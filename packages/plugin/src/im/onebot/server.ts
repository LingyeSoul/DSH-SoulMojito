/**
 * OneBot 11 通道（提案 0024 §2.3 / M2）：反向 WS + HTTP POST 入站 + WS 出站。
 *
 * 本插件是 OneBot 的**对端**：上游实现连到 `${API}/im/onebot/ws`，握手头带
 * `X-Self-ID` / `X-Client-Role`；或者用 HTTP POST 把事件推到 webhook。两条入站
 * 路径共用同一条管线：parseOneBotMessage → 群 @ 门控 → RouterSink.handle。
 *
 * 鉴权只有一个 token，优先级 Authorization: Bearer → X-OneBot-Token →
 * ?access_token=。第一个出现的凭据不匹配就拒绝，不向后查找第二个——否则
 * 攻击者带一个错误 Bearer 就能靠 query 里的旧 token 混进来。token 为空一律
 * 拒绝，绝不把「没配置密钥」当成「不需要密钥」。
 *
 * 出站只走 Universal/API 连接：Event 连接按协议只收事件，往上发 API 调用会被
 * 上游忽略，等待响应直到超时；宁可当场报「没有可用连接」。
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { HostLogger } from '../../host-contract.js'
import type { ImChannel, ImChannelStatus, ImInbound, ImSendReceipt, ImTarget, OutboundPart } from '../types.js'
import { OneBotCodecError, oneBotMentioned, oneBotSendCall, parseOneBotMessage } from './codec.js'
import { acceptWebSocket, type WsConnection } from './ws.js'

/** OneBot 反向 WS 的连接角色；只有 Universal/API 能收 API 响应。 */
export type OneBotRole = 'API' | 'Event' | 'Universal'

/** 出站 API 响应超时：OneBot 上游是本地实现，10s 足够暴露断连或死循环。 */
const REQUEST_TIMEOUT_MS = 10_000
/** webhook 请求体上限（提案 §4.4）；OneBot 事件本身通常只有几 KB。 */
const WEBHOOK_BODY_LIMIT = 256 * 1024

export type OneBotErrorCode =
  | 'ONEBOT_BAD_SECRET'
  | 'ONEBOT_BAD_REQUEST'
  | 'ONEBOT_BODY_TOO_LARGE'
  | 'ONEBOT_BAD_TARGET'
  | 'ONEBOT_NO_CONNECTION'
  | 'ONEBOT_CLOSED'
  | 'ONEBOT_TIMEOUT'
  | 'ONEBOT_API_FAILED'

export class OneBotError extends Error {
  readonly code: OneBotErrorCode

  constructor(code: OneBotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OneBotError'
    this.code = code
  }
}

/** 入站落点；运行时把 `router.inbound` 包一层交给通道，通道不认识 Tavern。 */
export interface OneBotRouterSink {
  handle(inbound: ImInbound): Promise<void>
}

export interface OneBotChannelOptions {
  accountId: string
  /** `ImStore.readSecret('onebot', accountId)` 的密钥袋，只认 token。 */
  secret: Readonly<Record<string, string>>
  router: OneBotRouterSink
  /** 群消息是否必须 @ 机器人；来自 state.imSettings.groupRequireMention。 */
  groupRequireMention: () => Promise<boolean>
  now: () => number
  logger?: HostLogger
}

/** 握手成功后解析出的连接身份。 */
export interface OneBotUpgradeClaims {
  role: OneBotRole
  selfId: string
}

interface PendingCall {
  resolve: (response: Record<string, unknown>) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface LiveConnection {
  connection: WsConnection
  role: OneBotRole
  selfId: string
  since: number
  closed: boolean
  waiters: Map<string, PendingCall>
  /** 同一连接上的出站分片串行化：两轮回复并发时不得交错。 */
  sendChain: Promise<void>
}

export class OneBotChannel implements ImChannel {
  readonly channel = 'onebot' as const
  readonly accountId: string

  private readonly token: string
  private readonly router: OneBotRouterSink
  private readonly groupRequireMention: () => Promise<boolean>
  private readonly now: () => number
  private readonly logger: HostLogger | undefined
  private readonly connections = new Map<string, LiveConnection>()
  /** 账号级入站 FIFO 链尾：webhook 与反向 WS 共用一个账号的到达顺序。 */
  private inboundTail: Promise<void> = Promise.resolve()

  private started = false
  private lastError: string | undefined
  private signal: AbortSignal | undefined
  private abortListener: (() => void) | undefined

  constructor(options: OneBotChannelOptions) {
    const token = options.secret.token
    if (typeof token !== 'string' || token.trim() === '') {
      throw new OneBotError(
        'ONEBOT_BAD_SECRET',
        `onebot account '${options.accountId}' has no token; secret.token must be a non-empty string`,
      )
    }
    this.accountId = options.accountId
    this.token = token
    this.router = options.router
    this.groupRequireMention = options.groupRequireMention
    this.now = options.now
    this.logger = options.logger
  }

  /** 反向 WS 只登记「等待连接」，不发任何网络请求；连接由 upgrade 路由送进来。 */
  async start(signal: AbortSignal): Promise<void> {
    if (this.started) return
    if (signal.aborted) {
      throw new OneBotError('ONEBOT_CLOSED', `onebot account '${this.accountId}' cannot start: signal is already aborted`)
    }
    this.started = true
    this.signal = signal
    this.abortListener = () => { void this.stop() }
    signal.addEventListener('abort', this.abortListener, { once: true })
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.signal !== undefined && this.abortListener !== undefined) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
    this.signal = undefined
    this.abortListener = undefined
    for (const live of [...this.connections.values()]) {
      this.connections.delete(live.connection.id)
      this.rejectWaiters(live, 'channel stopped')
      live.connection.close(1001, 'channel stopped')
    }
  }

  status(): ImChannelStatus {
    // 「有连接」不等于「能出站」：Event-only 客户端只上报事件，发送会抛错。
    const sendable = this.sendConnection()
    if (sendable !== undefined) {
      let since = Number.POSITIVE_INFINITY
      for (const live of this.connections.values()) since = Math.min(since, live.since)
      return { state: 'online', since }
    }
    if (this.connections.size > 0) {
      return { state: 'paused', reason: 'connected without an API/Universal client; outbound messages are unavailable' }
    }
    if (this.lastError !== undefined) return { state: 'error', message: this.lastError }
    return { state: 'idle' }
  }

  async send(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    if (target.channel !== 'onebot') {
      throw new OneBotError('ONEBOT_BAD_TARGET', `onebot channel cannot send to channel '${target.channel}'`)
    }
    if (target.accountId !== this.accountId) {
      throw new OneBotError(
        'ONEBOT_BAD_TARGET',
        `onebot account '${target.accountId}' cannot send through account '${this.accountId}'`,
      )
    }
    if (parts.length === 0) return { parts: 0, at: this.now() }

    const live = this.sendConnection()
    if (live === undefined) {
      throw new OneBotError(
        'ONEBOT_NO_CONNECTION',
        `onebot account '${this.accountId}' has no onebot connection; the upstream must connect before replies can be delivered`,
      )
    }
    // 同一连接上的出站串行：两轮回复并发时，分片必须整轮发完再发下一轮，
    // 否则用户会看到 A1,B1,A2,B2 这种交错碎片（审查 P1-2）。
    const queued = live.sendChain.then(() => this.sendParts(live, target, parts))
    live.sendChain = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async sendParts(live: LiveConnection, target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt> {
    let messageId: string | undefined
    for (const part of parts) {
      const call = this.sendCallOf(target, part)
      const response = await this.call(live, call.action, call.params)
      if (response.status !== 'ok') {
        throw new OneBotError(
          'ONEBOT_API_FAILED',
          `onebot action '${call.action}' failed: status=${describeValue(response.status)} retcode=${describeValue(response.retcode)}${apiDetailOf(response)}`,
        )
      }
      const id = messageIdOf(response)
      if (id !== undefined) messageId = id
    }
    return { parts: parts.length, at: this.now(), ...(messageId === undefined ? {} : { messageId }) }
  }

  /** upgrade 鉴权：token + 两个握手头都必须合法，否则调用方回 401 而不是升级。 */
  authorizeUpgrade(req: IncomingMessage): OneBotUpgradeClaims | undefined {
    if (!this.tokenMatches(requestToken(req))) return undefined
    const selfId = headerOf(req, 'x-self-id')
    const role = roleOf(headerOf(req, 'x-client-role'))
    // self_id 在 OneBot 里是 QQ 号；群 @ 判定与事件里的 at 段直接比较，必须是十进制。
    if (selfId === undefined || !/^\d+$/.test(selfId) || role === undefined) return undefined
    return { role, selfId }
  }

  /** webhook 不要求握手头，只认 token；供运行时在多账号间挑选归属。 */
  acceptsWebhook(req: IncomingMessage): boolean {
    return this.tokenMatches(requestToken(req))
  }

  /** 接管已握手的连接；调用方保证 authorizeUpgrade 已通过。 */
  attach(connection: WsConnection, claims: OneBotUpgradeClaims): void {
    const live: LiveConnection = {
      connection,
      role: claims.role,
      selfId: claims.selfId,
      since: this.now(),
      closed: false,
      waiters: new Map(),
      sendChain: Promise.resolve(),
    }
    this.connections.set(connection.id, live)
    this.lastError = undefined
    this.logger?.info?.(`dsh-soulmojito im onebot/${this.accountId}: ${claims.role} connection ${connection.id} attached (self_id ${claims.selfId})`)

    connection.onText((text) => { this.onFrame(live, text) })
    connection.onClose(() => {
      live.closed = true
      if (this.connections.get(connection.id) === live) this.connections.delete(connection.id)
      this.rejectWaiters(live, 'connection closed')
    })
  }

  /** 握手/协议错误记在账号状态上；下次成功连接时清掉。 */
  noteError(message: string): void {
    this.lastError = message
    this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: ${message}`)
  }

  /**
   * HTTP POST 入站（提案 §6.2 的 webhook）。响应体只回 `{}`：本实现不做快速
   * 操作，入站结果由回复链路另发，调用方不需要从响应里读生成内容。
   */
  async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.tokenMatches(requestToken(req))) {
      respondJson(res, 401, { ok: false, message: 'unauthorized' })
      return
    }
    if (req.method !== 'POST') {
      respondJson(res, 405, { ok: false, message: "onebot webhook only accepts POST" })
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req, WEBHOOK_BODY_LIMIT)
    } catch (error) {
      if (error instanceof OneBotError) {
        respondJson(res, error.code === 'ONEBOT_BODY_TOO_LARGE' ? 413 : 400, { ok: false, message: error.message })
        return
      }
      throw error
    }
    if (!isJsonObject(body)) {
      respondJson(res, 400, { ok: false, message: 'onebot webhook body must be a JSON object' })
      return
    }
    let inbound: ImInbound | undefined
    try {
      inbound = parseOneBotMessage(body, this.accountId, this.now())
    } catch (error) {
      if (error instanceof OneBotCodecError) {
        respondJson(res, 400, { ok: false, message: error.message })
        return
      }
      throw error
    }
    if (inbound === undefined) {
      respondJson(res, 200, {})
      return
    }
    if (inbound.scope === 'group' && await this.groupRequireMention() && !oneBotMentioned(body, selfIdOf(body))) {
      respondJson(res, 200, {})
      return
    }
    const message = inbound
    try {
      await this.enqueueInbound(() => this.router.handle(message))
    } catch (error) {
      this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: webhook inbound failed: ${messageOf(error)}`)
      respondJson(res, 500, { ok: false, message: 'onebot inbound handling failed' })
      return
    }
    respondJson(res, 200, {})
  }

  /**
   * 入站按账号串行：webhook 与反向 WS 排进同一条 FIFO，两个连接同时到达也
   * 不会并发进 router。返回本次任务自己的 Promise，调用方拿得到成功/失败；
   * 链尾吞掉拒绝，一条消息失败不会毒化后续入站。
   */
  private enqueueInbound(task: () => Promise<void>): Promise<void> {
    const queued = this.inboundTail.then(task)
    this.inboundTail = queued.then(() => undefined, () => undefined)
    return queued
  }

  private tokenMatches(presented: string | undefined): boolean {
    if (presented === undefined || presented === '') return false
    const expected = Buffer.from(this.token, 'utf8')
    const actual = Buffer.from(presented, 'utf8')
    // 长度不同时 timingSafeEqual 会抛错，先比较长度；token 长度本身不是秘密。
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  private sendCallOf(target: ImTarget, part: OutboundPart): ReturnType<typeof oneBotSendCall> {
    try {
      return oneBotSendCall(target, part)
    } catch (error) {
      if (error instanceof OneBotCodecError) {
        throw new OneBotError('ONEBOT_BAD_TARGET', error.message, { cause: error })
      }
      throw error
    }
  }

  private sendConnection(): LiveConnection | undefined {
    const live = [...this.connections.values()].filter((entry) => !entry.closed)
    return live.find((entry) => entry.role === 'Universal') ?? live.find((entry) => entry.role === 'API')
  }

  private call(
    live: LiveConnection,
    action: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const echo = randomUUID()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.waiters.delete(echo)
        reject(new OneBotError(
          'ONEBOT_TIMEOUT',
          `onebot action '${action}' got no response within ${REQUEST_TIMEOUT_MS}ms (echo ${echo})`,
        ))
      }, REQUEST_TIMEOUT_MS)
      // 不给进程续命：超时定时器只在请求进行中有意义。
      timer.unref?.()
      live.waiters.set(echo, { resolve, reject, timer })
      try {
        live.connection.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        live.waiters.delete(echo)
        reject(new OneBotError(
          'ONEBOT_CLOSED',
          `onebot connection '${live.connection.id}' is closed; action '${action}' was not sent`,
          { cause: error },
        ))
      }
    })
  }

  private onFrame(live: LiveConnection, text: string): void {
    if (live.closed) return
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: dropped a non-JSON frame`)
      return
    }
    if (!isJsonObject(value)) {
      this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: dropped a frame that is not a JSON object`)
      return
    }
    const echo = value.echo
    if (typeof echo === 'string') {
      const waiter = live.waiters.get(echo)
      if (waiter === undefined) {
        this.logger?.debug?.(`dsh-soulmojito im onebot/${this.accountId}: ignored a response for unknown echo ${echo}`)
        return
      }
      live.waiters.delete(echo)
      clearTimeout(waiter.timer)
      waiter.resolve(value)
      return
    }
    // Event 连接只收事件；API 连接只发调用，事件从别的连接来。
    if (live.role === 'API') return
    // 入站走账号级 FIFO，不再按连接各排一条链：多连接与 webhook 混发也不交错。
    void this.enqueueInbound(() => this.deliverEvent(live, value))
      .catch((error: unknown) => {
        this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: inbound event failed: ${messageOf(error)}`)
      })
  }

  private async deliverEvent(live: LiveConnection, event: Record<string, unknown>): Promise<void> {
    let inbound: ImInbound | undefined
    try {
      inbound = parseOneBotMessage(event, this.accountId, this.now())
    } catch (error) {
      if (error instanceof OneBotCodecError) {
        this.logger?.warn?.(`dsh-soulmojito im onebot/${this.accountId}: dropped a malformed event: ${error.message}`)
        return
      }
      throw error
    }
    if (inbound === undefined) return
    if (inbound.scope === 'group' && await this.groupRequireMention() && !oneBotMentioned(event, live.selfId)) {
      return
    }
    await this.router.handle(inbound)
  }

  private rejectWaiters(live: LiveConnection, reason: string): void {
    for (const waiter of live.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new OneBotError(
        'ONEBOT_CLOSED',
        `onebot connection '${live.connection.id}' closed before the action replied: ${reason}`,
      ))
    }
    live.waiters.clear()
  }
}

/** upgrade 路由处理器：token 先于握手，401 因此能作为真正的 HTTP 响应发出去。 */
export type OneBotUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface OneBotUpgradeHandlerOptions {
  /** 每次握手时取当前账号表：账号可以随时增删，闭包不能缓存空表。 */
  channels: () => readonly OneBotChannel[]
  logger?: HostLogger
}

export function createOneBotUpgradeHandler(options: OneBotUpgradeHandlerOptions): OneBotUpgradeHandler {
  return (req, socket, head) => {
    let owner: OneBotChannel | undefined
    let claims: OneBotUpgradeClaims | undefined
    for (const channel of options.channels()) {
      const found = channel.authorizeUpgrade(req)
      if (found !== undefined) {
        owner = channel
        claims = found
        break
      }
    }
    if (owner === undefined || claims === undefined) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      options.logger?.warn?.('dsh-soulmojito im: rejected an OneBot upgrade without a matching token')
      return
    }
    let connection: WsConnection
    try {
      connection = acceptWebSocket(req, socket, head)
    } catch (error) {
      owner.noteError(messageOf(error))
      return
    }
    owner.attach(connection, claims)
  }
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  const body = `${statusText}\n`
  if (socket.destroyed || !socket.writable) {
    socket.destroy()
    return
  }
  socket.end([
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

/**
 * 凭据只认两条头：`Authorization: Bearer` → `X-OneBot-Token`。
 *
 * 刻意不支持 `?access_token=`：查询串会进访问日志与反代日志，而且
 * `URLSearchParams` 会把 token 里的 `+` 解码成空格，含 `+` 的 token 永远匹配
 * 不上（审查 P2-1）。上游要传凭据就用头。
 */
function requestToken(req: IncomingMessage): string | undefined {
  const authorization = headerOf(req, 'authorization')
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    return match?.[1]?.trim()
  }
  return headerOf(req, 'x-onebot-token')
}

function roleOf(value: string | undefined): OneBotRole | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'api':
      return 'API'
    case 'event':
      return 'Event'
    case 'universal':
      return 'Universal'
    default:
      return undefined
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function selfIdOf(event: Record<string, unknown>): string {
  const value = event.self_id
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''
}

function messageIdOf(response: Record<string, unknown>): string | undefined {
  const data = response.data
  if (!isJsonObject(data)) return undefined
  const id = data.message_id
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id)
  if (typeof id === 'string' && id !== '') return id
  return undefined
}

function apiDetailOf(response: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof response.message === 'string' && response.message !== '') parts.push(`message='${response.message}'`)
  if (typeof response.wording === 'string' && response.wording !== '') parts.push(`wording='${response.wording}'`)
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded === true) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        settled = true
        // 不能 destroy：413 还要写回客户端。剩余字节丢弃，不再累积。
        req.resume()
        reject(new OneBotError('ONEBOT_BODY_TOO_LARGE', `onebot webhook body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new OneBotError('ONEBOT_BAD_REQUEST', 'onebot webhook body is not valid JSON', { cause: error }))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(new OneBotError('ONEBOT_BAD_REQUEST', 'reading the onebot webhook body failed', { cause: error }))
    })
  })
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
