/**
 * Candidate receipt keys and ledger slot witnesses (proposal 0023).
 *
 * Kept separate from `body-candidate-receipts.ts` so the key grammar and the
 * slot-witness rules stay readable and testable without the edit transaction.
 * The transaction module re-exports these symbols, so existing importers keep
 * their entry point.
 */

import type { BodyLedger } from './body.js'

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

export const BODY_PREFIX = 'body:'
const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/

/** Native message ids never carry the separator or surrounding whitespace. */
export function isCanonicalMessageId(value: string): boolean {
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
 * Every receipt key owned by one body group's candidates: the canonical
 * `body:<messageId>#<index>` key plus the legacy `body:<messageId>` alias.
 *
 * The alias stays listed because a still-unmigrated legacy receipt belongs to
 * the same candidate; migrating it later must not find it evicted. Callers pass
 * this set to the receipt append so ring retention cannot drop the active
 * group's candidates (proposal 0023 §3.6). A malformed ledger entry throws
 * instead of producing a partial set: an unprotected candidate is a silent
 * data-loss path.
 */
export function candidatePreserveKeys(ledger: BodyLedger): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const candidate of ledger.candidates) {
    keys.add(candidateReceiptKey(candidate.messageId, candidate.index))
    keys.add(`${BODY_PREFIX}${candidate.messageId}`)
  }
  return keys
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
export function refMismatch(ref: CandidateReceiptRef): string | undefined {
  if (typeof ref.messageId !== 'string' || !isCanonicalMessageId(ref.messageId)) {
    return `candidate ref message id must be non-empty without '#' or surrounding whitespace, received '${String(ref.messageId)}'`
  }
  if (!Number.isSafeInteger(ref.index) || ref.index < 0) {
    return `candidate ref for '${ref.messageId}' has a non-negative safe integer index requirement, received ${String(ref.index)}`
  }
  return undefined
}

/** `messageId -> slot` witness plus the first conflict, if any. */
export interface LedgerIndex {
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
export function readLedgerIndex(ledger: BodyLedger): LedgerIndex {
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

export function requireLedgerIndex(ledger: BodyLedger): ReadonlyMap<string, number> {
  const index = readLedgerIndex(ledger)
  if (index.error !== undefined) throw new CandidateReceiptError('body-receipt-key-mismatch', index.error)
  return index.byMessageId
}
