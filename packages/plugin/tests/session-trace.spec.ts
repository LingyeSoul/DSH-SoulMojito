import { describe, expect, it } from 'vitest'
import type { SessionAppendInput } from '../../../bind/src/index.js'
import {
  beginTavernSessionTurn,
  finishTavernSessionTrace,
  startTavernSessionStep,
  type TraceAgentLike,
} from '../src/session/trace.js'

interface FakeEvent {
  type: string
  data?: unknown
  opts?: unknown
}

function sequentialSession(options: { failAt?: number } = {}) {
  const events: FakeEvent[] = []
  let calls = 0
  const session = {
    events,
    append: (type: string, data?: unknown, opts?: unknown) => {
      calls += 1
      if (options.failAt === calls) throw new Error(`append ${type} rejected`)
      events.push(opts === undefined ? { type, data } : { type, data, opts })
    },
  }
  return { session, events, calls: () => calls }
}

function batchSession(options: { failBatchAt?: number } = {}) {
  const events: FakeEvent[] = []
  const batches: Array<readonly SessionAppendInput[]> = []
  const session = {
    events,
    surface: { prepareBatch: () => undefined },
    append: (input: string | readonly SessionAppendInput[], data?: unknown, opts?: unknown) => {
      if (!Array.isArray(input)) {
        events.push(opts === undefined ? { type: input, data } : { type: input, data, opts })
        return
      }
      batches.push(input as readonly SessionAppendInput[])
      if (options.failBatchAt === batches.length) throw new Error('batch rejected')
      for (const [type, eventData, eventOpts] of input as readonly SessionAppendInput[]) {
        events.push(eventOpts === undefined ? { type, data: eventData } : { type, data: eventData, opts: eventOpts })
      }
    },
  }
  return { session, events, batches }
}

function agentFor(session: object): TraceAgentLike {
  return {
    id: 'agent-trace',
    phase: { kind: 'idle', lastTurn: 0 },
    session: session as NonNullable<TraceAgentLike['session']>,
  }
}

function typesOf(events: readonly FakeEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('beginTavernSessionTurn', () => {
  it('writes turn/start and user/message sequentially on old hosts', () => {
    const { session, events } = sequentialSession()
    const trace = beginTavernSessionTurn(agentFor(session), 'hello')
    expect(trace).not.toBeNull()
    expect(typesOf(events)).toEqual(['turn/start', 'user/message'])
    expect(events[1]?.opts).toEqual({ surfaceOp: 'append' })
  })

  it('submits the opening pair as one native batch on rc.5 hosts', () => {
    const { session, events, batches } = batchSession()
    const trace = beginTavernSessionTurn(agentFor(session), 'hello')
    expect(trace).not.toBeNull()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map(([type]) => type)).toEqual(['turn/start', 'user/message'])
    expect(batches[0]?.[1]?.[2]).toEqual({ surfaceOp: 'append' })
    expect(typesOf(events)).toEqual(['turn/start', 'user/message'])
  })

  it('closes the half-open turn after a sequential second append fails', () => {
    const { session, events } = sequentialSession({ failAt: 2 })
    expect(beginTavernSessionTurn(agentFor(session), 'hello')).toBeNull()
    expect(typesOf(events)).toEqual(['turn/start', 'turn/end'])
    expect(events[1]?.data).toMatchObject({ turn: 1, reason: { kind: 'error' } })
  })

  it('does not append a closing turn when the native batch committed nothing', () => {
    const { session, events, batches } = batchSession({ failBatchAt: 1 })
    expect(beginTavernSessionTurn(agentFor(session), 'hello')).toBeNull()
    expect(batches).toHaveLength(1)
    expect(events).toEqual([])
  })
})

describe('finishTavernSessionTrace', () => {
  it('closes step and turn sequentially and advances the live turn base', () => {
    const { session, events } = sequentialSession()
    const agent = agentFor(session)
    const trace = startTavernSessionStep(beginTavernSessionTurn(agent, 'hello'))
    finishTavernSessionTrace(trace)
    expect(typesOf(events)).toEqual(['turn/start', 'user/message', 'step/start', 'step/end', 'turn/end'])
    expect(agent.phase).toMatchObject({ lastTurn: 1 })
  })

  it('closes step and turn as one native batch on rc.5 hosts', () => {
    const { session, events, batches } = batchSession()
    const agent = agentFor(session)
    const trace = startTavernSessionStep(beginTavernSessionTurn(agent, 'hello'))
    finishTavernSessionTrace(trace)
    expect(batches).toHaveLength(2)
    expect(batches[1]?.map(([type]) => type)).toEqual(['step/end', 'turn/end'])
    expect(typesOf(events)).toEqual(['turn/start', 'user/message', 'step/start', 'step/end', 'turn/end'])
    expect(agent.phase).toMatchObject({ lastTurn: 1 })
  })

  it('stops without advancing when sequential turn/end fails after step/end committed', () => {
    const { session, events } = sequentialSession({ failAt: 5 })
    const agent = agentFor(session)
    const trace = startTavernSessionStep(beginTavernSessionTurn(agent, 'hello'))
    finishTavernSessionTrace(trace)
    expect(typesOf(events)).toEqual(['turn/start', 'user/message', 'step/start', 'step/end'])
    expect(agent.phase).toMatchObject({ lastTurn: 0 })
    expect(trace).toMatchObject({ stepOpen: false, turnOpen: false })
  })

  it('leaves the log untouched when the native closing batch fails', () => {
    const { session, events, batches } = batchSession({ failBatchAt: 2 })
    const agent = agentFor(session)
    const trace = startTavernSessionStep(beginTavernSessionTurn(agent, 'hello'))
    finishTavernSessionTrace(trace)
    expect(batches).toHaveLength(2)
    expect(typesOf(events)).toEqual(['turn/start', 'user/message', 'step/start'])
    expect(agent.phase).toMatchObject({ lastTurn: 0 })
    expect(trace).toMatchObject({ stepOpen: false, turnOpen: false })
  })
})