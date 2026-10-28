/**
 * Body operation settlement and restore.
 *
 * `finalizeTurnStopping` (live turn stop) and `finalizeRecoveredOperation`
 * (durable op reconstructed at startup) share `settleBodyOperation`, so both
 * paths hide the trigger/process nodes before `op-finish`. The restore turn is
 * the model-free failure path.
 */

import { randomUUID } from 'node:crypto'
import { advanceHostTurnBase, lastLoggedTurn } from '../session/trace.js'
import {
  appendBodyEvent,
  appendOpFinish,
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
  validateFinalizePayload,
  validatePendingOperation,
  warn,
  withBodyLock,
  type BodyRuntimeDeps,
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
  turnOfUserMessage,
} from './body-runtime-session.js'
import {
  appendDeveloperHide,
  appendHideInOpenTurn,
  bodyLedger,
  closeBracketBestEffort,
  hideTargets,
  restoreAssistantData,
  surfaceRanges,
} from './body-runtime-state.js'

/**
 * Settle the pending regeneration at `agent/turn-stopping`.
 *
 * The last assistant message in the turn that carries text and no tool call
 * becomes the new selected candidate. The synthetic trigger and every process
 * node of the turn are then replaced with empty developer messages.
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
 * recovered turn also hides its trigger/process nodes before `op-finish`.
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

function settleBodyOperation(
  deps: BodyRuntimeDeps,
  context: SettlementContext,
  turn: number,
): FinalizeTurnStoppingResult {
  const events = eventsOf(deps.session)
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

    const hidden = hideTargets(events, surface, triggerMessageIdOf(context.op), turn, candidate.messageId)
    appendHideInOpenTurn(deps, turn, hidden)
    appendOpFinish(deps, context.op.opId, 'ok', candidate.messageId, undefined)
    releaseSettlement(deps, context)
    return { status: 'ok', anchorMessageId: candidate.messageId }
  } catch (error) {
    const reason = `${context.label} ${context.op.opId} failed to settle turn ${turn}: ${errorMessage(error)}`
    if (selectAppended) {
      try {
        appendBodyEvent(deps, { op: 'select', groupId: context.op.groupId, index: context.op.previousIndex })
      } catch (selectError) {
        warn(deps, `body runtime: failed to restore previous body selection for ${context.op.opId}: ${errorMessage(selectError)}`)
      }
    }
    return failSettlement(deps, context, reason)
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
 * Put the previous body back after a failed or cancelled regeneration.
 *
 * The restore is a model-free turn: hide the failed trigger/process nodes,
 * append a copy of the previous assistant message, then record `body/restore`.
 * The live loop turn base is advanced after the turn closes. Preconditions are
 * checked before any event is appended and fail with specific errors.
 */
export async function restoreBodyAfterFailure(
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<string> {
  validatePendingOperation(op)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
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
    const previousText = textOfMessage(previousMessage)
    if (previousText.trim() === '') {
      throw bodyRuntimeError('restore-unavailable', `body restore ${op.opId} previous anchor '${op.previousAnchorId}' has no body text`)
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
    const triggerId = triggerMessageIdOf(op)
    const failedTurn = turnOfUserMessage(events, triggerId)
    const targets = new Set<number>()
    const initialSurface = surfaceNodeList(deps.session)
    const triggerSeq = findSurfaceSeqByMessageId(events, initialSurface, triggerId)
    if (triggerSeq !== undefined) targets.add(triggerSeq)
    if (failedTurn !== undefined) {
      for (const seq of initialSurface) {
        const event = eventAtSeq(events, seq)
        if (event.type === 'system/message') continue
        if (numberField(event.data.turn) === failedTurn) targets.add(seq)
      }
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
