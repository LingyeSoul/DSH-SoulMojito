/**
 * AgentTavern body write rollback: shared vocabulary, errors and deps.
 *
 * This shard exists so the journal, receipt and orchestration shards can share
 * the public types and the typed `BodyRollbackError` without circular imports.
 * `body-rollback.ts` re-exports every public member from here, so the runtime
 * and wiring keep importing from the same path.
 */

import type { CharacterCardIR, ChatLogIR } from '../../../tavern-format/src/index.js'
import type {
  JsonValue,
  MemoryRecord,
  MemoryScope,
  TavernState,
  VariableScope,
  VariableSnapshot,
} from '../../../tavern-store/src/index.js'
import type { MvuReceipt } from '../mvu.js'
import type {
  WriteJournalMemoryTarget,
  WriteJournalMemoryTool,
  WriteJournalRecordWriter,
  WriteJournalVariableTarget,
  WriteJournalVariableTool,
} from './write-journal.js'

/* ------------------------------- vocabulary -------------------------------- */

/** Structured failure codes of the rollback port. */
export type BodyRollbackErrorCode =
  | 'invalid-arguments'
  | 'body-state-unsafe'
  | 'body-rollback-target-missing'
  | 'body-rollback-conflict'
  | 'body-rollback-save-failed'
  | 'body-rollback-failed'
  | 'body-rollback-partial'

/** Concrete signal behind a `body-state-unsafe` refusal (proposal 0022 §7). */
export type BodyRollbackUnsafeDetail =
  | 'binding-unavailable'
  | 'card-unreadable'
  | 'chat-unreadable'
  | 'body-floor-missing'
  | 'session-unreadable'
  | 'mvu-receipt-missing'
  | 'write-journal-missing'
  | 'write-journal-unavailable'

/** Stage that failed; the caller can decide whether to keep the op pending. */
export type BodyRollbackStage =
  | 'prepare'
  | 'journal-rollback'
  | 'mvu-undo'
  | 'chat-save'
  | 'journal-replay'
  | 'mvu-redo'
  | 'restore'
  | 'compensation'

/** Options carried by every `BodyRollbackError`. */
export interface BodyRollbackErrorOptions {
  readonly detail?: BodyRollbackUnsafeDetail
  readonly stage?: BodyRollbackStage
  readonly sessionId?: string
  readonly turn?: number
  readonly journalId?: string
  /** True when the opposite journal direction ran cleanly to avoid a split state. */
  readonly compensated?: boolean
  readonly cause?: unknown
}

/**
 * Typed rollback failure.
 *
 * `code` is stable for callers, `detail` narrows `body-state-unsafe`, and the
 * contextual fields make a failed rollback actionable without parsing prose.
 */
export class BodyRollbackError extends Error {
  readonly code: BodyRollbackErrorCode
  readonly detail: BodyRollbackUnsafeDetail | undefined
  readonly stage: BodyRollbackStage | undefined
  readonly sessionId: string | undefined
  readonly turn: number | undefined
  readonly journalId: string | undefined
  readonly compensated: boolean

  constructor(code: BodyRollbackErrorCode, message: string, options: BodyRollbackErrorOptions) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'BodyRollbackError'
    this.code = code
    this.detail = options.detail
    this.stage = options.stage
    this.sessionId = options.sessionId
    this.turn = options.turn
    this.journalId = options.journalId
    this.compensated = options.compensated === true
  }
}

/* --------------------------------- deps ------------------------------------ */

/** Chat binding slice the rollback port reads from the store. */
export interface BodyRollbackBinding {
  readonly character: string
  readonly chatId: string
}

/** Store surface consumed by the rollback port (`TavernStore` satisfies it). */
export interface BodyRollbackStore {
  getState(): Promise<Pick<TavernState, 'sessionBindings'>>
  getCharacter(name: string): Promise<{ card: CharacterCardIR } | undefined>
  getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR; revision: string } | undefined>
  saveChat(character: string, chatId: string, chat: ChatLogIR, expectedRevision: string): Promise<string>
}

/** Memory store surface consumed by the rollback port. */
export interface BodyRollbackMemoryStore {
  read(id: string, scope: MemoryScope, scopeId: string, includeDeleted: boolean): Promise<MemoryRecord | undefined>
  forget(id: string, scope: MemoryScope, scopeId: string, expectedRevision: string): Promise<void>
  restore(record: MemoryRecord, expectedRevision: string | undefined): Promise<MemoryRecord>
}

/** Variable store surface consumed by the rollback port. */
export interface BodyRollbackVariableStore {
  get(scope: VariableScope, scopeId: string, name: string): Promise<VariableSnapshot | undefined>
  set(
    scope: VariableScope,
    scopeId: string,
    name: string,
    value: JsonValue,
    expectedRevision: string | undefined,
  ): Promise<VariableSnapshot>
  delete(scope: VariableScope, scopeId: string, name: string, expectedRevision: string): Promise<void>
}

/**
 * Resolve the write journal of one session.
 *
 * `undefined` means the session log is not readable; an empty array is a
 * readable session with no write records. The resolver stays injectable so the
 * runtime can hand in the live host session without this module importing it.
 */
export type BodyRollbackSessionEvents = (
  sessionId: string,
) => readonly unknown[] | undefined | Promise<readonly unknown[] | undefined>

/** Structured logging seam. */
export interface BodyRollbackLogger {
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
  error?(message: string, fields?: Record<string, unknown>): void
}

/** Everything `createBodyWriteRollbackPort` needs. */
export interface BodyWriteRollbackDeps {
  readonly store: BodyRollbackStore
  readonly memoryStore: BodyRollbackMemoryStore
  readonly variableStore: BodyRollbackVariableStore
  readonly sessionEvents: BodyRollbackSessionEvents
  readonly logger?: BodyRollbackLogger
  /**
   * Journal seam probe. When omitted the port resolves
   * `appendPluginRecord` through `write-journal.ts`; tests and hosts with an
   * explicit seam inject it here.
   */
  readonly resolveJournalWriter?: () => Promise<WriteJournalRecordWriter | undefined>
}

/* --------------------------------- plan ------------------------------------ */

/** A committed memory mutation rebuilt from one journal id's before/after pair. */
export interface BodyRollbackMemoryWrite {
  readonly kind: 'memory'
  readonly journalId: string
  readonly tool: WriteJournalMemoryTool
  readonly target: WriteJournalMemoryTarget
  readonly before: MemoryRecord | null
  readonly after: MemoryRecord | null
}

/** A committed variable mutation rebuilt from one journal id's before/after pair. */
export interface BodyRollbackVariableWrite {
  readonly kind: 'variable'
  readonly journalId: string
  readonly tool: WriteJournalVariableTool
  readonly target: WriteJournalVariableTarget
  readonly before: readonly VariableSnapshot[] | null
  readonly after: readonly VariableSnapshot[] | null
}

/** One committed journal pair the plan can undo or replay. */
export type BodyRollbackJournalWrite = BodyRollbackMemoryWrite | BodyRollbackVariableWrite

/** Non-blocking observations recorded while preparing the rollback. */
export type BodyRollbackDiagnosticCode = 'journal-uncommitted-skipped' | 'vector-restore-skipped'

/** A diagnostic the caller can surface in logs or an ops panel. */
export interface BodyRollbackDiagnostic {
  readonly code: BodyRollbackDiagnosticCode
  readonly message: string
}

/**
 * Everything `restore` needs.
 *
 * The plan is intentionally self-contained: journal pairs and the pre-undo MVU
 * receipt snapshots travel together, so failure recovery never depends on
 * process-local state (proposal 0022 §10.4).
 */
export interface BodyRollbackPlan {
  readonly sessionId: string
  readonly turn: number
  readonly previousMessageId: string
  readonly binding: BodyRollbackBinding
  readonly floorIndex: number
  readonly bodyText: string
  /** Revision observed before `prepare` began (the CAS base). */
  readonly chatRevision: string
  /** Revision after the rolled-back chat was saved; equals `chatRevision` for a no-op. */
  readonly preparedRevision: string
  readonly journal: readonly BodyRollbackJournalWrite[]
  /** Receipts matched by `body:<previousMessageId>` and the old floor index, before undo. */
  readonly mvuReceipts: readonly MvuReceipt[]
  readonly diagnostics: readonly BodyRollbackDiagnostic[]
  readonly preparedAt: string
}

/** One new-turn journal entry whose undo failed. */
export interface BodyTurnRollbackFailure {
  readonly journalId: string
  readonly kind: 'memory' | 'variable'
  readonly tool: WriteJournalMemoryTool | WriteJournalVariableTool
  readonly code: BodyRollbackErrorCode | 'unknown'
  readonly message: string
}

/**
 * Result of rolling back one turn's committed writes.
 *
 * `undone` counts committed journal entries whose undo actually changed a
 * store; a repeated call reports `0` because the stores already hold the before
 * state. `skippedUncommitted` lists before-only journal ids. `failures` lists
 * entries that could not be undone; the remaining entries still run.
 */
export interface BodyNewTurnRollback {
  readonly sessionId: string
  readonly turn: number
  readonly undone: number
  readonly skippedUncommitted: readonly string[]
  readonly failures: readonly BodyTurnRollbackFailure[]
}

/** The prepare / restore / commit / new-turn rollback seam consumed by body-runtime. */
export interface BodyWriteRollbackPort {
  prepare(agentId: string, turn: number, previousMessageId: string): Promise<BodyRollbackPlan>
  restore(plan: BodyRollbackPlan): Promise<void>
  commit(plan: BodyRollbackPlan): Promise<void>
  /**
   * Undo the committed memory/variable writes of one turn (proposal 0022 §10.3).
   *
   * This is the new-turn failure path: it reads only that session+turn's write
   * journal, never the old plan or the MVU receipts. Before-only records are
   * reported and skipped. Failures are collected per entry so the caller gets a
   * complete diagnostic instead of only the first store error.
   */
  rollbackTurnWrites(agentId: string, turn: number): Promise<BodyNewTurnRollback>
}

export function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new BodyRollbackError(
      'invalid-arguments',
      `body rollback rejected: ${field} must be a non-empty string`,
      { stage: 'prepare' },
    )
  }
}

export function requireNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!isNonNegativeInteger(value)) {
    throw new BodyRollbackError(
      'invalid-arguments',
      `body rollback rejected: ${field} must be a non-negative safe integer`,
      { stage: 'prepare' },
    )
  }
}

export function log(
  logger: BodyRollbackLogger | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void {
  try {
    if (level === 'info') logger?.info?.(message, fields)
    else if (level === 'warn') logger?.warn?.(message, fields)
    else logger?.error?.(message, fields)
  } catch {
    // Logging must never mask the rollback failure it reports.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
