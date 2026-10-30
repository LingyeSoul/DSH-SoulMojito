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

/** 本轮的用户消息 id（宿主 user/message 事件的 data.id）。 */
export function userMessageIdsOfTurn(events: readonly ImSessionEventLike[], turn: number): string[] {
  const ids: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (turnOf(event) !== turn) continue
    const id = messageIdOf(event.data)
    if (id !== undefined) ids.push(id)
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
