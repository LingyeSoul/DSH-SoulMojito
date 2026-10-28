/**
 * Pure AgentTavern body ledger and host message projection for proposal 0021.
 *
 * This module owns the `plugin:dsh-soulmojito/body` plugin-record vocabulary, the
 * fold that reconstructs candidate order, selection, anchor and edits, the
 * effective body text, and the message-projection definition that rewrites the
 * surface anchor. It never reads the clock, filesystem, network or host
 * runtime state.
 */

export const BODY_EVENT_TYPE = 'plugin:dsh-soulmojito/body' as const

/* ------------------------------- event shape ------------------------------- */

/** One body log event. `op-start` / `op-finish` are bookkeeping only. */
export type BodyEventData =
  | {
      readonly op: 'op-start'
      readonly opId: string
      readonly groupId: string
      readonly kind: 'regenerate'
      readonly previousAnchorId: string
      readonly previousIndex: number
    }
  | {
      readonly op: 'op-finish'
      readonly opId: string
      readonly result: 'ok' | 'failed'
      readonly anchorId?: string
      readonly reason?: string
    }
  | {
      readonly op: 'candidate'
      readonly groupId: string
      readonly messageId: string
      readonly index: number
      readonly feedback?: string
    }
  | {
      readonly op: 'restore'
      readonly groupId: string
      readonly messageId: string
      readonly index: number
    }
  | {
      readonly op: 'select'
      readonly groupId: string
      readonly index: number
    }
  | {
      readonly op: 'edit'
      readonly groupId: string
      readonly index: number
      readonly text: string
      readonly previousText: string
    }

/** The structural surface of one body log record. */
export interface BodyLogEvent {
  readonly seq: number
  readonly type: typeof BODY_EVENT_TYPE
  readonly data: BodyEventData
}

/* -------------------------------- ledger ---------------------------------- */

/**
 * One body candidate. `text` is the candidate's original assistant text; it is
 * not part of proposal 0021's abbreviated interface but is required to answer
 * `effectiveBodyText()` for a candidate that was never edited.
 */
export interface BodyCandidate {
  readonly messageId: string
  readonly index: number
  readonly text: string
  readonly feedback?: string
}

/** Read-only state folded from body events for one group. */
export interface BodyLedger {
  readonly groupId: string
  readonly candidates: readonly BodyCandidate[]
  readonly selectedIndex: number
  readonly anchorMessageId: string
  readonly edits: ReadonlyMap<number, string>
}

/* ------------------------------- messages --------------------------------- */

/** Strict JSON value used at the external-event boundary. */
export type BodyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly BodyJsonValue[]
  | BodyJsonObject

/** Strict JSON object used at the external-event boundary. */
export interface BodyJsonObject {
  readonly [member: string]: BodyJsonValue | undefined
}

/**
 * Minimal structural view of one message content block. Every non-`type`
 * member is preserved as JSON so non-text blocks survive projection.
 */
export interface BodyContentBlock {
  readonly type: string
  readonly [member: string]: BodyJsonValue | undefined
}

/**
 * Minimal structural view of a host message. The projection spreads the
 * original value, so members outside this view (`source`, tool metadata,
 * provider replay state) survive unchanged.
 */
export interface BodyMessageLike {
  readonly id: string
  readonly role: string
  readonly content: readonly BodyContentBlock[]
  readonly source?: BodyJsonValue
}

/** Data carried by an `assistant/message` event used to resolve candidate text. */
export interface BodyAssistantMessageData {
  readonly message: BodyMessageLike
}

/** Data accepted from a session event while folding or projecting. */
export type BodySessionEventData =
  | BodyEventData
  | BodyAssistantMessageData
  | BodyJsonObject

/** Minimal structural view of one host session event. */
export interface BodySessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: BodySessionEventData | undefined
}

/** Minimal structural view of the host message-projection context. */
export interface BodyProjectionContext {
  readonly events: readonly BodySessionEvent[]
}

/** Message projection definition registered through `registerMessageProjection`. */
export interface BodyProjection {
  readonly type: typeof BODY_EVENT_TYPE
  project(event: BodyLogEvent, context: BodyProjectionContext): ReadonlyMap<number, BodyMessageLike>
}

/* --------------------------------- errors --------------------------------- */

export type BodyLedgerErrorCode =
  | 'invalid-body-event'
  | 'invalid-body-op'
  | 'invalid-body-seq'
  | 'invalid-body-group-id'
  | 'invalid-body-message-id'
  | 'invalid-body-index'
  | 'invalid-body-text'
  | 'body-candidate-gap'
  | 'body-candidate-message-missing'

/** Typed failure with a stable code for callers and tests. */
export class BodyLedgerError extends Error {
  readonly code: BodyLedgerErrorCode

  constructor(code: BodyLedgerErrorCode, message: string) {
    super(message)
    this.name = 'BodyLedgerError'
    this.code = code
  }
}

/* ---------------------------------- fold ---------------------------------- */

/**
 * Fold body events into the ledger for one group.
 *
 * Events are ordered by `seq`, and only events at or before `uptoSeq` are
 * applied. Non-body events are ignored except `assistant/message`, which
 * supplies candidate text. `op-start` / `op-finish` never change the ledger.
 *
 * @returns a new frozen ledger, or `undefined` when the group has no candidate
 * @throws BodyLedgerError for malformed events and out-of-range indices
 */
export function foldBodyLedger(
  events: readonly BodySessionEvent[],
  groupId: string,
  uptoSeq: number,
): BodyLedger | undefined {
  if (typeof groupId !== 'string' || groupId.trim() === '') {
    throw new BodyLedgerError('invalid-body-group-id', 'body group id must be a non-empty string')
  }
  if (!Number.isSafeInteger(uptoSeq) || uptoSeq < 0) {
    throw new BodyLedgerError('invalid-body-seq', `fold watermark must be a non-negative safe integer, received ${String(uptoSeq)}`)
  }

  const ordered = orderEvents(events)
  const candidates: BodyCandidate[] = []
  const candidateText = new Map<string, string>()
  const edits = new Map<number, string>()
  let selectedIndex = -1
  let anchorMessageId = ''

  for (const event of ordered) {
    if (event.seq > uptoSeq) break

    if (event.type === 'assistant/message') {
      const message = readAssistantMessage(event.data)
      if (message !== undefined && !candidateText.has(message.id)) {
        candidateText.set(message.id, messageText(message))
      }
      continue
    }

    if (event.type !== BODY_EVENT_TYPE) continue

    const data = parseBodyEventData(event.data, event.seq)
    if (data.op === 'op-start' || data.op === 'op-finish') continue
    if (data.groupId !== groupId) continue

    switch (data.op) {
      case 'candidate': {
        if (data.index !== candidates.length) {
          throw new BodyLedgerError(
            'body-candidate-gap',
            `body event seq ${event.seq} would place candidate index ${data.index} after ${candidates.length} candidates in group '${groupId}'`,
          )
        }
        const text = candidateText.get(data.messageId)
        if (text === undefined) {
          throw new BodyLedgerError(
            'body-candidate-message-missing',
            `body event seq ${event.seq} candidate '${data.messageId}' has no assistant/message at or before its seq in group '${groupId}'`,
          )
        }
        candidates.push(Object.freeze({
          messageId: data.messageId,
          index: data.index,
          text,
          ...(data.feedback === undefined ? {} : { feedback: data.feedback }),
        }))
        selectedIndex = data.index
        anchorMessageId = data.messageId
        break
      }
      case 'select': {
        requireCandidate(candidates, data.index, 'select', event.seq, groupId)
        selectedIndex = data.index
        break
      }
      case 'edit': {
        requireCandidate(candidates, data.index, 'edit', event.seq, groupId)
        edits.set(data.index, data.text)
        break
      }
      case 'restore': {
        requireCandidate(candidates, data.index, 'restore', event.seq, groupId)
        selectedIndex = data.index
        anchorMessageId = data.messageId
        break
      }
    }
  }

  if (candidates.length === 0) return undefined

  return Object.freeze({
    groupId,
    candidates: Object.freeze(candidates),
    selectedIndex,
    anchorMessageId,
    edits: new Map(edits),
  })
}

/**
 * Effective text of the selected candidate: the latest edit for its index,
 * otherwise the candidate's original text.
 */
export function effectiveBodyText(ledger: BodyLedger): string | undefined {
  const candidate = ledger.candidates[ledger.selectedIndex]
  if (candidate === undefined) return undefined
  return ledger.edits.get(candidate.index) ?? candidate.text
}

/* ------------------------------ text projection ---------------------------- */

/**
 * Replace all text blocks with one text block at the first text position.
 * Non-text blocks keep their order and all other message members survive.
 * The input is never mutated.
 */
export function replaceMessageText(message: BodyMessageLike, text: string): BodyMessageLike {
  if (typeof message.id !== 'string' || message.id.trim() === '') {
    throw new BodyLedgerError('invalid-body-message-id', 'message id must be a non-empty string')
  }
  if (typeof message.role !== 'string' || message.role.trim() === '') {
    throw new BodyLedgerError('invalid-body-event', `message '${message.id}' role must be a non-empty string`)
  }
  if (!Array.isArray(message.content)) {
    throw new BodyLedgerError('invalid-body-event', `message '${message.id}' content must be an array`)
  }
  if (typeof text !== 'string') {
    throw new BodyLedgerError('invalid-body-text', `replacement text for message '${message.id}' must be a string`)
  }

  const blocks: BodyContentBlock[] = []
  let replaced = false
  for (const block of message.content) {
    if (!isJsonObject(block)) {
      throw new BodyLedgerError('invalid-body-event', `message '${message.id}' contains a non-object content block`)
    }
    const type = block['type']
    if (typeof type !== 'string' || type === '') {
      throw new BodyLedgerError('invalid-body-event', `message '${message.id}' contains a content block without a type`)
    }
    if (type === 'text') {
      if (!replaced) {
        blocks.push({ type: 'text', text })
        replaced = true
      }
      continue
    }
    blocks.push({ ...block, type })
  }
  if (!replaced) blocks.push({ type: 'text', text })

  return { ...message, content: blocks }
}

/* ------------------------------- projection -------------------------------- */

/** Create the message projection consumed by the host session store. */
export function createBodyProjection(): BodyProjection {
  return {
    type: BODY_EVENT_TYPE,
    project(event, context) {
      const data = event.data
      if (data.op !== 'select' && data.op !== 'edit') return new Map<number, BodyMessageLike>()

      const ledger = foldBodyLedger(context.events, data.groupId, event.seq)
      if (ledger === undefined) return new Map<number, BodyMessageLike>()

      const anchor = findAnchorMessage(context.events, ledger.anchorMessageId, event.seq)
      if (anchor === undefined) return new Map<number, BodyMessageLike>()

      const text = effectiveBodyText(ledger)
      if (text === undefined) return new Map<number, BodyMessageLike>()

      return new Map([[anchor.seq, replaceMessageText(anchor.message, text)]])
    },
  }
}

/* -------------------------------- helpers ---------------------------------- */

interface BodyAnchor {
  readonly seq: number
  readonly message: BodyMessageLike
}

function findAnchorMessage(
  events: readonly BodySessionEvent[],
  messageId: string,
  uptoSeq: number,
): BodyAnchor | undefined {
  let anchor: BodyAnchor | undefined
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > uptoSeq) continue
    if (event.type !== 'assistant/message') continue
    const message = readAssistantMessage(event.data)
    if (message === undefined || message.id !== messageId) continue
    if (anchor === undefined || event.seq >= anchor.seq) anchor = { seq: event.seq, message }
  }
  return anchor
}

function orderEvents(events: readonly BodySessionEvent[]): readonly BodySessionEvent[] {
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new BodyLedgerError('invalid-body-seq', `event at index ${index} has invalid seq ${String(event.seq)}`)
    }
  }

  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous !== undefined && current !== undefined && previous.seq === current.seq) {
      throw new BodyLedgerError('invalid-body-seq', `events share seq ${current.seq}; session sequences must be unique`)
    }
  }
  return ordered
}

function requireCandidate(
  candidates: readonly BodyCandidate[],
  index: number,
  op: 'select' | 'edit' | 'restore',
  seq: number,
  groupId: string,
): void {
  if (index >= candidates.length) {
    throw new BodyLedgerError(
      'invalid-body-index',
      `body event seq ${seq} ${op} index ${index} is out of range for group '${groupId}' with ${candidates.length} candidates`,
    )
  }
}

function parseBodyEventData(data: BodySessionEventData | undefined, seq: number): BodyEventData {
  if (!isJsonObject(data)) {
    throw new BodyLedgerError('invalid-body-event', `body event seq ${seq} must carry an object data payload`)
  }

  const where = `body event seq ${seq}`
  const op = data['op']
  switch (op) {
    case 'op-start': {
      const kind = data['kind']
      if (kind !== 'regenerate') {
        throw new BodyLedgerError('invalid-body-event', `${where} field 'kind' must be 'regenerate', received ${String(kind)}`)
      }
      return {
        op,
        opId: requireNonEmpty(data, 'opId', where, 'invalid-body-event'),
        groupId: requireGroupId(data, where),
        kind,
        previousAnchorId: requireMessageId(data, 'previousAnchorId', where),
        previousIndex: requireIndex(data, 'previousIndex', where),
      }
    }
    case 'op-finish': {
      const result = data['result']
      if (result !== 'ok' && result !== 'failed') {
        throw new BodyLedgerError('invalid-body-event', `${where} field 'result' must be 'ok' or 'failed', received ${String(result)}`)
      }
      const anchorId = optionalText(data, 'anchorId', where)
      const reason = optionalText(data, 'reason', where)
      return {
        op,
        opId: requireNonEmpty(data, 'opId', where, 'invalid-body-event'),
        result,
        ...(anchorId === undefined ? {} : { anchorId }),
        ...(reason === undefined ? {} : { reason }),
      }
    }
    case 'candidate': {
      const feedback = optionalText(data, 'feedback', where)
      return {
        op,
        groupId: requireGroupId(data, where),
        messageId: requireMessageId(data, 'messageId', where),
        index: requireIndex(data, 'index', where),
        ...(feedback === undefined ? {} : { feedback }),
      }
    }
    case 'restore':
      return {
        op,
        groupId: requireGroupId(data, where),
        messageId: requireMessageId(data, 'messageId', where),
        index: requireIndex(data, 'index', where),
      }
    case 'select':
      return {
        op,
        groupId: requireGroupId(data, where),
        index: requireIndex(data, 'index', where),
      }
    case 'edit':
      return {
        op,
        groupId: requireGroupId(data, where),
        index: requireIndex(data, 'index', where),
        text: requireText(data, 'text', where),
        previousText: requireText(data, 'previousText', where),
      }
    default:
      throw new BodyLedgerError('invalid-body-op', `${where} has unknown op '${String(op)}'`)
  }
}

function requireGroupId(record: BodyJsonObject, where: string): string {
  return requireNonEmpty(record, 'groupId', where, 'invalid-body-group-id')
}

function requireMessageId(record: BodyJsonObject, field: string, where: string): string {
  return requireNonEmpty(record, field, where, 'invalid-body-message-id')
}

function requireNonEmpty(
  record: BodyJsonObject,
  field: string,
  where: string,
  code: BodyLedgerErrorCode,
): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BodyLedgerError(code, `${where} field '${field}' must be a non-empty string`)
  }
  return value
}

function requireText(record: BodyJsonObject, field: string, where: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new BodyLedgerError('invalid-body-event', `${where} field '${field}' must be a string`)
  }
  return value
}

function optionalText(record: BodyJsonObject, field: string, where: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new BodyLedgerError('invalid-body-event', `${where} field '${field}' must be a string when present`)
  }
  return value
}

function requireIndex(record: BodyJsonObject, field: string, where: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BodyLedgerError(
      'invalid-body-index',
      `${where} field '${field}' must be a non-negative safe integer, received ${String(value)}`,
    )
  }
  return value
}

function readAssistantMessage(data: BodySessionEventData | undefined): BodyMessageLike | undefined {
  if (!isJsonObject(data)) return undefined
  // BodyEventData is itself JSON-shaped, so the guard keeps it in the narrowed
  // union; after the guard the payload is safe to read as a JSON object.
  const envelope: BodyJsonObject = data
  const message = envelope['message']
  if (!isJsonObject(message)) return undefined

  const id = message['id']
  const role = message['role']
  const content = message['content']
  if (typeof id !== 'string' || id.trim() === '' || role !== 'assistant' || !Array.isArray(content)) return undefined

  const blocks: BodyContentBlock[] = []
  for (const block of content) {
    if (!isJsonObject(block)) return undefined
    const type = block['type']
    if (typeof type !== 'string' || type === '') return undefined
    if (type === 'text' && typeof block['text'] !== 'string') return undefined
    blocks.push({ ...block, type })
  }

  return { ...message, id, role, content: blocks }
}

function messageText(message: BodyMessageLike): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function isJsonObject(
  value: BodySessionEventData | BodyJsonValue | undefined,
): value is BodyJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
