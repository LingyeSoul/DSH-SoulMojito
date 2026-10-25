/**
 * 内置游戏：3×3 井字棋（提案 0018 §4.1，P0）。
 *
 * 契约来源：docs/proposals/0018-agent-game-bridge.md §3.2 引擎契约 + §3.3 视图
 * 契约——与五子棋参照包（examples/games/dsh-soulmojito.gomoku）逐条同款：JSON-safe
 * state、深拷贝、确定性（全文无随机/时间源）、非法动作中文报错、describe 带坐标、
 * 三连即胜、满盘和棋。保留动作 resign 由运行时统一处理，本引擎只实现 place。
 *
 * 裁剪说明（决策留档，代码侧标注）：提案 §4.1 原定「首发两个内置——井字棋 +
 * 五子棋」，落地裁剪为井字棋一个——examples/ 不在 package.json files 里不随包
 * 分发，五子棋已是导入示例包（P2 导入路径的参照夹具），内置再放一份是双份
 * 维护面。井字棋留下验证「内置 = 静态 import 引擎 + viewHtml 字符串常量内联
 * （mood-tracker UI_PAGE 先例）、零文件依赖、随插件分发」的装载形态。
 *
 * view.html 为内联字符串常量：自包含（无外链、无 fetch）、监听
 * dsh-soulmojito:game-state 下行、上行 dsh-soulmojito:game-action（§3.3 两条消息协议）。
 */

import { parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

const SIZE = 3
const EMPTY = 0
const CROSS = 1 // X
const NOUGHT = 2 // O
/** 建议集上限远大于棋盘（9 格），天然有界——§3.2 的 ≤64 约束自然满足。 */
const COLUMNS = 'ABC'
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]]

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。 */
/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.tic-tac-toe',
  name: '井字棋',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['x', 'o'] },
  turnBased: true,
  actionVocabulary: "落子 {type:'place', x, y}，x/y 为 0-2 整数坐标（列 A-C、行 1-3）；认输 {type:'resign'} 由运行时统一处理",
}

type Role = 'x' | 'o'

interface TicState {
  board: number[][]
  turn: Role
  ply: number
  lastMove: { x: number; y: number } | null
  finished: boolean
  winner: Role | null
  winLine: Array<{ x: number; y: number }> | null
}

function markName(role: Role): string {
  return role === 'x' ? 'X' : 'O'
}

function sideName(role: Role): string {
  return role === 'x' ? 'X 方' : 'O 方'
}

function other(role: Role): Role {
  return role === 'x' ? 'o' : 'x'
}

function isOnBoard(x: unknown, y: unknown): x is number {
  return Number.isInteger(x) && Number.isInteger(y)
    && (x as number) >= 0 && (x as number) < SIZE && (y as number) >= 0 && (y as number) < SIZE
}

function coordName(x: number, y: number): string {
  return COLUMNS[x]! + String(y + 1)
}

function cloneState(state: TicState): TicState {
  return {
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    ply: state.ply,
    lastMove: state.lastMove === null ? null : { ...state.lastMove },
    finished: state.finished,
    winner: state.winner,
    winLine: state.winLine === null ? null : state.winLine.map((cell) => ({ ...cell })),
  }
}

/** 以刚落的 (x, y) 为锚找三连（while 双向延伸——锚可以在连线端点）；
 *  返回连线坐标（按 x/y 升序，确定性输出）或 null。 */
function findWinLine(board: number[][], x: number, y: number): Array<{ x: number; y: number }> | null {
  const mark = board[y]![x]
  if (mark === EMPTY) return null
  for (const [dx, dy] of DIRECTIONS) {
    const cells = [{ x, y }]
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (isOnBoard(cx, cy) && board[cy]![cx] === mark) {
        cells.push({ x: cx, y: cy })
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (cells.length >= SIZE) {
      cells.sort((a, b) => (a.x - b.x) || (a.y - b.y))
      return cells
    }
  }
  return null
}

const engine: GameEngine = {
  meta: MANIFEST,

  /** 开局：空盘 X 先。options（含 seed）接受但忽略——井字棋无随机性。 */
  createGame(_options?: unknown): { state: TicState } {
    return {
      state: {
        board: Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => EMPTY)),
        turn: 'x',
        ply: 0,
        lastMove: null,
        finished: false,
        winner: null,
        winLine: null,
      },
    }
  },

  /** 建议集 = 全部空点（3×3 棋盘 ≤9 < 64，天然有界）；终局返回空数组。 */
  legalActions(state: TicState): Array<{ type: 'place'; x: number; y: number }> {
    if (state.finished) return []
    const actions: Array<{ type: 'place'; x: number; y: number }> = []
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (state.board[y]![x] === EMPTY) actions.push({ type: 'place', x, y })
      }
    }
    return actions
  },

  /** 落子并推进局面；校验顺序与报错纪律逐条对齐五子棋引擎。 */
  applyAction(state: TicState, action: unknown, actor: string): {
    state: TicState
    events: string[]
    finished: boolean
    winner: Role | null
    summary: string
  } {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    const typed = action as { type?: unknown; x?: unknown; y?: unknown }
    if (typeof typed.type !== 'string' || typed.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (typed.type !== 'place') {
      throw new Error(`不支持的动作类型「${typed.type}」：本引擎只实现 place（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再落子')
    }
    if (actor !== 'x' && actor !== 'o') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 x/o`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能落子`)
    }
    const x = parseBoardCoord(typed.x)
    const y = parseBoardCoord(typed.y)
    if (x === null || y === null || !isOnBoard(x, y)) {
      throw new Error(`落子坐标必须是 0-${SIZE - 1} 的整数，收到 x=${String(typed.x)}、y=${String(typed.y)}`)
    }
    if (state.board[y]![x] !== EMPTY) {
      throw new Error(`${coordName(x, y)} 已有棋子，不能落在已占格上`)
    }

    const next = cloneState(state)
    next.board[y]![x] = actor === 'x' ? CROSS : NOUGHT
    next.ply = state.ply + 1
    next.lastMove = { x, y }
    next.turn = other(actor)

    const move = `${markName(actor)}落于 ${coordName(x, y)}`
    const events = [move]
    let summary = move
    const winLine = findWinLine(next.board, x, y)
    if (winLine !== null) {
      next.finished = true
      next.winner = actor
      next.winLine = winLine
      const ending = `${markName(actor)}三连，${actor === 'x' ? 'X' : 'O'}胜`
      events.push(ending)
      summary = `${move}，${ending}`
    } else if (next.ply === SIZE * SIZE) {
      next.finished = true
      next.winner = null
      next.winLine = null
      events.push('棋盘已满，和棋')
      summary = `${move}，棋盘已满，和棋`
    }
    return { state: next, events, finished: next.finished, winner: next.winner, summary }
  },

  /** 人类可读的一手棋描述（含列 A-C + 行 1-3 坐标）。 */
  describe(_state: TicState, actor: string, action: unknown): string {
    if (
      action !== null && typeof action === 'object' && !Array.isArray(action)
      && (action as { type?: unknown }).type === 'place'
    ) {
      const x = parseBoardCoord((action as { x?: unknown }).x)
      const y = parseBoardCoord((action as { y?: unknown }).y)
      if (x !== null && y !== null && isOnBoard(x, y)) {
        return `${markName(actor === 'o' ? 'o' : 'x')}落于 ${coordName(x, y)}`
      }
    }
    return `${String(actor)}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as ticTacToeEngine }

/** 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>井字棋 · dsh-soulmojito 游戏桥</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    background: #171a20; color: #e8e4da;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
  }
  header { width: 100%; max-width: 320px; display: flex; justify-content: space-between; font-size: 14px; padding-bottom: 8px; }
  .session-id { color: #9a948a; font-size: 11px; font-variant-numeric: tabular-nums; }
  #banner { width: 100%; max-width: 320px; border: 1px solid #3a3f4a; background: #22262e; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; text-align: center; margin-bottom: 10px; }
  #board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; width: 100%; max-width: 320px; }
  .cell {
    aspect-ratio: 1; border-radius: 8px; background: #20242c; border: 1px solid #333945;
    display: flex; align-items: center; justify-content: center;
    font-size: 34px; font-weight: 700; user-select: none;
  }
  .cell.x { color: #7fb2ff; }
  .cell.o { color: #ffb27f; }
  .cell.playable { cursor: pointer; }
  .cell.playable:hover { background: #2a3140; }
  .cell.last { outline: 2px solid #8a6d2f; }
  footer { margin-top: 10px; font-size: 11px; color: #8d887e; text-align: center; width: 100%; max-width: 320px; }
</style>
</head>
<body>
<header><span>井字棋</span><span class="session-id" id="session-id"></span></header>
<div id="banner">等待对局…</div>
<div id="board"></div>
<footer>轮到你时点击空格落子；坐标为列 A-C、行 1-3。</footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账）、
   上行 dsh-soulmojito:game-action。token 从 location.search 自读（服务端注入的
   桥脚本与宿主 GameSurface 都按同一纪律）。无 token 时渲染静态预览。 */
var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var board = document.getElementById('board')
var banner = document.getElementById('banner')
var current = null

function render(view, session) {
  current = view
  document.getElementById('session-id').textContent = session ? session.id : ''
  var state = view.state
  var legal = {}
  for (var i = 0; i < (view.legal || []).length; i += 1) {
    var a = view.legal[i]
    legal[a.x + ',' + a.y] = true
  }
  board.innerHTML = ''
  for (var y = 0; y < 3; y += 1) {
    for (var x = 0; x < 3; x += 1) {
      var cell = document.createElement('div')
      var mark = state.board[y][x]
      cell.className = 'cell' + (mark === 1 ? ' x' : mark === 2 ? ' o' : '')
      cell.textContent = mark === 1 ? 'X' : mark === 2 ? 'O' : ''
      if (state.lastMove && state.lastMove.x === x && state.lastMove.y === y) cell.className += ' last'
      if (!view.finished && legal[x + ',' + y]) {
        cell.className += ' playable'
        ;(function (cx, cy) {
          cell.addEventListener('click', function () {
            parent.postMessage({ type: 'dsh-soulmojito:game-action', token: TOKEN, action: { type: 'place', x: cx, y: cy } }, '*')
          })
        })(x, y)
      }
      board.appendChild(cell)
    }
  }
  banner.textContent = view.finished
    ? (view.summary || '对局结束')
    : (view.turn === 'x' ? '轮到 X' : '轮到 O') + (view.summary ? ' · ' + view.summary : '')
}

addEventListener('message', function (event) {
  var data = event.data
  if (!data || data.type !== 'dsh-soulmojito:game-state' || data.token !== TOKEN) return
  render(data.view, data.session)
})

if (!TOKEN) {
  render({ state: { board: [[1, 2, 0], [2, 1, 0], [0, 0, 0]], turn: 'o', lastMove: null },
    legal: [{ type: 'place', x: 2, y: 0 }], finished: false, summary: '静态预览（无 token）' }, null)
}
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const ticTacToe = { manifest, engine, viewHtml } as const
