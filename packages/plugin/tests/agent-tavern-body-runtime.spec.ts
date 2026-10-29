/**
 * Body-operation state machine regression (proposal 0021).
 *
 * The fake session enforces the DSH v4 relationships the production code has
 * to satisfy: turn/step density, message placement inside an open step, and
 * complete `sourceEventSeqs` coverage for every surface replacement. This keeps
 * the tests honest about the host seam instead of only asserting event shapes.
 */

import { describe, expect, it } from 'vitest'
import {
  BODY_SETTLED_EVENT_TYPE,
  createBodyProjection,
  effectiveBodyText,
  foldBodyLedger,
  type BodyLogEvent,
  type BodySessionEvent,
} from '../src/agent-tavern/body.js'
import {
  recoverBodyOperationWith,
  type BodyRecoveryHost,
} from '../src/agent-tavern/body-recovery.js'
import {
  BodyRollbackError,
  type BodyRollbackPlan,
} from '../src/agent-tavern/body-rollback.js'
import {
  BODY_EVENT_TYPE,
  BODY_WRITE_TOOL_DENY,
  applyBodyEdit,
  bodyRuntimeError,
  finalizeRecoveredOperation,
  finalizeTurnStopping,
  foldPendingOps,
  restoreBodyAfterFailure,
  selectBodyCandidate,
  startRegenerate,
  withBodyLock,
  type BodyAgentLike,
  type BodyEditInspection,
  type BodyRuntimeDeps,
  type BodyRuntimeFailure,
  type BodyRuntimeRollbackPort,
  type BodyRuntimeTurnRollback,
  type BodySessionLike,
} from '../src/agent-tavern/body-runtime.js'
import { pendingByAgent } from '../src/agent-tavern/body-runtime-core.js'

interface FakeEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  opts?: unknown
}

interface HarnessOptions {
  status: unknown
  phaseKind: string
  lastTurn: number
  followupError: unknown
  restrictError: unknown
  appendRecord: boolean
  rollback: BodyWriteRollbackPort | undefined
}

interface Harness {
  deps: BodyRuntimeDeps
  session: BodySessionLike
  agentId: string
  events: FakeEvent[]
  phase: { kind: string; lastTurn: number }
  followups: unknown[]
  denies: string[][]
  readonly activeRestrictions: number
  warnings: string[]
  surface(): number[]
}

let harnessSequence = 0

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function createHarness(options: HarnessOptions): Harness {
  harnessSequence += 1
  const agentId = `agent-${harnessSequence}`
  const events: FakeEvent[] = []
  const surfaceNodes: number[] = []
  const followups: unknown[] = []
  const denies: string[][] = []
  const warnings: string[] = []
  let activeRestrictions = 0
  let openTurn: number | undefined
  let openStep: number | undefined
  let maxTurn = 0
  let nextStep = 1

  const append = (type: string, data: unknown, opts?: unknown): unknown => {
    if (!isRecord(data)) throw new Error(`fake session: ${type} data must be an object`)
    const seq = events.length
    const metadata = isRecord(opts) ? opts : undefined
    const surfaceOp = metadata?.surfaceOp
    const sourceEventSeqs = metadata?.sourceEventSeqs
    const surfaceEligible = SURFACE_TYPES.has(type)
    if (surfaceEligible && surfaceOp === undefined) throw new Error(`fake session: ${type} requires surfaceOp`)
    if (!surfaceEligible && surfaceOp !== undefined) throw new Error(`fake session: ${type} cannot carry surfaceOp`)

    if (type === 'turn/start') {
      if (openTurn !== undefined) throw new Error(`fake session: turn/start while turn ${openTurn} is open`)
      const turn = data.turn
      if (!isSeq(turn) || turn !== maxTurn + 1) throw new Error(`fake session: turn/start expected ${maxTurn + 1}, got ${String(turn)}`)
    } else if (type === 'step/start') {
      if (openTurn !== data.turn || openStep !== undefined) throw new Error('fake session: step/start without its turn or with an open step')
      if (data.step !== nextStep) throw new Error(`fake session: step/start expected step ${nextStep}, got ${String(data.step)}`)
    } else if (type === 'step/end') {
      if (openTurn !== data.turn || openStep !== data.step) throw new Error('fake session: step/end does not match the open step')
    } else if (type === 'turn/end') {
      if (openTurn !== data.turn || openStep !== undefined) throw new Error('fake session: turn/end does not match the open turn with no open step')
    } else if (type === 'developer/message' || type === 'system/message' || type === 'assistant/message' || type === 'tool/result') {
      if (openTurn !== data.turn || openStep !== data.step) throw new Error(`fake session: ${type} does not match an open turn and step`)
    } else if (type === 'user/message') {
      if (openTurn === undefined) throw new Error('fake session: user/message is outside an open turn')
    }

    if (surfaceOp === 'append') {
      if (sourceEventSeqs !== undefined && !Array.isArray(sourceEventSeqs)) throw new Error('fake session: sourceEventSeqs must be an array')
    } else if (surfaceOp !== undefined) {
      if (!isRecord(surfaceOp) || surfaceOp.op !== 'replace' || !isSeq(surfaceOp.startSeq) || !isSeq(surfaceOp.endSeq)) {
        throw new Error('fake session: invalid replace surfaceOp')
      }
      const startSeq = surfaceOp.startSeq
      const endSeq = surfaceOp.endSeq
      if (startSeq >= seq || endSeq >= seq || startSeq > endSeq) throw new Error('fake session: replacement range must reference earlier events')
      const startIndex = surfaceNodes.indexOf(startSeq)
      const endIndex = surfaceNodes.indexOf(endSeq)
      if (startIndex < 0 || endIndex < startIndex) throw new Error('fake session: replacement range is not on the current surface')
      const shadowed = surfaceNodes.slice(startIndex, endIndex + 1)
      if (!Array.isArray(sourceEventSeqs)) throw new Error('fake session: replacement requires sourceEventSeqs')
      const sources = new Set<number>()
      for (const source of sourceEventSeqs) {
        if (!isSeq(source) || source >= seq) throw new Error('fake session: sourceEventSeqs must be earlier sequences')
        sources.add(source)
      }
      for (const shadowedSeq of shadowed) {
        if (!sources.has(shadowedSeq)) throw new Error(`fake session: sourceEventSeqs omit shadowed node ${shadowedSeq}`)
      }
      const head = surfaceNodes[0]
      if (startIndex === 0 && head !== undefined) {
        const headEvent = events.find((event) => event.seq === head)
        if (headEvent?.type === 'system/message' && (type !== 'system/message' || shadowed.length !== 1)) {
          throw new Error('fake session: protected system head may only be rewritten by one system/message')
        }
      }
    }

    const event: FakeEvent = { type, seq, time: 1000 + seq, data, ...(metadata === undefined ? {} : { opts: metadata }) }
    events.push(event)

    if (surfaceOp === 'append') {
      surfaceNodes.push(seq)
    } else if (isRecord(surfaceOp) && surfaceOp.op === 'replace' && isSeq(surfaceOp.startSeq) && isSeq(surfaceOp.endSeq)) {
      const startIndex = surfaceNodes.indexOf(surfaceOp.startSeq)
      const endIndex = surfaceNodes.indexOf(surfaceOp.endSeq)
      surfaceNodes.splice(startIndex, endIndex - startIndex + 1, seq)
    }

    if (type === 'turn/start') {
      openTurn = data.turn as number
      openStep = undefined
      maxTurn = data.turn as number
      nextStep = 1
    } else if (type === 'step/start') {
      openStep = data.step as number
      nextStep = (data.step as number) + 1
    } else if (type === 'step/end') {
      openStep = undefined
    } else if (type === 'turn/end') {
      openTurn = undefined
      openStep = undefined
    }
    return event
  }

  const phase = { kind: options.phaseKind, lastTurn: options.lastTurn }
  const session: BodySessionLike = {
    id: `session-${harnessSequence}`,
    header: { version: 4 },
    events,
    get surface() {
      return { nodes: [...surfaceNodes] }
    },
    append,
  }
  const agent: BodyAgentLike = {
    id: agentId,
    session,
    status: options.status,
    phase,
    ctx: {
      tools: {
        restrict(filter) {
          if (options.restrictError !== undefined) throw options.restrictError
          denies.push([...(filter.deny ?? [])])
          activeRestrictions += 1
          let released = false
          return () => {
            if (released) return
            released = true
            activeRestrictions -= 1
          }
        },
      },
    },
    followup(message) {
      followups.push(message)
      if (options.followupError !== undefined) throw options.followupError
    },
  }
  return {
    deps: {
      session,
      agent,
      logger: { warn: (message: string) => { warnings.push(message) } },
      now: () => 5000,
      ...(options.appendRecord
        ? { appendRecord: (target: BodySessionLike, type: string, data: unknown) => target.append(type, data) }
        : {}),
      ...(options.rollback === undefined ? {} : { writeRollback: options.rollback }),
    },
    session,
    agentId,
    events,
    phase,
    followups,
    denies,
    get activeRestrictions() {
      return activeRestrictions
    },
    warnings,
    surface: () => [...surfaceNodes],
  }
}

function healthyHarness(): Harness {
  return createHarness({
    status: 'idle',
    phaseKind: 'idle',
    lastTurn: 0,
    followupError: undefined,
    restrictError: undefined,
    appendRecord: true,
    rollback: undefined,
  })
}

/* --------------------------- rollback port doubles ------------------------- */

interface TestTurnRollback extends BodyRuntimeTurnRollback {
  readonly sessionId: string
  readonly turn: number
  readonly undone: number
  readonly skippedUncommitted: readonly string[]
}

interface RollbackScript {
  readonly prepare?: (agentId: string, turn: number, previousMessageId: string) => Promise<BodyRollbackPlan>
  readonly commit?: (plan: BodyRollbackPlan) => Promise<void>
  readonly restore?: (plan: BodyRollbackPlan) => Promise<void>
  readonly rollbackTurnWrites?: (agentId: string, turn: number) => Promise<TestTurnRollback>
}

function rollbackPlan(agentId: string, turn: number, previousMessageId: string): BodyRollbackPlan {
  return {
    sessionId: agentId,
    turn,
    previousMessageId,
    binding: { character: 'Character', chatId: 'chat.jsonl' },
    floorIndex: 0,
    bodyText: 'old body',
    chatRevision: 'rev-1',
    preparedRevision: 'rev-1',
    journal: [],
    mvuReceipts: [],
    diagnostics: [],
    preparedAt: '2026-10-28T00:00:00.000Z',
  }
}

function newTurnRollback(agentId: string, turn: number): TestTurnRollback {
  return { sessionId: agentId, turn, undone: 0, skippedUncommitted: [], failures: [] }
}

function createRollbackPort(script: RollbackScript, calls: string[]): BodyRuntimeRollbackPort {
  return {
    prepare: async (agentId: string, turn: number, previousMessageId: string) => {
      calls.push(`prepare:${agentId}:${turn}:${previousMessageId}`)
      return script.prepare === undefined
        ? rollbackPlan(agentId, turn, previousMessageId)
        : await script.prepare(agentId, turn, previousMessageId)
    },
    commit: async (plan: BodyRollbackPlan) => {
      calls.push(`commit:${plan.turn}`)
      if (script.commit !== undefined) await script.commit(plan)
    },
    restore: async (plan: BodyRollbackPlan) => {
      calls.push(`restore:${plan.turn}`)
      if (script.restore !== undefined) await script.restore(plan)
    },
    rollbackTurnWrites: async (agentId: string, turn: number) => {
      calls.push(`rollback-turn:${turn}`)
      return script.rollbackTurnWrites === undefined
        ? newTurnRollback(agentId, turn)
        : await script.rollbackTurnWrites(agentId, turn)
    },
  }
}

function seedClosedTurn(harness: Harness, turn: number, anchorId: string, text: string, withSystem: boolean): number {
  harness.session.append('turn/start', { turn })
  harness.session.append('step/start', { turn, step: 1 })
  if (withSystem) {
    harness.session.append('system/message', {
      turn,
      step: 1,
      message: {
        id: 'system-head',
        role: 'system',
        content: [{ type: 'text', text: 'system prompt' }],
        source: { kind: 'system-prompt' },
      },
    }, { surfaceOp: 'append' })
  }
  harness.session.append('user/message', {
    id: `user-${turn}`,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  const anchorEvent = harness.session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: {
      id: anchorId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  }, { surfaceOp: 'append' })
  harness.session.append('step/end', { turn, step: 1 })
  harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  const seq = isRecord(anchorEvent) ? anchorEvent.seq : undefined
  if (!isSeq(seq)) throw new Error('fake session: append did not return the anchor event')
  return seq
}

function seedLedgerCandidate(harness: Harness, groupId: string, messageId: string): void {
  harness.session.append(BODY_EVENT_TYPE, { op: 'candidate', groupId, messageId, index: 0 })
}

/**
 * Reproduce the empty developer replacement a pre-9.5 `startRegenerate`
 * appended in a bridge turn: after it, the old anchor is off the surface.
 */
function hideAnchorLikeLegacyStart(harness: Harness, turn: number, anchorSeq: number): void {
  harness.session.append('turn/start', { turn })
  harness.session.append('step/start', { turn, step: 1 })
  harness.session.append('developer/message', {
    turn,
    step: 1,
    message: {
      id: `body-hide-legacy-${turn}`,
      role: 'developer',
      content: [],
      source: { kind: 'plugin:dsh-soulmojito', form: 'body-hide', summary: 'legacy body hide' },
    },
  }, {
    surfaceOp: { op: 'replace', startSeq: anchorSeq, endSeq: anchorSeq },
    sourceEventSeqs: [anchorSeq],
  })
  harness.session.append('step/end', { turn, step: 1 })
  harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function firstFollowup(harness: Harness): Record<string, unknown> {
  const trigger = harness.followups[0]
  if (!isRecord(trigger)) throw new Error('fake harness: no followup trigger was delivered')
  return trigger
}

interface TriggerTurn {
  triggerSeq: number
  processSeq: number
  toolResultSeq: number
  finalSeq?: number
}

function appendTriggerTurn(
  harness: Harness,
  turn: number,
  trigger: Record<string, unknown>,
  finalId: string | undefined,
  close: boolean,
): TriggerTurn {
  harness.session.append('turn/start', { turn })
  harness.session.append('step/start', { turn, step: 1 })
  const triggerEvent = harness.session.append('user/message', trigger, { surfaceOp: 'append' })
  const processEvent = harness.session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: {
      id: 'tool-step',
      role: 'assistant',
      content: [
        { type: 'text', text: 'planning' },
        { type: 'tool-call', callId: 'call-1', name: 'tavern_scene_get', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  }, { surfaceOp: 'append' })
  const toolResultEvent = harness.session.append('tool/result', {
    turn,
    step: 1,
    message: {
      id: 'tool-result-1',
      role: 'tool',
      content: [{ type: 'text', text: 'tool output' }],
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
    },
  }, { surfaceOp: 'append' })
  harness.session.append('step/end', { turn, step: 1 })

  let finalSeq: number | undefined
  if (finalId !== undefined) {
    harness.session.append('step/start', { turn, step: 2 })
    const finalEvent = harness.session.append('assistant/message', {
      turn,
      step: 2,
      stream: [],
      message: {
        id: finalId,
        role: 'assistant',
        content: [{ type: 'text', text: 'new body' }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    }, { surfaceOp: 'append' })
    finalSeq = isRecord(finalEvent) ? finalEvent.seq as number : undefined
    harness.session.append('step/end', { turn, step: 2 })
  }
  if (close) harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })

  return {
    triggerSeq: eventSeq(triggerEvent, 'trigger'),
    processSeq: eventSeq(processEvent, 'process'),
    toolResultSeq: eventSeq(toolResultEvent, 'tool result'),
    ...(finalSeq === undefined ? {} : { finalSeq }),
  }
}

function closeTurn(harness: Harness, turn: number): void {
  harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function eventSeq(value: unknown, subject: string): number {
  if (!isRecord(value) || !isSeq(value.seq)) throw new Error(`fake session: ${subject} append did not return an event`)
  return value.seq
}

function bodyEventsOf(events: readonly FakeEvent[]): FakeEvent[] {
  return events.filter((event) => event.type === BODY_EVENT_TYPE)
}

function bodyEvent(events: readonly FakeEvent[], op: string): FakeEvent | undefined {
  return events.find((event) => event.type === BODY_EVENT_TYPE && event.data.op === op)
}

function bodyEventsWithOp(events: readonly FakeEvent[], op: string): FakeEvent[] {
  return events.filter((event) => event.type === BODY_EVENT_TYPE && event.data.op === op)
}

function settledEventsOf(events: readonly FakeEvent[]): FakeEvent[] {
  return events.filter((event) => event.type === BODY_SETTLED_EVENT_TYPE)
}

function messageOf(event: FakeEvent): Record<string, unknown> | undefined {
  if (event.type === 'user/message') return event.data
  return isRecord(event.data.message) ? event.data.message : undefined
}

function seqOfMessage(events: readonly FakeEvent[], messageId: string): number | undefined {
  return events.find((event) => messageOf(event)?.id === messageId)?.seq
}

function bodyFailureOf(error: unknown): BodyRuntimeFailure {
  if (!(error instanceof Error) || error.name !== 'BodyRuntimeError') throw new Error('expected a BodyRuntimeError')
  return error as BodyRuntimeFailure
}

function toBodySessionEvents(events: readonly FakeEvent[]): BodySessionEvent[] {
  return events.map((event) => ({
    seq: event.seq,
    type: event.type,
    data: event.data as unknown as BodySessionEvent['data'],
  }))
}

function asBodyLogEvent(event: FakeEvent): BodyLogEvent {
  if (event.type !== BODY_EVENT_TYPE) throw new Error(`expected ${BODY_EVENT_TYPE}, received ${event.type}`)
  return { seq: event.seq, type: BODY_EVENT_TYPE, data: event.data as unknown as BodyLogEvent['data'] }
}

function projectedText(message: { content: readonly { type: string; text?: unknown }[] } | undefined): string {
  if (message === undefined) return ''
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

describe('AgentTavern body runtime', () => {
  it('keeps the old anchor visible, delivers the trigger and settles the new body', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
      writeToolDeny: ['memory_write', 'variable_set'],
    })

    expect(started.opId).toMatch(/^body-op-/)
    expect(started.triggerMessageId).toBe(`body-trigger-${started.opId}`)
    expect(harness.followups).toHaveLength(1)
    expect(harness.denies).toEqual([['memory_write', 'variable_set']])
    expect(harness.activeRestrictions).toBe(1)
    // Proposal 0021 §9.5: start opens no bridge turn and hides nothing.
    expect(harness.phase.lastTurn).toBe(0)
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.events.some((event) => event.type === 'developer/message')).toBe(false)

    const opStart = bodyEvent(harness.events, 'op-start')
    expect(opStart?.data).toMatchObject({
      opId: started.opId,
      groupId: 'anchor-1',
      kind: 'regenerate',
      previousAnchorId: 'anchor-1',
      previousIndex: 0,
    })

    const trigger = firstFollowup(harness)
    expect(trigger).toMatchObject({
      id: started.triggerMessageId,
      role: 'user',
      source: { form: 'body-regenerate', opId: started.opId, groupId: 'anchor-1' },
    })

    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    expect(harness.activeRestrictions).toBe(0)

    const candidates = bodyEventsWithOp(harness.events, 'candidate')
    expect(candidates.map((event) => event.data.index)).toEqual([0, 1])
    expect(candidates[0]?.data).toMatchObject({ groupId: 'anchor-1', messageId: 'anchor-1', index: 0 })
    expect(candidates[1]?.data).toMatchObject({ groupId: 'anchor-1', messageId: 'new-body', index: 1 })
    const select = bodyEvent(harness.events, 'select')
    expect(select?.data).toMatchObject({ groupId: 'anchor-1', index: 1 })
    const finish = bodyEvent(harness.events, 'op-finish')
    expect(finish?.data).toMatchObject({ result: 'ok', anchorId: 'new-body' })
    // Proposal 0021 §9.2: the durable settlement boundary is two-phase — the
    // pre-hide `settling` marker, the hide, then the post-hide `settled`
    // marker, all before op-finish, so recovery can finish without touching
    // the body.
    const settled = settledEventsOf(harness.events)
    expect(settled.map((event) => event.data.phase)).toEqual(['settling', 'settled'])
    const settledMarker = settled[1]
    expect(settledMarker?.data).toMatchObject({
      op: 'op-settled',
      opId: started.opId,
      groupId: 'anchor-1',
      anchorId: 'new-body',
      index: 1,
    })
    if (finish === undefined || settledMarker === undefined) throw new Error('settlement records are missing')
    expect(harness.events.indexOf(settledMarker)).toBeLessThan(harness.events.indexOf(finish))

    const surface = harness.surface()
    expect(surface).not.toContain(triggerTurn.triggerSeq)
    expect(surface).not.toContain(triggerTurn.processSeq)
    expect(surface).not.toContain(triggerTurn.toolResultSeq)
    expect(surface).not.toContain(anchorSeq)
    expect(surface).toContain(triggerTurn.finalSeq)

    // The successful settlement is the only place the old body leaves the
    // surface: one empty developer replacement covers the old anchor and the
    // new turn's trigger/process nodes, while the candidate stays visible.
    const settleHide = harness.events.find((event) => event.type === 'developer/message' && event.data.turn === 2)
    expect(settleHide?.data.step).toBe(3)
    const settlingMarker = settled[0]
    if (settleHide === undefined || settlingMarker === undefined) throw new Error('settlement ordering records are missing')
    expect(harness.events.indexOf(settlingMarker)).toBeLessThan(harness.events.indexOf(settleHide))
    expect(settleHide === undefined ? undefined : messageOf(settleHide)).toMatchObject({ role: 'developer', content: [] })
    expect(settleHide?.opts).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: anchorSeq, endSeq: triggerTurn.toolResultSeq },
      sourceEventSeqs: [anchorSeq, triggerTurn.triggerSeq, triggerTurn.processSeq, triggerTurn.toolResultSeq],
    })

    started.release()
    expect(harness.activeRestrictions).toBe(0)
  })

  it('replaces the previous candidate on a second regeneration', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const firstTrigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, firstTrigger, 'new-body', false)
    expect(await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 }))
      .toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    closeTurn(harness, 2)

    const previousSeq = seqOfMessage(harness.events, 'new-body')
    expect(previousSeq).toBeDefined()
    expect(harness.surface()).toContain(previousSeq)

    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'new-body',
      expectedIndex: 1,
    })
    expect(harness.surface()).toContain(previousSeq)

    const secondTrigger = harness.followups[1]
    if (!isRecord(secondTrigger)) throw new Error('fake harness: no second followup trigger was delivered')
    const secondTurn = appendTriggerTurn(harness, 3, secondTrigger, 'third-body', false)
    expect(await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 3 }))
      .toEqual({ status: 'ok', anchorMessageId: 'third-body' })
    closeTurn(harness, 3)

    const surface = harness.surface()
    expect(surface).not.toContain(previousSeq)
    expect(surface).toContain(secondTurn.finalSeq)
    expect(bodyEventsWithOp(harness.events, 'candidate').map((event) => event.data.index)).toEqual([0, 1, 2])
    expect(bodyEventsWithOp(harness.events, 'select').map((event) => event.data.index)).toEqual([1, 2])
  })

  it('settles a recovered operation and hides its trigger, process and old anchor', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'recovered-body', false)
    const pending = foldPendingOps(harness.events)
    expect(pending).toHaveLength(1)
    const recovered = pending[0]
    if (recovered === undefined) throw new Error('foldPendingOps did not rebuild the operation')

    const result = await finalizeRecoveredOperation(harness.deps, recovered, 2)
    closeTurn(harness, 2)

    expect(result).toEqual({ status: 'ok', anchorMessageId: 'recovered-body' })
    const candidates = bodyEventsWithOp(harness.events, 'candidate')
    expect(candidates.map((event) => event.data.index)).toEqual([0, 1])
    expect(candidates[1]?.data).toMatchObject({ groupId: 'anchor-1', messageId: 'recovered-body', index: 1 })
    expect(bodyEvent(harness.events, 'select')?.data).toMatchObject({ groupId: 'anchor-1', index: 1 })
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'ok', anchorId: 'recovered-body' })

    const surface = harness.surface()
    expect(surface).not.toContain(triggerTurn.triggerSeq)
    expect(surface).not.toContain(triggerTurn.processSeq)
    expect(surface).not.toContain(triggerTurn.toolResultSeq)
    expect(surface).not.toContain(anchorSeq)
    expect(surface).toContain(triggerTurn.finalSeq)

    const settleHide = harness.events.find((event) => event.type === 'developer/message'
      && event.data.turn === 2
      && event.data.step === 3)
    expect(settleHide?.opts).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: anchorSeq, endSeq: triggerTurn.toolResultSeq },
      sourceEventSeqs: [anchorSeq, triggerTurn.triggerSeq, triggerTurn.processSeq, triggerTurn.toolResultSeq],
    })
    expect(harness.activeRestrictions).toBe(0)
  })

  it('fails a recovered operation without body text and writes no candidate or select', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, undefined, false)
    const pending = foldPendingOps(harness.events)
    expect(pending).toHaveLength(1)
    const recovered = pending[0]
    if (recovered === undefined) throw new Error('foldPendingOps did not rebuild the operation')
    const bodyEventsBefore = bodyEventsOf(harness.events).length

    const result = await finalizeRecoveredOperation(harness.deps, recovered, 2)
    closeTurn(harness, 2)

    expect(result.status).toBe('failed')
    const bodyEventsAfter = bodyEventsOf(harness.events)
    expect(bodyEventsAfter.length).toBe(bodyEventsBefore + 1)
    expect(bodyEventsAfter.at(-1)?.data).toMatchObject({ op: 'op-finish', result: 'failed' })
    const candidates = bodyEventsWithOp(harness.events, 'candidate')
    expect(candidates.map((event) => event.data.index)).toEqual([0])
    expect(bodyEvent(harness.events, 'select')).toBeUndefined()
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })
    if (result.status === 'failed') expect(result.reason).toContain('no assistant message with text')
    expect(harness.activeRestrictions).toBe(0)
  })

  it('removes the old turn process nodes but keeps the real user message', async () => {
    const harness = healthyHarness()
    const firstTurn = 1
    harness.session.append('turn/start', { turn: firstTurn })
    harness.session.append('step/start', { turn: firstTurn, step: 1 })
    harness.session.append('system/message', {
      turn: firstTurn,
      step: 1,
      message: { id: 'system-head', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    const userEvent = harness.session.append('user/message', {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const toolEvent = harness.session.append('assistant/message', {
      turn: firstTurn,
      step: 1,
      stream: [],
      message: {
        id: 'old-tool-step',
        role: 'assistant',
        content: [
          { type: 'text', text: 'planning' },
          { type: 'tool-call', callId: 'call-old', name: 'tavern_scene_get', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    }, { surfaceOp: 'append' })
    const toolResultEvent = harness.session.append('tool/result', {
      turn: firstTurn,
      step: 1,
      message: {
        id: 'old-tool-result',
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        source: { kind: 'tool', callId: 'call-old' },
        toolCallId: 'call-old',
      },
    }, { surfaceOp: 'append' })
    harness.session.append('step/end', { turn: firstTurn, step: 1 })
    harness.session.append('step/start', { turn: firstTurn, step: 2 })
    const anchorEvent = harness.session.append('assistant/message', {
      turn: firstTurn,
      step: 2,
      stream: [],
      message: {
        id: 'anchor-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'old body' }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    }, { surfaceOp: 'append' })
    harness.session.append('step/end', { turn: firstTurn, step: 2 })
    harness.session.append('turn/end', { turn: firstTurn, reason: { kind: 'completed' } })

    const started = await startRegenerate(harness.deps, {
      groupId: 'old-tool-step',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    // Start leaves the whole old turn on the surface, including tool nodes.
    const startedSurface = harness.surface()
    expect(startedSurface).toContain(eventSeq(userEvent, 'user'))
    expect(startedSurface).toContain(eventSeq(toolEvent, 'tool'))
    expect(startedSurface).toContain(eventSeq(toolResultEvent, 'tool result'))
    expect(startedSurface).toContain(eventSeq(anchorEvent, 'anchor'))
    expect(harness.events.some((event) => event.type === 'developer/message')).toBe(false)

    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    expect(started.opId).toMatch(/^body-op-/)

    const surface = harness.surface()
    expect(surface).toContain(eventSeq(userEvent, 'user'))
    expect(surface).not.toContain(eventSeq(toolEvent, 'tool'))
    expect(surface).not.toContain(eventSeq(toolResultEvent, 'tool result'))
    expect(surface).not.toContain(eventSeq(anchorEvent, 'anchor'))
    const hide = harness.events.find((event) => event.type === 'developer/message')
    expect(hide?.opts).toMatchObject({
      surfaceOp: {
        op: 'replace',
        startSeq: eventSeq(toolEvent, 'tool'),
        endSeq: triggerTurn.toolResultSeq,
      },
      sourceEventSeqs: [
        eventSeq(toolEvent, 'tool'),
        eventSeq(toolResultEvent, 'tool result'),
        eventSeq(anchorEvent, 'anchor'),
        triggerTurn.triggerSeq,
        triggerTurn.processSeq,
        triggerTurn.toolResultSeq,
      ],
    })
  })

  it('rejects restore while the failed turn is open and restores the previous body without a new message', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, undefined, false)

    await expect(restoreBodyAfterFailure(harness.deps, started.op)).rejects.toMatchObject({ code: 'session-busy' })

    const failed = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(failed.status).toBe('failed')
    expect(failed.status === 'failed' ? failed.reason : '').toContain('no assistant message with text')
    expect(harness.activeRestrictions).toBe(0)
    const failedCandidates = bodyEventsWithOp(harness.events, 'candidate')
    expect(failedCandidates.map((event) => event.data.index)).toEqual([0])
    expect(failedCandidates[0]?.data).toMatchObject({ messageId: 'anchor-1', index: 0 })
    expect(bodyEvent(harness.events, 'select')).toBeUndefined()
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })

    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length
    const restoredId = await restoreBodyAfterFailure(harness.deps, started.op)
    expect(restoredId).toBe('anchor-1')
    expect(harness.phase.lastTurn).toBe(3)

    // The old anchor never left the surface, so recovery appends no assistant
    // copy and no `restore` body event: the JSONL floor stays untouched.
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
    const surface = harness.surface()
    expect(surface).toContain(anchorSeq)
    expect(surface).not.toContain(triggerTurn.triggerSeq)
    expect(surface).not.toContain(triggerTurn.processSeq)
    expect(surface).not.toContain(triggerTurn.toolResultSeq)

    const hide = harness.events.find((event) => event.type === 'developer/message' && event.data.turn === 3)
    expect(hide?.opts).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: triggerTurn.triggerSeq, endSeq: triggerTurn.toolResultSeq },
      sourceEventSeqs: [triggerTurn.triggerSeq, triggerTurn.processSeq, triggerTurn.toolResultSeq],
    })
  })

  it('hides an errored candidate turn and keeps the previous body visible', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const failedTurn = appendTriggerTurn(harness, 2, trigger, 'failed-body', false)
    harness.session.append('turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { message: 'model failed', code: 'TEST' } },
    })

    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length
    const restoredId = await restoreBodyAfterFailure(harness.deps, started.op)
    expect(restoredId).toBe('anchor-1')
    const surface = harness.surface()
    expect(surface).toContain(anchorSeq)
    expect(surface).not.toContain(failedTurn.triggerSeq)
    expect(surface).not.toContain(failedTurn.processSeq)
    expect(surface).not.toContain(failedTurn.toolResultSeq)
    expect(surface).not.toContain(failedTurn.finalSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
    expect(harness.activeRestrictions).toBe(0)
    expect(harness.phase.lastTurn).toBe(3)
  })

  it('releases the write-tool restriction when start fails after followup', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: new Error('followup transport closed'),
      restrictError: undefined,
      appendRecord: true,
      rollback: undefined,
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    let thrown: unknown
    try {
      await startRegenerate(harness.deps, {
        groupId: 'anchor-1',
        expectedAnchorId: 'anchor-1',
        expectedIndex: 0,
      })
    } catch (error) {
      thrown = error
    }

    const failure = bodyFailureOf(thrown)
    expect(failure.code).toBe('operation-failed')
    expect(failure.message).toContain('followup transport closed')
    expect(failure.op).toBeDefined()
    expect(harness.activeRestrictions).toBe(0)
    expect(harness.denies).toHaveLength(1)
    expect(harness.surface()).toContain(anchorSeq)
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })
    if (failure.op === undefined) throw new Error('start failure did not expose its operation')

    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length
    const restoredId = await restoreBodyAfterFailure(harness.deps, failure.op)
    expect(restoredId).toBe('anchor-1')
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
    expect(harness.phase.lastTurn).toBe(0)
  })

  it('refuses regeneration when the host turn base cannot advance', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'running',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: undefined,
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({ code: 'host-unsupported' })

    expect(bodyEventsOf(harness.events)).toHaveLength(0)
    expect(harness.followups).toHaveLength(0)
    expect(harness.denies).toHaveLength(0)
    expect(harness.surface()).toContain(anchorSeq)
  })

  it('rejects a second regeneration while one operation is pending', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const first = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({ code: 'session-busy' })

    expect(bodyEventsWithOp(harness.events, 'op-start')).toHaveLength(1)
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    expect(harness.activeRestrictions).toBe(0)
  })

  it('validates edit and select requests against the group, index and anchor', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const settled = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(settled).toEqual({ status: 'ok', anchorMessageId: 'new-body' })

    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: '   ',
      expectedAnchorId: 'new-body',
    })).rejects.toMatchObject({ code: 'invalid-body-text' })

    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: 'changed',
      expectedAnchorId: 'missing-anchor',
    })).rejects.toMatchObject({ code: 'stale-anchor' })

    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: 'changed',
      expectedAnchorId: 'anchor-1',
    })).rejects.toMatchObject({ code: 'body-compacted' })

    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 9,
      text: 'changed',
      expectedAnchorId: 'new-body',
    })).rejects.toMatchObject({ code: 'stale-anchor' })

    const edited = await applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: 'edited body',
      expectedAnchorId: 'new-body',
    })
    expect(edited).toMatchObject({
      groupId: 'anchor-1',
      anchorMessageId: 'new-body',
      selectedIndex: 1,
      count: 2,
      text: 'edited body',
    })
    expect(bodyEvent(harness.events, 'edit')?.data).toMatchObject({
      groupId: 'anchor-1',
      index: 1,
      text: 'edited body',
      previousText: 'new body',
    })

    await expect(selectBodyCandidate(harness.deps, {
      groupId: 'anchor-1',
      index: 9,
      expectedAnchorId: 'new-body',
    })).rejects.toMatchObject({ code: 'stale-anchor' })

    await expect(selectBodyCandidate(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      expectedAnchorId: 'missing-anchor',
    })).rejects.toMatchObject({ code: 'stale-anchor' })

    const selected = await selectBodyCandidate(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      expectedAnchorId: 'new-body',
    })
    expect(selected).toMatchObject({
      groupId: 'anchor-1',
      anchorMessageId: 'new-body',
      selectedIndex: 0,
      count: 2,
      text: 'old body',
    })

    // Proposal 0023 §4.1.3: only the selected candidate can be edited.
    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: 'not the selected body',
      expectedAnchorId: 'new-body',
    })).rejects.toMatchObject({ code: 'stale-anchor' })
    expect(bodyEventsWithOp(harness.events, 'edit')).toHaveLength(1)

    const editedOld = await applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      text: 'edited old body',
      expectedAnchorId: 'new-body',
    })
    expect(editedOld).toMatchObject({ selectedIndex: 0, text: 'edited old body' })
    expect(bodyEventsWithOp(harness.events, 'edit').at(-1)?.data).toMatchObject({
      index: 0,
      previousText: 'old body',
      text: 'edited old body',
    })
    expect(started.opId).toMatch(/^body-op-/)
  })

  it('emits events the shared body ledger and projection can replay', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })

    const ledger = foldBodyLedger(toBodySessionEvents(harness.events), 'anchor-1', harness.events.length - 1)
    if (ledger === undefined) throw new Error('shared body ledger did not fold the runtime events')
    expect(ledger.candidates.map((candidate) => candidate.messageId)).toEqual(['anchor-1', 'new-body'])
    expect(ledger.selectedIndex).toBe(1)
    expect(effectiveBodyText(ledger)).toBe('new body')

    const projection = createBodyProjection()
    const selectEvent = bodyEvent(harness.events, 'select')
    if (selectEvent === undefined) throw new Error('runtime did not emit a select event')
    const newBodySeq = seqOfMessage(harness.events, 'new-body')
    if (newBodySeq === undefined) throw new Error('runtime lost the new body message')
    const projectedSelect = projection.project(asBodyLogEvent(selectEvent), { events: toBodySessionEvents(harness.events) })
    expect(projectedSelect.size).toBe(1)
    expect(projectedText(projectedSelect.get(newBodySeq))).toBe('new body')

    await applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 1,
      text: 'edited body',
      expectedAnchorId: 'new-body',
    })
    const editEvent = bodyEvent(harness.events, 'edit')
    if (editEvent === undefined) throw new Error('runtime did not emit an edit event')
    const projectedEdit = projection.project(asBodyLogEvent(editEvent), { events: toBodySessionEvents(harness.events) })
    expect(projectedText(projectedEdit.get(newBodySeq))).toBe('edited body')
  })

  it('routes body events through the injected plugin-record writer', async () => {
    const harness = healthyHarness()
    const recorded: string[] = []
    harness.deps.appendRecord = (session, type, data) => {
      recorded.push(type)
      return session.append(type, data)
    }
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)

    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    expect(recorded.length).toBeGreaterThanOrEqual(6)
    // The settlement marker is a plugin record too, but it must never be a
    // ledger event: the projector only reads BODY_EVENT_TYPE.
    expect(recorded.every((type) => type === BODY_EVENT_TYPE || type === BODY_SETTLED_EVENT_TYPE)).toBe(true)
    expect(recorded).toContain(BODY_SETTLED_EVENT_TYPE)
    expect(bodyEventsOf(harness.events)).toHaveLength(recorded.filter((type) => type === BODY_EVENT_TYPE).length)
  })

  it('fails closed before touching the session when appendRecord is missing', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: false,
      rollback: undefined,
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const beforeEvents = harness.events.length
    const beforeTurn = harness.phase.lastTurn

    const operations = [
      () => startRegenerate(harness.deps, {
        groupId: 'anchor-1',
        expectedAnchorId: 'anchor-1',
        expectedIndex: 0,
      }),
      () => finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 1 }),
      () => finalizeRecoveredOperation(harness.deps, {
        opId: 'op-recovered-missing-writer',
        groupId: 'anchor-1',
        previousAnchorId: 'anchor-1',
        previousIndex: 0,
        startSeq: 0,
      }, 1),
      () => restoreBodyAfterFailure(harness.deps, {
        opId: 'op-missing-writer',
        groupId: 'anchor-1',
        previousAnchorId: 'anchor-1',
        previousIndex: 0,
        startSeq: 0,
      }),
      () => applyBodyEdit(harness.deps, {
        groupId: 'anchor-1',
        index: 0,
        text: 'edited body',
        expectedAnchorId: 'anchor-1',
      }),
      () => selectBodyCandidate(harness.deps, {
        groupId: 'anchor-1',
        index: 0,
        expectedAnchorId: 'anchor-1',
      }),
    ]

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'host-unsupported' })
    }
    expect(harness.events.length).toBe(beforeEvents)
    expect(bodyEventsOf(harness.events)).toHaveLength(0)
    expect(harness.followups).toHaveLength(0)
    expect(harness.denies).toHaveLength(0)
    expect(harness.activeRestrictions).toBe(0)
    expect(harness.phase.lastTurn).toBe(beforeTurn)
  })

  it('folds op-start events without a matching op-finish', () => {
    const events = [
      {
        type: BODY_EVENT_TYPE,
        seq: 0,
        time: 0,
        data: { op: 'op-start', opId: 'op-a', groupId: 'g-1', kind: 'regenerate', previousAnchorId: 'm-0', previousIndex: 0 },
      },
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      {
        type: BODY_EVENT_TYPE,
        seq: 2,
        time: 2,
        data: { op: 'op-start', opId: 'op-b', groupId: 'g-1', kind: 'regenerate', previousAnchorId: 'm-1', previousIndex: 1 },
      },
      {
        type: BODY_EVENT_TYPE,
        seq: 3,
        time: 3,
        data: { op: 'op-finish', opId: 'op-a', result: 'ok', anchorId: 'm-1' },
      },
    ]

    expect(foldPendingOps(events)).toEqual([
      {
        opId: 'op-b',
        groupId: 'g-1',
        previousAnchorId: 'm-1',
        previousIndex: 1,
        startSeq: 2,
        triggerMessageId: 'body-trigger-op-b',
      },
    ])

    const finished = [...events, {
      type: BODY_EVENT_TYPE,
      seq: 4,
      time: 4,
      data: { op: 'op-finish', opId: 'op-b', result: 'failed', reason: 'cancelled' },
    }]
    expect(foldPendingOps(finished)).toEqual([])
  })

  it('folds the durable settled marker into the pending operation', () => {
    const events = [
      {
        type: BODY_EVENT_TYPE,
        seq: 0,
        time: 0,
        data: { op: 'op-start', opId: 'op-a', groupId: 'g-1', kind: 'regenerate', previousAnchorId: 'm-0', previousIndex: 0 },
      },
      {
        type: BODY_SETTLED_EVENT_TYPE,
        seq: 1,
        time: 1,
        data: { op: 'op-settled', opId: 'op-a', groupId: 'g-1', anchorId: 'm-1', index: 1 },
      },
    ]

    expect(foldPendingOps(events)).toEqual([
      {
        opId: 'op-a',
        groupId: 'g-1',
        previousAnchorId: 'm-0',
        previousIndex: 0,
        startSeq: 0,
        triggerMessageId: 'body-trigger-op-a',
        settled: { anchorId: 'm-1', index: 1 },
      },
    ])

    const finished = [...events, {
      type: BODY_EVENT_TYPE,
      seq: 2,
      time: 2,
      data: { op: 'op-finish', opId: 'op-a', result: 'ok', anchorId: 'm-1' },
    }]
    expect(foldPendingOps(finished)).toEqual([])

    // A repeated marker after op-finish is harmless evidence of the completed
    // operation and must not fail the whole fold.
    const repeated = [...finished, {
      type: BODY_SETTLED_EVENT_TYPE,
      seq: 3,
      time: 3,
      data: { op: 'op-settled', opId: 'op-a', groupId: 'g-1', anchorId: 'm-1', index: 1 },
    }]
    expect(foldPendingOps(repeated)).toEqual([])
  })

  it('prepares the old anchor turn rollback before the trigger starts', async () => {
    const calls: string[] = []
    const observed = { bodyEvents: -1, developer: -1, surface: [] as number[] }
    let harness = undefined as unknown as Harness
    const port = createRollbackPort({
      prepare: async (agentId, turn, previousMessageId) => {
        observed.bodyEvents = bodyEventsOf(harness.events).length
        observed.developer = harness.events.filter((event) => event.type === 'developer/message').length
        observed.surface = harness.surface()
        return rollbackPlan(agentId, turn, previousMessageId)
      },
    }, calls)
    harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: port,
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`])
    expect(observed.bodyEvents).toBe(0)
    expect(observed.developer).toBe(0)
    expect(observed.surface).toContain(anchorSeq)
    expect(bodyEventsOf(harness.events).filter((event) => event.data.op === 'op-start')).toHaveLength(1)
    // The anchor stays visible until successful settlement; start only keeps
    // candidate 0 (a log record) alongside it.
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.events.some((event) => event.type === 'developer/message')).toBe(false)
    expect(harness.phase.lastTurn).toBe(0)
    expect(started.op.rollbackPlan?.turn).toBe(1)
  })

  it('commits the prepared rollback plan after a successful settlement', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, calls),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)

    const finished = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)

    expect(finished).toEqual({ status: 'ok', anchorMessageId: 'new-body' })
    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'commit:1'])
  })

  it('rolls back the failed turn writes before restoring the old plan and body', async () => {
    const calls: string[] = []
    const observed = {
      turnStartsAtRollback: -1,
      restoreEventsAtRollback: -1,
      turnStartsAtRestore: -1,
      restoreEventsAtRestore: -1,
    }
    let harness = undefined as unknown as Harness
    const port = createRollbackPort({
      rollbackTurnWrites: async (agentId, turn) => {
        observed.turnStartsAtRollback = harness.events.filter((event) => event.type === 'turn/start').length
        observed.restoreEventsAtRollback = bodyEventsWithOp(harness.events, 'restore').length
        return newTurnRollback(agentId, turn)
      },
      restore: async () => {
        observed.turnStartsAtRestore = harness.events.filter((event) => event.type === 'turn/start').length
        observed.restoreEventsAtRestore = bodyEventsWithOp(harness.events, 'restore').length
      },
    }, calls)
    harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: port,
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, undefined, false)
    const failed = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(failed.status).toBe('failed')

    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length
    const restoredId = await restoreBodyAfterFailure(harness.deps, started.op)

    expect(restoredId).toBe('anchor-1')
    expect(calls).toEqual([
      `prepare:${harness.agentId}:1:anchor-1`,
      'rollback-turn:2',
      'restore:1',
    ])
    expect(observed.turnStartsAtRollback).toBe(2)
    expect(observed.restoreEventsAtRollback).toBe(0)
    expect(observed.turnStartsAtRestore).toBe(2)
    expect(observed.restoreEventsAtRestore).toBe(0)
    expect(harness.phase.lastTurn).toBe(3)
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('refuses regeneration with zero body records when prepare fails', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        prepare: async () => {
          throw new BodyRollbackError(
            'body-state-unsafe',
            'old turn has no write journal',
            { detail: 'write-journal-missing', stage: 'prepare' },
          )
        },
      }, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({ code: 'body-state-unsafe', detail: 'write-journal-missing' })

    expect(bodyEventsOf(harness.events)).toHaveLength(0)
    expect(harness.followups).toHaveLength(0)
    expect(harness.denies).toHaveLength(0)
    expect(harness.surface()).toContain(anchorSeq)
  })

  it('restores the prepared plan when start fails after prepare', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: new Error('followup transport closed'),
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, calls),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({ code: 'operation-failed' })

    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'restore:1'])
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })
    expect(harness.activeRestrictions).toBe(0)
    expect(harness.followups).toHaveLength(1)
  })

  it('restores the prepared plan when the op-start append fails', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, calls),
    })
    const appendRecord = harness.deps.appendRecord
    if (appendRecord === undefined) throw new Error('fake harness: appendRecord is missing')
    harness.deps.appendRecord = (session, type, data) => {
      if (isRecord(data) && data.op === 'op-start') throw new Error('op-start append failed')
      return appendRecord(session, type, data)
    }
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({ code: 'operation-failed' })

    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'restore:1'])
    expect(bodyEventsOf(harness.events)).toHaveLength(0)
    expect(harness.followups).toHaveLength(0)
    expect(harness.activeRestrictions).toBe(0)
    expect(harness.surface()).toContain(anchorSeq)
  })

  it('throws when the new turn writes cannot be rolled back', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        rollbackTurnWrites: async () => { throw new Error('new turn undo down') },
      }, calls),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, undefined, false)
    const failed = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(failed.status).toBe('failed')
    const turnStartsBefore = harness.events.filter((event) => event.type === 'turn/start').length

    await expect(restoreBodyAfterFailure(harness.deps, started.op)).rejects.toMatchObject({
      code: 'operation-failed',
      message: expect.stringContaining('failed to roll back turn 2 writes'),
    })

    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'rollback-turn:2'])
    expect(harness.events.filter((event) => event.type === 'turn/start')).toHaveLength(turnStartsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('throws when the new-turn rollback reports per-entry failures', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        rollbackTurnWrites: async (agentId, turn) => ({
          sessionId: agentId,
          turn,
          undone: 0,
          skippedUncommitted: [],
          failures: [{
            journalId: 'journal-new-1',
            kind: 'memory',
            tool: 'memory_write',
            code: 'body-rollback-failed',
            message: 'memory store down',
          }],
        }),
      }, []),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, undefined, false)
    const failed = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(failed.status).toBe('failed')

    await expect(restoreBodyAfterFailure(harness.deps, started.op)).rejects.toMatchObject({
      code: 'operation-failed',
      message: expect.stringContaining('could not undo 1 new-turn write'),
    })

    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('throws when the committed plan cannot be committed', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        commit: async () => { throw new Error('commit store down') },
      }, []),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)

    await expect(finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 }))
      .rejects.toMatchObject({ code: 'operation-failed' })
  })

  it('commits the rollback plan before hiding the old anchor', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        commit: async () => { throw new Error('commit store down') },
      }, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const failedTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)

    await expect(finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 }))
      .rejects.toMatchObject({ code: 'operation-failed', message: expect.stringContaining('failed to commit the write rollback') })

    // Proposal 0022 §10: commit runs while the old anchor is still visible, so
    // a commit failure leaves a restore path that needs no assistant copy.
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.surface()).toContain(failedTurn.finalSeq)
    expect(harness.events.some((event) => event.type === 'developer/message')).toBe(false)
    expect(settledEventsOf(harness.events)).toHaveLength(0)
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })

    closeTurn(harness, 2)
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length
    const restoredId = await restoreBodyAfterFailure(harness.deps, started.op)

    expect(restoredId).toBe('anchor-1')
    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'commit:1', 'rollback-turn:2', 'restore:1'])
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.surface()).not.toContain(failedTurn.finalSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(harness.events.some((event) => String(messageOf(event)?.id).startsWith('body-restore-'))).toBe(false)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
    expect(harness.phase.lastTurn).toBe(3)
  })

  it('keeps the settled body when op-finish fails after the hide and retries only op-finish', async () => {
    const calls: string[] = []
    let commitFails = false
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        commit: async () => {
          if (commitFails) throw new Error('commit store down')
        },
        restore: async () => { throw new Error('restore must not run for a settled body') },
        rollbackTurnWrites: async () => { throw new Error('new-turn rollback must not run for a settled body') },
      }, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const appendRecord = harness.deps.appendRecord
    if (appendRecord === undefined) throw new Error('fake harness: appendRecord is missing')
    let failFinish = true
    harness.deps.appendRecord = (session, type, data) => {
      if (failFinish && type === BODY_EVENT_TYPE && isRecord(data) && data.op === 'op-finish') {
        throw new Error('finish writer down')
      }
      return appendRecord(session, type, data)
    }
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    let thrown: unknown
    try {
      await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    } catch (error) {
      thrown = error
    }
    const failure = bodyFailureOf(thrown)
    expect(failure.code).toBe('settled-finish-pending')
    expect(failure.op?.opId).toBe(started.opId)

    // The new body stays selected and visible; only op-finish is missing.
    let surface = harness.surface()
    expect(surface).toContain(triggerTurn.finalSeq)
    expect(surface).not.toContain(anchorSeq)
    expect(bodyEvent(harness.events, 'op-finish')).toBeUndefined()
    const settled = settledEventsOf(harness.events)
    expect(settled.map((event) => event.data.phase)).toEqual(['settling', 'settled'])
    expect(settled[1]?.data).toMatchObject({ opId: started.opId, anchorId: 'new-body', index: 1 })
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)

    // Failure restore sees the marker and returns before the open-turn guard:
    // the still-open settle turn must not block it, and it must write nothing.
    const eventsBeforeRestore = harness.events.length
    expect(await restoreBodyAfterFailure(harness.deps, started.op)).toBe('new-body')
    expect(harness.events).toHaveLength(eventsBeforeRestore)
    surface = harness.surface()
    expect(surface).toContain(triggerTurn.finalSeq)
    expect(surface).not.toContain(anchorSeq)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()

    // Restart recovery simulates a crash during turn stopping: the trigger turn
    // is still open, so recovery must only fill op-finish and then close the
    // bracket. A commit/restore failure raised here would prove the settled
    // operation still touched the body, so the port is armed to fail and the
    // call log must stay unchanged.
    failFinish = false
    commitFails = true
    pendingByAgent.clear()
    const callsBeforeRecovery = [...calls]
    const outcome = await recoverBodyOperationWith(
      recoveryHost(),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'settled', pending: 1 })
    expect(outcome.reason).toBe('closed-turn-2')
    expect(calls).toEqual(callsBeforeRecovery)
    const finishes = bodyEventsWithOp(harness.events, 'op-finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]?.data).toMatchObject({ result: 'ok', anchorId: 'new-body' })
    expect(bodyEventsWithOp(harness.events, 'candidate')).toHaveLength(2)
    expect(bodyEventsWithOp(harness.events, 'select')).toHaveLength(1)
    expect(harness.events.filter((event) => event.type === 'developer/message')).toHaveLength(1)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(harness.events.filter((event) => event.type === 'turn/end' && event.data.turn === 2)).toHaveLength(1)
  })

  it('completes a settling operation after a crash between the hide and the settled marker', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const appendRecord = harness.deps.appendRecord
    if (appendRecord === undefined) throw new Error('fake harness: appendRecord is missing')
    let failSettlementProof = true
    harness.deps.appendRecord = (session, type, data) => {
      if (failSettlementProof && isRecord(data)) {
        if (type === BODY_SETTLED_EVENT_TYPE && data.op === 'op-settled' && data.phase === 'settled') {
          throw new Error('settled marker writer down')
        }
        if (type === BODY_EVENT_TYPE && data.op === 'op-finish') throw new Error('finish writer down')
      }
      return appendRecord(session, type, data)
    }
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    let thrown: unknown
    try {
      await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    } catch (error) {
      thrown = error
    }
    expect(bodyFailureOf(thrown).code).toBe('settled-finish-pending')
    // The crash window: the hide succeeded and only the pre-hide record is
    // durable. No settled marker, no op-finish, no cancellation.
    expect(settledEventsOf(harness.events).map((event) => event.data.phase)).toEqual(['settling'])
    expect(bodyEvent(harness.events, 'op-finish')).toBeUndefined()
    expect(harness.surface()).not.toContain(anchorSeq)
    expect(harness.surface()).toContain(triggerTurn.finalSeq)

    // Restart: recovery has to prove the hide from the surface and ledger, then
    // upgrade the marker and finish. It must not hide or select again.
    failSettlementProof = false
    pendingByAgent.clear()
    const stages: string[] = []
    const outcome = await recoverBodyOperationWith(
      recoveryStageHost(stages),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'settled', pending: 1 })
    expect(stages).toContain('settling-recovered')
    expect(settledEventsOf(harness.events).map((event) => event.data.phase)).toEqual(['settling', 'settled'])
    const finishes = bodyEventsWithOp(harness.events, 'op-finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]?.data).toMatchObject({ result: 'ok', anchorId: 'new-body' })
    expect(bodyEventsWithOp(harness.events, 'candidate')).toHaveLength(2)
    expect(bodyEventsWithOp(harness.events, 'select')).toHaveLength(1)
    expect(harness.events.filter((event) => event.type === 'developer/message')).toHaveLength(1)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(harness.events.some((event) => String(messageOf(event)?.id).startsWith('body-restore-'))).toBe(false)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('cancels a settling operation when the previous anchor survived the hide', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    // A crash after the pre-hide marker, after the hide failed, and before the
    // cancellation record or the selection rollback became durable.
    harness.session.append(BODY_EVENT_TYPE, {
      op: 'candidate',
      groupId: 'anchor-1',
      messageId: 'new-body',
      index: 1,
    })
    harness.session.append(BODY_EVENT_TYPE, { op: 'select', groupId: 'anchor-1', index: 1 })
    harness.session.append(BODY_SETTLED_EVENT_TYPE, {
      op: 'op-settled',
      phase: 'settling',
      opId: started.opId,
      groupId: 'anchor-1',
      anchorId: 'new-body',
      index: 1,
    })
    harness.session.append(BODY_EVENT_TYPE, { op: 'select', groupId: 'anchor-1', index: 0 })
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    pendingByAgent.clear()
    const stages: string[] = []
    const outcome = await recoverBodyOperationWith(
      recoveryStageHost(stages),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'restored', pending: 1 })
    expect(stages).toContain('cancelled')
    const cancelled = harness.events.find((event) => event.type === BODY_SETTLED_EVENT_TYPE
      && event.data.op === 'op-settle-cancelled')
    expect(cancelled?.data).toMatchObject({
      opId: started.opId,
      groupId: 'anchor-1',
      anchorId: 'new-body',
      index: 1,
    })
    expect(String(cancelled?.data.reason)).toContain('previous anchor')
    expect(settledEventsOf(harness.events).filter((event) => event.data.phase === 'settled')).toHaveLength(0)
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.surface()).not.toContain(triggerTurn.triggerSeq)
    expect(harness.surface()).not.toContain(triggerTurn.processSeq)
    expect(harness.surface()).not.toContain(triggerTurn.finalSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('keeps an ambiguous settling operation pending instead of guessing', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    // The pre-hide record is durable, but the previous anchor is still visible
    // while the ledger still selects the new candidate: the surface and ledger
    // disagree, so recovery must not settle or restore.
    harness.session.append(BODY_EVENT_TYPE, {
      op: 'candidate',
      groupId: 'anchor-1',
      messageId: 'new-body',
      index: 1,
    })
    harness.session.append(BODY_EVENT_TYPE, { op: 'select', groupId: 'anchor-1', index: 1 })
    harness.session.append(BODY_SETTLED_EVENT_TYPE, {
      op: 'op-settled',
      phase: 'settling',
      opId: started.opId,
      groupId: 'anchor-1',
      anchorId: 'new-body',
      index: 1,
    })
    const bodyEventsBefore = bodyEventsOf(harness.events).length
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    pendingByAgent.clear()
    const outcome = await recoverBodyOperationWith(
      recoveryHost(),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'failed', pending: 1 })
    expect(bodyEvent(harness.events, 'op-finish')).toBeUndefined()
    expect(bodyEventsOf(harness.events)).toHaveLength(bodyEventsBefore)
    expect(settledEventsOf(harness.events).filter((event) => event.data.phase === 'settled')).toHaveLength(0)
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('records a cancellation when the hide fails and never treats the attempt as settled', async () => {
    const harness = healthyHarness()
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const triggerTurn = appendTriggerTurn(harness, 2, trigger, 'new-body', false)

    const sessionAppend = harness.session.append
    let failHide = true
    harness.session.append = (type, data, opts) => {
      if (failHide && type === 'developer/message') throw new Error('hide writer down')
      return sessionAppend(type, data, opts)
    }
    const appendRecord = harness.deps.appendRecord
    if (appendRecord === undefined) throw new Error('fake harness: appendRecord is missing')
    let failFinish = true
    harness.deps.appendRecord = (session, type, data) => {
      if (failFinish && type === BODY_EVENT_TYPE && isRecord(data) && data.op === 'op-finish') {
        throw new Error('finish writer down')
      }
      return appendRecord(session, type, data)
    }
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    let thrown: unknown
    try {
      await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    } catch (error) {
      thrown = error
    }
    expect(bodyFailureOf(thrown).code).toBe('operation-failed')
    const cancelled = harness.events.find((event) => event.type === BODY_SETTLED_EVENT_TYPE
      && event.data.op === 'op-settle-cancelled')
    expect(cancelled?.data).toMatchObject({
      groupId: 'anchor-1',
      anchorId: 'new-body',
      index: 1,
    })
    expect(String(cancelled?.data.reason)).toContain('hide writer down')
    expect(settledEventsOf(harness.events)
      .filter((event) => event.data.op === 'op-settled')
      .map((event) => event.data.phase)).toEqual(['settling'])
    expect(bodyEventsWithOp(harness.events, 'select').map((event) => event.data.index)).toEqual([1, 0])
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.surface()).toContain(triggerTurn.finalSeq)

    // Restart with no op-finish: the cancellation must route to the previous
    // body, never to a settled finish.
    failHide = false
    failFinish = false
    pendingByAgent.clear()
    const outcome = await recoverBodyOperationWith(
      recoveryHost(),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'restored', pending: 1 })
    expect(settledEventsOf(harness.events).filter((event) => event.data.phase === 'settled')).toHaveLength(0)
    expect(bodyEvent(harness.events, 'op-finish')?.data).toMatchObject({ result: 'failed' })
    expect(harness.surface()).toContain(anchorSeq)
    expect(harness.surface()).not.toContain(triggerTurn.triggerSeq)
    expect(harness.surface()).not.toContain(triggerTurn.finalSeq)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(harness.events.some((event) => String(messageOf(event)?.id).startsWith('body-restore-'))).toBe(false)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('rejects a settled record whose anchor or index does not match the ledger', async () => {
    const mismatch = async (
      markerAnchorId: string,
      markerIndex: number,
      selectedIndex: number | undefined,
    ): Promise<void> => {
      const harness = healthyHarness()
      seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
      const started = await startRegenerate(harness.deps, {
        groupId: 'anchor-1',
        expectedAnchorId: 'anchor-1',
        expectedIndex: 0,
      })
      const trigger = firstFollowup(harness)
      appendTriggerTurn(harness, 2, trigger, 'new-body', false)
      harness.session.append(BODY_EVENT_TYPE, {
        op: 'candidate',
        groupId: 'anchor-1',
        messageId: 'new-body',
        index: 1,
      })
      if (selectedIndex !== undefined) {
        harness.session.append(BODY_EVENT_TYPE, { op: 'select', groupId: 'anchor-1', index: selectedIndex })
      }
      harness.session.append(BODY_SETTLED_EVENT_TYPE, {
        op: 'op-settled',
        phase: 'settled',
        opId: started.opId,
        groupId: 'anchor-1',
        anchorId: markerAnchorId,
        index: markerIndex,
      })
      const recovered = foldPendingOps(harness.events)[0]
      if (recovered === undefined) throw new Error('foldPendingOps did not rebuild the operation')
      const bodyEventsBefore = bodyEventsOf(harness.events).length

      await expect(finalizeRecoveredOperation(harness.deps, recovered, 2))
        .rejects.toMatchObject({ code: 'invalid-event' })

      expect(bodyEventsOf(harness.events)).toHaveLength(bodyEventsBefore)
      expect(bodyEvent(harness.events, 'op-finish')).toBeUndefined()
      expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(3)
    }

    // The candidate slot at index 1 is 'new-body', not the previous anchor.
    await mismatch('anchor-1', 1, 1)
    // The slot is right, but the ledger never selected it.
    await mismatch('new-body', 1, 0)
  })

  it('reports finish-pending when a settled body still cannot record op-finish', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, 'new-body', false)
    const appendRecord = harness.deps.appendRecord
    if (appendRecord === undefined) throw new Error('fake harness: appendRecord is missing')
    let failFinish = true
    harness.deps.appendRecord = (session, type, data) => {
      if (failFinish && type === BODY_EVENT_TYPE && isRecord(data) && data.op === 'op-finish') {
        throw new Error('finish writer down')
      }
      return appendRecord(session, type, data)
    }
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    let thrown: unknown
    try {
      await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    } catch (error) {
      thrown = error
    }
    expect(bodyFailureOf(thrown).code).toBe('settled-finish-pending')
    expect(settledEventsOf(harness.events).map((event) => event.data.phase)).toEqual(['settling', 'settled'])

    // The writer stays down across the restart: recovery can prove the body is
    // settled but still cannot record op-finish.
    pendingByAgent.clear()
    const stages: string[] = []
    const outcome = await recoverBodyOperationWith(
      recoveryStageHost(stages),
      harness.deps.agent,
      async () => harness.deps,
    )

    // The body is settled, but op-finish still cannot be written: this is not a
    // restore and must stay visible as pending bookkeeping.
    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'finish-pending', pending: 1 })
    expect(stages).toContain('settled-finish-pending')
    expect(bodyEvent(harness.events, 'op-finish')).toBeUndefined()
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(harness.events.some((event) => String(messageOf(event)?.id).startsWith('body-restore-'))).toBe(false)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('throws without writing a restore turn when the plan cannot be restored', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        restore: async () => { throw new Error('restore store down') },
      }, calls),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    appendTriggerTurn(harness, 2, trigger, undefined, false)
    const failed = await finalizeTurnStopping(harness.deps, { agentId: harness.agentId, turn: 2 })
    closeTurn(harness, 2)
    expect(failed.status).toBe('failed')
    const turnStartsBefore = harness.events.filter((event) => event.type === 'turn/start').length

    await expect(restoreBodyAfterFailure(harness.deps, started.op))
      .rejects.toMatchObject({ code: 'operation-failed' })

    expect(calls).toEqual([
      `prepare:${harness.agentId}:1:anchor-1`,
      'rollback-turn:2',
      'restore:1',
    ])
    expect(harness.events.filter((event) => event.type === 'turn/start')).toHaveLength(turnStartsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
  })

  it('keeps script and game tools denied while memory and variables run', async () => {
    expect(BODY_WRITE_TOOL_DENY).toEqual(['tavern_script_advance', 'game_start', 'game_move'])
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    expect(harness.denies).toEqual([['tavern_script_advance', 'game_start', 'game_move']])
  })

  it('serialises per-session operations and propagates failures from the tail', async () => {
    const harness = healthyHarness()
    const order: string[] = []
    const first = withBodyLock(harness.deps, async () => {
      order.push('first-start')
      await Promise.resolve()
      order.push('first-end')
      return 'first'
    })
    const second = withBodyLock(harness.deps, async () => {
      order.push('second-start')
      order.push('second-end')
      return 'second'
    })
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])

    const expected = bodyRuntimeError('invalid-arguments', 'tail failure')
    await expect(withBodyLock(harness.deps, async () => {
      throw expected
    })).rejects.toBe(expected)
    expect(await withBodyLock(harness.deps, async () => 'after-failure')).toBe('after-failure')
  })

  it('runs the candidate preflight before appending the edit event', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    seedLedgerCandidate(harness, 'anchor-1', 'anchor-1')
    const observed: Array<{ readonly editEvents: number; readonly input: BodyEditInspection }> = []
    harness.deps.inspectEdit = async (input) => {
      observed.push({ editEvents: bodyEventsWithOp(harness.events, 'edit').length, input })
    }

    const state = await applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      text: 'edited body',
      expectedAnchorId: 'anchor-1',
    })

    expect(observed).toHaveLength(1)
    expect(observed[0]?.editEvents).toBe(0)
    expect(observed[0]?.input).toMatchObject({
      groupId: 'anchor-1',
      index: 0,
      messageId: 'anchor-1',
      previousText: 'old body',
    })
    expect(observed[0]?.input.ledger.selectedIndex).toBe(0)
    expect(bodyEventsWithOp(harness.events, 'edit')).toHaveLength(1)
    expect(state).toMatchObject({ selectedIndex: 0, text: 'edited body' })
  })

  it('writes no edit event when the candidate preflight refuses', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    seedLedgerCandidate(harness, 'anchor-1', 'anchor-1')
    const eventsBefore = harness.events.length
    harness.deps.inspectEdit = async () => {
      throw bodyRuntimeError('body-state-unsafe', 'candidate receipt is missing', 'body-receipt-missing')
    }

    await expect(applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      text: 'edited body',
      expectedAnchorId: 'anchor-1',
    })).rejects.toMatchObject({ code: 'body-state-unsafe', detail: 'body-receipt-missing' })

    expect(harness.events).toHaveLength(eventsBefore)
    expect(bodyEventsWithOp(harness.events, 'edit')).toHaveLength(0)
  })

  it('keeps the legacy edit path when no preflight hook is injected', async () => {
    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    seedLedgerCandidate(harness, 'anchor-1', 'anchor-1')
    expect(harness.deps.inspectEdit).toBeUndefined()

    const state = await applyBodyEdit(harness.deps, {
      groupId: 'anchor-1',
      index: 0,
      text: 'edited body',
      expectedAnchorId: 'anchor-1',
    })

    expect(state.text).toBe('edited body')
    expect(bodyEventsWithOp(harness.events, 'edit')).toHaveLength(1)
  })
})

/* ------------------ durable rollback plan (proposal 0022 §10.4) ----------- */

function recoveryHost(): BodyRecoveryHost {
  return {
    bindingOf: () => ({ architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' }),
    safetyOf: () => ({ safe: true }),
  }
}

function recoveryStageHost(stages: string[]): BodyRecoveryHost {
  return {
    ...recoveryHost(),
    logger: {
      info: (...args: unknown[]) => {
        const fields = args[1]
        if (!isRecord(fields)) return
        const stage = fields.stage
        if (typeof stage === 'string') stages.push(stage)
      },
    },
  }
}

function appendLegacyOpStart(harness: Harness, opId: string): void {
  harness.session.append(BODY_EVENT_TYPE, {
    op: 'op-start',
    opId,
    groupId: 'anchor-1',
    kind: 'regenerate',
    previousAnchorId: 'anchor-1',
    previousIndex: 0,
  })
}

describe('AgentTavern durable body rollback plan', () => {
  it('writes the prepared rollback plan into the op-start payload', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, []),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    const opStart = bodyEvent(harness.events, 'op-start')
    expect(opStart?.data).toMatchObject({ opId: started.opId, kind: 'regenerate', previousIndex: 0 })
    expect(opStart?.data.rollbackPlan).toEqual(rollbackPlan(harness.agentId, 1, 'anchor-1'))
    expect(started.op.rollbackPlan).toEqual(rollbackPlan(harness.agentId, 1, 'anchor-1'))
    // The plan must survive the JSONL round trip the host will perform.
    const persisted = JSON.parse(JSON.stringify(opStart?.data.rollbackPlan)) as unknown
    expect(persisted).toEqual(opStart?.data.rollbackPlan)
  })

  it('rebuilds the durable rollback plan when folding pending ops', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, []),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    const started = await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    const pending = foldPendingOps(harness.events)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      opId: started.opId,
      groupId: 'anchor-1',
      previousAnchorId: 'anchor-1',
      previousIndex: 0,
      triggerMessageId: started.triggerMessageId,
    })
    expect(pending[0]?.rollbackPlan).toEqual(rollbackPlan(harness.agentId, 1, 'anchor-1'))
  })

  it('keeps nested journal, receipt and diagnostic entries through the op-start fold', async () => {
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        prepare: async (agentId, turn, previousMessageId) => ({
          ...rollbackPlan(agentId, turn, previousMessageId),
          journal: [{
            kind: 'memory',
            journalId: 'journal-1',
            tool: 'memory_write',
            target: { id: 'mem-1', scope: 'character', scopeId: 'Character' },
            before: null,
            after: null,
          }],
          mvuReceipts: [{
            at: '2026-10-28T00:00:00.000Z',
            turnKey: '1',
            status: 'updated',
            changes: [{ name: 'mvu.favor', after: 2 }],
            failures: [],
          }],
          diagnostics: [{ code: 'journal-uncommitted-skipped', message: 'before-only journal id skipped' }],
        }),
      }, []),
    })
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })

    const pending = foldPendingOps(harness.events)
    const plan = pending[0]?.rollbackPlan
    if (plan === undefined) throw new Error('foldPendingOps dropped the durable plan')
    expect(plan.journal[0]).toMatchObject({ kind: 'memory', journalId: 'journal-1', tool: 'memory_write' })
    expect(plan.journal[0]?.before).toBeNull()
    expect(plan.journal[0]?.after).toBeNull()
    expect(plan.mvuReceipts[0]).toMatchObject({ turnKey: '1', status: 'updated' })
    expect(plan.mvuReceipts[0]?.changes).toEqual([{ name: 'mvu.favor', after: 2 }])
    expect(plan.diagnostics[0]).toEqual({ code: 'journal-uncommitted-skipped', message: 'before-only journal id skipped' })
  })

  it('restores the durable plan after a restart without adding a body message', async () => {
    const calls: string[] = []
    const restoredPlans: BodyRollbackPlan[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        restore: async (plan) => { restoredPlans.push(plan) },
      }, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    await startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })
    const trigger = firstFollowup(harness)
    const failedTurn = appendTriggerTurn(harness, 2, trigger, undefined, false)
    closeTurn(harness, 2)

    // Simulated process restart: the durable log is all recovery may use.
    pendingByAgent.clear()
    const assistantsBefore = harness.events.filter((event) => event.type === 'assistant/message').length

    const outcome = await recoverBodyOperationWith(
      recoveryHost(),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'restored', pending: 1 })
    expect(calls).toEqual([
      `prepare:${harness.agentId}:1:anchor-1`,
      'rollback-turn:2',
      'restore:1',
    ])
    expect(restoredPlans).toHaveLength(1)
    expect(restoredPlans[0]).toEqual(rollbackPlan(harness.agentId, 1, 'anchor-1'))

    // The anchor stayed on the surface, so recovery hides only the failed turn.
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsBefore)
    expect(bodyEvent(harness.events, 'restore')).toBeUndefined()
    const surface = harness.surface()
    expect(surface).toContain(anchorSeq)
    expect(surface).not.toContain(failedTurn.triggerSeq)
    expect(surface).not.toContain(failedTurn.processSeq)
    expect(surface).not.toContain(failedTurn.toolResultSeq)
    expect(harness.phase.lastTurn).toBe(3)
  })

  it('restores a legacy op whose anchor was already hidden through the body-restore fallback', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({}, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    appendLegacyOpStart(harness, 'body-op-legacy')
    hideAnchorLikeLegacyStart(harness, 2, anchorSeq)
    harness.session.append('turn/start', { turn: 3 })
    harness.session.append('step/start', { turn: 3, step: 1 })
    harness.session.append('user/message', {
      id: 'body-trigger-body-op-legacy',
      role: 'user',
      content: [{ type: 'text', text: 'regenerate' }],
      source: { form: 'body-regenerate', opId: 'body-op-legacy', groupId: 'anchor-1' },
    }, { surfaceOp: 'append' })
    harness.session.append('step/end', { turn: 3, step: 1 })
    closeTurn(harness, 3)
    expect(harness.surface()).not.toContain(anchorSeq)

    const folded = foldPendingOps(harness.events)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.rollbackPlan).toBeUndefined()
    // A session written before the settled marker has no settlement evidence,
    // so the compatibility restore below must stay reachable.
    expect(folded[0]?.settled).toBeUndefined()
    expect(settledEventsOf(harness.events)).toHaveLength(0)

    const outcome = await recoverBodyOperationWith(
      recoveryHost(),
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'restored', pending: 1 })
    expect(calls).toEqual(['rollback-turn:3'])
    expect(calls.some((call) => call.startsWith('restore:'))).toBe(false)
    const restoreEvent = bodyEvent(harness.events, 'restore')
    expect(restoreEvent?.data).toMatchObject({ groupId: 'anchor-1', index: 0 })
    const restoredId = restoreEvent?.data.messageId
    if (typeof restoredId !== 'string') throw new Error('legacy recovery did not record a restore message')
    expect(restoredId).toMatch(/^body-restore-/)
    const restoredSeq = seqOfMessage(harness.events, restoredId)
    expect(restoredSeq).toBeDefined()
    expect(harness.surface()).toContain(restoredSeq)
    expect(harness.phase.lastTurn).toBe(4)
  })

  it('rejects a malformed durable plan with invalid-event instead of a partial accept', async () => {
    const malformed = { ...rollbackPlan('agent-legacy', 1, 'anchor-1'), journal: 'not-an-array' }
    const standalone = [{
      type: BODY_EVENT_TYPE,
      seq: 7,
      data: {
        op: 'op-start',
        opId: 'op-bad',
        groupId: 'g-1',
        kind: 'regenerate',
        previousAnchorId: 'm-0',
        previousIndex: 0,
        rollbackPlan: malformed,
      },
    }]

    let thrown: unknown
    try {
      foldPendingOps(standalone)
    } catch (error) {
      thrown = error
    }
    const failure = bodyFailureOf(thrown)
    expect(failure.code).toBe('invalid-event')
    expect(failure.message).toContain('seq 7')
    expect(failure.message).toContain('rollbackPlan.journal')

    const harness = healthyHarness()
    seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)
    const reported: Record<string, unknown>[] = []
    const host: BodyRecoveryHost = {
      ...recoveryHost(),
      logger: {
        error: (...args: unknown[]) => {
          const fields = args[1]
          if (isRecord(fields)) reported.push(fields)
        },
      },
    }
    const badSeq = harness.events.length
    harness.session.append(BODY_EVENT_TYPE, {
      op: 'op-start',
      opId: 'op-bad',
      groupId: 'anchor-1',
      kind: 'regenerate',
      previousAnchorId: 'anchor-1',
      previousIndex: 0,
      rollbackPlan: malformed,
    })

    const outcome = await recoverBodyOperationWith(
      host,
      harness.deps.agent,
      async () => harness.deps,
    )

    expect(outcome).toMatchObject({ agentId: harness.agentId, status: 'failed', pending: 0, reason: 'invalid-event' })
    expect(bodyEventsWithOp(harness.events, 'op-finish')).toHaveLength(0)
    const foldReport = reported.find((fields) => fields.code === 'invalid-event')
    if (foldReport === undefined) throw new Error('recovery did not report the invalid event')
    expect(String(foldReport.error)).toContain(`seq ${badSeq}`)
    expect(String(foldReport.error)).toContain('rollbackPlan.journal')
  })

  it('refuses a plan that cannot survive a JSONL round trip and replays it', async () => {
    const calls: string[] = []
    const harness = createHarness({
      status: 'idle',
      phaseKind: 'idle',
      lastTurn: 0,
      followupError: undefined,
      restrictError: undefined,
      appendRecord: true,
      rollback: createRollbackPort({
        prepare: async (agentId, turn, previousMessageId) => ({
          ...rollbackPlan(agentId, turn, previousMessageId),
          bodyText: (() => 'old body') as unknown as string,
        }),
      }, calls),
    })
    const anchorSeq = seedClosedTurn(harness, 1, 'anchor-1', 'old body', true)

    await expect(startRegenerate(harness.deps, {
      groupId: 'anchor-1',
      expectedAnchorId: 'anchor-1',
      expectedIndex: 0,
    })).rejects.toMatchObject({
      code: 'body-state-unsafe',
      message: expect.stringContaining('rollbackPlan.bodyText'),
    })

    expect(calls).toEqual([`prepare:${harness.agentId}:1:anchor-1`, 'restore:1'])
    expect(bodyEventsOf(harness.events)).toHaveLength(0)
    expect(harness.followups).toHaveLength(0)
    expect(harness.surface()).toContain(anchorSeq)
  })
})
