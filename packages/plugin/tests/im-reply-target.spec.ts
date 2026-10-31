import { describe, expect, it } from 'vitest'
import {
  PendingOrigins,
  assistantTextOfTurn,
  turnBlockedOf,
  turnFailedOf,
  userMessageIdsOfTurn,
} from '../src/im/reply.js'
import type { ImSessionEventLike } from '../src/im/reply.js'

const TTL = 60_000

function origins(): PendingOrigins {
  return new PendingOrigins({ ttlMs: TTL, maxPerSession: 3 })
}

function target(channel: 'qq' | 'weixin' | 'onebot', peerId: string) {
  return { channel, accountId: 'acct', scope: 'private' as const, peerId }
}

describe('PendingOrigins', () => {
  it('resolves by message id and consumes the entry', () => {
    const table = origins()
    table.remember('s1', 'm1', 'qq:acct:private:a', target('qq', 'a'), 0)
    expect(table.resolve('s1', ['m1'], 1)?.peerKey).toBe('qq:acct:private:a')
    expect(table.resolve('s1', ['m1'], 1)).toBeUndefined()
  })

  it('returns nothing when the turn was not caused by an IM message', () => {
    const table = origins()
    table.remember('s1', 'm1', 'qq:acct:private:a', target('qq', 'a'), 0)
    expect(table.resolve('s1', ['typed-in-web'], 1)).toBeUndefined()
    expect(table.pendingCount('s1')).toBe(1)
  })

  it('answers only the earliest origin and drops the rest of the same turn', () => {
    const table = origins()
    table.remember('s1', 'm1', 'qq:acct:private:a', target('qq', 'a'), 0)
    table.remember('s1', 'm2', 'qq:acct:private:b', target('qq', 'b'), 0)
    const hit = table.resolve('s1', ['m2', 'm1'], 1)
    expect(hit?.messageId).toBe('m1')
    // m2 的内容已被这一轮一并回答，留着它只会在下一轮回两次。
    expect(table.pendingCount('s1')).toBe(0)
    expect(table.resolve('s1', ['m2'], 1)).toBeUndefined()
  })

  it('drops entries older than the ttl', () => {
    const table = origins()
    table.remember('s1', 'm1', 'qq:acct:private:a', target('qq', 'a'), 0)
    expect(table.resolve('s1', ['m1'], TTL + 1)).toBeUndefined()
    expect(table.pendingCount('s1')).toBe(0)
  })

  it('keeps at most maxPerSession entries', () => {
    const table = origins()
    for (let index = 0; index < 5; index += 1) {
      table.remember('s1', `m${index}`, 'qq:acct:private:a', target('qq', 'a'), 0)
    }
    expect(table.pendingCount('s1')).toBe(3)
    expect(table.resolve('s1', ['m0'], 1)).toBeUndefined()
    expect(table.resolve('s1', ['m2'], 1)?.messageId).toBe('m2')
  })
})

const events: ImSessionEventLike[] = [
  { type: 'turn/start', data: { turn: 4 } },
  // 真实宿主不给 user/message 带 turn：按位置归轮（2026-10-30 实机取证）。
  { type: 'user/message', data: { id: 'm1' } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '第一段旁白' }] } } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '最终正文' }] } } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'tool-call' }] } } },
  { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  // 排队中的 followup 落在两轮之间，归给下一轮。
  { type: 'user/message', data: { id: 'm2' } },
  { type: 'turn/start', data: { turn: 5 } },
  { type: 'turn/end', data: { turn: 5, reason: { kind: 'error', error: { message: 'boom' } } } },
]

describe('turn extraction', () => {
  it('attributes user messages by position when the host omits turn', () => {
    expect(userMessageIdsOfTurn(events, 4)).toEqual(['m1'])
    expect(userMessageIdsOfTurn(events, 5)).toEqual(['m2'])
    expect(userMessageIdsOfTurn(events, 9)).toEqual([])
  })

  it('still honours an explicit turn on user/message', () => {
    const legacy: ImSessionEventLike[] = [
      { type: 'user/message', data: { id: 'typed', turn: 7 } },
      { type: 'turn/start', data: { turn: 7 } },
    ]
    expect(userMessageIdsOfTurn(legacy, 7)).toEqual(['typed'])
  })

  it('ignores user messages that belong to another turn', () => {
    expect(userMessageIdsOfTurn(events, 4)).not.toContain('m2')
  })

  it('takes the last non-empty assistant text of the turn', () => {
    expect(assistantTextOfTurn(events, 4)).toBe('最终正文')
    expect(assistantTextOfTurn(events, 5)).toBeUndefined()
  })

  it('detects an error turn', () => {
    expect(turnFailedOf(events, 4)).toBe(false)
    expect(turnFailedOf(events, 5)).toBe(true)
  })

  it('detects a turn the host blocked before any step ran', () => {
    const blocked: ImSessionEventLike[] = [
      { type: 'turn/start', data: { turn: 13 } },
      { type: 'turn/end', data: { turn: 13, reason: { kind: 'blocked' } } },
    ]
    expect(turnBlockedOf(blocked, 13)).toBe(true)
    expect(turnBlockedOf(blocked, 12)).toBe(false)
    expect(turnFailedOf(blocked, 13)).toBe(false)
  })
})

// 2026-10-31 从 V4 会话日志取证的真实 followup 形状：消息只落
// `agent/inbox/spliced`，由下一轮开始时的一条移除 splice 取出消费，没有
// `user/message`。IM 全部走这条路径。
function inboxInsert(id: string) {
  return { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id }] } }
}

function inboxRemove(count: number, extra: Record<string, unknown> = {}) {
  return { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: count, inserted: [], ...extra } }
}

const followupEvents: ImSessionEventLike[] = [
  { type: 'turn/start', data: { turn: 5 } },
  { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } },
  inboxInsert('im-a'),
  { type: 'turn/start', data: { turn: 6 } },
  inboxRemove(1),
  // 运行中到达的 followup 进 next-turn 队列，不属于当前轮。
  inboxInsert('im-b'),
  { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } },
  { type: 'turn/start', data: { turn: 7 } },
  inboxRemove(1),
  { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
  // 取消的投递从未被任何一轮读过。
  inboxInsert('im-c'),
  inboxRemove(1, { outcome: 'canceled' }),
  { type: 'turn/start', data: { turn: 8 } },
  { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } },
]

describe('turn attribution for followup inbox splices', () => {
  it('attributes a queued followup to the turn that consumed it', () => {
    expect(userMessageIdsOfTurn(followupEvents, 6)).toEqual(['im-a'])
    expect(userMessageIdsOfTurn(followupEvents, 7)).toEqual(['im-b'])
  })

  it('never attributes a queued followup to the turn it arrived in', () => {
    expect(userMessageIdsOfTurn(followupEvents, 5)).toEqual([])
  })

  it('ignores a canceled delivery', () => {
    expect(userMessageIdsOfTurn(followupEvents, 8)).toEqual([])
  })

  it('ignores splices that target the current step', () => {
    const steered: ImSessionEventLike[] = [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [{ id: 'steer' }] } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(userMessageIdsOfTurn(steered, 3)).toEqual([])
  })
})
