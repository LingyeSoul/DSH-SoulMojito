/**
 * AgentTavern body presentation policy and HTTP error vocabulary.
 *
 * This shard owns pure read-side decisions: proposal 0022 §7 state safety, the
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
  | 'card-unreadable'
  | 'chat-unreadable'
  | 'safety-unavailable'
  | 'mvu-receipt-missing'
  | 'write-journal-missing'
  | 'write-journal-unavailable'
  /** Legacy alias kept for old clients (proposal 0023 §6.4). */
  | 'edit-rollback-unavailable'
  /** Legacy alias kept for old clients (proposal 0023 §6.4). */
  | 'select-rollback-unavailable'
  | 'candidate-switch-disabled'
  | 'body-receipt-missing'
  | 'body-receipt-duplicate'
  | 'body-receipt-legacy'
  | 'body-receipt-key-mismatch'

/** Body mutation whose rollback requirements differ (proposal 0022 §7). */
export type BodyMutationAction = 'edit' | 'regenerate' | 'select'

/**
 * Read-only safety verdict for body mutations.
 *
 * Proposal 0022 §7: MVU state is no longer a blanket refusal. Regeneration is
 * protected by the write rollback port; editing and candidate selection still
 * have no candidate-level rollback and stay refused over historical MVU state.
 */
export type BodyStateSafety =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: 'body-state-unsafe'; readonly detail: BodyStateUnsafeDetail }

/**
 * Decide whether body state can be read at all.
 *
 * Only an unreadable character card (or an unreadable chat, reported by the
 * caller) is unsafe here. MVU cards and chats with historical variables are
 * handled per action by `bodyMutationSafetyOf`.
 */
export function bodyStateSafetyOf(
  character: { readonly card: CharacterCardIR } | undefined,
  chat: ChatLogIR | undefined,
): BodyStateSafety {
  if (character === undefined) return unsafeBodyState('card-unreadable')
  if (chat === undefined) return unsafeBodyState('chat-unreadable')

  try {
    // Reading the card is what proves it is usable; the MVU answer itself is no
    // longer a refusal reason.
    cardUsesJsrMvu(character.card)
  } catch {
    return unsafeBodyState('card-unreadable')
  }
  return { safe: true }
}

/**
 * Whether this card/chat already carries MVU or variable state that an edit or
 * select would replay without a candidate-level rollback.
 */
export function bodyHistoricalMvuStateOf(
  character: { readonly card: CharacterCardIR } | undefined,
  chat: ChatLogIR | undefined,
): boolean {
  if (character === undefined || chat === undefined) return true
  try {
    if (cardUsesJsrMvu(character.card)) return true
  } catch {
    return true
  }

  const metadata = chat.header.chat_metadata
  const variables = isRecord(metadata['variables']) ? metadata['variables'] : undefined
  if (variables !== undefined && Object.prototype.hasOwnProperty.call(variables, 'stat_data')) {
    return true
  }

  const mvu = isRecord(metadata['mvu']) ? metadata['mvu'] : undefined
  return mvu !== undefined && Array.isArray(mvu['receipts'])
}

/**
 * Action-specific gate.
 *
 * `regenerate` relies on the write rollback port (checked separately by the
 * HTTP layer). Proposal 0023 narrows the historical-MVU refusal to candidate
 * switching only: editing is protected by the runtime candidate-receipt
 * preflight, while select stays closed until the candidate-aware regenerate
 * lands (P1).
 */
export function bodyMutationSafetyOf(
  action: BodyMutationAction,
  character: { readonly card: CharacterCardIR } | undefined,
  chat: ChatLogIR | undefined,
): BodyStateSafety {
  const base = bodyStateSafetyOf(character, chat)
  if (!base.safe) return base
  if (action !== 'select') return base
  if (!bodyHistoricalMvuStateOf(character, chat)) return base
  return unsafeBodyState('candidate-switch-disabled')
}

/** Internal/public constructor for a typed unsafe verdict. */
export function unsafeBodyState(detail: BodyStateUnsafeDetail): BodyStateSafety {
  return { safe: false, reason: 'body-state-unsafe', detail }
}

/** Actionable explanation for a `body-state-unsafe` refusal. */
export function bodyStateUnsafeMessage(detail: BodyStateUnsafeDetail): string {
  switch (detail) {
    case 'card-unreadable':
      return 'the character card could not be read, so body state cannot be inspected; body mutations are disabled'
    case 'chat-unreadable':
      return 'the bound chat could not be read, so body state cannot be inspected; body mutations are disabled'
    case 'safety-unavailable':
      return 'the MVU state safety check could not be resolved; body mutations are disabled'
    case 'mvu-receipt-missing':
      return 'the old body applies MVU variables but has no matching receipt; regenerating it would apply the patches twice and cannot be rolled back'
    case 'write-journal-missing':
      return 'the old turn wrote memory or variables without a complete write journal; regeneration cannot roll those writes back'
    case 'write-journal-unavailable':
      return 'this host does not expose appendPluginRecord, so memory and variable writes cannot be journaled or rolled back'
    case 'edit-rollback-unavailable':
      return 'this chat already carries MVU or variable state; editing a body has no candidate-level rollback'
    case 'select-rollback-unavailable':
      return 'this chat already carries MVU or variable state; switching a body candidate has no candidate-level rollback'
    case 'candidate-switch-disabled':
      return 'switching body candidates over MVU or variable history is disabled in this build until candidate-aware regeneration lands; edit the selected body or regenerate instead'
    case 'body-receipt-missing':
      return 'the body candidate carries an <UpdateVariable> patch but has no candidate receipt to undo; restore or migrate its receipt before editing, do not retry blindly'
    case 'body-receipt-duplicate':
      return 'the body candidate has more than one live candidate receipt carrying variable changes; repair the receipt set before editing'
    case 'body-receipt-legacy':
      return 'the body candidate has a legacy body:<messageId> receipt that the ledger cannot map to a unique slot; migrate or repair the receipt key before editing'
    case 'body-receipt-key-mismatch':
      return 'the body candidate receipt key does not match the ledger slot or message id; repair the receipt keys before editing'
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
  /** True when this card/chat carries MVU or historical variable state. */
  readonly historicalMvuState: boolean
  /** True when `deps.writeRollback` can prepare/restore a regeneration. */
  readonly writeRollbackAvailable: boolean
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
  /** Concrete gate detail when one action is blocked but the body is readable. */
  readonly detail?: BodyStateUnsafeDetail
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

  const baseReason = bodyViewReason(input, hidden)
  // Proposal 0023 §6.3: edit is gated by the runtime candidate-receipt
  // preflight, so historical MVU state no longer hides it. Regeneration still
  // needs the write rollback port, and candidate switching stays closed in P0.
  const rollbackReason = baseReason === undefined
    && !hidden
    && input.historicalMvuState
    && !input.writeRollbackAvailable
    ? 'write-journal-unavailable'
    : undefined
  const reason = baseReason ?? rollbackReason
  const canEdit = baseReason === undefined && !hidden && count > 0
  const canRegenerate = baseReason === undefined
    && !hidden
    && count > 0
    && input.agent !== undefined
    && canAdvanceHostTurnBase(input.agent)
    && (!input.historicalMvuState || input.writeRollbackAvailable)
  const canSelect = canEdit && count > 1 && !input.historicalMvuState
  const detail = baseReason === undefined && !hidden && count > 0 && input.historicalMvuState
    ? 'candidate-switch-disabled'
    : undefined

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
    ...(detail === undefined ? {} : { detail }),
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
  /** Concrete `body-state-unsafe` signal, when the failure carries one. */
  readonly detail?: string
}

/**
 * Map one body runtime failure onto proposal §11 rejection codes and an HTTP
 * status. Runtime-only codes are folded into the closest public code so clients
 * never need to know internal state-machine names.
 */
export function bodyFailureOf(error: unknown): BodyFailureView {
  const rawCode = failureCodeOf(error)
  const code = publicBodyCode(rawCode)
  const detail = failureDetailOf(error) ?? candidateReceiptDetailOf(rawCode)
  return {
    status: bodyRejectStatus(code),
    code,
    message: errorMessage(error),
    ...(detail === undefined ? {} : { detail }),
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
    case 'body-receipt-missing':
    case 'body-receipt-duplicate':
    case 'body-receipt-legacy':
    case 'body-receipt-key-mismatch':
      return 'body-state-unsafe'
    case 'body-floor-not-found':
      return 'projection-pending'
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

function failureDetailOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const detail = error['detail']
  return typeof detail === 'string' && detail !== '' ? detail : undefined
}

/**
 * `CandidateReceiptError` carries the concrete receipt refusal in `code` and
 * has no separate `detail` member (proposal 0023 §3.3). Surface that code as
 * the public detail so a 409 keeps `body-receipt-missing` and friends.
 */
function candidateReceiptDetailOf(code: string | undefined): string | undefined {
  switch (code) {
    case 'body-receipt-missing':
    case 'body-receipt-duplicate':
    case 'body-receipt-legacy':
    case 'body-receipt-key-mismatch':
      return code
    default:
      return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
