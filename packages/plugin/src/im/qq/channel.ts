/**
 * QQ 官方机器人通道（提案 0024 §2.1 / M3 / M5）。
 *
 * 传输走 SDK 的 WebSocket 网关：token、鉴权、心跳与重连都由
 * `@tencent-connect/qqbot-nodejs` 负责，本模块只做三件事——把入站事件归一成
 * `ImInbound`（含平台附件的 https 直链）、把出站文字与媒体按 peer 发回、把连接
 * 相位投影成 `ImChannelStatus`。
 *
 * 几个必须记住的 SDK 事实：
 * 1. `bot.start()` 解到的是「连接结束」而不是「连接成功」，因此**不能** await 它；
 *    启动是否成功看 `ready`/`resumed` 事件，失败看 start 的 reject 与 `error`。
 * 2. 群消息 @ 判定的权威信号是事件名 `GROUP_AT_MESSAGE_CREATE`（QQ 官方只在用户
 *    真的 @ 了机器人时才投递该事件）；带结构化 @ 列表的载荷用
 *    `mentions[].is_you` 表达同一件事，两者任一成立即视为 @。
 * 3. 被动回复（带 `msgId`）对同一条触发消息最多 4 条，超出部分只能当主动推送发。
 * 4. 原生流式消息（`openStream`/`StreamSession`）只对 C2C 开放；群聊流式由本模块
 *    自己用「有序多段 + 被动额度重切片」近似（`planGroupParts`），不假装是平台流。
 *
 * SDK 本身不在产物里：构造器由运行时从 `im/qq/sdk.ts` 动态加载后注入，
 * 本模块只依赖那里的结构类型（见 `decisions/2026-10-30-qq-channel.md`）。
 *
 * 本模块不认识 Tavern：入站走注入的 `router.handle`，出站只写 `OutboundPart`。
 */

import { createHash } from 'node:crypto'
import type { HostLogger } from '../../host-contract.js'
import type { ImMediaStore } from '../media-store.js'
import { PASSIVE_REPLY_LIMIT, planDeliveries, planGroupParts } from './delivery.js'
import { qqAttachmentsOf, qqMediaOfAttachments, qqTranscriptsOf } from './inbound-media.js'
import { fetchInboundMedia } from '../media-fetch.js'
import type {
  ImChannel,
  ImChannelStatus,
  ImInbound,
  ImMediaKind,
  ImMediaRef,
  ImScope,
  ImSendReceipt,
  ImTarget,
  OutboundMediaPart,
  OutboundPart,
  OutboundTextPart,
} from '../types.js'
import { imDedupeKey, imPeerAlias, imPeerKey } from '../types.js'
import type {
  QqBotLike,
  QqBotOptions,
  QqGatewayDisconnect,
  QqInboundAttachment,
  QqInboundMessage,
  QqLogger,
  QqMediaSendResult,
  QqMediaSource,
  QqReplyTarget,
} from './sdk.js'

/** 启动等待上限：SDK 的握手自带超时，拉 token 没有；不设界会挂死面板请求。 */
const START_TIMEOUT_MS = 30_000

/** 入站附件上限与单条下载超时：与微信同口径（提案 §4.4 的 20MB）。 */
const QQ_MEDIA_MAX_BYTES = 20 * 1024 * 1024
const QQ_MEDIA_TIMEOUT_MS = 20_000

/** 昵称兜底长度：C2C 事件不携带昵称，用 openid 前 8 位给模型一个稳定标签。 */
const OPENID_LABEL_LENGTH = 8

/** 无平台时间戳时的内容指纹时间桶：与微信侧各自独立；同桶内相同内容视为重放。 */
const QQ_FALLBACK_DEDUPE_BUCKET_MS = 10 * 60 * 1_000

/** 被动额度记账表上限：msg_id 用完即弃，长跑进程不能让它无限增长。 */
const PASSIVE_USAGE_ENTRIES = 200

/**
 * 群聊单片字符上限：与 router 的 QQ 默认切分上限同源（`IM_CHUNK_DEFAULTS.qq`，
 * 平台约 5000）。群聊没有原生流式，只能靠片数控制被动额度，重切宽度按这个口径。
 */

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
  handle(
    inbound: ImInbound,
    options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> },
  ): Promise<void>
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
  /** 附件仓库：入站媒体在通过访问控制后下载到这里。 */
  media?: ImMediaStore
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
  private readonly media: ImMediaStore | undefined
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
    this.media = options.media
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
    // 群聊没有原生流式（SDK 的 stream_messages 只对私聊开放），只能靠多条有序
    // 消息：超过 4 片的长回复先重切成 ≤4 片，正好落在被动额度内。私聊保持原样。
    const plan = planDeliveries(target.scope, parts)
    if (plan.overflow) {
      this.logger?.warn?.(
        `dsh-soulmojito im qq/${this.accountId}: group reply exceeds the ${PASSIVE_REPLY_LIMIT} passive replies `
          + `(${plan.deliveries.length} parts); the tail is sent as proactive push`,
      )
    }
    let messageId: string | undefined
    // 被动回复额度按**被触发的消息**计：同一个 msg_id 累计最多 4 条，第 5 条起降级为
    // 主动推送。计数必须跨 send 累计——同一 replyTo 若被两次 send 命中（模型主动
    // 补话、失败重试、通知与正文先后发），只在本次 send 内归零就会超发被平台拒。
    let passiveUsed = reply.msgId === undefined ? PASSIVE_REPLY_LIMIT : (this.passiveUsed.get(reply.msgId) ?? 0)
    try {
      for (const delivery of plan.deliveries) {
        const passive = reply.msgId !== undefined && passiveUsed < PASSIVE_REPLY_LIMIT
        if (passive) passiveUsed += 1
        const partTarget: QqReplyTarget = passive
          ? reply
          : { scope: reply.scope, targetId: reply.targetId }
        // 媒体也是平台调用：同样占一格被动额度（文字说明先发，也各自占一格）。
        const id = delivery.kind === 'text'
          ? await this.sendTextPart(bot, partTarget, target, delivery.text, delivery.index, delivery.total)
          : await this.sendMediaPart(bot, partTarget, target, delivery.part)
        if (id !== undefined) messageId = id
      }
    } finally {
      // 中途失败也要记账：前几条已经占用的额度不能因为抛错而被“退回”，
      // 否则重试时会在同一条触发消息上超发。
      if (reply.msgId !== undefined) this.rememberPassiveUsage(reply.msgId, passiveUsed)
    }
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
  private async sendTextPart(
    bot: QqBotLike,
    reply: QqReplyTarget,
    target: ImTarget,
    text: string,
    index: number,
    total: number,
  ): Promise<string | undefined> {
    try {
      const sent = this.markdownSupport
        ? await bot.sendMarkdown(reply, text)
        : await bot.sendText(reply, text)
      return nonEmpty(sent.id)
    } catch (error) {
      throw new QQChannelError(
        'QQ_SEND_FAILED',
        `qq send part ${index + 1}/${total} to ${this.peerLabel(target)} failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * 媒体发送：源与落点先解析，再按 kind 调 SDK 的便捷方法。缺方法/缺源是
   * 可操作错误（QQChannelError 原样上抛），平台拒绝才是 QQ_SEND_FAILED 包装。
   */
  private async sendMediaPart(
    bot: QqBotLike,
    reply: QqReplyTarget,
    target: ImTarget,
    part: OutboundMediaPart,
  ): Promise<string | undefined> {
    const source = mediaSourceOf(part)
    try {
      const sent = await qqSendMedia(bot, reply, part, source)
      return nonEmpty(sent.message?.id)
    } catch (error) {
      if (error instanceof QQChannelError) throw error
      throw new QQChannelError(
        'QQ_SEND_FAILED',
        `qq send ${part.kind} part ${part.index + 1}/${part.total} to ${this.peerLabel(target)} failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  /** 日志里的对端标签：openid 不进日志环/面板，只出现稳定 alias。 */
  private peerLabel(target: ImTarget): string {
    return imPeerAlias('qq', target.scope, imPeerKey('qq', this.accountId, target.scope, target.peerId))
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
    // 附件在路由通过去重与访问控制之后才下载：白名单外的人不能靠附件让进程落盘。
    await this.router.handle(inbound, { loadMedia: () => this.materializeInboundMedia(msg) })
  }

  /** 逐个下载附件；失败只 warn 并保留不带 localPath 的 ref，不阻断这一轮。 */
  private async materializeInboundMedia(msg: QqInboundMessage): Promise<readonly ImMediaRef[]> {
    const refs = qqMediaOfAttachments(qqAttachmentsOf(msg))
    if (this.media === undefined) return refs
    const enriched: ImMediaRef[] = []
    for (const ref of refs) {
      if (ref.url === undefined) {
        enriched.push(ref)
        continue
      }
      try {
        enriched.push(await fetchInboundMedia(ref, {
          channel: 'qq',
          accountId: this.accountId,
          media: this.media,
          maxBytes: QQ_MEDIA_MAX_BYTES,
          timeoutMs: QQ_MEDIA_TIMEOUT_MS,
          ...(this.signal === undefined ? {} : { signal: this.signal }),
        }))
      } catch (error) {
        this.logger?.warn?.(
          `dsh-soulmojito im qq/${this.accountId}: inbound ${ref.kind} download failed: ${messageOf(error)}`,
        )
        enriched.push(ref)
      }
    }
    return enriched
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
    // 语音自带的识别文本是平台给的正文补充：丢了它，模型只看得到一条「语音」，
    // 而这正是 QQ 语音唯一可读的内容。
    const attachments = qqAttachmentsOf(msg)
    const transcript = qqTranscriptsOf(attachments)
    const body = typeof msg.content === 'string' ? msg.content.trim() : ''
    const text = transcript === '' ? body : body === '' ? transcript : `${body}\n${transcript}`
    // 平台不给 id 时改用内容指纹：随机 UUID 每次重放都换键，24h 去重日志永远挡不住重放。
    // 同一平台毫秒时间戳 + 相同内容的重复投递视为重放；不同内容即使同一时间戳也不会撞键。
    const dedupeId = messageId ?? fallbackDedupeId({
      senderId,
      content: body,
      timestamp: msg.timestamp,
      attachments,
      receivedAt,
    })
    return {
      channel: 'qq',
      accountId: this.accountId,
      scope,
      peerId,
      senderId,
      senderName,
      text,
      // 附件先只带远端信息；路由通过访问控制后才由 loadMedia 下载并补 localPath。
      media: qqMediaOfAttachments(attachments),
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

export { planGroupParts } from './delivery.js'
export type { GroupPartPlan } from './delivery.js'

/** 出站目标 → SDK 的 replyTarget；带 msgId 即被动回复，不带即主动推送。 */
export function replyTargetOf(target: ImTarget): QqReplyTarget {
  return {
    scope: target.scope === 'group' ? 'group' : 'c2c',
    targetId: target.peerId,
    ...(target.replyTo === undefined ? {} : { msgId: target.replyTo }),
  }
}

/* ------------------------------- 出站媒体 ------------------------------- */

/** 媒体源：localPath 优先；url 只给图片/视频，由平台自己抓取，本插件不下载。 */
function mediaSourceOf(part: OutboundMediaPart): QqMediaSource {
  const localPath = nonEmpty(part.localPath)
  if (localPath !== undefined) return { localPath }
  const url = nonEmpty(part.url)
  if (url === undefined) {
    throw new QQChannelError(
      'QQ_SEND_FAILED',
      `qq ${part.kind} part ${part.index + 1}/${part.total} carries neither localPath nor url`,
    )
  }
  if (part.kind !== 'image' && part.kind !== 'video') {
    throw new QQChannelError(
      'QQ_SEND_FAILED',
      `qq ${part.kind} parts must be sent from a local file; this adapter never downloads remote urls`,
    )
  }
  return { url }
}

/** 按 kind 调对应的便捷方法；方法缺失是 build 差异，报文直接点名并指向面板。 */
async function qqSendMedia(
  bot: QqBotLike,
  reply: QqReplyTarget,
  part: OutboundMediaPart,
  source: QqMediaSource,
): Promise<QqMediaSendResult> {
  switch (part.kind) {
    case 'image':
      if (bot.sendImage === undefined) throw qqMissingMediaMethod('sendImage')
      return await bot.sendImage(reply, source)
    case 'video':
      if (bot.sendVideo === undefined) throw qqMissingMediaMethod('sendVideo')
      return await bot.sendVideo(reply, source)
    case 'voice':
      // 官方 d.ts 的 sendVoice 只认 onProgress，没有 content 参数；说明文字
      // 由 planDeliveries 单独发一条。
      if (bot.sendVoice === undefined) throw qqMissingMediaMethod('sendVoice')
      return await bot.sendVoice(reply, source)
    case 'file': {
      if (bot.sendFile === undefined) throw qqMissingMediaMethod('sendFile')
      const name = nonEmpty(part.name)
      return await bot.sendFile(reply, source, name === undefined ? {} : { fileName: name })
    }
  }
}

function qqMissingMediaMethod(method: string): QQChannelError {
  return new QQChannelError(
    'QQ_SEND_FAILED',
    `this qqbot-nodejs build exposes no ${method}(); reinstall the runtime from the IM panel`,
  )
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

/**
 * 平台缺 `messageId` 时的确定性降级 id：平台身份 + 正文 + 平台时间戳（缺失时用
 * `receivedAt` 时间桶）+ 附件身份 → 同一个键。
 *
 * 同一平台毫秒时间戳 + 相同内容的重复投递视为重放，会被 24h 去重日志挡住；不同内容
 * 即使落在同一毫秒也不会撞键。代价：平台没给时间戳（旧 build / 手写载荷）时只能退回
 * 10 分钟桶——桶内两条真正相同的内容会被当成重放，后到的那条被吞掉。
 */
function fallbackDedupeId(input: {
  senderId: string
  content: string
  timestamp: string
  attachments: readonly QqInboundAttachment[]
  receivedAt: number
}): string {
  // `bucket-` 前缀让桶值与毫秒时间戳字符串永不混淆，两者可以共用同一槽位。
  const platformTimestamp =
    nonEmpty(input.timestamp) ?? `bucket-${Math.floor(input.receivedAt / QQ_FALLBACK_DEDUPE_BUCKET_MS)}`
  const canonical = JSON.stringify([
    input.senderId,
    input.content,
    platformTimestamp,
    input.attachments.map((attachment) => attachmentIdentityOf(attachment)),
  ])
  return `fallback-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

/**
 * 附件的可交付身份：与 `qqMediaRefOf` 同口径（空白字段视为缺失、字节数取整）。
 * `voice_wav_url` 与 `asr_refer_text` 也进指纹：语音交付的是 wav 直链与识别文本，
 * 两者不同就是两条内容不同的消息，不能让它们撞同一个键。
 */
function attachmentIdentityOf(attachment: QqInboundAttachment): (string | number | null)[] {
  const size = attachment.size
  const usableSize = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? Math.round(size) : null
  return [
    nonEmpty(attachment.content_type) ?? null,
    nonEmpty(attachment.url) ?? null,
    nonEmpty(attachment.filename) ?? null,
    usableSize,
    nonEmpty(attachment.voice_wav_url) ?? null,
    nonEmpty(attachment.asr_refer_text) ?? null,
  ]
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
