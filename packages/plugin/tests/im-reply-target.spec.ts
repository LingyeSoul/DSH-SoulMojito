import { describe, expect, it } from 'vitest'
import {
  PendingOrigins,
  assistantTextOfTurn,
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
  { type: 'user/message', data: { id: 'm1', turn: 4 } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '第一段旁白' }] } } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '最终正文' }] } } },
  { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'tool-call' }] } } },
  { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  { type: 'user/message', data: { id: 'm2', turn: 5 } },
  { type: 'turn/end', data: { turn: 5, reason: { kind: 'error', error: { message: 'boom' } } } },
]

describe('turn extraction', () => {
  it('lists the user message ids of one turn only', () => {
    expect(userMessageIdsOfTurn(events, 4)).toEqual(['m1'])
    expect(userMessageIdsOfTurn(events, 9)).toEqual([])
  })

  it('takes the last non-empty assistant text of the turn', () => {
    expect(assistantTextOfTurn(events, 4)).toBe('最终正文')
    expect(assistantTextOfTurn(events, 5)).toBeUndefined()
  })

  it('detects an error turn', () => {
    expect(turnFailedOf(events, 4)).toBe(false)
    expect(turnFailedOf(events, 5)).toBe(true)
  })
})
