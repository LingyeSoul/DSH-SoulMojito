/**
 * 内置地牢爬行（dsh-soulmojito.dungeon-crawl，探索者 vs 地下城主）——引擎契约
 * 与规则面测试。
 *
 * 【蓝军声明】与大富翁套件同款纪律：断言严格落在契约面上，不发明契约外断言；
 * 伤害浮动/猛击命中/掉落不可镜像——一切随机相关断言只锁「取值范围/事件分支」
 * 的不变式，或用**探针取证的固定 seed**（dungeonProbe 暴露布局/陷阱/内容的纯
 * 函数面）构造受控局面；布局与战斗流实现细节一概不镜像。
 *
 * 契约面（v1）：
 * - 清单：id 'dsh-soulmojito.dungeon-crawl'、name '地牢爬行'、version '1.0.0'、
 *   players {min:2,max:2,roles:['hero','world']}、turnBased、engines 缺席；
 * - 防偷看不变式（21 点暗牌延迟决定 + 记忆翻牌「未翻开牌面不进 state」同款）：
 *   ① 未揭示格不在 state.tiles；② 已揭示但未踩的陷阱不在 state（无任何键），
 *   踏上才落 trapSprung；③ 岩壁布局由 seed 纯函数重算、永不进 state——
 *   state 里只有揭示半径内的墙；
 * - 节奏不变式：探索动作（move/drink/descend）turn 恒留 hero；只有与活怪
 *   同格才 turn='world'（遭遇先手）；战斗逐手交替，怪死/脱战即回 hero；
 * - 数值：英雄 30HP/攻4/防0/药水3（+15）；怪 HP 6+3d±、攻 1+d±；Boss 32/5；
 * - 确定性：除 createGame 缺省 seed（crypto）外无随机/时间源；rolls 游标在
 *   state，同输入两次调用 deep-equal；
 * - 端到端：seed 3 + 仁慈 DM（恒 attack）脚本通关（约 87 手）；seed 1 同款
 *   脚本英雄阵亡（约 68 手）——两种终局都被锁定。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  dungeonCrawlEngine,
  dungeonProbe,
  manifest,
  viewHtml,
} from '../src/games/builtin/dungeon-crawl.js'
import { renderGameViewDocument } from '../src/games/view.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, jsonSizeOf, smokeTestGameEngine, type GameEngine } from '../src/games/standard.js'

type Role = 'hero' | 'world'
type Dir = 'up' | 'down' | 'left' | 'right'

interface Monster { name: string; hp: number; maxHp: number; atk: number; boss?: boolean; braced?: boolean }
interface Item { kind: 'potion' | 'weapon' | 'armor' | 'gold'; name: string; power?: number; amount?: number }
interface Tile { kind: 'floor' | 'stairs' | 'wall'; monster?: Monster; item?: Item; trapSprung?: boolean }
interface Hero { x: number; y: number; hp: number; maxHp: number; atk: number; def: number; potions: number; gold: number; weapon: string; armor: string }
interface DungeonState {
  turn: Role
  seed: number
  rolls: number
  depth: number
  hero: Hero
  tiles: Record<string, Tile>
  finished: boolean
  winner: Role | null
}
interface ApplyResult { state: DungeonState; events: string[]; finished: boolean; winner: Role | null; summary: string }

const engine = dungeonCrawlEngine as GameEngine

/** 任意 seed 的开局态（探针纪律：测试自己选 seed 构造受控局面）。 */
function start(seed: number): DungeonState {
  return engine.createGame({ seed }).state as DungeonState
}

/** 深拷贝 + 局部改写（手工构造受控局面——引擎把 state 当数据读，合法）。 */
function tweak(state: DungeonState, patch: (draft: DungeonState) => void): DungeonState {
  const next = structuredClone(state)
  patch(next)
  return next
}

function legalOf(state: DungeonState): Array<{ type: string; dir?: Dir }> {
  return engine.legalActions(state) as Array<{ type: string; dir?: Dir }>
}

function apply(state: DungeonState, action: unknown, actor: Role): ApplyResult {
  return engine.applyAction(state, action, actor) as ApplyResult
}

/* ------------------------------ 测试侧 BFS（探针数据上寻路） ------------------------------ */

function bfsPath(seed: number, depth: number, from: { x: number; y: number }, to: { x: number; y: number }): Dir[] {
  const carved = new Set(dungeonProbe.carveInfo(seed, depth).carved)
  const startKey = `${from.x},${from.y}`
  const goalKey = `${to.x},${to.y}`
  const prev = new Map<string, string>([[startKey, '']])
  const queue = [startKey]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur === goalKey) break
    const [cx, cy] = cur.split(',').map(Number)
    for (const [dir, dx, dy] of [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]] as Array<[Dir, number, number]>) {
      const nk = `${cx + dx},${cy + dy}`
      if (!carved.has(nk) || prev.has(nk)) continue
      prev.set(nk, cur)
      queue.push(nk)
    }
  }
  if (!prev.has(goalKey)) throw new Error(`BFS 不可达：${goalKey}（seed ${seed} depth ${depth}）`)
  const path: Dir[] = []
  let cur = goalKey
  while (cur !== startKey) {
    const p = prev.get(cur)!
    const [cx, cy] = cur.split(',').map(Number)
    const [px, py] = p.split(',').map(Number)
    if (cx === px && cy === py - 1) path.unshift('up')
    else if (cx === px && cy === py + 1) path.unshift('down')
    else if (cx === px - 1 && cy === py) path.unshift('left')
    else path.unshift('right')
    cur = p
  }
  return path
}

/** 路径（方向序列）从 from 出发是否途经 given 格——Boss 取证用例避开石阶格。 */
function walkPathPasses(from: { x: number; y: number }, path: Dir[], given: { x: number; y: number }): boolean {
  let cx = from.x
  let cy = from.y
  for (const dir of path) {
    if (dir === 'up') cy -= 1
    else if (dir === 'down') cy += 1
    else if (dir === 'left') cx -= 1
    else cx += 1
    if (cx === given.x && cy === given.y) return true
  }
  return false
}

/**
 * 沿探针寻路走到目标格：途中遭遇即战斗（英雄 hp<10 且可喝则喝，否则攻击；
 * world 恒以 attack 回击——仁慈 DM），到点即停。返回最终局面（可能已终局）。
 * 路径按下标推进——BFS 简单路径无环，英雄只沿路径走，战斗不推进下标。
 */
function walkTo(state: DungeonState, target: { x: number; y: number }, options: { maxSteps?: number } = {}): DungeonState {
  const maxSteps = options.maxSteps ?? 600
  const path = bfsPath(state.seed, state.depth, state.hero, target)
  let current = state
  let at = 0
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.finished) return current
    if (current.turn === 'world') {
      current = apply(current, { type: 'attack' }, 'world').state
      continue
    }
    const here = current.tiles[`${current.hero.x},${current.hero.y}`]?.monster
    if (here !== undefined) {
      const canDrink = legalOf(current).some((a) => a.type === 'drink')
      const action = current.hero.hp < 10 && canDrink ? { type: 'drink' } : { type: 'attack' }
      current = apply(current, action, 'hero').state
      continue
    }
    if (current.hero.x === target.x && current.hero.y === target.y) return current
    if (at >= path.length) throw new Error(`walkTo 路径走完仍未到 target ${target.x},${target.y}`)
    const dir = path[at]!
    if (!legalOf(current).some((a) => a.type === 'move' && a.dir === dir)) {
      throw new Error(`walkTo 卡死：${dir} 不合法（pos ${current.hero.x},${current.hero.y}）`)
    }
    current = apply(current, { type: 'move', dir }, 'hero').state
    at += 1
  }
  throw new Error(`walkTo 超步数上限（target ${target.x},${target.y}）`)
}

/** 探针找格：某层已凿格里第一个满足条件的坐标。 */
function findCell(seed: number, depth: number, predicate: (x: number, y: number) => boolean): { x: number; y: number } {
  for (const key of dungeonProbe.carveInfo(seed, depth).carved) {
    const [x, y] = key.split(',').map(Number)
    if (predicate(x!, y!)) return { x: x!, y: y! }
  }
  throw new Error('findCell 找不到满足条件的格子')
}

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 hero/world、engines 缺席', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-soulmojito.dungeon-crawl')
    expect(manifest.name).toBe('地牢爬行')
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['hero', 'world'] })
    expect(manifest.engines).toBeUndefined()
    expect(manifest.actionVocabulary).toContain('move')
    expect(manifest.actionVocabulary).toContain('heavy')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(engine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-soulmojito:game-state')
    expect(viewHtml).toContain('dsh-soulmojito:game-action')
    expect(viewHtml).toContain('data-game="dsh-soulmojito.dungeon-crawl"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(viewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.dungeon-crawl"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })

  it('引擎源码不含 Math.random / Date.now（确定性硬约束，seed 缺省走 node:crypto）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/games/builtin/dungeon-crawl.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('Math.random')
    expect(source).not.toContain('Date.now')
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(engine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

describe('createGame（§3.2）', () => {
  it('初始态：地下 1 层、入口 (1,1)、30HP/攻4/防0/药水3、turn hero、JSON-safe', () => {
    const state = start(1)
    expect(state.turn).toBe('hero')
    expect(state.depth).toBe(1)
    expect(state.hero).toEqual({ x: 1, y: 1, hp: 30, maxHp: 30, atk: 4, def: 0, potions: 3, gold: 0, weapon: '木棍', armor: '布衣' })
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    expect(currentRoleOf(state, manifest.players.roles)).toBe('hero')
    expect(jsonSizeOf(state)).toBeLessThan(65_536)
  })

  it('同 seed 两次 createGame deep-equal；缺省 seed（crypto）无 options 与空对象两路都出合法开局', () => {
    expect(start(7)).toEqual(start(7))
    for (const options of [undefined, {}]) {
      const state = engine.createGame(options).state as DungeonState
      expect(Number.isInteger(state.seed)).toBe(true)
      expect(state.seed).toBeGreaterThan(0)
      expect(state.turn).toBe('hero')
    }
  })

  it('初始建议集非空且全为 move（入口至少一个可凿邻格——游走构造保证）', () => {
    const actions = legalOf(start(1))
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.length).toBeLessThanOrEqual(64)
    for (const action of actions) expect(action.type).toBe('move')
  })
})

describe('布局与迷雾：防偷看不变式（暗牌延迟决定同款）', () => {
  it('探针：1 层凿 44 格、入口与石阶都在凿区、石阶不是入口', () => {
    const info = dungeonProbe.carveInfo(1, 1)
    expect(info.size).toBe(44)
    expect(info.carved).toContain('1,1')
    expect(info.carved).toContain(`${info.stairs.x},${info.stairs.y}`)
    expect(info.stairs).not.toEqual({ x: 1, y: 1 })
  })

  it('未揭示格不在 state：初始 tiles ⊆ 入口切比雪夫 2 半径、凿区内是地面/石阶、非凿区是墙；凿区远格不在 tiles', () => {
    const state = start(1)
    const carved = new Set(dungeonProbe.carveInfo(1, 1).carved)
    const keys = Object.keys(state.tiles)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const [x, y] = key.split(',').map(Number)
      expect(Math.max(Math.abs(x! - 1), Math.abs(y! - 1))).toBeLessThanOrEqual(2)
      if (carved.has(key)) {
        expect(['floor', 'stairs']).toContain(state.tiles[key]!.kind)
      } else {
        // 揭示半径内的非凿区格渲染为墙（岩壁可示）。
        expect(state.tiles[key]!.kind).toBe('wall')
      }
    }
    // 远处已凿格（布局存在于纯函数、不进 state）。
    const far = [...carved].find((key) => {
      const [x, y] = key.split(',').map(Number)
      return Math.max(Math.abs(x! - 1), Math.abs(y! - 1)) > 2
    })
    expect(far).toBeDefined()
    expect(state.tiles[far!]).toBeUndefined()
  })

  it('armed 陷阱不进 state：已揭示的陷阱格无任何陷阱痕迹，踩中才显形（伤害无浮动可精确断言）、再踏入不重复触发', () => {
    // 找一个陷阱格位于开局揭示半径内（切比雪夫 ≤2）——已揭示却看不见陷阱，
    // 正是「信息不存在」防偷看不变式的实证；邻格作受控起踏点。
    let scenario: { seed: number; trap: { x: number; y: number }; neighbor: { x: number; y: number }; onto: Dir; back: Dir } | undefined
    for (let seed = 1; seed <= 30 && scenario === undefined; seed += 1) {
      const cells = dungeonProbe.carveInfo(seed, 1).carved.map((key) => key.split(',').map(Number) as [number, number])
      for (const [x, y] of cells) {
        if (!dungeonProbe.trapAt(seed, 1, x, y)) continue
        if (Math.max(Math.abs(x - 1), Math.abs(y - 1)) > 2) continue
        for (const [nx, ny] of cells) {
          if (Math.abs(nx - x) + Math.abs(ny - y) !== 1 || dungeonProbe.trapAt(seed, 1, nx, ny)) continue
          scenario = {
            seed,
            trap: { x, y },
            neighbor: { x: nx, y: ny },
            onto: nx < x ? 'right' : nx > x ? 'left' : ny < y ? 'down' : 'up',
            back: nx < x ? 'left' : nx > x ? 'right' : ny < y ? 'up' : 'down',
          }
          break
        }
        if (scenario !== undefined) break
      }
    }
    expect(scenario).toBeDefined()
    const { seed, trap, neighbor, onto, back } = scenario!

    const state = tweak(start(seed), (draft) => {
      // 受控起踏点：直接放置（非 move，不触发内容结算），清掉邻格怪/物排除干扰。
      draft.hero.x = neighbor.x
      draft.hero.y = neighbor.y
      const nTile = draft.tiles[`${neighbor.x},${neighbor.y}`]
      if (nTile !== undefined) {
        delete nTile.monster
        delete nTile.item
      }
    })
    // 防偷看：陷阱格已揭示（在 tiles 里）却无任何陷阱信息。
    const revealedTrap = state.tiles[`${trap.x},${trap.y}`]!
    expect(revealedTrap).toBeDefined()
    expect(revealedTrap.trapSprung).toBeUndefined()
    expect(revealedTrap.monster).toBeUndefined()

    const sprung = apply(state, { type: 'move', dir: onto }, 'hero')
    // 1 层陷阱伤害 = 2 + depth = 3（无战斗流参与，可精确断言）。
    expect(sprung.state.hero.hp).toBe(27)
    expect(sprung.state.tiles[`${trap.x},${trap.y}`]!.trapSprung).toBe(true)
    expect(sprung.summary).toContain('陷阱')

    // 走开再回来：已显形陷阱不再触发（hp 不因再踏而下降）。
    const returned = apply(apply(sprung.state, { type: 'move', dir: back }, 'hero').state, { type: 'move', dir: onto }, 'hero')
    expect(returned.state.hero.hp).toBe(27)
    expect(returned.state.tiles[`${trap.x},${trap.y}`]!.trapSprung).toBe(true)
  })
})

describe('移动与探索', () => {
  it('普通一步：events 含方向叙述、turn 留 hero、rolls 不动（纯移动不耗战斗流）', () => {
    const state = start(1)
    const dir = legalOf(state)[0]!.dir!
    const result = apply(state, { type: 'move', dir }, 'hero')
    expect(result.events[0]).toContain('探索')
    expect(result.state.turn).toBe('hero')
    expect(result.state.rolls).toBe(state.rolls)
    expect(result.state.hero.x !== state.hero.x || result.state.hero.y !== state.hero.y).toBe(true)
  })

  it('岩壁与边界：入口向上/向左恒是岩壁（0 行 0 列不凿），中文抛错', () => {
    const state = start(1)
    expect(() => apply(state, { type: 'move', dir: 'up' }, 'hero')).toThrow(/岩壁/)
    expect(() => apply(state, { type: 'move', dir: 'left' }, 'hero')).toThrow(/岩壁/)
  })

  it('非法方向 / 缺 type / 未知 type / resign 全部抛错（中文）', () => {
    const state = start(1)
    expect(() => apply(state, { type: 'move', dir: 'north' }, 'hero')).toThrow(/up\/down\/left\/right/)
    expect(() => apply(state, { type: 'move' }, 'hero')).toThrow(/方向/)
    expect(() => apply(state, { type: 'jump' }, 'hero')).toThrow(/move\/attack\/drink\/descend/)
    expect(() => apply(state, { type: 'resign' }, 'hero')).toThrow(/保留动作/)
    expect(() => apply(state, { dir: 'up' }, 'hero')).toThrow(/type/)
  })

  it('下楼：站上石阶 descend → 深度 +1、回入口、tiles 重置为新区半径、楼梯坍塌叙事', () => {
    let state = start(1)
    const stairs = dungeonProbe.carveInfo(1, 1).stairs
    state = walkTo(state, stairs)
    expect(state.tiles[`${stairs.x},${stairs.y}`]!.kind).toBe('stairs')
    const result = apply(state, { type: 'descend' }, 'hero')
    expect(result.state.depth).toBe(2)
    expect(result.state.hero.x).toBe(1)
    expect(result.state.hero.y).toBe(1)
    expect(result.state.turn).toBe('hero')
    expect(result.events.join()).toContain('坍塌')
    // 新层揭示规模与开局同款（半径 2）。
    expect(Object.keys(result.state.tiles).length).toBeGreaterThan(0)
    expect(Object.keys(result.state.tiles).length).toBeLessThanOrEqual(24)
  })

  it('最底层石阶：descend 抛「巢穴」（Boss 战是唯一出路）', () => {
    const state = tweak(start(1), (draft) => {
      draft.depth = 3
      draft.tiles = { '1,1': { kind: 'stairs' } }
    })
    expect(() => apply(state, { type: 'descend' }, 'hero')).toThrow(/巢穴/)
  })

  it('非石阶格 descend 抛错（中文）', () => {
    const state = start(1)
    expect(() => apply(state, { type: 'descend' }, 'hero')).toThrow(/石阶/)
  })
})

describe('遭遇与战斗（world 三择）', () => {
  /** 受控遭遇态：英雄与 hp/maxHp 可控的怪同格、turn='world'。 */
  function engagedState(monster: Partial<Monster> = {}): DungeonState {
    return tweak(start(1), (draft) => {
      draft.tiles['1,1'] = {
        kind: 'floor',
        monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3, ...monster },
      }
      draft.turn = 'world'
    })
  }

  it('踏上活怪格：遭遇事件、turn → world、建议集 = [attack, heavy, defend]', () => {
    // 手工放置一只怪在入口紧邻的可凿格，走过去。
    const cell = findCell(1, 1, (x, y) => Math.abs(x - 1) + Math.abs(y - 1) === 1 && !dungeonProbe.trapAt(1, 1, x, y))
    const state = tweak(start(1), (draft) => {
      draft.tiles[`${cell.x},${cell.y}`] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
    })
    const dir = cell.x === 2 ? 'right' : 'down'
    const result = apply(state, { type: 'move', dir }, 'hero')
    expect(result.events.join()).toContain('遭遇')
    expect(result.state.turn).toBe('world')
    expect(legalOf(result.state).map((a) => a.type)).toEqual(['attack', 'heavy', 'defend'])
  })

  it('world attack：伤害 = 怪攻 ±1 - 防（范围断言，不镜像骰子）；英雄未死则回合回 hero', () => {
    const state = engagedState({ atk: 9 })
    const result = apply(state, { type: 'attack' }, 'world')
    expect(result.state.hero.hp).toBeGreaterThanOrEqual(30 - 10)
    expect(result.state.hero.hp).toBeLessThanOrEqual(30 - 8)
    expect(result.state.turn).toBe('hero')
    expect(result.events[0]).toContain('史莱姆')
  })

  it('world heavy：两分支——闪过（hp 不变）或命中（伤害 ≥ 双倍下界）', () => {
    const state = engagedState({ atk: 9 })
    const result = apply(state, { type: 'heavy' }, 'world')
    if (result.events.join().includes('闪过')) {
      expect(result.state.hero.hp).toBe(30)
    } else {
      expect(30 - result.state.hero.hp).toBeGreaterThanOrEqual(16)
      expect(result.state.turn).toBe('hero')
    }
  })

  it('world defend：架势减半英雄下一击（braced 置位 → 攻击结算即清）', () => {
    let state = engagedState({ hp: 20, maxHp: 20 })
    state = apply(state, { type: 'defend' }, 'world').state
    expect(state.tiles['1,1']!.monster!.braced).toBe(true)
    expect(state.hero.hp).toBe(30)
    expect(state.turn).toBe('hero')
    const hit = apply(state, { type: 'attack' }, 'hero')
    // raw = 4 ±1 ∈ [3,5]，架势减半 → dmg ∈ [1,2]；怪未死 → 战斗交替回 world。
    expect(20 - hit.state.tiles['1,1']!.monster!.hp).toBeLessThanOrEqual(2)
    expect(hit.state.tiles['1,1']!.monster!.braced).toBe(false)
    expect(hit.state.turn).toBe('world')
    state = apply(hit.state, { type: 'attack' }, 'world').state
    expect(state.turn).toBe('hero')
    const hit2 = apply(state, { type: 'attack' }, 'hero')
    // 两记英雄攻击合计（1-2 减半 + 3-5 全额）恒 > 2。
    expect(20 - hit2.state.tiles['1,1']!.monster!.hp).toBeGreaterThan(2)
  })

  it('英雄攻击：击杀掉金币（≥4）、怪从格上消失、turn 回 hero；药水掉落只锁范围', () => {
    const state = tweak(engagedState({ hp: 1 }), (draft) => { draft.turn = 'hero' })
    const result = apply(state, { type: 'attack' }, 'hero')
    expect(result.finished).toBe(false)
    expect(result.state.tiles['1,1']!.monster).toBeUndefined()
    expect(result.state.hero.gold).toBeGreaterThanOrEqual(4)
    expect([3, 4]).toContain(result.state.hero.potions)
    expect(result.state.turn).toBe('hero')
    expect(result.events.join()).toContain('掉落')
  })

  it('Boss 击杀（3 层石阶）：终局、winner hero、通关叙事', () => {
    const state = tweak(start(1), (draft) => {
      draft.depth = 3
      draft.tiles = { '1,1': { kind: 'stairs', monster: { name: '炎魔君王', hp: 1, maxHp: 32, atk: 5, boss: true } } }
      draft.turn = 'hero'
    })
    const result = apply(state, { type: 'attack' }, 'hero')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('hero')
    expect(result.summary).toContain('通关')
    expect(legalOf(result.state)).toEqual([])
  })

  it('英雄阵亡：world 攻击致 hp ≤ 0 → 终局 winner world、叙事含「倒下」', () => {
    const state = tweak(engagedState({ atk: 9 }), (draft) => { draft.hero.hp = 2 })
    const result = apply(state, { type: 'attack' }, 'world')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('world')
    expect(result.state.hero.hp).toBe(0)
    expect(result.summary).toContain('倒下')
  })

  it('回合纪律：错 actor 双向中文抛错；world 无接战怪时三动作抛错', () => {
    const state = start(1)
    expect(() => apply(state, { type: 'attack' }, 'world')).toThrow(/轮到英雄/)
    const inCombat = tweak(start(1), (draft) => { draft.turn = 'world' })
    expect(() => apply(inCombat, { type: 'move', dir: 'up' }, 'hero')).toThrow(/轮到地下城主/)
    expect(() => apply(inCombat, { type: 'attack' }, 'world')).toThrow(/没有与英雄接战/)
  })
})

describe('喝药与拾取', () => {
  it('喝药：+15 封顶、药水 -1；战斗中喝药把回合让给怪物', () => {
    const idle = tweak(start(1), (draft) => { draft.hero.hp = 10 })
    const result = apply(idle, { type: 'drink' }, 'hero')
    expect(result.state.hero.hp).toBe(25)
    expect(result.state.hero.potions).toBe(2)
    expect(result.state.turn).toBe('hero')
    const inCombat = tweak(start(1), (draft) => {
      draft.hero.hp = 10
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
    })
    const combat = apply(inCombat, { type: 'drink' }, 'hero')
    expect(combat.state.turn).toBe('world')
  })

  it('喝药闸：满血抛错、无药抛错、均不进建议集', () => {
    const full = start(1)
    expect(() => apply(full, { type: 'drink' }, 'hero')).toThrow(/状态良好/)
    expect(legalOf(full).some((a) => a.type === 'drink')).toBe(false)
    const empty = tweak(start(1), (draft) => {
      draft.hero.potions = 0
      draft.hero.hp = 5
    })
    expect(() => apply(empty, { type: 'drink' }, 'hero')).toThrow(/没有治疗药水/)
    expect(legalOf(empty).some((a) => a.type === 'drink')).toBe(false)
  })

  /** 相邻格放物品后走一步拾取（格选自探针凿区、避陷阱）。 */
  function pickupCell(item: Item, hero: Hero): { state: DungeonState; dir: Dir } {
    const cell = findCell(1, 1, (x, y) => Math.abs(x - 1) + Math.abs(y - 1) === 1 && !dungeonProbe.trapAt(1, 1, x, y))
    const state = tweak(start(1), (draft) => {
      draft.tiles[`${cell.x},${cell.y}`] = { kind: 'floor', item }
      draft.hero = { ...hero, x: 1, y: 1 }
    })
    return { state, dir: cell.x === 2 ? 'right' : 'down' }
  }

  it('拾取药水/金币：进背包、格上物品消失', () => {
    const potion = pickupCell({ kind: 'potion', name: '治疗药水' }, start(1).hero)
    const gotPotion = apply(potion.state, { type: 'move', dir: potion.dir }, 'hero')
    expect(gotPotion.state.hero.potions).toBe(4)
    expect(gotPotion.state.tiles[`2,1`] ?? gotPotion.state.tiles[`1,2`]).not.toHaveProperty('item')

    const gold = pickupCell({ kind: 'gold', name: '金币', amount: 9 }, start(1).hero)
    const gotGold = apply(gold.state, { type: 'move', dir: gold.dir }, 'hero')
    expect(gotGold.state.hero.gold).toBe(9)
  })

  it('换装：更优武器/护甲穿上（攻防更新）；不优则留在格上不捡', () => {
    const better = pickupCell({ kind: 'weapon', name: '铁剑', power: 1 }, start(1).hero)
    const armed = apply(better.state, { type: 'move', dir: better.dir }, 'hero')
    expect(armed.state.hero.atk).toBe(5)
    expect(armed.state.hero.weapon).toBe('铁剑')
    expect(armed.events.join()).toContain('装备')

    const alreadyBetter = tweak(armed.state, (draft) => {
      draft.hero.x = 1
      draft.hero.y = 1
      draft.tiles['2,1'] = { kind: 'floor', item: { kind: 'weapon', name: '铁剑', power: 1 } }
    })
    const kept = apply(alreadyBetter, { type: 'move', dir: 'right' }, 'hero')
    expect(kept.state.hero.weapon).toBe('铁剑')
    expect(kept.state.hero.atk).toBe(5)
    // 秘银剑在手（攻 6），铁剑（+1）不换——留在格上。
    const mithril = tweak(kept.state, (draft) => {
      draft.hero.x = 1
      draft.hero.y = 1
      draft.hero.atk = 6
      draft.hero.weapon = '秘银剑'
      draft.tiles['2,1'] = { kind: 'floor', item: { kind: 'weapon', name: '铁剑', power: 1 } }
    })
    const ignored = apply(mithril, { type: 'move', dir: 'right' }, 'hero')
    expect(ignored.state.hero.atk).toBe(6)
    expect(ignored.state.tiles['2,1']!.item).toEqual({ kind: 'weapon', name: '铁剑', power: 1 })
  })

  it('入口格 (1,1) 恒干净：揭示为纯地面（无怪/无物）、trapAt 恒假（多 seed）', () => {
    for (const seed of [1, 2, 3, 5, 8]) {
      expect(start(seed).tiles['1,1']).toEqual({ kind: 'floor' })
      expect(dungeonProbe.trapAt(seed, 1, 1, 1)).toBe(false)
    }
  })
})

describe('终局与非法面', () => {
  it('终局后任何动作抛错（中文）；建议集空', () => {
    const dead = tweak(start(1), (draft) => {
      draft.finished = true
      draft.winner = 'world'
      draft.turn = 'hero'
    })
    expect(() => apply(dead, { type: 'move', dir: 'down' }, 'hero')).toThrow(/对局已结束/)
    expect(legalOf(dead)).toEqual([])
  })

  it('非 JSON 对象 / 未知角色抛错（中文）', () => {
    const state = start(1)
    expect(() => engine.applyAction(state, 'move', 'hero')).toThrow(/JSON 对象/)
    expect(() => engine.applyAction(state, null, 'hero')).toThrow(/JSON 对象/)
    expect(() => apply(state, { type: 'move', dir: 'down' }, 'wizard')).toThrow(/hero\/world/)
  })
})

describe('确定性（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变（战斗流路径）', () => {
    const state = tweak(start(1), (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
      draft.turn = 'world'
    })
    const snapshot = structuredClone(state)
    const first = apply(state, { type: 'attack' }, 'world')
    const second = apply(state, { type: 'attack' }, 'world')
    expect(first).toEqual(second)
    expect(state).toEqual(snapshot)
  })

  it('探索路径重放两次 deep-equal（含拾取/揭示/陷阱的完整分支）', () => {
    const stairs = dungeonProbe.carveInfo(1, 1).stairs
    expect(walkTo(start(1), stairs)).toEqual(walkTo(start(1), stairs))
  })
})

describe('端到端：脚本通关与阵亡（探针 seed 取证，仁慈 DM 恒 attack）', () => {
  it('seed 3：BFS 导航三层 + 沿途战斗 → 斩杀（石阶上唯一的）炎魔君王通关（winner hero）', () => {
    let state = start(3)
    state = walkTo(state, dungeonProbe.carveInfo(3, 1).stairs)
    state = apply(state, { type: 'descend' }, 'hero').state
    expect(state.depth).toBe(2)
    state = walkTo(state, dungeonProbe.carveInfo(3, 2).stairs)
    state = apply(state, { type: 'descend' }, 'hero').state
    expect(state.depth).toBe(3)
    // Boss 唯一性取证（2026-10-16 实弹修复的回归锚）：先走到石阶邻格（BFS
    // 路径避开石阶格本身——不在取证前触发遭遇），断言揭示范围内 Boss 恰一只、
    // 就在石阶格、其余揭示怪全非 Boss。
    const stairs3 = dungeonProbe.carveInfo(3, 3).stairs
    const carved3 = dungeonProbe.carveInfo(3, 3).carved
    const candidates = carved3
      .map((key) => key.split(',').map(Number) as [number, number])
      .filter(([x, y]) => Math.abs(x - stairs3.x) + Math.abs(y - stairs3.y) === 1 && !dungeonProbe.trapAt(3, 3, x, y))
    const safe = candidates.find(([x, y]) => !walkPathPasses(state.hero, bfsPath(3, 3, state.hero, { x, y }), stairs3))
    const near = safe ?? candidates[0]!
    state = walkTo(state, { x: near[0], y: near[1] })
    const stairTile = state.tiles[`${stairs3.x},${stairs3.y}`]!
    expect(stairTile.kind).toBe('stairs')
    expect(stairTile.monster).toMatchObject({ boss: true, name: '炎魔君王' })
    const bosses = Object.entries(state.tiles).filter(([, tile]) => tile.monster?.boss === true)
    expect(bosses).toHaveLength(1)
    expect(bosses[0]![0]).toBe(`${stairs3.x},${stairs3.y}`)
    // 踏入石阶格 = 遭遇 Boss（先手交 world），战斗到终局。
    const onto = near[0] < stairs3.x ? 'right' : near[0] > stairs3.x ? 'left' : near[1] < stairs3.y ? 'down' : 'up'
    const met = apply(state, { type: 'move', dir: onto }, 'hero')
    expect(met.state.turn).toBe('world')
    expect(met.summary).toContain('炎魔君王')
    state = walkTo(met.state, stairs3, { maxSteps: 900 })
    expect(state.finished).toBe(true)
    expect(state.winner).toBe('hero')
    expect(state.hero.gold).toBeGreaterThan(0)
  })

  it('seed 1：同款脚本英雄阵亡（winner world）——死亡终局同样可达且被锁定', () => {
    let state = start(1)
    state = walkTo(state, dungeonProbe.carveInfo(1, 1).stairs)
    state = apply(state, { type: 'descend' }, 'hero').state
    state = walkTo(state, dungeonProbe.carveInfo(1, 2).stairs)
    state = apply(state, { type: 'descend' }, 'hero').state
    state = walkTo(state, dungeonProbe.carveInfo(1, 3).stairs, { maxSteps: 900 })
    expect(state.finished).toBe(true)
    expect(state.winner).toBe('world')
  })

  it('通关脚本整局重放两次 deep-equal', () => {
    const run = (): DungeonState => {
      let state = start(3)
      state = walkTo(state, dungeonProbe.carveInfo(3, 1).stairs)
      state = apply(state, { type: 'descend' }, 'hero').state
      state = walkTo(state, dungeonProbe.carveInfo(3, 2).stairs)
      state = apply(state, { type: 'descend' }, 'hero').state
      return walkTo(state, dungeonProbe.carveInfo(3, 3).stairs, { maxSteps: 900 })
    }
    expect(run()).toEqual(run())
  })
})

describe('describe（叙述面，sessions 在 applyAction 前取）', () => {
  it('七类动作的可叙述文案 + resign 回落', () => {
    const state = tweak(start(1), (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
    })
    expect(engine.describe(state, 'hero', { type: 'move', dir: 'up' })).toContain('北')
    expect(engine.describe(state, 'hero', { type: 'move', dir: 'right' })).toContain('东')
    expect(engine.describe(state, 'hero', { type: 'attack' })).toContain('史莱姆')
    expect(engine.describe(state, 'world', { type: 'attack' })).toContain('史莱姆')
    expect(engine.describe(state, 'world', { type: 'heavy' })).toContain('蓄力猛击')
    expect(engine.describe(state, 'world', { type: 'defend' })).toContain('防御')
    expect(engine.describe(state, 'hero', { type: 'drink' })).toContain('药水')
    expect(engine.describe(state, 'hero', { type: 'descend' })).toContain('石阶')
    expect(engine.describe(state, 'hero', { type: 'resign' })).toContain('未被本引擎识别')
  })
})

/* ---------------------- 视图反馈层（2026-10-16 用户需求） ---------------------- */
/* 最小 DOM 垫片把内联脚本真跑一遍（21 点坐席归属视图用例同款纪律）：键盘绑定
 * 走真实 keydown 分发断言 postMessage 上行；事件提示/飘字用引擎真实 applyAction
 * 结果作下行载荷序列，按指纹差分断言弹与不弹。 */

class FakeElement {
  children: FakeElement[] = []
  className = ''
  textContent = ''
  disabled = false
  style: Record<string, string> = {}
  offsetLeft = 0
  offsetTop = 0
  offsetWidth = 26
  private innerHtmlText = ''
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  constructor(readonly tagName: string) {}
  get innerHTML(): string { return this.innerHtmlText }
  set innerHTML(value: string) {
    this.innerHtmlText = value
    if (value === '') this.children.length = 0
  }
  get firstChild(): FakeElement | null { return this.children[0] ?? null }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child }
  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
}

const VIEW_ELEMENT_IDS = [
  'board', 'board-wrap', 'dc-toast-stack', 'banner', 'session-id', 'hp-text', 'hp-fill', 'stat-line',
  'btn-up', 'btn-down', 'btn-left', 'btn-right', 'btn-attack', 'btn-drink', 'btn-descend',
] as const

interface KeyEvt { key: string; preventDefault(): void; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

interface ViewHarness {
  el(id: string): FakeElement
  dispatch(state: DungeonState, summary: string): void
  key(event: KeyEvt): void
  sent: Array<{ action: { type: string; dir?: string } }>
}

/** 打开视图脚本（search 带 token 即实时面）。 */
function openDungeonView(search: string): ViewHarness {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(viewHtml)
  expect(script, 'viewHtml 含内联脚本').not.toBeNull()
  const registry = new Map<string, FakeElement>(VIEW_ELEMENT_IDS.map((id): [string, FakeElement] => [id, new FakeElement('div')]))
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  const keyListeners: Array<(event: KeyEvt) => void> = []
  const sent: Array<{ action: { type: string; dir?: string } }> = []
  const documentShim = {
    getElementById: (id: string): FakeElement | null => registry.get(id) ?? null,
    createElement: (tagName: string): FakeElement => new FakeElement(tagName),
    addEventListener: (type: string, listener: (event: KeyEvt) => void): void => {
      if (type === 'keydown') keyListeners.push(listener)
    },
  }
  const windowShim = {
    location: { search },
    parent: { postMessage: (message: { action: { type: string; dir?: string } }): void => { sent.push(message) } },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void): void => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  const run = new Function('window', 'document', 'URLSearchParams', script![1]!) as (
    window: unknown, document: unknown, urlSearchParams: unknown,
  ) => void
  run(windowShim, documentShim, URLSearchParams)
  return {
    el: (id) => {
      const element = registry.get(id)
      if (element === undefined) throw new Error(`缺垫片元素 ${id}`)
      return element
    },
    dispatch: (state, summary) => {
      const view = { state, turn: state.turn, legal: legalOf(state), finished: state.finished, summary }
      for (const listener of [...messageListeners]) {
        listener({ data: { type: 'dsh-soulmojito:game-state', token: 't', session: { id: 'g-viewtest' }, view } })
      }
    },
    key: (event) => {
      for (const listener of [...keyListeners]) listener(event)
    },
    sent,
  }
}

describe('视图反馈层：静态标记（提示栈 / 飘字 / 键盘绑定）', () => {
  it('viewHtml 含提示栈、飘字与键盘绑定的实现标记及键位角标', () => {
    expect(viewHtml).toContain('dc-toast-stack')
    expect(viewHtml).toContain('dc-float-num')
    expect(viewHtml).toContain('function toastClassOf') // 提示分级函数
    expect(viewHtml).toContain("addEventListener('keydown'")
    expect(viewHtml).toContain('WASD / 方向键移动 · J 攻击 · K 喝药 · L 下楼')
    expect(viewHtml).toContain('<span class="k">J</span>')
    expect(viewHtml).toContain('<span class="k">K</span>')
    expect(viewHtml).toContain('<span class="k">L</span>')
  })

  it('提示栈零布局抖动（2026-10-16 五次迭代）：地图内浮层（board-wrap 内、absolute 底部锚定）', () => {
    // 三次迭代终态：初版顶部浮层挡画面 → 文档流位致操作栏抖动（提示增删触发
    // 布局回流）→ 回位地图内但底部锚定。契约：①toast 栈在 board-wrap **内部**
    // （渲染进地图）；②CSS 为 absolute（零布局位移——出现/消失不牵动操作栏）；
    // ③底部锚定（bottom 锚，入口区左上全程无遮挡）。
    const wrapOpen = viewHtml.indexOf('<div id="board-wrap">')
    const toastAt = viewHtml.indexOf('<div id="dc-toast-stack"></div>')
    const boardAt = viewHtml.indexOf('<div id="board"></div>')
    const wrapClose = viewHtml.indexOf('</div>\n<div id="controls">')
    expect(wrapOpen).toBeGreaterThan(-1)
    expect(toastAt).toBeGreaterThan(wrapOpen)
    expect(boardAt).toBeGreaterThan(toastAt)
    expect(wrapClose).toBeGreaterThan(boardAt)
    const rule = /#dc-toast-stack \{([\s\S]*?)\}/.exec(viewHtml)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('absolute')
    expect(rule![1]).toContain('bottom')
    expect(rule![1]).not.toContain('margin-top')
  })
})

describe('视图反馈层：键盘绑定（DOM 垫片真跑内联脚本）', () => {
  it('WASD 与方向键移动：合法方向上行 move、非法方向静默、修饰键组合不劫持', () => {
    const view = openDungeonView('?token=t')
    const base = start(1)
    view.dispatch(base, '')
    // 入口 (1,1)：上/左是边界岩壁（disabled），键盘与按钮共用同一合法面。
    expect(view.el('btn-up').disabled).toBe(true)
    expect(view.el('btn-left').disabled).toBe(true)
    view.key({ key: 'w', preventDefault: () => {} })
    expect(view.sent).toHaveLength(0)
    const dir = legalOf(base).find((a) => a.type === 'move')!.dir!
    const wasd = dir === 'up' ? 'w' : dir === 'down' ? 's' : dir === 'left' ? 'a' : 'd'
    const arrow = dir === 'up' ? 'ArrowUp' : dir === 'down' ? 'ArrowDown' : dir === 'left' ? 'ArrowLeft' : 'ArrowRight'
    view.key({ key: wasd, preventDefault: () => {} })
    expect(view.sent).toHaveLength(1)
    expect(view.sent[0]!.action).toEqual({ type: 'move', dir })
    view.key({ key: arrow, preventDefault: () => {} })
    expect(view.sent).toHaveLength(2)
    expect(view.sent[1]!.action).toEqual({ type: 'move', dir })
    view.key({ key: wasd, preventDefault: () => {}, ctrlKey: true })
    view.key({ key: wasd, preventDefault: () => {}, altKey: true })
    view.key({ key: wasd, preventDefault: () => {}, metaKey: true })
    expect(view.sent).toHaveLength(2)
  })

  it('J/K/L 三动作：战斗中 J 攻击上行、无怪时 J 静默（按钮 disabled 即不动作）', () => {
    const view = openDungeonView('?token=t')
    const idle = start(1)
    view.dispatch(idle, '')
    expect(view.el('btn-attack').disabled).toBe(true)
    view.key({ key: 'j', preventDefault: () => {} })
    view.key({ key: 'k', preventDefault: () => {} }) // 满血喝药非法
    view.key({ key: 'l', preventDefault: () => {} }) // 不在石阶
    expect(view.sent).toHaveLength(0)

    const engaged = tweak(idle, (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
    })
    view.dispatch(engaged, '')
    expect(view.el('btn-attack').disabled).toBe(false)
    view.key({ key: 'j', preventDefault: () => {} })
    expect(view.sent).toHaveLength(1)
    expect(view.sent[0]!.action).toEqual({ type: 'attack' })
  })

  it('地下城主回合（turn world）：全部按键静默——键盘不越过回合闸', () => {
    const view = openDungeonView('?token=t')
    const worldTurn = tweak(start(1), (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
      draft.turn = 'world'
    })
    view.dispatch(worldTurn, '')
    for (const key of ['w', 'a', 's', 'd', 'j', 'k', 'l', 'ArrowUp', 'ArrowDown']) {
      view.key({ key, preventDefault: () => {} })
    }
    expect(view.sent).toHaveLength(0)
  })
})

describe('视图反馈层：事件提示栈与飘字（引擎真实载荷序列）', () => {
  it('首帧不弹；每手 summary 弹提示；怪物受创/英雄受击/治疗按类飘字；重复轮询不弹', () => {
    const view = openDungeonView('?token=t')
    const state = tweak(start(1), (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 20, maxHp: 20, atk: 3 } }
      draft.hero.hp = 20
    })
    view.dispatch(state, '')
    expect(view.el('dc-toast-stack').children).toHaveLength(0)

    const hit = apply(state, { type: 'attack' }, 'hero')
    view.dispatch(hit.state, hit.summary)
    expect(view.el('dc-toast-stack').children).toHaveLength(1)
    expect(view.el('dc-toast-stack').children[0]!.textContent).toBe(hit.summary)
    const floats = view.el('board-wrap').children.filter((child) => child.className.startsWith('dc-float-num'))
    expect(floats.some((child) => child.className.includes('dmg'))).toBe(true)

    // 重复轮询同一帧（指纹未变）：不重复弹。
    view.dispatch(hit.state, hit.summary)
    expect(view.el('dc-toast-stack').children).toHaveLength(1)

    const counter = apply(hit.state, { type: 'attack' }, 'world')
    view.dispatch(counter.state, counter.summary)
    expect(view.el('dc-toast-stack').children).toHaveLength(2)
    expect(view.el('board-wrap').children.some((child) => child.className.includes('hurt'))).toBe(true)

    const heal = apply(counter.state, { type: 'drink' }, 'hero')
    view.dispatch(heal.state, heal.summary)
    expect(view.el('board-wrap').children.some((child) => child.className.includes('heal'))).toBe(true)
  })

  it('击杀出 💀 飘字；遭遇/终局提示分级（danger/finale）', () => {
    const kill = openDungeonView('?token=t')
    const one = tweak(start(1), (draft) => {
      draft.tiles['1,1'] = { kind: 'floor', monster: { name: '史莱姆', hp: 1, maxHp: 9, atk: 3 } }
    })
    kill.dispatch(one, '')
    const killed = apply(one, { type: 'attack' }, 'hero')
    kill.dispatch(killed.state, killed.summary)
    expect(kill.el('board-wrap').children.some((child) => child.textContent === '💀')).toBe(true)

    const ambush = openDungeonView('?token=t')
    const cell = findCell(1, 1, (x, y) => Math.abs(x - 1) + Math.abs(y - 1) === 1 && !dungeonProbe.trapAt(1, 1, x, y))
    const armed = tweak(start(1), (draft) => {
      draft.tiles[`${cell.x},${cell.y}`] = { kind: 'floor', monster: { name: '史莱姆', hp: 9, maxHp: 9, atk: 3 } }
    })
    ambush.dispatch(armed, '')
    const met = apply(armed, { type: 'move', dir: cell.x === 2 ? 'right' : 'down' }, 'hero')
    ambush.dispatch(met.state, met.summary)
    const dangerToast = ambush.el('dc-toast-stack').children.find((child) => child.textContent === met.summary)
    expect(dangerToast).toBeDefined()
    expect(dangerToast!.className).toContain('danger')

    const finale = openDungeonView('?token=t')
    const bossFloor = tweak(start(1), (draft) => {
      draft.depth = 3
      draft.tiles = { '1,1': { kind: 'stairs', monster: { name: '炎魔君王', hp: 1, maxHp: 32, atk: 5, boss: true } } }
    })
    finale.dispatch(bossFloor, '')
    const won = apply(bossFloor, { type: 'attack' }, 'hero')
    finale.dispatch(won.state, won.summary)
    const finaleToast = finale.el('dc-toast-stack').children.find((child) => child.textContent === won.summary)
    expect(finaleToast).toBeDefined()
    expect(finaleToast!.className).toContain('finale')
  })
})

