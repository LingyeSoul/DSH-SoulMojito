import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyAgentTavern, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { addGuide, formatGuidesBlock, GUIDES_BLOCK_HEADER, normalizeGuides, removeGuide } from '../src/guides.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 角色名带空格与中文：guides 路径段必须经 decodeURIComponent 还原。
const CHARACTER = '夜之向导 ExampleCard'

function makeAgent(id: string) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const injections: unknown[] = []
  return {
    id,
    ctx: { id },
    injections,
    phase: { kind: 'idle', lastTurn: 0 },
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

function makeDeleteRequest(url: string) {
  return {
    method: 'DELETE',
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

describe('Conversation Guides (proposal 0009)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let agents: Map<string, ReturnType<typeof makeAgent>>
  let llmRequests: Array<{ system?: string }>
  let agentContexts: Map<string, { name: string; order: number; text: unknown }>
  let chatId: string
  let nativeChatId: string

  const guidesUrl = (targetChat: string, id?: string) =>
    `/api/dsh-tavern/guides/${encodeURIComponent(CHARACTER)}/${encodeURIComponent(targetChat)}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`

  const postGuide = async (targetChat: string, text: unknown) => {
    const res = makeResponse()
    await apiHandler(makeRequest({ text }, guidesUrl(targetChat)), res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') as Record<string, any> }
  }

  const listGuides = async (targetChat: string) => {
    const res = makeResponse()
    await apiHandler(makeGetRequest(guidesUrl(targetChat)), res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') as Record<string, any> }
  }

  const deleteGuide = async (targetChat: string, id: string) => {
    const res = makeResponse()
    await apiHandler(makeDeleteRequest(guidesUrl(targetChat, id)), res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') as Record<string, any> }
  }

  function guidesTextOf(agentId: string | undefined): string {
    const def = agentContexts.get('dsh-tavern:agent-guides') as
      | { text: (assembly?: { agent?: { id?: string } }) => string }
      | undefined
    return def!.text(agentId === undefined ? undefined : { agent: { id: agentId } })
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-guides-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A guide-test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const header = () => ({
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    })
    chatId = await store.createChat(CHARACTER, header(), [])
    nativeChatId = await store.createChat(CHARACTER, header(), [])
    await store.updateState(() => ({
      sessionBindings: {
        'native-guides': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: nativeChatId },
      },
    }))

    agents = new Map()
    llmRequests = []
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { system?: string }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: (id: string) => agents.get(id) },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()

    // AgentTavern 侧：mock 宿主上下文驱动 apply()，捕获 systemPrompt.context 注册。
    agentContexts = new Map()
    applyAgentTavern({
      systemPrompt: {
        section: (def: { name: string; order: number }) => { agentContexts.set(def.name, def) },
        context: (def: { name: string; order: number; text: unknown }) => { agentContexts.set(def.name, def) },
      },
      tools: { register: () => {} },
      effect: (fn) => { fn(); return () => {} },
    } as unknown as AgentContextLike)
    expect(agentContexts.get('dsh-tavern:agent-guides')).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('formats the injection block with the fixed header and createdAt ascending order', () => {
    expect(formatGuidesBlock(undefined)).toBeUndefined()
    expect(formatGuidesBlock([])).toBeUndefined()
    expect(formatGuidesBlock('nope')).toBeUndefined()
    // 全部条目无效（空白文本 / 缺字段 / 非对象）→ 不注入
    expect(formatGuidesBlock([
      null, 42,
      { id: '', text: 'missing id', createdAt: '2026-10-07T00:00:00.000Z' },
      { id: 'blank', text: '   ', createdAt: '2026-10-07T00:00:00.000Z' },
      { id: 'no-date', text: 'missing createdAt' },
    ])).toBeUndefined()
    // 按 createdAt 升序（新指南在后），每条一行 `- text`
    expect(formatGuidesBlock([
      { id: 'b', text: '第二条', createdAt: '2026-10-07T02:00:00.000Z' },
      { id: 'a', text: '第一条', createdAt: '2026-10-07T01:00:00.000Z' },
    ])).toBe([
      GUIDES_BLOCK_HEADER,
      '- 第一条',
      '- 第二条',
    ].join('\n'))
    expect(normalizeGuides([
      { id: 'ok', text: ' 有效 ', createdAt: '2026-10-07T00:00:00.000Z' },
      'junk',
    ])).toEqual([{ id: 'ok', text: '有效', createdAt: '2026-10-07T00:00:00.000Z' }])
  })

  it('validates text emptiness, length and the 8-guide cap', () => {
    expect(addGuide([], undefined).ok).toBe(false)
    expect(addGuide([], 42).ok).toBe(false)
    expect(addGuide([], '   ').ok).toBe(false)
    expect(addGuide([], 'x'.repeat(501)).ok).toBe(false)
    const atCap = Array.from({ length: 8 }, (_, index) => ({
      id: `g${index}`, text: `guide ${index}`, createdAt: `2026-10-07T0${index}:00:00.000Z`,
    }))
    expect(addGuide(atCap, '第九条').ok).toBe(false)
    expect(addGuide([], 'x'.repeat(500)).ok).toBe(true)

    const added = addGuide([], '  多写心理活动，对白不超过三句  ')
    expect(added.ok).toBe(true)
    if (added.ok) {
      expect(added.guide.text).toBe('多写心理活动，对白不超过三句')
      expect(added.guide.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(new Date(added.guide.createdAt).toISOString()).toBe(added.guide.createdAt)
      expect(added.guides).toEqual([added.guide])
    }
  })

  it('removes guides by id and reports misses', () => {
    const guides = [
      { id: 'keep', text: 'a', createdAt: '2026-10-07T00:00:00.000Z' },
      { id: 'drop', text: 'b', createdAt: '2026-10-07T01:00:00.000Z' },
    ]
    expect(removeGuide(guides, 'drop')).toEqual({ removed: true, guides: [guides[0]] })
    expect(removeGuide(guides, 'missing')).toEqual({ removed: false, guides })
  })

  it('adds, lists and persists guides through the API with chat_metadata round-trip', async () => {
    const empty = await listGuides(chatId)
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ ok: true, guides: [] })

    const first = await postGuide(chatId, '多写心理活动，对白不超过三句')
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.guide).toMatchObject({ text: '多写心理活动，对白不超过三句' })
    expect(first.body.guide.id).toMatch(/^[0-9a-f-]{36}$/)

    const second = await postGuide(chatId, '好感度涨得慢一点')
    expect(second.status).toBe(200)

    // 列表按 createdAt 升序
    const listed = await listGuides(chatId)
    expect(listed.status).toBe(200)
    expect(listed.body.guides.map((guide: { text: string }) => guide.text))
      .toEqual(['多写心理活动，对白不超过三句', '好感度涨得慢一点'])

    // 往返持久化：重新读快照，guides 落在 chat_metadata 上
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    expect(normalizeGuides(snapshot!.chat.header.chat_metadata.guides).map((guide) => guide.id))
      .toEqual([first.body.guide.id, second.body.guide.id])

    // 校验失败 → 400 风格错误；未知 chat → 404
    const blank = await postGuide(chatId, '   ')
    expect(blank.status).toBe(400)
    expect(blank.body).toMatchObject({ ok: false, code: 'TAVERN_GUIDES' })
    expect((await postGuide(chatId, 'x'.repeat(501))).status).toBe(400)
    expect((await postGuide(chatId, {})).status).toBe(400)
    expect((await listGuides('missing-chat.jsonl')).status).toBe(404)
  })

  it('rejects the ninth guide per chat with the cap error', async () => {
    const capChat = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    for (let index = 0; index < 8; index += 1) {
      expect((await postGuide(capChat, `指引 ${index}`)).status).toBe(200)
    }
    const ninth = await postGuide(capChat, '第九条')
    expect(ninth.status).toBe(400)
    expect(ninth.body.message).toContain('at most 8')
    expect((await listGuides(capChat)).body.guides).toHaveLength(8)
  })

  it('deletes guides by id and drops the metadata key when emptied', async () => {
    const delChat = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    const a = await postGuide(delChat, 'A')
    const b = await postGuide(delChat, 'B')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const removed = await deleteGuide(delChat, a.body.guide.id)
    expect(removed.status).toBe(200)
    expect(removed.body.guides.map((guide: { id: string }) => guide.id)).toEqual([b.body.guide.id])

    expect((await deleteGuide(delChat, 'no-such-id')).status).toBe(404)

    // 清空后 chat_metadata 摘除 guides 键（与 variables 的空置清理约定一致）
    expect((await deleteGuide(delChat, b.body.guide.id)).status).toBe(200)
    const snapshot = await store.getChatSnapshot(CHARACTER, delChat)
    expect(snapshot!.chat.header.chat_metadata).not.toHaveProperty('guides')
    expect((await listGuides(delChat)).body.guides).toEqual([])
  })

  it('injects the guides block at the end of the ST system prompt and honors deletion', async () => {
    const agent = makeAgent('session-guides')
    agents.set(agent.id, agent)
    const genChat = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    await postGuide(genChat, '多写心理活动，对白不超过三句')

    const snapshot = await store.getChatSnapshot(CHARACTER, genChat)
    await apiHandler(makeRequest({
      character: CHARACTER, chatId: genChat, message: 'Write a reply',
      revision: snapshot!.revision, sessionId: agent.id,
    }), makeResponse())
    const system = llmRequests.at(-1)?.system ?? ''
    expect(system).toContain(GUIDES_BLOCK_HEADER)
    expect(system).toContain('- 多写心理活动，对白不超过三句')
    // ST 链路注入位置是 system 段末尾（所有已装配 system 块之后）
    expect(system.endsWith('- 多写心理活动，对白不超过三句')).toBe(true)

    // 删除即时生效：下一次生成不再携带
    const listed = await listGuides(genChat)
    expect((await deleteGuide(genChat, listed.body.guides[0].id)).status).toBe(200)
    const fresh = await store.getChatSnapshot(CHARACTER, genChat)
    await apiHandler(makeRequest({
      character: CHARACTER, chatId: genChat, message: 'Write another reply',
      revision: fresh!.revision, sessionId: agent.id,
    }), makeResponse())
    expect(llmRequests.at(-1)?.system ?? '').not.toContain('Conversation guides')
  })

  it('registers the agent-guides context beside agent-facts and refreshes its cache through the write path', async () => {
    expect(agentContexts.get('dsh-tavern:agent-guides')?.order).toBe(-65)
    // 回归：facts 段仍注册在 guides 之前
    expect(agentContexts.get('dsh-tavern:agent-facts')?.order).toBe(-70)
    expect(agentContexts.get('dsh-tavern:agent-kernel')?.order).toBe(-80)

    // 绑定的 chat 此前无 guide：首次装配返回空串并触发异步装载
    expect(guidesTextOf('native-guides')).toBe('')
    expect(guidesTextOf(undefined)).toBe('')

    // 经真实写路由添加 → emitGuidesChanged 写穿缓存，无需重新挂载
    const added = await postGuide(nativeChatId, '心理活动多写一点')
    expect(added.status).toBe(200)
    await vi.waitFor(() => {
      expect(guidesTextOf('native-guides')).toContain('心理活动多写一点')
    })
    expect(guidesTextOf('native-guides')).toContain(GUIDES_BLOCK_HEADER)

    // 删除同理即时生效
    expect((await deleteGuide(nativeChatId, added.body.guide.id)).status).toBe(200)
    await vi.waitFor(() => {
      expect(guidesTextOf('native-guides')).not.toContain('心理活动多写一点')
    })
  })

  it('lazy-loads guides on the first assembly of a later-bound agent', async () => {
    const lazyChat = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    // guide 先落库（此刻无绑定匹配，写穿是 no-op），代理绑定后首次装配走异步装载
    expect((await postGuide(lazyChat, '好感度涨得慢一点')).status).toBe(200)
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'native-guides-lazy': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: lazyChat },
      },
    }))
    // 首次调用立即返回空串（不阻塞装配），装载在后台完成
    expect(guidesTextOf('native-guides-lazy')).toBe('')
    await vi.waitFor(() => {
      expect(guidesTextOf('native-guides-lazy')).toContain('好感度涨得慢一点')
    })
  })
})
