/**
 * AgentTavern body wiring facade (proposal 0021 §2.5, §2.6, §6).
 *
 * Owns the host-facing core: structural context, plugin-record seam, deps,
 * projection and the live turn listeners. Read policy lives in `body-view.ts`,
 * session reads in `body-session.ts`, crash recovery in `body-recovery.ts`.
 * The session log stays authoritative; `body-runtime.ts` owns every mutation.
 */

import { importHostPackage } from '../../../bind/src/index.js'
import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import { memories, store as tavernStore, variables } from '../runtime.js'
import { tavernDataRoot } from '../dsh-home.js'
import { embedMemoryRecord } from '../memory-hybrid.js'
import { embedBreakerOpen, readEmbedStatus } from '../memory-embed.js'
import type { HostSessionsService, PluginContext } from '../host-contract.js'
import { memoryEmbeddingConfig, memoryVectorStore } from './tools/stores.js'
import { inspectCandidateReceipts } from './body-candidate-receipts.js'
import { createBodyProjection } from './body.js'
import { locateBodyFloor } from './body-jsonl.js'
import {
  createBodyWriteRollbackPort,
  type BodyRollbackMemoryStore,
  type BodyRollbackMemoryVectors,
  type BodyRollbackStore,
  type BodyRollbackVariableStore,
} from './body-rollback.js'
import { operationView, pendingByAgent } from './body-runtime-core.js'
import {
  bodyRuntimeError,
  finalizeRecoveredOperation,
  finalizeTurnStopping,
  restoreBodyAfterFailure,
  type BodyAgentLike,
  type BodyEditInspection,
  type BodyRuntimeDeps,
  type BodySessionLike,
} from './body-runtime.js'
import { bodyStateUnsafeMessage } from './body-view.js'
import {
  agentIdOf,
  bodyAgentOf,
  bodyBindingEligible,
  errorLog,
  errorMessage,
  failureCodeOf,
  info,
  resolveBodyBinding,
  resolveLiveAgent,
  warn,
  wiringEvents,
  type BodyBindingResolver,
  type BodyBindingView,
} from './body-session.js'
import {
  recoverBodyOperationWith,
  recoverBodyOperationsWith,
  type BodyRecoveryHost,
  type BodyRecoveryOutcome,
} from './body-recovery.js'

/* ------------------------------- host surface ------------------------------ */

/** Structural host slice; missing services disable one feature instead of throwing. */
export interface BodyWiringContext extends BodyRecoveryHost {
  readonly sessions?: HostSessionsService
  readonly effect?: PluginContext['effect']
  readonly on?: PluginContext['on']
}

/** Host context slice accepted by `bodyWiringContext`. */
export type BodyWiringHost = Pick<PluginContext, 'logger' | 'sessions' | 'agents' | 'effect' | 'on'>

/** Assemble the structural context once, with an explicit binding resolver. */
export function bodyWiringContext(host: BodyWiringHost, bindingOf: BodyBindingResolver): BodyWiringContext {
  return {
    ...(host.logger === undefined ? {} : { logger: host.logger }),
    ...(host.sessions === undefined ? {} : { sessions: host.sessions }),
    ...(host.agents === undefined ? {} : { agents: host.agents }),
    effect: (callback, label) => host.effect(callback, label),
    on: (event, listener) => host.on?.(event, listener),
    bindingOf,
  }
}

/* --------------------------- plugin-record writer -------------------------- */

/** Writes one log-only plugin record; the host marks it `ignorable: true`. */
export type BodyRecordWriter = (
  session: BodySessionLike,
  type: string,
  data: unknown,
) => unknown

interface SessionHostModule {
  readonly appendPluginRecord?: unknown
  readonly pluginRecordOf?: unknown
}

let recordSeamWarningEmitted = false
let resolvedRecordWriter: BodyRecordWriter | undefined

/**
 * Resolve the experimental plugin-record seam. Both exports are required for
 * one version-gated API; a miss returns `undefined` and callers answer
 * `host-unsupported`. Successful resolutions are cached, misses are not.
 */
export async function resolveBodyRecordWriter(ctx: BodyWiringContext): Promise<BodyRecordWriter | undefined> {
  if (resolvedRecordWriter !== undefined) return resolvedRecordWriter

  let host: SessionHostModule
  try {
    host = await importHostPackage<SessionHostModule>('@deepseek-ai/dsh-session')
  } catch (error) {
    warnRecordSeamOnce(ctx, 'dsh-soulmojito body: cannot resolve @deepseek-ai/dsh-session', {
      reason: 'host-unsupported',
      error: errorMessage(error),
    })
    return undefined
  }

  const appendRecord = host.appendPluginRecord
  const pluginRecordOf = host.pluginRecordOf
  if (typeof appendRecord !== 'function' || typeof pluginRecordOf !== 'function') {
    warnRecordSeamOnce(ctx, 'dsh-soulmojito body: host has no appendPluginRecord/pluginRecordOf seam', {
      reason: 'host-unsupported',
      appendPluginRecord: typeof appendRecord,
      pluginRecordOf: typeof pluginRecordOf,
    })
    return undefined
  }

  const writer: BodyRecordWriter = (session, type, data) => appendRecord(session, type, data)
  resolvedRecordWriter = writer
  return writer
}

/** Build deps via one shared rollback seam; stores stay lazy for `GET body`. */
export async function createBodyDeps(
  ctx: BodyWiringContext,
  agent: BodyAgentLike,
): Promise<BodyRuntimeDeps | undefined> {
  const appendRecord = await resolveBodyRecordWriter(ctx)
  if (appendRecord === undefined) return undefined
  const rollbackStore = lazyRollbackStore()
  const writeRollback = createBodyWriteRollbackPort({
    store: rollbackStore,
    memoryStore: lazyRollbackMemoryStore(),
    variableStore: lazyRollbackVariableStore(),
    memoryVectors: lazyRollbackMemoryVectors(),
    sessionEvents: () => wiringEvents(agent.session),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  })
  return {
    session: agent.session,
    agent,
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    appendRecord,
    writeRollback,
    // Proposal 0023 §4.1/§7.3: the runtime owns the pre-append ordering, while
    // this shard owns the read-only Tavern inspection. The hook never migrates,
    // saves chat, or writes the session; a refusal propagates before the edit
    // event exists.
    inspectEdit: (input) => inspectBodyEdit(ctx, agent, rollbackStore, input),
  }
}

/** Read-only candidate-receipt preflight; refuses before the edit event exists. */
async function inspectBodyEdit(
  ctx: BodyWiringContext,
  agent: BodyAgentLike,
  store: BodyRollbackStore,
  input: BodyEditInspection,
): Promise<void> {
  const sessionId = agentIdOf(agent)
  if (sessionId === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      'body edit refused: the live agent has no session id, so the Tavern binding and candidate receipts cannot be inspected',
      'chat-unreadable',
    )
  }
  const binding = await resolveBodyBinding(ctx, sessionId)
  if (binding === undefined || !bodyBindingEligible(binding) || binding.character === undefined || binding.chatId === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for session '${sessionId}': the AgentTavern single-character binding is unavailable`,
      'chat-unreadable',
    )
  }
  let character: Awaited<ReturnType<BodyRollbackStore['getCharacter']>>
  try {
    character = await store.getCharacter(binding.character)
  } catch (error) {
    const failure = bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for session '${sessionId}': character card '${binding.character}' cannot be read: ${errorMessage(error)}`,
      'card-unreadable',
    )
    failure.cause = error
    throw failure
  }
  if (character === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for session '${sessionId}': character card '${binding.character}' cannot be read`,
      'card-unreadable',
    )
  }
  let snapshot: Awaited<ReturnType<BodyRollbackStore['getChatSnapshot']>>
  try {
    snapshot = await store.getChatSnapshot(binding.character, binding.chatId)
  } catch (error) {
    const failure = bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for session '${sessionId}': chat '${binding.character}/${binding.chatId}' cannot be read: ${errorMessage(error)}`,
      'chat-unreadable',
    )
    failure.cause = error
    throw failure
  }
  if (snapshot === undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for session '${sessionId}': chat '${binding.character}/${binding.chatId}' cannot be read`,
      'chat-unreadable',
    )
  }
  requireProjectedCandidate(snapshot.chat, input)

  const inspection = inspectCandidateReceipts(
    snapshot.chat,
    { messageId: input.messageId, index: input.index },
    input.ledger,
    input.previousText,
    character.card,
  )
  if (inspection.detail !== undefined) {
    throw bodyRuntimeError(
      'body-state-unsafe',
      `body edit refused for candidate ${input.index} ('${input.messageId}'): ${bodyStateUnsafeMessage(inspection.detail)}`,
      inspection.detail,
    )
  }
}

/** Missing floor/swipe means projection lag, not a receipt defect. */
function requireProjectedCandidate(chat: ChatLogIR, input: BodyEditInspection): void {
  let floorIndex: number
  try {
    floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
  } catch (error) {
    throw bodyRuntimeError(
      'projection-pending',
      `body edit deferred for group '${input.groupId}' (message '${input.messageId}'): ${errorMessage(error)}; retry after the body projection catches up`,
    )
  }
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw bodyRuntimeError(
      'projection-pending',
      `body edit deferred for group '${input.groupId}': the projected floor at message index ${floorIndex} is missing; retry after the body projection catches up`,
    )
  }
  if (floor.swipe_id !== input.index) {
    throw bodyRuntimeError(
      'projection-pending',
      `body edit deferred for group '${input.groupId}': the projected floor selects swipe ${String(floor.swipe_id)}, expected ${input.index}; retry after the body projection catches up`,
    )
  }
  const swipes = floor.swipes
  if (!Array.isArray(swipes) || typeof swipes[input.index] !== 'string') {
    throw bodyRuntimeError(
      'projection-pending',
      `body edit deferred for group '${input.groupId}': swipe ${input.index} has not been projected yet; retry after the body projection catches up`,
    )
  }
}

/** Lazy `TavernStore` adapter (proposal 0022 §5). */
function lazyRollbackStore(): BodyRollbackStore {
  return {
    getState: async () => (await tavernStore()).getState(),
    getCharacter: async (name) => {
      const found = await (await tavernStore()).getCharacter(name)
      return found === undefined ? undefined : { card: found.card }
    },
    getChatSnapshot: async (character, chatId) => (await tavernStore()).getChatSnapshot(character, chatId),
    saveChat: async (character, chatId, chat, expectedRevision) => (
      (await tavernStore()).saveChat(character, chatId, chat, expectedRevision)
    ),
  }
}

/** Lazy `MemoryStore` adapter (proposal 0022 §8). */
function lazyRollbackMemoryStore(): BodyRollbackMemoryStore {
  return {
    read: async (id, scope, scopeId, includeDeleted) => (
      (await memories()).read(id, scope, scopeId, includeDeleted)
    ),
    forget: async (id, scope, scopeId, expectedRevision) => (
      (await memories()).forget(id, scope, scopeId, expectedRevision)
    ),
    restore: async (record, expectedRevision) => (await memories()).restore(record, expectedRevision),
  }
}

/** Lazy `VariableStore` adapter (proposal 0022 §9). */
function lazyRollbackVariableStore(): BodyRollbackVariableStore {
  return {
    get: async (scope, scopeId, name) => (await variables()).get(scope, scopeId, name),
    set: async (scope, scopeId, name, value, expectedRevision) => (
      (await variables()).set(scope, scopeId, name, value, expectedRevision)
    ),
    delete: async (scope, scopeId, name, expectedRevision) => (
      (await variables()).delete(scope, scopeId, name, expectedRevision)
    ),
  }
}

/**
 * Lazy `MemoryVectorStore` adapter (proposal 0022 §8): tombstoned records drop
 * their vector, live records re-embed, and a `false` result fails with the id.
 */
function lazyRollbackMemoryVectors(): BodyRollbackMemoryVectors {
  return {
    sync: async (record) => {
      const config = await memoryEmbeddingConfig()
      if (config === undefined) return
      const vectorStore = await memoryVectorStore()
      if (record.deletedAt !== undefined) {
        await vectorStore.delete(record.id, record.scope, record.scopeId)
        return
      }
      const embedded = await embedMemoryRecord({
        root: tavernDataRoot(),
        config,
        vectorStore,
        record,
      })
      if (!embedded) {
        const status = await readEmbedStatus(tavernDataRoot())
        const reason = embedBreakerOpen(status)
          ? `embedding breaker is open${status.lastError === undefined ? '' : `: ${status.lastError}`}`
          : 'embedMemoryRecord returned false (empty vector or embedding request failed)'
        throw new Error(`memory vector sync failed for memory '${record.id}': ${reason}`)
      }
    },
  }
}

/* ------------------------------- projection -------------------------------- */

/**
 * Register the long-lived body projection shim (proposal §9.4); its disposer is
 * only for host unload, never for turning the feature off. Returns the host
 * disposer or `undefined` when the seam is missing.
 */
export function registerBodyProjection(ctx: BodyWiringContext): (() => void) | undefined {
  const sessions = ctx.sessions
  const register = sessions?.registerMessageProjection
  if (sessions === undefined || typeof register !== 'function') {
    warn(ctx, 'dsh-soulmojito body: sessions.registerMessageProjection is unavailable; body projection disabled', {
      reason: 'host-unsupported',
    })
    return undefined
  }

  let registered: unknown
  try {
    registered = register.call(sessions, createBodyProjection())
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: registerMessageProjection failed', {
      reason: 'host-unsupported',
      error: errorMessage(error),
    })
    return undefined
  }

  if (typeof registered !== 'function') {
    warn(ctx, 'dsh-soulmojito body: registerMessageProjection returned no disposer; projection stays registered', {
      reason: 'host-shape',
    })
    return undefined
  }

  const dispose = registered as () => void
  if (typeof ctx.effect === 'function') {
    let disposed = false
    const disposeOnce = (): void => {
      if (disposed) return
      disposed = true
      dispose()
    }
    try {
      ctx.effect(() => disposeOnce, 'dsh-soulmojito: body projection')
    } catch (error) {
      warn(ctx, 'dsh-soulmojito body: ctx.effect rejected the projection disposer; projection stays registered', {
        error: errorMessage(error),
      })
    }
  }
  return dispose
}

/* ----------------------------- turn stopping ------------------------------- */

/**
 * Subscribe to the live turn edges: `agent/turn-stopping` for success and
 * `session/event` for the error/cancelled/aborted edge that never emits
 * turn-stopping. The failure listener only queues work outside host dispatch.
 */
export function registerBodyTurnStopping(ctx: BodyWiringContext): (() => void) | undefined {
  if (typeof ctx.on !== 'function') {
    warn(ctx, 'dsh-soulmojito body: host has no event bus; agent/turn-stopping disabled', {
      reason: 'host-unsupported',
    })
    return undefined
  }

  let registered: unknown
  try {
    registered = ctx.on('agent/turn-stopping', (payload) => handleBodyTurnStopping(ctx, payload))
  } catch (error) {
    errorLog(ctx, 'dsh-soulmojito body: agent/turn-stopping registration failed', {
      error: errorMessage(error),
    })
    return undefined
  }

  const disposers: Array<() => void> = []
  if (typeof registered === 'function') disposers.push(registered as () => void)
  // Without a live-agent registry the queued restore could not resolve an agent.
  if (typeof ctx.agents?.get === 'function') {
    try {
      const turnEndRegistered = ctx.on('session/event', (session, event) => {
        handleBodySessionEvent(ctx, session, event)
        return undefined
      })
      if (typeof turnEndRegistered === 'function') disposers.push(turnEndRegistered as () => void)
    } catch (error) {
      errorLog(ctx, 'dsh-soulmojito body: session/event registration failed', {
        error: errorMessage(error),
      })
    }
  }
  registerTurnEndRestoreCleanup(ctx)
  disposers.push(cancelTurnEndRestoreChains)
  // `ctx.on` is fiber-scoped in Cordis: the host removes the listeners on
  // unload. The returned disposer is exposed for callers that unload earlier.
  return combineDisposers(ctx, disposers)
}

/** Exported so the wiring test can drive the filter without a real host bus. */
export async function handleBodyTurnStopping(ctx: BodyWiringContext, payload: unknown): Promise<void> {
  const record = isRecord(payload) ? payload : undefined
  const payloadAgent = bodyAgentOf(record?.agent)
  const payloadAgentId = nonEmptyString(record?.agentId)
  const agentId = payloadAgent === undefined ? payloadAgentId : agentIdOf(payloadAgent)
  const turn = numberField(record?.turn)

  if (agentId === undefined || turn === undefined || turn < 1) {
    warn(ctx, 'dsh-soulmojito body: ignored a malformed agent/turn-stopping payload', {
      hasAgent: payloadAgent !== undefined,
      hasAgentId: payloadAgentId !== undefined,
      turn: record?.turn,
    })
    return
  }

  const agent = payloadAgent ?? resolveLiveAgent(ctx, agentId)
  if (agent === undefined) return

  const binding = await resolveBodyBinding(ctx, agentId)
  if (!bodyBindingEligible(binding)) return

  const deps = await createBodyDeps(ctx, agent)
  if (deps === undefined) {
    warn(ctx, 'dsh-soulmojito body: turn-stopping skipped because the plugin-record seam is unavailable', {
      reason: 'host-unsupported',
      agentId,
      turn,
    })
    return
  }

  try {
    const result = await finalizeTurnStopping(deps, { agentId, turn })
    if (result.status === 'ok') {
      info(ctx, 'dsh-soulmojito body: regenerate settled from turn-stopping', {
        agentId,
        turn,
        anchorMessageId: result.anchorMessageId,
      })
      return
    }
    if (result.status === 'failed') {
      errorLog(ctx, 'dsh-soulmojito body: regenerate settle failed', {
        agentId,
        turn,
        reason: result.reason,
      })
      return
    }
    info(ctx, 'dsh-soulmojito body: turn-stopping had no active body op', { agentId, turn, reason: result.reason })
  } catch (error) {
    // A serial listener rejection would fail the model turn; the body feature
    // degrades to the recorded op-start so startup recovery can settle it.
    errorLog(ctx, 'dsh-soulmojito body: turn-stopping listener failed', {
      agentId,
      turn,
      code: failureCodeOf(error),
      error: errorMessage(error),
    })
  }
}

/* ---------------------------- turn/end failure ----------------------------- */

/** `turn/end` reasons that bypass `agent/turn-stopping` (proposal 0021 §2.6). */
const TURN_END_FAILURE_REASONS: ReadonlySet<string> = new Set(['error', 'cancelled', 'aborted'])

/** Bounded live restore schedule: microtask first, then 50 ms, then 250 ms. */
const TURN_END_RESTORE_RETRY_DELAYS_MS: readonly number[] = [0, 50, 250]

/** Host timing refusals are retried; every other failure is logged once. */
const TURN_END_RESTORE_RETRY_CODES: ReadonlySet<string> = new Set(['session-busy', 'host-unsupported'])

interface FailedTurnRestore {
  readonly sessionId: string
  readonly agentId: string
  readonly turn: number | undefined
  /** Failure reason for a restore task; absent for a deferred settlement. */
  readonly reason: string | undefined
  /**
   * `restore` handles an error/cancelled/aborted turn/end; `settle` finishes a
   * settlement whose trigger/process hide was deferred past the answer turn.
   */
  readonly mode: 'restore' | 'settle'
}

interface TurnEndRestoreChain {
  readonly task: FailedTurnRestore
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
  cancelled: boolean
}

interface TurnEndRestoreAttempt {
  readonly status: 'done' | 'failed'
  readonly code?: string
  readonly error?: string
  readonly opId?: string
}

/** One retry chain per session: duplicate turn edges never start a second one. */
const turnEndRestoreChains = new Map<string, TurnEndRestoreChain>()

/**
 * Observe one `session/event` delivery. It only validates the edge, checks for
 * a pending body operation and queues a microtask; it never appends, so it
 * cannot re-enter the host's dispatch (proposal 0021 §9.1).
 */
export function handleBodySessionEvent(
  ctx: BodyWiringContext,
  session: unknown,
  event: unknown,
): void {
  try {
    const eventRecord = isRecord(event) ? event : undefined
    if (eventRecord?.['type'] !== 'turn/end') return
    const data = isRecord(eventRecord['data']) ? eventRecord['data'] : undefined
    const reason = data === undefined ? undefined : isRecord(data['reason']) ? data['reason'] : undefined
    const reasonKind = nonEmptyString(reason?.['kind'])
    if (reasonKind === undefined) return

    const sessionId = nonEmptyString(isRecord(session) ? session['id'] : undefined)
    if (sessionId === undefined) return

    const liveAgent = resolveLiveAgent(ctx, sessionId)
    const agentId = liveAgent === undefined ? sessionId : agentIdOf(liveAgent) ?? sessionId
    const pending = pendingByAgent.get(agentId) ?? pendingByAgent.get(sessionId)
    const turn = data === undefined ? undefined : numberField(data['turn'])

    if (TURN_END_FAILURE_REASONS.has(reasonKind)) {
      if (pending === undefined) return
      // Never restore an operation from an older turn on an unrelated failure.
      if (pending.turn !== undefined && turn !== undefined && pending.turn !== turn) return
      scheduleTurnEndRestore(ctx, {
        sessionId,
        agentId,
        turn,
        reason: reasonKind,
        mode: 'restore',
      })
      return
    }

    // A completed turn finishes a deferred settlement. The task always carries
    // the operation's trigger turn so recovery validates the same edge; a later
    // turn may also flush an operation whose first completion window was
    // missed (the turn/end microtask lost the race with a new user turn).
    if (turn === undefined || turn < 1) return
    if (pending === undefined || pending.turn === undefined || turn < pending.turn) return
    scheduleTurnEndRestore(ctx, {
      sessionId,
      agentId,
      turn: pending.turn,
      reason: undefined,
      mode: 'settle',
    })
  } catch (error) {
    // A host event bus must never fail because body observation failed.
    errorLog(ctx, 'dsh-soulmojito body: session/event turn/end observation failed', {
      reason: 'listener-failed',
      error: errorMessage(error),
    })
  }
}

function scheduleTurnEndRestore(ctx: BodyWiringContext, task: FailedTurnRestore): void {
  if (turnEndRestoreChains.has(task.sessionId)) return
  const chain: TurnEndRestoreChain = { task, attempts: 0, timer: undefined, cancelled: false }
  turnEndRestoreChains.set(task.sessionId, chain)
  queueMicrotask(() => { void runTurnEndRestoreAttempt(ctx, chain) })
}

/**
 * One attempt plus the bounded retry decision. A host-loop timing refusal is
 * retried on the fixed schedule; the last failure stays in the session log for
 * startup recovery and is never reported as a success.
 */
async function runTurnEndRestoreAttempt(ctx: BodyWiringContext, chain: TurnEndRestoreChain): Promise<void> {
  if (chain.cancelled) return
  const outcome = await attemptTurnEndRestore(ctx, chain)
  if (chain.cancelled) return
  chain.attempts += 1
  if (outcome.status === 'done') {
    forgetTurnEndRestoreChain(chain)
    return
  }
  const delay = TURN_END_RESTORE_RETRY_DELAYS_MS[chain.attempts]
  const retryable = outcome.code !== undefined && TURN_END_RESTORE_RETRY_CODES.has(outcome.code)
  const subject = chain.task.mode === 'settle' ? 'deferred settlement' : 'turn/end restore'
  if (retryable && delay !== undefined) {
    warn(ctx, `dsh-soulmojito body: ${subject} failed; retrying`, {
      sessionId: chain.task.sessionId,
      agentId: chain.task.agentId,
      turn: chain.task.turn,
      ...(chain.task.reason === undefined ? {} : { reason: chain.task.reason }),
      code: outcome.code,
      attempt: chain.attempts,
      delayMs: delay,
    })
    chain.timer = setTimeout(() => {
      chain.timer = undefined
      void runTurnEndRestoreAttempt(ctx, chain)
    }, delay)
    return
  }
  forgetTurnEndRestoreChain(chain)
  // The operation stays in `pendingByAgent` and its `op-start` stays in the
  // log; startup recovery is the documented retry path (proposal §9.2).
  errorLog(ctx, `dsh-soulmojito body: ${subject} failed; op-start stays pending for startup recovery`, {
    sessionId: chain.task.sessionId,
    agentId: chain.task.agentId,
    turn: chain.task.turn,
    ...(chain.task.reason === undefined ? {} : { reason: chain.task.reason }),
    attempts: chain.attempts,
    ...(outcome.opId === undefined ? {} : { opId: outcome.opId }),
    code: outcome.code,
    error: outcome.error,
  })
}

async function attemptTurnEndRestore(
  ctx: BodyWiringContext,
  chain: TurnEndRestoreChain,
): Promise<TurnEndRestoreAttempt> {
  const task = chain.task
  let opId: string | undefined
  try {
    const agent = resolveLiveAgent(ctx, task.agentId)
      ?? (task.agentId === task.sessionId ? undefined : resolveLiveAgent(ctx, task.sessionId))
    if (agent === undefined) {
      warn(ctx, `dsh-soulmojito body: ${task.mode === 'settle' ? 'deferred settlement' : 'turn/end restore'} skipped because the live agent is gone`, {
        sessionId: task.sessionId,
        agentId: task.agentId,
        turn: task.turn,
        ...(task.reason === undefined ? {} : { reason: task.reason }),
      })
      return { status: 'done' }
    }

    const agentId = agentIdOf(agent) ?? task.agentId
    const op = pendingByAgent.get(agentId) ?? pendingByAgent.get(task.sessionId)
    if (op === undefined) return { status: 'done' }
    opId = op.opId

    const deps = await createBodyDeps(ctx, agent)
    if (deps === undefined) {
      return { status: 'failed', code: 'host-unsupported', error: 'the plugin-record seam is unavailable', opId }
    }
    // Turn-stopping may have released the same operation while deps loaded.
    const current = pendingByAgent.get(agentId) ?? pendingByAgent.get(task.sessionId)
    if (current === undefined || current.opId !== op.opId) return { status: 'done' }
    if (chain.cancelled) return { status: 'done' }

    if (task.mode === 'settle') {
      if (task.turn === undefined) return { status: 'done' }
      // The durable `settling` marker carries the hidden candidates and the
      // surviving surface targets, so the shared recovery path finishes the
      // hide in a post-turn bridge and then writes `settled` + `op-finish`.
      const result = await finalizeRecoveredOperation(deps, operationView(op), task.turn)
      info(ctx, 'dsh-soulmojito body: deferred settlement finished after turn/end', {
        sessionId: task.sessionId,
        agentId,
        opId: op.opId,
        turn: task.turn,
        status: result.status,
      })
      return { status: 'done' }
    }

    const restoredAnchorId = await restoreBodyAfterFailure(deps, operationView(op))
    info(ctx, 'dsh-soulmojito body: turn/end restored the previous body after a failed turn', {
      sessionId: task.sessionId,
      agentId,
      opId: op.opId,
      turn: task.turn,
      reason: task.reason,
      restoredAnchorId,
    })
    return { status: 'done' }
  } catch (error) {
    return {
      status: 'failed',
      code: failureCodeOf(error),
      error: errorMessage(error),
      ...(opId === undefined ? {} : { opId }),
    }
  }
}

function forgetTurnEndRestoreChain(chain: TurnEndRestoreChain): void {
  if (turnEndRestoreChains.get(chain.task.sessionId) === chain) turnEndRestoreChains.delete(chain.task.sessionId)
}

/** Drop every queued retry on plugin unload; a cancelled chain never calls the runtime again. */
function cancelTurnEndRestoreChains(): void {
  for (const chain of turnEndRestoreChains.values()) {
    chain.cancelled = true
    if (chain.timer !== undefined) clearTimeout(chain.timer)
    chain.timer = undefined
  }
  turnEndRestoreChains.clear()
}

function registerTurnEndRestoreCleanup(ctx: BodyWiringContext): void {
  if (typeof ctx.effect !== 'function') return
  try {
    ctx.effect(() => () => { cancelTurnEndRestoreChains() }, 'dsh-soulmojito: body turn/end retries')
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: ctx.effect rejected the turn/end retry cleanup', { error: errorMessage(error) })
  }
}

/* -------------------------------- recovery --------------------------------- */

/** Startup recovery over every live agent the host exposes. */
export function recoverBodyOperations(ctx: BodyWiringContext): Promise<readonly BodyRecoveryOutcome[]> {
  return recoverBodyOperationsWith(ctx, createBodyDeps)
}

/** Recover one agent (`agent/created` path). */
export function recoverBodyOperation(ctx: BodyWiringContext, agentValue: unknown): Promise<BodyRecoveryOutcome> {
  return recoverBodyOperationWith(ctx, agentValue, createBodyDeps)
}

/* ------------------------------- re-exports -------------------------------- */

export {
  bodyAgentOf, bodyBindingEligible, foldSessionBodyLedger,
  foldSessionBodyLedgerForMessage, inspectBodyAnchor, listLiveAgents,
  messageTextOfSession, readBodySessionFacts, resolveBodyBinding, resolveLiveAgent,
  type BodyAnchorInspection, type BodyBindingResolver, type BodyBindingView, type BodySessionFacts,
} from './body-session.js'

export {
  bodyFailureOf, bodyHistoricalMvuStateOf, bodyMutationSafetyOf, bodyRejectStatus,
  bodyStateSafetyOf, bodyStateUnsafeMessage, buildBodyView, publicBodyCode,
  type BodyFailureView, type BodyMutationAction, type BodyProjectedFloor,
  type BodyStateSafety, type BodyStateSafetyResolver, type BodyStateUnsafeDetail,
  type BodyView, type BodyViewInput,
} from './body-view.js'

export type { BodyRecoveryOutcome } from './body-recovery.js'

/* -------------------------------- helpers --------------------------------- */

function combineDisposers(
  ctx: BodyWiringContext,
  disposers: readonly (() => void)[],
): (() => void) | undefined {
  if (disposers.length === 0) return undefined
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        // Unload must keep disposing the remaining listener and stay observable.
        errorLog(ctx, 'dsh-soulmojito body: event listener disposer failed', {
          error: errorMessage(error),
        })
      }
    }
  }
}

function warnRecordSeamOnce(ctx: BodyWiringContext, message: string, fields: Record<string, unknown>): void {
  if (recordSeamWarningEmitted) return
  recordSeamWarningEmitted = true
  warn(ctx, message, fields)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}
