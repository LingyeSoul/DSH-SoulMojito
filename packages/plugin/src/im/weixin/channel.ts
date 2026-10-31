/**
 * 微信官方 iLink 通道（提案 0024 §2.2 / M4，仅私聊）。
 *
 * 传输是长轮询：`start()` 起循环，`getupdates` 挂起、取页、把消息归一成
 * `ImInbound` 交给 router。协议事实：`get_updates_buf` 必须续用；
 * `context_token` 按对端记账并在 `sendmessage` 原样回带；`ret/-14` 表示 token
 * 失效，暂停账号 1 小时；微信不渲染 markdown。媒体走 CDN，失败只 warn，
 * 文本仍要送达。本轮不做群聊。
 */

import type { HostLogger } from '../../host-contract.js'
import type { ImMediaStore } from '../media-store.js'
import type {
  ImChannel,
  ImChannelStatus,
  ImInbound,
  ImMediaRef,
  ImSendReceipt,
  ImTarget,
  OutboundMediaPart,
  OutboundPart,
} from '../types.js'
import { imPeerAlias, imPeerKey } from '../types.js'
import {
  getConfig,
  getUpdates,
  sendMessage,
  sendTyping,
  WeixinApiError,
  WEIXIN_DEFAULT_CDN_BASE_URL,
  WEIXIN_STALE_TOKEN_RETCODE,
  type WeixinApiContext,
  type WeixinMessage,
} from './api.js'
import type { WeixinClock } from './clock.js'
import { WeixinChannelError } from './errors.js'
import { weixinInboundOf } from './inbound.js'
import { isIlinkThrottle, WeixinSendGuard } from './send-guard.js'
import { createTypingTicketCache, MAX_TYPING_TICKETS, TYPING_TICKET_TTL_MS } from './typing-cache.js'
import {
  materializeInboundMedia,
  normalizeCdnBaseUrl,
  sendWeixinMedia,
  sweepExpiredMedia,
  WEIXIN_MEDIA_TIMEOUT_MS,
  type WeixinInboundMediaSource,
  type WeixinMediaLog,
} from './media.js'

export type { WeixinClock } from './clock.js'
export { WEIXIN_REAL_CLOCK } from './clock.js'

/** 协议建议的长轮询时长；服务端可用 `longpolling_timeout_ms` 覆盖。 */
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000
/** 本地超时给服务端多留的余量：服务端自己也会按建议值收尾。 */
const LONG_POLL_GRACE_MS = 5_000
const LONG_POLL_MIN_MS = 1_000
const LONG_POLL_MAX_MS = 120_000
const SEND_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000
/** 入站附件下载/解密与出站上传的单次超时：附件不是正文，卡住就放弃。 */
const MEDIA_TIMEOUT_MS = WEIXIN_MEDIA_TIMEOUT_MS
/** 落盘附件的一次性 TTL：启动时清掉 24h 前的东西。 */
const MEDIA_TTL_MS = 24 * 60 * 60 * 1_000
/** token 失效后的暂停窗口：1 小时。 */
const STALE_TOKEN_PAUSE_MS = 60 * 60 * 1_000
/** 普通失败：前两次 2s 重试，连续第 3 次起退避 30s。 */
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const FAILURES_BEFORE_BACKOFF = 3
/**
 * 启动探测窗口：长轮询在无消息时会被服务端挂起，没有「已连接」事件。
 * 首个请求在这个窗口内失败即启动失败；窗口内没失败就算可用。
 */
const START_PROBE_TIMEOUT_MS = 3_000
/** context_token 记账表上限：长跑进程不能让每个对端都永久驻留。 */
const MAX_CONTEXT_TOKENS = 500

export { WeixinChannelError, type WeixinChannelErrorCode } from './errors.js'

/**
 * 时钟注入面（`-14` 的 1 小时暂停与退避要能在测试里推进）在 `clock.ts`，
 * 这里转出给运行时与测试使用。
 */

/** 入站落点；运行时把 `router.inbound` 包一层交给通道。 */
export interface WeixinRouterSink {
  handle(
    inbound: ImInbound,
    options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> },
  ): Promise<void>
}

export interface WeixinChannelOptions {
  /** 账号 id，等于平台 `ilink_bot_id`。 */
  accountId: string
  /** 密钥袋里的 `botToken`。 */
  token: string
  /** 密钥袋里的 `baseUrl`（扫码确认时服务端给的 API 入口）。 */
  baseUrl: string
  router: WeixinRouterSink
  /** 重启续读：`get_updates_buf` 游标。 */
  loadCursor: () => Promise<string | undefined>
  /** 每轮把非空新游标交给它（`ImStore.writeCursor`）。 */
  saveCursor: (cursor: string) => Promise<void>
  /** 对端 → `context_token` 的持久化读面（缺失时从空表开始）。 */
  loadContextTokens: () => Promise<Readonly<Record<string, string>>>
  saveContextTokens: (tokens: Readonly<Record<string, string>>) => Promise<void>
  clock: WeixinClock
  /** 首轮长轮询时长；服务端可覆盖。 */
  longPollTimeoutMs: number
  /** 是否发输入状态；失败只 warn，绝不阻断回复。 */
  typingEnabled: boolean
  /** 媒体 CDN 入口；默认官方 c2c 域名，测试/反代可覆盖。 */
  cdnBaseUrl?: string
  /** 附件落盘；缺省时入站媒体只留引用，不下载（测试与嵌入场景）。 */
  media?: ImMediaStore
  logger?: HostLogger
}

interface StartGate {
  readonly promise: Promise<void>
  readonly settled: boolean
  /** 成功（首个请求通过或探测窗口到期）传 undefined；首请求失败传具体错误。 */
  settle(error: Error | undefined): void
}

function createStartGate(): StartGate {
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

export class WeixinChannel implements ImChannel {
  readonly channel = 'weixin' as const
  readonly accountId: string

  private readonly token: string
  private readonly baseUrl: string
  private readonly router: WeixinRouterSink
  private readonly loadCursor: () => Promise<string | undefined>
  private readonly saveCursor: (cursor: string) => Promise<void>
  private readonly loadContextTokens: () => Promise<Readonly<Record<string, string>>>
  private readonly saveContextTokens: (tokens: Readonly<Record<string, string>>) => Promise<void>
  private readonly clock: WeixinClock
  private readonly typingEnabled: boolean
  private readonly cdnBaseUrl: string
  private readonly media: ImMediaStore | undefined
  private readonly logger: HostLogger | undefined

  private longPollTimeoutMs: number
  private cursor = ''
  private contextTokens: Record<string, string> = {}
  private readonly typingTickets = createTypingTicketCache({ ttlMs: TYPING_TICKET_TTL_MS, max: MAX_TYPING_TICKETS })

  private controller: AbortController | undefined
  private lifetimeSignal: AbortSignal | undefined
  private abortListener: (() => void) | undefined
  private loopPromise: Promise<void> | undefined
  private gate: StartGate | undefined
  private starting = false
  private onlineSince: number | undefined
  private lastError: string | undefined
  private pausedUntil: number | undefined
  private pauseReason: string | undefined
  /** 出站突发预算与 `-2` 冷却（`send-guard.ts`）。 */
  private readonly sendGuard: WeixinSendGuard

  /** 同一账号的出站按整轮串行：两轮回复并发时不得出现 A1,B1,A2,B2 的碎片。 */
  private sendChain: Promise<void> = Promise.resolve()

  constructor(options: WeixinChannelOptions) {
    // 凭据先验后存：空 token / 非法入口在这里就拒绝，绝不让半个账号进连接状态。
    this.token = requireToken(options.token, options.accountId)
    this.baseUrl = requireBaseUrl(options.baseUrl, options.accountId)
    this.accountId = options.accountId
    this.router = options.router
    this.loadCursor = options.loadCursor
    this.saveCursor = options.saveCursor
    this.loadContextTokens = options.loadContextTokens
    this.saveContextTokens = options.saveContextTokens
    this.clock = options.clock
    this.sendGuard = new WeixinSendGuard({ accountId: options.accountId, clock: options.clock })
    this.longPollTimeoutMs = clampLongPoll(options.longPollTimeoutMs)
    this.typingEnabled = options.typingEnabled
    this.cdnBaseUrl = normalizeCdnBaseUrl(options.cdnBaseUrl ?? WEIXIN_DEFAULT_CDN_BASE_URL)
    this.media = options.media
    this.logger = options.logger
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.loopPromise !== undefined) return
    if (signal.aborted) {
      throw new WeixinChannelError('WEIXIN_CLOSED', `weixin account '${this.accountId}' cannot start: signal is already aborted`)
    }
    this.starting = true
    this.lastError = undefined
    this.pausedUntil = undefined
    this.pauseReason = undefined
    this.sendGuard.reset()
    // 附件是一次性数据：启动时顺手清掉 24h 前的落盘件，失败只 warn。
    if (this.media !== undefined) void sweepExpiredMedia(this.media, MEDIA_TTL_MS, this.mediaLog())
    // 游标与 context token 在首轮请求前装载：先发请求再读盘会让首轮用错游标。
    try {
      const [cursor, tokens] = await Promise.all([this.loadCursor(), this.loadContextTokens()])
      this.cursor = cursor ?? ''
      this.contextTokens = { ...tokens }
    } catch (error) {
      this.starting = false
      throw new WeixinChannelError(
        'WEIXIN_STATE',
        `weixin account '${this.accountId}' could not load its persisted cursor/context tokens: ${messageOf(error)}`,
        { cause: error },
      )
    }

    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
    this.lifetimeSignal = signal
    this.abortListener = onAbort
    this.controller = controller

    const gate = createStartGate()
    this.gate = gate
    const loop = this.runLoop(controller.signal, gate)
    this.loopPromise = loop
    if (controller.signal.aborted) {
      // 装载游标期间被卸载：循环一行都不会跑，必须自己把启动门关掉，
      // 否则 start() 会一直等到探测窗口超时。
      gate.settle(new WeixinChannelError('WEIXIN_CLOSED', `weixin account '${this.accountId}' cannot start: the runtime aborted while loading its state`))
    }
    const probe = setTimeout(() => { gate.settle(undefined) }, START_PROBE_TIMEOUT_MS)
    probe.unref?.()
    try {
      await gate.promise
    } catch (error) {
      await this.stop()
      if (error instanceof WeixinChannelError) throw error
      throw new WeixinChannelError(
        'WEIXIN_CLOSED',
        `weixin account '${this.accountId}' failed to start: ${messageOf(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(probe)
    }
    if (this.starting) {
      // 探测窗口内没有失败就视为可用：长轮询此时多半正被服务端挂起。
      this.starting = false
      if (this.onlineSince === undefined) this.onlineSince = this.clock.now()
    }
    void loop.catch((error: unknown) => {
      this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: poll loop ended: ${messageOf(error)}`)
    })
  }

  async stop(): Promise<void> {
    const loop = this.loopPromise
    this.loopPromise = undefined
    // 启动中的 stop 不算连接失败：调用方正在卸载，不该再收到一个 reject。
    this.gate?.settle(undefined)
    this.gate = undefined
    this.controller?.abort()
    this.controller = undefined
    this.detachAbort()
    if (loop !== undefined) {
      await loop.catch((error: unknown) => {
        this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: poll loop ended: ${messageOf(error)}`)
      })
    }
    this.starting = false
    this.onlineSince = undefined
    this.lastError = undefined
    this.pausedUntil = undefined
    this.pauseReason = undefined
    this.sendGuard.reset()
  }

  status(): ImChannelStatus {
    if (this.pausedUntil !== undefined && this.clock.now() < this.pausedUntil) {
      return {
        state: 'paused',
        reason: this.pauseReason ?? 'the WeChat bot token is stale',
        until: this.pausedUntil,
      }
    }
    if (this.lastError !== undefined) return { state: 'error', message: this.lastError }
    if (this.starting) return { state: 'starting' }
    if (this.onlineSince !== undefined) return { state: 'online', since: this.onlineSince }
    return { state: 'idle' }
  }

  async send(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    if (target.channel !== 'weixin') {
      throw new WeixinChannelError('WEIXIN_BAD_TARGET', `weixin channel cannot send to channel '${target.channel}'`)
    }
    if (target.accountId !== this.accountId) {
      throw new WeixinChannelError(
        'WEIXIN_BAD_TARGET',
        `weixin account '${target.accountId}' cannot send through account '${this.accountId}'`,
      )
    }
    if (target.scope !== 'private') {
      throw new WeixinChannelError('WEIXIN_BAD_TARGET', `weixin only supports private chats, got scope '${target.scope}'`)
    }
    // 暂停期间不出站：攒着等恢复会发出过期的回复，也会让调用方以为已经送达。
    const pausedFor = this.pauseRemaining()
    if (pausedFor > 0) throw pausedError(this.accountId, pausedFor, this.clock.now())
    // iLink 的 -2 惩罚期间也不出站：每次重试都会延长惩罚，交给冷却计时器。
    this.sendGuard.rejectIfCoolingDown()
    if (parts.length === 0) return { parts: 0, at: this.clock.now() }
    // 整轮串行：投递顺序是用户能看见的事实，交错发送比慢一点更糟。
    const queued = this.sendChain.then(() => this.sendParts(target, parts))
    this.sendChain = queued.then(noop, noop)
    return queued
  }

  /**
   * 输入状态（可选）：ticket 按对端缓存 30 分钟（上限 500），命中就不问
   * `getconfig`；`sendtyping` 失败会淘汰 ticket 并重试一次。失败只 warn。
   */
  async setTyping(peerId: string, status: 1 | 2): Promise<void> {
    if (!this.typingEnabled) return
    // typing 不是关键路径：暂停期间直接跳过，不抛错，也不发 getconfig。
    if (this.pauseRemaining() > 0) return
    try {
      const ticket = this.typingTickets.get(peerId, this.clock.now()) ?? (await this.fetchTypingTicket(peerId))
      if (ticket === undefined) {
        this.logger?.debug?.(`dsh-soulmojito im weixin/${this.accountId}: no typing ticket for ${this.peerLabel(peerId)}; typing skipped`)
        return
      }
      try {
        await this.postTyping(peerId, ticket, status)
      } catch {
        // 缓存/刚取的 ticket 都可能被服务端判过期：淘汰并只重试这一次。
        this.typingTickets.delete(peerId)
        const fresh = await this.fetchTypingTicket(peerId)
        if (fresh === undefined) {
          this.logger?.debug?.(
            `dsh-soulmojito im weixin/${this.accountId}: no fresh typing ticket for ${this.peerLabel(peerId)}; typing skipped`,
          )
          return
        }
        await this.postTyping(peerId, fresh, status)
      }
    } catch (error) {
      this.logger?.warn?.(
        `dsh-soulmojito im weixin/${this.accountId}: typing ${status} for ${this.peerLabel(peerId)} failed: ${messageOf(error)}`,
      )
    }
  }

  private async postTyping(peerId: string, ticket: string, status: 1 | 2): Promise<void> {
    await sendTyping(this.apiContext(CONFIG_TIMEOUT_MS), { ilinkUserId: peerId, typingTicket: ticket, status })
  }

  /** `getconfig` 拿新 ticket；服务端没给就不缓存（空 ticket 发出去只会白失败）。 */
  private async fetchTypingTicket(peerId: string): Promise<string | undefined> {
    const contextToken = this.contextTokens[peerId]
    const config = await getConfig(this.apiContext(CONFIG_TIMEOUT_MS), {
      ilinkUserId: peerId,
      ...(contextToken === undefined ? {} : { contextToken }),
    })
    const ticket = config.typingTicket
    if (ticket === undefined) return undefined
    this.typingTickets.set(peerId, ticket, this.clock.now())
    return ticket
  }

  /** 媒体路径的日志：统一补账号前缀，细节由 media.ts 给固定文案。 */
  private mediaLog(): WeixinMediaLog {
    const prefix = `dsh-soulmojito im weixin/${this.accountId}: `
    return {
      debug: (message) => { this.logger?.debug?.(`${prefix}${message}`) },
      warn: (message) => { this.logger?.warn?.(`${prefix}${message}`) },
    }
  }

  /** 统一的请求注入面：入口、token、超时与运行期中止信号。 */
  private apiContext(timeoutMs: number): WeixinApiContext {
    return {
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs,
      ...(this.controller === undefined ? {} : { signal: this.controller.signal }),
    }
  }

  private async sendParts(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    if (this.controller === undefined) {
      throw new WeixinChannelError(
        'WEIXIN_CLOSED',
        `weixin account '${this.accountId}' is not running; replies can only be delivered while polling is active`,
      )
    }
    // 排队期间可能刚收到 `-14` 或 `-2`：真正出站前再判一次暂停/冷却。
    const pausedFor = this.pauseRemaining()
    if (pausedFor > 0) throw pausedError(this.accountId, pausedFor, this.clock.now())
    this.sendGuard.rejectIfCoolingDown()
    const contextToken = this.contextTokens[target.peerId]
    if (contextToken === undefined) {
      // 协议没写「缺 context_token 会被拒」，但参考实现会给出 warning；照做，
      // 不因此拒绝发送——丢了 token 也不能丢了用户这一轮回复。
      this.logger?.warn?.(
        `dsh-soulmojito im weixin/${this.accountId}: no context_token for ${this.peerLabel(target.peerId)}; sending without context`,
      )
    }
    // 开始回复即取消「正在输入」；失败只 warn，不影响正文。
    void this.setTyping(target.peerId, 2)
    let messageId: string | undefined
    for (const part of parts) {
      try {
        // 每条独立 sendmessage 都占一个窗口名额；超出直接拒绝，不打到服务端。
        this.sendGuard.reserveSlot()
        const sentId =
          part.kind === 'text'
            ? (
                await sendMessage(this.apiContext(SEND_TIMEOUT_MS), {
                  toUserId: target.peerId,
                  text: part.text,
                  ...(contextToken === undefined ? {} : { contextToken }),
                })
              ).messageId
            : await this.sendMediaPart(target, part, contextToken)
        if (sentId !== undefined) messageId = sentId
      } catch (error) {
        // 通道级错误（坏目标、坏本地文件、预算/冷却）原样上抛。
        if (error instanceof WeixinChannelError) throw error
        if (isIlinkThrottle(error)) {
          const throttled = this.sendGuard.throttle(this.peerLabel(target.peerId), error)
          this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: ${throttled.message}`)
          throw throttled
        }
        if (isStaleToken(error)) {
          const until = this.clock.now() + STALE_TOKEN_PAUSE_MS
          this.pausedUntil = until
          this.pauseReason = `the WeChat bot token for '${this.accountId}' was rejected with ret/errcode ${WEIXIN_STALE_TOKEN_RETCODE}; paused until ${new Date(until).toISOString()}`
          throw new WeixinChannelError('WEIXIN_PAUSED', this.pauseReason, { cause: error })
        }
        throw new WeixinChannelError(
          'WEIXIN_SEND_FAILED',
          `weixin send part ${part.index + 1}/${part.total} to ${this.peerLabel(target.peerId)} failed: ${messageOf(error)}`,
          { cause: error },
        )
      }
    }
    return {
      parts: parts.length,
      at: this.clock.now(),
      ...(messageId === undefined ? {} : { messageId }),
    }
  }

  private async sendMediaPart(
    target: ImTarget,
    part: OutboundMediaPart,
    contextToken: string | undefined,
  ): Promise<string | undefined> {
    if (part.kind === 'voice') {
      throw new WeixinChannelError(
        'WEIXIN_BAD_TARGET',
        `weixin account '${this.accountId}' cannot send a voice part: the iLink reference implementation defines no outbound voice item`,
      )
    }
    if (part.localPath === undefined) {
      throw new WeixinChannelError(
        'WEIXIN_BAD_TARGET',
        `weixin account '${this.accountId}' cannot send a ${part.kind} without localPath: WeChat uploads local bytes only, and a remote url cannot be fetched${part.url === undefined ? '' : ' (the url was ignored)'}`,
      )
    }
    return sendWeixinMedia(
      {
        api: this.apiContext(SEND_TIMEOUT_MS),
        cdnBaseUrl: this.cdnBaseUrl,
        uploadTimeoutMs: MEDIA_TIMEOUT_MS,
        ...(this.controller === undefined ? {} : { signal: this.controller.signal }),
        toUserId: target.peerId,
        ...(contextToken === undefined ? {} : { contextToken }),
      },
      {
        kind: part.kind,
        localPath: part.localPath,
        ...(part.name === undefined ? {} : { name: part.name }),
        ...(part.caption === undefined ? {} : { caption: part.caption }),
      },
    )
  }

  private async runLoop(signal: AbortSignal, gate: StartGate): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      const pauseRemaining = this.pauseRemaining()
      if (pauseRemaining > 0) {
        await this.clock.sleep(pauseRemaining, signal)
        continue
      }
      try {
        const page = await getUpdates(
          {
            baseUrl: this.baseUrl,
            token: this.token,
            signal,
            timeoutMs: this.longPollTimeoutMs + LONG_POLL_GRACE_MS,
          },
          { cursor: this.cursor },
        )
        failures = 0
        this.pausedUntil = undefined
        this.pauseReason = undefined
        this.lastError = undefined
        if (this.onlineSince === undefined) this.onlineSince = this.clock.now()
        this.starting = false
        gate.settle(undefined)
        if (page.longPollTimeoutMs > 0) this.longPollTimeoutMs = clampLongPoll(page.longPollTimeoutMs)
        for (const message of page.messages) {
          try {
            await this.deliver(message)
          } catch (error) {
            // 单条坏消息不能拖垮整个游标：记一条 warning，其余消息照常投递。
            this.logger?.warn?.(
              `dsh-soulmojito im weixin/${this.accountId}: inbound message failed: ${messageOf(error)}`,
            )
          }
        }
        // 先投递再落游标：写完游标再崩在投递上，这页消息就永远回不来了。
        // 反过来最多重放一页，去重日志会挡住重复投喂。
        if (page.cursor !== undefined && page.cursor !== '' && page.cursor !== this.cursor) {
          this.cursor = page.cursor
          await this.persistCursor(page.cursor)
        }
      } catch (error) {
        if (signal.aborted) break
        if (isStaleToken(error)) {
          // token 失效不是「重试就好」：暂停 1 小时，期间一个请求都不发。
          const until = this.clock.now() + STALE_TOKEN_PAUSE_MS
          this.pausedUntil = until
          this.pauseReason = `the WeChat bot token for '${this.accountId}' was rejected with ret/errcode ${WEIXIN_STALE_TOKEN_RETCODE}; paused until ${new Date(until).toISOString()}`
          this.starting = false
          this.onlineSince = undefined
          this.lastError = undefined
          this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: ${this.pauseReason}`)
          gate.settle(undefined)
          await this.clock.sleep(STALE_TOKEN_PAUSE_MS, signal)
          continue
        }
        failures += 1
        const reason = `weixin getupdates for '${this.accountId}' failed (${failures} consecutive): ${messageOf(error)}`
        this.lastError = reason
        this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: ${reason}`)
        if (!gate.settled) {
          // 首个请求就失败 = 启动失败，必须抛给调用方；不在后台空转。
          gate.settle(
            new WeixinChannelError('WEIXIN_CLOSED', `weixin account '${this.accountId}' failed to start: ${messageOf(error)}`, { cause: error }),
          )
          return
        }
        if (failures >= FAILURES_BEFORE_BACKOFF) {
          failures = 0
          await this.clock.sleep(BACKOFF_DELAY_MS, signal)
        } else {
          await this.clock.sleep(RETRY_DELAY_MS, signal)
        }
      }
    }
  }

  /** 游标落盘失败只 warn：内存游标已推进，下一轮仍能续读，不该卡住消息流。 */
  private async persistCursor(cursor: string): Promise<void> {
    try {
      await this.saveCursor(cursor)
    } catch (error) {
      this.logger?.warn?.(
        `dsh-soulmojito im weixin/${this.accountId}: saving get_updates_buf failed: ${messageOf(error)}`,
      )
    }
  }

  /** 日志里的对端标签：openid 不进日志环/面板，只出现稳定 alias。 */
  private peerLabel(peerId: string): string {
    return imPeerAlias('weixin', 'private', imPeerKey('weixin', this.accountId, 'private', peerId))
  }

  private pauseRemaining(): number {
    if (this.pausedUntil === undefined) return 0
    const remaining = this.pausedUntil - this.clock.now()
    return remaining > 0 ? remaining : 0
  }

  private async deliver(message: WeixinMessage): Promise<void> {
    const prepared = this.inboundOf(message)
    if (prepared === undefined) return
    const inbound = prepared.inbound
    // context_token 按对端记账：同一对端后一条覆盖前一条，回复总是回带最近的。
    if (message.contextToken !== undefined) await this.rememberContextToken(inbound.peerId, message.contextToken)
    // 输入状态是锦上添花：不等它，也不能让它挡住投递。
    void this.setTyping(inbound.peerId, 1)
    // 媒体在路由通过去重与访问控制之后才下载：白名单外的人不能靠附件让进程落盘。
    await this.router.handle(inbound, {
      loadMedia: () => this.materializeMedia(prepared.sources),
    })
  }

  /**
   * `weixinInboundOf` 的通道层包装：纯映射在 `inbound.js`（见该文件的拆分边界
   * 说明），这里只补账号前缀的 debug 日志——宿主 logger 与账号身份属于通道侧。
   */
  private inboundOf(message: WeixinMessage): { inbound: ImInbound; sources: readonly WeixinInboundMediaSource[] } | undefined {
    const outcome = weixinInboundOf(message, this.accountId, this.clock.now())
    if (outcome.kind === 'delivered') return outcome
    this.logger?.debug?.(
      outcome.reason === 'message-type'
        ? `dsh-soulmojito im weixin/${this.accountId}: ignored message_type ${String(message.messageType)}`
        : `dsh-soulmojito im weixin/${this.accountId}: ignored a group message`,
    )
    return undefined
  }

  /** 逐个落盘；顺序与消息里的 item 一致，失败不改变 ref 的数量与顺序。 */
  private async materializeMedia(sources: readonly WeixinInboundMediaSource[]): Promise<ImMediaRef[]> {
    return materializeInboundMedia(
      {
        cdnBaseUrl: this.cdnBaseUrl,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ...(this.controller === undefined ? {} : { signal: this.controller.signal }),
        ...(this.media === undefined ? {} : { media: this.media }),
        channel: 'weixin',
        accountId: this.accountId,
        log: this.mediaLog(),
      },
      sources,
    )
  }

  /** 重新插入以保持「最近使用」顺序，超限淘汰最旧的一条。 */
  private async rememberContextToken(peerId: string, contextToken: string): Promise<void> {
    if (this.contextTokens[peerId] === contextToken) return
    delete this.contextTokens[peerId]
    this.contextTokens[peerId] = contextToken
    const keys = Object.keys(this.contextTokens)
    if (keys.length > MAX_CONTEXT_TOKENS) {
      for (const key of keys.slice(0, keys.length - MAX_CONTEXT_TOKENS)) delete this.contextTokens[key]
    }
    try {
      await this.saveContextTokens({ ...this.contextTokens })
    } catch (error) {
      // 记账失败不丢这一条消息：下一次入站会带新 token 再试。
      this.logger?.warn?.(
        `dsh-soulmojito im weixin/${this.accountId}: saving context token failed: ${messageOf(error)}`,
      )
    }
  }

  private detachAbort(): void {
    if (this.lifetimeSignal !== undefined && this.abortListener !== undefined) {
      this.lifetimeSignal.removeEventListener('abort', this.abortListener)
    }
    this.lifetimeSignal = undefined
    this.abortListener = undefined
  }
}

function isStaleToken(error: unknown): boolean {
  return error instanceof WeixinApiError && error.retcode === WEIXIN_STALE_TOKEN_RETCODE
}

/** 暂停期出站一律拒绝：错误里带恢复时间，调用方能判断是「现在不能发」而不是「发失败」。 */
function pausedError(accountId: string, remainingMs: number, now: number): WeixinChannelError {
  const resumeAt = new Date(now + remainingMs).toISOString()
  return new WeixinChannelError(
    'WEIXIN_PAUSED',
    `weixin account '${accountId}' is paused until ${resumeAt} after ret/errcode ${WEIXIN_STALE_TOKEN_RETCODE}; nothing can be sent before then`,
  )
}

function clampLongPoll(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return WEIXIN_LONG_POLL_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(value), LONG_POLL_MIN_MS), LONG_POLL_MAX_MS)
}

function requireToken(value: string, accountId: string): string {
  const token = value.trim()
  if (token === '') {
    throw new WeixinChannelError(
      'WEIXIN_BAD_SECRET',
      `weixin account '${accountId}' has no botToken; secret.botToken must be a non-empty string`,
    )
  }
  return token
}

function requireBaseUrl(value: string, accountId: string): string {
  const baseUrl = value.trim()
  if (baseUrl === '') {
    throw new WeixinChannelError(
      'WEIXIN_BAD_SECRET',
      `weixin account '${accountId}' has no baseUrl; secret.baseUrl must be the API host returned by the QR scan`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (cause) {
    throw new WeixinChannelError(
      'WEIXIN_BAD_SECRET',
      `weixin account '${accountId}' has an invalid baseUrl '${baseUrl}'; expected an absolute http(s) URL`,
      { cause },
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WeixinChannelError(
      'WEIXIN_BAD_SECRET',
      `weixin account '${accountId}' has baseUrl '${baseUrl}' with protocol '${parsed.protocol}'; expected http(s)`,
    )
  }
  return baseUrl.replace(/\/+$/, '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noop(): void {
  // 出站串行链只关心「上一轮已结束」，失败由各自的 promise 上抛。
}
