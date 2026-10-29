/**
 * AgentTavern body crash recovery.
 *
 * Startup and `agent/created` both enter here. Recovery first consumes
 * `op-prepare` records that never reached `op-start` (the plan is durable but
 * the operation is not, so the old writes are put back), then folds `op-start`
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
import { store as tavernStore, variables as tavernVariables } from '../runtime.js'
import { appendPrepareRecovered } from './body-rollback-prepare.js'
import {
  foldSettleIntents,
  recoverOpenSettleIntents,
  type SettleIntentOpenEntry,
  type SettleIntentRecovery,
  type WriteJournalSession,
} from './body-settle-intent.js'
import {
  finalizeRecoveredOperation,
  foldPendingOps,
  foldPendingPrepares,
  restoreBodyAfterFailure,
  type BodyAgentLike,
  type BodyRuntimeDeps,
  type PendingBodyOperation,
  type PendingBodyPrepare,
} from './body-runtime.js'
import { settlementEvidenceOf } from './body-runtime-core.js'
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
 * `finish-pending` means the body is durably settled but its `op-finish` still
 * could not be written; it is deliberately not counted as a restore.
 */
export interface BodyRecoveryOutcome {
  readonly agentId: string
  readonly status: 'clean' | 'settled' | 'restored' | 'finish-pending' | 'skipped' | 'failed'
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

  let prepares: readonly PendingBodyPrepare[]
  try {
    prepares = foldPendingPrepares(initial)
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: foldPendingPrepares failed during recovery', {
      agentId,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return { agentId, status: 'failed', pending: 0, reason: 'invalid-event' }
  }

  // Proposal 0022 §10: a durable `op-prepare` without `op-start`/`op-finish`
  // may have rolled the old writes back. Restore first: it only touches stores
  // and the chat, never the surface, so it is safe before any body settlement.
  //
  // Settle intents ride their own records and never enter the body journal.
  // Restoring them before a plan replay makes the flat store match the chat.
  const settleRecovery = await recoverSettleIntents(ctx, deps, agentId, initial)
  const prepareOutcome = await restoreInterruptedPrepares(ctx, deps, prepares)

  if (pending.length === 0) {
    const openTurn = openTurnNumber(initial)
    if (openTurn !== undefined) closeRecoveredBracket(ctx, agent, openTurn, agentId)
    const status: BodyRecoveryOutcome['status'] = prepareOutcome.failed > 0 || settleRecovery.failed > 0
      ? 'failed'
      : prepareOutcome.restored > 0 || settleRecovery.restored > 0
        ? 'restored'
        : 'clean'
    return { agentId, status, pending: 0, ...(openTurn === undefined ? {} : { reason: `closed-turn-${openTurn}` }) }
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
    if (op.settleCancelled !== undefined) {
      info(ctx, 'dsh-soulmojito body: recovery found a cancelled settlement and will restore the previous body', {
        agentId,
        opId: op.opId,
        stage: 'cancelled',
        reason: op.settleCancelled.reason,
      })
    }
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
        if (op.settling !== undefined) {
          info(ctx, 'dsh-soulmojito body: recovery completed a settling operation', {
            agentId,
            opId: op.opId,
            stage: 'settling-recovered',
            anchorMessageId: result.anchorMessageId,
          })
        }
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
  let finishPending = 0
  let failed = 0
  for (const op of restoreOps) {
    const outcome = await restoreRecoveredOperation(ctx, deps, op)
    if (outcome === 'restored') restored += 1
    else if (outcome === 'finish-pending') finishPending += 1
    else failed += 1
  }

  const status: BodyRecoveryOutcome['status'] = failed > 0 || prepareOutcome.failed > 0 || settleRecovery.failed > 0
    ? 'failed'
    : finishPending > 0
      ? 'finish-pending'
      : settled > 0
        ? 'settled'
        : restored > 0 || prepareOutcome.restored > 0 || settleRecovery.restored > 0
          ? 'restored'
          : 'clean'
  return {
    agentId,
    status,
    pending: pending.length,
    ...(openTurn === undefined ? {} : { reason: `closed-turn-${openTurn}` }),
  }
}

/** Counts of prepare records a recovery pass restored or left for retry. */
interface PrepareRecoveryOutcome {
  readonly restored: number
  readonly failed: number
}

/**
 * Consume unclosed settle intents before any body state is settled or restored.
 *
 * Folding is pure, so the Tavern and variable stores open only when an intent
 * exists. A malformed record or an unreadable store reports a failure and keeps
 * the body outcome honest; it never appends an assistant message or touches the
 * surface.
 */
async function recoverSettleIntents(
  ctx: BodyRecoveryHost,
  deps: BodyRuntimeDeps,
  agentId: string,
  events: readonly unknown[],
): Promise<SettleIntentRecovery> {
  let intents: readonly SettleIntentOpenEntry[]
  try {
    intents = foldSettleIntents(events)
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: foldSettleIntents failed during recovery', {
      agentId,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return { restored: 0, committed: 0, failed: 1, failures: [errorMessage(error)] }
  }
  if (intents.length === 0) return { restored: 0, committed: 0, failed: 0, failures: [] }

  try {
    const appendRecord = deps.appendRecord
    const outcome = await recoverOpenSettleIntents(
      {
        store: await tavernStore(),
        variableStore: await tavernVariables(),
        ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      },
      agentId,
      deps.session,
      appendRecord === undefined
        ? undefined
        : (_session: WriteJournalSession, type: string, data: unknown) => appendRecord(deps.session, type, data),
      intents,
    )
    if (outcome.restored > 0) {
      info(ctx, 'dsh-soulmojito body: recovery restored flat variables from settle intents', {
        agentId,
        restored: outcome.restored,
        committed: outcome.committed,
      })
    }
    if (outcome.failed > 0) {
      warn(ctx, 'dsh-soulmojito body: recovery left settle intents open for the next startup', {
        agentId,
        intents: intents.length,
        failed: outcome.failed,
        failures: outcome.failures.join('; '),
      })
    }
    return outcome
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: settle intent recovery failed', {
      agentId,
      intents: intents.length,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return { restored: 0, committed: 0, failed: intents.length, failures: [errorMessage(error)] }
  }
}

/**
 * Restore the old writes of prepares that never reached `op-start`.
 *
 * `restore(plan)` replays the journal and redoes the plan's MVU receipts, so a
 * prepare whose `apply` never ran is a no-op and one whose `apply` ran puts the
 * old turn back. Nothing here appends an assistant message or touches the
 * surface. A successful restore is consumed with an `op-prepare-recovered`
 * record; a failed restore or marker keeps the prepare pending for the next
 * startup instead of pretending the writes are back.
 */
async function restoreInterruptedPrepares(
  ctx: BodyRecoveryHost,
  deps: BodyRuntimeDeps,
  prepares: readonly PendingBodyPrepare[],
): Promise<PrepareRecoveryOutcome> {
  if (prepares.length === 0) return { restored: 0, failed: 0 }
  const port = deps.writeRollback
  if (port === undefined) {
    errorLog(ctx, 'dsh-soulmojito body: recovery cannot restore an interrupted prepare without a write rollback port', {
      agentId: deps.agent.id,
      prepares: prepares.length,
      reason: 'host-unsupported',
    })
    return { restored: 0, failed: prepares.length }
  }

  let restored = 0
  let failed = 0
  for (const prepare of prepares) {
    try {
      await port.restore(prepare.plan)
    } catch (error) {
      errorLog(ctx, 'dsh-soulmojito body: recovery could not restore an interrupted prepare', {
        agentId: deps.agent.id,
        opId: prepare.opId,
        turn: prepare.plan.turn,
        stage: 'prepare-interrupted-restore-failed',
        code: failureCodeOf(error),
        error: errorMessage(error),
      })
      failed += 1
      continue
    }
    try {
      appendPrepareRecovered(deps, prepare.opId, 'prepare-interrupted')
    } catch (error) {
      errorLog(ctx, 'dsh-soulmojito body: recovery restored an interrupted prepare but could not consume it', {
        agentId: deps.agent.id,
        opId: prepare.opId,
        stage: 'prepare-interrupted-marker-failed',
        code: failureCodeOf(error),
        error: errorMessage(error),
      })
      failed += 1
      continue
    }
    restored += 1
    info(ctx, 'dsh-soulmojito body: recovery restored the writes of an interrupted prepare', {
      agentId: deps.agent.id,
      opId: prepare.opId,
      turn: prepare.plan.turn,
      previousMessageId: prepare.plan.previousMessageId,
      stage: 'prepare-interrupted',
    })
  }
  return { restored, failed }
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

type RecoveryRestoreOutcome = 'restored' | 'finish-pending' | 'failed'

/**
 * Put the previous anchor back after a recovered operation produced no usable
 * candidate. `restoreBodyAfterFailure` owns the model-free hide when the old
 * anchor is still on the surface, the legacy restore turn otherwise, and the
 * settled-body short circuit.
 *
 * A return that leaves durable `settled` evidence means the body is already
 * replaced and only `op-finish` is missing: that is `finish-pending`, never a
 * restore, even though the same runtime call performed the check.
 */
async function restoreRecoveredOperation(
  ctx: BodyRecoveryHost,
  deps: BodyRuntimeDeps,
  op: PendingBodyOperation,
): Promise<RecoveryRestoreOutcome> {
  try {
    const restoredAnchorId = await restoreBodyAfterFailure(deps, op)
    const evidence = settlementEvidenceOf(wiringEvents(deps.session) ?? [], op.opId)
    if (evidence?.phase === 'settled') {
      // The settled marker kept the new body; only `op-finish` is still
      // missing, so the next recovery pass must retry the bookkeeping.
      info(ctx, 'dsh-soulmojito body: recovery kept the settled body with op-finish pending', {
        agentId: deps.agent.id,
        opId: op.opId,
        stage: 'settled-finish-pending',
        anchorId: restoredAnchorId,
      })
      return 'finish-pending'
    }
    info(ctx, 'dsh-soulmojito body: recovery restored the previous anchor', {
      agentId: deps.agent.id,
      opId: op.opId,
      stage: evidence?.phase === 'cancelled' ? 'cancelled' : 'restored',
      restoredAnchorId,
    })
    return 'restored'
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: recovery restore failed', {
      agentId: deps.agent.id,
      opId: op.opId,
      stage: op.settling === undefined ? 'restore-failed' : 'settling-restore-failed',
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
    return 'failed'
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
