/**
 * 微信 `typing_ticket` 缓存（提案 0024 §2.2）。
 *
 * 输入状态是可选能力，但 `getconfig` 是真实请求：每条入站/出站都打一次会把长轮询
 * 的带宽花在「正在输入」上。按对端缓存 30 分钟、上限 500 条（LRU），服务端没给
 * ticket 时不缓存——空 ticket 发出去只会白失败一次。
 *
 * 纯函数式封装：返回一个闭包对象，`now` 由调用方传入（通道用注入时钟）。
 */

/** ticket 有效期：30 分钟；过期即重新 `getconfig`。 */
export const TYPING_TICKET_TTL_MS = 30 * 60 * 1_000
/** 记账表上限：长跑进程不能让每个对端都永久驻留。 */
export const MAX_TYPING_TICKETS = 500

export interface TypingTicketCache {
  /** 命中且未过期时返回 ticket；过期条目顺手淘汰。 */
  get(peerId: string, now: number): string | undefined
  /** 写入并保持「最近使用」顺序；超限淘汰最旧的一条。 */
  set(peerId: string, ticket: string, now: number): void
  /** 服务端判定过期时淘汰，调用方再取一次。 */
  delete(peerId: string): void
}

export function createTypingTicketCache(options: { ttlMs: number; max: number }): TypingTicketCache {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new TypeError(`typing ticket ttl must be a positive integer, got ${String(options.ttlMs)}`)
  }
  if (!Number.isSafeInteger(options.max) || options.max <= 0) {
    throw new TypeError(`typing ticket capacity must be a positive integer, got ${String(options.max)}`)
  }
  const entries = new Map<string, { ticket: string; at: number }>()
  return {
    get(peerId, now) {
      const cached = entries.get(peerId)
      if (cached === undefined) return undefined
      if (now - cached.at >= options.ttlMs) {
        entries.delete(peerId)
        return undefined
      }
      return cached.ticket
    },
    set(peerId, ticket, now) {
      entries.delete(peerId)
      entries.set(peerId, { ticket, at: now })
      while (entries.size > options.max) {
        const oldest = entries.keys().next()
        if (oldest.done === true) return
        entries.delete(oldest.value)
      }
    },
    delete(peerId) {
      entries.delete(peerId)
    },
  }
}