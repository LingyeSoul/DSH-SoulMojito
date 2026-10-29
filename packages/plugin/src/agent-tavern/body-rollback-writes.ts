/**
 * AgentTavern body write rollback: flat-store journal operations.
 *
 * This shard plans and executes memory/variable journal entries in one
 * direction. It owns only `MemoryStore` / `VariableStore` writes: undo restores
 * the before state, replay restores the after state. It also resolves a
 * before-only journal group (a lost `after` append) by probing the store, and
 * compensates a partially applied group. It never reads the chat, the MVU
 * receipts or the session log.
 */

import {
  MemoryRevisionConflictError,
  VariableRevisionConflictError,
  type JsonValue,
  type MemoryRecord,
  type MemoryScope,
  type VariableScope,
  type VariableSnapshot,
} from '../../../tavern-store/src/index.js'
import {
  BodyRollbackError,
  errorMessage,
  log,
  type BodyRollbackDiagnostic,
  type BodyRollbackJournalWrite,
  type BodyRollbackMemoryWrite,
  type BodyRollbackStage,
  type BodyRollbackVariableWrite,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'
import type {
  WriteJournalMemoryEntry,
  WriteJournalMemoryTarget,
  WriteJournalVariableEntry,
  WriteJournalVariableTarget,
} from './write-journal.js'
import {
  assertMemoryRecordMatches,
  assertSnapshotsMatch,
  journalUnsafe,
  requireMemoryBefore,
  requireSnapshotsBefore,
} from './write-journal.js'

/* ---------------------------- journal operations --------------------------- */

export type JournalDirection = 'undo' | 'replay'

type JournalOperation =
  | {
      readonly kind: 'memory-forget'
      readonly journalId: string
      readonly id: string
      readonly scope: MemoryScope
      readonly scopeId: string
      readonly expectedRevision: string
    }
  | {
      readonly kind: 'memory-restore'
      readonly journalId: string
      readonly record: MemoryRecord
      readonly expectedRevision: string | undefined
    }
  | {
      readonly kind: 'variable-set'
      readonly journalId: string
      readonly scope: VariableScope
      readonly scopeId: string
      readonly name: string
      readonly value: JsonValue
      readonly expectedRevision: string | undefined
    }
  | {
      readonly kind: 'variable-delete'
      readonly journalId: string
      readonly scope: VariableScope
      readonly scopeId: string
      readonly name: string
      readonly expectedRevision: string
    }

export interface JournalApplyResult {
  /** Store operations actually executed (planners skip already-restored targets). */
  readonly applied: number
  /** Non-blocking vector-cache sync failures, one per affected memory. */
  readonly diagnostics: readonly BodyRollbackDiagnostic[]
}

export async function applyJournalWrites(
  deps: BodyWriteRollbackDeps,
  writes: readonly BodyRollbackJournalWrite[],
  direction: JournalDirection,
): Promise<JournalApplyResult> {
  // Undo runs newest-first so overlapping writes land on the oldest before
  // state; replay runs in write order. Each group reads its target revisions
  // right before writing them: an earlier group's undo changes the revision a
  // later group must expect when the same variable/memory is written twice.
  const ordered = direction === 'undo' ? [...writes].reverse() : [...writes]
  const diagnostics: BodyRollbackDiagnostic[] = []
  let applied = 0
  for (const write of ordered) {
    const progress: GroupProgress = { executed: 0 }
    try {
      const operations = await planOperations(deps, write, direction)
      for (const operation of operations) {
        const outcome = await executeOperation(deps, operation, direction)
        progress.executed += 1
        const diagnostic = await syncMemoryVector(deps, outcome, operation.journalId, direction)
        if (diagnostic !== undefined) diagnostics.push(diagnostic)
        applied += 1
      }
    } catch (error) {
      // A multi-operation group (variable_patch names) can fail after some of
      // its operations landed. Replaying the group restores its after state so
      // the caller never leaves a half-undone group behind. A planning failure
      // executed nothing, so compensating it would overwrite the foreign state
      // that caused the conflict.
      const compensation = await compensateGroup(deps, write, direction, progress)
      throw groupFailure(error, write, compensation, progress.executed > 0)
    }
  }
  return { applied, diagnostics }
}

async function planOperations(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackJournalWrite,
  direction: JournalDirection,
): Promise<JournalOperation[]> {
  return write.kind === 'memory'
    ? planMemoryOperations(deps, write, direction)
    : planVariableOperations(deps, write, direction)
}

interface GroupProgress {
  executed: number
}

/** Replay (or undo) one group after part of it was applied in the failing direction. */
async function compensateGroup(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackJournalWrite,
  direction: JournalDirection,
  progress: GroupProgress,
): Promise<CompensationResult> {
  if (progress.executed === 0) return { ok: true, note: '' }
  const opposite: JournalDirection = direction === 'undo' ? 'replay' : 'undo'
  try {
    const operations = await planOperations(deps, write, opposite)
    for (const operation of operations) await executeOperation(deps, operation, opposite)
    return {
      ok: true,
      note: `; the partially applied journal '${write.journalId}' was compensated (${opposite})`,
    }
  } catch (error) {
    log(deps.logger, 'error', 'dsh-soulmojito body rollback: group compensation failed', {
      journalId: write.journalId,
      direction: opposite,
      error: errorMessage(error),
    })
    return { ok: false, note: `; journal '${write.journalId}' was only partially applied and the compensation (${opposite}) failed: ${errorMessage(error)}` }
  }
}

function groupFailure(
  error: unknown,
  write: BodyRollbackJournalWrite,
  compensation: CompensationResult,
  compensated: boolean,
): BodyRollbackError {
  const code: BodyRollbackError['code'] = !compensation.ok
    ? 'body-rollback-partial'
    : error instanceof BodyRollbackError
      ? error.code
      : 'body-rollback-failed'
  return new BodyRollbackError(code, `${errorMessage(error)}${compensation.note}`, {
    ...(error instanceof BodyRollbackError && error.detail !== undefined ? { detail: error.detail } : {}),
    stage: error instanceof BodyRollbackError && error.stage !== undefined ? error.stage : 'journal-rollback',
    ...(error instanceof BodyRollbackError && error.sessionId !== undefined ? { sessionId: error.sessionId } : {}),
    ...(error instanceof BodyRollbackError && error.turn !== undefined ? { turn: error.turn } : {}),
    journalId: error instanceof BodyRollbackError && error.journalId !== undefined ? error.journalId : write.journalId,
    compensated,
    cause: error,
  })
}

/* ------------------------- before-only journal groups ---------------------- */

/**
 * Resolve one before-only journal group against the flat stores.
 *
 * A group is committed when its target no longer holds the before state: the
 * `after` record was lost after the store accepted the write. The actual store
 * state becomes the journaled `after`, so the group is rolled back and can be
 * replayed like a complete pair. A group whose store still holds the before
 * state never committed (`undefined`). When the store state cannot be verified
 * (an old journal without names, or a vanished target), this refuses with
 * `write-journal-unknown` instead of silently skipping.
 */
export async function resolveBeforeOnlyWrite(
  deps: BodyWriteRollbackDeps,
  journalId: string,
  entry: WriteJournalMemoryEntry | WriteJournalVariableEntry,
  agentId: string,
  turn: number,
): Promise<BodyRollbackJournalWrite | undefined> {
  return entry.kind === 'memory'
    ? probeMemoryGroup(deps, journalId, entry, agentId, turn)
    : probeVariableGroup(deps, journalId, entry, agentId, turn)
}

async function probeMemoryGroup(
  deps: BodyWriteRollbackDeps,
  journalId: string,
  entry: WriteJournalMemoryEntry,
  agentId: string,
  turn: number,
): Promise<BodyRollbackMemoryWrite | undefined> {
  const before = requireMemoryBefore(entry, journalId, agentId, turn)
  assertMemoryRecordMatches(before, entry.target, journalId, agentId, turn)
  if (entry.tool === 'memory_write') {
    if (before !== null) {
      throw journalUnsafe(journalId, agentId, turn, 'memory_write must record a null before state')
    }
    const current = await probeMemory(deps, entry.target, journalId, agentId, turn)
    // No record means the create never landed. A live or tombstoned record
    // proves the create did land: the target id is fresh, so only this write can
    // have created it.
    if (current === undefined) return undefined
    return { kind: 'memory', journalId, tool: entry.tool, target: entry.target, before: null, after: current }
  }
  if (before === null) {
    throw journalUnsafe(journalId, agentId, turn, `memory_${entry.tool} requires a before record`)
  }
  const current = await probeMemory(deps, entry.target, journalId, agentId, turn)
  if (current === undefined) {
    throw journalUnsafe(journalId, agentId, turn, `names memory '${entry.target.id}', but the store has no record whose state can be verified`)
  }
  if (current.revision === before.revision) return undefined
  if (entry.tool === 'memory_update' && current.deletedAt !== undefined) {
    throw journalUnsafe(journalId, agentId, turn, `memory_update recorded a live before state for memory '${entry.target.id}', but the store holds a tombstone that the update cannot have produced`)
  }
  if (entry.tool === 'memory_forget' && current.deletedAt === undefined) {
    throw journalUnsafe(journalId, agentId, turn, `memory_forget observed memory '${entry.target.id}' still live with a foreign revision '${current.revision}'`)
  }
  return { kind: 'memory', journalId, tool: entry.tool, target: entry.target, before, after: current }
}

async function probeVariableGroup(
  deps: BodyWriteRollbackDeps,
  journalId: string,
  entry: WriteJournalVariableEntry,
  agentId: string,
  turn: number,
): Promise<BodyRollbackVariableWrite | undefined> {
  const before = requireSnapshotsBefore(entry, journalId, agentId, turn)
  assertSnapshotsMatch(before, entry.target, journalId, agentId, turn)
  if (entry.tool === 'variable_delete' && before === null) {
    throw journalUnsafe(journalId, agentId, turn, 'variable_delete requires a before snapshot')
  }
  const names = probeVariableNames(entry, before, journalId, agentId, turn)
  const beforeByName = new Map((before ?? []).map((snapshot) => [snapshot.name, snapshot]))
  const current = new Map<string, VariableSnapshot>()
  for (const name of names) {
    const snapshot = await probeVariable(deps, entry.target, name, journalId, agentId, turn)
    if (snapshot !== undefined) current.set(name, snapshot)
  }
  if (entry.tool !== 'variable_delete') {
    for (const name of names) {
      if (beforeByName.has(name) && !current.has(name)) {
        throw journalUnsafe(journalId, agentId, turn, `records variable '${name}' before the write, but the store no longer has it, so the before-only state cannot be verified`)
      }
    }
  }
  const committed = names.some((name) => current.get(name)?.revision !== beforeByName.get(name)?.revision)
  if (!committed) return undefined
  if (entry.tool === 'variable_delete') {
    return { kind: 'variable', journalId, tool: entry.tool, target: entry.target, before, after: null }
  }
  return {
    kind: 'variable',
    journalId,
    tool: entry.tool,
    target: entry.target,
    before,
    after: [...current.values()],
  }
}

function probeVariableNames(
  entry: WriteJournalVariableEntry,
  before: readonly VariableSnapshot[] | null,
  journalId: string,
  agentId: string,
  turn: number,
): readonly string[] {
  if (entry.tool === 'variable_patch' && entry.names === undefined) {
    throw journalUnsafe(journalId, agentId, turn, 'has a variable_patch before record without names, so a variable it added cannot be verified')
  }
  const names = new Set<string>(entry.names ?? [])
  for (const snapshot of before ?? []) names.add(snapshot.name)
  if (names.size === 0) {
    throw journalUnsafe(journalId, agentId, turn, 'has a before record without an after record and records no variable names, so its store state cannot be verified')
  }
  return [...names]
}

async function probeMemory(
  deps: BodyWriteRollbackDeps,
  target: WriteJournalMemoryTarget,
  journalId: string,
  agentId: string,
  turn: number,
): Promise<MemoryRecord | undefined> {
  try {
    return await deps.memoryStore.read(target.id, target.scope, target.scopeId, true)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} cannot read memory '${target.id}' to verify the before-only write journal '${journalId}': ${errorMessage(error)}`,
      { detail: 'write-journal-unknown', stage: 'prepare', sessionId: agentId, turn, journalId, cause: error },
    )
  }
}

async function probeVariable(
  deps: BodyWriteRollbackDeps,
  target: WriteJournalVariableTarget,
  name: string,
  journalId: string,
  agentId: string,
  turn: number,
): Promise<VariableSnapshot | undefined> {
  try {
    return await deps.variableStore.get(target.scope, target.scopeId, name)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} cannot read variable '${name}' to verify the before-only write journal '${journalId}': ${errorMessage(error)}`,
      { detail: 'write-journal-unknown', stage: 'prepare', sessionId: agentId, turn, journalId, cause: error },
    )
  }
}

async function planMemoryOperations(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackMemoryWrite,
  direction: JournalDirection,
): Promise<JournalOperation[]> {
  const current = await readMemory(deps, write, direction)
  if (direction === 'undo') {
    if (write.tool === 'memory_write') {
      if (write.after === null) return []
      if (current === undefined || current.deletedAt !== undefined) return []
      if (current.revision !== write.after.revision) {
        throw memoryUndoConflict(write, current, 'memory_write')
      }
      return [{
        kind: 'memory-forget',
        journalId: write.journalId,
        id: write.target.id,
        scope: write.target.scope,
        scopeId: write.target.scopeId,
        expectedRevision: current.revision,
      }]
    }
    if (write.before === null) return []
    // Already undone: the store is back at the journaled before state.
    if (current !== undefined && current.revision === write.before.revision) return []
    if (current === undefined || write.after === null || current.revision !== write.after.revision) {
      // An update/forget undo must not overwrite a state the journal never
      // wrote (a later manual edit, or a lost tombstone).
      throw memoryUndoConflict(write, current, write.tool)
    }
    return [{
      kind: 'memory-restore',
      journalId: write.journalId,
      record: write.before,
      expectedRevision: current.revision,
    }]
  }

  // Replay only reverts a group the rollback actually undid: the store must
  // hold the before state. A group already at its after state needs nothing; a
  // foreign state (a manual edit after the rollback) is left untouched instead
  // of being overwritten by the old turn.
  if (write.tool === 'memory_write') {
    if (write.after === null) return []
    if (current?.revision === write.after.revision) return []
    if (current !== undefined && current.deletedAt === undefined) {
      logSkippedReplay(deps, write, 'memory_write', current.revision)
      return []
    }
    return [{
      kind: 'memory-restore',
      journalId: write.journalId,
      record: write.after,
      expectedRevision: current?.revision,
    }]
  }
  if (write.after === null) {
    // A forget whose tombstone was not journaled can only be replayed over the
    // exact before state; a foreign revision is left for the caller to inspect.
    if (current === undefined || current.deletedAt !== undefined) return []
    if (write.before !== null && current.revision !== write.before.revision) {
      logSkippedReplay(deps, write, 'memory_forget', current.revision)
      return []
    }
    return [{
      kind: 'memory-forget',
      journalId: write.journalId,
      id: write.target.id,
      scope: write.target.scope,
      scopeId: write.target.scopeId,
      expectedRevision: current.revision,
    }]
  }
  if (current === undefined) {
    logSkippedReplay(deps, write, write.tool, undefined)
    return []
  }
  if (current.revision === write.after.revision) return []
  if (write.before === null || current.revision !== write.before.revision) {
    logSkippedReplay(deps, write, write.tool, current.revision)
    return []
  }
  return [{
    kind: 'memory-restore',
    journalId: write.journalId,
    record: write.after,
    expectedRevision: current.revision,
  }]
}

/** Log a replay skipped because the store no longer holds either journal phase. */
function logSkippedReplay(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackJournalWrite,
  tool: string,
  revision: string | undefined,
  name?: string,
): void {
  log(deps.logger, 'warn', 'dsh-soulmojito body rollback: journal replay skipped a foreign state', {
    journalId: write.journalId,
    kind: write.kind,
    tool,
    ...(name === undefined ? {} : { name }),
    target: write.kind === 'memory' ? write.target.id : `${write.target.scope}/${write.target.scopeId}`,
    revision: revision ?? null,
  })
}

async function planVariableOperations(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackVariableWrite,
  direction: JournalDirection,
): Promise<JournalOperation[]> {
  const before = new Map((write.before ?? []).map((snapshot) => [snapshot.name, snapshot]))
  const after = new Map((write.after ?? []).map((snapshot) => [snapshot.name, snapshot]))
  // A delete records `after: null`, so its names come only from the before
  // list; a set/patch names come from the after list and may also appear in the
  // before list. The union keeps every affected name in one undo pass.
  const names = [...new Set([...before.keys(), ...after.keys()])]

  const deletes: JournalOperation[] = []
  const sets: JournalOperation[] = []
  // Deletes first so a set that re-creates a name never races its own delete.
  for (const name of names) {
    const current = await readVariable(deps, write.target, name, direction)
    const target = direction === 'undo' ? before.get(name) : after.get(name)
    if (direction === 'undo') {
      // Already undone: this name is back at the journaled before state.
      if (sameVariableState(current, before.get(name))) continue
      if (!sameVariableState(current, after.get(name))) {
        throw new BodyRollbackError(
          'body-rollback-conflict',
          `body rollback cannot undo ${write.tool} '${name}': the store holds revision ${current?.revision ?? 'no value'}, the journaled after state is ${after.get(name)?.revision ?? 'no value'}`,
          { stage: 'journal-rollback', journalId: write.journalId },
        )
      }
    } else {
      // Replay only reverts a name the rollback actually undid.
      if (sameVariableState(current, after.get(name))) continue
      if (!sameVariableState(current, before.get(name))) {
        logSkippedReplay(deps, write, write.tool, current?.revision, name)
        continue
      }
    }
    if (target === undefined) {
      if (current === undefined) continue
      deletes.push({
        kind: 'variable-delete',
        journalId: write.journalId,
        scope: write.target.scope,
        scopeId: write.target.scopeId,
        name,
        expectedRevision: current.revision,
      })
      continue
    }
    if (current !== undefined && current.revision === target.revision) continue
    sets.push({
      kind: 'variable-set',
      journalId: write.journalId,
      scope: write.target.scope,
      scopeId: write.target.scopeId,
      name,
      value: structuredClone(target.value),
      expectedRevision: current?.revision,
    })
  }
  return [...deletes, ...sets]
}

/** Same presence and the same journaled revision (variables hash their value). */
function sameVariableState(left: VariableSnapshot | undefined, right: VariableSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.revision === right.revision
}

function memoryUndoConflict(
  write: BodyRollbackMemoryWrite,
  current: MemoryRecord | undefined,
  tool: string,
): BodyRollbackError {
  const after = write.after
  const expected = after === null ? 'no reconciled after state' : `the journaled after state is ${after.revision}`
  return new BodyRollbackError(
    'body-rollback-conflict',
    `body rollback cannot undo ${tool} '${write.target.id}': the store holds ${current === undefined ? 'no record' : `revision ${current.revision}`}, ${expected}`,
    { stage: 'journal-rollback', journalId: write.journalId },
  )
}

async function readMemory(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackMemoryWrite,
  direction: JournalDirection,
): Promise<MemoryRecord | undefined> {
  try {
    return await deps.memoryStore.read(
      write.target.id,
      write.target.scope,
      write.target.scopeId,
      true,
    )
  } catch (error) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback cannot read memory '${write.target.id}': ${errorMessage(error)}`,
      { stage: stageOf(direction), journalId: write.journalId, cause: error },
    )
  }
}

async function readVariable(
  deps: BodyWriteRollbackDeps,
  target: WriteJournalVariableTarget,
  name: string,
  direction: JournalDirection,
): Promise<VariableSnapshot | undefined> {
  try {
    return await deps.variableStore.get(target.scope, target.scopeId, name)
  } catch (error) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback cannot read variable '${name}': ${errorMessage(error)}`,
      { stage: stageOf(direction), cause: error },
    )
  }
}

function stageOf(direction: JournalDirection): BodyRollbackStage {
  return direction === 'undo' ? 'journal-rollback' : 'journal-replay'
}

/** What one executed operation changed, enough to reconcile the vector cache. */
type OperationOutcome =
  | { readonly kind: 'memory-record'; readonly record: MemoryRecord }
  | {
      readonly kind: 'memory-forgotten'
      readonly id: string
      readonly scope: MemoryScope
      readonly scopeId: string
    }
  | { readonly kind: 'variable' }

async function executeOperation(
  deps: BodyWriteRollbackDeps,
  operation: JournalOperation,
  direction: JournalDirection,
): Promise<OperationOutcome> {
  const stage: BodyRollbackStage = stageOf(direction)
  try {
    switch (operation.kind) {
      case 'memory-forget': {
        await deps.memoryStore.forget(
          operation.id,
          operation.scope,
          operation.scopeId,
          operation.expectedRevision,
        )
        return {
          kind: 'memory-forgotten',
          id: operation.id,
          scope: operation.scope,
          scopeId: operation.scopeId,
        }
      }
      case 'memory-restore': {
        const record = await deps.memoryStore.restore(operation.record, operation.expectedRevision)
        return { kind: 'memory-record', record }
      }
      case 'variable-set':
        await deps.variableStore.set(
          operation.scope,
          operation.scopeId,
          operation.name,
          operation.value,
          operation.expectedRevision,
        )
        return { kind: 'variable' }
      case 'variable-delete':
        await deps.variableStore.delete(
          operation.scope,
          operation.scopeId,
          operation.name,
          operation.expectedRevision,
        )
        return { kind: 'variable' }
    }
  } catch (error) {
    const subject = operationSubject(operation)
    if (error instanceof MemoryRevisionConflictError || error instanceof VariableRevisionConflictError) {
      throw new BodyRollbackError(
        'body-rollback-conflict',
        `body rollback ${direction} hit a store revision conflict for ${subject} in journal '${operation.journalId}': ${error.message}`,
        { stage, journalId: operation.journalId, cause: error },
      )
    }
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback ${direction} failed for ${subject} in journal '${operation.journalId}': ${errorMessage(error)}`,
      { stage, journalId: operation.journalId, cause: error },
    )
  }
}

/**
 * Reconcile the vector cache for one executed memory operation.
 *
 * A success returns `undefined`. A failure returns a `vector-sync-failed`
 * diagnostic and logs a warning instead of throwing, so the remaining journal
 * entries still roll back (proposal 0022 §8). The tombstone of a forget is read
 * back from the store because `forget` returns no record.
 */
async function syncMemoryVector(
  deps: BodyWriteRollbackDeps,
  outcome: OperationOutcome,
  journalId: string,
  direction: JournalDirection,
): Promise<BodyRollbackDiagnostic | undefined> {
  if (outcome.kind === 'variable' || deps.memoryVectors === undefined) return undefined
  const memoryId = outcome.kind === 'memory-record' ? outcome.record.id : outcome.id
  try {
    const record = outcome.kind === 'memory-record'
      ? outcome.record
      : await deps.memoryStore.read(outcome.id, outcome.scope, outcome.scopeId, true)
    if (record === undefined) {
      throw new Error(`memory '${memoryId}' is missing after forget, so its vector cannot be deleted`)
    }
    await deps.memoryVectors.sync(record)
    return undefined
  } catch (error) {
    const message = `memory vector sync failed for memory '${memoryId}' after journal '${journalId}' (${direction}): ${errorMessage(error)}`
    log(deps.logger, 'warn', 'dsh-soulmojito body rollback: memory vector sync failed', {
      journalId,
      memoryId,
      direction,
      error: errorMessage(error),
    })
    return { code: 'vector-sync-failed', message, memoryId }
  }
}

function operationSubject(operation: JournalOperation): string {
  switch (operation.kind) {
    case 'memory-forget':
      return `memory '${operation.id}'`
    case 'memory-restore':
      return `memory '${operation.record.id}'`
    case 'variable-set':
    case 'variable-delete':
      return `variable '${operation.name}'`
  }
}

/* -------------------------------- compensation ----------------------------- */

export interface CompensationResult {
  readonly ok: boolean
  readonly note: string
}

export async function compensateJournal(
  deps: BodyWriteRollbackDeps,
  writes: readonly BodyRollbackJournalWrite[],
  direction: JournalDirection,
): Promise<CompensationResult> {
  if (writes.length === 0) return { ok: true, note: '' }
  try {
    await applyJournalWrites(deps, writes, direction)
    return {
      ok: true,
      note: direction === 'replay'
        ? '; the flat-store rollback was replayed so the stores match the unsaved chat'
        : '; the flat-store replay was rolled back so the stores match the rolled-back chat',
    }
  } catch (error) {
    const failure = `body rollback compensation (${direction}) failed: ${errorMessage(error)}`
    log(deps.logger, 'error', 'dsh-soulmojito body rollback: compensation failed', {
      direction,
      error: errorMessage(error),
    })
    return { ok: false, note: `; ${failure}` }
  }
}
