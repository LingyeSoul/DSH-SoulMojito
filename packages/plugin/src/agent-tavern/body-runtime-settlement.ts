/**
 * Body operation settlement and restore.
 *
 * `finalizeTurnStopping` and `finalizeRecoveredOperation` share
 * `settleBodyOperation`. Settlement is two-phase: `settling` lands before the
 * hide, `settled` after it, and a failed hide writes a cancellation record.
 * Recovery trusts `settled` (or a `settling` record whose surface/ledger state
 * proves the hide completed) only for `op-finish`; a `settling` record whose
 * hide stopped after some ranges has exactly its remaining targets hidden
 * before it is finished. A cancellation restores the previous body. The legacy
 * `body-restore-*` copy stays reachable only for sessions with no settlement
 * evidence at all.
 */

import { randomUUID } from 'node:crypto'
import { advanceHostTurnBase, lastLoggedTurn } from '../session/trace.js'
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
  requirePositiveTurn,
  settlementEvidenceOf,
  validateFinalizePayload,
  validatePendingOperation,
  warn,
  withBodyLock,
  type BodyRuntimeDeps,
  type BodyRuntimeTurnRollback,
  type BodySettlementEvidence,
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
      // body must be restored, never treated as settled.
      return failSettlement(
        deps,
        context,
        `${context.label} ${context.op.opId} was cancelled before its previous anchor left the surface: ${evidence.reason ?? 'no reason recorded'}`,
      )
    }
    return settleFromSettlingEvidence(deps, context, evidence)
  }
  const candidate = lastBodyCandidate(events, turn)
  if (candidate === undefined) {
    return failSettlement(
      deps,
      context,
      `${context.label} ${context.op.opId} produced no assistant message with text and no tool-call in turn ${turn}`,
    )
  }
  const surface = surfaceNodeList(deps.session)
  if (!surface.includes(candidate.seq)) {
    return failSettlement(
      deps,
      context,
      `${context.label} ${context.op.opId} candidate '${candidate.messageId}' is not on the current surface in turn ${turn}`,
    )
  }
  let ledger = bodyLedger(events, context.op.groupId)
  if (ledger === undefined) {
    if (context.op.previousIndex !== 0) {
      return failSettlement(
        deps,
        context,
        `${context.label} ${context.op.opId} has no candidate 0 for group '${context.op.groupId}' at previous index ${context.op.previousIndex}`,
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
        `${context.label} ${context.op.opId} failed to seed candidate 0 for group '${context.op.groupId}': ${errorMessage(error)}`,
      )
    }
    ledger = bodyLedger(eventsOf(deps.session), context.op.groupId)
    if (ledger === undefined) {
      return failSettlement(
        deps,
        context,
        `${context.label} ${context.op.opId} seeded candidate 0 for group '${context.op.groupId}' but the ledger stayed empty`,
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
    if (selectAppended) restorePreviousSelection(deps, context)
    return failSettlement(
      deps,
      context,
      `${context.label} ${context.op.opId} failed to settle turn ${turn}: ${errorMessage(error)}`,
    )
  }

  // Proposal 0022 §5/§10: commit before the previous anchor is hidden, so a
  // commit failure still leaves the old body on the surface and the existing
  // invisible restore can replay the plan without appending an assistant copy.
  try {
    await commitBodyRollback(deps, context.op)
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to commit the write rollback in turn ${turn}: ${errorMessage(error)}`
    restorePreviousSelection(deps, context)
    failSettlement(deps, context, reason)
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
    restorePreviousSelection(deps, context)
    return failSettlement(deps, context, reason)
  }

  try {
    const hidden = hideTargets(events, surface, triggerMessageIdOf(context.op), turn, candidate.messageId)
    // Proposal 0021 §9.5: the old anchor stayed visible while the new turn ran,
    // so successful settlement is the only place that removes it. The old
    // turn's process nodes go with it; real user messages stay.
    for (const seq of oldAnchorSurfaceTargets(events, surface, context.op.previousAnchorId)) hidden.add(seq)
    appendHideInOpenTurn(deps, turn, hidden)
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to settle turn ${turn}: ${errorMessage(error)}`
    // The hide failed, so the body did not settle. Record the cancellation
    // before rolling the selection back: recovery must restore, not finish.
    recordSettlementCancelled(deps, context.op, context.label, {
      anchorId: candidate.messageId,
      index: candidateIndex,
    }, `failed to hide the previous anchor: ${errorMessage(error)}`)
    restorePreviousSelection(deps, context)
    return failSettlement(deps, context, reason)
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
function settleFromSettlingEvidence(deps: BodyRuntimeDeps, context: SettlementContext, evidence: BodySettlementEvidence): FinalizeTurnStoppingResult {
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
    return failSettlement(
      deps,
      context,
      `${context.label} ${context.op.opId} did not complete its hide; the previous body stays selected`,
    )
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

function failSettlement(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  reason: string,
): FinalizeTurnStoppingResult {
  try {
    appendOpFinish(deps, context.op.opId, 'failed', undefined, reason)
  } catch (finishError) {
    releaseSettlement(deps, context)
    throw failureFor(
      finishError,
      `body runtime: failed to record op-finish for ${context.op.opId}: ${errorMessage(finishError)}`,
      context.op,
    )
  }
  releaseSettlement(deps, context)
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
 * The old anchor stays on the surface while a regeneration runs (proposal 0021
 * §9.5). Failure recovery therefore only rolls the stores back and hides the
 * failed turn's trigger/process nodes in a bridge turn: no `assistant/message`,
 * no `restore` body event and no JSONL floor change. The agent sees the same
 * old body it saw before the operation started.
 *
 * Sessions written by an older build hid the anchor when the operation
 * started. Its anchor is off the surface, so this function keeps the existing
 * model-free `body-restore-*` copy as a compatibility fallback.
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
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
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
    const initialSurface = surfaceNodeList(deps.session)
    const previousSeq = findSurfaceSeqByMessageId(events, initialSurface, op.previousAnchorId)
    const targets = failedTurnTargets(events, initialSurface, triggerId, failedTurn)

    // Proposal 0022 §10.3: first undo the failed new turn's writes, then put
    // the old turn's journaled writes and MVU receipts back. Any failure keeps
    // the op-start pending for a retry and leaves the surface untouched.
    await rollbackNewTurnWrites(deps, op, events, failedTurn)
    await restoreBodyRollbackPlan(deps, op)

    if (previousSeq !== undefined) {
      try {
        appendHideInBridgeTurn(deps, targets)
      } catch (error) {
        releaseOperationByOp(deps, op, `body restore ${op.opId}`)
        throw failureFor(error, `body restore ${op.opId} failed`, op)
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
    releaseOperationByOp(deps, op, `body restore ${op.opId}`)
    if (!advanced) {
      throw failureFor(
        bodyRuntimeError('host-unsupported', `body restore ${op.opId} logged turn ${turn} but the live loop turn base could not advance`),
        `body restore ${op.opId} completed without a writable turn base`,
        op,
      )
    }
    return restoredMessageId
  })
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
