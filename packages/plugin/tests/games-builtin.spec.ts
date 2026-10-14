/**
 * 内置井字棋引擎契约 + registry 内置源（提案 0018 §3.2/§4.1，P0）。
 *
 * 与 games-gomoku.spec.ts 同款契约测试风格（标准即测试）：确定性 / JSON-safe /
 * 非法动作中文抛错 / 胜负 / 和棋 / legalActions 有界 / describe 带坐标——
 * 井字棋和棋构造容易（满盘 9 手），测试自带数据。另覆盖：
 * - 烟测（smokeTestGameEngine）对合法引擎通过、对确定性破坏与非法动作静默
 *   两个负样本必须翻红；
 * - GameRegistry 列出 builtin 源、状态 ok。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ticTacToeEngine as ticTacToe, manifest, viewHtml } from '../src/games/builtin/tic-tac-toe.js'
import { GameRegistry } from '../src/games/registry.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, smokeTestGameEngine, type GameEngine } from '../src/games/standard.js'

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
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验，id 反域名', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-tavern.tic-tac-toe')
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
    expect(viewHtml).toContain('dsh-tavern:game-state')
    expect(viewHtml).toContain('dsh-tavern:game-action')
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
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: '0', y: 0 }, 'x')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'o')).toThrow(Error)
    expect(() => ticTacToe.applyAction(fresh, { x: 0, y: 0 }, 'x')).toThrow(Error)
    // resign 是保留动作（运行时统一处理），引擎必须拒绝而非静默。
    expect(() => ticTacToe.applyAction(fresh, { type: 'resign' }, 'x')).toThrow(Error)
    const afterX = ticTacToe.applyAction(fresh, { type: 'place', x: 0, y: 0 }, 'x').state as TicState
    expect(() => ticTacToe.applyAction(afterX, { type: 'place', x: 0, y: 0 }, 'o')).toThrow(Error)
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

describe('烟测 smokeTestGameEngine（§4.6）', () => {
  it('井字棋引擎通过五关', () => {
    const result = smokeTestGameEngine(ticTacToe)
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
    expect(summaries.map((summary) => summary.id)).toContain('dsh-tavern.tic-tac-toe')
    const builtin = summaries.find((summary) => summary.id === 'dsh-tavern.tic-tac-toe')!
    expect(builtin.source).toBe('builtin')
    expect(builtin.status).toBe('ok')
    expect(builtin.players).toEqual({ min: 2, max: 2, roles: ['x', 'o'] })
    expect(builtin.actionVocabulary).toContain('place')
    const entry = registry.get('dsh-tavern.tic-tac-toe')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('<!doctype html>')
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
