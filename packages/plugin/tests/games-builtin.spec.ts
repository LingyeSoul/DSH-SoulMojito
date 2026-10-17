/**
 * 内置游戏引擎契约 + registry 内置源（提案 0018 §3.2/§4.1，P0；五子棋内置
 * 2026-10-14 回归，见 decisions/2026-10-14-gomoku-builtin.md）。
 *
 * 与 games-gomoku.spec.ts 同款契约测试风格（标准即测试）：确定性 / JSON-safe /
 * 非法动作中文抛错 / 胜负 / 和棋 / legalActions 有界 / describe 带坐标——
 * 井字棋和棋构造容易（满盘 9 手），测试自带数据；内置五子棋复用参照包的
 * 113/112 满盘和棋数据（(x + 2y) mod 5 < 3 基底，测试内先独立自校验）。
 * 另覆盖：
 * - 烟测（smokeTestGameEngine）对合法引擎通过、对确定性破坏与非法动作静默
 *   两个负样本必须翻红；
 * - GameRegistry 列出两个 builtin 源、状态 ok；
 * - 导入目录与内置同 id 的遮蔽语义（以导入副本为准 + warning 不静默）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gomokuEngine, manifest as gomokuManifest, viewHtml as gomokuViewHtml } from '../src/games/builtin/gomoku.js'
import { chineseCheckersEngine } from '../src/games/builtin/chinese-checkers.js'
import { dungeonCrawlEngine } from '../src/games/builtin/dungeon-crawl.js'
import { junqiEngine } from '../src/games/builtin/junqi.js'
import { monopolyEngine } from '../src/games/builtin/monopoly.js'
import { ticTacToeEngine as ticTacToe, manifest, viewHtml } from '../src/games/builtin/tic-tac-toe.js'
import { renderGameViewDocument } from '../src/games/view.js'
import { GameRegistry } from '../src/games/registry.js'
import { GameSessionStore } from '../src/games/sessions.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, parseBoardCoord, smokeTestGameEngine, type GameEngine } from '../src/games/standard.js'

interface TicState {
  board: number[][]
  turn: 'x' | 'o'
  ply: number
  lastMove: { x: number; y: number } | null
  finished: boolean
  winner: 'x' | 'o' | null
  winLine: Array<{ x: number; y: number }> | null
}

const home = mkdtempSync(join(tmpdir(), 'games-builtin-'))
/** 遮蔽用例独占的根：放进同 id 的坏导入目录，避免污染其他用例的干净 root。 */
const shadowHome = mkdtempSync(join(tmpdir(), 'games-builtin-shadow-'))
/** 改名兼容用例独占的根：旧命名空间对局文件写这里，不污染共享 root。 */
const legacyHome = mkdtempSync(join(tmpdir(), 'games-builtin-legacy-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(shadowHome, { recursive: true, force: true })
  rmSync(legacyHome, { recursive: true, force: true })
})

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验，id 反域名', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-soulmojito.tic-tac-toe')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(ticTacToe)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-soulmojito:game-state')
    expect(viewHtml).toContain('dsh-soulmojito:game-action')
  })
})

describe('createGame / applyAction 契约（§3.2）', () => {
  it('初始态：空盘、X 先、ply 0、未终局、JSON-safe 往返', () => {
    const { state } = ticTacToe.createGame()
    expect(state.board).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]])
    expect(state.turn).toBe('x')
    expect(state.ply).toBe(0)
    expect(state.lastMove).toBeNull()
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(state.winLine).toBeNull()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    expect(currentRoleOf(state, manifest.players.roles)).toBe('x')
  })

  it('普通一手：返回五字段、深拷贝不改入参、轮转 O', () => {
    const state = ticTacToe.createGame().state as TicState
    const snapshot = structuredClone(state)
    const result = ticTacToe.applyAction(state, { type: 'place', x: 1, y: 1 }, 'x')
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    expect(result.state.board[1]![1]).toBe(1)
    expect(result.state.turn).toBe('o')
    expect(result.state.ply).toBe(1)
    expect(result.state.lastMove).toEqual({ x: 1, y: 1 })
    expect(result.finished).toBe(false)
    expect(result.summary).toContain('B2')
    expect(state).toEqual(snapshot)
  })

  it('非法动作全部抛 Error：越界/非整数/已占/错误 actor/终局后/缺 type/未知 type（resign 含）', () => {
    const fresh = ticTacToe.createGame().state as TicState
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: -1, y: 0 }, 'x')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: 3, y: 0 }, 'x')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: 0.5, y: 0 }, 'x')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: '0.5', y: 0 }, 'x')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'o')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { x: 0, y: 0 }, 'x')).toThrow(Error)
    // resign 是保留动作（运行时统一处理），引擎必须拒绝而非静默。
    expect(() => ticTacToe.applyAction(fresh, { type: 'resign' }, 'x')).toThrow(Error)
    const afterX = ticTacToe.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'x').state as TicState
    expect(() => ticTacToe.applyAction(afterX, { type: 'place', x: 0, y: 0 }, 'o')).toThrow(Error)
  })

  it('坐标容错（2026-10-14 实弹）：整数的字符串形态归一执行（模型桥引号习惯）', () => {
    const fresh = ticTacToe.createGame().state as TicState
    const result = ticTacToe.applyAction(fresh, { type: 'place', x: '1', y: '1.0' }, 'x')
    expect((result.state as TicState).board[1]![1]).toBe(1)
    expect(result.summary).toContain('B2')
    expect(ticTacToe.describe(fresh, 'x', { type: 'place', x: '1', y: '1' })).toContain('B2')
  })
})

/** 交错走子（X 先自动轮转），终局即停；返回最后一次 applyAction 结果。 */
function play(moves: Array<[number, number]>) {
  let state = ticTacToe.createGame().state as TicState
  let last: ReturnType<GameEngine['applyAction']> | null = null
  for (const [x, y] of moves) {
    last = ticTacToe.applyAction(state, { type: 'place', x, y }, state.turn)
    state = last.state as TicState
    if (state.finished) break
  }
  if (last === null) throw new Error('play() 至少需要一手棋')
  return last
}

describe('胜负与和棋', () => {
  it('横向三连终局：winner/winLine/中文 summary', () => {
    // X: (0,0)(1,0)(2,0) 成行；O: (0,1)(1,1)。
    const result = play([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]])
    expect(result.state.finished).toBe(true)
    expect(result.winner).toBe('x')
    expect((result.state as TicState).winLine).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])
    expect(result.summary).toContain('三连')
    expect(result.summary).toContain('X胜')
  })

  it('主对角三连终局', () => {
    const result = play([[0, 0], [0, 2], [1, 1], [1, 2], [2, 2]])
    expect(result.winner).toBe('x')
    expect((result.state as TicState).winLine).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])
  })

  it('满盘 9 手和棋：finished 且 winner null', () => {
    // 无三连的满盘（X: (0,0)(0,1)(1,2)(2,0)(2,2)；O: (0,2)(1,0)(1,1)(2,1)），
    // 逐手交错且任何中间局面都不成三连（测试数据自洽）。
    const result = play([[0, 0], [0, 2], [0, 1], [1, 0], [1, 2], [1, 1], [2, 0], [2, 1], [2, 2]])
    expect(result.state.finished).toBe(true)
    expect(result.winner).toBeNull()
    expect((result.state as TicState).ply).toBe(9)
    expect(result.summary).toContain('和棋')
  })
})

describe('确定性（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变', () => {
    const base = play([[0, 0], [1, 1]]).state as TicState
    const snapshot = structuredClone(base)
    const first = ticTacToe.applyAction(base, { type: 'place', x: 2, y: 2 }, base.turn)
    const second = ticTacToe.applyAction(base, { type: 'place', x: 2, y: 2 }, base.turn)
    expect(first).toEqual(second)
    expect(base).toEqual(snapshot)
  })

  it('整局重放两次结果 deep-equal', () => {
    const moves: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]
    expect(play([...moves])).toEqual(play([...moves]))
  })
})

describe('legalActions / describe（§3.2）', () => {
  it('初始 9 点、中局递减、终局空数组', () => {
    const fresh = ticTacToe.createGame().state as TicState
    expect(ticTacToe.legalActions(fresh)).toHaveLength(9)
    const mid = play([[0, 0], [1, 1]]).state as TicState
    expect(ticTacToe.legalActions(mid)).toHaveLength(7)
    const finished = play([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]]).state as TicState
    expect(ticTacToe.legalActions(finished)).toEqual([])
  })

  it('describe 含棋子与坐标（列 A-C + 行 1-3）', () => {
    const state = ticTacToe.createGame().state as TicState
    expect(ticTacToe.describe(state, 'x', { type: 'place', x: 2, y: 1 })).toContain('C2')
    expect(ticTacToe.describe(state, 'o', { type: 'place', x: 2, y: 1 })).toContain('O')
    expect(ticTacToe.describe(state, 'x', { type: 'resign' })).toContain('未被本引擎识别')
  })
})

/* ---------------------------- 内置五子棋（2026-10-14） ---------------------------- */

interface GomokuState {
  board: number[][]
  turn: 'black' | 'white'
  ply: number
  lastMove: { x: number; y: number } | null
  finished: boolean
  winner: 'black' | 'white' | null
  winLine: Array<{ x: number; y: number }> | null
}

/** 交错走子（黑先自动轮转），终局即停；返回最后一次 applyAction 结果。 */
function playGomoku(moves: Array<[number, number]>) {
  let state = gomokuEngine.createGame().state as GomokuState
  let last: ReturnType<GameEngine['applyAction']> | null = null
  for (const [x, y] of moves) {
    last = gomokuEngine.applyAction(state, { type: 'place', x, y }, state.turn)
    state = last.state as GomokuState
    if (state.finished) break
  }
  if (last === null) throw new Error('playGomoku() 至少需要一手棋')
  return last
}

/**
 * 113 黑 / 112 白、四方向无五连的满盘局——数据来源 games-gomoku.spec.ts 的
 * (x + 2y) mod 5 < 3 基底翻 22 子方案（同一份冻结测试数据，两实现的规则
 * 一致性由各自的和棋用例独立钉死）。'1' 黑 '2' 白。
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
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (grid[y]![x] === 1) blacks.push([x, y])
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

/** 独立于引擎的五连检查（4 方向任意 5 连同色即真）——用于校验测试数据。 */
function hasFiveInARow(grid: number[][]): boolean {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const color = grid[y]![x]
      if (color === 0) continue
      for (const [dx, dy] of dirs) {
        let run = 1
        for (let k = 1; k < 5; k++) {
          const nx = x + dx! * k
          const ny = y + dy! * k
          if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15 || grid[ny]![nx] !== color) break
          run++
        }
        if (run === 5) return true
      }
    }
  }
  return false
}

describe('内置五子棋：清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验，id 反域名、engines 缺席（内置自我门控无意义）', () => {
    const check = checkGameManifest(gomokuManifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(gomokuManifest.id).toBe('dsh-soulmojito.gomoku')
    expect(gomokuManifest.name).toBe('五子棋')
    expect(gomokuManifest.players).toEqual({ min: 2, max: 2, roles: ['black', 'white'] })
    expect(gomokuManifest.engines).toBeUndefined()
    expect(gomokuManifest.actionVocabulary).toContain('place')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(gomokuEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(gomokuManifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(gomokuViewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(gomokuViewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(gomokuViewHtml).not.toContain('fetch(')
    expect(gomokuViewHtml).toContain('dsh-soulmojito:game-state')
    expect(gomokuViewHtml).toContain('dsh-soulmojito:game-action')
    expect(gomokuViewHtml).toContain('data-game="dsh-soulmojito.gomoku"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(gomokuViewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.gomoku"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })
})

describe('内置五子棋：开局与落子契约（§3.2）', () => {
  it('初始态：15×15 空盘、黑先、ply 0、未终局、JSON-safe 往返', () => {
    const { state } = gomokuEngine.createGame()
    const g = state as GomokuState
    expect(g.board).toHaveLength(15)
    for (const row of g.board) expect(row).toEqual(Array.from({ length: 15 }, () => 0))
    expect(g.turn).toBe('black')
    expect(g.ply).toBe(0)
    expect(g.lastMove).toBeNull()
    expect(g.finished).toBe(false)
    expect(g.winner).toBeNull()
    expect(g.winLine).toBeNull()
    expect(JSON.parse(JSON.stringify(g))).toEqual(g)
    expect(currentRoleOf(g, gomokuManifest.players.roles)).toBe('black')
  })

  it('普通一手：返回五字段、深拷贝不改入参、轮转白方、summary 带棋谱坐标', () => {
    const state = gomokuEngine.createGame().state as GomokuState
    const snapshot = structuredClone(state)
    const result = gomokuEngine.applyAction(state, { type: 'place', x: 7, y: 7 }, 'black')
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    const next = result.state as GomokuState
    expect(next.board[7]![7]).toBe(1)
    expect(next.turn).toBe('white')
    expect(next.ply).toBe(1)
    expect(next.lastMove).toEqual({ x: 7, y: 7 })
    expect(result.finished).toBe(false)
    expect(result.summary).toContain('H8')
    expect(state).toEqual(snapshot)
  })

  it('非法动作全部抛 Error：越界/非整数/已占/未知角色/错误 actor/终局后/缺 type/未知 type（resign 含）', () => {
    const fresh = gomokuEngine.createGame().state as GomokuState
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: -1, y: 0 }, 'black')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: 15, y: 0 }, 'black')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: 0.5, y: 0 }, 'black')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: '0x', y: 0 }, 'black')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'purple')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'white')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { x: 0, y: 0 }, 'black')).toThrow(Error)
    // resign 是保留动作（运行时统一处理），引擎必须拒绝而非静默。
    expect(() => gomokuEngine.applyAction(fresh, { type: 'resign' }, 'black')).toThrow(Error)
    expect(() => gomokuEngine.applyAction(fresh, { type: 'jump' }, 'black')).toThrow(Error)
    const afterBlack = gomokuEngine.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'black').state as GomokuState
    expect(() => gomokuEngine.applyAction(afterBlack, { type: 'place', x: 0, y: 0 }, 'white')).toThrow(Error)
  })

  it('坐标容错（2026-10-14 实弹）：整数的字符串形态归一执行（模型桥引号习惯）', () => {
    const fresh = gomokuEngine.createGame().state as GomokuState
    const result = gomokuEngine.applyAction(fresh, { type: 'place', x: '7', y: '7.0' }, 'black')
    expect((result.state as GomokuState).board[7]![7]).toBe(1)
    expect(result.summary).toContain('H8')
    expect(gomokuEngine.describe(fresh, 'black', { type: 'place', x: '7', y: '7' })).toContain('H8')
  })
})

describe('内置五子棋：胜负（自由规则 ≥5 连即胜含长连）', () => {
  it('横向五连终局：winner/winLine/中文 summary', () => {
    // 黑 (3..7,7) 成行；白 (0,0..3) 四子不成五。
    const result = playGomoku([[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3], [7, 7]])
    expect(result.state.finished).toBe(true)
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toEqual([
      { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }, { x: 6, y: 7 }, { x: 7, y: 7 },
    ])
    expect(result.summary).toContain('五连')
    expect(result.summary).toContain('黑胜')
  })

  it('竖向五连终局', () => {
    const result = playGomoku([[7, 3], [0, 0], [7, 4], [1, 0], [7, 5], [2, 0], [7, 6], [3, 0], [7, 7]])
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toEqual([
      { x: 7, y: 3 }, { x: 7, y: 4 }, { x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 },
    ])
  })

  it('主对角（↘）五连终局', () => {
    const result = playGomoku([[3, 3], [0, 0], [4, 4], [1, 0], [5, 5], [2, 0], [6, 6], [0, 1], [7, 7]])
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toEqual([
      { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 7 },
    ])
  })

  it('副对角（↗）五连终局', () => {
    const result = playGomoku([[3, 11], [0, 0], [4, 10], [1, 0], [5, 9], [2, 0], [6, 8], [0, 1], [7, 7]])
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toEqual([
      { x: 3, y: 11 }, { x: 4, y: 10 }, { x: 5, y: 9 }, { x: 6, y: 8 }, { x: 7, y: 7 },
    ])
  })

  it('长连也算胜：补中间一子连成六连，summary 用「六连」', () => {
    // 黑 (0..2,0) 与 (4..5,0) 分离、补 (3,0) 成六连——自由规则长连算胜。
    const result = playGomoku([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [0, 2], [4, 0], [1, 2], [5, 0], [0, 3], [3, 0]])
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toHaveLength(6)
    expect(result.summary).toContain('六连')
  })

  it('边界角落五连（棋盘边缘不算越界）', () => {
    const result = playGomoku([[0, 0], [0, 5], [1, 0], [1, 5], [2, 0], [2, 5], [3, 0], [3, 5], [4, 0]])
    expect(result.winner).toBe('black')
    expect((result.state as GomokuState).winLine).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
    ])
  })
})

describe('内置五子棋：和棋（225 手满盘无五连）', () => {
  it('测试数据自校验：113 黑 / 112 白且四方向无五连', () => {
    const grid = DRAW_PATTERN.map((row) => row.split('').map(Number))
    let blacks = 0
    let whites = 0
    for (const row of grid) {
      for (const cell of row) {
        if (cell === 1) blacks++
        else whites++
      }
    }
    expect(blacks).toBe(113)
    expect(whites).toBe(112)
    expect(hasFiveInARow(grid)).toBe(false)
  })

  it('225 手填满：finished 且 winner null、summary 含和棋', () => {
    const result = playGomoku(drawMoves())
    const state = result.state as GomokuState
    expect(state.finished).toBe(true)
    expect(state.winner).toBeNull()
    expect(state.ply).toBe(225)
    expect(result.summary).toContain('和棋')
  })

  it('满盘和棋局重放两次，最终结果 deep-equal', () => {
    expect(playGomoku(drawMoves())).toEqual(playGomoku(drawMoves()))
  })
})

describe('内置五子棋：确定性（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变', () => {
    const base = playGomoku([[7, 7], [7, 8], [8, 8]]).state as GomokuState
    const snapshot = structuredClone(base)
    const first = gomokuEngine.applyAction(base, { type: 'place', x: 6, y: 6 }, base.turn)
    const second = gomokuEngine.applyAction(base, { type: 'place', x: 6, y: 6 }, base.turn)
    expect(first).toEqual(second)
    expect(base).toEqual(snapshot)
  })
})

describe('内置五子棋：legalActions / describe（§3.2）', () => {
  it('空盘只有天元；中局建议集有界且落在空点；终局空数组', () => {
    const fresh = gomokuEngine.createGame().state as GomokuState
    expect(gomokuEngine.legalActions(fresh)).toEqual([{ type: 'place', x: 7, y: 7 }])
    const mid = playGomoku([[0, 0], [1, 0], [0, 1], [1, 1]]).state as GomokuState
    const suggestions = gomokuEngine.legalActions(mid)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.length).toBeLessThanOrEqual(64)
    for (const action of suggestions) expect(mid.board[action.y]![action.x]).toBe(0)
    const finished = playGomoku([[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3], [7, 7]]).state as GomokuState
    expect(gomokuEngine.legalActions(finished)).toEqual([])
  })

  it('建议集不是合法性依据：远离棋子的空点不在建议集但仍可落', () => {
    const mid = playGomoku([[0, 0], [1, 0], [0, 1], [1, 1]]).state as GomokuState
    const suggestions = gomokuEngine.legalActions(mid)
    expect(suggestions.some((action) => action.x === 14 && action.y === 14)).toBe(false)
    const result = gomokuEngine.applyAction(mid, { type: 'place', x: 14, y: 14 }, mid.turn)
    expect(result.finished).toBe(false)
    expect((result.state as GomokuState).board[14]![14]).not.toBe(0)
  })

  it('describe 含棋子与棋谱坐标（列 A-O + 行 1-15）', () => {
    const state = gomokuEngine.createGame().state as GomokuState
    expect(gomokuEngine.describe(state, 'black', { type: 'place', x: 7, y: 7 })).toContain('H8')
    expect(gomokuEngine.describe(state, 'white', { type: 'place', x: 14, y: 14 })).toContain('O15')
    expect(gomokuEngine.describe(state, 'black', { type: 'resign' })).toContain('未被本引擎识别')
  })
})

describe('烟测 smokeTestGameEngine（§4.6）', () => {
  it('井字棋引擎通过五关', () => {
    const result = smokeTestGameEngine(ticTacToe)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('五子棋引擎通过同一套五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(gomokuEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('军棋引擎通过同一套五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(junqiEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('大富翁引擎通过同一套五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(monopolyEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('地牢爬行引擎通过同一套五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(dungeonCrawlEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('中国跳棋引擎通过同一套五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(chineseCheckersEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('非确定引擎（applyAction 用 Math.random）必翻红', () => {
    const broken: GameEngine = {
      ...ticTacToe,
      applyAction(state, action, actor) {
        const base = ticTacToe.applyAction(state, action, actor)
        // 无条件扰动 summary：两次调用必不一致（不靠 50% 抽签）。
        return { ...base, summary: `${base.summary}#${Math.random()}` }
      },
    }
    const result = smokeTestGameEngine(broken)
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('确定性')
  })

  it('对非法动作静默的引擎必翻红', () => {
    const broken: GameEngine = {
      ...ticTacToe,
      applyAction(state, action, actor) {
        if (action !== null && typeof action === 'object' && (action as { type?: unknown }).type !== 'place') {
          // 违约：未知动作静默返回原局面。
          return { state, events: [], finished: false, winner: null, summary: '' }
        }
        return ticTacToe.applyAction(state, action, actor)
      },
    }
    const result = smokeTestGameEngine(broken)
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('未抛错')
  })

  it('入参可变性破坏必翻红', () => {
    const broken: GameEngine = {
      ...ticTacToe,
      applyAction(state, action, actor) {
        const result = ticTacToe.applyAction(state, action, actor)
        ;(state as TicState).turn = 'o' // 违约：直接改入参
        return result
      },
    }
    expect(smokeTestGameEngine(broken).ok).toBe(false)
  })

  it('初始建议集为空的引擎必翻红', () => {
    const broken: GameEngine = { ...ticTacToe, legalActions: () => [] }
    const result = smokeTestGameEngine(broken)
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('建议集为空')
  })
})

describe('registry 内置源（§4.1）', () => {
  it('列出 builtin 井字棋：source builtin、status ok、engine 可用', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'tavern'), hostVersion: '0.6.0' })
    const summaries = registry.summaries()
    expect(summaries.map((summary) => summary.id)).toContain('dsh-soulmojito.tic-tac-toe')
    const builtin = summaries.find((summary) => summary.id === 'dsh-soulmojito.tic-tac-toe')!
    expect(builtin.source).toBe('builtin')
    expect(builtin.status).toBe('ok')
    expect(builtin.players).toEqual({ min: 2, max: 2, roles: ['x', 'o'] })
    expect(builtin.actionVocabulary).toContain('place')
    const entry = registry.get('dsh-soulmojito.tic-tac-toe')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('<!doctype html>')
  })

  it('列出 builtin 五子棋：source builtin、status ok、engine/view 可用', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'tavern'), hostVersion: '0.6.0' })
    const summaries = registry.summaries()
    expect(summaries.filter((summary) => summary.source === 'builtin').map((summary) => summary.id))
      .toEqual(['dsh-soulmojito.blackjack', 'dsh-soulmojito.chinese-checkers', 'dsh-soulmojito.dungeon-crawl', 'dsh-soulmojito.gomoku', 'dsh-soulmojito.junqi', 'dsh-soulmojito.memory-match', 'dsh-soulmojito.monopoly', 'dsh-soulmojito.tic-tac-toe', 'dsh-soulmojito.xiangqi'])
    const gomokuSummary = summaries.find((summary) => summary.id === 'dsh-soulmojito.gomoku')!
    expect(gomokuSummary.name).toBe('五子棋')
    expect(gomokuSummary.status).toBe('ok')
    expect(gomokuSummary.players).toEqual({ min: 2, max: 2, roles: ['black', 'white'] })
    expect(gomokuSummary.actionVocabulary).toContain('place')
    const entry = registry.get('dsh-soulmojito.gomoku')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('data-game="dsh-soulmojito.gomoku"')
  })

  it('players.max !== 2 的游戏在 start 时被拒（v1 一人类一 Agent 裁剪）——校验面先验', async () => {
    // 清单校验层：roles 数与 max 不一致即拒（三人对局进不了注册表）。
    const check = checkGameManifest({
      id: 'a.b', name: 'n', version: '1.0.0',
      players: { min: 3, max: 3, roles: ['a', 'b', 'c'] },
      turnBased: true, actionVocabulary: 'x',
    })
    expect(check.ok).toBe(true) // 3 人清单本身合法（声明面）……
    // ……但 v1 会话裁剪在 sessions.start 落（games-service.spec 覆盖行为面）。
    expect(check.manifest!.players.max).toBe(3)
  })

  it('坏清单负样本：turnBased false / roles 与 max 不齐 / 反域名非法', () => {
    expect(checkGameManifest({ id: 'a.b', name: 'n', version: '1', players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: false, actionVocabulary: 'x' }).ok).toBe(false)
    expect(checkGameManifest({ id: 'a.b', name: 'n', version: '1', players: { min: 2, max: 2, roles: ['a'] }, turnBased: true, actionVocabulary: 'x' }).ok).toBe(false)
    expect(checkGameManifest({ id: 'Bad Id', name: 'n', version: '1', players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: 'x' }).ok).toBe(false)
    expect(checkGameManifest({ id: 'a.b', name: 'n', version: '1', players: { min: 2, max: 2, roles: ['a', 'b'] }, turnBased: true, actionVocabulary: '' }).ok).toBe(false)
  })
})

describe('内置五子棋：导入同 id 遮蔽内置（registry 单一遮蔽规则）', () => {
  it('导入目录与内置同 id → 以导入副本为准（broken 也遮蔽、可见）+ warning 不静默', async () => {
    mkdirSync(join(shadowHome, 'tavern', 'games', 'installed', 'dsh-soulmojito.gomoku'), { recursive: true })
    const warnings: string[] = []
    const registry = await GameRegistry.open({
      root: join(shadowHome, 'tavern'),
      hostVersion: '0.6.0',
      logger: { warn: (message: string) => { warnings.push(message) } },
    })
    const shadowed = registry.summaries().find((summary) => summary.id === 'dsh-soulmojito.gomoku')!
    expect(shadowed.source).toBe('imported')
    expect(shadowed.status).toBe('broken')
    expect(shadowed.reason).toContain('game.json 缺失或不可读')
    expect(warnings.some((message) => message.includes('与内置游戏同 id'))).toBe(true)
    // 坏游戏不断路：其余内置照常在册。
    expect(registry.summaries().some((summary) => summary.id === 'dsh-soulmojito.tic-tac-toe' && summary.status === 'ok')).toBe(true)
  })
})

describe('改名兼容：旧命名空间对局（2026-10-16 项目改名 dsh-tavern → dsh-soulmojito）', () => {
  it('registry.get 别名：旧名落空时映射到新名内置，无关旧名 id 不误配', async () => {
    const registry = await GameRegistry.open({ root: join(legacyHome, 'tavern'), hostVersion: '0.6.0' })
    expect(registry.get('dsh-tavern.gomoku')?.manifest.id).toBe('dsh-soulmojito.gomoku')
    expect(registry.get('dsh-tavern.not-installed')).toBeUndefined()
    // 直接命中路径不受影响（新名条目自身解析不变）。
    expect(registry.get('dsh-soulmojito.gomoku')?.manifest.id).toBe('dsh-soulmojito.gomoku')
  })

  it('存量对局文件 gameId 为旧名时不被判孤儿（可查看、可续弈）', async () => {
    const registry = await GameRegistry.open({ root: join(legacyHome, 'tavern'), hostVersion: '0.6.0' })
    const store = await GameSessionStore.open({ root: join(legacyHome, 'tavern'), registry: () => registry })
    const id = 'g-aaaabbbb'
    const now = new Date().toISOString()
    mkdirSync(join(legacyHome, 'tavern', 'games', 'sessions'), { recursive: true })
    writeFileSync(join(legacyHome, 'tavern', 'games', 'sessions', `${id}.json`), JSON.stringify({
      id,
      gameId: 'dsh-tavern.gomoku',
      players: [{ role: 'black', owner: 'human' }, { role: 'white', owner: 'agent' }],
      state: { turn: 'black' },
      moves: [],
      createdAt: now,
      updatedAt: now,
      chat: { character: 'ExampleCard', chatId: 'legacy-chat' },
      finished: false,
      winner: null,
      summary: '',
    }), 'utf8')
    const { session } = await store.get(id)
    expect(session.orphaned).toBe(false)
    expect(session.gameId).toBe('dsh-tavern.gomoku')
    expect(session.gameName).toBe('五子棋')
    expect(session.turn).toBe('black')
  })
})

describe('parseBoardCoord：整数/整数字符串归一（2026-10-14 实弹，决策 quoted-coordinate-tolerance）', () => {
  it('数字原样、整数的字符串形态归一、其余 null', () => {
    expect(parseBoardCoord(7)).toBe(7)
    expect(parseBoardCoord('7')).toBe(7)
    expect(parseBoardCoord(' 7 ')).toBe(7)
    expect(parseBoardCoord('+7')).toBe(7)
    expect(parseBoardCoord('07')).toBe(7)
    expect(parseBoardCoord('7.0')).toBe(7)
    expect(parseBoardCoord('7e0')).toBe(7)
    // 非整数/非数一律 null（引擎层沿用原有中文报错，不放行歧义输入）。
    expect(parseBoardCoord(7.5)).toBeNull()
    expect(parseBoardCoord('7.5')).toBeNull()
    expect(parseBoardCoord('abc')).toBeNull()
    expect(parseBoardCoord('')).toBeNull()
    expect(parseBoardCoord('   ')).toBeNull()
    expect(parseBoardCoord('0x7')).toBeNull()
    expect(parseBoardCoord(null)).toBeNull()
    expect(parseBoardCoord(undefined)).toBeNull()
    expect(parseBoardCoord(true)).toBeNull()
    expect(parseBoardCoord(NaN)).toBeNull()
    expect(parseBoardCoord(Infinity)).toBeNull()
  })
})
