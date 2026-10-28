/**
 * Session-log reading helpers for the body runtime.
 *
 * These functions keep the host session shape structural: event lists, surface
 * node sequences, message content, turn/step state and the pending-op
 * bookkeeping subset. They never write to the session.
 */

import { BODY_EVENT_TYPE } from './body.js'
import { bodyRuntimeError, type BodySessionLike, type PendingBodyOperation } from './body-runtime-core.js'

export interface RuntimeEvent {
  type: string
  seq: number
  data: Record<string, unknown>
}

export interface StepState {
  openStep: number | undefined
  nextStep: number
}

export function eventValues(session: BodySessionLike): readonly unknown[] {
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
    throw bodyRuntimeError('host-unsupported', `body runtime: session '${String(session.id)}' snapshotEvents() did not return an array`)
  }
  if (Array.isArray(session.log)) return session.log
  throw bodyRuntimeError('host-unsupported', `body runtime: session '${String(session.id)}' exposes no event log (events, snapshotEvents or log)`)
}

export function eventsOf(session: BodySessionLike): RuntimeEvent[] {
  return parseEventList(eventValues(session), `session '${String(session.id)}'`)
}

export function parseEventList(values: readonly unknown[], subject: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  for (const [index, value] of values.entries()) {
    if (!isPlainRecord(value)) {
      throw bodyRuntimeError('invalid-event', `${subject}: event at index ${index} is not an object`)
    }
    const type = value.type
    const seq = value.seq
    const data = value.data
    if (typeof type !== 'string' || !isEventSeq(seq) || !isPlainRecord(data)) {
      throw bodyRuntimeError('invalid-event', `${subject}: event at index ${index} needs a string type, safe-integer seq and object data`)
    }
    events.push({ type, seq, data })
  }
  events.sort((left, right) => left.seq - right.seq)
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq === events[index - 1]!.seq) {
      throw bodyRuntimeError('invalid-event', `${subject}: duplicate event seq ${events[index]!.seq}`)
    }
  }
  return events
}

export function surfaceNodeList(session: BodySessionLike): number[] {
  const surface = session.surface
  if (!isPlainRecord(surface) || !Array.isArray(surface.nodes)) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body runtime: session '${String(session.id)}' does not expose session.surface.nodes`,
    )
  }
  const nodes: number[] = []
  for (const value of surface.nodes) {
    if (!isEventSeq(value)) {
      throw bodyRuntimeError('host-unsupported', `body runtime: session '${String(session.id)}' surface contains a non-sequence node`)
    }
    nodes.push(value)
  }
  return nodes
}

export function messageOf(event: RuntimeEvent): Record<string, unknown> | undefined {
  if (event.type === 'user/message') return event.data
  const message = event.data.message
  return isPlainRecord(message) ? message : undefined
}

export function messageIdOf(event: RuntimeEvent): string | undefined {
  const message = messageOf(event)
  const id = message?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function contentOf(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => isPlainRecord(block))
}

export function textOfMessage(message: Record<string, unknown>): string {
  return contentOf(message)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

export function hasToolCall(message: Record<string, unknown>): boolean {
  return contentOf(message).some((block) => block.type === 'tool-call')
}

export function sourceOf(message: Record<string, unknown>): Record<string, unknown> | undefined {
  return isPlainRecord(message.source) ? message.source : undefined
}

export function modelSourceOf(message: Record<string, unknown>): { provider: string; model: string } | undefined {
  const source = sourceOf(message)
  if (source === undefined || source.kind !== 'model') return undefined
  const provider = source.provider
  const model = source.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

export function findEventByMessageId(events: readonly RuntimeEvent[], messageId: string): RuntimeEvent | undefined {
  return events.find((event) => messageIdOf(event) === messageId)
}

export function eventAtSeq(events: readonly RuntimeEvent[], seq: number): RuntimeEvent {
  const event = events.find((candidate) => candidate.seq === seq)
  if (event === undefined) {
    throw bodyRuntimeError('invalid-event', `body runtime: surface references missing event seq ${seq}`)
  }
  return event
}

export function findSurfaceSeqByMessageId(events: readonly RuntimeEvent[], surface: readonly number[], messageId: string): number | undefined {
  return surface.find((seq) => messageIdOf(eventAtSeq(events, seq)) === messageId)
}

export function turnOfUserMessage(events: readonly RuntimeEvent[], messageId: string): number | undefined {
  let openTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = numberField(event.data.turn)
      continue
    }
    if (event.type === 'turn/end') {
      openTurn = undefined
      continue
    }
    if (event.type === 'user/message' && messageIdOf(event) === messageId) return openTurn
  }
  return undefined
}

export function openTurnNumber(events: readonly RuntimeEvent[]): number | undefined {
  let open: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = numberField(event.data.turn)
    else if (event.type === 'turn/end') open = undefined
  }
  return open
}

/** Highest turn that has a matching `turn/end` in the log. */
export function lastClosedTurnNumber(events: readonly RuntimeEvent[]): number | undefined {
  let open: number | undefined
  let lastClosed: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = numberField(event.data.turn)
    } else if (event.type === 'turn/end') {
      if (open !== undefined) lastClosed = open
      open = undefined
    }
  }
  return lastClosed
}

/**
 * Turn that owns one event sequence.
 *
 * The message's own `data.turn` wins; otherwise the turn open at that sequence
 * (or the last closed turn) is used. Regeneration must never take the new
 * trigger turn here: the write rollback belongs to the old body's turn.
 */
export function turnOfEventSeq(events: readonly RuntimeEvent[], seq: number): number | undefined {
  let open: number | undefined
  let lastClosed: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = numberField(event.data.turn)
    } else if (event.type === 'turn/end') {
      if (open !== undefined) lastClosed = open
      open = undefined
    }
    if (event.seq !== seq) continue
    const direct = numberField(event.data.turn)
    if (direct !== undefined) return direct
    return open ?? lastClosed
  }
  return undefined
}

export function stepState(events: readonly RuntimeEvent[], turn: number): StepState {
  let openStep: number | undefined
  let nextStep = 1
  for (const event of events) {
    if (event.type === 'step/start' && numberField(event.data.turn) === turn) {
      openStep = numberField(event.data.step)
      if (openStep !== undefined) nextStep = Math.max(nextStep, openStep + 1)
      continue
    }
    if (event.type === 'step/end' && numberField(event.data.turn) === turn) {
      const step = numberField(event.data.step)
      if (openStep !== undefined && step === openStep) openStep = undefined
    }
  }
  return { openStep, nextStep }
}

export function lastBodyCandidate(
  events: readonly RuntimeEvent[],
  turn: number,
): { event: RuntimeEvent; message: Record<string, unknown>; seq: number; messageId: string } | undefined {
  let found: { event: RuntimeEvent; message: Record<string, unknown>; seq: number; messageId: string } | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' || numberField(event.data.turn) !== turn) continue
    const message = messageOf(event)
    const messageId = messageIdOf(event)
    if (message === undefined || messageId === undefined) continue
    if (textOfMessage(message).trim() === '' || hasToolCall(message)) continue
    found = { event, message, seq: event.seq, messageId }
  }
  return found
}

export function operationFinished(events: readonly RuntimeEvent[], opId: string): boolean {
  for (const event of events) {
    if (event.type !== BODY_EVENT_TYPE) continue
    if (event.data.op === 'op-finish' && event.data.opId === opId) return true
  }
  return false
}

export type PendingEvent =
  | { kind: 'start'; opId: string; groupId: string; previousAnchorId: string; previousIndex: number }
  | { kind: 'finish'; opId: string }

/**
 * Read the bookkeeping subset of one body event. Candidate/select/edit/restore
 * payloads are validated by the shared ledger; this parser only has to be
 * strict about the fields recovery depends on.
 */
export function pendingEventOf(event: RuntimeEvent): PendingEvent | undefined {
  if (event.type !== BODY_EVENT_TYPE) return undefined
  const op = event.data.op
  if (op === 'op-start') {
    if (event.data.kind !== 'regenerate') {
      throw bodyRuntimeError('invalid-event', `body op-start at seq ${event.seq} has unsupported kind '${String(event.data.kind)}'`)
    }
    return {
      kind: 'start',
      opId: pendingNonEmptyString(event.data.opId, event.seq, 'opId'),
      groupId: pendingNonEmptyString(event.data.groupId, event.seq, 'groupId'),
      previousAnchorId: pendingNonEmptyString(event.data.previousAnchorId, event.seq, 'previousAnchorId'),
      previousIndex: pendingInteger(event.data.previousIndex, event.seq, 'previousIndex'),
    }
  }
  if (op === 'op-finish') {
    return { kind: 'finish', opId: pendingNonEmptyString(event.data.opId, event.seq, 'opId') }
  }
  return undefined
}

function pendingNonEmptyString(value: unknown, seq: number, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw bodyRuntimeError('invalid-event', `body event at seq ${seq} requires ${field} to be a non-empty string`)
  }
  return value
}

function pendingInteger(value: unknown, seq: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw bodyRuntimeError('invalid-event', `body event at seq ${seq} requires ${field} to be a non-negative safe integer`)
  }
  return value
}

export function triggerMessageIdOf(op: PendingBodyOperation): string {
  return typeof op.triggerMessageId === 'string' && op.triggerMessageId !== ''
    ? op.triggerMessageId
    : triggerMessageIdFor(op.opId)
}

export function triggerMessageIdFor(opId: string): string {
  return `body-trigger-${opId}`
}

export function eventSeqOf(value: unknown): number | undefined {
  if (!isPlainRecord(value)) return undefined
  const seq = value.seq
  return isEventSeq(seq) ? seq : undefined
}

export function nextEventSeq(events: readonly RuntimeEvent[]): number {
  if (events.length === 0) return 0
  return events[events.length - 1]!.seq + 1
}

export function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

export function isEventSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
