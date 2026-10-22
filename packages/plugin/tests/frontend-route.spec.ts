/**
 * 美化前端右栏（2026-10-20）的 HTTP 面 e2e：`GET frontend/latest` 必须从真实
 * Tavern store 的聊天文件里挑出「最新一条带完整 HTML 的楼层」，只回传文档本身
 * （不是整份聊天），并把楼层号交给客户端做标题。独立文件：index.ts 的模块级
 * memoization 把 apply 绑定首个 DSH_HOME（与 tavern-mods-buttons.spec.ts 同款理由）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Frontend Probe'
const HEADER = { user_name: 'unused', character_name: 'unused', chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} } }

describe('frontend/latest route e2e through the real HTTP surface', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string
  let emptyChatId: string
  let httpServer: Server
  let baseUrl = ''

  function makeRequest(url: string, method = 'GET') {
    const listeners = new Map<string, (value?: unknown) => void>()
    return {
      method,
      url,
      on: (event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, listener)
        if (event === 'end') listener()
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

  async function call(url: string) {
    const res = makeResponse()
    await apiHandler(makeRequest(url), res)
    return { status: res.statusCode, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : null }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-frontend-e2e-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    const document = '<!doctype html><html><body><div id="hud">HP 12/12</div></body></html>'
    chatId = await store.createChat(CHARACTER, HEADER, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'old frontend\n<body>old</body>' },
      { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'keep going' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: `status panel:\n\`\`\`html\n${document}\n\`\`\`` },
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'latest prose reply' },
    ])
    emptyChatId = await store.createChat(`${CHARACTER} Empty`, HEADER, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'no html here' },
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
    httpServer = createServer((req, res) => { void apiHandler(req, res) })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('frontend route test server has no port')
    baseUrl = `http://127.0.0.1:${address.port}/api/dsh-soulmojito`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the latest complete document without shipping the whole chat', async () => {
    const result = await call(`/api/dsh-soulmojito/frontend/latest?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(chatId)}`)
    expect(result.status).toBe(200)
    expect(result.body?.ok).toBe(true)
    expect(result.body?.messageCount).toBe(4)
    expect(typeof result.body?.revision).toBe('string')
    expect(result.body?.chat).toBeUndefined()
    expect(result.body?.message).toEqual({
      index: 2,
      name: CHARACTER,
      isUser: false,
      documents: ['<!doctype html><html><body><div id="hud">HP 12/12</div></body></html>'],
    })
  })

  it('omits message when the chat has no complete document', async () => {
    const result = await call(`/api/dsh-soulmojito/frontend/latest?character=${encodeURIComponent(`${CHARACTER} Empty`)}&chatId=${encodeURIComponent(emptyChatId)}`)
    expect(result.status).toBe(200)
    expect(result.body?.message).toBeUndefined()
    expect(result.body?.messageCount).toBe(1)
  })

  it('answers 404 for an unknown chat instead of an empty document', async () => {
    const result = await call(`/api/dsh-soulmojito/frontend/latest?character=${encodeURIComponent(CHARACTER)}&chatId=missing-chat.jsonl`)
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ ok: false, message: 'chat not found' })
  })

  it('rejects a request without chatId', async () => {
    const result = await call(`/api/dsh-soulmojito/frontend/latest?character=${encodeURIComponent(CHARACTER)}`)
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, message: 'chatId query is required' })
  })

  it('streams virtual IndexedDB record bytes through the real HTTP routes', async () => {
    const headers = { 'content-type': 'application/json' }
    const open = await fetch(`${baseUrl}/helper`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op: 'idb.open', character: CHARACTER, chatId, name: 'idb-http', version: 1 }),
    })
    expect(open.status).toBe(200)
    const store = await fetch(`${baseUrl}/helper`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op: 'idb.store.create', character: CHARACTER, chatId, db: 'idb-http', store: 'records', keyPath: 'key' }),
    })
    expect(store.status).toBe(200)

    const query = new URLSearchParams({ character: CHARACTER, db: 'idb-http', store: 'records', key: 'k' }).toString()
    const meta = Buffer.from(JSON.stringify({ note: 'meta' }), 'utf8').toString('base64url')
    const put = await fetch(`${baseUrl}/frontend/idb/put?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-dsh-idb-meta': meta },
      body: Buffer.from('hello'),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ ok: true, value: { key: 'k', size: 5 } })

    const get = await fetch(`${baseUrl}/frontend/idb/get?${query}`)
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('hello')
    expect(get.headers.get('x-dsh-idb-meta')).toBe(meta)

    const remove = await fetch(`${baseUrl}/helper`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op: 'idb.delete', character: CHARACTER, chatId, db: 'idb-http', store: 'records', key: 'k' }),
    })
    expect(remove.status).toBe(200)
    const miss = await fetch(`${baseUrl}/frontend/idb/get?${query}`)
    // IndexedDB's get() miss is a successful undefined result, so the bridge
    // must not turn it into an error (cards report "cache corrupted" on that).
    expect(miss.status).toBe(204)
    expect(await miss.text()).toBe('')
  })

  it('exposes raw V2 card fields to JSR getCharData consumers', async () => {
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: 'Power By Probe',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: 'probe-creator',
        character_version: 'v9.9',
        alternate_greetings: [],
        extensions: {},
      },
    })
    const response = await fetch(`${baseUrl}/helper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'snapshot', character: CHARACTER, chatId }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { value?: { characterData?: Record<string, unknown> } }
    expect(body.value?.characterData).toMatchObject({
      creator: 'probe-creator',
      character_version: 'v9.9',
      creator_notes: 'Power By Probe',
    })
    expect(body.value?.characterData?.creatorNotes).toBeUndefined()
  })
})
