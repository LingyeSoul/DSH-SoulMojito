import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { generationHooks } from '../src/generation-hooks.js'
import {
  PROMPT_VIEWER_PER_CHAT,
  PROMPT_VIEWER_TOTAL,
  buildLoreTrace,
  listPromptViews,
  recordPromptView,
  resetPromptViews,
  setPromptViewerFaultInjector,
} from '../src/prompt-viewer.js'
import { activateWorldInfo } from '../../tavern-lore/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// A-6 提示词查看器 + 世界书激活追踪：
// - 单元：环形缓冲上限（每聊天 10 / 总量 50，FIFO）；loreTrace 与 lore 包激活
//   结果逐字段对齐（主键/副键/概率/常驻/递归各一例）；params 净化。
// - 接线：记录点在 pre-llm 改写之后——mod 改写 system/params 后记录的是改写后
//   形状；记录器注入抛错时生成照常完成。
// - 路由：GET prompts 过滤/倒序/形状；无记录空数组。
// - 客户端：main.js 分区注册 marker（含负样本自测——marker 带闭合引号，不同
//   id 不得误命中）。
const CHAR = 'Viewer Character'

function makeRequest(body: unknown, url: string, method = 'POST') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
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

function importBody(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name, description: `A test character ${name}`, personality: '', scenario: '', first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
    },
  }
}

/* ------------------------------ 单元：环形缓冲 ------------------------------ */

describe('prompt viewer ring buffer (per-chat 10 / total 50, FIFO)', () => {
  beforeEach(() => resetPromptViews())

  function push(character: string, chatId: string, n: number): void {
    for (let i = 0; i < n; i++) {
      recordPromptView({
        character, chatId, mode: 'send',
        request: { messages: [{ role: 'user', content: `m${i}` }], system: undefined, params: { provider: 'p', model: 'm' } },
      })
    }
  }

  it('keeps the latest PER_CHAT records for one chat and evicts oldest first', () => {
    push('C', 'chat-a', PROMPT_VIEWER_PER_CHAT + 4)
    const kept = listPromptViews({ chatId: 'chat-a' })
    expect(kept).toHaveLength(PROMPT_VIEWER_PER_CHAT)
    expect(kept[0]!.messages[0]!.content).toBe(`m${PROMPT_VIEWER_PER_CHAT + 3}`) // 倒序：最新在前
    expect(kept.at(-1)!.messages[0]!.content).toBe('m4') // 最旧保留到 m4（0-3 被淘汰）
  })

  it('caps the total across chats at TOTAL (FIFO across the global order)', () => {
    for (let chat = 0; chat < 6; chat++) push('C', `chat-${chat}`, PROMPT_VIEWER_PER_CHAT)
    const all = listPromptViews()
    expect(all).toHaveLength(PROMPT_VIEWER_TOTAL)
    // 60 条全局记录淘汰最旧 10 条：chat-0 整组先落、应被全量淘汰。
    expect(listPromptViews({ chatId: 'chat-0' })).toHaveLength(0)
    expect(listPromptViews({ chatId: 'chat-5' })).toHaveLength(PROMPT_VIEWER_PER_CHAT)
  })

  it('normalizes message content to text form with placeholders for non-text blocks', () => {
    recordPromptView({
      character: 'C', chatId: 'c', mode: 'send',
      request: {
        messages: [
          { role: 'user', content: 'plain' },
          { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }] },
          { role: 'assistant', content: 42 },
        ],
        system: 'sys',
        params: { provider: 'p', model: 'm', temperature: 0.7, apiKeyEnv: 'SHOULD_NOT_APPEAR', maxTokens: 400 },
      },
    })
    const [record] = listPromptViews()
    expect(record!.messages).toEqual([
      { role: 'user', content: 'plain' },
      { role: 'user', content: 'a\n[image_url block]' },
      { role: 'assistant', content: '[non-text content]' },
    ])
    expect(record!.system).toBe('sys')
    // params 无密钥样键（防御性净化；实发 params 本就不含密钥）
    expect(record!.params).toEqual({ provider: 'p', model: 'm', temperature: 0.7, maxTokens: 400 })
    expect(record!.promptTokens).toBeGreaterThan(0)
  })

  it('listPromptViews filters by character and chatId and returns newest first', () => {
    push('A', 'chat-1', 2)
    push('B', 'chat-1', 1)
    push('A', 'chat-2', 1)
    expect(listPromptViews({ character: 'A' })).toHaveLength(3)
    expect(listPromptViews({ character: 'A', chatId: 'chat-2' })).toHaveLength(1)
    expect(listPromptViews({ chatId: 'chat-1' })).toHaveLength(3)
    const seqs = listPromptViews().map((record) => record.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
  })
})

/* ------------------------------ 单元：loreTrace ------------------------------ */

describe('loreTrace aligns with the lore package activation result', () => {
  it('maps primary/secondary/probability/constant/recursive entries field by field', () => {
    const books = [{
      name: 'fixture-world',
      entries: [
        // 主键命中
        { uid: 0, key: ['alpha'], content: 'alpha lore mentions echo', comment: '主键条目' },
        // 副键 AND_ANY：主键 beta + 副键 gamma 同时在场
        { uid: 1, key: ['beta'], keysecondary: ['gamma'], selective: true, content: 'beta lore', comment: '副键条目' },
        // 概率 50：注入 rng 恒 0.2 → roll=20 命中
        { uid: 2, key: ['delta'], useProbability: true, probability: 50, content: 'delta lore' },
        // 常驻蓝灯
        { uid: 3, constant: true, content: 'constant lore', comment: '常驻条目' },
        // 仅递归第 1 层可激活：键 echo 只出现在 uid0 的内容里
        { uid: 4, key: ['echo'], delayUntilRecursion: 1, content: 'echo lore' },
      ],
    }]
    const lore = activateWorldInfo({
      books,
      chat: [{ name: 'User', content: 'alpha beta gamma delta', isUser: true }],
      contextSize: 4096,
      settings: { recursive: true, budgetPercent: 100 },
      rng: () => 0.2,
    })
    const trace = buildLoreTrace(lore)
    const byUid = new Map(trace.entries.map((entry) => [entry.uid, entry]))
    expect(trace.entries).toHaveLength(5)
    // 递归两轮是本夹具的确定行为：第 1 轮激活 echo 条目，其内容入缓冲后第 2
    // 轮空转（无新激活）才退出循环。
    expect(trace.recursionRounds).toBe(2)
    expect(trace.scanRounds).toBeGreaterThanOrEqual(2)
    expect(trace.budgetLimit).toBeGreaterThan(0)

    const primary = byUid.get(0)!
    expect(primary).toMatchObject({ world: 'fixture-world', name: '主键条目', matchedKeys: ['alpha'], reason: 'primary-key', constant: false, viaRecursion: false })
    expect(primary.position).toBe(0)

    const secondary = byUid.get(1)!
    expect(secondary).toMatchObject({ matchedKeys: ['beta'], reason: 'primary-and-secondary' })

    const probability = byUid.get(2)!
    expect(probability.probability).toEqual({ use: true, value: 50, roll: 20 })

    const constant = byUid.get(3)!
    expect(constant).toMatchObject({ reason: 'constant', constant: true, matchedKeys: [] })

    const recursive = byUid.get(4)!
    expect(recursive).toMatchObject({ matchedKeys: ['echo'], viaRecursion: true })
  })

  it('records no probability block when the entry does not roll', () => {
    const lore = activateWorldInfo({
      books: [{ name: 'w', entries: [{ uid: 0, key: ['alpha'], content: 'x' }] }],
      chat: [{ content: 'alpha here' }],
    })
    const trace = buildLoreTrace(lore)
    expect(trace.entries).toHaveLength(1)
    expect(trace.entries[0]!.probability).toBeUndefined()
    expect(trace.entries[0]!.probabilityRoll).toBeUndefined()
  })
})

/* ------------------------------ 接线：runGeneration 记录点 ------------------------------ */

describe('prompt viewer wiring in runGeneration (record after pre-llm rewrites)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string
  const hostWarnings: string[] = []
  const offs: Array<() => void> = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-prompt-viewer-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter(importBody(CHAR))
    await store.putPreset('viewer-preset', {
      prompts: [{ identifier: 'chatHistory', marker: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
    })
    await store.patchState({ activePreset: 'viewer-preset' })
    chatId = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent, presetId) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
      logger: { warn: (message: string) => { hostWarnings.push(message) } },
    } as never)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const off of offs.splice(0)) off()
    setPromptViewerFaultInjector(undefined)
  })

  beforeEach(() => resetPromptViews())

  async function generate(message = `hello ${Math.random()}`) {
    const snapshot = await store.getChatSnapshot(CHAR, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHAR, chatId, message, revision: snapshot!.revision,
    }, '/api/dsh-tavern/generate'), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
  }

  it('records the post-hook final request (mod rewrites system and params before the record)', async () => {
    offs.push(generationHooks.register('pre-llm', (request) => ({
      ...request,
      system: 'hook-injected system',
      params: { ...request.params, provider: 'mod-provider', model: 'mod-model' },
    })))
    await generate('record probe')
    const [record] = listPromptViews()
    expect(record).toBeDefined()
    expect(record!.system).toBe('hook-injected system') // pre-llm 改写之后
    expect(record!.params).toMatchObject({ provider: 'mod-provider', model: 'mod-model' })
    expect(record!.character).toBe(CHAR)
    expect(record!.chatId).toBe(chatId)
    expect(record!.mode).toBe('send')
    expect(record!.messages.at(-1)).toMatchObject({ role: 'user', content: 'record probe' })
    expect(record!.loreTrace).toBeDefined()
    expect(record!.loreTrace!.scanRounds).toBeGreaterThanOrEqual(1)
  })

  it('records without hooks too (empty-bus baseline: system stays undefined)', async () => {
    await generate('clean probe')
    const [record] = listPromptViews()
    expect(record!.system).toBeUndefined()
    expect(record!.params).toMatchObject({ provider: 'test-provider', model: 'test-model' })
  })

  it('keeps generation alive when the recorder itself throws (swallowed + one host log line)', async () => {
    setPromptViewerFaultInjector(() => { throw new Error('injected recorder failure') })
    await generate('fault probe') // 生成照常完成（saved 事件已在 generate 内断言）
    expect(listPromptViews()).toHaveLength(0) // 记录失败不落缓冲
    expect(hostWarnings.some((line) => line.includes('prompt-viewer record failed') && line.includes('injected recorder failure'))).toBe(true)
  })

  it('serves GET prompts with filter/descending order and an empty array when vacant', async () => {
    resetPromptViews()
    const empty = makeResponse()
    await apiHandler(makeRequest(undefined, '/api/dsh-tavern/prompts', 'GET'), empty)
    expect(JSON.parse(empty.chunks.join(''))).toEqual({ ok: true, records: [] })

    await generate('route probe a')
    const otherChat = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    recordPromptView({ character: CHAR, chatId: otherChat, mode: 'trigger', request: { messages: [], params: {} } })

    const all = makeResponse()
    await apiHandler(makeRequest(undefined, '/api/dsh-tavern/prompts', 'GET'), all)
    const bodyAll = JSON.parse(all.chunks.join('')) as { ok: boolean; records: Array<{ seq: number; at: string; character: string; chatId: string; mode: string; messages: unknown[]; params: Record<string, unknown> }> }
    expect(bodyAll.ok).toBe(true)
    expect(bodyAll.records).toHaveLength(2)
    expect(bodyAll.records[0]!.seq).toBeGreaterThan(bodyAll.records[1]!.seq) // 倒序
    for (const record of bodyAll.records) {
      expect(typeof record.at).toBe('string')
      expect(Array.isArray(record.messages)).toBe(true)
      expect(typeof record.params).toBe('object')
    }

    const filtered = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/prompts?character=${encodeURIComponent(CHAR)}&chatId=${encodeURIComponent(otherChat)}`, 'GET'), filtered)
    const bodyFiltered = JSON.parse(filtered.chunks.join('')) as { records: Array<{ chatId: string }> }
    expect(bodyFiltered.records).toHaveLength(1)
    expect(bodyFiltered.records[0]!.chatId).toBe(otherChat)
  })
})

/* ------------------------------ 客户端分区 marker ------------------------------ */

describe('client panel section registration marker (main.js source check)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')
  // marker 带闭合引号：不同 id（如 promptsX）不会把 marker 当子串误命中——
  // 负样本自测守住这个性质（自测负样本不含原 marker 子串）。
  const sectionMarker = "{ id: 'prompts',"
  // 键定义形态（带冒号）只在 zh/en 两张表出现；分区注册处的 t('...') 引用不带冒号。
  const localeMarker = "'panel.section.prompts':"
  const fetchMarker = 'api(`prompts'

  it('registers the prompts panel section and fetches the prompts API', () => {
    expect(source.includes(sectionMarker)).toBe(true)
    expect(source.includes(fetchMarker)).toBe(true)
  })

  it('carries the prompts locale key in both the zh and en tables', () => {
    expect(source.split(localeMarker).length - 1).toBe(2)
  })

  it('marker does not match a different section id (negative sample)', () => {
    expect("{ id: 'promptsX',".includes(sectionMarker)).toBe(false)
    expect("'panel.section.promptsX':".includes(localeMarker)).toBe(false)
  })
})
