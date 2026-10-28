/**
 * Pure AgentTavern body-event projection into ST-compatible chat fields.
 *
 * This module owns only the JSONL side of proposal 0021: candidate, select,
 * edit and restore events become `swipes` / `swipe_id` / `swipe_info` / `mes`
 * updates. It never reads the host session, clock, filesystem or network; the
 * caller resolves candidate text and timestamps before calling it.
 */

import type { ChatLogIR, ChatMessage } from '../../../tavern-format/src/index.js'

/* ------------------------------- event shape ------------------------------- */

/**
 * Projection-relevant slice of `plugin:dsh-soulmojito/body` log records (proposal
 * 0021 section 4). `op-start` / `op-finish` carry no JSONL action and are excluded.
 */
export type BodyJsonlEvent =
  | {
      op: 'candidate'
      groupId: string
      messageId: string
      index: number
      feedback?: string
    }
  | {
      op: 'select'
      groupId: string
      index: number
    }
  | {
      op: 'edit'
      groupId: string
      index: number
      text: string
      previousText: string
    }
  | {
      op: 'restore'
      groupId: string
      messageId: string
      index: number
    }

/* ------------------------------ projection data ---------------------------- */

/** Provider usage totals persisted in `swipe_info[].extra.usage`. */
export type BodyJsonlUsage = Readonly<Record<string, number>>

/** Extra metadata persisted under `swipe_info[].extra`. */
export interface BodyJsonlSwipeExtra {
  readonly provider?: string
  readonly model?: string
  readonly reasoning?: string
  readonly usage?: BodyJsonlUsage
  readonly feedback?: string
}

/** ST-compatible swipe metadata entry. Unknown existing keys are preserved. */
export interface BodyJsonlSwipeInfo {
  readonly send_date: string
  readonly extra: BodyJsonlSwipeExtra
  readonly [key: string]: unknown
}

/**
 * One body candidate ready for JSONL projection.
 *
 * `messageId` is the native assistant message that produced the candidate.
 * `index` is the zero-based body-ledger slot and must equal its `swipes` slot.
 */
export interface BodyJsonlCandidate {
  readonly messageId: string
  readonly index: number
  readonly text: string
  readonly sendDate: string
  readonly provider?: string
  readonly model?: string
  readonly reasoning?: string
  readonly usage?: BodyJsonlUsage
  readonly feedback?: string
}

/** Candidate input: a candidate plus the body group it belongs to. */
export type BodyJsonlCandidateInput = BodyJsonlCandidate & {
  readonly groupId: string
}

export interface BodyJsonlSelectInput {
  readonly groupId: string
  readonly index: number
  readonly anchorMessageId: string
}

export interface BodyJsonlEditInput {
  readonly groupId: string
  readonly index: number
  readonly text: string
}

export interface BodyJsonlRestoreInput {
  readonly groupId: string
  readonly index: number
  readonly messageId: string
}

/**
 * Read-only body ledger view mirrored from proposal 0021 section 3.3.
 *
 * The module does not fold events itself; integration code folds the log and
 * can use this view to feed candidate text or to keep the UI and JSONL aligned.
 */
export interface BodyJsonlLedgerView {
  readonly groupId: string
  readonly candidates: readonly BodyJsonlCandidate[]
  readonly selectedIndex: number
  readonly anchorMessageId: string
  readonly edits: ReadonlyMap<number, string>
}

/* --------------------------------- errors ---------------------------------- */

export type BodyJsonlErrorCode =
  | 'invalid-body-group-id'
  | 'invalid-body-message-id'
  | 'invalid-body-index'
  | 'invalid-body-text'
  | 'invalid-body-send-date'
  | 'body-floor-not-found'
  | 'body-group-mismatch'
  | 'body-swipes-missing'
  | 'body-index-out-of-range'
  | 'body-index-mismatch'
  | 'body-candidate-gap'
  | 'body-swipe-info-invalid'

/** Typed failure with a stable code for projector retry / HTTP mapping. */
export class BodyJsonlProjectionError extends Error {
  readonly code: BodyJsonlErrorCode

  constructor(code: BodyJsonlErrorCode, message: string) {
    super(message)
    this.name = 'BodyJsonlProjectionError'
    this.code = code
  }
}

/* -------------------------------- locators --------------------------------- */

/** Locate a body floor by group id, then by native message id. */
export function locateBodyFloor(chat: ChatLogIR, groupId: string, messageId: string | undefined): number {
  requireNonEmpty(groupId, 'invalid-body-group-id', 'body group id')
  const byGroup = findBodyFloorIndexByGroupId(chat, groupId)
  if (byGroup !== undefined) return byGroup
  if (messageId !== undefined) {
    requireNonEmpty(messageId, 'invalid-body-message-id', 'body message id')
    const byMessage = findBodyFloorIndexByMessageId(chat, messageId)
    if (byMessage !== undefined) return byMessage
  }
  const suffix = messageId === undefined ? '' : ` or message '${messageId}'`
  throw new BodyJsonlProjectionError(
    'body-floor-not-found',
    `body floor not found for group '${groupId}'${suffix}`,
  )
}

/** Find a body floor by `extra.agentTavern.bodyGroupId`. */
export function findBodyFloorIndexByGroupId(chat: ChatLogIR, groupId: string): number | undefined {
  for (const [index, message] of chat.messages.entries()) {
    if (readAgentTavern(message)?.bodyGroupId === groupId) return index
  }
  return undefined
}

/** Find a body floor by `extra.agentTavern.messageId`. */
export function findBodyFloorIndexByMessageId(chat: ChatLogIR, messageId: string): number | undefined {
  for (const [index, message] of chat.messages.entries()) {
    if (readAgentTavern(message)?.messageId === messageId) return index
  }
  return undefined
}

/* ------------------------------- projection -------------------------------- */

/**
 * Append (or replay) a candidate into the target floor.
 *
 * The first call creates `swipes` / `swipe_info`, records `bodyGroupId` and
 * makes the candidate the selected slot. Later calls append at `index`; an
 * already-present index is overwritten so projector retries stay idempotent.
 */
export function applyCandidateToChat(chat: ChatLogIR, input: BodyJsonlCandidateInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  requireNonEmpty(input.messageId, 'invalid-body-message-id', 'candidate message id')
  requireNonEmpty(input.sendDate, 'invalid-body-send-date', 'candidate send date')
  if (typeof input.text !== 'string') {
    throw new BodyJsonlProjectionError('invalid-body-text', `candidate text for '${input.messageId}' must be a string`)
  }
  requireIndex(input.index, 'invalid-body-index', 'candidate index')

  const floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
  const floor = chat.messages[floorIndex]!
  assertFloorGroup(floor, input.groupId)

  const swipes = readSwipes(floor, input.groupId)
  if (input.index > swipes.length) {
    throw new BodyJsonlProjectionError(
      'body-candidate-gap',
      `candidate index ${input.index} would skip slot ${swipes.length} on body floor '${input.groupId}'`,
    )
  }

  const next = structuredClone(chat)
  const nextFloor = next.messages[floorIndex]!
  const nextSwipes = [...swipes]
  const nextSwipeInfo = readSwipeInfo(nextFloor, input.groupId)

  nextSwipes[input.index] = input.text
  while (nextSwipeInfo.length < input.index) nextSwipeInfo.push({})
  nextSwipeInfo[input.index] = mergeSwipeInfo(nextSwipeInfo[input.index], input)

  next.messages[floorIndex] = {
    ...nextFloor,
    swipes: nextSwipes,
    swipe_info: nextSwipeInfo,
    swipe_id: input.index,
    mes: input.text,
    extra: patchAgentTavern(nextFloor, input.groupId, input.messageId),
  }
  return next
}

/** Select an existing candidate without adding a slot. */
export function applySelectToChat(chat: ChatLogIR, input: BodyJsonlSelectInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  requireNonEmpty(input.anchorMessageId, 'invalid-body-message-id', 'anchor message id')
  requireIndex(input.index, 'invalid-body-index', 'select index')

  const floorIndex = locateBodyFloor(chat, input.groupId, input.anchorMessageId)
  const floor = chat.messages[floorIndex]!
  assertFloorGroup(floor, input.groupId)
  const swipes = requireSwipes(floor, input.groupId)
  const text = requireSwipeText(swipes, input.index, input.groupId)

  const next = structuredClone(chat)
  const nextFloor = next.messages[floorIndex]!
  next.messages[floorIndex] = {
    ...nextFloor,
    swipe_id: input.index,
    mes: text,
    extra: patchAgentTavern(nextFloor, input.groupId, input.anchorMessageId),
  }
  return next
}

/**
 * Edit the currently selected candidate. `index` must equal `swipe_id`;
 * mismatches throw instead of silently editing a different slot.
 */
export function applyEditToChat(chat: ChatLogIR, input: BodyJsonlEditInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  if (typeof input.text !== 'string') {
    throw new BodyJsonlProjectionError('invalid-body-text', `edit text for body floor '${input.groupId}' must be a string`)
  }
  requireIndex(input.index, 'invalid-body-index', 'edit index')

  const floorIndex = locateBodyFloor(chat, input.groupId, undefined)
  const floor = chat.messages[floorIndex]!
  assertFloorGroup(floor, input.groupId)
  const swipes = requireSwipes(floor, input.groupId)
  requireSwipeText(swipes, input.index, input.groupId)

  const selected = floor.swipe_id
  if (selected === undefined || !Number.isSafeInteger(selected) || selected < 0 || selected >= swipes.length) {
    throw new BodyJsonlProjectionError(
      'body-index-mismatch',
      `body floor '${input.groupId}' has no valid selected swipe for edit`,
    )
  }
  if (selected !== input.index) {
    throw new BodyJsonlProjectionError(
      'body-index-mismatch',
      `edit index ${input.index} does not match selected swipe ${selected} on body floor '${input.groupId}'`,
    )
  }

  const next = structuredClone(chat)
  const nextFloor = next.messages[floorIndex]!
  const nextSwipes = [...swipes]
  nextSwipes[selected] = input.text
  next.messages[floorIndex] = {
    ...nextFloor,
    swipes: nextSwipes,
    mes: input.text,
  }
  return next
}

/**
 * Restore an anchor after a failed regeneration. The candidate list, selected
 * slot, effective text and `swipe_info` remain untouched.
 */
export function applyRestoreToChat(chat: ChatLogIR, input: BodyJsonlRestoreInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  requireNonEmpty(input.messageId, 'invalid-body-message-id', 'restore message id')
  requireIndex(input.index, 'invalid-body-index', 'restore index')

  const floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
  const floor = chat.messages[floorIndex]!
  assertFloorGroup(floor, input.groupId)
  const swipes = requireSwipes(floor, input.groupId)
  requireSwipeText(swipes, input.index, input.groupId)

  const next = structuredClone(chat)
  const nextFloor = next.messages[floorIndex]!
  next.messages[floorIndex] = {
    ...nextFloor,
    extra: patchAgentTavern(nextFloor, input.groupId, input.messageId),
  }
  return next
}

/* --------------------------------- helpers --------------------------------- */

function requireNonEmpty(value: string, code: BodyJsonlErrorCode, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BodyJsonlProjectionError(code, `${label} must be a non-empty string`)
  }
}

function requireIndex(index: number, code: BodyJsonlErrorCode, label: string): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new BodyJsonlProjectionError(code, `${label} must be a non-negative safe integer, received ${String(index)}`)
  }
}

function requireSwipes(message: ChatMessage, groupId: string): string[] {
  const swipes = readSwipes(message, groupId)
  if (swipes.length === 0) {
    throw new BodyJsonlProjectionError('body-swipes-missing', `body floor '${groupId}' has no swipes`)
  }
  return swipes
}

function readSwipes(message: ChatMessage, groupId: string): string[] {
  const swipes = message.swipes
  if (swipes === undefined) return []
  if (!Array.isArray(swipes)) {
    throw new BodyJsonlProjectionError('body-swipes-missing', `body floor '${groupId}' has a non-array swipes field`)
  }
  for (const [index, text] of swipes.entries()) {
    if (typeof text !== 'string') {
      throw new BodyJsonlProjectionError(
        'body-swipes-missing',
        `body floor '${groupId}' has a non-string swipe at index ${index}`,
      )
    }
  }
  return swipes
}

function readSwipeInfo(message: ChatMessage, groupId: string): Record<string, unknown>[] {
  const info = message.swipe_info
  if (info === undefined) return []
  if (!Array.isArray(info)) {
    throw new BodyJsonlProjectionError('body-swipe-info-invalid', `body floor '${groupId}' has a non-array swipe_info field`)
  }
  const cloned: Record<string, unknown>[] = []
  for (const [index, entry] of info.entries()) {
    if (!isRecord(entry)) {
      throw new BodyJsonlProjectionError(
        'body-swipe-info-invalid',
        `body floor '${groupId}' has a non-object swipe_info entry at index ${index}`,
      )
    }
    cloned.push(structuredClone(entry))
  }
  return cloned
}

function requireSwipeText(swipes: readonly string[], index: number, groupId: string): string {
  if (index >= swipes.length) {
    throw new BodyJsonlProjectionError(
      'body-index-out-of-range',
      `body index ${index} is out of range for floor '${groupId}' with ${swipes.length} swipes`,
    )
  }
  const text = swipes[index]
  if (typeof text !== 'string') {
    throw new BodyJsonlProjectionError(
      'body-index-out-of-range',
      `body floor '${groupId}' has no text at index ${index}`,
    )
  }
  return text
}

function mergeSwipeInfo(existing: Record<string, unknown> | undefined, candidate: BodyJsonlCandidate): Record<string, unknown> {
  const base = existing === undefined ? {} : structuredClone(existing)
  const currentExtra = isRecord(base.extra) ? structuredClone(base.extra) : {}
  const extra: Record<string, unknown> = { ...currentExtra }

  // Existing keys win: projection replay must never drop metadata written by
  // an earlier event or by an ST-compatible writer.
  if (extra.provider === undefined && candidate.provider !== undefined) extra.provider = candidate.provider
  if (extra.model === undefined && candidate.model !== undefined) extra.model = candidate.model
  if (extra.reasoning === undefined && candidate.reasoning !== undefined) extra.reasoning = candidate.reasoning
  if (extra.usage === undefined && candidate.usage !== undefined) extra.usage = structuredClone(candidate.usage)
  if (extra.feedback === undefined && candidate.feedback !== undefined) extra.feedback = candidate.feedback
  if (base.send_date === undefined || base.send_date === '') base.send_date = candidate.sendDate

  base.extra = extra
  return base
}

function patchAgentTavern(message: ChatMessage, groupId: string, anchorMessageId: string): Record<string, unknown> {
  const extra = isRecord(message.extra) ? structuredClone(message.extra) : {}
  const current = isRecord(extra.agentTavern) ? structuredClone(extra.agentTavern) : {}
  const currentGroup = current.bodyGroupId

  if (currentGroup !== undefined && currentGroup !== groupId) {
    throw new BodyJsonlProjectionError(
      'body-group-mismatch',
      `body floor is already bound to group '${String(currentGroup)}', cannot project group '${groupId}'`,
    )
  }

  current.bodyGroupId = groupId
  current.anchorMessageId = anchorMessageId
  extra.agentTavern = current
  return extra
}

function assertFloorGroup(message: ChatMessage, groupId: string): void {
  const currentGroup = readAgentTavern(message)?.bodyGroupId
  if (currentGroup !== undefined && currentGroup !== groupId) {
    throw new BodyJsonlProjectionError(
      'body-group-mismatch',
      `body floor is already bound to group '${String(currentGroup)}', cannot project group '${groupId}'`,
    )
  }
}

function readAgentTavern(message: ChatMessage): Record<string, unknown> | undefined {
  const extra = message.extra
  if (!isRecord(extra)) return undefined
  const agentTavern = extra.agentTavern
  return isRecord(agentTavern) ? agentTavern : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
