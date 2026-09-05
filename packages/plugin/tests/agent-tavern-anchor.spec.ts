import { describe, expect, it, vi } from 'vitest'
import {
  ANCHOR_EVERY_TURNS_DEFAULT,
  ANCHOR_TEXT,
  OPENING_TEXT,
  anchorDue,
  createAnchorMessage,
  createOpeningMessage,
  hasRealUserTurn,
  latestReminderTurn,
  registerAgentTavernAnchor,
  reminderDue,
  resolveAnchorEveryTurns,
} from '../src/agent-tavern/anchor.js'

const USER_DECISION = { kind: 'enter', messages: [{ id: 'user-msg' }] }

function anchorEvent(turn: number) {
  return { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-anchor', turn } } }
}

function openingEvent(turn: number) {
  return { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-opening', turn } } }
}

function realUserEvent() {
  return { type: 'user/message', data: { source: { kind: 'user' } } }
}

function setupListener(options: { everyTurns?: unknown; isTavernSession?: (sessionId: string) => Promise<boolean> } = {}) {
  let listener: (payload: unknown, next: () => unknown) => Promise<unknown>
  const ctx = {
    on: vi.fn((event: string, fn: typeof listener, hookOptions?: unknown) => {
      expect(event).toBe('agent/pre-step')
      listener = fn
      return hookOptions
    }),
  }
  registerAgentTavernAnchor(ctx, { isTavernSession: async () => true, ...options })
  return { ctx, run: (payload: unknown, decision: unknown = USER_DECISION) => listener(payload, async () => decision) }
}

describe('AgentTavern anchor scheduling', () => {
  it('fires only on turn multiples at step 1', () => {
    expect(anchorDue(5, 1, 5)).toBe(true)
    expect(anchorDue(10, 1, 5)).toBe(true)
    expect(anchorDue(4, 1, 5)).toBe(false)
    expect(anchorDue(5, 2, 5)).toBe(false)
    expect(anchorDue(0, 1, 5)).toBe(false)
    expect(anchorDue(-5, 1, 5)).toBe(false)
    expect(anchorDue(Number.NaN, 1, 5)).toBe(false)
    expect(anchorDue(5, 1, 0)).toBe(false)
  })

  it('never fires when the schedule is disabled or defaulted correctly', () => {
    expect(resolveAnchorEveryTurns(undefined)).toBe(ANCHOR_EVERY_TURNS_DEFAULT)
    expect(resolveAnchorEveryTurns(8)).toBe(8)
    expect(resolveAnchorEveryTurns(0)).toBe(0)
    expect(resolveAnchorEveryTurns(-1)).toBe(ANCHOR_EVERY_TURNS_DEFAULT)
    expect(resolveAnchorEveryTurns('5')).toBe(ANCHOR_EVERY_TURNS_DEFAULT)
    expect(resolveAnchorEveryTurns(2.5)).toBe(ANCHOR_EVERY_TURNS_DEFAULT)
  })

  it('schedules the opening brief on the first turn without a real user message', () => {
    expect(reminderDue({ turn: 2, step: 1, messages: [{}] }, 5, 0, false)).toBe('opening')
    // 开场不受轮数节流：任意 turn 号、任意周期都触发。
    expect(reminderDue({ turn: 1, step: 1, messages: [{}] }, 5, 0, false)).toBe('opening')
    expect(reminderDue({ turn: 13, step: 1, messages: [{}] }, 5, 0, false)).toBe('opening')
  })

  it('schedules periodic anchors only after the opening, on turn multiples at step 1', () => {
    expect(reminderDue({ turn: 5, step: 1, messages: [{}] }, 5, 0, true)).toBe('periodic')
    expect(reminderDue({ turn: 4, step: 1, messages: [{}] }, 5, 0, true)).toBeUndefined()
    expect(reminderDue({ turn: 5, step: 2, messages: [{}] }, 5, 0, true)).toBeUndefined()
    expect(reminderDue({ turn: 5, step: 1, messages: [{}] }, 0, 0, true)).toBeUndefined()
  })

  it('guards both reminder kinds against empty batches, invalid turns, and same-turn repeats', () => {
    expect(reminderDue({ turn: 2, step: 1 }, 5, 0, false)).toBeUndefined()
    expect(reminderDue({ turn: 2, step: 1, messages: [] }, 5, 0, false)).toBeUndefined()
    expect(reminderDue({ turn: Number.NaN, step: 1, messages: [{}] }, 5, 0, false)).toBeUndefined()
    expect(reminderDue({ turn: 0, step: 1, messages: [{}] }, 5, 0, false)).toBeUndefined()
    expect(reminderDue({ turn: -4, step: 1, messages: [{}] }, 5, 0, false)).toBeUndefined()
    expect(reminderDue({ turn: 5, step: 1, messages: [{}] }, 5, 5, true)).toBeUndefined()
    expect(reminderDue({ turn: 5, step: 1, messages: [{}] }, 5, 7, true)).toBeUndefined()
    expect(reminderDue({ turn: 2, step: 1, messages: [{}] }, 5, 2, false)).toBeUndefined()
  })
})

describe('AgentTavern reminder log scans', () => {
  it('finds the most recent reminder turn across both forms and ignores other messages', () => {
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' } } },
      anchorEvent(5),
      { type: 'assistant/message', data: {} },
      openingEvent(2),
      anchorEvent(10),
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ]
    expect(latestReminderTurn(events)).toBe(10)
    expect(latestReminderTurn([realUserEvent()])).toBe(0)
    expect(latestReminderTurn([])).toBe(0)
  })

  it('detects real user turns and ignores imported or plugin-sourced messages', () => {
    expect(hasRealUserTurn([realUserEvent()])).toBe(true)
    expect(hasRealUserTurn([
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' } } },
      realUserEvent(),
    ])).toBe(true)
    expect(hasRealUserTurn([
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' } } },
      anchorEvent(5),
      { type: 'assistant/message', data: {} },
    ])).toBe(false)
    expect(hasRealUserTurn([])).toBe(false)
  })
})

describe('AgentTavern reminder message contracts', () => {
  it('carries plugin source, turn stamp, and the cache-safe write-once text', () => {
    const message = createAnchorMessage(5)
    expect(message.role).toBe('user')
    expect(message.id).toEqual(expect.any(String))
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-anchor', turn: 5 })
    expect(message.content).toEqual([{ type: 'text', text: ANCHOR_TEXT }])
  })

  it('anchors all three KERNEL duties behind a not-story-content guard', () => {
    expect(ANCHOR_TEXT).toContain('<tavern-anchor>')
    expect(ANCHOR_TEXT).toContain('not story content — do not narrate, quote, or reference it')
    expect(ANCHOR_TEXT).toContain('memory_write or memory_update')
    expect(ANCHOR_TEXT).toContain('tavern_lore_search')
    expect(ANCHOR_TEXT).toContain('tavern_history_search or memory_search')
    expect(ANCHOR_TEXT).toContain('continue the scene without mentioning this reminder')
  })

  it('carries the opening brief with its own form and turn stamp', () => {
    const message = createOpeningMessage(2)
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-opening', turn: 2 })
    expect(message.content).toEqual([{ type: 'text', text: OPENING_TEXT }])
  })

  it('grounds the opening in the read tools and explains the mirrored history', () => {
    expect(OPENING_TEXT).toContain('<tavern-opening>')
    expect(OPENING_TEXT).toContain('not story content — do not narrate, quote, or reference it')
    expect(OPENING_TEXT).toContain('imported from the Tavern save')
    expect(OPENING_TEXT).toContain('not your own memory')
    expect(OPENING_TEXT).toContain('tavern_character_get')
    expect(OPENING_TEXT).toContain('tavern_lore_search')
    expect(OPENING_TEXT).toContain('memory_search')
    expect(OPENING_TEXT).toContain('tavern_history_search')
    expect(OPENING_TEXT).toContain('without mentioning this brief')
  })
})

describe('AgentTavern anchor pre-step wiring', () => {
  it('appends the opening brief after the user batch on the first real user turn', async () => {
    const { run, ctx } = setupListener({ everyTurns: 5 })
    expect(ctx.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    const decision = await run({
      agent: { session: { id: 's1', events: [{ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' } } }] } },
      turn: 2,
      step: 1,
      signal: { aborted: false },
    }) as { kind: string; messages: Array<{ source?: { form?: string }; turn?: number }> }
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1]).toMatchObject({ source: { form: 'tavern-opening', turn: 2 }, role: 'user' })
  })

  it('subsumes the periodic anchor when the opening turn is also a multiple', async () => {
    const { run } = setupListener({ everyTurns: 5 })
    const decision = await run({
      agent: { session: { id: 's1', events: [] } },
      turn: 10,
      step: 1,
      signal: { aborted: false },
    }) as { messages: Array<{ source?: { form?: string } }> }
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1]).toMatchObject({ source: { form: 'tavern-opening' } })
  })

  it('switches to periodic anchors after the first real user message', async () => {
    const { run } = setupListener({ everyTurns: 5 })
    const lateDecision = await run({
      agent: { session: { id: 's1', events: [realUserEvent(), anchorEvent(5)] } },
      turn: 10,
      step: 1,
      signal: { aborted: false },
    }) as { messages: Array<{ source?: { form?: string } }> }
    expect(lateDecision.messages).toHaveLength(2)
    expect(lateDecision.messages[1]).toMatchObject({ source: { form: 'tavern-anchor', turn: 10 } })
  })

  it('passes through on non-due steps, repeats, rejects, aborts, empty batches, and non-tavern sessions', async () => {
    // 透传语义：返回值与喂入的 decision 是同一对象（身份保持，不做任何包装）。
    const passthrough = async (options: Parameters<typeof setupListener>[0], payload: unknown, decision: unknown = USER_DECISION) => {
      const { run } = setupListener(options)
      expect(await run(payload, decision)).toBe(decision)
    }
    const payload = (turn: number, events: unknown[] = [], step = 1) => ({
      agent: { session: { id: 's1', events } },
      turn,
      step,
      signal: { aborted: false },
    })
    const importedHistory = [{ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' } } }]

    // 已有真实用户消息后，非周期点的 turn 透传。
    await passthrough({ everyTurns: 5 }, payload(4, [realUserEvent(), anchorEvent(5)]))
    await passthrough({ everyTurns: 5 }, payload(2, importedHistory, 2))
    await passthrough({ everyTurns: 5 }, payload(2, [...importedHistory, openingEvent(2)]))
    await passthrough({ everyTurns: 5 }, payload(2), { kind: 'reject' })
    await passthrough({ everyTurns: 5 }, { ...payload(2), signal: { aborted: true } })
    await passthrough({ everyTurns: 5 }, payload(2), { kind: 'enter', messages: [] })
    await passthrough({ everyTurns: 5, isTavernSession: async () => false }, payload(2))
    await passthrough({ everyTurns: 5 }, payload(Number.NaN))
  })

  it('does not register any listener when disabled', () => {
    const on = vi.fn()
    registerAgentTavernAnchor({ on }, { everyTurns: 0 })
    expect(on).not.toHaveBeenCalled()
  })
})
