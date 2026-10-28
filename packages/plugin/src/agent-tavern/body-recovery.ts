/**
 * AgentTavern body crash recovery.
 *
 * Startup and `agent/created` both enter here. Recovery folds `op-start`
 * records that never received `op-finish`, settles the ones the runtime can
 * settle through `finalizeRecoveredOperation` (the same helper turn-stopping
 * uses), restores the rest with `restoreBodyAfterFailure`, and closes a
 * half-open bracket with `closeImportBracket`.
 *
 * Proposal §10 gate: an MVU-managed chat keeps every op unfinished and writes
 * nothing until variable rollback exists.
 */

import type { HostLogger, HostAgentsService } from '../host-contract.js'
import { advanceHostTurnBase, canAdvanceHostTurnBase, closeImportBracket, lastLoggedTurn } from '../session/trace.js'
import { store as tavernStore } from '../runtime.js'
import {
  finalizeRecoveredOperation,
  foldPendingOps,
  restoreBodyAfterFailure,
  type BodyAgentLike,
  type BodyRuntimeDeps,
  type PendingBodyOperation,
} from './body-runtime.js'
import {
  agentIdOf,
  bodyAgentOf,
  bodyBindingEligible,
  errorLog,
  errorMessage,
  failureCodeOf,
  hasToolCall,
  info,
  listLiveAgents,
  messageIdOf,
  messageOf,
  numberField,
  openTurnNumber,
  resolveBodyBinding,
  textOfMessage,
  warn,
  wiringEvents,
  type BodyBindingResolver,
  type BodyBindingView,
  type WiringEvent,
} from './body-session.js'
import {
  bodyStateSafetyOf,
  unsafeBodyState,
  type BodyStateSafety,
  type BodyStateSafetyResolver,
} from './body-view.js'

/** Structural host slice recovery needs; `BodyWiringContext` satisfies it. */
export interface BodyRecoveryHost {
  readonly logger?: HostLogger
  readonly agents?: HostAgentsService
  readonly bindingOf?: BodyBindingResolver
  readonly safetyOf?: BodyStateSafetyResolver
}

/** Builds the runtime deps bundle (injected to avoid a wiring import cycle). */
export type BodyDepsFactory = (
  ctx: BodyRecoveryHost,
  agent: BodyAgentLike,
) => Promise<BodyRuntimeDeps | undefined>

/**
 * One agent's recovery result. `pending` counts `op-start` records without
 * `op-finish`, so tests and logs can distinguish a clean session from a repair.
 */
export interface BodyRecoveryOutcome {
  readonly agentId: string
  readonly status: 'clean' | 'settled' | 'restored' | 'skipped' | 'failed'
  readonly pending: number
  readonly reason?: string
}

const recoveryInFlight = new Set<string>()

/**
 * Startup recovery over every live agent the host exposes.
 *
 * Hosts without `agents.list()` fall back to the `agent/created` path; this
 * function then returns an empty report instead of guessing sessions.
 */
export async function recoverBodyOperationsWith(
  ctx: BodyRecoveryHost,
  createDeps: BodyDepsFactory,
): Promise<readonly BodyRecoveryOutcome[]> {
  const outcomes: BodyRecoveryOutcome[] = []
  for (const agent of listLiveAgents(ctx)) {
    outcomes.push(await recoverBodyOperationWith(ctx, agent, createDeps))
  }
  return outcomes
}

/**
 * Recover one agent.
 *
 * - `op-start` with a text assistant candidate settles through the runtime's
 *   `finalizeRecoveredOperation` (same settlement helper as turn-stopping,
 *   including its trigger/process hide step);
 * - `op-start` whose settlement failed or whose trigger turn does not match the
 *   candidate restores the previous anchor;
 * - a half-open turn is closed with the existing `closeImportBracket` helper,
 *   only after every settlement attempt (the open turn is what settlement hides
 *   its nodes in).
 *
 * An MVU-unsafe chat keeps every op unfinished with zero writes (proposal §10).
 * Agent busy/running is skipped: recovery must never close or rewrite a live
 * turn. Failures are logged with structured fields and left pending for the
 * next startup, never silently dropped.
 */
export async function recoverBodyOperationWith(
  ctx: BodyRecoveryHost,
  agentValue: unknown,
  createDeps: BodyDepsFactory,
): Promise<BodyRecoveryOutcome> {
  const agent = bodyAgentOf(agentValue)
  const agentId = agent === undefined ? undefined : agentIdOf(agent)
  if (agent === undefined || agentId === undefined) {
    return { agentId: '', status: 'skipped', pending: 0, reason: 'agent-shape' }
  }
  if (agent.status === 'running') {
    return { agentId, status: 'skipped', pending: 0, reason: 'agent-running' }
  }
  if (recoveryInFlight.has(agentId)) {
    return { agentId, status: 'skipped', pending: 0, reason: 'recovery-in-flight' }
  }

  recoveryInFlight.add(agentId)
  try {
    return await recoverAgentBody(ctx, agent, agentId, createDeps)
  } finally {
    recoveryInFlight.delete(agentId)
  }
}

async function recoverAgentBody(
  ctx: BodyRecoveryHost,
  agent: BodyAgentLike,
  agentId: string,
  createDeps: BodyDepsFactory,
): Promise<BodyRecoveryOutcome> {
  const binding = await resolveBodyBinding(ctx, agentId)
  if (binding === undefined || !bodyBindingEligible(binding)) {
    return { agentId, status: 'skipped', pending: 0, reason: 'architecture-mismatch' }
  }

  const deps = await createDeps(ctx, agent)
  if (deps === undefined) {
    warn(ctx, 'dsh-soulmojito body: recovery skipped because the plugin-record seam is unavailable', {
      reason: 'host-unsupported',
      agentId,
    })
    return { agentId, status: 'skipped', pending: 0, reason: 'host-unsupported' }
  }

  const initial = wiringEvents(deps.session)
  if (initial === undefined) {
    errorLog(ctx, 'dsh-soulmojito body: recovery cannot read the session log', {
      agentId,
      reason: 'host-unsupported',
    })
    return { agentId, status: 'failed', pending: 0, reason: 'session-log' }
  }

  let pending: readonly PendingBodyOperation[]
  try {
    pending = foldPendingOps(initial)
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: foldPendingOps failed during recovery', {
      agentId,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return { agentId, status: 'failed', pending: 0, reason: 'invalid-event' }
  }

  if (pending.length === 0) {
    const openTurn = openTurnNumber(initial)
    if (openTurn !== undefined) closeRecoveredBracket(ctx, agent, openTurn, agentId)
    return { agentId, status: 'clean', pending: 0, ...(openTurn === undefined ? {} : { reason: `closed-turn-${openTurn}` }) }
  }

  // Proposal §10: an MVU-managed chat cannot settle or restore body state
  // until variable rollback exists. Keep every op unfinished and write nothing.
  const safety = await recoveryStateSafety(ctx, agentId, binding)
  if (!safety.safe) {
    warn(ctx, 'dsh-soulmojito body: recovery skipped because MVU state cannot be rolled back safely', {
      agentId,
      pending: pending.length,
      detail: safety.detail,
    })
    return { agentId, status: 'skipped', pending: pending.length, reason: 'body-state-unsafe' }
  }

  const events = wiringEvents(deps.session) ?? initial
  const restoreOps: PendingBodyOperation[] = []
  let settled = 0

  for (const op of pending) {
    // Order matters (proposal §9.2): the recovered turn may still be open, and
    // the runtime settles it in place before `closeImportBracket` closes it.
    const turn = recoveredTurnOf(events, op)
    const candidate = turn === undefined ? undefined : recoveredCandidateInTurn(events, op, turn)
    if (turn === undefined || candidate === undefined) {
      restoreOps.push(op)
      continue
    }

    try {
      const result = await finalizeRecoveredOperation(deps, op, turn)
      if (result.status === 'ok') {
        settled += 1
        continue
      }
      if (result.status === 'failed' || recoveryTurnMismatch(result.reason)) {
        errorLog(ctx, 'dsh-soulmojito body: recovery could not settle the candidate', {
          agentId,
          opId: op.opId,
          reason: result.reason,
        })
        restoreOps.push(op)
        continue
      }
      info(ctx, 'dsh-soulmojito body: recovery found the operation already settled', {
        agentId,
        opId: op.opId,
        reason: result.reason,
      })
    } catch (error) {
      errorLog(ctx, 'dsh-soulmojito body: finalizeRecoveredOperation failed during recovery', {
        agentId,
        opId: op.opId,
        code: failureCodeOf(error),
        error: errorMessage(error),
      })
      restoreOps.push(op)
    }
  }

  // Close the bracket only after every settlement attempt: an open trigger turn
  // is what lets `finalizeRecoveredOperation` hide its nodes; restores then need
  // the turn closed.
  const openTurn = openTurnNumber(wiringEvents(deps.session) ?? initial)
  if (openTurn !== undefined) closeRecoveredBracket(ctx, agent, openTurn, agentId)

  let restored = 0
  let failed = 0
  for (const op of restoreOps) {
    if (await restoreRecoveredOperation(ctx, deps, op)) restored += 1
    else failed += 1
  }

  const status: BodyRecoveryOutcome['status'] = failed > 0
    ? 'failed'
    : settled > 0
      ? 'settled'
      : restored > 0
        ? 'restored'
        : 'clean'
  return {
    agentId,
    status,
    pending: pending.length,
    ...(openTurn === undefined ? {} : { reason: `closed-turn-${openTurn}` }),
  }
}

/**
 * Resolve the proposal §10 safety verdict for one recovering agent.
 *
 * An injected resolver keeps tests away from the real Tavern store; the default
 * reads the bound character and chat. Any resolver failure fails closed, so an
 * unreadable safety state keeps the op unfinished instead of writing blind.
 */
async function recoveryStateSafety(
  ctx: BodyRecoveryHost,
  sessionId: string,
  binding: BodyBindingView,
): Promise<BodyStateSafety> {
  const resolve = ctx.safetyOf
  if (typeof resolve === 'function') {
    try {
      return await resolve(sessionId, binding) ?? unsafeBodyState('safety-unavailable')
    } catch (error) {
      errorLog(ctx, 'dsh-soulmojito body: recovery state safety resolver failed', {
        sessionId,
        error: errorMessage(error),
      })
      return unsafeBodyState('safety-unavailable')
    }
  }
  return defaultRecoveryStateSafety(ctx, binding)
}

async function defaultRecoveryStateSafety(
  ctx: BodyRecoveryHost,
  binding: BodyBindingView,
): Promise<BodyStateSafety> {
  const characterName = binding.character
  const chatId = binding.chatId
  if (characterName === undefined || chatId === undefined) return unsafeBodyState('chat-unreadable')
  try {
    const db = await tavernStore()
    const character = await db.getCharacter(characterName)
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (snapshot === undefined) return unsafeBodyState('chat-unreadable')
    return bodyStateSafetyOf(character, snapshot.chat)
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: recovery state safety could not be read', {
      error: errorMessage(error),
    })
    return unsafeBodyState('safety-unavailable')
  }
}

function recoveryTurnMismatch(reason: string): boolean {
  return /trigger belongs to turn \d+, not turn/.test(reason)
}

/**
 * Put the previous anchor back after a recovered operation produced no usable
 * candidate. `restoreBodyAfterFailure` owns the model-free hide when the old
 * anchor is still on the surface, and the legacy restore turn otherwise.
 */
async function restoreRecoveredOperation(
  ctx: BodyRecoveryHost,
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<boolean> {
  try {
    const restoredAnchorId = await restoreBodyAfterFailure(deps, op)
    if (op.settled !== undefined) {
      // The settled marker kept the new body; only `op-finish` is still
      // missing, so the next recovery pass must retry the bookkeeping.
      info(ctx, 'dsh-soulmojito body: recovery kept the settled body with op-finish pending', {
        agentId: deps.agent.id,
        opId: op.opId,
        anchorId: restoredAnchorId,
      })
      return true
    }
    info(ctx, 'dsh-soulmojito body: recovery restored the previous anchor', {
      agentId: deps.agent.id,
      opId: op.opId,
      restoredAnchorId,
    })
    return true
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: recovery restore failed', {
      agentId: deps.agent.id,
      opId: op.opId,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return false
  }
}

function closeRecoveredBracket(
  ctx: BodyRecoveryHost,
  agent: BodyAgentLike,
  openTurn: number,
  agentId: string,
): void {
  if (!canAdvanceHostTurnBase(agent)) {
    warn(ctx, 'dsh-soulmojito body: recovery found a half-open turn but the agent cannot advance its turn base', {
      agentId,
      openTurn,
      reason: 'host-unsupported',
    })
    return
  }
  const logged = closeImportBracket(agent, {
    kind: 'error',
    error: {
      message: `dsh-soulmojito body recovery closed half-open turn ${openTurn}`,
      code: 'BODY_RECOVERY',
    },
  })
  if (logged !== undefined) advanceHostTurnBase(agent, logged)
  info(ctx, 'dsh-soulmojito body: recovery closed a half-open turn', {
    agentId,
    openTurn,
    lastLoggedTurn: logged ?? lastLoggedTurn(agent),
  })
}

function recoveredTurnOf(events: readonly WiringEvent[], op: PendingBodyOperation): number | undefined {
  return turnOfUserMessage(events, triggerIdOf(op))
}

function recoveredCandidateInTurn(
  events: readonly WiringEvent[],
  op: PendingBodyOperation,
  turn: number,
): string | undefined {
  let found: string | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.seq <= op.startSeq) continue
    if (numberField(event.data['turn']) !== turn) continue
    const message = messageOf(event)
    const messageId = messageIdOf(event)
    if (message === undefined || messageId === undefined) continue
    if (textOfMessage(message).trim() === '' || hasToolCall(message)) continue
    found = messageId
  }
  return found
}

function triggerIdOf(op: PendingBodyOperation): string {
  return typeof op.triggerMessageId === 'string' && op.triggerMessageId !== ''
    ? op.triggerMessageId
    : `body-trigger-${op.opId}`
}

function turnOfUserMessage(events: readonly WiringEvent[], messageId: string): number | undefined {
  let openTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = numberField(event.data['turn'])
      continue
    }
    if (event.type === 'turn/end') {
      openTurn = undefined
      continue
    }
    if (event.type === 'user/message' && messageIdOf(event) === messageId) return openTurn
  }
  return undefined
}
