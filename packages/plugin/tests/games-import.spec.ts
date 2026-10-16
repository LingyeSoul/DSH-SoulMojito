/**
 * P2 导入路径（提案 0018 §4.5/§4.6）：从 examples/games/dsh-soulmojito.gomoku
 * 的 path 安装 → status ok → 服务层下完一整局（脚本化落子到五连）→
 * revision 推进 → 视图 HTML 含桥标记与 CSP。
 *
 * 负样本（烟测失败 → status broken + reason，不抛异常不崩启动——镜像 mods
 * blocked 语义）：坏清单 / 引擎抛错 / 非确定引擎（Math.random）。
 * reload 拾取手工放入的目录；卸载（删目录 + reload）后孤儿会话只读。
 * url 参数行为如实断言（真实 git 流程 + cloneImpl 注入替身）。
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openGamesService, type GamesService } from '../src/games/service.js'

const EXAMPLE_GAME = join(import.meta.dirname, '..', 'examples', 'games', 'dsh-soulmojito.gomoku')
// 宿主版本取插件真实版本（与宿主 BUILD_INFO.version 同源语义）——示例清单的
// engines（^0.6.0 ⇒ 0.6.x 全系）必须覆盖当前宿主，漂移在这里翻红（镜像
// tavern-mods-examples.spec 的守卫；0.6.1 升版即由本行发现示例仍声明 ^0.6.0
// 且依然成立，0.7.0 起将逼同步示例清单）。
const PLUGIN_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
const HOST_VERSION = PLUGIN_VERSION

const home = mkdtempSync(join(tmpdir(), 'games-import-'))
const root = join(home, 'tavern')
const CHARACTER = '维克多'
const CHAT = 'chat-gomoku'

let service: GamesService

beforeAll(async () => {
  service = await openGamesService({ root, hostVersion: HOST_VERSION })
})

afterAll(() => {
  service.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** 手工放一个游戏包目录进 installed（reload 拾取路径的夹具）。 */
function placeGameDir(id: string, files: Record<string, string>): string {
  const directory = join(root, 'games', 'installed', id)
  mkdirSync(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), content, 'utf8')
  }
  return directory
}

// 行尾归一（2026-10-16 真机实况）：变体合成用 LF 锚对源码做多行替换，而
// core.autocrlf 的 Windows 检出工作区是 CRLF——不归一会让多行锚静默失配
// （boom.engine 用例曾在本机漏打补丁、以 meta id 遮蔽内置而翻红）。
// 归一后本文件在 LF/CRLF 两种检出世界输出一致。
const GOMOKU_ENGINE = readFileSync(join(EXAMPLE_GAME, 'engine.mjs'), 'utf8').replaceAll('\r\n', '\n')
const GOMOKU_VIEW = readFileSync(join(EXAMPLE_GAME, 'view.html'), 'utf8')
const GOMOKU_MANIFEST = JSON.parse(readFileSync(join(EXAMPLE_GAME, 'game.json'), 'utf8')) as Record<string, unknown>

/** 以五子棋为基底的负样本包夹具（改 manifest/engine 制造违约）。 */
function gomokuVariant(overrides: { manifest?: Record<string, unknown>; manifestWithout?: string[]; enginePatch?: (source: string) => string }): Record<string, string> {
  const manifest: Record<string, unknown> = { ...GOMOKU_MANIFEST, ...overrides.manifest }
  for (const key of overrides.manifestWithout ?? []) delete manifest[key]
  return {
    'game.json': JSON.stringify(manifest),
    'engine.mjs': overrides.enginePatch === undefined ? GOMOKU_ENGINE : overrides.enginePatch(GOMOKU_ENGINE),
    'view.html': GOMOKU_VIEW,
  }
}

describe('path 安装 → status ok → 整局 → revision → 视图', () => {
  it('从 examples 路径安装：返回该游戏 status ok、source imported', async () => {
    const { game } = await service.install({ path: EXAMPLE_GAME })
    expect(game.id).toBe('dsh-soulmojito.gomoku')
    expect(game.status).toBe('ok')
    expect(game.source).toBe('imported')
    expect(game.name).toBe('五子棋')
    // 落盘核对：installed/<id>/ 三件套。
    expect(readFileSync(join(root, 'games', 'installed', 'dsh-soulmojito.gomoku', 'game.json'), 'utf8')).toContain('gomoku')
  })

  it('重复安装被拒（force 默认 false）', async () => {
    await expect(service.install({ path: EXAMPLE_GAME })).rejects.toThrow('已安装')
  })

  it('服务层下完一整局：脚本化落子到黑方五连，describe 透传引擎文案', async () => {
    const { session } = await service.start({ gameId: 'dsh-soulmojito.gomoku', character: CHARACTER, chatId: CHAT })
    expect(session.players).toEqual([
      { role: 'black', owner: 'human' },
      { role: 'white', owner: 'agent' },
    ])
    // 黑（人类）：(3,7)(4,7)(5,7)(6,7)(7,7) 横向五连；白（Agent）：A1-D1。
    const humanMoves: Array<[number, number]> = [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]
    const agentMoves: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [0, 3]]
    const before = await service.revision()
    let outcome
    for (let index = 0; index < humanMoves.length; index += 1) {
      await service.humanAction(session.id, { type: 'place', x: humanMoves[index]![0], y: humanMoves[index]![1] })
      if (index < agentMoves.length) {
        outcome = await service.agentMove(session.id, { type: 'place', x: agentMoves[index]![0], y: agentMoves[index]![1] })
        expect(outcome.describe).toMatch(/白棋落于 [A-O][1-9]/)
      }
    }
    // 最后一手黑 (7,7) 五连终局。
    const final = await service.state(session.id)
    expect(final.session.finished).toBe(true)
    expect(final.session.winner).toBe('black')
    expect(final.session.summary).toContain('五连')
    // 增量修订（2026-10-14）：日志不在快照里，总量锚 moveCount + history 窗口。
    expect(final.session.moveCount).toBe(9)
    const { moves } = await service.history(session.id, { from: 0 })
    expect(moves).toHaveLength(9)
    // revision 推进。
    expect(await service.revision()).not.toBe(before)
  })

  it('视图 HTML：含桥标记（game-state/game-action）与 CSP meta（mod 面同款）', async () => {
    const { sessions } = await service.list({ character: CHARACTER, chatId: CHAT })
    const finished = sessions.find((session) => session.finished)!
    const html = await service.view('dsh-soulmojito.gomoku', finished.id)
    expect(html).toContain('dsh-soulmojito:game-state')
    expect(html).toContain('dsh-soulmojito:game-action')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'unsafe-inline'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain('五子棋')
  })
})

describe('负样本：坏包 broken 入册不崩（§4.6 烟测 + 清单/engines 关）', () => {
  it('坏清单（缺 players）→ status broken + reason 含清单校验', async () => {
    placeGameDir('bad.manifest', gomokuVariant({
      manifest: { id: 'bad.manifest' },
      manifestWithout: ['players'],
    }))
    const { games } = await service.reload()
    const broken = games.find((game) => game.id === 'bad.manifest')!
    expect(broken.status).toBe('broken')
    expect(broken.reason).toContain('清单校验失败')
    // 不崩启动：内置 + 好游戏照常在册。
    expect(games.some((game) => game.id === 'dsh-soulmojito.gomoku' && game.status === 'ok')).toBe(true)
    expect(games.some((game) => game.id === 'dsh-soulmojito.tic-tac-toe' && game.status === 'ok')).toBe(true)
  })

  it('引擎抛错（applyAction 直接 throw）→ status broken + reason 含烟测', async () => {
    placeGameDir('boom.engine', gomokuVariant({
      manifest: { id: 'boom.engine' },
      // 锚在 applyAction 方法体的首个校验语句（docblock 里的同名签名不会被误伤）。
      enginePatch: (source) => source.replace(
        "    if (action === null || typeof action !== 'object' || Array.isArray(action)) {\n      throw new Error('动作必须是 JSON 对象')",
        "    throw new Error('kaboom')\n    if (action === null || typeof action !== 'object' || Array.isArray(action)) {\n      throw new Error('动作必须是 JSON 对象')",
      ),
    }))
    const { games } = await service.reload()
    const broken = games.find((game) => game.id === 'boom.engine')!
    expect(broken.status).toBe('broken')
    expect(broken.reason).toContain('烟测失败')
    expect(broken.reason).toContain('kaboom')
  })

  it('非确定引擎（Math.random）→ status broken + reason 含确定性', async () => {
    placeGameDir('random.engine', gomokuVariant({
      manifest: { id: 'random.engine' },
      // 直接污染 ply 赋值行（注意不能在 cloneState 后注入再被原行覆盖——
      // 原引擎随后有 next.ply = state.ply + 1 会把随机值擦掉）。
      enginePatch: (source) => source.replace(
        '    next.ply = state.ply + 1',
        '    next.ply = state.ply + 1 + Math.random()',
      ),
    }))
    const { games } = await service.reload()
    const broken = games.find((game) => game.id === 'random.engine')!
    expect(broken.status).toBe('broken')
    expect(broken.reason).toContain('确定性')
  })

  it('engines 不满足（^9.0.0 vs 当前宿主）→ status broken + reason 含版本', async () => {
    placeGameDir('future.engine', gomokuVariant({
      manifest: { id: 'future.engine', engines: { 'dsh-soulmojito': '^9.0.0' } },
    }))
    const { games } = await service.reload()
    const broken = games.find((game) => game.id === 'future.engine')!
    expect(broken.status).toBe('broken')
    expect(broken.reason).toContain('版本不满足')
  })

  it('改名兼容（2026-10-16）：旧键 engines[\'dsh-tavern\'] 双读——范围满足即装载 ok', async () => {
    placeGameDir('legacy.engines', {
      'game.json': JSON.stringify({ ...GOMOKU_MANIFEST, id: 'legacy.engines', engines: { 'dsh-tavern': '^0.6.0' } }),
      // meta id 与目录名对齐（registry 成功路径以 meta 为权威）。
      'engine.mjs': GOMOKU_ENGINE.replace("id: 'dsh-soulmojito.gomoku'", "id: 'legacy.engines'"),
      'view.html': GOMOKU_VIEW,
    })
    const { games } = await service.reload()
    const found = games.find((game) => game.id === 'legacy.engines')!
    expect(found.status).toBe('ok')
    expect(found.source).toBe('imported')
  })

  it('broken 游戏不可开局（unavailable）', async () => {
    await expect(service.start({ gameId: 'bad.manifest', character: CHARACTER, chatId: CHAT })).rejects.toThrow('不可用')
  })
})

describe('reload 拾取手工放入的目录（启动扫描之外的进入路径）', () => {
  it('reload 后新目录入册且 status ok', async () => {
    const manual = join(root, 'games', 'installed', 'manual.gomoku')
    cpSync(EXAMPLE_GAME, manual, { recursive: true })
    // 手工放入的目录清单 id 与目录名不一致 → 修正清单 id（目录名纪律）。
    const manifestPath = join(manual, 'game.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'manual.gomoku' }, null, 2), 'utf8')
    // 也得改 engine.meta 的 id（运行时以 meta 为准；不一致只 warning，id 取 meta）。
    const enginePath = join(manual, 'engine.mjs')
    writeFileSync(enginePath, readFileSync(enginePath, 'utf8').replace("id: 'dsh-soulmojito.gomoku'", "id: 'manual.gomoku'"), 'utf8')
    const before = (await service.list({})).games.find((game) => game.id === 'manual.gomoku')
    expect(before).toBeUndefined()
    const { games } = await service.reload()
    const found = games.find((game) => game.id === 'manual.gomoku')!
    expect(found.status).toBe('ok')
    expect(found.source).toBe('imported')
  })

  it('卸载（删目录 + reload）后：既有会话 orphaned 只读、拒绝落子', async () => {
    const { session } = await service.start({ gameId: 'manual.gomoku', character: CHARACTER, chatId: CHAT })
    rmSync(join(root, 'games', 'installed', 'manual.gomoku'), { recursive: true, force: true })
    await service.reload()
    const state = await service.state(session.id)
    expect(state.session.orphaned).toBe(true)
    await expect(service.humanAction(session.id, { type: 'place', x: 7, y: 7 })).rejects.toThrow('orphaned')
    await expect(service.agentMove(session.id, { type: 'resign' })).rejects.toThrow('orphaned')
  })
})

describe('install {url}（git 流程镜像 mods/install.ts，如实断言）', () => {
  it('缺 path 与 url → invalid；非法 url → parseGitSource 报错上抛', async () => {
    await expect(service.install({})).rejects.toThrow('expected { path } or { url }')
    await expect(service.install({ url: 'not a url' })).rejects.toThrow('invalid git url')
  })

  it('合法 GitHub slug + cloneImpl 替身：克隆内容按本地包落地', async () => {
    // 替身把 examples 目录当「克隆产物」写入目标（git 真流程在本仓无远端依赖，不进测试）。
    const urlHome = mkdtempSync(join(tmpdir(), 'games-url-'))
    const fakeService = await openGamesService({
      root: join(urlHome, 'tavern'),
      hostVersion: HOST_VERSION,
      gameInstall: {
        cloneImpl: async (_url, directory) => {
          cpSync(EXAMPLE_GAME, directory, { recursive: true })
        },
      },
    })
    try {
      const { game } = await fakeService.install({ url: 'https://github.com/owner/dsh-soulmojito-gomoku' })
      expect(game.id).toBe('dsh-soulmojito.gomoku')
      expect(game.status).toBe('ok')
      expect(game.source).toBe('imported')
    } finally {
      fakeService.dispose()
      rmSync(urlHome, { recursive: true, force: true })
    }
  })
})
