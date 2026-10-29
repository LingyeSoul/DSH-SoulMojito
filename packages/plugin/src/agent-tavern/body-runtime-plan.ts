/**
 * Durable `rollbackPlan` boundary for body `op-start` records (proposal 0022 §10.4).
 *
 * `startRegenerate` prepares the plan and writes it into the `op-start` payload,
 * so a restart can replay it without any process-local state. This shard owns
 * both ends of that boundary:
 *
 * - `durableRollbackPlan` guards the write: the plan must survive a JSONL round
 *   trip, so functions, `undefined`, class instances, cycles and non-finite
 *   numbers are refused before the record is appended.
 * - `rollbackPlanOfEvent` guards the read: a missing plan is a legacy record, but
 *   a present malformed plan is an `invalid-event` that names the seq and field.
 *
 * Nested entries (journal writes, MVU receipts, diagnostics) are produced by the
 * trusted rollback port; only the fields recovery needs are checked. Accepted
 * nested values are re-emitted as the original objects so newer optional fields
 * survive a fold.
 */

import type { MvuReceipt } from '../mvu.js'
import type {
  BodyRollbackBinding,
  BodyRollbackDiagnostic,
  BodyRollbackJournalWrite,
  BodyRollbackPlan,
} from './body-rollback.js'
import { bodyRuntimeError, type BodyRuntimeFailure } from './body-runtime-core.js'

const PLAN_FIELD = 'rollbackPlan'

/**
 * Validate one `op-start.rollbackPlan` value and return the typed plan.
 *
 * `seq` is the event sequence the plan came from; every failure message names
 * both the sequence and the exact field, so a corrupt log is actionable without
 * guessing which record broke.
 */
export function rollbackPlanOfEvent(value: unknown, seq: number): BodyRollbackPlan {
  if (!isRecord(value)) throw planError(seq, '', 'an object')
  return {
    sessionId: requirePlanString(value['sessionId'], seq, 'sessionId'),
    turn: requirePlanInteger(value['turn'], seq, 'turn'),
    previousMessageId: requirePlanString(value['previousMessageId'], seq, 'previousMessageId'),
    binding: bindingOf(value['binding'], seq),
    floorIndex: requirePlanInteger(value['floorIndex'], seq, 'floorIndex'),
    bodyText: value['bodyText'] === undefined ? undefined : requirePlanText(value['bodyText'], seq, 'bodyText'),
    chatRevision: requirePlanString(value['chatRevision'], seq, 'chatRevision'),
    preparedRevision: requirePlanString(value['preparedRevision'], seq, 'preparedRevision'),
    journal: journalOf(value['journal'], seq),
    mvuReceipts: receiptsOf(value['mvuReceipts'], seq),
    diagnostics: diagnosticsOf(value['diagnostics'], seq),
    preparedAt: requirePlanString(value['preparedAt'], seq, 'preparedAt'),
  }
}

/**
 * Refuse a plan that cannot be persisted as JSON.
 *
 * The caller runs this inside the start failure path, so a refused plan still
 * replays through the prepared write rollback before the start error surfaces.
 */
export function durableRollbackPlan(plan: BodyRollbackPlan): BodyRollbackPlan {
  requireJsonValue(plan, PLAN_FIELD, new Set<object>())
  return plan
}

function journalOf(value: unknown, seq: number): readonly BodyRollbackJournalWrite[] {
  if (!Array.isArray(value)) throw planError(seq, 'journal', 'an array of journal writes')
  const writes: BodyRollbackJournalWrite[] = []
  for (const [index, entry] of value.entries()) {
    writes.push(journalWriteOf(entry, seq, `journal[${index}]`))
  }
  return writes
}

function journalWriteOf(value: unknown, seq: number, path: string): BodyRollbackJournalWrite {
  if (!isRecord(value)) throw planError(seq, path, 'a journal write object')
  const kind = value['kind']
  if (kind !== 'memory' && kind !== 'variable') {
    throw planError(seq, `${path}.kind`, "'memory' or 'variable'")
  }
  requirePlanString(value['journalId'], seq, `${path}.journalId`)
  requirePlanString(value['tool'], seq, `${path}.tool`)
  if (!isRecord(value['target'])) throw planError(seq, `${path}.target`, 'an object')
  if (!('before' in value) || !('after' in value)) {
    throw planError(seq, path, 'a before/after journal pair')
  }
  // The before/after snapshots come from the trusted rollback port; only the
  // discriminator recovery needs is checked here.
  return value as unknown as BodyRollbackJournalWrite
}

function receiptsOf(value: unknown, seq: number): readonly MvuReceipt[] {
  if (!Array.isArray(value)) throw planError(seq, 'mvuReceipts', 'an array of MVU receipts')
  const receipts: MvuReceipt[] = []
  for (const [index, entry] of value.entries()) {
    receipts.push(receiptOf(entry, seq, `mvuReceipts[${index}]`))
  }
  return receipts
}

function receiptOf(value: unknown, seq: number, path: string): MvuReceipt {
  if (!isRecord(value)) throw planError(seq, path, 'an MVU receipt object')
  requirePlanString(value['at'], seq, `${path}.at`)
  requirePlanString(value['turnKey'], seq, `${path}.turnKey`)
  const status = value['status']
  if (status !== 'updated' && status !== 'unchanged' && status !== 'failed') {
    throw planError(seq, `${path}.status`, "'updated', 'unchanged' or 'failed'")
  }
  if (!Array.isArray(value['changes'])) throw planError(seq, `${path}.changes`, 'an array')
  const failures = value['failures']
  if (!Array.isArray(failures) || failures.some((item) => typeof item !== 'string')) {
    throw planError(seq, `${path}.failures`, 'an array of strings')
  }
  const undoneAt = value['undoneAt']
  if (undoneAt !== undefined && typeof undoneAt !== 'string') {
    throw planError(seq, `${path}.undoneAt`, 'a string when present')
  }
  // `changes` entries are written by the trusted MVU projector; the array shape
  // above is all recovery needs to replay the receipt.
  return value as unknown as MvuReceipt
}

function diagnosticsOf(value: unknown, seq: number): readonly BodyRollbackDiagnostic[] {
  if (!Array.isArray(value)) throw planError(seq, 'diagnostics', 'an array of diagnostics')
  const diagnostics: BodyRollbackDiagnostic[] = []
  for (const [index, entry] of value.entries()) {
    const path = `diagnostics[${index}]`
    if (!isRecord(entry)) throw planError(seq, path, 'a diagnostic object')
    requirePlanString(entry['code'], seq, `${path}.code`)
    requirePlanText(entry['message'], seq, `${path}.message`)
    const memoryId = entry['memoryId']
    if (memoryId !== undefined && typeof memoryId !== 'string') {
      throw planError(seq, `${path}.memoryId`, 'a string when present')
    }
    diagnostics.push(entry as unknown as BodyRollbackDiagnostic)
  }
  return diagnostics
}

function bindingOf(value: unknown, seq: number): BodyRollbackBinding {
  if (!isRecord(value)) throw planError(seq, 'binding', 'an object with character and chatId')
  return {
    character: requirePlanString(value['character'], seq, 'binding.character'),
    chatId: requirePlanString(value['chatId'], seq, 'binding.chatId'),
  }
}

function requirePlanString(value: unknown, seq: number, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw planError(seq, field, 'a non-empty string')
  }
  return value
}

function requirePlanText(value: unknown, seq: number, field: string): string {
  if (typeof value !== 'string') throw planError(seq, field, 'a string')
  return value
}

function requirePlanInteger(value: unknown, seq: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw planError(seq, field, 'a non-negative safe integer')
  }
  return value
}

function planError(seq: number, field: string, expectation: string): BodyRuntimeFailure {
  const path = field === '' ? PLAN_FIELD : `${PLAN_FIELD}.${field}`
  return bodyRuntimeError('invalid-event', `body event at seq ${seq} requires ${path} to be ${expectation}`)
}

/** Plain-object/array/JSON-scalar walk that refuses values JSONL cannot keep. */
function requireJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw notSerializable(path, 'the plan carries a non-finite number')
    return
  }
  if (typeof value !== 'object') throw notSerializable(path, `the plan carries a ${typeof value}`)
  if (ancestors.has(value)) throw notSerializable(path, 'the plan graph is cyclic')

  if (Array.isArray(value)) {
    ancestors.add(value)
    for (const [index, item] of value.entries()) requireJsonValue(item, `${path}[${index}]`, ancestors)
    ancestors.delete(value)
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw notSerializable(path, 'the plan carries a class instance')
  }
  ancestors.add(value)
  for (const [key, item] of Object.entries(value)) requireJsonValue(item, `${path}.${key}`, ancestors)
  ancestors.delete(value)
}

function notSerializable(path: string, detail: string): BodyRuntimeFailure {
  return bodyRuntimeError(
    'body-state-unsafe',
    `body regenerate refused: the prepared write rollback plan is not JSON-serializable at ${path}: ${detail}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
