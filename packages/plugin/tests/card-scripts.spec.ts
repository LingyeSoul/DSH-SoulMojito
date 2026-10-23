/**
 * 卡脚本右栏（2026-10-21）的服务端面：`GET card/scripts` 只读
 * `data.extensions.tavern_helper.scripts`，过滤类型/启用状态/空内容，并给出
 * 稳定的回退 id。独立文件：index.ts 的模块级 memoization 把 apply 绑定首个
 * DSH_HOME（与 frontend-route.spec.ts 同款理由）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectCardScripts } from '../src/card-scripts.js'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { decodeCharacterCard } from '../../tavern-format/src/index.js'

function rawCard(extensions: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Script Carrier', description: '', personality: '', scenario: '', first_mes: '',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      extensions,
      ...extra,
    },
  }
}

describe('collectCardScripts', () => {
  it('lists enabled script nodes with their content and info', () => {
    const card = decodeCharacterCard(rawCard({
      world: 'Linked World',
      tavern_helper: {
        scripts: [
          { type: 'script', id: 'a', name: 'Alpha', content: 'console.log(1)', info: 'first' },
          { type: 'folder', id: 'f', name: 'Folder' },
          { type: 'script', id: 'b', name: 'Disabled', content: 'x', enabled: false },
          { type: 'script', id: 'c', name: 'Blank', content: '   ' },
          { type: 'script', id: 'd', name: 'Empty info', content: 'y' },
        ],
      },
    }))
    const bundle = collectCardScripts(card)
    expect(bundle.world).toBe('Linked World')
    expect(bundle.scripts.map((script) => script.name)).toEqual(['Alpha', 'Empty info'])
    expect(bundle.scripts[0]).toEqual({ id: 'a', name: 'Alpha', content: 'console.log(1)', info: 'first', enabled: true })
    expect(bundle.scripts[1]?.info).toBe('')
  })

  it('falls back to a stable per-index id and to the embedded book name', () => {
    const card = decodeCharacterCard(rawCard({
      tavern_helper: {
        scripts: [{ type: 'script', name: 'No id', content: 'z' }],
      },
    }, { character_book: { name: 'Embedded Book', entries: [] } }))
    const bundle = collectCardScripts(card)
    expect(bundle.world).toBe('Embedded Book')
    expect(bundle.scripts[0]?.id).toBe('script-0')
  })

  it('returns an empty list and null world for cards without helper scripts', () => {
    const bundle = collectCardScripts(decodeCharacterCard(rawCard({})))
    expect(bundle).toEqual({ world: null, scripts: [] })
  })
})

describe('card/scripts route e2e', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string
  let otherChatId: string

  function makeRequest(url: string, method = 'GET', body?: unknown) {
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

  async function call(url: string, method = 'GET', body?: unknown) {
    const res = makeResponse()
    await apiHandler(makeRequest(url, method, body), res)
    return { status: res.statusCode, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : null }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-card-scripts-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter(rawCard({
      world: 'Linked World',
      tavern_helper: {
        scripts: [
          { type: 'script', id: 'panel', name: 'Floating GM Panel', content: 'window.panel = true', info: 'hud' },
          { type: 'script', id: 'off', name: 'Disabled', content: 'x', enabled: false },
        ],
      },
    }))
    await store.importCharacter({
      ...rawCard({}),
      data: { ...rawCard({}).data, name: 'Plain Carrier' },
    })
    const header = { user_name: 'User', character_name: 'Script Carrier', chat_metadata: {} }
    chatId = await store.createChat('Script Carrier', header)
    otherChatId = await store.createChat('Script Carrier', header)
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

  it('returns the enabled card scripts and the linked world', async () => {
    const result = await call(`/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent('Script Carrier')}`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      character: 'Script Carrier',
      world: 'Linked World',
      scripts: [{ id: 'panel', name: 'Floating GM Panel', content: 'window.panel = true', info: 'hud', enabled: true }],
    })
  })

  it('returns an empty array for cards without scripts', async () => {
    const result = await call(`/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent('Plain Carrier')}`)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, scripts: [], world: null })
  })

  it('prefers the session script-tree copy when chatId is given, without changing the old behavior', async () => {
    const sessionTrees = [
      {
        type: 'folder', id: 'zod-folder', name: 'Zod', scripts: [
          { type: 'script', id: 'zod', name: '示例卡_zod', content: 'registerMvuSchema({ v: 2 })', enabled: true, button: { enabled: true } },
        ],
      },
      { type: 'script', id: 'panel', name: 'Floating GM Panel (edited)', content: 'window.panel = 2', info: 'session copy' },
      { type: 'script', id: 'off', name: 'Disabled in copy', content: 'x', enabled: false },
    ]
    await store.putChatScripts('Script Carrier', chatId, sessionTrees)

    const withChat = await call(`/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent('Script Carrier')}&chatId=${encodeURIComponent(chatId)}`)
    expect(withChat.status).toBe(200)
    expect(withChat.body).toEqual({
      ok: true,
      character: 'Script Carrier',
      world: 'Linked World',
      scripts: [
        { id: 'zod', name: '示例卡_zod', content: 'registerMvuSchema({ v: 2 })', info: '', enabled: true },
        { id: 'panel', name: 'Floating GM Panel (edited)', content: 'window.panel = 2', info: 'session copy', enabled: true },
      ],
    })

    // 其他聊天没有副本：回卡内脚本
    const otherChat = await call(`/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent('Script Carrier')}&chatId=${encodeURIComponent(otherChatId)}`)
    expect((otherChat.body?.scripts as Array<Record<string, unknown>>).map((script) => script.id)).toEqual(['panel'])

    // 无 chatId 时行为完全不变（仍读卡内脚本）
    const cardOnly = await call(`/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent('Script Carrier')}`)
    expect(cardOnly.body?.scripts).toEqual([
      { id: 'panel', name: 'Floating GM Panel', content: 'window.panel = true', info: 'hud', enabled: true },
    ])
  })

  it('answers 404 for a missing character and rejects a missing query', async () => {
    const missing = await call('/api/dsh-soulmojito/card/scripts?character=Ghost')
    expect(missing.status).toBe(404)
    expect(String(missing.body?.message)).toContain("character 'Ghost' not found")

    const noQuery = await call('/api/dsh-soulmojito/card/scripts')
    expect(noQuery.status).toBe(500)
    expect(String(noQuery.body?.message)).toContain('character query is required')
  })

  it('persists cardScriptsAutoRun through the state PATCH boolean whitelist', async () => {
    const enabled = await call('/api/dsh-soulmojito/state', 'POST', { cardScriptsAutoRun: true })
    expect(enabled.status).toBe(200)
    expect((enabled.body?.state as Record<string, unknown>).cardScriptsAutoRun).toBe(true)
    expect((await store.getState()).cardScriptsAutoRun).toBe(true)

    // 非布尔值被忽略（保持 true），不会把安全开关误开/误关
    const ignored = await call('/api/dsh-soulmojito/state', 'POST', { cardScriptsAutoRun: 'yes' })
    expect((ignored.body?.state as Record<string, unknown>).cardScriptsAutoRun).toBe(true)

    const disabled = await call('/api/dsh-soulmojito/state', 'POST', { cardScriptsAutoRun: false })
    expect((disabled.body?.state as Record<string, unknown>).cardScriptsAutoRun).toBe(false)
    expect((await store.getState()).cardScriptsAutoRun).toBe(false)
  })
})
