/**
 * 内置游戏：15×15 五子棋（提案 0018 §4.1「井字棋 + 五子棋」双内置的回归，
 * 2026-10-14——原裁剪为「井字棋一个」的理由是 examples/ 不随包分发、五子棋
 * 已是导入参照包（双份维护面），由用户需求「内置五子棋」重新裁定；决策与
 * 边界见 decisions/2026-10-14-gomoku-builtin.md）。
 *
 * 契约来源：§3.2 引擎契约 + §3.3 视图契约——与 builtin/tic-tac-toe.ts 同款
 * 形态：静态 import 的 TS 引擎 + viewHtml 字符串常量内联（mood-tracker
 * UI_PAGE 先例），零文件依赖、随插件分发。规则与参照包
 * （examples/games/dsh-soulmojito.gomoku）逐条同款：自由五子棋（任意方向 ≥5 连
 * 即胜，长连也算胜；连珠禁手不实现）、15×15、黑先；保留动作 resign 由运行时
 * 统一处理（引擎收到一律抛错）。
 *
 * 同 id 语义：本内置 id 与参照包相同（'dsh-soulmojito.gomoku'）——导入参照包会
 * 以磁盘副本接管同 id 槽位（registry「以磁盘上可审计的导入副本为准」纪律），
 * 装载期由 registry 记 warning 提示遮蔽。
 *
 * 确定性：全文无随机/时间源（createGame 的 options/seed 接受但忽略）。
 * legalActions 是有界**建议集**（≤64：空盘只有天元；之后取与既有棋子切比雪夫
 * 距离 ≤2 的空点按邻居加权打分截断），不是合法性依据——applyAction 按全量
 * 规则终审任意空点（§3.2/§9 摩擦 3）。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面；人类回合才启用
 * 点击与建议点提示（AI 回合等待落子自动出现，避免无谓 409）。
 */

import { parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

const SIZE = 15
const EMPTY = 0
const BLACK = 1
const WHITE = 2
/** 建议集上限（§3.2：≤64）。 */
const MAX_CANDIDATES = 64
/** 棋谱列名（A-O），同时用于 describe 的坐标文本。 */
const COLUMNS = 'ABCDEFGHIJKLMNO'
/** 胜利连珠长度的中文数字（自由规则下长连 6-15 都可能出现）。 */
const CN_NUMERALS: Record<number, string> = {
  5: '五', 6: '六', 7: '七', 8: '八', 9: '九',
  10: '十', 11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五',
}
/** 胜负判定的四个方向：横、竖、主对角（↘）、副对角（↗）。 */
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.gomoku',
  name: '五子棋',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['black', 'white'] },
  turnBased: true,
  actionVocabulary: "落子 {type:'place', x, y}，x/y 为 0-14 整数坐标（列 A-O、行 1-15）；认输 {type:'resign'} 由运行时统一处理",
}

type Role = 'black' | 'white'

interface Point {
  x: number
  y: number
}

interface GomokuState {
  board: number[][]
  turn: Role
  ply: number
  lastMove: Point | null
  finished: boolean
  winner: Role | null
  winLine: Point[] | null
}

/** 坐标 → 棋谱记法，如 (7,7) → 'H8'。 */
function coordName(x: number, y: number): string {
  return COLUMNS[x]! + String(y + 1)
}

function stoneName(role: Role): string {
  return role === 'black' ? '黑棋' : '白棋'
}

function sideName(role: Role): string {
  return role === 'black' ? '黑方' : '白方'
}

function other(role: Role): Role {
  return role === 'black' ? 'white' : 'black'
}

function isOnBoard(x: unknown, y: unknown): boolean {
  return Number.isInteger(x) && Number.isInteger(y)
    && (x as number) >= 0 && (x as number) < SIZE && (y as number) >= 0 && (y as number) < SIZE
}

/** 深拷贝 state（board 逐行、lastMove/winLine 逐点），绝不共享可变结构。 */
function cloneState(state: GomokuState): GomokuState {
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

/** 以刚落的 (x, y) 为锚，找出过该点的 ≥5 连（自由规则：长连也算）。
 *  双向 while 延伸（锚可以在连线端点）；返回连珠坐标（按 x/y 升序，确定性
 *  输出）或 null。 */
function findWinLine(board: number[][], x: number, y: number): Point[] | null {
  const stone = board[y]![x]
  if (stone === EMPTY) return null
  for (const [dx, dy] of DIRECTIONS) {
    const cells: Point[] = [{ x, y }]
    for (const sign of [1, -1]) {
      let cx = x + dx! * sign
      let cy = y + dy! * sign
      while (isOnBoard(cx, cy) && board[cy]![cx] === stone) {
        cells.push({ x: cx, y: cy })
        cx += dx! * sign
        cy += dy! * sign
      }
    }
    if (cells.length >= 5) {
      cells.sort((a, b) => (a.x - b.x) || (a.y - b.y))
      return cells
    }
  }
  return null
}

const engine: GameEngine = {
  meta: MANIFEST,

  /** 开局：空盘黑先。options（含 seed）接受但忽略——五子棋无随机性。 */
  createGame(_options?: unknown): { state: GomokuState } {
    return {
      state: {
        board: Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => EMPTY)),
        turn: 'black',
        ply: 0,
        lastMove: null,
        finished: false,
        winner: null,
        winLine: null,
      },
    }
  },

  /**
   * 当前行棋方的建议落点（有界建议集，非全量合法点）：已终局 → []；空盘 →
   * 只有天元 (7,7)；否则 → 与既有棋子切比雪夫距离 ≤2 的空点，按邻居加权
   * 计数打分（距离 1 记 2 分、距离 2 记 1 分）降序、(y, x) 字典序 tiebreak，
   * 截断至 64。全部确定性：无随机、无时间依赖。
   */
  legalActions(state: GomokuState): Array<{ type: 'place'; x: number; y: number }> {
    if (state.finished) return []
    if (state.ply === 0) return [{ type: 'place', x: 7, y: 7 }]

    const candidates: Array<{ x: number; y: number; score: number }> = []
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (state.board[y]![x] !== EMPTY) continue
        let score = 0
        let nearStone = false
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue
            if (state.board[ny]![nx] === EMPTY) continue
            nearStone = true
            score += Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 2 : 1
          }
        }
        if (nearStone) candidates.push({ x, y, score })
      }
    }
    candidates.sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.x - b.x))
    return candidates
      .slice(0, MAX_CANDIDATES)
      .map(({ x, y }) => ({ type: 'place', x, y }))
  },

  /**
   * 落子并推进局面。校验顺序：动作形状 → type → 未终局 → 行棋方 → 坐标 →
   * 空点；任一不过抛 Error（中文报错）。绝不改入参 state——深拷贝出新态。
   * 返回 { state, events, finished, winner, summary }；胜时新态附 winLine。
   */
  applyAction(state: GomokuState, action: unknown, actor: string): {
    state: GomokuState
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
    if (actor !== 'black' && actor !== 'white') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 black/white`)
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
      throw new Error(`${coordName(x, y)} 已有棋子，不能落在已占点上`)
    }

    const next = cloneState(state)
    next.board[y]![x] = actor === 'black' ? BLACK : WHITE
    next.ply = state.ply + 1
    next.lastMove = { x, y }
    next.turn = other(actor)

    const move = `${stoneName(actor)}落于 ${coordName(x, y)}`
    const events = [move]
    let summary = move
    const winLine = findWinLine(next.board, x, y)
    if (winLine !== null) {
      next.finished = true
      next.winner = actor
      next.winLine = winLine
      const ending = `${stoneName(actor)}${CN_NUMERALS[winLine.length] ?? String(winLine.length)}连，${actor === 'black' ? '黑' : '白'}胜`
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

  /** 人类可读的一手棋描述（Agent 在对话里角色化叙述用），含棋谱坐标（列 A-O + 行 1-15）。 */
  describe(_state: GomokuState, actor: string, action: unknown): string {
    if (
      action !== null && typeof action === 'object' && !Array.isArray(action)
      && (action as { type?: unknown }).type === 'place'
    ) {
      const x = parseBoardCoord((action as { x?: unknown }).x)
      const y = parseBoardCoord((action as { y?: unknown }).y)
      if (x !== null && y !== null && isOnBoard(x, y)) {
        return `${stoneName(actor === 'white' ? 'white' : 'black')}落于 ${coordName(x, y)}`
      }
    }
    return `${stoneName(actor === 'white' ? 'white' : 'black')}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as gomokuEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置五子棋随 bundle 分发）。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>五子棋 · dsh-soulmojito 游戏桥</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #171a20; color: #e8e4da;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 10px 10px 14px;
  }
  header {
    width: 100%; max-width: 560px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    padding: 4px 2px 8px;
  }
  .game-name { font-size: 16px; font-weight: 600; letter-spacing: 1px; }
  .meta {
    font-size: 12px; color: #9a948a; font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #banner {
    width: 100%; max-width: 560px;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; text-align: center;
    margin-bottom: 10px; border: 1px solid #3a3f4a; background: #22262e;
    transition: background .2s;
  }
  #banner.turn-black { background: #101216; border-color: #454b57; }
  #banner.turn-white { background: #e9e5da; border-color: #c9c2b2; color: #26282d; }
  #banner.finished  { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview   { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  .board-wrap { position: relative; width: 100%; max-width: 560px; }
  svg#board { display: block; width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.45); }
  svg#board.interactive .hit { cursor: pointer; }
  .overlay {
    position: absolute; inset: 0; border-radius: 8px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    background: rgba(14, 15, 18, .72);
  }
  .overlay.hidden { display: none; }
  .overlay .result { font-size: 22px; font-weight: 700; color: #f0e6c8; letter-spacing: 2px; }
  .overlay .sub { font-size: 13px; color: #c9c0a8; padding: 0 14px; text-align: center; }
  footer {
    width: 100%; max-width: 560px; margin-top: 10px;
    font-size: 12px; color: #8d887e; text-align: center; line-height: 1.6;
  }
</style>
</head>
<body data-game="dsh-soulmojito.gomoku">
<header>
  <span class="game-name">五子棋</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="board-wrap">
  <svg id="board" viewBox="0 0 688 688" role="img" aria-label="五子棋棋盘 15 路"></svg>
  <div class="overlay hidden" id="overlay">
    <div class="result" id="overlay-result"></div>
    <div class="sub" id="overlay-sub">对局结束</div>
  </div>
</div>
<footer id="hint"></footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账、全量重渲染）、
   上行 dsh-soulmojito:game-action（合法性由服务端引擎终审）。token 从 location.search
   自读；无 token（浏览器直接打开）渲染静态预览局面。人类回合才启用点击与建议点
   提示——AI 回合的落子经下行自动出现在棋盘上。 */
var N = 15
var PAD = 36
var CELL = 44
var STONE_R = 19
var HIT_R = 21.5
var COLUMNS = 'ABCDEFGHIJKLMNO'
var STAR_POINTS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]
var LINE_COLOR = '#7a5a33'

var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var current = null /* 最近一条 game-state：{ state, legal, finished, summary, session } */

var boardEl = document.getElementById('board')
var bannerEl = document.getElementById('banner')
var overlayEl = document.getElementById('overlay')
var overlayResultEl = document.getElementById('overlay-result')
var overlaySubEl = document.getElementById('overlay-sub')
var metaEl = document.getElementById('meta')
var hintEl = document.getElementById('hint')

/* 无 token 的静态演示局面：黑白各若干子（黑四子斜线呼应），轮白。 */
var PREVIEW_STATE = buildBoard([
  [[7, 7], 1], [[8, 8], 1], [[6, 6], 1], [[7, 5], 1],
  [[7, 8], 2], [[8, 6], 2], [[6, 8], 2],
], 'white', 7, { x: 7, y: 5 })
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-soulmojito.gomoku',
  players: [
    { role: 'black', owner: 'human' },
    { role: 'white', owner: 'agent' },
  ],
}

function buildBoard(stones, turn, ply, lastMove) {
  var board = []
  for (var y = 0; y < N; y++) {
    var row = []
    for (var x = 0; x < N; x++) row.push(0)
    board.push(row)
  }
  for (var i = 0; i < stones.length; i++) board[stones[i][0][1]][stones[i][0][0]] = stones[i][1]
  return {
    board: board, turn: turn, ply: ply, lastMove: lastMove,
    finished: false, winner: null, winLine: null,
  }
}

function coord(i) { return PAD + i * CELL }

function svgEl(name, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (var key in attrs) el.setAttribute(key, String(attrs[key]))
  return el
}

function radialGradient(id, innerColor, outerColor) {
  var gradient = svgEl('radialGradient', { id: id, cx: '35%', cy: '30%', r: '75%' })
  gradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': innerColor }))
  gradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': outerColor }))
  return gradient
}

window.addEventListener('message', function (event) {
  var data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type !== 'dsh-soulmojito:game-state' || data.token !== TOKEN) return
  var view = data.view && typeof data.view === 'object' ? data.view : {}
  current = {
    state: view.state || null,
    legal: Array.isArray(view.legal) ? view.legal : [],
    finished: view.finished === true,
    summary: typeof view.summary === 'string' ? view.summary : '',
    session: data.session && typeof data.session === 'object' ? data.session : null,
  }
  render()
})

function active() {
  if (current) return current
  if (TOKEN !== null) {
    /* 已由游戏服务装载但首条 game-state 未到：空盘等待，不借预览局面。 */
    return { state: null, legal: [], finished: false, summary: '', session: null }
  }
  return { state: PREVIEW_STATE, legal: [], finished: false, summary: '', session: PREVIEW_SESSION }
}

function ownerOf(session, role) {
  if (!session || !Array.isArray(session.players)) return null
  for (var i = 0; i < session.players.length; i++) {
    if (session.players[i] && session.players[i].role === role) return session.players[i].owner
  }
  return null
}

function sideName(role) { return role === 'black' ? '黑方' : '白方' }

function endText(state) {
  if (state.winner === 'black') return '黑棋获胜'
  if (state.winner === 'white') return '白棋获胜'
  return '和棋'
}

function humanTurn(act) {
  if (!act.state || act.state.finished) return false
  return ownerOf(act.session, act.state.turn) !== 'agent'
}

function render() {
  var act = active()
  var state = act.state
  var live = current !== null || TOKEN !== null

  renderBoard(act)

  if (!live) metaEl.textContent = '预览模式'
  else if (!state) metaEl.textContent = '等待会话…'
  else metaEl.textContent = (act.session && act.session.id ? '对局 ' + act.session.id : '对局中') + ' · 手数 ' + state.ply

  var cls = 'preview'
  var text = '预览模式：由 dsh-soulmojito 游戏服务装载后启用交互'
  if (live) {
    if (!state) {
      text = '等待对局状态…'
    } else if (state.finished) {
      cls = 'finished'
      text = act.summary ? '对局结束 · ' + act.summary : '对局结束：' + endText(state)
    } else {
      cls = state.turn === 'black' ? 'turn-black' : 'turn-white'
      var owner = ownerOf(act.session, state.turn)
      text = sideName(state.turn) + (owner === 'agent' ? ' · AI 思考中…' : owner === 'human' ? ' · 轮到你落子' : '行动中')
      if (act.summary) text += ' · ' + act.summary
    }
  }
  bannerEl.className = cls
  bannerEl.textContent = text

  var finished = !!(live && state && state.finished)
  overlayEl.className = finished ? 'overlay' : 'overlay hidden'
  if (finished) {
    overlayResultEl.textContent = endText(state)
    overlaySubEl.textContent = act.summary || '对局结束'
  }

  if (!live) {
    hintEl.textContent = '这是静态演示局面：由 dsh-soulmojito 游戏服务装载后，棋盘将接收实时状态并启用点击落子。'
  } else if (!state) {
    hintEl.textContent = '正在连接 dsh-soulmojito 游戏服务…'
  } else if (state.finished) {
    hintEl.textContent = '对局已结束。可在对局面板中开新一局，或让 AI 再来一盘。'
  } else if (humanTurn(act)) {
    hintEl.textContent = '点击交叉点落子（任意空点均可点，合法性由服务端引擎终审）；坐标为列 A-O、行 1-15。'
  } else {
    hintEl.textContent = 'AI 思考中，落子将自动出现在棋盘上。'
  }
}

function renderBoard(act) {
  var state = act.state
  while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild)

  var defs = svgEl('defs', {})
  defs.appendChild(radialGradient('grad-black', '#4a4a4a', '#000000'))
  defs.appendChild(radialGradient('grad-white', '#ffffff', '#b9b9b9'))
  boardEl.appendChild(defs)

  boardEl.appendChild(svgEl('rect', { x: 0, y: 0, width: 688, height: 688, rx: 8, fill: '#d6a45f' }))

  for (var i = 0; i < N; i++) {
    var edge = i === 0 || i === N - 1
    boardEl.appendChild(svgEl('line', {
      x1: coord(0), y1: coord(i), x2: coord(N - 1), y2: coord(i),
      stroke: LINE_COLOR, 'stroke-width': edge ? 2 : 1,
    }))
    boardEl.appendChild(svgEl('line', {
      x1: coord(i), y1: coord(0), x2: coord(i), y2: coord(N - 1),
      stroke: LINE_COLOR, 'stroke-width': edge ? 2 : 1,
    }))
  }

  for (var s = 0; s < STAR_POINTS.length; s++) {
    boardEl.appendChild(svgEl('circle', {
      cx: coord(STAR_POINTS[s][0]), cy: coord(STAR_POINTS[s][1]), r: 4.5, fill: LINE_COLOR,
    }))
  }

  for (var c = 0; c < N; c++) {
    var colLabel = svgEl('text', {
      x: coord(c), y: PAD - 14, 'text-anchor': 'middle', 'font-size': 12, fill: LINE_COLOR,
    })
    colLabel.textContent = COLUMNS[c]
    boardEl.appendChild(colLabel)
    var rowLabel = svgEl('text', {
      x: PAD - 16, y: coord(c) + 4, 'text-anchor': 'middle', 'font-size': 12, fill: LINE_COLOR,
    })
    rowLabel.textContent = String(c + 1)
    boardEl.appendChild(rowLabel)
  }

  if (!state) {
    boardEl.setAttribute('class', '')
    return
  }

  var winCells = {}
  if (state.winLine) {
    for (var w = 0; w < state.winLine.length; w++) {
      winCells[state.winLine[w].x + ',' + state.winLine[w].y] = true
    }
  }

  for (var y = 0; y < N; y++) {
    for (var x = 0; x < N; x++) {
      var stone = state.board[y][x]
      if (stone === 0) continue
      boardEl.appendChild(svgEl('circle', {
        cx: coord(x), cy: coord(y), r: STONE_R,
        fill: stone === 1 ? 'url(#grad-black)' : 'url(#grad-white)',
        stroke: stone === 1 ? '#000' : '#b0b0b0', 'stroke-width': 0.5,
      }))
      if (winCells[x + ',' + y]) {
        boardEl.appendChild(svgEl('circle', {
          cx: coord(x), cy: coord(y), r: STONE_R + 2,
          fill: 'none', stroke: '#e05252', 'stroke-width': 3,
        }))
      }
    }
  }

  if (state.lastMove) {
    boardEl.appendChild(svgEl('circle', {
      cx: coord(state.lastMove.x), cy: coord(state.lastMove.y),
      r: 6.5, fill: 'none', stroke: '#e05252', 'stroke-width': 3,
    }))
  }

  var ownTurn = humanTurn(act)

  if (ownTurn) {
    for (var l = 0; l < act.legal.length; l++) {
      var point = act.legal[l]
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') continue
      if (state.board[point.y][point.x] !== 0) continue
      boardEl.appendChild(svgEl('circle', {
        cx: coord(point.x), cy: coord(point.y), r: 3, fill: 'rgba(60, 40, 10, 0.35)',
      }))
    }
  }

  boardEl.setAttribute('class', ownTurn ? 'interactive' : '')
  if (ownTurn) {
    for (var yy = 0; yy < N; yy++) {
      for (var xx = 0; xx < N; xx++) {
        if (state.board[yy][xx] !== 0) continue
        boardEl.appendChild(svgEl('circle', {
          cx: coord(xx), cy: coord(yy), r: HIT_R,
          fill: 'transparent', 'data-x': xx, 'data-y': yy, 'class': 'hit',
        }))
      }
    }
  }
}

/* 点击空点（人类回合、未终局）：上行 dsh-soulmojito:game-action。合法性由服务端
   引擎终审——这里不做本地规则裁决，人类可点任意空点。 */
boardEl.addEventListener('click', function (event) {
  if (!TOKEN) return
  var act = active()
  if (!act.state || act.state.finished || !humanTurn(act)) return
  var target = event.target
  if (!target || target.getAttribute('data-x') === null) return
  var x = Number(target.getAttribute('data-x'))
  var y = Number(target.getAttribute('data-y'))
  if (act.state.board[y][x] !== 0) return
  window.parent.postMessage(
    { type: 'dsh-soulmojito:game-action', token: TOKEN, action: { type: 'place', x: x, y: y } },
    '*',
  )
})

render()
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const gomoku = { manifest, engine, viewHtml } as const
