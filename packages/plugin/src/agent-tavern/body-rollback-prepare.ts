/**
 * Durable `op-prepare` boundary for AgentTavern body regeneration
 * (proposal 0022 §10).
 *
 * `startRegenerate` plans the old turn's write rollback, persists that draft in
 * one `plugin:dsh-soulmojito/body-prepare` record, and only then applies it.
 * The record closes the crash window between "the old writes were rolled back"
 * and "`op-start` carried the plan": a restart that finds an unconsumed
 * `op-prepare` replays its plan through the rollback port's `restore` and marks
 * it recovered.
 *
 * The record is log-only: it never enters the body ledger, the message
 * projection or the JSONL chat. Records are parsed strictly, so a damaged
 * prepare fails the whole fold with `invalid-event` instead of being skipped.
 */

import type { BodyRollbackPlan } from './body-rollback-support.js'
import {
  bodyRuntimeError,
  requireRecordWriter,
  type BodyRuntimeDeps,
} from './body-runtime-core.js'
import { durableRollbackPlan, rollbackPlanOfEvent } from './body-runtime-plan.js'
import { pendingEventOf, type RuntimeEvent } from './body-runtime-session.js'

/** Plugin record type carrying the durable pre-apply rollback plan. */
export const BODY_PREPARE_EVENT_TYPE = 'plugin:dsh-soulmojito/body-prepare' as const

/** Payload vocabulary of one `body-prepare` record. */
export type BodyPrepareEventData =
  | {
      readonly op: 'op-prepare'
      readonly opId: string
      readonly groupId: string
      readonly plan: BodyRollbackPlan
    }
  | {
      readonly op: 'op-prepare-recovered'
      readonly opId: string
      readonly reason: string
    }

/** One planned-but-unconsumed rollback a restart has to put back. */
export interface PendingBodyPrepare {
  readonly opId: string
  readonly groupId: string
  readonly plan: BodyRollbackPlan
}

/**
 * Append the durable prepare record before any store mutation.
 *
 * `durableRollbackPlan` refuses functions, `undefined`, class instances,
 * cycles and non-finite numbers, so a plan that JSONL would silently damage
 * never reaches the log.
 */
export function appendPreparedRollback(
  deps: BodyRuntimeDeps,
  opId: string,
  groupId: string,
  plan: BodyRollbackPlan,
): void {
  if (typeof opId !== 'string' || opId === '') {
    throw bodyRuntimeError('invalid-arguments', 'body op-prepare rejected: opId must be a non-empty string')
  }
  if (typeof groupId !== 'string' || groupId === '') {
    throw bodyRuntimeError('invalid-arguments', 'body op-prepare rejected: groupId must be a non-empty string')
  }
  const data: BodyPrepareEventData = { op: 'op-prepare', opId, groupId, plan: durableRollbackPlan(plan) }
  requireRecordWriter(deps)(deps.session, BODY_PREPARE_EVENT_TYPE, data)
}

/** Append the consumption marker of one recovered prepare. */
export function appendPrepareRecovered(deps: BodyRuntimeDeps, opId: string, reason: string): void {
  if (typeof opId !== 'string' || opId === '') {
    throw bodyRuntimeError('invalid-arguments', 'body op-prepare-recovered rejected: opId must be a non-empty string')
  }
  const data: BodyPrepareEventData = { op: 'op-prepare-recovered', opId, reason }
  requireRecordWriter(deps)(deps.session, BODY_PREPARE_EVENT_TYPE, data)
}

/**
 * Fold every prepare record into the plans a restart still has to restore.
 *
 * A prepare with a matching `op-start` or `op-finish` is consumed by the
 * runtime: `apply` already ran and the plan travels with the operation, so it
 * is ignored. A prepare whose plan is malformed throws `invalid-event`.
 */
export function foldPreparedOperations(events: readonly RuntimeEvent[]): readonly PendingBodyPrepare[] {
  const consumed = consumedOperations(events)
  const recovered = new Set<string>()
  const pending = new Map<string, PendingBodyPrepare>()
  for (const event of events) {
    if (event.type !== BODY_PREPARE_EVENT_TYPE) continue
    const record = parsePrepareRecord(event)
    if (record.op === 'op-prepare-recovered') {
      if (recovered.has(record.opId)) continue
      recovered.add(record.opId)
      pending.delete(record.opId)
      continue
    }
    if (consumed.has(record.opId)) continue
    if (recovered.has(record.opId)) {
      throw bodyRuntimeError(
        'invalid-event',
        `body op-prepare at seq ${event.seq} re-plans operation '${record.opId}' after it was already recovered`,
      )
    }
    if (pending.has(record.opId)) {
      throw bodyRuntimeError(
        'invalid-event',
        `body op-prepare at seq ${event.seq} duplicates the open prepare of operation '${record.opId}'`,
      )
    }
    pending.set(record.opId, { opId: record.opId, groupId: record.groupId, plan: record.plan })
  }
  return [...pending.values()]
}

/** Operations the runtime already started or finished; their prepare is spent. */
function consumedOperations(events: readonly RuntimeEvent[]): Set<string> {
  const consumed = new Set<string>()
  for (const event of events) {
    const operation = pendingEventOf(event)
    if (operation !== undefined) consumed.add(operation.opId)
  }
  return consumed
}

type ParsedPrepareRecord =
  | {
      readonly op: 'op-prepare'
      readonly opId: string
      readonly groupId: string
      readonly plan: BodyRollbackPlan
    }
  | { readonly op: 'op-prepare-recovered'; readonly opId: string }

function parsePrepareRecord(event: RuntimeEvent): ParsedPrepareRecord {
  const op = event.data.op
  if (op === 'op-prepare-recovered') {
    return {
      op: 'op-prepare-recovered',
      opId: prepareString(event.data.opId, event.seq, 'opId'),
    }
  }
  if (op !== 'op-prepare') {
    throw bodyRuntimeError(
      'invalid-event',
      `body prepare record at seq ${event.seq} has op '${String(op)}', expected 'op-prepare' or 'op-prepare-recovered'`,
    )
  }
  return {
    op: 'op-prepare',
    opId: prepareString(event.data.opId, event.seq, 'opId'),
    groupId: prepareString(event.data.groupId, event.seq, 'groupId'),
    // A malformed plan throws `invalid-event` naming the seq and field.
    plan: rollbackPlanOfEvent(event.data.plan, event.seq),
  }
}

function prepareString(value: unknown, seq: number, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw bodyRuntimeError(
      'invalid-event',
      `body prepare record at seq ${seq} requires ${field} to be a non-empty string`,
    )
  }
  return value
}
