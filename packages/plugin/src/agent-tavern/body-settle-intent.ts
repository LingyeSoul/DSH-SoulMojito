/**
 * AgentTavern settle-intent startup recovery.
 *
 * A settle batch writes the flat `VariableStore` before its chat receipt is
 * saved, so a crash inside that window can leave flat values no receipt covers.
 * `tavern_variable_settle` brackets the window with a durable `open` intent
 * (undo data), a `decide` record (the commit decision plus the exact receipt it
 * was about to save) and a closure (`commit`, `abort` or `recovered`). This
 * shard owns both sides of that contract: the startup pass that resolves
 * intents a crash left open, and the flat rollback a live tool reuses when it
 * abandons a batch.
 *
 * A decision is final: whenever one exists, recovery re-appends the decided
 * receipt to the current chat snapshot and saves it with the current revision
 * instead of asking whether the 20-entry receipt ring still holds the original.
 * Only an intent without a decision falls back to restoring its `before` values.
 * Every decided intent recovery commits also emits its `<tavern>/mvu/audit.jsonl`
 * line through an injected audit sink, so a crash before the tool's own audit
 * append leaves no silent hole; the sink deduplicates by `opId`.
 *
 * Intent parsing and folding live with the record vocabulary in
 * `settle-intent-record.ts`; `foldSettleIntents` is re-exported here for
 * recovery callers.
 */

import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import { appendMvuReceipt, readMvuReceipts, type MvuReceipt } from '../mvu.js'
import {
  BodyRollbackError,
  errorMessage,
  log,
  type BodyRollbackLogger,
  type BodyRollbackStore,
  type BodyRollbackVariableStore,
} from './body-rollback-support.js'
import {
  appendSettleIntentWith,
  type SettleIntentDecideEntry,
  type SettleIntentItem,
  type SettleIntentOpenEntry,
} from './settle-intent-record.js'
import type {
  WriteJournalRecordWriter,
  WriteJournalSession,
} from './write-journal.js'

export { foldSettleIntents } from './settle-intent-record.js'
export type { SettleIntentOpenEntry } from './settle-intent-record.js'
export type { WriteJournalSession } from './write-journal.js'

/* --------------------------- settle intent recovery ------------------------ */

/** One audit change in the shape `<tavern>/mvu/audit.jsonl` stores. */
export interface SettleAuditChange {
  readonly name: string
  readonly reason?: string
  readonly before?: unknown
  readonly after?: unknown
}

/**
 * Audit line startup recovery writes for a decided settle intent.
 *
 * It mirrors `MvuAuditRecord` without importing the projector runtime: the
 * filesystem-backed deduplicating sink stays in `body-recovery.ts`, so this
 * shard keeps its "stores and records only" boundary.
 */
export interface SettleRecoveryAuditRecord {
  readonly at: string
  readonly sessionId: string
  readonly character: string
  readonly chatId: string
  readonly turnKey: string
  readonly status: string
  readonly changes: SettleAuditChange[]
  readonly failures: string[]
  readonly opId: string
  readonly recovered: true
}

/** Map a settle receipt's changes to the audit file's record shape. */
export function settleAuditChanges(receipt: MvuReceipt): SettleAuditChange[] {
  return receipt.changes.map((change) => ({
    name: change.name,
    ...(change.reason === undefined ? {} : { reason: change.reason }),
    ...('before' in change ? { before: change.before } : {}),
    ...('after' in change ? { after: change.after } : {}),
  }))
}

/** Stores one startup settle-intent pass reads and restores. */
export interface SettleIntentRecoveryDeps {
  readonly store: BodyRollbackStore
  readonly variableStore: BodyRollbackVariableStore
  readonly logger?: BodyRollbackLogger
  /**
   * Deduplicating audit sink for a decided intent's recovered line. Omitted by
   * callers that run without the Tavern audit file; `body-recovery.ts` wires
   * the append that skips an `opId` already present.
   */
  readonly auditReceipt?: (record: SettleRecoveryAuditRecord) => Promise<void>
}

/** Result of one startup pass over unclosed settle intents. */
export interface SettleIntentRecovery {
  readonly restored: number
  readonly committed: number
  /** Committed intents whose decision receipt had to be appended again. */
  readonly replayed?: number
  readonly failed: number
  readonly failures: readonly string[]
}

/**
 * Resolve settle intents a crash left open between a flat write and its receipt.
 *
 * For each intent, in log order:
 *
 * - a stored receipt carrying the same `opId` proves the save; only `commit` is
 *   appended (an undone receipt still proves the save happened, so replay never
 *   resurrects an undone settlement), then the recovered audit line is emitted;
 * - otherwise a `decide` record wins: its receipt is appended to the current
 *   chat snapshot and saved with the current revision, then `commit` and the
 *   recovered audit line are appended. A failed save keeps the intent and never
 *   touches the flat writes (the decision is already a commit);
 * - otherwise an intent written before `receiptOpId` existed may still match a
 *   legacy receipt (no `opId`) by `turnKey` + `receiptAt`;
 * - otherwise every merged open/extend item is restored to its `before` value
 *   (deleted when absent) with the current revision as CAS, newest first, so a
 *   name written by several phases returns to its earliest `before`, and the
 *   intent closes as `recovered`.
 *
 * A failure is collected per intent so the caller gets a complete diagnostic
 * instead of only the first store error. An audit sink failure is logged as a
 * non-fatal `stage: 'audit'` warning: the receipt, save and commit are already
 * durable and the intent stays closed.
 */
export async function recoverOpenSettleIntents(
  deps: SettleIntentRecoveryDeps,
  agentId: string,
  session: WriteJournalSession,
  appendRecord: WriteJournalRecordWriter | undefined,
  intents: readonly SettleIntentOpenEntry[],
): Promise<SettleIntentRecovery> {
  if (intents.length === 0) return { restored: 0, committed: 0, replayed: 0, failed: 0, failures: [] }
  if (appendRecord === undefined) {
    return { restored: 0, committed: 0, replayed: 0, failed: intents.length, failures: intents.map((intent) => `${intent.opId}: no plugin-record writer`) }
  }
  let restored = 0
  let committed = 0
  let replayed = 0
  const failures: string[] = []
  for (const intent of intents) {
    try {
      const snapshot = await readSettleSnapshot(deps, intent)
      const stored = storedSettleReceipt(snapshot.chat, intent)
      if (stored !== undefined) {
        closeSettleIntent(appendRecord, session, intent, 'commit', 'receipt persisted before the intent closed')
        committed += 1
        await auditSettleReceipt(deps, intent, stored)
        continue
      }
      if (intent.decision !== undefined) {
        await replaySettleDecision(deps, intent, intent.decision, snapshot)
        closeSettleIntent(appendRecord, session, intent, 'commit', 'commit decision replayed before the intent closed')
        committed += 1
        replayed += 1
        await auditSettleReceipt(deps, intent, intent.decision.receipt)
        continue
      }
      if (legacySettleReceipt(snapshot.chat, intent) !== undefined) {
        closeSettleIntent(appendRecord, session, intent, 'commit', 'legacy receipt matched before the intent closed')
        committed += 1
        continue
      }
      await restoreSettleIntentBefore(deps, intent)
      closeSettleIntent(appendRecord, session, intent, 'recovered', 'restored before values')
      restored += 1
    } catch (error) {
      const message = errorMessage(error)
      failures.push(`${intent.opId}: ${message}`)
      log(deps.logger, 'warn', 'dsh-soulmojito body recovery: settle intent recovery failed', {
        agentId,
        opId: intent.opId,
        phase: intent.decision === undefined ? 'restore' : 'commit-replay',
        scopeId: intent.scopeId,
        error: message,
      })
    }
  }
  return { restored, committed, replayed, failed: failures.length, failures }
}

/* ------------------------------- chat access ------------------------------- */

/** Chat snapshot one recovery step reads and rewrites. */
interface SettleChatSnapshot {
  readonly chat: ChatLogIR
  readonly revision: string
}

async function readSettleSnapshot(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
): Promise<SettleChatSnapshot> {
  let snapshot: SettleChatSnapshot | undefined
  try {
    snapshot = await deps.store.getChatSnapshot(intent.character, intent.scopeId)
  } catch (cause) { throw settleChatError(intent, cause) }
  if (snapshot === undefined) throw settleChatError(intent, undefined)
  return snapshot
}

function settleChatError(intent: SettleIntentOpenEntry, cause: unknown): BodyRollbackError {
  const suffix = cause === undefined ? '' : `: ${errorMessage(cause)}`
  return new BodyRollbackError(
    'body-state-unsafe',
    `settle intent '${intent.opId}' cannot read chat '${intent.scopeId}'${suffix}`,
    { detail: 'chat-unreadable', stage: 'restore', ...(cause === undefined ? {} : { cause }) },
  )
}

/**
 * The chat's own receipt of this batch, when present.
 *
 * Identity only: `receipt.opId` must equal the intent's `opId`, so another
 * settle that shares the millisecond and floor can never vouch for this batch.
 * An undone receipt still proves the save happened (the undo is a later user
 * action), so the check does not filter `undoneAt`.
 */
function storedSettleReceipt(chat: ChatLogIR, intent: SettleIntentOpenEntry): MvuReceipt | undefined {
  return readMvuReceipts(chat).find((receipt) => receipt.opId === intent.opId)
}

/**
 * Legacy receipt of this batch, written before receipts carried `opId`.
 *
 * Only an intent written before `receiptOpId` existed may use this heuristic:
 * an intent that promised an exact receipt must never accept a foreign receipt
 * at the same millisecond and floor. An undone legacy receipt does not count.
 */
function legacySettleReceipt(chat: ChatLogIR, intent: SettleIntentOpenEntry): MvuReceipt | undefined {
  if (intent.receiptOpId === true) return undefined
  return readMvuReceipts(chat).find((receipt) => receipt.undoneAt === undefined
    && receipt.opId === undefined
    && receipt.turnKey === intent.turnKey
    && receipt.at >= intent.receiptAt)
}

/**
 * Persist the decided receipt into the live chat snapshot.
 *
 * The decision was written before the original `saveChat`, so its receipt is
 * authoritative. Appending it to the current snapshot and saving with the
 * current revision finishes the commit the crash interrupted; a save failure
 * stays a typed error so the intent survives for the next startup and the flat
 * writes are never rolled back.
 */
async function replaySettleDecision(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
  decision: SettleIntentDecideEntry,
  snapshot: SettleChatSnapshot,
): Promise<void> {
  appendMvuReceipt(snapshot.chat, decision.receipt)
  try {
    await deps.store.saveChat(intent.character, intent.scopeId, snapshot.chat, snapshot.revision)
  } catch (cause) {
    throw new BodyRollbackError(
      'body-rollback-save-failed',
      `settle decision '${intent.opId}' cannot save its receipt into chat '${intent.scopeId}': ${errorMessage(cause)}`,
      { stage: 'chat-save', sessionId: intent.sessionId, cause },
    )
  }
}

/**
 * Append the recovered audit line for a decided intent.
 *
 * Called after the commit marker lands, so an audit failure can never reopen
 * the intent or undo the receipt/save: it only logs the missing line with the
 * stage and op id. The injected sink owns `opId` deduplication across startups.
 */
async function auditSettleReceipt(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
  receipt: MvuReceipt,
): Promise<void> {
  if (deps.auditReceipt === undefined) return
  try {
    await deps.auditReceipt({
      at: receipt.at,
      sessionId: intent.sessionId,
      character: intent.character,
      chatId: intent.scopeId,
      turnKey: receipt.turnKey,
      status: receipt.status,
      changes: settleAuditChanges(receipt),
      failures: [...receipt.failures],
      opId: intent.opId,
      recovered: true,
    })
  } catch (error) {
    log(deps.logger, 'warn', 'dsh-soulmojito body recovery: settle audit append failed', {
      stage: 'audit',
      opId: intent.opId,
      error: errorMessage(error),
    })
  }
}

/* --------------------------------- undo ------------------------------------ */

/**
 * Put flat entries back to their recorded `before` values, newest first.
 *
 * Each write takes the value's current revision as CAS, so a concurrent write
 * fails instead of being overwritten. An item whose `before` is absent is
 * deleted when present. Shared by startup recovery and the live tool's abort
 * path so both undo a batch the same way.
 */
export async function restoreSettleIntentItems(
  variableStore: BodyRollbackVariableStore,
  scopeId: string,
  items: readonly SettleIntentItem[],
): Promise<void> {
  for (const item of [...items].reverse()) {
    const current = await variableStore.get('chat', scopeId, item.name)
    if (item.before !== undefined) {
      await variableStore.set('chat', scopeId, item.name, item.before, current?.revision)
    } else if (current !== undefined) {
      await variableStore.delete('chat', scopeId, item.name, current.revision)
    }
  }
}

async function restoreSettleIntentBefore(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
): Promise<void> {
  await restoreSettleIntentItems(deps.variableStore, intent.scopeId, intent.items)
}

/* -------------------------------- closure ---------------------------------- */

function closeSettleIntent(
  writer: WriteJournalRecordWriter,
  session: WriteJournalSession,
  intent: SettleIntentOpenEntry,
  phase: 'commit' | 'recovered' | 'abort',
  reason: string,
): void {
  appendSettleIntentWith(writer, session, {
    kind: 'settle-intent',
    phase,
    opId: intent.opId,
    sessionId: intent.sessionId,
    at: new Date().toISOString(),
    reason,
  })
}
