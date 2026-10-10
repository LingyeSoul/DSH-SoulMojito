import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 独立文件（同文件两个 e2e describe 会共享 index.ts 的模块级 memoization——
// storePromise/modHostPromise 绑定首个 home，第二个 home 的 apply 是空转）：
// P2 三件套示例 Mod 的真实闭环——
// - 两层开关启用 → 面板 ui 路由返回 CSP 注入的自包含 HTML（iframe 纪律）；
// - runGeneration 真跑 → post-output hook 观察统计落 mod 私有存储；
// - 抛错 hook 的 mod 不断路：生成照常成功 + hook-degradation 审计；
// - bootstrap 投影带 surfaces（loaded 展示实际注册名单，disabled 展示声明）；
// - POST mods/install 的路由形状校验（无网络路径）。
const MOOD_ID = 'dsh-tavern.mood-tracker'
const repoExampleMod = join(import.meta.dirname, '..', 'examples', 'mods')
const CHAR = 'Mood Character'

describe('mod P2 e2e: generation hooks, panel surface and projections', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  const llmRequests: unknown[] = []

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

  async function call(method: string, url: string, body?: unknown) {
    const res = makeResponse()
    await apiHandler(makeRequest(body, url, method), res)
    const text = res.chunks.join('')
    return { status: res.statusCode, text, body: (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return null } })() }
  }

  async function generate(message: string, character: string, chatId: string) {
    const snapshot = await store.getChatSnapshot(character, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character, chatId, message, revision: snapshot!.revision }, '/api/dsh-tavern/generate'), res)
    return { status: res.statusCode, chunks: res.chunks }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-modp2e2e-'))
    process.env.DSH_HOME = home
    cpSync(join(repoExampleMod, 'dsh-tavern.mood-tracker'), join(home, 'tavern', 'mods', MOOD_ID), { recursive: true })
    const throwingDir = join(home, 'tavern', 'mods', 'throwing-hook')
    mkdirSync(throwingDir, { recursive: true })
    writeFileSync(join(throwingDir, 'mod.json'), JSON.stringify({
      id: 'throwing-hook', name: 'Throwing Hook', version: '1.0.0', author: 't', description: 'throws on post-output',
      main: 'index.mjs',
    }), 'utf8')
    writeFileSync(join(throwingDir, 'index.mjs'), `
      export async function setup(api) {
        api.hooks.on('post-output', () => { throw new Error('p2 e2e hook failure') })
      }
    `, 'utf8')
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHAR, description: 'd', personality: '', scenario: '', first_mes: 'hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
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
      llm: {
        stream: async function* (request: unknown) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: 'mood reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
    // 两层开关全开（mood-tracker + throwing-hook）。
    expect((await call('POST', `/api/dsh-tavern/mods/${MOOD_ID}/enable`, {})).status).toBe(200)
    expect((await call('POST', '/api/dsh-tavern/mods/throwing-hook/enable', {})).status).toBe(200)
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: true })).status).toBe(200)
    const management = await call('GET', '/api/dsh-tavern/mods')
    const statuses = new Map((management.body!.mods as Array<{ id: string; status: string }>).map((mod) => [mod.id, mod.status]))
    expect(statuses.get(MOOD_ID)).toBe('loaded')
    expect(statuses.get('throwing-hook')).toBe('loaded')
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('serves the panel ui as self-contained HTML with the CSP meta and the bridge protocol', async () => {
    const ui = await call('GET', `/api/dsh-tavern/mods/${MOOD_ID}/ui`)
    expect(ui.status).toBe(200)
    expect(ui.text).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(ui.text).toContain("connect-src 'none'")
    expect(ui.text).toContain('dsh-tavern:mod-request')
    expect(ui.text).toContain('dsh-tavern:frontend-height')
    expect(ui.text).toContain("new URLSearchParams(location.search).get('token')")
  })

  it('runs the post-output hook on a real generation and persists its observations', async () => {
    const chatId = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    const result = await generate('hello mood', CHAR, chatId)
    expect(result.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
    const stats = await call('GET', `/api/dsh-tavern/mods/${MOOD_ID}/stats`)
    expect(stats.status).toBe(200)
    expect(stats.body!.replyCount).toBe(1)
    expect(stats.body!.lastReplyLength).toBe('mood reply'.length)
    expect(stats.body!.totalCharacters).toBe('mood reply'.length)
    // 生成落盘的文本未被观察型 hook 改写
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.at(-1)!.mes).toBe('mood reply')
  })

  it('keeps generation alive next to a throwing mod hook and audits the degradation', async () => {
    const chatId = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    const before = (await call('GET', '/api/dsh-tavern/mods')).body!.mods as Array<{ id: string; auditCount: number }>
    const throwingBefore = before.find((mod) => mod.id === 'throwing-hook')!.auditCount
    const result = await generate('survive the boom', CHAR, chatId)
    expect(result.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
    const after = (await call('GET', '/api/dsh-tavern/mods')).body!.mods as Array<{ id: string; auditCount: number }>
    expect(after.find((mod) => mod.id === 'throwing-hook')!.auditCount).toBeGreaterThan(throwingBefore)
    const audit = readFileSync(join(home, 'tavern', 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"hook-degradation"')
    expect(audit).toContain('p2 e2e hook failure')
  })

  it('projects surfaces: loaded mods show live registrations, disabled mods show declarations', async () => {
    const boot = await call('GET', '/api/dsh-tavern/bootstrap')
    const mods = boot.body!.mods as Array<{ id: string; status: string; surfaces: { hooks: string[]; tools: string[]; http: string[] } }>
    const mood = mods.find((mod) => mod.id === MOOD_ID)!
    expect(mood.status).toBe('loaded')
    expect(mood.surfaces.hooks).toEqual(['post-output'])
    expect(mood.surfaces.tools).toEqual(['dsh-tavern.mood-tracker_get_mood', 'dsh-tavern.mood-tracker_set_mood'])
    expect(mood.surfaces.http).toEqual(['GET stats', 'POST mood', 'GET ui'])
    // 停用后回落 manifest 声明（作者自查面）
    expect((await call('POST', `/api/dsh-tavern/mods/${MOOD_ID}/disable`, {})).status).toBe(200)
    const disabled = (await call('GET', '/api/dsh-tavern/bootstrap')).body!.mods as Array<{ id: string; status: string; surfaces: { hooks: string[] } }>
    const moodDisabled = disabled.find((mod) => mod.id === MOOD_ID)!
    expect(moodDisabled.status).toBe('disabled')
    expect(moodDisabled.surfaces.hooks).toEqual(['post-output'])
    expect((await call('POST', `/api/dsh-tavern/mods/${MOOD_ID}/enable`, {})).status).toBe(200)
  })

  it('POST mods/install validates its payload through the real route', async () => {
    const bad = await call('POST', '/api/dsh-tavern/mods/install', { url: '' })
    expect(bad.status).toBe(500)
    expect(bad.body!.message).toContain('expected { url }')
  })
})
