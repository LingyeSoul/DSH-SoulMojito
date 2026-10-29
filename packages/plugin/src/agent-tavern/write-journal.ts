/**
 * AgentTavern write journal (proposal 0022 §3).
 *
 * Every journaled mutation appends a `before` record before it touches the
 * store and an `after` record once the store accepted the change. Records live
 * in the session log as `plugin:dsh-soulmojito/write` plugin records
 * (`ignorable: true`), so they never reach the model surface and survive a
 * restart for body rollback.
 *
 * Reading and folding are pure. Only the writer resolution touches the host
 * seam (`@deepseek-ai/dsh-session`); this module never reads the clock or the
 * filesystem, so callers own the `at` timestamp and the store interactions.
 */

import { randomUUID } from 'node:crypto'
import {
  importHostPackage,
  readSessionEvents,
  type HostSessionLog,
} from '../../../bind/src/index.js'
import type {
  MemoryRecord,
  MemoryScope,
  MemorySource,
  VariableScope,
  VariableSnapshot,
} from '../../../tavern-store/src/index.js'
import {
  WriteJournalError,
  foldSettleIntents,
  invalid,
  isRecord,
  jsonValueAt,
  recordAt,
  textAt,
  timestampAt,
  type SettleIntentOpenEntry,
  type WriteJournalRecordWriter,
  type WriteJournalSession,
} from './settle-intent-record.js'

// Settle intent records keep their own shard; this module re-exports the whole
// previous surface so callers keep importing from `write-journal.js`.
export { WriteJournalError, foldSettleIntents }
export { SETTLE_INTENT_EVENT_TYPE, appendSettleIntentWith, readSettleIntents } from './settle-intent-record.js'
export type {
  SettleIntentCloseEntry,
  SettleIntentEntry,
  SettleIntentExtendEntry,
  SettleIntentItem,
  SettleIntentOpenEntry,
  WriteJournalErrorCode,
  WriteJournalRecordWriter,
  WriteJournalSession,
} from './settle-intent-record.js'

/* ------------------------------- vocabulary -------------------------------- */

/** Plugin record type carrying every journaled mutation. */
export const WRITE_JOURNAL_EVENT_TYPE = 'plugin:dsh-soulmojito/write' as const

/** Phase of one mutation journaled in two steps. */
export type WriteJournalPhase = 'before' | 'after'

/** Memory tool calls that journal their writes. */
export const MEMORY_WRITE_JOURNAL_TOOLS = ['memory_write', 'memory_update', 'memory_forget'] as const
export type WriteJournalMemoryTool = (typeof MEMORY_WRITE_JOURNAL_TOOLS)[number]

/** Variable tool calls that journal their writes. */
export const VARIABLE_WRITE_JOURNAL_TOOLS = ['variable_set', 'variable_patch', 'variable_delete'] as const
export type WriteJournalVariableTool = (typeof VARIABLE_WRITE_JOURNAL_TOOLS)[number]

/* ------------------------------- entry shape ------------------------------- */

/** Memory identity a journaled write targets. */
export interface WriteJournalMemoryTarget {
  readonly id: string
  readonly scope: MemoryScope
  readonly scopeId: string
}

/** Variable scope a journaled write targets. */
export interface WriteJournalVariableTarget {
  readonly scope: VariableScope
  readonly scopeId: string
}

/** One memory mutation record; `null` means "no record existed". */
export interface WriteJournalMemoryEntry {
  readonly kind: 'memory'
  readonly tool: WriteJournalMemoryTool
  readonly journalId: string
  readonly sessionId: string
  readonly turn: number
  readonly phase: WriteJournalPhase
  readonly at: string
  readonly target: WriteJournalMemoryTarget
  readonly before?: MemoryRecord | null
  readonly after?: MemoryRecord | null
}

/** One variable mutation record; `null` means "no snapshot existed". */
export interface WriteJournalVariableEntry {
  readonly kind: 'variable'
  readonly tool: WriteJournalVariableTool
  readonly journalId: string
  readonly sessionId: string
  readonly turn: number
  readonly phase: WriteJournalPhase
  readonly at: string
  readonly target: WriteJournalVariableTarget
  readonly before?: readonly VariableSnapshot[] | null
  readonly after?: readonly VariableSnapshot[] | null
}

/** Payload of one `plugin:dsh-soulmojito/write` session event. */
export type WriteJournalEntry = WriteJournalMemoryEntry | WriteJournalVariableEntry

/* ----------------------------- settle intents ------------------------------ */

/** Durable seam of one settle batch; the commit marker reuses the same handle. */
export interface SettleIntentHandle {
  readonly opId: string
  readonly sessionId: string
  readonly session: WriteJournalSession
  readonly writer: WriteJournalRecordWriter
}

/* ---------------------------------- host ----------------------------------- */

/** Minimal structural view of the host agent carrying the live session. */
export interface WriteJournalAgent {
  readonly id?: string
  readonly session?: WriteJournalSession
}

/** Everything one journaled tool call needs to append its two phases. */
export interface WriteJournalHandle {
  readonly journalId: string
  readonly sessionId: string
  readonly turn: number
  readonly session: WriteJournalSession
  readonly writer: WriteJournalRecordWriter
}

/* ---------------------------------- read ----------------------------------- */

/**
 * Current open turn of a session event log.
 *
 * `turn/start` opens a turn and `turn/end` closes it; the last event wins.
 * Non-turn events are ignored. A `turn/start` without a non-negative integer
 * `data.turn` is rejected instead of being guessed.
 *
 * @returns the open turn number, or `undefined` when no turn is open
 */
export function currentTurnOf(events: readonly unknown[]): number | undefined {
  let open: number | undefined
  for (const [index, event] of events.entries()) {
    if (!isRecord(event)) continue
    const type = event['type']
    if (type === 'turn/start') {
      open = turnOfEvent(event, index)
    } else if (type === 'turn/end') {
      open = undefined
    }
  }
  return open
}

/**
 * Read every write journal record from a session event log, in log order.
 *
 * Events of other types are ignored. A journal record with a malformed or
 * unknown payload throws: silently skipping it would hide an unusable undo
 * record from the rollback path.
 */
export function readWriteJournal(events: readonly unknown[]): readonly WriteJournalEntry[] {
  const entries: WriteJournalEntry[] = []
  for (const [index, event] of events.entries()) {
    if (!isRecord(event)) continue
    if (event['type'] !== WRITE_JOURNAL_EVENT_TYPE) continue
    entries.push(parseEntry(event['data'], index))
  }
  return entries
}

/**
 * Fold the settle intents still open in a live session log.
 *
 * A successful settle closes every open intent of its chat scope, so an intent
 * left by an earlier failed attempt cannot undo a later committed batch on the
 * next startup. An unreadable session log throws instead of reporting "none".
 */
export function openSettleIntentsOf(
  session: WriteJournalSession,
  sessionId: string,
): readonly SettleIntentOpenEntry[] {
  return foldSettleIntents(eventsOfSession(session, sessionId))
}

/* ---------------------------------- write ---------------------------------- */

/** Fresh journal id shared by the `before` and `after` record of one mutation. */
export function newJournalId(): string {
  return randomUUID()
}

/**
 * Resolve the host plugin-record seam.
 *
 * A missing package or an import that fails means the seam does not exist on
 * this host; callers treat the result as `unavailable` and keep ordinary
 * writes working. The resolution is not cached: journal appends happen at most
 * twice per tool call, and the ESM module cache already dedupes the import, so
 * a reloaded host module is picked up without stale state.
 */
export async function resolveWriteJournalWriter(): Promise<WriteJournalRecordWriter | undefined> {
  let host: SessionHostModule
  try {
    host = await importHostPackage<SessionHostModule>('@deepseek-ai/dsh-session')
  } catch {
    // Absent package or failed host import: no seam on this deployment.
    return undefined
  }
  const append = host.appendPluginRecord
  if (typeof append !== 'function') return undefined
  const appendRecord = append as (session: WriteJournalSession, type: string, data: unknown) => unknown
  return (session, type, data) => appendRecord(session, type, data)
}

/**
 * Append one journal record through an explicit writer.
 *
 * Host failures are wrapped with the record identity (kind, tool, phase,
 * journal id) and the original error as `cause`, then rethrown: a failed
 * `before` append must abort the tool before any business write, and a failed
 * `after` append must surface as a concrete error, never be swallowed.
 */
export function appendWriteJournalWith(
  writer: WriteJournalRecordWriter,
  session: WriteJournalSession,
  entry: WriteJournalEntry,
): 'recorded' {
  try {
    writer(session, WRITE_JOURNAL_EVENT_TYPE, entry)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new WriteJournalError(
      'write-journal-append-failed',
      `cannot append the write journal ${entry.phase} record '${entry.journalId}' for ${entry.kind} ${entry.tool}: ${reason}`,
      { cause },
    )
  }
  return 'recorded'
}

/**
 * Append one journal record through the host seam.
 *
 * @returns `'unavailable'` when the host exposes no `appendPluginRecord`, so
 * the caller keeps its ordinary write; `'recorded'` once the host accepted it
 */
export async function appendWriteJournal(
  agent: WriteJournalAgent | undefined,
  entry: WriteJournalEntry,
): Promise<'recorded' | 'unavailable'> {
  const writer = await resolveWriteJournalWriter()
  if (writer === undefined) return 'unavailable'
  const session = requireSession(agent)
  return appendWriteJournalWith(writer, session, entry)
}

/**
 * Open the journal of one tool call.
 *
 * @returns `undefined` when the host has no journal seam (the caller skips
 * journaling), otherwise the journal id, turn and writer to reuse for both
 * phases
 *
 * @throws WriteJournalError when the seam exists but the live session, its
 * event log or the open turn cannot be read: without them the undo record
 * would be incomplete, so the tool must fail closed before mutating
 */
export async function openWriteJournal(
  agent: WriteJournalAgent | undefined,
  sessionId: string,
): Promise<WriteJournalHandle | undefined> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new WriteJournalError('write-journal-session-missing', 'write journal requires the session id of the writing agent')
  }
  const writer = await resolveWriteJournalWriter()
  if (writer === undefined) return undefined
  const session = requireSession(agent)
  const turn = currentTurnOf(eventsOfSession(session, sessionId))
  if (turn === undefined) {
    throw new WriteJournalError(
      'write-journal-turn-missing',
      `write journal requires an open turn in session '${sessionId}'; the session log has no turn/start that is still open`,
    )
  }
  return { journalId: newJournalId(), sessionId, turn, session, writer }
}

/* -------------------------------- settle write ----------------------------- */

/** Fresh operation id shared by one settle batch's open and close records. */
export function newSettleIntentOpId(): string {
  return randomUUID()
}

/**
 * Open the durable intent seam of one settle batch.
 *
 * @returns `undefined` when the host exposes no `appendPluginRecord`: the tool
 * keeps its legacy settle path and the cross-store window stays unguarded
 *
 * @throws WriteJournalError when the seam exists but the live session cannot be
 * read; without it no intent can be recorded, so the caller must not write
 */
export async function openSettleIntent(
  agent: WriteJournalAgent | undefined,
  sessionId: string,
): Promise<SettleIntentHandle | undefined> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new WriteJournalError('write-journal-session-missing', 'settle intent requires the session id of the writing agent')
  }
  const writer = await resolveWriteJournalWriter()
  if (writer === undefined) return undefined
  const session = requireSession(agent)
  return { opId: newSettleIntentOpId(), sessionId, session, writer }
}

/* ------------------------------- validation -------------------------------- */

interface SessionHostModule {
  readonly appendPluginRecord?: unknown
}

const MEMORY_SCOPES: readonly MemoryScope[] = ['turn', 'chat', 'character', 'agent', 'global']
const VARIABLE_SCOPES: readonly VariableScope[] = ['turn', 'chat', 'character', 'agent', 'global']

function requireSession(agent: WriteJournalAgent | undefined): WriteJournalSession {
  const session = agent?.session
  if (session === undefined) {
    throw new WriteJournalError(
      'write-journal-session-missing',
      'write journal requires exec.agent.session; the tool execution carries no live session',
    )
  }
  return session
}

function eventsOfSession(session: WriteJournalSession, sessionId: string): readonly unknown[] {
  const events = readSessionEvents(session as HostSessionLog)
  if (events === undefined) {
    throw new WriteJournalError(
      'write-journal-session-unreadable',
      `write journal cannot read the event log of session '${sessionId}' (events/snapshotEvents/log are all unavailable)`,
    )
  }
  return events
}

function parseEntry(data: unknown, index: number): WriteJournalEntry {
  const where = `write journal event at index ${index}`
  if (!isRecord(data)) throw invalid(where, 'data must be an object')
  const kind = data['kind']
  if (kind === 'memory') return parseMemoryEntry(data, where)
  if (kind === 'variable') return parseVariableEntry(data, where)
  throw invalid(where, `unknown kind '${String(kind)}'`)
}

function parseMemoryEntry(record: Record<string, unknown>, where: string): WriteJournalMemoryEntry {
  const target = recordAt(record['target'], `${where} target`)
  const before = optionalMemoryRecord(record['before'], `${where} before`)
  const after = optionalMemoryRecord(record['after'], `${where} after`)
  return {
    kind: 'memory',
    tool: memoryToolAt(record['tool'], where),
    journalId: textAt(record, 'journalId', where),
    sessionId: textAt(record, 'sessionId', where),
    turn: turnAt(record, where),
    phase: phaseAt(record, where),
    at: timestampAt(record, 'at', where),
    target: {
      id: textAt(target, 'id', `${where} target`),
      scope: memoryScopeAt(target['scope'], `${where} target`),
      scopeId: textAt(target, 'scopeId', `${where} target`),
    },
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  }
}

function parseVariableEntry(record: Record<string, unknown>, where: string): WriteJournalVariableEntry {
  const target = recordAt(record['target'], `${where} target`)
  const before = optionalSnapshots(record['before'], `${where} before`)
  const after = optionalSnapshots(record['after'], `${where} after`)
  return {
    kind: 'variable',
    tool: variableToolAt(record['tool'], where),
    journalId: textAt(record, 'journalId', where),
    sessionId: textAt(record, 'sessionId', where),
    turn: turnAt(record, where),
    phase: phaseAt(record, where),
    at: timestampAt(record, 'at', where),
    target: {
      scope: variableScopeAt(target['scope'], `${where} target`),
      scopeId: textAt(target, 'scopeId', `${where} target`),
    },
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  }
}

function turnOfEvent(event: Record<string, unknown>, index: number): number {
  const data = isRecord(event['data']) ? event['data'] : undefined
  const turn = data?.['turn']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) {
    throw invalid(
      `session event at index ${index}`,
      `a turn/start must carry a non-negative integer data.turn, received '${String(turn)}'`,
    )
  }
  return turn
}

function optionalMemoryRecord(value: unknown, where: string): MemoryRecord | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return memoryRecordAt(value, where)
}

function memoryRecordAt(value: unknown, where: string): MemoryRecord {
  const record = recordAt(value, where)
  const kind = record['kind']
  if (kind !== 'semantic' && kind !== 'episodic') {
    throw invalid(where, `field 'kind' must be 'semantic' or 'episodic', received '${String(kind)}'`)
  }
  return {
    id: textAt(record, 'id', where),
    scope: memoryScopeAt(record['scope'], where),
    scopeId: textAt(record, 'scopeId', where),
    kind,
    content: textAt(record, 'content', where),
    tags: stringArrayAt(record['tags'], `${where} tags`),
    importance: scoreAt(record, 'importance', where),
    confidence: scoreAt(record, 'confidence', where),
    source: memorySourceAt(record['source'], `${where} source`),
    createdAt: timestampAt(record, 'createdAt', where),
    updatedAt: timestampAt(record, 'updatedAt', where),
    ...(record['lastAccessedAt'] === undefined ? {} : { lastAccessedAt: timestampAt(record, 'lastAccessedAt', where) }),
    ...(record['expiresAt'] === undefined ? {} : { expiresAt: timestampAt(record, 'expiresAt', where) }),
    ...(record['deletedAt'] === undefined ? {} : { deletedAt: timestampAt(record, 'deletedAt', where) }),
    revision: textAt(record, 'revision', where),
  }
}

/** Rebuild a memory source, keeping producer-owned extras the store wrote. */
function memorySourceAt(value: unknown, where: string): MemorySource {
  const record = recordAt(value, where)
  const source: MemorySource = { kind: textAt(record, 'kind', where) }
  for (const [key, item] of Object.entries(record)) {
    if (key === 'kind') continue
    source[key] = item
  }
  return source
}

function optionalSnapshots(value: unknown, where: string): readonly VariableSnapshot[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value)) throw invalid(where, 'must be an array of variable snapshots or null')
  return value.map((item, index) => variableSnapshotAt(item, `${where}[${index}]`))
}

function variableSnapshotAt(value: unknown, where: string): VariableSnapshot {
  const record = recordAt(value, where)
  return {
    scope: variableScopeAt(record['scope'], where),
    scopeId: textAt(record, 'scopeId', where),
    name: textAt(record, 'name', where),
    value: jsonValueAt(record['value'], `${where} value`),
    revision: textAt(record, 'revision', where),
    updatedAt: timestampAt(record, 'updatedAt', where),
  }
}

function memoryToolAt(value: unknown, where: string): WriteJournalMemoryTool {
  for (const tool of MEMORY_WRITE_JOURNAL_TOOLS) if (value === tool) return tool
  throw invalid(where, `field 'tool' must be one of ${MEMORY_WRITE_JOURNAL_TOOLS.join(', ')}, received '${String(value)}'`)
}

function variableToolAt(value: unknown, where: string): WriteJournalVariableTool {
  for (const tool of VARIABLE_WRITE_JOURNAL_TOOLS) if (value === tool) return tool
  throw invalid(where, `field 'tool' must be one of ${VARIABLE_WRITE_JOURNAL_TOOLS.join(', ')}, received '${String(value)}'`)
}

function memoryScopeAt(value: unknown, where: string): MemoryScope {
  for (const scope of MEMORY_SCOPES) if (value === scope) return scope
  throw invalid(where, `memory scope must be one of ${MEMORY_SCOPES.join(', ')}, received '${String(value)}'`)
}

function variableScopeAt(value: unknown, where: string): VariableScope {
  for (const scope of VARIABLE_SCOPES) if (value === scope) return scope
  throw invalid(where, `variable scope must be one of ${VARIABLE_SCOPES.join(', ')}, received '${String(value)}'`)
}

function phaseAt(record: Record<string, unknown>, where: string): WriteJournalPhase {
  const value = record['phase']
  if (value !== 'before' && value !== 'after') {
    throw invalid(where, `field 'phase' must be 'before' or 'after', received '${String(value)}'`)
  }
  return value
}

function turnAt(record: Record<string, unknown>, where: string): number {
  const value = record['turn']
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(where, `field 'turn' must be a non-negative safe integer, received '${String(value)}'`)
  }
  return value
}

function scoreAt(record: Record<string, unknown>, field: string, where: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(where, `field '${field}' must be a number between 0 and 1`)
  }
  return value
}

function stringArrayAt(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw invalid(where, 'must be an array of strings')
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw invalid(where, 'must be an array of strings')
    result.push(item)
  }
  return result
}
