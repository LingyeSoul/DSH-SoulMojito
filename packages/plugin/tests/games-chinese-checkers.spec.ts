/**
 * 内置中国跳棋（dsh-soulmojito.chinese-checkers，提案 0018 §4.1 内置序列第九款）
 * ——引擎契约与规则面测试。
 *
 * 【蓝军声明】断言严格落在契约面上，不发明契约外断言；星形几何结论只经探针
 * （chineseCheckersProbe 的纯几何面：行洞数/坐标/邻接/营盘归属）与引擎输出
 * 反推，不复刻引擎的坐标表实现；受控局面用「空白棋盘 + 探针坐标落子」构造
 * （引擎把 state 当数据读，既有各款同款纪律）。
 *
 * 契约面（v1）：
 * - 清单：id 'dsh-soulmojito.chinese-checkers'、name '中国跳棋'、version '1.0.0'、
 *   players {min:2,max:2,roles:['red','blue']}、turnBased、engines 缺席；
 * - 盘面：标准 121 洞六角星（17 行，行洞数 1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1）、
 *   红方 10 子起于顶营（行 1-4）、蓝方 10 子起于底营（行 14-17），红先；
 * - 一手 {type:'move', from:[行,列], to:[行,列]}（0 基；叙述用 1 基「行-列」名）：
 *   走到相邻空位，或跳过紧邻的任意一颗弹珠（不分敌我）落于正后方空位——
 *   可连跳、连跳中可拐弯，同一手不重复落点（含不得落回起点）；无吃子；
 * - 终局：先把自己十颗全部搬进对方营盘的获胜；对方无任何合法着法（困毙）
 *   同样本方胜（军棋/象棋同款裁决；真实可达性未证——封锁单方理论下界 11 子
 *   > 10 子，判定分支保留为总函数并由构造性夹具锁定，见决策文档边界节）；
 * - 确定性：全文无随机/时间源（无 seed——本款零随机）；同 state+action 两次
 *   apply deep-equal、不改入参；
 * - 建议集 ≤64（真实开局 14 手、密集中腹局面约 60——64 上限用 12 子构造夹具
 *   锁定截断主序），不是合法性依据。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chineseCheckersEngine, chineseCheckersProbe, manifest, viewHtml } from '../src/games/builtin/chinese-checkers.js'
import { openGamesService } from '../src/games/service.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, jsonSizeOf, smokeTestGameEngine } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Role = 'red' | 'blue'

interface StateShape {
  turn: Role
  board: number[][]
  ply: number
  lastMove: { from: [number, number]; to: [number, number] } | null
  finished: boolean
  winner: Role | null
}

interface MoveAction {
  type: 'move'
  from: [number, number]
  to: [number, number]
}

/** 引擎形状（以被测 v1 契约为准的本地视图，刻意不复用实现类型）。 */
interface EngineShape {
  createGame(options?: unknown): { state: StateShape }
  legalActions(state: StateShape): MoveAction[]
  applyAction(state: StateShape, action: unknown, actor: string): {
    state: StateShape
    events: string[]
    finished: boolean
    winner: Role | null
    summary: string
  }
  describe(state: StateShape, actor: string, action: unknown): string
}

const engine = chineseCheckersEngine as unknown as EngineShape
const probe = chineseCheckersProbe

const home = mkdtempSync(join(tmpdir(), 'games-chinese-checkers-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const ENGINE_SOURCE = readFileSync(
  join(import.meta.dirname, '..', 'src', 'games', 'builtin', 'chinese-checkers.ts'),
  'utf8',
)

const ROW_LENGTHS = [1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1] as const

/* ------------------------------ 构造工具（空白盘 + 探针坐标） ------------------------------ */

/** 起手空盘（清空 20 颗起手弹珠——引擎把 state 当数据读）。 */
function blank(): StateShape {
  const state = engine.createGame().state
  state.board = state.board.map((row) => row.map(() => 0))
  return state
}

function index(row: number, col: number): number {
  const found = probe.indexOf(row, col)
  if (found === null) throw new Error(`测试坐标不在盘上: [${row}, ${col}]`)
  return found
}

function place(state: StateShape, row: number, col: number, role: Role): StateShape {
  state.board[row]![col] = role === 'red' ? 1 : 2
  return state
}

function at(state: StateShape, row: number, col: number): number {
  return state.board[row]![col]!
}

/** 蓝方散布中腹（收官类夹具的陪衬面——不参与被断言的收官路线）。 */
function scatterBlue(state: StateShape): StateShape {
  for (let col = 0; col < 8; col += 1) place(state, 5, col, 'blue')
  place(state, 6, 0, 'blue'); place(state, 6, 1, 'blue')
  return state
}

/** 红方散布中腹（对称陪衬）。 */
function scatterRed(state: StateShape): StateShape {
  for (let col = 0; col < 5; col += 1) place(state, 8, col, 'red')
  for (let col = 0; col < 5; col += 1) place(state, 9, col, 'red')
  return state
}

/* ------------------------------------ 清单与形状 ------------------------------------ */

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 red/blue、engines 缺席', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-soulmojito.chinese-checkers')
    expect(manifest.name).toBe('中国跳棋')
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    expect(manifest.engines).toBeUndefined()
    expect(manifest.actionVocabulary).toContain('move')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(chineseCheckersEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-soulmojito:game-state')
    expect(viewHtml).toContain('dsh-soulmojito:game-action')
    expect(viewHtml).toContain('data-game="dsh-soulmojito.chinese-checkers"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(viewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.chinese-checkers"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })

  it('视图静态锚点：洞/弹珠/可落点/选中/营盘类名、布局注入与双态文案', () => {
    expect(viewHtml).toContain('.hole')
    expect(viewHtml).toContain('.marble')
    expect(viewHtml).toContain("'reach'")
    expect(viewHtml).toContain("'sel'")
    expect(viewHtml).toContain("'camp-red'")
    expect(viewHtml).toContain("'camp-blue'")
    expect(viewHtml).toContain('CC_LAYOUT')
    expect(viewHtml).toContain('PREVIEW')
    expect(viewHtml).toContain('轮到你')
    expect(viewHtml).toContain('等待 AI 落子')
    expect(viewHtml).toContain('静态预览（无 token）')
  })

  it('引擎源码不含随机/时间源（本款零随机；确定性硬约束）', () => {
    expect(ENGINE_SOURCE).not.toContain('Math.random')
    expect(ENGINE_SOURCE).not.toContain('Date.now')
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(chineseCheckersEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

/* ------------------------------------ 棋盘几何（探针面） ------------------------------------ */

describe('棋盘几何（探针面）', () => {
  it('121 洞、17 行、行洞数与标准星形逐行一致、坐标可往返', () => {
    expect(probe.holeCount).toBe(121)
    expect(probe.rowLengths).toEqual([...ROW_LENGTHS])
    let sum = 0
    for (const length of probe.rowLengths) sum += length
    expect(sum).toBe(121)
    for (let row = 0; row < ROW_LENGTHS.length; row += 1) {
      for (let col = 0; col < ROW_LENGTHS[row]!; col += 1) {
        expect(probe.coordOf(index(row, col))).toEqual({ row, col })
      }
    }
    expect(probe.indexOf(-1, 0)).toBeNull()
    expect(probe.indexOf(17, 0)).toBeNull()
    expect(probe.indexOf(0, 1)).toBeNull() // 顶行只有 1 洞
    expect(probe.indexOf(8, 9)).toBeNull() // 中央行只有 9 洞
  })

  it('营盘：顶营 10 洞（行 1-4）、底营 10 洞（行 14-17），其余为盘心', () => {
    const top: number[] = []
    const bottom: number[] = []
    for (let hole = 0; hole < probe.holeCount; hole += 1) {
      const camp = probe.campOf(hole)
      if (camp === 'top') top.push(hole)
      if (camp === 'bottom') bottom.push(hole)
    }
    expect(top).toHaveLength(10)
    expect(bottom).toHaveLength(10)
    expect(probe.campOf(index(0, 0))).toBe('top')
    expect(probe.campOf(index(3, 3))).toBe('top')
    expect(probe.campOf(index(4, 4))).toBe(null)
    expect(probe.campOf(index(8, 4))).toBe(null)
    expect(probe.campOf(index(13, 0))).toBe('bottom')
    expect(probe.campOf(index(16, 0))).toBe('bottom')
    expect(probe.targetCampOf('red')).toBe('bottom')
    expect(probe.targetCampOf('blue')).toBe('top')
  })

  it('邻接对称、无自环、无重复；顶尖 2 邻、右尖 2 邻、盘心 6 邻', () => {
    for (let hole = 0; hole < probe.holeCount; hole += 1) {
      const neighbors = probe.neighborsOf(hole)
      expect(new Set(neighbors).size).toBe(neighbors.length)
      expect(neighbors).not.toContain(hole)
      for (const neighbor of neighbors) {
        expect(probe.neighborsOf(neighbor)).toContain(hole)
      }
    }
    expect(probe.neighborsOf(index(0, 0))).toHaveLength(2)
    expect(probe.neighborsOf(index(4, 12))).toHaveLength(2)
    expect(probe.neighborsOf(index(8, 4))).toHaveLength(6)
  })
})

/* ------------------------------------ createGame ------------------------------------ */

describe('createGame 开局（§3.2）', () => {
  it('初始态：红十子占顶营、蓝十子占底营、红先、ply 0、JSON-safe', () => {
    const { state } = engine.createGame()
    expect(state.turn).toBe('red')
    expect(state.ply).toBe(0)
    expect(state.lastMove).toBeNull()
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(state.board).toHaveLength(17)
    state.board.forEach((row, rowIndex) => {
      expect(row).toHaveLength(ROW_LENGTHS[rowIndex]!)
    })
    let reds = 0
    let blues = 0
    for (let row = 0; row < 17; row += 1) {
      for (let col = 0; col < ROW_LENGTHS[row]!; col += 1) {
        const code = at(state, row, col)
        if (code === 1) reds += 1
        if (code === 2) blues += 1
        if (code === 1) expect(probe.campOf(index(row, col))).toBe('top')
        if (code === 2) expect(probe.campOf(index(row, col))).toBe('bottom')
      }
    }
    expect(reds).toBe(10)
    expect(blues).toBe(10)
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    expect(currentRoleOf(state, manifest.players.roles)).toBe('red')
  })

  it('初始建议集恰为 14 手（后排三子跳前排 + 前排四子各两个向外空位），顺序确定', () => {
    const state = engine.createGame().state
    expect(engine.legalActions(state)).toEqual([
      { type: 'move', from: [2, 0], to: [4, 4] },
      { type: 'move', from: [2, 0], to: [4, 6] },
      { type: 'move', from: [2, 1], to: [4, 5] },
      { type: 'move', from: [2, 1], to: [4, 7] },
      { type: 'move', from: [2, 2], to: [4, 6] },
      { type: 'move', from: [2, 2], to: [4, 8] },
      { type: 'move', from: [3, 0], to: [4, 4] },
      { type: 'move', from: [3, 0], to: [4, 5] },
      { type: 'move', from: [3, 1], to: [4, 5] },
      { type: 'move', from: [3, 1], to: [4, 6] },
      { type: 'move', from: [3, 2], to: [4, 6] },
      { type: 'move', from: [3, 2], to: [4, 7] },
      { type: 'move', from: [3, 3], to: [4, 7] },
      { type: 'move', from: [3, 3], to: [4, 8] },
    ])
  })
})

/* ------------------------------------ 走子与叙述 ------------------------------------ */

describe('走子（步）与叙述（§3.2）', () => {
  it('普通一步：五字段、深拷贝不改入参、轮转蓝方、lastMove、summary/describe 带 行-列', () => {
    const state = engine.createGame().state
    const snapshot = structuredClone(state)
    const result = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red')
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    expect(at(result.state, 3, 0)).toBe(0)
    expect(at(result.state, 4, 4)).toBe(1)
    expect(result.state.turn).toBe('blue')
    expect(result.state.ply).toBe(1)
    expect(result.state.lastMove).toEqual({ from: [3, 0], to: [4, 4] })
    expect(result.finished).toBe(false)
    expect(result.summary).toBe('红方 4-1 走到 5-5')
    expect(engine.describe(state, 'red', { type: 'move', from: [3, 0], to: [4, 4] })).toBe('红方 4-1 走到 5-5')
    expect(state).toEqual(snapshot)
  })

  it('坐标容错（2026-10-14 实弹）：行列的整数字符串形态归一执行', () => {
    const state = engine.createGame().state
    const result = engine.applyAction(state, { type: 'move', from: ['3', ' 0 '], to: [4, '4.0'] }, 'red')
    expect(at(result.state, 4, 4)).toBe(1)
    expect(result.summary).toBe('红方 4-1 走到 5-5')
    expect(engine.describe(state, 'red', { type: 'move', from: ['3', '0'], to: ['4', '4'] }))
      .toBe('红方 4-1 走到 5-5')
  })
})

/* ------------------------------------ 跳与连跳 ------------------------------------ */

describe('跳与连跳（不分敌我、可拐弯、不重复落点）', () => {
  /**
   * 受控走廊：红 [0,0]＝1-1；蓝桥 [1,1]＝2-2、[2,1]＝3-2、[3,1]＝4-2。
   * 航线（拐弯连跳）：[0,0] →跳[1,1]落 [2,2] →跳[2,1]落 [2,0] →跳[3,1]落 [4,6]。
   */
  function corridor(): StateShape {
    const state = blank()
    place(state, 0, 0, 'red')
    place(state, 1, 1, 'blue')
    place(state, 2, 1, 'blue')
    place(state, 3, 1, 'blue')
    return state
  }

  it('单跳与连跳：建议集恰为「1 步 + 3 落点」、叙述带连跳步数、可执行', () => {
    const state = corridor()
    expect(engine.legalActions(state)).toEqual([
      { type: 'move', from: [0, 0], to: [1, 0] }, // 唯一空邻位（落 2-1）
      { type: 'move', from: [0, 0], to: [2, 2] }, // 单跳过 [1,1]（落 3-3）
      { type: 'move', from: [0, 0], to: [2, 0] }, // 连跳 2：再过 [2,1]（落 3-1）
      { type: 'move', from: [0, 0], to: [4, 6] }, // 连跳 3：拐弯再过 [3,1]（落 5-7）
    ])
    expect(engine.describe(state, 'red', { type: 'move', from: [0, 0], to: [2, 2] }))
      .toBe('红方 1-1 跳到 3-3（连跳 1 步）')
    expect(engine.describe(state, 'red', { type: 'move', from: [0, 0], to: [4, 6] }))
      .toBe('红方 1-1 跳到 5-7（连跳 3 步）')
    const result = engine.applyAction(state, { type: 'move', from: [0, 0], to: [4, 6] }, 'red')
    expect(at(result.state, 0, 0)).toBe(0)
    expect(at(result.state, 4, 6)).toBe(1)
    expect(result.summary).toBe('红方 1-1 跳到 5-7（连跳 3 步）')
  })

  it('不重复落点：不得落回起点、同一手落点无重复', () => {
    // 红 [8,4]＝9-5；蓝 [7,4]＝8-5：可跳 → [6,4]＝7-5；从 [6,4] 再跳应回 [8,4]——
    // 起点已访问，不在落点集内（朴素 BFS 会回环）；其余五个邻位中的蓝位不算步。
    const state = blank()
    place(state, 8, 4, 'red')
    place(state, 7, 4, 'blue')
    const suggestions = engine.legalActions(state)
    const toKeys = suggestions.map((action) => `${action.to[0]},${action.to[1]}`)
    expect(toKeys).toContain('6,4')
    expect(toKeys).not.toContain('8,4')
    expect(new Set(toKeys).size).toBe(toKeys.length)
    expect(suggestions).toHaveLength(6) // 五个空格步 + 一跳
  })

  it('跳的两道闸：桥必须被弹珠占据、落点必须为空', () => {
    const emptyBridge = blank()
    place(emptyBridge, 0, 0, 'red')
    expect(engine.legalActions(emptyBridge).every((action) => action.to[0] !== 2 || action.to[1] !== 2)).toBe(true)
    expect(() => engine.applyAction(emptyBridge, { type: 'move', from: [0, 0], to: [2, 2] }, 'red'))
      .toThrow(/不是合法的一步移动或连跳/)

    const blocked = blank()
    place(blocked, 0, 0, 'red')
    place(blocked, 1, 1, 'blue')
    place(blocked, 2, 2, 'red')
    expect(() => engine.applyAction(blocked, { type: 'move', from: [0, 0], to: [2, 2] }, 'red'))
      .toThrow(/已有弹珠/)
  })
})

/* ------------------------------------ 非法动作全家族 ------------------------------------ */

describe('非法动作全家族（中文抛错）', () => {
  it('动作形状：非对象 / 缺 type / 未知 type / resign 保留动作', () => {
    const state = engine.createGame().state
    expect(() => engine.applyAction(state, 'move', 'red')).toThrow(/JSON 对象/)
    expect(() => engine.applyAction(state, null, 'red')).toThrow(/JSON 对象/)
    expect(() => engine.applyAction(state, [1, 2], 'red')).toThrow(/JSON 对象/)
    expect(() => engine.applyAction(state, { from: [3, 0], to: [4, 4] }, 'red')).toThrow(/type/)
    expect(() => engine.applyAction(state, { type: 'jump', from: [3, 0], to: [4, 4] }, 'red')).toThrow(/jump/)
    expect(() => engine.applyAction(state, { type: 'resign' }, 'red')).toThrow(/保留动作/)
  })

  it('角色与回合：未知角色 / 非本方回合（两个方向）', () => {
    const state = engine.createGame().state
    expect(() => engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'purple')).toThrow(/red\/blue/)
    expect(() => engine.applyAction(state, { type: 'move', from: [13, 0], to: [12, 4] }, 'blue')).toThrow(/现在轮到红方/)
    const afterRed = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red').state
    expect(() => engine.applyAction(afterRed, { type: 'move', from: [3, 1], to: [4, 5] }, 'red')).toThrow(/现在轮到蓝方/)
  })

  it('坐标：形状非法 / 非整数 / 不在盘上 / 起点无子 / 终点有子 / 同点', () => {
    const state = engine.createGame().state
    const mv = (from: unknown, to: unknown) => ({ type: 'move', from, to })
    expect(() => engine.applyAction(state, mv('3,0', [4, 4]), 'red')).toThrow(/两元组/)
    expect(() => engine.applyAction(state, mv([3], [4, 4]), 'red')).toThrow(/两元组/)
    expect(() => engine.applyAction(state, mv([3.5, 0], [4, 4]), 'red')).toThrow(/整数/)
    expect(() => engine.applyAction(state, mv(['0x', 0], [4, 4]), 'red')).toThrow(/整数/)
    expect(() => engine.applyAction(state, mv([17, 0], [4, 4]), 'red')).toThrow(/不在棋盘洞位/)
    expect(() => engine.applyAction(state, mv([0, 1], [4, 4]), 'red')).toThrow(/不在棋盘洞位/)
    expect(() => engine.applyAction(state, mv([4, 4], [4, 5]), 'red')).toThrow(/没有红方的弹珠/)
    expect(() => engine.applyAction(state, mv([3, 0], [3, 1]), 'red')).toThrow(/已有弹珠/)
    expect(() => engine.applyAction(state, mv([3, 0], [3, 0]), 'red')).toThrow(/起点与终点相同/)
    expect(() => engine.applyAction(state, mv([3, 0], [8, 4]), 'red')).toThrow(/不能从 4-1 到 9-5/)
  })

  it('终局后任何动作抛错（中文），建议集空', () => {
    // 红：底营 9 洞（留 [13,3]）+ 第 10 颗在 [12,7]（邻接 [13,3]）。
    const state = blank()
    place(state, 13, 0, 'red'); place(state, 13, 1, 'red'); place(state, 13, 2, 'red')
    place(state, 14, 0, 'red'); place(state, 14, 1, 'red'); place(state, 14, 2, 'red')
    place(state, 15, 0, 'red'); place(state, 15, 1, 'red')
    place(state, 16, 0, 'red')
    place(state, 12, 7, 'red')
    const won = engine.applyAction(state, { type: 'move', from: [12, 7], to: [13, 3] }, 'red')
    expect(won.finished).toBe(true)
    expect(won.winner).toBe('red')
    expect(engine.legalActions(won.state)).toEqual([])
    expect(() => engine.applyAction(won.state, { type: 'move', from: [13, 1], to: [13, 2] }, 'red')).toThrow(/对局已结束/)
  })
})

/* ------------------------------------ 胜利与困毙 ------------------------------------ */

describe('胜利（先填满对方营盘）与困毙（对方无棋可走）', () => {
  it('红方走满底营即胜：winner/summary/终局建议集空', () => {
    // 红：底营 9 洞（留 [13,0]）+ 第 10 颗在 [12,5]（邻接 [13,0]）；蓝方中腹陪衬。
    const state = blank()
    place(state, 13, 1, 'red'); place(state, 13, 2, 'red'); place(state, 13, 3, 'red')
    place(state, 14, 0, 'red'); place(state, 14, 1, 'red'); place(state, 14, 2, 'red')
    place(state, 15, 0, 'red'); place(state, 15, 1, 'red')
    place(state, 16, 0, 'red')
    place(state, 12, 5, 'red')
    scatterBlue(state)
    const result = engine.applyAction(state, { type: 'move', from: [12, 5], to: [13, 0] }, 'red')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect(result.summary).toContain('红方 13-6 走到 14-1')
    expect(result.summary).toContain('红方胜')
    expect(engine.legalActions(result.state)).toEqual([])
  })

  it('蓝方对称：走满顶营即胜（目标营盘按角色对号）', () => {
    // 蓝：顶营 9 洞（留 [3,3]）+ 第 10 颗在 [4,7]（邻接 [3,3]）；红方中腹陪衬。
    const state = blank()
    place(state, 0, 0, 'blue')
    place(state, 1, 0, 'blue'); place(state, 1, 1, 'blue')
    place(state, 2, 0, 'blue'); place(state, 2, 1, 'blue'); place(state, 2, 2, 'blue')
    place(state, 3, 0, 'blue'); place(state, 3, 1, 'blue'); place(state, 3, 2, 'blue')
    place(state, 4, 7, 'blue')
    scatterRed(state)
    state.turn = 'blue'
    const result = engine.applyAction(state, { type: 'move', from: [4, 7], to: [3, 3] }, 'blue')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('blue')
    expect(result.summary).toContain('蓝方 5-8 走到 4-4')
    expect(result.summary).toContain('蓝方胜')
  })

  it('登错营盘不算胜（红方棋子全在顶营不判红胜）', () => {
    const state = engine.createGame().state
    const result = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red')
    expect(result.finished).toBe(false)
  })

  it('困毙（构造性夹具）：对方轮到走子而无任何合法着法 → 本方胜', () => {
    // 红方十子满占顶营；蓝方十一子封死红方全部突围面（5 个步位 + 6 个落点），
    // 另有第十二子自由可动。该封锁真实可达性未证（理论下界 11 子 > 蓝方 10 子
    // ——见决策文档边界节）；本夹具直接构造状态锁定判定分支（引擎把 state 当数据读）。
    const state = blank()
    place(state, 0, 0, 'red')
    place(state, 1, 0, 'red'); place(state, 1, 1, 'red')
    place(state, 2, 0, 'red'); place(state, 2, 1, 'red'); place(state, 2, 2, 'red')
    place(state, 3, 0, 'red'); place(state, 3, 1, 'red'); place(state, 3, 2, 'red'); place(state, 3, 3, 'red')
    for (let col = 4; col <= 8; col += 1) place(state, 4, col, 'blue')
    for (let col = 3; col <= 8; col += 1) place(state, 5, col, 'blue')
    place(state, 16, 0, 'blue')
    const redTurn: StateShape = { ...structuredClone(state), turn: 'red' }
    expect(engine.legalActions(redTurn)).toEqual([])
    state.turn = 'blue'
    const result = engine.applyAction(state, { type: 'move', from: [16, 0], to: [15, 0] }, 'blue')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('blue')
    expect(result.summary).toContain('无棋可走')
    expect(result.summary).toContain('蓝方胜')
  })
})

/* ------------------------------------ 建议集 ------------------------------------ */

describe('legalActions 建议集（§3.2）', () => {
  /** 密集中腹簇：红十子（第 8 行全 9 洞 + [7,4]）——真实子数下的密集建议面。 */
  function cluster(): StateShape {
    const state = blank()
    for (let col = 0; col < 9; col += 1) place(state, 8, col, 'red')
    place(state, 7, 4, 'red')
    return state
  }

  /**
   * 截断夹具（构造性，非真实子数）：12 颗红子两两相隔 ≥2、六邻全在盘内——
   * 候选恰 12×6=72 手，超过 64 上限；枚举主序下第 12 颗 [8,2] 的全部着法被
   * 截断在外（真实 20 子局面的建议上限约 60，截断通道由本夹具锁定）。
   * 另置一颗蓝子于底角：保证红方落子后蓝方仍有棋可走，不触发困毙收局。
   */
  function crowd(): StateShape {
    const state = blank()
    const cells: Array<[number, number]> = [
      [2, 1], [4, 5], [4, 7], [5, 1], [5, 3], [5, 8], [5, 10], [6, 4], [6, 6], [7, 1], [7, 7], [8, 2],
    ]
    for (const [row, col] of cells) place(state, row, col, 'red')
    place(state, 16, 0, 'blue')
    return state
  }

  it('上限截断恰 64：12×6 候选按主序保留前 64、确定性、被截断着法仍可执行', () => {
    const state = crowd()
    expect(probe.neighborsOf(index(8, 2))).toHaveLength(6)
    const first = engine.legalActions(state)
    const second = engine.legalActions(state)
    expect(first).toEqual(second)
    expect(first).toHaveLength(64)
    for (const action of first) {
      expect(action.type).toBe('move')
      expect(at(state, action.from[0], action.from[1])).toBe(1)
      expect(at(state, action.to[0], action.to[1])).toBe(0)
    }
    // 主序末位 [8,2] 的六个步出着法全部被截断在外——但仍可执行（不是合法性依据）。
    expect(first.some((action) => action.from[0] === 8 && action.from[1] === 2)).toBe(false)
    const neighbor = probe.neighborsOf(index(8, 2))[0]!
    const target = probe.coordOf(neighbor)
    const outside = engine.applyAction(state, { type: 'move', from: [8, 2], to: [target.row, target.col] }, 'red')
    expect(at(outside.state, target.row, target.col)).toBe(1)
    expect(outside.finished).toBe(false)
  })

  it('建议集有界且全部可执行（逐个 apply 不抛错）；开局 14、终局空数组', () => {
    const state = cluster()
    const suggestions = engine.legalActions(state)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.length).toBeLessThanOrEqual(64)
    for (const action of suggestions) {
      expect(() => engine.applyAction(state, action, 'red')).not.toThrow()
    }
    const fresh = engine.createGame().state
    expect(engine.legalActions(fresh)).toHaveLength(14)
    const finished = blank()
    expect(engine.legalActions({ ...finished, finished: true, winner: 'red', turn: 'red' })).toEqual([])
  })
})

/* ------------------------------------ describe 与尺寸 ------------------------------------ */

describe('describe 叙述（§3.2）与状态尺寸', () => {
  it('未识别回落：resign / 未知 type / 缺 type / 非对象 / 越界 / 起点空 / 非本方子 / 不可达', () => {
    const state = engine.createGame().state
    expect(engine.describe(state, 'red', { type: 'resign' })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'jump', from: [3, 0], to: [4, 4] })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { from: [3, 0], to: [4, 4] })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', null)).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'move', from: [17, 0], to: [4, 4] })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'move', from: [8, 4], to: [4, 4] })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'blue', { type: 'move', from: [3, 0], to: [4, 4] })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'red', { type: 'move', from: [3, 0], to: [8, 8] })).toContain('未被本引擎识别')
  })

  it('开局/中局/终局三态：jsonSizeOf 远小于 65536', () => {
    const fresh = engine.createGame().state
    expect(jsonSizeOf(fresh)).toBeLessThan(65536)
    const mid = engine.applyAction(fresh, { type: 'move', from: [3, 0], to: [4, 4] }, 'red').state
    expect(jsonSizeOf(mid)).toBeLessThan(65536)
    const finished = blank()
    place(finished, 0, 0, 'red')
    expect(jsonSizeOf({ ...finished, finished: true, winner: 'red' })).toBeLessThan(65536)
  })
})

/* ------------------------------------ 确定性 ------------------------------------ */

describe('确定性（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变', () => {
    const state = engine.createGame().state
    const snapshot = structuredClone(state)
    const first = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red')
    const second = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red')
    expect(first).toEqual(second)
    expect(state).toEqual(snapshot)
  })
})

/* ------------------------------------ 端到端（引擎） ------------------------------------ */

/**
 * 「冲家机器人」（确定性）：开局为每颗弹珠一次性分配镜像家位（按弹珠身份
 * 跟踪，不随位置重算——否则弹珠一移动「家」就漂到中腹，双方互相圈养死锁），
 * 每手挑最接近落位的合法着法——入家 +1000、家距缩短 ×100、深位家优先
 * （先占远端再回填入口，避免自我堵门）——同局面签名去重打破循环。只读 legal
 * 决策、不复刻合法性（合法性全部来自 legal 建议集）。
 */
function targetCampOf(role: Role): 'top' | 'bottom' {
  return role === 'red' ? 'bottom' : 'top'
}

/** 镜像洞位（星形两点关于盘心中心对称）：顶营 (q,r) ↔ 底营 (-q,-r)。 */
function mirrorHole(hole: number): number {
  const axial = probe.axialOf(hole)
  for (let candidate = 0; candidate < probe.holeCount; candidate += 1) {
    const other = probe.axialOf(candidate)
    if (other.q === -axial.q && other.r === -axial.r) return candidate
  }
  throw new Error(`洞位 ${hole} 的镜像不存在`)
}

function axialDistanceOf(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs((a.q + a.r) - (b.q + b.r))) / 2
}

function botPick(
  state: StateShape,
  legal: MoveAction[],
  home: Map<number, number>,
  seen: Set<string>,
): MoveAction {
  const boardOf = (action: MoveAction): number[][] => {
    const board = state.board.map((row) => row.slice())
    board[action.from[0]]![action.from[1]] = 0
    board[action.to[0]]![action.to[1]] = state.board[action.from[0]]![action.from[1]]!
    return board
  }
  const signatureOf = (board: number[][]): string => board.map((row) => row.join(',')).join('|')
  const code = state.turn === 'red' ? 1 : 2
  const scored: Array<{ action: MoveAction; score: number }> = []
  for (const action of legal) {
    const fromHole = index(action.from[0], action.from[1])
    if (at(state, action.from[0], action.from[1]) !== code) continue
    const myHome = home.get(fromHole)
    if (myHome === undefined || fromHole === myHome) continue
    const toHole = index(action.to[0], action.to[1])
    const distanceNow = axialDistanceOf(probe.axialOf(fromHole), probe.axialOf(myHome))
    const distanceNext = axialDistanceOf(probe.axialOf(toHole), probe.axialOf(myHome))
    const homeCoord = probe.coordOf(myHome)
    const depth = state.turn === 'red' ? homeCoord.row : 16 - homeCoord.row
    scored.push({ action, score: (distanceNow - distanceNext) * 100 + depth * 6 + (toHole === myHome ? 1000 : 0) })
  }
  scored.sort((a, b) => b.score - a.score)
  for (const entry of scored) {
    if (!seen.has(signatureOf(boardOf(entry.action)))) return entry.action
  }
  return scored.length > 0 ? scored[0]!.action : legal[0]!
}

function playBotGame(maxPlies = 600): { state: StateShape; plies: number } {
  let state = engine.createGame().state
  const home = new Map<number, number>()
  for (let hole = 0; hole < probe.holeCount; hole += 1) {
    const coord = probe.coordOf(hole)
    if (at(state, coord.row, coord.col) !== 0) home.set(hole, mirrorHole(hole))
  }
  const seen = new Set<string>()
  let plies = 0
  while (!state.finished && plies < maxPlies) {
    const legal = engine.legalActions(state)
    expect(legal.length, '未终局必有合法着法').toBeGreaterThan(0)
    const action = botPick(state, legal, home, seen)
    seen.add(state.board.map((row) => row.join(',')).join('|'))
    const fromHole = index(action.from[0], action.from[1])
    const toHole = index(action.to[0], action.to[1])
    home.set(toHole, home.get(fromHole)!)
    home.delete(fromHole)
    state = engine.applyAction(state, action, state.turn).state
    plies += 1
  }
  return { state, plies }
}

describe('端到端（引擎级冲家机器人）', () => {
  it('机器人对局终局收官：赢家十子全部落在对方营盘、终局建议集空', () => {
    const { state, plies } = playBotGame()
    expect(state.finished).toBe(true)
    expect(plies).toBeLessThan(600)
    const winner = state.winner!
    expect(['red', 'blue']).toContain(winner)
    let inTarget = 0
    let total = 0
    for (let row = 0; row < 17; row += 1) {
      for (let col = 0; col < ROW_LENGTHS[row]!; col += 1) {
        const code = at(state, row, col)
        if (code !== (winner === 'red' ? 1 : 2)) continue
        total += 1
        if (probe.campOf(index(row, col)) === targetCampOf(winner)) inTarget += 1
      }
    }
    expect(total).toBe(10)
    expect(inTarget).toBe(10)
    expect(engine.legalActions(state)).toEqual([])
  })

  it('整局重放两次 deep-equal（机器人确定性 ⇒ 对局确定性）', () => {
    expect(playBotGame()).toEqual(playBotGame())
  })
})

/* ----------------------- 端到端会话（真实 GamesService，开箱可玩面） ----------------------- */

/** 直接落一个会话文件（构造近收官局面；服务把会话文件当数据读）。 */
function writeSession(root: string, session: {
  id: string
  players: Array<{ role: Role; owner: 'human' | 'agent' }>
  state: StateShape
}): void {
  const now = new Date().toISOString()
  mkdirSync(join(root, 'games', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'games', 'sessions', `${session.id}.json`), JSON.stringify({
    id: session.id,
    gameId: 'dsh-soulmojito.chinese-checkers',
    players: session.players,
    state: session.state,
    moves: [],
    createdAt: now,
    updatedAt: now,
    chat: { character: 'ExampleCard', chatId: 'cc-chat' },
    finished: false,
    winner: null,
    summary: '',
  }, null, 2), 'utf8')
}

describe('端到端会话（真实 GamesService）', () => {
  it('开局：人类执红先手、建议集 14、回合闸双向把守', async () => {
    const service = await openGamesService({ root: join(home, 'soulmojito'), hostVersion: '0.6.5' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-soulmojito.chinese-checkers', character: 'ExampleCard', chatId: 'cc-chat' })
      expect(session.gameId).toBe('dsh-soulmojito.chinese-checkers')
      expect(session.gameName).toBe('中国跳棋')
      expect(session.players).toEqual([
        { role: 'red', owner: 'human' },
        { role: 'blue', owner: 'agent' },
      ])
      expect(view.turn).toBe('red')
      expect(view.legal).toHaveLength(14)
      expect(view.finished).toBe(false)
      await expect(service.agentMove(session.id, { type: 'move', from: [3, 0], to: [4, 4] }))
        .rejects.toThrow(/不是 Agent 的回合/)
      const human = await service.humanAction(session.id, { type: 'move', from: [3, 0], to: [4, 4] })
      expect(human.describe).toBe('红方 4-1 走到 5-5')
      expect(human.view.turn).toBe('blue')
      await expect(service.humanAction(session.id, { type: 'move', from: [3, 1], to: [4, 5] }))
        .rejects.toThrow(/请等待 AI 落子/)
      const agent = await service.agentMove(session.id, { type: 'move', from: [13, 0], to: [12, 4] })
      expect(agent.view.turn).toBe('red')
      expect(agent.session.moveCount).toBe(2)
    } finally {
      service.dispose()
    }
  })

  it('人类收官（构造性会话）：humanAction 走满底营 → 终局红胜、视图终局态', async () => {
    const root = join(home, 'soulmojito')
    const service = await openGamesService({ root, hostVersion: '0.6.5' })
    try {
      const state = blank()
      // 红：底营 9 洞（留 [13,0]）+ 第 10 颗在 [12,5]；蓝：中腹散布。
      place(state, 13, 1, 'red'); place(state, 13, 2, 'red'); place(state, 13, 3, 'red')
      place(state, 14, 0, 'red'); place(state, 14, 1, 'red'); place(state, 14, 2, 'red')
      place(state, 15, 0, 'red'); place(state, 15, 1, 'red')
      place(state, 16, 0, 'red')
      place(state, 12, 5, 'red')
      scatterBlue(state)
      state.turn = 'red'
      writeSession(root, {
        id: 'g-cafe0001',
        players: [{ role: 'red', owner: 'human' }, { role: 'blue', owner: 'agent' }],
        state,
      })
      const outcome = await service.humanAction('g-cafe0001', { type: 'move', from: [12, 5], to: [13, 0] })
      expect(outcome.session.finished).toBe(true)
      expect(outcome.session.winner).toBe('red')
      expect(outcome.describe).toBe('红方 13-6 走到 14-1')
      expect(outcome.session.summary).toContain('红方胜')
      expect(outcome.view.finished).toBe(true)
      expect(outcome.view.legal).toEqual([])
      await expect(service.humanAction('g-cafe0001', { type: 'move', from: [13, 1], to: [13, 2] }))
        .rejects.toThrow(/对局已结束/)
    } finally {
      service.dispose()
    }
  })

  it('Agent 收官（构造性会话）：agentMove 走满顶营 → 终局蓝胜', async () => {
    const root = join(home, 'soulmojito')
    const service = await openGamesService({ root, hostVersion: '0.6.5' })
    try {
      const state = blank()
      // 蓝：顶营 9 洞（留 [3,3]）+ 第 10 颗在 [4,7]；红：中腹散布。
      place(state, 0, 0, 'blue')
      place(state, 1, 0, 'blue'); place(state, 1, 1, 'blue')
      place(state, 2, 0, 'blue'); place(state, 2, 1, 'blue'); place(state, 2, 2, 'blue')
      place(state, 3, 0, 'blue'); place(state, 3, 1, 'blue'); place(state, 3, 2, 'blue')
      place(state, 4, 7, 'blue')
      scatterRed(state)
      state.turn = 'blue'
      writeSession(root, {
        id: 'g-cafe0002',
        players: [{ role: 'red', owner: 'human' }, { role: 'blue', owner: 'agent' }],
        state,
      })
      const outcome = await service.agentMove('g-cafe0002', { type: 'move', from: [4, 7], to: [3, 3] })
      expect(outcome.session.finished).toBe(true)
      expect(outcome.session.winner).toBe('blue')
      expect(outcome.view.finished).toBe(true)
    } finally {
      service.dispose()
    }
  })
})

/* ----------------------- 视图（DOM 垫片真跑内联脚本） ----------------------- */
/* 最小 DOM 垫片把内联脚本真跑一遍（地牢/21 点同款纪律）：两段式选择与上行动作、
 * 对手回合与终局静默、lastMove 金框类名——按真实载荷断言。 */

class FakeElement {
  children: FakeElement[] = []
  className = ''
  textContent = ''
  title = ''
  style: Record<string, string> = {}
  private attrs = new Map<string, string>()
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
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  click(): void {
    for (const listener of [...(this.listeners.get('click') ?? [])]) listener({})
  }
}

const VIEW_ELEMENT_IDS = ['board', 'banner', 'hint', 'session-id', 'owner-red', 'owner-blue'] as const

interface ViewHarness {
  el(id: string): FakeElement
  dispatch(state: StateShape, options?: { turn?: Role; legal?: MoveAction[]; finished?: boolean; summary?: string }): void
  hole(index: number): FakeElement
  holeCount(): number
  marbleCount(): number
  sent: Array<{ action: MoveAction }>
}

/** 打开视图脚本（search 带 token 即实时面）。 */
function openView(search: string): ViewHarness {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(viewHtml)
  expect(script, 'viewHtml 含内联脚本').not.toBeNull()
  const registry = new Map<string, FakeElement>(VIEW_ELEMENT_IDS.map((id): [string, FakeElement] => [id, new FakeElement('div')]))
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  const sent: ViewHarness['sent'] = []
  const documentShim = {
    getElementById: (id: string): FakeElement | null => registry.get(id) ?? null,
    createElement: (tagName: string): FakeElement => new FakeElement(tagName),
  }
  const windowShim = {
    location: { search },
    parent: { postMessage: (message: { action: MoveAction }): void => { sent.push(message) } },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void): void => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  const run = new Function('window', 'document', 'URLSearchParams', script![1]!) as (
    window: unknown, document: unknown, urlSearchParams: unknown,
  ) => void
  run(windowShim, documentShim, URLSearchParams)
  const boardOf = (): FakeElement => {
    const element = registry.get('board')
    if (element === undefined) throw new Error('缺垫片元素 board')
    return element
  }
  const holes = (): FakeElement[] => boardOf().children.filter((child) => child.className.startsWith('hole'))
  return {
    el: (id) => {
      const element = registry.get(id)
      if (element === undefined) throw new Error(`缺垫片元素 ${id}`)
      return element
    },
    dispatch: (state, options = {}) => {
      const view = {
        state,
        turn: options.turn ?? state.turn,
        legal: options.legal ?? engine.legalActions(state),
        finished: options.finished ?? state.finished,
        summary: options.summary ?? '',
      }
      for (const listener of [...messageListeners]) {
        listener({
          data: {
            type: 'dsh-soulmojito:game-state',
            token: 't',
            session: {
              id: 'g-viewtest',
              players: [{ role: 'red', owner: 'human' }, { role: 'blue', owner: 'agent' }],
            },
            view,
          },
        })
      }
    },
    hole: (index) => {
      const found = holes().find((element) => element.getAttribute('data-cell') === String(index))
      if (found === undefined) throw new Error(`缺垫片洞位 ${index}`)
      return found
    },
    holeCount: () => holes().length,
    marbleCount: () => {
      let count = 0
      for (const hole of holes()) count += hole.children.filter((child) => child.className.startsWith('marble')).length
      return count
    },
    sent,
  }
}

describe('视图（DOM 垫片真跑内联脚本）', () => {
  it('无 token 静态预览：121 洞、20 颗弹珠、横幅标注预览', () => {
    const view = openView('')
    expect(view.holeCount()).toBe(121)
    expect(view.marbleCount()).toBe(20)
    expect(view.el('banner').textContent).toContain('静态预览（无 token）')
  })

  it('两段式选择：点自家弹珠亮落点、点落点上行动作、发送锁防重发', () => {
    const view = openView('?token=t')
    const state = engine.createGame().state
    view.dispatch(state)
    expect(view.el('banner').textContent).toContain('轮到你')
    view.hole(index(3, 0)).click()
    expect(view.hole(index(3, 0)).children.some((child) => child.className.includes('sel'))).toBe(true)
    expect(view.hole(index(4, 4)).className).toContain('reach')
    expect(view.hole(index(4, 5)).className).toContain('reach')
    view.hole(index(4, 4)).click()
    expect(view.sent).toHaveLength(1)
    expect(view.sent[0]!.action).toEqual({ type: 'move', from: [3, 0], to: [4, 4] })
    view.hole(index(4, 4)).click()
    expect(view.sent).toHaveLength(1)
  })

  it('对手回合与终局：点击全静默（视图不越过回合闸）；lastMove 金框类名落位', () => {
    const view = openView('?token=t')
    const state = engine.createGame().state
    view.dispatch(state, { turn: 'blue' })
    expect(view.el('banner').textContent).toContain('等待 AI 落子')
    view.hole(index(3, 0)).click()
    expect(view.sent).toHaveLength(0)
    const moved = engine.applyAction(state, { type: 'move', from: [3, 0], to: [4, 4] }, 'red').state
    view.dispatch(moved, { turn: 'blue' })
    expect(view.hole(index(3, 0)).className).toContain('last-from')
    expect(view.hole(index(4, 4)).className).toContain('last-to')
    const finished = structuredClone(moved)
    finished.finished = true
    finished.winner = 'red'
    view.dispatch(finished, { turn: 'red', finished: true, legal: [], summary: '红方胜' })
    expect(view.el('banner').textContent).toContain('红方胜')
    view.hole(index(4, 4)).click()
    expect(view.sent).toHaveLength(0)
  })

  it('静态锚点：洞带 data-cell 与 行-列 title、营盘类名按行落位', () => {
    const view = openView('')
    expect(view.hole(0).getAttribute('data-cell')).toBe('0')
    expect(view.hole(0).title).toBe('1-1')
    expect(view.hole(index(8, 4)).title).toBe('9-5')
    expect(view.hole(0).className).toContain('camp-red')
    expect(view.hole(index(16, 0)).className).toContain('camp-blue')
    expect(view.hole(index(8, 4)).className).not.toContain('camp-')
  })
})
