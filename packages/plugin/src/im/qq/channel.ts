/**
 * QQ 官方机器人通道（提案 0024 §2.1 / M3）。
 *
 * 传输走 SDK 的 WebSocket 网关：token、鉴权、心跳与重连都由
 * `@tencent-connect/qqbot-nodejs` 负责，本模块只做三件事——把入站事件归一成
 * `ImInbound`、把出站文本按 peer 发回、把连接相位投影成 `ImChannelStatus`。
 *
 * 三个必须记住的 SDK 事实：
 * 1. `bot.start()` 解到的是「连接结束」而不是「连接成功」，因此**不能** await 它；
 *    启动是否成功看 `ready`/`resumed` 事件，失败看 start 的 reject 与 `error`。
 * 2. 群消息 @ 判定的权威信号是事件名 `GROUP_AT_MESSAGE_CREATE`（QQ 官方只在用户
 *    真的 @ 了机器人时才投递该事件）；带结构化 @ 列表的载荷用
 *    `mentions[].is_you` 表达同一件事，两者任一成立即视为 @。
 * 3. 被动回复（带 `msgId`）对同一条触发消息最多 4 条，超出部分只能当主动推送发。
 *
 * SDK 本身不在产物里：构造器由运行时从 `im/qq/sdk.ts` 动态加载后注入，
 * 本模块只依赖那里的结构类型（见 `decisions/2026-10-30-qq-channel.md`）。
 *
 * 本模块不认识 Tavern：入站走注入的 `router.handle`，出站只写 `OutboundPart`。
 */

import { randomUUID } from 'node:crypto'
import type { HostLogger } from '../../host-contract.js'
import type {
  ImChannel,
  ImChannelStatus,
  ImInbound,
  ImScope,
  ImSendReceipt,
  ImTarget,
  OutboundPart,
} from '../types.js'
import { imDedupeKey } from '../types.js'
import type { QqBotLike, QqBotOptions, QqGatewayDisconnect, QqInboundMessage, QqLogger, QqReplyTarget } from './sdk.js'

/** 启动等待上限：SDK 的握手自带超时，拉 token 没有；不设界会挂死面板请求。 */
const START_TIMEOUT_MS = 30_000

/** 昵称兜底长度：C2C 事件不携带昵称，用 openid 前 8 位给模型一个稳定标签。 */
const OPENID_LABEL_LENGTH = 8

/** 同一条触发消息的被动回复上限；平台口径是 4 条，第 5 条起降级主动推送。 */
const PASSIVE_REPLY_LIMIT = 4
/** 被动额度记账表上限：msg_id 用完即弃，长跑进程不能让它无限增长。 */
const PASSIVE_USAGE_ENTRIES = 200

export type QQChannelErrorCode =
  | 'QQ_BAD_SECRET'
  | 'QQ_BAD_MESSAGE'
  | 'QQ_BAD_TARGET'
  | 'QQ_CLOSED'
  | 'QQ_START_FAILED'
  | 'QQ_START_TIMEOUT'
  | 'QQ_SEND_FAILED'

/** 通道级错误：code 让路由层区分「凭据坏了」与「连接断了」，message 必须可排障。 */
export class QQChannelError extends Error {
  readonly code: QQChannelErrorCode

  constructor(code: QQChannelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'QQChannelError'
    this.code = code
  }
}

/** 入站落点；运行时把 `router.inbound` 包一层交给通道。 */
export interface QQRouterSink {
  handle(inbound: ImInbound): Promise<void>
}

/** QQBot 构造工厂：生产路径由运行时的动态加载器提供，测试注入假 SDK，整条链路不碰网络。 */
export type QQBotFactory = (options: QqBotOptions) => QqBotLike

export interface QQChannelOptions {
  /** 账号 id，等于平台 AppID：一个机器人账号一个通道实例。 */
  accountId: string
  /** `ImStore.readSecret('qq', accountId)` 的密钥袋，只认 appId/appSecret。 */
  secret: Readonly<Record<string, string>>
  router: QQRouterSink
  /** 群消息是否必须 @ 机器人；来自 state.imSettings.groupRequireMention。 */
  groupRequireMention: () => Promise<boolean>
  createBot: QQBotFactory
  /** 账号是否具备 markdown 能力；来自密钥袋 `markdownSupport === 'true'`。 */
  markdownSupport: boolean
  now: () => number
  logger?: HostLogger
}

interface StartupGate {
  readonly promise: Promise<void>
  readonly settled: boolean
  /** 成功（ready/resumed）传 undefined；失败传具体错误。重复调用是空操作。 */
  settle(error: Error | undefined): void
}

function createStartupGate(): StartupGate {
  let resolveGate: (() => void) | undefined
  let rejectGate: ((error: unknown) => void) | undefined
  let settled = false
  const promise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  return {
    promise,
    get settled(): boolean {
      return settled
    },
    settle(error: Error | undefined): void {
      if (settled) return
      settled = true
      if (error === undefined) resolveGate?.()
      else rejectGate?.(error)
    },
  }
}

export class QQChannel implements ImChannel {
  readonly channel = 'qq' as const
  readonly accountId: string

  private readonly appId: string
  private readonly appSecret: string
  private readonly router: QQRouterSink
  private readonly groupRequireMention: () => Promise<boolean>
  private readonly createBot: QQBotFactory
  private readonly markdownSupport: boolean
  private readonly now: () => number
  private readonly logger: HostLogger | undefined

  private bot: QqBotLike | undefined
  private ready: StartupGate | undefined
  private starting = false
  private onlineSince: number | undefined
  private lastError: string | undefined
  private signal: AbortSignal | undefined
  private abortListener: (() => void) | undefined
  /** 同一账号的入站按到达顺序串行：群聊并发事件不得乱序，去重才可靠。 */
  private inboundChain: Promise<void> = Promise.resolve()
  /** 同一账号的出站按整轮串行：两轮回复并发时不得出现 A1,B1,A2,B2 的交错碎片。 */
  private sendChain: Promise<void> = Promise.resolve()
  /** 每个被动回复 msg_id 已用掉的条数：额度跨 send 累计，不是每次 send 归零。 */
  private readonly passiveUsed = new Map<string, number>()

  constructor(options: QQChannelOptions) {
    // 凭据先验后存：空 appId/appSecret 在这里就拒绝，绝不让半个账号进连接状态。
    this.appId = requireSecret(options.secret, 'appId', options.accountId)
    this.appSecret = requireSecret(options.secret, 'appSecret', options.accountId)
    this.accountId = options.accountId
    this.router = options.router
    this.groupRequireMention = options.groupRequireMention
    this.createBot = options.createBot
    this.markdownSupport = options.markdownSupport
    this.now = options.now
    this.logger = options.logger
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.bot !== undefined) return
    if (signal.aborted) {
      throw new QQChannelError('QQ_CLOSED', `qq account '${this.accountId}' cannot start: signal is already aborted`)
    }
    // 先构造再登记状态：构造抛错时通道仍是 idle，没有监听器或半截字段要回收。
    const bot = this.createBot({
      appId: this.appId,
      appSecret: this.appSecret,
      accountId: this.accountId,
      transport: 'websocket',
      logger: qqLoggerOf(this.logger),
    })
    this.starting = true
    this.lastError = undefined
    this.signal = signal
    this.abortListener = () => { void this.stop() }
    signal.addEventListener('abort', this.abortListener, { once: true })
    this.bot = bot
    const gate = createStartupGate()
    this.ready = gate
    this.attach(bot, gate)

    try {
      // start() 只在连接终止时解出：成功与否看 ready 事件，这里只接失败信号。
      // 调用本身也在 try 内：同步抛出（被替换的工厂或未来的 SDK 改动）同样走清理。
      void bot.start().then(
        () => { this.failStartup(bot, gate, 'the QQ gateway closed before the bot became ready') },
        (error: unknown) => {
          this.failStartup(bot, gate, `the QQ gateway refused to start: ${messageOf(error)}`)
          this.noteFailure(bot, `QQ gateway start failed: ${messageOf(error)}`)
        },
      )
      await withTimeout(gate.promise, START_TIMEOUT_MS, `qq account '${this.accountId}' was not ready within ${START_TIMEOUT_MS}ms`)
    } catch (error) {
      const failure = error instanceof QQChannelError
        ? error
        : new QQChannelError('QQ_START_FAILED', `qq account '${this.accountId}' failed to start: ${messageOf(error)}`, { cause: error })
      this.dropStartup(bot, failure.message)
      throw failure
    }
  }

  async stop(): Promise<void> {
    const bot = this.bot
    const gate = this.ready
    this.bot = undefined
    this.ready = undefined
    this.starting = false
    this.onlineSince = undefined
    this.lastError = undefined
    this.detachAbort()
    gate?.settle(new QQChannelError('QQ_CLOSED', `qq account '${this.accountId}' stopped before it became ready`))
    bot?.stop()
  }

  status(): ImChannelStatus {
    // 最近一次失败优先：SDK 会自己重连，但重连成功前「在线」是谎报。
    if (this.lastError !== undefined) return { state: 'error', message: this.lastError }
    if (this.starting) return { state: 'starting' }
    if (this.onlineSince !== undefined) return { state: 'online', since: this.onlineSince }
    return { state: 'idle' }
  }

  async send(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    if (target.channel !== 'qq') {
      throw new QQChannelError('QQ_BAD_TARGET', `qq channel cannot send to channel '${target.channel}'`)
    }
    if (target.accountId !== this.accountId) {
      throw new QQChannelError(
        'QQ_BAD_TARGET',
        `qq account '${target.accountId}' cannot send through account '${this.accountId}'`,
      )
    }
    if (parts.length === 0) return { parts: 0, at: this.now() }
    // 整轮串行：投递顺序是用户能看见的事实，交错发送比慢一点更糟（审查 P2-5）。
    const queued = this.sendChain.then(() => this.sendParts(target, parts))
    this.sendChain = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async sendParts(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    const bot = this.bot
    if (bot === undefined) {
      throw new QQChannelError('QQ_CLOSED', `qq account '${this.accountId}' is not connected; the gateway must be ready before replies can be delivered`)
    }
    // 出站目标按 peer 重建：入站时缓存的 replyTarget 会把上一轮的 msgId 带进来，
    // 被动回复就挂到了旧消息上。replyTo 只来自本轮触发消息。
    const reply = replyTargetOf(target)
    let messageId: string | undefined
    // 被动回复额度按**被触发的消息**计：同一个 msg_id 累计最多 4 条，第 5 条起降级为
    // 主动推送。计数必须跨 send 累计——同一 replyTo 若被两次 send 命中（模型主动
    // 补话、失败重试、通知与正文先后发），只在本次 send 内归零就会超发被平台拒。
    let passiveUsed = reply.msgId === undefined ? PASSIVE_REPLY_LIMIT : (this.passiveUsed.get(reply.msgId) ?? 0)
    for (const part of parts) {
      const passive = reply.msgId !== undefined && passiveUsed < PASSIVE_REPLY_LIMIT
      if (passive) passiveUsed += 1
      const partTarget: QqReplyTarget = passive
        ? reply
        : { scope: reply.scope, targetId: reply.targetId }
      const id = await this.sendPart(bot, partTarget, target, part)
      if (id !== undefined) messageId = id
    }
    if (reply.msgId !== undefined) this.rememberPassiveUsage(reply.msgId, passiveUsed)
    return { parts: parts.length, at: this.now(), ...(messageId === undefined ? {} : { messageId }) }
  }

  /** 记账并限制表大小：msg_id 是用完即弃的，长跑进程不能无限增长。 */
  private rememberPassiveUsage(msgId: string, used: number): void {
    this.passiveUsed.delete(msgId)
    this.passiveUsed.set(msgId, used)
    while (this.passiveUsed.size > PASSIVE_USAGE_ENTRIES) {
      const oldest = this.passiveUsed.keys().next()
      if (oldest.done === true) return
      this.passiveUsed.delete(oldest.value)
    }
  }

  /**
   * 单条发送失败必须上抛：静默吞掉会让「模型答了但用户没收到」变成不可见的故障。
   * markdown 能力是账号级配置：没有该能力的机器人发 msg_type=2 会被平台拒绝，
   * 因此降级到 `sendText` 而不是让整轮回复失败（审查 P1-4）。
   */
  private async sendPart(bot: QqBotLike, reply: QqReplyTarget, target: ImTarget, part: OutboundPart): Promise<string | undefined> {
    try {
      const sent = this.markdownSupport
        ? await bot.sendMarkdown(reply, part.text)
        : await bot.sendText(reply, part.text)
      return nonEmpty(sent.id)
    } catch (error) {
      throw new QQChannelError(
        'QQ_SEND_FAILED',
        `qq send part ${part.index + 1}/${part.total} to ${target.scope}/${target.peerId} failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  private attach(bot: QqBotLike, gate: StartupGate): void {
    bot.on('ready', () => { this.markOnline(bot, gate) })
    bot.on('resumed', () => { this.markOnline(bot, gate) })
    bot.on('disconnected', (event: QqGatewayDisconnect) => {
      this.onlineSince = undefined
      this.noteFailure(bot, `QQ gateway disconnected: ${describeDisconnect(event)}`)
    })
    bot.on('error', (error: Error) => {
      this.noteFailure(bot, `QQ channel error: ${messageOf(error)}`)
    })
    bot.on('message', (_ctx, msg: QqInboundMessage) => this.enqueue(msg))
  }

  private markOnline(bot: QqBotLike, gate: StartupGate): void {
    if (this.bot !== bot) return
    this.starting = false
    // 重连成功就是恢复：旧的断线原因不能继续把面板钉在 error 上（审查 P2-4）。
    this.lastError = undefined
    this.onlineSince = this.now()
    gate.settle(undefined)
    this.logger?.info?.(`dsh-soulmojito im qq/${this.accountId}: gateway ready`)
  }

  private noteFailure(bot: QqBotLike, reason: string): void {
    if (this.bot !== bot) return
    this.lastError = reason
    this.logger?.warn?.(`dsh-soulmojito im qq/${this.accountId}: ${reason}`)
  }

  private failStartup(bot: QqBotLike, gate: StartupGate, reason: string): void {
    // 只把启动门关掉：真正的清理由 start() 的 catch 统一做，状态转移只此一处。
    if (this.bot !== bot || gate.settled) return
    gate.settle(new QQChannelError('QQ_START_FAILED', `qq account '${this.accountId}' failed to start: ${reason}`))
  }

  private dropStartup(bot: QqBotLike, reason: string): void {
    if (this.bot === bot) {
      this.bot = undefined
      this.ready = undefined
      this.starting = false
      this.onlineSince = undefined
      this.lastError = reason
      this.detachAbort()
    }
    bot.stop()
  }

  private detachAbort(): void {
    if (this.signal !== undefined && this.abortListener !== undefined) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
    this.signal = undefined
    this.abortListener = undefined
  }

  private enqueue(msg: QqInboundMessage): Promise<void> {
    const next = this.inboundChain.then(() => this.deliver(msg))
    this.inboundChain = next.catch((error: unknown) => {
      this.logger?.warn?.(`dsh-soulmojito im qq/${this.accountId}: inbound message failed: ${messageOf(error)}`)
    })
    return this.inboundChain
  }

  private async deliver(msg: QqInboundMessage): Promise<void> {
    // guild/dm 没有 c2c/group 等价；SDK 也不会把它们投到 message 事件上，
    // 这里显式丢弃并留痕，避免把频道语义塞进角色扮演会话。
    if (msg.kind !== 'c2c' && msg.kind !== 'group') {
      this.logger?.debug?.(`dsh-soulmojito im qq/${this.accountId}: ignored a ${msg.kind} message`)
      return
    }
    const inbound = this.inboundOf(msg)
    // 群 @ 门控读当次设置：面板关掉开关后，下一条群消息立即放行，不需要重连。
    if (inbound.scope === 'group' && await this.groupRequireMention() && !qqWasMentioned(msg)) return
    await this.router.handle(inbound)
  }

  private inboundOf(msg: QqInboundMessage): ImInbound {
    const replyTarget = msg.replyTarget
    if (replyTarget === undefined || (replyTarget.scope !== 'c2c' && replyTarget.scope !== 'group')) {
      throw new QQChannelError('QQ_BAD_MESSAGE', `qq account '${this.accountId}' got a message without a usable replyTarget`)
    }
    const peerId = replyTarget.targetId.trim()
    if (peerId === '') {
      throw new QQChannelError('QQ_BAD_MESSAGE', `qq account '${this.accountId}' got a message with an empty replyTarget.targetId`)
    }
    const scope: ImScope = replyTarget.scope === 'group' ? 'group' : 'private'
    const senderId = nonEmpty(msg.senderId) ?? peerId
    const senderName = nonEmpty(msg.senderName) ?? openidLabel(senderId)
    const messageId = nonEmpty(msg.messageId)
    const receivedAt = this.now()
    // 平台不给 id 时用随机 UUID 降级。取舍：宁可重复投递，不可吞消息——
    // 用 peer+时间做键时，同毫秒的两条消息会撞键，后一条被当成重放丢掉。
    const dedupeId = messageId ?? randomUUID()
    return {
      channel: 'qq',
      accountId: this.accountId,
      scope,
      peerId,
      senderId,
      senderName,
      text: typeof msg.content === 'string' ? msg.content : '',
      // 媒体（图片/语音/文件）留到 M5：本轮不下载、不上传，附件消息只按文本投递。
      media: [],
      // 被动回复锚点是本轮触发消息本身，不是它引用的消息。
      ...(messageId === undefined ? {} : { replyTo: messageId }),
      dedupeKey: imDedupeKey('qq', this.accountId, scope, peerId, dedupeId),
      receivedAt,
    }
  }
}

/**
 * 群消息是否 @ 了机器人。
 *
 * QQ 官方平台只在用户 @ 机器人时投递 `GROUP_AT_MESSAGE_CREATE`，事件名本身就是
 * 权威信号；带结构化 @ 列表的载荷用 `mentions[].is_you` 表达同一件事。正文里的
 * `<@appid>` 扫描是 SDK 给私有域机器人的私活，这里不重复实现。
 */
export function qqWasMentioned(msg: QqInboundMessage): boolean {
  if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  return Array.isArray(msg.mentions) && msg.mentions.some((entry) => entry?.is_you === true)
}

/** 出站目标 → SDK 的 replyTarget；带 msgId 即被动回复，不带即主动推送。 */
export function replyTargetOf(target: ImTarget): QqReplyTarget {
  return {
    scope: target.scope === 'group' ? 'group' : 'c2c',
    targetId: target.peerId,
    ...(target.replyTo === undefined ? {} : { msgId: target.replyTo }),
  }
}

function requireSecret(secret: Readonly<Record<string, string>>, key: string, accountId: string): string {
  const value = secret[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QQChannelError(
      'QQ_BAD_SECRET',
      `qq account '${accountId}' has no ${key}; secret.${key} must be a non-empty string`,
    )
  }
  return value.trim()
}

function openidLabel(openid: string): string {
  return openid.slice(0, OPENID_LABEL_LENGTH)
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function describeDisconnect(event: QqGatewayDisconnect): string {
  return `code=${event.code} reason='${event.reason}' willReconnect=${event.willReconnect}`
}

/** SDK 的 Logger 要求 info/error 必填；宿主的全是可选的，这里补齐。 */
function qqLoggerOf(logger: HostLogger | undefined): QqLogger {
  return {
    info: (message, meta) => { logger?.info?.(message, meta) },
    warn: (message, meta) => { logger?.warn?.(message, meta) },
    error: (message, meta) => { logger?.error?.(message, meta) },
    debug: (message, meta) => { logger?.debug?.(message, meta) },
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new QQChannelError('QQ_START_TIMEOUT', message))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      () => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
