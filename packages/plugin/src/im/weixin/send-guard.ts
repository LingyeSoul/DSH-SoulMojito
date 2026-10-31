/**
 * 微信出站突发预算与 `-2` 冷却。
 *
 * iLink 对同一 bot 短时间内的多条 `sendmessage` 会返回
 * `ret/errcode -2: prepare failed`（2026-10-31 现场：约 12 条/22 秒后开始
 * 拒绝，之后每次重试都在延长惩罚）。通道先自己设上限：30 秒窗口最多 5 条
 * 独立消息；`-2` 后进入冷却，期间一个请求都不发。
 *
 * 本类只做事实记账（窗口占用、冷却截止、下一个可发时刻），排队与等待在
 * `send-queue.ts`：`reserveSlot()` 仍会在窗口满时抛错，那是队列没算准的
 * 最后一道保险，队列会接住并按 `nextWindowSlotAt()` 重排。
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
  private readonly cooldownMs: number
  private sendWindow: number[] = []
  private throttledUntil: number | undefined

  constructor(options: { accountId: string; clock: WeixinClock; cooldownMs?: number }) {
    this.accountId = options.accountId
    this.clock = options.clock
    this.cooldownMs = options.cooldownMs ?? SEND_THROTTLE_COOLDOWN_MS
  }

  /** 账号启动/停止时清空：窗口与冷却是连接期内的事实。 */
  reset(): void {
    this.sendWindow = []
    this.throttledUntil = undefined
  }

  /**
   * 最早的「窗口有空位」时刻：`notBefore` 之前没有额就等到第五老的一条过期，
   * 并逐条内推（窗口里已有 6 条时要把 2 条等出窗口）。只读，不占位。
   */
  nextWindowSlotAt(notBefore: number): number {
    const now = this.clock.now()
    this.sendWindow = this.sendWindow.filter((at) => now - at < SEND_WINDOW_MS)
    if (this.sendWindow.length < SEND_WINDOW_MAX) return notBefore
    const overflow = this.sendWindow.length - SEND_WINDOW_MAX
    return Math.max(notBefore, (this.sendWindow[overflow] ?? now) + SEND_WINDOW_MS)
  }

  /** 冷却截止时刻；未冷却时为 undefined。状态投影只读它，不改任何事实。 */
  throttleUntil(): number | undefined {
    return this.throttledUntil
  }

  /** 占一个窗口名额；超限立刻抛错，由队列接住等待后重试。 */
  reserveSlot(): void {
    const now = this.clock.now()
    this.sendWindow = this.sendWindow.filter((at) => now - at < SEND_WINDOW_MS)
    if (this.sendWindow.length >= SEND_WINDOW_MAX) {
      const retryAt = (this.sendWindow[0] ?? now) + SEND_WINDOW_MS
      throw new WeixinChannelError(
        'WEIXIN_SEND_BUDGET_EXHAUSTED',
        `weixin account '${this.accountId}' refused to send: ${SEND_WINDOW_MAX} messages already went out within ${SEND_WINDOW_MS / 1000}s, and iLink throttles a bot after a burst of separate messages (ret/errcode ${ILINK_RETCODE_ERROR} prepare failed). Sending is allowed again at ${new Date(retryAt).toISOString()}.`,
      )
    }
    this.sendWindow.push(now)
  }

  /** 记录一次 `-2` 惩罚，返回带恢复时间的错误。 */
  throttle(peerLabel: string, cause: unknown): WeixinChannelError {
    const until = this.clock.now() + this.cooldownMs
    this.throttledUntil = until
    return new WeixinChannelError(
      'WEIXIN_THROTTLED',
      `weixin send to ${peerLabel} was rejected by iLink with ret/errcode ${ILINK_RETCODE_ERROR} (prepare failed); the bot sent too many separate messages in a short window, so sending is paused until ${new Date(until).toISOString()}. The message was NOT delivered; do not retry it in this turn because retrying extends the penalty`,
      { cause },
    )
  }
}

/** `ret/errcode -2`：iLink 的突发节流/请求未准备。 */
export function isIlinkThrottle(error: unknown): boolean {
  return error instanceof WeixinApiError && error.retcode === ILINK_RETCODE_ERROR
}
