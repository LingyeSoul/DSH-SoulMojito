/**
 * Shared AgentTavern body session reads and host-shape helpers.
 *
 * This shard owns the read-only side used by both the `GET body` view and
 * startup recovery: structural event parsing, body-ledger folds, operation
 * terminal records, message text, anchor-surface inspection, binding/agent
 * resolution and safe logging. It never writes to the session and never owns
 * projection or mutation logic.
 */

import {
  isHostPluginMessageSource,
  readSessionEvents,
  LEGACY_PLUGIN_NAME,
  PLUGIN_NAME,
  type HostSessionLog,
} from '../../../bind/src/index.js'
import type { HostAgentsService, HostLogger } from '../host-contract.js'
import {
  BODY_EVENT_TYPE,
  BODY_SETTLED_EVENT_TYPE,
  foldBodyLedger,
  type BodyLedger,
  type BodySessionEvent,
} from './body.js'
import { BODY_ABORT_EVENT_TYPE } from './body-runtime-settlement.js'
import type { BodyAgentLike, BodySessionLike } from './body-runtime.js'

/* ------------------------- contract and logging ---------------------------- */

// Host slices, logging and primitive guards live in `body-session-contract.ts`;
// they are re-exported here so existing importers keep this module as the entry
// point.
export {
  errorLog,
  errorMessage,
  failureCodeOf,
  info,
  isRecord,
  nonEmptyString,
  warn,
} from './body-session-contract.js'
export type {
  BodyAgentsHost,
  BodyBindingHost,
  BodyBindingResolver,
  BodyBindingView,
  BodyLogHost,
} from './body-session-contract.js'
import {
  errorLog,
  errorMessage,
  failureCodeOf,
  info,
  isRecord,
  nonEmptyString,
  warn,
} from './body-session-contract.js'
import type {
  BodyAgentsHost,
  BodyBindingHost,
  BodyBindingView,
  BodyLogHost,
} from './body-session-contract.js'

/* ------------------------------ session marker ----------------------------- */

/**
 * Whether a session message source carries the dsh-soulmojito marker (import
 * mirror, anchored notice, plugin notification). Preload notices (a summary
 * starting with "AgentTavern preload: ") are excluded: they must not lock the
 * session as started. Model mirrors are recognised by the synthetic
 * provider/model pair because released v0 dispositions admit no extra members
 * on model sources (TAVERN_MIRROR_MODEL_SOURCE).
 */
export function isTavernSessionMarker(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as Record<string, unknown>
  if (record.kind === 'model') {
    // Rename compatibility (2026-10-16): stored mirrors may carry the legacy
    // provider name; new writes always use the new one.
    const provider = record.provider
    return (provider === PLUGIN_NAME || provider === LEGACY_PLUGIN_NAME) && record.model === 'agent-tavern-import'
  }
  if (!isHostPluginMessageSource(record)) return false
  return !(typeof record.summary === 'string' && record.summary.startsWith('AgentTavern preload: '))
}

export function agentIdOf(agent: BodyAgentLike): string | undefined {
  return nonEmptyString(agent.id) ?? nonEmptyString(agent.session.id)
}

/* -------------------------------- parsing --------------------------------- */

export interface WiringEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
  /** Host event time in epoch milliseconds; absent when the event has none. */
  readonly time?: number
}

export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** Stable diagnostic code for a session event that could not be read at all. */
type WiringLogIssueCode =
  | 'invalid-session-event'
  | 'invalid-body-event'
  | 'invalid-body-seq'

/** One skipped or malformed session event, kept for logging instead of dropping the whole log. */
interface WiringLogIssue {
  readonly code: WiringLogIssueCode
  readonly message: string
  readonly index: number
  readonly type?: string
  readonly seq?: number
}

/**
 * Session log read with per-event degradation.
 *
 * Unrelated events that cannot be parsed are skipped one by one. A body event
 * that cannot be read at all is reported as `strictFailure`: callers must not
 * fold a body ledger from a log that is missing a body record, because the
 * resulting slots would silently describe something the log never said.
 */
interface WiringLogRead {
  readonly events: readonly WiringEvent[]
  readonly issues: readonly WiringLogIssue[]
  readonly strictFailure?: WiringLogIssue
}

/** Event types whose payload the body read side relies on. */
function isBodyReadEventType(type: string): boolean {
  return type === BODY_EVENT_TYPE || type === BODY_SETTLED_EVENT_TYPE || type === BODY_ABORT_EVENT_TYPE
}

/**
 * Read one host session log, tolerating unrelated malformed events.
 *
 * Before 2026-10-29 a single unrelated event without an object `data` made the
 * whole body read return `undefined`, so `GET body` looked like `session-busy`
 * and no log line explained why. Unrelated events are now skipped with an
 * issue, and only a damaged body record blocks the ledger fold.
 */
function readWiringLog(session: BodySessionLike): WiringLogRead | undefined {
  const values = readSessionEvents(session as HostSessionLog)
  if (values === undefined) return undefined
  const events: WiringEvent[] = []
  const issues: WiringLogIssue[] = []
  let strictFailure: WiringLogIssue | undefined
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)) {
      issues.push({
        code: 'invalid-session-event',
        message: `session event at index ${index} is not an object`,
        index,
      })
      continue
    }
    const type = value['type']
    if (typeof type !== 'string' || type === '') {
      issues.push({
        code: 'invalid-session-event',
        message: `session event at index ${index} has no type`,
        index,
      })
      continue
    }
    const seq = value['seq']
    const data = value['data']
    const seqUsable = isSeq(seq)
    const dataUsable = isRecord(data)
    if (isBodyReadEventType(type) && (!seqUsable || !dataUsable)) {
      const issue: WiringLogIssue = seqUsable
        ? {
          code: 'invalid-body-event',
          message: `body event '${type}' at session index ${index} (seq ${seq}) must carry an object data payload`,
          index,
          type,
          seq,
        }
        : {
          code: 'invalid-body-seq',
          message: `body event '${type}' at session index ${index} has invalid seq ${String(seq)}`,
          index,
          type,
        }
      issues.push(issue)
      strictFailure ??= issue
      continue
    }
    if (!seqUsable) {
      issues.push({
        code: 'invalid-session-event',
        message: `session event '${type}' at index ${index} has invalid seq ${String(seq)}`,
        index,
        type,
      })
      continue
    }
    if (!dataUsable && data !== undefined) {
      issues.push({
        code: 'invalid-session-event',
        message: `session event '${type}' at index ${index} (seq ${seq}) has non-object data; read as an empty payload`,
        index,
        type,
        seq,
      })
    }
    const time = value['time']
    events.push({
      type,
      seq,
      data: dataUsable ? data : {},
      ...(isSeq(time) ? { time } : {}),
    })
  }
  events.sort((left, right) => left.seq - right.seq)
  return {
    events,
    issues,
    ...(strictFailure === undefined ? {} : { strictFailure }),
  }
}

/** Session events for callers that do not consume degradation diagnostics. */
export function wiringEvents(session: BodySessionLike): WiringEvent[] | undefined {
  const log = readWiringLog(session)
  return log === undefined ? undefined : [...log.events]
}

/** One-line diagnostic used as the `GET body` ledger warning. */
function wiringLogIssueText(issues: readonly WiringLogIssue[], strictFailure: WiringLogIssue | undefined): string | undefined {
  const first = strictFailure ?? issues[0]
  if (first === undefined) return undefined
  const extra = issues.filter((issue) => issue !== first).length
  return `${first.code}: ${first.message}${extra > 0 ? ` (+${extra} more unreadable session event(s))` : ''}`
}

export function eventAt(events: readonly WiringEvent[], seq: number): WiringEvent | undefined {
  return events.find((event) => event.seq === seq)
}

export function messageOf(event: WiringEvent): Record<string, unknown> | undefined {
  if (event.type === 'user/message') return event.data
  const message = event.data['message']
  return isRecord(message) ? message : undefined
}

export function messageIdOf(event: WiringEvent): string | undefined {
  const message = messageOf(event)
  const id = message?.['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function textOfMessage(message: Record<string, unknown>): string {
  return contentOf(message)
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('')
}

export function hasToolCall(message: Record<string, unknown>): boolean {
  return contentOf(message).some((block) => block['type'] === 'tool-call')
}

export function surfaceNodes(session: BodySessionLike): number[] | undefined {
  const surface = session.surface
  if (!isRecord(surface)) return undefined
  const nodes = surface['nodes']
  if (!Array.isArray(nodes)) return undefined
  const parsed: number[] = []
  for (const node of nodes) {
    if (!isSeq(node)) return undefined
    parsed.push(node)
  }
  return parsed
}

export function openTurnNumber(events: readonly WiringEvent[]): number | undefined {
  let open: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = numberField(event.data['turn'])
    else if (event.type === 'turn/end') open = undefined
  }
  return open
}

/* ------------------------------ session reads ------------------------------ */

/** Fold body records for one group from a live session log. */
export function foldSessionBodyLedger(session: BodySessionLike, groupId: string): BodyLedger | undefined {
  const events = wiringEvents(session)
  if (events === undefined) return undefined
  return foldBodyLedgerFromEvents(events, groupId)
}

/**
 * One session snapshot resolved for `GET body`: the body ledger, the native
 * message text and the anchor surface check. Reading them together keeps the
 * per-rendered-row route at one event-log pass instead of three.
 */
export interface BodySessionFacts {
  readonly ledger: BodyLedger | undefined
  readonly messageText: string | undefined
  readonly inspection: BodyAnchorInspection | undefined
  /**
   * Highest `edit` record sequence for the folded group. The JSONL floor marks
   * the last edit it applied in `agentTavern.lastBodyEventSeq`; the display
   * route compares the two so a stale floor never masks a fresh edit.
   */
  readonly latestEditSeq?: number
  /**
   * Latest aborted, failed or cancelled operation in the log. Present only when
   * a non-successful terminal record exists, so a cold session keeps the stable
   * empty body shape.
   */
  readonly lastOperation?: BodyLastOperation
  /**
   * Present when folding failed or a session event had to be skipped. The
   * display route logs it and keeps the stable body.
   */
  readonly ledgerError?: string
}

/** Most recent non-successful terminal record of one body operation. */
export interface BodyLastOperation {
  readonly opId: string
  readonly status: 'aborted' | 'failed' | 'cancelled'
  /** Actionable cause recorded with the terminal record. */
  readonly reason: string
  /**
   * Host event time in epoch milliseconds. Absent when the record carries no
   * usable time (hand-written or legacy log); the read side never invents one.
   */
  readonly at?: number
}

/** Whether the anchor is still the last body on the current surface. */
export interface BodyAnchorInspection {
  readonly onSurface: boolean
  readonly last: boolean
}

/**
 * One parsed session log shared by every message id of a request.
 *
 * The batch form of `GET body` resolves the event log, the body ledgers, the
 * message texts and the anchor checks once; `factsOf` then only assembles the
 * per-message facts. A fold failure stays bound to its group, so damaged data
 * degrades the same way for every row that owns it.
 */
export interface BodySessionFactsSource {
  factsOf(messageId: string, groupHint: string | undefined): BodySessionFacts
}

/** One cached ledger fold; a failure is cached too, so it degrades consistently. */
interface FoldedBodyLedger {
  readonly ledger: BodyLedger | undefined
  readonly error?: unknown
}

/** Cached terminal-operation fold for the shared log. */
interface BodyOperationRead {
  readonly value?: BodyLastOperation
  readonly error?: string
}

/**
 * Build a read source over one session log.
 *
 * The returned `factsOf` is memoized per `messageId` + `groupHint`, so repeated
 * rows of the same body group never re-fold the ledger. `readBodySessionFacts`
 * is the single-id wrapper: it keeps the exact per-request behavior.
 */
export function createBodySessionFactsSource(session: BodySessionLike): BodySessionFactsSource {
  const log = readWiringLog(session)
  if (log === undefined) {
    const empty: BodySessionFacts = { ledger: undefined, messageText: undefined, inspection: undefined }
    return { factsOf: () => empty }
  }
  const events = log.events
  const surface = surfaceNodes(session)
  // Skipped log records stay diagnosable through the existing GET warning path.
  const logIssue = wiringLogIssueText(log.issues, log.strictFailure)
  const folds = new Map<string, FoldedBodyLedger>()
  const editSeqs = new Map<string, number | undefined>()
  const inspections = new Map<string, BodyAnchorInspection | undefined>()
  const facts = new Map<string, BodySessionFacts>()
  let messageTexts: Map<string, string | undefined> | undefined
  let operation: BodyOperationRead | undefined

  const fold = (groupId: string): BodyLedger | undefined => {
    const cached = folds.get(groupId)
    if (cached !== undefined) {
      if (cached.error !== undefined) throw cached.error
      return cached.ledger
    }
    try {
      const ledger = foldBodyLedgerFromEvents(events, groupId)
      folds.set(groupId, { ledger })
      return ledger
    } catch (error) {
      folds.set(groupId, { ledger: undefined, error })
      throw error
    }
  }

  const messageTextOf = (messageId: string): string | undefined => {
    if (messageTexts === undefined) {
      // One pass builds every message text; the first event wins, matching the
      // previous `events.find` lookup.
      const built = new Map<string, string | undefined>()
      for (const event of events) {
        const id = messageIdOf(event)
        if (id === undefined || built.has(id)) continue
        const message = messageOf(event)
        built.set(id, message === undefined ? undefined : textOfMessage(message))
      }
      messageTexts = built
    }
    return messageTexts.get(messageId)
  }

  const inspectionOf = (anchorMessageId: string): BodyAnchorInspection | undefined => {
    if (surface === undefined) return undefined
    if (!inspections.has(anchorMessageId)) {
      inspections.set(anchorMessageId, inspectAnchorInEvents(events, surface, anchorMessageId))
    }
    return inspections.get(anchorMessageId)
  }

  const latestEditSeqOf = (groupId: string): number | undefined => {
    if (!editSeqs.has(groupId)) editSeqs.set(groupId, latestGroupEditSeq(events, groupId))
    return editSeqs.get(groupId)
  }

  const operationOf = (): BodyOperationRead => {
    if (operation !== undefined) return operation
    try {
      const value = latestBodyOperation(events)
      operation = value === undefined ? {} : { value }
    } catch (error) {
      // A damaged terminal record must not turn the read route into a 500: the
      // display keeps the stable body and the route logs the fold failure.
      operation = { error: errorMessage(error) }
    }
    return operation
  }

  const factsOf = (messageId: string, groupHint: string | undefined): BodySessionFacts => {
    // The length prefix keeps the `\u0000` pair injective: without it the ids
    // ('a\u0000b', undefined) and ('a', 'b') would share one memo key.
    const key = `${messageId.length}\u0000${messageId}\u0000${groupHint ?? ''}`
    const cached = facts.get(key)
    if (cached !== undefined) return cached

    let ledger: BodyLedger | undefined
    let ledgerError = logIssue
    try {
      // A missing body record makes any folded slot list a guess; keep the read
      // side on the stable body and let the logged code explain the damage.
      if (log.strictFailure === undefined) {
        ledger = groupHint === undefined ? undefined : fold(groupHint)
        if (ledger === undefined) ledger = findBodyLedgerForMessage(events, messageId, fold)
      }
    } catch (error) {
      ledger = undefined
      ledgerError = ledgerError ?? errorMessage(error)
    }

    const terminal = operationOf()
    if (terminal.error !== undefined) ledgerError = ledgerError ?? terminal.error
    const anchorMessageId = ledger?.anchorMessageId ?? messageId
    const latestEditSeq = ledger === undefined ? undefined : latestEditSeqOf(ledger.groupId)
    const resolved: BodySessionFacts = {
      ledger,
      messageText: messageTextOf(messageId),
      inspection: inspectionOf(anchorMessageId),
      ...(latestEditSeq === undefined ? {} : { latestEditSeq }),
      ...(terminal.value === undefined ? {} : { lastOperation: terminal.value }),
      ...(ledgerError === undefined ? {} : { ledgerError }),
    }
    facts.set(key, resolved)
    return resolved
  }

  return { factsOf }
}

/**
 * Read everything `GET body` needs from one session log.
 *
 * A projected JSONL floor supplies `groupHint`; cold sessions fall back to a
 * scan over the groups named in the log. Ledger failures stay local to this
 * lookup (stable empty body) instead of turning the display route into a 500.
 */
export function readBodySessionFacts(
  session: BodySessionLike,
  messageId: string,
  groupHint: string | undefined,
): BodySessionFacts {
  return createBodySessionFactsSource(session).factsOf(messageId, groupHint)
}

/** Highest durable `edit` sequence for one body group. */
function latestGroupEditSeq(events: readonly WiringEvent[], groupId: string): number | undefined {
  let latest: number | undefined
  for (const event of events) {
    if (event.type !== BODY_EVENT_TYPE) continue
    if (event.data['op'] !== 'edit') continue
    if (event.data['groupId'] !== groupId) continue
    if (latest === undefined || event.seq > latest) latest = event.seq
  }
  return latest
}

/* --------------------------- operation read side --------------------------- */

/**
 * Fold the latest non-successful terminal record of a body operation.
 *
 * Only records that describe an operation which did not end in a settled body
 * are folded: `op-abort` (the previous body was restored), `op-settle-cancelled`
 * (the hide failed before the restore) and `op-finish` with `result: 'failed'`.
 * Events are seq-ordered, so the last match wins. Records are validated
 * strictly; a damaged record throws instead of presenting the operation as
 * successful, and the caller degrades to the stable body.
 */
function latestBodyOperation(events: readonly WiringEvent[]): BodyLastOperation | undefined {
  let latest: BodyLastOperation | undefined
  for (const event of events) {
    const record = bodyOperationRecord(event)
    if (record !== undefined) latest = record
  }
  return latest
}

function bodyOperationRecord(event: WiringEvent): BodyLastOperation | undefined {
  if (event.type === BODY_ABORT_EVENT_TYPE) return abortedOperationRecord(event)
  if (event.type === BODY_SETTLED_EVENT_TYPE && event.data['op'] === 'op-settle-cancelled') {
    return {
      opId: requiredOperationString(event, 'opId'),
      status: 'cancelled',
      reason: requiredOperationString(event, 'reason'),
      ...operationTimeOf(event),
    }
  }
  if (event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-finish' && event.data['result'] === 'failed') {
    return {
      opId: requiredOperationString(event, 'opId'),
      status: 'failed',
      reason: requiredOperationString(event, 'reason'),
      ...operationTimeOf(event),
    }
  }
  return undefined
}

function abortedOperationRecord(event: WiringEvent): BodyLastOperation {
  const op = event.data['op']
  if (op !== 'op-abort') {
    throw new Error(`body abort record at seq ${event.seq} has op '${String(op)}', expected 'op-abort'`)
  }
  const anchorId = event.data['anchorId']
  if (anchorId !== undefined && nonEmptyString(anchorId) === undefined) {
    throw new Error(`body abort record at seq ${event.seq} requires anchorId to be a non-empty string when present`)
  }
  return {
    opId: requiredOperationString(event, 'opId'),
    status: 'aborted',
    reason: requiredOperationString(event, 'reason'),
    ...operationTimeOf(event),
  }
}

function requiredOperationString(event: WiringEvent, field: string): string {
  const value = nonEmptyString(event.data[field])
  if (value === undefined) {
    throw new Error(`body operation record at seq ${event.seq} requires ${field} to be a non-empty string`)
  }
  return value
}

function operationTimeOf(event: WiringEvent): { readonly at?: number } {
  return event.time === undefined ? {} : { at: event.time }
}

/**
 * Find the body ledger that owns one native message id.
 *
 * `GET body` knows only the assistant message id, not the group id. A projected
 * JSONL floor supplies it when available; this scan covers cold or not-yet
 * projected sessions by trying every group named in the log, then the message
 * id itself (a fresh group's id is its first assistant message id).
 */
export function foldSessionBodyLedgerForMessage(
  session: BodySessionLike,
  messageId: string,
): BodyLedger | undefined {
  const events = wiringEvents(session)
  if (events === undefined) return undefined
  return findBodyLedgerForMessage(events, messageId, (groupId) => foldBodyLedgerFromEvents(events, groupId))
}

function findBodyLedgerForMessage(
  events: readonly WiringEvent[],
  messageId: string,
  fold: (groupId: string) => BodyLedger | undefined,
): BodyLedger | undefined {
  // The group id of a fresh body is its first anchor message id.
  const direct = fold(messageId)
  if (direct !== undefined && ownsMessage(direct, messageId)) return direct

  // Candidate events carry their group id, so one pass avoids folding every
  // group in a long session (the GET fast path is the floor hint; this covers
  // the window where a candidate switch has not reached the floor yet).
  let owner: string | undefined
  for (const event of events) {
    if (event.type !== BODY_EVENT_TYPE) continue
    if (event.data['messageId'] !== messageId) continue
    const groupId = nonEmptyString(event.data['groupId'])
    if (groupId !== undefined) {
      owner = groupId
      break
    }
  }
  if (owner !== undefined && owner !== messageId) {
    const ledger = fold(owner)
    if (ledger !== undefined && ownsMessage(ledger, messageId)) return ledger
  }

  // Legacy or hand-written logs without candidate message ids: try every group.
  const groupIds = new Set<string>()
  for (const event of events) {
    if (event.type !== BODY_EVENT_TYPE) continue
    const groupId = nonEmptyString(event.data['groupId'])
    if (groupId !== undefined) groupIds.add(groupId)
  }
  for (const groupId of groupIds) {
    const ledger = fold(groupId)
    if (ledger !== undefined && ownsMessage(ledger, messageId)) return ledger
  }
  return undefined
}

function ownsMessage(ledger: BodyLedger, messageId: string): boolean {
  return ledger.anchorMessageId === messageId
    || ledger.candidates.some((entry) => entry.messageId === messageId)
}

/** Text of one session message (`user/message` or `data.message` shapes). */
export function messageTextOfSession(session: BodySessionLike, messageId: string): string | undefined {
  const events = wiringEvents(session)
  if (events === undefined) return undefined
  return textOfSessionMessage(events, messageId)
}

function textOfSessionMessage(events: readonly WiringEvent[], messageId: string): string | undefined {
  const event = events.find((entry) => messageIdOf(entry) === messageId)
  if (event === undefined) return undefined
  const message = messageOf(event)
  return message === undefined ? undefined : textOfMessage(message)
}

/** Surface position and last-body check for one anchor message id. */
export function inspectBodyAnchor(
  session: BodySessionLike,
  anchorMessageId: string,
): BodyAnchorInspection | undefined {
  const events = wiringEvents(session)
  const surface = surfaceNodes(session)
  if (events === undefined || surface === undefined) return undefined
  return inspectAnchorInEvents(events, surface, anchorMessageId)
}

function inspectAnchorInEvents(
  events: readonly WiringEvent[],
  surface: readonly number[],
  anchorMessageId: string,
): BodyAnchorInspection {
  const anchorIndex = surface.findIndex((seq) => {
    const event = eventAt(events, seq)
    return event !== undefined && messageIdOf(event) === anchorMessageId
  })
  if (anchorIndex < 0) return { onSurface: false, last: false }

  for (const seq of surface.slice(anchorIndex + 1)) {
    const event = eventAt(events, seq)
    if (event === undefined) return { onSurface: true, last: false }
    if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'tool/result') continue
    const message = messageOf(event)
    if (message === undefined) continue
    if (event.type === 'user/message') {
      if (sourceOf(message)?.kind === 'user') return { onSurface: true, last: false }
      continue
    }
    if (event.type === 'assistant/message' && textOfMessage(message).trim() !== '' && !hasToolCall(message)) {
      return { onSurface: true, last: false }
    }
  }
  return { onSurface: true, last: true }
}

/* -------------------------------- agents ---------------------------------- */

// Live-agent and binding resolution lives in `body-session-agents.ts`; it is
// re-exported here so existing importers keep this module as the entry point.
export {
  bodyAgentOf,
  bodyBindingEligible,
  listLiveAgents,
  resolveBodyBinding,
  resolveLiveAgent,
} from './body-session-agents.js'

/* -------------------------------- helpers --------------------------------- */

function contentOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message['content']
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => isRecord(block))
}

function sourceOf(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = message['source']
  return isRecord(source) ? source : undefined
}

function foldBodyLedgerFromEvents(events: readonly WiringEvent[], groupId: string): BodyLedger | undefined {
  const last = events[events.length - 1]
  if (last === undefined) return undefined
  const bodyEvents: BodySessionEvent[] = events.map((event) => ({
    seq: event.seq,
    type: event.type,
    // The ledger validates every body payload it reads and ignores unrelated
    // events; the session log itself is JSON by host contract.
    data: event.data as unknown as BodySessionEvent['data'],
  }))
  return foldBodyLedger(bodyEvents, groupId, last.seq)
}
