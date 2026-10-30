/**
 * 微信扫码绑定状态机（提案 0024 §4.1 / M4）。
 *
 * 与 QQ 的绑定器同形（`im/qq/bind.ts`），多一个 `verify` 相位：
 * `wait` → `scaned` → `need_verifycode`（面板输数字）→ `confirmed`。
 *
 * 四条不变量：
 * 1. 进程内只允许一个活动会话：第二个 start 直接抛 `WEIXIN_BIND_BUSY`，否则
 *    「扫码人即 owner」的归属会变成掷硬币。
 * 2. 迟到回调一律丢弃：取消时先摘会话再 abort，用会话身份比对挡住仍可能到达的
 *    `confirmed`/失败回调，绝不让已取消的扫码改写账号。
 * 3. `expired` 只允许刷新一次二维码，超过即 failed；`binded_redirect` 视为成功
 *    （平台认为已绑定，不再下发凭据）。
 * 4. `scaned_but_redirect` 把后续轮询换到 `redirect_host`；服务端只给主机名，
 *    重定向沿用当前入口的协议（默认 https，本地/自建入口保持 http）。
 *
 * 本模块不认识 store 也不认识 Tavern：凭据交给调用方的回调落库。
 */

import type { HostLogger } from '../../host-contract.js'
import type { ImBindStatus } from '../types.js'
import { qrSvgForBind } from '../qr.js'
import {
  getBotQrcode,
  getQrcodeStatus,
  WeixinApiError,
  type WeixinCredential,
  type WeixinQrcodeResult,
} from './api.js'
import type { WeixinClock } from './clock.js'

export type WeixinBindCredential = WeixinCredential

/** 二维码拉取与扫码状态的超时；状态请求本可被服务端挂起，超时按等待处理。 */
const QR_FETCH_TIMEOUT_MS = 15_000
const QR_STATUS_TIMEOUT_MS = 35_000
/** 二维码总有效期：超过即 failed，不让面板无限等。 */
const QR_TTL_MS = 5 * 60_000
/** 允许的二维码刷新次数（`expired` 时用掉一次）。 */
const MAX_QR_REFRESHES = 1

export type WeixinBindErrorCode =
  | 'WEIXIN_BIND_BUSY'
  | 'WEIXIN_BIND_ABORTED'
  | 'WEIXIN_BIND_IDLE'
  | 'WEIXIN_BIND_NOT_VERIFYING'
  | 'WEIXIN_BIND_BAD_CODE'
  | 'WEIXIN_BIND_REFRESH_EXHAUSTED'
  | 'WEIXIN_BIND_REFRESH_FAILED'

export class WeixinBindError extends Error {
  readonly code: WeixinBindErrorCode

  constructor(code: WeixinBindErrorCode, message: string) {
    super(message)
    this.name = 'WeixinBindError'
    this.code = code
  }
}

/** 调用方提供的回调：失败不是异常路径，运行时只打日志。 */
export interface WeixinBindCallbacks {
  onQrDisplayed?(url: string): void
  onSuccess(credential: WeixinBindCredential): void | Promise<void>
  /** `binded_redirect`：平台认为这个机器人已绑定，本次没有新凭据。 */
  onAlreadyBound?(): void
  onFailure?(error: Error): void
}

export interface WeixinBindStartOptions {
  /** 运行时生命信号：插件卸载/热重载时随参数中止，不留孤儿轮询。 */
  signal: AbortSignal
}

export interface WeixinBindingOptions {
  /** 扫码入口；生产是 `WEIXIN_FIXED_BASE_URL`，测试/自建可指向本地桩。 */
  qrBaseUrl: string
  botType: string
  pollIntervalMs: number
  clock: WeixinClock
  /** 本机已存 bot token：让平台在重复扫码时回 `binded_redirect` 而不是发新凭据。 */
  localTokenList: () => Promise<readonly string[]>
  logger?: HostLogger
}

export interface WeixinBinding {
  start(callbacks: WeixinBindCallbacks, options: WeixinBindStartOptions): Promise<ImBindStatus>
  /** 提交手机微信显示的数字；只在 `verify` 相位合法。 */
  submitVerifyCode(code: string): ImBindStatus
  /** 手动换一张二维码；每个会话只有一次机会。 */
  refresh(): Promise<ImBindStatus>
  cancel(): ImBindStatus
  status(): ImBindStatus
  /** 与 cancel 等价；运行时 dispose 时调用。 */
  dispose(): void
}

interface BindSession {
  readonly controller: AbortController
  readonly callbacks: WeixinBindCallbacks
  qrcode: string
  url: string
  /** 当前轮询入口；`scaned_but_redirect` 会改它。 */
  pollBaseUrl: string
  /** 已提交但还没被服务端确认的验证码。 */
  verifyCode: string | undefined
  refreshes: number
  issuedAt: number
  detach: () => void
}

export function createWeixinBinding(options: WeixinBindingOptions): WeixinBinding {
  const qrBaseUrl = requireHttpUrl(options.qrBaseUrl)
  let phase: ImBindStatus = { phase: 'idle' }
  let session: BindSession | undefined

  function status(): ImBindStatus {
    return { ...phase }
  }

  async function start(callbacks: WeixinBindCallbacks, startOptions: WeixinBindStartOptions): Promise<ImBindStatus> {
    if (session !== undefined) {
      throw new WeixinBindError('WEIXIN_BIND_BUSY', 'a WeChat QR binding session is already running; cancel it before starting another one')
    }
    if (startOptions.signal.aborted) {
      throw new WeixinBindError('WEIXIN_BIND_ABORTED', 'the WeChat QR binding cannot start: the runtime is already shutting down')
    }
    const current: BindSession = {
      controller: new AbortController(),
      callbacks,
      qrcode: '',
      url: '',
      pollBaseUrl: qrBaseUrl,
      verifyCode: undefined,
      refreshes: 0,
      issuedAt: options.clock.now(),
      detach: () => {},
    }
    session = current
    phase = { phase: 'waiting' }
    // 先挂生命信号再拉码：卸载时正在飞行的 QR 请求也必须被取消，不能留孤儿。
    const onAbort = (): void => {
      if (session === current) cancel()
    }
    startOptions.signal.addEventListener('abort', onAbort, { once: true })
    current.detach = () => { startOptions.signal.removeEventListener('abort', onAbort) }

    let qr: { qrcode: string; url: string }
    try {
      qr = await fetchQrcode(current.controller.signal)
    } catch (error) {
      if (startOptions.signal.aborted) {
        throw new WeixinBindError('WEIXIN_BIND_ABORTED', 'the WeChat QR binding was cancelled while fetching the QR code')
      }
      // 已取消的会话：错误属于过期请求，不覆盖 cancel 已经写好的 idle 相位。
      if (session !== current) return status()
      session = undefined
      current.detach()
      phase = { phase: 'failed', reason: messageOf(error) }
      throw error
    }
    // 拉码期间被取消：会话已摘，绝不再开一个无人认领的轮询。
    if (session !== current) {
      if (startOptions.signal.aborted) {
        throw new WeixinBindError('WEIXIN_BIND_ABORTED', 'the WeChat QR binding was cancelled while fetching the QR code')
      }
      return status()
    }
    current.qrcode = qr.qrcode
    current.url = qr.url
    current.issuedAt = options.clock.now()
    phase = waitingOf(current)
    callbacks.onQrDisplayed?.(qr.url)
    void poll(current)
    return status()
  }

  async function fetchQrcode(signal: AbortSignal): Promise<{ qrcode: string; url: string }> {
    const tokens = await options.localTokenList()
    return getBotQrcode(
      { baseUrl: qrBaseUrl, signal, timeoutMs: QR_FETCH_TIMEOUT_MS },
      { botType: options.botType, localTokenList: tokens },
    )
  }

  async function poll(current: BindSession): Promise<void> {
    while (session === current && !current.controller.signal.aborted) {
      if (options.clock.now() - current.issuedAt >= QR_TTL_MS) {
        failSession(current, `the WeChat QR code was not confirmed within ${Math.round(QR_TTL_MS / 60_000)} minutes`)
        return
      }
      try {
        const result = await getQrcodeStatus(
          {
            baseUrl: current.pollBaseUrl,
            signal: current.controller.signal,
            timeoutMs: QR_STATUS_TIMEOUT_MS,
          },
          {
            qrcode: current.qrcode,
            ...(current.verifyCode === undefined ? {} : { verifyCode: current.verifyCode }),
          },
        )
        if (session !== current) return
        if (await handleStatus(current, result)) return
      } catch (error) {
        if (session !== current || current.controller.signal.aborted) return
        // 扫码状态本身就是长轮询：本地超时是「还没有变化」，不是故障；
        // 真正需要留痕的是网络/HTTP/协议错误。
        if (!(error instanceof WeixinApiError && error.timedOut)) {
          options.logger?.warn?.(`dsh-soulmojito im weixin bind: QR status poll failed, retrying: ${messageOf(error)}`)
        }
      }
      await options.clock.sleep(options.pollIntervalMs, current.controller.signal)
    }
  }

  /** true = 本次扫码已结束（成功、已绑定或失败）。 */
  async function handleStatus(current: BindSession, result: WeixinQrcodeResult): Promise<boolean> {
    switch (result.status) {
      case 'wait':
        // 验证码还在等服务端确认时保持 verify 相位，面板不能把输入框收走。
        if (phase.phase !== 'verify') phase = waitingOf(current)
        return false
      case 'scaned':
        // 服务端接受过验证码（或不需验证）：暂存值作废，下一轮由服务端判定。
        current.verifyCode = undefined
        phase = waitingOf(current)
        return false
      case 'need_verifycode':
        phase = {
          phase: 'verify',
          url: current.url,
          prompt: current.verifyCode === undefined
            ? '输入手机微信显示的数字，以继续连接'
            : '验证码不正确，请重新输入',
        }
        return false
      case 'scaned_but_redirect': {
        const host = result.redirectHost
        if (host === undefined) {
          options.logger?.warn?.('dsh-soulmojito im weixin bind: scaned_but_redirect without redirect_host; keeping the current host')
          return false
        }
        current.pollBaseUrl = redirectBaseUrl(host, current.pollBaseUrl)
        options.logger?.info?.(`dsh-soulmojito im weixin bind: polling host switched to ${new URL(current.pollBaseUrl).host}`)
        return false
      }
      case 'confirmed': {
        const credential = result.credential
        if (credential === undefined) {
          // api 层已校验，这里只防御未来形状漂移：没有凭据就不算成功。
          failSession(current, 'the WeChat backend reported confirmed without a usable credential')
          return true
        }
        phase = { phase: 'saving' }
        try {
          await current.callbacks.onSuccess(credential)
        } catch (error) {
          failSession(current, `saving the WeChat credential failed: ${messageOf(error)}`)
          return true
        }
        if (session === current) {
          session = undefined
          current.detach()
          phase = { phase: 'idle' }
        }
        return true
      }
      case 'expired': {
        if (current.refreshes >= MAX_QR_REFRESHES) {
          failSession(current, 'the WeChat QR code expired again after one refresh')
          return true
        }
        return !(await refreshSession(current))
      }
      case 'verify_code_blocked':
        failSession(current, 'too many verification attempts; the WeChat backend blocked this QR code')
        return true
      case 'binded_redirect':
        // 已绑定是成功语义：本次没有新凭据，但也不该把面板钉在失败上。
        if (session === current) {
          session = undefined
          current.detach()
          phase = { phase: 'idle' }
        }
        options.logger?.info?.('dsh-soulmojito im weixin bind: this bot is already bound; no new credential was issued')
        current.callbacks.onAlreadyBound?.()
        return true
    }
  }

  /** 刷新二维码；false 表示已经失败（相位在 failSession 里写好）。 */
  async function refreshSession(current: BindSession): Promise<boolean> {
    let qr: { qrcode: string; url: string }
    try {
      qr = await fetchQrcode(current.controller.signal)
    } catch (error) {
      failSession(current, `refreshing the WeChat QR code failed: ${messageOf(error)}`)
      return false
    }
    if (session !== current) return false
    current.qrcode = qr.qrcode
    current.url = qr.url
    current.pollBaseUrl = qrBaseUrl
    current.verifyCode = undefined
    current.refreshes += 1
    current.issuedAt = options.clock.now()
    phase = { phase: 'waiting', url: qr.url }
    current.callbacks.onQrDisplayed?.(qr.url)
    return true
  }

  async function refresh(): Promise<ImBindStatus> {
    const current = session
    if (current === undefined) {
      throw new WeixinBindError('WEIXIN_BIND_IDLE', 'no WeChat QR binding is running; start a new scan first')
    }
    if (current.refreshes >= MAX_QR_REFRESHES) {
      throw new WeixinBindError(
        'WEIXIN_BIND_REFRESH_EXHAUSTED',
        'the WeChat QR code has already been refreshed once; start a new scan instead',
      )
    }
    if (!(await refreshSession(current))) {
      const reason = phase.phase === 'failed' ? phase.reason : undefined
      throw new WeixinBindError(
        'WEIXIN_BIND_REFRESH_FAILED',
        reason ?? 'refreshing the WeChat QR code failed',
      )
    }
    return status()
  }

  function submitVerifyCode(code: string): ImBindStatus {
    const current = session
    if (current === undefined) {
      throw new WeixinBindError('WEIXIN_BIND_IDLE', 'no WeChat QR binding is running; start a new scan first')
    }
    if (phase.phase !== 'verify') {
      throw new WeixinBindError(
        'WEIXIN_BIND_NOT_VERIFYING',
        `the WeChat QR binding is in phase '${phase.phase}', not 'verify'; no verification code is expected now`,
      )
    }
    const trimmed = code.trim()
    if (trimmed === '') {
      throw new WeixinBindError('WEIXIN_BIND_BAD_CODE', 'the WeChat verification code must be a non-empty string')
    }
    current.verifyCode = trimmed
    // 提交后回到 waiting：服务端在下一轮轮询里确认；错了会再回到 verify。
    phase = waitingOf(current)
    return status()
  }

  function cancel(): ImBindStatus {
    const current = session
    if (current === undefined) return status()
    // 先摘会话再中止：迟到的 confirmed/失败回调必须被当成过期回调丢弃。
    session = undefined
    phase = { phase: 'idle' }
    current.detach()
    current.controller.abort()
    return status()
  }

  function failSession(current: BindSession, reason: string): void {
    if (session !== current) return
    session = undefined
    current.detach()
    current.controller.abort()
    phase = { phase: 'failed', reason }
    current.callbacks.onFailure?.(new Error(reason))
  }

  function waitingOf(current: BindSession): ImBindStatus {
    const qrSvg = qrSvgForBind(current.url)
    return { phase: 'waiting', url: current.url, ...(qrSvg === undefined ? {} : { qrSvg }) }
  }

  return {
    start,
    submitVerifyCode,
    refresh,
    cancel,
    status,
    dispose: () => { cancel() },
  }
}

/**
 * `redirect_host` 只是主机名，协议写法是 `https://<host>`。
 * 本地桩与自建反代走 http 时沿用当前入口的协议，否则重定向会被 TLS 掐断。
 */
function redirectBaseUrl(host: string, currentBaseUrl: string): string {
  const protocol = new URL(currentBaseUrl).protocol === 'http:' ? 'http:' : 'https:'
  return `${protocol}//${host}`
}

function requireHttpUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError('the WeChat QR base URL must be a non-empty absolute URL')
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`the WeChat QR base URL '${trimmed}' has protocol '${parsed.protocol}'; expected http(s)`)
  }
  return trimmed.replace(/\/+$/, '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
