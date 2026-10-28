/**
 * Body wiring regression (proposal 0021 §2.5, §6.1, §7.3, §9).
 *
 * These tests use fake host values only: the plugin-record seam is injected
 * through the bind package mock, the event bus is a captured listener, and no
 * real @deepseek-ai/dsh-session or Tavern store is opened.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CharacterCardIR, ChatLogIR } from '../../tavern-format/src/index.js'
import type { TavernStore } from '../../tavern-store/src/index.js'

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
  handleBodyTurnStopping,
  recoverBodyOperation,
  recoverBodyOperations,
  registerBodyProjection,
  registerBodyTurnStopping,
  resolveBodyRecordWriter,
} = await import('../src/agent-tavern/body-wiring.js')
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
    expect(bodyMutationSafetyOf('edit', character, chat)).toMatchObject({
      safe: false,
      reason: 'body-state-unsafe',
      detail: 'edit-rollback-unavailable',
    })
    expect(bodyMutationSafetyOf('select', character, chat)).toMatchObject({
      safe: false,
      reason: 'body-state-unsafe',
      detail: 'select-rollback-unavailable',
    })
  })

  it('treats chat variables.stat_data as edit/select-only history', () => {
    const character = { card: plainCharacter() }
    const chat = fakeChat({ variables: { stat_data: {} } })
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(true)
    expect(bodyMutationSafetyOf('edit', character, chat)).toMatchObject({ detail: 'edit-rollback-unavailable' })
    expect(bodyMutationSafetyOf('regenerate', character, chat)).toEqual({ safe: true })
  })

  it('treats chat mvu.receipts as edit/select-only history', () => {
    const character = { card: plainCharacter() }
    const chat = fakeChat({ mvu: { receipts: [{ at: 't', turnKey: 'k' }] } })
    expect(bodyStateSafetyOf(character, chat)).toEqual({ safe: true })
    expect(bodyHistoricalMvuStateOf(character, chat)).toBe(true)
    expect(bodyMutationSafetyOf('select', character, chat)).toMatchObject({ detail: 'select-rollback-unavailable' })
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

  it('returns 409 edit-rollback-unavailable from a PUT before touching the agent', async () => {
    const mvu = await callBodyMutation(mvuCharacter(), fakeChat({}))
    expect(mvu.status).toBe(409)
    expect(mvu.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'edit-rollback-unavailable',
    })
    expect(String(mvu.body['message'])).toContain('rollback')
  })

  it('returns 409 select-rollback-unavailable from a select', async () => {
    const result = await callBodySelect(mvuCharacter(), fakeChat({}))
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({
      ok: false,
      code: 'body-state-unsafe',
      detail: 'select-rollback-unavailable',
    })
  })

  it('keeps edit refused when the chat only carries stat_data or receipts', async () => {
    const stat = await callBodyMutation(plainCharacter(), fakeChat({ variables: { stat_data: {} } }))
    expect(stat).toMatchObject({ status: 409, body: { code: 'body-state-unsafe', detail: 'edit-rollback-unavailable' } })

    const receipts = await callBodyMutation(plainCharacter(), fakeChat({ mvu: { receipts: [{ at: 't' }] } }))
    expect(receipts).toMatchObject({ status: 409, body: { code: 'body-state-unsafe', detail: 'edit-rollback-unavailable' } })
  })

  it('lets a plain card pass the safety gate (later fails on the missing live agent)', async () => {
    const result = await callBodyMutation(plainCharacter(), fakeChat({}))
    expect(result.status).toBe(409)
    expect(result.body['code']).toBe('session-busy')
  })

  it('keeps body text readable while allowing regenerate and refusing edit/select for an MVU GET view', async () => {
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
      canEdit: false,
      canRegenerate: true,
      canSelect: false,
      reason: 'edit-rollback-unavailable',
    })
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
      canEdit: false,
      canRegenerate: false,
      canSelect: false,
      reason: 'write-journal-unavailable',
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
    expect(harness.surface()).not.toContain(anchorSeq)
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
})
