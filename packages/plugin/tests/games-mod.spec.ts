/**
 * P3：api.games.register（提案 0018 §4.5 第 3 源）——真 ModHost 装载示例 rps
 * Mod + 真 games 服务（host.ts 的 register 经 globalThis 句柄直调注册表，镜像
 * 生产拓扑：index.ts 恒先落定游戏服务再装 Mod）。覆盖：
 * - rps 示例装载成功且游戏以 source 'mod' 入册（面板「游戏」分区可见）；
 * - 注册纪律负样本：未在 manifest games 声明 / id 前缀不符 / 引擎烟测失败
 *   （Math.random 破确定性）/ 跨源重复 id / manifest games 字段非法——全部
 *   在 scan 或 setup 阶段 fail-fast 成错误位，不带病入册；
 * - 人机完整对局（三局两胜到终局，describe 可叙述）；
 * - 卸载孤儿语义：Mod 卸载 → 游戏摘册、其会话 orphaned 只读（落子 unavailable、
 *   视图 not-found）；重装载后孤儿判定动态查表、同一会话恢复可玩。
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModHost } from '../src/mods/host.js'
import { clearModRegistryForTest } from '../src/mods/cross-bundle.js'
import { openGamesService, type GamesService } from '../src/games/service.js'
import { clearGamesServiceForTest, publishGamesService } from '../src/games/handle.js'
import { GameBridgeError } from '../src/games/sessions.js'

const RPS_EXAMPLE = join(import.meta.dirname, '..', 'examples', 'mods', 'dsh-soulmojito.rps')
const RPS_GAME = 'dsh-soulmojito.rps.gesture'
const CHARACTER = 'ExampleCard'
const CHAT = 'chat-rps'

let home: string
let service: GamesService
let unpublishGames: () => void
let host: ModHost

/** 与 tavern-mods-examples.spec 同款：只实现 ModHost 用到的 state 读面。 */
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

/** 造一个坏 Mod：manifest 覆写 + setup 体（ESM 源码字符串）。 */
function writeBadMod(root: string, id: string, manifestOverride: string, setupBody: string) {
  const dir = join(root, 'mods', id)
  mkdirSync(dir, { recursive: true })
  const manifest = `{
  "id": "${id}",
  "name": "${id} bad probe",
  "version": "1.0.0",
  "author": "gate",
  "description": "negative probe",
  "main": "index.mjs"${manifestOverride}
}`
  writeFileSync(join(dir, 'mod.json'), manifest)
  writeFileSync(join(dir, 'index.mjs'), `export async function setup(api) {\n${setupBody}\n}\n`)
}

async function openHostOver(root: string, ids: string[]): Promise<ModHost> {
  return ModHost.open({
    root,
    hostVersion: '0.6.0',
    dbProvider: (async () => fakeStateStore({
      modsEnabled: true,
      enabled: Object.fromEntries(ids.map((id) => [id, true])),
    })) as never,
  })
}

beforeAll(async () => {
  clearModRegistryForTest()
  clearGamesServiceForTest()
  home = mkdtempSync(join(tmpdir(), 'games-mod-'))
  const root = join(home, 'tavern')
  service = await openGamesService({ root, hostVersion: '0.6.0' })
  unpublishGames = publishGamesService(service)
  cpSync(RPS_EXAMPLE, join(root, 'mods', 'dsh-soulmojito.rps'), { recursive: true })
  host = await openHostOver(root, ['dsh-soulmojito.rps'])
})

afterAll(async () => {
  await host.disposeAll()
  unpublishGames()
  service.dispose()
  clearModRegistryForTest()
  clearGamesServiceForTest()
  rmSync(home, { recursive: true, force: true })
})

describe('rps 示例 Mod：注册与对局', () => {
  it('Mod 装载成功且游戏以 source "mod" 入册', async () => {
    const entry = host.snapshot().mods.find((item) => item.id === 'dsh-soulmojito.rps')
    expect(entry?.status, entry?.error).toBe('loaded')
    const { games } = await service.list({ character: '', chatId: '' })
    const game = games.find((item) => item.id === RPS_GAME)
    expect(game).toBeDefined()
    expect(game?.source).toBe('mod')
    expect(game?.status).toBe('ok')
    expect(game?.name).toBe('猜拳')
    expect(game?.players.roles).toEqual(['first', 'second'])
  })

  it('人机完整对局：三局两胜到终局，describe 可叙述', async () => {
    const { session, view } = await service.start({ gameId: RPS_GAME, character: CHARACTER, chatId: CHAT })
    expect(session.players).toEqual([
      { role: 'first', owner: 'human' },
      { role: 'second', owner: 'agent' },
    ])
    expect(view.finished).toBe(false)
    // 第 1 局：人 rock、Agent paper（Agent 胜）；第 2 局同型——两胜终局。
    const first = await service.humanAction(session.id, { type: 'throw', gesture: 'rock' })
    expect(first.view.turn).toBe('second')
    const agentFirst = await service.agentMove(session.id, { type: 'throw', gesture: 'paper' })
    expect(agentFirst.describe).toContain('第')
    const second = await service.humanAction(session.id, { type: 'throw', gesture: 'rock' })
    expect(second.view.turn).toBe('second')
    const ending = await service.agentMove(session.id, { type: 'throw', gesture: 'paper' })
    expect(ending.session.finished).toBe(true)
    expect(ending.session.winner).toBe('second')
    expect(ending.view.summary).toContain('乙方获胜')
  })
})

describe('注册纪律负样本（scan / setup fail-fast）', () => {
  it('未在 manifest games 声明的 id：setup 抛错进错误位', async () => {
    // 前缀校验先于声明校验（host.ts 顺序），id 必须带本 Mod 前缀但不在名单内。
    const root = join(home, 'bad-undeclared')
    writeBadMod(root, 'dsh-soulmojito.bad.undeclared',
      '', '  await api.games.register({ id: "dsh-soulmojito.bad.undeclared.sneaky", engine: {} })')
    const bad = await openHostOver(root, ['dsh-soulmojito.bad.undeclared'])
    const entry = bad.snapshot().mods[0]
    expect(entry.status).toBe('error')
    expect(entry.error).toContain('not declared in the manifest games')
    await bad.disposeAll()
  })

  it('id 前缀不符 mod id：setup 抛错进错误位', async () => {
    const root = join(home, 'bad-prefix')
    writeBadMod(root, 'dsh-soulmojito.bad.prefix',
      ',\n  "games": ["other.game"]',
      '  await api.games.register({ id: "other.game", engine: {} })')
    const bad = await openHostOver(root, ['dsh-soulmojito.bad.prefix'])
    const entry = bad.snapshot().mods[0]
    expect(entry.status).toBe('error')
    expect(entry.error).toContain("must start with the mod id prefix 'dsh-soulmojito.bad.prefix.'")
    await bad.disposeAll()
  })

  it('引擎烟测失败（Math.random 破确定性）：setup 抛错进错误位', async () => {
    const root = join(home, 'bad-smoke')
    writeBadMod(root, 'dsh-soulmojito.bad.smoke',
      ',\n  "games": ["dsh-soulmojito.bad.smoke.rand"]',
      `  const engine = {
    meta: { id: 'dsh-soulmojito.bad.smoke.rand', name: '坏引擎', version: '1.0.0',
      players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: 'noop {type:\\'go\\'}' },
    createGame() { return { state: { board: 1, turn: 'a', ply: 0, lastMove: null, finished: false, winner: null, winLine: null } } },
    legalActions(state) { return [{ type: 'go' }] },
    applyAction(state) {
      const next = { ...state, board: state.board + (Math.random() > 0.5 ? 1 : 2), turn: 'b' }
      return { state: next, events: [], finished: false, winner: null, summary: 'ok' }
    },
    describe() { return 'a 走了一手' },
  }
  await api.games.register({ id: 'dsh-soulmojito.bad.smoke.rand', name: '坏引擎', version: '1.0.0',
    players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: 'noop {type:\\'go\\'}',
    engine, view: '<!doctype html><html><body>bad</body></html>' })`)
    const bad = await openHostOver(root, ['dsh-soulmojito.bad.smoke'])
    const entry = bad.snapshot().mods[0]
    expect(entry.status).toBe('error')
    expect(entry.error).toContain('引擎烟测失败')
    // 坏引擎不带病入册：全局注册表查无此游戏。
    const { games } = await service.list({ character: '', chatId: '' })
    expect(games.find((item) => item.id === 'dsh-soulmojito.bad.smoke.rand')).toBeUndefined()
    await bad.disposeAll()
  })

  it('同 Mod 重复注册同一 id：setup 抛错进错误位（跨源查重同一守卫）', async () => {
    // 跨源撞 rps 的 id 过不了前缀校验（游戏 id 必须以本 Mod id 为前缀），
    // 「already registered」守卫用同 Mod 二次注册等价触达——registry.registerModGame
    // 对 builtin/imported/mod 三源统一查重，同一分支。
    const root = join(home, 'bad-duplicate')
    writeBadMod(root, 'dsh-soulmojito.bad.dup',
      ',\n  "games": ["dsh-soulmojito.bad.dup.g"]',
      `  const engine = {
    meta: { id: 'dsh-soulmojito.bad.dup.g', name: 'dup', version: '1.0.0',
      players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: 'noop {type:\\'go\\'}' },
    createGame() { return { state: { board: 1, turn: 'a', ply: 0, lastMove: null, finished: false, winner: null, winLine: null } } },
    legalActions(state) { return [{ type: 'go' }] },
    applyAction(state, action) {
      if (action?.type !== 'go') throw new Error('不支持的动作')
      return { state: { ...state, turn: 'b' }, events: [], finished: false, winner: null, summary: 'ok' }
    },
    describe() { return 'a 走了一手' },
  }
  const def = { id: 'dsh-soulmojito.bad.dup.g', name: 'dup', version: '1.0.0',
    players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: 'noop {type:\\'go\\'}',
    engine, view: '<!doctype html><html><body>dup</body></html>' }
  await api.games.register(def)
  await api.games.register(def)`)
    const bad = await openHostOver(root, ['dsh-soulmojito.bad.dup'])
    const entry = bad.snapshot().mods[0]
    expect(entry.status).toBe('error')
    expect(entry.error).toContain('already registered')
    // 第一次注册随 setup 失败被 tracked 反注册回滚，不带病入册。
    const { games } = await service.list({ character: '', chatId: '' })
    expect(games.find((item) => item.id === 'dsh-soulmojito.bad.dup.g')).toBeUndefined()
    await bad.disposeAll()
  })

  it('manifest games 字段非法（非字符串数组）：scan 阶段被拒', async () => {
    const root = join(home, 'bad-manifest')
    const dir = join(root, 'mods', 'dsh-soulmojito.bad.manifest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mod.json'), JSON.stringify({
      id: 'dsh-soulmojito.bad.manifest', name: 'bad manifest', version: '1.0.0',
      author: 'gate', description: 'x', main: 'index.mjs', games: [123],
    }))
    writeFileSync(join(dir, 'index.mjs'), 'export async function setup() {}\n')
    const bad = await openHostOver(root, ['dsh-soulmojito.bad.manifest'])
    const entry = bad.snapshot().mods[0]
    expect(entry.status).toBe('error')
    expect(entry.error).toContain('games entries must be non-empty strings')
    await bad.disposeAll()
  })
})

describe('卸载孤儿语义与重装载恢复', () => {
  it('Mod 卸载 → 游戏摘册、会话 orphaned 只读；重装载后同一会话恢复可玩', async () => {
    const { session } = await service.start({ gameId: RPS_GAME, character: CHARACTER, chatId: CHAT })
    await service.humanAction(session.id, { type: 'throw', gesture: 'rock' })

    await host.disposeAll()
    const afterUnload = await service.list({ character: CHARACTER, chatId: CHAT })
    expect(afterUnload.games.find((item) => item.id === RPS_GAME)).toBeUndefined()
    const orphanState = await service.state(session.id)
    expect(orphanState.session.orphaned).toBe(true)
    await expect(service.humanAction(session.id, { type: 'throw', gesture: 'rock' }))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.view(RPS_GAME, session.id))
      .rejects.toMatchObject({ code: 'not-found' })

    // 重装载（reload 后新引擎实例）：孤儿判定按 gameId 动态查表，旧会话复活。
    host = await openHostOver(join(home, 'tavern'), ['dsh-soulmojito.rps'])
    const revived = await service.state(session.id)
    expect(revived.session.orphaned).toBe(false)
    // 复活时处于第 1 局的 Agent 手（人类已出 rock）；人类回合探针只剩 turn 纪律。
    await expect(service.humanAction(session.id, { type: 'throw', gesture: 'rock' }))
      .rejects.toMatchObject({ code: 'turn' })
    await service.agentMove(session.id, { type: 'throw', gesture: 'paper' })
    // 第 2 局：人 rock、Agent paper——两胜终局。
    await service.humanAction(session.id, { type: 'throw', gesture: 'rock' })
    const closing = await service.agentMove(session.id, { type: 'throw', gesture: 'paper' })
    expect(closing.session.finished).toBe(true)
    expect(closing.session.winner).toBe('second')
  })
})

// GameBridgeError code 类型收窄仅用于测试断言可读性（rejects.toMatchObject 按
// 属性匹配，不依赖 instanceof）。
void GameBridgeError
