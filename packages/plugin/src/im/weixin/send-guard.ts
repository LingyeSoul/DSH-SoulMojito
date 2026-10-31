/**
 * 微信出站突发预算与 `-2` 冷却。
 *
 * iLink 对同一 bot 短时间内的多条 `sendmessage` 会返回
 * `ret/errcode -2: prepare failed`（2026-10-31 现场：约 12 条/22 秒后开始
 * 拒绝，之后每次重试都在延长惩罚）。通道先自己设上限：30 秒窗口最多 5 条
 * 独立消息，超出直接拒绝、不打到服务端；`-2` 后进入冷却，期间一个请求都不发。
 *
 * 状态是进程内的：重启允许再探测一次，比无限重试安全。
 */

import { WeixinApiError } from './api.js'
import type { WeixinClock } from './clock.js'
import { WeixinChannelError } from './errors.js'

/** 滑动窗口长度。 */
export const SEND_WINDOW_MS = 30_000
/** 窗口内允许的独立 `sendmessage` 条数（文字与媒体按 part 计）。 */
export const SEND_WINDOW_MAX = 5
/** `-2` 惩罚冷却：期间一个 `sendmessage` 都不发；重试只会延长惩罚。 */
export const SEND_THROTTLE_COOLDOWN_MS = 5 * 60_000
/** iLink 的 `-2`：参数错误/突发节流；本通道按节流处理。 */
const ILINK_RETCODE_ERROR = -2

export class WeixinSendGuard {
  private readonly accountId: string
  private readonly clock: WeixinClock
  private sendWindow: number[] = []
  private throttledUntil: number | undefined

  constructor(options: { accountId: string; clock: WeixinClock }) {
    this.accountId = options.accountId
    this.clock = options.clock
  }

  /** 账号启动/停止时清空：窗口与冷却是连接期内的事实。 */
  reset(): void {
    this.sendWindow = []
    this.throttledUntil = undefined
  }

  /** 冷却期直接拒绝，不发请求。 */
  rejectIfCoolingDown(): void {
    const remaining = this.throttleRemaining()
    if (remaining > 0) throw throttledError(this.accountId, remaining, this.clock.now())
  }

  /** 占一个窗口名额；超限立刻拒绝，不排队、不等待。 */
  reserveSlot(): void {
    const now = this.clock.now()
    this.sendWindow = this.sendWindow.filter((at) => now - at < SEND_WINDOW_MS)
    if (this.sendWindow.length >= SEND_WINDOW_MAX) {
      const retryAt = (this.sendWindow[0] ?? now) + SEND_WINDOW_MS
      throw new WeixinChannelError(
        'WEIXIN_SEND_BUDGET_EXHAUSTED',
        `weixin account '${this.accountId}' refused to send: ${SEND_WINDOW_MAX} messages already went out within ${SEND_WINDOW_MS / 1000}s, and iLink throttles a bot after a burst of separate messages (ret/errcode ${ILINK_RETCODE_ERROR} prepare failed). The message was NOT delivered; do not retry it in this turn. Sending is allowed again at ${new Date(retryAt).toISOString()}.`,
      )
    }
    this.sendWindow.push(now)
  }

  /** 记录一次 `-2` 惩罚，返回带恢复时间的错误。 */
  throttle(peerLabel: string, cause: unknown): WeixinChannelError {
    const until = this.clock.now() + SEND_THROTTLE_COOLDOWN_MS
    this.throttledUntil = until
    return new WeixinChannelError(
      'WEIXIN_THROTTLED',
      `weixin send to ${peerLabel} was rejected by iLink with ret/errcode ${ILINK_RETCODE_ERROR} (prepare failed); the bot sent too many separate messages in a short window, so sending is paused until ${new Date(until).toISOString()}. The message was NOT delivered; do not retry it in this turn because retrying extends the penalty`,
      { cause },
    )
  }

  private throttleRemaining(): number {
    if (this.throttledUntil === undefined) return 0
    const remaining = this.throttledUntil - this.clock.now()
    return remaining > 0 ? remaining : 0
  }
}

/** `ret/errcode -2`：iLink 的突发节流/请求未准备。 */
export function isIlinkThrottle(error: unknown): boolean {
  return error instanceof WeixinApiError && error.retcode === ILINK_RETCODE_ERROR
}

/** 冷却期出站一律拒绝；重试会延长 iLink 的惩罚。 */
function throttledError(accountId: string, remainingMs: number, now: number): WeixinChannelError {
  const resumeAt = new Date(now + remainingMs).toISOString()
  return new WeixinChannelError(
    'WEIXIN_THROTTLED',
    `weixin account '${accountId}' is cooling down until ${resumeAt} after iLink rejected a send with ret/errcode ${ILINK_RETCODE_ERROR} (prepare failed); nothing was delivered, and retrying now only extends the penalty`,
  )
}
