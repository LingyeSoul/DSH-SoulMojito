/**
 * AgentTavern body write rollback: write journal reads and new-turn undo.
 *
 * This shard owns the session-log side: turn tool calls, journal folding into
 * committed memory/variable writes, journal coverage checks, diagnostics and
 * the `rollbackTurnWrites` implementation. It delegates every store mutation to
 * `body-rollback-writes.ts` and never reads the chat or MVU receipts.
 */

import type { MemoryRecord, VariableSnapshot } from '../../../tavern-store/src/index.js'
import {
  MEMORY_WRITE_JOURNAL_TOOLS,
  VARIABLE_WRITE_JOURNAL_TOOLS,
  readWriteJournal,
  resolveWriteJournalWriter,
  type WriteJournalEntry,
  type WriteJournalMemoryEntry,
  type WriteJournalMemoryTarget,
  type WriteJournalMemoryTool,
  type WriteJournalVariableEntry,
  type WriteJournalVariableTarget,
  type WriteJournalVariableTool,
} from './write-journal.js'
import {
  BodyRollbackError,
  errorMessage,
  isRecord,
  log,
  requireNonEmptyString,
  requireNonNegativeInteger,
  type BodyNewTurnRollback,
  type BodyRollbackDiagnostic,
  type BodyRollbackErrorCode,
  type BodyRollbackJournalWrite,
  type BodyRollbackLogger,
  type BodyRollbackMemoryWrite,
  type BodyRollbackVariableWrite,
  type BodyTurnRollbackFailure,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'
import { applyJournalWrites, type CompensationResult } from './body-rollback-writes.js'

/* ------------------------------- session log ------------------------------- */

async function readEvents(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
): Promise<readonly unknown[]> {
  let events: readonly unknown[] | undefined
  try {
    events = await deps.sessionEvents(agentId)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback cannot read the session log of '${agentId}': ${errorMessage(error)}`,
      { detail: 'session-unreadable', stage: 'prepare', sessionId: agentId, turn, cause: error },
    )
  }
  if (events === undefined) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback cannot read the session log of '${agentId}'`,
      { detail: 'session-unreadable', stage: 'prepare', sessionId: agentId, turn },
    )
  }
  return events
}

function toolNamesInTurn(events: readonly unknown[], turn: number): string[] {
  const names: string[] = []
  let open: number | undefined
  for (const event of events) {
    if (!isRecord(event)) continue
    const type = event['type']
    if (type === 'turn/start') {
      open = turnNumberOf(event['data'])
      continue
    }
    if (type === 'turn/end') {
      open = undefined
      continue
    }
    if (type !== 'assistant/message') continue
    const data = isRecord(event['data']) ? event['data'] : undefined
    if (data === undefined) continue
    const eventTurn = typeof data['turn'] === 'number' ? data['turn'] : open
    if (eventTurn !== turn) continue
    const message = isRecord(data['message']) ? data['message'] : undefined
    const content = message?.['content']
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool-call') continue
      const name = block['name']
      if (typeof name === 'string' && name !== '') names.push(name)
    }
  }
  return names
}

function turnNumberOf(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined
  const turn = data['turn']
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

/* ------------------------------ journal build ------------------------------ */

export interface JournalBuild {
  readonly writes: readonly BodyRollbackJournalWrite[]
  readonly uncommitted: readonly string[]
  /** Tools that produced at least one journal record, committed or not. */
  readonly tools: ReadonlySet<string>
}

/** One turn's folded journal plus the journaled tool names seen in its log. */
export interface TurnJournalLoad {
  readonly journal: JournalBuild
  readonly toolNames: readonly string[]
}

function buildJournalWrites(events: readonly unknown[], agentId: string, turn: number): JournalBuild {
  let entries: readonly WriteJournalEntry[]
  try {
    entries = readWriteJournal(events)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback cannot read the write journal of session '${agentId}' turn ${turn}: ${errorMessage(error)}`,
      { detail: 'write-journal-missing', stage: 'prepare', sessionId: agentId, turn, cause: error },
    )
  }

  const groups = new Map<string, WriteJournalEntry[]>()
  for (const entry of entries) {
    if (entry.sessionId !== agentId || entry.turn !== turn) continue
    const group = groups.get(entry.journalId)
    if (group === undefined) groups.set(entry.journalId, [entry])
    else group.push(entry)
  }

  const writes: BodyRollbackJournalWrite[] = []
  const uncommitted: string[] = []
  const tools = new Set<string>()
  for (const [journalId, group] of groups) {
    const kind = group[0]?.kind
    if (kind === undefined) continue
    if (group.some((entry) => entry.kind !== kind)) {
      throw journalUnsafe(journalId, agentId, turn, 'mixes memory and variable records')
    }
    for (const entry of group) tools.add(entry.tool)
    const before = group.filter((entry) => entry.phase === 'before')
    const after = group.filter((entry) => entry.phase === 'after')
    if (before.length > 1 || after.length > 1) {
      throw journalUnsafe(journalId, agentId, turn, 'has duplicate phase records')
    }
    if (after.length === 0) {
      // A before-only record never reached the store write (the tool appends the
      // after record only after the store accepted it), so it stays untouched.
      uncommitted.push(journalId)
      continue
    }
    const beforeEntry = before[0]
    const afterEntry = after[0]!
    if (beforeEntry === undefined) {
      throw journalUnsafe(journalId, agentId, turn, 'has an after record without a before record')
    }
    if (beforeEntry.kind !== afterEntry.kind || beforeEntry.tool !== afterEntry.tool) {
      throw journalUnsafe(journalId, agentId, turn, 'has mismatched kind/tool phases')
    }
    writes.push(
      beforeEntry.kind === 'memory'
        ? memoryWriteOf(beforeEntry, afterEntry as WriteJournalMemoryEntry, journalId, agentId, turn)
        : variableWriteOf(beforeEntry, afterEntry as WriteJournalVariableEntry, journalId, agentId, turn),
    )
  }
  return { writes, uncommitted, tools }
}

function memoryWriteOf(
  beforeEntry: WriteJournalMemoryEntry,
  afterEntry: WriteJournalMemoryEntry,
  journalId: string,
  agentId: string,
  turn: number,
): BodyRollbackMemoryWrite {
  if (!sameMemoryTarget(beforeEntry.target, afterEntry.target)) {
    throw journalUnsafe(journalId, agentId, turn, 'targets two different memories')
  }
  const before = requireMemoryBefore(beforeEntry, journalId, agentId, turn)
  const after = requireMemoryAfter(afterEntry, journalId, agentId, turn)
  assertMemoryRecordMatches(before, beforeEntry.target, journalId, agentId, turn)
  assertMemoryRecordMatches(after, beforeEntry.target, journalId, agentId, turn)
  if (beforeEntry.tool === 'memory_write' && before !== null) {
    throw journalUnsafe(journalId, agentId, turn, 'memory_write must record a null before state')
  }
  if (beforeEntry.tool !== 'memory_write' && before === null) {
    throw journalUnsafe(journalId, agentId, turn, `memory_${beforeEntry.tool} requires a before record`)
  }
  if (beforeEntry.tool !== 'memory_forget' && after === null) {
    throw journalUnsafe(journalId, agentId, turn, `${beforeEntry.tool} requires an after record`)
  }
  return {
    kind: 'memory',
    journalId,
    tool: beforeEntry.tool,
    target: beforeEntry.target,
    before,
    after,
  }
}

function variableWriteOf(
  beforeEntry: WriteJournalVariableEntry,
  afterEntry: WriteJournalVariableEntry,
  journalId: string,
  agentId: string,
  turn: number,
): BodyRollbackVariableWrite {
  if (beforeEntry.target.scope !== afterEntry.target.scope || beforeEntry.target.scopeId !== afterEntry.target.scopeId) {
    throw journalUnsafe(journalId, agentId, turn, 'targets two different variable scopes')
  }
  const before = requireSnapshotsBefore(beforeEntry, journalId, agentId, turn)
  const after = requireSnapshotsAfter(afterEntry, journalId, agentId, turn)
  assertSnapshotsMatch(before, beforeEntry.target, journalId, agentId, turn)
  assertSnapshotsMatch(after, beforeEntry.target, journalId, agentId, turn)
  if (beforeEntry.tool === 'variable_delete' && after !== null) {
    throw journalUnsafe(journalId, agentId, turn, 'variable_delete must record a null after state')
  }
  if (beforeEntry.tool !== 'variable_delete' && after === null) {
    throw journalUnsafe(journalId, agentId, turn, `${beforeEntry.tool} requires an after snapshot list`)
  }
  return {
    kind: 'variable',
    journalId,
    tool: beforeEntry.tool,
    target: beforeEntry.target,
    before,
    after,
  }
}

function sameMemoryTarget(left: WriteJournalMemoryTarget, right: WriteJournalMemoryTarget): boolean {
  return left.id === right.id && left.scope === right.scope && left.scopeId === right.scopeId
}

function requireMemoryBefore(
  entry: WriteJournalMemoryEntry,
  journalId: string,
  agentId: string,
  turn: number,
): MemoryRecord | null {
  if (!('before' in entry) || entry.before === undefined) {
    throw journalUnsafe(journalId, agentId, turn, 'has a before record without a before state')
  }
  return entry.before
}

function requireMemoryAfter(
  entry: WriteJournalMemoryEntry,
  journalId: string,
  agentId: string,
  turn: number,
): MemoryRecord | null {
  if (!('after' in entry) || entry.after === undefined) {
    throw journalUnsafe(journalId, agentId, turn, 'has an after record without an after state')
  }
  return entry.after
}

function requireSnapshotsBefore(
  entry: WriteJournalVariableEntry,
  journalId: string,
  agentId: string,
  turn: number,
): readonly VariableSnapshot[] | null {
  if (!('before' in entry) || entry.before === undefined) {
    throw journalUnsafe(journalId, agentId, turn, 'has a before record without a before state')
  }
  return entry.before
}

function requireSnapshotsAfter(
  entry: WriteJournalVariableEntry,
  journalId: string,
  agentId: string,
  turn: number,
): readonly VariableSnapshot[] | null {
  if (!('after' in entry) || entry.after === undefined) {
    throw journalUnsafe(journalId, agentId, turn, 'has an after record without an after state')
  }
  return entry.after
}

function assertMemoryRecordMatches(
  record: MemoryRecord | null,
  target: WriteJournalMemoryTarget,
  journalId: string,
  agentId: string,
  turn: number,
): void {
  if (record === null) return
  if (record.id !== target.id || record.scope !== target.scope || record.scopeId !== target.scopeId) {
    throw journalUnsafe(journalId, agentId, turn, `records memory '${record.id}' outside its target`)
  }
}

function assertSnapshotsMatch(
  snapshots: readonly VariableSnapshot[] | null,
  target: WriteJournalVariableTarget,
  journalId: string,
  agentId: string,
  turn: number,
): void {
  if (snapshots === null) return
  for (const snapshot of snapshots) {
    if (snapshot.scope !== target.scope || snapshot.scopeId !== target.scopeId) {
      throw journalUnsafe(journalId, agentId, turn, `records variable '${snapshot.name}' outside its target scope`)
    }
  }
}

/**
 * Read one turn's session log and fold its write journal (`read only`).
 *
 * Kept together so callers do one event-log pass instead of two and cannot
 * accidentally fold a different turn's journal than the one whose tool calls
 * they validate.
 */
export async function loadTurnJournal(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
): Promise<TurnJournalLoad> {
  const events = await readEvents(deps, agentId, turn)
  return {
    journal: buildJournalWrites(events, agentId, turn),
    toolNames: toolNamesInTurn(events, turn),
  }
}

export async function assertJournalCoverage(
  deps: BodyWriteRollbackDeps,
  toolNames: readonly string[],
  journal: JournalBuild,
  agentId: string,
  turn: number,
): Promise<void> {
  const requested = [...new Set(toolNames)].filter(
    (name) => MEMORY_TOOL_SET.has(name) || VARIABLE_TOOL_SET.has(name),
  )
  const missing = requested.filter((name) => !journal.tools.has(name))
  if (missing.length === 0) return
  const writer = await journalWriterAvailable(deps, agentId, turn)
  if (!writer) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} cannot roll back ${missing.join(', ')}: the host does not expose appendPluginRecord (write journal unavailable)`,
      { detail: 'write-journal-unavailable', stage: 'prepare', sessionId: agentId, turn },
    )
  }
  throw new BodyRollbackError(
    'body-state-unsafe',
    `body rollback for session '${agentId}' turn ${turn} cannot roll back ${missing.join(', ')}: the tool call has no write journal record`,
    { detail: 'write-journal-missing', stage: 'prepare', sessionId: agentId, turn },
  )
}

async function journalWriterAvailable(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
): Promise<boolean> {
  try {
    const writer = deps.resolveJournalWriter === undefined
      ? await resolveWriteJournalWriter()
      : await deps.resolveJournalWriter()
    return writer !== undefined
  } catch (error) {
    log(deps.logger, 'warn', 'dsh-soulmojito body rollback: write journal probe failed', {
      sessionId: agentId,
      turn,
      error: errorMessage(error),
    })
    return false
  }
}

/* -------------------------------- diagnostics ------------------------------ */

export function buildJournalDiagnostics(
  journal: JournalBuild,
  logger: BodyRollbackLogger | undefined,
  agentId: string,
  turn: number,
): BodyRollbackDiagnostic[] {
  const diagnostics: BodyRollbackDiagnostic[] = []
  if (journal.uncommitted.length > 0) {
    diagnostics.push({
      code: 'journal-uncommitted-skipped',
      message: `${journal.uncommitted.length} write journal group(s) have no after record and were treated as uncommitted: ${journal.uncommitted.join(', ')}`,
    })
  }
  if (journal.writes.some((write) => write.kind === 'memory')) {
    const message = 'memory vectors are not restored by the rollback port (embedWrittenMemory is outside this seam); stale vectors are left for lazy re-embedding'
    diagnostics.push({ code: 'vector-restore-skipped', message })
    log(logger, 'warn', 'dsh-soulmojito body rollback: memory vectors skipped', {
      sessionId: agentId,
      turn,
      reason: 'vector-restore-skipped',
    })
  }
  return diagnostics
}

/* --------------------------- new-turn rollback ----------------------------- */

/**
 * Undo one turn's committed writes from its own journal (proposal 0022 §10.3).
 *
 * The new turn may have written memories and flat variables before it failed
 * or was cancelled. `restore(plan)` only knows the old turn, so the runtime
 * calls this for the new turn before restoring the old plan. The method reads
 * only `sessionId + turn` journal entries, never the chat or MVU receipts, and
 * leaves the old plan untouched.
 *
 * Idempotency is state-based: every planner skips a target whose current
 * revision already matches the journal's before state, so a repeated call
 * performs no second mutation and reports `undone: 0`.
 */
export async function rollbackTurnWritesImpl(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
): Promise<BodyNewTurnRollback> {
  requireNonEmptyString(agentId, 'agentId')
  requireNonNegativeInteger(turn, 'turn')

  const events = await readEvents(deps, agentId, turn)
  const journal = buildJournalWrites(events, agentId, turn)
  const failures: BodyTurnRollbackFailure[] = []
  let undone = 0

  // Newest-first across journal groups; each group's planner reads the target
  // revision at this moment, so repeated writes to the same key unwind safely.
  const ordered = [...journal.writes].reverse()
  for (const write of ordered) {
    try {
      const applied = await applyJournalWrites(deps, [write], 'undo')
      if (applied.applied > 0) undone += 1
    } catch (error) {
      const failure: BodyTurnRollbackFailure = {
        journalId: write.journalId,
        kind: write.kind,
        tool: write.tool,
        code: error instanceof BodyRollbackError ? error.code : 'unknown',
        message: errorMessage(error),
      }
      failures.push(failure)
      log(deps.logger, 'warn', 'dsh-soulmojito body rollback: new-turn write undo failed', {
        sessionId: agentId,
        turn,
        journalId: write.journalId,
        kind: write.kind,
        tool: write.tool,
        error: failure.message,
      })
    }
  }

  const result: BodyNewTurnRollback = {
    sessionId: agentId,
    turn,
    undone,
    skippedUncommitted: [...journal.uncommitted],
    failures,
  }
  log(deps.logger, 'info', 'dsh-soulmojito body rollback: rolled back new-turn writes', {
    sessionId: agentId,
    turn,
    undone,
    skippedUncommitted: result.skippedUncommitted.length,
    failures: failures.length,
  })
  return result
}

/* --------------------------------- errors ---------------------------------- */

export function asJournalError(
  error: unknown,
  agentId: string,
  turn: number,
  compensation: CompensationResult,
): BodyRollbackError {
  const code: BodyRollbackErrorCode = compensation.ok
    ? error instanceof BodyRollbackError
      ? error.code
      : 'body-rollback-failed'
    : 'body-rollback-partial'
  return new BodyRollbackError(
    code,
    `body rollback for session '${agentId}' turn ${turn} failed to roll back the write journal: ${errorMessage(error)}${compensation.note}`,
    {
      ...(error instanceof BodyRollbackError && error.detail !== undefined ? { detail: error.detail } : {}),
      stage: 'journal-rollback',
      sessionId: agentId,
      turn,
      ...(error instanceof BodyRollbackError && error.journalId !== undefined ? { journalId: error.journalId } : {}),
      compensated: compensation.ok,
      cause: error,
    },
  )
}

function journalUnsafe(
  journalId: string,
  agentId: string,
  turn: number,
  detail: string,
): BodyRollbackError {
  return new BodyRollbackError(
    'body-state-unsafe',
    `body rollback for session '${agentId}' turn ${turn} refused: write journal '${journalId}' ${detail}`,
    { detail: 'write-journal-missing', stage: 'prepare', sessionId: agentId, turn, journalId },
  )
}

const MEMORY_TOOL_SET = new Set<string>(MEMORY_WRITE_JOURNAL_TOOLS)
const VARIABLE_TOOL_SET = new Set<string>(VARIABLE_WRITE_JOURNAL_TOOLS)
