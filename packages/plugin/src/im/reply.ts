/**
 * 回复目标与正文抽取（提案 0024 §3.3.1）。
 *
 * 共享模式下同一个会话服务多个 peer，所以「这一轮回复发给谁」不能靠会话反查，
 * 只能靠入站时登记的 message id。这里把登记表与「从 turn 事件里取正文」做成
 * 纯逻辑，宿主事件由调用方喂进来——便于在没有真 agent 的测试里跑全部分支。
 */

import type { ImTarget } from './types.js'

/**
 * 宿主会话事件的最小结构：`bind` 的 `HostSessionEvent` 把 `type` 声明成
 * unknown（跨版本兼容层不保证形状），这里只按字符串比较与 `data` 取字段。
 */
export interface ImSessionEventLike {
  type?: unknown
  data?: Record<string, unknown>
}

export interface PendingOrigin {
  messageId: string
  peerKey: string
  /** 回复目标随登记一起记住：peerKey 反解不如当场记下可靠。 */
  target: ImTarget
  at: number
}

export interface PendingOriginsOptions {
  ttlMs: number
  maxPerSession: number
}

/**
 * 会话 → 待回复来源的登记表（进程内）。
 *
 * 只解决「这一轮是谁引起的」：丢一条登记的后果是这一轮不回 IM（保守失败），
 * 而不是发错人。因此重启即失是可以接受的。
 */
export class PendingOrigins {
  private readonly bySession = new Map<string, PendingOrigin[]>()
  private readonly options: PendingOriginsOptions

  constructor(options: PendingOriginsOptions) {
    this.options = options
  }

  remember(sessionId: string, messageId: string, peerKey: string, target: ImTarget, now: number): void {
    this.prune(now)
    const list = this.bySession.get(sessionId) ?? []
    list.push({ messageId, peerKey, target, at: now })
    while (list.length > this.options.maxPerSession) list.shift()
    this.bySession.set(sessionId, list)
  }

  /**
   * 按本轮出现过的 user message id 解析来源。命中即删除（一轮只回一次），
   * 同时清掉本轮其它命中项——它们的内容已并入同一轮，再各回一次会刷屏。
   */
  resolve(sessionId: string, messageIds: readonly string[], now: number): PendingOrigin | undefined {
    this.prune(now)
    const list = this.bySession.get(sessionId)
    if (list === undefined || list.length === 0) return undefined
    const wanted = new Set(messageIds)
    const first = list.find((entry) => wanted.has(entry.messageId))
    if (first === undefined) return undefined
    const remaining = list.filter((entry) => entry !== first && !wanted.has(entry.messageId))
    if (remaining.length === 0) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, remaining)
    return first
  }

  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  pendingCount(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0
  }

  private prune(now: number): void {
    for (const [sessionId, list] of this.bySession) {
      const alive = list.filter((entry) => now - entry.at <= this.options.ttlMs)
      if (alive.length === 0) this.bySession.delete(sessionId)
      else if (alive.length !== list.length) this.bySession.set(sessionId, alive)
    }
  }
}

/**
 * 本轮的用户消息 id。
 *
 * 真实宿主有两条入站形状（2026-10-30/31 实机取证的 V4 会话日志）：
 *
 * - `user/message`：来自客户端的消息。**不带 `turn`**（只有 `turn/start`/
 *   `turn/end`/`assistant/*` 带），所以按日志位置归轮；
 * - `agent/inbox/spliced`：`followup` 投递的消息（IM 全走这条）。消息先 splice 进
 *   `next-turn` 队列，下一轮开始时再以一条 `removedCount` 的 splice 取出消费——
 *   日志里**没有** `user/message`。移除事件不带 id，只能按 splice 的
 *   `start`/`removedCount` 从队列里定位被消费的那几条。
 *
 * 因此这里同时折叠两种形状：`turn/start` 打开一轮、`turn/end` 关闭；夹在中间的
 * `user/message` 属于当前轮；`turn/end` 之后、下一次 `turn/start` 之前的属于下一
 * 轮。inbox 队列则严格跟随 splice 事件（插入 + 移除），只有在某一轮**打开期间**
 * 被移除的消息才算被这一轮消费（与宿主 `foldConsumedWork` 的判据一致）。
 * 仍然接受 `user/message` 上显式的 `turn`（旧测试与未来宿主形状）。
 */
export function userMessageIdsOfTurn(events: readonly ImSessionEventLike[], turn: number): string[] {
  const ids: string[] = []
  let current: number | undefined
  let queued: string[] = []
  let pendingInbox: readonly unknown[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = turnOf(event)
      if (current === turn) ids.push(...queued)
      queued = []
      continue
    }
    if (event.type === 'turn/end') {
      current = undefined
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const splice = inboxSpliceOf(event.data)
      if (splice === undefined) continue
      // 与宿主的写入校验一致：越界的 splice 说明日志不可信，整条跳过（保守失败）。
      if (splice.start + splice.removedCount > pendingInbox.length) continue
      const removed = pendingInbox.slice(splice.start, splice.start + splice.removedCount)
      // 取消的投递（outcome === 'canceled'）从未被任何一轮读过，不能算来源。
      if (current === turn && splice.outcome !== 'canceled') ids.push(...messageIdsOf(removed))
      pendingInbox = [
        ...pendingInbox.slice(0, splice.start),
        ...splice.inserted,
        ...pendingInbox.slice(splice.start + splice.removedCount),
      ]
      continue
    }
    if (event.type !== 'user/message') continue
    const id = messageIdOf(event.data)
    if (id === undefined) continue
    const explicit = turnOf(event)
    if (explicit !== undefined) {
      if (explicit === turn) ids.push(id)
      continue
    }
    if (current === undefined) {
      queued.push(id)
      continue
    }
    if (current === turn) ids.push(id)
  }
  return ids
}

/** 只认 `next-turn`：`next-step` 的 splice 进当前 step，与 IM 投递无关。 */
interface InboxSplice {
  start: number
  removedCount: number
  outcome?: unknown
  inserted: readonly unknown[]
}

/**
 * `agent/inbox/spliced` 的形状校验。坏 splice（宿主换形状、日志被手改）直接
 * 跳过：这一轮最多不回 IM（保守失败），绝不按猜出来的下标误认来源。
 */
function inboxSpliceOf(data: Record<string, unknown> | undefined): InboxSplice | undefined {
  if (data === undefined || data['target'] !== 'next-turn') return undefined
  const start = data['start']
  const removedCount = data['removedCount'] ?? 0
  const inserted = data['inserted']
  if (!Number.isSafeInteger(start) || (start as number) < 0) return undefined
  if (!Number.isSafeInteger(removedCount) || (removedCount as number) < 0) return undefined
  if (!Array.isArray(inserted)) return undefined
  return {
    start: start as number,
    removedCount: removedCount as number,
    ...(data['outcome'] === undefined ? {} : { outcome: data['outcome'] }),
    inserted,
  }
}

/** 队列里的消息 id（`{ id }`）；坏条目跳过，不参与归属。 */
function messageIdsOf(messages: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    const id = asRecord(message)?.['id']
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

/**
 * 本轮最后一条带正文的 assistant 消息。
 *
 * 一轮里可能有多条 assistant/message（工具调用之间的旁白）；最后一条非空正文
 * 才是用户看到的那句。正文为空的一轮返回 undefined——调用方据此决定不发。
 */
export function assistantTextOfTurn(events: readonly ImSessionEventLike[], turn: number): string | undefined {
  let text: string | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (turnOf(event) !== turn) continue
    const candidate = assistantTextOf(event.data)
    if (candidate !== undefined && candidate.trim() !== '') text = candidate
  }
  return text
}

/** 本轮是否以错误收尾；错误轮只回固定短句，不回模型原文。 */
export function turnFailedOf(events: readonly ImSessionEventLike[], turn: number): boolean {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    if (turnOf(event) !== turn) continue
    const reason = asRecord(event.data?.['reason'])
    return reason?.['kind'] === 'error'
  }
  return false
}

/**
 * 本轮是否在第一步之前就被宿主拒绝（`turn/end => { kind: 'blocked' }`）。
 *
 * 真实成因是宿主 `ArchivedSessionGate`：会话被归档后，任何迟到的 followup 都
 * 会在 pre-step 被拒，整轮不发请求直接结束。它不是「空轮」，必须回一条可行动
 * 的提示，而不是静默。
 */
export function turnBlockedOf(events: readonly ImSessionEventLike[], turn: number): boolean {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    if (turnOf(event) !== turn) continue
    const reason = asRecord(event.data?.['reason'])
    return reason?.['kind'] === 'blocked'
  }
  return false
}

function turnOf(event: ImSessionEventLike): number | undefined {
  const value = event.data?.['turn']
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function messageIdOf(data: Record<string, unknown> | undefined): string | undefined {
  const id = data?.['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** assistant/message 的载荷形状：`{ message: { content: [...] } }`。 */
function assistantTextOf(data: Record<string, unknown> | undefined): string | undefined {
  const message = asRecord(data?.['message'])
  const content = message?.['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const entry = asRecord(block)
    if (entry?.['type'] !== 'text') continue
    const text = entry['text']
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
