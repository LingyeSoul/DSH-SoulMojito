/**
 * AgentTavern body write rollback: flat-store journal operations.
 *
 * This shard plans and executes memory/variable journal entries in one
 * direction. It owns only `MemoryStore` / `VariableStore` writes: undo restores
 * the before state, replay restores the after state. It never reads the chat,
 * the MVU receipts or the session log.
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
  type BodyRollbackJournalWrite,
  type BodyRollbackMemoryWrite,
  type BodyRollbackStage,
  type BodyRollbackVariableWrite,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'
import type { WriteJournalVariableTarget } from './write-journal.js'

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
  let applied = 0
  for (const write of ordered) {
    const operations = write.kind === 'memory'
      ? await planMemoryOperations(deps, write, direction)
      : await planVariableOperations(deps, write, direction)
    for (const operation of operations) {
      await executeOperation(deps, operation, direction)
      applied += 1
    }
  }
  return { applied }
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
        throw new BodyRollbackError(
          'body-rollback-conflict',
          `body rollback cannot undo memory_write '${write.target.id}': the store holds revision ${current.revision}, the journaled after state is ${write.after.revision}`,
          { stage: 'journal-rollback', journalId: write.journalId },
        )
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
    if (current !== undefined && current.revision === write.before.revision) return []
    return [{
      kind: 'memory-restore',
      journalId: write.journalId,
      record: write.before,
      expectedRevision: current?.revision,
    }]
  }

  if (write.tool === 'memory_forget') {
    if (write.after !== null) {
      if (current?.revision === write.after.revision) return []
      return [{
        kind: 'memory-restore',
        journalId: write.journalId,
        record: write.after,
        expectedRevision: current?.revision,
      }]
    }
    if (current === undefined || current.deletedAt !== undefined) return []
    return [{
      kind: 'memory-forget',
      journalId: write.journalId,
      id: write.target.id,
      scope: write.target.scope,
      scopeId: write.target.scopeId,
      expectedRevision: current.revision,
    }]
  }

  if (write.after === null) return []
  if (current?.revision === write.after.revision) return []
  return [{
    kind: 'memory-restore',
    journalId: write.journalId,
    record: write.after,
    expectedRevision: current?.revision,
  }]
}

async function planVariableOperations(
  deps: BodyWriteRollbackDeps,
  write: BodyRollbackVariableWrite,
  direction: JournalDirection,
): Promise<JournalOperation[]> {
  const desired = new Map(
    (direction === 'undo'
      ? write.before ?? []
      : write.after ?? []
    ).map((snapshot) => [snapshot.name, snapshot]),
  )
  // A delete records `after: null`, so its names come from the before list; a
  // set/patch names always come from the after list.
  const names = (write.after ?? write.before ?? []).map((snapshot) => snapshot.name)

  const deletes: JournalOperation[] = []
  const sets: JournalOperation[] = []
  // Deletes first so a set that re-creates a name never races its own delete.
  for (const name of new Set(names)) {
    const current = await readVariable(deps, write.target, name, direction)
    const target = desired.get(name)
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

async function executeOperation(
  deps: BodyWriteRollbackDeps,
  operation: JournalOperation,
  direction: JournalDirection,
): Promise<void> {
  const stage: BodyRollbackStage = stageOf(direction)
  try {
    switch (operation.kind) {
      case 'memory-forget':
        await deps.memoryStore.forget(
          operation.id,
          operation.scope,
          operation.scopeId,
          operation.expectedRevision,
        )
        return
      case 'memory-restore':
        await deps.memoryStore.restore(operation.record, operation.expectedRevision)
        return
      case 'variable-set':
        await deps.variableStore.set(
          operation.scope,
          operation.scopeId,
          operation.name,
          operation.value,
          operation.expectedRevision,
        )
        return
      case 'variable-delete':
        await deps.variableStore.delete(
          operation.scope,
          operation.scopeId,
          operation.name,
          operation.expectedRevision,
        )
        return
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
