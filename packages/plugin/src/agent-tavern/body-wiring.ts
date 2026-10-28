/**
 * AgentTavern body wiring facade (proposal 0021 §2.5, §2.6, §6).
 *
 * This shard owns the host-facing core: the structural context, the
 * experimental plugin-record seam, deps assembly, the message projection and
 * the `agent/turn-stopping` listener. Read-side view policy lives in
 * `body-view.ts`, session reads in `body-session.ts`, crash recovery in
 * `body-recovery.ts`.
 *
 * No durable fact is invented here: the session log stays authoritative, the
 * body ledger in `body.ts` folds it, and the state machine in `body-runtime.ts`
 * owns every mutation.
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
import {
  bodyRuntimeError,
  finalizeTurnStopping,
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

/**
 * Structural context used by every wiring entry point. Host services stay
 * optional so a missing seam disables one feature instead of throwing.
 */
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

/**
 * Writes one log-only plugin record. The host function snapshots `data` and
 * marks the event `ignorable: true`; it never enters the model surface.
 */
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
 * Resolve the experimental plugin-record seam.
 *
 * Both `appendPluginRecord` and `pluginRecordOf` must exist: the decision
 * record treats them as one version-gated API, and a host with only half of it
 * cannot safely read its own records after reload. A missing package or missing
 * export returns `undefined`; callers must answer `host-unsupported`.
 *
 * Successful resolutions are cached for the process: `GET body` asks per
 * rendered assistant row, and a dynamic host import per row would be wasteful.
 * A miss is not cached so a reloaded host module can be picked up.
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

/**
 * Build the deps bundle consumed by the body state machine.
 *
 * The write rollback port is assembled here so every entry point (routes,
 * turn-stopping, recovery) shares one seam. Stores stay lazy: `GET body` builds
 * deps per rendered row and must not open the Tavern/Memory/Variable stores just
 * to report `canRegenerate`.
 */
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

/**
 * Read-only candidate-receipt preflight for one edit.
 *
 * Binding, card and chat are resolved through the same lazy store as the
 * rollback port. Every refusal is a typed `body-state-unsafe`/`projection-
 * pending` failure and happens before the edit event is appended.
 */
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

/**
 * A candidate edit can only project onto a floor whose swipes already contain
 * the slot. Missing floor/swipe is a projection lag, not a receipt defect.
 */
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
 * Lazy `MemoryVectorStore` adapter (proposal 0022 §8).
 *
 * No embedding config means the vector cache is disabled, so the sync is a
 * no-op. Otherwise a tombstoned record drops its vector and a live record is
 * re-embedded and persisted. `embedMemoryRecord` reports failure as `false`
 * (breaker open, empty vector or request error); that is turned into an error
 * carrying the memory id so the rollback layer can record `vector-sync-failed`.
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
 * Register the body message projection before any agent/session is created.
 *
 * The projection is a long-lived compatibility shim (proposal §9.4): turning
 * the body feature off later stops new records but never unregisters it. The
 * returned disposer is handed to `ctx.effect` for host unload only.
 *
 * @returns the host disposer, or `undefined` when the host has no projection
 * seam (the caller keeps the rest of the plugin running)
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
 * Subscribe to the serial `agent/turn-stopping` event.
 *
 * The listener never waits for `agent.whenIdle()`: it already runs after the
 * final assistant message settled, and waiting would deadlock the same loop.
 * It appends only the events `finalizeTurnStopping` needs (candidate, select,
 * hide replacement, op-finish); ordinary `session/event` bookkeeping stays out.
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

  const dispose = typeof registered === 'function' ? registered as () => void : undefined
  // `ctx.on` is fiber-scoped in Cordis: the host removes the listener on
  // unload. The returned disposer is exposed for callers that unload earlier.
  return dispose
}

/**
 * One `agent/turn-stopping` delivery. Exported so the wiring test can drive the
 * filter without a real host bus.
 */
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

/* -------------------------------- recovery --------------------------------- */

/** Startup recovery over every live agent the host exposes. */
export function recoverBodyOperations(ctx: BodyWiringContext): Promise<readonly BodyRecoveryOutcome[]> {
  return recoverBodyOperationsWith(ctx, createBodyDeps)
}

/** Recover one agent (`agent/created` path). */
export function recoverBodyOperation(
  ctx: BodyWiringContext,
  agentValue: unknown,
): Promise<BodyRecoveryOutcome> {
  return recoverBodyOperationWith(ctx, agentValue, createBodyDeps)
}

/* ------------------------------- re-exports -------------------------------- */

export {
  bodyAgentOf,
  bodyBindingEligible,
  foldSessionBodyLedger,
  foldSessionBodyLedgerForMessage,
  inspectBodyAnchor,
  listLiveAgents,
  messageTextOfSession,
  readBodySessionFacts,
  resolveBodyBinding,
  resolveLiveAgent,
  type BodyAnchorInspection,
  type BodyBindingResolver,
  type BodyBindingView,
  type BodySessionFacts,
} from './body-session.js'

export {
  bodyFailureOf,
  bodyHistoricalMvuStateOf,
  bodyMutationSafetyOf,
  bodyRejectStatus,
  bodyStateSafetyOf,
  bodyStateUnsafeMessage,
  buildBodyView,
  publicBodyCode,
  type BodyFailureView,
  type BodyMutationAction,
  type BodyProjectedFloor,
  type BodyStateSafety,
  type BodyStateSafetyResolver,
  type BodyStateUnsafeDetail,
  type BodyView,
  type BodyViewInput,
} from './body-view.js'

export type { BodyRecoveryOutcome } from './body-recovery.js'

/* -------------------------------- helpers --------------------------------- */

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
