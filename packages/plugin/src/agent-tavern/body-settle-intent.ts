/**
 * AgentTavern settle-intent startup recovery.
 *
 * A settle batch writes the flat `VariableStore` before the chat receipt is
 * saved, so a crash between the two can leave flat values no receipt covers.
 * `tavern_variable_settle` records an open intent before the first flat write
 * and a commit marker after `saveChat`; this shard owns the startup pass that
 * closes or reverts those intents.
 *
 * Intent parsing stays with the journal vocabulary in `write-journal.ts`;
 * `foldSettleIntents` is re-exported here for recovery callers.
 */

import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import { readMvuReceipts } from '../mvu.js'
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
  type SettleIntentOpenEntry,
  type WriteJournalRecordWriter,
  type WriteJournalSession,
} from './write-journal.js'

export { foldSettleIntents } from './write-journal.js'
export type { SettleIntentOpenEntry, WriteJournalSession } from './write-journal.js'

/* --------------------------- settle intent recovery ------------------------ */

/** Stores one startup settle-intent pass reads and restores. */
export interface SettleIntentRecoveryDeps {
  readonly store: BodyRollbackStore
  readonly variableStore: BodyRollbackVariableStore
  readonly logger?: BodyRollbackLogger
}

/** Result of one startup pass over unclosed settle intents. */
export interface SettleIntentRecovery {
  readonly restored: number
  readonly committed: number
  readonly failed: number
  readonly failures: readonly string[]
}

/**
 * Close settle intents a crash left open between the flat write and the chat
 * save, or after the save but before the commit marker.
 *
 * A persisted live receipt carrying the intent's `opId` closes it as committed:
 * the receipt is that batch's own durable proof, so another settle that shares
 * `at` and `turnKey` can never vouch for it. Receipts written before `opId`
 * existed keep the legacy `turnKey` + `receiptAt` match, so old journals still
 * recover. Otherwise every merged open/extend item is restored to its `before`
 * value (deleted when absent) with the current revision as CAS, newest first,
 * so a name written by several phases returns to its earliest `before`;
 * nothing else is written on failure.
 */
export async function recoverOpenSettleIntents(
  deps: SettleIntentRecoveryDeps,
  agentId: string,
  session: WriteJournalSession,
  appendRecord: WriteJournalRecordWriter | undefined,
  intents: readonly SettleIntentOpenEntry[],
): Promise<SettleIntentRecovery> {
  if (intents.length === 0) return { restored: 0, committed: 0, failed: 0, failures: [] }
  if (appendRecord === undefined) {
    return { restored: 0, committed: 0, failed: intents.length, failures: intents.map((intent) => `${intent.opId}: no plugin-record writer`) }
  }
  let restored = 0
  let committed = 0
  const failures: string[] = []
  for (const intent of intents) {
    try {
      if (await settleReceiptPersisted(deps, intent)) {
        closeSettleIntent(appendRecord, session, intent, 'commit', 'receipt persisted before the intent closed')
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
        scopeId: intent.scopeId,
        error: message,
      })
    }
  }
  return { restored, committed, failed: failures.length, failures }
}

async function settleReceiptPersisted(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
): Promise<boolean> {
  let snapshot: { readonly chat: ChatLogIR; readonly revision: string } | undefined
  try {
    snapshot = await deps.store.getChatSnapshot(intent.character, intent.scopeId)
  } catch (cause) { throw settleChatError(intent, cause) }
  if (snapshot === undefined) throw settleChatError(intent, undefined)
  const live = readMvuReceipts(snapshot.chat).filter((receipt) => receipt.undoneAt === undefined)
  // Exact identity first: only this batch's own receipt proves its save.
  if (live.some((receipt) => receipt.opId === intent.opId)) return true
  // Legacy receipts (written before opId existed) keep the old match; a receipt
  // belonging to another op must never close this intent, even at the same
  // millisecond on the same floor.
  return live.some((receipt) => receipt.opId === undefined
    && receipt.turnKey === intent.turnKey
    && receipt.at >= intent.receiptAt)
}

function settleChatError(intent: SettleIntentOpenEntry, cause: unknown): BodyRollbackError {
  const suffix = cause === undefined ? '' : `: ${errorMessage(cause)}`
  return new BodyRollbackError(
    'body-state-unsafe',
    `settle intent '${intent.opId}' cannot read chat '${intent.scopeId}'${suffix}`,
    { detail: 'chat-unreadable', stage: 'restore', ...(cause === undefined ? {} : { cause }) },
  )
}

async function restoreSettleIntentBefore(
  deps: SettleIntentRecoveryDeps,
  intent: SettleIntentOpenEntry,
): Promise<void> {
  for (const item of [...intent.items].reverse()) {
    const current = await deps.variableStore.get(intent.scope, intent.scopeId, item.name)
    if (item.before !== undefined) {
      await deps.variableStore.set(intent.scope, intent.scopeId, item.name, item.before, current?.revision)
    } else if (current !== undefined) {
      await deps.variableStore.delete(intent.scope, intent.scopeId, item.name, current.revision)
    }
  }
}

function closeSettleIntent(
  writer: WriteJournalRecordWriter,
  session: WriteJournalSession,
  intent: SettleIntentOpenEntry,
  phase: 'commit' | 'recovered',
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
