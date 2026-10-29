/**
 * Body ledger state, candidate seeding and surface-hiding helpers.
 *
 * The functions here read the shared body ledger, validate the current body
 * target, and append the empty developer replacements that remove stale nodes
 * from the model surface. They never start or settle an operation themselves.
 */

import { randomUUID } from 'node:crypto'
import { hostPluginMessageSource, hostSessionFormatVersion } from '../../../bind/src/index.js'
import { advanceHostTurnBase, lastLoggedTurn } from '../session/trace.js'
import {
  effectiveBodyText,
  foldBodyLedger,
  type BodyLedger,
  type BodySessionEvent,
} from './body.js'
import {
  BODY_WRITE_TOOL_DENY,
  appendBodyEvent,
  bodyRuntimeError,
  errorMessage,
  failureFor,
  once,
  warn,
  type ActiveBodyOperation,
  type BodyRuntimeDeps,
  type BodyRuntimeState,
} from './body-runtime-core.js'
import {
  contentOf,
  eventAtSeq,
  eventsOf,
  findEventByMessageId,
  findSurfaceSeqByMessageId,
  hasToolCall,
  isPlainRecord,
  messageIdOf,
  messageOf,
  numberField,
  openTurnNumber,
  sourceOf,
  stepState,
  surfaceNodeList,
  textOfMessage,
  type RuntimeEvent,
} from './body-runtime-session.js'

export interface SurfaceRange {
  startSeq: number
  endSeq: number
  sourceEventSeqs: number[]
}

export function anchorTarget(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  anchorMessageId: string,
): { event: RuntimeEvent; message: Record<string, unknown>; seq: number } {
  const event = findEventByMessageId(events, anchorMessageId)
  if (event === undefined) {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor message '${anchorMessageId}' is not in the session log`)
  }
  if (event.type !== 'assistant/message') {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor '${anchorMessageId}' is '${event.type}', expected assistant/message`)
  }
  const message = messageOf(event)
  if (message === undefined) {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor '${anchorMessageId}' has no message payload`)
  }
  if (textOfMessage(message).trim() === '') {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor '${anchorMessageId}' has no body text`)
  }
  if (hasToolCall(message)) {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor '${anchorMessageId}' is a tool-call message, not a body`)
  }
  const seq = surface.find((node) => messageIdOf(eventAtSeq(events, node)) === anchorMessageId)
  if (seq === undefined) {
    throw bodyRuntimeError('body-compacted', `body operation rejected: anchor '${anchorMessageId}' is no longer on the current surface`)
  }
  return { event, message, seq }
}

export function assertLastBodyTarget(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  anchorSeq: number,
  anchorMessage: Record<string, unknown>,
): void {
  const anchorIndex = surface.indexOf(anchorSeq)
  if (anchorIndex < 0) {
    throw bodyRuntimeError('body-compacted', `body operation rejected: anchor at seq ${anchorSeq} is no longer on the current surface`)
  }
  if (textOfMessage(anchorMessage).trim() === '') {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: anchor at seq ${anchorSeq} has no body text`)
  }
  for (const seq of surface.slice(anchorIndex + 1)) {
    const event = eventAtSeq(events, seq)
    if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'tool/result') continue
    const message = messageOf(event)
    if (message === undefined) continue
    if (event.type === 'user/message') {
      if (sourceOf(message)?.kind === 'user') {
        throw bodyRuntimeError('not-last-round', `body operation rejected: a real user message at seq ${seq} follows anchor at seq ${anchorSeq}`)
      }
      continue
    }
    if (event.type === 'assistant/message' && textOfMessage(message).trim() !== '' && !hasToolCall(message)) {
      throw bodyRuntimeError('not-last-round', `body operation rejected: assistant body at seq ${seq} follows anchor at seq ${anchorSeq}`)
    }
  }
}

/**
 * Fold body events through the shared body ledger. `undefined` means the group
 * has no candidate yet; callers then seed candidate 0 for the current anchor.
 */
export function bodyLedger(events: readonly RuntimeEvent[], groupId: string): BodyLedger | undefined {
  if (events.length === 0) return undefined
  const lastSeq = events[events.length - 1]!.seq
  const bodyEvents: BodySessionEvent[] = events.map((event) => ({
    seq: event.seq,
    type: event.type,
    // The compiler cannot know session data is JSON; the ledger validates
    // every body payload it reads and ignores unrelated events.
    data: event.data as unknown as BodySessionEvent['data'],
  }))
  return foldBodyLedger(bodyEvents, groupId, lastSeq)
}

export function ledgerForRegenerate(
  events: readonly RuntimeEvent[],
  groupId: string,
  expectedAnchorId: string,
  expectedIndex: number,
): BodyLedger | undefined {
  const ledger = bodyLedger(events, groupId)
  if (ledger === undefined) {
    if (expectedIndex !== 0) {
      throw bodyRuntimeError('stale-anchor', `body regenerate rejected: unscoped group '${groupId}' starts at index 0, expected ${expectedIndex}`)
    }
    assertFreshGroup(events, groupId, expectedAnchorId)
    return undefined
  }
  if (ledger.anchorMessageId !== expectedAnchorId) {
    throw bodyRuntimeError(
      'stale-anchor',
      `body regenerate rejected: group '${groupId}' anchor is '${ledger.anchorMessageId}', expected '${expectedAnchorId}'`,
    )
  }
  if (ledger.selectedIndex !== expectedIndex) {
    throw bodyRuntimeError(
      'stale-anchor',
      `body regenerate rejected: group '${groupId}' selected index is ${ledger.selectedIndex}, expected ${expectedIndex}`,
    )
  }
  return ledger
}

/**
 * Resolve the ledger for edit/select and seed candidate 0 for an untouched
 * floor. The seed keeps the shared ledger dense and gives the JSONL projector
 * the original reply as swipe slot 0.
 */
export function ensureBodyLedger(
  deps: BodyRuntimeDeps,
  groupId: string,
  expectedAnchorId: string,
): { ledger: BodyLedger; events: RuntimeEvent[] } {
  const events = eventsOf(deps.session)
  const existing = bodyLedger(events, groupId)
  if (existing !== undefined) {
    if (existing.anchorMessageId !== expectedAnchorId) {
      throw bodyRuntimeError(
        'stale-anchor',
        `body operation rejected: group '${groupId}' anchor is '${existing.anchorMessageId}', expected '${expectedAnchorId}'`,
      )
    }
    return { ledger: existing, events }
  }
  assertFreshGroup(events, groupId, expectedAnchorId)
  appendBodyEvent(deps, { op: 'candidate', groupId, messageId: expectedAnchorId, index: 0 })
  const after = eventsOf(deps.session)
  const seeded = bodyLedger(after, groupId)
  if (seeded === undefined) {
    throw bodyRuntimeError('host-unsupported', `body runtime: seeded candidate 0 for group '${groupId}' but the body ledger stayed empty`)
  }
  return { ledger: seeded, events: after }
}

function assertFreshGroup(events: readonly RuntimeEvent[], groupId: string, anchorMessageId: string): void {
  if (groupId === anchorMessageId) return
  const anchor = findEventByMessageId(events, anchorMessageId)
  if (anchor === undefined) return
  const turn = numberField(anchor.data.turn)
  if (turn === undefined) {
    throw bodyRuntimeError(
      'stale-anchor',
      `body operation rejected: group '${groupId}' does not match anchor '${anchorMessageId}' and the anchor has no turn`,
    )
  }
  const first = events.find((event) => event.type === 'assistant/message' && numberField(event.data.turn) === turn)
  if (first === undefined || messageIdOf(first) !== groupId) {
    throw bodyRuntimeError(
      'stale-anchor',
      `body operation rejected: group '${groupId}' is not the first assistant message of anchor turn ${turn}`,
    )
  }
}

export function requireCandidate(ledger: BodyLedger, index: number): BodyLedger['candidates'][number] {
  const candidate = ledger.candidates[index]
  if (candidate === undefined) {
    throw bodyRuntimeError(
      'stale-anchor',
      `body operation rejected: group '${ledger.groupId}' has no candidate index ${index}; count ${ledger.candidates.length}`,
    )
  }
  return candidate
}

export function candidateText(ledger: BodyLedger, index: number): string {
  const edited = ledger.edits.get(index)
  if (edited !== undefined) return edited
  return requireCandidate(ledger, index).text
}

export function stateFromLedger(ledger: BodyLedger): BodyRuntimeState {
  const text = effectiveBodyText(ledger)
  if (text === undefined) {
    throw bodyRuntimeError('stale-anchor', `body operation rejected: group '${ledger.groupId}' has no selected candidate text`)
  }
  return {
    groupId: ledger.groupId,
    anchorMessageId: ledger.anchorMessageId,
    selectedIndex: ledger.selectedIndex,
    count: ledger.candidates.length,
    text,
    candidates: ledger.candidates.map((candidate) => ({
      messageId: candidate.messageId,
      index: candidate.index,
      ...(candidate.feedback === undefined ? {} : { feedback: candidate.feedback }),
    })),
  }
}

export function appendHideInBridgeTurn(deps: BodyRuntimeDeps, targets: ReadonlySet<number> | readonly number[]): void {
  const ranges = surfaceRanges(surfaceNodeList(deps.session), targets)
  if (ranges.length === 0) return
  const events = eventsOf(deps.session)
  const openTurn = openTurnNumber(events)
  if (openTurn !== undefined) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body runtime: cannot hide body nodes while turn ${openTurn} is open; expected an idle closed-turn state`,
    )
  }

  const turn = (lastLoggedTurn(deps.agent) ?? 0) + 1
  let turnOpen = false
  let stepOpen = false
  try {
    deps.session.append('turn/start', { turn })
    turnOpen = true
    deps.session.append('step/start', { turn, step: 1 })
    stepOpen = true
    for (const range of [...ranges].reverse()) appendDeveloperHide(deps, turn, 1, range)
    deps.session.append('step/end', { turn, step: 1 })
    stepOpen = false
    deps.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  } catch (error) {
    closeBracketBestEffort(deps, turn, 1, turnOpen, stepOpen, `body hide bridge turn ${turn} failed`)
    throw error
  }

  if (!advanceHostTurnBase(deps.agent, turn)) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body runtime: bridge turn ${turn} is logged but the live loop turn base could not advance`,
    )
  }
}

export function appendHideInOpenTurn(deps: BodyRuntimeDeps, turn: number, targets: ReadonlySet<number>): void {
  const ranges = surfaceRanges(surfaceNodeList(deps.session), targets)
  if (ranges.length === 0) return
  const events = eventsOf(deps.session)
  const openTurn = openTurnNumber(events)
  if (openTurn !== turn) {
    throw bodyRuntimeError(
      'host-unsupported',
      `body runtime: cannot hide settle nodes for turn ${turn} while open turn is ${String(openTurn)}`,
    )
  }
  const state = stepState(events, turn)
  const ownsStep = state.openStep === undefined
  const step = state.openStep ?? state.nextStep
  if (ownsStep) deps.session.append('step/start', { turn, step })

  let failure: unknown
  try {
    for (const range of [...ranges].reverse()) appendDeveloperHide(deps, turn, step, range)
  } catch (error) {
    failure = error
  }

  if (ownsStep) {
    try {
      deps.session.append('step/end', { turn, step })
      alignHostStepBase(deps, step)
    } catch (closeError) {
      if (failure === undefined) failure = closeError
      else failure = new AggregateError([failure, closeError], `body runtime: failed to hide nodes and close step ${step} of turn ${turn}`)
    }
  }
  if (failure !== undefined) throw failure
}

/**
 * The host loop keeps its own `phase.step` counter and, when steering continues
 * the turn after `agent/turn-stopping`, computes its next step from that
 * counter. Hiding nodes opens and closes one extra empty step, so align the
 * counter the same way `advanceHostTurnBase` aligns `phase.lastTurn`: only when
 * the field exists and is writable. Missing field means the host does not
 * expose the counter; a failed write is logged instead of silently ignored.
 */
function alignHostStepBase(deps: BodyRuntimeDeps, step: number): void {
  const phase = deps.agent.phase
  if (!isPlainRecord(phase)) return
  const current = phase.step
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) return
  if (current >= step) return
  try {
    phase.step = step
  } catch (error) {
    warn(deps, `body runtime: could not advance the live loop step base to ${step}: ${errorMessage(error)}`)
    return
  }
  if (phase.step !== step) {
    warn(deps, `body runtime: the live loop step base did not accept ${step}`)
  }
}

export function surfaceRanges(surface: readonly number[], targets: ReadonlySet<number> | readonly number[]): SurfaceRange[] {
  const wanted = targets instanceof Set ? targets : new Set(targets)
  const ranges: SurfaceRange[] = []
  let start = -1
  for (let index = 0; index <= surface.length; index += 1) {
    const seq = surface[index]
    const hit = seq !== undefined && wanted.has(seq)
    if (hit && start < 0) start = index
    if (!hit && start >= 0) {
      const sources = surface.slice(start, index)
      const startSeq = sources[0]
      const endSeq = sources[sources.length - 1]
      if (startSeq === undefined || endSeq === undefined) {
        throw bodyRuntimeError('invalid-event', 'body runtime: empty surface replacement range')
      }
      ranges.push({ startSeq, endSeq, sourceEventSeqs: sources })
      start = -1
    }
  }
  return ranges
}

export function appendDeveloperHide(deps: BodyRuntimeDeps, turn: number, step: number, range: SurfaceRange): void {
  deps.session.append('developer/message', {
    turn,
    step,
    message: {
      id: `body-hide-${randomUUID()}`,
      role: 'developer',
      content: [],
      source: hostPluginMessageSource(deps.session, {
        form: 'body-hide',
        summary: `body hide ${range.startSeq}-${range.endSeq}`,
      }),
    },
  }, {
    surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
    sourceEventSeqs: range.sourceEventSeqs,
  })
}

/**
 * Surface nodes belonging to one body anchor and its turn: the anchor itself
 * plus every process node of that turn (tool calls, tool results, prior body
 * hide nodes and synthetic body triggers). Real user messages and system
 * prompts stay visible. The runtime uses this at successful settlement to
 * remove the previous body together with its turn's process nodes.
 */
export function oldBodyTargets(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  target: { event: RuntimeEvent; message: Record<string, unknown>; seq: number },
): Set<number> {
  const targets = new Set<number>([target.seq])
  const turn = numberField(target.event.data.turn)
  if (turn === undefined) return targets
  for (const seq of surface) {
    if (seq === target.seq) continue
    const event = eventAtSeq(events, seq)
    if (event.type === 'system/message') continue
    const message = messageOf(event)
    if (event.type === 'user/message') {
      const form = message === undefined ? undefined : sourceOf(message)?.form
      if (form === 'body-regenerate' || form === 'body-restore') targets.add(seq)
      continue
    }
    // An empty `body-hide` replacement is bookkeeping from an earlier hide;
    // targeting it again would append noise and can invert a surface range
    // (its seq is newer than the nodes that follow its insertion point).
    if (event.type === 'developer/message' && message !== undefined && sourceOf(message)?.form === 'body-hide') continue
    if (numberField(event.data.turn) === turn) targets.add(seq)
  }
  return targets
}

/**
 * Surface targets of the previous anchor, resolved by its message id at the
 * moment they are hidden.
 *
 * An empty set means the anchor already left the surface (a session written by
 * an older build that hid it when the operation started). Settlement then
 * leaves it hidden, and failure recovery takes the compatibility path instead
 * of the model-free one.
 */
export function oldAnchorSurfaceTargets(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  previousAnchorId: string,
): Set<number> {
  const seq = findSurfaceSeqByMessageId(events, surface, previousAnchorId)
  if (seq === undefined) return new Set<number>()
  const event = findEventByMessageId(events, previousAnchorId)
  if (event === undefined) return new Set<number>()
  const message = messageOf(event)
  if (message === undefined) return new Set<number>()
  return oldBodyTargets(events, surface, { event, message, seq })
}

/**
 * Remove the previous body anchor from the model surface before a regeneration
 * turn starts (proposal 0021 §6.2 step 4, revision 2026-10-29).
 *
 * A regeneration must not see the draft it replaces: keeping the anchor visible
 * made the model rewrite its own text and settle a near-copy. The old anchor
 * and its turn's process nodes therefore leave the surface here, while the
 * agent is idle. Surface replacements only append inside an open turn and step,
 * so this opens a bridge turn and advances the live loop turn base.
 *
 * Returns true when a replacement was written. A false result means the anchor
 * already left the surface (a legacy session or a resumed operation); callers
 * then keep their existing compatibility behaviour.
 */
export function hidePreviousAnchorBeforeRegenerate(deps: BodyRuntimeDeps, previousAnchorId: string): boolean {
  const events = eventsOf(deps.session)
  const surface = surfaceNodeList(deps.session)
  const targets = oldAnchorSurfaceTargets(events, surface, previousAnchorId)
  if (targets.size === 0) return false
  appendHideInBridgeTurn(deps, targets)
  return true
}

export function hideTargets(
  events: readonly RuntimeEvent[],
  surface: readonly number[],
  triggerMessageId: string,
  turn: number,
  candidateMessageId: string,
): Set<number> {
  const targets = new Set<number>()
  for (const seq of surface) {
    const event = eventAtSeq(events, seq)
    if (event.type === 'system/message') continue
    const message = messageOf(event)
    if (message !== undefined && messageIdOf(event) === candidateMessageId) continue
    if (event.type === 'user/message') {
      if (messageIdOf(event) === triggerMessageId) {
        targets.add(seq)
        continue
      }
      if (message !== undefined && sourceOf(message)?.kind === 'user') continue
      continue
    }
    if (numberField(event.data.turn) === turn) targets.add(seq)
  }
  return targets
}

export function restoreAssistantData(
  deps: BodyRuntimeDeps,
  turn: number,
  messageId: string,
  previousMessage: Record<string, unknown>,
  model: { provider: string; model: string },
): Record<string, unknown> {
  const blocks = contentOf(previousMessage)
    .filter((block) => block.type !== 'tool-call')
    .map((block) => structuredClone(block))
  if (blocks.length === 0 || textOfMessage(previousMessage).trim() === '') {
    throw bodyRuntimeError('restore-unavailable', `body restore turn ${turn} previous anchor has no copyable content`)
  }
  const version = hostSessionFormatVersion(deps.session)
  return {
    turn,
    step: 1,
    message: {
      id: messageId,
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider: model.provider, model: model.model },
    },
    ...(version !== undefined && version >= 4 ? { stream: [] } : {}),
  }
}

export function applyWriteRestriction(deps: BodyRuntimeDeps, deny: readonly string[]): () => void {
  const tools = deps.agent.ctx?.tools
  const restrict = tools?.restrict
  if (typeof restrict !== 'function' || tools === undefined) return () => {}
  let disposer: unknown
  try {
    disposer = restrict.call(tools, { deny })
  } catch (error) {
    throw failureFor(error, `body runtime: tools.restrict({ deny }) failed for ${deny.join(', ')}`, undefined)
  }
  if (typeof disposer !== 'function') {
    throw bodyRuntimeError('host-unsupported', 'body runtime: tools.restrict({ deny }) did not return a disposer function')
  }
  const release = disposer as () => unknown
  return once(() => {
    release()
  })
}

export function normalizeDenyTools(values: readonly string[] | undefined): readonly string[] {
  const source = values ?? BODY_WRITE_TOOL_DENY
  const names = [...new Set(source.map((name) => name.trim()).filter((name) => name !== ''))]
  if (names.length === 0) {
    throw bodyRuntimeError('invalid-arguments', 'body regenerate rejected: writeToolDeny must contain at least one tool name')
  }
  return names
}

export function buildRegenerateTrigger(
  deps: BodyRuntimeDeps,
  op: ActiveBodyOperation,
  feedback: string | undefined,
): Record<string, unknown> {
  return {
    id: op.triggerMessageId,
    role: 'user',
    content: [{ type: 'text', text: regenerationInstruction(feedback) }],
    source: hostPluginMessageSource(deps.session, {
      form: 'body-regenerate',
      summary: `body regenerate ${op.opId}`,
      groupId: op.groupId,
      opId: op.opId,
    }),
  }
}

function regenerationInstruction(feedback: string | undefined): string {
  const base = 'Regenerate the final assistant reply for this scene. Continue from the prior visible context, write only the assistant body, and do not mention this instruction.'
  const note = feedback?.trim() ?? ''
  return note === '' ? base : `${base}\n\nRevision note from the user: ${note}`
}

export function closeBracketBestEffort(
  deps: BodyRuntimeDeps,
  turn: number,
  step: number,
  turnOpen: boolean,
  stepOpen: boolean,
  subject: string,
): void {
  let stepClosed = !stepOpen
  if (stepOpen) {
    try {
      deps.session.append('step/end', { turn, step })
      stepClosed = true
    } catch (error) {
      warn(deps, `body runtime: ${subject}: failed to close step of turn ${turn}: ${errorMessage(error)}`)
    }
  }
  if (turnOpen && stepClosed) {
    try {
      deps.session.append('turn/end', {
        turn,
        reason: { kind: 'error', error: { message: subject, code: 'BODY_RUNTIME' } },
      })
    } catch (error) {
      warn(deps, `body runtime: ${subject}: failed to close turn ${turn}: ${errorMessage(error)}`)
    }
  }
  if (turnOpen) {
    const advanced = advanceHostTurnBase(deps.agent, turn)
    if (!advanced) warn(deps, `body runtime: ${subject}: could not advance the live loop turn base to ${turn}`)
  }
}
