import { describe, expect, it } from 'vitest'
import type { SessionImportAppend } from '../src/agent-tavern/projector.js'
import { applyAgentTavernHistoryImport } from '../src/session/activate.js'

interface FakeEvent {
  type: string
  data: unknown
  opts?: unknown
}

interface FakeAgent {
  id: string
  phase?: { kind: string; lastTurn: number }
  session?: {
    events?: FakeEvent[]
    header?: { version: number }
    append?: (type: string, data: unknown, opts?: unknown) => void
  }
}

/**
 * 最小导入计划：一个 assistant 轮（v0 形状，无受保护 system 头）。
 * 直接手写而不是调 `historyImportAppends`，让断言只盯落地协议本身。
 */
function plan(): SessionImportAppend[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '你好。' }], source: { kind: 'model' } },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function fakeAgent(id: string, options: { withPhase?: boolean; withSession?: boolean; withAppend?: boolean } = {}): FakeAgent {
  const events: FakeEvent[] = []
  const agent: FakeAgent = {
    id,
    ...(options.withPhase === false ? {} : { phase: { kind: 'idle', lastTurn: 0 } }),
  }
  if (options.withSession !== false) {
    agent.session = {
      events,
      ...(options.withAppend === false ? {} : {
        append: (type: string, data: unknown, opts?: unknown) => {
          events.push(opts === undefined ? { type, data } : { type, data, opts })
        },
      }),
    }
  }
  return agent
}

function typesOf(agent: FakeAgent): string[] {
  return (agent.session?.events ?? []).map((event) => event.type)
}

describe('applyAgentTavernHistoryImport', () => {
  it('writes the whole plan and advances the live turn base to the verified turn', () => {
    const agent = fakeAgent('session-apply')
    const outcome = applyAgentTavernHistoryImport({ agent, plan: plan() })
    expect(outcome).toEqual({ status: 'applied', landed: 5, total: 5 })
    expect(typesOf(agent)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(agent.session?.events?.[2]?.opts).toEqual({ surfaceOp: 'append' })
    expect(agent.phase?.lastTurn).toBe(1)
  })

  it('skips the write when the host turn base cannot advance, and says why', () => {
    const warnings: string[] = []
    const agent = fakeAgent('session-no-base', { withPhase: false })
    const outcome = applyAgentTavernHistoryImport({
      agent,
      plan: plan(),
      logger: { warn: (message) => { warnings.push(message) } },
    })
    expect(outcome).toEqual({ status: 'skipped', landed: 0, total: 5 })
    expect(typesOf(agent)).toEqual([])
    expect(warnings).toEqual([
      'AgentTavern history import skipped: the host session exposes no advanceable turn base, so imported turn boundaries would desynchronise the live loop.',
    ])
  })

  it('retries the missing suffix when the log tail is a clean prefix of the plan', () => {
    const agent = fakeAgent('session-partial')
    const events = agent.session?.events
    if (events === undefined) throw new Error('fake session missing')
    let calls = 0
    // 宿主吞掉首轮第 3-5 次写入，重试阶段恢复：日志尾部仍是干净前缀（2 项），
    // 后缀补写不会产生重复轮号。
    agent.session = {
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        calls += 1
        if (calls >= 3 && calls <= 5) return
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    }
    const outcome = applyAgentTavernHistoryImport({ agent, plan: plan() })
    expect(calls).toBe(8)
    expect(outcome).toEqual({ status: 'applied', landed: 5, total: 5 })
    expect(typesOf(agent)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(agent.phase?.lastTurn).toBe(1)
  })

  it('degrades to a verified prefix when read-back never sees the appends', () => {
    const errors: string[] = []
    const warnings: string[] = []
    const agent = fakeAgent('session-swallowed', { withAppend: false })
    agent.session = { events: [], append: () => {} }
    const outcome = applyAgentTavernHistoryImport({
      agent,
      plan: plan(),
      logger: {
        warn: (message) => { warnings.push(message) },
        error: (message) => { errors.push(message) },
      },
    })
    expect(outcome).toEqual({ status: 'partial', landed: 0, total: 5 })
    expect(typesOf(agent)).toEqual([])
    expect(warnings).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not be confirmed by read-back')
    expect(errors[0]).toContain('attempt 1: 0/5 appends visible, attempt 2: 0/5')
    // 读回没有任何落账轮号：基线不动，live loop 不会被推向一个不存在的轮。
    expect(agent.phase?.lastTurn).toBe(0)
  })

  it('skips with a warning when the host agent exposes no appendable session', () => {
    for (const agent of [fakeAgent('session-none', { withSession: false }), fakeAgent('session-no-append', { withAppend: false })]) {
      const warnings: string[] = []
      const outcome = applyAgentTavernHistoryImport({
        agent,
        plan: plan(),
        logger: { warn: (message) => { warnings.push(message) } },
      })
      expect(outcome).toEqual({ status: 'skipped', landed: 0, total: 5 })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('no appendable session')
    }
  })
})
