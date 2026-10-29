/**
 * AgentTavern settle intent records.
 *
 * A settle batch writes the flat `VariableStore` before its chat receipt is
 * saved, so it brackets those writes with durable records on a dedicated plugin
 * event type: `open` and `extend` carry undo data, `decide` carries the commit
 * decision and the exact receipt to replay, `abort` states that the flat writes
 * were rolled back, and `commit`/`recovered` close the batch. This shard owns
 * that vocabulary, its parser, reader, fold and append wrapper.
 *
 * The shared journal error, the record writer seam types and the primitive
 * record validators live here as well: `write-journal.ts` imports them from
 * this module, and this module never imports back, so the dependency stays one
 * way.
 */

import type { JsonValue } from '../../../tavern-store/src/index.js'
import type { MvuReceipt, MvuVariableChange } from '../mvu.js'

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
  /** The batch could not be closed after its flat writes: recovery owns it now. */
  | 'settle-intent-abort-failed'

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

/**
 * Version of the per-item `effectiveAfter` field on an `open` record.
 *
 * Version 2 means every name the batch actually wrote also carries the
 * post-guard value the flat store accepted, so an abort replay never resurrects
 * a raw request value the MVU guard clamped or rejected. Records without this
 * version predate the tracking and must not be replayed from item values.
 */
export const SETTLE_INTENT_AFTER_VERSION = 2 as const

/** Per-variable state captured before one settle batch touches the flat store. */
export interface SettleIntentItem {
  readonly name: string
  /** Flat chat-scope value before the batch; absent when the name had no value. */
  readonly before?: JsonValue
  /** JSON value the batch requested; informational only, never replayed. */
  readonly after?: JsonValue
  /**
   * Value the guard let into the flat store. Only names carrying this field
   * were written, and an abort replay uses only this field.
   */
  readonly effectiveAfter?: JsonValue
}

/** `open` and `extend` carry undo data; every other phase closes or decides. */
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
  /**
   * `true` when the batch promised that its receipt carries `opId`. Such an
   * intent must never be closed by the legacy `at + turnKey` heuristic: a
   * receipt without an `opId` cannot prove that this batch saved.
   */
  readonly receiptOpId?: true
  /**
   * `2` when the batch records each written name's post-guard value in
   * `SettleIntentItem.effectiveAfter`. Absent on legacy intents, which must not
   * be replayed from item values.
   */
  readonly afterVersion?: typeof SETTLE_INTENT_AFTER_VERSION
  /**
   * The batch's durable commit decision, attached by `foldSettleIntents` from a
   * later `decide` record. Never present in an `open` payload.
   */
  readonly decision?: SettleIntentDecideEntry
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

/**
 * The batch's durable commit decision, written after every flat write and
 * before `saveChat`.
 *
 * It carries the exact receipt the batch was about to persist, so a crash
 * before the save replays that receipt instead of guessing whether some other
 * settlement closed the batch. `receipt.opId` must equal this record's `opId`.
 */
export interface SettleIntentDecideEntry {
  readonly kind: 'settle-intent'
  readonly phase: 'decide'
  readonly opId: string
  readonly sessionId: string
  readonly at: string
  /** Chat the decision belongs to; informational, the open record is authoritative. */
  readonly chatCharacter?: string
  readonly chatId?: string
  readonly receipt: MvuReceipt
}

/** One closure marker: a committed settle, a rolled-back batch or a recovery. */
export interface SettleIntentCloseEntry {
  readonly kind: 'settle-intent'
  readonly phase: 'commit' | 'recovered' | 'abort'
  readonly opId: string
  readonly sessionId: string
  readonly at: string
  readonly reason?: string
}

/** Payload of one `plugin:dsh-soulmojito/settle-intent` session event. */
export type SettleIntentEntry =
  | SettleIntentOpenEntry
  | SettleIntentExtendEntry
  | SettleIntentDecideEntry
  | SettleIntentCloseEntry

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
 * Fold the open settle intents a restart still has to resolve.
 *
 * `extend` items merge into their op in log order; an item carrying
 * `effectiveAfter` updates the recorded post-guard value of a name instead of
 * appending a second undo entry (an undo entry without `before` would delete the
 * name). A `decide` record attaches to its open entry; `commit`/`recovered`/
 * `abort` close the op and drop it, so an aborted batch is never restored or
 * replayed again. Opening twice, extending or deciding after closure, deciding
 * twice, deciding without an open record, extending after the decision, or
 * closing twice/without an open record throws: a damaged record must not be
 * skipped silently.
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
      if (current.decision !== undefined) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' extends after it was decided`)
      if (current.afterVersion !== SETTLE_INTENT_AFTER_VERSION
        && entry.items.some((item) => item.effectiveAfter !== undefined)) {
        throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' extends with effective after values but its open record predates afterVersion ${SETTLE_INTENT_AFTER_VERSION}`)
      }
      open.set(entry.opId, { ...current, items: mergeSettleIntentItems(current.items, entry.items) })
      continue
    }
    if (entry.phase === 'decide') {
      if (closed.has(entry.opId)) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' decides after it closed`)
      const current = open.get(entry.opId)
      if (current === undefined) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' decides without an open record`)
      if (current.decision !== undefined) throw new WriteJournalError('invalid-settle-intent', `settle intent '${entry.opId}' decides more than once`)
      open.set(entry.opId, { ...current, decision: entry })
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

/**
 * Merge one extend record into the folded undo list.
 *
 * Legacy items keep append order. An item that carries `effectiveAfter` is a
 * value update for a name the batch already lists: it replaces the recorded
 * effective value in place so undo never sees an entry without `before`.
 */
function mergeSettleIntentItems(
  current: readonly SettleIntentItem[],
  extension: readonly SettleIntentItem[],
): SettleIntentItem[] {
  const merged = [...current]
  for (const item of extension) {
    if (item.effectiveAfter === undefined) {
      merged.push(item)
      continue
    }
    let index = -1
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i]!.name === item.name) {
        index = i
        break
      }
    }
    if (index === -1) {
      merged.push(item)
      continue
    }
    merged[index] = { ...merged[index]!, effectiveAfter: item.effectiveAfter }
  }
  return merged
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

/**
 * Rebuild one settle receipt as the JSON-safe payload a `decide` record stores.
 *
 * `MvuVariableChange.before/after` are `unknown` on the receipt type; the
 * decision must round-trip through the session log, so every value is validated
 * against the JSON value grammar here instead of failing later at recovery.
 * The decision's own `opId` is authoritative and stamped onto the receipt.
 *
 * @throws WriteJournalError when a change value cannot be stored as JSON
 */
export function jsonSafeSettleReceipt(opId: string, receipt: MvuReceipt): MvuReceipt {
  const where = `settle decision receipt '${opId}'`
  return {
    at: receipt.at,
    turnKey: receipt.turnKey,
    status: receipt.status,
    changes: receipt.changes.map((change, index) => ({
      name: change.name,
      ...(change.before === undefined ? {} : { before: jsonValueAt(change.before, `${where} changes[${index}].before`) }),
      ...(change.after === undefined ? {} : { after: jsonValueAt(change.after, `${where} changes[${index}].after`) }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    })),
    failures: [...receipt.failures],
    opId,
  }
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
  if (phase === 'decide') return parseSettleIntentDecide(data, where)
  if (phase === 'commit' || phase === 'recovered' || phase === 'abort') {
    return {
      kind: 'settle-intent',
      phase,
      opId: textAt(data, 'opId', where),
      sessionId: textAt(data, 'sessionId', where),
      at: timestampAt(data, 'at', where),
      ...(data['reason'] === undefined ? {} : { reason: textAt(data, 'reason', where) }),
    }
  }
  throw invalidSettle(where, `field 'phase' must be 'open', 'extend', 'decide', 'abort', 'commit' or 'recovered', received '${String(phase)}'`)
}

function parseSettleIntentOpen(record: Record<string, unknown>, where: string): SettleIntentOpenEntry {
  const scope = record['scope']
  if (scope !== 'chat') throw invalidSettle(where, `field 'scope' must be 'chat', received '${String(scope)}'`)
  const afterVersion = record['afterVersion'] === undefined ? undefined : afterVersionAt(record, where)
  const items = settleIntentItems(record['items'], where)
  if (afterVersion !== SETTLE_INTENT_AFTER_VERSION && items.some((item) => item.effectiveAfter !== undefined)) {
    throw invalidSettle(where, `items carry 'effectiveAfter' but field 'afterVersion' is not ${SETTLE_INTENT_AFTER_VERSION}`)
  }
  return {
    kind: 'settle-intent',
    phase: 'open',
    opId: textAt(record, 'opId', where),
    sessionId: textAt(record, 'sessionId', where),
    character: textAt(record, 'character', where),
    scope: 'chat',
    scopeId: textAt(record, 'scopeId', where),
    turnKey: floorKeyAt(record, where),
    receiptAt: timestampAt(record, 'receiptAt', where),
    at: timestampAt(record, 'at', where),
    ...(record['receiptOpId'] === undefined ? {} : { receiptOpId: receiptOpIdFlagAt(record, where) }),
    ...(afterVersion === undefined ? {} : { afterVersion }),
    items,
  }
}

function parseSettleIntentDecide(record: Record<string, unknown>, where: string): SettleIntentDecideEntry {
  const opId = textAt(record, 'opId', where)
  return {
    kind: 'settle-intent',
    phase: 'decide',
    opId,
    sessionId: textAt(record, 'sessionId', where),
    at: timestampAt(record, 'at', where),
    ...(record['chatCharacter'] === undefined ? {} : { chatCharacter: textAt(record, 'chatCharacter', where) }),
    ...(record['chatId'] === undefined ? {} : { chatId: textAt(record, 'chatId', where) }),
    receipt: parseSettleIntentReceipt(record['receipt'], opId, `${where} receipt`),
  }
}

/**
 * The decision receipt must be the settle receipt of this very op: an `opId`
 * that differs (or is missing) would leave the replayed receipt unable to close
 * the intent, so the record is rejected instead of replayed.
 */
function parseSettleIntentReceipt(value: unknown, opId: string, where: string): MvuReceipt {
  const record = recordAt(value, where)
  const receiptOpId = textAt(record, 'opId', where)
  if (receiptOpId !== opId) {
    throw invalidSettle(where, `field 'opId' must equal the decide record's opId '${opId}', received '${receiptOpId}'`)
  }
  const status = record['status']
  if (status !== 'updated' && status !== 'unchanged' && status !== 'failed') {
    throw invalidSettle(where, `field 'status' must be 'updated', 'unchanged' or 'failed', received '${String(status)}'`)
  }
  return {
    at: timestampAt(record, 'at', where),
    turnKey: floorKeyAt(record, where),
    status,
    changes: settleIntentReceiptChanges(record['changes'], where),
    failures: stringArrayAt(record['failures'], `${where} failures`),
    opId: receiptOpId,
  }
}

function settleIntentReceiptChanges(value: unknown, where: string): MvuVariableChange[] {
  if (!Array.isArray(value)) throw invalidSettle(where, `field 'changes' must be an array`)
  return value.map((item, index) => {
    const changeWhere = `${where} changes[${index}]`
    const record = recordAt(item, changeWhere)
    return {
      name: textAt(record, 'name', changeWhere),
      ...(record['before'] === undefined ? {} : { before: jsonValueAt(record['before'], `${changeWhere} before`) }),
      ...(record['after'] === undefined ? {} : { after: jsonValueAt(record['after'], `${changeWhere} after`) }),
      ...(record['reason'] === undefined ? {} : { reason: textAt(record, 'reason', changeWhere) }),
    }
  })
}

function stringArrayAt(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw invalidSettle(where, 'must be an array of strings')
  return value.map((item, index) => {
    if (typeof item !== 'string') throw invalidSettle(`${where}[${index}]`, 'must be a string')
    return item
  })
}

/** Floor index of a settle receipt (`String(messages.length)` at settle time). */
function floorKeyAt(record: Record<string, unknown>, where: string): string {
  const turnKey = textAt(record, 'turnKey', where)
  if (!/^(0|[1-9][0-9]*)$/.test(turnKey)) {
    throw invalidSettle(where, `field 'turnKey' must be a floor index, received '${turnKey}'`)
  }
  return turnKey
}

function receiptOpIdFlagAt(record: Record<string, unknown>, where: string): true {
  const value = record['receiptOpId']
  if (value !== true) throw invalidSettle(where, `field 'receiptOpId' must be true when present, received '${String(value)}'`)
  return true
}

function afterVersionAt(record: Record<string, unknown>, where: string): typeof SETTLE_INTENT_AFTER_VERSION {
  const value = record['afterVersion']
  if (value !== SETTLE_INTENT_AFTER_VERSION) {
    throw invalidSettle(where, `field 'afterVersion' must be ${SETTLE_INTENT_AFTER_VERSION} when present, received '${String(value)}'`)
  }
  return SETTLE_INTENT_AFTER_VERSION
}

function settleIntentItems(value: unknown, where: string): SettleIntentItem[] {
  // An empty list is valid: a batch whose every request the flat store rejected
  // has nothing to undo, but still owns a receipt decision.
  if (!Array.isArray(value)) throw invalidSettle(where, `field 'items' must be an array of undo items`)
  return value.map((item, index) => parseSettleIntentItem(item, `${where} items[${index}]`))
}

function parseSettleIntentItem(value: unknown, where: string): SettleIntentItem {
  const record = recordAt(value, where)
  return {
    name: textAt(record, 'name', where),
    ...(record['before'] === undefined ? {} : { before: jsonValueAt(record['before'], `${where} before`) }),
    ...(record['after'] === undefined ? {} : { after: jsonValueAt(record['after'], `${where} after`) }),
    ...(record['effectiveAfter'] === undefined
      ? {}
      : { effectiveAfter: jsonValueAt(record['effectiveAfter'], `${where} effectiveAfter`) }),
  }
}
