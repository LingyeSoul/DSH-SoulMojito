import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sessionEvents } from '../src/host-session.js'
import {
  appendSessionEvents,
  SessionAppendError,
  supportsSessionBatchAppend,
  type SessionAppendInput,
  type SessionAppendLike,
} from '../src/session-append.js'

const RUNTIME_ROOT = new URL('../../../.npm-cache/dsh-runtime/node_modules/@deepseek-ai/', import.meta.url)
const runtimeAvailable = existsSync(new URL('dsh-session/lib/index.js', RUNTIME_ROOT))

function makeBatchSession(options: { fail?: boolean } = {}) {
  const calls: Array<readonly SessionAppendInput[]> = []
  const session: SessionAppendLike = {
    surface: { prepareBatch: () => undefined },
    append: (type: string | readonly SessionAppendInput[], data?: unknown, opts?: unknown) => {
      if (!Array.isArray(type)) {
        calls.push([['single', data, opts]] as unknown as Array<readonly SessionAppendInput[]>)
        return { type, data }
      }
      calls.push(type as readonly SessionAppendInput[])
      if (options.fail === true) throw new Error('batch rejected')
      return type.map(([eventType], index) => ({ type: eventType, seq: index }))
    },
  }
  return { session, calls }
}

function makeSequentialSession(options: { failAt?: number } = {}) {
  const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
  const session: SessionAppendLike = {
    append: (type: string, data: unknown, opts?: unknown) => {
      calls.push({ type, data, opts })
      if (options.failAt === calls.length) throw new Error(`append ${type} rejected`)
      return { type }
    },
  }
  return { session, calls }
}

describe('supportsSessionBatchAppend', () => {
  it('accepts the rc.5 session shape with a callable surface.prepareBatch', () => {
    expect(supportsSessionBatchAppend(makeBatchSession().session)).toBe(true)
  })

  it('rejects hosts without the batch surface probe or without append', () => {
    expect(supportsSessionBatchAppend(makeSequentialSession().session)).toBe(false)
    expect(supportsSessionBatchAppend({ surface: { prepareBatch: () => undefined } } as never)).toBe(false)
    expect(supportsSessionBatchAppend({ append: () => undefined, surface: { prepareBatch: 'nope' } } as SessionAppendLike)).toBe(false)
    expect(supportsSessionBatchAppend(undefined)).toBe(false)
    expect(supportsSessionBatchAppend(null)).toBe(false)
  })
})

describe('appendSessionEvents', () => {
  const inputs: readonly SessionAppendInput[] = [
    ['turn/start', { turn: 1 }],
    ['assistant/message', { turn: 1, text: 'hi' }, { surfaceOp: 'append' }],
  ]

  it('submits one tuple array on rc.5 hosts and preserves opts', () => {
    const { session, calls } = makeBatchSession()
    const result = appendSessionEvents(session, inputs)
    expect(result.mode).toBe('batch')
    expect(result.events).toEqual([
      { type: 'turn/start', seq: 0 },
      { type: 'assistant/message', seq: 1 },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(inputs)
  })

  it('falls back to ordered single appends on older hosts', () => {
    const { session, calls } = makeSequentialSession()
    const result = appendSessionEvents(session, inputs)
    expect(result.mode).toBe('sequential')
    expect(result.events).toEqual([{ type: 'turn/start' }, { type: 'assistant/message' }])
    expect(calls).toEqual([
      { type: 'turn/start', data: { turn: 1 }, opts: undefined },
      { type: 'assistant/message', data: { turn: 1, text: 'hi' }, opts: { surfaceOp: 'append' } },
    ])
  })

  it('does not call append for an empty input list', () => {
    const batch = makeBatchSession()
    const sequential = makeSequentialSession()
    expect(appendSessionEvents(batch.session, [])).toEqual({ mode: 'batch', events: [] })
    expect(appendSessionEvents(sequential.session, [])).toEqual({ mode: 'sequential', events: [] })
    expect(batch.calls).toEqual([])
    expect(sequential.calls).toEqual([])
  })

  it('propagates a batch rejection without retrying individual events', () => {
    const { session, calls } = makeBatchSession({ fail: true })
    try {
      appendSessionEvents(session, inputs)
      throw new Error('expected the batch append to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionAppendError)
      const failure = error as SessionAppendError
      expect(failure.mode).toBe('batch')
      expect(failure.committed).toBe(0)
      expect(failure.events).toEqual([])
      expect(failure.message).toContain('batch rejected')
    }
    expect(calls).toHaveLength(1)
  })

  it('reports the committed prefix when a sequential append fails midway', () => {
    const { session, calls } = makeSequentialSession({ failAt: 2 })
    try {
      appendSessionEvents(session, inputs)
      throw new Error('expected the sequential append to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionAppendError)
      const failure = error as SessionAppendError
      expect(failure.mode).toBe('sequential')
      expect(failure.committed).toBe(1)
      expect(failure.events).toEqual([{ type: 'turn/start' }])
      expect(failure.message).toContain('after 1 committed event')
      expect(failure.message).toContain('append assistant/message rejected')
    }
    expect(calls).toHaveLength(2)
  })
})

describe.skipIf(!runtimeAvailable)('appendSessionEvents against the real rc.5 Session', () => {
  it('probes surface.prepareBatch and commits one turn through a single batch append', async () => {
    // The runtime path is repo-cached and optional; a static import would make
    // this spec fail to load on checkouts without `.npm-cache/dsh-runtime`.
    const host = await import(fileURLToPath(new URL('dsh-session/lib/index.js', RUNTIME_ROOT))) as {
      Session: {
        create(
          id: string,
          seed: readonly unknown[],
          header: unknown,
          inheritedEventCount: number,
          projections: readonly unknown[],
        ): SessionAppendLike
      }
    }
    const id = 'session-batch-smoke'
    const session = host.Session.create(
      id,
      [],
      { version: 4, id, createdAt: 0, isSeeded: false, delegationDepth: 0 },
      0,
      [],
    )
    expect(supportsSessionBatchAppend(session)).toBe(true)
    const inputs: readonly SessionAppendInput[] = [
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      ['assistant/message', {
        turn: 1,
        step: 1,
        stream: [],
        message: {
          id: 'live-assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        },
      }, { surfaceOp: 'append' }],
      ['step/end', { turn: 1, step: 1 }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ]
    const result = appendSessionEvents(session, inputs)
    expect(result.mode).toBe('batch')
    expect(result.events).toHaveLength(5)
    expect(sessionEvents(session).map((event) => event.type).slice(-5)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
  })
})