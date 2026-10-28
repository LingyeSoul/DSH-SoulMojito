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
} from '../mvu.js'
import {
  BodyRollbackError,
  errorMessage,
  isRecord,
  type BodyRollbackBinding,
  type BodyRollbackStage,
  type BodyWriteRollbackDeps,
} from './body-rollback-support.js'

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
  if (bodyHasUpdateVariable && !receipts.some((receipt) => receipt.turnKey === bodyKey)) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback for session '${agentId}' turn ${turn} refused: the old body contains <UpdateVariable> but has no '${bodyKey}' receipt`,
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

function isFloorTurnKey(turnKey: string): boolean {
  return /^\d+$/.test(turnKey)
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
  for (const entry of ordered) {
    const restores = settleRestoresOf(entry.receipt, direction)
    await applySettleRestores(deps, entry.receipt, restores, direction, binding)
    markStoredReceipts(chat, [entry.index], direction === 'undo' ? at : undefined)
  }
  return targets.length
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

async function applySettleRestores(
  deps: BodyWriteRollbackDeps,
  receipt: MvuReceipt,
  restores: readonly MvuUndoRestore[],
  direction: ReceiptDirection,
  binding: BodyRollbackBinding,
): Promise<void> {
  const deletes: string[] = []
  const sets: Array<{ readonly name: string; readonly value: JsonValue }> = []
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

  // Deletes first: a path restored later must never be caught by its own delete.
  for (const name of deletes) {
    const current = await readSettleVariable(deps, binding, name, receipt, direction)
    if (current === undefined) continue
    await deleteSettleVariable(deps, binding, name, current.revision, receipt, direction)
  }
  for (const entry of sets) {
    const current = await readSettleVariable(deps, binding, entry.name, receipt, direction)
    if (current !== undefined && jsonValuesEqual(current.value, entry.value)) continue
    await setSettleVariable(deps, binding, entry.name, entry.value, current?.revision, receipt, direction)
  }
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
