/**
 * TavernHelper 兼容面（2026-10-20，用户需求「深度兼容酒馆助手行为」）的
 * HTTP e2e：真实 Tavern store + 真实路由。覆盖快照、变量四作用域、楼层
 * 增删改、事件数据源（快照比对所依赖的 message_id/role 形状）与明确的
 * 不支持错误。独立文件：index.ts 的 apply memoization 绑定首个 DSH_HOME。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
    store = await TavernStore.open(join(home, 'soulmojito'))
    chatId = await store.createChat(CHARACTER, HEADER, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'greeting' },
      { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'hello' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'reply', extra: { mood: 'calm' } },
    ])
    await store.importWorldFile('Helper Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: 'base', content: 'base lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
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

  it('resolves the soulmojito data root on a fresh home', () => {
    // 2026-10-21 存储目录迁移：干净 home 只有一个 soulmojito/ 库，旧目录不生成。
    expect(existsSync(join(home, 'soulmojito', 'characters'))).toBe(true)
    expect(existsSync(join(home, 'tavern'))).toBe(false)
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

  it('lorebook.get 优先会话副本，lorebook.put 只写副本，基础资产不变', async () => {
    const base = await call({ op: 'lorebook.get', character: CHARACTER, chatId, name: 'Helper Lore' })
    expect(base.status).toBe(200)
    const baseValue = base.body?.value as { name: string; entries: Array<Record<string, unknown>> }
    expect(baseValue.entries[0]).toMatchObject({ world: 'Helper Lore', content: 'base lore' })

    const written = await call({
      op: 'lorebook.put',
      character: CHARACTER,
      chatId,
      name: 'Helper Lore',
      entries: [{ uid: 0, key: [], content: 'script lore', world: 'Helper Lore' }],
    })
    expect(written.status).toBe(200)
    const writtenValue = written.body?.value as { name: string; entries: Array<Record<string, unknown>> }
    expect(writtenValue.name).toBe('Helper Lore')
    // `world` is stripped before normalization and re-attached for the reader.
    expect(writtenValue.entries[0]).toMatchObject({ world: 'Helper Lore', content: 'script lore' })

    // 基础世界书资产保持只读
    expect((await store.getWorld('Helper Lore'))?.entries[0]?.content).toBe('base lore')
    // 会话副本成为本聊天的读取源
    const copy = await call({ op: 'lorebook.get', character: CHARACTER, chatId, name: 'Helper Lore' })
    expect((copy.body?.value as { entries: Array<Record<string, unknown>> }).entries[0]?.content).toBe('script lore')
    // 其它聊天仍读基础资产
    const otherChatId = await store.createChat(CHARACTER, HEADER)
    const other = await call({ op: 'lorebook.get', character: CHARACTER, chatId: otherChatId, name: 'Helper Lore' })
    expect((other.body?.value as { entries: Array<Record<string, unknown>> }).entries[0]?.content).toBe('base lore')
  })

  it('lorebook.reset 丢弃会话副本并回到角色卡原版世界书', async () => {
    const reset = await call({ op: 'lorebook.reset', character: CHARACTER, chatId, name: 'Helper Lore' })
    expect(reset.status).toBe(200)
    expect(reset.body?.value).toEqual({ name: 'Helper Lore', reset: true })
    const readBack = await call({ op: 'lorebook.get', character: CHARACTER, chatId, name: 'Helper Lore' })
    expect((readBack.body?.value as { entries: Array<Record<string, unknown>> }).entries[0]?.content).toBe('base lore')
    // 重复重置是幂等的
    const again = await call({ op: 'lorebook.reset', character: CHARACTER, chatId, name: 'Helper Lore' })
    expect(again.body?.value).toEqual({ name: 'Helper Lore', reset: true })
  })

  it('lorebook.put 拒绝缺少会话作用域或形状非法的 entries', async () => {
    const noChat = await call({ op: 'lorebook.put', character: CHARACTER, chatId: '', name: 'Helper Lore', entries: [] })
    expect(noChat.status).toBe(500)
    expect(String(noChat.body?.message)).toContain('chatId is required for lorebook.put')

    const notArray = await call({ op: 'lorebook.put', character: CHARACTER, chatId, name: 'Helper Lore', entries: 'nope' })
    expect(String(notArray.body?.message)).toContain('entries must be an array')

    const badEntry = await call({ op: 'lorebook.put', character: CHARACTER, chatId, name: 'Helper Lore', entries: [1] })
    expect(String(badEntry.body?.message)).toContain('entries[0] must be an object')

    const missingBook = await call({ op: 'lorebook.put', character: CHARACTER, chatId, name: 'Ghost Lore', entries: [] })
    expect(String(missingBook.body?.message)).toContain("lorebook 'Ghost Lore' not found")
  })

  it('scripts.put/get/reset 按聊天持久化脚本树副本，并随 snapshot 下发', async () => {
    const empty = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((empty.body?.value as Record<string, unknown>).scriptTrees).toBeNull()

    const trees = [
      { type: 'folder', id: 'folder-1', name: 'Zod', scripts: [{ type: 'script', id: 'zod', name: 'Zod', content: 'registerMvuSchema()' }] },
      { type: 'script', id: 'panel', name: 'GM', content: 'window.panel = true', enabled: true, button: { enabled: true } },
    ]
    const put = await call({ op: 'scripts.put', character: CHARACTER, chatId, scriptTrees: trees })
    expect(put.status).toBe(200)
    expect(put.body?.value).toEqual({ scriptTrees: trees })

    const read = await call({ op: 'scripts.get', character: CHARACTER, chatId })
    expect(read.body?.value).toEqual({ scriptTrees: trees })
    // 快照带回副本，刷新/重开 iframe 不再从卡原版起步
    const snapshot = await call({ op: 'snapshot', character: CHARACTER, chatId })
    expect((snapshot.body?.value as Record<string, unknown>).scriptTrees).toEqual(trees)
    // 其他聊天没有副本
    const otherChatId = await store.createChat(CHARACTER, HEADER)
    const other = await call({ op: 'scripts.get', character: CHARACTER, chatId: otherChatId })
    expect(other.body?.value).toEqual({ scriptTrees: null })

    const reset = await call({ op: 'scripts.reset', character: CHARACTER, chatId })
    expect(reset.body?.value).toEqual({ reset: true })
    const afterReset = await call({ op: 'scripts.get', character: CHARACTER, chatId })
    expect(afterReset.body?.value).toEqual({ scriptTrees: null })
  })

  it('scripts.get/put/reset 拒绝缺少 chatId 或形状非法的脚本树', async () => {
    const noGet = await call({ op: 'scripts.get', character: CHARACTER, chatId: '' })
    expect(String(noGet.body?.message)).toContain('chatId is required for scripts.get')

    const noPut = await call({ op: 'scripts.put', character: CHARACTER, chatId: '', scriptTrees: [] })
    expect(String(noPut.body?.message)).toContain('chatId is required for scripts.put')

    const noReset = await call({ op: 'scripts.reset', character: CHARACTER, chatId: '' })
    expect(String(noReset.body?.message)).toContain('chatId is required for scripts.reset')

    const notArray = await call({ op: 'scripts.put', character: CHARACTER, chatId, scriptTrees: {} })
    expect(String(notArray.body?.message)).toContain('scriptTrees must be an array')

    const badNode = await call({ op: 'scripts.put', character: CHARACTER, chatId, scriptTrees: ['x'] })
    expect(String(badNode.body?.message)).toContain('scriptTrees[0] must be an object')
  })
})
