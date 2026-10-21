/**
 * TavernHelper 兼容面（2026-10-20，用户需求「深度兼容酒馆助手行为」）的
 * HTTP e2e：真实 Tavern store + 真实路由。覆盖快照、变量四作用域、楼层
 * 增删改、事件数据源（快照比对所依赖的 message_id/role 形状）与明确的
 * 不支持错误。独立文件：index.ts 的 apply memoization 绑定首个 DSH_HOME。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Helper Probe'
const HEADER = { user_name: 'User', character_name: CHARACTER, chat_metadata: {} }

describe('helper route e2e (TavernHelper compatibility surface)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string

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
      headersSent: false,
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

  async function call(body: unknown) {
    const res = makeResponse()
    await apiHandler(makeRequest(body, '/api/dsh-soulmojito/helper'), res)
    return { status: res.statusCode, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : null }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-helper-e2e-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    chatId = await store.createChat(CHARACTER, HEADER, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'greeting' },
      { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'hello' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'reply', extra: { mood: 'calm' } },
    ])
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('snapshots the bound chat in TavernHelper message shape', async () => {
    const result = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect(result.status).toBe(200)
    const value = result.body?.value as Record<string, unknown>
    expect(value.characterName).toBe(CHARACTER)
    expect(value.lastMessageId).toBe(2)
    const messages = value.messages as Array<Record<string, unknown>>
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant'])
    expect(messages[2]).toMatchObject({ message_id: 2, message: 'reply', data: { mood: 'calm' } })
  })

  it('writes global and chat variables, and mirrors the chat scope for AgentTavern', async () => {
    const global = await call({
      op: 'variables.replace',
      character: CHARACTER,
      chatId,
      scope: 'global',
      variables: { 神乐光: { 好感度: 5 } },
    })
    expect(global.body?.value).toEqual({ 神乐光: { 好感度: 5 } })

    const chat = await call({
      op: 'variables.replace',
      character: CHARACTER,
      chatId,
      scope: 'chat',
      variables: { 商品: [{ 内容: '药水' }], 回合: 3 },
    })
    expect(chat.status).toBe(200)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    expect(snapshot?.chat.header.chat_metadata.variables).toEqual({ 商品: [{ 内容: '药水' }], 回合: 3 })
    const readBack = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((readBack.body?.value as Record<string, unknown>).variables).toMatchObject({
      global: { 神乐光: { 好感度: 5 } },
      chat: { 商品: [{ 内容: '药水' }], 回合: 3 },
    })
  })

  it('writes MVU stat_data through the message and chat authority tree', async () => {
    const statData = {
      系统状态: { 主角创建完毕: true },
      主角: { 个人信息: { '身份&职业': '学生' } },
      进程: { 阶段: '幕间休息' },
    }
    const written = await call({
      op: 'mvu.replace',
      character: CHARACTER,
      chatId,
      statData,
      messageId: 2,
    })
    expect(written.status).toBe(200)
    expect(written.body?.value).toMatchObject({ stat_data: statData, messageId: 2 })
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    expect(snapshot?.chat.header.chat_metadata.variables).toMatchObject({ stat_data: statData, 商品: [{ 内容: '药水' }] })
    expect(snapshot?.chat.messages[2]?.variables).toMatchObject({ stat_data: statData })
    const readBack = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((readBack.body?.value as Record<string, unknown>).variables).toMatchObject({ chat: { stat_data: statData } })
  })

  it('reads and writes message-scoped variables', async () => {
    const written = await call({
      op: 'variables.replace',
      character: CHARACTER,
      chatId,
      scope: 'message',
      messageId: 2,
      variables: { 阶段: 'climax' },
    })
    expect(written.body?.value).toEqual({ 阶段: 'climax' })
    const snapshot = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((snapshot.body?.value as Record<string, unknown>).variables).toMatchObject({ message: { 阶段: 'climax' } })
  })

  it('rejects character writes and unknown scopes with explicit errors', async () => {
    const character = await call({ op: 'variables.replace', character: CHARACTER, chatId, scope: 'character', variables: {} })
    expect(character.status).toBe(500)
    expect(String(character.body?.message)).toContain('read-only')
    const bogus = await call({ op: 'variables.replace', character: CHARACTER, chatId, scope: 'script', variables: {} })
    expect(String(bogus.body?.message)).toContain('unsupported variable scope')
  })

  it('gets a message range with role filter and negative depth', async () => {
    const latest = await call({ op: 'messages.get', character: CHARACTER, chatId, range: -1 })
    expect((latest.body?.value as Array<Record<string, unknown>>).map((message) => message.message_id)).toEqual([2])
    const range = await call({ op: 'messages.get', character: CHARACTER, chatId, range: '0-{{lastMessageId}}' })
    expect((range.body?.value as unknown[]).length).toBe(3)
    const userOnly = await call({ op: 'messages.get', character: CHARACTER, chatId, range: '0-2', role: 'user' })
    expect(userOnly.body?.value).toMatchObject([{ message_id: 1, message: 'hello' }])
  })

  it('sets, creates and deletes messages', async () => {
    const edited = await call({ op: 'messages.set', character: CHARACTER, chatId, messages: [{ message_id: 1, message: 'edited hello' }] })
    expect(edited.status).toBe(200)
    const created = await call({
      op: 'messages.create',
      character: CHARACTER,
      chatId,
      messages: [{ role: 'user', message: 'inserted', insert_before: 0 }],
      insertBefore: 0,
    })
    expect(created.status).toBe(200)
    const afterCreate = await call({ op: 'snapshot', character: CHARACTER, chatId })
    const texts = ((afterCreate.body?.value as Record<string, unknown>).messages as Array<Record<string, unknown>>).map((message) => message.message)
    expect(texts).toEqual(['inserted', 'greeting', 'edited hello', 'reply'])
    const deleted = await call({ op: 'messages.delete', character: CHARACTER, chatId, messageIds: [0] })
    expect(deleted.status).toBe(200)
    const afterDelete = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((afterDelete.body?.value as Record<string, unknown>).lastMessageId).toBe(2)
  })

  it('runs an STscript subset and persists variable writes', async () => {
    const result = await call({ op: 'slash', character: CHARACTER, chatId, command: '/setvar 心情 平静 | /getvar 心情' })
    expect(result.body?.value).toMatchObject({ output: '平静' })
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    expect(snapshot?.chat.header.chat_metadata.variables).toMatchObject({ 心情: '平静' })
  })

  it('fails explicitly on unsupported ops instead of pretending success', async () => {
    const result = await call({ op: 'generate', character: CHARACTER, chatId })
    expect(result.status).toBe(500)
    expect(String(result.body?.message)).toContain('unsupported helper op')
  })
})
