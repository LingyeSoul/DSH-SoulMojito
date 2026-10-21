/**
 * 内置军棋（提案 0018 §4.1 内置序列第四款，2026-10-14）——引擎契约与
 * 全量规则面测试。决策与边界见 decisions/2026-10-14-junqi-builtin.md。
 *
 * 与 games-xiangqi.spec.ts 同款契约测试风格（标准即测试）：确定性 / JSON-safe /
 * 非法动作中文抛错 / legalActions 有界 / describe 带叙述——另加军棋专属的
 * 规则面：
 * - 走法几何逐一钉死：公路一步、行营斜线八达、大本营斜线三向、铁路直线
 *   滑行（非工兵不可拐弯、不可穿越占子）、工兵铁路 BFS 转弯、行营免攻、
 *   大本营冻结、地雷/军旗永不可动；
 * - 战斗裁决全矩阵：大吃小 / 小攻大阵亡 / 同级同尽 / 炸弹对任何子（含地雷）
 *   同尽 / 地雷克非工兵 / 工兵挖雷 / 扛旗即胜；
 * - 终局两途：夺旗与困毙（对方无棋可走判负——军棋无子和棋）；
 * - 布阵约束（固定经典布阵）：军旗在大本营、地雷只在后两排、炸弹不在前排、
 *   行营全空、每方 25 子；
 * - 视图静态面（自包含 + data-game 标记 + 桥消息 + view 管线）与预览局面
 *   与引擎真实四手开局的一致性（防视图内联预览漂移）。
 *
 * 测试位置构造说明（与象棋 spec 同款纪律）：规则面用「手工局面」直接构造
 * state（引擎对 state 是纯函数、不依赖历史——§3.2 契约的直接推论，也让
 * 边界局面可被精确钉死）；战斗局面恒放一枚蓝方保命子（(2,5) 连长）避免
 * 「对方全灭=困毙终局」的连锁干扰普通断言。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { manifest as junqiManifest, viewHtml as junqiViewHtml, junqiEngine } from '../src/games/builtin/junqi.js'
import { GameRegistry } from '../src/games/registry.js'
import { openGamesService } from '../src/games/service.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, smokeTestGameEngine, type GameAction } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Side = 'red' | 'blue'

interface Pt {
  x: number
  y: number
}

interface JunqiState {
  board: (string | null)[][]
  turn: Side
  ply: number
  lastMove: { from: Pt; to: Pt; piece: string; captured: string | null; outcome: string } | null
  finished: boolean
  winner: Side | null
  ending: 'flag' | 'immobilized' | null
}

interface ApplyResult {
  state: JunqiState
  events: string[]
  finished: boolean
  winner: Side | null
  summary: string
}

const home = mkdtempSync(join(tmpdir(), 'games-junqi-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function mv(from: [number, number], to: [number, number]): GameAction {
  return { type: 'move', from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } }
}

/** 手工局面：空盘 + 指定棋子（规则面测试用——引擎对 state 纯函数）。 */
function stateFrom(pieces: Array<[number, number, string]>, turn: Side = 'red'): JunqiState {
  const board: (string | null)[][] = Array.from({ length: 12 }, () => Array.from({ length: 5 }, () => null))
  for (const [x, y, piece] of pieces) board[y]![x] = piece
  return { board, turn, ply: 0, lastMove: null, finished: false, winner: null, ending: null }
}

/** 交错走子（红先自动轮转），终局即停；返回最后一次 applyAction 结果。 */
function play(moves: Array<[[number, number], [number, number]]>): ApplyResult {
  let state = junqiEngine.createGame().state as JunqiState
  let last: ApplyResult | null = null
  for (const [from, to] of moves) {
    last = junqiEngine.applyAction(state, mv(from, to), state.turn) as ApplyResult
    state = last.state as JunqiState
    if (state.finished) break
  }
  if (last === null) throw new Error('play() 至少需要一手棋')
  return last
}

/** 建议集是否包含某 from→to。 */
function hasMove(actions: Array<{ type: string; from: Pt; to: Pt }>, from: [number, number], to: [number, number]): boolean {
  return actions.some((action) => action.from.x === from[0] && action.from.y === from[1] && action.to.x === to[0] && action.to.y === to[1])
}

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验，id 反域名、engines 缺席（内置自我门控无意义）', () => {
    const check = checkGameManifest(junqiManifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(junqiManifest.id).toBe('dsh-soulmojito.junqi')
    expect(junqiManifest.name).toBe('军棋')
    expect(junqiManifest.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    expect(junqiManifest.engines).toBeUndefined()
    expect(junqiManifest.actionVocabulary).toContain('move')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源；烟测过五关', () => {
    const check = checkGameEngine(junqiEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(junqiManifest)
    const smoke = smokeTestGameEngine(junqiEngine)
    expect(smoke.ok).toBe(true)
    expect(smoke.reasons).toEqual([])
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(junqiViewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(junqiViewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(junqiViewHtml).not.toContain('fetch(')
    expect(junqiViewHtml).toContain('dsh-soulmojito:game-state')
    expect(junqiViewHtml).toContain('dsh-soulmojito:game-action')
    expect(junqiViewHtml).toContain('data-game="dsh-soulmojito.junqi"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(junqiViewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.junqi"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })
})

describe('createGame 开局（§3.2）：经典固定布阵', () => {
  it('初始态：红先、ply 0、未终局、JSON-safe 往返、turn 契约', () => {
    const { state } = junqiEngine.createGame()
    const g = state as JunqiState
    expect(g.turn).toBe('red')
    expect(g.ply).toBe(0)
    expect(g.lastMove).toBeNull()
    expect(g.finished).toBe(false)
    expect(g.winner).toBeNull()
    expect(g.ending).toBeNull()
    expect(JSON.parse(JSON.stringify(g))).toEqual(g)
    expect(currentRoleOf(g, junqiManifest.players.roles)).toBe('red')
  })

  it('每方 25 子、行营全空、蓝方为红方 y 镜像（大小写对应）', () => {
    const { state } = junqiEngine.createGame()
    const g = state as JunqiState
    const camps = ['1,2', '3,2', '2,3', '1,4', '3,4', '1,7', '3,7', '2,8', '1,9', '3,9']
    for (const camp of camps) {
      const [x, y] = camp.split(',').map(Number) as [number, number]
      expect(g.board[y]![x]).toBeNull()
    }
    let reds = 0
    let blues = 0
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const piece = g.board[y]![x]
        if (piece === null) continue
        if (piece === piece.toUpperCase()) reds += 1
        else blues += 1
        // 镜像：board[y][x] 与 board[11-y][x] 同子异色。
        expect(g.board[11 - y]![x]).toBe(piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase())
      }
    }
    expect(reds).toBe(25)
    expect(blues).toBe(25)
  })

  it('布阵约束：军旗在大本营、地雷只在后两排、炸弹不在前排', () => {
    const { state } = junqiEngine.createGame()
    const g = state as JunqiState
    const counts: Record<string, number> = {}
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const piece = g.board[y]![x]
        if (piece === null) continue
        const kind = piece.toUpperCase()
        const red = piece === piece.toUpperCase()
        counts[kind] = (counts[kind] ?? 0) + 1
        if (kind === 'F') {
          expect(red ? `${x},${y}` : `${x},${11 - y}`).toBe(x === 1 ? '1,11' : '3,11')
        }
        if (kind === 'L') {
          // 地雷只在后两排（红 y∈{10,11}、蓝 y∈{0,1}）。
          expect(red ? y >= 10 : y <= 1).toBe(true)
        }
        if (kind === 'Z') {
          // 炸弹不在前排（红 y≠6、蓝 y≠5）。
          expect(red ? y !== 6 : y !== 5).toBe(true)
        }
      }
    }
    expect(counts).toEqual({
      M: 2, G: 2, D: 4, B: 4, R: 4, T: 4, C: 6, P: 6, E: 6, Z: 4, L: 6, F: 2,
    })
  })
})

describe('开局走子与叙述（真实序列）', () => {
  it('第一手进营：五字段、深拷贝不改入参、轮转蓝方、中文叙述', () => {
    const state = junqiEngine.createGame().state as JunqiState
    const snapshot = structuredClone(state)
    const result = junqiEngine.applyAction(state, mv([2, 7], [2, 8]), 'red') as ApplyResult
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    const next = result.state as JunqiState
    expect(next.board[8]![2]).toBe('T')
    expect(next.board[7]![2]).toBeNull()
    expect(next.turn).toBe('blue')
    expect(next.ply).toBe(1)
    expect(next.lastMove).toEqual({ from: { x: 2, y: 7 }, to: { x: 2, y: 8 }, piece: 'T', captured: null, outcome: 'move' })
    expect(result.finished).toBe(false)
    expect(result.events).toEqual(['红方 营长 (2,7)→(2,8)'])
    expect(result.summary).toBe('红方 营长 (2,7)→(2,8)')
    expect(state).toEqual(snapshot)
  })

  it('铁路机动叙述带「沿铁路」后缀（中线铁路相邻攻击）', () => {
    const state = junqiEngine.createGame().state as JunqiState
    const result = junqiEngine.applyAction(state, mv([2, 6], [2, 5]), 'red') as ApplyResult
    expect(result.events[0]).toBe('红方 营长 (2,6)→(2,5)沿铁路')
    expect(result.events[1]).toBe('与蓝方营长同归于尽')
    expect(result.summary).toBe('红方 营长 (2,6)→(2,5)沿铁路，与蓝方营长同归于尽')
    // 同级互撞：两格皆空。
    expect((result.state as JunqiState).board[6]![2]).toBeNull()
    expect((result.state as JunqiState).board[5]![2]).toBeNull()
  })
})

describe('非法动作全家族（中文抛错）', () => {
  it('形状/type/角色/终局面：非对象/缺 type/未知 type（resign 含）/错误角色/未轮到/终局后', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    expect(() => junqiEngine.applyAction(fresh, null, 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, { x: 0, y: 0 }, 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, { type: 'resign' }, 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, { type: 'jump' }, 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, mv([2, 7], [2, 8]), 'blue')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, mv([2, 4], [2, 3]), 'red')).toThrow(/不能走对方的棋子/)
    const after = junqiEngine.applyAction(fresh, mv([2, 7], [2, 8]), 'red').state as JunqiState
    expect(() => junqiEngine.applyAction(after, mv([2, 4], [2, 3]), 'red')).toThrow(/轮到/)
  })

  it('坐标面：越界/非整数/起点与终点相同/空起点', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    expect(() => junqiEngine.applyAction(fresh, mv([5, 6], [4, 6]), 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, mv([0, 12], [0, 11]), 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, { type: 'move', from: { x: 0.5, y: 6 }, to: { x: 0, y: 5 } }, 'red')).toThrow(Error)
    expect(() => junqiEngine.applyAction(fresh, mv([1, 7], [1, 7]), 'red')).toThrow(/相同/)
    expect(() => junqiEngine.applyAction(fresh, mv([1, 7], [1, 8]), 'red')).toThrow(/没有棋子/)
    // 非整数文本仍拒（0.5 数字形态在上一条；此处钉字符串形态的同一闸门）。
    expect(() => junqiEngine.applyAction(fresh, { type: 'move', from: { x: '0.5', y: 6 }, to: { x: 0, y: 5 } }, 'red')).toThrow(/坐标必须是整数/)
  })

  it('坐标容错（2026-10-14 实弹，决策 quoted-coordinate-tolerance）：整数的字符串形态归一执行', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    // 实弹形状：模型桥把工具参数数字写成引号串；归一是同点同义，不改动作语义。
    const stringCoord = junqiEngine.applyAction(fresh, { type: 'move', from: { x: '2', y: '7.0' }, to: { x: '2', y: '8' } }, 'red')
    expect(stringCoord.summary).toContain('营长')
    // describe 与 applyAction 同一套解析：历史叙述不缺坐标叙述。
    expect(junqiEngine.describe(fresh, 'red', { type: 'move', from: { x: '2', y: '7' }, to: { x: '2', y: '8' } }))
      .toBe('红方 营长 (2,7)→(2,8)')
  })

  it('冻结面：地雷/军旗永不可动、大本营棋子（初始就位）不能再动', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    expect(() => junqiEngine.applyAction(fresh, mv([2, 11], [2, 10]), 'red')).toThrow(/地雷与军旗不能移动/)
    // 军旗在大本营内同时命中两条规则，引擎先报大本营冻结（两条都真，报序在此钉死）。
    expect(() => junqiEngine.applyAction(fresh, mv([1, 11], [1, 10]), 'red')).toThrow(/不符合走子规则（大本营中的棋子不能再移动）/)
    // 非大本营的手工军旗钉「军旗不可动」本尊。
    expect(() => junqiEngine.applyAction(stateFrom([[2, 5, 'F']]), mv([2, 5], [2, 4]), 'red')).toThrow(/地雷与军旗不能移动/)
    expect(() => junqiEngine.applyAction(fresh, mv([3, 11], [2, 10]), 'red')).toThrow(/大本营中的棋子不能再移动/)
  })

  it('几何面：非工兵铁路拐弯、铁路穿越占子、行营宿子不可攻', () => {
    // 非工兵在铁路交叉口拐弯：(0,1)→(1,5) 不是直线。
    const bend = stateFrom([[0, 1, 'M']])
    expect(() => junqiEngine.applyAction(bend, mv([0, 1], [1, 5]), 'red')).toThrow(/不符合走子规则/)
    // 铁路滑行穿越占子：(0,1)→(0,6) 被 (0,3) 挡。
    const blocked = stateFrom([[0, 1, 'M'], [0, 3, 'e']])
    expect(() => junqiEngine.applyAction(blocked, mv([0, 1], [0, 6]), 'red')).toThrow(/不符合走子规则/)
    // 行营免攻：蓝工兵坐在 (1,7) 行营，红司令在斜邻 (0,8) 不可攻入。
    const camp = stateFrom([[0, 8, 'M'], [1, 7, 'e']])
    expect(() => junqiEngine.applyAction(camp, mv([0, 8], [1, 7]), 'red')).toThrow(/不符合走子规则/)
    // 走子规则报错带几何说明（军棋的合法性是几何的）。
    expect(() => junqiEngine.applyAction(camp, mv([0, 8], [1, 7]), 'red')).toThrow(/行营中的棋子不可被攻击/)
  })
})

describe('走法几何（手工局面）', () => {
  it('公路一步与行营斜线：营长 (2,7) 恰好四目标（进三营 + 退一步）', () => {
    const state = stateFrom([[2, 7, 'T']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(actions).toHaveLength(4)
    expect(hasMove(actions, [2, 7], [2, 8])).toBe(true)
    expect(hasMove(actions, [2, 7], [2, 6])).toBe(true)
    expect(hasMove(actions, [2, 7], [1, 7])).toBe(true)
    expect(hasMove(actions, [2, 7], [3, 7])).toBe(true)
  })

  it('行营内出发八向：连长在 (1,7) 行营恰八目标（正交四 + 斜四）', () => {
    const state = stateFrom([[1, 7, 'C']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(actions).toHaveLength(8)
    expect(hasMove(actions, [1, 7], [1, 6])).toBe(true)
    expect(hasMove(actions, [1, 7], [1, 8])).toBe(true)
    expect(hasMove(actions, [1, 7], [0, 7])).toBe(true)
    expect(hasMove(actions, [1, 7], [2, 7])).toBe(true)
    expect(hasMove(actions, [1, 7], [0, 6])).toBe(true)
    expect(hasMove(actions, [1, 7], [2, 6])).toBe(true)
    expect(hasMove(actions, [1, 7], [0, 8])).toBe(true)
    expect(hasMove(actions, [1, 7], [2, 8])).toBe(true)
  })

  it('大本营斜线三向（从 (0,1) 可斜入 (1,0) 大本营与 (1,2) 行营）', () => {
    const state = stateFrom([[0, 1, 'C']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 1], [1, 0])).toBe(true)
    expect(hasMove(actions, [0, 1], [1, 2])).toBe(true)
    expect(hasMove(actions, [0, 1], [0, 0])).toBe(true)
  })

  it('非工兵铁路直线滑行：司令 (0,1) 一口气滑到 (0,10)（九格）', () => {
    const state = stateFrom([[0, 1, 'M']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 1], [0, 10])).toBe(true)
    expect(hasMove(actions, [0, 1], [4, 1])).toBe(true)
    // 直线纪律：拐弯目标不在建议集。
    expect(hasMove(actions, [0, 1], [2, 5])).toBe(false)
    expect(hasMove(actions, [0, 1], [1, 5])).toBe(false)
  })

  it('铁路遇子即止：可攻 (0,5) 但不可越至 (0,6)', () => {
    const state = stateFrom([[0, 1, 'M'], [0, 5, 'e']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 1], [0, 5])).toBe(true)
    expect(hasMove(actions, [0, 1], [0, 6])).toBe(false)
  })

  it('工兵铁路可转弯：工兵 (0,6) 经 (0,5) 转入 5 排铁路直达 (4,5)', () => {
    const state = stateFrom([[0, 6, 'E']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 6], [4, 5])).toBe(true)
    expect(hasMove(actions, [0, 6], [2, 1])).toBe(true)
  })

  it('非工兵无工兵路线：司令 (0,6) 到不了需要拐弯的 (4,5)', () => {
    const state = stateFrom([[0, 6, 'M']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 6], [4, 5])).toBe(false)
    expect(hasMove(actions, [0, 6], [0, 10])).toBe(true)
    expect(hasMove(actions, [0, 6], [4, 6])).toBe(true)
  })

  it('行营免攻：斜邻行营有蓝子不可攻，空行营可进', () => {
    const state = stateFrom([[0, 8, 'M'], [1, 7, 'e']])
    const actions = junqiEngine.legalActions(state) as Array<{ type: string; from: Pt; to: Pt }>
    expect(hasMove(actions, [0, 8], [1, 7])).toBe(false)
    expect(hasMove(actions, [0, 8], [1, 9])).toBe(true)
  })
})

describe('战斗裁决（手工局面，蓝方恒留保命子防困毙连锁）', () => {
  const BASE: Array<[number, number, string]> = [[2, 5, 'c']]

  it('大吃小：司令吃军长，占位', () => {
    const state = stateFrom([[0, 6, 'M'], [0, 5, 'g'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[5]![0]).toBe('M')
    expect(next.board[6]![0]).toBeNull()
    expect(result.events[1]).toBe('吃掉蓝方军长')
    expect(result.finished).toBe(false)
  })

  it('小攻大：排长攻司令阵亡，司令原地不动', () => {
    const state = stateFrom([[0, 6, 'P'], [0, 5, 'm'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[6]![0]).toBeNull()
    expect(next.board[5]![0]).toBe('m')
    expect(result.events[1]).toBe('进攻阵亡（蓝方司令仍在）')
    expect(result.finished).toBe(false)
  })

  it('同级互撞：营长对营长同归于尽', () => {
    const state = stateFrom([[0, 6, 'T'], [0, 5, 't'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[6]![0]).toBeNull()
    expect(next.board[5]![0]).toBeNull()
    expect(result.events[1]).toBe('与蓝方营长同归于尽')
  })

  it('炸弹对任何子同尽（攻与被攻两个方向）', () => {
    const attack = stateFrom([[0, 6, 'Z'], [0, 5, 'd'], ...BASE])
    const attacked = junqiEngine.applyAction(attack, mv([0, 6], [0, 5]), 'red') as ApplyResult
    expect((attacked.state as JunqiState).board[5]![0]).toBeNull()
    expect(attacked.events[1]).toBe('与蓝方师长同归于尽')

    const defend = stateFrom([[0, 6, 'M'], [0, 5, 'z'], ...BASE])
    const defending = junqiEngine.applyAction(defend, mv([0, 6], [0, 5]), 'red') as ApplyResult
    expect((defending.state as JunqiState).board[5]![0]).toBeNull()
    expect((defending.state as JunqiState).board[6]![0]).toBeNull()
    expect(defending.events[1]).toBe('与蓝方炸弹同归于尽')
  })

  it('地雷克非工兵：司令触雷阵亡、地雷仍在', () => {
    const state = stateFrom([[0, 6, 'M'], [0, 5, 'l'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[6]![0]).toBeNull()
    expect(next.board[5]![0]).toBe('l')
    expect(result.events[1]).toBe('触雷阵亡（地雷仍在）')
  })

  it('工兵挖雷：地雷移除、工兵占位', () => {
    const state = stateFrom([[0, 6, 'E'], [0, 5, 'l'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[5]![0]).toBe('E')
    expect(result.events[1]).toBe('挖掉蓝方地雷')
  })

  it('炸弹对地雷：同归于尽', () => {
    const state = stateFrom([[0, 6, 'Z'], [0, 5, 'l'], ...BASE])
    const result = junqiEngine.applyAction(state, mv([0, 6], [0, 5]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[5]![0]).toBeNull()
    expect(result.events[1]).toBe('与蓝方地雷同归于尽')
  })
})

describe('终局（军棋无子和棋）', () => {
  it('扛旗即胜：工兵斜入大本营扛走军旗，ending=flag', () => {
    const state = stateFrom([[0, 1, 'E'], [1, 0, 'f'], [2, 5, 'c']])
    const result = junqiEngine.applyAction(state, mv([0, 1], [1, 0]), 'red') as ApplyResult
    const next = result.state as JunqiState
    expect(next.board[0]![1]).toBe('E')
    expect(next.finished).toBe(true)
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect(next.ending).toBe('flag')
    expect(result.events).toContain('扛走蓝方军旗！')
    expect(result.summary).toBe('红方 工兵 (0,1)→(1,0)，扛走蓝方军旗！，夺旗获胜，红方胜')
  })

  it('困毙判负：蓝方只剩地雷军旗（全不可动），红方任意一手后终局', () => {
    const state = structuredClone(junqiEngine.createGame().state) as JunqiState
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const piece = state.board[y]![x]
        if (piece !== null && piece === piece.toLowerCase() && piece !== 'l' && piece !== 'f') {
          state.board[y]![x] = null
        }
      }
    }
    const result = junqiEngine.applyAction(state, mv([2, 7], [2, 8]), 'red') as ApplyResult
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect((result.state as JunqiState).ending).toBe('immobilized')
    expect(result.summary).toContain('蓝方无棋可走')
    expect(result.summary).toContain('红方胜')
    // 终局后建议集为空、再走子被拒。
    expect(junqiEngine.legalActions(result.state as JunqiState)).toEqual([])
    expect(() => junqiEngine.applyAction(result.state as JunqiState, mv([2, 4], [2, 3]), 'blue')).toThrow(/对局已结束/)
  })
})

describe('legalActions（§3.2 建议集）', () => {
  it('初始 34 步（吃子优先三条铁路相邻攻击 + 非吃子字典序）', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    const actions = junqiEngine.legalActions(fresh) as Array<{ type: string; from: Pt; to: Pt }>
    expect(actions).toHaveLength(34)
    // 前三条是初始局面仅有的三个攻击（按被吃子威胁价值降序：营长>连长>工兵）。
    expect(actions[0]).toEqual({ type: 'move', from: { x: 2, y: 6 }, to: { x: 2, y: 5 } })
    expect(actions[1]).toEqual({ type: 'move', from: { x: 4, y: 6 }, to: { x: 4, y: 5 } })
    expect(actions[2]).toEqual({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 } })
  })

  it('建议集 ⊆ 终审：初始 34 条逐条被 applyAction 原样接受', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    for (const action of junqiEngine.legalActions(fresh)) {
      expect(() => junqiEngine.applyAction(fresh, action, 'red')).not.toThrow()
    }
  })

  it('建议集有界（≤64）且随局面变化', () => {
    const mid = play([[[2, 7], [2, 8]], [[2, 4], [2, 3]]]).state as JunqiState
    const suggestions = junqiEngine.legalActions(mid) as Array<{ type: string; from: Pt; to: Pt }>
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.length).toBeLessThanOrEqual(64)
    // 随局面变化的具体锚点：营长已离开 (2,7)（原走法消失）、进营后可退回 (2,8)→(2,7)。
    expect(hasMove(suggestions, [2, 7], [2, 8])).toBe(false)
    expect(hasMove(suggestions, [2, 8], [2, 7])).toBe(true)
  })
})

describe('describe 叙述（与 events 同源）', () => {
  it('普通一手与铁路一手、战斗预告、未识别回落', () => {
    const fresh = junqiEngine.createGame().state as JunqiState
    expect(junqiEngine.describe(fresh, 'red', mv([2, 7], [2, 8]))).toBe('红方 营长 (2,7)→(2,8)')
    expect(junqiEngine.describe(fresh, 'red', mv([2, 6], [2, 5]))).toBe('红方 营长 (2,6)→(2,5)沿铁路，与蓝方营长同归于尽')
    expect(junqiEngine.describe(fresh, 'red', mv([1, 7], [1, 6]))).toBe('红方的动作未被本引擎识别')
    expect(junqiEngine.describe(fresh, 'red', { type: 'resign' })).toContain('未被本引擎识别')
  })
})

describe('确定性（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变', () => {
    const base = play([[[2, 7], [2, 8]], [[2, 4], [2, 3]]]).state as JunqiState
    const snapshot = structuredClone(base)
    const first = junqiEngine.applyAction(base, mv([3, 6], [3, 7]), base.turn)
    const second = junqiEngine.applyAction(base, mv([3, 6], [3, 7]), base.turn)
    expect(first).toEqual(second)
    expect(base).toEqual(snapshot)
  })

  it('整局重放两次结果 deep-equal；state 尺寸远小于 64KB', () => {
    const moves: Array<[[number, number], [number, number]]> = [
      [[2, 7], [2, 8]], [[2, 4], [2, 3]], [[3, 6], [3, 7]], [[3, 5], [3, 4]],
      [[1, 6], [1, 7]], [[1, 5], [1, 4]], [[0, 9], [1, 9]], [[0, 5], [1, 5]],
    ]
    expect(play([...moves])).toEqual(play([...moves]))
    expect(JSON.stringify(play([...moves]).state).length).toBeLessThan(65536)
  })
})

describe('预览局面防漂移（视图内联 vs 引擎真实四手）', () => {
  it('引擎四手重放与视图 boardFrom 字面量逐行一致', () => {
    const result = play([
      [[2, 7], [2, 8]], [[2, 4], [2, 3]], [[3, 6], [3, 7]], [[3, 5], [3, 4]],
    ])
    const state = result.state as JunqiState
    expect(state.ply).toBe(4)
    expect(state.turn).toBe('red')
    expect(state.lastMove).toEqual({ from: { x: 3, y: 5 }, to: { x: 3, y: 4 }, piece: 'r', captured: null, outcome: 'move' })
    const rows = state.board.map((row) => row.map((cell) => cell ?? '.').join(''))
    expect(rows).toEqual([
      'rflbl', 'plmgd', 'e.z.e', 'cdtbz', 'p..rp',
      'ect.c', 'ECT.C', 'P..RP', 'CDTBZ', 'E.Z.E',
      'PLMGD', 'RFLBL',
    ])
    for (const row of rows) expect(junqiViewHtml).toContain(`'${row}'`)
  })
})

describe('registry 内置源（§4.1）', () => {
  it('列出 builtin 军棋：source builtin、status ok、engine/view 可用', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'soulmojito'), hostVersion: '0.6.4' })
    const summary = registry.summaries().find((candidate) => candidate.id === 'dsh-soulmojito.junqi')!
    expect(summary).toBeDefined()
    expect(summary.source).toBe('builtin')
    expect(summary.status).toBe('ok')
    expect(summary.name).toBe('军棋')
    expect(summary.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    expect(summary.actionVocabulary).toContain('move')
    const entry = registry.get('dsh-soulmojito.junqi')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('data-game="dsh-soulmojito.junqi"')
  })
})

describe('端到端会话（真实 GamesService，开箱可玩面）', () => {
  it('开局 → 人类营长进营 → Agent 营长进营：视图/叙述/轮次/终审全链路', async () => {
    const service = await openGamesService({ root: join(home, 'soulmojito'), hostVersion: '0.6.4' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-soulmojito.junqi', character: 'ExampleCard', chatId: 'jq-chat' })
      expect(session.gameId).toBe('dsh-soulmojito.junqi')
      expect(session.players).toEqual([
        { role: 'red', owner: 'human' },
        { role: 'blue', owner: 'agent' },
      ])
      expect(view.turn).toBe('red')
      expect(view.legal).toHaveLength(34)
      expect(view.finished).toBe(false)

      // 人类落子（HTTP 面路径）→ describe 即叙述文案。
      const human = await service.humanAction(session.id, mv([2, 7], [2, 8]))
      expect(human.describe).toBe('红方 营长 (2,7)→(2,8)')
      expect(human.view.turn).toBe('blue')
      expect((human.view.state as JunqiState).lastMove!.captured).toBeNull()

      // 人类回合外再落子被运行时的回合/owner 规则把守。
      await expect(service.humanAction(session.id, mv([0, 7], [1, 7]))).rejects.toThrow('请等待 AI 落子')

      // Agent 落子（工具面路径）。
      const agent = await service.agentMove(session.id, mv([2, 4], [2, 3]))
      expect(agent.describe).toBe('蓝方 营长 (2,4)→(2,3)')
      expect(agent.session.summary).toBe('蓝方 营长 (2,4)→(2,3)')
      expect(agent.view.turn).toBe('red')
      expect((agent.view.state as JunqiState).ply).toBe(2)
    } finally {
      service.dispose()
    }
  })
})
