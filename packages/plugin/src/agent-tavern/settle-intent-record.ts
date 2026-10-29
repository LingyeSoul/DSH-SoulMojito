/**
 * AgentTavern settle intent records.
 *
 * A settle batch writes the flat `VariableStore` before its chat receipt is
 * saved, so it brackets those writes with durable records on a dedicated plugin
 * event type: `open` and `extend` carry undo data, `commit` and `recovered`
 * close the batch. This shard owns that vocabulary, its parser, reader, fold
 * and append wrapper.
 *
 * The shared journal error, the record writer seam types and the primitive
 * record validators live here as well: `write-journal.ts` imports them from
 * this module, and this module never imports back, so the dependency stays one
 * way.
 */

import type { JsonValue } from '../../../tavern-store/src/index.js'

/* ---------------------------------- host ----------------------------------- */

/** Minimal structural view of the host session the journal reads and appends to. */
export interface WriteJournalSession {
  readonly id?: string
  readonly events?: readonly unknown[]
  readonly log?: readonly unknown[]
  readonly snapshotEvents?: (...args: unknown[]) => unknown
}

/**
 * Host append seam: `appendPluginRecord(session, type, data)` from
 * `@deepseek-ai/dsh-session` (DSH 0.2.1+). Synchronous by host contract.
 */
export type WriteJournalRecordWriter = (
  session: WriteJournalSession,
  type: string,
  data: unknown,
) => unknown

/* --------------------------------- errors ---------------------------------- */

export type WriteJournalErrorCode =
  | 'invalid-write-journal'
  | 'invalid-settle-intent'
  | 'write-journal-session-missing'
  | 'write-journal-session-unreadable'
  | 'write-journal-turn-missing'
  | 'write-journal-append-failed'
  | 'settle-intent-append-failed'

/** Typed failure with a stable code for callers and tests. */
export class WriteJournalError extends Error {
  readonly code: WriteJournalErrorCode

  constructor(code: WriteJournalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WriteJournalError'
    this.code = code
  }
}

/* ----------------------------- settle intents ------------------------------ */

/**
 * Plugin record type carrying one settle batch's durable intent and closure.
 *
 * It is deliberately separate from `WRITE_JOURNAL_EVENT_TYPE`: a settle batch
 * writes the flat `VariableStore` and then the chat receipts, so its undo data
 * cannot ride the ordinary variable journal without `rollbackTurnWrites`
 * mistaking an unclosed intent for a committed variable write.
 */
export const SETTLE_INTENT_EVENT_TYPE = 'plugin:dsh-soulmojito/settle-intent' as const

/** Per-variable state captured before one settle batch touches the flat store. */
export interface SettleIntentItem {
  readonly name: string
  /** Flat chat-scope value before the batch; absent when the name had no value. */
  readonly before?: JsonValue
  /** JSON value the batch intended to write; absent when the request was not JSON-safe. */
  readonly after?: JsonValue
}

/** `open` and `extend` carry undo data; `commit` and `recovered` close the intent. */
export interface SettleIntentOpenEntry {
  readonly kind: 'settle-intent'
  readonly phase: 'open'
  readonly opId: string
  readonly sessionId: string
  readonly character: string
  readonly scope: 'chat'
  readonly scopeId: string
  readonly turnKey: string
  /** Timestamp the matching MVU receipt will carry; lets recovery prove a save. */
  readonly receiptAt: string
  readonly at: string
  readonly items: readonly SettleIntentItem[]
}

/** One `extend` record: undo items a later settle phase appends to the same op. */
export interface SettleIntentExtendEntry {
  readonly kind: 'settle-intent'
  readonly phase: 'extend'
  readonly opId: string
  readonly sessionId: string
  readonly at: string
  readonly items: readonly SettleIntentItem[]
}

/** One closure marker: a committed settle or a startup recovery. */
export interface SettleIntentCloseEntry {
  readonly kind: 'settle-intent'
  readonly phase: 'commit' | 'recovered'
  readonly opId: string
  readonly sessionId: string
  readonly at: string
  readonly reason?: string
}

/** Payload of one `plugin:dsh-soulmojito/settle-intent` session event. */
export type SettleIntentEntry = SettleIntentOpenEntry | SettleIntentExtendEntry | SettleIntentCloseEntry

/* ---------------------------------- read ----------------------------------- */

/**
 * Read every settle intent record from a session log, in log order.
 *
 * The records use their own event type, so `readWriteJournal` and the
 * `rollbackTurnWrites` fold never see them as ordinary variable writes.
 */
export function readSettleIntents(events: readonly unknown[]): readonly SettleIntentEntry[] {
  const entries: SettleIntentEntry[] = []
  for (const [index, event] of events.entries()) {
    if (!isRecord(event)) continue
    if (event['type'] !== SETTLE_INTENT_EVENT_TYPE) continue
    entries.push(parseSettleIntent(event['data'], index))
  }
  return entries
}

/**
 * Fold the open settle intents a restart still has to restore.
 *
 * `extend` items merge into their op in log order; closed operations are
 * dropped. Opening twice, extending after closure, or closing twice/without
 * an open record throws: a damaged undo record must not be skipped silently.
 */
export function foldSettleIntents(events: readonly unknown[]): readonly SettleIntentOpenEntry[] {
  const open = new Map<string, SettleIntentOpenEntry>()
  const closed = new Set<string>()
  for (const entry of readSettleIntents(events)) {
    if (entry.phase === 'open') {
      if (open.has(entry.opId) || closed.has(entry.opId)) {
        throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' opens more than once`)
      }
      open.set(entry.opId, entry)
      continue
    }
    if (entry.phase === 'extend') {
      if (closed.has(entry.opId)) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' extends after it closed`)
      const current = open.get(entry.opId)
      if (current === undefined) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' extends without an open record`)
      open.set(entry.opId, { ...current, items: [...current.items, ...entry.items] })
      continue
    }
    if (closed.has(entry.opId)) {
      throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' closes more than once`)
    }
    if (!open.has(entry.opId)) {
      throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' closes without an open record`)
    }
    closed.add(entry.opId)
    open.delete(entry.opId)
  }
  return [...open.values()]
}

/* ---------------------------------- write ---------------------------------- */

/**
 * Append one settle intent record through an explicit writer.
 *
 * A failed `open` append must abort the tool before its first flat write; a
 * failed `commit` append must surface, because only the record proves the batch
 * closed. Host failures are wrapped with the operation id and phase.
 */
export function appendSettleIntentWith(
  writer: WriteJournalRecordWriter,
  session: WriteJournalSession,
  entry: SettleIntentEntry,
): 'recorded' {
  try {
    writer(session, SETTLE_INTENT_EVENT_TYPE, entry)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new WriteJournalError(
      'settle-intent-append-failed',
      `cannot append the settle intent ${entry.phase} record '${entry.opId}': ${reason}`,
      { cause },
    )
  }
  return 'recorded'
}

/* ------------------------------- validation -------------------------------- */

/** Shared primitive record validators: the ordinary journal parses with them too. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function recordAt(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(where, 'must be an object')
  return value
}

export function textAt(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(where, `field '${field}' must be a non-empty string`)
  }
  return value
}

export function timestampAt(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field]
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalid(where, `field '${field}' must be an ISO 8601 timestamp`)
  }
  return value
}

export function jsonValueAt(value: unknown, where: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(where, 'numbers must be finite')
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValueAt(item, `${where}[${index}]`))
  if (isRecord(value)) {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) record[key] = jsonValueAt(item, `${where}.${key}`)
    return record
  }
  throw invalid(where, 'must be a JSON value')
}

export function invalid(where: string, detail: string): WriteJournalError {
  return new WriteJournalError('invalid-write-journal', `${where}: ${detail}`)
}

function invalidSettle(where: string, detail: string): WriteJournalError {
  return new WriteJournalError('invalid-settle-intent', `${where}: ${detail}`)
}

/* ------------------------------ settle parsing ----------------------------- */

function parseSettleIntent(data: unknown, index: number): SettleIntentEntry {
  const where = `settle intent event at index ${index}`
  if (!isRecord(data)) throw invalidSettle(where, 'data must be an object')
  if (data['kind'] !== 'settle-intent') throw invalidSettle(where, `unknown kind '${String(data['kind'])}'`)
  const phase = data['phase']
  if (phase === 'open') return parseSettleIntentOpen(data, where)
  if (phase === 'extend') {
    return { kind: 'settle-intent', phase, opId: textAt(data, 'opId', where), sessionId: textAt(data, 'sessionId', where),
      at: timestampAt(data, 'at', where), items: settleIntentItems(data['items'], where) }
  }
  if (phase === 'commit' || phase === 'recovered') {
    return {
      kind: 'settle-intent',
      phase,
      opId: textAt(data, 'opId', where),
      sessionId: textAt(data, 'sessionId', where),
      at: timestampAt(data, 'at', where),
      ...(data['reason'] === undefined ? {} : { reason: textAt(data, 'reason', where) }),
    }
  }
  throw invalidSettle(where, `field 'phase' must be 'open', 'extend', 'commit' or 'recovered', received '${String(phase)}'`)
}

function parseSettleIntentOpen(record: Record<string, unknown>, where: string): SettleIntentOpenEntry {
  const scope = record['scope']
  if (scope !== 'chat') throw invalidSettle(where, `field 'scope' must be 'chat', received '${String(scope)}'`)
  const turnKey = textAt(record, 'turnKey', where)
  if (!/^(0|[1-9][0-9]*)$/.test(turnKey)) {
    throw invalidSettle(where, `field 'turnKey' must be a floor index, received '${turnKey}'`)
  }
  return {
    kind: 'settle-intent',
    phase: 'open',
    opId: textAt(record, 'opId', where),
    sessionId: textAt(record, 'sessionId', where),
    character: textAt(record, 'character', where),
    scope: 'chat',
    scopeId: textAt(record, 'scopeId', where),
    turnKey,
    receiptAt: timestampAt(record, 'receiptAt', where),
    at: timestampAt(record, 'at', where),
    items: settleIntentItems(record['items'], where),
  }
}

function settleIntentItems(value: unknown, where: string): SettleIntentItem[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidSettle(where, `field 'items' must be a non-empty array`)
  return value.map((item, index) => parseSettleIntentItem(item, `${where} items[${index}]`))
}

function parseSettleIntentItem(value: unknown, where: string): SettleIntentItem {
  const record = recordAt(value, where)
  return {
    name: textAt(record, 'name', where),
    ...(record['before'] === undefined ? {} : { before: jsonValueAt(record['before'], `${where} before`) }),
    ...(record['after'] === undefined ? {} : { after: jsonValueAt(record['after'], `${where} after`) }),
  }
}
