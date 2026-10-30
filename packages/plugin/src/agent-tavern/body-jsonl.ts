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
  | 'body-adoption-mismatch'
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

/**
 * Find a body floor by `extra.agentTavern.bodyGroupId`.
 *
 * A group owns exactly one chat floor. More than one match is ambiguous: the
 * read path would show an arbitrary floor and the write path would edit one of
 * them depending on chat order, so both refuse with `body-group-mismatch` and
 * list every matched index.
 */
export function findBodyFloorIndexByGroupId(chat: ChatLogIR, groupId: string): number | undefined {
  let found: number | undefined
  const matches: number[] = []
  for (const [index, message] of chat.messages.entries()) {
    if (readAgentTavern(message)?.bodyGroupId !== groupId) continue
    matches.push(index)
    found ??= index
  }
  if (matches.length > 1) {
    throw new BodyJsonlProjectionError(
      'body-group-mismatch',
      `body group '${groupId}' matches ${matches.length} chat floors (${matches.join(', ')}); a body group must own exactly one floor`,
    )
  }
  return found
}

/** Find a body floor by `extra.agentTavern.messageId`. */
export function findBodyFloorIndexByMessageId(chat: ChatLogIR, messageId: string): number | undefined {
  for (const [index, message] of chat.messages.entries()) {
    if (readAgentTavern(message)?.messageId === messageId) return index
  }
  return undefined
}

/** Hints for {@link locateBodyFloorForRead}. */
export interface BodyJsonlReadHints {
  readonly messageId: string
  /**
   * Ledger group id. It outranks the message scan because a candidate switch
   * leaves the floor on the previous anchor until the projection catches up.
   */
  readonly groupId?: string
}

/**
 * Locate the single chat floor a `GET body` read may use.
 *
 * The read path applies the same uniqueness rule as the write path: a group
 * that matches more than one floor throws `body-group-mismatch` with every
 * matched index instead of silently serving the first one. `undefined` means
 * nothing is projected yet (cold or lagging session), which is not an error.
 *
 * @throws BodyJsonlProjectionError `body-group-mismatch` when the group or the
 * message id resolves to more than one floor.
 */
export function locateBodyFloorForRead(chat: ChatLogIR, hints: BodyJsonlReadHints): number | undefined {
  requireNonEmpty(hints.messageId, 'invalid-body-message-id', 'body message id')
  if (hints.groupId !== undefined) {
    requireNonEmpty(hints.groupId, 'invalid-body-group-id', 'body group id')
    // `findBodyFloorIndexByGroupId` refuses an ambiguous group; a read must
    // never pick one of two floors the ledger expects to be unique.
    const byGroup = findBodyFloorIndexByGroupId(chat, hints.groupId)
    if (byGroup !== undefined) return byGroup
  }

  const matches: number[] = []
  for (const [index, message] of chat.messages.entries()) {
    const tavern = readAgentTavern(message)
    if (tavern === undefined) continue
    if (tavern.bodyGroupId !== hints.messageId
      && tavern.messageId !== hints.messageId
      && tavern.anchorMessageId !== hints.messageId) continue
    matches.push(index)
  }
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    throw new BodyJsonlProjectionError(
      'body-group-mismatch',
      `body message '${hints.messageId}' matches ${matches.length} chat floors (${matches.join(', ')}); a read must resolve exactly one floor`,
    )
  }

  const index = matches[0]!
  // Even when the message id found the floor, its group still owns exactly one
  // chat floor, so re-check the binding with the write-side locator.
  const groupId = readAgentTavern(chat.messages[index]!)?.bodyGroupId
  if (typeof groupId === 'string' && groupId !== '') findBodyFloorIndexByGroupId(chat, groupId)
  return index
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
  // Keep the ST swipe_info shape for every filled slot: an empty object would
  // drop the required send_date and break ST-compatible readers.
  while (nextSwipeInfo.length < input.index) {
    nextSwipeInfo.push({ send_date: input.sendDate, extra: {} })
  }
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
 * Restore an anchor after a failed regeneration.
 *
 * The candidate list and `swipe_info` remain untouched, but the ST selection
 * surface must agree with the ledger again: the failed attempt may leave the
 * floor on its candidate slot, and a `swipe_id` that no longer equals `index`
 * makes every later candidate receipt look `stale-anchor`. Restoring therefore
 * rewrites `swipe_id` and `mes` from `swipes[index]`; a missing slot is a typed
 * refusal instead of a silent keep. `lastBodyEventSeq` / `lastBodyMutation` are
 * preserved like `applySelectToChat` does, because a restore record carries no
 * edit watermark of its own.
 */
export function applyRestoreToChat(chat: ChatLogIR, input: BodyJsonlRestoreInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  requireNonEmpty(input.messageId, 'invalid-body-message-id', 'restore message id')
  requireIndex(input.index, 'invalid-body-index', 'restore index')

  const floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
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
    extra: patchAgentTavern(nextFloor, input.groupId, input.messageId),
  }
  return next
}

/* -------------------------------- adoption --------------------------------- */

/** Input for {@link applyFloorAdoptionToChat}. */
export interface BodyJsonlAdoptionInput {
  readonly groupId: string
  readonly sessionId: string
  readonly anchorMessageId: string
  /** Text of the imported anchor message the adopted floor must mirror. */
  readonly anchorText: string
}

/**
 * Adopt the chat's trailing plugin-unaware assistant floor for one imported
 * anchor (the AgentTavern history import never projects its mirror messages
 * back into the JSONL — decision 2026-10-20 — so their floors carry no
 * `extra.agentTavern` identity and every body event targeting them fails).
 *
 * The body ledger owns the floor's swipe slot list (`swipes[index]` is ledger
 * candidate `index`), so the adopted floor's ST swipe surface is dropped: the
 * following candidate projection then creates slot 0 from the ledger text
 * exactly like the first body operation on a live floor, placeholders and MVU
 * receipts included. `mes` stays untouched until that projection lands, and
 * the group binding makes the floor locatable for every later operation.
 *
 * Adoption is only allowed when the chosen floor is really the anchor's chat
 * mirror: a plugin-unaware assistant floor whose `mes` equals the anchor text.
 * Any other floor is refused with `body-adoption-mismatch` instead of binding
 * the group to a floor the anchor never produced.
 *
 * The dropped swipe fields are snapshotted into
 * `extra.agentTavern.adoptedSwipes` so the original ST surface can be
 * restored manually; the read paths ignore that field.
 *
 * The display route keeps matching `extra.agentTavern.messageId` only, so
 * adopted floors stay outside the display override (decision 2026-10-20).
 *
 * @throws BodyJsonlProjectionError `body-group-mismatch` when this group is
 * already projected; `body-floor-not-found` when no adoptable floor exists;
 * `body-adoption-mismatch` when the floor is not the anchor mirror.
 */
export function applyFloorAdoptionToChat(chat: ChatLogIR, input: BodyJsonlAdoptionInput): ChatLogIR {
  requireNonEmpty(input.groupId, 'invalid-body-group-id', 'body group id')
  requireNonEmpty(input.sessionId, 'invalid-body-message-id', 'adoption session id')
  requireNonEmpty(input.anchorMessageId, 'invalid-body-message-id', 'adoption anchor message id')
  requireNonEmpty(input.anchorText, 'invalid-body-text', 'adoption anchor text')

  if (findBodyFloorIndexByGroupId(chat, input.groupId) !== undefined) {
    throw new BodyJsonlProjectionError(
      'body-group-mismatch',
      `body floor for group '${input.groupId}' is already projected; nothing to adopt`,
    )
  }
  const floorIndex = findAdoptableFloorIndex(chat)
  if (floorIndex === undefined) {
    throw new BodyJsonlProjectionError(
      'body-floor-not-found',
      `no unprojected assistant floor can be adopted for group '${input.groupId}'`,
    )
  }
  const floor = chat.messages[floorIndex]!
  assertAdoptionMirror(floor, input, floorIndex)

  const next = structuredClone(chat)
  const nextFloor = next.messages[floorIndex]!
  const extra = patchAgentTavern(nextFloor, input.groupId, input.anchorMessageId)
  const current = isRecord(extra.agentTavern) ? extra.agentTavern : {}
  extra.agentTavern = {
    ...current,
    sessionId: input.sessionId,
    adoptedSwipes: snapshotSwipeSurface(nextFloor),
  }
  const adopted = { ...nextFloor, extra }
  delete adopted.swipes
  delete adopted.swipe_id
  delete adopted.swipe_info
  next.messages[floorIndex] = adopted
  return next
}

/**
 * Refuse a floor that is not the chat mirror of the imported anchor. The text
 * comparison is exact (after trimming) because the import writes the same
 * text into the host session.
 */
function assertAdoptionMirror(floor: ChatMessage, input: BodyJsonlAdoptionInput, floorIndex: number): void {
  if (floor.is_user === true || floor.is_system === true || typeof floor.mes !== 'string') {
    throw adoptionMismatch(input, floorIndex, 'the floor is not an assistant message')
  }
  const tavern = readAgentTavern(floor)
  if (tavern !== undefined && Object.keys(tavern).length > 0) {
    throw adoptionMismatch(input, floorIndex, 'the floor already carries AgentTavern metadata')
  }
  const anchorText = input.anchorText.trim()
  if (floor.mes.trim() !== anchorText) {
    // Lengths only: this message flows into the projection checkpoint, the
    // GET /projection response and logs, and the body must not leave a second
    // copy of its text there (decision 2026-10-29, the same round that dropped
    // `plan.bodyText` for exactly that reason).
    throw adoptionMismatch(
      input,
      floorIndex,
      `the floor text does not equal the anchor text (floor length ${floor.mes.trim().length}, anchor length ${anchorText.length})`,
    )
  }
}

function adoptionMismatch(
  input: BodyJsonlAdoptionInput,
  floorIndex: number,
  detail: string,
): BodyJsonlProjectionError {
  return new BodyJsonlProjectionError(
    'body-adoption-mismatch',
    `imported floor adoption refused for group '${input.groupId}': chat floor ${floorIndex} is not the mirror of anchor '${input.anchorMessageId}' (${detail})`,
  )
}

/** Original ST swipe surface of an adopted floor, kept for manual restoration. */
function snapshotSwipeSurface(floor: ChatMessage): Record<string, unknown> {
  return {
    ...(floor.swipes === undefined ? {} : { swipes: structuredClone(floor.swipes) }),
    ...(floor.swipe_id === undefined ? {} : { swipe_id: floor.swipe_id }),
    ...(floor.swipe_info === undefined ? {} : { swipe_info: structuredClone(floor.swipe_info) }),
  }
}

/** Last assistant floor the plugin never projected; the adoption target. */
function findAdoptableFloorIndex(chat: ChatLogIR): number | undefined {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index]
    if (message === undefined || message.is_user === true || message.is_system === true) continue
    if (typeof message.mes !== 'string' || message.mes.trim() === '') continue
    const tavern = readAgentTavern(message)
    if (tavern?.bodyGroupId !== undefined || tavern?.messageId !== undefined) continue
    return index
  }
  return undefined
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
