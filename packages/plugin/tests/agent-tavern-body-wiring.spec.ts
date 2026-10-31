/**
 * Body wiring regression (proposal 0021 §2.5, §6.1, §7.3, §9).
 *
 * These tests use fake host values only: the plugin-record seam is injected
 * through the bind package mock, the event bus is a captured listener, and no
 * real @deepseek-ai/dsh-session or Tavern store is opened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCardIR, ChatLogIR } from '../../tavern-format/src/index.js'
import type { TavernStore } from '../../tavern-store/src/index.js'
import { CandidateReceiptError } from '../src/agent-tavern/body-candidate-receipts.js'
import { BodyJsonlProjectionError } from '../src/agent-tavern/body-jsonl.js'
import { BodyLedgerError } from '../src/agent-tavern/body.js'
import { characterTools } from '../src/agent-tavern/tools/character.js'
import { deductionTools } from '../src/agent-tavern/tools/deduction.js'
import { gameTools } from '../src/agent-tavern/tools/games.js'
import { memoryTools } from '../src/agent-tavern/tools/memory.js'
import { scriptTools } from '../src/agent-tavern/tools/script.js'
import { variableTools } from '../src/agent-tavern/tools/variable.js'

const hostState = vi.hoisted(() => ({
  module: undefined as Record<string, unknown> | undefined,
}))

const rollbackState = vi.hoisted(() => ({
  store: undefined as unknown,
  memories: undefined as unknown,
  variables: undefined as unknown,
}))

vi.mock('../../bind/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../bind/src/index.js')>()
  return {
    ...actual,
    importHostPackage: async (name: string): Promise<unknown> => {
      if (name !== '@deepseek-ai/dsh-session') throw new Error(`unexpected host package import: ${name}`)
      if (hostState.module === undefined) throw new Error('@deepseek-ai/dsh-session is not installed')
      return hostState.module
    },
  }
})

vi.mock('../src/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime.js')>()
  return {
    ...actual,
    store: async (): Promise<unknown> => rollbackState.store,
    memories: async (): Promise<unknown> => rollbackState.memories,
    variables: async (): Promise<unknown> => rollbackState.variables,
  }
})

const { BODY_ABORT_EVENT_TYPE, BODY_EVENT_TYPE, bodyRuntimeError } = await import('../src/agent-tavern/body-runtime.js')
const {
  bodyFailureOf,
  bodyHistoricalMvuStateOf,
  bodyMutationSafetyOf,
  bodyRejectStatus,
  bodyStateSafetyOf,
  bodyStateUnsafeMessage,
  buildBodyView,
  createBodyDeps,
  handleBodySessionEvent,
  handleBodyTurnStopping,
  recoverBodyOperation,
  recoverBodyOperations,
  registerBodyProjection,
  registerBodyTurnStopping,
  resolveBodyRecordWriter,
} = await import('../src/agent-tavern/body-wiring.js')
const { pendingByAgent } = await import('../src/agent-tavern/body-runtime-core.js')
const { imBodyMutationDisabledOf } = await import('../src/agent-tavern/body-view.js')
const { createBodySessionFactsSource } = await import('../src/agent-tavern/body-session.js')
const { handleAgentTavernBodyApi } = await import('../src/http/router.js')
type BodyRuntimeModule = typeof import('../src/agent-tavern/body-runtime.js')
type BodyWiringModule = typeof import('../src/agent-tavern/body-wiring.js')
type BodyAgentLike = BodyRuntimeModule['BodyAgentLike']
type BodySessionLike = BodyRuntimeModule['BodySessionLike']
type BodyWiringContext = BodyWiringModule['BodyWiringContext']

interface CapturedLogger {
  readonly logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  readonly infos: unknown[][]
  readonly warnings: unknown[][]
  readonly errors: unknown[][]
}

function captureLogger(): CapturedLogger {
  const infos: unknown[][] = []
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  return {
    logger: {
      info: (...args: unknown[]) => { infos.push(args) },
      warn: (...args: unknown[]) => { warnings.push(args) },
      error: (...args: unknown[]) => { errors.push(args) },
    },
    infos,
    warnings,
    errors,
  }
}

function asTestRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function testNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * The host `appendPluginRecord(session, type, data)` seam is resolved once per
 * process and cached by the wiring module; delegating to a session method keeps
 * that cached writer usable by every fake session in this file.
 */
function delegatingAppendPluginRecord(session: unknown, type: string, data: unknown): unknown {
  const method = asTestRecord(session)?.['appendPluginRecord']
  return typeof method === 'function' ? method.call(session, type, data) : 0
}

function hostRecordModule(): Record<string, unknown> {
  return {
    appendPluginRecord: delegatingAppendPluginRecord,
    pluginRecordOf: () => undefined,
  }
}

interface RecoveryEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
  readonly opts?: Record<string, unknown>
}

interface RecoveryHarness {
  readonly session: BodySessionLike
  readonly agent: BodyAgentLike
  readonly events: RecoveryEvent[]
  readonly phase: { kind: string; lastTurn: number }
  surface(): number[]
  append(type: string, data: unknown, opts?: unknown): number
  appendRecord(type: string, data: unknown): number
}

/**
 * Minimal append-only session double for the recovery path: it models surface
 * nodes, plugin records without surface, and open turn/step bookkeeping, which
 * is what `finalizeRecoveredOperation` and `closeImportBracket` touch.
 */
function createRecoveryHarness(): RecoveryHarness {
  const events: RecoveryEvent[] = []
  const surfaceNodes: number[] = []
  const phase = { kind: 'idle', lastTurn: 0 }

  const applySurface = (seq: number, metadata: Record<string, unknown> | undefined): void => {
    const surfaceOp = metadata?.['surfaceOp']
    if (surfaceOp === 'append') {
      surfaceNodes.push(seq)
      return
    }
    if (typeof surfaceOp !== 'object' || surfaceOp === null) return
    const op = asTestRecord(surfaceOp)
    if (op?.['op'] !== 'replace') return
    const startSeq = testNumber(op['startSeq'])
    const endSeq = testNumber(op['endSeq'])
    if (startSeq === undefined || endSeq === undefined) throw new Error('fake recovery session: bad replace range')
    const startIndex = surfaceNodes.indexOf(startSeq)
    const endIndex = surfaceNodes.indexOf(endSeq)
    if (startIndex < 0 || endIndex < startIndex) throw new Error('fake recovery session: replace range is not on the surface')
    surfaceNodes.splice(startIndex, endIndex - startIndex + 1, seq)
  }

  const append = (type: string, data: unknown, opts?: unknown): number => {
    const record = asTestRecord(data) ?? {}
    const metadata = asTestRecord(opts)
    const seq = events.length
    events.push({ type, seq, data: record, ...(metadata === undefined ? {} : { opts: metadata }) })
    if (type === 'turn/end' || type === 'step/start' || type === 'step/end') return seq
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result' || type === 'system/message' || type === 'developer/message') {
      applySurface(seq, metadata)
    }
    return seq
  }

  const appendRecord = (type: string, data: unknown): number => {
    const seq = events.length
    events.push({ type, seq, data: asTestRecord(data) ?? {} })
    return seq
  }

  const session = {
    id: 'session-recovery',
    header: { version: 4 },
    events,
    get surface() { return { nodes: [...surfaceNodes] } },
    append,
    appendPluginRecord: appendRecord,
  } as unknown as BodySessionLike

  const agent: BodyAgentLike = {
    id: 'session-recovery',
    session,
    status: 'idle',
    phase,
    followup: () => undefined,
  }

  return {
    session,
    agent,
    events,
    phase,
    surface: () => [...surfaceNodes],
    append,
    appendRecord,
  }
}

/** One interrupted regenerate: closed anchor turn + open turn with trigger and candidate. */
function seedPendingRecovery(harness: RecoveryHarness): {
  triggerSeq: number
  processSeq: number
  candidateSeq: number
} {
  harness.append('turn/start', { turn: 1 })
  harness.append('step/start', { turn: 1, step: 1 })
  harness.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'anchor-1', role: 'assistant', content: [{ type: 'text', text: 'old body' }] },
  })
  harness.append('step/end', { turn: 1, step: 1 })
  harness.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  harness.appendRecord(BODY_EVENT_TYPE, {
    op: 'op-start',
    opId: 'op-rec-1',
    groupId: 'anchor-1',
    kind: 'regenerate',
    previousAnchorId: 'anchor-1',
    previousIndex: 0,
  })

  harness.append('turn/start', { turn: 2 })
  harness.append('step/start', { turn: 2, step: 1 })
  const triggerSeq = harness.append('user/message', {
    id: 'body-trigger-op-rec-1',
    role: 'user',
    content: [{ type: 'text', text: 'regenerate' }],
  }, { surfaceOp: 'append' })
  const processSeq = harness.append('tool/result', { turn: 2, step: 1, result: { ok: true } }, { surfaceOp: 'append' })
  const candidateSeq = harness.append('assistant/message', {
    turn: 2,
    step: 1,
    message: { id: 'candidate-1', role: 'assistant', content: [{ type: 'text', text: 'new body' }] },
  }, { surfaceOp: 'append' })
  harness.append('step/end', { turn: 2, step: 1 })
  return { triggerSeq, processSeq, candidateSeq }
}

/** One interrupted regenerate whose turn produced no candidate: the restore path. */
function seedPendingRecoveryWithoutCandidate(harness: RecoveryHarness): {
  anchorSeq: number
  triggerSeq: number
  processSeq: number
} {
  harness.append('turn/start', { turn: 1 })
  harness.append('step/start', { turn: 1, step: 1 })
  const anchorSeq = harness.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'anchor-1', role: 'assistant', content: [{ type: 'text', text: 'old body' }] },
  }, { surfaceOp: 'append' })
  harness.append('step/end', { turn: 1, step: 1 })
  harness.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  harness.appendRecord(BODY_EVENT_TYPE, {
    op: 'op-start',
    opId: 'op-rec-restore',
    groupId: 'anchor-1',
    kind: 'regenerate',
    previousAnchorId: 'anchor-1',
    previousIndex: 0,
  })

  harness.append('turn/start', { turn: 2 })
  harness.append('step/start', { turn: 2, step: 1 })
  const triggerSeq = harness.append('user/message', {
    id: 'body-trigger-op-rec-restore',
    role: 'user',
    content: [{ type: 'text', text: 'regenerate' }],
  }, { surfaceOp: 'append' })
  const processSeq = harness.append('tool/result', { turn: 2, step: 1, result: { ok: true } }, { surfaceOp: 'append' })
  harness.append('step/end', { turn: 2, step: 1 })
  return { anchorSeq, triggerSeq, processSeq }
}

function fakeSession(id: string, events: readonly unknown[] = []): BodySessionLike {
  return { id, header: { version: 4 }, events, append: () => 0 }
}

function fakeAgent(session: BodySessionLike, status: unknown = 'idle'): BodyAgentLike {
  return {
    id: session.id,
    session,
    status,
    phase: { kind: 'idle', lastTurn: 0 },
    followup: () => undefined,
  }
}

function wiringContext(logger: CapturedLogger['logger']): BodyWiringContext {
  return { logger }
}

function throwingSession(id: string): BodySessionLike {
  return {
    id,
    get events(): never {
      throw new Error(`body wiring test: ${id} event log must not be read`)
    },
    append: () => 0,
  } as unknown as BodySessionLike
}

function cardWithExtensions(extensions: Record<string, unknown>): CharacterCardIR {
  return {
    spec: 'chara_card_v2',
    specVersion: '2.0',
    data: { name: 'Character', extensions } as unknown as CharacterCardIR['data'],
    raw: {},
  }
}

function mvuCharacter(): CharacterCardIR {
  return cardWithExtensions({
    tavern_helper: { scripts: [{ content: "import { registerMvuSchema } from 'mvu_zod'" }] },
  })
}

function plainCharacter(): CharacterCardIR {
  return cardWithExtensions({})
}

function fakeChat(metadata: Record<string, unknown>): ChatLogIR {
  return {
    header: { user_name: 'user', character_name: 'character', chat_metadata: metadata },
    messages: [],
  }
}

function projectedChat(text: string): ChatLogIR {
  const chat = fakeChat({})
  chat.messages.push({
    name: 'character',
    is_user: false,
    is_system: false,
    send_date: '',
    mes: text,
    swipe_id: 0,
    swipes: [text],
    extra: {
      agentTavern: {
        messageId: 'message-1',
        anchorMessageId: 'message-1',
        bodyGroupId: 'message-1',
      },
    },
  })
  return chat
}

/**
 * Floor shape after the importer adoption: group-bound but without the
 * projected message id, so the display lookup keeps the stored text.
 */
function adoptedChat(groupId: string, text: string): ChatLogIR {
  const chat = fakeChat({})
  chat.messages.push({
    name: 'character',
    is_user: false,
    is_system: false,
    send_date: '',
    mes: text,
    swipe_id: 0,
    swipes: [text],
    extra: {
      agentTavern: {
        bodyGroupId: groupId,
        anchorMessageId: groupId,
        sessionId: 'session-recovery',
      },
    },
  })
  return chat
}

/** Candidate 0 floor plus the candidate-level MVU receipts a 0023 edit inspects. */
function projectedMvuChat(text: string, receipts: readonly Record<string, unknown>[]): ChatLogIR {
  const chat = projectedChat(text)
  chat.header.chat_metadata.mvu = { receipts: [...receipts] }
  return chat
}

/** Seed one closed anchor turn on the recovery harness used by route tests. */
function seedEditAnchor(harness: RecoveryHarness, messageId: string, text: string): void {
  harness.append('turn/start', { turn: 1 })
  harness.append('step/start', { turn: 1, step: 1 })
  harness.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] },
  }, { surfaceOp: 'append' })
  harness.append('step/end', { turn: 1, step: 1 })
  harness.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

function sessionWithAssistant(messageId: string, text: string): BodySessionLike {
  return {
    id: 'session-mvu',
    header: { version: 4 },
    events: [{
      type: 'assistant/message',
      seq: 0,
      data: { message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } },
    }],
    surface: { nodes: [0] },
    append: () => 0,
  }
}

/**
 * Live session carrying one projected body group.
 *
 * `indexes` seeds the candidate events in ledger order; a repeated message id
 * reproduces the duplicate-slot collision that the receipt key gate rejects.
 */
function bodySession(
  messageId: string,
  text: string,
  groupId: string,
  indexes: readonly number[],
): BodySessionLike {
  const events: RecoveryEvent[] = [{
    type: 'assistant/message',
    seq: 0,
    data: { message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } },
  }]
  for (const [position, index] of indexes.entries()) {
    events.push({
      type: BODY_EVENT_TYPE,
      seq: position + 1,
      data: { op: 'candidate', groupId, messageId, index },
    })
  }
  return {
    id: 'session-mvu',
    header: { version: 4 },
    events,
    surface: { nodes: [0] },
    append: () => 0,
  }
}

/**
 * One candidate plus one edit record; the chat floor carries whatever body-event
 * watermark the caller sets, so the read-side freshness check can be exercised.
 */
function editedBodySession(
  messageId: string,
  groupId: string,
  previousText: string,
  text: string,
): BodySessionLike {
  const session = bodySession(messageId, previousText, groupId, [0])
  const events = session.events as RecoveryEvent[]
  events.push({
    type: BODY_EVENT_TYPE,
    seq: events.length,
    data: { op: 'edit', groupId, index: 0, text, previousText },
  })
  return session
}

/** Mark (or withhold) the edit watermark on the single floor of {@link projectedChat}. */
function withEditWatermark(chat: ChatLogIR, seq: number | undefined): ChatLogIR {
  const floor = chat.messages[0]
  if (floor === undefined) throw new Error('test chat has no floor')
  const extra = floor.extra ?? {}
  const agentTavern = { ...(extra.agentTavern as Record<string, unknown> | undefined) }
  if (seq !== undefined) agentTavern.lastBodyEventSeq = seq
  floor.extra = { ...extra, agentTavern }
  return chat
}

async function callBodyGet(
  character: CharacterCardIR,
  chat: ChatLogIR,
  agent: BodyAgentLike,
  sessionId: string,
  messageId: string,
  logger?: CapturedLogger['logger'],
): Promise<{ status: number; body: Record<string, unknown> }> {
  return callBodyGetQuery(
    agent,
    sessionId,
    `messageId=${encodeURIComponent(messageId)}`,
    mutationDbFor(sessionId, character, chat),
    logger,
  )
}

/**
 * Call the body GET route with an explicit query tail, so a test can send the
 * batched `messageIds` form and the malformed combinations around it.
 */
async function callBodyGetQuery(
  agent: BodyAgentLike,
  sessionId: string,
  query: string,
  db: TavernStore,
  logger: CapturedLogger['logger'] | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  hostState.module = hostRecordModule()
  const res = makeResponse()
  const ctx = {
    agents: { get: (id: string) => id === sessionId ? agent : undefined },
    ...(logger === undefined ? {} : { logger }),
  } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
  const url = new URL(
    `/api/dsh-soulmojito/body?sessionId=${encodeURIComponent(sessionId)}&${query}`,
    'http://localhost',
  )
  await handleAgentTavernBodyApi(
    ctx,
    db,
    makeRequest(undefined, 'GET', `${url.pathname}${url.search}`),
    res,
    url,
    'body',
    'GET',
  )
  return {
    status: res.statusCode,
    body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : {},
  }
}

/**
 * Live session carrying several projected body groups: every candidate gets one
 * assistant message and one candidate record, so one batch can read rows that
 * belong to different groups.
 */
function groupedBodySession(
  groups: readonly {
    readonly groupId: string
    readonly candidates: readonly { readonly messageId: string; readonly text: string }[]
  }[],
): BodySessionLike {
  const events: RecoveryEvent[] = []
  const surface: number[] = []
  for (const group of groups) {
    for (const [index, candidate] of group.candidates.entries()) {
      events.push({
        type: 'assistant/message',
        seq: events.length,
        data: {
          message: {
            id: candidate.messageId,
            role: 'assistant',
            content: [{ type: 'text', text: candidate.text }],
          },
        },
      })
      surface.push(events.length - 1)
      events.push({
        type: BODY_EVENT_TYPE,
        seq: events.length,
        data: { op: 'candidate', groupId: group.groupId, messageId: candidate.messageId, index },
      })
    }
  }
  return {
    id: 'session-mvu',
    header: { version: 4 },
    events,
    surface: { nodes: surface },
    append: () => 0,
  }
}

/** Store wrapper counting reads, so a batch can prove it read the shared state once. */
function countingDbFor(
  sessionId: string,
  character: CharacterCardIR,
  chat: ChatLogIR,
): { readonly db: TavernStore; readonly counts: { snapshots: number; states: number } } {
  const base = mutationDbFor(sessionId, character, chat) as unknown as Record<string, unknown>
  const counts = { snapshots: 0, states: 0 }
  const db = {
    ...base,
    getState: async () => {
      counts.states += 1
      return (base.getState as () => Promise<unknown>)()
    },
    getChatSnapshot: async (characterName: string, chatId: string) => {
      counts.snapshots += 1
      return (base.getChatSnapshot as (name: string, id: string) => Promise<unknown>)(characterName, chatId)
    },
  } as unknown as TavernStore
  return { db, counts }
}

/** Session wrapper counting log parses; a batch must parse the session once. */
function countingSession(session: BodySessionLike): {
  readonly session: BodySessionLike
  readonly reads: { log: number }
} {
  const reads = { log: 0 }
  const counted = {
    ...session,
    events: undefined,
    snapshotEvents: () => {
      reads.log += 1
      return session.events
    },
  } as unknown as BodySessionLike
  return { session: counted, reads }
}

function makeRequest(body: unknown, method: string, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  } as unknown as Parameters<typeof handleAgentTavernBodyApi>[2]
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    headersSent: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response as unknown as Parameters<typeof handleAgentTavernBodyApi>[3] & { chunks: string[]; statusCode: number }
}

function mutationDb(character: CharacterCardIR, chat: ChatLogIR): TavernStore {
  return mutationDbFor('session-mvu', character, chat)
}

function mutationDbFor(sessionId: string, character: CharacterCardIR, chat: ChatLogIR): TavernStore {
  return {
    getState: async () => ({
      regexScripts: [],
      activePreset: undefined,
      sessionBindings: {
        [sessionId]: { architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' },
      },
    }),
    getCharacter: async () => ({ fileName: 'Character', kind: 'json', card: character }),
    getChatSnapshot: async () => ({ chat, revision: 'rev-1' }),
    getChatJsrOverlay: async () => undefined,
  } as unknown as TavernStore
}

/** Same store as {@link mutationDbFor}, with one IM peer bound to a session id. */
function imBoundMutationDbFor(
  sessionId: string,
  character: CharacterCardIR,
  chat: ChatLogIR,
  peerKey: string,
  peerSessionId: string,
): TavernStore {
  const base = mutationDbFor(sessionId, character, chat)
  return {
    ...base,
    getState: async () => ({
      ...(await base.getState() as unknown as Record<string, unknown>),
      imPeers: { [peerKey]: { sessionId: peerSessionId } },
    }),
  } as unknown as TavernStore
}

/* ------------------------- regeneration rollback harness ------------------- */

interface RegenerateEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
  readonly opts?: Record<string, unknown>
}

interface RegenerateHarness {
  readonly session: BodySessionLike
  readonly agent: BodyAgentLike
  readonly events: RegenerateEvent[]
  readonly followups: unknown[]
  surface(): number[]
}

/**
 * Minimal live session for one closed anchor turn. `toolCalls` seeds real
 * tool-call blocks in the old turn so the rollback port can test journal
 * coverage; `text` is the old body floor.
 */
function createRegenerateHarness(text: string, toolCalls: readonly string[], sessionId: string): RegenerateHarness {
  const events: RegenerateEvent[] = []
  const surfaceNodes: number[] = []
  const followups: unknown[] = []
  const phase = { kind: 'idle', lastTurn: 1 }

  const applySurface = (seq: number, metadata: Record<string, unknown> | undefined): void => {
    const surfaceOp = metadata?.['surfaceOp']
    if (surfaceOp === 'append') {
      surfaceNodes.push(seq)
      return
    }
    const op = asTestRecord(surfaceOp)
    if (op?.['op'] !== 'replace') return
    const startSeq = testNumber(op['startSeq'])
    const endSeq = testNumber(op['endSeq'])
    if (startSeq === undefined || endSeq === undefined) throw new Error('fake regenerate session: bad replace range')
    const startIndex = surfaceNodes.indexOf(startSeq)
    const endIndex = surfaceNodes.indexOf(endSeq)
    if (startIndex < 0 || endIndex < startIndex) throw new Error('fake regenerate session: replace range is not on the surface')
    surfaceNodes.splice(startIndex, endIndex - startIndex + 1, seq)
  }

  const append = (type: string, data: unknown, opts?: unknown): number => {
    const metadata = asTestRecord(opts)
    const seq = events.length
    events.push({ type, seq, data: asTestRecord(data) ?? {}, ...(metadata === undefined ? {} : { opts: metadata }) })
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
      || type === 'system/message' || type === 'developer/message') {
      applySurface(seq, metadata)
    }
    return seq
  }

  const appendRecord = (type: string, data: unknown): number => {
    const seq = events.length
    events.push({ type, seq, data: asTestRecord(data) ?? {} })
    return seq
  }

  const session = {
    id: sessionId,
    header: { version: 4 },
    events,
    get surface() { return { nodes: [...surfaceNodes] } },
    append,
    appendPluginRecord: appendRecord,
  } as unknown as BodySessionLike

  const agent: BodyAgentLike = {
    id: sessionId,
    session,
    status: 'idle',
    phase,
    followup: (message: unknown) => { followups.push(message) },
  }

  append('turn/start', { turn: 1 })
  append('step/start', { turn: 1, step: 1 })
  for (const [index, name] of toolCalls.entries()) {
    append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: `process-${index}`,
        role: 'assistant',
        content: [{ type: 'tool-call', callId: `call-${index}`, name, arguments: '{}' }],
      },
    }, { surfaceOp: 'append' })
    append('tool/result', {
      turn: 1,
      step: 1,
      message: { id: `result-${index}`, role: 'tool', content: [{ type: 'text', text: 'ok' }] },
    }, { surfaceOp: 'append' })
  }
  append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  }, { surfaceOp: 'append' })
  append('step/end', { turn: 1, step: 1 })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return {
    session,
    agent,
    events,
    followups,
    surface: () => [...surfaceNodes],
  }
}

function rollbackDb(character: CharacterCardIR, chat: ChatLogIR, sessionId: string): Record<string, unknown> {
  return {
    getState: async () => ({
      sessionBindings: {
        [sessionId]: { architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' },
      },
    }),
    getCharacter: async () => ({ fileName: 'Character', kind: 'json', card: character }),
    getChatSnapshot: async () => ({ chat, revision: 'rev-1' }),
    saveChat: async () => 'rev-2',
  }
}

function installRollbackState(character: CharacterCardIR, chat: ChatLogIR, sessionId: string): void {
  rollbackState.store = rollbackDb(character, chat, sessionId)
  rollbackState.memories = {
    read: async () => undefined,
    forget: async () => { throw new Error('unexpected memory forget') },
    restore: async () => { throw new Error('unexpected memory restore') },
  }
  rollbackState.variables = {
    get: async () => undefined,
    set: async () => { throw new Error('unexpected variable set') },
    delete: async () => { throw new Error('unexpected variable delete') },
  }
}

async function callBodyRegenerate(
  character: CharacterCardIR,
  chat: ChatLogIR,
  harness: RegenerateHarness,
  sessionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  hostState.module = hostRecordModule()
  installRollbackState(character, chat, sessionId)
  const res = makeResponse()
  const ctx = {
    agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
  } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
  await handleAgentTavernBodyApi(
    ctx,
    mutationDbFor(sessionId, character, chat),
    makeRequest({
      sessionId,
      messageId: 'message-1',
      groupId: 'message-1',
      expectedAnchorId: 'message-1',
      expectedIndex: 0,
    }, 'POST', '/api/dsh-soulmojito/body/regenerate'),
    res,
    new URL('/api/dsh-soulmojito/body/regenerate', 'http://localhost'),
    'body/regenerate',
    'POST',
  )
  return {
    status: res.statusCode,
    body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : {},
  }
}

async function callBodyRoute(
  character: CharacterCardIR,
  chat: ChatLogIR,
  route: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return callBodyRouteWithDb(mutationDb(character, chat), 'session-mvu', route, method, payload)
}

async function callBodyRouteWithDb(
  db: TavernStore,
  sessionId: string,
  route: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = makeResponse()
  await handleAgentTavernBodyApi(
    {} as unknown as Parameters<typeof handleAgentTavernBodyApi>[0],
    db,
    makeRequest({
      sessionId,
      messageId: 'message-1',
      groupId: 'message-1',
      expectedAnchorId: 'message-1',
      ...payload,
    }, method, `/api/dsh-soulmojito/${route}`),
    res,
    new URL(`/api/dsh-soulmojito/${route}`, 'http://localhost'),
    route,
    method,
  )
  const payloadOut = res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : {}
  return { status: res.statusCode, body: payloadOut }
}

async function callBodyMutation(character: CharacterCardIR, chat: ChatLogIR) {
  return callBodyRoute(character, chat, 'body', 'PUT', { index: 0, text: 'edited body' })
}

async function callBodySelect(character: CharacterCardIR, chat: ChatLogIR) {
  return callBodyRoute(character, chat, 'body/select', 'POST', { index: 0 })
}

/**
 * Drive one `PUT body` with a live agent so the runtime preflight executes.
 * The mocked Tavern store is shared by the route and the wiring inspection hook.
 */
async function callBodyEditWithHarness(
  character: CharacterCardIR,
  chat: ChatLogIR,
  harness: RecoveryHarness,
  sessionId: string,
  text: string,
  ids?: { groupId: string; expectedAnchorId: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  hostState.module = hostRecordModule()
  rollbackState.store = mutationDbFor(sessionId, character, chat)
  const res = makeResponse()
  const ctx = {
    agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
  } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
  await handleAgentTavernBodyApi(
    ctx,
    mutationDbFor(sessionId, character, chat),
    makeRequest({
      sessionId,
      groupId: ids === undefined ? 'message-1' : ids.groupId,
      expectedAnchorId: ids === undefined ? 'message-1' : ids.expectedAnchorId,
      index: 0,
      text,
    }, 'PUT', '/api/dsh-soulmojito/body'),
    res,
    new URL('/api/dsh-soulmojito/body', 'http://localhost'),
    'body',
    'PUT',
  )
  return {
    status: res.statusCode,
    body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : {},
  }
}

describe('plugin-record seam', () => {
  it('returns no deps when the host has no appendPluginRecord', async () => {
    hostState.module = { pluginRecordOf: () => undefined }
    const capture = captureLogger()
    const agent = fakeAgent(fakeSession('session-missing'))

    await expect(resolveBodyRecordWriter(wiringContext(capture.logger))).resolves.toBeUndefined()
    await expect(createBodyDeps(wiringContext(capture.logger), agent)).resolves.toBeUndefined()
    expect(capture.warnings.some((args) => String(args[0]).includes('appendPluginRecord/pluginRecordOf'))).toBe(true)
  })

  it('returns no deps when the host package itself is missing', async () => {
    hostState.module = undefined
    const capture = captureLogger()
    const agent = fakeAgent(fakeSession('session-package-missing'))

    await expect(createBodyDeps(wiringContext(capture.logger), agent)).resolves.toBeUndefined()
  })

  it('injects the resolved writer and keeps the live session/agent', async () => {
    const calls: Array<Record<string, unknown>> = []
    hostState.module = {
      appendPluginRecord: (session: unknown, type: string, data: unknown) => {
        calls.push({ session, type, data })
        delegatingAppendPluginRecord(session, type, data)
        return 11
      },
      pluginRecordOf: () => undefined,
    }
    const capture = captureLogger()
    const session = fakeSession('session-writer')
    const agent = fakeAgent(session)

    const deps = await createBodyDeps(wiringContext(capture.logger), agent)
    expect(deps).toBeDefined()
    expect(deps!.session).toBe(session)
    expect(deps!.agent).toBe(agent)
    expect(deps!.appendRecord).toBeTypeOf('function')
    expect(deps!.writeRollback).toBeDefined()

    const data = { op: 'op-finish', opId: 'body-op-test', result: 'failed' }
    expect(deps!.appendRecord!(session, BODY_EVENT_TYPE, data)).toBe(11)
    expect(calls).toEqual([{ session, type: BODY_EVENT_TYPE, data }])
  })
})

describe('HTTP rejection mapping', () => {
  it('maps runtime codes onto proposal §11 codes and statuses', () => {
    expect(bodyFailureOf(bodyRuntimeError('invalid-body-text', 'empty body'))).toEqual({
      status: 400,
      code: 'invalid-body-text',
      message: 'empty body',
    })
    expect(bodyFailureOf(bodyRuntimeError('session-busy', 'running'))).toMatchObject({
      status: 409,
      code: 'session-busy',
    })
    expect(bodyFailureOf(bodyRuntimeError('restore-unavailable', 'no anchor'))).toMatchObject({
      status: 409,
      code: 'body-state-unsafe',
    })
    expect(bodyFailureOf(bodyRuntimeError('invalid-arguments', 'bad index'))).toMatchObject({
      status: 400,
      code: 'invalid-body-text',
    })
    expect(bodyFailureOf(new Error('boom'))).toEqual({
      status: 500,
      code: 'operation-failed',
      message: 'boom',
    })
    expect(bodyRejectStatus('host-unsupported')).toBe(501)
    expect(bodyRejectStatus('projection-pending')).toBe(503)
    expect(bodyRejectStatus('body-compacted')).toBe(409)
  })

  it('preserves candidate receipt details on 409 and maps projection lag to 503', () => {
    for (const detail of ['body-receipt-missing', 'body-receipt-duplicate', 'body-receipt-legacy', 'body-receipt-key-mismatch'] as const) {
      expect(bodyFailureOf(new CandidateReceiptError(detail, `${detail} from projection`))).toMatchObject({
        status: 409,
        code: 'body-state-unsafe',
        detail,
      })
    }
    expect(bodyFailureOf(bodyRuntimeError('projection-pending', 'projection is still catching up'))).toMatchObject({
      status: 503,
      code: 'projection-pending',
    })
  })

  it('maps internal body data failures to 409 with the original code as detail', () => {
    const cases = [
      new BodyJsonlProjectionError('body-swipes-missing', 'body floor has no swipes'),
      new BodyJsonlProjectionError('body-index-mismatch', 'edit index does not match the selected swipe'),
      new BodyJsonlProjectionError('body-candidate-gap', 'candidate index would skip a slot'),
      new BodyJsonlProjectionError('body-group-mismatch', 'body group matches two floors'),
      new BodyJsonlProjectionError('body-swipe-info-invalid', 'swipe_info is not an array'),
      new BodyJsonlProjectionError('body-adoption-mismatch', 'floor is not the anchor mirror'),
      new BodyLedgerError('invalid-body-seq', 'event has an invalid seq'),
      new BodyLedgerError('invalid-body-event', 'body event data must be an object'),
      new BodyLedgerError('body-candidate-message-missing', 'candidate has no assistant message'),
      bodyRuntimeError('invalid-event', 'body event is malformed'),
    ] as const
    for (const error of cases) {
      const failure = bodyFailureOf(error)
      expect(failure).toMatchObject({
        status: 409,
        code: 'body-state-unsafe',
        detail: error.code,
      })
      expect(bodyRejectStatus(error.code)).toBe(409)
    }

    // Retryable waits keep their own code and status; only unknown exceptions
    // stay a 500.
    expect(bodyFailureOf(bodyRuntimeError('projection-pending', 'catching up'))).toMatchObject({
      status: 503,
      code: 'projection-pending',
    })
    expect(bodyFailureOf(new Error('unexpected boom'))).toMatchObject({
      status: 500,
      code: 'operation-failed',
    })
  })

  it('keeps the before-only write-journal-unknown detail on a 409', () => {
    const failure = bodyFailureOf({
      code: 'body-state-unsafe',
      detail: 'write-journal-unknown',
      message: 'body rollback cannot read memory to verify the before-only write journal',
    })

    expect(failure).toMatchObject({
      status: 409,
      code: 'body-state-unsafe',
      detail: 'write-journal-unknown',
    })
    expect(bodyStateUnsafeMessage('write-journal-unknown')).toContain('cannot prove')
  })
})

describe('projection registration', () => {
  it('registers the body projection once and retains its disposer', () => {
    const capture = captureLogger()
    const registered: Array<{ type: string }> = []
    const effects: Array<() => (() => void) | void> = []
    let disposed = 0
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      sessions: {
        registerMessageProjection: (projection: unknown) => {
          registered.push(projection as { type: string })
          return () => { disposed += 1 }
        },
      },
      effect: (callback) => {
        effects.push(callback)
        return undefined
      },
    }

    const dispose = registerBodyProjection(ctx)
    expect(dispose).toBeTypeOf('function')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.type).toBe(BODY_EVENT_TYPE)
    expect(effects).toHaveLength(1)

    const cleanup = effects[0]!()
    expect(cleanup).toBeTypeOf('function')
    cleanup!()
    expect(disposed).toBe(1)
  })

  it('disables projection when the host has no sessions service', () => {
    const capture = captureLogger()
    expect(registerBodyProjection({ logger: capture.logger })).toBeUndefined()
    expect(capture.warnings.some((args) => String(args[0]).includes('registerMessageProjection is unavailable'))).toBe(true)
  })

  it('subscribes the turn-stopping listener once', () => {
    const capture = captureLogger()
    let attached = 0
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      on: () => {
        attached += 1
        return () => undefined
      },
    }
    registerBodyTurnStopping(ctx)
    expect(attached).toBe(1)
  })
})

describe('turn-stopping binding filter', () => {
  it('reads the body op only for AgentTavern single-character bindings', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const bindings: Record<string, { architecture: string; group?: boolean }> = {
      'session-tavern': { architecture: 'agent-tavern' },
      'session-st': { architecture: 'st' },
      'session-group': { architecture: 'agent-tavern', group: true },
    }
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      bindingOf: (sessionId) => bindings[sessionId],
    }

    // A throwing event log is the observable proof that the listener reached
    // finalizeTurnStopping: the failure is logged, not silently swallowed.
    await handleBodyTurnStopping(ctx, {
      agent: fakeAgent(throwingSession('session-tavern')),
      turn: 3,
    })
    expect(capture.errors.some((args) => String(args[0]).includes('turn-stopping listener failed'))).toBe(true)
    const errorsAfterTavern = capture.errors.length

    await handleBodyTurnStopping(ctx, {
      agent: fakeAgent(throwingSession('session-st')),
      turn: 3,
    })
    await handleBodyTurnStopping(ctx, {
      agent: fakeAgent(throwingSession('session-group')),
      turn: 3,
    })
    expect(capture.errors).toHaveLength(errorsAfterTavern)
  })

  it('skips malformed payloads without touching the binding store', async () => {
    const capture = captureLogger()
    let lookups = 0
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      bindingOf: () => {
        lookups += 1
        return undefined
      },
    }
    await handleBodyTurnStopping(ctx, { turn: 0 })
    await handleBodyTurnStopping(ctx, null)
    expect(lookups).toBe(0)
    expect(capture.warnings.length).toBeGreaterThan(0)
  })
})

describe('body state safety (proposal 0022 §7)', () => {
  it('no longer refuses an MVU-declared card for regeneration', () => {
    const character = { card: mvuCharacter() }
    const chat = fakeChat({})
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(true)
    expect(bodyMutationSafetyOf('regenerate', character, chat)).toEqual({ safe: true })
    expect(bodyMutationSafetyOf('edit', character, chat)).toEqual({ safe: true })
    expect(bodyMutationSafetyOf('select', character, chat)).toMatchObject({
      safe: false,
      reason: 'body-state-unsafe',
      detail: 'candidate-switch-disabled',
    })
  })

  it('treats chat variables.stat_data as edit/select-only history', () => {
    const character = { card: plainCharacter() }
    const chat = fakeChat({ variables: { stat_data: {} } })
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(true)
    expect(bodyMutationSafetyOf('edit', character, chat)).toEqual({ safe: true })
    expect(bodyMutationSafetyOf('select', character, chat)).toMatchObject({ detail: 'candidate-switch-disabled' })
    expect(bodyMutationSafetyOf('regenerate', character, chat)).toEqual({ safe: true })
  })

  it('treats chat mvu.receipts as edit/select-only history', () => {
    const character = { card: plainCharacter() }
    const chat = fakeChat({ mvu: { receipts: [{ at: 't', turnKey: 'k' }] } })
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(true)
    expect(bodyMutationSafetyOf('edit', character, chat)).toEqual({ safe: true })
    expect(bodyMutationSafetyOf('select', character, chat)).toMatchObject({ detail: 'candidate-switch-disabled' })
  })

  it('allows a plain card with no historical MVU state', () => {
    const character = { card: plainCharacter() }
    const chat = fakeChat({ variables: { other: 1 } })
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(false)
    expect(bodyMutationSafetyOf('edit', character, chat)).toEqual({ safe: true })
  })

  it('fails closed when the card cannot be read', () => {
    expect(bodyStateSafetyOf(undefined, fakeChat({}))).toMatchObject({
      safe: false,
      detail: 'card-unreadable',
    })
    expect(bodyStateUnsafeMessage('card-unreadable')).toContain('character card')
    expect(bodyStateUnsafeMessage('write-journal-missing')).toContain('write journal')
    expect(bodyStateUnsafeMessage('write-journal-unavailable')).toContain('appendPluginRecord')
    expect(bodyStateUnsafeMessage('mvu-receipt-missing')).toContain('receipt')
  })

  it('lets an MVU edit pass the safety gate and reach the missing live agent', async () => {
    const mvu = await callBodyMutation(mvuCharacter(), fakeChat({}))
    expect(mvu.status).toBe(409)
    expect(mvu.body).toMatchObject({
      ok: false,
      code: 'session-busy',
    })
    expect(String(mvu.body['message'])).toContain('no live agent')
  })

  it('returns 409 candidate-switch-disabled from a select on MVU history', async () => {
    const result = await callBodySelect(mvuCharacter(), fakeChat({}))
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'candidate-switch-disabled',
    })
  })

  it('lets an edit pass the safety gate when the chat only carries stat_data or receipts', async () => {
    const stat = await callBodyMutation(plainCharacter(), fakeChat({ variables: { stat_data: {} } }))
    expect(stat).toMatchObject({ status: 409, body: { code: 'session-busy' } })

    const receipts = await callBodyMutation(plainCharacter(), fakeChat({ mvu: { receipts: [{ at: 't' }] } }))
    expect(receipts).toMatchObject({ status: 409, body: { code: 'session-busy' } })
  })

  it('lets a plain card pass the safety gate (later fails on the missing live agent)', async () => {
    const result = await callBodyMutation(plainCharacter(), fakeChat({}))
    expect(result.status).toBe(409)
    expect(result.body['code']).toBe('session-busy')
  })

  it('accepts an MVU edit once the candidate receipt exists', async () => {
    const character = mvuCharacter()
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const chat = projectedMvuChat(text, [{
      at: '2026-10-28T00:00:00.000Z',
      turnKey: 'body:message-1#0',
      status: 'updated',
      changes: [{ name: 'stat_data.hp', before: 1, after: 2 }],
      failures: [],
    }])
    const harness = createRecoveryHarness()
    seedEditAnchor(harness, 'message-1', text)

    const result = await callBodyEditWithHarness(character, chat, harness, 'session-recovery', 'edited body')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, state: { groupId: 'message-1', selectedIndex: 0, text: 'edited body' } })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'edit')).toBe(true)
  })

  it('refuses an MVU edit whose body has no candidate receipt', async () => {
    const character = mvuCharacter()
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const chat = projectedChat(text)
    const harness = createRecoveryHarness()
    seedEditAnchor(harness, 'message-1', text)

    const result = await callBodyEditWithHarness(character, chat, harness, 'session-recovery', 'edited body')

    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'body-receipt-missing',
    })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'edit')).toBe(false)
  })

  it('answers projection-pending when the JSONL floor is not projected yet', async () => {
    const character = mvuCharacter()
    const chat = fakeChat({})
    const harness = createRecoveryHarness()
    seedEditAnchor(harness, 'message-1', 'old body')

    const result = await callBodyEditWithHarness(character, chat, harness, 'session-recovery', 'edited body')

    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ ok: false, code: 'projection-pending' })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'edit')).toBe(false)
  })

  it('reads the ledger edit when the JSONL floor still carries the previous text', async () => {
    const session = editedBodySession('message-1', 'message-1', 'old body', 'edited body')
    const chat = withEditWatermark(projectedChat('old body'), 1)

    const result = await callBodyGet(plainCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      text: 'edited body',
      projectionPending: true,
    })
  })

  it('keeps the projected display text once the floor applied the edit', async () => {
    const session = editedBodySession('message-1', 'message-1', 'old body', 'edited body')
    const chat = withEditWatermark(projectedChat('projected display body'), 2)

    const result = await callBodyGet(plainCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, text: 'projected display body' })
    expect(result.body['projectionPending']).toBeUndefined()
  })

  it('reads the selected swipe while the floor anchor still points at the previous candidate', async () => {
    const events: RecoveryEvent[] = [
      {
        type: 'assistant/message',
        seq: 0,
        data: { message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'old body' }] } },
      },
      {
        type: 'assistant/message',
        seq: 1,
        data: { message: { id: 'message-2', role: 'assistant', content: [{ type: 'text', text: 'new body' }] } },
      },
      { type: BODY_EVENT_TYPE, seq: 2, data: { op: 'candidate', groupId: 'message-1', messageId: 'message-1', index: 0 } },
      { type: BODY_EVENT_TYPE, seq: 3, data: { op: 'candidate', groupId: 'message-1', messageId: 'message-2', index: 1 } },
      { type: BODY_EVENT_TYPE, seq: 4, data: { op: 'select', groupId: 'message-1', index: 1 } },
    ]
    const session = {
      id: 'session-mvu',
      header: { version: 4 },
      events,
      surface: { nodes: [0, 1] },
      append: () => 0,
    } as unknown as BodySessionLike
    const chat = projectedChat('old body')
    chat.messages[0]!.swipes = ['old body', 'new body']

    const result = await callBodyGet(plainCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-2')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      selectedIndex: 1,
      anchorMessageId: 'message-2',
      text: 'new body',
      projectionPending: true,
    })
  })

  it('never serves the previous anchor text when the candidate slot is not projected', async () => {
    const events: RecoveryEvent[] = [
      {
        type: 'assistant/message',
        seq: 0,
        data: { message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'old body' }] } },
      },
      {
        type: 'assistant/message',
        seq: 1,
        data: { message: { id: 'message-2', role: 'assistant', content: [{ type: 'text', text: 'new body' }] } },
      },
      { type: BODY_EVENT_TYPE, seq: 2, data: { op: 'candidate', groupId: 'message-1', messageId: 'message-1', index: 0 } },
      { type: BODY_EVENT_TYPE, seq: 3, data: { op: 'candidate', groupId: 'message-1', messageId: 'message-2', index: 1 } },
      { type: BODY_EVENT_TYPE, seq: 4, data: { op: 'select', groupId: 'message-1', index: 1 } },
    ]
    const session = {
      id: 'session-mvu',
      header: { version: 4 },
      events,
      surface: { nodes: [0, 1] },
      append: () => 0,
    } as unknown as BodySessionLike
    const chat = projectedChat('old body')

    const result = await callBodyGet(plainCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-2')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      anchorMessageId: 'message-2',
      text: 'new body',
      projectionPending: true,
    })
  })

  it('accepts an edit on an imported floor once the projection adopted it', async () => {
    const character = plainCharacter()
    const chat = adoptedChat('import-anchor', 'Chosen greeting.')
    const harness = createRecoveryHarness()
    seedEditAnchor(harness, 'import-anchor', 'Chosen greeting.')

    const result = await callBodyEditWithHarness(character, chat, harness, 'session-recovery', 'edited body', {
      groupId: 'import-anchor',
      expectedAnchorId: 'import-anchor',
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      state: { groupId: 'import-anchor', selectedIndex: 0, text: 'edited body' },
    })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'edit')).toBe(true)
  })

  it('enables edit while keeping selection closed for an MVU GET view', async () => {
    hostState.module = hostRecordModule()
    const session = sessionWithAssistant('message-1', 'session body')
    const agent = fakeAgent(session)
    const ctx = {
      agents: { get: (id: string) => id === 'session-mvu' ? agent : undefined },
    } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
    const res = makeResponse()
    const url = new URL('/api/dsh-soulmojito/body?sessionId=session-mvu&messageId=message-1', 'http://localhost')
    await handleAgentTavernBodyApi(
      ctx,
      mutationDb(mvuCharacter(), projectedChat('stored body')),
      makeRequest(undefined, 'GET', `${url.pathname}${url.search}`),
      res,
      url,
      'body',
      'GET',
    )
    const result = JSON.parse(res.chunks.join('')) as Record<string, unknown>

    expect(result).toMatchObject({
      ok: true,
      text: 'stored body',
      hidden: false,
      canEdit: true,
      canRegenerate: true,
      canSelect: false,
      detail: 'candidate-switch-disabled',
    })
    expect(result['reason']).toBeUndefined()
  })

  it('closes MVU edit on GET when the selected candidate has no receipt', async () => {
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const session = bodySession('message-1', text, 'message-1', [0])

    const result = await callBodyGet(mvuCharacter(), projectedChat(text), fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      canEdit: false,
      canSelect: false,
      detail: 'body-receipt-missing',
    })
  })

  it('closes MVU edit on GET when the selected candidate has duplicate live receipts', async () => {
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const chat = projectedMvuChat(text, [
      {
        at: '2026-10-28T00:00:00.000Z',
        turnKey: 'body:message-1#0',
        status: 'updated',
        changes: [{ name: 'stat_data.hp', before: 1, after: 2 }],
        failures: [],
      },
      {
        at: '2026-10-28T00:00:01.000Z',
        turnKey: 'body:message-1#0',
        status: 'updated',
        changes: [{ name: 'stat_data.hp', before: 2, after: 3 }],
        failures: [],
      },
    ])
    const session = bodySession('message-1', text, 'message-1', [0])

    const result = await callBodyGet(mvuCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ canEdit: false, detail: 'body-receipt-duplicate' })
  })

  it('closes MVU edit on GET when the ledger maps one message id to two slots', async () => {
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const session = bodySession('message-1', text, 'message-1', [0, 1])

    const result = await callBodyGet(mvuCharacter(), projectedChat(text), fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ canEdit: false, detail: 'body-receipt-key-mismatch' })
  })

  it('keeps MVU edit open on GET when the selected candidate receipt is live', async () => {
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const chat = projectedMvuChat(text, [{
      at: '2026-10-28T00:00:00.000Z',
      turnKey: 'body:message-1#0',
      status: 'updated',
      changes: [{ name: 'stat_data.hp', before: 1, after: 2 }],
      failures: [],
    }])
    const session = bodySession('message-1', text, 'message-1', [0])

    const result = await callBodyGet(mvuCharacter(), chat, fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      canEdit: true,
      canSelect: false,
      detail: 'candidate-switch-disabled',
    })
  })

  it('keeps the optimistic edit gate for a plain card with a variable block', async () => {
    const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/hp","value":2}]</JSONPatch></UpdateVariable>'
    const session = bodySession('message-1', text, 'message-1', [0])

    const result = await callBodyGet(plainCharacter(), projectedChat(text), fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ canEdit: true })
    expect(result.body['detail']).toBeUndefined()
  })

  it('disables regenerate when the rollback port is unavailable', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: true,
      writeRollbackAvailable: false,
      ledger: undefined,
      messageText: 'raw message text',
      projected: { text: 'display text', count: 1, selectedIndex: 0 },
      inspection: { onSurface: true, last: true },
    })
    expect(view).toMatchObject({
      canEdit: true,
      canRegenerate: false,
      canSelect: false,
      reason: 'write-journal-unavailable',
    })
  })

  it('keeps MVU selection closed while allowing edit for a multi-candidate body', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view-mvu')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: true,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'old body',
      projected: { text: 'old body', count: 2, selectedIndex: 0 },
      inspection: { onSurface: true, last: true },
    })
    expect(view).toMatchObject({
      canEdit: true,
      canRegenerate: true,
      canSelect: false,
      detail: 'candidate-switch-disabled',
    })
  })

  it('lets an MVU regenerate reach the runtime and start the trigger', async () => {
    const character = mvuCharacter()
    const chat = projectedChat('old body')
    const harness = createRegenerateHarness('old body', [], 'session-mvu-regen-pass')

    const result = await callBodyRegenerate(character, chat, harness, 'session-mvu-regen-pass')

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ ok: true, status: 'pending' })
    expect(harness.followups).toHaveLength(1)
    const anchorSeq = harness.events.find((event) => asTestRecord(event.data['message'])?.['id'] === 'message-1')?.seq
    expect(anchorSeq).toBeDefined()
    // Proposal 0021 §6.2 step 4 (revision 2026-10-29): the start hides the old
    // anchor before the trigger turn opens.
    expect(harness.surface()).not.toContain(anchorSeq)
    expect(harness.events.some((event) => event.type === 'developer/message')).toBe(true)
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'op-start')).toBe(true)
  })

  it('refuses an MVU regenerate whose old turn wrote without a journal record', async () => {
    const character = mvuCharacter()
    const chat = projectedChat('old body')
    const harness = createRegenerateHarness('old body', ['memory_write'], 'session-mvu-regen-journal')

    const result = await callBodyRegenerate(character, chat, harness, 'session-mvu-regen-journal')

    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'write-journal-missing',
    })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE)).toBe(false)
    expect(harness.followups).toHaveLength(0)
    const anchorSeq = harness.events.find((event) => asTestRecord(event.data['message'])?.['id'] === 'message-1')?.seq
    expect(anchorSeq).toBeDefined()
    expect(harness.surface()).toContain(anchorSeq)
  })

  it('refuses an MVU regenerate whose old body has no receipt', async () => {
    const character = mvuCharacter()
    const chat = projectedChat('<UpdateVariable>{"hp":1}</UpdateVariable>')
    const harness = createRegenerateHarness(
      '<UpdateVariable>{"hp":1}</UpdateVariable>',
      [],
      'session-mvu-regen-receipt',
    )

    const result = await callBodyRegenerate(character, chat, harness, 'session-mvu-regen-receipt')

    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'mvu-receipt-missing',
    })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE)).toBe(false)
    expect(harness.followups).toHaveLength(0)
  })
})

describe('IM body mutation gate', () => {
  const peerKey = 'qq:account:private:peer-1'

  it('gates only AgentTavern bindings with a matching IM peer', () => {
    const peers = { [peerKey]: { sessionId: 'session-mvu' } }

    expect(imBodyMutationDisabledOf({ architecture: 'agent-tavern' }, 'session-mvu', peers)).toContain('im_send')
    expect(imBodyMutationDisabledOf({ architecture: 'st' }, 'session-mvu', peers)).toBeUndefined()
    expect(imBodyMutationDisabledOf({ architecture: 'agent-tavern' }, 'session-other', peers)).toBeUndefined()
    expect(imBodyMutationDisabledOf({ architecture: 'agent-tavern' }, 'session-mvu', undefined)).toBeUndefined()
  })

  it('rejects edit, regenerate and select with 409 im-body-mutation-disabled', async () => {
    const routes = [
      { route: 'body', method: 'PUT', payload: { index: 0, text: 'edited body' } },
      { route: 'body/regenerate', method: 'POST', payload: { expectedIndex: 0 } },
      { route: 'body/select', method: 'POST', payload: { index: 0 } },
    ] as const
    for (const entry of routes) {
      const db = imBoundMutationDbFor('session-mvu', plainCharacter(), projectedChat('stored body'), peerKey, 'session-mvu')
      const result = await callBodyRouteWithDb(db, 'session-mvu', entry.route, entry.method, entry.payload)

      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ ok: false, code: 'im-body-mutation-disabled' })
      expect(String(result.body['message'])).toContain('im_send')
      // The refusal names neither the peer key nor any peer id.
      expect(JSON.stringify(result.body)).not.toContain(peerKey)
      expect(JSON.stringify(result.body)).not.toContain('peer-1')
    }
  })

  it('keeps the body readable and reports mutationsEnabled:false with the reason', async () => {
    const text = 'IM reply body'
    const db = imBoundMutationDbFor('session-mvu', plainCharacter(), projectedChat(text), peerKey, 'session-mvu')

    const result = await callBodyGetQuery(
      fakeAgent(sessionWithAssistant('message-1', text)),
      'session-mvu',
      'messageId=message-1',
      db,
      undefined,
    )

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      text,
      canEdit: false,
      canRegenerate: false,
      canSelect: false,
      mutationsEnabled: false,
      disabledReason: expect.stringContaining('im_send'),
    })
  })

  it('does not gate a session whose IM peer binds another session id', async () => {
    const db = imBoundMutationDbFor('session-mvu', plainCharacter(), projectedChat('stored body'), peerKey, 'session-other')
    const routes = [
      { route: 'body', method: 'PUT', payload: { index: 0, text: 'edited body' } },
      { route: 'body/regenerate', method: 'POST', payload: { expectedIndex: 0 } },
      { route: 'body/select', method: 'POST', payload: { index: 0 } },
    ] as const
    for (const entry of routes) {
      const result = await callBodyRouteWithDb(db, 'session-mvu', entry.route, entry.method, entry.payload)

      // The route reaches its normal validation path (no live agent), never the IM gate.
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ ok: false, code: 'session-busy' })
    }
  })

  it('keeps the normal body shape for a session without an IM peer', async () => {
    const text = 'stored body'
    const result = await callBodyGet(plainCharacter(), projectedChat(text), fakeAgent(sessionWithAssistant('message-1', text)), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, canEdit: true })
    expect(result.body['mutationsEnabled']).toBeUndefined()
    expect(result.body['disabledReason']).toBeUndefined()
  })
})

describe('GET body floor resolution', () => {
  it('serves the ledger body instead of the first of two floors bound to one group', async () => {
    const session = bodySession('message-1', 'ledger body', 'message-1', [0])
    const chat = projectedChat('first floor body')
    chat.messages.push({
      name: 'character',
      is_user: false,
      is_system: false,
      send_date: '',
      mes: 'second floor body',
      swipe_id: 0,
      swipes: ['second floor body'],
      extra: { agentTavern: { messageId: 'message-2', anchorMessageId: 'message-2', bodyGroupId: 'message-1' } },
    })
    const capture = captureLogger()

    const result = await callBodyGet(
      plainCharacter(),
      chat,
      fakeAgent(session),
      'session-mvu',
      'message-1',
      capture.logger,
    )

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      groupId: 'message-1',
      text: 'ledger body',
      // Ambiguity is a state gate on the read side: edit must be closed before
      // the user opens the editor and hits a 409.
      canEdit: false,
      detail: 'body-group-mismatch',
      projectionPending: true,
    })
    expect(JSON.stringify(result.body)).not.toContain('first floor body')
    const warning = capture.warnings.find((args) => String(args[0]).includes('body floor binding is ambiguous'))
    expect(warning).toBeDefined()
    expect(JSON.stringify(warning?.[1])).toContain('(0, 1)')
  })
})

describe('GET body batch read', () => {
  it('answers every requested id with the single-id item shape', async () => {
    const session = groupedBodySession([{
      groupId: 'message-1',
      candidates: [
        { messageId: 'message-1', text: 'first body' },
        { messageId: 'message-2', text: 'second body' },
      ],
    }])
    const chat = projectedChat('first body')
    const agent = fakeAgent(session)

    const single = await callBodyGet(plainCharacter(), chat, agent, 'session-mvu', 'message-1')
    const batch = await callBodyGetQuery(
      agent,
      'session-mvu',
      'messageIds=message-1,message-2',
      mutationDbFor('session-mvu', plainCharacter(), chat),
      undefined,
    )

    expect(single.status).toBe(200)
    expect(batch.status).toBe(200)
    expect(batch.body['ok']).toBe(true)
    const items = batch.body['items'] as Record<string, Record<string, unknown>>
    expect(Object.keys(items)).toEqual(['message-1', 'message-2'])
    // The item is the exact single-id payload, not a reduced variant.
    expect(items['message-1']).toEqual(single.body)
    expect(items['message-2']).toMatchObject({
      ok: true,
      groupId: 'message-1',
      anchorMessageId: 'message-2',
      hidden: false,
      count: 2,
      text: 'second body',
      canEdit: true,
    })
  })

  it('reads the chat snapshot, the state and the session log once per batch', async () => {
    const session = groupedBodySession([
      { groupId: 'message-1', candidates: [{ messageId: 'message-1', text: 'one body' }] },
      { groupId: 'message-3', candidates: [{ messageId: 'message-3', text: 'three body' }] },
      { groupId: 'message-5', candidates: [{ messageId: 'message-5', text: 'five body' }] },
    ])
    const counted = countingSession(session)
    const chat = projectedChat('one body')
    chat.messages.push(
      {
        name: 'character',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'three body',
        swipe_id: 0,
        swipes: ['three body'],
        extra: { agentTavern: { messageId: 'message-3', anchorMessageId: 'message-3', bodyGroupId: 'message-3' } },
      },
      {
        name: 'character',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'five body',
        swipe_id: 0,
        swipes: ['five body'],
        extra: { agentTavern: { messageId: 'message-5', anchorMessageId: 'message-5', bodyGroupId: 'message-5' } },
      },
    )
    const countedDb = countingDbFor('session-mvu', plainCharacter(), chat)

    const batch = await callBodyGetQuery(
      fakeAgent(counted.session),
      'session-mvu',
      'messageIds=message-1,message-3,message-5',
      countedDb.db,
      undefined,
    )

    expect(batch.status).toBe(200)
    expect(Object.keys(batch.body['items'] as Record<string, unknown>)).toHaveLength(3)
    expect(countedDb.counts.snapshots).toBe(1)
    expect(countedDb.counts.states).toBe(1)
    expect(counted.reads.log).toBe(1)
  })

  it('reuses one ledger fold and one facts record per group', () => {
    const session = groupedBodySession([{
      groupId: 'message-1',
      candidates: [
        { messageId: 'message-1', text: 'first body' },
        { messageId: 'message-2', text: 'second body' },
      ],
    }])
    const source = createBodySessionFactsSource(session)
    const first = source.factsOf('message-1', 'message-1')
    const second = source.factsOf('message-2', 'message-1')

    expect(first.ledger).toBeDefined()
    // A re-fold would build a new frozen ledger object; the shared source keeps
    // one instance for every row that resolves the same group.
    expect(second.ledger).toBe(first.ledger)
    expect(source.factsOf('message-1', 'message-1')).toBe(first)
  })

  it('de-duplicates repeated ids in request order', async () => {
    const session = groupedBodySession([{
      groupId: 'message-1',
      candidates: [{ messageId: 'message-1', text: 'first body' }],
    }])

    const batch = await callBodyGetQuery(
      fakeAgent(session),
      'session-mvu',
      'messageIds=message-1,message-1',
      mutationDbFor('session-mvu', plainCharacter(), projectedChat('first body')),
      undefined,
    )

    expect(batch.status).toBe(200)
    expect(Object.keys(batch.body['items'] as Record<string, unknown>)).toEqual(['message-1'])
  })

  it('rejects a mixed single/batch selector instead of guessing', async () => {
    const db = mutationDbFor('session-mvu', plainCharacter(), projectedChat('body'))
    await expect(callBodyGetQuery(
      fakeAgent(bodySession('message-1', 'body', 'message-1', [0])),
      'session-mvu',
      'messageId=message-1&messageIds=message-2',
      db,
      undefined,
    )).rejects.toMatchObject({ status: 400 })
  })

  it('rejects an empty entry and a batch over the 50-id limit', async () => {
    const db = mutationDbFor('session-mvu', plainCharacter(), projectedChat('body'))
    const agent = fakeAgent(bodySession('message-1', 'body', 'message-1', [0]))
    await expect(callBodyGetQuery(
      agent,
      'session-mvu',
      'messageIds=message-1,,message-2',
      db,
      undefined,
    )).rejects.toMatchObject({ status: 400 })

    const tooMany = Array.from({ length: 51 }, (_, index) => `message-${index}`).join(',')
    await expect(callBodyGetQuery(
      agent,
      'session-mvu',
      `messageIds=${tooMany}`,
      db,
      undefined,
    )).rejects.toMatchObject({ status: 400, message: expect.stringContaining('51') })
  })

  it('degrades only the ambiguous item and keeps the rest of the batch', async () => {
    const session = groupedBodySession([
      { groupId: 'message-1', candidates: [{ messageId: 'message-1', text: 'first body' }] },
      { groupId: 'message-3', candidates: [{ messageId: 'message-3', text: 'third body' }] },
    ])
    const chat = fakeChat({})
    chat.messages.push(
      {
        name: 'character',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'first body',
        swipe_id: 0,
        swipes: ['first body'],
        extra: { agentTavern: { messageId: 'message-1', anchorMessageId: 'message-1', bodyGroupId: 'message-1' } },
      },
      {
        name: 'character',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'third body',
        swipe_id: 0,
        swipes: ['third body'],
        extra: { agentTavern: { messageId: 'message-3', anchorMessageId: 'message-3', bodyGroupId: 'message-3' } },
      },
      {
        name: 'character',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'duplicate third body',
        swipe_id: 0,
        swipes: ['duplicate third body'],
        extra: { agentTavern: { messageId: 'message-3', anchorMessageId: 'message-3', bodyGroupId: 'message-3' } },
      },
    )
    const capture = captureLogger()

    const batch = await callBodyGetQuery(
      fakeAgent(session),
      'session-mvu',
      'messageIds=message-1,message-3',
      mutationDbFor('session-mvu', plainCharacter(), chat),
      capture.logger,
    )

    expect(batch.status).toBe(200)
    const items = batch.body['items'] as Record<string, Record<string, unknown>>
    // The healthy row keeps the ordinary surface gate (a later assistant body
    // exists) and is not touched by the other row's degradation.
    expect(items['message-1']).toMatchObject({ ok: true, canEdit: false, reason: 'not-last-round', text: 'first body' })
    expect(items['message-1']?.['detail']).toBeUndefined()
    expect(items['message-1']?.['projectionPending']).toBeUndefined()
    // The duplicated group degrades to the ledger body with its gate detail;
    // the request itself stays a 200.
    expect(items['message-3']).toMatchObject({
      ok: true,
      groupId: 'message-3',
      text: 'third body',
      canEdit: false,
      detail: 'body-group-mismatch',
      projectionPending: true,
    })
    const warning = capture.warnings.find((args) => String(args[0]).includes('body floor binding is ambiguous'))
    expect(JSON.stringify(warning?.[1])).toContain('message-3')
  })
})

describe('GET body last operation', () => {
  interface OperationEvent {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data: Record<string, unknown>
  }

  /** Body session carrying the anchor, its candidate and explicit terminal records. */
  function operationSession(records: readonly OperationEvent[]): BodySessionLike {
    return {
      id: 'session-mvu',
      header: { version: 4 },
      events: [
        {
          type: 'assistant/message',
          seq: 0,
          time: 1000,
          data: { message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'old body' }] } },
        },
        {
          type: BODY_EVENT_TYPE,
          seq: 1,
          time: 1100,
          data: { op: 'candidate', groupId: 'message-1', messageId: 'message-1', index: 0 },
        },
        ...records,
      ],
      surface: { nodes: [0] },
      append: () => 0,
    }
  }

  it('reports the latest aborted operation on GET body', async () => {
    const session = operationSession([
      {
        type: 'plugin:dsh-soulmojito/body-settled',
        seq: 2,
        time: 1200,
        data: {
          op: 'op-settle-cancelled',
          opId: 'op-1',
          groupId: 'message-1',
          anchorId: 'message-1',
          index: 0,
          reason: 'settlement hide failed',
        },
      },
      {
        type: BODY_EVENT_TYPE,
        seq: 3,
        time: 1300,
        data: { op: 'op-finish', opId: 'op-1', result: 'failed', reason: 'settlement failed' },
      },
      {
        type: BODY_ABORT_EVENT_TYPE,
        seq: 4,
        time: 1400,
        data: { op: 'op-abort', opId: 'op-1', reason: 'previous body restored' },
      },
    ])

    const result = await callBodyGet(plainCharacter(), projectedChat('old body'), fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body['lastOperation']).toEqual({
      opId: 'op-1',
      status: 'aborted',
      reason: 'previous body restored',
      at: 1400,
    })
  })

  it('omits lastOperation when no terminal failure is recorded', async () => {
    const session = bodySession('message-1', 'old body', 'message-1', [0])

    const result = await callBodyGet(plainCharacter(), projectedChat('old body'), fakeAgent(session), 'session-mvu', 'message-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, text: 'old body' })
    expect(result.body['lastOperation']).toBeUndefined()
  })

  it('degrades a malformed abort record to a logged warning instead of a 500', async () => {
    hostState.module = hostRecordModule()
    const session = operationSession([
      {
        type: BODY_ABORT_EVENT_TYPE,
        seq: 2,
        time: 1200,
        data: { op: 'op-abort', opId: '', reason: 'previous body restored' },
      },
    ])
    const capture = captureLogger()
    const agent = fakeAgent(session)
    const ctx = {
      agents: { get: (id: string) => id === 'session-mvu' ? agent : undefined },
      logger: capture.logger,
    } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
    const res = makeResponse()
    const url = new URL('/api/dsh-soulmojito/body?sessionId=session-mvu&messageId=message-1', 'http://localhost')
    await handleAgentTavernBodyApi(
      ctx,
      mutationDb(plainCharacter(), projectedChat('old body')),
      makeRequest(undefined, 'GET', `${url.pathname}${url.search}`),
      res,
      url,
      'body',
      'GET',
    )
    const body = JSON.parse(res.chunks.join('')) as Record<string, unknown>

    expect(res.statusCode).toBe(200)
    expect(body['ok']).toBe(true)
    expect(body['lastOperation']).toBeUndefined()
    expect(capture.warnings.some((args) => String(args[0]).includes('ledger fold failed'))).toBe(true)
  })
})

describe('GET body log degradation', () => {
  function sessionWithRawEvent(raw: unknown): BodySessionLike {
    const base = bodySession('message-1', 'old body', 'message-1', [0])
    return {
      ...base,
      events: [...(base.events as readonly unknown[]), raw],
    } as unknown as BodySessionLike
  }

  it('keeps the body read usable when an unrelated event has non-object data', async () => {
    const session = sessionWithRawEvent({ type: 'tool/result', seq: 2, data: 'not-an-object' })
    const capture = captureLogger()

    const result = await callBodyGet(
      plainCharacter(),
      projectedChat('old body'),
      fakeAgent(session),
      'session-mvu',
      'message-1',
      capture.logger,
    )

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, text: 'old body', canEdit: true })
    expect(result.body['reason']).toBeUndefined()
    const warning = capture.warnings.find((args) => String(args[0]).includes('ledger fold failed'))
    expect(warning).toBeDefined()
    expect(JSON.stringify(warning?.[1])).toContain('invalid-session-event')
  })

  it('reports a malformed body event by code instead of borrowing session-busy', async () => {
    const session = sessionWithRawEvent({ type: BODY_EVENT_TYPE, seq: 2, data: 'not-an-object' })
    const capture = captureLogger()

    const result = await callBodyGet(
      plainCharacter(),
      projectedChat('old body'),
      fakeAgent(session),
      'session-mvu',
      'message-1',
      capture.logger,
    )

    // The stable row still renders; the ledger fold is skipped because a body
    // record is missing, and the warning names the code.
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, text: 'old body' })
    expect(result.body['reason']).not.toBe('session-busy')
    const warning = capture.warnings.find((args) => String(args[0]).includes('ledger fold failed'))
    expect(warning).toBeDefined()
    expect(JSON.stringify(warning?.[1])).toContain('invalid-body-event')
    expect(JSON.stringify(warning?.[1])).toContain('object data payload')
  })

  /** Two floors sharing one `agentTavern.messageId`, in distinct groups. */
  function duplicateMessageIdChat(): ChatLogIR {
    const chat = projectedChat('old body')
    chat.messages.push({
      name: 'character',
      is_user: false,
      is_system: false,
      send_date: '',
      mes: 'stray copy',
      swipe_id: 0,
      swipes: ['stray copy'],
      extra: {
        agentTavern: { messageId: 'message-1', anchorMessageId: 'group-b', bodyGroupId: 'group-b' },
      },
    })
    return chat
  }

  it('clears the floor degradation for a row whose group-hinted reread resolves one floor', async () => {
    // The by-message lookup is ambiguous, but the ledger's group id still owns
    // exactly one floor: the successful reread must clear the degradation
    // instead of pinning the row on projectionPending forever.
    const session = groupedBodySession([
      { groupId: 'message-1', candidates: [{ messageId: 'message-1', text: 'old body' }] },
    ])
    const capture = captureLogger()

    const result = await callBodyGet(
      plainCharacter(),
      duplicateMessageIdChat(),
      fakeAgent(session),
      'session-mvu',
      'message-1',
      capture.logger,
    )

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, text: 'old body' })
    expect(result.body['detail']).toBeUndefined()
    expect(result.body['projectionPending']).toBeUndefined()
    expect(capture.warnings.filter((args) => String(args[0]).includes('ambiguous'))).toEqual([])
  })

  it('still publishes the degradation when no ledger exists to re-resolve the floor', async () => {
    const capture = captureLogger()

    const result = await callBodyGet(
      plainCharacter(),
      duplicateMessageIdChat(),
      fakeAgent(fakeSession('session-mvu', [])),
      'session-mvu',
      'message-1',
      capture.logger,
    )

    expect(result.status).toBe(200)
    expect(result.body['detail']).toBe('body-group-mismatch')
    expect(result.body['projectionPending']).toBe(true)
    expect(capture.warnings.some((args) => String(args[0]).includes('ambiguous'))).toBe(true)
  })
})

describe('body view policy', () => {
  it('prefers JSONL display text and enables actions for an idle eligible anchor', () => {
    const agent = fakeAgent(fakeSession('session-view'))
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent,
      hostSupported: true,
      stateSafety: undefined,
      historicalMvuState: false,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'raw message text',
      projected: { text: 'display text', count: 1, selectedIndex: 0 },
      inspection: { onSurface: true, last: true },
    })
    expect(view.text).toBe('display text')
    expect(view.hidden).toBe(false)
    expect(view.canEdit).toBe(true)
    expect(view.canRegenerate).toBe(true)
    expect(view.canSelect).toBe(false)
  })

  it('closes edit and publishes every candidate receipt detail', () => {
    for (const detail of [
      'body-receipt-missing',
      'body-receipt-duplicate',
      'body-receipt-legacy',
      'body-receipt-key-mismatch',
    ] as const) {
      const view = buildBodyView({
        messageId: 'message-1',
        binding: { architecture: 'agent-tavern' },
        agent: fakeAgent(fakeSession('session-view-receipt')),
        hostSupported: true,
        stateSafety: { safe: true },
        historicalMvuState: true,
        writeRollbackAvailable: true,
        ledger: undefined,
        messageText: 'body',
        projected: { text: 'body', count: 1, selectedIndex: 0 },
        inspection: { onSurface: true, last: true },
        editDetail: detail,
      })
      expect(view).toMatchObject({
        canEdit: false,
        canRegenerate: true,
        canSelect: false,
        detail,
      })
    }
  })

  it('closes regeneration for a degraded read because the floor binding is a guess', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view-degraded')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: false,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'body',
      projected: { text: 'body', count: 1, selectedIndex: 0 },
      inspection: { onSurface: true, last: true },
      readDetail: 'body-group-mismatch',
    })
    expect(view.canEdit).toBe(false)
    expect(view.canRegenerate).toBe(false)
    expect(view.detail).toBe('body-group-mismatch')
  })

  it('lets a caller-derived edit gate outrank the receipt detail', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view-receipt-gate')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: true,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'body',
      projected: { text: 'body', count: 1, selectedIndex: 0 },
      inspection: { onSurface: true, last: true },
      editDetail: 'body-receipt-missing',
      canEditDetail: 'body-receipt-legacy',
    })
    expect(view).toMatchObject({ canEdit: false, detail: 'body-receipt-legacy' })
  })

  it('closes edit and publishes the floor-binding detail of a degraded read', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view-floor')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: false,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'body',
      projected: { text: 'body', count: 1, selectedIndex: 0 },
      projectionCurrent: false,
      projectionTextCurrent: false,
      inspection: { onSurface: true, last: true },
      readDetail: 'body-group-mismatch',
    })
    expect(view).toMatchObject({
      canEdit: false,
      projectionPending: true,
      detail: 'body-group-mismatch',
    })
  })

  it('keeps the degraded-read detail when another reason already gates the row', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: undefined,
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: false,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'body',
      projected: undefined,
      inspection: undefined,
      readDetail: 'body-floor-unreadable',
    })
    expect(view).toMatchObject({
      canEdit: false,
      reason: 'session-busy',
      detail: 'body-floor-unreadable',
    })
  })

  it('does not borrow session-busy when the session surface is unreadable', () => {
    const view = buildBodyView({
      messageId: 'message-1',
      binding: { architecture: 'agent-tavern' },
      agent: fakeAgent(fakeSession('session-view-no-surface')),
      hostSupported: true,
      stateSafety: { safe: true },
      historicalMvuState: false,
      writeRollbackAvailable: true,
      ledger: undefined,
      messageText: 'raw message text',
      projected: undefined,
      inspection: undefined,
    })
    expect(view.reason).toBe('host-unsupported')
  })

  it('returns a stable empty body without a Tavern binding', () => {
    const view = buildBodyView({
      messageId: 'message-2',
      binding: { architecture: 'st' },
      agent: undefined,
      hostSupported: false,
      stateSafety: undefined,
      historicalMvuState: false,
      writeRollbackAvailable: false,
      ledger: undefined,
      messageText: undefined,
      projected: undefined,
      inspection: undefined,
    })
    expect(view).toMatchObject({
      ok: true,
      hidden: false,
      count: 0,
      text: '',
      canEdit: false,
      canRegenerate: false,
      canSelect: false,
      reason: 'architecture-mismatch',
    })
  })
})

describe('agent tool surface', () => {
  it('exposes no body edit or rollback tool; edits stay on the HTTP route', () => {
    const names = [
      ...characterTools(),
      ...memoryTools(),
      ...variableTools(),
      ...scriptTools(),
      ...deductionTools(),
      ...gameTools(),
    ].map((definition) => definition.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => name.startsWith('body_') || name.startsWith('rollback_') || name === 'edit_body')).toEqual([])
    expect(names).not.toContain('body_edit')
    expect(names).not.toContain('body_select')
  })
})

describe('startup recovery', () => {
  it('returns an empty report on a host without agents.list', async () => {
    const capture = captureLogger()
    await expect(recoverBodyOperations(wiringContext(capture.logger))).resolves.toEqual([])
  })

  it('settles a pending op through finalizeRecoveredOperation and hides trigger/process', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const harness = createRecoveryHarness()
    const seqs = seedPendingRecovery(harness)
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      bindingOf: () => ({ architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' }),
      safetyOf: () => ({ safe: true }),
    }

    const outcome = await recoverBodyOperation(ctx, harness.agent)

    expect(outcome).toMatchObject({ status: 'settled', pending: 1 })
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'op-finish'
      && event.data['result'] === 'ok')).toBe(true)

    // The runtime's own hide step must shadow the trigger and the process node;
    // this is what proves settlement went through finalizeRecoveredOperation
    // instead of the removed wiring-only record splice.
    const hide = harness.events.find((event) => event.type === 'developer/message')
    expect(hide).toBeDefined()
    const surfaceOp = asTestRecord(hide?.opts?.['surfaceOp'])
    const sourceEventSeqs = hide?.opts?.['sourceEventSeqs']
    expect(surfaceOp?.['op']).toBe('replace')
    expect(surfaceOp?.['startSeq']).toBe(seqs.triggerSeq)
    expect(surfaceOp?.['endSeq']).toBe(seqs.processSeq)
    expect(sourceEventSeqs).toEqual([seqs.triggerSeq, seqs.processSeq])

    const surface = harness.surface()
    expect(surface).not.toContain(seqs.triggerSeq)
    expect(surface).not.toContain(seqs.processSeq)
    expect(surface).toContain(seqs.candidateSeq)
    expect(harness.phase.lastTurn).toBe(2)
    expect(harness.events.some((event) => event.type === 'turn/end' && event.data['turn'] === 2)).toBe(true)
  })

  it('skips recovery with zero writes when MVU state safety is unsafe', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const harness = createRecoveryHarness()
    seedPendingRecovery(harness)
    const eventCountBefore = harness.events.length
    const surfaceBefore = harness.surface()
    let safetyCalls = 0
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      bindingOf: () => ({ architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' }),
      safetyOf: () => {
        safetyCalls += 1
        return { safe: false, reason: 'body-state-unsafe', detail: 'card-unreadable' }
      },
    }

    const outcome = await recoverBodyOperation(ctx, harness.agent)

    expect(safetyCalls).toBe(1)
    expect(outcome).toMatchObject({ status: 'skipped', pending: 1, reason: 'body-state-unsafe' })
    expect(harness.events).toHaveLength(eventCountBefore)
    expect(harness.surface()).toEqual(surfaceBefore)
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-finish')).toBe(false)
    expect(harness.phase.lastTurn).toBe(0)
    expect(capture.warnings.some((args) => String(args[0]).includes('MVU state cannot be rolled back safely'))).toBe(true)
  })

  it('restores a failed op without adding an assistant message or touching the JSONL floor', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const harness = createRecoveryHarness()
    const seqs = seedPendingRecoveryWithoutCandidate(harness)
    const chat = projectedChat('old body')
    const chatBefore = JSON.stringify(chat)
    rollbackState.store = rollbackDb(plainCharacter(), chat, 'session-recovery')
    rollbackState.memories = { read: async () => undefined }
    rollbackState.variables = { get: async () => undefined }
    const ctx: BodyWiringContext = {
      logger: capture.logger,
      bindingOf: () => ({ architecture: 'agent-tavern', character: 'Character', chatId: 'chat.jsonl' }),
      safetyOf: () => ({ safe: true }),
    }

    const outcome = await recoverBodyOperation(ctx, harness.agent)

    expect(outcome).toMatchObject({ status: 'restored', pending: 1 })
    // The old anchor stays visible; recovery adds no model-visible message and
    // records no restore event, so the JSONL floor and swipes stay identical.
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'restore')).toBe(false)
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(chat)).toBe(chatBefore)
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]).toMatchObject({ mes: 'old body', swipe_id: 0, swipes: ['old body'] })
    const surface = harness.surface()
    expect(surface).toContain(seqs.anchorSeq)
    expect(surface).not.toContain(seqs.triggerSeq)
    expect(surface).not.toContain(seqs.processSeq)
    expect(harness.events.some((event) => event.type === BODY_ABORT_EVENT_TYPE
      && event.data['reason'] !== undefined)).toBe(true)

    // C2: the next recovery pass must be a no-op. Without the terminal abort
    // record the op would stay pending and a restart would append a duplicate.
    const assistantsAfterFirst = harness.events.filter((event) => event.type === 'assistant/message').length
    const second = await recoverBodyOperation(ctx, harness.agent)
    expect(second).toMatchObject({ status: 'clean', pending: 0 })
    expect(harness.events.filter((event) => event.type === 'assistant/message')).toHaveLength(assistantsAfterFirst)
    expect(harness.events.filter((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'restore')).toHaveLength(0)
  })
})

/* ---------------------- live turn/end failure restore ---------------------- */

describe('live turn/end failure restore', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const [agentId, op] of [...pendingByAgent.entries()]) {
      pendingByAgent.delete(agentId)
      op.release()
    }
  })

  async function startPendingBodyOp(harness: RegenerateHarness, sessionId: string): Promise<string> {
    const result = await callBodyRegenerate(plainCharacter(), projectedChat('old body'), harness, sessionId)
    expect(result.status).toBe(202)
    const trigger = asTestRecord(harness.followups[0])
    const triggerId = typeof trigger?.['id'] === 'string' ? trigger['id'] : undefined
    if (triggerId === undefined) throw new Error('body regenerate did not expose a trigger message id')
    return triggerId
  }

  function turnEndReason(kind: string): Record<string, unknown> {
    return kind === 'error'
      ? { kind, error: { message: 'model failed', code: 'TEST' } }
      : { kind }
  }

  function turnEndEvent(turn: number, kind: string): Record<string, unknown> {
    return { type: 'turn/end', data: { turn, reason: turnEndReason(kind) } }
  }

  function appendFailedBodyTurn(
    harness: RegenerateHarness,
    turn: number,
    triggerId: string,
    kind: string,
  ): { triggerSeq: number; processSeq: number } {
    harness.session.append('turn/start', { turn })
    harness.session.append('step/start', { turn, step: 1 })
    const triggerSeq = harness.events.length
    harness.session.append('user/message', {
      id: triggerId,
      role: 'user',
      content: [{ type: 'text', text: 'regenerate' }],
    }, { surfaceOp: 'append' })
    const processSeq = harness.events.length
    harness.session.append('tool/result', {
      turn,
      step: 1,
      message: { id: `process-${turn}`, role: 'tool', content: [{ type: 'text', text: 'ok' }] },
    }, { surfaceOp: 'append' })
    harness.session.append('step/end', { turn, step: 1 })
    harness.session.append('turn/end', { turn, reason: turnEndReason(kind) })
    return { triggerSeq, processSeq }
  }

  function failureRestoreContext(
    harness: RegenerateHarness,
    sessionId: string,
    logger: CapturedLogger['logger'],
  ): BodyWiringContext {
    return {
      logger,
      agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
    } as unknown as BodyWiringContext
  }

  function flushTurnEndRestore(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, 0) })
  }

  function retryLogs(capture: CapturedLogger): unknown[][] {
    return capture.warnings.filter((args) => String(args[0]).includes('turn/end restore failed; retrying'))
  }

  function finalFailureLogs(capture: CapturedLogger): unknown[][] {
    return capture.errors.filter((args) =>
      String(args[0]).includes('turn/end restore failed; op-start stays pending'))
  }

  function openBlockingTurn(harness: RegenerateHarness, turn: number): void {
    harness.session.append('turn/start', { turn })
    harness.session.append('step/start', { turn, step: 1 })
  }

  function closeBlockingTurn(harness: RegenerateHarness, turn: number): void {
    harness.session.append('step/end', { turn, step: 1 })
    harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it.each(['error', 'cancelled', 'aborted'])(
    'restores the previous body once after a %s turn/end',
    async (kind) => {
      hostState.module = hostRecordModule()
      const capture = captureLogger()
      const sessionId = `session-turn-end-${kind}`
      const harness = createRegenerateHarness('old body', [], sessionId)
      const triggerId = await startPendingBodyOp(harness, sessionId)
      const turn = 2
      const seqs = appendFailedBodyTurn(harness, turn, triggerId, kind)
      const anchorSeq = harness.events.find((event) =>
        asTestRecord(event.data['message'])?.['id'] === 'message-1')?.seq
      expect(anchorSeq).toBeDefined()

      const ctx = failureRestoreContext(harness, sessionId, capture.logger)
      const before = harness.events.length
      handleBodySessionEvent(ctx, harness.session, turnEndEvent(turn, kind))

      // The listener only registers the edge: nothing is appended synchronously.
      expect(harness.events).toHaveLength(before)

      await vi.waitFor(() => {
        expect(pendingByAgent.has(sessionId)).toBe(false)
      })

      const hide = harness.events.find((event) =>
        event.type === 'developer/message' && testNumber(event.data['turn']) === 3)
      expect(hide).toBeDefined()
      expect(asTestRecord(hide?.opts?.['surfaceOp'])).toMatchObject({
        op: 'replace',
        startSeq: seqs.triggerSeq,
        endSeq: seqs.processSeq,
      })
      expect(harness.surface()).not.toContain(seqs.triggerSeq)
      expect(harness.surface()).not.toContain(seqs.processSeq)
      const restoredSeq = harness.events.find((event) =>
        String(asTestRecord(event.data['message'])?.['id']).startsWith('body-restore-'))?.seq
      expect(restoredSeq).toBeDefined()
      expect(harness.surface()).toContain(restoredSeq)
      expect(harness.surface()).not.toContain(anchorSeq)
    },
  )

  it('does not restore a completed turn/end', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-completed'
    const harness = createRegenerateHarness('old body', [], sessionId)
    await startPendingBodyOp(harness, sessionId)
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)
    const before = harness.events.length

    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'completed'))
    await flushTurnEndRestore()

    expect(harness.events).toHaveLength(before)
    expect(pendingByAgent.has(sessionId)).toBe(true)
    expect(capture.errors).toHaveLength(0)
  })

  it('finishes a deferred settlement after the answer turn ends', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-settle-after-turn'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    const ctx = {
      logger: capture.logger,
      bindingOf: () => ({ architecture: 'agent-tavern' }),
      agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
    } as unknown as BodyWiringContext

    harness.session.append('turn/start', { turn: 3 })
    harness.session.append('step/start', { turn: 3, step: 1 })
    const triggerSeq = harness.session.append('user/message', {
      id: triggerId,
      role: 'user',
      content: [{ type: 'text', text: 'regenerate' }],
    }, { surfaceOp: 'append' })
    const bodySeq = harness.session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: {
        id: 'new-body',
        role: 'assistant',
        content: [{ type: 'text', text: 'new body' }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    }, { surfaceOp: 'append' })
    harness.session.append('step/end', { turn: 3, step: 1 })

    // Turn-stopping selects the new body but leaves the trigger/process hide to
    // the post-turn completion; the answer step must stay the turn's last step.
    await handleBodyTurnStopping(ctx, { agentId: sessionId, turn: 3 })
    expect(harness.surface()).toContain(triggerSeq)
    expect(harness.events.some((event) => event.type === 'developer/message'
      && testNumber(event.data['turn']) === 3)).toBe(false)
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'op-finish')).toBe(false)

    harness.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    handleBodySessionEvent(ctx, harness.session, turnEndEvent(3, 'completed'))
    await vi.advanceTimersByTimeAsync(0)

    expect(pendingByAgent.has(sessionId)).toBe(false)
    expect(harness.surface()).not.toContain(triggerSeq)
    expect(harness.surface()).toContain(bodySeq)
    const finish = harness.events.find((event) => event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-finish')
    expect(finish?.data).toMatchObject({ result: 'ok', anchorId: 'new-body' })
    const hides = harness.events.filter((event) => event.type === 'developer/message'
      && testNumber(event.data['turn']) === 4)
    expect(hides).toHaveLength(1)
  })

  it('collapses duplicate turn/end edges into one restore', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-duplicate'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    const seqs = appendFailedBodyTurn(harness, 2, triggerId, 'error')
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)

    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))

    await vi.waitFor(() => {
      expect(pendingByAgent.has(sessionId)).toBe(false)
    })

    const bridgeTurns = harness.events.filter((event) =>
      event.type === 'turn/start' && testNumber(event.data['turn']) === 3)
    expect(bridgeTurns).toHaveLength(1)
    const hides = harness.events.filter((event) =>
      event.type === 'developer/message' && testNumber(event.data['turn']) === 3)
    expect(hides).toHaveLength(1)
    expect(harness.surface()).not.toContain(seqs.triggerSeq)
    expect(harness.surface()).not.toContain(seqs.processSeq)

    // A later duplicate after the operation ended is a no-op too.
    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    await flushTurnEndRestore()
    expect(harness.events.filter((event) =>
      event.type === 'turn/start' && testNumber(event.data['turn']) === 3)).toHaveLength(1)
  })

  it('keeps op-start pending after the bounded retries are exhausted', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-restore-failure'
    const harness = createRegenerateHarness('old body', [], sessionId)
    await startPendingBodyOp(harness, sessionId)

    // Leave a turn open in the log so restoreBodyAfterFailure refuses with
    // session-busy before touching the surface.
    openBlockingTurn(harness, 2)
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)

    expect(() => {
      handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    }).not.toThrow()

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(250)

    expect(retryLogs(capture)).toHaveLength(2)
    expect(finalFailureLogs(capture)).toHaveLength(1)
    expect(finalFailureLogs(capture)[0]?.[1]).toMatchObject({ attempts: 3, code: 'session-busy' })
    expect(vi.getTimerCount()).toBe(0)
    expect(pendingByAgent.has(sessionId)).toBe(true)
    expect(harness.events.some((event) =>
      event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-start')).toBe(true)
    expect(harness.events.some((event) =>
      event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-finish')).toBe(false)
    expect(harness.events.some((event) =>
      event.type === 'developer/message' && testNumber(event.data['turn']) === 3)).toBe(false)
  })

  it('retries after session-busy and clears the chain on success', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-retry-success'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    const seqs = appendFailedBodyTurn(harness, 2, triggerId, 'error')
    openBlockingTurn(harness, 3)
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)
    const anchorSeq = harness.events.find((event) =>
      asTestRecord(event.data['message'])?.['id'] === 'message-1')?.seq
    expect(anchorSeq).toBeDefined()

    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(retryLogs(capture)).toHaveLength(1)

    // The host loop reached idle before the 50 ms retry: the second attempt
    // must restore the old body without a final host-unsupported failure.
    closeBlockingTurn(harness, 3)
    await vi.advanceTimersByTimeAsync(50)

    expect(pendingByAgent.has(sessionId)).toBe(false)
    expect(retryLogs(capture)).toHaveLength(1)
    expect(finalFailureLogs(capture)).toHaveLength(0)
    expect(capture.infos.filter((args) =>
      String(args[0]).includes('turn/end restored the previous body'))).toHaveLength(1)
    const hides = harness.events.filter((event) =>
      event.type === 'developer/message' && testNumber(event.data['turn']) === 4)
    expect(hides).toHaveLength(1)
    expect(harness.surface()).not.toContain(seqs.triggerSeq)
    expect(harness.surface()).not.toContain(seqs.processSeq)
    const restoredSeq = harness.events.find((event) =>
      String(asTestRecord(event.data['message'])?.['id']).startsWith('body-restore-'))?.seq
    expect(restoredSeq).toBeDefined()
    expect(harness.surface()).toContain(restoredSeq)
    expect(harness.surface()).not.toContain(anchorSeq)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries host-unsupported once the host turn base is writable again', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-retry-host'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    appendFailedBodyTurn(harness, 2, triggerId, 'error')
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)

    // A running loop cannot advance its turn base; the restore refuses with
    // host-unsupported until the loop is back at idle.
    harness.agent.phase.kind = 'running'
    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(retryLogs(capture)).toHaveLength(1)
    expect(retryLogs(capture)[0]?.[1]).toMatchObject({ code: 'host-unsupported' })

    harness.agent.phase.kind = 'idle'
    await vi.advanceTimersByTimeAsync(50)

    expect(pendingByAgent.has(sessionId)).toBe(false)
    expect(finalFailureLogs(capture)).toHaveLength(0)
    expect(capture.infos.filter((args) =>
      String(args[0]).includes('turn/end restored the previous body'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a single chain when duplicate turn/end edges arrive during a retry', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-retry-duplicate'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    appendFailedBodyTurn(harness, 2, triggerId, 'error')
    openBlockingTurn(harness, 3)
    const ctx = failureRestoreContext(harness, sessionId, capture.logger)

    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(retryLogs(capture)).toHaveLength(1)

    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    handleBodySessionEvent(ctx, harness.session, turnEndEvent(2, 'error'))
    closeBlockingTurn(harness, 3)
    await vi.advanceTimersByTimeAsync(50)

    expect(retryLogs(capture)).toHaveLength(1)
    expect(capture.infos.filter((args) =>
      String(args[0]).includes('turn/end restored the previous body'))).toHaveLength(1)
    expect(harness.events.filter((event) =>
      event.type === 'turn/start' && testNumber(event.data['turn']) === 4)).toHaveLength(1)
    expect(harness.events.filter((event) =>
      event.type === 'developer/message' && testNumber(event.data['turn']) === 4)).toHaveLength(1)
    expect(finalFailureLogs(capture)).toHaveLength(0)
  })

  it('cancels queued retries when the plugin fiber unloads', async () => {
    vi.useFakeTimers()
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-turn-end-unload'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const triggerId = await startPendingBodyOp(harness, sessionId)
    appendFailedBodyTurn(harness, 2, triggerId, 'error')
    openBlockingTurn(harness, 3)

    const listeners = new Map<string, (session?: unknown, event?: unknown) => unknown>()
    const effects: Array<() => (() => void) | void> = []
    const ctx = {
      logger: capture.logger,
      agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
      on: (event: string, listener: (session?: unknown, event?: unknown) => unknown) => {
        listeners.set(event, listener)
        return () => undefined
      },
      effect: (callback: () => (() => void) | void) => {
        effects.push(callback)
        return undefined
      },
    } as unknown as BodyWiringContext
    const dispose = registerBodyTurnStopping(ctx)
    expect(dispose).toBeTypeOf('function')
    const listener = listeners.get('session/event')
    expect(listener).toBeDefined()

    listener!(harness.session, turnEndEvent(2, 'error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(retryLogs(capture)).toHaveLength(1)
    const eventsBeforeUnload = harness.events.length

    expect(effects).toHaveLength(1)
    const cleanup = effects[0]!()
    expect(cleanup).toBeTypeOf('function')
    cleanup!()
    await vi.advanceTimersByTimeAsync(1000)

    expect(harness.events).toHaveLength(eventsBeforeUnload)
    expect(pendingByAgent.has(sessionId)).toBe(true)
    expect(finalFailureLogs(capture)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('subscribes the session/event failure edge alongside turn-stopping', () => {
    const capture = captureLogger()
    const registered: string[] = []
    const disposed: string[] = []
    const ctx = {
      logger: capture.logger,
      agents: { get: () => undefined },
      on: (event: string) => {
        registered.push(event)
        return () => { disposed.push(event) }
      },
    } as unknown as BodyWiringContext

    const dispose = registerBodyTurnStopping(ctx)

    expect(registered).toEqual(['agent/turn-stopping', 'session/event'])
    expect(dispose).toBeTypeOf('function')
    dispose!()
    dispose!()
    expect(disposed).toEqual(['agent/turn-stopping', 'session/event'])
  })
})

/* ------------- regenerate start-failure recovery retry (review M4) --------- */

describe('regenerate start-failure recovery retry', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const [agentId, op] of [...pendingByAgent.entries()]) {
      pendingByAgent.delete(agentId)
      op.release()
    }
  })

  /**
   * Rollback store whose chat reads fail while the flag is active, so the
   * compensation inside `startRegenerate`'s catch fails after `followup`
   * rejects. `readsRemaining` bounds the failure for the transient case.
   */
  function flakyRollbackStore(
    character: CharacterCardIR,
    chat: ChatLogIR,
    sessionId: string,
    failing: { active: boolean; readsRemaining: number },
  ): Record<string, unknown> {
    const base = rollbackDb(character, chat, sessionId)
    return {
      ...base,
      getChatSnapshot: async () => {
        if (failing.active && failing.readsRemaining > 0) {
          failing.readsRemaining -= 1
          throw new Error("EACCES: permission denied, open 'C:\\secrets\\chat.jsonl'")
        }
        return (base.getChatSnapshot as () => Promise<unknown>)()
      },
    }
  }

  /** Make the trigger `followup` fail after the operation started, tripping the store failure window. */
  function failFollowupAfterStart(harness: RegenerateHarness, trip: () => void): void {
    harness.agent.followup = () => {
      trip()
      return Promise.reject(new Error('host refused the trigger turn'))
    }
  }

  async function callStartFailureRegenerate(
    harness: RegenerateHarness,
    sessionId: string,
    logger: CapturedLogger['logger'],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    hostState.module = hostRecordModule()
    const res = makeResponse()
    const ctx = {
      agents: { get: (id: string) => id === sessionId ? harness.agent : undefined },
      logger,
    } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
    await handleAgentTavernBodyApi(
      ctx,
      mutationDbFor(sessionId, plainCharacter(), projectedChat('old body')),
      makeRequest({
        sessionId,
        messageId: 'message-1',
        groupId: 'message-1',
        expectedAnchorId: 'message-1',
        expectedIndex: 0,
      }, 'POST', '/api/dsh-soulmojito/body/regenerate'),
      res,
      new URL('/api/dsh-soulmojito/body/regenerate', 'http://localhost'),
      'body/regenerate',
      'POST',
    )
    return {
      status: res.statusCode,
      body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : {},
    }
  }

  function retryingLogs(capture: CapturedLogger): unknown[][] {
    return capture.warnings.filter((args) => String(args[0]).includes('retrying recovery'))
  }

  it('retries the recovery once and surfaces the pending op handle when the restore keeps failing', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-start-fail-locked'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const failing = { active: false, readsRemaining: 0 }
    rollbackState.store = flakyRollbackStore(plainCharacter(), projectedChat('old body'), sessionId, failing)
    rollbackState.memories = { read: async () => undefined }
    rollbackState.variables = { get: async () => undefined }
    failFollowupAfterStart(harness, () => {
      failing.active = true
      failing.readsRemaining = Number.POSITIVE_INFINITY
    })

    const result = await callStartFailureRegenerate(harness, sessionId, capture.logger)

    // The start failed and the compensation failed with it; the message embeds
    // a filesystem path, so the outbound copy must collapse at the boundary.
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, code: 'operation-failed' })
    expect(result.body['message']).toBe('internal storage error')
    expect(JSON.stringify(result.body)).not.toContain('secrets')
    expect(JSON.stringify(result.body)).not.toContain('chat.jsonl')

    // M4: one bounded in-process retry handed the operation to the shared
    // recovery; the store is still broken, so the op stays pending and the
    // response carries its durable handle instead of hiding the lock.
    expect(retryingLogs(capture)).toHaveLength(1)
    const opId = harness.events.find((event) =>
      event.type === BODY_EVENT_TYPE && event.data['op'] === 'op-start')?.data['opId']
    expect(opId).toBeDefined()
    expect(result.body['pendingOperation']).toEqual({ opId, status: 'pending' })
    expect(capture.errors.filter((args) =>
      String(args[0]).includes('left op') && String(args[0]).includes(String(opId)))).toHaveLength(1)

    // Fail-closed lock: the writes are not restored yet, so the operation must
    // stay in pendingByAgent with no terminal record; startup recovery still
    // owns the durable op-start + plan.
    expect(pendingByAgent.has(sessionId)).toBe(true)
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'op-finish')).toBe(false)
    expect(harness.events.some((event) => event.type === BODY_ABORT_EVENT_TYPE)).toBe(false)

    // A client that retries the regenerate sees the lock, not a silent 500.
    const retry = await callStartFailureRegenerate(harness, sessionId, capture.logger)
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({ ok: false, code: 'session-busy' })
  })

  it('unlocks the session when the retry recovery completes the restore', async () => {
    hostState.module = hostRecordModule()
    const capture = captureLogger()
    const sessionId = 'session-start-fail-recovered'
    const harness = createRegenerateHarness('old body', [], sessionId)
    const failing = { active: false, readsRemaining: 0 }
    rollbackState.store = flakyRollbackStore(plainCharacter(), projectedChat('old body'), sessionId, failing)
    rollbackState.memories = { read: async () => undefined }
    rollbackState.variables = { get: async () => undefined }
    // The compensation fails exactly once; the delayed recovery retry then
    // reads a healthy store and finishes the restore.
    failFollowupAfterStart(harness, () => {
      failing.active = true
      failing.readsRemaining = 1
    })

    const result = await callStartFailureRegenerate(harness, sessionId, capture.logger)

    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, code: 'operation-failed', message: 'internal storage error' })
    expect(result.body['pendingOperation']).toBeUndefined()
    expect(retryingLogs(capture)).toHaveLength(1)
    expect(capture.infos.filter((args) => String(args[0]).includes('closed op'))).toHaveLength(1)

    // The shared recovery did the full restore: bridge-turn copy of the old
    // body, terminal op-abort, and the pendingByAgent lock released.
    expect(pendingByAgent.has(sessionId)).toBe(false)
    const restoredSeq = harness.events.find((event) =>
      String(asTestRecord(event.data['message'])?.['id']).startsWith('body-restore-'))?.seq
    expect(restoredSeq).toBeDefined()
    expect(harness.surface()).toContain(restoredSeq)
    expect(harness.events.some((event) => event.type === BODY_ABORT_EVENT_TYPE)).toBe(true)
    expect(harness.events.some((event) => event.type === BODY_EVENT_TYPE
      && event.data['op'] === 'op-finish')).toBe(false)

    // Pre-fix this second request was rejected as session-busy with no handle;
    // after the retry the lock is gone and a new regenerate is judged on its
    // own merits (here: the restored copy replaced the hidden anchor).
    harness.agent.followup = (message: unknown) => { harness.followups.push(message) }
    failing.active = false
    failing.readsRemaining = 0
    const retry = await callStartFailureRegenerate(harness, sessionId, capture.logger)
    expect(retry.body['code']).not.toBe('session-busy')
  })
})
