import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'
import {
  appendMvuReceipt,
  diffVariables,
  MVU_RECEIPTS_LIMIT,
  overlayScopedVariables,
  readMvuReceipts,
  recordMvuTurnReceipt,
  type MvuReceipt,
} from '../src/mvu.js'

const CHARACTER = '艾琳'
const PLAIN_CHARACTER = '北风'
const FAILING_CHARACTER = '暮色'
const STATUS_CHARACTER = '罗塞'

const SETTLE_REPLY = `<% setvar('mvu.favor', getvar('mvu.favor') + 5) -%>
好感现在是<%= getvar('mvu.favor') %>。`

function makeChat(variables?: Record<string, unknown>, mvu?: unknown) {
  return {
    header: { user_name: 'User', character_name: CHARACTER, chat_metadata: { ...(variables === undefined ? {} : { variables }), ...(mvu === undefined ? {} : { mvu }) } },
    messages: [],
  } as never
}

/* ---------------------------- 纯函数：diff / 回执 ---------------------------- */

describe('diffVariables', () => {
  it('reports nested add / change / delete as dot paths with missing sides omitted', () => {
    const changes = diffVariables(
      { mvu: { favor: 10, trust: 5, gone: 1 }, flag: true },
      { mvu: { favor: 15, trust: 5 }, flag: true, scene: '夜' },
    )
    expect(changes).toEqual([
      { name: 'mvu.favor', before: 10, after: 15 },
      { name: 'mvu.gone', before: 1 },
      { name: 'scene', after: '夜' },
    ])
  })

  it('treats arrays and non-object values as whole leaves', () => {
    expect(diffVariables({ list: [1, 2], keep: 'a' }, { list: [1, 2], keep: 'a' })).toEqual([])
    expect(diffVariables({ list: [1, 2] }, { list: [2, 1] })).toEqual([{ name: 'list', before: [1, 2], after: [2, 1] }])
    expect(diffVariables({ list: [1, 2] }, { list: 'plain' })).toEqual([{ name: 'list', before: [1, 2], after: 'plain' }])
  })

  it('compares nested objects deeply and sorts output by name', () => {
    const changes = diffVariables({ b: { deep: { v: 1 } }, a: 1 }, { b: { deep: { v: 2 } }, a: 1 })
    expect(changes).toEqual([{ name: 'b.deep.v', before: 1, after: 2 }])
  })

  it('expands added / removed subtrees to leaf paths but keeps object-primitive migrations whole', () => {
    expect(diffVariables({}, { mvu: { favor: 15, trust: 5 } })).toEqual([
      { name: 'mvu.favor', after: 15 },
      { name: 'mvu.trust', after: 5 },
    ])
    expect(diffVariables({ mvu: { favor: 15 } }, {})).toEqual([{ name: 'mvu.favor', before: 15 }])
    expect(diffVariables({ a: { b: 1 } }, { a: 5 })).toEqual([{ name: 'a', before: { b: 1 }, after: 5 }])
  })
})

describe('overlayScopedVariables', () => {
  it('overlays flat dotted names onto the nested tree without mutating the base', () => {
    expect(overlayScopedVariables({ mvu: { favor: 10, trust: 1 } }, [
      { name: 'mvu.favor', value: 99 },
      { name: 'scene', value: '夜' },
    ])).toEqual({ mvu: { favor: 99, trust: 1 }, scene: '夜' })
    expect(overlayScopedVariables({}, [{ name: 'a.b.c', value: 1 }])).toEqual({ a: { b: { c: 1 } } })
    const base = { mvu: { favor: 10 } }
    overlayScopedVariables(base, [{ name: 'mvu.favor', value: 1 }])
    expect(base).toEqual({ mvu: { favor: 10 } })
  })

  it('replaces a non-object intermediate with an object when the dotted name needs the path', () => {
    expect(overlayScopedVariables({ a: 5 }, [{ name: 'a.b', value: 1 }])).toEqual({ a: { b: 1 } })
    expect(overlayScopedVariables({ list: [1, 2] }, [{ name: 'list', value: [3] }])).toEqual({ list: [3] })
  })
})

describe('receipt recording (pure)', () => {
  it('skips the mvu key entirely for a turn with no variables and no changes', () => {
    const chat = makeChat()
    expect(recordMvuTurnReceipt(chat, {}, { turnKey: '0' })).toBeUndefined()
    expect(chat.header.chat_metadata.mvu).toBeUndefined()
  })

  it('records unchanged when variables exist but the turn changed nothing', () => {
    const chat = makeChat({ favor: 10 })
    const receipt = recordMvuTurnReceipt(chat, { favor: 10 }, { turnKey: '3' })
    expect(receipt).toMatchObject({ turnKey: '3', status: 'unchanged', changes: [], failures: [] })
    expect(readMvuReceipts(chat)).toHaveLength(1)
  })

  it('records failed (warnings) even without variable changes', () => {
    const chat = makeChat()
    const receipt = recordMvuTurnReceipt(chat, {}, { turnKey: '1', failures: ['render exploded'] })
    expect(receipt!.status).toBe('failed')
    expect(receipt!.failures).toEqual(['render exploded'])
  })

  it('keeps only the most recent receipts in a ring', () => {
    const chat = makeChat()
    for (let i = 0; i < MVU_RECEIPTS_LIMIT + 2; i++) {
      appendMvuReceipt(chat, { at: `t${i}`, turnKey: String(i), status: 'updated', changes: [], failures: [] })
    }
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(MVU_RECEIPTS_LIMIT)
    expect(receipts[0]!.turnKey).toBe('2')
    expect(receipts.at(-1)!.turnKey).toBe(String(MVU_RECEIPTS_LIMIT + 1))
  })

  it('drops malformed receipt entries when reading', () => {
    const chat = makeChat(undefined, {
      receipts: [
        'garbage',
        { at: 't', turnKey: '0', status: 'weird', changes: [], failures: [] },
        { at: 't', turnKey: '1', status: 'updated', changes: [{ name: 'a', after: 1 }, 'bad'], failures: ['x', 42] },
      ],
    })
    expect(readMvuReceipts(chat)).toEqual([
      { at: 't', turnKey: '1', status: 'updated', changes: [{ name: 'a', after: 1 }], failures: ['x'] },
    ])
  })
})

/* ------------------------- 端到端：生成回执 / 路由 ------------------------- */

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: url.includes('/mvu/status/') ? 'GET' : 'POST',
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

function cardData(name: string, extensions: Record<string, unknown> = {}) {
  return {
    name, description: `${name}的描述。`, personality: '', scenario: '', first_mes: '你好。', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions,
  }
}

describe('MVU settlement receipts (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmReply = SETTLE_REPLY
  let chatId: string
  let plainChatId: string
  let failingChatId: string
  let statusChatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-mvu-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))

    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(CHARACTER, { world: 'MVU Lore' }) })
    await store.importWorldFile('MVU Lore', {
      entries: {
        '0': {
          uid: 0, key: [], keysecondary: [], comment: '[InitialVariables]',
          content: '{"mvu": {"favor": 10, "trust": 5}}',
          constant: false, selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(PLAIN_CHARACTER) })
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData(FAILING_CHARACTER, { world: 'MVU Lore' }),
    })
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData(STATUS_CHARACTER, {
        world: 'MVU Lore',
        agentTavern: { statusTemplate: '<div class="mvu-status">好感度：<%- getvar("mvu.favor") ?? 0 %>/100</div>' },
      }),
    })

    const now = new Date().toISOString()
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [])
    plainChatId = await store.createChat(PLAIN_CHARACTER, {
      user_name: 'User', character_name: PLAIN_CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [])
    failingChatId = await store.createChat(FAILING_CHARACTER, {
      user_name: 'User', character_name: FAILING_CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [])
    statusChatId = await store.createChat(STATUS_CHARACTER, {
      user_name: 'User', character_name: STATUS_CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {}, variables: { mvu: { favor: 42 } } },
    }, [])

    await apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: llmReply }
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

  async function generate(character: string, id: string, message: string) {
    const snapshot = await store.getChatSnapshot(character, id)
    const res = makeResponse()
    await apiHandler(makeRequest({ character, chatId: id, message, revision: snapshot!.revision }, '/api/dsh-tavern/generate'), res)
    expect(res.writableEnded).toBe(true)
    const events = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
    return events.find((event) => event.type === 'saved')
  }

  it('writes an updated receipt for a settling turn (setvar write-through diffed)', async () => {
    const saved = await generate(CHARACTER, chatId, 'hello')
    expect(saved).toBeDefined()
    // 输出渲染写穿：initial favor=10 → local favor=15（写穿路径入 variables）
    expect(saved.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 15 } })
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      turnKey: '1', status: 'updated', changes: [{ name: 'mvu.favor', after: 15 }], failures: [],
    })
    expect(typeof receipts[0].at).toBe('string')
    // 持久化后仍可读回
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    expect(readMvuReceipts(snapshot!.chat)).toHaveLength(1)
  })

  it('leaves the mvu key absent for a turn with no variables and no changes', async () => {
    llmReply = '普通的回复，不涉及任何变量。'
    try {
      const saved = await generate(PLAIN_CHARACTER, plainChatId, 'hi')
      expect(saved.chat.header.chat_metadata.mvu).toBeUndefined()
      expect(saved.chat.header.chat_metadata.variables).toBeUndefined()
    } finally {
      llmReply = SETTLE_REPLY
    }
  })

  it('collects template warnings into a failed receipt', async () => {
    llmReply = `<% throw new Error('boom') -%>正文`
    try {
      const saved = await generate(FAILING_CHARACTER, failingChatId, 'hi')
      const floor = saved.chat.messages[saved.chat.messages.length - 1]
      expect(floor.extra?.templateWarnings).toBeDefined()
      const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
      expect(receipts).toHaveLength(1)
      expect(receipts[0].status).toBe('failed')
      expect(receipts[0].failures.join('\n')).toContain('boom')
      expect(receipts[0].changes).toEqual([])
    } finally {
      llmReply = SETTLE_REPLY
    }
  })

  it('serves variables and receipts over GET mvu/status without a status template', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(CHARACTER)}/${chatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.ok).toBe(true)
    expect(payload.available).toBe(true)
    expect(payload.variables).toEqual({ mvu: { favor: 15 } })
    expect(payload.receipts).toHaveLength(1)
    expect(payload.renderedHtml).toBeUndefined()
  })

  it('returns available=false and empty receipts for a variable-less chat; 404 for unknown chat', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(PLAIN_CHARACTER)}/${plainChatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.available).toBe(false)
    expect(payload.variables).toEqual({})
    expect(payload.receipts).toEqual([])

    const missing = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(CHARACTER)}/20990101000000000.jsonl`), missing)
    expect(missing.statusCode).toBe(404)
  })

  it('renders the agentTavern statusTemplate into renderedHtml', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(STATUS_CHARACTER)}/${statusChatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.available).toBe(true)
    expect(payload.renderedHtml).toContain('好感度：42/100')
    // 只读渲染：不写穿聊天变量
    const snapshot = await store.getChatSnapshot(STATUS_CHARACTER, statusChatId)
    expect(snapshot!.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 42 } })
  })

  it('retries settlement on the last assistant floor: variables updated, floor text untouched', async () => {
    const now = new Date().toISOString()
    const crafted = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: {
        createdAt: now, timedWorldInfo: {},
        variables: { mvu: { favor: 42 } }, initial_variables: { mvu: { favor: 10 } },
      },
    }, [{
      // 渲染失败降级保原文的楼层：标签仍在，重跑输出渲染可提取写穿
      name: CHARACTER, is_user: false, is_system: false, send_date: now,
      mes: `<% setvar('mvu.favor', 99) -%>正文保持原样`,
    }])
    const snapshot = await store.getChatSnapshot(CHARACTER, crafted)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId: crafted, revision: snapshot!.revision }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.ok).toBe(true)
    expect(payload.receipt).toMatchObject({
      turnKey: '0', status: 'updated',
      changes: [{ name: 'mvu.favor', before: 42, after: 99 }],
    })
    expect(payload.revision).not.toBe(snapshot!.revision)
    expect(payload.variables).toEqual({ mvu: { favor: 99 } })

    const after = await store.getChatSnapshot(CHARACTER, crafted)
    // 正文不动（不重跑 AI_OUTPUT regex，也不重渲染楼层文本）
    expect(after!.chat.messages[0].mes).toContain("setvar('mvu.favor', 99)")
    expect(after!.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 99 } })
    expect(readMvuReceipts(after!.chat)).toHaveLength(1)
  })

  it('appends an unchanged receipt when the retried floor has no residual tags', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: before!.revision }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.receipt.status).toBe('unchanged')
    expect(payload.receipt.changes).toEqual([])
    expect(payload.variables).toEqual({ mvu: { favor: 15 } })
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(readMvuReceipts(after!.chat)).toHaveLength(2)
    expect(after!.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 15 } })
  })

  it('rejects a stale revision with a CAS conflict', async () => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: 'stale' }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('CHAT_REVISION_CONFLICT')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(snapshot!.revision)
  })

  it('rejects retry when the chat has no assistant floor', async () => {
    const now = new Date().toISOString()
    const userOnly = await store.createChat(PLAIN_CHARACTER, {
      user_name: 'User', character_name: PLAIN_CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: 'User', is_user: true, is_system: false, send_date: now, mes: '只有用户层' }])
    const snapshot = await store.getChatSnapshot(PLAIN_CHARACTER, userOnly)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: PLAIN_CHARACTER, chatId: userOnly, revision: snapshot!.revision }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(500)
    expect(res.chunks.join('')).toContain('no assistant floor to settle')
  })

  it('rejects retry for an AgentTavern binding', async () => {
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-native-mvu': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, revision: snapshot!.revision, sessionId: 'session-native-mvu' }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(409)
    expect(res.chunks.join('')).toContain('TAVERN_ARCHITECTURE_CONFLICT')
  })

  it('keeps the panel available when only receipts exist (nothing settled to a variable)', async () => {
    const now = new Date().toISOString()
    const receiptOnly = await store.createChat(PLAIN_CHARACTER, {
      user_name: 'User', character_name: PLAIN_CHARACTER,
      chat_metadata: {
        createdAt: now, timedWorldInfo: {},
        mvu: { receipts: [{ at: now, turnKey: '1', status: 'failed', changes: [], failures: ['boom'] }] },
      },
    }, [])
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(PLAIN_CHARACTER)}/${receiptOnly}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.available).toBe(true)
    expect(payload.variables).toEqual({})
    expect(payload.receipts).toHaveLength(1)
  })

  it('reads chat-scope AgentTavern variables for an agent-tavern binding and renders them into the status bar', async () => {
    const scoped = await VariableStore.open(join(home, 'tavern'))
    await scoped.set('chat', statusChatId, 'mvu.favor', 77)
    await scoped.set('chat', statusChatId, 'scene', '夜')
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-status-mvu': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: STATUS_CHARACTER, chatId: statusChatId },
      },
    }))
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(STATUS_CHARACTER)}/${statusChatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.available).toBe(true)
    // 卡上种子 mvu.favor=42 被作用域值覆盖；新增叶子按点分名还原成嵌套树
    expect(payload.variables).toEqual({ mvu: { favor: 77 }, scene: '夜' })
    expect(payload.renderedHtml).toContain('好感度：77/100')
    // 只读渲染与只读读取：不回写聊天文件
    const snapshot = await store.getChatSnapshot(STATUS_CHARACTER, statusChatId)
    expect(snapshot!.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 42 } })
  })

  it('does not read chat-scope variables for ST-bound or unbound chats', async () => {
    const scoped = await VariableStore.open(join(home, 'tavern'))
    await scoped.set('chat', plainChatId, 'mvu.favor', 5)
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-st-ignore': { architecture: 'st', character: PLAIN_CHARACTER, chatId: plainChatId },
      },
    }))
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(PLAIN_CHARACTER)}/${plainChatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.available).toBe(false)
    expect(payload.variables).toEqual({})
  })
})
