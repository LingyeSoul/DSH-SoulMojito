import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = '小樱'

const LLM_REPLY = `<% setvar('hakimi.affection', getvar('hakimi.affection') + 10) -%>
好感度现在是<%- getvar('hakimi.affection') %>。`

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

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

describe('Prompt Template generation wiring (proposal 0008)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<{ system?: string; messages?: Array<{ role: string; content: unknown }> }>
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-template-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))

    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: '好感度：<%- variables.hakimi.affection %>/100',
        personality: '', scenario: '', first_mes: 'hi', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: { world: 'Tpl Lore' },
      },
    })
    await store.importWorldFile('Tpl Lore', {
      entries: {
        '0': {
          uid: 0, key: [], keysecondary: [], comment: '[InitialVariables]',
          content: '{"hakimi": {"affection": 20, "status": "normal"}}',
          constant: false, selective: false, order: 100, position: 0, disable: false,
        },
        '1': {
          uid: 1, key: [], keysecondary: [], comment: '[GENERATE:BEFORE] init',
          content: '<% incvar("hakimi.affection", 5) -%>【好感逻辑已加载】',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
        '2': {
          uid: 2, key: [], keysecondary: [], comment: '[GENERATE:AFTER] tail',
          content: '【TAIL】',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
        '3': {
          uid: 3, key: [], keysecondary: [], comment: '@INJECT pos=0,role=system',
          content: '【INJECTED-HEAD】',
          constant: false, selective: false, order: 100, position: 0, disable: true,
        },
        '4': {
          uid: 4, key: [], keysecondary: [], comment: '[RENDER:AFTER] status',
          content: '\n[好感:<%- variables.hakimi.affection %>]',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
        '5': {
          uid: 5, key: [], keysecondary: [], comment: 'plain lore',
          content: '普通世界书条目',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    await store.patchState({ activeWorlds: ['Tpl Lore'] })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])

    llmRequests = []
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { system?: string; messages?: Array<{ role: string; content: unknown }> }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: LLM_REPLY }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => {
        fn()
        return () => {}
      },
    } as never)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('renders templates end-to-end: initial vars → generate/inject → output render → persist', async () => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, message: 'hello', revision: snapshot!.revision,
    }), res)
    expect(res.writableEnded).toBe(true)
    const events = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
    const saved = events.find((event) => event.type === 'saved')
    expect(saved).toBeDefined()

    // 请求侧：system 含 @INJECT 头注 + GENERATE:BEFORE（含其变量副作用：20+5=25 进卡描述）
    const request = llmRequests[0]!
    const system = request.system ?? ''
    expect(system).toContain('【INJECTED-HEAD】')
    expect(system).toContain('【好感逻辑已加载】')
    expect(system).toContain('好感度：25/100')
    expect(system).toContain('普通世界书条目')
    // 特殊条目不得再走普通世界书通道
    expect(system).not.toContain('hakimi')
    expect(system).not.toContain('【TAIL】')
    // 用户消息保留；末条消息带 GENERATE:AFTER 尾注（content 为 text 分段数组）
    const messages = request.messages ?? []
    expect(messages.some((m) => JSON.stringify(m.content).includes('hello'))).toBe(true)
    const last = messages[messages.length - 1]
    expect(JSON.stringify(last)).toContain('【TAIL】')

    // 输出侧：setvar（25+10=35）+ RENDER:AFTER 状态栏
    const finalMessage = saved.chat.messages[saved.chat.messages.length - 1]
    expect(finalMessage.mes).toBe('好感度现在是35。\n[好感:35]')
    // 变量持久化：local 只含模板写穿的路径；initial 树独立保存（下次生成视图合并）
    expect(saved.chat.header.chat_metadata.variables).toEqual({
      hakimi: { affection: 35 },
    })
    expect(saved.chat.header.chat_metadata.initial_variables).toEqual({
      hakimi: { affection: 20, status: 'normal' },
    })
    // 模板错误不落告警（全部渲染成功）
    expect(finalMessage.extra?.templateWarnings).toBeUndefined()
  })

  it('keeps the plain path unchanged when templates are disabled via env', async () => {
    process.env.DSH_TAVERN_DISABLE_TEMPLATES = '1'
    try {
      const fresh = await store.createChat(CHARACTER, {
        user_name: 'User', character_name: CHARACTER,
        chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
      }, [])
      const snapshot = await store.getChatSnapshot(CHARACTER, fresh)
      llmRequests.length = 0
      const res = makeResponse()
      await apiHandler(makeRequest({
        character: CHARACTER, chatId: fresh, message: 'plain', revision: snapshot!.revision,
      }), res)
      expect(res.writableEnded).toBe(true)
      const request = llmRequests[0]!
      const system = request.system ?? ''
      // 关闭后：EJS 原样直通，特殊条目回到普通激活通道（constant 条目原样注入）
      expect(system).toContain('好感度：<%- variables.hakimi.affection %>/100')
      expect(system).toContain('【TAIL】')
      expect(system).not.toContain('【INJECTED-HEAD】')
      const events = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
      const saved = events.find((event) => event.type === 'saved')
      const finalMessage = saved.chat.messages[saved.chat.messages.length - 1]
      expect(finalMessage.mes).toContain(LLM_REPLY.trim().split('\n')[1]!)
    } finally {
      delete process.env.DSH_TAVERN_DISABLE_TEMPLATES
    }
  })
})
