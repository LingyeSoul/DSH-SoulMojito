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

const { BODY_EVENT_TYPE, bodyRuntimeError } = await import('../src/agent-tavern/body-runtime.js')
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

async function callBodyGet(
  character: CharacterCardIR,
  chat: ChatLogIR,
  agent: BodyAgentLike,
  sessionId: string,
  messageId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  hostState.module = hostRecordModule()
  const res = makeResponse()
  const ctx = {
    agents: { get: (id: string) => id === sessionId ? agent : undefined },
  } as unknown as Parameters<typeof handleAgentTavernBodyApi>[0]
  const url = new URL(
    `/api/dsh-soulmojito/body?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`,
    'http://localhost',
  )
  await handleAgentTavernBodyApi(
    ctx,
    mutationDbFor(sessionId, character, chat),
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
  const res = makeResponse()
  await handleAgentTavernBodyApi(
    {} as unknown as Parameters<typeof handleAgentTavernBodyApi>[0],
    mutationDb(character, chat),
    makeRequest({
      sessionId: 'session-mvu',
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
    // Proposal 0021 §9.5: regeneration no longer hides the old anchor at start.
    expect(harness.surface()).toContain(anchorSeq)
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
      expect(harness.surface()).toContain(anchorSeq)
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
    expect(harness.surface()).toContain(anchorSeq)
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
