/**
 * Shared AgentTavern body session reads and host-shape helpers.
 *
 * This shard owns the read-only side used by both the `GET body` view and
 * startup recovery: structural event parsing, body-ledger folds, message text,
 * anchor-surface inspection, binding/agent resolution and safe logging. It
 * never writes to the session and never owns projection or mutation logic.
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
  foldBodyLedger,
  type BodyLedger,
  type BodySessionEvent,
} from './body.js'
import type { BodyAgentLike, BodySessionLike } from './body-runtime.js'

/* ------------------------------- binding ---------------------------------- */

/** Persistent binding slice needed to decide whether body operations apply. */
export interface BodyBindingView {
  readonly architecture: string
  readonly character?: string
  readonly chatId?: string
  readonly group?: boolean
}

/** Resolves one session id to its Tavern binding (state is owned by the store). */
export type BodyBindingResolver = (
  sessionId: string,
) => BodyBindingView | undefined | Promise<BodyBindingView | undefined>

/** Structural host slices accepted by the session helpers. */
export interface BodyLogHost {
  readonly logger?: HostLogger
}

export interface BodyBindingHost extends BodyLogHost {
  readonly bindingOf?: BodyBindingResolver
}

export interface BodyAgentsHost extends BodyLogHost {
  readonly agents?: HostAgentsService
}

/* ------------------------------ logging ----------------------------------- */

export function warn(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.warn?.(message, fields)
  } catch {
    // Logging must never mask the body failure it reports.
  }
}

export function info(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.info?.(message, fields)
  } catch {
    // Same as warn.
  }
}

export function errorLog(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.error?.(message, fields)
  } catch {
    // Same as warn.
  }
}

export function failureCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const code = error['code']
  return typeof code === 'string' && code !== '' ? code : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

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
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

export function wiringEvents(session: BodySessionLike): WiringEvent[] | undefined {
  const values = readSessionEvents(session as HostSessionLog)
  if (values === undefined) return undefined
  const events: WiringEvent[] = []
  for (const value of values) {
    if (!isRecord(value)) return undefined
    const type = value['type']
    const seq = value['seq']
    const data = value['data']
    if (typeof type !== 'string' || !isSeq(seq) || !isRecord(data)) return undefined
    events.push({ type, seq, data })
  }
  events.sort((left, right) => left.seq - right.seq)
  return events
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
  /** Present when folding failed; the display route logs it and stays stable. */
  readonly ledgerError?: string
}

/** Whether the anchor is still the last body on the current surface. */
export interface BodyAnchorInspection {
  readonly onSurface: boolean
  readonly last: boolean
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
  const events = wiringEvents(session)
  if (events === undefined) {
    return { ledger: undefined, messageText: undefined, inspection: undefined }
  }

  let ledger: BodyLedger | undefined
  let ledgerError: string | undefined
  try {
    ledger = groupHint === undefined ? undefined : foldBodyLedgerFromEvents(events, groupHint)
    if (ledger === undefined) ledger = findBodyLedgerForMessage(events, messageId)
  } catch (error) {
    ledger = undefined
    ledgerError = errorMessage(error)
  }

  const messageText = textOfSessionMessage(events, messageId)
  const surface = surfaceNodes(session)
  const anchorMessageId = ledger?.anchorMessageId ?? messageId
  const inspection = surface === undefined
    ? undefined
    : inspectAnchorInEvents(events, surface, anchorMessageId)
  const latestEditSeq = ledger === undefined ? undefined : latestGroupEditSeq(events, ledger.groupId)
  return {
    ledger,
    messageText,
    inspection,
    ...(latestEditSeq === undefined ? {} : { latestEditSeq }),
    ...(ledgerError === undefined ? {} : { ledgerError }),
  }
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
  return findBodyLedgerForMessage(events, messageId)
}

function findBodyLedgerForMessage(events: readonly WiringEvent[], messageId: string): BodyLedger | undefined {
  // The group id of a fresh body is its first anchor message id.
  const direct = foldBodyLedgerFromEvents(events, messageId)
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
    const ledger = foldBodyLedgerFromEvents(events, owner)
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
    const ledger = foldBodyLedgerFromEvents(events, groupId)
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

/** Narrow one host value to the live-agent surface the body runtime needs. */
export function bodyAgentOf(value: unknown): BodyAgentLike | undefined {
  if (!isRecord(value)) return undefined
  const session = value['session']
  if (!isBodySession(session)) return undefined
  if (typeof value['followup'] !== 'function') return undefined
  return value as unknown as BodyAgentLike
}

/** Resolve a live agent from `ctx.agents.get`. */
export function resolveLiveAgent(ctx: BodyAgentsHost, sessionId: string): BodyAgentLike | undefined {
  const agents = ctx.agents
  const get = agents?.get
  if (agents === undefined || typeof get !== 'function') return undefined
  try {
    return bodyAgentOf(get.call(agents, sessionId))
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: agents.get failed', { sessionId, error: errorMessage(error) })
    return undefined
  }
}

/** All live agents the host exposes; empty on hosts without `agents.list`. */
export function listLiveAgents(ctx: BodyAgentsHost): readonly BodyAgentLike[] {
  const agents = ctx.agents
  const list = agents?.list
  if (agents === undefined || typeof list !== 'function') return []
  let values: unknown
  try {
    values = list.call(agents)
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: agents.list failed', { error: errorMessage(error) })
    return []
  }
  if (!Array.isArray(values)) return []
  const agentsOut: BodyAgentLike[] = []
  for (const value of values) {
    const agent = bodyAgentOf(value)
    if (agent !== undefined) agentsOut.push(agent)
  }
  return agentsOut
}

/** Resolve one session's Tavern binding through the injected resolver. */
export async function resolveBodyBinding(
  ctx: BodyBindingHost,
  sessionId: string,
): Promise<BodyBindingView | undefined> {
  const bindingOf = ctx.bindingOf
  if (typeof bindingOf !== 'function') {
    warn(ctx, 'dsh-soulmojito body: no binding resolver is wired; body operations disabled', {
      reason: 'architecture-mismatch',
      sessionId,
    })
    return undefined
  }
  try {
    return await bindingOf(sessionId)
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: binding lookup failed', { sessionId, error: errorMessage(error) })
    return undefined
  }
}

/** Only AgentTavern single-character sessions own body operations. */
export function bodyBindingEligible(binding: BodyBindingView | undefined): boolean {
  return binding !== undefined && binding.architecture === 'agent-tavern' && binding.group !== true
}

/* -------------------------------- helpers --------------------------------- */

function isBodySession(value: unknown): value is BodySessionLike {
  if (!isRecord(value)) return false
  return typeof value['append'] === 'function'
}

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
