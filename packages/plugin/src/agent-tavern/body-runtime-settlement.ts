/**
 * Body operation settlement and restore.
 *
 * `finalizeTurnStopping` (live turn stop) and `finalizeRecoveredOperation`
 * (durable op reconstructed at startup) share `settleBodyOperation`, so both
 * paths hide the trigger/process and the previous anchor before `op-finish`.
 * The write rollback is committed while the previous anchor is still visible;
 * after the hide a durable `op-settled` marker is written before `op-finish`,
 * so a late failure keeps the new body and only retries `op-finish`. Failure
 * recovery is model-free when the previous anchor is still visible and keeps
 * the legacy `body-restore-*` copy only for sessions whose anchor was hidden by
 * an older build (no settled marker).
 */

import { randomUUID } from 'node:crypto'
import { advanceHostTurnBase, lastLoggedTurn } from '../session/trace.js'
import {
  appendBodyEvent,
  appendOpFinish,
  appendSettledMarker,
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
  settledMarkerOf,
  validateFinalizePayload,
  validatePendingOperation,
  warn,
  withBodyLock,
  type BodyRuntimeDeps,
  type BodyRuntimeFailure,
  type BodyRuntimeTurnRollback,
  type BodySettledMarker,
  type FinalizeTurnStoppingResult,
  type PendingBodyOperation,
  type SettlementContext,
} from './body-runtime-core.js'
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
  const settled = settledMarkerOf(events, context.op.opId)
  if (settled !== undefined) {
    // A previous attempt already hid the old anchor and selected the new body;
    // only `op-finish` is missing. Re-doing candidate/select/hide would append
    // a second settlement and could resurrect the previous body.
    return finishSettledOperation(deps, context, settled)
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

  try {
    const hidden = hideTargets(events, surface, triggerMessageIdOf(context.op), turn, candidate.messageId)
    // Proposal 0021 §9.5: the old anchor stayed visible while the new turn ran,
    // so successful settlement is the only place that removes it. The old
    // turn's process nodes go with it; real user messages stay.
    for (const seq of oldAnchorSurfaceTargets(events, surface, context.op.previousAnchorId)) hidden.add(seq)
    appendHideInOpenTurn(deps, turn, hidden)
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to settle turn ${turn}: ${errorMessage(error)}`
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
 * Complete an operation whose body settlement is already durable.
 *
 * Only `op-finish` is written: candidate/select/hide already happened, and any
 * body restore here would either resurrect the old anchor or duplicate the new
 * one. A failed finish keeps the durable `op-start` pending for the next
 * recovery pass and surfaces a recognizable `settled-finish-pending` error.
 */
function finishSettledOperation(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  settled: BodySettledMarker,
): FinalizeTurnStoppingResult {
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

function settledFinishPending(
  reason: string,
  op: PendingBodyOperation,
  cause: unknown,
): BodyRuntimeFailure {
  const failure = bodyRuntimeError('settled-finish-pending', reason)
  if (cause instanceof Error) failure.cause = cause
  failure.op = op
  return failure
}

/**
 * Point the body ledger back at the previous candidate after a settlement step
 * failed while the previous anchor was still visible.
 */
function restorePreviousSelection(deps: BodyRuntimeDeps, context: SettlementContext): void {
  try {
    appendBodyEvent(deps, { op: 'select', groupId: context.op.groupId, index: context.op.previousIndex })
  } catch (selectError) {
    warn(deps, `body runtime: failed to restore previous body selection for ${context.op.opId}: ${errorMessage(selectError)}`)
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
 * An operation with a durable settlement marker is never restored: its new
 * body already replaced the old anchor, so any late failure (a failed
 * `op-finish`, for example) only leaves bookkeeping to retry. This branch runs
 * before the open-turn check because settlement happens during turn stopping,
 * while the new turn is still open.
 */
export async function restoreBodyAfterFailure(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<string> {
  validatePendingOperation(op)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
    const settled = settledMarkerOf(events, op.opId)
    if (settled !== undefined) {
      releaseOperationByOp(deps, op, `body restore ${op.opId}`)
      return settled.anchorId
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
 * the turn that owns it. System prompts are never hidden.
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
    if (numberField(event.data.turn) === failedTurn) targets.add(seq)
  }
  return targets
}
