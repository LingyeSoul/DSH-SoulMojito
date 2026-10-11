import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 声明式按钮 + 桥下行事件的 HTTP 面 e2e（A-1c/A-1d，2026-10-11）：
// - `POST mods/<id>/button/<name>` 经真实路由：loaded→{ok,handled}、URL 编码 CJK
//   显示名往返、context 透传、handler 抛错→500+button-error 审计；
// - 未装载 / 未知按钮 / 开关关闭 → 404 与未知路由不可区分（含响应体同形）；
// - bootstrap 投影带 buttons（客户端渲染按钮 chips 的数据源）。
// 独立文件：index.ts 的模块级 memoization 把 apply 绑定首个 home（同文件第二个
// describe 会空转），与 tavern-mods-p2-e2e.spec.ts 同款理由。

const MOD_ID = 'e2e.buttons'
const BUTTON_NAME = '拨快 1 小时'

describe('mod button route e2e through the real HTTP surface', () => {
  let home: string
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

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
    return { status: res.statusCode, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : null }
  }

  const buttonUrl = (name: string) => `/api/dsh-tavern/mods/${MOD_ID}/button/${encodeURIComponent(name)}`

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-modbtn-e2e-'))
    process.env.DSH_HOME = home
    const directory = join(home, 'tavern', 'mods', MOD_ID)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'mod.json'), JSON.stringify({
      id: MOD_ID, name: 'E2E Buttons', version: '1.0.0', author: 't', description: 'button route probe',
      main: 'index.mjs', buttons: [BUTTON_NAME, '闲置'],
    }), 'utf8')
    writeFileSync(join(directory, 'index.mjs'), `
      export async function setup(api) {
        api.onButton(${JSON.stringify(BUTTON_NAME)}, async (click, context) => {
          await api.storage.set('lastClick', { name: click.name, character: context.character ?? null, chatId: context.chatId ?? null })
        })
      }
    `, 'utf8')
    await TavernStore.open(join(home, 'tavern'))
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
    delete process.env.DSH_TAVERN_DISABLE_MODS
    rmSync(home, { recursive: true, force: true })
  })

  it('projects declared buttons through bootstrap for both disabled and loaded mods', async () => {
    const disabled = await call('GET', '/api/dsh-tavern/bootstrap')
    const asDisabled = (disabled.body!.mods as Array<{ id: string; buttons: string[] }>).find((mod) => mod.id === MOD_ID)
    expect(asDisabled?.buttons).toEqual([BUTTON_NAME, '闲置'])
    // 未启用时点击同一 URL：先取一份 404 基准（后面与停用态比对不可区分性）。
    const beforeEnable = await call('POST', buttonUrl(BUTTON_NAME), {})
    expect(beforeEnable.status).toBe(404)
    expect((beforeEnable.body!.message as string).startsWith('route not found: POST mods/')).toBe(true)
    expect((await call('POST', `/api/dsh-tavern/mods/${MOD_ID}/enable`, {})).status).toBe(200)
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: true })).status).toBe(200)
    const loaded = await call('GET', '/api/dsh-tavern/bootstrap')
    const asLoaded = (loaded.body!.mods as Array<{ id: string; status: string; buttons: string[] }>).find((mod) => mod.id === MOD_ID)
    expect(asLoaded?.status).toBe('loaded')
    expect(asLoaded?.buttons).toEqual([BUTTON_NAME, '闲置'])
    // 停用后同一 URL 回到与未启用时逐字节相同的 404（不可区分）。
    expect((await call('POST', `/api/dsh-tavern/mods/${MOD_ID}/disable`, {})).status).toBe(200)
    const disabledClick = await call('POST', buttonUrl(BUTTON_NAME), {})
    expect(disabledClick.status).toBe(404)
    expect(disabledClick.body).toEqual(beforeEnable.body)
    expect((await call('POST', `/api/dsh-tavern/mods/${MOD_ID}/enable`, {})).status).toBe(200)
  })

  it('dispatches button clicks with URL-encoded CJK names and context passthrough', async () => {
    const click = await call('POST', buttonUrl(BUTTON_NAME), { character: 'ExampleCard', chatId: 'chat-1' })
    expect(click.status).toBe(200)
    expect(click.body).toEqual({ ok: true, handled: true })
    const stored = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')).values.lastClick
    expect(stored).toEqual({ name: BUTTON_NAME, character: 'ExampleCard', chatId: 'chat-1' })
    // 空体（面板 chips 无绑定上下文）：context 字段缺省
    const bare = await call('POST', buttonUrl(BUTTON_NAME), {})
    expect(bare.body).toEqual({ ok: true, handled: true })
    const bareStored = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')).values.lastClick
    expect(bareStored).toEqual({ name: BUTTON_NAME, character: null, chatId: null })
  })

  it('answers { ok, handled: false } for declared buttons without a handler', async () => {
    const idle = await call('POST', buttonUrl('闲置'))
    expect(idle.status).toBe(200)
    expect(idle.body).toEqual({ ok: true, handled: false })
  })

  it('keeps unknown buttons indistinguishable from unknown routes at the 404 shape', async () => {
    // 未知按钮 / 未知 mod id / 非法名：一律走 notFound() 的同一形状
    // {ok:false, message:'route not found: <method> <route>'}——消息只回显请求方
    // 自己的 URL，不泄露 mod 是否存在、按钮是否声明过。
    const unknownButton = await call('POST', buttonUrl('不存在的按钮'))
    expect(unknownButton.status).toBe(404)
    expect(unknownButton.body!.ok).toBe(false)
    expect((unknownButton.body!.message as string)).toBe(`route not found: POST mods/${MOD_ID}/button/${encodeURIComponent('不存在的按钮')}`)
    const unknownMod = await call('POST', `/api/dsh-tavern/mods/ghost.mod/button/${encodeURIComponent(BUTTON_NAME)}`)
    expect(unknownMod.status).toBe(404)
    expect((unknownMod.body!.message as string)).toContain('route not found: POST mods/ghost.mod')
  })

  it('converts throwing handlers into 500 with a button-error audit line', async () => {
    const boomId = 'e2e.boom-button'
    const directory = join(home, 'tavern', 'mods', boomId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'mod.json'), JSON.stringify({
      id: boomId, name: 'Boom', version: '1.0.0', author: 't', description: 'throws on click',
      main: 'index.mjs', buttons: ['炸'],
    }), 'utf8')
    writeFileSync(join(directory, 'index.mjs'), `
      export async function setup(api) { api.onButton('炸', async () => { throw new Error('e2e button kaboom') }) }
    `, 'utf8')
    // refresh 吸收新目录（幂等重设全局开关的副作用即 rescan）
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: true })).status).toBe(200)
    expect((await call('POST', `/api/dsh-tavern/mods/${boomId}/enable`, {})).status).toBe(200)
    const failed = await call('POST', `/api/dsh-tavern/mods/${boomId}/button/${encodeURIComponent('炸')}`)
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ ok: false })
    expect((failed.body!.message as string)).toContain('e2e button kaboom')
    const audit = readFileSync(join(home, 'tavern', 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"button-error"')
    expect(audit).toContain('e2e button kaboom')
  })
})
