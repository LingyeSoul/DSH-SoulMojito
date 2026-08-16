import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = '露西'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeAgent(id: string) {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    id,
    session: {
      events,
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  }
}

function makeRequest(body: unknown) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url: '/api/dsh-tavern/generate',
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function turnStarts(agent: ReturnType<typeof makeAgent>) {
  return agent.session.events.filter((event) => event.type === 'turn/start')
}

describe('internal Tavern session bridge occupation', () => {
  let home: string
  let store: TavernStore
  let handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }>
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let agents: Map<string, ReturnType<typeof makeAgent>>
  let failGeneration = false
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-occupy-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])

    let definition: { handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> } | undefined
    agents = new Map()
    apply({
      systemPrompt: { section: () => {} },
      commands: { register: (def) => { definition = def } },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      llm: {
        stream: async function* () {
          if (failGeneration) throw new Error('test generation failure')
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 89, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: (id: string) => agents.get(id) },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(definition).toBeDefined()
    expect((definition as { name?: string }).name).toBe('dsh-tavern-session')
    handler = definition!.handler
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('appends an occupation turn pair when the host session has no turn/start', async () => {
    const agent = makeAgent('session-a')
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['session-a']).toEqual({ architecture: 'st', character: CHARACTER, chatId })
    const starts = turnStarts(agent)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.data).toEqual({ turn: 1 })
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('is idempotent: repairing an already-occupied session appends no further turns', async () => {
    const agent = makeAgent('session-a')
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'user/message')).toHaveLength(0)
  })

  it('does not pollute a session that already has real host turns', async () => {
    const agent = makeAgent('session-b')
    agent.session.append('turn/start', { turn: 7 })
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
  })

  it('mirrors Tavern generation into the native session trace with usage', async () => {
    const agent = makeAgent('session-generate')
    agents.set(agent.id, agent)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const req = makeRequest({
      character: CHARACTER,
      chatId,
      message: 'Write a reply',
      revision: snapshot!.revision,
      sessionId: agent.id,
    })
    const res = makeResponse()
    await apiHandler(req, res)
    const eventTypes = agent.session.events.map((event) => event.type)
    expect(eventTypes).toEqual([
      'turn/start', 'user/message', 'step/start',
      'assistant/chunk', 'assistant/chunk', 'assistant/chunk',
      'assistant/message', 'step/end', 'turn/end',
    ])
    const assistant = agent.session.events.find((event) => event.type === 'assistant/message')
    expect((assistant?.data as { usage?: unknown }).usage).toEqual({
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 89, cacheWriteTokens: 0,
    })
    expect((agent.session.events.at(-1)?.data as { reason?: unknown }).reason).toEqual({ kind: 'completed' })
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
  })

  it('rejects the ST generation endpoint for an AgentTavern binding', async () => {
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-native': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER,
      chatId,
      message: 'Must not use ST generation',
      revision: snapshot!.revision,
      sessionId: 'session-native',
    }), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('TAVERN_ARCHITECTURE_CONFLICT')
  })

  it('closes the mirrored trace as an error when generation fails', async () => {
    failGeneration = true
    const agent = makeAgent('session-failure')
    agents.set(agent.id, agent)
    const failureChatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused', chat_metadata: { timedWorldInfo: {} },
    }, [])
    const snapshot = await store.getChatSnapshot(CHARACTER, failureChatId)
    const req = makeRequest({
      character: CHARACTER,
      chatId: failureChatId,
      message: 'This will fail',
      revision: snapshot!.revision,
      sessionId: agent.id,
    })
    const res = makeResponse()
    await apiHandler(req, res)
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'step/end', 'turn/end',
    ])
    expect((agent.session.events.at(-1)?.data as { reason?: unknown }).reason).toEqual({
      kind: 'error', error: { message: 'Tavern generation failed', code: 'TAVERN_GENERATION' },
    })
    expect(res.chunks.some((chunk) => chunk.includes('test generation failure'))).toBe(true)
    failGeneration = false
  })
})
