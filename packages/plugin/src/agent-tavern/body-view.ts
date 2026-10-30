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
import { inspectCandidateReceipts } from './body-candidate-receipts.js'
import type { BodyAgentLike } from './body-runtime.js'
import { cardUsesJsrMvu } from './mvu-compat.js'
import { publicErrorMessage } from '../http/public-error.js'
import {
  bodyBindingEligible,
  isRecord,
  type BodyAnchorInspection,
  type BodyBindingView,
  type BodyLastOperation,
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
  /** A journal holds only a `before` record and the store cannot prove whether the write landed. */
  | 'write-journal-unknown'
  /** Legacy alias kept for old clients (proposal 0023 §6.4). */
  | 'edit-rollback-unavailable'
  /** Legacy alias kept for old clients (proposal 0023 §6.4). */
  | 'select-rollback-unavailable'
  | 'candidate-switch-disabled'
  | 'body-receipt-missing'
  | 'body-receipt-duplicate'
  | 'body-receipt-legacy'
  | 'body-receipt-key-mismatch'
  /** One body group is bound to more than one chat floor, so read and edit disagree. */
  | 'body-group-mismatch'
  /** The JSONL floor lookup failed for this message; only the ledger body is shown. */
  | 'body-floor-unreadable'

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
    case 'write-journal-unknown':
      return 'a write journal holds only a before record and the store cannot prove whether that write landed; regeneration cannot safely roll it back'
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
    case 'body-group-mismatch':
      return 'one body group is bound to more than one chat floor, so the displayed body and the edit target disagree; repair the duplicated floor binding before editing'
    case 'body-floor-unreadable':
      return 'the chat floor for this body could not be resolved, so only the ledger body is shown; retry after the projection catches up'
  }
}

/* ------------------------------ edit detail ------------------------------ */

/**
 * Read-only candidate-receipt verdict for the body that `GET body` will edit.
 *
 * Editing always targets the ledger's selected candidate, never the requested
 * message id, so an anchor row whose id belongs to candidate 0 is judged by the
 * candidate the `PUT` preflight would actually inspect. The previous text comes
 * from the ledger exactly like the runtime preflight does
 * (`edits.get(index) ?? candidates[index].text`).
 *
 * Returns `undefined` when the card is not JSR MVU, the ledger has no selected
 * candidate, or the card cannot be read: non-MVU and cold sessions keep the
 * 0021 optimistic gate instead of inventing a refusal.
 */
export function bodyEditDetailOf(
  card: CharacterCardIR,
  chat: ChatLogIR,
  ledger: BodyLedger,
): BodyStateUnsafeDetail | undefined {
  const candidate = ledger.candidates[ledger.selectedIndex]
  if (candidate === undefined) return undefined

  let mvu: boolean
  try {
    mvu = cardUsesJsrMvu(card)
  } catch {
    // An unreadable card already reaches the client as `card-unreadable`
    // through state safety; the receipt gate must not publish a second reason.
    return undefined
  }
  if (!mvu) return undefined

  const inspection = inspectCandidateReceipts(
    chat,
    { messageId: candidate.messageId, index: candidate.index },
    ledger,
    ledger.edits.get(candidate.index) ?? candidate.text,
    card,
  )
  return inspection.detail
}

/* ------------------------------- body view --------------------------------- */

/** JSONL-side projection facts resolved by the HTTP layer (display text included). */
export interface BodyProjectedFloor {
  readonly groupId?: string
  readonly anchorMessageId?: string
  readonly selectedIndex?: number
  readonly count?: number
  readonly text?: string
  /** Sequence of the last body event this floor applied (edits only). */
  readonly lastBodyEventSeq?: number
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
  /**
   * Whether the JSONL floor already reflects the ledger's latest edit and
   * selection. A false value marks `projectionPending` and may make the ledger
   * text win, so a just-edited body never shows old text.
   */
  readonly projectionCurrent?: boolean
  /**
   * Whether the projected text itself may be used. A stale selection is safe
   * (the caller resolved the selected swipe text); a stale floor is not.
   */
  readonly projectionTextCurrent?: boolean
  readonly inspection: BodyAnchorInspection | undefined
  /**
   * Read-only candidate-receipt verdict from {@link bodyEditDetailOf}. When
   * present, `canEdit` is false and this detail replaces the generic
   * `candidate-switch-disabled` signal.
   */
  readonly editDetail?: BodyStateUnsafeDetail
  /**
   * Caller-derived edit gate that already folded the receipt verdict or a
   * degraded floor read. It wins over `editDetail` so the outer check keeps its
   * more specific reason.
   */
  readonly canEditDetail?: BodyStateUnsafeDetail
  /**
   * Gate detail of a degraded read (a duplicated floor binding or an unreadable
   * floor). Unlike `canEditDetail` it is published as `detail` even when another
   * reason already closes the actions, so the damaged-data signal is never lost.
   */
  readonly readDetail?: BodyStateUnsafeDetail
  /**
   * Latest aborted, failed or cancelled operation folded from the session log.
   * Display-only: it never changes a gate or the stable empty-body default.
   */
  readonly lastOperation?: BodyLastOperation
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
  /**
   * The JSONL floor has not applied the ledger's latest edit/selection yet;
   * `text` comes from the ledger or the selected swipe rather than the floor's
   * current `mes`.
   */
  readonly projectionPending?: boolean
  readonly reason?: string
  /** Concrete gate detail when one action is blocked but the body is readable. */
  readonly detail?: BodyStateUnsafeDetail
  /** Latest aborted, failed or cancelled operation; absent when none is recorded. */
  readonly lastOperation?: BodyLastOperation
}

/**
 * Build the `GET body` payload.
 *
 * JSONL display text wins (it already carries markdownOnly regex scripts); the
 * ledger supplies selection, candidate count and the text fallback. A message
 * the plugin has never projected yields a stable empty body instead of an
 * error, so cold sessions and freshly written turns still render normally.
 *
 * `canEdit` requires both the base gate and an open `editDetail` /
 * `canEditDetail`; `canSelect` still derives from `canEdit` and the historical
 * MVU refusal, and `canRegenerate` keeps its rollback-port rule.
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
  // A floor that has not applied the latest edit must not win the read: the
  // ledger is authoritative and already carries the text the user just saved.
  // A stale *selection* is different: the caller resolved the selected swipe's
  // save-layer text, so that projected text stays valid.
  const textCurrent = input.projectionTextCurrent !== false
  const projectedText = textCurrent ? input.projected?.text : undefined
  const text = hidden
    ? candidateText ?? input.messageText ?? ''
    : projectedText ?? ledgerText ?? input.messageText ?? ''

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
  // Proposal 0023 §6.3: the read side publishes the same receipt verdict the
  // `PUT` preflight enforces, so a missing/duplicate/legacy/mismatched receipt
  // closes edit here instead of failing after the user opens the editor. A
  // degraded read outranks it and is published even when another reason gates
  // the body.
  const editGate = input.readDetail ?? input.canEditDetail ?? input.editDetail
  const baseEditable = baseReason === undefined && !hidden && count > 0
  const canEdit = baseEditable && editGate === undefined
  // A degraded read (ambiguous or unreadable floor binding) closes
  // regeneration too: the target the runtime would regenerate against is a
  // guess, and a failure mid-flight would leave its restore pending. Receipt
  // verdicts (`editDetail`) stay regenerate-compatible — the runtime's own
  // regenerate preflight enforces them and reports its own 409.
  const canRegenerate = baseReason === undefined
    && !hidden
    && count > 0
    && input.readDetail === undefined
    && input.agent !== undefined
    && canAdvanceHostTurnBase(input.agent)
    && (!input.historicalMvuState || input.writeRollbackAvailable)
  const canSelect = canEdit && count > 1 && !input.historicalMvuState
  const detail = baseEditable
    ? editGate ?? (input.historicalMvuState ? 'candidate-switch-disabled' : undefined)
    : input.readDetail

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
    ...(input.projectionCurrent === false ? { projectionPending: true } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(input.lastOperation === undefined ? {} : { lastOperation: publicLastOperation(input.lastOperation) }),
  }
}

/**
 * The view is the HTTP boundary for the recorded operation reason.
 *
 * The runtime stores the full failure text (`errorMessage` of the original
 * error, which for filesystem failures embeds absolute paths and internal file
 * names) because that detail is what log-side diagnostics need. Only the
 * outbound copy collapses through the shared error classifier
 * (`publicErrorMessage`), so a stored reason can never leak what
 * http/public-error.ts keeps out of every other response body. A clean,
 * human-readable reason passes through unchanged.
 */
function publicLastOperation(operation: BodyLastOperation): BodyLastOperation {
  return { ...operation, reason: publicErrorMessage(operation.reason) }
}

function bodyViewReason(input: BodyViewInput, hidden: boolean): string | undefined {
  if (!bodyBindingEligible(input.binding)) return 'architecture-mismatch'
  if (input.stateSafety !== undefined && !input.stateSafety.safe) return 'body-state-unsafe'
  if (input.agent === undefined) return 'session-busy'
  if (input.agent.status !== 'idle') return 'session-busy'
  if (!input.hostSupported) return 'host-unsupported'
  if (hidden) return undefined
  if (input.messageText === undefined && input.ledger === undefined && input.projected === undefined) return undefined
  // A missing surface read is a host/log shape problem, never evidence that an
  // agent is running: `session-busy` stays reserved for a live non-idle agent.
  if (input.inspection === undefined) return 'host-unsupported'
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
 *
 * Internal data/state failures (missing swipes, slot gaps, ledger seq damage)
 * publish `body-state-unsafe` (409) and keep the original code as `detail`: a
 * client can tell "wait for the projection" (503 `projection-pending`) from
 * "this body data is inconsistent" (409) without parsing the message. Only an
 * unknown exception stays a 500 `operation-failed`. The message crosses the
 * HTTP boundary, so it goes through `publicErrorMessage`: infrastructure text
 * (paths, internal file names, filesystem codes) collapses to the stable
 * internal message, matching the `lastOperation.reason` boundary above.
 */
export function bodyFailureOf(error: unknown): BodyFailureView {
  const rawCode = failureCodeOf(error)
  const failure = publicBodyFailure(rawCode)
  const detail = failureDetailOf(error) ?? failure.detail
  return {
    status: bodyRejectStatus(failure.code),
    code: failure.code,
    message: publicErrorMessage(errorMessage(error)),
    ...(detail === undefined ? {} : { detail }),
  }
}

/** Public code plus the internal code kept as its client-facing detail. */
interface BodyPublicFailure {
  readonly code: string
  readonly detail?: string
}

/** Proposal §11 code for an arbitrary failure. */
export function publicBodyCode(code: string | undefined): string {
  return publicBodyFailure(code).code
}

function publicBodyFailure(code: string | undefined): BodyPublicFailure {
  switch (code) {
    case undefined:
      return { code: 'operation-failed' }
    case 'architecture-mismatch':
    case 'session-busy':
    case 'not-last-round':
    case 'stale-anchor':
    case 'body-compacted':
    case 'body-state-unsafe':
    case 'invalid-body-text':
    case 'host-unsupported':
    case 'projection-pending':
      return { code }
    case 'invalid-arguments':
      return { code: 'invalid-body-text' }
    case 'restore-unavailable':
      return { code: 'body-state-unsafe' }
    case 'body-receipt-missing':
    case 'body-receipt-duplicate':
    case 'body-receipt-legacy':
    case 'body-receipt-key-mismatch':
      // CandidateReceiptError carries the concrete refusal in `code` and has
      // no separate `detail` member (proposal 0023 §3.3).
      return { code: 'body-state-unsafe', detail: code }
    case 'body-floor-not-found':
      // The floor is written asynchronously; retry after the projection lands.
      return { code: 'projection-pending' }
    case 'operation-failed':
      return { code }
    default:
      return isBodyDataStateCode(code)
        ? { code: 'body-state-unsafe', detail: code }
        : { code: 'operation-failed' }
  }
}

/**
 * Internal codes that describe damaged or unreplayable body data.
 *
 * These are known state failures, not unknown exceptions: retrying the same
 * request cannot succeed until the data or projection is repaired.
 */
function isBodyDataStateCode(code: string): boolean {
  switch (code) {
    case 'invalid-event':
    case 'invalid-body-event':
    case 'invalid-body-op':
    case 'invalid-body-seq':
    case 'invalid-body-group-id':
    case 'invalid-body-message-id':
    case 'invalid-body-index':
    case 'invalid-body-send-date':
    case 'body-candidate-gap':
    case 'body-candidate-message-missing':
    case 'body-swipes-missing':
    case 'body-index-mismatch':
    case 'body-index-out-of-range':
    case 'body-swipe-info-invalid':
    case 'body-adoption-mismatch':
    case 'body-group-mismatch':
      return true
    default:
      return false
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
      return isBodyDataStateCode(code) ? 409 : 500
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
