import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runScript, stscriptCommandNames } from '../../tavern-script/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { generationHooks } from '../src/generation-hooks.js'
import { emitGuidesChanged } from '../src/guides.js'
import { ModHost } from '../src/mods/host.js'
import { checkModManifest, satisfiesVersionRange } from '../src/mods/manifest.js'
import { emitAssetsSaved } from '../src/mods/events.js'
import { clearModRegistryForTest, modSectionSnapshot } from '../src/mods/cross-bundle.js'

// 示例 Mod dsh-tavern.story-clock（examples/mods/）的行为锁定：
// 宏（{{clock}} 读聊天变量）/ STscript（/clock 族写聊天变量 + chatChanged）/
// hook（user-input 变换位、post-save 观察位）/ prompt.section / llm 门控面 /
// timers / 事件——与 asset-stats（P1 面）、mood-tracker（P2 三件套）互补，
// 三个示例合计覆盖 mod-api.md 的全部能力面。

const MOD_ID = 'dsh-tavern.story-clock'
const repoExampleMod = join(import.meta.dirname, '..', 'examples', 'mods', MOD_ID)

// 宿主版本取本包真实发布版本（index.ts 的 BUILD_INFO.version 同源语义）——
// 示例 Mod 的 engines 必须对「随仓库发布的宿主」成立，硬编码旧版本会把
// engines 漂移掩盖成绿灯（2026-10-12 story-clock ^0.4.1 卡死 0.5.0 宿主的事故）。
const PLUGIN_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 只实现 ModHost 用到的 state + assets 读面（fakeStateStore + getChat）。 */
function fakeStateStore(initial: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {}) {
  let state = {
    modsEnabled: initial.modsEnabled === true,
    mods: { enabled: { ...(initial.enabled ?? {}) } },
  }
  return {
    getState: async () => structuredClone(state),
    updateState: async (update: (current: typeof state) => Partial<typeof state>) => {
      state = { ...state, ...update(structuredClone(state)) }
      return structuredClone(state)
    },
    getChat: async () => ({
      header: { user_name: 'User', character_name: 'ExampleCard', chat_metadata: {} },
      messages: [
        { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'Another round, please.' },
        { name: 'ExampleCard', is_user: false, is_system: false, send_date: '', mes: 'She slides the glass across the counter.' },
      ],
    }),
  }
}

function fakeRes() {
  const response = {
    chunks: [] as string[],
    headers: {} as Record<string, string>,
    statusCode: 0,
    writableEnded: false,
    setHeader(name: string, value: string) { response.headers[name] = value },
    end(chunk?: string) {
      if (chunk !== undefined) response.chunks.push(String(chunk))
      response.writableEnded = true
    },
  }
  return response
}

/** readModRequestBody 同语义的假请求对象：注册 end 时同步投喂 data + end。 */
function makeReq(body?: string): { on: (event: string, listener: (chunk?: unknown) => void) => unknown } {
  const dataListeners: Array<(chunk?: unknown) => void> = []
  return {
    on(event: string, listener: (chunk?: unknown) => void) {
      if (event === 'data') dataListeners.push(listener)
      if (event === 'end') {
        for (const deliver of [...dataListeners]) deliver(Buffer.from(body ?? ''))
        listener()
      }
      return undefined
    },
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('story-clock example mod', () => {
  let home: string
  let host: ModHost

  beforeAll(async () => {
    clearModRegistryForTest()
    home = tempHome('dsh-story-clock-')
    cpSync(repoExampleMod, join(home, 'tavern', 'mods', MOD_ID), { recursive: true })
    host = await ModHost.open({
      root: join(home, 'tavern'),
      hostVersion: PLUGIN_VERSION,
      dbProvider: (async () => fakeStateStore({ modsEnabled: true, enabled: { [MOD_ID]: true } })) as never,
      ctx: {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        llm: {
          stream: async function* (request: Record<string, unknown>) {
            expect(request.provider).toBe('test-provider')
            yield { type: 'text-delta', text: 'A quiet evening at the tavern.' }
            yield { type: 'usage', usage: { input: 10, output: 7 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      },
    })
  })

  afterAll(async () => {
    await host.disposeAll()
    clearModRegistryForTest()
    rmSync(home, { recursive: true, force: true })
  })

  it('ships a manifest that passes validation with llm capability and engine range', () => {
    const raw = JSON.parse(readFileSync(join(repoExampleMod, 'mod.json'), 'utf8')) as unknown
    const check = checkModManifest(raw, { directory: MOD_ID })
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.manifest.capabilities).toEqual(['storage', 'llm'])
      // engines 声明当前宿主次版本（0.x 下 caret 锁次段）；断言从 PLUGIN_VERSION
      // 推导而非硬编码字面量——升次版本时仍与 drift guard
      // （tavern-mods-examples.spec.ts）一起逼着同步示例清单（0.6.0 同步实践：
      // 2026-10-14 游戏桥发布）。
      expect(check.manifest.engines?.dshTavern).toBe(`^${PLUGIN_VERSION}`)
      expect(satisfiesVersionRange(PLUGIN_VERSION, check.manifest.engines!.dshTavern!).ok).toBe(true)
      expect(check.manifest.surfaces.hooks).toEqual(['user-input', 'post-save'])
      // 声明式按钮（A-1a）：CJK 显示名可声明
      expect(check.manifest.buttons).toEqual(['拨快 1 小时'])
    }
  })

  it('loads with both switches on and reports live surfaces', () => {
    const snapshot = host.snapshot()
    expect(snapshot.globalEnabled).toBe(true)
    const mod = snapshot.mods.find((entry) => entry.id === MOD_ID)
    expect(mod?.status).toBe('loaded')
    expect(mod?.error).toBe('')
    expect([...mod?.surfaces.hooks ?? []].sort()).toEqual(['post-save', 'user-input'])
    expect(mod?.surfaces.http).toEqual(['GET status', 'POST summarize'])
    expect(mod?.buttons).toEqual(['拨快 1 小时'])
  })

  // 声明式按钮（A-1b）：story-clock 的「拨快 1 小时」复用 /clock advance 的推进
  // 逻辑——读当前聊天变量 clock（fake store 无 clock → 0），+60 分钟（第1天 08:00 →
  // 09:00），记入 mod 存储。v1 无聊天写面：把钟真的拨快仍用 /clock advance 1h。
  it('dispatches the declared button with click context into mod storage', async () => {
    await expect(host.dispatchButton(MOD_ID, '拨快 1 小时', { character: 'ExampleCard', chatId: 'chat-1' })).resolves.toBe('handled')
    const stateFile = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')) as { values: Record<string, unknown> }
    expect(stateFile.values['button-ExampleCard-chat-1']).toEqual({ from: 0, to: 60, display: '第1天 09:00' })
    expect(stateFile.values.buttonAdvances).toBe(1)
    // 状态路由的计数器披露按钮推进
    const statusRes = fakeRes()
    await host.handleRoute(makeReq(), statusRes, 'GET', new URL('http://x/api/dsh-tavern/mods/dsh-tavern.story-clock/status'), MOD_ID, 'status')
    expect((JSON.parse(statusRes.chunks[0]!) as { counters: Record<string, number> }).counters.buttonAdvances).toBe(1)
    // 无上下文（面板 chips）：回落全局存储位
    await expect(host.dispatchButton(MOD_ID, '拨快 1 小时')).resolves.toBe('handled')
    const after = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')) as { values: Record<string, unknown> }
    expect(after.values['button-global']).toEqual({ from: 0, to: 60, display: '第1天 09:00' })
    expect(after.values.buttonAdvances).toBe(2)
  })

  it('expands {{clock}} macros from the chat variable (deterministic, per-chat)', () => {
    const withClock = createMacroEngine({ char: 'ExampleCard', user: 'User', local: { clock: 390 } })
    expect(withClock.expand('{{clock}}')).toBe('第1天 14:30')
    expect(withClock.expand('{{clock::day}}')).toBe('第1天')
    expect(withClock.expand('{{clock::time}}')).toBe('14:30')
    // 未设置变量 → 确定性缺省（第1天 08:00），不是错误也不是随机值。
    const withoutClock = createMacroEngine({ char: 'ExampleCard', user: 'User' })
    expect(withoutClock.expand('now: {{clock}}')).toBe('now: 第1天 08:00')
  })

  it('runs the /clock command family against chat variables', async () => {
    const local = new Map<string, string | number | boolean>()
    const env = {
      expand: (text: string) => text,
      getVar: (name: string) => local.get(name),
      setVar: (name: string, value: string | number | boolean) => { local.set(name, value) },
      deleteVar: (name: string) => local.delete(name),
      getGlobalVar: () => undefined,
      setGlobalVar: () => {},
      deleteGlobalVar: () => false,
    }
    expect(stscriptCommandNames()).toContain('clock')

    const show = await runScript('/clock', env)
    expect(show).toEqual({ output: '第1天 08:00', chatChanged: false })

    const advance = await runScript('/clock advance 1h30m', env)
    expect(advance.output).toBe('第1天 09:30')
    expect(advance.chatChanged).toBe(true)
    expect(local.get('clock')).toBe(90)

    const setTime = await runScript('/clock set 14:30', env)
    expect(setTime.output).toBe('第1天 14:30')
    expect(local.get('clock')).toBe(390)

    const setDay = await runScript('/clock set day=2 time=09:30', env)
    expect(setDay.output).toBe('第2天 09:30')
    expect(local.get('clock')).toBe(1530)

    const alias = await runScript('/storyclock', env)
    expect(alias.output).toBe('第2天 09:30')

    await expect(runScript('/clock frobnicate', env)).rejects.toThrow("unknown /clock subcommand 'frobnicate'")
    await expect(runScript('/clock advance soon', env)).rejects.toThrow('/clock advance requires a duration')
  })

  it('rewrites user-input through the hook bus (zero-width cleanup)', async () => {
    const cleaned = await generationHooks.dispatch(
      'user-input',
      'hel\u200Blo\uFEFF there\u200D',
      { mode: 'send', character: 'ExampleCard', chatId: 'chat-1', group: false },
    )
    expect(cleaned).toBe('hello there')
  })

  it('observes post-save and persists per-chat turn counts into mod storage', async () => {
    await generationHooks.dispatch(
      'post-save',
      { chat: { messages: [] }, revision: 3, speaker: 'ExampleCard', finalText: '…' },
      { mode: 'send', character: 'ExampleCard', chatId: 'chat-1', group: false },
    )
    const stateFile = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')) as { values: Record<string, unknown> }
    expect(stateFile.values['turns-ExampleCard-chat-1']).toBe(1)
  })

  it('registers an AgentTavern prompt section with a clamped order', () => {
    const sections = modSectionSnapshot().filter((entry) => entry.modId === MOD_ID)
    expect(sections).toHaveLength(1)
    expect(sections[0]?.definition.name).toBe('story-clock')
    expect(sections[0]?.definition.order).toBe(-40)
    expect(sections[0]?.definition.text).toContain('variable_get')
  })

  it('serves GET status and POST summarize over the http surface (llm-gated)', async () => {
    const statusRes = fakeRes()
    const handled = await host.handleRoute(
      makeReq(), statusRes, 'GET',
      new URL('http://x/api/dsh-tavern/mods/dsh-tavern.story-clock/status'),
      MOD_ID, 'status',
    )
    expect(handled).toBe(true)
    const status = JSON.parse(statusRes.chunks[0]!) as { ok: boolean; llm: string }
    expect(status.ok).toBe(true)
    expect(status.llm).toBe('available')

    const before = host.snapshot().mods.find((entry) => entry.id === MOD_ID)?.auditCount ?? 0
    const summarizeRes = fakeRes()
    await host.handleRoute(
      makeReq(JSON.stringify({ character: 'ExampleCard', chatId: 'chat-1', provider: 'test-provider', model: 'test-model' })),
      summarizeRes, 'POST',
      new URL('http://x/api/dsh-tavern/mods/dsh-tavern.story-clock/summarize'),
      MOD_ID, 'summarize',
    )
    const summary = JSON.parse(summarizeRes.chunks[0]!) as { ok: boolean; summary: string; usage: unknown }
    expect(summary.ok).toBe(true)
    expect(summary.summary).toBe('A quiet evening at the tavern.')
    expect(summary.usage).toEqual({ input: 10, output: 7 })
    // llm-call 用量进审计线（面板审计计数可见）。
    const after = host.snapshot().mods.find((entry) => entry.id === MOD_ID)?.auditCount ?? 0
    expect(after).toBeGreaterThan(before)

    const bad = fakeRes()
    await host.handleRoute(
      makeReq(JSON.stringify({ character: 'ExampleCard' })), bad, 'POST',
      new URL('http://x/api/dsh-tavern/mods/dsh-tavern.story-clock/summarize'),
      MOD_ID, 'summarize',
    )
    expect(bad.statusCode).toBe(400)
  })

  it('counts assets-saved / guides-changed events into mod storage', async () => {
    await emitAssetsSaved('world', 'Fallen Realms')
    emitGuidesChanged('ExampleCard', 'chat-1')
    await sleep(50)
    const stateFile = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')) as { values: Record<string, unknown> }
    expect(stateFile.values.assetSaves).toEqual({ count: 1, last: 'world:Fallen Realms' })
    expect(stateFile.values.guideChanges).toEqual({ count: 1, last: 'ExampleCard/chat-1' })
  })

  it('unregisters every api.* surface on dispose (host-managed cleanup)', async () => {
    await host.disposeAll()
    expect(stscriptCommandNames()).not.toContain('clock')
    expect(createMacroEngine({ char: 'a', user: 'b' }).expand('{{clock}}')).toBe('{{clock}}')
    expect(modSectionSnapshot().filter((entry) => entry.modId === MOD_ID)).toHaveLength(0)
    // setup 返回的 dispose flush 定时器计数。
    const stateFile = JSON.parse(readFileSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'), 'utf8')) as { values: Record<string, unknown> }
    expect(stateFile.values.timerTicks).toBe(0)
    expect(existsSync(join(home, 'tavern', 'mods', MOD_ID, 'data', 'state.json'))).toBe(true)
  })
})
