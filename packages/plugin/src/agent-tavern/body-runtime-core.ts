/**
 * Body runtime structural surface, errors and record-writer plumbing.
 *
 * This shard owns the public deps/type vocabulary, the fail-closed
 * `appendRecord` seam, validation of request shapes, and the in-process
 * operation map used by the start/settle paths.
 */

import { KeyedMutationTails } from '../../../tavern-store/src/index.js'
import { BODY_EVENT_TYPE, type BodyEventData, type BodyLedger } from './body.js'
import type { BodyRollbackPlan, BodyWriteRollbackPort } from './body-rollback.js'
import { canAdvanceHostTurnBase } from '../session/trace.js'

/** Maximum accepted user-visible body length. */
export const BODY_TEXT_MAX_LENGTH = 100_000

/**
 * Write-capable tools disabled while a regeneration turn is running. Callers
 * may pass a narrower/more precise list in the request.
 *
 * Memory and variable writes are journaled by `write-journal.ts` and rolled
 * back by `body-rollback.ts`, and `tavern_variable_settle` records an MVU
 * receipt, so those tools stay available during regeneration (proposal 0022
 * §6). Script cursors and game state have no sibling checkpoint in this
 * proposal, so they remain denied until one is added.
 */
export const BODY_WRITE_TOOL_DENY: readonly string[] = [
  'tavern_script_advance',
  'game_start',
  'game_move',
]

export type BodyRuntimeErrorCode =
  | 'session-busy'
  | 'not-last-round'
  | 'stale-anchor'
  | 'body-compacted'
  | 'body-state-unsafe'
  | 'invalid-body-text'
  | 'host-unsupported'
  | 'invalid-arguments'
  | 'invalid-event'
  | 'restore-unavailable'
  | 'operation-failed'
  | 'projection-pending'

/** Specific, actionable body runtime failure. */
export interface BodyRuntimeFailure extends Error {
  name: 'BodyRuntimeError'
  code: BodyRuntimeErrorCode
  cause?: unknown
  /** Concrete `body-state-unsafe` signal forwarded from the rollback port. */
  detail?: string
  /** Present when a start failed after the operation was recorded. */
  op?: PendingBodyOperation
}

export function bodyRuntimeError(
  code: BodyRuntimeErrorCode,
  message: string,
  detail?: string,
): BodyRuntimeFailure {
  const error = new Error(message) as BodyRuntimeFailure
  error.name = 'BodyRuntimeError'
  error.code = code
  if (detail !== undefined) error.detail = detail
  return error
}

export interface BodyLogger {
  warn?(message: string): void
  error?(message: string): void
}

/** Minimal append surface; the host Session satisfies it structurally. */
export interface BodySessionLike {
  [key: string]: unknown
  id?: string
  header?: { version?: unknown }
  events?: readonly unknown[]
  log?: readonly unknown[]
  snapshotEvents?(...args: unknown[]): unknown
  surface?: { nodes?: readonly unknown[] }
  /** Standard host events (turn/step/messages) only; body records never use this. */
  append(type: string, data: unknown, opts?: unknown): unknown
}

/** Minimal live-agent surface used by the body state machine. */
export interface BodyAgentLike {
  id?: string
  session: BodySessionLike
  status?: unknown
  phase?: unknown
  ctx?: {
    tools?: {
      restrict?(filter: { deny?: readonly string[] }): unknown
    }
  }
  followup(message: unknown): unknown
}

/** One new-turn write the rollback port could not undo. */
export interface BodyRuntimeTurnRollbackFailure {
  readonly journalId: string
  readonly kind: string
  readonly tool: string
  readonly code: string
  readonly message: string
}

/** Structural result of `rollbackTurnWrites`; the port owns the concrete type. */
export interface BodyRuntimeTurnRollback {
  readonly failures: readonly BodyRuntimeTurnRollbackFailure[]
}

/** Runtime-side structural view of the write rollback port. */
export interface BodyRuntimeRollbackPort extends Omit<BodyWriteRollbackPort, 'rollbackTurnWrites'> {
  /**
   * Undo the writes produced by one turn (proposal 0022 §10.3).
   *
   * R3 owns the concrete port; this stays optional so a port from an older
   * build still works and the runtime never imports a concrete class.
   */
  rollbackTurnWrites?(agentId: string, turn: number): Promise<BodyRuntimeTurnRollback>
}

/**
 * Read-only preflight for one candidate edit (proposal 0023 §4.1, §7.3).
 *
 * The runtime owns the ordering (preflight before the `edit` event); wiring
 * owns the Tavern reads. `ledger` is the folded view the edit is about to
 * extend and `previousText` is the effective text the new patch replaces.
 */
export interface BodyEditInspection {
  readonly groupId: string
  readonly index: number
  readonly messageId: string
  readonly previousText: string
  readonly ledger: BodyLedger
}

export interface BodyRuntimeDeps {
  session: BodySessionLike
  agent: BodyAgentLike
  logger?: BodyLogger
  now?: () => number
  /**
   * Required-at-runtime plugin-record writer. DSH 0.2.1-rc.2 exposes
   * `appendPluginRecord(session, type, data)` as a module export; the caller
   * injects it here so this module never imports the host package. Missing at
   * runtime means body operations are unsupported: every body-writing entry
   * point fails closed with `host-unsupported` before touching the session.
   */
  appendRecord?: (session: BodySessionLike, type: string, data: unknown) => unknown
  /**
   * Memory/variable/MVU write rollback used by regeneration (proposal 0022 §5).
   *
   * When present, `startRegenerate` prepares the plan before the trigger turn
   * starts, settlement commits it, and failure restore replays it. When absent
   * the runtime keeps the legacy no-rollback path; the HTTP gate only allows
   * regeneration over historical MVU state when this port is available.
   */
  writeRollback?: BodyRuntimeRollbackPort
  /**
   * Read-only candidate-state preflight, called before the `edit` event is
   * appended (proposal 0023 §4.1). Wiring injects it over the Tavern store;
   * when absent the legacy text-only edit path is preserved for non-MVU hosts
   * and existing callers.
   */
  inspectEdit?: (input: BodyEditInspection) => Promise<void>
}

export interface RegenerateBodyRequest {
  groupId: string
  expectedAnchorId: string
  expectedIndex: number
  feedback?: string
  writeToolDeny?: readonly string[]
}

export interface EditBodyRequest {
  groupId: string
  index: number
  text: string
  expectedAnchorId: string
}

export interface SelectBodyRequest {
  groupId: string
  index: number
  expectedAnchorId: string
}

export interface PendingBodyOperation {
  opId: string
  groupId: string
  previousAnchorId: string
  previousIndex: number
  startSeq: number
  agentId?: string
  triggerMessageId?: string
  turn?: number
  feedback?: string
  /**
   * In-memory rollback plan prepared by `startRegenerate`. It travels with the
   * operation so a failed start can restore the rolled-back writes before the
   * body itself is restored.
   */
  rollbackPlan?: BodyRollbackPlan
}

export type FinalizeTurnStoppingResult =
  | { status: 'ok'; anchorMessageId: string }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string }

export interface BodyCandidateState {
  messageId: string
  index: number
  feedback?: string
}

export interface BodyRuntimeState {
  groupId: string
  anchorMessageId: string
  selectedIndex: number
  count: number
  text: string
  candidates: readonly BodyCandidateState[]
}

export interface ActiveBodyOperation extends PendingBodyOperation {
  agentId: string
  triggerMessageId: string
  release: () => void
}

/** One operation handed to the shared settlement helper. */
export interface SettlementContext {
  agentId: string
  op: PendingBodyOperation
  /** Stable log/error prefix, e.g. `body regenerate` or `body recovery`. */
  label: string
  /** In-memory restriction disposer; recovered operations have none. */
  release: (() => void) | undefined
}

/** Process-local operation registry shared by start and settlement. */
export const pendingByAgent = new Map<string, ActiveBodyOperation>()

const bodyTails = new KeyedMutationTails<string>(true)

/**
 * Serialise every mutation of one session. `KeyedMutationTails` returns the
 * operation's own promise, so failures reach the caller instead of being
 * swallowed by the tail's internal chain.
 */
export function withBodyLock<T>(deps: BodyRuntimeDeps, operation: () => Promise<T>): Promise<T> {
  return bodyTails.enqueue(sessionIdOf(deps), operation)
}

export function validateRegenerateRequest(request: RegenerateBodyRequest): void {
  requireNonEmptyString(request.groupId, 'regenerate.groupId')
  requireNonEmptyString(request.expectedAnchorId, 'regenerate.expectedAnchorId')
  requireNonNegativeInteger(request.expectedIndex, 'regenerate.expectedIndex')
  if (request.feedback !== undefined && typeof request.feedback !== 'string') {
    throw bodyRuntimeError('invalid-arguments', 'body regenerate rejected: feedback must be a string when present')
  }
  if (request.writeToolDeny !== undefined) {
    if (!Array.isArray(request.writeToolDeny) || request.writeToolDeny.some((name) => typeof name !== 'string')) {
      throw bodyRuntimeError('invalid-arguments', 'body regenerate rejected: writeToolDeny must be an array of tool names')
    }
  }
}

export function validateFinalizePayload(payload: { agentId: string; turn: number }): void {
  requireNonEmptyString(payload.agentId, 'turn-stopping.agentId')
  requireNonNegativeInteger(payload.turn, 'turn-stopping.turn')
  if (payload.turn < 1) throw bodyRuntimeError('invalid-arguments', 'body turn-stopping rejected: turn must be at least 1')
}

export function validateEditRequest(request: EditBodyRequest): void {
  requireNonEmptyString(request.groupId, 'edit.groupId')
  requireNonEmptyString(request.expectedAnchorId, 'edit.expectedAnchorId')
  requireNonNegativeInteger(request.index, 'edit.index')
  if (typeof request.text !== 'string') throw bodyRuntimeError('invalid-arguments', 'body edit rejected: text must be a string')
}

export function validateSelectRequest(request: SelectBodyRequest): void {
  requireNonEmptyString(request.groupId, 'select.groupId')
  requireNonEmptyString(request.expectedAnchorId, 'select.expectedAnchorId')
  requireNonNegativeInteger(request.index, 'select.index')
}

export function validatePendingOperation(op: PendingBodyOperation): void {
  requireNonEmptyString(op.opId, 'restore.opId')
  requireNonEmptyString(op.groupId, 'restore.groupId')
  requireNonEmptyString(op.previousAnchorId, 'restore.previousAnchorId')
  requireNonNegativeInteger(op.previousIndex, 'restore.previousIndex')
  requireNonNegativeInteger(op.startSeq, 'restore.startSeq')
}

function requireNonEmptyString(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bodyRuntimeError('invalid-arguments', `body runtime rejected ${subject}: expected a non-empty string`)
  }
}

function requireNonNegativeInteger(value: unknown, subject: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw bodyRuntimeError('invalid-arguments', `body runtime rejected ${subject}: expected a non-negative safe integer`)
  }
}

export function requirePositiveTurn(value: unknown, subject: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw bodyRuntimeError('invalid-arguments', `body runtime rejected ${subject}: expected a positive safe integer`)
  }
}

export function sessionIdOf(deps: BodyRuntimeDeps): string {
  if (typeof deps.session.id === 'string' && deps.session.id !== '') return deps.session.id
  if (typeof deps.agent.id === 'string' && deps.agent.id !== '') return deps.agent.id
  throw bodyRuntimeError('invalid-arguments', 'body runtime rejected session: neither session.id nor agent.id is a non-empty string')
}

export function requireAgentId(deps: BodyRuntimeDeps): string {
  if (typeof deps.agent.id !== 'string' || deps.agent.id === '') {
    throw bodyRuntimeError('invalid-arguments', 'body runtime rejected agent: agent.id must be a non-empty string')
  }
  return deps.agent.id
}

export function recoveryAgentId(deps: BodyRuntimeDeps, op: PendingBodyOperation): string {
  if (typeof op.agentId === 'string' && op.agentId !== '') return op.agentId
  if (typeof deps.agent.id === 'string' && deps.agent.id !== '') return deps.agent.id
  if (typeof deps.session.id === 'string' && deps.session.id !== '') return deps.session.id
  throw bodyRuntimeError('invalid-arguments', 'body recovery rejected: neither the operation nor the live deps carry an agent/session id')
}

export function assertAgentIdle(deps: BodyRuntimeDeps): void {
  if (deps.agent.status !== 'idle') {
    throw bodyRuntimeError(
      'session-busy',
      `body operation rejected: agent '${String(deps.agent.id)}' is ${String(deps.agent.status ?? 'unknown')}, expected idle`,
    )
  }
}

export function assertCanAdvanceTurnBase(deps: BodyRuntimeDeps): void {
  if (!canAdvanceHostTurnBase(deps.agent)) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body operation rejected: agent '${String(deps.agent.id)}' cannot advance its host turn base (phase must be idle with a writable integer lastTurn)`,
    )
  }
}

export function releaseOperation(deps: BodyRuntimeDeps, op: ActiveBodyOperation): void {
  releaseActiveOperation(deps, op.agentId, op.opId, op.release)
}

export function releaseActiveOperation(
  deps: BodyRuntimeDeps,
  agentId: string,
  opId: string,
  release: () => void,
): void {
  pendingByAgent.delete(agentId)
  try {
    release()
  } catch (error) {
    warn(deps, `body runtime: failed to release write-tool restriction for op ${opId}: ${errorMessage(error)}`)
  }
}

function releasePendingOperation(
  deps: BodyRuntimeDeps,
  agentId: string,
  opId: string,
  subject: string,
): void {
  const active = pendingByAgent.get(agentId)
  if (active === undefined || active.opId !== opId) return
  try {
    active.release()
  } catch (error) {
    warn(deps, `body runtime: ${subject}: failed to release write-tool restriction: ${errorMessage(error)}`)
  }
  pendingByAgent.delete(agentId)
}

export function releaseOperationByOp(deps: BodyRuntimeDeps, op: PendingBodyOperation, subject: string): void {
  const agentId = typeof deps.agent.id === 'string' ? deps.agent.id : undefined
  if (agentId === undefined) return
  releasePendingOperation(deps, agentId, op.opId, subject)
}

export function releaseSettlement(deps: BodyRuntimeDeps, context: SettlementContext): void {
  if (context.release !== undefined) {
    releaseActiveOperation(deps, context.agentId, context.op.opId, context.release)
    return
  }
  releasePendingOperation(deps, context.agentId, context.op.opId, `${context.label} ${context.op.opId}`)
}

export function operationView(op: ActiveBodyOperation): PendingBodyOperation {
  return {
    opId: op.opId,
    groupId: op.groupId,
    previousAnchorId: op.previousAnchorId,
    previousIndex: op.previousIndex,
    startSeq: op.startSeq,
    agentId: op.agentId,
    triggerMessageId: op.triggerMessageId,
    ...(op.turn === undefined ? {} : { turn: op.turn }),
    ...(op.feedback === undefined ? {} : { feedback: op.feedback }),
    ...(op.rollbackPlan === undefined ? {} : { rollbackPlan: op.rollbackPlan }),
  }
}

/**
 * Body records must go through the host plugin-record seam only. `Session.append`
 * cannot mark a record `ignorable: true`, so a fallback would poison v4 sessions
 * on reload. Fail closed instead of degrading.
 */
export function requireRecordWriter(
  deps: BodyRuntimeDeps,
): (session: BodySessionLike, type: string, data: unknown) => unknown {
  const appendRecord = deps.appendRecord
  if (typeof appendRecord !== 'function') {
    throw bodyRuntimeError(
      'host-unsupported',
      'body operation rejected: the host does not expose appendPluginRecord; inject deps.appendRecord from dsh-session appendPluginRecord (DSH 0.2.1-rc.2+)',
    )
  }
  return appendRecord
}

export function assertRecordWriter(deps: BodyRuntimeDeps): void {
  requireRecordWriter(deps)
}

export function appendBodyEvent(deps: BodyRuntimeDeps, data: BodyEventData): unknown {
  return requireRecordWriter(deps)(deps.session, BODY_EVENT_TYPE, data)
}

/**
 * `op-start` payload with the durable write rollback plan (proposal 0022 §10.4).
 *
 * The shared `BodyEventData` vocabulary in `body.ts` is ledger-owned and has no
 * plan field, so this type extends its `op-start` member instead of duplicating
 * it. The record writer accepts `unknown`, which keeps the extra field out of
 * the ledger's strict parser while staying readable after a reload.
 */
export type BodyStartEventData = Extract<BodyEventData, { readonly op: 'op-start' }> & {
  readonly rollbackPlan?: BodyRollbackPlan
}

export function appendBodyStartEvent(deps: BodyRuntimeDeps, data: BodyStartEventData): unknown {
  return requireRecordWriter(deps)(deps.session, BODY_EVENT_TYPE, data)
}

export function appendOpFinish(
  deps: BodyRuntimeDeps,
  opId: string,
  result: 'ok' | 'failed',
  anchorId: string | undefined,
  reason: string | undefined,
): void {
  appendBodyEvent(deps, {
    op: 'op-finish',
    opId,
    result,
    ...(anchorId === undefined ? {} : { anchorId }),
    ...(reason === undefined ? {} : { reason }),
  })
}

export function once(operation: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    operation()
  }
}

export function warn(deps: BodyRuntimeDeps, message: string): void {
  try {
    deps.logger?.warn?.(message)
  } catch {
    // Logging must never mask the body failure it is reporting.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isBodyFailure(value: unknown): value is BodyRuntimeFailure {
  return value instanceof Error
    && value.name === 'BodyRuntimeError'
    && typeof (value as { code?: unknown }).code === 'string'
}

export function failureFor(error: unknown, context: string, op: PendingBodyOperation | undefined): BodyRuntimeFailure {
  const code = isBodyFailure(error) ? error.code : 'operation-failed'
  const failure = bodyRuntimeError(code, `${context}: ${errorMessage(error)}`)
  if (error instanceof Error) failure.cause = error
  if (isBodyFailure(error) && error.detail !== undefined) failure.detail = error.detail
  if (op !== undefined) failure.op = op
  return failure
}
