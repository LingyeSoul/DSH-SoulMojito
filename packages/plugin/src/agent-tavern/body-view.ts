/**
 * AgentTavern body presentation policy and HTTP error vocabulary.
 *
 * This shard owns pure read-side decisions: proposal §10 state safety, the
 * `GET body` payload builder, and the mapping from body-runtime failures to
 * proposal §11 codes and HTTP statuses. It never reads or writes the session.
 */

import type { CharacterCardIR, ChatLogIR } from '../../../tavern-format/src/index.js'
import { canAdvanceHostTurnBase } from '../session/trace.js'
import { effectiveBodyText, type BodyLedger } from './body.js'
import type { BodyAgentLike } from './body-runtime.js'
import { cardUsesJsrMvu } from './mvu-compat.js'
import {
  bodyBindingEligible,
  isRecord,
  type BodyAnchorInspection,
  type BodyBindingView,
} from './body-session.js'

/** Resolves one session's body state safety (character card + chat). */
export type BodyStateSafetyResolver = (
  sessionId: string,
  binding: BodyBindingView,
) => BodyStateSafety | undefined | Promise<BodyStateSafety | undefined>

/* ----------------------------- state safety -------------------------------- */

/** Concrete signal behind a `body-state-unsafe` refusal. */
export type BodyStateUnsafeDetail =
  | 'card-mvu'
  | 'stat-data'
  | 'mvu-receipts'
  | 'card-unreadable'
  | 'chat-unreadable'
  | 'safety-unavailable'

/**
 * Read-only safety verdict for body mutations.
 *
 * Proposal 0021 §10: replaying an old body over a chat whose MVU variables were
 * already patched would apply the patch a second time. Until variable rollback
 * exists, every MVU-declared card and every chat that already carries MVU state
 * is refused instead of silently writing a corrupted variable tree.
 */
export type BodyStateSafety =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: 'body-state-unsafe'; readonly detail: BodyStateUnsafeDetail }

/**
 * Decide whether edit/regenerate/select may run for this character + chat.
 *
 * Pure and read-only: it never mutates the card or chat. A missing/unreadable
 * card fails closed because the card's MVU declaration cannot be inspected.
 */
export function bodyStateSafetyOf(
  character: { readonly card: CharacterCardIR } | undefined,
  chat: ChatLogIR,
): BodyStateSafety {
  if (character === undefined) return unsafeBodyState('card-unreadable')

  let usesMvu: boolean
  try {
    usesMvu = cardUsesJsrMvu(character.card)
  } catch {
    return unsafeBodyState('card-unreadable')
  }
  if (usesMvu) return unsafeBodyState('card-mvu')

  const metadata = chat.header.chat_metadata
  const variables = isRecord(metadata['variables']) ? metadata['variables'] : undefined
  if (variables !== undefined && Object.prototype.hasOwnProperty.call(variables, 'stat_data')) {
    return unsafeBodyState('stat-data')
  }

  const mvu = isRecord(metadata['mvu']) ? metadata['mvu'] : undefined
  if (mvu !== undefined) {
    const receipts = mvu['receipts']
    if (Array.isArray(receipts)) return unsafeBodyState('mvu-receipts')
  }

  return { safe: true }
}

/** Internal/public constructor for a typed unsafe verdict. */
export function unsafeBodyState(detail: BodyStateUnsafeDetail): BodyStateSafety {
  return { safe: false, reason: 'body-state-unsafe', detail }
}

/** Actionable explanation for a `body-state-unsafe` refusal. */
export function bodyStateUnsafeMessage(detail: BodyStateUnsafeDetail): string {
  switch (detail) {
    case 'card-mvu':
      return 'this character card declares MVU variables; body mutations would apply variable patches twice'
    case 'stat-data':
      return 'this chat already carries chat_metadata.variables.stat_data; body mutations are disabled until variable rollback exists'
    case 'mvu-receipts':
      return 'this chat already carries chat_metadata.mvu.receipts; body mutations are disabled until variable rollback exists'
    case 'card-unreadable':
      return 'the character card could not be read, so MVU state cannot be ruled out; body mutations are disabled'
    case 'chat-unreadable':
      return 'the bound chat could not be read, so MVU state cannot be ruled out; body mutations are disabled'
    case 'safety-unavailable':
      return 'the MVU state safety check could not be resolved; body mutations are disabled'
  }
}

/* ------------------------------- body view --------------------------------- */

/** JSONL-side projection facts resolved by the HTTP layer (display text included). */
export interface BodyProjectedFloor {
  readonly groupId?: string
  readonly anchorMessageId?: string
  readonly selectedIndex?: number
  readonly count?: number
  readonly text?: string
}

/** Inputs for the pure `GET body` response builder. */
export interface BodyViewInput {
  readonly messageId: string
  readonly binding: BodyBindingView | undefined
  readonly agent: BodyAgentLike | undefined
  readonly hostSupported: boolean
  readonly stateSafety: BodyStateSafety | undefined
  readonly ledger: BodyLedger | undefined
  readonly messageText: string | undefined
  readonly projected: BodyProjectedFloor | undefined
  readonly inspection: BodyAnchorInspection | undefined
}

/** Proposal §7.3 response plus the stable rejection code when gated. */
export interface BodyView {
  readonly ok: true
  readonly groupId: string
  readonly anchorMessageId: string
  readonly selectedIndex: number
  readonly count: number
  readonly text: string
  readonly hidden: boolean
  readonly canEdit: boolean
  readonly canRegenerate: boolean
  readonly canSelect: boolean
  readonly reason?: string
}

/**
 * Build the `GET body` payload.
 *
 * JSONL display text wins (it already carries markdownOnly regex scripts); the
 * ledger supplies selection, candidate count and the text fallback. A message
 * the plugin has never projected yields a stable empty body instead of an
 * error, so cold sessions and freshly written turns still render normally.
 */
export function buildBodyView(input: BodyViewInput): BodyView {
  const ledger = input.ledger
  const candidate = ledger?.candidates.find((entry) => entry.messageId === input.messageId)
  const hidden = ledger !== undefined && ledger.anchorMessageId !== input.messageId && candidate !== undefined
  const groupId = ledger?.groupId ?? input.projected?.groupId ?? input.messageId
  const anchorMessageId = ledger?.anchorMessageId ?? input.projected?.anchorMessageId ?? input.messageId
  const selectedIndex = ledger?.selectedIndex ?? input.projected?.selectedIndex ?? 0
  const count = ledger?.candidates.length
    ?? input.projected?.count
    ?? (input.messageText === undefined ? 0 : 1)

  let candidateText: string | undefined
  if (ledger !== undefined && candidate !== undefined) {
    candidateText = ledger.edits.get(candidate.index) ?? candidate.text
  }
  const ledgerText = ledger === undefined ? undefined : effectiveBodyText(ledger)
  const text = hidden
    ? candidateText ?? input.messageText ?? ''
    : input.projected?.text ?? ledgerText ?? input.messageText ?? ''

  const reason = bodyViewReason(input, hidden)
  const canEdit = reason === undefined && !hidden && count > 0
  const canRegenerate = canEdit && input.agent !== undefined && canAdvanceHostTurnBase(input.agent)
  const canSelect = canEdit && count > 1

  return {
    ok: true,
    groupId,
    anchorMessageId,
    selectedIndex,
    count,
    text,
    hidden,
    canEdit,
    canRegenerate,
    canSelect,
    ...(reason === undefined ? {} : { reason }),
  }
}

function bodyViewReason(input: BodyViewInput, hidden: boolean): string | undefined {
  if (!bodyBindingEligible(input.binding)) return 'architecture-mismatch'
  if (input.stateSafety !== undefined && !input.stateSafety.safe) return 'body-state-unsafe'
  if (input.agent === undefined) return 'session-busy'
  if (input.agent.status !== 'idle') return 'session-busy'
  if (!input.hostSupported) return 'host-unsupported'
  if (hidden) return undefined
  if (input.messageText === undefined && input.ledger === undefined && input.projected === undefined) return undefined
  if (input.inspection === undefined) return 'session-busy'
  if (!input.inspection.onSurface) return 'body-compacted'
  if (!input.inspection.last) return 'not-last-round'
  return undefined
}

/* ------------------------------- HTTP errors ------------------------------- */

/** Stable failure view consumed by the HTTP layer. */
export interface BodyFailureView {
  readonly status: number
  readonly code: string
  readonly message: string
}

/**
 * Map one body runtime failure onto proposal §11 rejection codes and an HTTP
 * status. Runtime-only codes are folded into the closest public code so clients
 * never need to know internal state-machine names.
 */
export function bodyFailureOf(error: unknown): BodyFailureView {
  const rawCode = failureCodeOf(error)
  const code = publicBodyCode(rawCode)
  return {
    status: bodyRejectStatus(code),
    code,
    message: errorMessage(error),
  }
}

/** Proposal §11 code for an arbitrary failure. */
export function publicBodyCode(code: string | undefined): string {
  switch (code) {
    case 'architecture-mismatch':
    case 'session-busy':
    case 'not-last-round':
    case 'stale-anchor':
    case 'body-compacted':
    case 'body-state-unsafe':
    case 'invalid-body-text':
    case 'host-unsupported':
    case 'projection-pending':
      return code
    case 'invalid-arguments':
      return 'invalid-body-text'
    case 'restore-unavailable':
      return 'body-state-unsafe'
    case 'invalid-event':
    case 'operation-failed':
      return 'operation-failed'
    default:
      return 'operation-failed'
  }
}

/** HTTP status for one proposal §11 / internal body failure code. */
export function bodyRejectStatus(code: string): number {
  switch (code) {
    case 'invalid-body-text':
    case 'invalid-arguments':
      return 400
    case 'host-unsupported':
      return 501
    case 'projection-pending':
      return 503
    case 'architecture-mismatch':
    case 'session-busy':
    case 'not-last-round':
    case 'stale-anchor':
    case 'body-compacted':
    case 'body-state-unsafe':
      return 409
    default:
      return 500
  }
}

/* ------------------------------- helpers ---------------------------------- */

function failureCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const code = error['code']
  return typeof code === 'string' && code !== '' ? code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
