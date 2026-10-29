/**
 * AgentTavern body write rollback: MVU receipt split and settle flat restore.
 *
 * Body receipts (`body:<messageId>`) own the JSONL `chat_metadata.variables`
 * tree. Settle receipts (numeric floor keys) own the chat-scope `VariableStore`
 * and are marked `undoneAt` directly in `mvu.receipts` without calling
 * `undoMvuReceipts`, which would copy their changes into the JSONL tree.
 */

import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import {
  VariableRevisionConflictError,
  type JsonValue,
  type VariableSnapshot,
} from '../../../tavern-store/src/index.js'
import {
  mvuReceiptsForBody,
  planMvuUndoRestores,
  redoMvuReceipts,
  undoMvuReceipts,
  type MvuReceipt,
  type MvuUndoRestore,
  type MvuVariableChange,
} from '../mvu.js'
import {
  BodyRollbackError,
  errorMessage,
  isRecord,
  log,
  type BodyRollbackBinding,
  type BodyRollbackErrorCode,
  type BodyRollbackErrorOptions,
  type BodyRollbackStage,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'
import { classifyBodyReceiptKey } from './body-candidate-receipts.js'

/* --------------------------------- receipts -------------------------------- */

export function readBodyReceipts(
  chat: ChatLogIR,
  previousMessageId: string,
  floorIndex: number,
  agentId: string,
  turn: number,
): MvuReceipt[] {
  try {
    return mvuReceiptsForBody(chat, { messageId: previousMessageId, floorIndex })
  } catch (error) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback for session '${agentId}' turn ${turn} cannot read MVU receipts: ${errorMessage(error)}`,
      { stage: 'prepare', sessionId: agentId, turn, cause: error },
    )
  }
}

export function assertReceiptCoverage(
  bodyText: string,
  toolNames: readonly string[],
  receipts: readonly MvuReceipt[],
  previousMessageId: string,
  floorIndex: number,
  agentId: string,
  turn: number,
): void {
  const bodyKey = `body:${previousMessageId}`
  const bodyHasUpdateVariable = /<UpdateVariable\b/i.test(bodyText)
  if (bodyHasUpdateVariable && !receipts.some((receipt) => isBodyReceiptOf(receipt.turnKey, previousMessageId))) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} refused: the old body contains <UpdateVariable> but has neither a '${bodyKey}' nor a '${bodyKey}#<index>' receipt`,
      { detail: 'mvu-receipt-missing', stage: 'prepare', sessionId: agentId, turn },
    )
  }
  const settleCall = toolNames.includes('tavern_variable_settle')
  if (settleCall && !receipts.some((receipt) => receipt.turnKey === String(floorIndex))) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} refused: tavern_variable_settle ran without a receipt for floor ${floorIndex}`,
      { detail: 'mvu-receipt-missing', stage: 'prepare', sessionId: agentId, turn },
    )
  }
}

/**
 * Whether `turnKey` is a body receipt for `messageId`: the legacy
 * `body:<messageId>` key or a candidate `body:<messageId>#<index>` key.
 */
function isBodyReceiptOf(turnKey: string, messageId: string): boolean {
  const key = classifyBodyReceiptKey(turnKey)
  if (key.kind === 'candidate') return key.messageId === messageId
  return key.kind === 'legacy' && key.messageId === messageId
}

/* ------------------------- receipt split / settle -------------------------- */

export type ReceiptDirection = 'undo' | 'redo'

export interface ReceiptRollbackResult {
  readonly bodyReceipts: number
  readonly settleReceipts: number
}

interface LocatedSettleReceipt {
  readonly index: number
  readonly receipt: MvuReceipt
  readonly undoneAt: string | undefined
}

/**
 * Apply both receipt families in one direction.
 *
 * Body receipts (`turnKey = 'body:<messageId>'`) own
 * `chat_metadata.variables`; `undoMvuReceipts` / `redoMvuReceipts` handle them.
 * Settle receipts (`turnKey` is the numeric floor index) own the chat-scope
 * `VariableStore`; they must never reach `undoMvuReceipts`, which would copy
 * their changes into the JSONL variable tree and mix the two stores
 * (proposal 0022 §9).
 */
export async function applyReceiptRollback(
  deps: BodyWriteRollbackDeps,
  chat: ChatLogIR,
  receipts: readonly MvuReceipt[],
  direction: ReceiptDirection,
  binding: BodyRollbackBinding,
): Promise<ReceiptRollbackResult> {
  const unclassified = receipts.filter(
    (receipt) => !receipt.turnKey.startsWith('body:') && !isFloorTurnKey(receipt.turnKey),
  )
  if (unclassified.length > 0) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback cannot classify receipt(s) ${unclassified.map((receipt) => `'${receipt.turnKey}'`).join(', ')}: expected 'body:<messageId>' or a numeric floor key`,
      { stage: direction === 'undo' ? 'mvu-undo' : 'mvu-redo' },
    )
  }

  const at = new Date().toISOString()
  const bodyReceipts = receipts.filter((receipt) => receipt.turnKey.startsWith('body:'))
  const settleReceipts = receipts.filter((receipt) => isFloorTurnKey(receipt.turnKey))

  let bodyCount = 0
  if (bodyReceipts.length > 0) {
    const result = direction === 'undo'
      ? undoMvuReceipts(chat, bodyReceipts, { at })
      : redoMvuReceipts(chat, bodyReceipts)
    bodyCount = result.receipts.length
  }
  const settleCount = await mutateSettleReceiptVariables(deps, chat, settleReceipts, direction, at, binding)
  return { bodyReceipts: bodyCount, settleReceipts: settleCount }
}

/** Result of replaying a partially applied receipt direction. */
export interface ReceiptCompensation {
  readonly ok: boolean
  readonly note: string
}

/**
 * Replay the opposite receipt direction after a later step failed.
 *
 * `applyReceiptRollback` mutates two stores (the chat tree/flat variables for
 * receipts and the chat clone's `undoneAt` marks), so a chat save failure
 * leaves a rollback that was never persisted. Replaying the same receipt set in
 * the opposite direction on the same chat clone puts both back before the
 * caller reports the original error. `applied` is the result the failed
 * direction returned when it is known; a missing value means the direction
 * threw partway and only the receipts it already marked are replayed.
 */
export async function compensateReceiptRollback(
  deps: BodyWriteRollbackDeps,
  chat: ChatLogIR,
  receipts: readonly MvuReceipt[],
  direction: ReceiptDirection,
  binding: BodyRollbackBinding,
  applied: ReceiptRollbackResult | undefined,
): Promise<ReceiptCompensation> {
  if (receipts.length === 0) return { ok: true, note: '' }
  // Both receipt families mutate only after locating every planned receipt, so
  // a chat that no longer stores one of them never applied part of this set.
  // Compensating would fail on the same missing record and mask the original
  // error as `body-rollback-partial`.
  if (!planReceiptsStored(chat, receipts)) return { ok: true, note: '' }
  const verb = direction === 'redo' ? 'replay' : 'undo'
  try {
    const replayed = await applyReceiptRollback(deps, chat, receipts, direction, binding)
    if (applied === undefined) {
      return {
        ok: true,
        note: direction === 'redo'
          ? '; the receipt rollback was replayed so the chat and flat store match the unsaved chat'
          : '; the receipt replay was undone so the chat and flat store match the rolled-back chat',
      }
    }
    const expected = applied.bodyReceipts + applied.settleReceipts
    const actual = replayed.bodyReceipts + replayed.settleReceipts
    if (actual === expected) {
      return {
        ok: true,
        note: direction === 'redo'
          ? '; the receipt rollback was replayed so the chat and flat store match the unsaved chat'
          : '; the receipt replay was undone so the chat and flat store match the rolled-back chat',
      }
    }
    return {
      ok: false,
      note: `; the receipt compensation only ${verb === 'replay' ? 'replayed' : 'undid'} ${actual} of ${expected} receipt(s)`,
    }
  } catch (error) {
    log(deps.logger, 'error', 'dsh-soulmojito body rollback: receipt compensation failed', {
      direction,
      error: errorMessage(error),
    })
    return { ok: false, note: `; the ${verb} receipt compensation failed: ${errorMessage(error)}` }
  }
}

/** True when every planned receipt still exists in the chat's receipt log. */
function planReceiptsStored(chat: ChatLogIR, receipts: readonly MvuReceipt[]): boolean {
  const raw = rawMvuReceipts(chat)
  if (raw === undefined) return false
  const used = new Set<number>()
  for (const receipt of receipts) {
    let found = false
    for (let index = 0; index < raw.length; index += 1) {
      if (used.has(index)) continue
      const record = raw[index]
      if (!isRecord(record)) continue
      if (record['turnKey'] !== receipt.turnKey || record['at'] !== receipt.at) continue
      used.add(index)
      found = true
      break
    }
    if (!found) return false
  }
  return true
}

function isFloorTurnKey(turnKey: string): boolean {
  return /^\d+$/.test(turnKey)
}

/* ---------------------- settle receipt plans and evidence ------------------- */

/**
 * One variable write already applied to the flat store.
 *
 * `written` lets the reverse pass refuse to overwrite a foreign write that
 * landed after this one; a delete is the state where the name is absent.
 */
type SettleVariableWrite =
  | { readonly kind: 'set'; readonly name: string; readonly before: VariableSnapshot | undefined; readonly written: JsonValue }
  | { readonly kind: 'delete'; readonly name: string; readonly before: VariableSnapshot }

interface SettleSetRestore {
  readonly name: string
  readonly value: JsonValue
}

/** One settle receipt fully validated before the first flat-store write. */
interface SettleReceiptPlan {
  readonly entry: LocatedSettleReceipt
  readonly deletes: readonly string[]
  readonly sets: readonly SettleSetRestore[]
}

type SettleStep<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

type SettleApplyResult =
  | { readonly ok: true; readonly writes: readonly SettleVariableWrite[] }
  | { readonly ok: false; readonly writes: readonly SettleVariableWrite[]; readonly failedName: string; readonly error: unknown }

type SettleCompensation =
  | { readonly ok: true; readonly restoredNames: readonly string[] }
  | { readonly ok: false; readonly restoredNames: readonly string[]; readonly failedName: string; readonly error: unknown }

/** One name the failed receipt already wrote, with the state it replaced. */
export interface SettleReceiptWrittenName {
  readonly name: string
  readonly before?: VariableSnapshot
}

/**
 * Recoverable evidence for a settle receipt whose own writes could not be
 * reverted: what each written name held, what the reverse pass restored, and
 * both failures. The receipt stays unmarked, so a retry re-plans it.
 */
export interface SettleReceiptPartialEvidence {
  readonly character: string
  readonly chatId: string
  readonly receiptKey: string
  readonly receiptAt: string
  readonly direction: ReceiptDirection
  /** Name whose write failed in the requested direction. */
  readonly failedName: string
  readonly writtenNames: readonly SettleReceiptWrittenName[]
  readonly restoredNames: readonly string[]
  /** Name whose reverse write failed. */
  readonly compensationFailedName: string
  /** Original store failure that triggered the reverse pass. */
  readonly failure: string
  /** Failure of the reverse pass itself. */
  readonly compensationFailure: string
}

/** `body-rollback-partial` carrying the names a settle receipt applied and restored. */
export class SettleReceiptPartialError extends BodyRollbackError {
  readonly evidence: SettleReceiptPartialEvidence

  constructor(
    message: string,
    options: BodyRollbackErrorOptions,
    evidence: SettleReceiptPartialEvidence,
  ) {
    // Evidence only exists when the reverse pass failed; never downgrade it.
    super('body-rollback-partial', message, { ...options, compensated: false })
    this.evidence = evidence
  }
}

export function settleReceiptPartialEvidenceOf(error: unknown): SettleReceiptPartialEvidence | undefined {
  return error instanceof SettleReceiptPartialError ? error.evidence : undefined
}

/**
 * Rebuild an outer rollback error without dropping settle receipt evidence.
 * A source carrying evidence keeps `body-rollback-partial`.
 */
export function rollbackErrorWithSettleEvidence(
  source: unknown,
  code: BodyRollbackErrorCode,
  message: string,
  options: BodyRollbackErrorOptions,
): BodyRollbackError {
  const evidence = settleReceiptPartialEvidenceOf(source)
  if (evidence !== undefined) return new SettleReceiptPartialError(message, options, evidence)
  return new BodyRollbackError(code, message, options)
}

/**
 * Undo or replay settle receipts against the chat-scope flat store.
 *
 * Undo restores each receipt's `before` value (`planMvuUndoRestores`) and
 * deletes a path that had no before value; replay restores each `after` value
 * and deletes a path the receipt removed. Receipts are processed newest-first
 * for undo and oldest-first for replay, and a receipt whose stored `undoneAt`
 * already matches the direction is skipped so repeated calls stay idempotent.
 */
async function mutateSettleReceiptVariables(
  deps: BodyWriteRollbackDeps,
  chat: ChatLogIR,
  receipts: readonly MvuReceipt[],
  direction: ReceiptDirection,
  at: string,
  binding: BodyRollbackBinding,
): Promise<number> {
  if (receipts.length === 0) return 0
  const located = locateSettleReceipts(chat, receipts, direction)
  const targets = located.filter((entry) =>
    direction === 'undo' ? entry.undoneAt === undefined : entry.undoneAt !== undefined)
  if (targets.length === 0) return 0

  const ordered = direction === 'undo' ? [...targets].reverse() : targets
  // Plan every receipt before the first store write. An incomplete or damaged
  // receipt must refuse the whole call instead of leaving earlier receipts
  // already applied to the flat store.
  const planned = ordered.map((entry) => planSettleReceipt(entry, direction))
  for (const plan of planned) {
    const applied = await applySettleRestores(deps, plan, direction, binding)
    if (!applied.ok) {
      // A receipt can fail after some of its names landed. Restore exactly the
      // names this receipt wrote, then report the original store failure; the
      // receipt is not marked, so a retry re-plans the same direction.
      const compensation = await compensateSettleWrites(deps, binding, applied.writes)
      if (!compensation.ok) {
        throw settleCompensationError(deps, plan, direction, binding, applied, compensation)
      }
      throw applied.error
    }
    markStoredReceipts(chat, [plan.entry.index], direction === 'undo' ? at : undefined)
  }
  return targets.length
}

/**
 * Resolve and validate every variable item of one receipt before any write.
 *
 * Both recorded sides are validated even though one direction writes only one:
 * a bad `after` could be undone but never replayed. Duplicate names make the
 * per-name compensation ambiguous and are refused too.
 */
function planSettleReceipt(entry: LocatedSettleReceipt, direction: ReceiptDirection): SettleReceiptPlan {
  const receipt = entry.receipt
  const restores = settleRestoresOf(receipt, direction)
  const names = new Set<string>()
  for (const change of receipt.changes) {
    validateSettleChange(receipt, direction, change)
    if (names.has(change.name)) {
      throw settleReceiptError(receipt, direction, `records variable '${change.name}' more than once, so the write order is ambiguous`, undefined)
    }
    names.add(change.name)
  }
  const deletes: string[] = []
  const sets: SettleSetRestore[] = []
  for (const restore of restores) {
    if (!('value' in restore)) {
      deletes.push(restore.path)
      continue
    }
    try {
      sets.push({ name: restore.path, value: toJsonValue(restore.value, restore.path, receipt) })
    } catch (error) {
      throw settleReceiptError(receipt, direction, errorMessage(error), error)
    }
  }
  return { entry, deletes, sets }
}

function validateSettleChange(
  receipt: MvuReceipt,
  direction: ReceiptDirection,
  change: MvuVariableChange,
): void {
  if (typeof change.name !== 'string' || change.name.trim() === '') {
    throw settleReceiptError(receipt, direction, 'records a change with an empty variable name', undefined)
  }
  for (const side of ['before', 'after'] as const) {
    if (!(side in change)) continue
    try {
      toJsonValue(change[side], `${change.name} (${side})`, receipt)
    } catch (error) {
      throw settleReceiptError(receipt, direction, errorMessage(error), error)
    }
  }
}

function locateSettleReceipts(
  chat: ChatLogIR,
  receipts: readonly MvuReceipt[],
  direction: ReceiptDirection,
): LocatedSettleReceipt[] {
  const raw = rawMvuReceipts(chat)
  if (raw === undefined) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback cannot ${direction === 'undo' ? 'undo' : 'replay'} settle receipts: the chat has no mvu.receipts array`,
      { stage: stageOfReceipt(direction) },
    )
  }
  const used = new Set<number>()
  const located: LocatedSettleReceipt[] = []
  for (const receipt of receipts) {
    let match: LocatedSettleReceipt | undefined
    for (let index = 0; index < raw.length; index += 1) {
      if (used.has(index)) continue
      const record = raw[index]
      if (!isRecord(record)) continue
      if (record['turnKey'] !== receipt.turnKey || record['at'] !== receipt.at) continue
      match = {
        index,
        receipt,
        undoneAt: typeof record['undoneAt'] === 'string' ? record['undoneAt'] : undefined,
      }
      break
    }
    if (match === undefined) {
      throw new BodyRollbackError(
        'body-rollback-failed',
        `body rollback cannot ${direction === 'undo' ? 'undo' : 'replay'} settle receipt '${receipt.turnKey}' at ${receipt.at}: the receipt is not stored in this chat`,
        { stage: stageOfReceipt(direction) },
      )
    }
    used.add(match.index)
    located.push(match)
  }
  return located
}

function settleRestoresOf(receipt: MvuReceipt, direction: ReceiptDirection): MvuUndoRestore[] {
  try {
    if (direction === 'redo') return planSettleRedoRestores(receipt)
    const restores = planMvuUndoRestores(receipt)
    // Undo is newest-first at every level: changes inside one receipt reverse
    // too, matching the receipt-level order.
    restores.reverse()
    return restores
  } catch (error) {
    throw settleReceiptError(receipt, direction, errorMessage(error), error)
  }
}

/**
 * Redo plan for one settle receipt: restore the after value when present,
 * otherwise delete the path (the receipt recorded a deletion). Completeness
 * rules mirror `planMvuUndoRestores`.
 */
function planSettleRedoRestores(receipt: MvuReceipt): MvuUndoRestore[] {
  if (receipt.status === 'updated' && receipt.changes.length === 0) {
    throw new Error(`receipt ${receipt.turnKey} claims status 'updated' but records no change data; the receipt data is incomplete and cannot be replayed`)
  }
  const restores: MvuUndoRestore[] = []
  for (const change of receipt.changes) {
    if (!('before' in change) && !('after' in change)) {
      throw new Error(`receipt change '${change.name}' records neither a before nor an after value; the receipt data is incomplete and cannot be replayed`)
    }
    restores.push({ path: change.name, ...('after' in change ? { value: change.after } : {}) })
  }
  return restores
}

/**
 * Execute one validated receipt plan (deletes first, then sets). A store
 * failure returns the writes that already landed so the caller can compensate.
 */
async function applySettleRestores(
  deps: BodyWriteRollbackDeps,
  plan: SettleReceiptPlan,
  direction: ReceiptDirection,
  binding: BodyRollbackBinding,
): Promise<SettleApplyResult> {
  const receipt = plan.entry.receipt
  const writes: SettleVariableWrite[] = []
  for (const name of plan.deletes) {
    const current = await settleStep(() => readSettleVariable(deps, binding, name, receipt, direction))
    if (!current.ok) return { ok: false, writes, failedName: name, error: current.error }
    const before = current.value
    if (before === undefined) continue
    const deleted = await settleStep(() => deleteSettleVariable(deps, binding, name, before.revision, receipt, direction))
    if (!deleted.ok) return { ok: false, writes, failedName: name, error: deleted.error }
    writes.push({ kind: 'delete', name, before })
  }
  for (const entry of plan.sets) {
    const current = await settleStep(() => readSettleVariable(deps, binding, entry.name, receipt, direction))
    if (!current.ok) return { ok: false, writes, failedName: entry.name, error: current.error }
    const before = current.value
    if (before !== undefined && jsonValuesEqual(before.value, entry.value)) continue
    const written = await settleStep(() => setSettleVariable(deps, binding, entry.name, entry.value, before?.revision, receipt, direction))
    if (!written.ok) return { ok: false, writes, failedName: entry.name, error: written.error }
    writes.push({ kind: 'set', name: entry.name, before, written: entry.value })
  }
  return { ok: true, writes }
}

async function settleStep<T>(execute: () => Promise<T>): Promise<SettleStep<T>> {
  try {
    return { ok: true, value: await execute() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Restore the names one receipt already wrote, newest-first and name by name. */
async function compensateSettleWrites(
  deps: BodyWriteRollbackDeps,
  binding: BodyRollbackBinding,
  writes: readonly SettleVariableWrite[],
): Promise<SettleCompensation> {
  const restoredNames: string[] = []
  for (let index = writes.length - 1; index >= 0; index -= 1) {
    const write = writes[index]!
    const restored = await settleStep(() => restoreSettleWrite(deps, binding, write))
    if (!restored.ok) return { ok: false, restoredNames, failedName: write.name, error: restored.error }
    restoredNames.push(write.name)
  }
  return { ok: true, restoredNames }
}

async function restoreSettleWrite(
  deps: BodyWriteRollbackDeps,
  binding: BodyRollbackBinding,
  write: SettleVariableWrite,
): Promise<void> {
  const current = await deps.variableStore.get('chat', binding.chatId, write.name)
  if (write.kind === 'delete') {
    // A foreign write re-created the name; restoring the old value would clobber it.
    if (current !== undefined) {
      throw new Error(`settle variable '${write.name}' was re-created after the rollback deleted it, so its old value cannot be restored safely`)
    }
    await deps.variableStore.set('chat', binding.chatId, write.name, structuredClone(write.before.value), undefined)
    return
  }
  // Only revert the exact value this rollback wrote; a foreign state is refused.
  if (current === undefined || !jsonValuesEqual(current.value, write.written)) {
    throw new Error(`settle variable '${write.name}' no longer holds the value this rollback wrote, so it cannot be reverted safely`)
  }
  if (write.before === undefined) {
    await deps.variableStore.delete('chat', binding.chatId, write.name, current.revision)
    return
  }
  await deps.variableStore.set('chat', binding.chatId, write.name, structuredClone(write.before.value), current.revision)
}

function settleCompensationError(
  deps: BodyWriteRollbackDeps,
  plan: SettleReceiptPlan,
  direction: ReceiptDirection,
  binding: BodyRollbackBinding,
  applied: Extract<SettleApplyResult, { readonly ok: false }>,
  compensation: Extract<SettleCompensation, { readonly ok: false }>,
): SettleReceiptPartialError {
  const receipt = plan.entry.receipt
  const evidence: SettleReceiptPartialEvidence = {
    character: binding.character,
    chatId: binding.chatId,
    receiptKey: receipt.turnKey,
    receiptAt: receipt.at,
    direction,
    failedName: applied.failedName,
    writtenNames: applied.writes.map((write) => ({
      name: write.name,
      ...(write.before === undefined ? {} : { before: structuredClone(write.before) }),
    })),
    restoredNames: compensation.restoredNames,
    compensationFailedName: compensation.failedName,
    failure: errorMessage(applied.error),
    compensationFailure: errorMessage(compensation.error),
  }
  log(deps.logger, 'error', 'dsh-soulmojito body rollback: settle receipt compensation failed', {
    sessionId: binding.chatId,
    receiptKey: receipt.turnKey,
    failedName: applied.failedName,
    restoredNames: compensation.restoredNames,
    error: evidence.compensationFailure,
  })
  const verb = direction === 'undo' ? 'undo' : 'replay'
  const restored = compensation.restoredNames.join(', ') || 'none'
  return new SettleReceiptPartialError(
    `body rollback cannot ${verb} settle receipt '${receipt.turnKey}' at ${receipt.at}: variable '${applied.failedName}' failed (${evidence.failure}) and the names already written could not be restored (${evidence.compensationFailure}; restored: ${restored}); the receipt stays without 'undoneAt' so it can be retried`,
    { stage: stageOfReceipt(direction), cause: applied.error },
    evidence,
  )
}

async function readSettleVariable(
  deps: BodyWriteRollbackDeps,
  binding: BodyRollbackBinding,
  name: string,
  receipt: MvuReceipt,
  direction: ReceiptDirection,
): Promise<VariableSnapshot | undefined> {
  try {
    return await deps.variableStore.get('chat', binding.chatId, name)
  } catch (error) {
    throw settleReceiptError(receipt, direction, `cannot read variable '${name}': ${errorMessage(error)}`, error)
  }
}

async function setSettleVariable(
  deps: BodyWriteRollbackDeps,
  binding: BodyRollbackBinding,
  name: string,
  value: JsonValue,
  expectedRevision: string | undefined,
  receipt: MvuReceipt,
  direction: ReceiptDirection,
): Promise<void> {
  try {
    await deps.variableStore.set('chat', binding.chatId, name, value, expectedRevision)
  } catch (error) {
    throw settleStoreError(error, name, receipt, direction)
  }
}

async function deleteSettleVariable(
  deps: BodyWriteRollbackDeps,
  binding: BodyRollbackBinding,
  name: string,
  expectedRevision: string,
  receipt: MvuReceipt,
  direction: ReceiptDirection,
): Promise<void> {
  try {
    await deps.variableStore.delete('chat', binding.chatId, name, expectedRevision)
  } catch (error) {
    throw settleStoreError(error, name, receipt, direction)
  }
}

function settleStoreError(
  error: unknown,
  name: string,
  receipt: MvuReceipt,
  direction: ReceiptDirection,
): BodyRollbackError {
  const verb = direction === 'undo' ? 'undo' : 'replay'
  if (error instanceof VariableRevisionConflictError) {
    return new BodyRollbackError(
      'body-rollback-conflict',
      `body rollback ${verb} hit a variable revision conflict for settle receipt '${receipt.turnKey}' at ${receipt.at}, variable '${name}': ${error.message}`,
      { stage: stageOfReceipt(direction), cause: error },
    )
  }
  return settleReceiptError(receipt, direction, `cannot ${verb} variable '${name}': ${errorMessage(error)}`, error)
}

function settleReceiptError(
  receipt: MvuReceipt,
  direction: ReceiptDirection,
  detail: string,
  cause: unknown,
): BodyRollbackError {
  return new BodyRollbackError(
    'body-rollback-failed',
    `body rollback cannot ${direction === 'undo' ? 'undo' : 'replay'} settle receipt '${receipt.turnKey}' at ${receipt.at}: ${detail}`,
    { stage: stageOfReceipt(direction), cause },
  )
}

function stageOfReceipt(direction: ReceiptDirection): BodyRollbackStage {
  return direction === 'undo' ? 'mvu-undo' : 'mvu-redo'
}

function rawMvuReceipts(chat: ChatLogIR): unknown[] | undefined {
  const mvu = chat.header.chat_metadata.mvu
  const receipts = isRecord(mvu) ? mvu['receipts'] : undefined
  return Array.isArray(receipts) ? receipts : undefined
}

/** Mark or clear `undoneAt` on stored receipts without touching their changes. */
function markStoredReceipts(
  chat: ChatLogIR,
  indexes: readonly number[],
  undoneAt: string | undefined,
): void {
  const raw = rawMvuReceipts(chat)
  if (raw === undefined) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      'body rollback cannot mark settle receipts: the chat has no mvu.receipts array',
      { stage: undoneAt === undefined ? 'mvu-redo' : 'mvu-undo' },
    )
  }
  const next = raw.slice()
  for (const index of indexes) {
    const record = next[index]
    if (!isRecord(record)) {
      throw new BodyRollbackError(
        'body-rollback-failed',
        `body rollback cannot mark MVU receipt at index ${index}: the entry is not an object`,
        { stage: undoneAt === undefined ? 'mvu-redo' : 'mvu-undo' },
      )
    }
    const updated: Record<string, unknown> = { ...record }
    if (undoneAt === undefined) delete updated['undoneAt']
    else updated['undoneAt'] = undoneAt
    next[index] = updated
  }
  const metadata = chat.header.chat_metadata
  const mvu = isRecord(metadata.mvu) ? metadata.mvu : {}
  // Keep unknown mvu members; only receipts uses the edited raw entries.
  metadata.mvu = { ...mvu, receipts: next }
}

function toJsonValue(value: unknown, path: string, receipt: MvuReceipt): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`settle receipt '${receipt.turnKey}' path '${path}' carries a non-finite number`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}[${index}]`, receipt))
  }
  if (isRecord(value)) {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) record[key] = toJsonValue(item, `${path}.${key}`, receipt)
    return record
  }
  throw new Error(`settle receipt '${receipt.turnKey}' path '${path}' carries a non-JSON value`)
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => jsonValuesEqual(item, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => key in right && jsonValuesEqual(left[key], right[key]))
  }
  return false
}
