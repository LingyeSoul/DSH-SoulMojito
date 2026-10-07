import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import {
  buildCandidateRequest,
  parseCandidates,
  readStoredCandidates,
  runCandidateGeneration,
  writeStoredCandidates,
  type CandidateHistoryMessage,
} from '../src/candidates.js'

const CHARACTER = '塞拉'

/* ---------------------------- 纯函数：请求构造 ---------------------------- */

function historyOf(count: number): CandidateHistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'User' : CHARACTER,
    isUser: i % 2 === 0,
    text: `msg${i}`,
  }))
}

describe('buildCandidateRequest', () => {
  const base = {
    character: {
      name: CHARACTER,
      description: '雨夜酒馆的看板娘，金色卷发，袖口别着一枚旧徽章。',
      personality: '热情，但喜欢用毒舌掩饰关心',
      scenario: '一个雷雨交加的深夜，酒馆里只剩最后一位客人。',
    },
    userName: '旅人',
    history: historyOf(3),
  }

  it('emits the candidate generator directive with strict JSON contract', () => {
    const request = buildCandidateRequest(base)
    expect(request.system).toContain('propose 3 to 6 candidates')
    expect(request.system).toContain('strict JSON array')
    expect(request.system).toContain('do not advance the plot')
    expect(request.system).toContain(`Character: ${CHARACTER}`)
    expect(request.system).toContain('Description: 雨夜酒馆的看板娘')
    expect(request.system).toContain('Personality: 热情，但喜欢用毒舌掩饰关心')
    expect(request.system).toContain('Scenario: 一个雷雨交加的深夜')
    expect(request.system).toContain('User persona name: 旅人')
  })

  it('clamps long card description to an excerpt', () => {
    const request = buildCandidateRequest({
      ...base,
      character: { ...base.character, description: '长'.repeat(4000) },
    })
    const descriptionLine = request.system.split('\n').find((line) => line.startsWith('Description:'))
    expect(descriptionLine!.length).toBeLessThanOrEqual('Description: '.length + 1500 + 1)
    expect(descriptionLine).toMatch(/…$/)
  })

  it('formats guides as a persistent-directive block ordered by creation time', () => {
    const request = buildCandidateRequest({
      ...base,
      guides: [
        { id: 'g2', text: '对白不超过三句', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'g1', text: '多写心理活动', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
    const block = request.system.split('\n\n').find((part) => part.includes('Conversation guides'))!
    expect(block.split('\n')[0]).toBe('Conversation guides (persistent user directives; apply to every reply):')
    // 创建时间升序：新指南在后
    expect(block.indexOf('- 多写心理活动')).toBeLessThan(block.indexOf('- 对白不超过三句'))
  })

  it('omits the guides block when there are no guides', () => {
    expect(buildCandidateRequest(base).system).not.toContain('Conversation guides')
  })

  it('carries previous candidates plus feedback as a revision directive', () => {
    const request = buildCandidateRequest({
      ...base,
      feedback: '少一点战斗，多一点日常互动',
      previousCandidates: [
        { kind: 'action', text: '拔剑指向酒馆门口的黑影' },
        { kind: 'scene', text: '烛火忽然全部熄灭' },
      ],
    })
    expect(request.system).toContain('Previous candidates (the user reviewed them and asked for a revision):')
    expect(request.system).toContain('- [action] 拔剑指向酒馆门口的黑影')
    expect(request.system).toContain('- [scene] 烛火忽然全部熄灭')
    expect(request.system).toContain('User feedback on the candidates: 少一点战斗，多一点日常互动')
    expect(request.system).toContain('Revise the candidates according to the feedback')
    expect(request.messages.at(-1)!.content).toContain('revising the previous candidates')
  })

  it('windows history to the most recent 10 floors and appends the ask', () => {
    const request = buildCandidateRequest({ ...base, history: historyOf(15) })
    // 15 条进 10 条出：msg5..msg14，末尾再补一条 user 指令
    expect(request.messages).toHaveLength(11)
    expect(request.messages[0]!.content).toBe(`[${CHARACTER}] msg5`)
    expect(request.messages[9]!.content).toBe('[User] msg14')
    const ask = request.messages.at(-1)!
    expect(ask.role).toBe('user')
    expect(ask.content).toContain('Propose 3 to 6 candidate inputs')
  })
})

/* ---------------------------- 纯函数：解析容错 ---------------------------- */

describe('parseCandidates', () => {
  it('parses a bare JSON array', () => {
    expect(parseCandidates('[{"kind":"action","text":"走向塞拉"},{"kind":"scene","text":"窗外雨声渐大"}]')).toEqual([
      { kind: 'action', text: '走向塞拉' },
      { kind: 'scene', text: '窗外雨声渐大' },
    ])
  })

  it('extracts the first JSON array from fenced or noisy output', () => {
    const noisy = '好的，以下是候选：\n```json\n[{"kind":"action","text":"点一杯热酒"}]\n```\n希望有帮助。'
    expect(parseCandidates(noisy)).toEqual([{ kind: 'action', text: '点一杯热酒' }])
    expect(parseCandidates('前后杂质 ["候选A"] 尾巴 ["候选B"]')).toEqual([{ kind: 'action', text: '候选A' }])
  })

  it('falls back to kind action for plain string items and invalid kinds', () => {
    expect(parseCandidates('["做点什么","四处看看"]')).toEqual([
      { kind: 'action', text: '做点什么' },
      { kind: 'action', text: '四处看看' },
    ])
    expect(parseCandidates('[{"kind":"narration","text":"旁白"}]')).toEqual([{ kind: 'action', text: '旁白' }])
  })

  it('clamps each item to 200 characters and truncates arrays to 6 entries', () => {
    const long = parseCandidates(`[{"kind":"action","text":"${'长'.repeat(300)}"}]`)
    expect(long[0]!.text).toHaveLength(200)
    const eight = parseCandidates(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ kind: 'action', text: `c${i}` }))))
    expect(eight).toHaveLength(6)
    expect(eight.at(-1)!.text).toBe('c5')
  })

  it('rejects outputs with no usable candidates', () => {
    expect(() => parseCandidates('[]')).toThrow('no usable candidates')
    expect(() => parseCandidates('完全没有 JSON')).toThrow('no JSON array')
    expect(() => parseCandidates('[{"kind":"action"}]')).toThrow('no usable candidates')
    expect(() => parseCandidates('[42, null]')).toThrow('no usable candidates')
  })
})

/* ---------------------------- 纯函数：存储读写 ---------------------------- */

describe('candidate storage round trip', () => {
  function makeChat(candidates?: unknown) {
    return { header: { user_name: 'User', character_name: CHARACTER, chat_metadata: { ...(candidates === undefined ? {} : { candidates }) } }, messages: [] } as never
  }

  it('writes then reads back the stored payload', () => {
    const chat = makeChat()
    writeStoredCandidates(chat, {
      items: [{ kind: 'action', text: '走向塞拉' }],
      generatedAt: '2026-10-07T00:00:00.000Z',
      feedback: '少一点战斗',
    })
    expect(readStoredCandidates(chat)).toEqual({
      items: [{ kind: 'action', text: '走向塞拉' }],
      generatedAt: '2026-10-07T00:00:00.000Z',
      feedback: '少一点战斗',
    })
  })

  it('omits the feedback key when there is no feedback', () => {
    const chat = makeChat()
    writeStoredCandidates(chat, { items: [{ kind: 'scene', text: '天亮了' }], generatedAt: 'now' })
    const raw = (chat.header.chat_metadata.candidates as Record<string, unknown>)
    expect(raw).not.toHaveProperty('feedback')
    expect(readStoredCandidates(chat)!.feedback).toBeUndefined()
  })

  it('returns undefined for absent or malformed metadata', () => {
    expect(readStoredCandidates(makeChat())).toBeUndefined()
    expect(readStoredCandidates(makeChat('garbage'))).toBeUndefined()
    expect(readStoredCandidates(makeChat({ items: [] }))).toBeUndefined()
  })
})

/* ------------------------- 端到端：路由与执行内核 ------------------------- */

function makeRequest(body: unknown, url = '/api/dsh-tavern/candidates') {
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

const CANDIDATE_OUTPUT = JSON.stringify([
  { kind: 'action', text: '走向塞拉，低声问今晚还剩什么酒' },
  { kind: 'scene', text: '窗外忽然响起一声闷雷' },
  { text: '点一杯热酒，坐到吧台尽头' },
])

describe('candidate generation (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<{ provider?: string; model?: string; system?: string; messages?: unknown[] }>
  let failCandidates = false
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-candidates-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: '雨夜酒馆的看板娘，金色卷发。', personality: '热情但毒舌', scenario: '雷雨深夜的酒馆',
        first_mes: '欢迎光临。', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const now = new Date().toISOString()
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: {
        createdAt: now, timedWorldInfo: {},
        guides: [
          { id: 'g2', text: '对白不超过三句', createdAt: '2026-01-02T00:00:00.000Z' },
          { id: 'g1', text: '多写心理活动', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    }, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '欢迎光临，外面雨很大吧。' },
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: '来一杯热的。' },
      { name: 'System', is_user: false, is_system: true, send_date: now, mes: '系统隐藏层不应进候选历史' },
    ])
    llmRequests = []
    await apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { provider?: string; model?: string; system?: string; messages?: unknown[] }) {
          llmRequests.push(request)
          if (failCandidates) throw new Error('candidate stream failure')
          yield { type: 'text-delta', text: CANDIDATE_OUTPUT }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => void) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('generates candidates over POST candidates and persists them with a new revision', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: before!.revision }), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.ok).toBe(true)
    expect(payload.revision).not.toBe(before!.revision)
    // 字符串项兜底 action；对象项保持 kind
    expect(payload.items).toEqual([
      { kind: 'action', text: '走向塞拉，低声问今晚还剩什么酒' },
      { kind: 'scene', text: '窗外忽然响起一声闷雷' },
      { kind: 'action', text: '点一杯热酒，坐到吧台尽头' },
    ])
    expect(typeof payload.generatedAt).toBe('string')

    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(payload.revision)
    expect(after!.chat.header.chat_metadata.candidates).toMatchObject({
      items: payload.items,
      generatedAt: payload.generatedAt,
    })

    const request = llmRequests.at(-1)!
    expect(request.provider).toBe('test-provider')
    expect(request.model).toBe('test-model')
    expect(request.system).toContain('strict JSON array')
    // 候选请求携带 guides 块（提案 0009 形状，创建时间升序）
    expect(request.system).toContain('Conversation guides (persistent user directives; apply to every reply):')
    expect(request.system!.indexOf('- 多写心理活动')).toBeLessThan(request.system!.indexOf('- 对白不超过三句'))
    // is_system 楼层不进候选历史
    const serialized = JSON.stringify(request.messages)
    expect(serialized).not.toContain('系统隐藏层')
    expect(serialized).toContain('来一杯热的。')
  })

  it('regenerates with feedback, revising the previous candidates', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, revision: before!.revision, feedback: '少一点战斗，多一点日常互动',
    }), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.revision).not.toBe(before!.revision)

    const request = llmRequests.at(-1)!
    expect(request.system).toContain('Previous candidates (the user reviewed them and asked for a revision):')
    expect(request.system).toContain('- [action] 走向塞拉，低声问今晚还剩什么酒')
    expect(request.system).toContain('User feedback on the candidates: 少一点战斗，多一点日常互动')

    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.chat.header.chat_metadata.candidates).toMatchObject({ feedback: '少一点战斗，多一点日常互动' })
  })

  it('reuses the session model selection and lets explicit provider/model win', async () => {
    await store.updateState((state) => ({
      modelSelections: { ...state.modelSelections, 'session-cand': { provider: 'sel-provider', model: 'sel-model' } },
    }))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, revision: snapshot!.revision, sessionId: 'session-cand',
    }), makeResponse())
    expect(llmRequests.at(-1)!.provider).toBe('sel-provider')
    expect(llmRequests.at(-1)!.model).toBe('sel-model')

    const fresh = await store.getChatSnapshot(CHARACTER, chatId)
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, revision: fresh!.revision,
      sessionId: 'session-cand', provider: 'exp-provider', model: 'exp-model',
    }), makeResponse())
    expect(llmRequests.at(-1)!.provider).toBe('exp-provider')
    expect(llmRequests.at(-1)!.model).toBe('exp-model')
  })

  it('rejects the candidates endpoint for an AgentTavern binding', async () => {
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-native-cand': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, revision: snapshot!.revision, sessionId: 'session-native-cand',
    }), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('TAVERN_ARCHITECTURE_CONFLICT')
  })

  it('rejects a stale revision with a CAS conflict', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: 'stale-revision' }), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('CHAT_REVISION_CONFLICT')
  })

  it('leaves the chat untouched when candidate generation fails', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const candidatesBefore = before!.chat.header.chat_metadata.candidates
    failCandidates = true
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: before!.revision }), res)
    failCandidates = false
    expect(res.statusCode).toBe(500)
    expect(res.chunks.join('')).toContain('candidate stream failure')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    // 失败不改聊天：revision 与候选元数据保持原样
    expect(after!.revision).toBe(before!.revision)
    expect(after!.chat.header.chat_metadata.candidates).toEqual(candidatesBefore)
  })

  it('runCandidateGeneration surfaces stream failures without mutating the chat', async () => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const state = await store.getState()
    const failingCtx = {
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    await expect(runCandidateGeneration(failingCtx as never, store, {
      state: state as never,
      characterName: CHARACTER,
      chatId,
      snapshot: snapshot!,
      revision: snapshot!.revision,
    })).rejects.toThrow('provider exploded')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(snapshot!.revision)
    expect(after!.chat.header.chat_metadata.candidates).toEqual(snapshot!.chat.header.chat_metadata.candidates)
  })

  it('runCandidateGeneration re-checks the ST binding for direct callers', async () => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const state = await store.getState()
    const ctx = {
      llm: { stream: async function* () { yield { type: 'text-delta', text: CANDIDATE_OUTPUT } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    await expect(runCandidateGeneration(ctx as never, store, {
      state: { ...state, sessionBindings: { 'direct-native': { architecture: 'agent-tavern' } } } as never,
      characterName: CHARACTER,
      chatId,
      snapshot: snapshot!,
      revision: snapshot!.revision,
      sessionId: 'direct-native',
    })).rejects.toThrow('AgentTavern sessions')
  })
})
