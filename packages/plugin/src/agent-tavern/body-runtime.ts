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
import { appendPrepareRecovered, appendPreparedRollback, foldPreparedOperations, type PendingBodyPrepare } from './body-rollback-prepare.js'
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
  type BodyRuntimeFailure,
  type BodyRuntimeState,
  type BodySettledEvent,
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
export { BODY_PREPARE_EVENT_TYPE } from './body-rollback-prepare.js'
export type { BodyPrepareEventData, PendingBodyPrepare } from './body-rollback-prepare.js'
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
 * The write rollback goes through three durable steps before the trigger turn
 * exists (proposal 0022 §10):
 *
 * 1. `plan` reads the old turn and returns a draft without touching a store.
 * 2. `op-prepare` persists that draft as a log-only plugin record.
 * 3. `apply` rolls the old writes back, then `op-start` carries the final plan.
 *
 * A crash between 2 and 3 is recoverable from the log alone. Ports without
 * `plan`/`apply` keep the legacy single-call `prepare`.
 *
 * The previous anchor deliberately stays on the model surface while the new
 * turn runs, so a failed regeneration has nothing to add back: the old body
 * never left. Successful settlement hides it together with the new turn's
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
    }

    const port = deps.writeRollback
    let prepareRecordWritten = false
    let opStarted = false
    let drafted: BodyRollbackPlan | undefined
    try {
      if (port !== undefined && typeof port.plan === 'function' && typeof port.apply === 'function') {
        drafted = await planRegenerateRollback(deps, agentId, events, target.seq, request.expectedAnchorId)
        // The draft is durable before `apply` mutates a store, so a restart can
        // replay it without any process-local state.
        appendPreparedRollback(deps, opId, request.groupId, drafted)
        prepareRecordWritten = true
        active.rollbackPlan = await applyRegenerateRollback(deps, drafted)
      } else {
        active.rollbackPlan = await prepareRegenerateRollback(deps, agentId, events, target.seq, request.expectedAnchorId)
      }

      const startEvent = appendBodyStartEvent(deps, {
        op: 'op-start',
        opId,
        groupId: request.groupId,
        kind: 'regenerate',
        previousAnchorId: request.expectedAnchorId,
        previousIndex,
        // Proposal 0022 §10.4: the applied plan is durable, so a restart can
        // replay it without this process's `pendingByAgent` entry. The write
        // check refuses anything JSONL cannot keep before the record is written.
        ...(active.rollbackPlan === undefined ? {} : { rollbackPlan: durableRollbackPlan(active.rollbackPlan) }),
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

      // Proposal 0022 §10.3: the plan is already rolled back once `apply` ran.
      // Any later start failure puts those writes back before surfacing the
      // error. A draft plan that never reached `apply` is restored too: replay
      // is a no-op over the still-current journal, but heals a partial apply.
      let compensationError: unknown
      const planToRestore = prepareRecordWritten ? active.rollbackPlan ?? drafted : active.rollbackPlan
      if (planToRestore !== undefined && port !== undefined) {
        try {
          await port.restore(planToRestore)
        } catch (restoreError) {
          compensationError = restoreError
        }
      }

      // `op-start` consumes the prepare record. When the start stopped before
      // that record exists and the writes were put back, a recovery marker
      // keeps the next startup from replaying an already-restored plan.
      if (prepareRecordWritten && !opStarted && compensationError === undefined) {
        try {
          appendPrepareRecovered(deps, opId, 'body regenerate start failed after op-prepare')
        } catch (markerError) {
          warn(deps, `body runtime: failed to record the op-prepare-recovered marker for ${opId}: ${errorMessage(markerError)}`)
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
 * Read-only plan step of a regeneration (proposal 0022 §10).
 *
 * The turn comes from the old anchor itself (its `data.turn`, or the turn that
 * was open/closed at that sequence), never from the trigger turn that is about
 * to start. Any failure is reported as `body-state-unsafe`, so the caller
 * refuses before `op-prepare` or `op-start` exists.
 */
async function planRegenerateRollback(
  deps: BodyRuntimeDeps,
  agentId: string,
  events: ReturnType<typeof eventsOf>,
  anchorSeq: number,
  previousAnchorId: string,
): Promise<BodyRollbackPlan> {
  const port = deps.writeRollback
  const plan = port?.plan
  if (port === undefined || plan === undefined) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body regenerate for session '${agentId}' cannot plan the write rollback: deps.writeRollback exposes no plan()`,
    )
  }
  const oldTurn = requireAnchorTurn(events, agentId, anchorSeq, previousAnchorId)
  try {
    return await plan.call(port, agentId, oldTurn, previousAnchorId)
  } catch (error) {
    throw regenerationRollbackFailure(error, agentId, oldTurn, previousAnchorId, 'plan')
  }
}

/**
 * Mutating apply step of a regeneration.
 *
 * `apply` owns the journal undo, the receipt undo and the chat CAS save, so a
 * failure here still runs inside the port's own compensation. The caller
 * restores the draft plan afterwards: replay is a no-op when the compensation
 * completed and heals a partial rollback when it did not.
 */
async function applyRegenerateRollback(deps: BodyRuntimeDeps, plan: BodyRollbackPlan): Promise<BodyRollbackPlan> {
  const port = deps.writeRollback
  const apply = port?.apply
  if (port === undefined || apply === undefined) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body regenerate for session '${plan.sessionId}' cannot apply the write rollback: deps.writeRollback exposes no apply()`,
    )
  }
  try {
    return await apply.call(port, plan)
  } catch (error) {
    throw regenerationRollbackFailure(error, plan.sessionId, plan.turn, plan.previousMessageId, 'apply')
  }
}

/**
 * Prepare the old turn's write rollback.
 *
 * Compatibility path for a port that exposes only `prepare` (plan + apply in
 * one call). The plan is applied immediately, exactly like the pre-split build.
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
  const oldTurn = requireAnchorTurn(events, agentId, anchorSeq, previousAnchorId)
  try {
    return await port.prepare(agentId, oldTurn, previousAnchorId)
  } catch (error) {
    throw regenerationRollbackFailure(error, agentId, oldTurn, previousAnchorId, 'prepare')
  }
}

function requireAnchorTurn(
  events: ReturnType<typeof eventsOf>,
  agentId: string,
  anchorSeq: number,
  previousAnchorId: string,
): number {
  const oldTurn = turnOfEventSeq(events, anchorSeq)
  if (oldTurn === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body regenerate for session '${agentId}' refused: cannot derive the turn of anchor '${previousAnchorId}' from the session log`,
    )
  }
  return oldTurn
}

function regenerationRollbackFailure(
  error: unknown,
  agentId: string,
  turn: number,
  previousAnchorId: string,
  step: 'plan' | 'apply' | 'prepare',
): BodyRuntimeFailure {
  const detail = error instanceof BodyRollbackError ? error.detail : undefined
  const failure = bodyRuntimeError(
    'body-state-unsafe',
    `body regenerate for session '${agentId}' refused: cannot ${step} the write rollback of turn ${turn} for anchor '${previousAnchorId}': ${errorMessage(error)}`,
    detail,
  )
  failure.cause = error
  return failure
}

/**
 * Fold the durable `op-prepare` records a restart still has to restore
 * (proposal 0022 §10).
 *
 * A prepare with a matching `op-start` or `op-finish` is ignored: the runtime
 * applied it and the plan already travels with the operation. Only an
 * unconsumed prepare means "the old writes may be rolled back without a durable
 * op", which startup recovery resolves with `restore(plan)`.
 */
export function foldPendingPrepares(events: readonly unknown[]): readonly PendingBodyPrepare[] {
  return foldPreparedOperations(parseEventList(events, 'foldPendingPrepares'))
}

/**
 * Fold `op-start` events that never received `op-finish`. Startup recovery
 * uses this list to decide between candidate settlement and a body restore.
 * A durable `rollbackPlan` carried by the record is attached to the operation,
 * so the restore path can replay the old writes after a restart. Two-phase
 * `body-settled` records are attached as `settled`, `settling` or
 * `settleCancelled`: recovery must resolve `settling` against the surface and
 * ledger, and must never treat `settleCancelled` as settled.
 */
export function foldPendingOps(events: readonly unknown[]): readonly PendingBodyOperation[] {
  const parsed = parseEventList(events, 'foldPendingOps')
  // `op-prepare` records are not operations, but a malformed durable plan must
  // fail the whole fold instead of being silently skipped by recovery.
  foldPreparedOperations(parsed)

  const pending = new Map<string, PendingBodyOperation>()
  const finished = new Set<string>()
  for (const event of parsed) {
    const settlement = parseSettledEvent(event)
    if (settlement !== undefined) {
      const op = pending.get(settlement.opId)
      if (op !== undefined) {
        applySettlementEvidence(op, settlement, event.seq)
        continue
      }
      // A marker repeated after op-finish is harmless evidence of the same
      // completed operation; one without any open op-start is a broken log.
      if (finished.has(settlement.opId)) continue
      throw bodyRuntimeError(
        'invalid-event',
        `foldPendingOps: body settled record at seq ${event.seq} references operation '${settlement.opId}' with no open op-start`,
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

/**
 * Attach one settlement record to its open operation. The latest record wins:
 * a cancelled attempt clears earlier settlement proof, and a later settled
 * record clears an earlier cancellation.
 */
function applySettlementEvidence(
  op: PendingBodyOperation,
  settlement: BodySettledEvent,
  seq: number,
): void {
  if (settlement.groupId !== op.groupId) {
    throw bodyRuntimeError(
      'invalid-event',
      `foldPendingOps: settlement record at seq ${seq} references group '${settlement.groupId}', not '${op.groupId}' of operation '${settlement.opId}'`,
    )
  }
  const marker = { anchorId: settlement.anchorId, index: settlement.index }
  if (settlement.phase === 'settled') {
    op.settled = marker
    delete op.settling
    delete op.settleCancelled
    return
  }
  delete op.settled
  if (settlement.phase === 'settling') {
    op.settling = marker
    delete op.settleCancelled
    return
  }
  op.settleCancelled = {
    anchorId: settlement.anchorId,
    index: settlement.index,
    reason: settlement.reason ?? 'settlement-cancelled',
  }
  delete op.settling
}
