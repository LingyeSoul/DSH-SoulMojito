import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'
import {
  applyMvuSettlementGuard,
  diffVariables,
  readMvuReceipts,
  type MvuReceipt,
} from '../src/mvu.js'
import { guardMvuWrite, readMvuSchema, stripMvuSchema } from '../src/mvu-guard.js'

/* ---------------------------- 纯函数：守卫语义 ---------------------------- */

const SCHEMA = {
  mvu: {
    favor: { $range: [0, 100] },
    mood: { $enum: ['calm', 'tense'] },
    name: { $ro: true },
    stats: { hp: 0, mp: 0 },
    allies: { '*': { hp: 0 } },
    notes: {},
    bag: [{ item: '', count: { $range: [0, 99] } }],
  },
}

describe('guardMvuWrite (pure)', () => {
  it('is a no-op pass-through without a schema (golden backwards compatibility)', () => {
    expect(guardMvuWrite(undefined, 'mvu.favor', 'anything', 1)).toEqual({ ok: true, value: 'anything' })
    expect(guardMvuWrite({}, 'mvu.favor', 42, 1)).toEqual({ ok: true, value: 42 })
    expect(guardMvuWrite({ unrelated: 0 }, 'mvu.favor', 42, 1)).toEqual({ ok: true, value: 42 })
  })

  it('clamps $range violations instead of failing, with a guard note', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.favor', 150, 10)).toEqual({
      ok: true, value: 100, note: 'mvu.favor: guard clamp: 150 -> 100',
    })
    expect(guardMvuWrite(SCHEMA, 'mvu.favor', -5, 10)).toMatchObject({ ok: true, value: 0 })
  })

  it('caps the per-write delta with $step (inc semantics on absolute writes), then clamps', () => {
    const stepped = { mvu: { favor: { $range: [0, 100], $step: 30 } } }
    // delta +95 -> +30 = 40
    expect(guardMvuWrite(stepped, 'mvu.favor', 105, 10)).toEqual({
      ok: true, value: 40,
      note: 'mvu.favor: guard step: delta +95 capped to +30',
    })
    // 首写无既有值：step 不截断，仅 range clamp
    expect(guardMvuWrite(stepped, 'mvu.favor', 200, undefined)).toEqual({
      ok: true, value: 100, note: 'mvu.favor: guard clamp: 200 -> 100',
    })
  })

  it('rejects $enum non-members as retryable failures (no silent correction)', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.mood', 'angry', 'calm')).toMatchObject({
      ok: false, kind: 'enum-violation',
    })
    expect(guardMvuWrite(SCHEMA, 'mvu.mood', 'tense', 'calm')).toEqual({ ok: true, value: 'tense' })
  })

  it('rejects $ro writes that change the value; identical re-writes pass', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.name', '新名字', '艾琳')).toMatchObject({ ok: false, kind: 'readonly' })
    expect(guardMvuWrite(SCHEMA, 'mvu.name', '艾琳', '艾琳')).toEqual({ ok: true, value: '艾琳' })
  })

  it('rejects type mismatches without coercion', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.favor', '105', 10)).toMatchObject({ ok: false, kind: 'type-mismatch' })
    expect(guardMvuWrite(SCHEMA, 'mvu.stats', 'broken', { hp: 1 })).toMatchObject({ ok: false, kind: 'type-mismatch' })
    expect(guardMvuWrite(SCHEMA, 'mvu.stats', { hp: 'x', mp: 1 }, { hp: 1, mp: 1 })).toMatchObject({ ok: false, kind: 'type-mismatch' })
  })

  it('locks structure: extra keys rejected on flat paths and whole-object writes', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.stats.extra', 1, undefined)).toMatchObject({
      ok: false, kind: 'structure', reason: expect.stringContaining("'mvu.stats.extra' is not in the schema template"),
    })
    expect(guardMvuWrite(SCHEMA, 'mvu.stats', { hp: 1, mp: 1, extra: 2 }, { hp: 1, mp: 1 })).toMatchObject({
      ok: false, kind: 'structure', reason: expect.stringContaining("'extra' is not in the schema template"),
    })
  })

  it('rejects whole-object writes that would drop an existing template field, tolerates partial writes', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.stats', { hp: 1 }, { hp: 1, mp: 1 })).toMatchObject({
      ok: false, kind: 'structure', reason: expect.stringContaining("'mp' would be deleted"),
    })
    // mp 尚未播种：部分写入放行（不要求模板字段齐全）
    expect(guardMvuWrite(SCHEMA, 'mvu.stats', { hp: 2 }, { hp: 1 })).toEqual({ ok: true, value: { hp: 2 }, note: undefined })
  })

  it('supports "*" wildcard dynamic keys and empty-object open subtrees', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.allies.莉娜.hp', 8, undefined)).toEqual({ ok: true, value: 8 })
    expect(guardMvuWrite(SCHEMA, 'mvu.allies.莉娜.hp', 'lots', undefined)).toMatchObject({ ok: false, kind: 'type-mismatch' })
    expect(guardMvuWrite(SCHEMA, 'mvu.notes.任意.更深.键', { 任意: '值' }, undefined)).toEqual({ ok: true, value: { 任意: '值' } })
  })

  it('locks array items to the first-element template, clamping per item', () => {
    const result = guardMvuWrite(SCHEMA, 'mvu.bag', [
      { item: '回血药', count: 3 },
      { item: '蓝药', count: 300 },
    ], undefined)
    expect(result).toMatchObject({
      ok: true,
      value: [{ item: '回血药', count: 3 }, { item: '蓝药', count: 99 }],
      note: expect.stringContaining('mvu.bag[1].count: guard clamp: 300 -> 99'),
    })
    expect(guardMvuWrite(SCHEMA, 'mvu.bag', [{ item: 'a', count: 1, 非法: 'x' }], undefined)).toMatchObject({
      ok: false, kind: 'structure',
    })
    // 不要求项内模板字段齐全（部分写入放行）
    expect(guardMvuWrite(SCHEMA, 'mvu.bag', [{ item: 'a' }], undefined)).toMatchObject({ ok: true })
  })

  it('guards deletions: template fields cannot be deleted, undeclared keys can', () => {
    expect(guardMvuWrite(SCHEMA, 'mvu.stats.hp', undefined, 5)).toMatchObject({
      ok: false, kind: 'structure', reason: expect.stringContaining('cannot be deleted'),
    })
    expect(guardMvuWrite(SCHEMA, 'mvu.name', undefined, '艾琳')).toMatchObject({ ok: false, kind: 'readonly' })
    expect(guardMvuWrite(SCHEMA, 'mvu.notes.临时', undefined, 1)).toEqual({ ok: true, value: undefined })
  })

  it('makes the $schema subtree itself read-only and leaves undeclared top-level names unguarded', () => {
    expect(guardMvuWrite(SCHEMA, '$schema', { mvu: {} }, SCHEMA)).toMatchObject({ ok: false, kind: 'readonly' })
    expect(guardMvuWrite(SCHEMA, '$schema.mvu.favor', { $range: [0, 1] }, undefined)).toMatchObject({ ok: false, kind: 'readonly' })
    expect(guardMvuWrite(SCHEMA, 'other.unrelated', { free: 'form' }, undefined)).toEqual({ ok: true, value: { free: 'form' } })
  })
})

describe('schema plumbing (pure)', () => {
  it('strips only the root $schema key, keeping other $-prefixed keys intact', () => {
    expect(stripMvuSchema({ a: 1, $schema: { x: 1 }, $other: 2 })).toEqual({ a: 1, $other: 2 })
    const untouched = { a: 1 }
    expect(stripMvuSchema(untouched)).toBe(untouched)
  })

  it('diffVariables never reports $schema paths as variable changes', () => {
    const before = { $schema: { mvu: { favor: { $range: [0, 100] } } }, mvu: { favor: 10 } }
    const after = { $schema: { mvu: { favor: { $range: [0, 50] } } }, mvu: { favor: 50 } }
    expect(diffVariables(before, after)).toEqual([{ name: 'mvu.favor', before: 10, after: 50 }])
  })

  it('resolves the schema from the chat tree first, then the card, then initial variables', () => {
    const chat = {
      header: {
        chat_metadata: {
          variables: { $schema: { from: 'chat' }, mvu: { favor: 1 } },
          initial_variables: { $schema: { from: 'initial' } },
        },
      },
      messages: [],
    } as never
    const card = {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: { extensions: { agentTavern: { initialVariables: { $schema: { from: 'card' } } } } },
    } as never
    expect(readMvuSchema(chat, card)).toEqual({ from: 'chat' })
    expect(readMvuSchema({
      ...chat,
      header: { chat_metadata: { variables: { mvu: { favor: 1 } }, initial_variables: { $schema: { from: 'initial' } } }, user_name: 'u', character_name: 'c' },
    } as never, card)).toEqual({ from: 'card' })
    expect(readMvuSchema(chat, undefined)).toEqual({ from: 'chat' })
  })

  it('applyMvuSettlementGuard is an identity pass without a schema or without variables', () => {
    const chat = { header: { chat_metadata: { variables: { mvu: { favor: 10 } } } }, messages: [] } as never
    expect(applyMvuSettlementGuard(chat, undefined, { mvu: { favor: 5 } })).toEqual({ failures: [], notes: {} })
    expect(applyMvuSettlementGuard({ header: { chat_metadata: {} }, messages: [] } as never, undefined, {})).toEqual({ failures: [], notes: {} })
  })

  it('applyMvuSettlementGuard clamps, reverts rejects, and rolls back $schema self-writes', () => {
    const schema = { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] } } }
    const before = { $schema: schema, mvu: { favor: 10, mood: 'calm' } }
    const live = {
      $schema: { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['hacked'] } } },
      mvu: { favor: 150, mood: 'angry' },
    }
    const chat = { header: { chat_metadata: { variables: live } }, messages: [] } as never
    const result = applyMvuSettlementGuard(chat, undefined, before)
    expect(result.failures).toEqual([
      expect.stringContaining('$schema: guard readonly'),
      expect.stringContaining('mvu.mood: guard enum-violation'),
    ])
    expect(result.notes).toEqual({ 'mvu.favor': 'mvu.favor: guard clamp: 150 -> 100' })
    expect(live.$schema).toEqual(schema)
    expect(live.mvu).toEqual({ favor: 100, mood: 'calm' })
  })
})

/* --------------------- ST 链路集成：生成 / 重试 / 投影 --------------------- */

const GUARD_CHARACTER = '甘道'
const GUARD_PLAIN_CHARACTER = '洛尘'

function makeChat(variables?: Record<string, unknown>) {
  return {
    user_name: 'User', character_name: GUARD_CHARACTER,
    chat_metadata: {
      createdAt: new Date().toISOString(), timedWorldInfo: {},
      ...(variables === undefined ? {} : { variables: structuredClone(variables) }),
    },
  }
}

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

describe('MVU $schema guard on the ST settlement path (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmReply = ''
  let schemaChatId: string
  let plainChatId: string

  const GUARD_VARIABLES = {
    $schema: { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] }, name: { $ro: true }, stats: { hp: 0, mp: 0 } } },
    mvu: { favor: 10, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } },
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-mvu-guard-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    const cardData = (name: string, extensions: Record<string, unknown> = {}) => ({
      name, description: `${name}的描述。`, personality: '', scenario: '', first_mes: '你好。', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '', extensions,
    })
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData(GUARD_CHARACTER, {
        agentTavern: { statusTemplate: '<div class="mvu-status">好感：<%- getvar("mvu.favor") ?? 0 %>|<%- getvar("mvu.mood") ?? "" %></div>' },
      }),
    })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(GUARD_PLAIN_CHARACTER) })
    schemaChatId = await store.createChat(GUARD_CHARACTER, makeChat(GUARD_VARIABLES), [])
    plainChatId = await store.createChat(GUARD_PLAIN_CHARACTER, makeChat({ mvu: { favor: 10 } }), [])

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

  it('clamps an out-of-range write-through and records it as a guard-noted change (not a failure)', async () => {
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 95) -%>好感上升。`
    try {
      const saved = await generate(GUARD_CHARACTER, schemaChatId, '请客吃饭')
      const variables = saved.chat.header.chat_metadata.variables
      expect(variables.mvu.favor).toBe(100)
      expect(variables.$schema).toEqual(GUARD_VARIABLES.$schema)
      const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
      expect(receipts.at(-1)!).toMatchObject({ status: 'updated', failures: [] })
      expect(receipts.at(-1)!.changes).toEqual([
        { name: 'mvu.favor', before: 10, after: 100, reason: 'mvu.favor: guard clamp: 105 -> 100' },
      ])
    } finally {
      llmReply = ''
    }
  })

  it('rejects enum / readonly / structure writes: values rolled back, failures retryable', async () => {
    llmReply = `<% setvar('mvu.mood', 'angry') -%><% setvar('mvu.name', '新名字') -%><% setvar('mvu.stats.extra', 1) -%>表面平静。`
    try {
      const saved = await generate(GUARD_CHARACTER, schemaChatId, '试探')
      const variables = saved.chat.header.chat_metadata.variables
      expect(variables.mvu.mood).toBe('calm')
      expect(variables.mvu.name).toBe('艾琳')
      expect(variables.mvu.stats).toEqual({ hp: 5, mp: 5 })
      const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
      expect(receipts.at(-1)!.status).toBe('failed')
      expect(receipts.at(-1)!.changes).toEqual([])
      expect(receipts.at(-1)!.failures).toEqual([
        expect.stringContaining('mvu.mood: guard enum-violation'),
        expect.stringContaining('mvu.name: guard readonly'),
        expect.stringContaining('mvu.stats.extra: guard structure'),
      ])
    } finally {
      llmReply = ''
    }
  })

  it('rolls back a template attempt to rewrite the $schema subtree itself', async () => {
    llmReply = `<% setvar('$schema.mvu.favor', {}) -%>偷改守卫。`
    try {
      const saved = await generate(GUARD_CHARACTER, schemaChatId, '作弊')
      const variables = saved.chat.header.chat_metadata.variables
      expect(variables.$schema).toEqual(GUARD_VARIABLES.$schema)
      const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
      expect(receipts.at(-1)!.status).toBe('failed')
      expect(receipts.at(-1)!.failures[0]).toContain('$schema: guard readonly')
      // $schema 不是变量：不进 changes
      expect(receipts.at(-1)!.changes).toEqual([])
    } finally {
      llmReply = ''
    }
  })

  it('keeps schema-less cards byte-identical in behavior (no reason, no failures)', async () => {
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 5) -%>好感+5。`
    try {
      const saved = await generate(GUARD_PLAIN_CHARACTER, plainChatId, 'hello')
      expect(saved.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 15 } })
      const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
      expect(receipts.at(-1)!).toMatchObject({ status: 'updated', failures: [] })
      expect(receipts.at(-1)!.changes).toEqual([{ name: 'mvu.favor', before: 10, after: 15 }])
    } finally {
      llmReply = ''
    }
  })

  it('hides $schema from the status payload and the rendered status bar, including the AgentTavern overlay', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(GUARD_CHARACTER)}/${schemaChatId}`), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.ok).toBe(true)
    expect(payload.variables).toEqual({ mvu: { favor: 100, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } } })
    expect(JSON.stringify(payload.variables)).not.toContain('$schema')
    expect(payload.renderedHtml).toContain('好感：100|calm')
    expect(payload.renderedHtml).not.toContain('$schema')

    // AgentTavern 绑定：chat 作用域变量覆盖回嵌套树后同样不泄漏 $schema
    const scoped = await VariableStore.open(join(home, 'tavern'))
    await scoped.set('chat', schemaChatId, 'mvu.favor', 77)
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-guard-overlay': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: GUARD_CHARACTER, chatId: schemaChatId },
      },
    }))
    const overlay = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(GUARD_CHARACTER)}/${schemaChatId}`), overlay)
    const overlayPayload = JSON.parse(overlay.chunks.join(''))
    expect(overlayPayload.variables).toEqual({ mvu: { favor: 77, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } } })
    expect(overlayPayload.renderedHtml).toContain('好感：77|calm')
  })

  it('runs the guard on mvu/retry: clamp lands with a reason, reject rolls back with a failure', async () => {
    const now = new Date().toISOString()
    // 渲染失败降级保原文的楼层：标签仍在，retry 重跑输出渲染提取写穿
    const crafted = await store.createChat(GUARD_CHARACTER, makeChat(GUARD_VARIABLES), [
      { name: GUARD_CHARACTER, is_user: false, is_system: false, send_date: now, mes: `<% setvar('mvu.favor', 150) -%><% setvar('mvu.mood', 'angry') -%>正文保持原样` },
    ])
    const retrySnapshot = await store.getChatSnapshot(GUARD_CHARACTER, crafted)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: GUARD_CHARACTER, chatId: crafted, revision: retrySnapshot!.revision }, '/api/dsh-tavern/mvu/retry'), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 10, after: 100, reason: 'mvu.favor: guard clamp: 150 -> 100' },
    ])
    // retry 既有约定：失败项进 failures 但状态不因 failures 变 'failed'
    expect(payload.receipt.status).toBe('updated')
    expect(payload.receipt.failures).toEqual([expect.stringContaining('mvu.mood: guard enum-violation')])
    expect(payload.variables).toEqual({ mvu: { favor: 100, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } } })
    const after = await store.getChatSnapshot(GUARD_CHARACTER, crafted)
    expect(after!.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 100, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } })
    expect(readMvuReceipts(after!.chat)[0]!.changes[0]).toMatchObject({ name: 'mvu.favor', after: 100, reason: expect.stringContaining('guard clamp') })
  })

  it('retries a rejected settle into a valid write once the value conforms (guard applies to retries too)', async () => {
    const now = new Date().toISOString()
    const crafted = await store.createChat(GUARD_CHARACTER, makeChat(GUARD_VARIABLES), [
      { name: GUARD_CHARACTER, is_user: false, is_system: false, send_date: now, mes: `<% setvar('mvu.mood', 'angry') -%>失败楼层` },
    ])
    const first = await store.getChatSnapshot(GUARD_CHARACTER, crafted)
    const rejected = makeResponse()
    await apiHandler(makeRequest({ character: GUARD_CHARACTER, chatId: crafted, revision: first!.revision }, '/api/dsh-tavern/mvu/retry'), rejected)
    const rejectedPayload = JSON.parse(rejected.chunks.join(''))
    expect(rejectedPayload.receipt.status).toBe('unchanged')
    expect(rejectedPayload.receipt.failures[0]).toContain('guard enum-violation')

    // 修正楼层文本后重试：合法枚举值放行
    const fixed = await store.getChatSnapshot(GUARD_CHARACTER, crafted)
    await store.saveChat(GUARD_CHARACTER, crafted, {
      ...fixed!.chat,
      messages: [{ ...fixed!.chat.messages[0]!, mes: `<% setvar('mvu.mood', 'tense') -%>修正后的楼层` }],
    }, fixed!.revision)
    const retrySnapshot = await store.getChatSnapshot(GUARD_CHARACTER, crafted)
    const retried = makeResponse()
    await apiHandler(makeRequest({ character: GUARD_CHARACTER, chatId: crafted, revision: retrySnapshot!.revision }, '/api/dsh-tavern/mvu/retry'), retried)
    const retriedPayload = JSON.parse(retried.chunks.join(''))
    expect(retriedPayload.receipt.status).toBe('updated')
    expect(retriedPayload.receipt.changes).toEqual([{ name: 'mvu.mood', before: 'calm', after: 'tense' }])
    expect(retriedPayload.variables.mvu.mood).toBe('tense')
  })
})
