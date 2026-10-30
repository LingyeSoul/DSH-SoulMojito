/**
 * Body operation settlement and restore.
 *
 * `finalizeTurnStopping` and `finalizeRecoveredOperation` share
 * `settleBodyOperation`. Settlement is two-phase: `settling` lands before the
 * hide, `settled` after it, and a failed hide writes a cancellation record.
 * Any settlement that cannot commit a candidate records the same cancellation
 * and keeps `op-start` pending: every branch runs after the old writes were
 * rolled back, so a terminal `op-finish failed` would strand them. Recovery
 * trusts `settled` (or a `settling` record whose surface/ledger state proves
 * the hide completed) only for `op-finish`; a `settling` record whose hide
 * stopped after some ranges has exactly its remaining targets hidden before it
 * is finished. A cancellation restores the previous body. The legacy
 * `body-restore-*` copy stays reachable only for sessions with no settlement
 * evidence at all.
 */

import { randomUUID } from 'node:crypto'
import { advanceHostTurnBase, lastLoggedTurn } from '../session/trace.js'
import { mvuReceiptsForBody, undoMvuReceipts } from '../mvu.js'
import {
  appendBodyEvent,
  appendOpFinish,
  appendSettledMarker,
  appendSettlingMarker,
  assertCanAdvanceTurnBase,
  assertRecordWriter,
  bodyRuntimeError,
  errorMessage,
  failureFor,
  operationView,
  pendingByAgent,
  recoveryAgentId,
  releaseOperationByOp,
  releaseSettlement,
  releaseSettlementRestriction,
  requirePositiveTurn,
  requireRecordWriter,
  settlementEvidenceOf,
  validateFinalizePayload,
  validatePendingOperation,
  warn,
  withBodyLock,
  type BodyRuntimeDeps,
  type BodyRuntimeTurnRollback,
  type BodySettlementEvidence,
  type BodySettledEventLike,
  type FinalizeTurnStoppingResult,
  type PendingBodyOperation,
  type SettlementContext,
} from './body-runtime-core.js'
import {
  assertCommittedSettlement,
  finishSettledOperation,
  isBodyHideMarker,
  recordSettlementCancelled,
  restorePreviousSelection,
  settledFinishPending,
  settlementRemainingTargets,
  settlementTurnOf,
  settlingDecision,
} from './body-settlement-decision.js'
import type { BodyLedger } from './body.js'
import {
  eventAtSeq,
  eventsOf,
  findEventByMessageId,
  findSurfaceSeqByMessageId,
  lastBodyCandidate,
  messageOf,
  modelSourceOf,
  numberField,
  openTurnNumber,
  operationFinished,
  surfaceNodeList,
  textOfMessage,
  triggerMessageIdOf,
  turnOfEventSeq,
  turnOfUserMessage,
} from './body-runtime-session.js'
import {
  appendDeveloperHide,
  appendHideInBridgeTurn,
  appendHideInOpenTurn,
  bodyLedger,
  closeBracketBestEffort,
  hideTargets,
  oldAnchorSurfaceTargets,
  restoreAssistantData,
  surfaceRanges,
} from './body-runtime-state.js'

/**
 * Durable close record for an operation that ended by restoring the previous
 * body (proposal 0021 §9.2, revision 2026-10-29).
 *
 * `op-finish` stays the terminal record of a completed body replacement (or a
 * fully compensated failure). `op-abort` is the terminal record of an
 * operation whose new body was rolled back and whose previous body is back on
 * the surface. `foldPendingOps` closes an operation only on one of these two
 * records; a bare cancellation marker still means "restore pending".
 */
export const BODY_ABORT_EVENT_TYPE = 'plugin:dsh-soulmojito/body-abort' as const

/** Payload of the durable abort (restored) terminal record. */
export interface BodyAbortEventData {
  readonly op: 'op-abort'
  readonly opId: string
  /** Actionable cause of the restore; kept for the read side and diagnostics. */
  readonly reason: string
  /** Body that is back on the surface after the restore. */
  readonly anchorId?: string
}

/**
 * Append the terminal record of an operation that was aborted and restored.
 *
 * Callers write it only after the new-turn writes, the old plan and the
 * previous body are back. A failed append keeps the operation pending, so the
 * next recovery pass can retry the restore idempotently.
 */
export function appendOpAbort(
  deps: BodyRuntimeDeps,
  opId: string,
  reason: string,
  anchorId: string | undefined,
): void {
  const data: BodyAbortEventData = {
    op: 'op-abort',
    opId,
    reason,
    ...(anchorId === undefined ? {} : { anchorId }),
  }
  requireRecordWriter(deps)(deps.session, BODY_ABORT_EVENT_TYPE, data)
}

/**
 * Strictly read one abort record.
 *
 * `undefined` means the event is not an abort record; a malformed abort payload
 * throws `invalid-event` so recovery never silently drops the only terminal
 * record of an operation.
 */
export function parseAbortEvent(event: BodySettledEventLike): BodyAbortEventData | undefined {
  if (event.type !== BODY_ABORT_EVENT_TYPE) return undefined
  const op = event.data.op
  if (op !== 'op-abort') {
    throw bodyRuntimeError(
      'invalid-event',
      `body abort record at seq ${event.seq} has op '${String(op)}', expected 'op-abort'`,
    )
  }
  const anchorId = event.data.anchorId
  if (anchorId !== undefined && (typeof anchorId !== 'string' || anchorId === '')) {
    throw bodyRuntimeError(
      'invalid-event',
      `body abort record at seq ${event.seq} requires anchorId to be a non-empty string when present`,
    )
  }
  return {
    op,
    opId: abortString(event.data.opId, event.seq, 'opId'),
    reason: abortString(event.data.reason, event.seq, 'reason'),
    ...(anchorId === undefined ? {} : { anchorId }),
  }
}

/** Last abort record of one operation, if any. */
export function abortedOperation(
  events: readonly BodySettledEventLike[],
  opId: string,
): BodyAbortEventData | undefined {
  let found: BodyAbortEventData | undefined
  for (const event of events) {
    const abort = parseAbortEvent(event)
    if (abort !== undefined && abort.opId === opId) found = abort
  }
  return found
}

function abortString(value: unknown, seq: number, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw bodyRuntimeError('invalid-event', `body abort record at seq ${seq} requires ${field} to be a non-empty string`)
  }
  return value
}

/**
 * Settle the pending regeneration at `agent/turn-stopping`.
 *
 * The last assistant message in the turn that carries text and no tool call
 * becomes the new selected candidate. The synthetic trigger, every process
 * node of the turn and the previous body anchor (with its old turn process
 * nodes) are then replaced with empty developer messages. The new candidate
 * itself stays on the surface.
 */
export async function finalizeTurnStopping(
  deps: BodyRuntimeDeps,
  payload: { agentId: string; turn: number },
): Promise<FinalizeTurnStoppingResult> {
  validateFinalizePayload(payload)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
    const active = pendingByAgent.get(payload.agentId)
    if (active === undefined) {
      return { status: 'skipped', reason: `no pending body operation for agent '${payload.agentId}'` }
    }
    const triggerTurn = turnOfUserMessage(events, active.triggerMessageId)
    if (triggerTurn !== payload.turn) {
      return {
        status: 'skipped',
        reason: `pending body operation ${active.opId} belongs to trigger turn ${String(triggerTurn)}, not turn ${payload.turn}`,
      }
    }
    active.turn = payload.turn
    return settleBodyOperation(deps, {
      agentId: active.agentId,
      op: operationView(active),
      label: 'body regenerate',
      release: active.release,
      deferHide: true,
    }, payload.turn)
  })
}

/**
 * Settle an operation reconstructed from the durable log at startup.
 *
 * Unlike `finalizeTurnStopping`, this path has no in-process operation map or
 * tool restriction to release. It reuses the same settlement helper, so the
 * recovered turn also hides its trigger/process nodes before `op-finish`. An
 * operation that already carries a settled marker only records `op-finish`.
 */
export async function finalizeRecoveredOperation(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  turn: number,
): Promise<FinalizeTurnStoppingResult> {
  validatePendingOperation(op)
  requirePositiveTurn(turn, 'recovered.turn')
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const agentId = recoveryAgentId(deps, op)
    const events = eventsOf(deps.session)
    if (operationFinished(events, op.opId)) {
      releaseSettlement(deps, { agentId, op, label: 'body recovery', release: undefined })
      return { status: 'skipped', reason: `body recovery '${op.opId}' already has op-finish` }
    }
    const triggerTurn = turnOfUserMessage(events, triggerMessageIdOf(op))
    if (triggerTurn !== undefined && triggerTurn !== turn) {
      return {
        status: 'skipped',
        reason: `body recovery '${op.opId}' trigger belongs to turn ${triggerTurn}, not turn ${turn}`,
      }
    }
    return settleBodyOperation(deps, { agentId, op, label: 'body recovery', release: undefined }, turn)
  })
}

async function settleBodyOperation(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  turn: number,
): Promise<FinalizeTurnStoppingResult> {
  const events = eventsOf(deps.session)
  const evidence = settlementEvidenceOf(events, context.op.opId)
  if (evidence !== undefined) {
    if (evidence.phase === 'settled') {
      // A previous attempt already hid the old anchor and selected the new
      // body; only `op-finish` is missing. Re-doing candidate/select/hide
      // would append a second settlement and could resurrect the previous body.
      return finishSettledOperation(deps, context, evidence)
    }
    if (evidence.phase === 'cancelled') {
      // The hide failed and the cancellation is already durable; the previous
      // body must be restored, never treated as settled. The terminal record is
      // written only after the restore (or a later recovery pass) succeeds.
      return restoreCancelledSettlement(
        deps,
        context,
        `${context.label} ${context.op.opId} was cancelled before its previous anchor left the surface: ${evidence.reason ?? 'no reason recorded'}`,
        evidence,
      )
    }
    if (context.deferHide === true) {
      // A repeated live turn-stopping edge must keep the deferred contract: the
      // answer turn never opens a hide step, and the turn/end chain finishes.
      return { status: 'ok', anchorMessageId: evidence.anchorId }
    }
    return settleFromSettlingEvidence(deps, context, evidence)
  }
  const candidate = lastBodyCandidate(events, turn)
  if (candidate === undefined) {
    return failSettlement(
      deps,
      context,
      settlementFailureReason(context, turn, 'produced no assistant message with text and no tool-call'),
      {},
    )
  }
  const surface = surfaceNodeList(deps.session)
  if (!surface.includes(candidate.seq)) {
    return failSettlement(
      deps,
      context,
      settlementFailureReason(context, turn, `candidate '${candidate.messageId}' is not on the current surface`),
      {},
    )
  }
  let ledger = bodyLedger(events, context.op.groupId)
  if (ledger === undefined) {
    if (context.op.previousIndex !== 0) {
      return failSettlement(
        deps,
        context,
        settlementFailureReason(
          context,
          turn,
          `has no candidate 0 recorded at previous index ${context.op.previousIndex}, so the previous selection cannot be reconstructed`,
        ),
        {},
      )
    }
    try {
      appendBodyEvent(deps, {
        op: 'candidate',
        groupId: context.op.groupId,
        messageId: context.op.previousAnchorId,
        index: 0,
      })
    } catch (error) {
      return failSettlement(
        deps,
        context,
        settlementFailureReason(context, turn, `failed to seed candidate 0: ${errorMessage(error)}`),
        { cause: error },
      )
    }
    ledger = bodyLedger(eventsOf(deps.session), context.op.groupId)
    if (ledger === undefined) {
      return failSettlement(
        deps,
        context,
        settlementFailureReason(context, turn, 'seeded candidate 0 but the ledger stayed empty'),
        {},
      )
    }
  }
  const existingIndex = ledger.candidates.find((item) => item.messageId === candidate.messageId)?.index
  const candidateIndex = existingIndex ?? ledger.candidates.length
  let selectAppended = false

  try {
    if (existingIndex === undefined) {
      appendBodyEvent(deps, {
        op: 'candidate',
        groupId: context.op.groupId,
        messageId: candidate.messageId,
        index: candidateIndex,
        ...(context.op.feedback === undefined ? {} : { feedback: context.op.feedback }),
      })
    }
    appendBodyEvent(deps, { op: 'select', groupId: context.op.groupId, index: candidateIndex })
    selectAppended = true
  } catch (error) {
    // The candidate append may have landed even when the select failed. The
    // ledger is checked by the shared failure path before it restores the
    // previous selection, so a half-appended candidate never becomes visible
    // through a select for a slot the ledger never selected.
    if (selectAppended) restorePreviousSelection(deps, context)
    return failSettlement(
      deps,
      context,
      settlementFailureReason(context, turn, `failed to record candidate/select: ${errorMessage(error)}`),
      { cause: error },
    )
  }

  // Proposal 0022 §5/§10: commit runs before the hide boundary. A commit
  // failure is not a completed compensation, so it is routed to the shared
  // restore path instead of writing a terminal record here.
  try {
    await commitBodyRollback(deps, context.op)
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to commit the write rollback in turn ${turn}: ${errorMessage(error)}`
    // Proposal 0022 §10.3 revision 2026-10-29: a commit failure is a failure
    // that has not been compensated. Keep the op-start + plan durable, record
    // the cancellation and let turn/end or startup recovery undo the new turn
    // writes and restore the old plan before any terminal record is written.
    cancelSettlementForRestore(deps, context, { anchorId: candidate.messageId, index: candidateIndex }, reason)
    throw failureFor(error, reason, context.op)
  }

  // Two-phase durable boundary: `settling` lands before the previous anchor
  // leaves the surface. If the process dies after the hide but before the
  // `settled` record, recovery resolves the surface/ledger state instead of
  // falling back to the legacy restore path.
  try {
    appendSettlingMarker(deps, context.op.opId, context.op.groupId, candidate.messageId, candidateIndex, {
      triggerMessageId: triggerMessageIdOf(context.op),
      previousAnchorId: context.op.previousAnchorId,
    })
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to record the settling marker before hiding turn ${turn}: ${errorMessage(error)}`
    cancelSettlementForRestore(deps, context, { anchorId: candidate.messageId, index: candidateIndex }, reason)
    return { status: 'failed', reason }
  }

  // Proposal 0021 §6.2 revision 2026-10-29: an operation started after the
  // start-hide already removed the previous anchor from the model surface. Its
  // remaining hide (trigger/process) is deferred to the post-turn bridge so the
  // answer step stays the turn's last step. Opening an extra hide step here
  // made DSH treat the whole turn as a process page (default folded) and
  // dropped its per-turn token usage.
  const openTurn = openTurnNumber(events)
  const previousVisible = findSurfaceSeqByMessageId(events, surface, context.op.previousAnchorId) !== undefined
  if (!previousVisible && context.deferHide === true) {
    releaseSettlementRestriction(deps, context)
    return { status: 'ok', anchorMessageId: candidate.messageId }
  }

  try {
    const hidden = hideTargets(events, surface, triggerMessageIdOf(context.op), turn, candidate.messageId)
    // Legacy operations (started before the revision) still carry their
    // previous anchor on the surface, so settlement removes it here. Real user
    // messages stay. Recovery may run after the trigger turn closed; it opens
    // its own bridge turn instead of relying on the live turn.
    for (const seq of oldAnchorSurfaceTargets(events, surface, context.op.previousAnchorId)) hidden.add(seq)
    if (openTurn === turn) appendHideInOpenTurn(deps, turn, hidden)
    else appendHideInBridgeTurn(deps, hidden)
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to settle turn ${turn}: ${errorMessage(error)}`
    // A legacy operation still has its previous anchor on the surface, so the
    // failed hide cancels the settlement: recovery restores the old body. A
    // new operation whose start already hid the anchor keeps the committed
    // candidate instead — cancelling would leave the model no body at all. Its
    // durable `settling` record stays and recovery finishes the remaining
    // trigger/process hide.
    const previousVisibleNow = findSurfaceSeqByMessageId(
      eventsOf(deps.session),
      surfaceNodeList(deps.session),
      context.op.previousAnchorId,
    ) !== undefined
    if (!previousVisibleNow) {
      releaseSettlement(deps, context)
      throw failureFor(error, reason, context.op)
    }
    cancelSettlementForRestore(deps, context, {
      anchorId: candidate.messageId,
      index: candidateIndex,
    }, `failed to hide the previous anchor: ${errorMessage(error)}`)
    return { status: 'failed', reason }
  }

  // The previous anchor is off the surface from here on. This marker is the
  // durable boundary between "body not settled" (restore is safe) and "body
  // settled" (any late failure must keep the new body and retry op-finish).
  let markerWritten = true
  try {
    appendSettledMarker(deps, context.op.opId, context.op.groupId, candidate.messageId, candidateIndex)
  } catch (error) {
    markerWritten = false
    warn(deps, `body runtime: ${context.label} ${context.op.opId} settled '${candidate.messageId}' but could not record the settled marker: ${errorMessage(error)}`)
  }

  try {
    appendOpFinish(deps, context.op.opId, 'ok', candidate.messageId, undefined)
    releaseSettlement(deps, context)
    return { status: 'ok', anchorMessageId: candidate.messageId }
  } catch (error) {
    if (!markerWritten) {
      try {
        appendSettledMarker(deps, context.op.opId, context.op.groupId, candidate.messageId, candidateIndex)
        markerWritten = true
      } catch (markerError) {
        warn(deps, `body runtime: ${context.label} ${context.op.opId} could not retry the settled marker: ${errorMessage(markerError)}`)
      }
    }
    releaseSettlement(deps, context)
    const reason = `${context.label} ${context.op.opId} settled '${candidate.messageId}' in turn ${turn} but failed to record op-finish: ${errorMessage(error)}`
    warn(deps, reason)
    throw settledFinishPending(reason, context.op, error)
  }
}

/**
 * Resolve a `settling` record left by a crash between the pre-hide marker and
 * the post-hide marker. The surface and ledger are the authority: new candidate
 * visible and committed, and every hide target off the surface means settled.
 * A settlement hide that stopped after any subset of its ranges (trigger/process
 * survivors or only the previous anchor) is completed before the settled marker,
 * so no target can survive as a surface-only leftover. Old anchor still visible
 * with the previous index selected means cancelled; anything else fails closed
 * and keeps the op-start pending instead of guessing.
 */
async function settleFromSettlingEvidence(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  evidence: BodySettlementEvidence,
): Promise<FinalizeTurnStoppingResult> {
  const decision = settlingDecision(deps, context.op, evidence)
  if (decision === 'settled' || decision === 'finish-hide') {
    if (decision === 'finish-hide') {
      finishSettlementHide(deps, context.op, evidence, `${context.label} ${context.op.opId}`)
    }
    try {
      appendSettledMarker(deps, context.op.opId, context.op.groupId, evidence.anchorId, evidence.index)
    } catch (error) {
      warn(deps, `body runtime: ${context.label} ${context.op.opId} completed its hide but could not upgrade the settled marker: ${errorMessage(error)}`)
    }
    return finishSettledOperation(deps, context, evidence)
  }
  if (decision === 'cancelled') {
    recordSettlementCancelled(
      deps,
      context.op,
      context.label,
      evidence,
      'the previous anchor is still on the surface and the previous selection was restored',
    )
    restorePreviousSelection(deps, context)
    releaseSettlementRestriction(deps, context)
    if (openTurnNumber(eventsOf(deps.session)) === undefined) {
      // The turn already closed: complete the restore now instead of holding a
      // dangling cancellation until the next startup.
      await restoreBodyAfterFailureLocked(deps, context.op)
    }
    return {
      status: 'failed',
      reason: `${context.label} ${context.op.opId} did not complete its hide; the previous body stays selected`,
    }
  }
  throw bodyRuntimeError(
    'operation-failed',
    `${context.label} ${context.op.opId} has an ambiguous settling record for '${evidence.anchorId}' index ${evidence.index}: the surface and ledger disagree about whether the previous anchor was replaced; refusing to guess`,
  )
}

/**
 * Finish a settlement whose hide was only partially applied.
 *
 * The remaining set is derived from the live surface, so ranges that were
 * already replaced are absent and a retry is idempotent. The hide runs in the
 * settling turn while it is still open or in a bridge turn after it closed.
 * The ledger, selection and assistant log are never touched; the new candidate
 * stays exactly where the settlement put it. A failed hide surfaces as a typed
 * failure and leaves `op-start` pending for the next recovery pass instead of
 * writing a settled marker.
 */
function finishSettlementHide(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  evidence: BodySettlementEvidence,
  subject: string,
): void {
  const events = eventsOf(deps.session)
  const remaining = settlementRemainingTargets(events, surfaceNodeList(deps.session), op, evidence)
  if (remaining.length === 0) return
  const openTurn = openTurnNumber(events)
  const hideTurn = settlementTurnOf(events, op, evidence) ?? openTurn
  try {
    if (hideTurn === undefined) {
      appendHideInBridgeTurn(deps, new Set(remaining))
    } else if (openTurn === undefined) {
      appendHideInBridgeTurn(deps, new Set(remaining))
    } else if (openTurn === hideTurn) {
      appendHideInOpenTurn(deps, hideTurn, new Set(remaining))
    } else {
      throw bodyRuntimeError(
        'session-busy',
        `${subject}: cannot finish the partial settlement hide while turn ${openTurn} is open, expected turn ${hideTurn}`,
      )
    }
  } catch (error) {
    warn(deps, `${subject}: failed to finish the partial settlement hide of seq ${remaining.join(', ')}: ${errorMessage(error)}`)
    throw failureFor(error, `${subject}: failed to finish the partial settlement hide`, op)
  }
  const leftover = settlementRemainingTargets(eventsOf(deps.session), surfaceNodeList(deps.session), op, evidence)
  if (leftover.length > 0) {
    throw bodyRuntimeError(
      'operation-failed',
      `${subject}: the partial settlement hide left seq ${leftover.join(', ')} on the surface; keeping op-start pending`,
    )
  }
}

/**
 * Keep an unfinished settlement recoverable.
 *
 * A failure before the previous body is restored must not write a terminal
 * record: the new-turn writes are still live and only recovery can undo them.
 * The cancellation record tells both live turn/end and startup recovery to
 * take the restore path; the op-start and its plan stay durable until then.
 */
function cancelSettlementForRestore(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  evidence: { readonly anchorId: string; readonly index: number },
  reason: string,
): void {
  recordSettlementCancelled(deps, context.op, context.label, evidence, reason)
  restorePreviousSelection(deps, context)
  releaseSettlementRestriction(deps, context)
}

/**
 * Resolve a durable cancellation. The turn/end path restores immediately once
 * the turn is closed; recovery with an open turn returns a failure and retries
 * after `closeImportBracket`. A restore failure propagates and keeps the op
 * pending instead of recording a terminal state.
 */
async function restoreCancelledSettlement(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  reason: string,
  evidence: BodySettlementEvidence,
): Promise<FinalizeTurnStoppingResult> {
  recordSettlementCancelled(deps, context.op, context.label, evidence, evidence.reason ?? reason)
  // A cancellation written before candidate 0 was seeded has no ledger to
  // select in: appending a `select` would make the whole ledger unfoldable.
  const ledger = bodyLedger(eventsOf(deps.session), context.op.groupId)
  if (ledger !== undefined && ledger.selectedIndex !== context.op.previousIndex) {
    restorePreviousSelection(deps, context)
  }
  releaseSettlementRestriction(deps, context)
  if (openTurnNumber(eventsOf(deps.session)) === undefined) {
    await restoreBodyAfterFailureLocked(deps, context.op)
  }
  return { status: 'failed', reason }
}

/** Failure reason that keeps the operation identity actionable in logs. */
function settlementFailureReason(context: SettlementContext, turn: number, detail: string): string {
  return `${context.label} ${context.op.opId} (group '${context.op.groupId}', turn ${turn}, start seq ${context.op.startSeq}) ${detail}`
}

/** Optional cause carried by a settlement failure that caught an exception. */
interface SettlementFailureOptions {
  /** Underlying exception; when present the failure is rethrown instead of returned. */
  readonly cause?: unknown
}

/**
 * End a settlement attempt that could not produce a committed candidate.
 *
 * Every call site runs after `startRegenerate` applied the write rollback and
 * may already have hidden the previous anchor. `op-finish failed` would close
 * the operation and drop the only durable handle while the old turn's writes
 * stay rolled back and the old body may be off the surface. There is no branch
 * here that is proven to have changed nothing, so all of them take the same
 * "failed, restore pending" path: record the cancellation, restore the
 * previous selection when the ledger can express it, release the write-tool
 * restriction, and keep `op-start` pending. Turn/end or startup recovery then
 * runs `rollbackTurnWrites` + `restore(plan)` + the previous body.
 *
 * A caught append failure is rethrown so its message is not swallowed; the
 * cancellation record is already durable before the throw.
 */
function failSettlement(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  reason: string,
  options: SettlementFailureOptions,
): FinalizeTurnStoppingResult {
  // The previous anchor/index identify what the restore path will put back.
  // Using the failed candidate would claim a ledger slot that may never have
  // been committed.
  recordSettlementCancelled(deps, context.op, context.label, {
    anchorId: context.op.previousAnchorId,
    index: context.op.previousIndex,
  }, reason)
  // A crash before candidate 0 was seeded leaves no ledger at all; appending a
  // `select` would then make the ledger unfoldable (`body-candidate-gap`), so
  // the selection is restored only when the ledger can accept it and actually
  // points somewhere else. A candidate append auto-selects its slot, so a
  // failed select still has to be rolled back here.
  const ledger = bodyLedger(eventsOf(deps.session), context.op.groupId)
  if (ledger !== undefined && ledger.selectedIndex !== context.op.previousIndex) {
    restorePreviousSelection(deps, context)
  }
  releaseSettlementRestriction(deps, context)
  warn(deps, reason)
  if (options.cause !== undefined) throw failureFor(options.cause, reason, context.op)
  return { status: 'failed', reason }
}

/**
 * Commit the prepared rollback plan. A missing port for an existing plan is a
 * programming/state error: failing loudly keeps the op pending instead of
 * pretending the old writes were settled.
 */
async function commitBodyRollback(deps: BodyRuntimeDeps, op: PendingBodyOperation): Promise<void> {
  const plan = op.rollbackPlan
  if (plan === undefined) return
  const port = deps.writeRollback
  if (port === undefined) {
    throw bodyRuntimeError(
      'operation-failed',
      `body runtime: operation '${op.opId}' carries a write rollback plan but deps.writeRollback is missing`,
    )
  }
  await port.commit(plan)
}

/**
 * Refuse the restore when the plan's chat is no longer the live binding,
 * before the restore sequence writes anything (proposal 0022 §10.3).
 *
 * `undoNewCandidateBodyReceipt` and `restoreBodyRollbackPlan` both write the
 * chat recorded in `plan.binding`, but the port's own binding assert only runs
 * inside `restore` — the last of the three steps. After a session branch or
 * rename the old chat still exists, so the receipt undo would mark and save it
 * first, and the retry would then skip the already-undone receipt while the
 * replay keeps refusing: a half-rolled-back old chat with no reconciliation.
 *
 * The check rides the port's optional `assertTarget` capability (the factory
 * behind `createBodyWriteRollbackPort` provides it), so it reads the same store
 * `restore` reads. A port without the capability keeps the legacy ordering,
 * like the optional `plan`/`apply` split.
 */
async function assertRestoreTargetCurrent(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<void> {
  const plan = op.rollbackPlan
  if (plan === undefined) return
  const port = deps.writeRollback as
    | { assertTarget?: (plan: NonNullable<PendingBodyOperation['rollbackPlan']>) => Promise<void> }
    | undefined
  const assertTarget = port?.assertTarget
  if (typeof assertTarget !== 'function') return
  try {
    await assertTarget.call(port, plan)
  } catch (error) {
    throw failureFor(
      error,
      `body restore ${op.opId} refused to restore the write rollback plan`,
      op,
    )
  }
}

/**
 * Replay the prepared plan before the old body is restored. Any restore
 * failure is surfaced with the operation context; the caller keeps the
 * `op-start` pending for a retry instead of restoring the body over lost writes.
 */
async function restoreBodyRollbackPlan(deps: BodyRuntimeDeps, op: PendingBodyOperation): Promise<void> {
  const plan = op.rollbackPlan
  if (plan === undefined) return
  const port = deps.writeRollback
  if (port === undefined) {
    throw failureFor(
      bodyRuntimeError(
        'operation-failed',
        `body restore ${op.opId} carries a write rollback plan but deps.writeRollback is missing`,
      ),
      `body restore ${op.opId} cannot restore the write rollback plan`,
      op,
    )
  }
  try {
    await port.restore(plan)
  } catch (error) {
    throw failureFor(error, `body restore ${op.opId} failed to restore the write rollback plan`, op)
  }
}

function oldAnchorTurn(events: ReturnType<typeof eventsOf>, previousAnchorId: string): number | undefined {
  const anchor = findEventByMessageId(events, previousAnchorId)
  return anchor === undefined ? undefined : turnOfEventSeq(events, anchor.seq)
}

/**
 * Undo the failed regeneration turn's own writes before the old plan is
 * replayed (proposal 0022 §10.3).
 *
 * The new turn comes from the trigger user message. When the trigger never
 * reached the session (start failed before `followup`), there is no new turn
 * and therefore nothing to undo; the old anchor turn is never used as a
 * fallback because undoing it would erase the writes the plan is restoring.
 */
async function rollbackNewTurnWrites(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  events: ReturnType<typeof eventsOf>,
  newTurn: number | undefined,
): Promise<void> {
  const port = deps.writeRollback
  const rollback = port?.rollbackTurnWrites
  if (port === undefined || rollback === undefined || newTurn === undefined) return

  const oldTurn = op.rollbackPlan?.turn ?? oldAnchorTurn(events, op.previousAnchorId)
  if (oldTurn !== undefined && newTurn === oldTurn) {
    throw failureFor(
      bodyRuntimeError('operation-failed', `body restore ${op.opId} derived old turn ${newTurn} as the failed turn`),
      `body restore ${op.opId} refused to roll back the old turn as the new turn`,
      op,
    )
  }

  const agentId = recoveryAgentId(deps, op)
  let result: BodyRuntimeTurnRollback
  try {
    result = await rollback.call(port, agentId, newTurn)
  } catch (error) {
    throw failureFor(error, `body restore ${op.opId} failed to roll back turn ${newTurn} writes`, op)
  }
  const failures = result?.failures ?? []
  if (failures.length > 0) {
    const details = failures
      .map((failure) => `${failure.kind}/${failure.tool}/${failure.journalId}: ${failure.message}`)
      .join('; ')
    throw failureFor(
      bodyRuntimeError(
        'operation-failed',
        `body restore ${op.opId} could not undo ${failures.length} new-turn write(s) in turn ${newTurn}: ${details}`,
      ),
      `body restore ${op.opId} failed to roll back turn ${newTurn} writes`,
      op,
    )
  }
}

/**
 * Put the previous body back after a failed or cancelled regeneration.
 *
 * Operations started after the 2026-10-29 revision hid the previous anchor
 * before the trigger turn opened (proposal 0021 §6.2 step 4), so a failure
 * restores it by appending an assistant copy together with a `body/restore`
 * event in a model-free bridge turn. Operations started before the revision
 * still have the anchor on the surface; those only roll the stores back and
 * hide the failed turn's trigger/process nodes, without an assistant copy.
 *
 * `settled` evidence (or `settling` evidence whose surface/ledger state proves
 * the hide completed) is never restored: the new body already replaced the old
 * anchor, so a late failure only leaves `op-finish` to retry. A `settling`
 * record whose ledger committed the new candidate but whose hide survived on
 * any range (trigger/process or the previous anchor) is completed by hiding
 * exactly those targets. `settleCancelled` evidence always takes the restore
 * path. These branches run before the open-turn check because settlement
 * happens during turn stopping, while the new turn is still open.
 */
export async function restoreBodyAfterFailure(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<string> {
  validatePendingOperation(op)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => restoreBodyAfterFailureLocked(deps, op))
}

async function restoreBodyAfterFailureLocked(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<string> {
  const events = eventsOf(deps.session)
  // A crash after the restore but before the caller observed the return can
  // replay the same operation. The abort record is the durable proof that the
  // body, the old writes and the selection are already back.
  const abort = abortedOperation(events, op.opId)
  if (abort !== undefined) {
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    return abort.anchorId ?? op.previousAnchorId
  }

  const evidence = settlementEvidenceOf(events, op.opId)
  if (evidence !== undefined) {
    if (evidence.phase === 'settled') {
      assertCommittedSettlement(deps, op.groupId, evidence, `body restore ${op.opId}`)
      releaseOperationByOp(deps, op, `body restore ${op.opId}`)
      return evidence.anchorId
    }
    if (evidence.phase === 'settling') {
      const decision = settlingDecision(deps, op, evidence)
      if (decision === 'settled') {
        // The hide completed but the post-hide marker never landed. Upgrade
        // the durable boundary so recovery can classify the missing
        // `op-finish` as finish-pending instead of reporting a restore.
        try {
          appendSettledMarker(deps, op.opId, op.groupId, evidence.anchorId, evidence.index)
        } catch (error) {
          throw failureFor(
            error,
            `body restore ${op.opId} proved the body settled but could not upgrade the settled marker`,
            op,
          )
        }
        releaseOperationByOp(deps, op, `body restore ${op.opId}`)
        return evidence.anchorId
      }
      if (decision === 'finish-hide') {
        // The previous anchor and the new selection are durable, but a
        // multi-range hide stopped after some ranges. Complete exactly the
        // surviving targets, then finish the operation; no ledger, select or
        // assistant write is allowed here.
        finishSettlementHide(deps, op, evidence, `body restore ${op.opId}`)
        assertCommittedSettlement(deps, op.groupId, evidence, `body restore ${op.opId}`)
        try {
          appendSettledMarker(deps, op.opId, op.groupId, evidence.anchorId, evidence.index)
        } catch (error) {
          warn(deps, `body runtime: body restore ${op.opId} finished the partial hide but could not record the settled marker: ${errorMessage(error)}`)
        }
        try {
          appendOpFinish(deps, op.opId, 'ok', evidence.anchorId, undefined)
        } catch (error) {
          throw settledFinishPending(
            `body restore ${op.opId} finished the partial hide but failed to record op-finish: ${errorMessage(error)}`,
            op,
            error,
          )
        }
        releaseOperationByOp(deps, op, `body restore ${op.opId}`)
        return evidence.anchorId
      }
      if (decision === 'ambiguous') {
        throw bodyRuntimeError(
          'operation-failed',
          `body restore ${op.opId} has an ambiguous settling record for '${evidence.anchorId}' index ${evidence.index}: the surface and ledger disagree; refusing to guess`,
        )
      }
      recordSettlementCancelled(
        deps,
        op,
        `body restore ${op.opId}`,
        evidence,
        'the previous anchor is still on the surface and the previous selection was restored',
      )
    }
  }
  const surface = surfaceNodeList(deps.session)
  // Recovery after `op-settle-cancelled` may have already appended the restore
  // copy and only lost the terminal record. Reuse that copy instead of
  // appending a second assistant message for the same operation. This check
  // runs before the turn-base guard because the abort record is log-only.
  const existingRestore = restoredAnchorOf(events, surface, op)
  if (existingRestore !== undefined) {
    appendOpAbort(deps, op.opId, restoreAbortReason(events, op), existingRestore)
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    return existingRestore
  }

  const openTurn = openTurnNumber(events)
  if (openTurn !== undefined) {
    throw bodyRuntimeError(
      'session-busy',
      `body restore ${op.opId} rejected: turn ${openTurn} is still open; close its step/turn before restoring`,
    )
  }
  assertCanAdvanceTurnBase(deps)

  const previous = findEventByMessageId(events, op.previousAnchorId)
  if (previous === undefined) {
    throw bodyRuntimeError('restore-unavailable', `body restore ${op.opId} cannot find previous anchor '${op.previousAnchorId}' in the session log`)
  }
  const previousMessage = messageOf(previous)
  if (previousMessage === undefined || previous.type !== 'assistant/message') {
    throw bodyRuntimeError('restore-unavailable', `body restore ${op.opId} previous anchor '${op.previousAnchorId}' is not an assistant message`)
  }
  if (textOfMessage(previousMessage).trim() === '') {
    throw bodyRuntimeError('restore-unavailable', `body restore ${op.opId} previous anchor '${op.previousAnchorId}' has no body text`)
  }

  const triggerId = triggerMessageIdOf(op)
  const failedTurn = turnOfUserMessage(events, triggerId)
  const previousSeq = findSurfaceSeqByMessageId(events, surface, op.previousAnchorId)
  const targets = failedTurnTargets(events, surface, triggerId, failedTurn)

  // Proposal 0022 §10.3: first undo the failed new turn's writes, then put
  // the old turn's journaled writes and MVU receipts back. The new candidate's
  // own body receipt is undone in between: it is keyed by the new message id,
  // so replaying the old plan alone would leave its unique variable paths live.
  // The binding recheck runs first: a branch or rename that moved the live
  // binding must refuse before any of the three steps writes the stale chat.
  await assertRestoreTargetCurrent(deps, op)
  await rollbackNewTurnWrites(deps, op, events, failedTurn)
  await undoNewCandidateBodyReceipt(deps, op, events, failedTurn)
  await restoreBodyRollbackPlan(deps, op)

  const abortReason = restoreAbortReason(events, op)
  if (previousSeq !== undefined) {
    // Legacy operation: its start kept the anchor visible, so a model-free
    // hide of the failed turn's nodes already restores the visible body.
    try {
      appendHideInBridgeTurn(deps, targets)
    } catch (error) {
      releaseOperationByOp(deps, op, `body restore ${op.opId}`)
      throw failureFor(error, `body restore ${op.opId} failed`, op)
    }
    try {
      appendOpAbort(deps, op.opId, abortReason, op.previousAnchorId)
    } catch (error) {
      throw failureFor(error, `body restore ${op.opId} restored the previous body but could not record op-abort`, op)
    }
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    return op.previousAnchorId
  }

  const model = modelSourceOf(previousMessage)
  if (model === undefined) {
    throw bodyRuntimeError('restore-unavailable', `body restore ${op.opId} previous anchor '${op.previousAnchorId}' has no model provider/model source`)
  }

  const ledgerBeforeRestore = bodyLedger(events, op.groupId)
  if (ledgerBeforeRestore === undefined && op.previousIndex !== 0) {
    throw bodyRuntimeError(
      'restore-unavailable',
      `body restore ${op.opId} cannot reconstruct group '${op.groupId}' at index ${op.previousIndex}: no candidate 0 is recorded`,
    )
  }
  if (ledgerBeforeRestore !== undefined && ledgerBeforeRestore.candidates[op.previousIndex] === undefined) {
    throw bodyRuntimeError(
      'restore-unavailable',
      `body restore ${op.opId} cannot restore group '${op.groupId}' index ${op.previousIndex}: the ledger has ${ledgerBeforeRestore.candidates.length} candidates`,
    )
  }

  const turn = (lastLoggedTurn(deps.agent) ?? 0) + 1
  const restoredMessageId = `body-restore-${randomUUID()}`
  let turnOpen = false
  let stepOpen = false
  try {
    deps.session.append('turn/start', { turn })
    turnOpen = true
    deps.session.append('step/start', { turn, step: 1 })
    stepOpen = true

    const currentSurface = surfaceNodeList(deps.session)
    const ranges = surfaceRanges(currentSurface, targets)
    for (const range of [...ranges].reverse()) appendDeveloperHide(deps, turn, 1, range)

    deps.session.append('assistant/message', restoreAssistantData(deps, turn, restoredMessageId, previousMessage, model), {
      surfaceOp: 'append',
    })
    if (ledgerBeforeRestore === undefined) {
      // Crash recovery may meet an op-start whose start never seeded the
      // original reply; seed it now so the restore event keeps the ledger dense.
      appendBodyEvent(deps, { op: 'candidate', groupId: op.groupId, messageId: op.previousAnchorId, index: 0 })
    }
    appendBodyEvent(deps, {
      op: 'restore',
      groupId: op.groupId,
      messageId: restoredMessageId,
      index: op.previousIndex,
    })
    deps.session.append('step/end', { turn, step: 1 })
    stepOpen = false
    deps.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  } catch (error) {
    closeBracketBestEffort(deps, turn, 1, turnOpen, stepOpen, `body restore ${op.opId} failed`)
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    throw failureFor(error, `body restore ${op.opId} failed`, op)
  }

  const advanced = advanceHostTurnBase(deps.agent, turn)
  if (!advanced) {
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    throw failureFor(
      bodyRuntimeError('host-unsupported', `body restore ${op.opId} logged turn ${turn} but the live loop turn base could not advance`),
      `body restore ${op.opId} completed without a writable turn base`,
      op,
    )
  }
  try {
    appendOpAbort(deps, op.opId, abortReason, restoredMessageId)
  } catch (error) {
    throw failureFor(error, `body restore ${op.opId} restored the previous body but could not record op-abort`, op)
  }
  releaseOperationByOp(deps, op, `body restore ${op.opId}`)
  return restoredMessageId
}

/**
 * A copy appended by an earlier restore attempt of this operation, proven by
 * the ledger slot and its presence on the current surface. A copy belonging to
 * an older operation cannot match because the current operation's
 * `previousAnchorId` would then be that same copy.
 */
function restoredAnchorOf(
  events: ReturnType<typeof eventsOf>,
  surface: readonly number[],
  op: PendingBodyOperation,
): string | undefined {
  const ledger = bodyLedger(events, op.groupId)
  if (ledger === undefined || ledger.selectedIndex !== op.previousIndex) return undefined
  const anchor = ledger.anchorMessageId
  if (!anchor.startsWith('body-restore-') || anchor === op.previousAnchorId) return undefined
  return findSurfaceSeqByMessageId(events, surface, anchor) === undefined ? undefined : anchor
}

/** Terminal reason that survives in the abort record for the read side. */
function restoreAbortReason(events: ReturnType<typeof eventsOf>, op: PendingBodyOperation): string {
  const evidence = settlementEvidenceOf(events, op.opId)
  if (evidence?.phase === 'cancelled' && evidence.reason !== undefined) return evidence.reason
  return `body restore ${op.opId} put back the previous anchor '${op.previousAnchorId}'`
}

/**
 * Undo the failed candidate's own body receipt before the old plan is replayed
 * (proposal 0022 §4, proposal 0023 §3.2).
 *
 * The projector keys a candidate patch as `body:<newMessageId>` (or
 * `body:<newMessageId>#<index>`). `rollbackTurnWrites` only owns journal and
 * settle receipts, so without this step a failed regeneration leaves the new
 * patch live in `chat_metadata.variables` and the old plan redos on top of it.
 * The chat is read and saved with CAS; a missing receipt (candidate not
 * projected yet) is a no-op.
 */
async function undoNewCandidateBodyReceipt(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
  events: ReturnType<typeof eventsOf>,
  failedTurn: number | undefined,
): Promise<void> {
  const plan = op.rollbackPlan
  if (plan === undefined || failedTurn === undefined) return
  const candidate = lastBodyCandidate(events, failedTurn)
  if (candidate === undefined) return
  const text = textOfMessage(candidate.message)
  if (!/<UpdateVariable(?:Variable)?\b/i.test(text)) return

  try {
    const { store } = await import('../runtime.js')
    const tavern = await store()
    const snapshot = await tavern.getChatSnapshot(plan.binding.character, plan.binding.chatId)
    if (snapshot === undefined) {
      throw bodyRuntimeError(
        'operation-failed',
        `body restore ${op.opId} cannot read chat '${plan.binding.chatId}' of '${plan.binding.character}' to undo candidate '${candidate.messageId}'`,
      )
    }
    const receipts = mvuReceiptsForBody(snapshot.chat, { messageId: candidate.messageId })
    const live = receipts.filter((receipt) => receipt.undoneAt === undefined)
    if (live.length === 0) return
    undoMvuReceipts(snapshot.chat, live, { at: new Date().toISOString() })
    await tavern.saveChat(plan.binding.character, plan.binding.chatId, snapshot.chat, snapshot.revision)
  } catch (error) {
    throw failureFor(
      error,
      `body restore ${op.opId} failed to undo the new candidate receipt '${candidate.messageId}'`,
      op,
    )
  }
}

/**
 * Surface nodes of the failed regeneration turn. The trigger is matched by id
 * because a user message carries no turn field; everything else is matched by
 * the turn that owns it. System prompts and empty `body-hide` replacements are
 * never hidden again.
 */
function failedTurnTargets(
  events: ReturnType<typeof eventsOf>,
  surface: readonly number[],
  triggerId: string,
  failedTurn: number | undefined,
): Set<number> {
  const targets = new Set<number>()
  const triggerSeq = findSurfaceSeqByMessageId(events, surface, triggerId)
  if (triggerSeq !== undefined) targets.add(triggerSeq)
  if (failedTurn === undefined) return targets
  for (const seq of surface) {
    const event = eventAtSeq(events, seq)
    if (event.type === 'system/message') continue
    if (isBodyHideMarker(event)) continue
    if (numberField(event.data.turn) === failedTurn) targets.add(seq)
  }
  return targets
}
