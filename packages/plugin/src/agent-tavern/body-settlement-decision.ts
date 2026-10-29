/**
 * Body settlement decision and settled-completion helpers.
 *
 * A `settling` record is written before the previous body leaves the surface.
 * Settlement can replace several surface ranges, so a crash between two
 * replacements leaves the operation partially hidden. Recovery therefore
 * resolves the durable marker against the current surface and the folded
 * ledger before it is allowed to write `op-settled` or `op-finish`:
 *
 * - `settled`: every hide target is gone, the new candidate is visible and
 *   committed; only the bookkeeping finish is missing.
 * - `finish-hide`: the new candidate is committed and visible, but any hide
 *   target (trigger/process range or the previous anchor range) is still on the
 *   surface; recovery removes exactly those remaining targets and then finishes.
 * - `cancelled`: the previous anchor never left the surface and the previous
 *   selection is durable; recovery must restore.
 * - `ambiguous`: the surface and ledger disagree; recovery must not guess.
 */

import type { BodyLedger, BodySettlementTargets } from './body.js'
import {
  appendBodyEvent,
  appendOpFinish,
  appendSettleCancelledMarker,
  bodyRuntimeError,
  errorMessage,
  releaseSettlement,
  warn,
  type BodyRuntimeDeps,
  type BodyRuntimeFailure,
  type BodySettledMarker,
  type BodySettlementEvidence,
  type FinalizeTurnStoppingResult,
  type PendingBodyOperation,
  type SettlementContext,
} from './body-runtime-core.js'
import {
  eventAtSeq,
  eventsOf,
  findSurfaceSeqByMessageId,
  messageOf,
  sourceOf,
  surfaceNodeList,
  triggerMessageIdOf,
  turnOfUserMessage,
  type RuntimeEvent,
} from './body-runtime-session.js'
import {
  bodyLedger,
  hideTargets,
  oldAnchorSurfaceTargets,
} from './body-runtime-state.js'

/** Outcome of resolving one durable `settling` record. */
export type SettlingDecision = 'settled' | 'finish-hide' | 'cancelled' | 'ambiguous'

/**
 * Resolve a `settling` record left by a crash between the pre-hide marker and
 * the post-hide marker.
 *
 * `settled` requires every hide target to be off the surface, so a partially
 * applied multi-range hide can never be mistaken for a completed body
 * replacement. `finish-hide` requires the ledger to have committed the new
 * candidate and that candidate to be visible, but tolerates any surviving hide
 * range: the hide may have stopped after the trigger/process range, leaving only
 * the previous anchor, and vice versa. Legacy records without targets fall back
 * to the operation's trigger id and previous anchor id instead of failing
 * closed.
 */
export function settlingDecision(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  evidence: BodySettlementEvidence,
): SettlingDecision {
  const ledger = settlementLedger(deps, op.groupId, evidence)
  const events = eventsOf(deps.session)
  const surface = surfaceNodeList(deps.session)
  const previousVisible = findSurfaceSeqByMessageId(events, surface, op.previousAnchorId) !== undefined
  const candidateVisible = findSurfaceSeqByMessageId(events, surface, evidence.anchorId) !== undefined
  const committed = ledger.selectedIndex === evidence.index && ledger.anchorMessageId === evidence.anchorId
  if (!previousVisible && candidateVisible && committed) {
    const remaining = settlementRemainingTargets(events, surface, op, evidence)
    return remaining.length === 0 ? 'settled' : 'finish-hide'
  }
  if (previousVisible && ledger.selectedIndex === op.previousIndex) return 'cancelled'
  if (candidateVisible && committed && settlementRemainingTargets(events, surface, op, evidence).length > 0) {
    return 'finish-hide'
  }
  return 'ambiguous'
}

/**
 * Hide target ids of one settlement attempt.
 *
 * A new marker carries both ids; a legacy marker is resolved from the
 * operation so older logs stay recoverable. A marker whose ids disagree with
 * its operation is damaged evidence, not a legacy record, and fails closed.
 */
export function settlementTargetsOf(op: PendingBodyOperation, evidence: BodySettlementEvidence): BodySettlementTargets {
  const expectedTriggerId = triggerMessageIdOf(op)
  const targets = evidence.targets
  if (targets === undefined) {
    return { triggerMessageId: expectedTriggerId, previousAnchorId: op.previousAnchorId }
  }
  if (targets.triggerMessageId !== expectedTriggerId || targets.previousAnchorId !== op.previousAnchorId) {
    throw bodyRuntimeError(
      'invalid-event',
      `body settlement record for '${evidence.anchorId}' carries hide targets trigger '${targets.triggerMessageId}' / anchor '${targets.previousAnchorId}', but operation '${op.opId}' expects trigger '${expectedTriggerId}' / anchor '${op.previousAnchorId}'; refusing to trust it`,
    )
  }
  return targets
}

/** Turn that owns the settling trigger; `op.turn` covers a live operation. */
export function settlementTurnOf(
  events: readonly RuntimeEvent[],
  op: PendingBodyOperation,
  evidence: BodySettlementEvidence,
): number | undefined {
  return turnOfUserMessage(events, settlementTargetsOf(op, evidence).triggerMessageId) ?? op.turn
}

/**
 * Surface nodes the settlement still has to remove.
 *
 * The set is derived from the current surface, so ranges that were already
 * replaced are absent and a repeated finish-hide is a no-op. Empty developer
 * `body-hide` markers are excluded: they are the result of an earlier hide
 * step and hiding them again would only append bookkeeping noise.
 */
export function settlementRemainingTargets(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  op: PendingBodyOperation,
  evidence: BodySettlementEvidence,
): number[] {
  const targets = settlementTargetsOf(op, evidence)
  const turn = settlementTurnOf(events, op, evidence)
  const remaining = new Set<number>()
  if (turn === undefined) {
    const triggerSeq = findSurfaceSeqByMessageId(events, surface, targets.triggerMessageId)
    if (triggerSeq !== undefined) remaining.add(triggerSeq)
  } else {
    for (const seq of hideTargets(events, surface, targets.triggerMessageId, turn, evidence.anchorId)) {
      remaining.add(seq)
    }
  }
  for (const seq of oldAnchorSurfaceTargets(events, surface, targets.previousAnchorId)) remaining.add(seq)
  return [...remaining]
    .filter((seq) => !isBodyHideMarker(eventAtSeq(events, seq)))
    .sort((left, right) => left - right)
}

/** True for the empty developer replacement a body hide leaves on the surface. */
export function isBodyHideMarker(event: RuntimeEvent): boolean {
  if (event.type !== 'developer/message') return false
  const message = messageOf(event)
  return message !== undefined && sourceOf(message)?.form === 'body-hide'
}

/**
 * Complete an operation whose body settlement is already durable.
 *
 * Only `op-finish` is written: candidate/select/hide already happened, and any
 * body restore here would either resurrect the old anchor or duplicate the new
 * one. A failed finish keeps the durable `op-start` pending for the next
 * recovery pass and surfaces a recognizable `settled-finish-pending` error.
 */
export function finishSettledOperation(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  settled: BodySettlementEvidence,
): FinalizeTurnStoppingResult {
  // The marker is recovery evidence, not authority: it must still describe the
  // group's committed candidate slot. A damaged marker fails closed instead of
  // keeping a body the ledger never selected.
  assertCommittedSettlement(deps, context.op.groupId, settled, `${context.label} ${context.op.opId}`)
  try {
    appendOpFinish(deps, context.op.opId, 'ok', settled.anchorId, undefined)
  } catch (error) {
    releaseSettlement(deps, context)
    const reason = `${context.label} ${context.op.opId} already settled '${settled.anchorId}' but failed to record op-finish: ${errorMessage(error)}`
    warn(deps, reason)
    throw settledFinishPending(reason, context.op, error)
  }
  releaseSettlement(deps, context)
  return { status: 'ok', anchorMessageId: settled.anchorId }
}

/** Durable settled evidence whose `op-finish` still cannot be written. */
export function settledFinishPending(reason: string, op: PendingBodyOperation, cause: unknown): BodyRuntimeFailure {
  const failure = bodyRuntimeError('settled-finish-pending', reason)
  if (cause instanceof Error) failure.cause = cause
  failure.op = op
  return failure
}

/** Fold the ledger and prove the evidence points at one real candidate slot. */
export function settlementLedger(
  deps: BodyRuntimeDeps,
  groupId: string,
  evidence: BodySettlementEvidence,
): BodyLedger {
  if (evidence.groupId !== groupId) {
    throw bodyRuntimeError(
      'invalid-event',
      `body settlement record for '${evidence.anchorId}' belongs to group '${evidence.groupId}', not '${groupId}'`,
    )
  }
  const ledger = bodyLedger(eventsOf(deps.session), groupId)
  if (ledger === undefined) {
    throw bodyRuntimeError('invalid-event', `body settlement record references group '${groupId}' with no body ledger`)
  }
  const candidate = ledger.candidates[evidence.index]
  if (candidate === undefined || candidate.messageId !== evidence.anchorId) {
    throw bodyRuntimeError(
      'invalid-event',
      `body settlement record points at anchor '${evidence.anchorId}' index ${evidence.index}, but group '${groupId}' has ${candidate === undefined ? 'no candidate at that index' : `candidate '${candidate.messageId}'`}; refusing to trust it`,
    )
  }
  return ledger
}

/** Require the evidence to be the group's currently selected candidate. */
export function assertCommittedSettlement(
  deps: BodyRuntimeDeps,
  groupId: string,
  evidence: BodySettlementEvidence,
  subject: string,
): void {
  const ledger = settlementLedger(deps, groupId, evidence)
  if (ledger.selectedIndex !== evidence.index || ledger.anchorMessageId !== evidence.anchorId) {
    throw bodyRuntimeError(
      'invalid-event',
      `${subject}: settlement record '${evidence.anchorId}' index ${evidence.index} is not the committed selection (selected ${ledger.selectedIndex}, anchor '${ledger.anchorMessageId}'); refusing to trust it`,
    )
  }
}

/** Best-effort durable cancellation; a failed record is logged, not masked. */
export function recordSettlementCancelled(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  label: string,
  evidence: BodySettledMarker,
  reason: string,
): void {
  try {
    appendSettleCancelledMarker(deps, op.opId, op.groupId, evidence.anchorId, evidence.index, reason)
  } catch (error) {
    warn(deps, `body runtime: ${label} ${op.opId} could not record the cancelled settlement: ${errorMessage(error)}`)
  }
}

/**
 * Point the body ledger back at the previous candidate after a settlement step
 * failed while the previous anchor was still visible.
 */
export function restorePreviousSelection(deps: BodyRuntimeDeps, context: SettlementContext): void {
  try {
    appendBodyEvent(deps, { op: 'select', groupId: context.op.groupId, index: context.op.previousIndex })
  } catch (selectError) {
    warn(deps, `body runtime: failed to restore previous body selection for ${context.op.opId}: ${errorMessage(selectError)}`)
  }
}
