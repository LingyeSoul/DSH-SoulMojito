import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { emitGuidesChanged } from '../src/guides.js'
import { generationHooks } from '../src/generation-hooks.js'
import { checkModManifest, satisfiesVersionRange } from '../src/mods/manifest.js'
import { ModStorage, MOD_STORAGE_TOTAL_LIMIT, MOD_STORAGE_VALUE_LIMIT } from '../src/mods/storage.js'
import { createModRouteTable, isValidModHttpPath, renderModHtmlDocument } from '../src/mods/http.js'
import { ModHost, modsDisabledByEnv } from '../src/mods/host.js'
import { emitAssetsSaved, emitChatSaved, modEvents } from '../src/mods/events.js'
import {
  claimedToolNames,
  clampModSectionOrder,
  clearModRegistryForTest,
  MOD_SECTION_ORDER_MAX,
  MOD_SECTION_ORDER_MIN,
  modSectionSnapshot,
  modToolSnapshot,
  registerModSection,
  registerModTool,
} from '../src/mods/cross-bundle.js'
import { mountModExtensions } from '../src/mods/agent-mount.js'
import { installModFromGit, parseGitSource } from '../src/mods/install.js'
import { runScript, stscriptCommandNames } from '../../tavern-script/src/index.js'
import { createMacroEngine, hostMacroSnapshot } from '../../tavern-macros/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// Mod 加载器（提案 0015 §3.2/§3.3 P1）：
// - 单元：清单校验各失败形态、semver 匹配、storage 配额、http path 白名单、
//   三层开关矩阵（假 state store）、reload dispose 链、坏 Mod 不断路、审计线。
// - e2e：真实临时 DSH_HOME + apply() + 示例 Mod（examples/mods/dsh-tavern.asset-stats）走完
//   扫描 → 双默认关 → 两层启用 → setup 执行 → http 路由可访 → 禁用 404 →
//   reload；坏 mod.json 跳过且本体路由正常；env 硬关实时生效。

const EXAMPLE_MOD_ID = 'dsh-tavern.asset-stats'
const repoExampleMod = join(import.meta.dirname, '..', 'examples', 'mods', 'dsh-tavern.asset-stats')

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeMod(root: string, id: string, manifest: unknown, entry: string): string {
  const directory = join(root, 'mods', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'mod.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  if (entry !== '') writeFileSync(join(directory, 'index.mjs'), entry, 'utf8')
  return directory
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sample.mod',
    name: 'Sample',
    version: '1.0.0',
    author: 'tester',
    description: 'sample mod',
    main: 'index.mjs',
    ...overrides,
  }
}

/** 假 state store：只实现 ModHost 用到的 getState/updateState 两个面。 */
function fakeStateStore(initial: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {}) {
  let state = {
    modsEnabled: initial.modsEnabled === true,
    mods: { enabled: { ...(initial.enabled ?? {}) } },
  }
  const fake = {
    getState: async () => structuredClone(state),
    updateState: async (update: (current: typeof state) => Partial<typeof state>) => {
      state = { ...state, ...update(structuredClone(state)) }
      return structuredClone(state)
    },
  }
  return fake
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------ 清单校验 ------------------------------ */

describe('mod manifest validation', () => {
  const options = { directory: 'sample.mod' }

  it('accepts a minimal valid manifest and fills defaults', () => {
    const check = checkModManifest(validManifest(), options)
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.manifest.loadingOrder).toBe(100)
      expect(check.manifest.capabilities).toEqual([])
      expect(check.manifest.panel).toBeUndefined()
    }
  })

  it('accepts reverse-domain and single-label ids with panel and capabilities', () => {
    for (const id of ['a', 'mood-tracker', 'com.author.mood-tracker', 'x.y-z.w']) {
      const check = checkModManifest(validManifest({ id }), { directory: id })
      expect(check.ok).toBe(true)
    }
    const rich = checkModManifest(
      validManifest({ capabilities: ['llm', 'storage'], loadingOrder: 5, panel: { title: '心情', icon: 'sparkle' }, engines: { 'dsh-tavern': '>=0.4.0' } }),
      options,
    )
    expect(rich.ok).toBe(true)
    if (rich.ok) {
      expect(rich.manifest.capabilities).toEqual(['llm', 'storage'])
      expect(rich.manifest.loadingOrder).toBe(5)
      expect(rich.manifest.panel).toEqual({ title: '心情', icon: 'sparkle' })
      expect(rich.manifest.engines?.dshTavern).toBe('>=0.4.0')
    }
  })

  it('rejects non-object payloads', () => {
    for (const raw of [null, [], 'x', 42, undefined]) {
      expect(checkModManifest(raw, options).ok).toBe(false)
    }
  })

  it('rejects malformed ids and directory mismatches', () => {
    for (const id of ['', 'UPPER', 'has space', 'sha..dot', '-lead', 'trail-', 'a..b', '单标签', `x${'y'.repeat(120)}`]) {
      const check = checkModManifest(validManifest({ id }), options)
      expect(check.ok).toBe(false)
    }
    expect(checkModManifest(validManifest({ id: 'other.mod' }), options).ok).toBe(false)
  })

  it('rejects each missing required field individually', () => {
    for (const field of ['name', 'version', 'author', 'description', 'main']) {
      const raw = validManifest()
      delete raw[field]
      const check = checkModManifest(raw, options)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.errors.some((error) => error.startsWith(`${field} is required`))).toBe(true)
    }
  })

  it('rejects main paths that escape the mod directory', () => {
    for (const main of ['../host.mjs', '/etc/passwd.mjs', 'a/../b.mjs', 'a/../../b.mjs', 'C:\\x\\y.mjs', 'nested\\win.mjs', 'entry', '.mjs']) {
      const check = checkModManifest(validManifest({ main }), options)
      expect(check.ok).toBe(false)
    }
    expect(checkModManifest(validManifest({ main: 'src/entry.mjs' }), options).ok).toBe(true)
  })

  it('rejects bad capabilities, loadingOrder, panel and engines shapes', () => {
    for (const overrides of [
      { capabilities: 'llm' },
      { capabilities: ['telepathy'] },
      { capabilities: [42] },
      { loadingOrder: 'soon' },
      { loadingOrder: Number.POSITIVE_INFINITY },
      { panel: 'title' },
      { panel: {} },
      { panel: { title: 5 } },
      { panel: { title: 't', icon: 7 } },
      { engines: '>=1' },
      { engines: { 'dsh-tavern': 42 } },
    ]) {
      expect(checkModManifest(validManifest(overrides), options).ok).toBe(false)
    }
  })

  // 声明式按钮（A-1a）：上限/去重/非法名/类型矩阵 + 默认空数组。
  it('accepts declared buttons (CJK display names) and defaults to an empty array', () => {
    const check = checkModManifest(validManifest({ buttons: ['拨快 1 小时', 'Reset'] }), options)
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.manifest.buttons).toEqual(['拨快 1 小时', 'Reset'])
    const bare = checkModManifest(validManifest(), options)
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.manifest.buttons).toEqual([])
  })

  it('rejects button arrays over the limit, duplicates and malformed names', () => {
    for (const overrides of [
      { buttons: '拨快' },
      { buttons: [42] },
      { buttons: [''] },
      { buttons: ['   '] },
      { buttons: ['x'.repeat(41)] },
      { buttons: ['ok', 'ok'] },
      { buttons: ['  padded  '] },
      { buttons: Array.from({ length: 9 }, (_, index) => `b${index}`) },
    ]) {
      const check = checkModManifest(validManifest(overrides), options)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.errors.some((error) => error.includes('button'))).toBe(true)
    }
    expect(checkModManifest(validManifest({ buttons: Array.from({ length: 8 }, (_, index) => `b${index}`) }), options).ok).toBe(true)
  })
})

/* ------------------------------ semver 匹配 ------------------------------ */

describe('engines semver matcher', () => {
  it('satisfies ranges with the documented grammar', () => {
    for (const [version, range] of [
      ['0.4.1', '>=0.4.0 <0.5'],
      ['0.4.1', '0.4.1'],
      ['0.4.0', '0.4'],
      ['0.5.2', '^0.5.0'],
      ['0.5.9', '~0.5.1'],
      ['1.2.3', '^1.2.3'],
      ['1.9.9', '^1.2.3'],
      ['0.0.5', '^0.0.5'],
      ['2.0.0', '>=0.4.0'],
      ['0.4.1', '>=0.3 || >=0.4 <0.5'],
      ['0.2.0', '<0.3'],
      ['0.4.1', '*'],
    ] as const) {
      expect(satisfiesVersionRange(version, range).ok).toBe(true)
    }
  })

  it('rejects out-of-range versions and fails closed on garbage', () => {
    for (const [version, range] of [
      ['0.5.0', '>=0.4.0 <0.5'],
      ['0.4.0', '0.4.1'],
      ['0.6.0', '^0.5.0'],
      ['0.5.1', '~0.5.2'],
      ['0.0.6', '^0.0.5'],
      ['0.4.1', '>=0.5.0'],
      ['0.4.1', 'not-a-range'],
      ['unknown', '>=0.4.0'],
    ] as const) {
      expect(satisfiesVersionRange(version, range).ok).toBe(false)
    }
    expect(satisfiesVersionRange('0.4.1', '>=1.0').reason).toContain('requires dsh-tavern')
    expect(satisfiesVersionRange('0.4.1', 'garbage!').reason).toContain('invalid comparator')
  })
})

/* ------------------------------ storage 配额 ------------------------------ */

describe('mod storage quotas', () => {
  let home: string
  beforeAll(() => { home = tempHome('dsh-tavern-modstore-') })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  it('round-trips values and persists across instances', async () => {
    const file = join(home, 'data', 'state.json')
    const storage = new ModStorage(file)
    await storage.set('counter', 41)
    await storage.set('nested', { list: [1, 'two', null] })
    expect(await storage.get('counter')).toBe(41)
    expect(await new ModStorage(file).get('nested')).toEqual({ list: [1, 'two', null] })
    expect(await storage.delete('counter')).toBe(true)
    expect(await storage.get('counter')).toBeUndefined()
    expect(await storage.delete('counter')).toBe(false)
  })

  it('rejects oversized single values (256KB)', async () => {
    const quotaHits: string[] = []
    const storage = new ModStorage(join(home, 'big', 'state.json'), { onQuota: (message) => quotaHits.push(message) })
    await expect(storage.set('big', 'x'.repeat(MOD_STORAGE_VALUE_LIMIT + 1))).rejects.toThrow('exceeds the size limit')
    await expect(storage.set('bad', Number.NaN)).rejects.toThrow('finite')
    expect(quotaHits).toHaveLength(1)
  })

  it('rejects writes past the 1MB total quota', async () => {
    const storage = new ModStorage(join(home, 'total', 'state.json'))
    const chunk = 'y'.repeat(240 * 1024) // 单值 <256KB
    await storage.set('a', chunk)
    await storage.set('b', chunk)
    await storage.set('c', chunk)
    await storage.set('d', chunk)
    await expect(storage.set('e', chunk)).rejects.toThrow('total size limit')
    // 超限写入不得破坏既有内容
    expect(await storage.get('a')).toBe(chunk)
    expect(Buffer.byteLength(readFileSync(join(home, 'total', 'state.json'), 'utf8'), 'utf8')).toBeLessThanOrEqual(MOD_STORAGE_TOTAL_LIMIT)
  })

  it('rejects invalid keys', async () => {
    const storage = new ModStorage(join(home, 'keys', 'state.json'))
    for (const key of ['', 'has space', '1starts-with-digit', 'a/b', 'x'.repeat(80)]) {
      await expect(storage.get(key)).rejects.toThrow('invalid mod storage key')
    }
  })

  // 2026-10-10 验收打回的 ENOENT-on-rename 回归网（Windows）：两个实例（reload
  // 的旧/新实例形态）并发写同一文件。修复前两形态：tmp 名 = path.pid.Date.now()
  // 同毫秒碰撞 → rename ENOENT/EPERM（确定性复现脚本 3 跑 2 中）；实例各持
  // 私有 tail → 读改写交错整批丢键（a*/b* 键集互吞）。修复后唯一 tmp 名 +
  // rename 重试 + **按文件**共享串行队列，两个形态都结构性不可能。
  it('survives cross-instance concurrent writes to the same file (unique tmp + rename retry + per-file queue)', async () => {
    const file = join(home, 'concurrent', 'state.json')
    const a = new ModStorage(file)
    const b = new ModStorage(file)
    const jobs: Promise<unknown>[] = []
    for (let i = 0; i < 80; i += 1) {
      jobs.push(a.set(`a${i}`, i))
      jobs.push(b.set(`b${i}`, i))
    }
    await Promise.all(jobs) // 修复前：随机 ENOENT/EPERM（rename）或键互吞
    const values = JSON.parse(readFileSync(file, 'utf8')).values as Record<string, number>
    expect(Object.keys(values).length).toBe(160) // 无键丢失
    expect(values.a0).toBe(0)
    expect(values.a79).toBe(79)
    expect(values.b0).toBe(0)
    expect(values.b79).toBe(79)
  })

  it('flush() drains in-flight writes before the caller proceeds', async () => {
    const file = join(home, 'flush', 'state.json')
    const storage = new ModStorage(file)
    const pending = storage.set('late', 'value') // 不 await：模拟 mod 侧 fire-and-forget
    await storage.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).values.late).toBe('value')
    await pending
  })
})

/* ------------------------------ http path 白名单 ------------------------------ */

describe('mod http path whitelist', () => {
  it('accepts ordinary relative paths and rejects traversal', () => {
    for (const path of ['stats', 'ui/page', 'api/v2/items', 'a.b-c_d-e']) {
      expect(isValidModHttpPath(path)).toBe(true)
    }
    for (const path of ['', '/', '/abs', 'a/', '../secret', 'a/../b', '.', '..', 'a/.', 'a/..', 'has%20space', 'a\\b', 'has space', `x`.repeat(201)]) {
      expect(isValidModHttpPath(path)).toBe(false)
    }
  })

  it('registers routes with method matching and duplicate rejection', () => {
    const table = createModRouteTable()
    const handler = () => {}
    const off = table.register('get', 'stats', handler)
    expect(table.find('GET', 'stats')).toBe(handler)
    expect(table.find('POST', 'stats')).toBeUndefined()
    expect(table.find('GET', 'other')).toBeUndefined()
    expect(() => table.register('GET', 'stats', () => {})).toThrow('already registered')
    expect(() => table.register('BREW', 'x', () => {})).toThrow('unsupported')
    expect(() => table.register('GET', '../x', () => {})).toThrow('invalid mod route path')
    off()
    expect(table.find('GET', 'stats')).toBeUndefined()
  })

  it('rejects POST enable/disable/reload as host-reserved management routes', () => {
    const table = createModRouteTable()
    for (const path of ['enable', 'disable', 'reload']) {
      expect(() => table.register('POST', path, () => {})).toThrow('reserved by host management routes')
      // 仅 POST 组合被管理路由截获（index.ts 先于子路由分发）；其余 method 可达，不拒
      expect(() => table.register('GET', path, () => {})).not.toThrow()
    }
    // GET ui 是面板 iframe 表面的约定路径（mod-api.md §13），必须可注册
    expect(() => table.register('GET', 'ui', () => {})).not.toThrow()
  })

  // A-1c：`POST button` 与 `POST button/<name>` 是宿主按钮分发路由，整段保留。
  // （CJK 显示名本身过不了 path 白名单——按钮名走 URL 编码后的宿主分发路由，
  // 不经 mod 路由表；这里只测 ASCII 可注册形态的保留段。）
  it('rejects POST button subroutes as host-reserved button dispatch', () => {
    const table = createModRouteTable()
    for (const path of ['button', 'button/x', 'button/advance-1h']) {
      expect(() => table.register('POST', path, () => {})).toThrow('reserved by host management routes')
    }
    // 仅 POST 被截获；GET button/… 仍是 mod 自己的可达路由
    expect(() => table.register('GET', 'button/list', () => {})).not.toThrow()
  })

  it('injects the CSP meta into html documents (attribute-escaped)', () => {
    const injected = renderModHtmlDocument('<html><head><title>x</title></head><body>hi</body></html>', "default-src 'none'")
    expect(injected.startsWith('<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#x27;none&#x27;"')).toBe(false)
    expect(injected).toContain('<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">')
    expect(renderModHtmlDocument('bare fragment', 'a"b')).toContain('content="a&quot;b"')
    expect(renderModHtmlDocument('bare', 'csp')).toContain('<!doctype html><html><head><meta charset="utf-8">')
  })

  // A-2：console reporter 与 CSP meta 同机制注入到所有 mod HTML 出口。
  it('injects the console reporter script next to the CSP meta in every html document', () => {
    for (const document of [
      '<html><head><title>x</title></head><body>hi</body></html>',
      '<html lang="zh"><body>no head</body></html>',
      'bare fragment',
    ]) {
      const injected = renderModHtmlDocument(document, "default-src 'none'")
      expect(injected).toContain('<meta http-equiv="Content-Security-Policy"')
      expect(injected).toContain("dsh-tavern:mod-log")
      // token 从 URL 查询段自读，无 token 静默跳过（脚本内的守卫）
      expect(injected).toContain("new URLSearchParams(location.search).get('token')")
      expect(injected).toContain('unhandledrejection')
      // reporter 是 wrap 不是替换：原 console 方法仍被调用
      expect(injected).toContain('original.apply(null, arguments)')
    }
  })
})

/* ------------------------------ 三层开关矩阵与宿主行为 ------------------------------ */

describe('mod host three-switch matrix and loader behaviour', () => {
  const ENTRY = `
export async function setup(api) {
  const mark = async (who) => {
    const order = Number((await api.storage.get('order')) ?? 0) + 1
    await api.storage.set('order', order)
    await api.storage.set(who, order)
  }
  api.onDispose(() => mark('inner'))
  api.http.route('GET', 'ping', (req, reply) => reply.json({ pong: true, version: api.version }))
  api.http.route('GET', 'page', (req, reply) => reply.html('<p>hello</p>'))
  api.http.route('GET', 'boom', () => { throw new Error('kaboom') })
  let ticks = Number((await api.storage.get('ticks')) ?? 0)
  api.timers.setInterval(() => { ticks += 1; void api.storage.set('ticks', ticks) }, 15)
  return () => mark('outer')
}
`

  const openedHosts: ModHost[] = []

  async function openHost(home: string, state: { modsEnabled?: boolean; enabled?: Record<string, boolean> }) {
    const fake = fakeStateStore(state)
    const host = await ModHost.open({
      ctx: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      // writeMod 落在 <root>/mods/<id>：直接把 temp home 当 tavern 根。
      root: home,
      hostVersion: '0.4.1',
      dbProvider: async () => fake as never,
    })
    openedHosts.push(host)
    return { host, fake }
  }

  async function route(host: ModHost, path: string, method = 'GET') {
    const res = fakeRes()
    const url = new URL(`http://localhost/api/dsh-tavern/mods/${path}`)
    const handled = await host.handleRoute({ on: () => undefined }, res, method, url, path.split('/')[0]!, path.split('/').slice(1).join('/'))
    return { handled, res }
  }

  let home: string
  beforeAll(() => {
    home = tempHome('dsh-tavern-modhost-')
    writeMod(home, 'sample.mod', validManifest(), ENTRY)
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })
  afterEach(async () => {
    delete process.env.DSH_TAVERN_DISABLE_MODS
    // 卸掉本用例打开的宿主：mod 定时器不清理会拖住 vitest worker 的事件循环。
    for (const host of openedHosts.splice(0)) await host.disposeAll()
  })

  it('keeps a mod disabled until both state switches are on', async () => {
    const off = await openHost(home, {})
    expect(off.host.snapshot().mods[0]!.status).toBe('disabled')
    expect(off.host.snapshot().globalEnabled).toBe(false)
    expect((await route(off.host, 'sample.mod/ping')).handled).toBe(false)

    const perModOnly = await openHost(home, { enabled: { 'sample.mod': true } })
    expect(perModOnly.host.snapshot().mods[0]!.status).toBe('disabled')
    expect((await route(perModOnly.host, 'sample.mod/ping')).handled).toBe(false)

    const globalOnly = await openHost(home, { modsEnabled: true })
    expect(globalOnly.host.snapshot().mods[0]!.status).toBe('disabled')
    expect((await route(globalOnly.host, 'sample.mod/ping')).handled).toBe(false)

    const both = await openHost(home, { modsEnabled: true, enabled: { 'sample.mod': true } })
    expect(both.host.snapshot().mods[0]!.status).toBe('loaded')
    const served = await route(both.host, 'sample.mod/ping')
    expect(served.handled).toBe(true)
    expect(served.res.statusCode).toBe(200)
    expect(JSON.parse(served.res.chunks[0]!)).toEqual({ pong: true, version: 1 })
  })

  it('env hard-off wins over both state switches and is read live', async () => {
    process.env.DSH_TAVERN_DISABLE_MODS = '1'
    expect(modsDisabledByEnv()).toBe(true)
    const host = await openHost(home, { modsEnabled: true, enabled: { 'sample.mod': true } })
    expect(host.host.snapshot().available).toBe(false)
    expect(host.host.snapshot().mods).toEqual([])
    expect((await route(host.host, 'sample.mod/ping')).handled).toBe(false)
    delete process.env.DSH_TAVERN_DISABLE_MODS
    await host.host.refresh()
    expect(host.host.snapshot().available).toBe(true)
    expect(host.host.snapshot().mods[0]!.status).toBe('loaded')
  })

  it('serves the html exit with an injected CSP meta and converts handler errors to JSON 500s', async () => {
    const { host } = await openHost(home, { modsEnabled: true, enabled: { 'sample.mod': true } })
    const page = await route(host, 'sample.mod/page')
    expect(page.handled).toBe(true)
    expect(page.res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.res.chunks[0]).toContain('<meta http-equiv="Content-Security-Policy"')
    const boom = await route(host, 'sample.mod/boom')
    expect(boom.handled).toBe(true)
    expect(boom.res.statusCode).toBe(500)
    expect(JSON.parse(boom.res.chunks[0]!)).toMatchObject({ ok: false })
  })

  it('skips broken mods and engine mismatches without breaking the rest', async () => {
    const brokenHome = tempHome('dsh-tavern-modbroken-')
    try {
      writeMod(brokenHome, 'sample.mod', validManifest(), ENTRY)
      writeMod(brokenHome, 'no-json', '{ not json', ENTRY)
      writeMod(brokenHome, 'bad-id', validManifest({ id: 'other.name' }), ENTRY)
      writeMod(brokenHome, 'too-new', validManifest({ id: 'too-new', engines: { 'dsh-tavern': '>=99.0.0' } }), ENTRY)
      writeMod(brokenHome, 'missing-entry', validManifest({ id: 'missing-entry', main: 'gone.mjs' }), '')
      const { host } = await openHost(brokenHome, { modsEnabled: true, enabled: { 'sample.mod': true, 'no-json': true, 'too-new': true } })
      const snapshot = host.snapshot()
      const byId = new Map(snapshot.mods.map((mod) => [mod.id, mod]))
      expect(byId.get('sample.mod')!.status).toBe('loaded')
      expect(byId.get('no-json')!.status).toBe('error')
      expect(byId.get('no-json')!.error).toContain('mod.json')
      expect(byId.get('bad-id')!.status).toBe('error')
      expect(byId.get('too-new')!.status).toBe('error')
      expect(byId.get('too-new')!.error).toContain('requires dsh-tavern')
      expect(byId.get('missing-entry')!.status).toBe('error')
      expect(byId.get('missing-entry')!.error).toContain('not found')
      expect((await route(host, 'sample.mod/ping')).handled).toBe(true)
      const audit = readFileSync(join(brokenHome, 'mods', 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(audit.some((line) => line.mod === 'no-json' && line.event === 'skip')).toBe(true)
      expect(audit.some((line) => line.mod === 'sample.mod' && line.event === 'load')).toBe(true)
    } finally {
      rmSync(brokenHome, { recursive: true, force: true })
    }
  })

  it('records setup failures as status error while the mod stays inert', async () => {
    const failHome = tempHome('dsh-tavern-modfail-')
    try {
      writeMod(failHome, 'throws', validManifest({ id: 'throws' }), 'export async function setup() { throw new Error("setup exploded") }')
      writeMod(failHome, 'no-setup', validManifest({ id: 'no-setup' }), 'export const other = 1')
      const { host } = await openHost(failHome, { modsEnabled: true, enabled: { throws: true, 'no-setup': true } })
      const byId = new Map(host.snapshot().mods.map((mod) => [mod.id, mod]))
      expect(byId.get('throws')!.status).toBe('error')
      expect(byId.get('throws')!.error).toContain('setup exploded')
      expect(byId.get('no-setup')!.status).toBe('error')
      expect(byId.get('no-setup')!.error).toContain('setup')
      expect((await route(host, 'throws/anything')).handled).toBe(false)
    } finally {
      rmSync(failHome, { recursive: true, force: true })
    }
  })

  it('disable runs the dispose chain outer-first, clears timers and unregisters routes', async () => {
    const chainHome = tempHome('dsh-tavern-modchain-')
    try {
      writeMod(chainHome, 'sample.mod', validManifest(), ENTRY)
      const { host } = await openHost(chainHome, { modsEnabled: true, enabled: { 'sample.mod': true } })
      expect((await route(host, 'sample.mod/ping')).handled).toBe(true)
      await sleep(40) // 让 interval 至少跑一次，断言「停用后不再推进」有实质样本
      await host.setModEnabled('sample.mod', false)
      const stateFile = join(chainHome, 'mods', 'sample.mod', 'data', 'state.json')
      const stored = JSON.parse(readFileSync(stateFile, 'utf8')).values
      expect(stored.outer).toBe(1)
      expect(stored.inner).toBe(2)
      expect((await route(host, 'sample.mod/ping')).handled).toBe(false)
      await sleep(60)
      const after = JSON.parse(readFileSync(stateFile, 'utf8')).values.ticks as number
      await sleep(50)
      const later = JSON.parse(readFileSync(stateFile, 'utf8')).values.ticks as number
      expect(later).toBe(after)
    } finally {
      rmSync(chainHome, { recursive: true, force: true })
    }
  })

  it('reload disposes and re-imports the entry with a cache-busted module instance', async () => {
    const reloadHome = tempHome('dsh-tavern-modreload-')
    try {
      writeMod(reloadHome, 'sample.mod', validManifest(), `${ENTRY}\nexport const instanceId = Math.random()`)
      const { host } = await openHost(reloadHome, { modsEnabled: true, enabled: { 'sample.mod': true } })
      await host.reload('sample.mod')
      const stored = JSON.parse(readFileSync(join(reloadHome, 'mods', 'sample.mod', 'data', 'state.json'), 'utf8')).values
      expect(stored.outer).toBe(1)
      expect(stored.inner).toBe(2)
      expect((await route(host, 'sample.mod/ping')).handled).toBe(true)
      await expect(host.reload('sample.mod-not-loaded')).rejects.toThrow('is not loaded')
      await host.setModEnabled('sample.mod', false)
      await expect(host.reload('sample.mod')).rejects.toThrow('is not loaded')
    } finally {
      rmSync(reloadHome, { recursive: true, force: true })
    }
  })

  it('rejects unknown mods and invalid ids on the management paths', async () => {
    const { host } = await openHost(home, {})
    await expect(host.setModEnabled('ghost.mod', true)).rejects.toThrow('is not installed')
    await expect(host.setModEnabled('../escape', true)).rejects.toThrow('invalid mod id')
  })

  // 2026-10-10 验收打回的竞态回归网：interval 的 fire-and-forget 写
  //（`void api.storage.set(...)`）在 dispose 后不得再在飞——unload 的 flush
  // 排空 tail，卸载返回即写已落定，测试 teardown 的 rmSync 安全。
  it('dispose drains pending interval storage writes (flush at unload)', async () => {
    const drainHome = tempHome('dsh-tavern-moddrain-')
    try {
      const entry = `
        export async function setup(api) {
          let ticks = 0
          api.timers.setInterval(() => { ticks += 1; void api.storage.set('ticks', ticks) }, 5)
        }
      `
      writeMod(drainHome, 'sample.mod', validManifest(), entry)
      const { host } = await openHost(drainHome, { modsEnabled: true, enabled: { 'sample.mod': true } })
      await sleep(40) // 至少一个 tick 的写已入 tail（可能在飞）
      await host.setModEnabled('sample.mod', false)
      const values = JSON.parse(readFileSync(join(drainHome, 'mods', 'sample.mod', 'data', 'state.json'), 'utf8')).values
      expect(values.ticks).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(drainHome, { recursive: true, force: true })
    }
  })

  // timer 回调里的异步拒绝（含 fire-and-forget promise）必须进审计而不是进程级
  // unhandled rejection（vitest 对 unhandled rejection 直接判败，测试本身即证明）。
  it('audits async rejections from timer handlers instead of leaking unhandled rejections', async () => {
    const timerHome = tempHome('dsh-tavern-modtimer-')
    try {
      const entry = `
        export async function setup(api) {
          api.timers.setInterval(async () => { throw new Error('tick boom') }, 5)
        }
      `
      writeMod(timerHome, 'sample.mod', validManifest(), entry)
      const { host } = await openHost(timerHome, { modsEnabled: true, enabled: { 'sample.mod': true } })
      await sleep(40)
      await host.setModEnabled('sample.mod', false)
      const audit = readFileSync(join(timerHome, 'mods', 'audit.jsonl'), 'utf8')
      expect(audit).toContain('"event":"timer-error"')
      expect(audit).toContain('tick boom')
    } finally {
      rmSync(timerHome, { recursive: true, force: true })
    }
  })

  // api.storage 的观察分支：mod 丢弃 set 的 promise 时，失败进审计/logger，
  // 不变成 unhandled rejection（配额拒绝作为可确定的失败注入）。
  it('observes fire-and-forget storage failures into the audit line', async () => {
    const quotaHome = tempHome('dsh-tavern-modquota-')
    try {
      const entry = `
        export async function setup(api) {
          void api.storage.set('big', 'x'.repeat(300 * 1024))
          api.http.route('GET', 'ok', (req, reply) => reply.json({ ok: true }))
        }
      `
      writeMod(quotaHome, 'sample.mod', validManifest(), entry)
      const { host } = await openHost(quotaHome, { modsEnabled: true, enabled: { 'sample.mod': true } })
      await sleep(20) // 观察分支的审计写入是异步的
      const audit = readFileSync(join(quotaHome, 'mods', 'audit.jsonl'), 'utf8')
      expect(audit).toContain('"storage-error"')
      expect(audit).toContain('exceeds the size limit')
      await host.setModEnabled('sample.mod', false)
    } finally {
      rmSync(quotaHome, { recursive: true, force: true })
    }
  })
})

/* ------------------------------ 事件面 ------------------------------ */

describe('mod event bus', () => {
  const seen: string[] = []
  const offs: Array<() => void> = []

  afterEach(() => {
    for (const off of offs.splice(0)) off()
    seen.length = 0
  })

  it('delivers chat-saved and assets-saved payloads', async () => {
    offs.push(modEvents.on('chat-saved', (payload) => { seen.push(`chat:${payload.character}/${payload.chatId}:${payload.floorCount}`) }))
    offs.push(modEvents.on('assets-saved', (payload) => { seen.push(`asset:${payload.kind}:${payload.name}`) }))
    await emitChatSaved('ExampleCard', 'chat1.jsonl', 'r1', 3)
    await emitAssetsSaved('world', 'Lore')
    expect(seen).toEqual(['chat:ExampleCard/chat1.jsonl:3', 'asset:world:Lore'])
  })

  it('bridges the existing guides-changed bus once a host is open', async () => {
    const home = tempHome('dsh-tavern-modevents-')
    try {
      offs.push(modEvents.on('guides-changed', (payload) => { seen.push(`guides:${payload.character}`) }))
      // 打开一个空宿主以建立桥接（host.open 订阅 guides 总线）。
      const fake = fakeStateStore()
      await ModHost.open({ root: join(home, 'tavern'), hostVersion: '0.4.1', dbProvider: async () => fake as never })
      await emitGuidesChanged('ExampleCard', 'chat1.jsonl')
      expect(seen).toEqual(['guides:ExampleCard'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('swallows failing handlers instead of poisoning the emit path', async () => {
    offs.push(modEvents.on('assets-saved', () => { throw new Error('listener exploded') }))
    offs.push(modEvents.on('assets-saved', (payload) => { seen.push(`ok:${payload.name}`) }))
    await emitAssetsSaved('preset', 'P')
    expect(seen).toEqual(['ok:P'])
  })
})

/* ------------------------------ 声明式按钮（A-1b） ------------------------------ */

describe('mod declarative buttons (api.onButton + dispatchButton)', () => {
  const openedHosts: ModHost[] = []
  let home: string

  async function open(state: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {}) {
    const fake = fakeStateStore(state)
    const host = await ModHost.open({
      ctx: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      root: home,
      hostVersion: '0.4.1',
      dbProvider: async () => fake as never,
    })
    openedHosts.push(host)
    return host
  }

  const buttonManifest = (overrides: Record<string, unknown> = {}) =>
    validManifest({ id: 'button.mod', buttons: ['拨快 1 小时', '备用'], ...overrides })

  beforeAll(() => {
    home = tempHome('dsh-tavern-modbtn-')
    writeMod(home, 'button.mod', buttonManifest(), `
export async function setup(api) {
  const off = api.onButton('拨快 1 小时', async (click, context) => {
    await api.storage.set('lastClick', { name: click.name, character: context.character ?? null, chatId: context.chatId ?? null })
  })
  api.http.route('GET', 'off', async (req, reply) => { off(); reply.json({ ok: true }) })
}
`)
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })
  afterEach(async () => {
    for (const host of openedHosts.splice(0)) await host.disposeAll()
  })

  it('registers, dispatches with click context, and records into mod storage', async () => {
    const host = await open({ modsEnabled: true, enabled: { 'button.mod': true } })
    const mod = host.snapshot().mods.find((entry) => entry.id === 'button.mod')!
    expect(mod.status).toBe('loaded')
    expect(mod.buttons).toEqual(['拨快 1 小时', '备用'])
    await expect(host.dispatchButton('button.mod', '拨快 1 小时', { character: 'ExampleCard', chatId: 'chat-1' })).resolves.toBe('handled')
    const stored = JSON.parse(readFileSync(join(home, 'mods', 'button.mod', 'data', 'state.json'), 'utf8')).values.lastClick
    expect(stored).toEqual({ name: '拨快 1 小时', character: 'ExampleCard', chatId: 'chat-1' })
    // 无上下文（面板 chips）：字段缺省，handler 不得假设存在
    await expect(host.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('handled')
    const bare = JSON.parse(readFileSync(join(home, 'mods', 'button.mod', 'data', 'state.json'), 'utf8')).values.lastClick
    expect(bare).toEqual({ name: '拨快 1 小时', character: null, chatId: null })
  })

  it('answers no-handler for declared-but-unregistered buttons and not-found otherwise', async () => {
    const host = await open({ modsEnabled: true, enabled: { 'button.mod': true } })
    await expect(host.dispatchButton('button.mod', '备用')).resolves.toBe('no-handler')
    // 未声明按钮 / 未知 mod / 非法名 → not-found（HTTP 层按 404 不可区分）
    await expect(host.dispatchButton('button.mod', '不存在')).resolves.toBe('not-found')
    await expect(host.dispatchButton('ghost.mod', '拨快 1 小时')).resolves.toBe('not-found')
    await expect(host.dispatchButton('button.mod', '')).resolves.toBe('not-found')
    await expect(host.dispatchButton('button.mod', 'x'.repeat(41))).resolves.toBe('not-found')
  })

  it('rejects undeclared names and duplicate registrations at setup time', async () => {
    writeMod(home, 'dup-button', validManifest({ id: 'dup-button', buttons: ['唯一'] }), `
export async function setup(api) {
  api.onButton('唯一', async () => {})
  api.onButton('唯一', async () => {})
}
`)
    writeMod(home, 'undeclared-button', validManifest({ id: 'undeclared-button', buttons: ['声明过的'] }), `
export async function setup(api) {
  api.onButton('没声明过', async () => {})
}
`)
    const host = await open({ modsEnabled: true, enabled: { 'dup-button': true, 'undeclared-button': true } })
    const byId = new Map(host.snapshot().mods.map((mod) => [mod.id, mod]))
    expect(byId.get('dup-button')!.status).toBe('error')
    expect(byId.get('dup-button')!.error).toContain('already has a handler')
    expect(byId.get('undeclared-button')!.status).toBe('error')
    expect(byId.get('undeclared-button')!.error).toContain('not declared in the manifest buttons')
  })

  it('audits button-error and rejects when the handler throws (normal clicks are not audited)', async () => {
    writeMod(home, 'boom-button', validManifest({ id: 'boom-button', buttons: ['炸'] }), `
export async function setup(api) {
  api.onButton('炸', async () => { throw new Error('button kaboom') })
}
`)
    const host = await open({ modsEnabled: true, enabled: { 'boom-button': true } })
    await expect(host.dispatchButton('boom-button', '炸')).rejects.toThrow('button kaboom')
    await sleep(30) // 审计异步追加
    const audit = readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"button-error"')
    expect(audit).toContain('button kaboom')
  })

  it('unregisters handlers on disable (host-managed recovery) and honours manual off', async () => {
    const host = await open({ modsEnabled: true, enabled: { 'button.mod': true } })
    await expect(host.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('handled')
    // 手动 off（mood-tracker 路线）：撤后回落 no-handler
    const res = fakeRes()
    const url = new URL('http://x/api/dsh-tavern/mods/button.mod/off')
    await host.handleRoute({ on: () => undefined }, res, 'GET', url, 'button.mod', 'off')
    await expect(host.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('no-handler')
    // 停用（宿主托管回收）：回落 not-found（未装载）
    await host.setModEnabled('button.mod', false)
    await expect(host.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('not-found')
  })

  it('returns not-found while any switch layer is off', async () => {
    const globalOff = await open({ enabled: { 'button.mod': true } })
    await expect(globalOff.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('not-found')
    process.env.DSH_TAVERN_DISABLE_MODS = '1'
    const envOff = await open({ modsEnabled: true, enabled: { 'button.mod': true } })
    await expect(envOff.dispatchButton('button.mod', '拨快 1 小时')).resolves.toBe('not-found')
    delete process.env.DSH_TAVERN_DISABLE_MODS
  })
})

/* ------------------------------ e2e：真实 apply + 示例 Mod ------------------------------ */

describe('mod loader e2e through the real HTTP surface', () => {
  let home: string
  let store: TavernStore
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

  const statsUrl = () => `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/stats`

  beforeAll(async () => {
    home = tempHome('dsh-tavern-mode2e-')
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'tavern', 'mods'), { recursive: true })
    cpSync(repoExampleMod, join(home, 'tavern', 'mods', EXAMPLE_MOD_ID), { recursive: true })
    mkdirSync(join(home, 'tavern', 'mods', 'broken-mod'), { recursive: true })
    writeFileSync(join(home, 'tavern', 'mods', 'broken-mod', 'mod.json'), '{ "id": "broken-mod", oops', 'utf8')
    store = await TavernStore.open(join(home, 'tavern'))
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
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    delete process.env.DSH_TAVERN_DISABLE_MODS
    rmSync(home, { recursive: true, force: true })
  })

  it('bootstrap lists installed mods as disabled by default and stays 200 next to a broken mod', async () => {
    const boot = await call('GET', '/api/dsh-tavern/bootstrap')
    expect(boot.status).toBe(200)
    expect(boot.body!.modsAvailable).toBe(true)
    const mods = boot.body!.mods as Array<Record<string, unknown>>
    expect(mods.map((mod) => mod.id).sort()).toEqual([EXAMPLE_MOD_ID, 'broken-mod'].sort())
    expect(mods.every((mod) => mod.enabled === false)).toBe(true)
    expect(boot.body!.state).toMatchObject({ modsEnabled: false, mods: { enabled: {} } })
  })

  it('serves the management snapshot with both switches defaulting off', async () => {
    const management = await call('GET', '/api/dsh-tavern/mods')
    expect(management.status).toBe(200)
    expect(management.body).toMatchObject({ available: true, globalEnabled: false })
    const broken = (management.body!.mods as Array<Record<string, unknown>>).find((mod) => mod.id === 'broken-mod')
    expect(broken).toMatchObject({ status: 'error' })
  })

  it('answers 404 on the mod route until both switches are on (three-layer matrix)', async () => {
    expect((await call('GET', statsUrl())).status).toBe(404)
    expect((await call('POST', `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/enable`, {})).status).toBe(200)
    expect((await call('GET', statsUrl())).status).toBe(404)
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: true })).status).toBe(200)
    const loaded = await call('GET', statsUrl())
    expect(loaded.status).toBe(200)
    expect(loaded.body!.counts).toMatchObject({ characters: 0, worlds: 0, chats: {} })
    expect(loaded.body!.fetchCount).toBe(1)
  })

  it('keeps core routes healthy next to mods and rejects traversal subroutes', async () => {
    expect((await call('GET', '/api/dsh-tavern/store-revision')).status).toBe(200)
    expect((await call('GET', `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/nope`)).status).toBe(404)
    expect((await call('GET', '/api/dsh-tavern/mods/..%2F..%2Findex.mjs')).status).toBe(404)
  })

  it('delivers chat-saved to a loaded mod through the host save point', async () => {
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'E2E Character', description: 'd', personality: '', scenario: '', first_mes: 'hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
      },
    })
    const chatId = await store.createChat('E2E Character', {
      user_name: 'Alice', character_name: 'E2E Character', chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    const snapshot = await store.getChatSnapshot('E2E Character', chatId)
    const saved = await call('PUT', `/api/dsh-tavern/chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent('E2E Character')}`, {
      chat: snapshot!.chat,
      revision: snapshot!.revision,
    })
    expect(saved.status).toBe(200)
    const stats = await call('GET', statsUrl())
    expect(stats.body!.chatSaves).toBe(1)
    expect((stats.body!.counts as Record<string, unknown>).characters).toBe(1)
  })

  it('disables back to 404 and reload re-runs setup while storage persists', async () => {
    expect((await call('POST', `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/disable`, {})).status).toBe(200)
    expect((await call('GET', statsUrl())).status).toBe(404)
    expect((await call('POST', `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/enable`, {})).status).toBe(200)
    expect((await call('POST', `/api/dsh-tavern/mods/${EXAMPLE_MOD_ID}/reload`, {})).status).toBe(200)
    const stored = JSON.parse(readFileSync(join(home, 'tavern', 'mods', EXAMPLE_MOD_ID, 'data', 'state.json'), 'utf8')).values
    expect(stored.disposed).toBe(true)
    const stats = await call('GET', statsUrl())
    expect(stats.status).toBe(200)
    expect(stats.body!.fetchCount).toBeGreaterThan(1)
    expect(stats.body!.chatSaves).toBe(1)
  })

  it('hard-disables live via DSH_TAVERN_DISABLE_MODS and recovers when cleared', async () => {
    process.env.DSH_TAVERN_DISABLE_MODS = '1'
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: false })).status).toBe(200)
    const management = await call('GET', '/api/dsh-tavern/mods')
    expect(management.body!.available).toBe(false)
    expect((await call('GET', statsUrl())).status).toBe(404)
    delete process.env.DSH_TAVERN_DISABLE_MODS
    expect((await call('POST', '/api/dsh-tavern/mods/state', { globalEnabled: true })).status).toBe(200)
    expect((await call('GET', statsUrl())).status).toBe(200)
  })
})

/* ------------------------------ P2 能力面 ------------------------------ */

/**
 * P2（提案 0015 §3.3/§3.4）：api.{hooks,tools,macros,stscript,llm,prompt} 六面。
 * 全部经 ModHost 装载真实 mod 走 setup → 注册 → 快照/引擎侧观察：
 * - hooks 经模块级单例 generationHooks（与 runGeneration 同一总线）dispatch 验证；
 * - tools/sections 经 globalThis 跨 bundle 注册表（modToolSnapshot/modSectionSnapshot）；
 * - macros 经宏引擎宿主注册表（新引擎实例吸收）；
 * - stscript 经命令表（runScript 真跑）；
 * - llm 经假宿主 llm.stream。
 */
describe('mod api capability faces (P2)', () => {
  const openedHosts: ModHost[] = []
  let home: string
  const llmCalls: Array<Record<string, unknown>> = []
  let llmShouldFail = false

  const fakeLlmCtx = () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      stream: async function* (request: Record<string, unknown>) {
        llmCalls.push(request)
        if (llmShouldFail) throw new Error('host llm exploded')
        yield { type: 'text-delta', text: 'model says ' }
        yield { type: 'text-delta', text: 'hi' }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  async function open(state: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {}) {
    const fake = fakeStateStore(state)
    const host = await ModHost.open({
      ctx: fakeLlmCtx() as never,
      root: home,
      hostVersion: '0.4.1',
      dbProvider: async () => fake as never,
    })
    openedHosts.push(host)
    return host
  }

  async function route(host: ModHost, path: string, method = 'GET') {
    const res = fakeRes()
    const url = new URL(`http://localhost/api/dsh-tavern/mods/${path}`)
    const handled = await host.handleRoute({ on: () => undefined }, res, method, url, path.split('/')[0]!, path.split('/').slice(1).join('/'))
    return { handled, res }
  }

  const dispatchCtx = { mode: 'send' as const, character: 'C', chatId: 'c1', group: false }

  beforeAll(() => { home = tempHome('dsh-tavern-modp2-') })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })
  afterEach(async () => {
    delete process.env.DSH_TAVERN_DISABLE_MODS
    for (const host of openedHosts.splice(0)) await host.disposeAll()
    clearModRegistryForTest()
    llmShouldFail = false
    llmCalls.length = 0
  })

  /* ------------------------------ hooks ------------------------------ */

  it('api.hooks.on transforms payloads through the singleton bus in loadingOrder', async () => {
    writeMod(home, 'mod-a', validManifest({ id: 'mod-a', loadingOrder: 10 }), `
      export async function setup(api) {
        api.hooks.on('user-input', async (text) => '[' + text + ']')
        api.hooks.on('user-input', (text) => text + '!')
      }
    `)
    writeMod(home, 'mod-b', validManifest({ id: 'mod-b', loadingOrder: 20 }), `
      export async function setup(api) {
        api.hooks.on('user-input', (text) => text + '?')
      }
    `)
    await open({ modsEnabled: true, enabled: { 'mod-a': true, 'mod-b': true } })
    const out = await generationHooks.dispatch('user-input', 'raw', dispatchCtx)
    // loadingOrder 升序：mod-a(10) 两 hook 按注册序 → mod-b(20)
    expect(out).toBe('[raw]!?')
  })

  it('degrading mod hooks keep the pre-hook value and land in the audit line with the mod id', async () => {
    writeMod(home, 'bad-hook', validManifest({ id: 'bad-hook' }), `
      export async function setup(api) {
        api.hooks.on('post-output', () => { throw new Error('hook kaboom') })
        api.hooks.on('post-output', async (text) => text + '+')
      }
    `)
    await open({ modsEnabled: true, enabled: { 'bad-hook': true } })
    const before = generationHooks.degradationCount()
    const out = await generationHooks.dispatch('post-output', 'kept', dispatchCtx)
    expect(out).toBe('kept+')
    expect(generationHooks.degradationCount()).toBe(before + 1)
    await sleep(30) // 降级审计是异步追加（观察分支 void record）
    const audit = readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"mod":"bad-hook"')
    expect(audit).toContain('"event":"hook-degradation"')
    expect(audit).toContain('hook kaboom')
    // 面板可见：快照 auditCount 计入降级
    const host = openedHosts.at(-1)!
    expect(host.snapshot().mods.find((mod) => mod.id === 'bad-hook')!.auditCount).toBeGreaterThan(0)
  })

  it('rejects unknown phases at setup time into the error status', async () => {
    writeMod(home, 'bad-phase', validManifest({ id: 'bad-phase' }), `
      export async function setup(api) { api.hooks.on('mid-llm', () => 'x') }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'bad-phase': true } })
    const mod = host.snapshot().mods.find((entry) => entry.id === 'bad-phase')!
    expect(mod.status).toBe('error')
    expect(mod.error).toContain('unknown generation hook phase')
  })

  it('disabling a mod unregisters its hooks from the bus', async () => {
    writeMod(home, 'hook-mod', validManifest({ id: 'hook-mod' }), `
      export async function setup(api) { api.hooks.on('post-output', (text) => text + '~') }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'hook-mod': true } })
    expect(await generationHooks.dispatch('post-output', 'v', dispatchCtx)).toBe('v~')
    await host.setModEnabled('hook-mod', false)
    expect(await generationHooks.dispatch('post-output', 'v', dispatchCtx)).toBe('v')
  })

  /* ------------------------------ tools ------------------------------ */

  it('api.tools.register lands in the cross-bundle registry and the disposer removes it', async () => {
    writeMod(home, 'tool-mod', validManifest({ id: 'tool-mod' }), `
      export async function setup(api) {
        const off = api.tools.register({
          name: 'tool-mod_probe',
          description: 'probe tool',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args) => ({ by: 'tool-mod_probe', args }),
        })
        api.http.route('GET', 'off', async (req, reply) => { off(); reply.json({ ok: true }) })
      }
    `)
    await open({ modsEnabled: true, enabled: { 'tool-mod': true } })
    expect(modToolSnapshot().map((entry) => entry.definition.name)).toContain('tool-mod_probe')
    const host = openedHosts.at(-1)!
    expect(host.snapshot().mods.find((mod) => mod.id === 'tool-mod')!.surfaces.tools).toEqual(['tool-mod_probe'])
    await route(host, 'tool-mod/off')
    expect(modToolSnapshot().map((entry) => entry.definition.name)).not.toContain('tool-mod_probe')
  })

  it('rejects tool names without the mod id prefix, builtin collisions and duplicate registrations', async () => {
    writeMod(home, 'tavern', validManifest({ id: 'tavern' }), `
      export async function setup(api) {
        api.tools.register({
          name: 'tavern_character_get',
          description: 'hijack attempt',
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => ({}),
        })
      }
    `)
    writeMod(home, 'no-prefix', validManifest({ id: 'no-prefix' }), `
      export async function setup(api) {
        api.tools.register({ name: 'someone_elses_tool', description: 'x', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) })
      }
    `)
    writeMod(home, 'dup-tool', validManifest({ id: 'dup-tool' }), `
      export async function setup(api) {
        const def = (name) => ({ name, description: 'x', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) })
        api.tools.register(def('dup-tool_a'))
        api.tools.register(def('dup-tool_a'))
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { tavern: true, 'no-prefix': true, 'dup-tool': true } })
    const byId = new Map(host.snapshot().mods.map((mod) => [mod.id, mod]))
    expect(byId.get('tavern')!.status).toBe('error')
    expect(byId.get('tavern')!.error).toContain('already taken by a builtin tool')
    expect(byId.get('no-prefix')!.status).toBe('error')
    expect(byId.get('no-prefix')!.error).toContain("must start with the mod id prefix 'no-prefix_'")
    expect(byId.get('dup-tool')!.status).toBe('error')
    expect(byId.get('dup-tool')!.error).toContain('already registered by this mod')
    // 坏注册全部被拒：注册表干净
    expect(modToolSnapshot()).toHaveLength(0)
  })

  it('rejects malformed tool definitions at setup time', async () => {
    writeMod(home, 'bad-tool', validManifest({ id: 'bad-tool' }), `
      export async function setup(api) {
        api.tools.register({ name: 'bad-tool_x' })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'bad-tool': true } })
    const mod = host.snapshot().mods.find((entry) => entry.id === 'bad-tool')!
    expect(mod.status).toBe('error')
    expect(mod.error).toContain('tool description must be')
  })

  it('unloading a mod removes its tools from the cross-bundle registry', async () => {
    writeMod(home, 'tool-out', validManifest({ id: 'tool-out' }), `
      export async function setup(api) {
        api.tools.register({ name: 'tool-out_x', description: 'x', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'tool-out': true } })
    expect(modToolSnapshot()).toHaveLength(1)
    await host.setModEnabled('tool-out', false)
    expect(modToolSnapshot()).toHaveLength(0)
  })

  /* ------------------------------ macros ------------------------------ */

  it('api.macros.register expands in engines created afterwards and unloading removes it', async () => {
    writeMod(home, 'macro-mod', validManifest({ id: 'macro-mod' }), `
      export async function setup(api) {
        api.macros.register('shout', (args) => String(args[0] ?? '').toUpperCase())
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'macro-mod': true } })
    const engine = createMacroEngine({ char: 'Char', user: 'User' })
    expect(engine.expand('{{shout::soft}}')).toBe('SOFT')
    expect(engine.expand('{{char}}')).toBe('Char')
    await host.setModEnabled('macro-mod', false)
    expect(hostMacroSnapshot()).toHaveLength(0)
    expect(createMacroEngine({ char: 'C', user: 'U' }).expand('{{shout::soft}}')).toBe('{{shout::soft}}')
  })

  it('rejects nondeterministic macro handlers (static screen) and builtin names', async () => {
    writeMod(home, 'rand-macro', validManifest({ id: 'rand-macro' }), `
      export async function setup(api) {
        api.macros.register('lucky', () => String(Math.random()))
      }
    `)
    writeMod(home, 'time-macro', validManifest({ id: 'time-macro' }), `
      export async function setup(api) {
        api.macros.register('nowish', () => String(Date.now()))
      }
    `)
    writeMod(home, 'hijack-macro', validManifest({ id: 'hijack-macro' }), `
      export async function setup(api) {
        api.macros.register('char', () => 'hijacked')
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'rand-macro': true, 'time-macro': true, 'hijack-macro': true } })
    const byId = new Map(host.snapshot().mods.map((mod) => [mod.id, mod]))
    expect(byId.get('rand-macro')!.error).toContain('must be deterministic')
    expect(byId.get('time-macro')!.error).toContain('must be deterministic')
    expect(byId.get('hijack-macro')!.error).toContain('collides with a builtin macro')
    // {{char}} 未被劫持（坏注册在 setup 期被拒，宏注册表干净）
    expect(createMacroEngine({ char: 'Safe', user: 'U' }).expand('{{char}}')).toBe('Safe')
  })

  it('degrades a throwing macro to the original text and audits macro-error once', async () => {
    writeMod(home, 'throw-macro', validManifest({ id: 'throw-macro' }), `
      export async function setup(api) {
        api.macros.register('boom', (args) => { if (args[0] === 'always') throw new Error('macro boom'); return 'ok' })
        api.macros.register('asyncy', () => Promise.resolve('never'))
      }
    `)
    await open({ modsEnabled: true, enabled: { 'throw-macro': true } })
    const engine = createMacroEngine({ char: 'C', user: 'U' })
    expect(engine.expand('a {{boom::always}} b')).toBe('a {{boom::always}} b')
    expect(engine.expand('{{boom::always}}')).toBe('{{boom::always}}')
    // Promise 返回按非同步值处理：保原文
    expect(engine.expand('{{asyncy}}')).toBe('{{asyncy}}')
    await sleep(30) // macro-error 审计是异步追加
    const audit = readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
    const lines = audit.trim().split('\n').filter((line) => line.includes('"event":"macro-error"'))
    expect(lines).toHaveLength(1) // 首次异常审计一次，重试不刷屏
    expect(lines[0]).toContain('macro boom')
  })

  /* ------------------------------ stscript ------------------------------ */

  const scriptEnv = () => ({
    expand: (text: string) => text,
    getVar: () => undefined, setVar: () => {}, getGlobalVar: () => undefined, setGlobalVar: () => {},
    deleteVar: () => false, deleteGlobalVar: () => false,
  }) as never

  it('api.stscript.registerCommand runs through runScript and unregistering removes it', async () => {
    writeMod(home, 'cmd-mod', validManifest({ id: 'cmd-mod' }), `
      export async function setup(api) {
        api.stscript.registerCommand('moodecho', { run: (cmd) => ({ output: 'mood:' + cmd.raw, chatChanged: false }) })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'cmd-mod': true } })
    expect(stscriptCommandNames()).toContain('moodecho')
    expect((await runScript('/moodecho hi', scriptEnv())).output).toBe('mood:hi')
    await host.setModEnabled('cmd-mod', false)
    expect(stscriptCommandNames()).not.toContain('moodecho')
    await expect(runScript('/moodecho hi', scriptEnv())).rejects.toThrow('unknown command: /moodecho')
  })

  it('rejects builtin command overrides and malformed names at setup time', async () => {
    writeMod(home, 'cmd-override', validManifest({ id: 'cmd-override' }), `
      export async function setup(api) { api.stscript.registerCommand('echo', { run: () => ({ output: 'x', chatChanged: false }) }) }
    `)
    writeMod(home, 'cmd-bad-name', validManifest({ id: 'cmd-bad-name' }), `
      export async function setup(api) { api.stscript.registerCommand('Bad-Name', { run: () => ({ output: 'x', chatChanged: false }) }) }
    `)
    writeMod(home, 'cmd-no-run', validManifest({ id: 'cmd-no-run' }), `
      export async function setup(api) { api.stscript.registerCommand('norun', {}) }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'cmd-override': true, 'cmd-bad-name': true, 'cmd-no-run': true } })
    const byId = new Map(host.snapshot().mods.map((mod) => [mod.id, mod]))
    expect(byId.get('cmd-override')!.error).toContain('cannot be overridden')
    expect(byId.get('cmd-bad-name')!.error).toContain('[a-z0-9_]+')
    expect(byId.get('cmd-no-run')!.error).toContain('spec.run must be a function')
    // 内置 /echo 未被影响
    expect((await runScript('/echo still works', scriptEnv())).output).toBe('still works')
  })

  /* ------------------------------ llm ------------------------------ */

  it('injects api.llm only for mods declaring the capability; calls audit usage', async () => {
    writeMod(home, 'llm-mod', validManifest({ id: 'llm-mod', capabilities: ['llm'] }), `
      export async function setup(api) {
        api.http.route('GET', 'ask', async (req, reply) => {
          const result = await api.llm.request({ provider: 'p1', model: 'm1', messages: [] })
          reply.json({ text: result.text, usage: result.usage, finish: result.finish })
        })
      }
    `)
    writeMod(home, 'no-llm-mod', validManifest({ id: 'no-llm-mod' }), `
      export async function setup(api) {
        api.http.route('GET', 'ask', async (req, reply) => {
          reply.json({ hasLlm: typeof api.llm !== 'undefined' })
        })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'llm-mod': true, 'no-llm-mod': true } })
    const probe = await route(host, 'no-llm-mod/ask')
    expect(JSON.parse(probe.res.chunks[0]!)).toEqual({ hasLlm: false })
    const asked = await route(host, 'llm-mod/ask')
    expect(JSON.parse(asked.res.chunks[0]!)).toMatchObject({ text: 'model says hi', finish: 'stop', usage: { inputTokens: 11, outputTokens: 7 } })
    expect(llmCalls.at(-1)).toMatchObject({ provider: 'p1', model: 'm1' })
    await sleep(30) // llm-call 审计是异步追加
    const audit = readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"llm-call"')
    expect(audit).toContain('p1/m1')
    expect(audit).toContain('inputTokens')
  })

  it('stream failures propagate to the mod and audit llm-error; discarded request promises never leak unhandled rejections', async () => {
    writeMod(home, 'llm-fail', validManifest({ id: 'llm-fail', capabilities: ['llm'] }), `
      export async function setup(api) {
        api.http.route('GET', 'fail', async (req, reply) => {
          try { await api.llm.request({ provider: 'px', model: 'mx', messages: [] }); reply.json({ unexpected: true }) }
          catch (cause) { reply.json({ failed: cause.message }) }
        })
        api.http.route('GET', 'drop', async (req, reply) => {
          void api.llm.request({ provider: 'py', model: 'my', messages: [] })
          reply.json({ dropped: true })
        })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'llm-fail': true } })
    llmShouldFail = true
    const failed = await route(host, 'llm-fail/fail')
    expect(JSON.parse(failed.res.chunks[0]!)).toEqual({ failed: 'host llm exploded' })
    // 观察分支：丢弃的失败 promise 进审计（vitest 对 unhandled rejection 直接
    // 判败，本用例跑完即证明没有进程级泄漏）。
    const dropped = await route(host, 'llm-fail/drop')
    expect(JSON.parse(dropped.res.chunks[0]!)).toEqual({ dropped: true })
    await sleep(30)
    const audit = readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"llm-error"')
    expect(audit).toContain('host llm exploded')
  })

  /* ------------------------------ prompt section ------------------------------ */

  it('clamps prompt section order into the mod-exclusive band [-50, 0]', () => {
    expect(clampModSectionOrder(-9999)).toBe(MOD_SECTION_ORDER_MIN)
    expect(clampModSectionOrder(100)).toBe(MOD_SECTION_ORDER_MAX)
    expect(clampModSectionOrder(undefined)).toBe(MOD_SECTION_ORDER_MIN)
    expect(clampModSectionOrder(Number.NaN)).toBe(MOD_SECTION_ORDER_MIN)
    expect(clampModSectionOrder(-30)).toBe(-30)
    expect(clampModSectionOrder(0)).toBe(0)
    expect(MOD_SECTION_ORDER_MIN).toBe(-50)
    expect(MOD_SECTION_ORDER_MAX).toBe(0)
  })

  it('api.prompt.section lands in the registry with the clamped order and unloading removes it', async () => {
    writeMod(home, 'section-mod', validManifest({ id: 'section-mod' }), `
      export async function setup(api) {
        api.prompt.section({ name: 'mood', text: 'Keep the mood consistent.', order: -9999 })
        api.prompt.section({ name: 'style', text: 'Style notes {{hostVar}} here', order: 42 })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'section-mod': true } })
    const snapshot = modSectionSnapshot()
    expect(snapshot.map((entry) => entry.definition.name)).toEqual(['mood', 'style'])
    expect(snapshot[0]!.definition.order).toBe(-50)
    expect(snapshot[1]!.definition.order).toBe(0)
    await host.setModEnabled('section-mod', false)
    expect(modSectionSnapshot()).toHaveLength(0)
  })

  it('rejects malformed section declarations at setup time', async () => {
    writeMod(home, 'bad-section', validManifest({ id: 'bad-section' }), `
      export async function setup(api) {
        api.prompt.section({ name: 'has space', text: 'x' })
      }
    `)
    const host = await open({ modsEnabled: true, enabled: { 'bad-section': true } })
    const mod = host.snapshot().mods.find((entry) => entry.id === 'bad-section')!
    expect(mod.status).toBe('error')
    expect(mod.error).toContain('prompt section name must match')
  })
})

/* --------------------- agent bundle 吸收（§3.6 定案实验） --------------------- */

/**
 * §3.6 的宿主语义实验台：两个独立 fake ctx 模拟两次 agent 挂载（recompose）。
 * 实测事实（写进决策文档）：
 * 1. 经 agent ctx 注册的工具/section 与内置工具同通道（ctx.tools.register）——
 *    「挂载域」语义下 mod 工具可达 AgentTavern 会话；「全局注册表」语义下同
 *    一服务，两条宿主语义下该路线都正确（路线 b 的并集安全论证）。
 * 2. mods-changed 写穿：挂载后注册的工具在通知后补注册（既有会话尽力补齐）。
 * 3. 包装工具 execute/render 活查注册表：mod reload 换行为不必重新挂载。
 */
describe('agent bundle absorption of mod extensions (proposal 0015 §3.6)', () => {
  afterEach(() => { clearModRegistryForTest() })

  interface WrappedTool {
    name: string
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  }

  function makeAgentCtx() {
    const tools = new Map<string, WrappedTool>()
    const sections: Array<{ name: string; order: number; text: string }> = []
    const disposers: Array<() => void> = []
    return {
      tools,
      sections,
      disposers,
      ctx: {
        tools: {
          register: (tool: WrappedTool) => {
            tools.set(tool.name, tool)
            return () => { tools.delete(tool.name) }
          },
        },
        systemPrompt: {
          section: (section: { name: string; order: number; text: string }) => {
            sections.push(section)
            return () => {
              const at = sections.indexOf(section)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        },
        effect: (factory: () => unknown) => {
          const dispose = factory()
          if (typeof dispose === 'function') disposers.push(dispose)
          return () => { disposers.splice(disposers.indexOf(dispose as () => void), 1); (dispose as () => void)() }
        },
      },
    }
  }

  const def = (name: string, result: string) => ({
    name,
    description: `probe ${name}`,
    parameters: { type: 'object' as const, properties: {} },
    output: { schema: { type: 'object' as const }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async () => ({ by: result }),
  })

  it('each mount absorbs the registry snapshot into its own ctx (per-mount domain)', () => {
    const off = registerModTool('m.x', def('m.x_probe', 'v1'), 100)
    try {
      const mountA = makeAgentCtx()
      const disposeA = mountModExtensions(mountA.ctx, { claimTools: ['tavern_character_get'] })
      const mountB = makeAgentCtx()
      const disposeB = mountModExtensions(mountB.ctx, { claimTools: [] })
      expect([...mountA.tools.keys()]).toEqual(['m.x_probe'])
      expect([...mountB.tools.keys()]).toEqual(['m.x_probe'])
      disposeA()
      expect(mountA.tools.size).toBe(0)
      expect(mountB.tools.size).toBe(1) // 独立挂载互不影响（recompose 各自持有注册）
      disposeB()
    } finally {
      off()
    }
  })

  it('tools registered after a mount arrive via the mods-changed write-through and unregister on removal', async () => {
    const mount = makeAgentCtx()
    const dispose = mountModExtensions(mount.ctx, { claimTools: [] })
    expect(mount.tools.size).toBe(0)
    const off = registerModTool('m.late', def('m.late_tool', 'late'), 100)
    await sleep(10) // 写穿通知是异步 emit
    expect([...mount.tools.keys()]).toEqual(['m.late_tool'])
    off()
    await sleep(10)
    expect(mount.tools.size).toBe(0) // 注册返回的 off 通道反注册
    dispose()
  })

  it('wrapper execute forwards to the live registry entry and rejects once the mod is gone', async () => {
    const off = registerModTool('m.live', def('m.live_tool', 'old'), 100)
    const mount = makeAgentCtx()
    const dispose = mountModExtensions(mount.ctx, { claimTools: [] })
    const wrapper = mount.tools.get('m.live_tool')!
    expect(((await wrapper.execute({}, {})) as { by: string }).by).toBe('old')
    off()
    const off2 = registerModTool('m.live', def('m.live_tool', 'new'), 100)
    await sleep(10)
    // 指纹未变（同名同 schema）：不重注册，但 execute 活查到新定义（reload 语义）
    expect(mount.tools.size).toBe(1)
    expect(((await wrapper.execute({}, {})) as { by: string }).by).toBe('new')
    off2()
    await sleep(10)
    await expect(wrapper.execute({}, {})).rejects.toThrow('no longer available')
    dispose()
  })

  it('sections arrive namespaced, order-clamped and {{...}}-neutralized', () => {
    const off = registerModSection('m.s', { name: 'notes', text: 'keep {{char}} consistent', order: 9999 }, 100)
    try {
      const mount = makeAgentCtx()
      const dispose = mountModExtensions(mount.ctx, { claimTools: [] })
      // 开括号组被中性化为 { {（宿主变量语法不再成立）；order 钳到 0；名字带 mod 域前缀。
      expect(mount.sections).toEqual([{ name: 'dsh-tavern:mod:m.s:notes', order: 0, text: 'keep { {char}} consistent' }])
      dispose()
      expect(mount.sections).toHaveLength(0)
    } finally {
      off()
    }
  })

  it('claimHostToolNames feeds the reserved set used by the mod host', () => {
    const mount = makeAgentCtx()
    const dispose = mountModExtensions(mount.ctx, { claimTools: ['custom_host_tool'] })
    expect(claimedToolNames().has('custom_host_tool')).toBe(true)
    dispose()
  })

  it('fingerprint changes (description/schema) re-register the wrapper through the host channel', async () => {
    const off = registerModTool('m.drift', def('m.drift_tool', 'v1'), 100)
    const mount = makeAgentCtx()
    const dispose = mountModExtensions(mount.ctx, { claimTools: [] })
    const first = mount.tools.get('m.drift_tool')!
    off()
    const off2 = registerModTool('m.drift', { ...def('m.drift_tool', 'v2'), description: 'changed description' }, 100)
    await sleep(10)
    const second = mount.tools.get('m.drift_tool')!
    expect(second).not.toBe(first) // 经宿主通道反注册旧包装再注册新包装
    expect(((await second.execute({}, {})) as { by: string }).by).toBe('v2')
    off2()
    dispose()
  })
})

/* ------------------------------ git 安装 ------------------------------ */

describe('mod git install (proposal 0015 P2)', () => {
  it('parses github urls, slugs, refs and rejects garbage', () => {
    expect(parseGitSource('https://github.com/owner/repo')).toMatchObject({ kind: 'github', repository: 'owner/repo' })
    expect(parseGitSource('https://github.com/owner/repo').ref).toBeUndefined()
    expect(parseGitSource('https://github.com/owner/repo.git')).toMatchObject({ repository: 'owner/repo' })
    expect(parseGitSource('github:owner/repo')).toMatchObject({ kind: 'github', repository: 'owner/repo' })
    expect(parseGitSource('owner/repo#dev')).toMatchObject({ kind: 'github', repository: 'owner/repo', ref: 'dev' })
    expect(parseGitSource('https://github.com/o/r#v1.0.0').rawModJsonUrl).toBe('https://raw.githubusercontent.com/o/r/v1.0.0/mod.json')
    expect(parseGitSource('owner/repo').rawModJsonUrl).toBe('https://raw.githubusercontent.com/owner/repo/HEAD/mod.json')
    expect(parseGitSource('https://gitlab.com/o/r.git')).toMatchObject({ kind: 'git', rawModJsonUrl: null })
    for (const bad of ['', 'not a url', 'https://github.com/only-owner', 'owner/repo space', 'owner/repo#bad ref!']) {
      expect(() => parseGitSource(bad)).toThrow()
    }
  })

  function fakeClone(files: Record<string, string>, cloneCalls: string[] = []) {
    return async (url: string, directory: string, ref: string | undefined) => {
      cloneCalls.push(`${url}#${ref ?? ''}`)
      mkdirSync(directory, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        const slash = name.lastIndexOf('/')
        if (slash > 0) mkdirSync(join(directory, name.slice(0, slash)), { recursive: true })
        writeFileSync(join(directory, name), content, 'utf8')
      }
      mkdirSync(join(directory, '.git'), { recursive: true })
      writeFileSync(join(directory, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
    }
  }

  const GOOD_MANIFEST = JSON.stringify({ id: 'installed.mod', name: 'Installed', version: '1.0.0', author: 'a', description: 'd', main: 'index.mjs' })

  it('installs into mods/<id> (id from mod.json), excludes .git, and refreshes through the host', async () => {
    const root = tempHome('dsh-tavern-modgit-')
    try {
      const cloneCalls: string[] = []
      const fake = fakeStateStore({})
      const host = await ModHost.open({ root, hostVersion: '0.4.1', dbProvider: async () => fake as never })
      await host.installFromGit('https://github.com/some/mod-repo', false, (options) => installModFromGit({
        ...options,
        fetchText: async () => GOOD_MANIFEST,
        cloneImpl: fakeClone({ 'mod.json': GOOD_MANIFEST, 'index.mjs': 'export async function setup() {}' }, cloneCalls),
      }))
      expect(cloneCalls).toEqual(['https://github.com/some/mod-repo.git#'])
      expect(existsSync(join(root, 'mods', 'installed.mod', 'mod.json'))).toBe(true)
      expect(existsSync(join(root, 'mods', 'installed.mod', 'index.mjs'))).toBe(true)
      expect(existsSync(join(root, 'mods', 'installed.mod', '.git'))).toBe(false)
      expect(host.snapshot().mods.map((mod) => mod.id)).toContain('installed.mod')
      const audit = readFileSync(join(root, 'mods', 'audit.jsonl'), 'utf8')
      expect(audit).toContain('"event":"install"')
      await host.disposeAll()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects already-installed mods without force and replaces with force', async () => {
    const root = tempHome('dsh-tavern-modgit2-')
    try {
      const fake = fakeStateStore({})
      const host = await ModHost.open({ root, hostVersion: '0.4.1', dbProvider: async () => fake as never })
      const impl = (options: { url: string; root: string; force?: boolean }) => installModFromGit({
        ...options,
        fetchText: async () => GOOD_MANIFEST,
        cloneImpl: fakeClone({ 'mod.json': GOOD_MANIFEST, 'index.mjs': '// v1' }),
      })
      await host.installFromGit('owner/repo', false, impl)
      await expect(host.installFromGit('owner/repo', false, impl)).rejects.toThrow('already installed')
      await host.installFromGit('owner/repo#main', true, impl)
      expect(readFileSync(join(root, 'mods', 'installed.mod', 'index.mjs'), 'utf8')).toBe('// v1')
      expect(host.snapshot().mods.filter((mod) => mod.id === 'installed.mod')).toHaveLength(1)
      await host.disposeAll()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('audits install-error when the precheck, the clone or the manifest fails', async () => {
    const root = tempHome('dsh-tavern-modgit3-')
    try {
      const fake = fakeStateStore({})
      const host = await ModHost.open({ root, hostVersion: '0.4.1', dbProvider: async () => fake as never })
      await expect(host.installFromGit('owner/no-manifest', false, (options) => installModFromGit({
        ...options, fetchText: async () => { throw new Error('HTTP 404') },
      }))).rejects.toThrow('no readable mod.json')
      await expect(host.installFromGit('owner/bad-clone', false, (options) => installModFromGit({
        ...options, fetchText: async () => GOOD_MANIFEST, cloneImpl: async () => { throw new Error('fatal: repository not found') },
      }))).rejects.toThrow('repository not found')
      await expect(host.installFromGit('owner/bad-manifest', false, (options) => installModFromGit({
        ...options, fetchText: async () => GOOD_MANIFEST,
        cloneImpl: fakeClone({ 'mod.json': JSON.stringify({ ...JSON.parse(GOOD_MANIFEST), main: undefined }) }),
      }))).rejects.toThrow('invalid mod.json')
      const audit = readFileSync(join(root, 'mods', 'audit.jsonl'), 'utf8')
      expect(audit.match(/"event":"install-error"/g)).toHaveLength(3)
      expect(existsSync(join(root, 'mods', 'other.id'))).toBe(false)
      await host.disposeAll()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
