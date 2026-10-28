/**
 * AgentTavern body-operation public entry (proposal 0021).
 *
 * This module keeps the caller-facing API stable while the implementation is
 * split by responsibility:
 *
 * - `body-runtime-core.ts`: structural deps, errors, record writer, operation map
 * - `body-runtime-session.ts`: session-log and surface reading
 * - `body-runtime-state.ts`: ledger state, candidate seeding, surface hiding
 * - `body-runtime-settlement.ts`: turn-stopping settlement and restore
 *
 * Body records are log-only plugin records; old bodies leave the model surface
 * through empty `developer/message` replacements.
 */

import { randomUUID } from 'node:crypto'
import { BODY_EVENT_TYPE, type BodyEventData } from './body.js'
import { BodyRollbackError, type BodyRollbackPlan } from './body-rollback.js'
import {
  BODY_TEXT_MAX_LENGTH,
  appendBodyEvent,
  appendBodyStartEvent,
  appendOpFinish,
  assertAgentIdle,
  assertCanAdvanceTurnBase,
  assertRecordWriter,
  bodyRuntimeError,
  errorMessage,
  failureFor,
  operationView,
  parseSettledEvent,
  pendingByAgent,
  releaseOperation,
  requireAgentId,
  validateEditRequest,
  validateRegenerateRequest,
  validateSelectRequest,
  warn,
  withBodyLock,
  type ActiveBodyOperation,
  type BodyRuntimeDeps,
  type BodyRuntimeState,
  type EditBodyRequest,
  type PendingBodyOperation,
  type RegenerateBodyRequest,
  type SelectBodyRequest,
} from './body-runtime-core.js'
import { durableRollbackPlan } from './body-runtime-plan.js'
import {
  eventSeqOf,
  eventsOf,
  nextEventSeq,
  parseEventList,
  pendingEventOf,
  surfaceNodeList,
  triggerMessageIdFor,
  turnOfEventSeq,
} from './body-runtime-session.js'
import {
  anchorTarget,
  applyWriteRestriction,
  assertLastBodyTarget,
  bodyLedger,
  buildRegenerateTrigger,
  candidateText,
  ensureBodyLedger,
  ledgerForRegenerate,
  normalizeDenyTools,
  requireCandidate,
  stateFromLedger,
} from './body-runtime-state.js'
import {
  finalizeRecoveredOperation,
  finalizeTurnStopping,
  restoreBodyAfterFailure,
} from './body-runtime-settlement.js'

export { BODY_EVENT_TYPE }
export type { BodyEventData }
export {
  BODY_TEXT_MAX_LENGTH,
  BODY_WRITE_TOOL_DENY,
  bodyRuntimeError,
  withBodyLock,
} from './body-runtime-core.js'
export type {
  BodyAgentLike,
  BodyCandidateState,
  BodyEditInspection,
  BodyLogger,
  BodyRuntimeDeps,
  BodyRuntimeErrorCode,
  BodyRuntimeFailure,
  BodyRuntimeRollbackPort,
  BodyRuntimeState,
  BodyRuntimeTurnRollback,
  BodyRuntimeTurnRollbackFailure,
  BodySessionLike,
  EditBodyRequest,
  FinalizeTurnStoppingResult,
  PendingBodyOperation,
  RegenerateBodyRequest,
  SelectBodyRequest,
} from './body-runtime-core.js'
export {
  finalizeRecoveredOperation,
  finalizeTurnStopping,
  restoreBodyAfterFailure,
} from './body-runtime-settlement.js'

export interface StartRegenerateResult {
  opId: string
  release: () => void
  triggerMessageId: string
  /** The same operation, ready for `restoreBodyAfterFailure`. */
  op: PendingBodyOperation
}

/**
 * Start a regeneration operation.
 *
 * The write rollback plan is prepared before any body record is written: a
 * refused plan leaves the old anchor visible and produces no `op-start`. The
 * previous anchor deliberately stays on the model surface while the new turn
 * runs, so a failed regeneration has nothing to add back: the old body never
 * left. Successful settlement hides it together with the new turn's
 * trigger/process nodes (see `finalizeTurnStopping`).
 */
export async function startRegenerate(
  deps: BodyRuntimeDeps,
  request: RegenerateBodyRequest,
): Promise<StartRegenerateResult> {
  validateRegenerateRequest(request)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const agentId = requireAgentId(deps)
    assertAgentIdle(deps)
    assertCanAdvanceTurnBase(deps)
    if (pendingByAgent.has(agentId)) {
      throw bodyRuntimeError('session-busy', `body regenerate rejected: agent '${agentId}' already has a pending body operation`)
    }
    const events = eventsOf(deps.session)
    const surface = surfaceNodeList(deps.session)
    const target = anchorTarget(events, surface, request.expectedAnchorId)
    assertLastBodyTarget(events, surface, target.seq, target.message)
    const existingLedger = ledgerForRegenerate(events, request.groupId, request.expectedAnchorId, request.expectedIndex)
    const previousIndex = existingLedger?.selectedIndex ?? 0
    const deny = normalizeDenyTools(request.writeToolDeny)

    // Proposal 0022 §5/§10: prepare the old turn's write rollback before the
    // anchor is hidden or the trigger turn starts. A prepare failure is a
    // fail-closed `body-state-unsafe` with zero body records written.
    const rollbackPlan = await prepareRegenerateRollback(deps, agentId, events, target.seq, request.expectedAnchorId)

    const opId = `body-op-${randomUUID()}`
    const triggerMessageId = `body-trigger-${opId}`
    const active: ActiveBodyOperation = {
      opId,
      agentId,
      groupId: request.groupId,
      previousAnchorId: request.expectedAnchorId,
      previousIndex,
      startSeq: -1,
      triggerMessageId,
      release: () => {},
      ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
      ...(rollbackPlan === undefined ? {} : { rollbackPlan }),
    }

    let opStarted = false
    try {
      const startEvent = appendBodyStartEvent(deps, {
        op: 'op-start',
        opId,
        groupId: request.groupId,
        kind: 'regenerate',
        previousAnchorId: request.expectedAnchorId,
        previousIndex,
        // Proposal 0022 §10.4: the prepared plan is durable, so a restart can
        // replay it without this process's `pendingByAgent` entry. The write
        // check refuses anything JSONL cannot keep before the record is written.
        ...(rollbackPlan === undefined ? {} : { rollbackPlan: durableRollbackPlan(rollbackPlan) }),
      })
      opStarted = true
      active.startSeq = eventSeqOf(startEvent) ?? nextEventSeq(events)
      pendingByAgent.set(agentId, active)

      if (existingLedger === undefined) {
        // First body operation on this floor: register the original reply as
        // candidate 0 so the body ledger and the JSONL swipes start at slot 0.
        appendBodyEvent(deps, {
          op: 'candidate',
          groupId: request.groupId,
          messageId: request.expectedAnchorId,
          index: 0,
        })
      }
      active.release = applyWriteRestriction(deps, deny)
      await deps.agent.followup(buildRegenerateTrigger(deps, active, request.feedback))
      return {
        opId,
        release: active.release,
        triggerMessageId,
        op: operationView(active),
      }
    } catch (error) {
      const reason = `body regenerate ${opId} failed to start: ${errorMessage(error)}`

      // Proposal 0022 §10.3: prepare already rolled the old writes back. If
      // any later start step fails, put those writes back before surfacing the
      // error so the store never stays rolled back while the old body remains.
      let compensationError: unknown
      if (rollbackPlan !== undefined && deps.writeRollback !== undefined) {
        try {
          await deps.writeRollback.restore(rollbackPlan)
        } catch (restoreError) {
          compensationError = restoreError
        }
      }

      if (opStarted) {
        try {
          appendOpFinish(deps, opId, 'failed', undefined, reason)
        } catch (finishError) {
          warn(deps, `body runtime: failed to record op-finish for start failure ${opId}: ${errorMessage(finishError)}`)
        }
      }
      releaseOperation(deps, active)

      if (compensationError !== undefined) {
        const combined = new AggregateError(
          [error, compensationError],
          `${reason}; the prepared write rollback could not be restored: ${errorMessage(compensationError)}`,
        )
        const failure = bodyRuntimeError('operation-failed', combined.message)
        failure.cause = combined
        failure.op = operationView(active)
        throw failure
      }
      throw failureFor(error, reason, operationView(active))
    }
  })
}

/** Append an edit event and return the resulting body state. */
export async function applyBodyEdit(
  deps: BodyRuntimeDeps,
  request: EditBodyRequest,
): Promise<BodyRuntimeState> {
  validateEditRequest(request)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
    const surface = surfaceNodeList(deps.session)
    const target = anchorTarget(events, surface, request.expectedAnchorId)
    assertLastBodyTarget(events, surface, target.seq, target.message)
    const ledger = ensureBodyLedger(deps, request.groupId, request.expectedAnchorId).ledger
    const candidate = requireCandidate(ledger, request.index)
    if (request.index !== ledger.selectedIndex) {
      throw bodyRuntimeError(
        'stale-anchor',
        `body edit rejected: group '${request.groupId}' has candidate ${ledger.selectedIndex} selected, but index ${request.index} was requested; only the selected body can be edited`,
      )
    }
    const previousText = candidateText(ledger, request.index)
    const text = request.text
    if (text.trim() === '') {
      throw bodyRuntimeError('invalid-body-text', `body edit rejected: text for group '${request.groupId}' index ${request.index} is empty`)
    }
    if (text.length > BODY_TEXT_MAX_LENGTH) {
      throw bodyRuntimeError(
        'invalid-body-text',
        `body edit rejected: text for group '${request.groupId}' index ${request.index} has ${text.length} characters (max ${BODY_TEXT_MAX_LENGTH})`,
      )
    }
    // Proposal 0023 §4.1/§4.2: the candidate-receipt preflight is read-only and
    // must finish before the edit event becomes durable. A refusal leaves the
    // ledger, the JSONL chat and the session log untouched.
    if (deps.inspectEdit !== undefined) {
      await deps.inspectEdit({
        groupId: request.groupId,
        index: request.index,
        messageId: candidate.messageId,
        previousText,
        ledger,
      })
    }
    appendBodyEvent(deps, {
      op: 'edit',
      groupId: request.groupId,
      index: request.index,
      text,
      previousText,
    })
    const updated = bodyLedger(eventsOf(deps.session), request.groupId)
    if (updated === undefined) {
      throw bodyRuntimeError('host-unsupported', `body edit for group '${request.groupId}' did not leave a readable body ledger`)
    }
    return stateFromLedger(updated)
  })
}

/** Append a select event and return the resulting body state. */
export async function selectBodyCandidate(
  deps: BodyRuntimeDeps,
  request: SelectBodyRequest,
): Promise<BodyRuntimeState> {
  validateSelectRequest(request)
  assertRecordWriter(deps)
  return withBodyLock(deps, async () => {
    const events = eventsOf(deps.session)
    const surface = surfaceNodeList(deps.session)
    const target = anchorTarget(events, surface, request.expectedAnchorId)
    assertLastBodyTarget(events, surface, target.seq, target.message)
    const ledger = ensureBodyLedger(deps, request.groupId, request.expectedAnchorId).ledger
    requireCandidate(ledger, request.index)
    appendBodyEvent(deps, { op: 'select', groupId: request.groupId, index: request.index })
    const updated = bodyLedger(eventsOf(deps.session), request.groupId)
    if (updated === undefined) {
      throw bodyRuntimeError('host-unsupported', `body select for group '${request.groupId}' did not leave a readable body ledger`)
    }
    return stateFromLedger(updated)
  })
}

/**
 * Prepare the old turn's write rollback.
 *
 * The turn comes from the old anchor itself (its `data.turn`, or the turn that
 * was open/closed at that sequence), never from the trigger turn that is about
 * to start. Any prepare failure is reported as `body-state-unsafe` so the
 * caller refuses before writing an `op-start` or hiding the anchor.
 */
async function prepareRegenerateRollback(
  deps: BodyRuntimeDeps,
  agentId: string,
  events: ReturnType<typeof eventsOf>,
  anchorSeq: number,
  previousAnchorId: string,
): Promise<BodyRollbackPlan | undefined> {
  const port = deps.writeRollback
  if (port === undefined) return undefined
  const oldTurn = turnOfEventSeq(events, anchorSeq)
  if (oldTurn === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body regenerate for session '${agentId}' refused: cannot derive the turn of anchor '${previousAnchorId}' from the session log`,
    )
  }
  try {
    return await port.prepare(agentId, oldTurn, previousAnchorId)
  } catch (error) {
    const detail = error instanceof BodyRollbackError ? error.detail : undefined
    const failure = bodyRuntimeError(
      'body-state-unsafe',
      `body regenerate for session '${agentId}' refused: cannot prepare the write rollback of turn ${oldTurn} for anchor '${previousAnchorId}': ${errorMessage(error)}`,
      detail,
    )
    failure.cause = error
    throw failure
  }
}

/**
 * Fold `op-start` events that never received `op-finish`. Startup recovery
 * uses this list to decide between candidate settlement and a body restore.
 * A durable `rollbackPlan` carried by the record is attached to the operation,
 * so the restore path can replay the old writes after a restart. A durable
 * `op-settled` marker is attached as `settled`: that operation already replaced
 * the body, so recovery must only retry `op-finish`.
 */
export function foldPendingOps(events: readonly unknown[]): readonly PendingBodyOperation[] {
  const parsed = parseEventList(events, 'foldPendingOps')
  const pending = new Map<string, PendingBodyOperation>()
  const finished = new Set<string>()
  for (const event of parsed) {
    const settled = parseSettledEvent(event)
    if (settled !== undefined) {
      const op = pending.get(settled.opId)
      if (op !== undefined) {
        op.settled = { anchorId: settled.anchorId, index: settled.index }
        continue
      }
      // A marker repeated after op-finish is harmless evidence of the same
      // completed operation; one without any open op-start is a broken log.
      if (finished.has(settled.opId)) continue
      throw bodyRuntimeError(
        'invalid-event',
        `foldPendingOps: body settled record at seq ${event.seq} references operation '${settled.opId}' with no open op-start`,
      )
    }
    const data = pendingEventOf(event)
    if (data === undefined) continue
    if (data.kind === 'start') {
      if (pending.has(data.opId)) {
        throw bodyRuntimeError('invalid-event', `foldPendingOps: duplicate open body operation '${data.opId}' at seq ${event.seq}`)
      }
      pending.set(data.opId, {
        opId: data.opId,
        groupId: data.groupId,
        previousAnchorId: data.previousAnchorId,
        previousIndex: data.previousIndex,
        startSeq: event.seq,
        triggerMessageId: triggerMessageIdFor(data.opId),
        ...(data.rollbackPlan === undefined ? {} : { rollbackPlan: data.rollbackPlan }),
      })
      continue
    }
    pending.delete(data.opId)
    finished.add(data.opId)
  }
  return [...pending.values()].sort((left, right) => left.startSeq - right.startSeq)
}
