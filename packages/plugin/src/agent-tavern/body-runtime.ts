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
import {
  BODY_TEXT_MAX_LENGTH,
  appendBodyEvent,
  appendOpFinish,
  assertAgentIdle,
  assertCanAdvanceTurnBase,
  assertRecordWriter,
  bodyRuntimeError,
  errorMessage,
  failureFor,
  operationView,
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
import {
  eventSeqOf,
  eventsOf,
  nextEventSeq,
  parseEventList,
  pendingEventOf,
  surfaceNodeList,
  triggerMessageIdFor,
} from './body-runtime-session.js'
import {
  anchorTarget,
  appendHideInBridgeTurn,
  applyWriteRestriction,
  assertLastBodyTarget,
  bodyLedger,
  buildRegenerateTrigger,
  candidateText,
  ensureBodyLedger,
  ledgerForRegenerate,
  normalizeDenyTools,
  oldBodyTargets,
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
  BodyLogger,
  BodyRuntimeDeps,
  BodyRuntimeErrorCode,
  BodyRuntimeFailure,
  BodyRuntimeState,
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
 * The previous anchor is moved out of the model surface before `followup` is
 * called. A small bridge turn is used because DSH v4 only admits
 * `developer/message` inside an open turn and step; the bridge keeps the
 * replacement reload-valid without fabricating an assistant replacement.
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

    const startEvent = appendBodyEvent(deps, {
      op: 'op-start',
      opId,
      groupId: request.groupId,
      kind: 'regenerate',
      previousAnchorId: request.expectedAnchorId,
      previousIndex,
    })
    active.startSeq = eventSeqOf(startEvent) ?? nextEventSeq(events)
    pendingByAgent.set(agentId, active)

    try {
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
      appendHideInBridgeTurn(deps, oldBodyTargets(events, surface, target))
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
      try {
        appendOpFinish(deps, opId, 'failed', undefined, reason)
      } catch (finishError) {
        warn(deps, `body runtime: failed to record op-finish for start failure ${opId}: ${errorMessage(finishError)}`)
      }
      releaseOperation(deps, active)
      pendingByAgent.delete(agentId)
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
    requireCandidate(ledger, request.index)
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
 * Fold `op-start` events that never received `op-finish`. Startup recovery
 * uses this list to decide between candidate settlement and a body restore.
 */
export function foldPendingOps(events: readonly unknown[]): readonly PendingBodyOperation[] {
  const parsed = parseEventList(events, 'foldPendingOps')
  const pending = new Map<string, PendingBodyOperation>()
  for (const event of parsed) {
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
      })
      continue
    }
    pending.delete(data.opId)
  }
  return [...pending.values()].sort((left, right) => left.startSeq - right.startSeq)
}
