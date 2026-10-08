import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { MemoryStore, TavernStore } from '../../tavern-store/src/index.js'
import { parseRegexScripts } from '../../tavern-format/src/index.js'

const CHARACTER = '露西'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeAgent(id: string, hostFormatVersion?: number) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const injections: unknown[] = []
  return {
    id,
    ctx: { id },
    injections,
    // 宿主 AgentLoop 的公开运行状态对象：构造函数从 turnBoundary.lastTurn 快照一次，
    // 之后只在 turn 结束时更新（dsh-agent-loop/lib/index.js 的 ReactLoopAgent）。
    // 插件写入 turn 边界后必须推进 phase.lastTurn，否则 live loop 会重复轮号。
    phase: { kind: 'idle', lastTurn: 0 },
    inject: (message: unknown) => { injections.push(message) },
    session: {
      // 宿主 Session 公开 header：rc.2 为 format v4。省略时按旧宿主（v0 形状）处理。
      ...(hostFormatVersion === undefined ? {} : { header: { version: hostFormatVersion } }),
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    },
  }
}

// DSH 0.1.2 的 Session 形状：事件日志是私有 log + snapshotEvents() 冻结快照，
// 没有 events 数组属性（激活曾在此形状上抛 reading 'some' of undefined）。
function makeHostSessionAgent(id: string) {
  const injections: unknown[] = []
  const log: Array<{ type: string; seq: number; time: number; data: unknown; opts?: unknown }> = []
  return {
    id,
    ctx: { id },
    injections,
    phase: { kind: 'idle', lastTurn: 0 },
    inject: (message: unknown) => { injections.push(message) },
    log,
    session: {
      log,
      snapshotEvents: () => Object.freeze([...log]),
      append: (type: string, data: unknown, opts?: unknown) => {
        log.push({ type, seq: log.length, time: 0, data, ...(opts === undefined ? {} : { opts }) })
      },
    },
  }
}

// DSH 0.2.0-rc.2 的 Session 形状：header.version = 4（format v4），事件日志经
// snapshotEvents() 快照读取。用于断言 v4 会话的 settlement/词汇表合规性。
function makeV4SessionAgent(id: string) {
  const agent = makeHostSessionAgent(id)
  return { ...agent, session: { ...agent.session, header: { version: 4 } } }
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
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
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
    // 占位 turn 必须同时推进 live loop 的轮次基线：宿主的 AgentLoop 在会话创建时
    // 就快照了 lastTurn = 0，不推进的话原生下一轮会再写 turn/start { turn: 1 }，
    // v4 关系准入会判整个会话损坏（真实会话 session-4c468689 即此形状）。
    expect(agent.phase.lastTurn).toBe(1)
  })

  it('leaves no turn boundary behind when the host loop base cannot be advanced', async () => {
    const agent = makeAgent('session-a')
    // 宿主换代：phase 不再可推进（缺失/冻结）。此时宁可不占位，也不写坏会话。
    delete (agent as { phase?: unknown }).phase
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    expect(turnStarts(agent)).toHaveLength(0)
  })

  it('is idempotent: repairing an already-occupied session appends no further turns', async () => {
    const agent = makeAgent('session-a')
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'user/message')).toHaveLength(0)
  })

  it('occupies a DSH 0.1.2 session whose event log rides snapshotEvents()', async () => {
    const agent = makeHostSessionAgent('session-012-st')
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['session-012-st']).toEqual({ architecture: 'st', character: CHARACTER, chatId })
    const starts = agent.log.filter((event) => event.type === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.data).toEqual({ turn: 1 })
  })

  it('does not pollute a session that already has real host turns', async () => {
    const agent = makeAgent('session-b')
    agent.session.append('turn/start', { turn: 7 })
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
  })

  it('mirrors Tavern generation into the native session trace with usage (pre-v4 host session)', async () => {
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
      'assistant/message', 'step/end', 'turn/end',
    ])
    const assistant = agent.session.events.find((event) => event.type === 'assistant/message')
    expect((assistant?.data as { usage?: unknown }).usage).toEqual({
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 89, cacheWriteTokens: 0,
    })
    // v4 前格式不写 settlement 成员：老宿主工件升级时多余成员会毒化会话。
    expect(assistant?.data).not.toHaveProperty('stream')
    expect((agent.session.events.at(-1)?.data as { reason?: unknown }).reason).toEqual({ kind: 'completed' })
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
  })

  it('writes v4 settlement fields on a format-v4 host session and drops assistant/chunk', async () => {
    const agent = makeV4SessionAgent('session-generate')
    agents.set(agent.id, agent)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    await apiHandler(makeRequest({
      character: CHARACTER,
      chatId,
      message: 'Write another reply',
      revision: snapshot!.revision,
      sessionId: agent.id,
    }), makeResponse())
    const eventTypes = agent.log.map((event) => event.type)
    expect(eventTypes).toEqual([
      'turn/start', 'user/message', 'step/start',
      'assistant/message', 'step/end', 'turn/end',
    ])
    // assistant/chunk 是 v0 词汇，v4 宿主加载期整会话拒载，绝不允许再出现。
    expect(agent.log.some((event) => event.type === 'assistant/chunk')).toBe(false)
    const assistant = agent.log.find((event) => event.type === 'assistant/message')
    // v4 settlement 校验要求 data.stream 为数组（有 usage 也不豁免），缺失时
    // append 成功但重载即拒载。
    expect(assistant?.data).toMatchObject({ turn: 1, step: 1, stream: [] })
  })

  it('records no v0 assistant/chunk stream rows on a v4 host session', async () => {
    // `assistant/chunk` 在 v4 词汇表里不存在，写进 v4 会话会让持久化校验以
    // "unknown to this harness and not marked ignorable" 拒绝整个会话文件
    // （v1→v2 迁移会消费这个类型，v4 日志不可能合法地包含它）。
    const agent = makeAgent('session-generate-v4', 4)
    agents.set(agent.id, agent)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER,
      chatId,
      message: 'Write a reply',
      revision: snapshot!.revision,
      sessionId: agent.id,
    }), res)
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
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
    const agent = makeAgent('session-agent-greeting', 4)
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    // 导入写出完整 turn/step 边界（v4 准入要求 assistant/message 落在打开的
    // turn+step 内），最后一个导入轮号必须同时推进 live loop 的轮次基线，
    // 否则 loop 的首轮会重复 turn 1 并被准入拒绝。历史之前先写受保护 system
    // 头（turn 1）：surface 首个节点必须是 system/message，否则 live 首轮的
    // system prompt 提交触发 `system/message requires a protected first surface
    // head`，会话在磁盘上判损坏。
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'agent-preset/selected',
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(agent.phase.lastTurn).toBe(3)
    const head = agent.session.events[3]!
    expect(head.data).toMatchObject({
      turn: 1,
      step: 1,
      // 恢复校验要求 system/message 的 source 恰好是 system-prompt（与宿主
      // createSystemMessage 同形）；plugin/marker 成员会被 seed/observe 拒绝。
      message: { role: 'system', content: [], source: { kind: 'system-prompt' } },
    })
    expect(head.opts).toEqual({ surfaceOp: 'append' })
    const greeting = agent.session.events[8]!
    expect(greeting.data).toMatchObject({
      turn: 2,
      step: 1,
      // v4 assistant 结算契约：token-meter 的 usageOf() 在 usage/stream 双缺时
      // 抛 TypeError（"reading 'length'"），会话所有投影读取随之失败。
      stream: [],
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '早上好，旅行者。' }],
        source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' },
      },
    })
    expect(greeting.opts).toEqual({ surfaceOp: 'append' })
    expect((greeting.data as { usage?: unknown }).usage).toBeUndefined()
    const importedUser = agent.session.events[12]!
    expect(importedUser.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '你也是早上好。' }],
      source: { kind: 'plugin:dsh-tavern' },
    })
    expect(importedUser.opts).toEqual({ surfaceOp: 'append' })
    const followUp = agent.session.events[14]!
    expect(followUp.data).toMatchObject({
      turn: 3,
      step: 1,
      message: {
        content: [{ type: 'text', text: '今天想去哪里？' }],
        source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' },
      },
    })
    expect(turnStarts(agent).map((event) => event.data)).toEqual([{ turn: 1 }, { turn: 2 }, { turn: 3 }])
  })

  it('does not write turn boundaries when the host loop base cannot be advanced', async () => {
    const now = new Date().toISOString()
    const guardedChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '开场白。' },
    ])
    const agent = makeAgent('session-agent-no-base')
    delete (agent as { phase?: unknown }).phase
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: guardedChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    // 无法推进基线时不能写 turn 边界：写了就会在 live loop 首轮撞号，v4 准入把
    // 整个会话判成损坏。宁可少一次导入，也不写坏会话。
    expect(result.kind).toBe('success')
    expect(agent.session.events.map((event) => event.type)).toEqual(['agent-preset/selected'])
    expect((await store.getState()).sessionBindings[agent.id]).toMatchObject({ architecture: 'agent-tavern', chatId: guardedChat })
  })

  it('re-activation of the same AgentTavern binding after the greeting import is an idempotent no-op', async () => {
    const agent = makeAgent('session-agent-greeting-locked')
    const now = new Date().toISOString()
    const lockedChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '嗨。' }])
    const rawInput = base64Url({ character: CHARACTER, chatId: lockedChat, architecture: 'agent-tavern', contextMode: 'dsh-native' })
    await handler({ agent, rawInput })
    expect(agent.session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    recomposeCalls.length = 0
    const result = await handler({ agent, rawInput })
    expect(result.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    // 该假会话没有 v4 header（v0 形状）：导入写 turn 边界但不写受保护头
    // （v4 专属形状，写入老工件会毒化），重复激活不重复导入。
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'agent-preset/selected',
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(recomposeCalls).toEqual([])
  })

  it('keeps a started AgentTavern session locked against rebinding to another chat', async () => {
    const agent = makeAgent('session-agent-greeting-retarget')
    const now = new Date().toISOString()
    const firstChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '嗨。' }])
    const otherChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [])
    await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: firstChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    const eventsBefore = agent.session.events.length
    await expect(handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: otherChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })).rejects.toThrow('already started')
    expect(agent.session.events).toHaveLength(eventsBefore)
    expect((await store.getState()).sessionBindings[agent.id]).toMatchObject({ character: CHARACTER, chatId: firstChat })
  })

  it('completes a pending AgentTavern initialization whose history the projector replayed first', async () => {
    const agent = makeAgent('session-agent-pending-replay')
    const now = new Date().toISOString()
    const replayedChat = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '重放的开场白。' }])
    await apiHandler(makeRequest({
      sessionId: agent.id,
      character: CHARACTER,
      chatId: replayedChat,
      architecture: 'agent-tavern',
      contextMode: 'dsh-native',
    }, '/api/dsh-tavern/binding'), makeResponse())
    expect((await store.getState()).sessionBindings[agent.id]).toMatchObject({ initializationPending: true })
    // 投影器重放先于激活命令到达：会话里已有 turn，但没有预设 marker。
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'replayed', role: 'assistant', content: [{ type: 'text', text: '重放的开场白。' }] },
    })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: replayedChat, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    const binding = (await store.getState()).sessionBindings[agent.id]
    expect(binding).toMatchObject({ architecture: 'agent-tavern', character: CHARACTER, chatId: replayedChat })
    expect(binding.initializationPending).toBeUndefined()
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
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: expect.stringContaining('AgentTavern preload') })
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
    const body = JSON.parse(res.chunks.join(''))
    expect(body.internalWorkspace).toEqual({
      path: join(home, 'tavern', 'workspace'),
      title: 'Tavern (internal)',
    })
    expect(body.workbenchWorkspace).toEqual({
      path: join(home, 'tavern', 'workbench'),
      title: 'Tavern Workbench (internal)',
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

  it('workbench-open binds a blank session to the CardWorkbench preset once', async () => {
    const agent = makeAgent('session-workbench')
    const result = await handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['session-workbench']).toEqual({
      architecture: 'card-workbench',
      character: '',
      chatId: '',
      sourceCharacter: '',
      sourceChatId: '',
      createdCard: '',
    })
    // 面板「新建角色卡 → 写卡 Agent」桥：marker + recompose 各一次，并写一对
    // 占位 turn 摘除宿主 blank 复用资格（工作台无 driver，用户开口前没有
    // turn/start 的话，宿主会把本会话当 blank 草稿复用，下一个工作台会话的
    // connect 落回本会话并撞上换绑守卫——新建会话从此失败）。
    expect(agent.session.events).toEqual([
      { type: 'agent-preset/selected', data: { agentPreset: 'card-workbench' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(agent.phase.lastTurn).toBe(1)
    expect(recomposeCalls).toContainEqual({ agent: agent.ctx, presetId: 'card-workbench' })
    // 幂等：重复 workbench-open 不叠加 marker、不重复 recompose，也不叠加占位。
    const recomposeCount = recomposeCalls.length
    const again = await handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })
    expect(again.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    expect(turnStarts(agent)).toHaveLength(1)
    expect(recomposeCalls).toHaveLength(recomposeCount)
  })

  it('workbench-open carries the source chat identity and locks a session to it', async () => {
    // 聊天侧「交给工作台」：来源身份成对携带并写进绑定（每个聊天对应一个
    // 写卡工作会话）；不成对的脏载荷直接拒绝。
    const badPayload = await handler({ agent: makeAgent('session-workbench-bad'), rawInput: base64Url({ action: 'workbench-open', sourceCharacter: 'X' }) })
    expect(badPayload.kind).toBe('error')
    expect((await store.getState()).sessionBindings['session-workbench-bad']).toBeUndefined()

    const agent = makeAgent('session-workbench-source')
    const result = await handler({ agent, rawInput: base64Url({ action: 'workbench-open', sourceCharacter: CHARACTER, sourceChatId: chatId }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['session-workbench-source']).toEqual({
      architecture: 'card-workbench',
      character: '',
      chatId: '',
      sourceCharacter: CHARACTER,
      sourceChatId: chatId,
      createdCard: '',
    })
    // 同身份重复仍幂等：不叠加 marker、不重复 recompose，也不抹掉出卡后记下的
    // 卡名（会话标题与侧边栏分组的数据源）与用户显式改的名（title 压过一切
    // 派生标签，改名能力补齐）。
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-workbench-source': { ...state.sessionBindings['session-workbench-source']!, createdCard: '已出卡', title: '我的草稿角' },
      },
    }))
    const recomposeCount = recomposeCalls.length
    const again = await handler({ agent, rawInput: base64Url({ action: 'workbench-open', sourceCharacter: CHARACTER, sourceChatId: chatId }) })
    expect(again.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    expect(recomposeCalls).toHaveLength(recomposeCount)
    expect((await store.getState()).sessionBindings['session-workbench-source']).toMatchObject({ sourceCharacter: CHARACTER, sourceChatId: chatId, createdCard: '已出卡', title: '我的草稿角' })
    // 已绑定会话拒绝换绑另一个来源（自由工作台身份也不行），绑定保持原身份。
    // 首次打开已写占位 turn，换来源命令先撞「已启动」锁（同款 fail-closed）。
    await expect(handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })).rejects.toThrow('already started')
    expect((await store.getState()).sessionBindings['session-workbench-source']).toMatchObject({ sourceCharacter: CHARACTER, sourceChatId: chatId })
  })

  it('re-sends workbench-open on an occupied session idempotently (client stock repair path)', async () => {
    // 客户端存量修复对旧版本打开的 blank 工作台会话重发同来源 workbench-open，
    // 服务端补占位 turn 对；会话已有真实轮次（用户聊过）时同来源重发同样必须
    // 幂等成功，而不是把「已启动」错误塞进会话记录。
    const agent = makeAgent('session-workbench-repair')
    await handler({ agent, rawInput: base64Url({ action: 'workbench-open', sourceCharacter: CHARACTER, sourceChatId: chatId }) })
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const recomposeCount = recomposeCalls.length
    const again = await handler({ agent, rawInput: base64Url({ action: 'workbench-open', sourceCharacter: CHARACTER, sourceChatId: chatId }) })
    expect(again.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    expect(turnStarts(agent)).toHaveLength(2)
    expect(recomposeCalls).toHaveLength(recomposeCount)
    expect((await store.getState()).sessionBindings['session-workbench-repair']).toMatchObject({ sourceCharacter: CHARACTER, sourceChatId: chatId })
  })

  it('opens a workbench session without occupying when the host loop base cannot be advanced', async () => {
    // 宿主换代：phase 不可推进时宁可不占位（仅失去防复用保护），不阻断激活。
    const agent = makeAgent('session-workbench-nophase')
    delete (agent as { phase?: unknown }).phase
    const result = await handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })
    expect(result.kind).toBe('success')
    expect(turnStarts(agent)).toHaveLength(0)
    expect((await store.getState()).sessionBindings['session-workbench-nophase']).toMatchObject({ architecture: 'card-workbench' })
  })

  it('still refuses rebinding a blank stock workbench session to another source', async () => {
    // 旧版本存量形态：绑定已写、会话仍 blank（无占位 turn）。换来源命令必须
    // 继续被换绑守卫 fail-closed 拦下（决策 2026-10-08），绑定身份不被改写。
    const agent = makeAgent('session-workbench-stock')
    delete (agent as { phase?: unknown }).phase
    await handler({ agent, rawInput: base64Url({ action: 'workbench-open', sourceCharacter: CHARACTER, sourceChatId: chatId }) })
    expect(turnStarts(agent)).toHaveLength(0)
    await expect(handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })).rejects.toThrow('already bound to another chat')
    expect((await store.getState()).sessionBindings['session-workbench-stock']).toMatchObject({ sourceCharacter: CHARACTER, sourceChatId: chatId })
  })

  it('refuses workbench-open on a session that already started real turns', async () => {
    const agent = makeAgent('session-workbench-started')
    agent.session.append('turn/start', { turn: 1 })
    await expect(handler({ agent, rawInput: base64Url({ action: 'workbench-open' }) })).rejects.toThrow('already started')
    expect((await store.getState()).sessionBindings['session-workbench-started']).toBeUndefined()
    expect(recomposeCalls.some((call) => call.agent === agent.ctx)).toBe(false)
  })

  // 放在末尾：recomposeCalls 是累积数组，前面的测试对其做精确断言。
  it('recomposes a blank AgentTavern session on a DSH 0.1.2-shaped host session', async () => {
    const agent = makeHostSessionAgent('session-012-agent-tavern')
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: emptyChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    expect(agent.log.map((event) => event.type)).toEqual(['agent-preset/selected'])
    expect(turnStartsOn(agent.log)).toHaveLength(0)
    expect(agent.injections).toHaveLength(0)
  })

  // 放在末尾：向共享记忆目录写入记录，会改变前面 audit 测试的 memories 断言。
  it('returns memory records, not search hits, from the AgentTavern audit', async () => {
    const memories = await MemoryStore.open(join(home, 'tavern'))
    await memories.put({
      scope: 'character',
      scopeId: CHARACTER,
      kind: 'semantic',
      content: '露西习惯把酒单藏在吧台第三层',
      source: { kind: 'deduce', sessionId: 'session-agent-tavern' },
    })
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/agent-tavern/audit?sessionId=session-agent-tavern'), res)
    expect(res.statusCode).toBe(200)
    const memory = JSON.parse(res.chunks.join('')).memories
      .find((candidate: { id?: unknown }) => candidate.id !== undefined)
    expect(memory).toMatchObject({
      scope: 'character',
      kind: 'semantic',
      content: '露西习惯把酒单藏在吧台第三层',
      source: { kind: 'deduce' },
    })
    expect(typeof memory.revision).toBe('string')
    // 回归：曾把 MemoryHit 包装（{ record, score }）直接下发，面板渲染成 undefined · undefined
    expect(memory).not.toHaveProperty('record')
    expect(memory).not.toHaveProperty('score')
  })
})

function turnStartsOn(log: Array<{ type: string }>) {
  return log.filter((event) => event.type === 'turn/start')
}
