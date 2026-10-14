import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModHost } from '../src/mods/host.js'
import { clearModRegistryForTest } from '../src/mods/cross-bundle.js'
import { openGamesService, type GamesService } from '../src/games/service.js'
import { clearGamesServiceForTest, publishGamesService } from '../src/games/handle.js'

// 示例 Mod 与「随仓库发布的宿主版本」的防漂移守卫（decisions/2026-10-12-story-clock-engines-drift.md）：
// examples/mods/ 的示例随仓库分发，story-clock 曾声明 engines `^0.4.1` 而宿主已升
// 0.5.0——0.x 下 caret 锁次段（^0.4.1 ⇒ >=0.4.1 <0.5.0），0.5.0 越界在 scan 阶段
// 被拦进 blocked、面板报「错误」。各示例 spec 此前硬编码 hostVersion '0.4.1'，
// 把这类漂移掩盖成绿灯。本守卫用 package.json 的真实版本开宿主、三层开关全开
// 装载全部示例：清单校验 / engines / setup 任何一环对当前宿主失效都在这里翻红。

const EXAMPLES_ROOT = join(import.meta.dirname, '..', 'examples', 'mods')
const PLUGIN_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version

/** 只实现 ModHost 用到的 state 读面（开关裁决），资产面走默认空快照。 */
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
    getChat: async () => null,
  }
}

describe('example mods vs shipping host version (engines drift guard)', () => {
  let home: string
  let host: ModHost
  let modIds: string[]
  let gamesService: GamesService
  let unpublishGames: () => void

  beforeAll(async () => {
    clearModRegistryForTest()
    home = mkdtempSync(join(tmpdir(), 'dsh-mods-examples-'))
    modIds = readdirSync(EXAMPLES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(modIds.length).toBeGreaterThanOrEqual(3)
    for (const id of modIds) {
      cpSync(join(EXAMPLES_ROOT, id), join(home, 'tavern', 'mods', id), { recursive: true })
    }
    // P3（提案 0018 §4.5）：注册游戏的 Mod（如 rps）在 setup 期经 globalThis 句柄
    // 直调游戏注册表——生产拓扑里 index.ts 恒先落定游戏服务再装 Mod（源码注释
    // 同款裁决），这里镜像该拓扑，否则句柄缺失会把注册游戏的示例打成假错误位。
    gamesService = await openGamesService({ root: join(home, 'tavern'), hostVersion: PLUGIN_VERSION })
    unpublishGames = publishGamesService(gamesService)
    host = await ModHost.open({
      root: join(home, 'tavern'),
      hostVersion: PLUGIN_VERSION,
      dbProvider: (async () => fakeStateStore({
        modsEnabled: true,
        enabled: Object.fromEntries(modIds.map((id) => [id, true])),
      })) as never,
    })
  })

  afterAll(async () => {
    await host.disposeAll()
    unpublishGames()
    gamesService.dispose()
    clearModRegistryForTest()
    clearGamesServiceForTest()
    rmSync(home, { recursive: true, force: true })
  })

  it('ships at least the three documented example mods', () => {
    expect(modIds).toEqual(expect.arrayContaining([
      'dsh-tavern.asset-stats',
      'dsh-tavern.mood-tracker',
      'dsh-tavern.story-clock',
    ]))
  })

  it('loads every example against the current package version (engines/manifest/setup all valid)', () => {
    const snapshot = host.snapshot()
    expect(snapshot.mods.map((entry) => entry.id).sort()).toEqual(modIds)
    for (const entry of snapshot.mods) {
      // status 'error' 覆盖三类失败：清单校验不过 / engines 不满足 / setup 抛错
      //（host.ts 把 blocked、broken、load-error 全部投影为 error + 原因）。
      expect(entry.status, `${entry.id}: ${entry.error}`).toBe('loaded')
      expect(entry.error, entry.id).toBe('')
    }
  })
})
