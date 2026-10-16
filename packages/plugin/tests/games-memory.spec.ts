/**
 * 内置记忆翻牌对战（dsh-soulmojito.memory-match，提案 0018 §4.1 内置序列第六款）
 * ——引擎契约与规则面测试。
 *
 * 【蓝军声明】断言严格落在契约面上，不发明契约外断言；**布局派生不复刻洗牌
 * 实现**——一切牌面结论只经引擎输出反推（describe/summary 里的牌面文本），
 * 覆盖范围：清单/形状/视图自包含与 view 管线/静态锚点/createGame/布局不定式
 * （8 图案各恰两张）/配对与失配语义/终局两态（8–0 与平局）/防偷看不变式
 * （未翻开牌面不进 state）/非法动作全家族/确定性/建议集/describe/源码扫描/
 * 尺寸/烟测五关/真实 service 端到端（记忆机器人只用观察到的牌面决策）。
 *
 * 契约面（v1）：
 * - 清单：id 'dsh-soulmojito.memory-match'、name '记忆翻牌对战'、version '1.0.0'、
 *   players {min:2,max:2,roles:['red','blue']}、turnBased、engines 缺席；
 * - state（JSON-safe、顶层 turn）：{ turn, seed, board: (null|图案)[16]、
 *   scores{red,blue}、ply、lastFlip{cards,faces,match}|null、finished, winner }；
 * - 一手 {type:'flip', a, b}（0-15 行主序牌位，列 A-D、行 1-4）同手结算：
 *   配对成功 → +1 分、两张定格、turn 不变（同一方继续）；失配 → 翻回、换对方；
 * - 终局：8 对配完比总分（高者胜、同分平局 winner null）；终局后不可行动；
 * - 未翻开的牌面不物化进 state（只由 seed 派生）——「防偷看不变式」用例钉死；
 * - 确定性：同 state+action 两次 deep-equal、不改入参；源码禁随机/时间源
 *   （seed 缺省走 node:crypto）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryMatchEngine, manifest, viewHtml } from '../src/games/builtin/memory.js'
import { openGamesService } from '../src/games/service.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, jsonSizeOf, smokeTestGameEngine } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Side = 'red' | 'blue'

interface MemoryStateShape {
  turn: Side
  seed: number
  board: (string | null)[]
  scores: { red: number; blue: number }
  ply: number
  lastFlip: { cards: [number, number]; faces: [string, string]; match: boolean } | null
  finished: boolean
  winner: Side | null
}

interface FlipAction {
  type: 'flip'
  a: number
  b: number
}

interface MemoryApplyResult {
  state: MemoryStateShape
  events: string[]
  finished: boolean
  winner: Side | null
  summary: string
}

/** 引擎形状（以被测 v1 契约为准的本地视图，刻意不复用实现类型）。 */
interface MemoryEngineShape {
  createGame(options?: unknown): { state: MemoryStateShape }
  legalActions(state: MemoryStateShape): FlipAction[]
  applyAction(state: MemoryStateShape, action: unknown, actor: string): MemoryApplyResult
  describe(state: MemoryStateShape, actor: string, action: unknown): string
}

const engine = memoryMatchEngine as unknown as MemoryEngineShape

const home = mkdtempSync(join(tmpdir(), 'games-memory-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const ENGINE_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'games', 'builtin', 'memory.ts'), 'utf8')

/* ------------------------- 蓝军工具：只从输出反推牌面 ------------------------- */

const CARDS = 16
const FLIP_TEXT = /翻开 ([A-D][1-4])（(.+?)）与 ([A-D][1-4])（(.+?)）：/

/** 牌位名 'C2' → 行主序下标（列 A-D、行 1-4）。 */
function nameToIndex(name: string): number {
  return (Number(name[1]) - 1) * 4 + 'ABCD'.indexOf(name[0]!)
}

/** 从任意叙述/摘要文本里取一手翻牌的牌位与两面（parseBoardCoord 归一后的输出面）。 */
function parseFlip(text: string): { a: number; b: number; fa: string; fb: string } | null {
  const found = FLIP_TEXT.exec(text)
  if (found === null) return null
  return { a: nameToIndex(found[1]!), b: nameToIndex(found[3]!), fa: found[2]!, fb: found[4]! }
}

/** 未翻开的牌位集合。 */
function coveredOf(state: MemoryStateShape): Set<number> {
  const covered = new Set<number>()
  for (let index = 0; index < state.board.length; index += 1) {
    if (state.board[index] === null) covered.add(index)
  }
  return covered
}

/** 在覆盖集里找一对图案相同（配对可成）的牌位。 */
function findMatchingPair(layout: string[], covered: Set<number>): [number, number] | null {
  for (let i = 0; i < CARDS; i += 1) {
    if (!covered.has(i)) continue
    for (let j = i + 1; j < CARDS; j += 1) {
      if (covered.has(j) && layout[i] === layout[j]) return [i, j]
    }
  }
  return null
}

/** 在覆盖集里找一对图案不同（必然失配）的牌位。 */
function findMismatchPair(layout: string[], covered: Set<number>): [number, number] | null {
  for (let i = 0; i < CARDS; i += 1) {
    if (!covered.has(i)) continue
    for (let j = i + 1; j < CARDS; j += 1) {
      if (covered.has(j) && layout[i] !== layout[j]) return [i, j]
    }
  }
  return null
}

/**
 * 布局派生（不复刻洗牌）：对固定 seed 的真实对局按 (0,1)(2,3)…(14,15) 翻满
 * 8 手（每张牌恰被翻一次、终局提前时盘面必全翻开），从 summary 里读回 16 张
 * 图案。这是「蓝军」的观测面——后续一切配对/失配断言都以此为准。
 */
function deriveLayout(seed: number): string[] {
  let state = engine.createGame({ seed }).state
  const layout: Array<string | null> = Array.from({ length: CARDS }, () => null)
  for (let pair = 0; pair < CARDS / 2; pair += 1) {
    if (state.finished) break
    const a = pair * 2
    const b = pair * 2 + 1
    if (state.board[a] !== null || state.board[b] !== null) continue
    const result = engine.applyAction(state, { type: 'flip', a, b }, state.turn)
    const observed = parseFlip(result.summary)
    expect(observed, `seed ${seed} 第 ${pair} 手 summary 应有牌位与两面: ${result.summary}`).not.toBeNull()
    layout[observed!.a] = observed!.fa
    layout[observed!.b] = observed!.fb
    state = result.state
  }
  for (let index = 0; index < CARDS; index += 1) {
    if (layout[index] === null && state.board[index] !== null) layout[index] = state.board[index]
  }
  return layout.map((face, index) => {
    expect(face, `seed ${seed} 的牌位 ${index} 未能观测到牌面`).not.toBeNull()
    return face!
  })
}

/* ------------------------------- 清单与形状 ------------------------------- */

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 red/blue、engines 缺席', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-soulmojito.memory-match')
    expect(manifest.name).toBe('记忆翻牌对战')
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    expect(manifest.engines).toBeUndefined()
    expect(manifest.actionVocabulary).toContain('flip')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(memoryMatchEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-soulmojito:game-state')
    expect(viewHtml).toContain('dsh-soulmojito:game-action')
    expect(viewHtml).toContain('data-game="dsh-soulmojito.memory-match"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(viewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.memory-match"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })

  it('视图静态锚点：翻回预览/配对定格/两段点击/比分板/结果条/静态预览局面', () => {
    expect(viewHtml).toContain('.card.peek')
    expect(viewHtml).toContain('.card.matched')
    expect(viewHtml).toContain('PEEK_MS')
    expect(viewHtml).toContain('selected')
    expect(viewHtml).toContain('onPick')
    expect(viewHtml).toContain('score-red')
    expect(viewHtml).toContain('owner-tag')
    expect(viewHtml).toContain('result-strip')
    expect(viewHtml).toContain('PREVIEW_STATE')
    expect(viewHtml).not.toContain('class="overlay')
  })

  it('引擎源码不含随机/时间源（确定性硬约束，seed 缺省走 node:crypto）', () => {
    expect(ENGINE_SOURCE).not.toMatch(/Math\.random|Date\.now/)
    expect(ENGINE_SOURCE).toContain('randomInt')
    expect(ENGINE_SOURCE).toContain("'node:crypto'")
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(memoryMatchEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

/* -------------------------------- createGame -------------------------------- */

describe('createGame 开局（§3.2）', () => {
  it('固定 seed 开局：16 张全背面、比分 0–0、红方先手、ply 0、JSON-safe', () => {
    const { state } = engine.createGame({ seed: 7 })
    expect(state.seed).toBe(7)
    expect(state.board).toHaveLength(CARDS)
    expect(state.board.every((cell) => cell === null)).toBe(true)
    expect(state.scores).toEqual({ red: 0, blue: 0 })
    expect(state.turn).toBe('red')
    expect(state.ply).toBe(0)
    expect(state.lastFlip).toBeNull()
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    expect(currentRoleOf(state, manifest.players.roles)).toBe('red')
  })

  it('同 seed 两次 createGame deep-equal（布局确定性从开局就成立）', () => {
    expect(engine.createGame({ seed: 42 })).toEqual(engine.createGame({ seed: 42 }))
  })

  it('缺省 seed（crypto 随机）：无 options 与空对象两路都出合法开局', () => {
    for (const options of [undefined, {}]) {
      const { state } = engine.createGame(options)
      expect(state.board.every((cell) => cell === null)).toBe(true)
      expect(engine.legalActions(state).length).toBeGreaterThan(0)
    }
  })

  it('seed 扫描 1..40：每个开局都满足初始不变式（建议集恰 64、全为覆盖对）', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { state } = engine.createGame({ seed })
      const suggestions = engine.legalActions(state)
      expect(suggestions).toHaveLength(64)
      for (const action of suggestions) {
        expect(action.type).toBe('flip')
        expect(action.a).toBeLessThan(action.b)
        expect(state.board[action.a]).toBeNull()
        expect(state.board[action.b]).toBeNull()
      }
    }
  })
})

/* --------------------- 布局派生与牌面一致性（蓝军观测面） --------------------- */

describe('布局派生与牌面一致性（只经引擎输出反推）', () => {
  it('派生 16 张全牌面：8 种图案各恰两张、无缺格', () => {
    for (const seed of [1, 3, 2026, 65535]) {
      const layout = deriveLayout(seed)
      expect(new Set(layout).size).toBe(8)
      const counts = new Map<string, number>()
      for (const face of layout) counts.set(face, (counts.get(face) ?? 0) + 1)
      for (const count of counts.values()) expect(count).toBe(2)
    }
  })

  it('同 seed 两个独立对局布局一致（重启续局语义：state 只带 seed 即可重建）', () => {
    expect(deriveLayout(99)).toEqual(deriveLayout(99))
  })

  it('配对判定与派生一致：已知对翻出即配成、已知非对翻出即散', () => {
    const seed = 21
    const layout = deriveLayout(seed)
    const fresh = engine.createGame({ seed }).state
    const pair = findMatchingPair(layout, coveredOf(fresh))!
    const matched = engine.applyAction(fresh, { type: 'flip', a: pair[0], b: pair[1] }, 'red')
    expect(matched.finished).toBe(false)
    expect((matched.state as MemoryStateShape).board[pair[0]]).toBe(layout[pair[0]])
    expect((matched.state as MemoryStateShape).board[pair[1]]).toBe(layout[pair[1]])
    expect(matched.summary).toContain('配对成功')

    const fresh2 = engine.createGame({ seed }).state
    const bad = findMismatchPair(layout, coveredOf(fresh2))!
    const missed = engine.applyAction(fresh2, { type: 'flip', a: bad[0], b: bad[1] }, 'red')
    const next = missed.state as MemoryStateShape
    expect(next.board[bad[0]]).toBeNull()
    expect(next.board[bad[1]]).toBeNull()
    expect(missed.summary).toContain('不是一对')
  })

  it('防偷看不变式：未翻开的牌面不出现在 state 任何字段（只由 seed 派生）', () => {
    const seed = 11
    const layout = deriveLayout(seed)
    const faces = new Set(layout)

    // 开局：全背面——16 张图案一个都不在 state 的序列化文本里。
    const fresh = engine.createGame({ seed }).state
    const freshText = JSON.stringify(fresh)
    for (const face of faces) expect(freshText).not.toContain(face)

    // 失配一手后：只有这一手的两张面物化（lastFlip——双方都看见过），其余仍不出现。
    const pair = findMismatchPair(layout, coveredOf(fresh))!
    const after = engine.applyAction(fresh, { type: 'flip', a: pair[0], b: pair[1] }, 'red').state as MemoryStateShape
    const afterText = JSON.stringify(after)
    expect(afterText).toContain(layout[pair[0]]!)
    expect(afterText).toContain(layout[pair[1]]!)
    const flippedFaces = new Set([layout[pair[0]], layout[pair[1]]])
    for (const face of faces) {
      if (!flippedFaces.has(face)) expect(afterText).not.toContain(face)
    }
  })
})

/* ----------------------------- 配对与失配语义 ----------------------------- */

describe('配对与失配（同手结算）', () => {
  it('配对成功：得 1 分、两张定格、turn 不变（同一方继续）、lastFlip 记录、describe 带比分', () => {
    const seed = 33
    const layout = deriveLayout(seed)
    const state = engine.createGame({ seed }).state
    const pair = findMatchingPair(layout, coveredOf(state))!
    const result = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, 'red')
    const next = result.state as MemoryStateShape
    expect(next.scores).toEqual({ red: 1, blue: 0 })
    expect(next.turn).toBe('red')
    expect(next.ply).toBe(1)
    expect(next.lastFlip).toEqual({ cards: [pair[0], pair[1]], faces: [layout[pair[0]], layout[pair[1]]], match: true })
    expect(result.events).toHaveLength(1)
    expect(result.summary).toContain('配对成功')
    expect(result.summary).toContain('比分 红方 1–蓝方 0')
    const text = engine.describe(state, 'red', { type: 'flip', a: pair[0], b: pair[1] })
    expect(text).toContain('配对成功')
    expect(text).toContain('得 1 分')
    expect(text).toContain('继续翻牌')
  })

  it('失配：不加分、两张翻回（board 保持 null）、换对方、lastFlip 留存两面', () => {
    const seed = 34
    const layout = deriveLayout(seed)
    const state = engine.createGame({ seed }).state
    const pair = findMismatchPair(layout, coveredOf(state))!
    const result = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, 'red')
    const next = result.state as MemoryStateShape
    expect(next.scores).toEqual({ red: 0, blue: 0 })
    expect(next.turn).toBe('blue')
    expect(next.board[pair[0]]).toBeNull()
    expect(next.board[pair[1]]).toBeNull()
    expect(next.lastFlip).toEqual({ cards: [pair[0], pair[1]], faces: [layout[pair[0]], layout[pair[1]]], match: false })
    expect(result.summary).toContain('不是一对')
    expect(result.summary).toContain('轮到蓝方')
  })

  it('describe 的「轮到X」与 apply 结果 turn 一致（失配两方向）', () => {
    const seed = 35
    const layout = deriveLayout(seed)
    const fresh = engine.createGame({ seed }).state
    const pair = findMismatchPair(layout, coveredOf(fresh))!
    const described = engine.describe(fresh, 'red', { type: 'flip', a: pair[0], b: pair[1] })
    const next = engine.applyAction(fresh, { type: 'flip', a: pair[0], b: pair[1] }, 'red').state as MemoryStateShape
    expect(described).toContain(`轮到${next.turn === 'blue' ? '蓝方' : '红方'}`)
    // 反向：换蓝方先手（手工局面）再失配，轮到红方。
    const blueTurn: MemoryStateShape = { ...engine.createGame({ seed }).state, turn: 'blue' }
    const describedBlue = engine.describe(blueTurn, 'blue', { type: 'flip', a: pair[0], b: pair[1] })
    const nextBlue = engine.applyAction(blueTurn, { type: 'flip', a: pair[0], b: pair[1] }, 'blue').state as MemoryStateShape
    expect(describedBlue).toContain('轮到红方')
    expect(nextBlue.turn).toBe('red')
  })

  it('已配对的牌位不能再翻（中文报错含 已配对）', () => {
    const seed = 36
    const layout = deriveLayout(seed)
    const state = engine.createGame({ seed }).state
    const pair = findMatchingPair(layout, coveredOf(state))!
    const after = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, 'red').state as MemoryStateShape
    const free = [...coveredOf(after)][0]!
    expect(() => engine.applyAction(after, { type: 'flip', a: pair[0], b: free }, after.turn)).toThrow('已配对翻开')
    expect(() => engine.applyAction(after, { type: 'flip', a: free, b: pair[1] }, after.turn)).toThrow('已配对翻开')
  })
})

/* ---------------------------------- 终局 ---------------------------------- */

describe('终局（8 对配完比总分）', () => {
  it('全知策略：红方一路配到底 8–0 红方胜（ply=8、盘面全翻开、turn 停在最后行动方）', () => {
    const seed = 20261015
    const layout = deriveLayout(seed)
    let state = engine.createGame({ seed }).state
    let last: MemoryApplyResult | null = null
    let guard = 0
    while (!state.finished && guard < 20) {
      guard += 1
      const pair = findMatchingPair(layout, coveredOf(state))!
      expect(pair, '全知策略下每一手都能找到剩余对').not.toBeNull()
      last = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, state.turn)
      state = last.state
    }
    expect(state.finished).toBe(true)
    expect(state.scores).toEqual({ red: 8, blue: 0 })
    expect(state.winner).toBe('red')
    expect(state.ply).toBe(8)
    expect(state.turn).toBe('red')
    expect(state.board.every((cell) => cell !== null)).toBe(true)
    expect(last!.summary).toContain('对局结束')
    expect(last!.summary).toContain('红方胜')
    // 终局后不能再行动。
    expect(() => engine.applyAction(state, { type: 'flip', a: 0, b: 1 }, 'red')).toThrow('对局已结束')
  })

  it('手工局面：4–3 落后方配成最后一对 → 4–4 平局（winner null、summary 含 平局）', () => {
    const seed = 77
    const layout = deriveLayout(seed)
    const all = new Set(Array.from({ length: CARDS }, (_, index) => index))
    const pair = findMatchingPair(layout, all)!
    const crafted: MemoryStateShape = {
      turn: 'blue',
      seed,
      board: layout.map((face, index) => (index === pair[0] || index === pair[1] ? null : face)),
      scores: { red: 4, blue: 3 },
      ply: 14,
      lastFlip: null,
      finished: false,
      winner: null,
    }
    expect(JSON.parse(JSON.stringify(crafted))).toEqual(crafted)
    const result = engine.applyAction(crafted, { type: 'flip', a: pair[0], b: pair[1] }, 'blue')
    expect(result.finished).toBe(true)
    expect(result.winner).toBeNull()
    expect((result.state as MemoryStateShape).scores).toEqual({ red: 4, blue: 4 })
    expect((result.state as MemoryStateShape).board.every((cell) => cell !== null)).toBe(true)
    expect(result.summary).toContain('对局结束')
    expect(result.summary).toContain('平局')
  })
})

/* ------------------------------- 确定性（§3.2） ------------------------------- */

describe('确定性（§3.2 硬约束）', () => {
  it('同 state 同 action 两次 apply deep-equal，入参快照不变', () => {
    const seed = 55
    const state = engine.createGame({ seed }).state
    const snapshot = structuredClone(state)
    const first = engine.applyAction(state, { type: 'flip', a: 0, b: 1 }, 'red')
    const second = engine.applyAction(state, { type: 'flip', a: 0, b: 1 }, 'red')
    expect(first).toEqual(second)
    expect(state).toEqual(snapshot)
  })

  it('整局重放两次 deep-equal（同 seed 同脚本到终局）', () => {
    const seed = 88
    const play = () => {
      const layout = deriveLayout(seed)
      let state = engine.createGame({ seed }).state
      let guard = 0
      while (!state.finished && guard < 20) {
        guard += 1
        const pair = findMatchingPair(layout, coveredOf(state))!
        state = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, state.turn).state
      }
      return state
    }
    expect(play()).toEqual(play())
  })
})

/* ------------------------------ 建议集（§3.2） ------------------------------ */

describe('legalActions 建议集（§3.2）', () => {
  it('开局 120 对截断至 64：全为覆盖对、a<b、覆盖全部 16 个牌位、两次调用 deep-equal', () => {
    const state = engine.createGame({ seed: 5 }).state
    const suggestions = engine.legalActions(state)
    expect(suggestions).toHaveLength(64)
    expect(engine.legalActions(state)).toEqual(suggestions)
    const touched = new Set<number>()
    for (const action of suggestions) {
      expect(action.type).toBe('flip')
      expect(action.a).toBeLessThan(action.b)
      expect(state.board[action.a]).toBeNull()
      expect(state.board[action.b]).toBeNull()
      touched.add(action.a)
      touched.add(action.b)
    }
    expect(touched.size).toBe(CARDS)
  })

  it('中局（6 张未翻开手工局面）：恰 C(6,2)=15 对全集；终局空数组', () => {
    const seed = 66
    const layout = deriveLayout(seed)
    const covered = new Set([3, 4, 8, 11, 12, 15])
    const crafted: MemoryStateShape = {
      turn: 'red',
      seed,
      board: layout.map((face, index) => (covered.has(index) ? null : face)),
      scores: { red: 5, blue: 0 },
      ply: 11,
      lastFlip: null,
      finished: false,
      winner: null,
    }
    const suggestions = engine.legalActions(crafted)
    expect(suggestions).toHaveLength(15)
    const expected: string[] = []
    for (const a of covered) {
      for (const b of covered) {
        if (a < b) expected.push(`${a},${b}`)
      }
    }
    expect(suggestions.map((action) => `${action.a},${action.b}`).sort()).toEqual(expected.sort())

    const finished: MemoryStateShape = { ...crafted, board: layout.slice(), scores: { red: 8, blue: 0 }, finished: true, winner: 'red' }
    expect(engine.legalActions(finished)).toEqual([])
  })

  it('建议集不是合法性依据：不在建议集内的覆盖对仍可执行', () => {
    const seed = 9
    const state = engine.createGame({ seed }).state
    const suggestions = engine.legalActions(state)
    const inSet = new Set(suggestions.map((action) => `${action.a},${action.b}`))
    let outside: [number, number] | null = null
    for (let a = 0; a < CARDS && outside === null; a += 1) {
      for (let b = a + 1; b < CARDS && outside === null; b += 1) {
        if (!inSet.has(`${a},${b}`)) outside = [a, b]
      }
    }
    expect(outside, '开局 120 对中必有建议集外的对').not.toBeNull()
    const result = engine.applyAction(state, { type: 'flip', a: outside![0], b: outside![1] }, 'red')
    expect(result.finished).toBe(false)
    expect((result.state as MemoryStateShape).ply).toBe(1)
  })
})

/* ------------------------------ describe（§3.2） ------------------------------ */

describe('describe 叙述（§3.2）', () => {
  it('未识别回落：resign / 未知 type / 缺 type / 越界坐标 / 同张 / 已配对均含 未被本引擎识别', () => {
    const seed = 12
    const layout = deriveLayout(seed)
    const state = engine.createGame({ seed }).state
    expect(engine.describe(state, 'red', { type: 'resign' })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'jump' })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { a: 0, b: 1 })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'flip', a: 0, b: 16 })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'flip', a: 2, b: 2 })).toContain('未被本引擎识别')
    const pair = findMatchingPair(layout, coveredOf(state))!
    const after = engine.applyAction(state, { type: 'flip', a: pair[0], b: pair[1] }, 'red').state as MemoryStateShape
    expect(engine.describe(after, 'red', { type: 'flip', a: pair[0], b: [...coveredOf(after)][0]! })).toContain('未被本引擎识别')
  })

  it('坐标容错（2026-10-14 实弹）：整数的字符串形态归一执行（模型桥引号习惯）', () => {
    const seed = 13
    const layout = deriveLayout(seed)
    const state = engine.createGame({ seed }).state
    const pair = findMatchingPair(layout, coveredOf(state))!
    const viaQuotes = engine.applyAction(state, { type: 'flip', a: String(pair[0]), b: `${pair[1]}.0` }, 'red')
    expect(viaQuotes.summary).toContain('配对成功')
    expect((viaQuotes.state as MemoryStateShape).board[pair[0]]).toBe(layout[pair[0]])
    expect(engine.describe(state, 'red', { type: 'flip', a: String(pair[0]), b: String(pair[1]) })).toContain('配对成功')
  })
})

/* --------------------------- 非法动作全家族（中文抛错） --------------------------- */

describe('非法动作全家族（中文抛错）', () => {
  it('动作形状：非对象 / 缺 type / 未知 type / resign 保留动作', () => {
    const state = engine.createGame({ seed: 8 }).state
    expect(() => engine.applyAction(state, null, 'red')).toThrow('动作必须是 JSON 对象')
    expect(() => engine.applyAction(state, [1, 2], 'red')).toThrow('动作必须是 JSON 对象')
    expect(() => engine.applyAction(state, { a: 0, b: 1 }, 'red')).toThrow('动作缺少 type 字段')
    expect(() => engine.applyAction(state, { type: 'jump', a: 0, b: 1 }, 'red')).toThrow('不支持的动作类型')
    expect(() => engine.applyAction(state, { type: 'resign' }, 'red')).toThrow('不支持的动作类型')
  })

  it('角色：未知角色 / 非本方回合（两个方向）', () => {
    const state = engine.createGame({ seed: 10 }).state
    expect(() => engine.applyAction(state, { type: 'flip', a: 0, b: 1 }, 'purple')).toThrow('未知角色')
    expect(() => engine.applyAction(state, { type: 'flip', a: 0, b: 1 }, 'blue')).toThrow('现在轮到红方')
    const blueTurn: MemoryStateShape = { ...state, turn: 'blue' }
    expect(() => engine.applyAction(blueTurn, { type: 'flip', a: 0, b: 1 }, 'red')).toThrow('现在轮到蓝方')
  })

  it('坐标：缺 a / 越界 / 负值 / 小数 / 非数文本 / 同张', () => {
    const state = engine.createGame({ seed: 14 }).state
    expect(() => engine.applyAction(state, { type: 'flip', b: 1 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: 0, b: 16 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: -1, b: 1 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: 0.5, b: 1 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: '0.5', b: 1 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: 'abc', b: 1 }, 'red')).toThrow('翻牌坐标必须是')
    expect(() => engine.applyAction(state, { type: 'flip', a: 3, b: 3 }, 'red')).toThrow('不能在同一手翻开同一张牌')
  })
})

/* ---------------------------------- 尺寸 ---------------------------------- */

describe('状态尺寸（§3.2：序列化 <64KB）', () => {
  it('开局/中局/终局三态：jsonSizeOf 远小于 65536', () => {
    const seed = 15
    const fresh = engine.createGame({ seed }).state
    expect(jsonSizeOf(fresh)).toBeLessThan(65536)
    const mid = engine.applyAction(fresh, { type: 'flip', a: 0, b: 1 }, 'red').state as MemoryStateShape
    expect(jsonSizeOf(mid)).toBeLessThan(65536)
    const layout = deriveLayout(seed)
    const finished: MemoryStateShape = { ...fresh, board: layout.slice(), scores: { red: 8, blue: 0 }, finished: true, winner: 'red' }
    expect(jsonSizeOf(finished)).toBeLessThan(65536)
  })
})

/* ----------------------- 端到端会话（真实 GamesService） ----------------------- */

describe('端到端会话（真实 GamesService，开箱可玩面）', () => {
  it('记忆机器人驱动人机双路径翻完全盘：叙述/记分/终局全链路对账', async () => {
    const service = await openGamesService({ root: join(home, 'tavern'), hostVersion: '0.6.5' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-soulmojito.memory-match', character: 'Seraphina', chatId: 'mem-chat' })
      expect(session.gameId).toBe('dsh-soulmojito.memory-match')
      expect(session.players).toEqual([
        { role: 'red', owner: 'human' },
        { role: 'blue', owner: 'agent' },
      ])
      expect(session.turn).toBe('red')
      expect(view.finished).toBe(false)
      expect(view.legal.length).toBeGreaterThan(0)

      /* 机器人只看 describe 观察到的牌面做决策（不触碰 seed、不复刻洗牌）：
         1) 已知可配成的对优先；2) 否则翻一张未知面 + 任意另一张（学新信息）；
         3) 全知后剩余必为整对，规则 1 必然命中——三规则共同保证 ≤24 手终止。 */
      const memory = new Map<number, string>()
      let current = view
      let guard = 0
      while (!current.finished && guard < 80) {
        guard += 1
        const state = current.state as MemoryStateShape
        const covered = [...coveredOf(state)]
        expect(covered.length, '未终局必有可翻的牌').toBeGreaterThanOrEqual(2)
        let pair: [number, number] | null = null
        for (const a of covered) {
          for (const b of covered) {
            if (a < b && memory.get(a) !== undefined && memory.get(a) === memory.get(b)) pair = [a, b]
          }
          if (pair !== null) break
        }
        if (pair === null) {
          const unknown = covered.find((index) => memory.get(index) === undefined)!
          expect(unknown, '仍有未知面（或被规则 1 覆盖）').not.toBeUndefined()
          pair = [unknown, covered.find((index) => index !== unknown)!]
        }
        const [a, b] = pair!
        const move = current.turn === 'red'
          ? await service.humanAction(session.id, { type: 'flip', a, b })
          : await service.agentMove(session.id, { type: 'flip', a, b })
        const observed = parseFlip(move.describe)
        expect(observed, `describe 应含牌位与两面: ${move.describe}`).not.toBeNull()
        memory.set(observed!.a, observed!.fa)
        memory.set(observed!.b, observed!.fb)
        expect(move.describe).toMatch(/^(红方|蓝方)翻开 [A-D][1-4]（.+）与 [A-D][1-4]（.+）：(配对成功|不是一对)/)
        current = move.view
      }
      expect(current.finished, 'guard 80 内必须终局').toBe(true)
      expect(current.legal).toEqual([])
      expect(current.summary).toContain('对局结束')

      const settled = current.state as MemoryStateShape
      expect(settled.board.every((cell) => cell !== null)).toBe(true)
      expect(settled.scores.red + settled.scores.blue).toBe(8)
      const expectedWinner = settled.scores.red > settled.scores.blue ? 'red'
        : settled.scores.blue > settled.scores.red ? 'blue' : null
      expect(settled.winner).toBe(expectedWinner)
      // 机器人记忆与终局盘面逐张一致（describe 与 board 同一事实来源的回环对账）。
      expect(memory.size).toBe(CARDS)
      for (let index = 0; index < settled.board.length; index += 1) {
        expect(settled.board[index]).toBe(memory.get(index))
      }
    } finally {
      service.dispose()
    }
  })
})
