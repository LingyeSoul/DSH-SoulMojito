/**
 * IM 消息引用（决策 2026-10-31-im-message-refs）：每条已投递入站消息一个稳定、
 * 可引用的 `msg-<hash>`，relay 头部带它，`im_send` 的 `replyTo` 用它在事后锚回
 * 触发消息与对端（QQ 被动回复的 `msg_id`）。
 *
 * 引用只从 `dedupeKey` 派生：同一平台消息重放（插件重启、平台补发、通道重连）
 * 算出的引用一致，`replyTo` 才能跨重连命中。对外只暴露哈希——peerId、openid
 * 与平台消息 id 绝不进 ref/relay 文本/摘要（模型可能把 ref 复述到群里）。
 *
 * 表是进程内的：TTL 与容量都是硬的，重载/重启即失，引用只服务刚收到的消息。
 */

import { createHash } from 'node:crypto'

/** 引用的存活时间：平台被动回复窗口远短于此，过期即拒绝解析。 */
export const IM_MESSAGE_REF_TTL_MS = 10 * 60_000

/** 引用表容量上限：只保最近投递的消息，陌生人群刷不爆内存。 */
export const IM_MESSAGE_REF_MAX_ENTRIES = 1000

/** `dedupeKey` → 稳定引用：`msg-` + sha256 前 10 位十六进制，等长、单向、不带平台身份。 */
export function imMessageRef(dedupeKey: string): string {
  return `msg-${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 10)}`
}

/** 一条已投递消息的引用记录：回谁、投进哪个会话、被动锚点是什么、何时投递。 */
export interface ImMessageRefEntry {
  peerKey: string
  sessionId: string
  replyTo?: string
  at: number
}

/**
 * 进程内引用表：`record`/`resolve` 都先清理过期条目。
 * - `record`：同 ref 覆盖并移到最新；满载时从最旧开始淘汰。
 * - `resolve`：过期条目视同不存在，绝不拿旧锚点猜。
 */
export function createImMessageRefStore(options: {
  now: () => number
  ttlMs: number
  maxEntries: number
}): {
  record(ref: string, entry: ImMessageRefEntry): void
  resolve(ref: string): ImMessageRefEntry | undefined
  size(): number
} {
  const entries = new Map<string, ImMessageRefEntry>()

  function pruneExpired(): void {
    const now = options.now()
    for (const [ref, entry] of entries) {
      if (now - entry.at > options.ttlMs) entries.delete(ref)
    }
  }

  return {
    record(ref: string, entry: ImMessageRefEntry): void {
      pruneExpired()
      // 覆盖要挪到 Map 末尾：淘汰只认「最旧」，重放不该让刚记的条目提前出局。
      entries.delete(ref)
      while (entries.size >= options.maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      entries.set(ref, entry)
    },
    resolve(ref: string): ImMessageRefEntry | undefined {
      pruneExpired()
      return entries.get(ref)
    },
    size(): number {
      return entries.size
    },
  }
}