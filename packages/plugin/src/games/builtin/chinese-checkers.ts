/**
 * 内置游戏：中国跳棋 / Chinese Checkers（提案 0018 §4.1 内置序列第九款，2026-10-17）。
 *
 * 契约来源：docs/proposals/0018-agent-game-bridge.md §3.2 引擎契约 + §3.3 视图
 * 契约——与既有一切内置同款：JSON-safe state、深拷贝、确定性（本款**零随机**，
 * 连 seed 都不需要）、非法动作中文报错、describe 带 行-列 坐标。保留动作
 * resign 由运行时统一处理，本引擎只实现 move。
 *
 * 盘面（标准 121 洞六角星）：星形 = 两个重叠大三角形，用立方坐标 (q, r, s)，
 * s = -q - r，星形 = { q,r,s ≥ -4 } ∪ { q,r,s ≤ 4 }（各 91 洞、交叠六边形 61
 * 洞，并集恰 121 洞）。按 r = -8..8 排成 17 行，行洞数恒为
 * 1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1；行内按 q 升序为列。顶营 = 行 1-4、
 * 底营 = 行 14-17（各 10 洞）。渲染像素坐标：pointy-top 六边形，
 * x = √3·(q + r/2)、y = 1.5·r（视图内布局表由本模块注入，与引擎同源零漂移）。
 *
 * 规则面 v1（决策留档见 decisions/2026-10-17-chinese-checkers-builtin.md）：
 * - 双人对局（roles red/blue），红方起于顶营、蓝方起于底营，各 10 颗弹珠，红先；
 * - 每回合择一：走到相邻空位，或跳过紧邻的任意一颗弹珠（不分敌我）落于正后方
 *   空位——可连跳、连跳中可拐弯，**同一手不重复落点**（含不得落回起点）；无吃子；
 * - 先把自己十颗全部搬进对方营盘的一方获胜；对方轮到走子而无任何合法着法
 *   （困毙）同样本方胜——与军棋/象棋同款裁决（见下「困毙」注）；
 * - 建议集 ≤64（§3.2）：截断按「洞号升序 × 步先跳后」的确定主序，不是合法性
 *   依据——applyAction 按全量规则终审任意动作。
 *
 * 困毙注：20 子/121 洞规模下红方被全封锁的理论下界是 11 颗蓝子（十子满营时
 * 仅突围面就有 5 个步位 + 6 个落点），大于蓝方 10 子——真实可达性未证；判定
 * 保留为总函数（防止任何构造态陷入死局），由 spec 的构造性夹具锁定。
 *
 * view.html 为内联字符串常量：自包含（无外链、无 fetch），监听
 * dsh-soulmojito:game-state 下行、上行 dsh-soulmojito:game-action（§3.3 两条
 * 消息协议）；布局表与预览局面由本模块在模块期注入（地牢爬行同款纪律——
 * 预览由引擎实时生成，与开局态零漂移）。
 */

import { GAME_LEGAL_ACTIONS_MAX, parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

type Role = 'red' | 'blue'

const CODE_OF: Record<Role, number> = { red: 1, blue: 2 }

/** 六向邻接（axial，pointy-top 坐标系的六个单位方向）。 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]

interface StarCell {
  row: number
  col: number
  q: number
  r: number
}

/** 星形盘面的 121 洞，行主序：行 0（r=-8，顶）→ 行 16（r=8，底），行内 q 升序。 */
function buildCells(): StarCell[] {
  const cells: StarCell[] = []
  for (let r = -8; r <= 8; r += 1) {
    const rowCells: Array<[number, number]> = []
    for (let q = -8; q <= 8; q += 1) {
      const s = -q - r
      const inStar = (q >= -4 && r >= -4 && s >= -4) || (q <= 4 && r <= 4 && s <= 4)
      if (inStar) rowCells.push([q, r])
    }
    rowCells.sort((a, b) => a[0] - b[0])
    rowCells.forEach(([q, cellR], col) => {
      cells.push({ row: r + 8, col, q, r: cellR })
    })
  }
  return cells
}

const CELLS = buildCells()
const ROW_LENGTHS: readonly number[] = Array.from(
  { length: 17 },
  (_, row) => CELLS.filter((cell) => cell.row === row).length,
)
const ROW_OFFSETS: readonly number[] = (() => {
  const offsets: number[] = []
  let acc = 0
  for (const length of ROW_LENGTHS) {
    offsets.push(acc)
    acc += length
  }
  return offsets
})()

const HOLE_INDEX = new Map<string, number>()
CELLS.forEach((cell, hole) => HOLE_INDEX.set(`${cell.q},${cell.r}`, hole))

const NEIGHBORS: number[][] = Array.from({ length: CELLS.length }, () => [])
/** 跳表：从每个洞出发、六个方向上的 { 逾越点, 落点 }（逾越点与落点都必须在盘内）。 */
const HOPS: Array<Array<{ over: number; to: number }>> = Array.from({ length: CELLS.length }, () => [])
CELLS.forEach((cell, hole) => {
  for (const [dq, dr] of DIRECTIONS) {
    const over = HOLE_INDEX.get(`${cell.q + dq},${cell.r + dr}`)
    if (over === undefined) continue
    NEIGHBORS[hole]!.push(over)
    const to = HOLE_INDEX.get(`${cell.q + dq * 2},${cell.r + dr * 2}`)
    if (to !== undefined) HOPS[hole]!.push({ over, to })
  }
})

const CAMP_OF: Array<'top' | 'bottom' | null> = CELLS.map((cell) =>
  cell.row <= 3 ? 'top' : cell.row >= 13 ? 'bottom' : null)
const TOP_CAMP: number[] = CELLS.filter((cell) => cell.row <= 3).map((cell) => HOLE_INDEX.get(`${cell.q},${cell.r}`)!)
const BOTTOM_CAMP: number[] = CELLS.filter((cell) => cell.row >= 13).map((cell) => HOLE_INDEX.get(`${cell.q},${cell.r}`)!)
const TARGET_CAMP: Record<Role, readonly number[]> = { red: BOTTOM_CAMP, blue: TOP_CAMP }

interface ChineseCheckersState {
  turn: Role
  /** 17 行锯齿棋盘：0 空 / 1 红 / 2 蓝。 */
  board: number[][]
  ply: number
  lastMove: { from: [number, number]; to: [number, number] } | null
  finished: boolean
  winner: Role | null
}

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意缺席：
 *  内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.chinese-checkers',
  name: '中国跳棋',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['red', 'blue'] },
  turnBased: true,
  actionVocabulary: "移动 {type:'move', from:[行,列], to:[行,列]}：from/to 为 0 基 [行号, 列号]（行 0-16 自上而下、列 0-该行洞数-1 自左而右；叙述用 1 基「行-列」名）——走到相邻空位，或跳过紧邻一颗弹珠（不分敌我）落于正后方空位、可连跳（拐弯自由、同一手不重复落点）；认输 {type:'resign'} 由运行时统一处理",
}

function sideName(role: Role): string {
  return role === 'red' ? '红方' : '蓝方'
}

function otherRole(role: Role): Role {
  return role === 'red' ? 'blue' : 'red'
}

function nameOf(row: number, col: number): string {
  return `${row + 1}-${col + 1}`
}

/** (row, col) → 洞号；不在盘上返回 null（坐标语义唯一的界内终审）。 */
function holeOf(row: number, col: number): number | null {
  if (row < 0 || row >= ROW_LENGTHS.length) return null
  if (col < 0 || col >= ROW_LENGTHS[row]!) return null
  return ROW_OFFSETS[row]! + col
}

function cellCode(board: number[][], hole: number): number {
  const cell = CELLS[hole]!
  return board[cell.row]![cell.col]!
}

function cloneState(state: ChineseCheckersState): ChineseCheckersState {
  return {
    turn: state.turn,
    board: state.board.map((row) => row.slice()),
    ply: state.ply,
    lastMove: state.lastMove === null
      ? null
      : { from: [state.lastMove.from[0], state.lastMove.from[1]], to: [state.lastMove.to[0], state.lastMove.to[1]] },
    finished: state.finished,
    winner: state.winner,
  }
}

interface ReadCell {
  row: number
  col: number
  hole: number
}

/** 动作坐标解析：形状 [行, 列] 两元组（parseBoardCoord 归一整数串）+ 界内终审。 */
function readCell(raw: unknown, field: string): ReadCell {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`动作 ${field} 必须是 [行, 列] 两元组（0 基，行 0-16），收到 ${Array.isArray(raw) ? `${raw.length} 项数组` : typeof raw}`)
  }
  const row = parseBoardCoord(raw[0])
  const col = parseBoardCoord(raw[1])
  if (row === null || col === null) {
    throw new Error(`动作 ${field} 的行列必须是整数，收到 [${String(raw[0])}, ${String(raw[1])}]`)
  }
  const hole = holeOf(row, col)
  if (hole === null) {
    throw new Error(`动作 ${field} [${row}, ${col}] 不在棋盘洞位内`)
  }
  return { row, col, hole }
}

/**
 * 单子一手可达集：步（连跳步数记 0）+ 连跳 BFS（记最小连跳步数）。
 * 连跳规则：逾越点必须有弹珠（不分敌我）、落点必须为空、同一手不重复落点
 * （visited 起手含起点——落回起点与任何回环都被排除，BFS 必终止）。
 */
function reachableFrom(board: number[][], from: number): Map<number, number> {
  const result = new Map<number, number>()
  for (const neighbor of NEIGHBORS[from]!) {
    if (cellCode(board, neighbor) === 0) result.set(neighbor, 0)
  }
  const visited = new Set<number>([from])
  const queue: Array<{ at: number; depth: number }> = [{ at: from, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const hop of HOPS[current.at]!) {
      if (visited.has(hop.to)) continue
      if (cellCode(board, hop.over) === 0) continue
      if (cellCode(board, hop.to) !== 0) continue
      visited.add(hop.to)
      const depth = current.depth + 1
      if (!result.has(hop.to)) result.set(hop.to, depth)
      queue.push({ at: hop.to, depth })
    }
  }
  return result
}

/** 指定方是否还有任何合法着法（困毙终局判定，军棋同款纪律）。 */
function hasAnyMove(board: number[][], role: Role): boolean {
  const code = CODE_OF[role]
  for (let hole = 0; hole < CELLS.length; hole += 1) {
    if (cellCode(board, hole) !== code) continue
    if (reachableFrom(board, hole).size > 0) return true
  }
  return false
}

function moveText(actor: Role, from: { row: number; col: number }, to: { row: number; col: number }, hops: number): string {
  const fromName = nameOf(from.row, from.col)
  const toName = nameOf(to.row, to.col)
  return hops === 0
    ? `${sideName(actor)} ${fromName} 走到 ${toName}`
    : `${sideName(actor)} ${fromName} 跳到 ${toName}（连跳 ${hops} 步）`
}

/** 建议集主序：洞号升序 × 单子内「步先跳后（BFS 发现序）」。 */
type MoveAction = { type: 'move'; from: [number, number]; to: [number, number] }

const engine: GameEngine = {
  meta: MANIFEST,

  /** 开局：红十子满占顶营、蓝十子满占底营，红先。本款零随机，options 接受但忽略。 */
  createGame(_options?: unknown): { state: ChineseCheckersState } {
    return {
      state: {
        turn: 'red',
        board: ROW_LENGTHS.map((length, row) => Array.from(
          { length },
          () => row <= 3 ? CODE_OF.red : row >= 13 ? CODE_OF.blue : 0,
        )),
        ply: 0,
        lastMove: null,
        finished: false,
        winner: null,
      },
    }
  },

  /** 建议集（≤64，全量规则见 applyAction——本函数只是有界建议面，§3.2）。 */
  legalActions(state: ChineseCheckersState): MoveAction[] {
    if (state.finished) return []
    const actions: MoveAction[] = []
    const code = CODE_OF[state.turn]
    for (let hole = 0; hole < CELLS.length; hole += 1) {
      if (cellCode(state.board, hole) !== code) continue
      const cell = CELLS[hole]!
      const from: [number, number] = [cell.row, cell.col]
      for (const to of reachableFrom(state.board, hole).keys()) {
        if (actions.length >= GAME_LEGAL_ACTIONS_MAX) return actions
        const target = CELLS[to]!
        actions.push({ type: 'move', from, to: [target.row, target.col] })
      }
    }
    return actions
  },

  /** 落子并推进局面；校验顺序与报错纪律逐条对齐既有各款引擎。 */
  applyAction(state: ChineseCheckersState, action: unknown, actor: string): {
    state: ChineseCheckersState
    events: string[]
    finished: boolean
    winner: Role | null
    summary: string
  } {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    const typed = action as { type?: unknown; from?: unknown; to?: unknown }
    if (typeof typed.type !== 'string' || typed.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (typed.type !== 'move') {
      throw new Error(`不支持的动作类型「${typed.type}」：本引擎只实现 move（resign 是保留动作，由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再落子')
    }
    if (actor !== 'red' && actor !== 'blue') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 red/blue`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能落子`)
    }
    const from = readCell(typed.from, 'from')
    const to = readCell(typed.to, 'to')
    if (from.hole === to.hole) {
      throw new Error(`起点与终点相同（${nameOf(from.row, from.col)}），不能落子`)
    }
    if (cellCode(state.board, from.hole) !== CODE_OF[actor]) {
      throw new Error(`${nameOf(from.row, from.col)} 没有${sideName(actor)}的弹珠`)
    }
    if (cellCode(state.board, to.hole) !== 0) {
      throw new Error(`${nameOf(to.row, to.col)} 已有弹珠，不能落子`)
    }
    const hops = reachableFrom(state.board, from.hole).get(to.hole)
    if (hops === undefined) {
      throw new Error(`不能从 ${nameOf(from.row, from.col)} 到 ${nameOf(to.row, to.col)}：这不是合法的一步移动或连跳`)
    }

    const next = cloneState(state)
    next.board[from.row]![from.col] = 0
    next.board[to.row]![to.col] = CODE_OF[actor]
    next.ply = state.ply + 1
    next.lastMove = { from: [from.row, from.col], to: [to.row, to.col] }
    next.turn = otherRole(actor)

    const move = moveText(actor, from, to, hops)
    const events = [move]
    let summary = move
    if (TARGET_CAMP[actor].every((hole) => cellCode(next.board, hole) === CODE_OF[actor])) {
      next.finished = true
      next.winner = actor
      const ending = `${sideName(actor)}十颗弹珠全部搬进对方营盘，${sideName(actor)}胜`
      events.push(ending)
      summary = `${move}，${ending}`
    } else if (!hasAnyMove(next.board, next.turn)) {
      next.finished = true
      next.winner = actor
      const ending = `${sideName(next.turn)}无棋可走，${sideName(actor)}胜`
      events.push(ending)
      summary = `${move}，${ending}`
    }
    return { state: next, events, finished: next.finished, winner: next.winner, summary }
  },

  /** 人类可读的一手棋描述（含 1 基 行-列 名与连跳步数）；任何未识别回落统一文案。 */
  describe(state: ChineseCheckersState, actor: string, action: unknown): string {
    const fallback = `${String(actor)}的动作未被本引擎识别`
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return fallback
    const typed = action as { type?: unknown; from?: unknown; to?: unknown }
    if (typed.type !== 'move') return fallback
    if (actor !== 'red' && actor !== 'blue') return fallback
    let from: ReadCell
    let to: ReadCell
    try {
      from = readCell(typed.from, 'from')
      to = readCell(typed.to, 'to')
    } catch {
      return fallback
    }
    if (from.hole === to.hole) return fallback
    if (cellCode(state.board, from.hole) !== CODE_OF[actor]) return fallback
    if (cellCode(state.board, to.hole) !== 0) return fallback
    const hops = reachableFrom(state.board, from.hole).get(to.hole)
    if (hops === undefined) return fallback
    return moveText(actor, from, to, hops)
  },
}

/** 测试探针（大富翁/地牢爬行同款纪律）：只读几何面，供受控局面构造。 */
export const chineseCheckersProbe = {
  holeCount: CELLS.length,
  rowLengths: [...ROW_LENGTHS],
  indexOf(row: number, col: number): number | null {
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null
    return holeOf(row, col)
  },
  coordOf(hole: number): { row: number; col: number } {
    const cell = CELLS[hole]
    if (cell === undefined) throw new Error(`洞号 ${String(hole)} 不在棋盘内（0-120）`)
    return { row: cell.row, col: cell.col }
  },
  neighborsOf(hole: number): number[] {
    const neighbors = NEIGHBORS[hole]
    if (neighbors === undefined) throw new Error(`洞号 ${String(hole)} 不在棋盘内（0-120）`)
    return [...neighbors]
  },
  campOf(hole: number): 'top' | 'bottom' | null {
    const camp = CAMP_OF[hole]
    if (camp === undefined) throw new Error(`洞号 ${String(hole)} 不在棋盘内（0-120）`)
    return camp
  },
  targetCampOf(role: 'red' | 'blue'): 'top' | 'bottom' {
    if (role !== 'red' && role !== 'blue') throw new Error(`未知角色「${String(role)}」：本游戏角色为 red/blue`)
    return role === 'red' ? 'bottom' : 'top'
  },
  axialOf(hole: number): { q: number; r: number } {
    const cell = CELLS[hole]
    if (cell === undefined) throw new Error(`洞号 ${String(hole)} 不在棋盘内（0-120）`)
    return { q: cell.q, r: cell.r }
  },
} as const

/** 视图布局表（引擎几何的唯一事实来源注入视图；unit 半径 11×13 画布）。 */
const LAYOUT = {
  rows: [...ROW_LENGTHS],
  cells: CELLS.map((cell) => [cell.q, cell.r]),
}

/** 预览局面（模块期由引擎实时生成注入，与开局零漂移——地牢爬行同款纪律）。 */
const PREVIEW = (() => {
  let state = engine.createGame().state as ChineseCheckersState
  for (let ply = 0; ply < 10; ply += 1) {
    const suggestions = engine.legalActions(state) as MoveAction[]
    if (suggestions.length === 0) break
    const pick = suggestions[(ply * 3 + 1) % suggestions.length]!
    const result = engine.applyAction(state, pick, state.turn)
    state = result.state as ChineseCheckersState
    if (state.finished) break
  }
  return { state, legal: (engine.legalActions(state) as MoveAction[]).slice(0, 8) }
})()

export const manifest: GameManifest = MANIFEST
export { engine as chineseCheckersEngine }

/** 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>中国跳棋 · dsh-soulmojito 游戏桥</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    background: #171a20; color: #e8e4da;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
  }
  header { width: 100%; max-width: 480px; display: flex; justify-content: space-between; font-size: 14px; padding-bottom: 8px; }
  .session-id { color: #9a948a; font-size: 11px; font-variant-numeric: tabular-nums; }
  #seats { width: 100%; max-width: 480px; display: flex; justify-content: center; gap: 16px; font-size: 12px; color: #b8b2a6; padding-bottom: 6px; }
  .seat { display: inline-flex; align-items: center; gap: 5px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.red { background: #d9634f; }
  .dot.blue { background: #5b8fd6; }
  #banner { width: 100%; max-width: 480px; border: 1px solid #3a3f4a; background: #22262e; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; text-align: center; margin-bottom: 10px; }
  #board { position: relative; width: 100%; max-width: 480px; aspect-ratio: 22 / 26; margin: 0 auto; }
  .hole { position: absolute; border-radius: 50%; background: #20242c; border: 1px solid #333945; }
  .hole.camp-red { border-color: #7a4a41; background: #241f26; }
  .hole.camp-blue { border-color: #3f547a; background: #1f232c; }
  .hole.playable { cursor: pointer; }
  .hole.reach { cursor: pointer; border-color: #d8b13f; box-shadow: 0 0 0 2px rgba(216, 177, 63, 0.35) inset; }
  .hole.last-from { border-color: #8a6d2f; }
  .hole.last-to { border-color: #d8b13f; }
  .marble { position: absolute; left: 50%; top: 50%; width: 74%; height: 74%; transform: translate(-50%, -50%);
    border-radius: 50%; pointer-events: none; }
  .marble.red { background: radial-gradient(circle at 35% 30%, #f2a292, #c9503c 72%); }
  .marble.blue { background: radial-gradient(circle at 35% 30%, #9cc4f2, #3f74bd 72%); }
  .marble.sel { box-shadow: 0 0 0 2px #f2d16b, 0 0 8px rgba(242, 209, 107, 0.8); }
  #hint { width: 100%; max-width: 480px; text-align: center; font-size: 11px; color: #8d887e; margin-top: 8px; min-height: 15px; }
  footer { margin-top: 6px; font-size: 11px; color: #8d887e; text-align: center; max-width: 480px; }
</style>
</head>
<body>
<header><span>中国跳棋</span><span class="session-id" id="session-id"></span></header>
<div id="seats">
  <span class="seat"><span class="dot red"></span>红方<span id="owner-red"></span></span>
  <span class="seat"><span class="dot blue"></span>蓝方<span id="owner-blue"></span></span>
</div>
<div id="banner">等待对局…</div>
<div id="board" data-game="dsh-soulmojito.chinese-checkers"></div>
<div id="hint"></div>
<footer>点选自家弹珠 → 点亮起的洞位落子；把自家十颗弹珠全部搬进对方营盘即胜。</footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账）、
   上行 dsh-soulmojito:game-action。token 从 location.search 自读；无 token 时
   渲染静态预览。布局表（CC_LAYOUT）与预览局面（PREVIEW）由引擎模块期注入——
   与引擎几何同源，零漂移。 */
var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var CC_LAYOUT = ${JSON.stringify(LAYOUT)}
var PREVIEW = ${JSON.stringify(PREVIEW)}
var board = document.getElementById('board')
var banner = document.getElementById('banner')
var hint = document.getElementById('hint')
var RED = 1
var BLUE = 2
var OFFSETS = []
var COORDS = []
;(function () {
  var acc = 0
  for (var row = 0; row < CC_LAYOUT.rows.length; row += 1) {
    OFFSETS.push(acc)
    for (var col = 0; col < CC_LAYOUT.rows[row]; col += 1) {
      COORDS.push([row, col])
      acc += 1
    }
  }
})()
var current = null
var selected = null
var sending = false
var lockTimer = null

function ownerOf(session, role) {
  if (!session || !Array.isArray(session.players)) return null
  for (var i = 0; i < session.players.length; i += 1) {
    if (session.players[i] && session.players[i].role === role) return session.players[i].owner
  }
  return null
}
function myRole(session) {
  if (!session || !Array.isArray(session.players)) return null
  for (var i = 0; i < session.players.length; i += 1) {
    if (session.players[i] && session.players[i].owner === 'human') return session.players[i].role
  }
  return null
}
function codeOf(role) { return role === 'red' ? RED : BLUE }
function sideName(role) { return role === 'red' ? '红方' : '蓝方' }
function nameAt(index) {
  var coord = COORDS[index]
  return (coord[0] + 1) + '-' + (coord[1] + 1)
}
function setOwner(id, owner) {
  var element = document.getElementById(id)
  if (owner === 'human') element.textContent = '（你）'
  else if (owner === 'agent') element.textContent = '（AI）'
  else element.textContent = ''
}
function interactive() {
  if (!TOKEN || !current) return false
  if (current.view.finished) return false
  var human = myRole(current.session)
  return human !== null && current.view.turn === human
}
function send(action) {
  if (sending) return
  sending = true
  selected = null
  window.parent.postMessage({ type: 'dsh-soulmojito:game-action', token: TOKEN, action: action }, '*')
  lockTimer = setTimeout(function () { sending = false }, 4000)
}
function onHoleClick(row, col, index, code) {
  if (!interactive()) return
  var human = myRole(current.session)
  if (code === codeOf(human)) {
    selected = selected === index ? null : index
    render()
    return
  }
  if (selected === null) return
  var list = current.view.legal || []
  var selectedCoord = COORDS[selected]
  for (var i = 0; i < list.length; i += 1) {
    var action = list[i]
    if (!action || action.type !== 'move' || !action.from || !action.to) continue
    if (action.from[0] === selectedCoord[0] && action.from[1] === selectedCoord[1]
      && action.to[0] === row && action.to[1] === col) {
      send({ type: 'move', from: [selectedCoord[0], selectedCoord[1]], to: [row, col] })
      render()
      return
    }
  }
  if (code === 0) {
    selected = null
    render()
  }
}
function render() {
  if (!current) return
  var view = current.view
  var session = current.session
  var state = view.state
  document.getElementById('session-id').textContent = session ? session.id : ''
  setOwner('owner-red', ownerOf(session, 'red'))
  setOwner('owner-blue', ownerOf(session, 'blue'))
  var human = myRole(session)
  var myTurn = interactive()
  var selectedCoord = selected === null ? null : COORDS[selected]
  var reach = {}
  if (myTurn && selectedCoord !== null) {
    var list = view.legal || []
    for (var i = 0; i < list.length; i += 1) {
      var action = list[i]
      if (!action || action.type !== 'move' || !action.from || !action.to) continue
      if (action.from[0] === selectedCoord[0] && action.from[1] === selectedCoord[1]) {
        reach[action.to[0] + ',' + action.to[1]] = true
      }
    }
  }
  var lastMove = state.lastMove
  var lastFrom = lastMove ? lastMove.from[0] + ',' + lastMove.from[1] : null
  var lastTo = lastMove ? lastMove.to[0] + ',' + lastMove.to[1] : null
  board.innerHTML = ''
  for (var row = 0; row < CC_LAYOUT.rows.length; row += 1) {
    for (var col = 0; col < CC_LAYOUT.rows[row]; col += 1) {
      var index = OFFSETS[row] + col
      var cell = CC_LAYOUT.cells[index]
      var x = Math.sqrt(3) * (cell[0] + cell[1] / 2)
      var y = 1.5 * cell[1]
      var w = 0.94 / 22 * 100
      var h = 0.94 / 26 * 100
      var code = state.board[row][col]
      var classes = ['hole']
      if (row <= 3) classes.push('camp-red')
      else if (row >= 13) classes.push('camp-blue')
      if (lastFrom === row + ',' + col) classes.push('last-from')
      if (lastTo === row + ',' + col) classes.push('last-to')
      if (myTurn && code === codeOf(human)) classes.push('playable')
      if (reach[row + ',' + col]) classes.push('reach')
      var hole = document.createElement('div')
      hole.className = classes.join(' ')
      hole.style.left = ((x + 11) / 22 * 100 - w / 2) + '%'
      hole.style.top = ((y + 13) / 26 * 100 - h / 2) + '%'
      hole.style.width = w + '%'
      hole.style.height = h + '%'
      hole.title = (row + 1) + '-' + (col + 1)
      hole.setAttribute('data-cell', String(index))
      if (code !== 0) {
        var marbleClasses = ['marble', code === RED ? 'red' : 'blue']
        if (selected === index) marbleClasses.push('sel')
        var marble = document.createElement('div')
        marble.className = marbleClasses.join(' ')
        hole.appendChild(marble)
      }
      ;(function (clickRow, clickCol, clickIndex, clickCode, element) {
        element.addEventListener('click', function () { onHoleClick(clickRow, clickCol, clickIndex, clickCode) })
      })(row, col, index, code, hole)
      board.appendChild(hole)
    }
  }
  if (!session) {
    banner.textContent = view.summary || '静态预览'
  } else if (view.finished) {
    banner.textContent = view.summary || '对局结束'
  } else {
    banner.textContent = (view.turn === human ? '轮到你' : '等待 AI 落子…') + (view.summary ? ' · ' + view.summary : '')
  }
  if (selected !== null && selectedCoord !== null) {
    var count = 0
    for (var key in reach) { count += 1; void key }
    hint.textContent = '已选 ' + sideName(human) + ' ' + nameAt(selected) + ' · 可落点 ' + count + ' 处'
  } else if (myTurn) {
    hint.textContent = '轮到你：先点自家弹珠，再点亮起的洞位'
  } else {
    hint.textContent = ''
  }
}

window.addEventListener('message', function (event) {
  var data = event.data
  if (!data || data.type !== 'dsh-soulmojito:game-state' || data.token !== TOKEN) return
  sending = false
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null }
  selected = null
  current = { view: data.view, session: data.session || null }
  render()
})

if (!TOKEN) {
  current = {
    view: {
      state: PREVIEW.state,
      turn: PREVIEW.state.turn,
      legal: PREVIEW.legal,
      finished: PREVIEW.state.finished,
      summary: '静态预览（无 token）',
    },
    session: null,
  }
  render()
}
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const chineseCheckers = { manifest, engine, viewHtml } as const
