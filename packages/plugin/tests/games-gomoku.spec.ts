/**
 * 提案 0018（Agent 游戏桥）§3 标准契约的一致性测试——第一个参照实现
 * packages/plugin/examples/games/dsh-tavern.gomoku（五子棋标准游戏包）。
 *
 * 本套件是提案 §8「标准即测试」的先例：不依赖尚未实现的 src/games/ 运行时，
 * 用 pathToFileURL 直接动态导入游戏包引擎、readFileSync 读取清单与视图，对
 * 三件套（game.json / engine.mjs / view.html）做静态 + 行为断言：
 * - 清单形状（§3.1）与 engine.meta 冗余一致性（§6 运行时以 meta 为准）；
 * - createGame 初始态与 JSON-safe（§3.2 硬约束）；
 * - applyAction 纯函数、确定性、非法动作中文报错、胜负判定（自由五子棋 ≥5 连即胜）、和棋；
 * - legalActions 有界建议集语义（≤64、空盘天元、建议集之外仍可落）；
 * - describe 人类可读坐标；state 64KB 上限（§3.2）；
 * - view.html 自包含（§3.3 mod CSP 纪律：无外链资源）与两条桥消息类型。
 *
 * 测试数据说明（和棋局）：任务原定的「棋盘格交错排布」在自由五子棋规则下不成立——
 * 棋盘格的对角线同色（(0,0)..(4,4) 全黑），扫描序第 65 手就以主对角五连终局。
 * 这里用 (x + 2y) mod 5 < 3 基底（四个方向步长 mod 5 均非零 ⇒ 任意连续 5 格恰含
 * 全部余数、3 黑 2 白，天然无五连）翻 22 黑为白，得到恰好 113 黑 / 112 白的满盘局；
 * 测试内先独立自校验（计数 + 无五连）再走子，保证测试数据自洽。
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const GAME_DIR = join(import.meta.dirname, '..', 'examples', 'games', 'dsh-tavern.gomoku')
const manifest = JSON.parse(readFileSync(join(GAME_DIR, 'game.json'), 'utf8')) as Record<string, unknown>
const viewHtml = readFileSync(join(GAME_DIR, 'view.html'), 'utf8')
const engineSource = readFileSync(join(GAME_DIR, 'engine.mjs'), 'utf8')

type Role = 'black' | 'white'
interface Pt {
  x: number
  y: number
}
interface GomokuState {
  board: number[][]
  turn: Role
  ply: number
  lastMove: Pt | null
  finished: boolean
  winner: Role | null
  winLine: Pt[] | null
}
interface PlaceAction {
  type: 'place'
  x: number
  y: number
}
interface ApplyResult {
  state: GomokuState
  events: string[]
  finished: boolean
  winner: Role | null
  summary: string
}
interface GameEngine {
  meta: Record<string, unknown>
  createGame(options?: unknown): { state: GomokuState }
  legalActions(state: GomokuState): PlaceAction[]
  applyAction(state: GomokuState, action: unknown, actor: string): ApplyResult
  describe(state: GomokuState, actor: string, action: unknown): string
}

const engine = (await import(pathToFileURL(join(GAME_DIR, 'engine.mjs')).href)).default as GameEngine

const SIZE = 15

/** 交错走子（黑先自动轮转），终局即停；返回最后一次 applyAction 的完整结果。 */
function play(moves: Array<[number, number]>): ApplyResult {
  let state = engine.createGame().state
  let last: ApplyResult | null = null
  for (const [x, y] of moves) {
    last = engine.applyAction(state, { type: 'place', x, y }, state.turn)
    state = last.state
    if (state.finished) break
  }
  if (!last) throw new Error('play() 至少需要一手棋')
  return last
}

/** 独立于引擎的五连检查（4 方向任意 5 连同色即真）——用于校验测试数据，不复用被测代码。 */
function hasFiveInARow(grid: number[][]): boolean {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const color = grid[y][x]
      if (color === 0) continue
      for (const [dx, dy] of dirs) {
        let run = 1
        for (let k = 1; k < 5; k++) {
          const nx = x + dx * k
          const ny = y + dy * k
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || grid[ny][nx] !== color) break
          run++
        }
        if (run === 5) return true
      }
    }
  }
  return false
}

/**
 * 113 黑 / 112 白、四方向无五连的满盘局（构造见文件头）。'1' 黑 '2' 白。
 * 黑白按扫描序各自排队后交错走出（b,w,b,w,...,b），225 手填满成和。
 */
const DRAW_PATTERN = [
  '111221122212122',
  '122111221112212',
  '211222211221112',
  '122212122121221',
  '221112211122111',
  '122221212211222',
  '222112221112211',
  '212122111221112',
  '112211122111221',
  '221112211122111',
  '211221112211122',
  '122112222112212',
  '211122111222112',
  '112212122111221',
  '221112221122111',
]

function drawMoves(): Array<[number, number]> {
  const grid = DRAW_PATTERN.map((row) => row.split('').map(Number))
  const blacks: Array<[number, number]> = []
  const whites: Array<[number, number]> = []
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] === 1) blacks.push([x, y])
      else whites.push([x, y])
    }
  }
  const moves: Array<[number, number]> = []
  for (let i = 0; i < blacks.length; i++) {
    moves.push(blacks[i]!)
    if (whites[i]) moves.push(whites[i]!)
  }
  return moves
}

describe('清单 game.json（提案 0018 §3.1）', () => {
  it('可解析、id 与目录名一致（dsh-tavern.xxx 反域名纪律）', () => {
    expect(manifest.id).toBe('dsh-tavern.gomoku')
    // 目录名即包名：装载目录名与清单 id 必须一致（镜像 mod.json 纪律）
    expect(basename(GAME_DIR)).toBe(manifest.id)
  })

  it('必填字段齐全且形状正确', () => {
    expect(manifest.name).toBe('五子棋')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.engines).toEqual({ 'dsh-tavern': '^0.6.0' })
    expect(typeof manifest.actionVocabulary).toBe('string')
    expect((manifest.actionVocabulary as string).length).toBeGreaterThan(0)
    expect((manifest.actionVocabulary as string)).toContain('place')
  })

  it('turnBased 为 true 且 players 为 2/2 双角色 black/white', () => {
    expect(manifest.turnBased).toBe(true)
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['black', 'white'] })
  })

  it('engine.meta 与清单冗余字段一致（提案 §6：运行时以 meta 为准）', () => {
    for (const key of ['id', 'name', 'version', 'engines', 'players', 'turnBased', 'actionVocabulary']) {
      expect(engine.meta[key], `meta.${key}`).toEqual(manifest[key])
    }
  })
})

describe('createGame（§3.2 开局）', () => {
  it('返回 { state } 形态，初始态为空盘、黑先、ply 0、未终局', () => {
    const created = engine.createGame()
    expect(Object.keys(created).sort()).toEqual(['state'])
    const state = created.state
    expect(state.board).toHaveLength(15)
    for (const row of state.board) {
      expect(row).toHaveLength(15)
      expect(row.every((cell) => cell === 0)).toBe(true)
    }
    expect(state.turn).toBe('black')
    expect(state.ply).toBe(0)
    expect(state.lastMove).toBeNull()
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(state.winLine).toBeNull()
  })

  it('初始态 JSON-safe：JSON.parse(JSON.stringify) 往返 deep-equal', () => {
    const { state } = engine.createGame()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('options/seed 接受但忽略（确定性游戏，带 seed 调用不抛错且同构）', () => {
    const plain = engine.createGame().state
    const seeded = engine.createGame({ seed: 42, anything: 'else' }).state
    expect(seeded).toEqual(plain)
  })
})

describe('applyAction 契约（§3.2 纯函数 + 合法性终审）', () => {
  it('返回 { state, events, finished, winner, summary }，普通一手 events/summary 为中文', () => {
    const fresh = engine.createGame().state
    const result = engine.applyAction(fresh, { type: 'place', x: 7, y: 7 }, 'black')
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toContain('H8')
    expect(result.summary).toContain('H8')
    expect(result.finished).toBe(false)
    expect(result.winner).toBeNull()
    expect(result.state.board[7]![7]).toBe(1)
    expect(result.state.turn).toBe('white')
    expect(result.state.ply).toBe(1)
    expect(result.state.lastMove).toEqual({ x: 7, y: 7 })
  })

  it('绝不改入参 state：深拷贝出新态', () => {
    const state = engine.createGame().state
    const before = structuredClone(state)
    engine.applyAction(state, { type: 'place', x: 7, y: 7 }, 'black')
    expect(state).toEqual(before)
  })

  it('非法动作全部抛 Error：越界 / 非整数 / 已占点 / 错误 actor / 终局后 / 缺 type / 未知 type', () => {
    const fresh = engine.createGame().state
    // 越界
    expect(() => engine.applyAction(fresh, { type: 'place', x: -1, y: 7 }, 'black')).toThrow(Error)
    expect(() => engine.applyAction(fresh, { type: 'place', x: 15, y: 7 }, 'black')).toThrow(Error)
    expect(() => engine.applyAction(fresh, { type: 'place', x: 7, y: -1 }, 'black')).toThrow(Error)
    expect(() => engine.applyAction(fresh, { type: 'place', x: 7, y: 15 }, 'black')).toThrow(Error)
    // 非整数（数字与数字小数字符串一律拒；整数字符串容错见下一条用例）
    expect(() => engine.applyAction(fresh, { type: 'place', x: 7.5, y: 7 }, 'black')).toThrow(Error)
    expect(() => engine.applyAction(fresh, { type: 'place', x: '7.5', y: 7 }, 'black')).toThrow(Error)
    // 错误 actor：黑先时传 white
    expect(() => engine.applyAction(fresh, { type: 'place', x: 7, y: 7 }, 'white')).toThrow(Error)
    // 缺 type 字段
    expect(() => engine.applyAction(fresh, { x: 7, y: 7 }, 'black')).toThrow(Error)
    // 未知 type（resign 是保留动作，由运行时处理，引擎必须拒绝而非静默）
    expect(() => engine.applyAction(fresh, { type: 'resign' }, 'black')).toThrow(Error)
    // 已占点（黑落 (3,3) 后轮白，白再落同点）
    const afterBlack = engine.applyAction(fresh, { type: 'place', x: 3, y: 3 }, 'black').state
    expect(() => engine.applyAction(afterBlack, { type: 'place', x: 3, y: 3 }, 'white')).toThrow(Error)
    // 终局后再落子
    const finished = play([[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3], [7, 7]]).state
    expect(finished.finished).toBe(true)
    expect(() => engine.applyAction(finished, { type: 'place', x: 14, y: 14 }, finished.turn)).toThrow(Error)
  })

  it('坐标容错（2026-10-14 实弹，决策 quoted-coordinate-tolerance）：整数的字符串形态归一执行', () => {
    const fresh = engine.createGame().state
    // 实弹形状：模型桥把工具参数数字写成引号串；归一是同点同义，不改动作语义。
    const result = engine.applyAction(fresh, { type: 'place', x: '7', y: '7.0' }, 'black')
    expect(result.summary).toContain('H8')
    // describe 与 applyAction 同一套解析：历史叙述不缺坐标。
    expect(engine.describe(fresh, 'black', { type: 'place', x: '7', y: '7' })).toContain('H8')
  })
})

describe('胜负判定（自由五子棋：≥5 连即胜，含长连）', () => {
  it('横向恰好五连终局，winner/winLine 正确、summary 中文', () => {
    const result = play([[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3], [7, 7]])
    expect(result.state.finished).toBe(true)
    expect(result.finished).toBe(true)
    expect(result.state.winner).toBe('black')
    expect(result.winner).toBe('black')
    expect(result.state.winLine).toEqual([
      { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }, { x: 6, y: 7 }, { x: 7, y: 7 },
    ])
    expect(result.summary).toContain('黑胜')
    expect(result.summary).toContain('五连')
    expect(result.events.some((e) => e.includes('五连'))).toBe(true)
  })

  it('纵向五连终局', () => {
    const result = play([[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3], [7, 7]])
    expect(result.state.winner).toBe('black')
    expect(result.state.winLine).toEqual([
      { x: 7, y: 3 }, { x: 7, y: 4 }, { x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 },
    ])
  })

  it('主对角（↘）五连终局', () => {
    const result = play([[3, 3], [0, 0], [4, 4], [0, 1], [5, 5], [0, 2], [6, 6], [0, 3], [7, 7]])
    expect(result.state.winner).toBe('black')
    expect(result.state.winLine).toEqual([
      { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 7 },
    ])
  })

  it('副对角（↗）五连终局', () => {
    const result = play([[3, 11], [0, 0], [4, 10], [0, 1], [5, 9], [0, 2], [6, 8], [0, 3], [7, 7]])
    expect(result.state.winner).toBe('black')
    expect(result.state.winLine).toEqual([
      { x: 3, y: 11 }, { x: 4, y: 10 }, { x: 5, y: 9 }, { x: 6, y: 8 }, { x: 7, y: 7 },
    ])
  })

  it('六连（长连）同样获胜，winLine 给出全部 6 点', () => {
    // 黑先在 (3,7)(4,7) 与 (6,7)(7,7)(8,7) 布下 2+3 两段（各段均 <5 不胜），
    // 最后一手 (5,7) 一子双连成 6 连——自由规则下长连即胜。
    const result = play([
      [3, 7], [0, 0], [4, 7], [0, 1], [6, 7], [0, 2], [7, 7], [0, 3], [8, 7], [14, 14], [5, 7],
    ])
    expect(result.state.finished).toBe(true)
    expect(result.state.winner).toBe('black')
    expect(result.state.winLine).toEqual([
      { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }, { x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 },
    ])
    expect(result.summary).toContain('六连')
  })
})

describe('和棋（满盘无五连）', () => {
  it('测试数据自校验：113 黑 / 112 白且四方向无五连', () => {
    expect(DRAW_PATTERN).toHaveLength(15)
    const grid = DRAW_PATTERN.map((row) => row.split('').map(Number))
    const blacks = grid.flat().filter((c) => c === 1).length
    const whites = grid.flat().filter((c) => c === 2).length
    expect(blacks).toBe(113)
    expect(whites).toBe(112)
    expect(hasFiveInARow(grid)).toBe(false)
  })

  it('225 手交错填满 → finished 且 winner 为 null', () => {
    const moves = drawMoves()
    expect(moves).toHaveLength(225)
    const result = play(moves)
    expect(result.state.finished).toBe(true)
    expect(result.state.winner).toBeNull()
    expect(result.state.ply).toBe(225)
    expect(result.state.winLine).toBeNull()
    expect(result.summary).toContain('和棋')
  })
})

describe('确定性（§3.2 硬约束：同输入必同输出）', () => {
  it('同一动作从同一状态 apply 两次，结果 deep-equal 且入参不变', () => {
    const base = play([[7, 7], [0, 0], [8, 8], [0, 1]]).state
    const snapshot = structuredClone(base)
    const first = engine.applyAction(base, { type: 'place', x: 9, y: 9 }, base.turn)
    const second = engine.applyAction(base, { type: 'place', x: 9, y: 9 }, base.turn)
    expect(first).toEqual(second)
    expect(base).toEqual(snapshot)
  })

  it('扫描序交错填盘重放两次最终态 deep-equal（第 61 手副对角五连提前终局）', () => {
    // 棋盘格的对角线同色：扫描序（y 外层、x 内层，先黑后白）下，副对角 x+y=4 的
    // (0,4)(1,3)(2,2)(3,1)(4,0) 全为黑（idx 60/46/32/18/4 均为偶），第 61 手落
    // (0,4) 即五连终局——这正是和棋局不能直接用扫描序/棋盘格排布的原因。
    const scanMoves = (): Array<[number, number]> => {
      const moves: Array<[number, number]> = []
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) moves.push([x, y])
      }
      return moves
    }
    const first = play(scanMoves())
    expect(first.state.finished).toBe(true)
    expect(first.state.ply).toBe(61)
    expect(first.state.winner).toBe('black')
    expect(first.state.winLine).toEqual([
      { x: 0, y: 4 }, { x: 1, y: 3 }, { x: 2, y: 2 }, { x: 3, y: 1 }, { x: 4, y: 0 },
    ])
    const second = play(scanMoves())
    expect(second).toEqual(first)
  })

  it('225 手满盘和棋局重放两次，最终结果 deep-equal', () => {
    const first = play(drawMoves())
    const second = play(drawMoves())
    expect(second).toEqual(first)
  })

  it('引擎源码不含 Math.random / Date.now（确定性是导入烟测硬约束）', () => {
    expect(engineSource).not.toContain('Math.random')
    expect(engineSource).not.toContain('Date.now')
  })
})

describe('legalActions（§3.2 有界建议集）', () => {
  it('空盘恰返回天元一点', () => {
    const { state } = engine.createGame()
    expect(engine.legalActions(state)).toEqual([{ type: 'place', x: 7, y: 7 }])
  })

  it('若干手后：≤64、全部为界内空点、距既有棋子切比雪夫距离 ≤2', () => {
    // 9 手中局（黑 5 白 4，无五连——避开终局态）
    const state = play([[7, 7], [0, 0], [8, 8], [0, 1], [9, 9], [0, 2], [6, 6], [0, 3], [5, 6]]).state
    const actions = engine.legalActions(state)
    expect(actions.length).toBeGreaterThanOrEqual(1)
    expect(actions.length).toBeLessThanOrEqual(64)
    const stones: Array<[number, number]> = []
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (state.board[y]![x] !== 0) stones.push([x, y])
      }
    }
    expect(stones.length).toBe(9)
    for (const action of actions) {
      expect(action.type).toBe('place')
      expect(Number.isInteger(action.x)).toBe(true)
      expect(Number.isInteger(action.y)).toBe(true)
      expect(action.x).toBeGreaterThanOrEqual(0)
      expect(action.x).toBeLessThanOrEqual(14)
      expect(action.y).toBeGreaterThanOrEqual(0)
      expect(action.y).toBeLessThanOrEqual(14)
      expect(state.board[action.y]![action.x]).toBe(0)
      const cheb = Math.min(...stones.map(([sx, sy]) =>
        Math.max(Math.abs(sx - action.x), Math.abs(sy - action.y))))
      expect(cheb).toBeLessThanOrEqual(2)
    }
  })

  it('建议集之外的空点同样合法（applyAction 按全量规则校验任意空点）', () => {
    // 黑占天元后，(0,0) 距既有棋子切比雪夫距离 7，不在建议集内，但白可以直接落。
    const state = engine.applyAction(engine.createGame().state, { type: 'place', x: 7, y: 7 }, 'black').state
    const actions = engine.legalActions(state)
    expect(actions.some((a) => a.x === 0 && a.y === 0)).toBe(false)
    const result = engine.applyAction(state, { type: 'place', x: 0, y: 0 }, 'white')
    expect(result.state.board[0]![0]).toBe(2)
    expect(result.finished).toBe(false)
  })

  it('终局返回空数组', () => {
    const finished = play([[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3], [7, 7]]).state
    expect(engine.legalActions(finished)).toEqual([])
  })
})

describe('describe（§3.2 人类可读的一手棋描述）', () => {
  it('黑 / 白各返回含列字母与行号的非空中文串', () => {
    const { state } = engine.createGame()
    const blackText = engine.describe(state, 'black', { type: 'place', x: 7, y: 7 })
    expect(typeof blackText).toBe('string')
    expect(blackText.length).toBeGreaterThan(0)
    expect(blackText).toContain('黑')
    expect(blackText).toContain('H')
    expect(blackText).toContain('8')

    const whiteText = engine.describe(state, 'white', { type: 'place', x: 0, y: 14 })
    expect(whiteText.length).toBeGreaterThan(0)
    expect(whiteText).toContain('白')
    expect(whiteText).toContain('A')
    expect(whiteText).toContain('15')
  })
})

describe('尺寸上限（§3.2 state 序列化 ≤64KB）', () => {
  it('中局 state JSON.stringify 长度 < 65536', () => {
    const moves = drawMoves().slice(0, 120) // 120 手的中局
    const state = play(moves).state
    expect(state.ply).toBe(120)
    expect(JSON.stringify(state).length).toBeLessThan(65536)
  })
})

describe('view.html 静态检查（§3.3 自包含 / §4.6 导入烟测）', () => {
  it('不含外链资源与网络调用（mod CSP 纪律同款）', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
  })

  it('包含 dsh-tavern:game-state 与 dsh-tavern:game-action 桥消息类型', () => {
    expect(viewHtml).toContain('dsh-tavern:game-state')
    expect(viewHtml).toContain('dsh-tavern:game-action')
  })
})
