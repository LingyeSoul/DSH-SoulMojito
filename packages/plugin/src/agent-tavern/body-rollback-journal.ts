/**
 * AgentTavern body write rollback: write journal reads and new-turn undo.
 *
 * This shard owns the session-log side: turn tool calls, journal folding into
 * committed memory/variable writes, journal coverage checks, diagnostics and
 * the `rollbackTurnWrites` implementation. It delegates journal mutations to
 * `body-rollback-writes.ts` and settle receipts to
 * `body-rollback-receipts.ts`, so the flat `VariableStore` and
 * `mvu.receipts` move in one direction. Settle-intent startup recovery lives in
 * `body-settle-intent.ts` and is re-exported here for existing callers.
 */

import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import { ChatRevisionConflictError } from '../../../tavern-store/src/index.js'
import { readMvuReceipts, type MvuReceipt } from '../mvu.js'
import {
  MEMORY_WRITE_JOURNAL_TOOLS,
  VARIABLE_WRITE_JOURNAL_TOOLS,
  journalUnsafe,
  memoryWriteOf,
  readWriteJournal,
  resolveWriteJournalWriter,
  variableWriteOf,
  type WriteJournalEntry,
  type WriteJournalMemoryEntry,
  type WriteJournalMemoryTool,
  type WriteJournalVariableEntry,
  type WriteJournalVariableTool,
} from './write-journal.js'
import {
  BodyRollbackError,
  errorMessage,
  isRecord,
  log,
  readAgentTavernBinding,
  requireNonEmptyString,
  requireNonNegativeInteger,
  type BodyNewTurnRollback,
  type BodyRollbackBinding,
  type BodyRollbackDiagnostic,
  type BodyRollbackErrorCode,
  type BodyRollbackJournalWrite,
  type BodyRollbackLogger,
  type BodyTurnRollbackFailure,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'

export { recoverOpenSettleIntents } from './body-settle-intent.js'
export type { SettleIntentRecovery, SettleIntentRecoveryDeps } from './body-settle-intent.js'
import { applyJournalWrites, resolveBeforeOnlyWrite, type CompensationResult } from './body-rollback-writes.js'
import { applyReceiptRollback } from './body-rollback-receipts.js'

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

/** A before-only group whose store effect must be verified before skipping it. */
interface PendingJournalGroup {
  readonly journalId: string
  readonly entry: WriteJournalMemoryEntry | WriteJournalVariableEntry
}

type DraftJournalGroup =
  | { readonly state: 'write'; readonly write: BodyRollbackJournalWrite }
  | { readonly state: 'pending'; readonly pending: PendingJournalGroup }
  | { readonly state: 'uncommitted'; readonly journalId: string }

interface DraftJournalBuild {
  readonly groups: readonly DraftJournalGroup[]
  readonly tools: ReadonlySet<string>
}

function buildJournalGroups(events: readonly unknown[], agentId: string, turn: number): DraftJournalBuild {
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

  const draft: DraftJournalGroup[] = []
  const tools = new Set<string>()
  for (const [journalId, group] of groups) {
    const kind = group[0]?.kind
    if (kind === undefined) continue
    if (group.some((entry) => entry.kind !== kind)) {
      throw journalUnsafe(journalId, agentId, turn, 'mixes memory and variable records')
    }
    for (const entry of group) tools.add(entry.tool)
    const noops = group.filter((entry) => entry.phase === 'noop')
    const failed = group.filter((entry) => entry.phase === 'failed')
    const before = group.filter((entry) => entry.phase === 'before')
    const after = group.filter((entry) => entry.phase === 'after')
    if (noops.length > 0) {
      if (noops.length > 1 || before.length > 0 || after.length > 0 || failed.length > 0) {
        throw journalUnsafe(journalId, agentId, turn, 'mixes a noop record with phase records')
      }
      continue
    }
    if (failed.length > 0) {
      // A terminal `failed` record proves the store call itself rejected the
      // write, so the group can never have committed. It is reported
      // uncommitted without probing: the store may hold a concurrent writer's
      // revision, and a probe would attribute that foreign state to this
      // journal and roll it back.
      if (failed.length > 1 || after.length > 0) {
        throw journalUnsafe(journalId, agentId, turn, 'mixes a failed record with other phase records')
      }
      if (before.length > 1) {
        throw journalUnsafe(journalId, agentId, turn, 'has duplicate phase records')
      }
      if (before.length === 0) {
        throw journalUnsafe(journalId, agentId, turn, 'has a failed record without a before record')
      }
      draft.push({ state: 'uncommitted', journalId })
      continue
    }
    if (before.length > 1 || after.length > 1) {
      throw journalUnsafe(journalId, agentId, turn, 'has duplicate phase records')
    }
    if (after.length === 0) {
      // The `after` append can fail (or the process can die) after the store
      // accepted the write. The group is resolved against the store instead of
      // being assumed untouched: see `resolveJournalGroups`.
      if (before.length === 0) {
        throw journalUnsafe(journalId, agentId, turn, 'has neither a before, after nor noop record')
      }
      draft.push({ state: 'pending', pending: { journalId, entry: before[0]! } })
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
    draft.push({
      state: 'write',
      write: beforeEntry.kind === 'memory'
        ? memoryWriteOf(beforeEntry, afterEntry as WriteJournalMemoryEntry, journalId, agentId, turn)
        : variableWriteOf(beforeEntry, afterEntry as WriteJournalVariableEntry, journalId, agentId, turn),
    })
  }
  return { groups: draft, tools }
}

/**
 * Verify before-only groups against the store (proposal 0022 §3).
 *
 * A group terminated by a `failed` record never reaches the store probe: the
 * store call itself rejected the write, so it is reported uncommitted however
 * the store looks. A before-only group is committed when its target no longer
 * holds the before state: the `after` record was lost after the store accepted
 * the write. The actual store state becomes the journaled `after`, so the group
 * is rolled back and can be replayed like a complete pair. A group whose store
 * still holds the before state never committed and is reported as uncommitted.
 * When the store state cannot be verified (an old journal without names, a
 * vanished target, a store read failure, or a current state the journaled
 * payload cannot explain), this refuses with `write-journal-unknown` instead of
 * silently skipping.
 */
async function resolveJournalGroups(
  deps: BodyWriteRollbackDeps,
  draft: DraftJournalBuild,
  agentId: string,
  turn: number,
): Promise<JournalBuild> {
  const writes: BodyRollbackJournalWrite[] = []
  const uncommitted: string[] = []
  for (const group of draft.groups) {
    if (group.state === 'write') {
      writes.push(group.write)
      continue
    }
    if (group.state === 'uncommitted') {
      uncommitted.push(group.journalId)
      continue
    }
    const { journalId, entry } = group.pending
    const resolved = await resolveBeforeOnlyWrite(deps, journalId, entry, agentId, turn)
    if (resolved === undefined) uncommitted.push(journalId)
    else writes.push(resolved)
  }
  return { writes, uncommitted, tools: draft.tools }
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
  const draft = buildJournalGroups(events, agentId, turn)
  return {
    journal: await resolveJournalGroups(deps, draft, agentId, turn),
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
  memoryVectorsInjected: boolean,
): BodyRollbackDiagnostic[] {
  const diagnostics: BodyRollbackDiagnostic[] = []
  if (journal.uncommitted.length > 0) {
    diagnostics.push({
      code: 'journal-uncommitted-skipped',
      message: `${journal.uncommitted.length} write journal group(s) have no after record and never committed (their store call failed or the store still holds the before state), so they were treated as uncommitted: ${journal.uncommitted.join(', ')}`,
    })
  }
  if (!memoryVectorsInjected && journal.writes.some((write) => write.kind === 'memory')) {
    const message = 'memory vectors are not restored by the rollback port (memoryVectors is not injected); stale vectors are left for lazy re-embedding'
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
 * Undo one turn's committed writes from its own journal and settle receipts
 * (proposal 0022 §10.3).
 *
 * The new turn may have written memories, flat variables and a settle receipt
 * before it failed or was cancelled. `restore(plan)` only knows the old turn,
 * so the runtime calls this for the new turn before restoring the old plan.
 * Journal entries are unwound first; settle receipts are matched afterwards by
 * their floor (`extra.agentTavern.turn === turn`, or the next floor index) and
 * persisted with `undoneAt`. Body receipts and the old plan stay untouched.
 *
 * A before-only journal group is verified against the store: when the store
 * still holds the before state it is reported in `skippedUncommitted`; when the
 * store already holds a committed write it is undone like a complete pair.
 *
 * Idempotency is state-based: journal planners skip a target whose current
 * revision already matches the before state, and already-undone receipts are
 * never selected again, so a repeated call reports `undone: 0` and
 * `receiptsUndone: 0` without writing any store.
 */
export async function rollbackTurnWritesImpl(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
): Promise<BodyNewTurnRollback> {
  requireNonEmptyString(agentId, 'agentId')
  requireNonNegativeInteger(turn, 'turn')

  const events = await readEvents(deps, agentId, turn)
  const journal = await resolveJournalGroups(deps, buildJournalGroups(events, agentId, turn), agentId, turn)
  const failures: BodyTurnRollbackFailure[] = []
  const diagnostics: BodyRollbackDiagnostic[] = []
  let undone = 0

  // Newest-first across journal groups; each group's planner reads the target
  // revision at this moment, so repeated writes to the same key unwind safely.
  const ordered = [...journal.writes].reverse()
  for (const write of ordered) {
    try {
      const applied = await applyJournalWrites(deps, [write], 'undo')
      diagnostics.push(...applied.diagnostics)
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

  const receiptsUndone = await rollbackTurnSettleReceipts(deps, agentId, turn, failures)

  const result: BodyNewTurnRollback = {
    sessionId: agentId,
    turn,
    undone,
    receiptsUndone,
    skippedUncommitted: [...journal.uncommitted],
    failures,
    diagnostics,
  }
  log(deps.logger, 'info', 'dsh-soulmojito body rollback: rolled back new-turn writes', {
    sessionId: agentId,
    turn,
    undone,
    receiptsUndone,
    skippedUncommitted: result.skippedUncommitted.length,
    failures: failures.length,
    vectorSyncFailures: diagnostics.length,
  })
  return result
}

/* ------------------------- new-turn settle receipts ------------------------ */

/**
 * Undo the settle receipts that belong to one turn and persist `undoneAt`.
 *
 * A settle receipt keeps the floor index in `turnKey` (proposal 0022 §4). The
 * floor belongs to this turn when the projected message there carries
 * `extra.agentTavern.turn === turn`, or when the index equals the current
 * message count (settle runs before the assistant floor is projected). Only
 * receipts still awaiting undo are selected. When nothing matches, the chat is
 * read but neither the flat store nor the chat is written.
 *
 * A save failure replays the just-undone receipts so the flat store matches
 * the still-active receipts in the persisted chat; the failure is reported
 * either way instead of being swallowed.
 */
async function rollbackTurnSettleReceipts(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
  failures: BodyTurnRollbackFailure[],
): Promise<number> {
  let binding: BodyRollbackBinding
  try {
    binding = await readAgentTavernBinding(deps.store, agentId)
  } catch (error) {
    recordSettleFailure(deps, failures, agentId, turn, [], settleRollbackError(error, agentId, turn))
    return 0
  }
  let snapshot: { readonly chat: ChatLogIR; readonly revision: string } | undefined
  try {
    snapshot = await deps.store.getChatSnapshot(binding.character, binding.chatId)
  } catch (error) {
    recordSettleFailure(deps, failures, agentId, turn, [], error instanceof BodyRollbackError
      ? error
      : new BodyRollbackError(
          'body-state-unsafe',
          `body rollback for session '${agentId}' turn ${turn} cannot read chat '${binding.chatId}': ${errorMessage(error)}`,
          { detail: 'chat-unreadable', stage: 'mvu-undo', sessionId: agentId, turn, cause: error },
        ))
    return 0
  }
  if (snapshot === undefined) {
    recordSettleFailure(deps, failures, agentId, turn, [], new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} cannot read the chat that owns its settle receipts`,
      { detail: 'chat-unreadable', stage: 'mvu-undo', sessionId: agentId, turn },
    ))
    return 0
  }

  const chat = snapshot.chat
  const receipts = settleReceiptsForTurn(chat, turn)
  if (receipts.length === 0) return 0

  let undone: number
  try {
    undone = (await applyReceiptRollback(deps, chat, receipts, 'undo', binding)).settleReceipts
  } catch (error) {
    recordSettleFailure(deps, failures, agentId, turn, receipts, settleRollbackError(error, agentId, turn))
    return 0
  }
  if (undone === 0) return 0

  try {
    await deps.store.saveChat(binding.character, binding.chatId, chat, snapshot.revision)
  } catch (error) {
    const compensation = await compensateSettleReceipts(deps, chat, receipts, undone, binding)
    const code: BodyRollbackErrorCode = !compensation.ok
      ? 'body-rollback-partial'
      : error instanceof ChatRevisionConflictError
        ? 'body-rollback-conflict'
        : 'body-rollback-save-failed'
    recordSettleFailure(deps, failures, agentId, turn, receipts, new BodyRollbackError(
      code,
      `body rollback for session '${agentId}' turn ${turn} could not save the chat after undoing its settle receipts: ${errorMessage(error)}${compensation.note}`,
      { stage: 'chat-save', sessionId: agentId, turn, cause: error },
    ))
    return 0
  }

  log(deps.logger, 'info', 'dsh-soulmojito body rollback: undid new-turn settle receipts', {
    sessionId: agentId,
    turn,
    receipts: undone,
    floors: receipts.map((receipt) => receipt.turnKey),
  })
  return undone
}

interface SettleCompensation {
  readonly ok: boolean
  readonly note: string
}

/** Replay the undone settle receipts after the chat save failed. */
async function compensateSettleReceipts(
  deps: BodyWriteRollbackDeps,
  chat: ChatLogIR,
  receipts: readonly MvuReceipt[],
  undone: number,
  binding: BodyRollbackBinding,
): Promise<SettleCompensation> {
  try {
    const applied = await applyReceiptRollback(deps, chat, receipts, 'redo', binding)
    if (applied.settleReceipts === undone) {
      return { ok: true, note: '; the flat-store undo was replayed because the chat could not be saved' }
    }
    return {
      ok: false,
      note: `; the flat-store undo was only replayed for ${applied.settleReceipts} of ${undone} receipt(s)`,
    }
  } catch (error) {
    log(deps.logger, 'error', 'dsh-soulmojito body rollback: settle compensation failed', {
      sessionId: binding.chatId,
      error: errorMessage(error),
    })
    return { ok: false, note: `; the flat-store undo could not be replayed: ${errorMessage(error)}` }
  }
}

/**
 * Select the un-undone settle receipts whose floor belongs to `turn`.
 *
 * `body:<messageId>` receipts are body receipts and are never selected here.
 */
function settleReceiptsForTurn(chat: ChatLogIR, turn: number): MvuReceipt[] {
  return readMvuReceipts(chat).filter((receipt) => {
    if (receipt.undoneAt !== undefined) return false
    if (!/^\d+$/.test(receipt.turnKey)) return false
    const floor = Number(receipt.turnKey)
    if (!Number.isSafeInteger(floor)) return false
    if (floor === chat.messages.length) return true
    return messageTurnNumber(chat.messages[floor]) === turn
  })
}

function messageTurnNumber(message: ChatLogIR['messages'][number] | undefined): number | undefined {
  const extra = message?.extra
  const tavern = isRecord(extra) ? extra['agentTavern'] : undefined
  if (!isRecord(tavern)) return undefined
  const turn = tavern['turn']
  return typeof turn === 'number' && Number.isSafeInteger(turn) ? turn : undefined
}

function settleRollbackError(error: unknown, agentId: string, turn: number): BodyRollbackError {
  if (error instanceof BodyRollbackError) return error
  return new BodyRollbackError(
    error instanceof ChatRevisionConflictError ? 'body-rollback-conflict' : 'body-rollback-failed',
    `body rollback for session '${agentId}' turn ${turn} cannot undo its settle receipts: ${errorMessage(error)}`,
    { stage: 'mvu-undo', sessionId: agentId, turn, cause: error },
  )
}

function recordSettleFailure(
  deps: BodyWriteRollbackDeps,
  failures: BodyTurnRollbackFailure[],
  agentId: string,
  turn: number,
  receipts: readonly MvuReceipt[],
  error: BodyRollbackError,
): void {
  const floors = receipts.length === 0
    ? 'none located'
    : [...new Set(receipts.map((receipt) => receipt.turnKey))].join(', ')
  const failure: BodyTurnRollbackFailure = {
    journalId: `settle-receipts:${receipts.length === 0 ? String(turn) : floors}`,
    kind: 'variable',
    tool: 'tavern_variable_settle',
    code: error.code,
    message: `new-turn settle receipt rollback for session '${agentId}' turn ${turn} failed at floor(s) ${floors}: ${error.message}`,
  }
  failures.push(failure)
  log(deps.logger, 'warn', 'dsh-soulmojito body rollback: new-turn settle receipt undo failed', {
    sessionId: agentId,
    turn,
    receiptFloors: floors,
    code: failure.code,
    error: failure.message,
  })
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

const MEMORY_TOOL_SET = new Set<string>(MEMORY_WRITE_JOURNAL_TOOLS)
const VARIABLE_TOOL_SET = new Set<string>(VARIABLE_WRITE_JOURNAL_TOOLS)
