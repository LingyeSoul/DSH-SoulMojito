/**
 * 内置游戏：9×10 中国象棋（提案 0018 §4.1 内置序列第三款，2026-10-14）。
 *
 * 需求源：用户「新建内置游戏 中国象棋」。装载形态与 builtin/gomoku.ts、
 * builtin/tic-tac-toe.ts 同款——静态 import 的 TS 引擎 + viewHtml 字符串常量
 * 内联（mood-tracker UI_PAGE 先例），零文件依赖、随插件分发；决策与边界见
 * decisions/2026-10-14-xiangqi-builtin.md。
 *
 * 规则面（v1 明示裁剪，决策文档同款）：
 * - 实现全部常规着法：车直行、马走日（蹩马腿）、象走田（塞象眼、不过河）、
 *   士斜行一步（不出九宫）、将/帅直行一步（不出九宫）、炮直行与隔一子吃、
 *   兵/卒过河前只进、过河后可横走、永不后退；
 * - 实现将军检测（含将帅照面「白脸将」——同纵线无遮挡视作将/帅对王攻击，
 *   走成照面即视为送将）、送将被禁（含被牵制的子不能走开）、将死与困毙
 *   （轮到走子而无任何合法着法即终局，且**两种都是对方胜**——困毙按象棋
 *   规则判负，与国际象棋的和棋相反，这是本项目规则面最容易踩错的一条）；
 * - 不实现长将/长捉/循环裁决与「自然限着」和棋（v1 无自动和棋：对局只以
 *   将死/困毙/认输结束）——与五子棋「自由规则」同款的分层裁剪纪律。
 *
 * 契约照抄 family（§3.2/§3.3）：JSON-safe state、深拷贝不改入参、确定性
 * （全文无随机/时间源——createGame 的 options/seed 接受但忽略）、非法动作
 * 中文报错、describe 带棋谱记法。legalActions 是**建议集**（§3.2 ≤64）而非
 * 合法性依据：完整性优先——正常局面返回全部合法着法；理论最大机动局面超过
 * 64 时按「吃子优先（按被吃子力价值降序）」截断（实战不可达的极端局面）。
 * applyAction 按全量规则终审任意动作。
 *
 * state 形状（运行时补充契约：顶层 `turn` 为当前行棋方角色名）：
 * { board: (null | 'R'|'H'|'E'|'A'|'K'|'C'|'P'（红，大写） | 同字母小写（黑）)[][],
 *   turn: 'red' | 'black', ply: number,
 *   lastMove: { from, to, piece, captured } | null,
 *   check: boolean（当前行棋方正被将军）, finished: boolean,
 *   winner: 'red' | 'black' | null, ending: 'checkmate' | 'stalemate' | null }
 * 坐标：x 为 0-8 列（摆放视角左起）、y 为 0-9 行（黑方底线 y=0、红方底线
 * y=9）；红方先行（roles[0]），红方朝 y 减小方向前进。
 *
 * 记谱（describe/events/summary 统一用中文象棋记谱）：纵线自右向左编号——
 * 红方用汉字一-九、黑方用阿拉伯 1-9（均自各自右侧起算，即红 file = 9-x、
 * 黑 file = x+1）；车/炮/兵/将 进退报步数、马/象/士 进退报目标纵线、横向
 * 一律「平」报目标纵线；同纵线同方同兵种以 前/中/后 消歧（四个以上用
 * 前、二、三…、后——理论可达、实战几乎不可达，取此确定性方案并如实标注）。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面；**人类回合才启用
 * 选子/走子交互**（先点己方棋子选中、再点建议集内高亮目标，上行
 * {type:'move',from,to}；AI 回合落子经下行自动出现，避免无谓 409）。与五子棋
 * 视图的差异语义（如实）：五子棋任意空点皆可点（服务端只查「轮到谁」），象棋
 * 只放行建议集内的目标——因为象棋的合法性是局部的（蹩腿/塞眼/炮架/送将），
 * 放开点击会大量撞 400。
 */

import { parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

const WIDTH = 9
const HEIGHT = 10
/** 建议集上限（§3.2：≤64）。 */
const MAX_SUGGESTIONS = 64

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.xiangqi',
  name: '中国象棋',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['red', 'black'] },
  turnBased: true,
  actionVocabulary: "走子 {type:'move', from:{x,y}, to:{x,y}}，x 为 0-8 列（摆放视角左起）、y 为 0-9 行（黑方底线 y=0、红方底线 y=9，红方朝 y 减小方向前进）；红方先行，全量合法性（含蹩马腿/塞象眼/炮架/送将与将帅照面）由本引擎终审；认输 {type:'resign'} 由运行时统一处理",
}

type Side = 'red' | 'black'

interface Point {
  x: number
  y: number
}

interface XiangqiState {
  board: (string | null)[][]
  turn: Side
  ply: number
  lastMove: { from: Point; to: Point; piece: string; captured: string | null } | null
  /** 当前行棋方是否正被将军（含将帅照面）。 */
  check: boolean
  finished: boolean
  winner: Side | null
  /** 终局方式：将死 / 困毙（两者都是对方胜）。 */
  ending: 'checkmate' | 'stalemate' | null
}

/** 兵种名：红大写 / 黑小写同一字母（R 车 H 马 E 象 A 士 K 将 C 炮 P 兵）。 */
const RED_NAMES: Record<string, string> = { R: '车', H: '马', E: '相', A: '仕', K: '帅', C: '炮', P: '兵' }
const BLACK_NAMES: Record<string, string> = { r: '车', h: '马', e: '象', a: '士', k: '将', c: '炮', p: '卒' }
const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
/** 子力价值（仅用于建议集排序与吃子叙述，不参与规则判定）。 */
const PIECE_VALUE: Record<string, number> = { K: 1000, R: 9, C: 5, H: 4, P: 2, A: 2, E: 2 }

const ORTHO: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const DIAGONAL: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const HORSE: Array<[number, number]> = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]

function pieceName(piece: string): string {
  return RED_NAMES[piece] ?? BLACK_NAMES[piece] ?? piece
}

function sideOfPiece(piece: string): Side {
  return piece === piece.toUpperCase() ? 'red' : 'black'
}

function sideName(side: Side): string {
  return side === 'red' ? '红方' : '黑方'
}

function ownerName(side: Side): string {
  return side === 'red' ? '红' : '黑'
}

function other(side: Side): Side {
  return side === 'red' ? 'black' : 'red'
}

function isOnBoard(x: unknown, y: unknown): boolean {
  return Number.isInteger(x) && Number.isInteger(y)
    && (x as number) >= 0 && (x as number) < WIDTH && (y as number) >= 0 && (y as number) < HEIGHT
}

function coordText(x: number, y: number): string {
  return `(${x},${y})`
}

/** 己方半场（象不可过河：红 y≥5、黑 y≤4）。 */
function inOwnHalf(side: Side, y: number): boolean {
  return side === 'red' ? y >= 5 : y <= 4
}

/** 过河（兵/卒横走资格：红 y≤4、黑 y≥5）。 */
function crossedRiver(side: Side, y: number): boolean {
  return side === 'red' ? y <= 4 : y >= 5
}

/** 九宫（士/将约束：列恒为 3-5；红行 7-9、黑行 0-2）。 */
function inPalace(side: Side, x: number, y: number): boolean {
  if (x < 3 || x > 5) return false
  return side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2
}

/** 红方纵线号（1-9，自红方右侧起算）↔ 黑方纵线号（1-9，自黑方右侧起算）。 */
function fileNumber(side: Side, x: number): number {
  return side === 'red' ? WIDTH - x : x + 1
}

/** 数字字形：红用汉字、黑用阿拉伯（写谱惯例）。 */
function digit(side: Side, n: number): string {
  return side === 'red' ? (CN_DIGITS[n - 1] ?? String(n)) : String(n)
}

/** 空盘 + 初始摆子（镜像标准开局图，两处对称核对于测试）。 */
function initialState(): XiangqiState {
  const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R']
  const board: (string | null)[][] = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null))
  for (let x = 0; x < WIDTH; x += 1) {
    board[0]![x] = back[x]!.toLowerCase()
    board[9]![x] = back[x]!
  }
  board[2]![1] = 'c'
  board[2]![7] = 'c'
  for (const x of [0, 2, 4, 6, 8]) {
    board[3]![x] = 'p'
    board[6]![x] = 'P'
  }
  board[7]![1] = 'C'
  board[7]![7] = 'C'
  return {
    board,
    turn: 'red',
    ply: 0,
    lastMove: null,
    check: false,
    finished: false,
    winner: null,
    ending: null,
  }
}

type Board = (string | null)[][]

/** 目标点可落判定：界内且非己方棋子。 */
function pushIfAllowed(moves: Point[], board: Board, side: Side, tx: number, ty: number): void {
  if (!isOnBoard(tx, ty)) return
  const target = board[ty]![tx]
  if (target === null || target === undefined || sideOfPiece(target) !== side) moves.push({ x: tx, y: ty })
}

/**
 * 单子走法生成（含全部几何规则与阻挡；**不含**「走完是否送将」过滤）。
 * 车/炮的滑行、马腿、象眼、九宫、过河约束逐一在此收口——攻击检测
 * （isAttacked）复用本函数，保证「走法」与「攻击面」永远同一份事实。
 */
function pseudoMoves(board: Board, x: number, y: number): Point[] {
  const piece = board[y]?.[x]
  if (piece === null || piece === undefined) return []
  const side = sideOfPiece(piece)
  const kind = piece.toUpperCase()
  const moves: Point[] = []

  if (kind === 'R' || kind === 'C') {
    for (const [dx, dy] of ORTHO) {
      let cx = x + dx!
      let cy = y + dy!
      let screen = false
      while (isOnBoard(cx, cy)) {
        const target = board[cy]![cx]
        if (!screen) {
          if (target === null) {
            // 车：空点即走点；炮：空点是无子平移的走点。
            moves.push({ x: cx, y: cy })
          } else {
            if (kind === 'R') {
              // 车：首个棋子可吃（敌）即止（己方则止不可落）。
              if (sideOfPiece(target) !== side) moves.push({ x: cx, y: cy })
              break
            }
            // 炮：首个棋子是炮架，转入翻山相位。
            screen = true
          }
        } else if (target !== null) {
          // 炮：炮架之后的第一个棋子——敌子可吃，然后无论敌我都止。
          if (sideOfPiece(target) !== side) moves.push({ x: cx, y: cy })
          break
        }
        cx += dx!
        cy += dy!
      }
    }
    return moves
  }

  if (kind === 'H') {
    for (const [dx, dy] of HORSE) {
      const tx = x + dx!
      const ty = y + dy!
      if (!isOnBoard(tx, ty)) continue
      // 蹩马腿：长轴方向的正交邻点（先直后斜）。
      const legX = Math.abs(dx) === 2 ? x + Math.sign(dx!) : x
      const legY = Math.abs(dy) === 2 ? y + Math.sign(dy!) : y
      if (board[legY]![legX] !== null) continue
      pushIfAllowed(moves, board, side, tx, ty)
    }
    return moves
  }

  if (kind === 'E') {
    for (const [dx, dy] of DIAGONAL) {
      const tx = x + dx! * 2
      const ty = y + dy! * 2
      if (!isOnBoard(tx, ty)) continue
      if (!inOwnHalf(side, ty)) continue
      // 塞象眼：田字中心点被占即不可走。
      if (board[y + dy!]![x + dx!] !== null) continue
      pushIfAllowed(moves, board, side, tx, ty)
    }
    return moves
  }

  if (kind === 'A') {
    for (const [dx, dy] of DIAGONAL) {
      const tx = x + dx!
      const ty = y + dy!
      if (!isOnBoard(tx, ty) || !inPalace(side, tx, ty)) continue
      pushIfAllowed(moves, board, side, tx, ty)
    }
    return moves
  }

  if (kind === 'K') {
    for (const [dx, dy] of ORTHO) {
      const tx = x + dx!
      const ty = y + dy!
      if (!isOnBoard(tx, ty) || !inPalace(side, tx, ty)) continue
      pushIfAllowed(moves, board, side, tx, ty)
    }
    return moves
  }

  // P：兵/卒——前进一格恒可（不后退）；过河后增横走一格。
  const forward = side === 'red' ? -1 : 1
  pushIfAllowed(moves, board, side, x, y + forward)
  if (crossedRiver(side, y)) {
    pushIfAllowed(moves, board, side, x - 1, y)
    pushIfAllowed(moves, board, side, x + 1, y)
  }
  return moves
}

/** 指定方的将/帅位置；找不到返回 null（合法对局不可能，防御性兜底）。 */
function generalPos(board: Board, side: Side): Point | null {
  const wanted = side === 'red' ? 'K' : 'k'
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (board[y]![x] === wanted) return { x, y }
    }
  }
  return null
}

/**
 * (x, y) 是否被 bySide 攻击。仅用于王位判定（己方将军检测 / 将的落点合法性
 * / 走子后照面检测）——三处都恰好是「将/帅所在格或落点」，也正是白脸将语义
 * 适用的位置。含飞将：bySide 的将/帅与 (x, y) 同纵线且中间无子视作攻击
 * （走成照面 = 己方将/帅被对方将/帅攻击 = 送将，因此被 moveLeavesOwnKingSafe
 * 与将军检测统一覆盖，无需任何特例分支）。
 */
function isAttacked(board: Board, x: number, y: number, bySide: Side): boolean {
  for (let sy = 0; sy < HEIGHT; sy += 1) {
    for (let sx = 0; sx < WIDTH; sx += 1) {
      const piece = board[sy]![sx]
      if (piece === null || piece === undefined || sideOfPiece(piece) !== bySide) continue
      for (const move of pseudoMoves(board, sx, sy)) {
        if (move.x === x && move.y === y) return true
      }
    }
  }
  const general = generalPos(board, bySide)
  if (general !== null && general.x === x && general.y !== y) {
    const lo = Math.min(general.y, y)
    const hi = Math.max(general.y, y)
    let clear = true
    for (let j = lo + 1; j < hi; j += 1) {
      if (board[j]![general.x] !== null) {
        clear = false
        break
      }
    }
    if (clear) return true
  }
  return false
}

/** 指定方是否被将军（含将帅照面）。 */
function inCheck(board: Board, side: Side): boolean {
  const general = generalPos(board, side)
  if (general === null) return false
  return isAttacked(board, general.x, general.y, other(side))
}

/** 深拷贝棋盘并落子（绝不动入参 board）。 */
function boardAfter(board: Board, from: Point, to: Point): Board {
  const next = board.map((row) => row.slice())
  next[to.y]![to.x] = next[from.y]![from.x] ?? null
  next[from.y]![from.x] = null
  return next
}

/** 走子后己方将/帅是否安全（含照面）——送将与牵制在此一处收口。 */
function moveLeavesOwnKingSafe(board: Board, side: Side, from: Point, to: Point): boolean {
  return !inCheck(boardAfter(board, from, to), side)
}

interface LegalMove {
  from: Point
  to: Point
  capture: string | null
}

/** 指定方全部合法着法（几何规则 × 不送将），按确定性顺序排序后截断至上限。 */
function allLegalMoves(board: Board, side: Side): LegalMove[] {
  const moves: LegalMove[] = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const piece = board[y]![x]
      if (piece === null || piece === undefined || sideOfPiece(piece) !== side) continue
      for (const to of pseudoMoves(board, x, y)) {
        if (!moveLeavesOwnKingSafe(board, side, { x, y }, to)) continue
        moves.push({ from: { x, y }, to, capture: board[to.y]![to.x] ?? null })
      }
    }
  }
  // 确定性排序：吃子优先（被吃子价值降序），其余按 (起点 y,x → 终点 y,x)。
  moves.sort((a, b) => {
    const av = a.capture === null ? -1 : PIECE_VALUE[a.capture.toUpperCase()] ?? 0
    const bv = b.capture === null ? -1 : PIECE_VALUE[b.capture.toUpperCase()] ?? 0
    if (av !== bv) return bv - av
    return (a.from.y - b.from.y) || (a.from.x - b.from.x) || (a.to.y - b.to.y) || (a.to.x - b.to.x)
  })
  return moves.slice(0, MAX_SUGGESTIONS)
}

function hasAnyLegalMove(board: Board, side: Side): boolean {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const piece = board[y]![x]
      if (piece === null || piece === undefined || sideOfPiece(piece) !== side) continue
      for (const to of pseudoMoves(board, x, y)) {
        if (moveLeavesOwnKingSafe(board, side, { x, y }, to)) return true
      }
    }
  }
  return false
}

/**
 * 中文象棋记谱（基于走子**前**局面——前后消歧必须看走子前的同纵线局面）。
 * 车/炮/兵/将 进退报步数；马/象/士 进退报目标纵线；横向一律「平」。
 */
function moveNotation(board: Board, from: Point, to: Point, piece: string): string {
  const side = sideOfPiece(piece)
  const kind = piece.toUpperCase()
  const name = pieceName(piece)

  // 同纵线同方同兵种消歧：红方「前」= y 小（靠近敌方），黑方「前」= y 大。
  const sameColumn: number[] = []
  for (let y = 0; y < HEIGHT; y += 1) {
    if (y === from.y) continue
    const other_ = board[y]?.[from.x]
    if (other_ === null || other_ === undefined) continue
    if (sideOfPiece(other_) === side && other_.toUpperCase() === kind) sameColumn.push(y)
  }
  let head: string
  if (sameColumn.length === 0) {
    head = `${name}${digit(side, fileNumber(side, from.x))}`
  } else {
    const ordered = [...sameColumn, from.y].sort((a, b) => a - b)
    if (side === 'black') ordered.reverse()
    const index = ordered.indexOf(from.y)
    const total = ordered.length
    let label: string
    if (total === 2) label = index === 0 ? '前' : '后'
    else if (total === 3) label = index === 0 ? '前' : index === 1 ? '中' : '后'
    else label = index === 0 ? '前' : index === total - 1 ? '后' : digit(side, index + 1)
    head = `${label}${name}`
  }

  let action: string
  if (to.y === from.y) {
    action = `平${digit(side, fileNumber(side, to.x))}`
  } else {
    const forward = side === 'red' ? to.y < from.y : to.y > from.y
    const verb = forward ? '进' : '退'
    const arg = kind === 'H' || kind === 'E' || kind === 'A'
      ? digit(side, fileNumber(side, to.x))
      : digit(side, Math.abs(to.y - from.y))
    action = `${verb}${arg}`
  }
  return `${sideName(side)} ${head}${action}`
}

/** from/to 坐标解析（形状/类型/界内的分档中文报错）。整数的字符串形态
 *  （"1"、"1.0"——模型桥把工具参数数字写成引号串的实弹习惯）经 parseBoardCoord
 *  归一后与数字同路处理（决策 2026-10-14-quoted-coordinate-tolerance）。 */
function readPoint(raw: unknown, label: string): Point {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} 必须是 {x, y} 坐标对象`)
  }
  const rawX = (raw as { x?: unknown }).x
  const rawY = (raw as { y?: unknown }).y
  const x = parseBoardCoord(rawX)
  const y = parseBoardCoord(rawY)
  if (x === null || y === null) {
    throw new Error(`${label} 坐标必须是整数，收到 x=${JSON.stringify(rawX)}、y=${JSON.stringify(rawY)}`)
  }
  if (!isOnBoard(x, y)) {
    throw new Error(`${label} 坐标超出棋盘：x 为 0-${WIDTH - 1}（列）、y 为 0-${HEIGHT - 1}（行），收到 ${coordText(x, y)}`)
  }
  return { x, y }
}

const engine: GameEngine = {
  meta: MANIFEST,

  /** 开局：标准摆子、红先。options（含 seed）接受但忽略——象棋无随机性。 */
  createGame(_options?: unknown): { state: XiangqiState } {
    return { state: initialState() }
  },

  /** 建议集 = 全部合法着法（完整性优先；>64 时吃子优先截断）；终局返回空数组。 */
  legalActions(state: XiangqiState): Array<{ type: 'move'; from: Point; to: Point }> {
    if (state.finished) return []
    return allLegalMoves(state.board, state.turn).map((move) => ({
      type: 'move' as const,
      from: { ...move.from },
      to: { ...move.to },
    }))
  },

  /**
   * 走子并推进局面。校验顺序：动作形状 → type → 未终局 → 角色 → 坐标形状 →
   * 起终点各异 → 起点有子 → 子属本方 → 几何合法（含阻挡）→ 不送将；任一不过
   * 抛 Error（中文报错）。绝不改入参 state。终局判定：对方无任何合法着法时，
   * 被将军为将死、否则为困毙，两位一体都是本方胜（象棋规则）。
   */
  applyAction(state: XiangqiState, action: unknown, actor: string): {
    state: XiangqiState
    events: string[]
    finished: boolean
    winner: Side | null
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
      throw new Error(`不支持的动作类型「${typed.type}」：本引擎只实现 move（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再走子')
    }
    if (actor !== 'red' && actor !== 'black') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 red/black`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能走子`)
    }
    const from = readPoint(typed.from, 'from')
    const to = readPoint(typed.to, 'to')
    if (from.x === to.x && from.y === to.y) {
      throw new Error(`起点与终点相同（${coordText(from.x, from.y)}），请给出实际走到的目标点`)
    }
    const piece = state.board[from.y]?.[from.x] ?? null
    if (piece === null) {
      throw new Error(`起点 ${coordText(from.x, from.y)} 没有棋子`)
    }
    const pieceSide = sideOfPiece(piece)
    if (pieceSide !== actor) {
      throw new Error(`起点 ${coordText(from.x, from.y)} 是${ownerName(pieceSide)}方的${pieceName(piece)}，${sideName(actor)}不能走对方的棋子`)
    }
    if (!pseudoMoves(state.board, from.x, from.y).some((move) => move.x === to.x && move.y === to.y)) {
      throw new Error(`${pieceName(piece)}从 ${coordText(from.x, from.y)} 不能走到 ${coordText(to.x, to.y)}：不符合走子规则（路径被阻挡、目标被己方棋子占据或目标点在界外）`)
    }
    if (!moveLeavesOwnKingSafe(state.board, actor, from, to)) {
      throw new Error(`这步棋让${sideName(actor)}被将军（含将帅照面；被牵制的子不能走开），不能走`)
    }

    const captured = state.board[to.y]?.[to.x] ?? null
    const nextBoard = boardAfter(state.board, from, to)
    const notation = moveNotation(state.board, from, to, piece)
    const nextTurn = other(actor)
    const oppInCheck = inCheck(nextBoard, nextTurn)
    const oppHasMove = hasAnyLegalMove(nextBoard, nextTurn)
    const finished = !oppHasMove
    const ending: XiangqiState['ending'] = finished ? (oppInCheck ? 'checkmate' : 'stalemate') : null

    const events = [notation]
    const summaryParts = [notation]
    if (captured !== null) {
      const eaten = `吃掉${ownerName(sideOfPiece(captured))}${pieceName(captured)}`
      events.push(eaten)
      summaryParts.push(eaten)
    }
    if (finished) {
      const endingText = oppInCheck ? '将死' : '困毙'
      events.push(endingText)
      events.push(`${sideName(actor)}胜`)
      summaryParts.push(endingText)
      summaryParts.push(`${sideName(actor)}胜`)
    } else if (oppInCheck) {
      events.push('将军！')
      summaryParts.push('将军！')
    }

    const next: XiangqiState = {
      board: nextBoard,
      turn: nextTurn,
      ply: state.ply + 1,
      lastMove: { from: { ...from }, to: { ...to }, piece, captured },
      check: oppInCheck,
      finished,
      winner: finished ? actor : null,
      ending,
    }
    return { state: next, events, finished, winner: next.winner, summary: summaryParts.join('，') }
  },

  /** 人类可读的一手棋描述（中文象棋记谱，基于走子前局面——前后消歧所需）。 */
  describe(state: XiangqiState, actor: string, action: unknown): string {
    if (action !== null && typeof action === 'object' && !Array.isArray(action)
      && (action as { type?: unknown }).type === 'move') {
      try {
        const from = readPoint((action as { from?: unknown }).from, 'from')
        const to = readPoint((action as { to?: unknown }).to, 'to')
        const piece = state.board?.[from.y]?.[from.x] ?? null
        if (piece !== null) return moveNotation(state.board, from, to, piece)
      } catch {
        // 形状不完整交给运行时/applyAction 报错，describe 只负责可读文案。
      }
    }
    return `${sideName(actor === 'black' ? 'black' : 'red')}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as xiangqiEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置象棋随 bundle 分发）。
 * 注意：本字符串在 TS 模板字面量内——脚本内一律字符串拼接，禁止反引号与 ${。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>中国象棋 · dsh-soulmojito 游戏桥</title>
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
  #banner.turn-red   { background: #f2e2da; border-color: #d8b7a8; color: #6b1f14; }
  #banner.turn-black { background: #101216; border-color: #454b57; color: #d8dbe2; }
  #banner.finished   { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview    { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  /* 将军警报态（2026-10-14 用户需求「象棋应该提供提示：如将军提示」）：深红
     闪烁盖过回合底色——提示必须比「轮到谁」抢眼；文案与行动指引见 render()。 */
  #banner.check      { background: #571210; border-color: #e05252; color: #ffe7e3; font-weight: 600;
                       animation: dt-check-flash 1.1s ease-in-out infinite; }
  @keyframes dt-check-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(224, 82, 82, 0); }
                              50% { box-shadow: 0 0 16px 2px rgba(224, 82, 82, .6); } }
  .board-wrap { position: relative; width: 100%; max-width: 560px; }
  svg#board { display: block; width: 100%; height: auto; border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.45); }
  svg#board.interactive .hit { cursor: pointer; }
  .check-ring { animation: dt-pulse 1.15s ease-in-out infinite; }
  @keyframes dt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .overlay {
    position: absolute; inset: 0; border-radius: 10px;
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
<body data-game="dsh-soulmojito.xiangqi">
<header>
  <span class="game-name">中国象棋</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="board-wrap">
  <svg id="board" viewBox="0 0 532 586" role="img" aria-label="中国象棋棋盘 9 列 10 行"></svg>
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
   自读；无 token（浏览器直接打开）渲染静态预览局面。人类回合才启用选子交互：
   先点己方（行棋方）棋子选中，再点建议集内高亮目标走子；AI 回合落子经下行自动
   出现在棋盘上。 */
var NX = 9
var NY = 10
var PAD = 50
var CELL = 54
var LINE = '#6b4a26'
var PIECE_FONT = '"KaiTi", "STKaiti", "BFangSong", "SimSun", serif'
var CN_DIGITS = ['一','二','三','四','五','六','七','八','九']
var PIECE_CHAR = { R:'车', H:'马', E:'相', A:'仕', K:'帅', C:'炮', P:'兵', r:'车', h:'马', e:'象', a:'士', k:'将', c:'炮', p:'卒' }
var MARK_POINTS = [[1,2],[7,2],[1,7],[7,7],[0,3],[2,3],[4,3],[6,3],[8,3],[0,6],[2,6],[4,6],[6,6],[8,6]]

var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var current = null /* 最近一条 game-state：{ state, legal, finished, summary, session } */
var selected = null /* 已选中的己方棋子 {x, y}；新状态到达即清空 */

var boardEl = document.getElementById('board')
var bannerEl = document.getElementById('banner')
var overlayEl = document.getElementById('overlay')
var overlayResultEl = document.getElementById('overlay-result')
var overlaySubEl = document.getElementById('overlay-sub')
var metaEl = document.getElementById('meta')
var hintEl = document.getElementById('hint')

function px(i) { return PAD + i * CELL }
function py(j) { return PAD + j * CELL }
function sideOf(piece) { return piece === piece.toUpperCase() ? 'red' : 'black' }
function sideName(side) { return side === 'red' ? '红方' : '黑方' }

function svgEl(name, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (var key in attrs) el.setAttribute(key, String(attrs[key]))
  return el
}

function emptyBoard() {
  var b = []
  for (var y = 0; y < NY; y++) {
    var row = []
    for (var x = 0; x < NX; x++) row.push(null)
    b.push(row)
  }
  return b
}

/** 由 10 行 9 列字符画构造棋盘（'.' 为空）——仅预览局面使用。 */
function boardFrom(rows) {
  var b = emptyBoard()
  for (var y = 0; y < rows.length && y < NY; y++) {
    for (var x = 0; x < NX && x < rows[y].length; x++) {
      var ch = rows[y].charAt(x)
      if (ch !== '.') b[y][x] = ch
    }
  }
  return b
}

/* 无 token 的静态演示局面：中炮开局五手（炮二平五 / 马8进7 / 马二进三 /
   车9平8 / 车一平二），轮黑。 */
var PREVIEW_STATE = {
  board: boardFrom([
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
  ]),
  turn: 'black',
  ply: 5,
  lastMove: { from: { x: 8, y: 9 }, to: { x: 7, y: 9 }, piece: 'R', captured: null },
  check: false,
  finished: false,
  winner: null,
  ending: null,
}
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-soulmojito.xiangqi',
  players: [
    { role: 'red', owner: 'human' },
    { role: 'black', owner: 'agent' },
  ],
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
  selected = null
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

function humanTurn(act) {
  if (!act.state || act.state.finished) return false
  return ownerOf(act.session, act.state.turn) !== 'agent'
}

function legalFrom(act, from) {
  var out = []
  var legals = act.legal || []
  for (var i = 0; i < legals.length; i++) {
    var move = legals[i]
    if (!move || !move.from || !move.to) continue
    if (move.from.x === from.x && move.from.y === from.y) out.push(move)
  }
  return out
}

function findGeneral(board, side) {
  var wanted = side === 'red' ? 'K' : 'k'
  for (var y = 0; y < NY; y++) {
    for (var x = 0; x < NX; x++) {
      if (board[y][x] === wanted) return { x: x, y: y }
    }
  }
  return null
}

function endText(state) {
  if (state.winner === 'red') return '红方获胜'
  if (state.winner === 'black') return '黑方获胜'
  return '对局结束'
}

function render() {
  var act = active()
  var state = act.state
  var live = current !== null || TOKEN !== null

  renderBoard(act)

  if (!live) metaEl.textContent = '预览模式'
  else if (!state) metaEl.textContent = '等待会话…'
  else metaEl.textContent = (act.session && act.session.id ? '对局 ' + act.session.id : '对局中') + ' · 已走 ' + state.ply + ' 手'

  var cls = 'preview'
  var text = '预览模式：由 dsh-soulmojito 游戏服务装载后启用对弈'
  if (live) {
    if (!state) {
      text = '等待对局状态…'
    } else if (act.finished) {
      cls = 'finished'
      text = act.summary ? '对局结束 · ' + act.summary : '对局结束：' + endText(state)
    } else if (state.check) {
      /* 将军提示（2026-10-14 用户需求「象棋应该提供提示：如将军提示」）：
         警报优先于回合底色与往手摘要——check 态独用闪烁横幅；文案分
         「你被将 / AI 被将」两语境（归属经 ownerOf 反查，人类未必执红）。 */
      cls = 'check'
      var checkedOwner = ownerOf(act.session, state.turn)
      if (checkedOwner === 'human') {
        text = '将军！你（' + sideName(state.turn) + '）被将军了——必须解将'
      } else if (checkedOwner === 'agent') {
        text = '将军！' + sideName(state.turn) + '被将军——AI 正在解将…'
      } else {
        text = '将军！' + sideName(state.turn) + '被将军'
      }
    } else {
      cls = state.turn === 'red' ? 'turn-red' : 'turn-black'
      var owner = ownerOf(act.session, state.turn)
      text = sideName(state.turn) + (owner === 'agent' ? ' · AI 思考中…' : owner === 'human' ? ' · 轮到你走子' : '行动中')
      if (act.summary) text += ' · ' + act.summary
    }
  }
  bannerEl.className = cls
  bannerEl.textContent = text

  var finished = !!(live && state && act.finished)
  overlayEl.className = finished ? 'overlay' : 'overlay hidden'
  if (finished) {
    overlayResultEl.textContent = endText(state)
    var sub = act.summary || '对局结束'
    /* 认输由运行时以「<角色> 认输」合成（引擎不参与）——此处仅做展示本地化。 */
    if (!state.winner && sub.indexOf('认输') >= 0) {
      if (sub.indexOf('red') === 0) overlayResultEl.textContent = '红方认输'
      else if (sub.indexOf('black') === 0) overlayResultEl.textContent = '黑方认输'
    }
    overlaySubEl.textContent = sub
  }

  if (!live) {
    hintEl.textContent = '这是静态演示局面：由 dsh-soulmojito 游戏服务装载后，棋盘将接收实时状态并启用选子走子。'
  } else if (!state) {
    hintEl.textContent = '正在连接 dsh-soulmojito 游戏服务…'
  } else if (act.finished) {
    hintEl.textContent = '对局已结束。可在对局面板中开新一局，或让 AI 再来一盘。'
  } else if (humanTurn(act)) {
    hintEl.textContent = state.check
      ? '你被将军了——必须解将：移动帅/仕、垫子到将军线路上、或吃掉正在将军的棋子；点击己方棋子可看高亮走法。'
      : '点击己方棋子选中，再点高亮目标走子；走法合法性（含将军与将帅照面）由服务端引擎终审。'
  } else if (state.check) {
    hintEl.textContent = sideName(state.turn) + '被将军，AI 正在解将；走子将自动出现在棋盘上。'
  } else {
    hintEl.textContent = 'AI 思考中，走子将自动出现在棋盘上。'
  }
}

function renderBoard(act) {
  var state = act.state
  while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild)

  boardEl.appendChild(svgEl('rect', { x: 0, y: 0, width: 532, height: 586, rx: 10, fill: '#e9d3a3' }))
  /* 外框离盘 40px：棋子半径 23.5 与纵线号（贴外框内侧）都落在框内，不会被
     棋子越框遮挡（真机验收 2026-10-14 修：±16 时底排棋子穿框、纵线号被压）。 */
  boardEl.appendChild(svgEl('rect', {
    x: px(0) - 40, y: py(0) - 40, width: px(8) - px(0) + 80, height: py(9) - py(0) + 80,
    fill: 'none', stroke: LINE, 'stroke-width': 2,
  }))

  for (var j = 0; j < NY; j++) {
    boardEl.appendChild(svgEl('line', {
      x1: px(0), y1: py(j), x2: px(8), y2: py(j), stroke: LINE, 'stroke-width': j === 0 || j === NY - 1 ? 2.4 : 1.2,
    }))
  }
  for (var i = 0; i < NX; i++) {
    if (i === 0 || i === NX - 1) {
      boardEl.appendChild(svgEl('line', {
        x1: px(i), y1: py(0), x2: px(i), y2: py(9), stroke: LINE, 'stroke-width': 2.4,
      }))
    } else {
      boardEl.appendChild(svgEl('line', { x1: px(i), y1: py(0), x2: px(i), y2: py(4), stroke: LINE, 'stroke-width': 1.2 }))
      boardEl.appendChild(svgEl('line', { x1: px(i), y1: py(5), x2: px(i), y2: py(9), stroke: LINE, 'stroke-width': 1.2 }))
    }
  }

  /* 九宫斜线（双端） */
  boardEl.appendChild(svgEl('line', { x1: px(3), y1: py(0), x2: px(5), y2: py(2), stroke: LINE, 'stroke-width': 1.2 }))
  boardEl.appendChild(svgEl('line', { x1: px(5), y1: py(0), x2: px(3), y2: py(2), stroke: LINE, 'stroke-width': 1.2 }))
  boardEl.appendChild(svgEl('line', { x1: px(3), y1: py(7), x2: px(5), y2: py(9), stroke: LINE, 'stroke-width': 1.2 }))
  boardEl.appendChild(svgEl('line', { x1: px(5), y1: py(7), x2: px(3), y2: py(9), stroke: LINE, 'stroke-width': 1.2 }))

  /* 楚河汉界：基线取河带中心，横向避开兵/卒纵线（0·2·4·6·8 列）——河带里
     有子时文字不会被棋子压住（真机验收 2026-10-14 修）。 */
  var river = svgEl('text', {
    x: (px(0) + px(4)) / 2 + 42, y: (py(4) + py(5)) / 2 + 8, 'text-anchor': 'middle',
    'font-size': 22, 'font-family': PIECE_FONT, fill: LINE, 'letter-spacing': 8,
  })
  river.textContent = '楚河'
  boardEl.appendChild(river)
  var river2 = svgEl('text', {
    x: (px(4) + px(8)) / 2 - 42, y: (py(4) + py(5)) / 2 + 8, 'text-anchor': 'middle',
    'font-size': 22, 'font-family': PIECE_FONT, fill: LINE, 'letter-spacing': 8,
  })
  river2.textContent = '汉界'
  boardEl.appendChild(river2)

  /* 炮位/兵位定位角标（棋盘缘上的点只画朝内两角） */
  for (var m = 0; m < MARK_POINTS.length; m++) {
    drawMarks(MARK_POINTS[m][0], MARK_POINTS[m][1])
  }

  /* 纵线号：下（红方一-九，自右向左）/ 上（黑方 1-9，自右向左）。位置按棋子
     半径 23.5 与字形高度推：上排基线 -27、下排基线 +36（贴外框内、不压棋子）。 */
  for (var c = 0; c < NX; c++) {
    var bottom = svgEl('text', {
      x: px(c), y: py(9) + 36, 'text-anchor': 'middle', 'font-size': 13, fill: LINE,
    })
    bottom.textContent = CN_DIGITS[NX - 1 - c]
    boardEl.appendChild(bottom)
    var top = svgEl('text', {
      x: px(c), y: py(0) - 27, 'text-anchor': 'middle', 'font-size': 13, fill: LINE,
    })
    top.textContent = CN_DIGITS[c]
    boardEl.appendChild(top)
  }

  if (!state || !state.board) {
    boardEl.setAttribute('class', '')
    return
  }

  for (var y = 0; y < NY; y++) {
    for (var x = 0; x < NX; x++) {
      var piece = state.board[y][x]
      if (piece === null || piece === undefined || piece === '') continue
      drawPiece(x, y, piece)
    }
  }

  if (state.lastMove && state.lastMove.from && state.lastMove.to) {
    boardEl.appendChild(svgEl('circle', {
      cx: px(state.lastMove.from.x), cy: py(state.lastMove.from.y), r: 26,
      fill: 'none', stroke: 'rgba(43,58,90,.55)', 'stroke-width': 2, 'stroke-dasharray': '4 3',
    }))
    boardEl.appendChild(svgEl('circle', {
      cx: px(state.lastMove.to.x), cy: py(state.lastMove.to.y), r: 26,
      fill: 'none', stroke: '#c0392b', 'stroke-width': 2.4,
    }))
  }

  /* 将军标记：行棋方的将/帅红圈脉冲 + 底光晕（2026-10-14 提示增强——光晕让
     被将的子在小尺寸面板里也一眼可见，脉冲圈保持原样）。 */
  if (state.check && !act.finished) {
    var general = findGeneral(state.board, state.turn)
    if (general) {
      boardEl.appendChild(svgEl('circle', {
        cx: px(general.x), cy: py(general.y), r: 31,
        fill: 'rgba(224, 82, 82, .18)', class: 'check-halo',
      }))
      boardEl.appendChild(svgEl('circle', {
        cx: px(general.x), cy: py(general.y), r: 27.5,
        fill: 'none', stroke: '#e05252', 'stroke-width': 3, class: 'check-ring',
      }))
    }
  }

  var ownTurn = humanTurn(act)

  /* 选中与目标高亮（仅人类回合） */
  if (selected && ownTurn && !act.finished) {
    boardEl.appendChild(svgEl('circle', {
      cx: px(selected.x), cy: py(selected.y), r: 27.5, fill: 'none', stroke: '#d99a1e', 'stroke-width': 3.5,
    }))
    var targets = legalFrom(act, selected)
    for (var t = 0; t < targets.length; t++) {
      var to = targets[t].to
      if (state.board[to.y][to.x] === null) {
        boardEl.appendChild(svgEl('circle', { cx: px(to.x), cy: py(to.y), r: 6, fill: 'rgba(154,110,20,.85)' }))
      } else {
        boardEl.appendChild(svgEl('circle', {
          cx: px(to.x), cy: py(to.y), r: 26.5, fill: 'none', stroke: '#d9791e', 'stroke-width': 3,
        }))
      }
    }
  }

  boardEl.setAttribute('class', ownTurn ? 'interactive' : '')
  for (var hy = 0; hy < NY; hy++) {
    for (var hx = 0; hx < NX; hx++) {
      boardEl.appendChild(svgEl('circle', {
        cx: px(hx), cy: py(hy), r: 27, fill: 'transparent', 'data-x': hx, 'data-y': hy, 'class': 'hit',
      }))
    }
  }
}

function drawMarks(x, y) {
  var gap = 7
  var arm = 7
  var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
  for (var k = 0; k < corners.length; k++) {
    var hx = corners[k][0]
    var hy = corners[k][1]
    if (hx < 0 && x === 0) continue
    if (hx > 0 && x === NX - 1) continue
    var sx = px(x) + hx * gap
    var sy = py(y) + hy * gap
    var path = svgEl('path', {
      d: 'M ' + (px(x) + hx * (gap + arm)) + ' ' + sy + ' L ' + sx + ' ' + sy + ' L ' + sx + ' ' + (py(y) + hy * (gap + arm)),
      fill: 'none', stroke: LINE, 'stroke-width': 1.6,
    })
    boardEl.appendChild(path)
  }
}

function drawPiece(x, y, piece) {
  var red = sideOf(piece) === 'red'
  var color = red ? '#b02a1e' : '#26282e'
  boardEl.appendChild(svgEl('circle', {
    cx: px(x), cy: py(y), r: 23.5, fill: '#f9f1de', stroke: color, 'stroke-width': 1.6,
  }))
  boardEl.appendChild(svgEl('circle', {
    cx: px(x), cy: py(y), r: 19.5, fill: 'none', stroke: color, 'stroke-width': 1, opacity: 0.45,
  }))
  var label = svgEl('text', {
    x: px(x), y: py(y) + 1, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-size': 30, 'font-family': PIECE_FONT, 'font-weight': 600, fill: color,
  })
  label.textContent = PIECE_CHAR[piece] || '?'
  boardEl.appendChild(label)
}

/* 点击：已选中且目标在建议集内 → 上行 move；点己方（行棋方）棋子 → 选中/换选；
   其他点击 → 取消选择。合法性终审在服务端（400 中文报错经父页提示）。 */
boardEl.addEventListener('click', function (event) {
  if (!TOKEN) return
  var act = active()
  if (!act.state || !act.state.board || act.finished || !humanTurn(act)) return
  var target = event.target
  if (!target || target.getAttribute('data-x') === null) return
  var x = Number(target.getAttribute('data-x'))
  var y = Number(target.getAttribute('data-y'))

  if (selected) {
    var targets = legalFrom(act, selected)
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].to.x === x && targets[i].to.y === y) {
        window.parent.postMessage(
          { type: 'dsh-soulmojito:game-action', token: TOKEN, action: { type: 'move', from: { x: selected.x, y: selected.y }, to: { x: x, y: y } } },
          '*',
        )
        selected = null
        return
      }
    }
  }

  var piece = act.state.board[y][x]
  if (typeof piece === 'string' && piece !== '' && sideOf(piece) === act.state.turn) {
    selected = { x: x, y: y }
    render()
    return
  }

  if (selected) {
    selected = null
    render()
  }
})

render()
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const xiangqi = { manifest, engine, viewHtml } as const
