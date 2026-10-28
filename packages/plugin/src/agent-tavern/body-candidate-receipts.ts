/**
 * Candidate-level MVU receipts for AgentTavern body editing (proposal 0023).
 *
 * Every body candidate owns one MVU receipt keyed by
 * `body:<messageId>#<candidateIndex>`. The receipt is the only replayable proof
 * that the candidate's `<UpdateVariable>` block was applied, so an edit must:
 *
 * 1. locate and validate the projected JSONL floor;
 * 2. migrate legacy `body:<messageId>` keys with the body ledger as the witness;
 * 3. undo the candidate's live receipt so variables return to the candidate baseline;
 * 4. apply the new text patch and replace the candidate receipt (upsert);
 * 5. rewrite `swipes` / `mes` / `stat_data` in the same chat clone.
 *
 * This module never reads the host session, clock, filesystem, network or the
 * flat variable store. It only mutates the caller-owned chat clone; the caller
 * owns the single CAS save, and a thrown error means the clone must be
 * discarded.
 */

import type { CharacterCardIR, ChatLogIR, ChatMessage } from '../../../tavern-format/src/index.js'
import {
  appendMvuReceipt,
  diffVariables,
  readChatVariables,
  readMvuReceipts,
  recordMvuTurnReceipt,
  snapshotChatVariables,
  undoMvuReceipts,
  type MvuReceipt,
} from '../mvu.js'
import type { BodyLedger } from './body.js'
import {
  BodyJsonlProjectionError,
  applyEditToChat,
  locateBodyFloor,
} from './body-jsonl.js'
import {
  applyUpdateVariableToChat,
  cardUsesJsrMvu,
  messageStatVariables,
} from './mvu-compat.js'

/* --------------------------------- shapes --------------------------------- */

/** Stable identity of one body candidate (proposal 0021 §3.1). */
export interface CandidateReceiptRef {
  readonly messageId: string
  readonly index: number
}

/** Parsed shape of one `mvu.receipts[].turnKey`. */
export type BodyReceiptKey =
  | { readonly kind: 'candidate'; readonly messageId: string; readonly index: number }
  | { readonly kind: 'legacy'; readonly messageId: string }
  | { readonly kind: 'settle'; readonly floorIndex: number }
  | { readonly kind: 'unknown' }

/** Unsafe candidate-receipt states surfaced by inspection and edit. */
export type CandidateReceiptDetail =
  | 'body-receipt-missing'
  | 'body-receipt-duplicate'
  | 'body-receipt-legacy'
  | 'body-receipt-key-mismatch'

/** Every recoverable refusal code for the candidate edit transaction. */
export type CandidateReceiptErrorCode =
  | CandidateReceiptDetail
  | 'stale-anchor'
  | 'body-floor-not-found'
  | 'projection-pending'

/** Typed refusal with a stable code for the projector / HTTP error mapping. */
export class CandidateReceiptError extends Error {
  readonly code: CandidateReceiptErrorCode

  constructor(code: CandidateReceiptErrorCode, message: string) {
    super(message)
    this.name = 'CandidateReceiptError'
    this.code = code
  }
}

/** Result of rewriting legacy candidate keys. */
export interface LegacyCandidateMigration {
  readonly migrated: number
  /**
   * Legacy keys left untouched. A key may belong to an older body group, so an
   * absent ledger slot is reported instead of guessed or deleted.
   */
  readonly unmappable: readonly string[]
}

/** Read-only candidate receipt state. */
export interface CandidateReceiptInspection {
  readonly live: readonly MvuReceipt[]
  readonly undone: readonly MvuReceipt[]
  readonly needsReceipt: boolean
  readonly detail?: CandidateReceiptDetail
}

/** Input of one candidate edit projection. */
export interface CandidateEditInput {
  readonly ledger: BodyLedger
  readonly groupId: string
  readonly index: number
  readonly messageId: string
  readonly previousText: string
  readonly text: string
  readonly at: string
  readonly eventSeq: number
}

/* ---------------------------------- keys ---------------------------------- */

const BODY_PREFIX = 'body:'
const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/

/** Native message ids never carry the separator or surrounding whitespace. */
function isCanonicalMessageId(value: string): boolean {
  return value.trim() !== '' && value.trim() === value && !value.includes('#')
}

/**
 * Stable candidate receipt key: `body:<messageId>#<index>`.
 *
 * `index` is the ledger slot witness and must be a non-negative safe integer.
 * Message ids containing `#` or surrounding whitespace are rejected because the
 * separator would make the key ambiguous and the parser would have to guess.
 */
export function candidateReceiptKey(messageId: string, index: number): string {
  if (typeof messageId !== 'string' || !isCanonicalMessageId(messageId)) {
    throw new CandidateReceiptError(
      'body-receipt-key-mismatch',
      `candidate receipt key requires a non-empty message id without '#' or surrounding whitespace, received '${String(messageId)}'`,
    )
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new CandidateReceiptError(
      'body-receipt-key-mismatch',
      `candidate receipt key for message '${messageId}' requires a non-negative safe integer index, received ${String(index)}`,
    )
  }
  return `${BODY_PREFIX}${messageId}#${index}`
}

/**
 * Parse one stored `turnKey` without guessing:
 *
 * - `body:<messageId>#<digits>` is a candidate key (canonical digits only);
 * - `body:<messageId>` is the legacy candidate key;
 * - canonical digits are a settle receipt;
 * - every other shape is unknown.
 */
export function classifyBodyReceiptKey(turnKey: string): BodyReceiptKey {
  if (typeof turnKey !== 'string' || turnKey === '') return { kind: 'unknown' }

  if (!turnKey.startsWith(BODY_PREFIX)) {
    return CANONICAL_INDEX.test(turnKey) && Number.isSafeInteger(Number(turnKey))
      ? { kind: 'settle', floorIndex: Number(turnKey) }
      : { kind: 'unknown' }
  }

  const rest = turnKey.slice(BODY_PREFIX.length)
  const separator = rest.indexOf('#')
  if (separator === -1) {
    return isCanonicalMessageId(rest) ? { kind: 'legacy', messageId: rest } : { kind: 'unknown' }
  }

  const messageId = rest.slice(0, separator)
  const suffix = rest.slice(separator + 1)
  if (!isCanonicalMessageId(messageId) || !CANONICAL_INDEX.test(suffix)) return { kind: 'unknown' }
  const index = Number(suffix)
  if (!Number.isSafeInteger(index)) return { kind: 'unknown' }
  return { kind: 'candidate', messageId, index }
}

/** Reject a ref that cannot be represented as a candidate key. */
function refMismatch(ref: CandidateReceiptRef): string | undefined {
  if (typeof ref.messageId !== 'string' || !isCanonicalMessageId(ref.messageId)) {
    return `candidate ref message id must be non-empty without '#' or surrounding whitespace, received '${String(ref.messageId)}'`
  }
  if (!Number.isSafeInteger(ref.index) || ref.index < 0) {
    return `candidate ref for '${ref.messageId}' has a non-negative safe integer index requirement, received ${String(ref.index)}`
  }
  return undefined
}

/* ------------------------------ ledger index ------------------------------ */

interface LedgerIndex {
  readonly byMessageId: ReadonlyMap<string, number>
  readonly error?: string
}

/**
 * Build the `messageId -> slot` witness from the ledger.
 *
 * A message id appearing twice, or a candidate whose `index` differs from its
 * array position, makes the receipt key non-unique; the caller must refuse
 * instead of picking one slot.
 */
function readLedgerIndex(ledger: BodyLedger): LedgerIndex {
  const byMessageId = new Map<string, number>()
  for (const [position, candidate] of ledger.candidates.entries()) {
    const messageId = candidate.messageId
    if (typeof messageId !== 'string' || !isCanonicalMessageId(messageId)) {
      return {
        byMessageId,
        error: `ledger candidate at position ${position} has message id '${String(messageId)}', which cannot be encoded as a candidate receipt key`,
      }
    }
    if (!Number.isSafeInteger(candidate.index) || candidate.index < 0 || candidate.index !== position) {
      return {
        byMessageId,
        error: `ledger candidate '${messageId}' carries index ${String(candidate.index)} at position ${position}; the slot witness must equal its position`,
      }
    }
    const existing = byMessageId.get(messageId)
    if (existing !== undefined) {
      return {
        byMessageId,
        error: `ledger maps message id '${messageId}' to candidate ${existing} and candidate ${candidate.index}; refusing to guess which slot owns its receipt`,
      }
    }
    byMessageId.set(messageId, candidate.index)
  }
  return { byMessageId }
}

function requireLedgerIndex(ledger: BodyLedger): ReadonlyMap<string, number> {
  const index = readLedgerIndex(ledger)
  if (index.error !== undefined) throw new CandidateReceiptError('body-receipt-key-mismatch', index.error)
  return index.byMessageId
}

/* -------------------------------- migration ------------------------------- */

/**
 * Rewrite legacy `body:<messageId>` keys to `body:<messageId>#<index>` when the
 * ledger maps the message id to a unique slot.
 *
 * Only `turnKey` changes: `at` / `status` / `changes` / `failures` / `undoneAt`
 * and unknown members survive. Unmapped legacy keys stay untouched because they
 * may belong to an older body group. Repeated calls are idempotent: the second
 * call finds no legacy key for a mapped message id.
 */
export function migrateLegacyCandidateReceipts(
  chat: ChatLogIR,
  ledger: BodyLedger,
): LegacyCandidateMigration {
  const byMessageId = requireLedgerIndex(ledger)
  const mvu = plainObject(chat.header.chat_metadata.mvu)
  const raw = mvu?.receipts
  if (!Array.isArray(raw) || raw.length === 0) return { migrated: 0, unmappable: [] }

  const existingKeys = new Set<string>()
  for (const entry of raw) {
    if (isRecord(entry) && typeof entry['turnKey'] === 'string') existingKeys.add(entry['turnKey'])
  }

  const next: unknown[] = []
  const unmappable: string[] = []
  let migrated = 0
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['turnKey'] !== 'string') {
      next.push(entry)
      continue
    }
    const turnKey = entry['turnKey']
    const key = classifyBodyReceiptKey(turnKey)
    if (key.kind !== 'legacy') {
      next.push(entry)
      continue
    }
    const slot = byMessageId.get(key.messageId)
    if (slot === undefined) {
      unmappable.push(turnKey)
      next.push(entry)
      continue
    }
    const nextKey = candidateReceiptKey(key.messageId, slot)
    if (existingKeys.has(nextKey)) {
      // Rewriting would create two receipts with one key; report instead of
      // hiding the conflict behind a silent duplicate.
      unmappable.push(turnKey)
      next.push(entry)
      continue
    }
    next.push({ ...entry, turnKey: nextKey })
    existingKeys.add(nextKey)
    migrated += 1
  }

  if (migrated > 0) {
    chat.header.chat_metadata.mvu = { ...(mvu ?? {}), receipts: next }
  }
  return { migrated, unmappable }
}

/* ------------------------------- inspection ------------------------------- */

/** Same block shape as the MVU parser; only gates whether a receipt is required. */
function hasUpdateVariableBlock(text: string): boolean {
  return /<UpdateVariable(?:Variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:Variable)?\s*>/i.test(text)
}

/**
 * Inspect one candidate's receipts.
 *
 * `needsReceipt` is true when the card declares JSR MVU and the previous body
 * contains a complete `<UpdateVariable>` block. Only multiple live receipts
 * that actually carry changes are a duplicate: proposal 0023 §3.2 lets
 * `status: 'unchanged'` receipts coexist because they do not touch variables.
 */
export function inspectCandidateReceipts(
  chat: ChatLogIR,
  ref: CandidateReceiptRef,
  ledger: BodyLedger,
  previousText: string,
  card: CharacterCardIR,
): CandidateReceiptInspection {
  const needsReceipt = cardUsesJsrMvu(card) && hasUpdateVariableBlock(previousText)
  const mismatch = refMismatch(ref)
  if (mismatch !== undefined) {
    return { live: [], undone: [], needsReceipt, detail: 'body-receipt-key-mismatch' }
  }
  const ledgerIndex = readLedgerIndex(ledger)
  if (ledgerIndex.error !== undefined) {
    return { live: [], undone: [], needsReceipt, detail: 'body-receipt-key-mismatch' }
  }
  const slot = ledger.candidates[ref.index]
  if (slot !== undefined && slot.messageId !== ref.messageId) {
    return { live: [], undone: [], needsReceipt, detail: 'body-receipt-key-mismatch' }
  }
  const mapped = ledgerIndex.byMessageId.get(ref.messageId)
  if (mapped !== undefined && mapped !== ref.index) {
    return { live: [], undone: [], needsReceipt, detail: 'body-receipt-key-mismatch' }
  }

  const live: MvuReceipt[] = []
  const undone: MvuReceipt[] = []
  const legacyKeys: string[] = []
  let keyMismatch: string | undefined

  const pushMatch = (receipt: MvuReceipt): void => {
    if (receipt.undoneAt === undefined) live.push(receipt)
    else undone.push(receipt)
  }

  for (const receipt of readMvuReceipts(chat)) {
    const key = classifyBodyReceiptKey(receipt.turnKey)
    if (key.kind === 'candidate') {
      if (key.messageId !== ref.messageId) continue
      if (key.index !== ref.index) {
        keyMismatch ??= `receipt '${receipt.turnKey}' claims message '${ref.messageId}' at slot ${key.index}, but the candidate slot is ${ref.index}`
        continue
      }
      pushMatch(receipt)
      continue
    }
    if (key.kind === 'legacy') {
      if (key.messageId !== ref.messageId) continue
      const legacySlot = ledgerIndex.byMessageId.get(key.messageId)
      if (legacySlot === undefined) {
        legacyKeys.push(receipt.turnKey)
        continue
      }
      if (legacySlot !== ref.index) {
        keyMismatch ??= `legacy receipt '${receipt.turnKey}' maps to slot ${legacySlot}, but the candidate slot is ${ref.index}`
        continue
      }
      pushMatch(receipt)
      continue
    }
    if (key.kind === 'unknown' && receipt.turnKey.startsWith(`${BODY_PREFIX}${ref.messageId}#`)) {
      keyMismatch ??= `receipt '${receipt.turnKey}' looks like a candidate key for message '${ref.messageId}' but cannot be parsed`
    }
  }

  const liveEffects = live.filter((receipt) => receipt.changes.length > 0).length
  const detail: CandidateReceiptDetail | undefined = keyMismatch !== undefined
    ? 'body-receipt-key-mismatch'
    : liveEffects > 1
      ? 'body-receipt-duplicate'
      : legacyKeys.length > 0
        ? 'body-receipt-legacy'
        : needsReceipt && live.length === 0 && undone.length === 0
          ? 'body-receipt-missing'
          : undefined

  return {
    live,
    undone,
    needsReceipt,
    ...(detail === undefined ? {} : { detail }),
  }
}

/* --------------------------------- errors --------------------------------- */

function detailError(
  detail: CandidateReceiptDetail,
  ref: CandidateReceiptRef,
  inspection: CandidateReceiptInspection,
): CandidateReceiptError {
  const key = candidateReceiptKey(ref.messageId, ref.index)
  if (detail === 'body-receipt-missing') {
    return new CandidateReceiptError(
      detail,
      `candidate ${ref.index} ('${ref.messageId}') has an <UpdateVariable> body but no live or undone receipt at '${key}'; restore the receipt before editing, do not retry blindly`,
    )
  }
  if (detail === 'body-receipt-duplicate') {
    const conflicts = inspection.live.filter((receipt) => receipt.changes.length > 0).map((receipt) => `'${receipt.turnKey}' at ${receipt.at}`)
    return new CandidateReceiptError(
      detail,
      `candidate ${ref.index} ('${ref.messageId}') has ${conflicts.length} live receipts with variable changes (${conflicts.join(', ')}); refusing to choose one, repair the receipt set first`,
    )
  }
  if (detail === 'body-receipt-legacy') {
    return new CandidateReceiptError(
      detail,
      `candidate ${ref.index} ('${ref.messageId}') has a legacy 'body:<messageId>' receipt that the body ledger cannot map to a unique slot; migrate or repair the receipt key before editing`,
    )
  }
  return new CandidateReceiptError(
    detail,
    `candidate ${ref.index} ('${ref.messageId}') has a receipt key that does not match the ledger slot; repair the receipt keys before editing`,
  )
}

/* ------------------------------ edit transaction --------------------------- */

/**
 * Apply one candidate edit inside a caller-owned chat clone.
 *
 * Order (must not be reordered): locate + validate floor, migrate legacy keys,
 * undo the live receipt, snapshot the baseline, apply the new patch, replace the
 * candidate receipt, rewrite `swipes` / `mes`, then attach `stat_data`.
 *
 * The argument is mutated in place and returned. On a thrown
 * {@link CandidateReceiptError} the clone may already contain migration edits;
 * discard it.
 */
export function applyCandidateEditToChat(
  chat: ChatLogIR,
  card: CharacterCardIR,
  input: CandidateEditInput,
): ChatLogIR {
  const floorIndex = locateCandidateFloor(chat, input)
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor '${input.groupId}' disappeared at message index ${floorIndex}`,
    )
  }
  if (isReplayOfAppliedEvent(floor, input.eventSeq)) return chat

  const byMessageId = requireLedgerIndex(input.ledger)
  migrateLegacyCandidateReceipts(chat, input.ledger)

  const ref: CandidateReceiptRef = { messageId: input.messageId, index: input.index }
  const inspection = inspectCandidateReceipts(chat, ref, input.ledger, input.previousText, card)
  if (inspection.detail !== undefined) throw detailError(inspection.detail, ref, inspection)

  if (inspection.live.length > 0) undoMvuReceipts(chat, inspection.live, { at: input.at })

  const before = snapshotChatVariables(chat)
  const applied = applyUpdateVariableToChat(card, chat, input.text)
  if (applied.found) {
    removeCandidateReceipts(chat, ref, byMessageId)
    recordCandidateReceipt(chat, before, candidateReceiptKey(input.messageId, input.index), input.at, applied.failures)
  } else {
    removeCandidateReceipts(chat, ref, byMessageId)
    restoreChatVariables(chat, before)
  }

  // applyEditToChat locates by group id only; bind the floor when the caller
  // reached it through the message-id fallback.
  bindFloorGroup(chat, floorIndex, input.groupId)
  const next = applyEditToChat(chat, {
    groupId: input.groupId,
    index: input.index,
    text: applied.text,
  })
  const nextFloor = next.messages[floorIndex]
  if (nextFloor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor '${input.groupId}' disappeared after editing candidate ${input.index} ('${input.messageId}')`,
    )
  }
  syncFloorStatData(next, floorIndex)
  markBodyMutation(next, floorIndex, input.eventSeq, 'edit')
  chat.header = next.header
  chat.messages = next.messages
  return chat
}

/* -------------------------------- helpers --------------------------------- */

/**
 * Record the applied body event on the floor. The watermark makes a projector
 * replay of the same seq a no-op before any receipt exchange or patch runs.
 */
function markBodyMutation(
  chat: ChatLogIR,
  floorIndex: number,
  eventSeq: number,
  mutation: 'edit',
): void {
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor has no message at index ${floorIndex} while marking ${mutation} at seq ${eventSeq}`,
    )
  }
  const extra = isRecord(floor.extra) ? floor.extra : {}
  const agentTavern = isRecord(extra['agentTavern']) ? extra['agentTavern'] : {}
  chat.messages[floorIndex] = {
    ...floor,
    extra: {
      ...extra,
      agentTavern: { ...agentTavern, lastBodyEventSeq: eventSeq, lastBodyMutation: mutation },
    },
  }
}

/**
 * Mirror `chat_metadata.variables.stat_data` onto the floor message.
 *
 * `messageStatVariables` attaches the current tree but leaves an older
 * `stat_data` in place when the tree no longer has one. Removing that stale
 * copy keeps `getChatMessages().data.stat_data` and the chat tree from
 * diverging after an edit removes the last patch.
 */
function syncFloorStatData(chat: ChatLogIR, floorIndex: number): void {
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor has no message at index ${floorIndex} while syncing stat_data`,
    )
  }
  const updated = messageStatVariables(chat, floor)
  if (plainObject(readChatVariables(chat)['stat_data']) !== undefined) {
    chat.messages[floorIndex] = updated
    return
  }
  const variables = isRecord(updated.variables) ? updated.variables : undefined
  if (variables === undefined || !Object.prototype.hasOwnProperty.call(variables, 'stat_data')) {
    chat.messages[floorIndex] = updated
    return
  }
  const nextVariables = { ...variables }
  delete nextVariables['stat_data']
  if (Object.keys(nextVariables).length === 0) {
    const nextMessage: ChatMessage = { ...updated }
    delete nextMessage.variables
    chat.messages[floorIndex] = nextMessage
    return
  }
  chat.messages[floorIndex] = { ...updated, variables: nextVariables }
}

function locateCandidateFloor(chat: ChatLogIR, input: CandidateEditInput): number {
  if (!Number.isSafeInteger(input.index) || input.index < 0) {
    throw new CandidateReceiptError(
      'stale-anchor',
      `edit candidate index must be a non-negative safe integer, received ${String(input.index)}`,
    )
  }
  let floorIndex: number
  try {
    floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
  } catch (error) {
    if (error instanceof BodyJsonlProjectionError) {
      throw new CandidateReceiptError(
        'body-floor-not-found',
        `cannot locate body floor for group '${input.groupId}' / message '${input.messageId}': ${error.message}`,
      )
    }
    throw error
  }
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor '${input.groupId}' has no message at index ${floorIndex}`,
    )
  }
  if (floor.swipe_id !== input.index) {
    throw new CandidateReceiptError(
      'stale-anchor',
      `edit index ${input.index} does not match selected swipe ${String(floor.swipe_id)} on body floor '${input.groupId}'`,
    )
  }
  const swipes = floor.swipes
  if (!Array.isArray(swipes) || typeof swipes[input.index] !== 'string') {
    throw new CandidateReceiptError(
      'projection-pending',
      `body floor '${input.groupId}' has no projected swipe at index ${input.index}; retry after the body projection catches up`,
    )
  }
  return floorIndex
}

function bindFloorGroup(chat: ChatLogIR, floorIndex: number, groupId: string): void {
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new CandidateReceiptError(
      'body-floor-not-found',
      `body floor '${groupId}' has no message at index ${floorIndex}`,
    )
  }
  const extra = isRecord(floor.extra) ? floor.extra : {}
  const agentTavern = isRecord(extra['agentTavern']) ? extra['agentTavern'] : {}
  const current = agentTavern['bodyGroupId']
  if (current !== undefined && current !== groupId) {
    throw new CandidateReceiptError(
      'stale-anchor',
      `body floor at index ${floorIndex} is already bound to group '${String(current)}', cannot edit group '${groupId}'`,
    )
  }
  if (current === groupId) return
  chat.messages[floorIndex] = {
    ...floor,
    extra: { ...extra, agentTavern: { ...agentTavern, bodyGroupId: groupId } },
  }
}

function isReplayOfAppliedEvent(message: ChatMessage, eventSeq: number): boolean {
  const sequence = readLastBodyEventSeq(message)
  return sequence !== undefined
    && Number.isSafeInteger(eventSeq)
    && eventSeq >= 0
    && sequence >= eventSeq
}

function readLastBodyEventSeq(message: ChatMessage): number | undefined {
  const extra = isRecord(message.extra) ? message.extra : undefined
  const agentTavern = extra === undefined ? undefined : extra['agentTavern']
  if (!isRecord(agentTavern)) return undefined
  const value = agentTavern['lastBodyEventSeq']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Remove every receipt that belongs to this candidate (new key, migrated key,
 * or a still-legacy key mapped by the ledger). Other receipts and unknown
 * `mvu` members stay untouched.
 */
function removeCandidateReceipts(
  chat: ChatLogIR,
  ref: CandidateReceiptRef,
  byMessageId: ReadonlyMap<string, number>,
): void {
  const mvu = plainObject(chat.header.chat_metadata.mvu)
  const raw = mvu?.receipts
  if (!Array.isArray(raw)) return
  const next = raw.filter((entry) => {
    if (!isRecord(entry) || typeof entry['turnKey'] !== 'string') return true
    return !receiptBelongsToCandidate(entry['turnKey'], ref, byMessageId)
  })
  if (next.length === raw.length) return
  chat.header.chat_metadata.mvu = { ...(mvu ?? {}), receipts: next }
}

function receiptBelongsToCandidate(
  turnKey: string,
  ref: CandidateReceiptRef,
  byMessageId: ReadonlyMap<string, number>,
): boolean {
  const key = classifyBodyReceiptKey(turnKey)
  if (key.kind === 'candidate') return key.messageId === ref.messageId && key.index === ref.index
  if (key.kind === 'legacy') {
    return key.messageId === ref.messageId && byMessageId.get(key.messageId) === ref.index
  }
  return false
}

/**
 * Write one candidate receipt. `recordMvuTurnReceipt` refuses to append when
 * both trees and the failure list are empty, but a candidate receipt is the
 * proof that a patch was applied (even a no-op one), so fall back to an
 * explicit `unchanged` receipt.
 */
function recordCandidateReceipt(
  chat: ChatLogIR,
  before: Record<string, unknown>,
  turnKey: string,
  at: string,
  failures: readonly string[],
): MvuReceipt {
  const recorded = recordMvuTurnReceipt(chat, before, { turnKey, at, failures: [...failures] })
  if (recorded !== undefined) return recorded
  const changes = diffVariables(before, readChatVariables(chat))
  const receipt: MvuReceipt = {
    at,
    turnKey,
    status: changes.length > 0 ? 'updated' : 'unchanged',
    changes,
    failures: [...failures],
  }
  appendMvuReceipt(chat, receipt)
  return receipt
}

function restoreChatVariables(chat: ChatLogIR, before: Record<string, unknown>): void {
  const metadata = chat.header.chat_metadata
  if (Object.keys(before).length === 0) {
    delete metadata.variables
    return
  }
  metadata.variables = structuredClone(before) as Record<string, unknown>
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
