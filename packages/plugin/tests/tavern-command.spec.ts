import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { parseRegexScripts } from '../../tavern-format/src/index.js'

const CHARACTER = '露西'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeAgent(id: string) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const injections: unknown[] = []
  return {
    id,
    ctx: { id },
    injections,
    inject: (message: unknown) => { injections.push(message) },
    session: {
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    },
  }
}

function makeRequest(body: unknown, url = '/api/dsh-tavern/generate') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url,
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

function makeGetRequest(url: string) {
  return {
    method: 'GET',
    url,
    on: () => undefined,
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
  let recomposeCalls: Array<{ agent: unknown; presetId: string }>
  let llmRequests: Array<{ system?: string }>
  let failGeneration = false
  let chatId: string
  let emptyChatId: string

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
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        character_book: {
          entries: [
            { id: 10, keys: [], content: 'embedded default lore', enabled: true, insertion_order: 100, constant: true },
            { id: 11, keys: ['secret'], content: 'embedded keyword lore', enabled: true, insertion_order: 90, constant: false },
          ],
        },
        extensions: {
          world: 'Linked Lore',
          regex_scripts: {
            scripts: [{
              scriptName: 'filter linked lore', findRegex: 'unfiltered lore', replaceString: 'filtered lore',
              placement: [5],
            }],
          },
        },
      },
    })
    await store.importWorldFile('Linked Lore', {
      entries: {
        '0': {
          uid: 0, key: [], keysecondary: [], comment: 'linked', content: 'unfiltered lore',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    await store.importWorldFile('Active Lore', {
      entries: {
        '0': {
          uid: 0, key: [], keysecondary: [], comment: 'active', content: 'unfiltered active lore',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
        '1': {
          uid: 1, key: ['trigger'], keysecondary: [], comment: 'keyword', content: 'active keyword lore',
          constant: false, selective: false, order: 90, position: 0, disable: false,
        },
        '2': {
          uid: 2, key: [], keysecondary: [], comment: 'disabled', content: 'disabled default lore',
          constant: true, selective: false, order: 80, position: 0, disable: true,
        },
      },
    })
    await store.patchState({
      activeWorlds: ['Active Lore'],
      regexScripts: parseRegexScripts([{
        scriptName: 'filter active lore', findRegex: 'unfiltered active lore', replaceString: 'filtered active lore',
        placement: [5],
      }]),
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])
    // AgentTavern 激活测试专用：保持零消息，下面的 ST 生成测试只写 chatId。
    emptyChatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])

    let definition: { handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> } | undefined
    agents = new Map()
    recomposeCalls = []
    llmRequests = []
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: (def) => { definition = def } },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (agent: unknown, presetId: string) => {
          recomposeCalls.push({ agent, presetId })
          return { id: presetId }
        },
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { system?: string }) {
          llmRequests.push(request)
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

  it('automatically loads active/linked worlds and global/card regex in ST mode', async () => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER,
      chatId,
      message: 'Continue',
      revision: snapshot!.revision,
      sessionId: 'session-generate',
    }), res)
    const request = llmRequests.at(-1)
    expect(request?.system).toContain('filtered lore')
    expect(request?.system).not.toContain('unfiltered lore')
    expect(request?.system).toContain('filtered active lore')
    expect(request?.system).not.toContain('unfiltered active lore')
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

  it('recomposes a blank session with AgentTavern without occupying native turns', async () => {
    const agent = makeAgent('session-agent-tavern')
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: emptyChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    expect(recomposeCalls).toEqual([{ agent: agent.ctx, presetId: 'agent-tavern' }])
    expect(agent.session.events).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'agent-tavern' } }])
    expect(turnStarts(agent)).toHaveLength(0)
    expect(agent.injections).toHaveLength(0)
  })

  it('imports the greeting and existing history into a fresh AgentTavern session', async () => {
    const now = new Date().toISOString()
    const greetingChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '早上好，旅行者。' },
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: '你也是早上好。' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '今天想去哪里？' },
    ])
    const agent = makeAgent('session-agent-greeting')
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'agent-preset/selected',
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    const greeting = agent.session.events[3]!
    expect(greeting.data).toMatchObject({
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '早上好，旅行者。' }],
        source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'greeting' },
      },
    })
    expect(greeting.opts).toEqual({ surfaceOp: 'append' })
    expect((greeting.data as { usage?: unknown }).usage).toBeUndefined()
    const importedUser = agent.session.events[7]!
    expect(importedUser.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '你也是早上好。' }],
      source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' },
    })
    expect(importedUser.opts).toEqual({ surfaceOp: 'append' })
    const followUp = agent.session.events[9]!
    expect(followUp.data).toMatchObject({
      turn: 2, step: 1,
      message: {
        content: [{ type: 'text', text: '今天想去哪里？' }],
        source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' },
      },
    })
    expect(turnStarts(agent).map((event) => event.data)).toEqual([{ turn: 1 }, { turn: 2 }])
  })

  it('keeps the AgentTavern session locked after the history import created turns', async () => {
    const agent = makeAgent('session-agent-greeting-locked')
    const now = new Date().toISOString()
    const lockedChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '嗨。' }])
    const rawInput = base64Url({ character: CHARACTER, chatId: lockedChat, architecture: 'agent-tavern', contextMode: 'dsh-native' })
    await handler({ agent, rawInput })
    expect(agent.session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    await expect(handler({ agent, rawInput })).rejects.toThrow('already started')
    expect(agent.session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('accepts the AgentTavern one-time asset preload setting', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ agentTavernPreloadAssets: true }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    expect((await store.getState()).agentTavernPreloadAssets).toBe(true)
  })

  it('does not retroactively preload an existing AgentTavern binding', async () => {
    const agent = makeAgent('session-agent-tavern')
    await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: emptyChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(agent.injections).toHaveLength(0)
  })

  it('injects character data and constant lore once when an AgentTavern session is initialized', async () => {
    const agent = makeAgent('session-agent-preload')
    const rawInput = base64Url({ character: CHARACTER, chatId: emptyChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' })
    const bindingBody = {
      sessionId: agent.id,
      character: CHARACTER,
      chatId: emptyChatId,
      architecture: 'agent-tavern',
      contextMode: 'dsh-native',
    }
    const bindingResponse = makeResponse()
    await apiHandler(makeRequest(bindingBody, '/api/dsh-tavern/binding'), bindingResponse)
    expect(bindingResponse.statusCode).toBe(200)
    expect((await store.getState()).sessionBindings[agent.id]).toMatchObject({ initializationPending: true })

    await handler({ agent, rawInput })
    await apiHandler(makeRequest(bindingBody, '/api/dsh-tavern/binding'), makeResponse())
    await handler({ agent, rawInput })

    expect(agent.injections).toHaveLength(1)
    const message = agent.injections[0] as { role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown> }
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-tavern', form: 'context' })
    expect(message.content[0]?.text).toContain('A test character')
    expect(message.content[0]?.text).toContain('unfiltered lore')
    expect(message.content[0]?.text).toContain('unfiltered active lore')
    // 链接世界已导入：内嵌书不再叠加，避免同一份条目重复激活
    expect(message.content[0]?.text).not.toContain('embedded default lore')
    expect(message.content[0]?.text).not.toContain('active keyword lore')
    expect(message.content[0]?.text).not.toContain('embedded keyword lore')
    expect(message.content[0]?.text).not.toContain('disabled default lore')
    expect((await store.getState()).sessionBindings[agent.id]).not.toHaveProperty('initializationPending')

    await store.patchState({ agentTavernPreloadAssets: false })
  })

  it('exposes the read-only AgentTavern projection and state audit', async () => {
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/agent-tavern/audit?sessionId=session-agent-tavern'), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.chunks.join(''))).toMatchObject({
      ok: true,
      architecture: 'agent-tavern',
      contextMode: 'dsh-native',
      projection: { sessionId: 'session-agent-tavern', lastCursor: -1, status: 'ok' },
      memories: [],
      variables: [],
    })
  })

  it('publishes a dedicated path-backed DSH workspace for every Tavern architecture', async () => {
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/bootstrap'), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.chunks.join('')).internalWorkspace).toEqual({
      path: join(home, 'tavern', 'workspace'),
      title: 'Tavern (internal)',
    })
  })

  it('fails closed when AgentTavern managed context is unavailable', async () => {
    const agent = makeAgent('session-agent-managed')
    await expect(handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId, architecture: 'agent-tavern', contextMode: 'agent-managed' }),
    })).rejects.toMatchObject({ code: 'TAVERN_ARCHITECTURE_CONFLICT' })
    expect(recomposeCalls.some((call) => call.agent === agent.ctx)).toBe(false)
    expect((await store.getState()).sessionBindings['session-agent-managed']).toBeUndefined()
    expect(agent.session.events).toHaveLength(0)
    const res = makeResponse()
    await apiHandler(makeRequest({ defaultContextMode: 'agent-managed' }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('TAVERN_ARCHITECTURE_CONFLICT')
    expect((await store.getState()).defaultContextMode).toBe('dsh-native')
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

  it('imports an embedded character book as a linked world file', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Lore Carrier', description: 'carries lore', personality: '', scenario: '', first_mes: 'hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        character_book: {
          name: 'Carrier Lore',
          entries: [
            { id: 0, keys: [], content: 'carrier constant lore', enabled: true, insertion_order: 100, constant: true },
          ],
        },
        extensions: {},
      },
    }
    const res = makeResponse()
    await apiHandler(makeRequest({ card }, '/api/dsh-tavern/import/character'), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.chunks.join(''))).toMatchObject({ ok: true, name: 'Lore Carrier', world: 'Carrier Lore' })
    expect(await store.listWorlds()).toContain('Carrier Lore')
    expect((await store.getCharacter('Lore Carrier'))?.card.data.extensions['world']).toBe('Carrier Lore')
    const book = await store.getWorld('Carrier Lore')
    expect(book?.entries).toHaveLength(1)
    expect(book?.entries[0]?.content).toBe('carrier constant lore')
  })

  it('imports card-embedded regex scripts into the global script list', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Regex Carrier', description: 'carries regex', personality: '', scenario: '', first_mes: 'hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: {
          regex_scripts: [
            { scriptName: 'card strip', findRegex: '<div>|</div>', replaceString: '', placement: [2], markdownOnly: true },
          ],
        },
      },
    }
    const res = makeResponse()
    await apiHandler(makeRequest({ card }, '/api/dsh-tavern/import/character'), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.chunks.join(''))).toMatchObject({ ok: true, name: 'Regex Carrier', importedRegex: 1 })
    const state = await store.getState()
    expect(state.regexScripts.some((script) => script.scriptName === 'card strip')).toBe(true)
  })

  it('activates the linked world when a character becomes active', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ activeCharacter: 'Lore Carrier' }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    expect((await store.getState()).activeWorlds).toContain('Carrier Lore')
    // 切回原角色：手动激活的世界书保持，新角色的链接世界并入
    await apiHandler(makeRequest({ activeCharacter: CHARACTER }, '/api/dsh-tavern/state'), makeResponse())
    const state = await store.getState()
    expect(state.activeWorlds).toContain('Carrier Lore')
    expect(state.activeWorlds).toContain('Linked Lore')
  })

  it('activates the linked world when a session binds the character', async () => {
    const chatId = await store.createChat('Lore Carrier', {
      user_name: 'unused', character_name: 'unused', chat_metadata: { timedWorldInfo: {} },
    }, [])
    const res = makeResponse()
    await apiHandler(makeRequest({
      sessionId: 'session-carrier', character: 'Lore Carrier', chatId,
    }, '/api/dsh-tavern/binding'), res)
    expect(res.statusCode).toBe(200)
    expect((await store.getState()).activeWorlds).toContain('Carrier Lore')
  })
})
