/**
 * 内置中国象棋（提案 0018 §4.1 内置序列第三款，2026-10-14）——引擎契约与
 * 全量规则面测试。决策与边界见 decisions/2026-10-14-xiangqi-builtin.md。
 *
 * 与 games-builtin.spec.ts（井字棋/五子棋）同款契约测试风格（标准即测试）：
 * 确定性 / JSON-safe / 非法动作中文抛错 / legalActions 有界 / describe 带
 * 记谱——另加象棋专属的规则面：
 * - 七种子的几何规则逐一钉死（车滑行与吃子即止、马八向与蹩马腿、象田字与
 *   塞象眼与不过河、士/将九宫约束、炮隔一子吃与双炮架不可吃、兵卒过河横走
 *   与永不后退）；
 * - 将军检测（含将帅照面「白脸将」）、送将与照面禁令（走成照面即被拒）、
 *   将死与困毙（双终局都判负——象棋规则，与国际象棋和棋相反）；
 * - 中文象棋记谱：进/退/平、红汉字黑阿拉伯、目标端（步数 vs 目标纵线）、
 *   同纵线同兵种 前/中/后 消歧；
 * - 视图静态面（自包含 + data-game 标记 + 桥消息 + view 管线）与预览局面
 *   与引擎真实五手开局的一致性（防视图内联预览漂移）。
 *
 * 测试位置构造说明：规则面用「手工局面」直接构造 state（引擎对 state 是纯
 * 函数、不依赖历史——§3.2 契约的直接推论，也让边界局面可被精确钉死）；
 * 终局与开局链路用真实走子序列（applyAction 逐步推进）验证端到端一致性。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { manifest as xiangqiManifest, viewHtml as xiangqiViewHtml, xiangqiEngine } from '../src/games/builtin/xiangqi.js'
import { GameRegistry } from '../src/games/registry.js'
import { openGamesService } from '../src/games/service.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, smokeTestGameEngine } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Side = 'red' | 'black'

interface Pt {
  x: number
  y: number
}

interface XiangqiState {
  board: (string | null)[][]
  turn: Side
  ply: number
  lastMove: { from: Pt; to: Pt; piece: string; captured: string | null } | null
  check: boolean
  finished: boolean
  winner: Side | null
  ending: 'checkmate' | 'stalemate' | null
}

interface ApplyResult {
  state: XiangqiState
  events: string[]
  finished: boolean
  winner: Side | null
  summary: string
}

const home = mkdtempSync(join(tmpdir(), 'games-xiangqi-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const ENGINE_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'games', 'builtin', 'xiangqi.ts'), 'utf8')

/** 10 行 9 列字符画 → 棋盘（'.' 为空；大写红、小写黑）。 */
function boardOf(rows: string[]): (string | null)[][] {
  const board: (string | null)[][] = []
  for (let y = 0; y < 10; y += 1) {
    const row: (string | null)[] = []
    for (let x = 0; x < 9; x += 1) {
      const ch = rows[y]?.[x] ?? '.'
      row.push(ch === '.' ? null : ch)
    }
    board.push(row)
  }
  return board
}

/** 手工局面（引擎是纯函数：state 不依赖历史，边界局面可直接构造）。 */
function stateOf(rows: string[], turn: Side): XiangqiState {
  return {
    board: boardOf(rows),
    turn,
    ply: 0,
    lastMove: null,
    check: false,
    finished: false,
    winner: null,
    ending: null,
  }
}

function mv(from: [number, number], to: [number, number]) {
  return { type: 'move', from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } }
}

/** 棋盘 → 10 行字符画（与 boardOf 逆向，用于整盘断言）。 */
function rowsOf(state: XiangqiState): string[] {
  return state.board.map((row) => row.map((cell) => cell === null ? '.' : cell).join(''))
}

const INITIAL_ROWS = [
  'rheakaehr',
  '.........',
  '.c.....c.',
  'p.p.p.p.p',
  '.........',
  '.........',
  'P.P.P.P.P',
  '.C.....C.',
  '.........',
  'RHEAKAEHR',
]

const apply = (state: XiangqiState, action: unknown, actor?: string): ApplyResult =>
  xiangqiEngine.applyAction(state, action, actor ?? state.turn) as ApplyResult

/** 真实走子序列（交错自动取 state.turn），终局即停。 */
function play(moves: Array<[[number, number], [number, number]]>): ApplyResult {
  let state = xiangqiEngine.createGame().state as XiangqiState
  let last: ApplyResult | null = null
  for (const [from, to] of moves) {
    last = apply(state, mv(from, to))
    state = last.state
    if (state.finished) break
  }
  if (last === null) throw new Error('play() 至少需要一手棋')
  return last
}

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 red/black、engines 缺席（内置自我门控无意义）', () => {
    const check = checkGameManifest(xiangqiManifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(xiangqiManifest.id).toBe('dsh-soulmojito.xiangqi')
    expect(xiangqiManifest.name).toBe('中国象棋')
    expect(xiangqiManifest.players).toEqual({ min: 2, max: 2, roles: ['red', 'black'] })
    expect(xiangqiManifest.engines).toBeUndefined()
    expect(xiangqiManifest.actionVocabulary).toContain('move')
    expect(xiangqiManifest.actionVocabulary).toContain('from')
    expect(xiangqiManifest.actionVocabulary).toContain('to')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(xiangqiEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(xiangqiManifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(xiangqiViewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(xiangqiViewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(xiangqiViewHtml).not.toContain('fetch(')
    expect(xiangqiViewHtml).toContain('dsh-soulmojito:game-state')
    expect(xiangqiViewHtml).toContain('dsh-soulmojito:game-action')
    expect(xiangqiViewHtml).toContain('data-game="dsh-soulmojito.xiangqi"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(xiangqiViewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.xiangqi"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })

  it('将军提示层（2026-10-14 用户需求「象棋应该提供提示：如将军提示」）：警报横幅/光晕/行动指引均在视图里', () => {
    // 警报横幅：check 态独用样式与闪烁动画（优先于回合底色）。
    expect(xiangqiViewHtml).toContain('#banner.check')
    expect(xiangqiViewHtml).toContain('dt-check-flash')
    // 被将帅光晕（脉冲圈之外新增的底光晕）。
    expect(xiangqiViewHtml).toContain('check-halo')
    // 分语境文案：「你被将」与「AI 被将」两路。
    expect(xiangqiViewHtml).toContain('将军！你（')
    expect(xiangqiViewHtml).toContain('被将军了——必须解将')
    expect(xiangqiViewHtml).toContain('AI 正在解将')
    // 人类被将时的可执行指引（footer）。
    expect(xiangqiViewHtml).toContain('必须解将：移动帅/仕')
  })

  it('引擎源码不含 Math.random / Date.now（确定性是导入烟测硬约束）', () => {
    expect(ENGINE_SOURCE).not.toContain('Math.random')
    expect(ENGINE_SOURCE).not.toContain('Date.now')
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(xiangqiEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

describe('createGame 开局（§3.2）', () => {
  it('标准摆子：红先、ply 0、未终局、JSON-safe 往返、currentRoleOf 为 red', () => {
    const { state } = xiangqiEngine.createGame()
    const s = state as XiangqiState
    expect(rowsOf(s)).toEqual(INITIAL_ROWS)
    expect(s.turn).toBe('red')
    expect(s.ply).toBe(0)
    expect(s.lastMove).toBeNull()
    expect(s.check).toBe(false)
    expect(s.finished).toBe(false)
    expect(s.winner).toBeNull()
    expect(s.ending).toBeNull()
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(currentRoleOf(s, xiangqiManifest.players.roles)).toBe('red')
  })

  it('options/seed 接受但忽略（确定性游戏，带 seed 调用不抛错且同构）', () => {
    const plain = xiangqiEngine.createGame().state
    const seeded = xiangqiEngine.createGame({ seed: 42, anything: 'else' }).state
    expect(seeded).toEqual(plain)
  })
})

describe('开局走子与记谱（真实序列）', () => {
  it('中炮开局五手逐手记谱：炮二平五 / 马8进7 / 马二进三 / 车9平8 / 车一平二', () => {
    const script: Array<[[number, number], [number, number]]> = [
      [[7, 7], [4, 7]],
      [[7, 0], [6, 2]],
      [[7, 9], [6, 7]],
      [[8, 0], [7, 0]],
      [[8, 9], [7, 9]],
    ]
    const notations = ['红方 炮二平五', '黑方 马8进7', '红方 马二进三', '黑方 车9平8', '红方 车一平二']
    let state = xiangqiEngine.createGame().state as XiangqiState
    for (let i = 0; i < script.length; i += 1) {
      const [from, to] = script[i]!
      const result = apply(state, mv(from, to))
      expect(result.events[0], `第 ${i + 1} 手`).toBe(notations[i])
      expect(result.summary).toBe(notations[i])
      state = result.state
    }
    expect(state.turn).toBe('black')
    expect(state.ply).toBe(5)
  })

  it('开局五手后的局面与视图内联预览逐行一致（防预览漂移）', () => {
    const previewRows = [
      'rheakaer.',
      '.........',
      '.c....hc.',
      'p.p.p.p.p',
      '.........',
      '.........',
      'P.P.P.P.P',
      '.C..C.H..',
      '.........',
      'RHEAKAER.',
    ]
    const result = play([
      [[7, 7], [4, 7]], [[7, 0], [6, 2]], [[7, 9], [6, 7]], [[8, 0], [7, 0]], [[8, 9], [7, 9]],
    ])
    expect(rowsOf(result.state)).toEqual(previewRows)
    expect(result.state.turn).toBe('black')
    // 视图把同一局面写成字面量——逐行存在性检查（改引擎不改预览即翻红）。
    for (const row of previewRows) expect(xiangqiViewHtml).toContain(`'${row}'`)
  })

  it('普通一手：返回五字段、深拷贝不改入参、轮转黑方、lastMove 带 from/to/piece/captured', () => {
    const state = xiangqiEngine.createGame().state as XiangqiState
    const snapshot = structuredClone(state)
    const result = apply(state, mv([0, 6], [0, 5]), 'red')
    expect(Object.keys(result).sort()).toEqual(['events', 'finished', 'state', 'summary', 'winner'])
    expect(result.state.board[5]![0]).toBe('P')
    expect(result.state.board[6]![0]).toBeNull()
    expect(result.state.turn).toBe('black')
    expect(result.state.ply).toBe(1)
    expect(result.state.lastMove).toEqual({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, piece: 'P', captured: null })
    expect(result.state.check).toBe(false)
    expect(result.finished).toBe(false)
    expect(result.summary).toBe('红方 兵九进一')
    expect(state).toEqual(snapshot)
  })

  it('吃子：captured 记录被吃子、summary 带「吃掉」叙述（炮翻架打子）', () => {
    const state = stateOf([
      '....k....',
      '.........',
      '.........',
      '.p.......',
      '.........',
      '.P.......',
      '.........',
      '.C.......',
      '.........',
      '...K.....',
    ], 'red')
    const result = apply(state, mv([1, 7], [1, 3]), 'red')
    expect(result.state.board[3]![1]).toBe('C')
    expect(result.state.lastMove!.captured).toBe('p')
    expect(result.summary).toBe('红方 炮八进四，吃掉黑卒')
    expect(result.events).toEqual(['红方 炮八进四', '吃掉黑卒'])
  })
})

describe('非法动作全家族（中文抛错）', () => {
  const fresh = () => xiangqiEngine.createGame().state as XiangqiState

  it('动作形状：非对象 / 缺 type / 未知 type / resign 保留动作', () => {
    expect(() => apply(fresh(), null)).toThrow('动作必须是 JSON 对象')
    expect(() => apply(fresh(), [1, 2])).toThrow('动作必须是 JSON 对象')
    expect(() => apply(fresh(), { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } })).toThrow('动作缺少 type 字段')
    expect(() => apply(fresh(), { type: 'jump', from: { x: 0, y: 6 }, to: { x: 0, y: 5 } })).toThrow('不支持的动作类型「jump」')
    // resign 是保留动作（运行时统一处理），引擎必须拒绝而非静默。
    expect(() => apply(fresh(), { type: 'resign' })).toThrow('不支持的动作类型「resign」')
  })

  it('角色：未知角色 / 非本方回合', () => {
    expect(() => apply(fresh(), mv([0, 6], [0, 5]), 'purple')).toThrow('未知角色「purple」')
    expect(() => apply(fresh(), mv([0, 6], [0, 5]), 'black')).toThrow('现在轮到红方，black 不能走子')
  })

  it('坐标：from/to 缺失或非对象 / 非整数 / 越界 / 起终点相同', () => {
    expect(() => apply(fresh(), { type: 'move', to: { x: 0, y: 5 } })).toThrow('from 必须是 {x, y} 坐标对象')
    expect(() => apply(fresh(), { type: 'move', from: { x: 0, y: 6 } })).toThrow('to 必须是 {x, y} 坐标对象')
    expect(() => apply(fresh(), { type: 'move', from: { x: 0.5, y: 6 }, to: { x: 0, y: 5 } })).toThrow('from 坐标必须是整数')
    expect(() => apply(fresh(), { type: 'move', from: { x: '1.5', y: 6 }, to: { x: 0, y: 5 } })).toThrow('from 坐标必须是整数')
    expect(() => apply(fresh(), { type: 'move', from: { x: 'abc', y: 6 }, to: { x: 0, y: 5 } })).toThrow('from 坐标必须是整数')
    expect(() => apply(fresh(), { type: 'move', from: { x: 0, y: 6 }, to: { x: 9, y: 5 } })).toThrow('to 坐标超出棋盘')
    expect(() => apply(fresh(), { type: 'move', from: { x: 0, y: 10 }, to: { x: 0, y: 5 } })).toThrow('from 坐标超出棋盘')
    expect(() => apply(fresh(), mv([0, 6], [0, 6]))).toThrow('起点与终点相同')
  })

  it('坐标容错（2026-10-14 实弹，决策 quoted-coordinate-tolerance）：整数的字符串形态归一执行', () => {
    // 实弹形状：模型桥把工具参数数字写成引号串（x="6"），语义与数字同点。
    const result = apply(fresh(), { type: 'move', from: { x: '6', y: '6.0' }, to: { x: '6', y: '5' } })
    expect(result.summary).toBe('红方 兵三进一')
    expect(result.state.ply).toBe(1)
    // describe 与 applyAction 同一套解析：本手叙述不缺记谱（不是兜底文案）。
    expect(xiangqiEngine.describe(fresh(), 'red', { type: 'move', from: { x: '6', y: '6' }, to: { x: '6', y: '5' } }))
      .toBe('红方 兵三进一')
  })

  it('起点：空点无子 / 对方的棋子 / 终局后不能再走子', () => {
    expect(() => apply(fresh(), mv([0, 5], [0, 4]))).toThrow('起点 (0,5) 没有棋子')
    expect(() => apply(fresh(), mv([0, 3], [0, 4]))).toThrow('是黑方的卒，红方不能走对方的棋子')
    const mate = apply(stateOf([
      '....k....',
      '.........',
      'R...P....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red'), mv([0, 2], [0, 0]), 'red')
    expect(mate.finished).toBe(true)
    expect(() => apply(mate.state, mv([4, 0], [4, 1]), 'black')).toThrow('对局已结束，不能再走子')
  })

  it('几何非法：车越子 / 兵横走 / 马腿被蹩——报错文案带棋子与坐标', () => {
    expect(() => apply(fresh(), mv([0, 9], [0, 5]))).toThrow('不符合走子规则')
    expect(() => apply(fresh(), mv([0, 6], [1, 6]))).toThrow('兵从 (0,6) 不能走到 (1,6)')
    // 马(1,9)→(3,8) 的马腿 (2,9) 是己方相。
    expect(() => apply(fresh(), mv([1, 9], [3, 8]))).toThrow('马从 (1,9) 不能走到 (3,8)')
  })
})

describe('送将与将帅照面（走子后己方被将军一律拒）', () => {
  it('被将军时走无关子（不挡不消）被拒：这步棋让红方被将军', () => {
    // 黑车 (4,1) 纵线将军红帅 (4,9)；红车 (0,9) 的走子不解决将军。
    const state = stateOf([
      '...k.....',
      '....r....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      'R...K....',
    ], 'red')
    expect(() => apply(state, mv([0, 9], [0, 8]), 'red')).toThrow('被将军')
  })

  it('同一局面下挡住将军的应手合法（马(2,7)→(4,8) 填线）', () => {
    const state = stateOf([
      '...k.....',
      '....r....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '..H......',
      '.........',
      'R...K....',
    ], 'red')
    const result = apply(state, mv([2, 7], [4, 8]), 'red')
    expect(result.state.board[8]![4]).toBe('H')
    expect(result.state.turn).toBe('black')
    expect(result.state.check).toBe(false)
  })

  it('白脸将：走成将帅照面即送将被拒；保持遮挡纵线的着法合法', () => {
    const state = stateOf([
      '....k....',
      '.........',
      '.........',
      '.........',
      '....P....',
      '.........',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red')
    expect(() => apply(state, mv([4, 4], [3, 4]), 'red')).toThrow('被将军（含将帅照面')
    const result = apply(state, mv([4, 4], [4, 3]), 'red')
    expect(result.summary).toBe('红方 兵五进一')
  })

  it('黑将不能走到与红帅照面的纵线（照面视作被攻击）', () => {
    const state = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'black')
    expect(() => apply(state, mv([3, 0], [4, 0]), 'black')).toThrow('被将军')
    const result = apply(state, mv([3, 0], [3, 1]), 'black')
    expect(result.state.board[1]![3]).toBe('k')
  })
})

describe('七种子的几何规则', () => {
  it('车：滑行、遇子即止、可吃不能越', () => {
    const state = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      'p........',
      '.........',
      '.........',
      'R...K....',
    ], 'red')
    // (0,8)(0,7) 空点可到；吃到 (0,6) 黑卒为止；(0,5) 不可越。
    expect(apply(state, mv([0, 9], [0, 7]), 'red').state.board[7]![0]).toBe('R')
    const capture = apply(state, mv([0, 9], [0, 6]), 'red')
    expect(capture.state.lastMove!.captured).toBe('p')
    expect(capture.summary).toContain('吃掉黑卒')
    expect(() => apply(state, mv([0, 9], [0, 5]), 'red')).toThrow('不符合走子规则')
  })

  it('马：蹩腿方向一律拒（向上两跳）、其余方向正常', () => {
    const state = stateOf([
      '.....k...',
      '.........',
      '.........',
      '....p....',
      '....H....',
      '.........',
      '.........',
      '.........',
      '.........',
      '...K.....',
    ], 'red')
    // 马腿 (4,3) 被黑卒占据：向上两跳全被蹩。
    expect(() => apply(state, mv([4, 4], [3, 2]), 'red')).toThrow('不符合走子规则')
    expect(() => apply(state, mv([4, 4], [5, 2]), 'red')).toThrow('不符合走子规则')
    // 其余方向正常（抽样三向）。
    expect(apply(state, mv([4, 4], [2, 3]), 'red').state.board[3]![2]).toBe('H')
    expect(apply(state, mv([4, 4], [6, 5]), 'red').state.board[5]![6]).toBe('H')
    expect(apply(state, mv([4, 4], [3, 6]), 'red').state.board[6]![3]).toBe('H')
  })

  it('象：田字走、塞象眼拒、不过河拒', () => {
    const eyeState = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '...p.....',
      '..E..K...',
    ], 'red')
    // (2,9)→(4,7) 的象眼 (3,8) 被黑卒塞住。
    expect(() => apply(eyeState, mv([2, 9], [4, 7]), 'red')).toThrow('不符合走子规则')
    expect(apply(eyeState, mv([2, 9], [0, 7]), 'red').state.board[7]![0]).toBe('E')

    const halfState = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '..E......',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red')
    // 红相已到 (2,5)，再走 (0,3)/(4,3) 即过河——两向皆拒。
    expect(() => apply(halfState, mv([2, 5], [0, 3]), 'red')).toThrow('不符合走子规则')
    expect(() => apply(halfState, mv([2, 5], [4, 3]), 'red')).toThrow('不符合走子规则')
    expect(apply(halfState, mv([2, 5], [0, 7]), 'red').state.board[7]![0]).toBe('E')
  })

  it('士：斜行一步、不出九宫', () => {
    const state = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '...AK....',
    ], 'red')
    expect(() => apply(state, mv([3, 9], [2, 8]), 'red')).toThrow('不符合走子规则')
    expect(apply(state, mv([3, 9], [4, 8]), 'red').state.board[8]![4]).toBe('A')
  })

  it('将/帅：直行一步、不出九宫、不能走成照面', () => {
    const state = stateOf([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '...K.....',
    ], 'red')
    expect(() => apply(state, mv([3, 9], [2, 9]), 'red')).toThrow('不符合走子规则')
    // (3,9)→(4,9) 将走成与黑将同线照面——送将拒。
    expect(() => apply(state, mv([3, 9], [4, 9]), 'red')).toThrow('被将军')
    expect(apply(state, mv([3, 9], [3, 8]), 'red').state.board[8]![3]).toBe('K')
  })

  it('炮：无炮架不可吃、一个炮架可吃、两个炮架不可吃', () => {
    const noScreen = stateOf([
      '....k....',
      '.........',
      '.........',
      '.p.......',
      '.........',
      '.........',
      '.........',
      '.C.......',
      '.........',
      '...K.....',
    ], 'red')
    // 首个棋子就是黑卒（作架）——架后无子，不能吃。
    expect(() => apply(noScreen, mv([1, 7], [1, 3]), 'red')).toThrow('不符合走子规则')

    const oneScreen = stateOf([
      '....k....',
      '.........',
      '.........',
      '.p.......',
      '.........',
      '.P.......',
      '.........',
      '.C.......',
      '.........',
      '...K.....',
    ], 'red')
    // 红兵 (1,5) 作炮架——可吃 (1,3)。
    const capture = apply(oneScreen, mv([1, 7], [1, 3]), 'red')
    expect(capture.state.board[3]![1]).toBe('C')
    expect(capture.state.lastMove!.captured).toBe('p')

    const twoScreens = stateOf([
      '....k....',
      '.........',
      '.........',
      '.p.......',
      '.p.......',
      '.P.......',
      '.........',
      '.C.......',
      '.........',
      '...K.....',
    ], 'red')
    // 炮架 (1,5) 之后第一个子 (1,4) 可吃；(1,3) 隔两子不可吃。
    expect(() => apply(twoScreens, mv([1, 7], [1, 3]), 'red')).toThrow('不符合走子规则')
    expect(apply(twoScreens, mv([1, 7], [1, 4]), 'red').state.board[4]![1]).toBe('C')
  })

  it('兵/卒：过河前只进、过河后可横走、永不后退（红黑镜像）', () => {
    const rows = [
      '....k....',
      '.........',
      '.........',
      '....p....',
      '....P....',
      '.........',
      '....p....',
      '.........',
      '.........',
      '...K.....',
    ]
    const red = stateOf(rows, 'red')
    expect(() => apply(red, mv([4, 4], [4, 5]), 'red')).toThrow('不符合走子规则') // 后退
    expect(apply(red, mv([4, 4], [3, 4]), 'red').state.board[4]![3]).toBe('P') // 过河横走
    expect(apply(red, mv([4, 4], [4, 3]), 'red').state.lastMove!.captured).toBe('p') // 前进吃子

    const notCrossed = stateOf([
      '....k....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.P.......',
      '.........',
      '.........',
      '...K.....',
    ], 'red')
    expect(() => apply(notCrossed, mv([1, 6], [0, 6]), 'red')).toThrow('不符合走子规则')
    expect(apply(notCrossed, mv([1, 6], [1, 5]), 'red').state.board[5]![1]).toBe('P')

    const black = stateOf(rows, 'black')
    expect(() => apply(black, mv([4, 3], [3, 3]), 'black')).toThrow('不符合走子规则') // 未过河不能横走
    expect(apply(black, mv([4, 3], [4, 4]), 'black').state.lastMove!.captured).toBe('P') // 前进吃子
    expect(apply(black, mv([4, 6], [3, 6]), 'black').state.board[6]![3]).toBe('p') // 过河横走
    expect(() => apply(black, mv([4, 6], [4, 5]), 'black')).toThrow('不符合走子规则') // 后退（黑方 y 减小为退）
  })

  it('不能吃己方棋子（炮以己方子为架、目标为另一己方子）', () => {
    const state = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.P.......',
      '.........',
      '.C..K....',
    ], 'red')
    expect(() => apply(state, mv([1, 9], [1, 7]), 'red')).toThrow('不符合走子规则')
  })
})

describe('将军 / 将死 / 困毙', () => {
  it('将军：check 标记、summary 带「将军！」，且对方仍有解不终局', () => {
    const state = stateOf([
      '....k....',
      '.........',
      'R........',
      '.........',
      '.........',
      '....P....',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red')
    const result = apply(state, mv([0, 2], [0, 0]), 'red')
    expect(result.finished).toBe(false)
    expect(result.state.check).toBe(true)
    expect(result.state.turn).toBe('black')
    expect(result.events).toEqual(['红方 车九进二', '将军！'])
    expect(result.summary).toBe('红方 车九进二，将军！')
  })

  it('将死：车封底线 + 兵锁宫顶，对方无着且被将军 → checkmate、红方胜', () => {
    const state = stateOf([
      '....k....',
      '.........',
      'R...P....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red')
    const result = apply(state, mv([0, 2], [0, 0]), 'red')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect(result.state.ending).toBe('checkmate')
    expect(result.state.check).toBe(true)
    expect(result.summary).toBe('红方 车九进二，将死，红方胜')
    expect(result.events).toContain('将死')
    expect(xiangqiEngine.legalActions(result.state)).toEqual([])
  })

  it('困毙：不被将军但无任何合法着法同样判负（象棋规则，非和棋）', () => {
    const state = stateOf([
      '....k....',
      '.........',
      '..H..R...',
      '.........',
      '.........',
      '...R.....',
      '.........',
      '.........',
      '.........',
      '...K.....',
    ], 'red')
    const result = apply(state, mv([5, 2], [5, 5]), 'red')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect(result.state.ending).toBe('stalemate')
    expect(result.state.check).toBe(false)
    // 红方 y 增大方向是「退」，故此手记谱为车四退三。
    expect(result.summary).toBe('红方 车四退三，困毙，红方胜')
    expect(xiangqiEngine.legalActions(result.state)).toEqual([])
  })
})

describe('legalActions（§3.2 建议集）', () => {
  it('初始局面恰 44 步（全套合法着法），每一条都被 applyAction 原样接受', () => {
    const fresh = xiangqiEngine.createGame().state as XiangqiState
    const suggestions = xiangqiEngine.legalActions(fresh)
    expect(suggestions).toHaveLength(44)
    expect(suggestions.length).toBeLessThanOrEqual(64)
    for (const action of suggestions) {
      expect(action.type).toBe('move')
      expect(Number.isInteger(action.from.x) && Number.isInteger(action.from.y)).toBe(true)
      expect(Number.isInteger(action.to.x) && Number.isInteger(action.to.y)).toBe(true)
      // 建议集 ⊆ 终审：每一条都必须能被 applyAction 原样接受（建议集与全量
      // 校验同一份事实的直接断言）。
      const result = apply(fresh, action, fresh.turn)
      expect(result.state.board[action.to.y]![action.to.x]).not.toBeNull()
    }
  })

  it('排序确定性：两次调用 deep-equal；吃子优先（初始局面唯二吃子排最前）', () => {
    const fresh = xiangqiEngine.createGame().state as XiangqiState
    const first = xiangqiEngine.legalActions(fresh)
    expect(xiangqiEngine.legalActions(fresh)).toEqual(first)
    // 初始局面唯二的吃子：炮(1,7)→(1,0) 与 炮(7,7)→(7,0)——翻过黑炮（炮架）
    // 打黑马；炮不能吃炮架本身，故 (1,2)/(7,2) 不在吃子列。
    expect(first[0]).toEqual({ type: 'move', from: { x: 1, y: 7 }, to: { x: 1, y: 0 } })
    expect(first[1]).toEqual({ type: 'move', from: { x: 7, y: 7 }, to: { x: 7, y: 0 } })
  })

  it('中局建议集目标非己方子；终局为空数组', () => {
    const mid = play([[[7, 7], [4, 7]], [[7, 0], [6, 2]], [[7, 9], [6, 7]]]).state
    expect(mid.turn).toBe('black')
    const suggestions = xiangqiEngine.legalActions(mid)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.length).toBeLessThanOrEqual(64)
    for (const action of suggestions) {
      const target = mid.board[action.to.y]![action.to.x]
      if (target !== null) expect(target).toBe(target.toUpperCase()) // 黑方行棋，目标必为红子
    }
    const mate = apply(stateOf([
      '....k....',
      '.........',
      'R...P....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....K....',
    ], 'red'), mv([0, 2], [0, 0]), 'red')
    expect(xiangqiEngine.legalActions(mate.state)).toEqual([])
  })
})

describe('记谱（describe / events 同一套中文记谱）', () => {
  it('开局坐标系：红汉字自右向左、黑阿拉伯自右向左，进退平三态与目标端', () => {
    const fresh = xiangqiEngine.createGame().state as XiangqiState
    expect(xiangqiEngine.describe(fresh, 'red', mv([7, 7], [4, 7]))).toBe('红方 炮二平五')
    expect(xiangqiEngine.describe(fresh, 'red', mv([0, 9], [0, 8]))).toBe('红方 车九进一')
    expect(xiangqiEngine.describe(fresh, 'red', mv([1, 9], [0, 7]))).toBe('红方 马八进九')
    expect(xiangqiEngine.describe(fresh, 'red', mv([2, 9], [4, 7]))).toBe('红方 相七进五')
    expect(xiangqiEngine.describe(fresh, 'red', mv([3, 9], [4, 8]))).toBe('红方 仕六进五')
    expect(xiangqiEngine.describe(fresh, 'red', mv([4, 9], [4, 8]))).toBe('红方 帅五进一')
    expect(xiangqiEngine.describe(fresh, 'black', mv([7, 0], [6, 2]))).toBe('黑方 马8进7')
    expect(xiangqiEngine.describe(fresh, 'black', mv([1, 2], [1, 6]))).toBe('黑方 炮2进4')
    expect(xiangqiEngine.describe(fresh, 'black', mv([3, 0], [4, 1]))).toBe('黑方 士4进5')
    expect(xiangqiEngine.describe(fresh, 'black', mv([2, 3], [2, 4]))).toBe('黑方 卒3进1')
    expect(xiangqiEngine.describe(fresh, 'black', mv([0, 5], [0, 4]))).toBe('黑方的动作未被本引擎识别') // 起点无子
  })

  it('进退：马/象/士 报目标纵线、车/炮/兵/将 报步数；退与平分支', () => {
    const state = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '....E....',
      '....A....',
      '...E.K...',
    ], 'red')
    // 相(4,7)→(2,9)：退（红方 y 增大方向）报目标纵线七。
    expect(xiangqiEngine.describe(state, 'red', mv([4, 7], [2, 9]))).toBe('红方 相五退七')
    // 仕(4,8)→(3,9) 退六、仕(4,8)→(5,7) 进四。
    expect(xiangqiEngine.describe(state, 'red', mv([4, 8], [3, 9]))).toBe('红方 仕五退六')
    expect(xiangqiEngine.describe(state, 'red', mv([4, 8], [5, 7]))).toBe('红方 仕五进四')
    // 兵过河横走「平」、炮退报步数。
    const state3 = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '....P....',
      '.........',
      '.........',
      '.C.......',
      '.........',
      '....K....',
    ], 'red')
    expect(xiangqiEngine.describe(state3, 'red', mv([4, 4], [3, 4]))).toBe('红方 兵五平六')
    expect(xiangqiEngine.describe(state3, 'red', mv([1, 7], [1, 9]))).toBe('红方 炮八退二')
  })

  it('同纵线消歧：两子用前/后（红前为 y 小）、三子用前/中/后', () => {
    const two = stateOf([
      '...k.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '....P....',
      '.........',
      'R........',
      '.........',
      'R...K....',
    ], 'red')
    expect(xiangqiEngine.describe(two, 'red', mv([0, 7], [0, 6]))).toBe('红方 前车进一')
    expect(xiangqiEngine.describe(two, 'red', mv([0, 9], [0, 8]))).toBe('红方 后车进一')

    const three = stateOf([
      '...k.....',
      '.........',
      '....P....',
      '....P....',
      '....P....',
      '.........',
      '.........',
      '.........',
      '.........',
      '...K.....',
    ], 'red')
    expect(xiangqiEngine.describe(three, 'red', mv([4, 2], [4, 1]))).toBe('红方 前兵进一')
    expect(xiangqiEngine.describe(three, 'red', mv([4, 3], [4, 2]))).toBe('红方 中兵进一')
    expect(xiangqiEngine.describe(three, 'red', mv([4, 4], [3, 4]))).toBe('红方 后兵平六')
  })

  it('非 move 动作与形状不全的动作回落为「未被本引擎识别」', () => {
    const fresh = xiangqiEngine.createGame().state as XiangqiState
    expect(xiangqiEngine.describe(fresh, 'red', { type: 'resign' })).toContain('未被本引擎识别')
    expect(xiangqiEngine.describe(fresh, 'red', { type: 'move' })).toContain('未被本引擎识别')
    expect(xiangqiEngine.describe(fresh, 'red', { type: 'move', from: { x: 0, y: 5 }, to: { x: 0, y: 4 } })).toContain('未被本引擎识别')
    expect(xiangqiEngine.describe(fresh, 'black', { type: 'move', from: { x: 0, y: 5 }, to: { x: 0, y: 4 } })).toContain('未被本引擎识别')
  })
})

describe('确定性与尺寸（§3.2 硬约束）', () => {
  it('同一动作从同一状态 apply 两次 deep-equal 且入参不变', () => {
    const mid = play([[[7, 7], [4, 7]], [[7, 0], [6, 2]]]).state
    const snapshot = structuredClone(mid)
    const first = xiangqiEngine.applyAction(mid, mv([4, 7], [4, 3]), mid.turn)
    const second = xiangqiEngine.applyAction(mid, mv([4, 7], [4, 3]), mid.turn)
    expect(first).toEqual(second)
    expect(mid).toEqual(snapshot)
  })

  it('中局 state 序列化远小于 64KB', () => {
    const mid = play([
      [[7, 7], [4, 7]], [[7, 0], [6, 2]], [[7, 9], [6, 7]], [[8, 0], [7, 0]], [[8, 9], [7, 9]],
      [[2, 3], [2, 4]], [[0, 6], [0, 5]], [[1, 0], [2, 2]], [[4, 7], [4, 3]],
    ]).state
    expect(mid.ply).toBe(9)
    expect(JSON.stringify(mid).length).toBeLessThan(65536)
  })
})

describe('registry 内置源（§4.1）', () => {
  it('列出 builtin 中国象棋：source builtin、status ok、engine/view 可用', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'tavern'), hostVersion: '0.6.2' })
    const summary = registry.summaries().find((candidate) => candidate.id === 'dsh-soulmojito.xiangqi')!
    expect(summary).toBeDefined()
    expect(summary.source).toBe('builtin')
    expect(summary.status).toBe('ok')
    expect(summary.name).toBe('中国象棋')
    expect(summary.players).toEqual({ min: 2, max: 2, roles: ['red', 'black'] })
    expect(summary.actionVocabulary).toContain('move')
    const entry = registry.get('dsh-soulmojito.xiangqi')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('data-game="dsh-soulmojito.xiangqi"')
  })

  it('内置同册（按 id 稳定排序；军棋/21 点/记忆翻牌随后加入同册）', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'tavern'), hostVersion: '0.6.2' })
    expect(registry.summaries().filter((summary) => summary.source === 'builtin').map((summary) => summary.id))
      .toEqual(['dsh-soulmojito.blackjack', 'dsh-soulmojito.gomoku', 'dsh-soulmojito.junqi', 'dsh-soulmojito.memory-match', 'dsh-soulmojito.monopoly', 'dsh-soulmojito.tic-tac-toe', 'dsh-soulmojito.xiangqi'])
  })
})

describe('端到端会话（真实 GamesService，开箱可玩面）', () => {
  it('开局 → 人类炮二平五 → Agent 马8进7：视图/叙述/轮次/终审全链路', async () => {
    const service = await openGamesService({ root: join(home, 'tavern'), hostVersion: '0.6.2' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-soulmojito.xiangqi', character: 'ExampleCard', chatId: 'xq-chat' })
      expect(session.gameId).toBe('dsh-soulmojito.xiangqi')
      expect(session.players).toEqual([
        { role: 'red', owner: 'human' },
        { role: 'black', owner: 'agent' },
      ])
      expect(view.turn).toBe('red')
      expect(view.legal).toHaveLength(44)
      expect(view.finished).toBe(false)

      // 人类落子（HTTP 面路径）→ describe 即叙述文案。
      const human = await service.humanAction(session.id, mv([7, 7], [4, 7]))
      expect(human.describe).toBe('红方 炮二平五')
      expect(human.view.turn).toBe('black')
      expect((human.view.state as XiangqiState).lastMove!.captured).toBeNull()

      // 人类回合外再落子被运行时的回合/owner 规则把守。
      await expect(service.humanAction(session.id, mv([0, 6], [0, 5]))).rejects.toThrow('请等待 AI 落子')

      // Agent 落子（工具面路径）。
      const agent = await service.agentMove(session.id, mv([7, 0], [6, 2]))
      expect(agent.describe).toBe('黑方 马8进7')
      expect(agent.session.summary).toBe('黑方 马8进7')
      expect(agent.view.turn).toBe('red')
      expect((agent.view.state as XiangqiState).ply).toBe(2)
    } finally {
      service.dispose()
    }
  })

  it('实弹回归（g-54e612c8 形状）：Agent 桥把坐标写成引号串时照常落子，规则仍全量终审', async () => {
    const service = await openGamesService({ root: join(home, 'tavern'), hostVersion: '0.6.2' })
    try {
      const { session } = await service.start({ gameId: 'dsh-soulmojito.xiangqi', character: 'ExampleCard', chatId: 'xq-quoted' })
      await service.humanAction(session.id, mv([6, 6], [6, 5])) // 人类 兵三进一
      // 引号串坐标（实弹日志形状：{"x":"1"}）归一执行；describe/summary 走同一解析。
      const cannon = await service.agentMove(session.id, { type: 'move', from: { x: '1', y: '2' }, to: { x: '4', y: '2' } })
      expect(cannon.describe).toBe('黑方 炮2平5')
      await service.humanAction(session.id, mv([7, 9], [6, 7])) // 人类 马二进三
      // 容错不越规则终审：错误目标点仍报全量规则错误（实弹 seq 233 的行为）。
      await expect(service.agentMove(session.id, { type: 'move', from: { x: '1', y: '0' }, to: { x: '3', y: '2' } }))
        .rejects.toThrow('马从 (1,0) 不能走到 (3,2)')
      const horse = await service.agentMove(session.id, { type: 'move', from: { x: '1', y: '0' }, to: { x: '2', y: '2' } })
      expect(horse.describe).toBe('黑方 马2进3')
      expect(horse.session.moveCount).toBe(4)
    } finally {
      service.dispose()
    }
  })
})
