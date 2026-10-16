/**
 * 内置游戏：5×12 军棋（陆战棋，提案 0018 §4.1 内置序列第四款，2026-10-14）。
 *
 * 需求源：用户「添加新内置游戏军棋」。装载形态与 builtin/tic-tac-toe.ts、
 * builtin/gomoku.ts、builtin/xiangqi.ts 同款——静态 import 的 TS 引擎 +
 * viewHtml 字符串常量内联，零文件依赖、随插件分发；决策与边界见
 * decisions/2026-10-14-junqi-builtin.md。
 *
 * 规则面（v1 明示裁剪，决策文档同款）：
 * - 变体为**明棋**（双方子力互相可见）：桥 v1 的视图载荷（viewOf）与
 *   game_state 工具都是全量 state 下发、无按角色投影的通道，暗棋会在两个
 *   方向泄密——这是接口事实决定的裁剪，不是规则偏好。
 * - 布阵为**经典固定布阵**（25 子镜像对称）：运行时 sessions.start 调
 *   createGame() 不传参（无 seed 通道），随机布阵无从谈起；固定布阵让
 *   对局确定性可复现（全文无随机/时间源，与象棋同纪律）。
 * - 实现全部常规着法：公路一步（含行营斜线八达、大本营斜线三向）、铁路
 *   直线任意距离（非工兵**不可转弯**，遇子即止不可穿越）、工兵铁路任意
 *   路径（可转弯，不可穿越占子）；地雷/军旗永不可动，进入大本营的棋子
 *   （含初始就位）不能再动；行营中的棋子**不可被攻击**（进营只可落空营）。
 * - 实现全部战斗裁决：大子吃小子（攻击方大则占位、小则阵亡）、同级与
 *   炸弹对任何子（含地雷）同归于尽、地雷克一切非工兵攻击子、工兵挖雷、
 *   扛走军旗即胜（任何攻击子含炸弹）。
 * - 终局两途：夺旗（扛走对方军旗）与困毙（对方轮到走子而无任何合法着法
 *   判负——军棋规则，无子和棋）；认输由运行时统一处理。
 * - 不实现：布阵阶段、暗棋/翻棋变体、四国军棋、长捉循环裁决（与象棋 v1
 *   同款分层裁剪纪律——对局主干完整可玩，循环类裁决留待单独立项）。
 *
 * 契约照抄 family（§3.2/§3.3）：JSON-safe state、深拷贝不改入参、确定性、
 * 非法动作中文报错、describe 带叙述。legalActions 是**建议集**（§3.2 ≤64）
 * 而非合法性依据：完整性优先——正常局面返回全部合法着法（固定布阵下机动
 * 量有限，初始 34 步）；理论极端局面超过 64 时按「吃子优先（按被吃子威胁
 * 价值降序）」截断。applyAction 按全量规则终审任意动作。
 *
 * state 形状（运行时补充契约：顶层 `turn` 为当前行棋方角色名）：
 * { board: (null | 'M'|'G'|'D'|'B'|'R'|'T'|'C'|'P'|'E'|'Z'|'L'|'F'（红，大写）
 *          | 同字母小写（蓝）)[][],
 *   turn: 'red' | 'blue', ply: number,
 *   lastMove: { from, to, piece, captured, outcome } | null,
 *   finished: boolean, winner: 'red' | 'blue' | null,
 *   ending: 'flag' | 'immobilized' | null }
 * 子力编码：M 司令 G 军长 D 师长 B 旅长 R 团长 T 营长 C 连长 P 排长
 * E 工兵 Z 炸弹 L 地雷 F 军旗；红大写、蓝小写。
 * 坐标：x 为 0-4 列（左起）、y 为 0-11 行（蓝方底线 y=0、红方底线 y=11）；
 * 红方先行（roles[0]），两方相向推进。行营：蓝 (1,2)(3,2)(2,3)(1,4)(3,4)、
 * 红 (1,7)(3,7)(2,8)(1,9)(3,9)；大本营：蓝 (1,0)(3,0)、红 (1,11)(3,11)。
 *
 * 记谱（describe/events/summary 统一）：军棋无通行棋谱记法，取「方 子力
 * (x,y)→(x,y)〔沿铁路〕〔，战斗结果〕」的坐标叙述——Agent 叙述与落子坐标
 * 同一套（坐标即动作面），不发明玩家对不上的假记谱。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面；人类回合才启用
 * 选子/走子交互（先点己方棋子选中、再点建议集内高亮目标，上行
 * {type:'move',from,to}）。与象棋视图同款语义：只放行建议集内的目标——
 * 军棋的合法性是几何的（铁路拐弯/行营免攻/穿越占子），放开点击会大量撞 400。
 */

import { parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

const WIDTH = 5
const HEIGHT = 12
/** 建议集上限（§3.2：≤64）。 */
const MAX_SUGGESTIONS = 64

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.junqi',
  name: '军棋',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['red', 'blue'] },
  turnBased: true,
  actionVocabulary: "走子 {type:'move', from:{x,y}, to:{x,y}}，x 为 0-4 列（左起）、y 为 0-11 行（蓝方底线 y=0、红方底线 y=11，红方先行）；公路一步（行营斜线八达、大本营斜线三向），铁路直线任意距离（非工兵不可转弯、不可穿越棋子），工兵铁路可转弯；大子吃小子、同级与炸弹同归于尽、地雷克非工兵、工兵挖雷、行营中的棋子不可被攻击、扛走军旗即胜；认输 {type:'resign'} 由运行时统一处理",
}

type Side = 'red' | 'blue'

interface Point {
  x: number
  y: number
}

/** 单手战斗结果（叙述与棋盘变更的同一份事实）。 */
type CombatOutcome = 'capture' | 'both' | 'attacker-dies' | 'defused' | 'flag'

interface JunqiState {
  board: (string | null)[][]
  turn: Side
  ply: number
  lastMove: { from: Point; to: Point; piece: string; captured: string | null; outcome: CombatOutcome | 'move' } | null
  finished: boolean
  winner: Side | null
  ending: 'flag' | 'immobilized' | null
}

/** 子力名（红蓝同名单）：M 司令 G 军长 D 师长 B 旅长 R 团长 T 营长 C 连长 P 排长 E 工兵 Z 炸弹 L 地雷 F 军旗。 */
const PIECE_NAMES: Record<string, string> = {
  M: '司令', G: '军长', D: '师长', B: '旅长', R: '团长', T: '营长',
  C: '连长', P: '排长', E: '工兵', Z: '炸弹', L: '地雷', F: '军旗',
}
/** 军衔大小（战斗裁决用；Z/L/F 特殊子不在此表，resolveCombat 特判）。 */
const RANK: Record<string, number> = { M: 9, G: 8, D: 7, B: 6, R: 5, T: 4, C: 3, P: 2, E: 1 }
/** 建议集排序用的被吃子威胁价值（仅排序，不参与规则判定）。 */
const THREAT_ORDER: Record<string, number> = { F: 100, M: 90, G: 80, D: 70, B: 60, Z: 55, R: 50, T: 40, C: 30, P: 20, L: 15, E: 10 }

const ORTHO: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const DIAGONAL: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]]

function pieceName(piece: string): string {
  return PIECE_NAMES[piece.toUpperCase()] ?? piece
}

function sideOfPiece(piece: string): Side {
  return piece === piece.toUpperCase() ? 'red' : 'blue'
}

function sideName(side: Side): string {
  return side === 'red' ? '红方' : '蓝方'
}

function ownerName(side: Side): string {
  return side === 'red' ? '红' : '蓝'
}

function other(side: Side): Side {
  return side === 'red' ? 'blue' : 'red'
}

function isOnBoard(x: unknown, y: unknown): boolean {
  return Number.isInteger(x) && Number.isInteger(y)
    && (x as number) >= 0 && (x as number) < WIDTH && (y as number) >= 0 && (y as number) < HEIGHT
}

function coordText(x: number, y: number): string {
  return `(${x},${y})`
}

/* ------------------------- 棋盘几何（图与边） ------------------------- */

/** 行营（八向连接、宿子免攻）：蓝五个 + 红五个。 */
const CAMP_KEYS = new Set(['1,2', '3,2', '2,3', '1,4', '3,4', '1,7', '3,7', '2,8', '1,9', '3,9'])
/** 大本营（斜线三向连接、入营冻结）：蓝两个 + 红两个。 */
const HQ_KEYS = new Set(['1,0', '3,0', '1,11', '3,11'])

function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  const left = `${ax},${ay}`
  const right = `${bx},${by}`
  return left < right ? `${left}|${right}` : `${right}|${left}`
}

/** 铁路边集合：横线 y∈{1,5,6,10} 全列；纵线 x∈{0,4} 贯通 y=1..10（跨前线）；中线 (2,5)-(2,6)。 */
const RAIL_EDGES = new Set<string>()
for (const y of [1, 5, 6, 10]) {
  for (let x = 0; x < WIDTH - 1; x += 1) RAIL_EDGES.add(edgeKey(x, y, x + 1, y))
}
for (const x of [0, 4]) {
  for (let y = 1; y <= 9; y += 1) RAIL_EDGES.add(edgeKey(x, y, x, y + 1))
}
RAIL_EDGES.add(edgeKey(2, 5, 2, 6))

/** 公路边集合（不含铁路边——铁路上走一步由铁路规则覆盖）：纵线全域（大本营
 *  排也向前连）、横线只在内排（y∈{2,3,4,7,8,9}，底线无横线）、行营斜线、
 *  大本营斜线。前线（y=5↔6）只有 x∈{0,2,4} 三处铁路过桥，无公路。 */
const ROAD_EDGES = new Set<string>()
function addRoad(ax: number, ay: number, bx: number, by: number): void {
  const key = edgeKey(ax, ay, bx, by)
  if (!RAIL_EDGES.has(key)) ROAD_EDGES.add(key)
}
for (const range of [[0, 4], [6, 10]] as const) {
  for (let y = range[0]; y <= range[1]; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) addRoad(x, y, x, y + 1)
  }
}
for (const y of [2, 3, 4, 7, 8, 9]) {
  for (let x = 0; x < WIDTH - 1; x += 1) addRoad(x, y, x + 1, y)
}
for (const camp of CAMP_KEYS) {
  const [cx, cy] = camp.split(',').map(Number) as [number, number]
  for (const [dx, dy] of DIAGONAL) {
    const tx = cx + dx!
    const ty = cy + dy!
    if (isOnBoard(tx, ty)) addRoad(cx, cy, tx, ty)
  }
}
// 大本营斜线（与前方两侧斜连——非行营，显式列出）。
for (const [hx, hy, fx, fy] of [
  [1, 0, 0, 1], [1, 0, 2, 1], [3, 0, 2, 1], [3, 0, 4, 1],
  [1, 11, 0, 10], [1, 11, 2, 10], [3, 11, 2, 10], [3, 11, 4, 10],
] as Array<[number, number, number, number]>) {
  addRoad(hx, hy, fx, fy)
}

function adjacencyOf(edges: Set<string>): Map<string, Point[]> {
  const map = new Map<string, Point[]>()
  const link = (key: string, point: Point): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [point])
    else list.push(point)
  }
  for (const edge of edges) {
    const [left, right] = edge.split('|') as [string, string]
    const [ax, ay] = left.split(',').map(Number) as [number, number]
    const [bx, by] = right.split(',').map(Number) as [number, number]
    link(left, { x: bx, y: by })
    link(right, { x: ax, y: ay })
  }
  return map
}

const ROAD_ADJ = adjacencyOf(ROAD_EDGES)
const RAIL_ADJ = adjacencyOf(RAIL_EDGES)

/* ------------------------- 固定布阵（经典） ------------------------- */

/** 红方 25 子（y=6..11）；蓝方为 y 镜像（11-y）同子小写。布阵约束：军旗在
 *  大本营 (1,11)、地雷只在后两排、炸弹不在前排、行营全空（测试逐条钉死）。 */
const RED_LAYOUT: Array<[number, number, string]> = [
  [0, 11, 'R'], [1, 11, 'F'], [2, 11, 'L'], [3, 11, 'B'], [4, 11, 'L'],
  [0, 10, 'P'], [1, 10, 'L'], [2, 10, 'M'], [3, 10, 'G'], [4, 10, 'D'],
  [0, 9, 'E'], [2, 9, 'Z'], [4, 9, 'E'],
  [0, 8, 'C'], [1, 8, 'D'], [3, 8, 'B'], [4, 8, 'Z'],
  [0, 7, 'P'], [2, 7, 'T'], [4, 7, 'P'],
  [0, 6, 'E'], [1, 6, 'C'], [2, 6, 'T'], [3, 6, 'R'], [4, 6, 'C'],
]

function initialState(): JunqiState {
  const board: (string | null)[][] = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null))
  for (const [x, y, piece] of RED_LAYOUT) {
    board[y]![x] = piece
    board[HEIGHT - 1 - y]![x] = piece.toLowerCase()
  }
  return {
    board,
    turn: 'red',
    ply: 0,
    lastMove: null,
    finished: false,
    winner: null,
    ending: null,
  }
}

type Board = (string | null)[][]

/* ------------------------- 走法生成与战斗裁决 ------------------------- */

/** 单子伪合法目标（全量几何规则；不含回合/终局——那些在 applyAction 层）。 */
function pseudoTargets(board: Board, x: number, y: number): Point[] {
  const piece = board[y]?.[x]
  if (piece === null || piece === undefined) return []
  const key = `${x},${y}`
  // 大本营冻结（初始就位或进驻一律不可再动）+ 地雷/军旗永不可动。
  if (HQ_KEYS.has(key)) return []
  const kind = piece.toUpperCase()
  if (kind === 'L' || kind === 'F') return []
  const side = sideOfPiece(piece)
  const targets: Point[] = []
  const taken = new Set<string>()
  /** 目点收编：空点可落可穿；敌子非行营可攻不可穿；己子与行营宿子一律不可。 */
  const consider = (tx: number, ty: number): boolean => {
    const target = board[ty]?.[tx] ?? null
    if (target === null || target === undefined) {
      const targetKey = `${tx},${ty}`
      if (!taken.has(targetKey)) {
        taken.add(targetKey)
        targets.push({ x: tx, y: ty })
      }
      return true
    }
    if (sideOfPiece(target) !== side && !CAMP_KEYS.has(`${tx},${ty}`)) {
      const targetKey = `${tx},${ty}`
      if (!taken.has(targetKey)) {
        taken.add(targetKey)
        targets.push({ x: tx, y: ty })
      }
    }
    return false
  }

  for (const neighbor of ROAD_ADJ.get(key) ?? []) consider(neighbor.x, neighbor.y)

  if (kind === 'E') {
    // 工兵：铁路图 BFS，可转弯，穿空点、止于占子。
    const visited = new Set([key])
    const queue: Array<[number, number]> = [[x, y]]
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!
      for (const neighbor of RAIL_ADJ.get(`${cx},${cy}`) ?? []) {
        const neighborKey = `${neighbor.x},${neighbor.y}`
        if (visited.has(neighborKey)) continue
        visited.add(neighborKey)
        if (consider(neighbor.x, neighbor.y)) queue.push([neighbor.x, neighbor.y])
      }
    }
  } else {
    // 非工兵：铁路直线滑行（固定方向不拐弯），逐边行走、遇子即止。
    for (const [dx, dy] of ORTHO) {
      let cx = x
      let cy = y
      for (;;) {
        const nx = cx + dx!
        const ny = cy + dy!
        if (!RAIL_EDGES.has(edgeKey(cx, cy, nx, ny))) break
        if (!consider(nx, ny)) break
        cx = nx
        cy = ny
      }
    }
  }
  return targets
}

/** 战斗裁决（攻击子 vs 守备子）：攻方大则占位、小则阵亡、同级同尽；炸弹对
 *  任何子（含地雷）同尽；地雷克一切非工兵、工兵挖雷；军旗被任何攻击子
 *  （含炸弹）扛走。 */
function resolveCombat(attacker: string, defender: string): CombatOutcome {
  const a = attacker.toUpperCase()
  const d = defender.toUpperCase()
  if (d === 'F') return 'flag'
  if (d === 'L') {
    if (a === 'E') return 'defused'
    return a === 'Z' ? 'both' : 'attacker-dies'
  }
  if (a === 'Z' || d === 'Z') return 'both'
  const attackerRank = RANK[a] ?? 0
  const defenderRank = RANK[d] ?? 0
  if (attackerRank > defenderRank) return 'capture'
  if (attackerRank < defenderRank) return 'attacker-dies'
  return 'both'
}

/** 指定方是否还有任何合法着法（困毙终局判定）。 */
function hasAnyMove(board: Board, side: Side): boolean {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const piece = board[y]![x]
      if (piece === null || piece === undefined || sideOfPiece(piece) !== side) continue
      if (pseudoTargets(board, x, y).length > 0) return true
    }
  }
  return false
}

interface LegalMove {
  from: Point
  to: Point
  capture: string | null
}

/** 指定方全部合法着法，确定性排序（吃子优先：被吃子威胁价值降序）后截断。 */
function allLegalMoves(board: Board, side: Side): LegalMove[] {
  const moves: LegalMove[] = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const piece = board[y]![x]
      if (piece === null || piece === undefined || sideOfPiece(piece) !== side) continue
      for (const to of pseudoTargets(board, x, y)) {
        moves.push({ from: { x, y }, to, capture: board[to.y]![to.x] ?? null })
      }
    }
  }
  moves.sort((a, b) => {
    const av = a.capture === null ? -1 : THREAT_ORDER[a.capture.toUpperCase()] ?? 0
    const bv = b.capture === null ? -1 : THREAT_ORDER[b.capture.toUpperCase()] ?? 0
    if (av !== bv) return bv - av
    return (a.from.y - b.from.y) || (a.from.x - b.from.x) || (a.to.y - b.to.y) || (a.to.x - b.to.x)
  })
  return moves.slice(0, MAX_SUGGESTIONS)
}

/* ------------------------- 叙述（describe/events 同源） ------------------------- */

/** 一手棋的基础叙述（基于走子前局面）：`红方 营长 (2,7)→(2,8)`，铁路机动加
 *  「沿铁路」（公路边集合不含的连接即铁路机动）。 */
function moveText(from: Point, to: Point, piece: string): string {
  const base = `${sideName(sideOfPiece(piece))} ${pieceName(piece)} ${coordText(from.x, from.y)}→${coordText(to.x, to.y)}`
  return ROAD_EDGES.has(edgeKey(from.x, from.y, to.x, to.y)) ? base : `${base}沿铁路`
}

/** 战斗结果叙述（与 resolveCombat 的 outcome 一一对应）。 */
function combatText(outcome: CombatOutcome, defender: string): string {
  const defenderSide = sideOfPiece(defender)
  const defenderText = `${ownerName(defenderSide)}方${pieceName(defender)}`
  switch (outcome) {
    case 'capture': return `吃掉${defenderText}`
    case 'both': return `与${defenderText}同归于尽`
    case 'attacker-dies': return defender.toUpperCase() === 'L' ? `触雷阵亡（地雷仍在）` : `进攻阵亡（${defenderText}仍在）`
    case 'defused': return `挖掉${defenderText}`
    case 'flag': return `扛走${defenderText}！`
  }
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

  /** 开局：经典固定布阵、红先。options（含 seed）接受但忽略——布阵固定，无随机性。 */
  createGame(_options?: unknown): { state: JunqiState } {
    return { state: initialState() }
  },

  /** 建议集 = 全部合法着法（完整性优先；>64 时吃子优先截断）；终局返回空数组。 */
  legalActions(state: JunqiState): Array<{ type: 'move'; from: Point; to: Point }> {
    if (state.finished) return []
    return allLegalMoves(state.board, state.turn).map((move) => ({
      type: 'move' as const,
      from: { ...move.from },
      to: { ...move.to },
    }))
  },

  /**
   * 走子并推进局面。校验顺序：动作形状 → type → 未终局 → 角色 → 坐标形状 →
   * 起终点各异 → 起点有子 → 子属本方 → 几何合法（公路/铁路/行营免攻/冻结）；
   * 任一不过抛 Error（中文报错）。绝不改入参 state。终局判定：扛旗即胜；
   * 否则对方无任何合法着法为困毙，同样本方胜（军棋无子和棋）。
   */
  applyAction(state: JunqiState, action: unknown, actor: string): {
    state: JunqiState
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
    if (actor !== 'red' && actor !== 'blue') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 red/blue`)
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
    if (!pseudoTargets(state.board, from.x, from.y).some((target) => target.x === to.x && target.y === to.y)) {
      const frozenReason = HQ_KEYS.has(`${from.x},${from.y}`)
        ? '（大本营中的棋子不能再移动）'
        : piece.toUpperCase() === 'L' || piece.toUpperCase() === 'F'
          ? '（地雷与军旗不能移动）'
          : ''
      throw new Error(`${pieceName(piece)}从 ${coordText(from.x, from.y)} 不能走到 ${coordText(to.x, to.y)}：不符合走子规则${frozenReason}——公路一步（行营斜线八达）、铁路直线任意距离（非工兵不可转弯、不可穿越棋子）、工兵铁路可转弯；行营中的棋子不可被攻击`)
    }

    const captured = state.board[to.y]?.[to.x] ?? null
    const outcome = captured === null ? 'move' as const : resolveCombat(piece, captured)
    const nextBoard = state.board.map((row) => row.slice())
    nextBoard[from.y]![from.x] = null
    if (captured === null || outcome === 'capture' || outcome === 'defused' || outcome === 'flag') {
      nextBoard[to.y]![to.x] = piece
    } else if (outcome === 'both') {
      nextBoard[to.y]![to.x] = null
    }
    // attacker-dies：攻击子阵亡，守备子留在原地。

    const nextTurn = other(actor)
    let finished = false
    let winner: Side | null = null
    let ending: JunqiState['ending'] = null
    if (outcome === 'flag') {
      finished = true
      winner = actor
      ending = 'flag'
    } else if (!hasAnyMove(nextBoard, nextTurn)) {
      finished = true
      winner = actor
      ending = 'immobilized'
    }

    const events = [moveText(from, to, piece)]
    const summaryParts = [moveText(from, to, piece)]
    if (captured !== null) {
      const text = combatText(outcome, captured)
      events.push(text)
      summaryParts.push(text)
    }
    if (finished) {
      const endingText = ending === 'flag' ? '夺旗获胜' : `${sideName(nextTurn)}无棋可走`
      events.push(endingText)
      events.push(`${sideName(actor)}胜`)
      summaryParts.push(endingText)
      summaryParts.push(`${sideName(actor)}胜`)
    }

    const next: JunqiState = {
      board: nextBoard,
      turn: nextTurn,
      ply: state.ply + 1,
      lastMove: { from: { ...from }, to: { ...to }, piece, captured, outcome },
      finished,
      winner,
      ending,
    }
    return { state: next, events, finished, winner: next.winner, summary: summaryParts.join('，') }
  },

  /** 人类可读的一手棋描述（与 events[0] 同一套叙述，基于走子前局面）。 */
  describe(state: JunqiState, actor: string, action: unknown): string {
    if (action !== null && typeof action === 'object' && !Array.isArray(action)
      && (action as { type?: unknown }).type === 'move') {
      try {
        const from = readPoint((action as { from?: unknown }).from, 'from')
        const to = readPoint((action as { to?: unknown }).to, 'to')
        const piece = state.board?.[from.y]?.[from.x] ?? null
        if (piece !== null) {
          const text = moveText(from, to, piece)
          const captured = state.board?.[to.y]?.[to.x] ?? null
          return captured === null ? text : `${text}，${combatText(resolveCombat(piece, captured), captured)}`
        }
      } catch {
        // 形状不完整交给运行时/applyAction 报错，describe 只负责可读文案。
      }
    }
    return `${sideName(actor === 'blue' ? 'blue' : 'red')}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as junqiEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置军棋随 bundle 分发）。
 * 注意：本字符串在 TS 模板字面量内——脚本内一律字符串拼接，禁止反引号与 ${。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>军棋 · dsh-soulmojito 游戏桥</title>
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
    width: 100%; max-width: 420px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    padding: 4px 2px 8px;
  }
  .game-name { font-size: 16px; font-weight: 600; letter-spacing: 1px; }
  .meta {
    font-size: 12px; color: #9a948a; font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #banner {
    width: 100%; max-width: 420px;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; text-align: center;
    margin-bottom: 10px; border: 1px solid #3a3f4a; background: #22262e;
    transition: background .2s;
  }
  #banner.turn-red  { background: #f2e2da; border-color: #d8b7a8; color: #6b1f14; }
  #banner.turn-blue { background: #dde8f4; border-color: #a8c0d8; color: #173a63; }
  #banner.finished  { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview   { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  .board-wrap { position: relative; width: 100%; max-width: 420px; }
  svg#board { display: block; width: 100%; height: auto; border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.45); }
  svg#board.interactive .hit { cursor: pointer; }
  .overlay {
    position: absolute; inset: 0; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    background: rgba(14, 15, 18, .72);
  }
  .overlay.hidden { display: none; }
  .overlay .result { font-size: 22px; font-weight: 700; color: #f0e6c8; letter-spacing: 2px; }
  .overlay .sub { font-size: 13px; color: #c9c0a8; padding: 0 14px; text-align: center; }
  footer {
    width: 100%; max-width: 420px; margin-top: 10px;
    font-size: 12px; color: #8d887e; text-align: center; line-height: 1.6;
  }
</style>
</head>
<body data-game="dsh-soulmojito.junqi">
<header>
  <span class="game-name">军棋</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="board-wrap">
  <svg id="board" viewBox="0 0 316 594" role="img" aria-label="军棋棋盘 5 列 12 行"></svg>
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
var NX = 5
var NY = 12
var PADX = 46
var PADY = 44
var CW = 56
var CH = 46
var LINE = '#6b4a26'
var RAIL = '#4a3418'
var RAIL_TIE = '#d9b98a'
var PIECE_FONT = '"KaiTi", "STKaiti", "BFangSong", "SimSun", serif'
var PIECE_CHAR = {
  M: '司令', G: '军长', D: '师长', B: '旅长', R: '团长', T: '营长',
  C: '连长', P: '排长', E: '工兵', Z: '炸弹', L: '地雷', F: '军旗',
  m: '司令', g: '军长', d: '师长', b: '旅长', r: '团长', t: '营长',
  c: '连长', p: '排长', e: '工兵', z: '炸弹', l: '地雷', f: '军旗',
}
var CAMPS = ['1,2', '3,2', '2,3', '1,4', '3,4', '1,7', '3,7', '2,8', '1,9', '3,9']
var HQS = ['1,0', '3,0', '1,11', '3,11']

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

function px(i) { return PADX + i * CW }
function py(j) { return PADY + j * CH }
function sideOf(piece) { return piece === piece.toUpperCase() ? 'red' : 'blue' }
function sideName(side) { return side === 'red' ? '红方' : '蓝方' }

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

/** 由 12 行 5 列字符画构造棋盘（'.' 为空）——仅预览局面使用。 */
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

/* 无 token 的静态演示局面：双方各三子进营的对称四手（红 营长(2,7)→(2,8)、
   蓝 营长(2,4)→(2,3)、红 团长(3,6)→(3,7)、蓝 团长(3,5)→(3,4)），轮红。 */
var PREVIEW_STATE = {
  board: boardFrom([
    'rflbl',
    'plmgd',
    'e.z.e',
    'cdtbz',
    'p..rp',
    'ect.c',
    'ECT.C',
    'P..RP',
    'CDTBZ',
    'E.Z.E',
    'PLMGD',
    'RFLBL',
  ]),
  turn: 'red',
  ply: 4,
  lastMove: { from: { x: 3, y: 5 }, to: { x: 3, y: 4 }, piece: 'r', captured: null, outcome: 'move' },
  finished: false,
  winner: null,
  ending: null,
}
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-soulmojito.junqi',
  players: [
    { role: 'red', owner: 'human' },
    { role: 'blue', owner: 'agent' },
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

function endText(state) {
  if (state.winner === 'red') return '红方获胜'
  if (state.winner === 'blue') return '蓝方获胜'
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
    } else {
      cls = state.turn === 'red' ? 'turn-red' : 'turn-blue'
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
      else if (sub.indexOf('blue') === 0) overlayResultEl.textContent = '蓝方认输'
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
    hintEl.textContent = '点击己方棋子选中，再点高亮目标走子；公路一步、铁路直线任意距离（工兵可转弯），行营中的棋子不可被攻击，扛走军旗即胜。'
  } else {
    hintEl.textContent = 'AI 思考中，走子将自动出现在棋盘上。'
  }
}

function drawRail(x1, y1, x2, y2) {
  /* 铁路双线渲染：深色粗轨 + 浅色枕木虚线。 */
  boardEl.appendChild(svgEl('line', {
    x1: x1, y1: y1, x2: x2, y2: y2, stroke: RAIL, 'stroke-width': 5, 'stroke-linecap': 'round',
  }))
  boardEl.appendChild(svgEl('line', {
    x1: x1, y1: y1, x2: x2, y2: y2, stroke: RAIL_TIE, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  }))
}

function drawRoad(x1, y1, x2, y2) {
  boardEl.appendChild(svgEl('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: LINE, 'stroke-width': 1.3 }))
}

function renderBoard(act) {
  var state = act.state
  while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild)

  boardEl.appendChild(svgEl('rect', { x: 0, y: 0, width: 316, height: 594, rx: 10, fill: '#e9d3a3' }))
  boardEl.appendChild(svgEl('rect', {
    x: px(0) - 32, y: py(0) - 32, width: px(4) - px(0) + 64, height: py(11) - py(0) + 64,
    fill: 'none', stroke: LINE, 'stroke-width': 2,
  }))

  /* 前线带（两方界线）：轻底色横带 + 两侧「前线」小字（中线铁路避开）。 */
  boardEl.appendChild(svgEl('rect', {
    x: px(0) - 26, y: py(5) + 14, width: px(4) - px(0) + 52, height: py(6) - py(5) - 28,
    fill: 'rgba(107, 74, 38, .12)',
  }))
  var fl1 = svgEl('text', {
    x: (px(1) + px(2)) / 2, y: (py(5) + py(6)) / 2 + 4, 'text-anchor': 'middle',
    'font-size': 12, 'font-family': PIECE_FONT, fill: '#8a6a3c', 'letter-spacing': 2,
  })
  fl1.textContent = '前线'
  boardEl.appendChild(fl1)
  var fl2 = svgEl('text', {
    x: (px(3) + px(4)) / 2, y: (py(5) + py(6)) / 2 + 4, 'text-anchor': 'middle',
    'font-size': 12, 'font-family': PIECE_FONT, fill: '#8a6a3c', 'letter-spacing': 2,
  })
  fl2.textContent = '前线'
  boardEl.appendChild(fl2)

  /* 公路纵线（全域；大本营排也有向前的连接）与横线（内排才有，底线无横线）。 */
  for (var rx = 0; rx < NX; rx++) {
    drawRoad(px(rx), py(0), px(rx), py(5))
    drawRoad(px(rx), py(6), px(rx), py(11))
  }
  for (var ry of [2, 3, 4, 7, 8, 9]) {
    drawRoad(px(0), py(ry), px(4), py(ry))
  }

  /* 行营斜线八达 + 大本营斜线（各与四/两邻点连）。 */
  for (var ci = 0; ci < CAMPS.length; ci++) {
    var parts = CAMPS[ci].split(',')
    var cx = Number(parts[0]), cy = Number(parts[1])
    var diags = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
    for (var di = 0; di < diags.length; di++) {
      var tx = cx + diags[di][0], ty = cy + diags[di][1]
      if (tx >= 0 && tx < NX && ty >= 0 && ty < NY) drawRoad(px(cx), py(cy), px(tx), py(ty))
    }
  }
  var hqDiags = [
    [1, 0, 0, 1], [1, 0, 2, 1], [3, 0, 2, 1], [3, 0, 4, 1],
    [1, 11, 0, 10], [1, 11, 2, 10], [3, 11, 2, 10], [3, 11, 4, 10],
  ]
  for (var hi = 0; hi < hqDiags.length; hi++) {
    drawRoad(px(hqDiags[hi][0]), py(hqDiags[hi][1]), px(hqDiags[hi][2]), py(hqDiags[hi][3]))
  }

  /* 铁路：横向四条全列 + 纵向两条（跨前线贯通）+ 中线过桥。 */
  for (var rry of [1, 5, 6, 10]) {
    drawRail(px(0), py(rry), px(4), py(rry))
  }
  drawRail(px(0), py(1), px(0), py(10))
  drawRail(px(4), py(1), px(4), py(10))
  drawRail(px(2), py(5), px(2), py(6))

  /* 行营：虚线圆 + 空营时「行营」小字。 */
  for (var cj = 0; cj < CAMPS.length; cj++) {
    var parts2 = CAMPS[cj].split(',')
    var jx = Number(parts2[0]), jy = Number(parts2[1])
    boardEl.appendChild(svgEl('circle', {
      cx: px(jx), cy: py(jy), r: 19, fill: 'rgba(107, 74, 38, .10)',
      stroke: LINE, 'stroke-width': 1.3, 'stroke-dasharray': '3 3',
    }))
    if (!state || !state.board || !state.board[jy][jx]) {
      /* 文字衬底：行营斜线与公路从格心穿过，无衬底时线条透字（真机验收
         2026-10-14 修）——衬底色取行营底色叠加后的实色（rgba(107,74,38,.10)
         over #e9d3a3 ≈ #dcc597），与格底无缝衔接。 */
      boardEl.appendChild(svgEl('circle', {
        cx: px(jx), cy: py(jy), r: 11.5, fill: '#dcc597',
      }))
      var campLabel = svgEl('text', {
        x: px(jx), y: py(jy), 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 9, fill: '#8a6a3c',
      })
      campLabel.textContent = '行营'
      boardEl.appendChild(campLabel)
    }
  }

  /* 大本营：着色圆角底 + 空营时「大本营」小字。 */
  for (var hj = 0; hj < HQS.length; hj++) {
    var parts3 = HQS[hj].split(',')
    var kx = Number(parts3[0]), ky = Number(parts3[1])
    boardEl.appendChild(svgEl('rect', {
      x: px(kx) - 26, y: py(ky) - 18, width: 52, height: 36, rx: 8,
      fill: 'rgba(74, 52, 24, .16)', stroke: LINE, 'stroke-width': 1.2, 'stroke-dasharray': '4 3',
    }))
    if (!state || !state.board || !state.board[ky][kx]) {
      /* 文字衬底同款（大本营斜线透字）：衬底色取大本营底色叠加后的实色
         （rgba(74,52,24,.16) over #e9d3a3 ≈ #d0ba8d）。 */
      boardEl.appendChild(svgEl('rect', {
        x: px(kx) - 22, y: py(ky) - 7, width: 44, height: 14, fill: '#d0ba8d',
      }))
      var hqLabel = svgEl('text', {
        x: px(kx), y: py(ky), 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 9, fill: '#6b4a26',
      })
      hqLabel.textContent = '大本营'
      boardEl.appendChild(hqLabel)
    }
  }

  /* 行列坐标：左侧行号 1-12（自上而下）、上下列号 1-5（自左而右）。 */
  for (var row = 0; row < NY; row++) {
    var rowLabel = svgEl('text', {
      x: px(0) - 36, y: py(row) + 4, 'text-anchor': 'middle', 'font-size': 11, fill: LINE,
    })
    rowLabel.textContent = String(row + 1)
    boardEl.appendChild(rowLabel)
  }
  for (var col = 0; col < NX; col++) {
    var bottom = svgEl('text', {
      x: px(col), y: py(11) + 32, 'text-anchor': 'middle', 'font-size': 11, fill: LINE,
    })
    bottom.textContent = String(col + 1)
    boardEl.appendChild(bottom)
    var top = svgEl('text', {
      x: px(col), y: py(0) - 22, 'text-anchor': 'middle', 'font-size': 11, fill: LINE,
    })
    top.textContent = String(col + 1)
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
    boardEl.appendChild(svgEl('ellipse', {
      cx: px(state.lastMove.from.x), cy: py(state.lastMove.from.y), rx: 26, ry: 16.5,
      fill: 'none', stroke: 'rgba(43,58,90,.55)', 'stroke-width': 2, 'stroke-dasharray': '4 3',
    }))
    boardEl.appendChild(svgEl('ellipse', {
      cx: px(state.lastMove.to.x), cy: py(state.lastMove.to.y), rx: 26, ry: 16.5,
      fill: 'none', stroke: '#c0392b', 'stroke-width': 2.4,
    }))
  }

  var ownTurn = humanTurn(act)

  /* 选中与目标高亮（仅人类回合） */
  if (selected && ownTurn && !act.finished) {
    boardEl.appendChild(svgEl('ellipse', {
      cx: px(selected.x), cy: py(selected.y), rx: 27, ry: 17.5, fill: 'none', stroke: '#d99a1e', 'stroke-width': 3.5,
    }))
    var targets = legalFrom(act, selected)
    for (var t = 0; t < targets.length; t++) {
      var to = targets[t].to
      if (state.board[to.y][to.x] === null) {
        boardEl.appendChild(svgEl('circle', { cx: px(to.x), cy: py(to.y), r: 5, fill: 'rgba(154,110,20,.85)' }))
      } else {
        boardEl.appendChild(svgEl('ellipse', {
          cx: px(to.x), cy: py(to.y), rx: 26, ry: 16.5, fill: 'none', stroke: '#d9791e', 'stroke-width': 3,
        }))
      }
    }
  }

  boardEl.setAttribute('class', ownTurn ? 'interactive' : '')
  for (var hy = 0; hy < NY; hy++) {
    for (var hx = 0; hx < NX; hx++) {
      boardEl.appendChild(svgEl('ellipse', {
        cx: px(hx), cy: py(hy), rx: 28, ry: 19, fill: 'transparent', 'data-x': hx, 'data-y': hy, 'class': 'hit',
      }))
    }
  }
}

function drawPiece(x, y, piece) {
  var red = sideOf(piece) === 'red'
  var color = red ? '#b02a1e' : '#1e4f8f'
  boardEl.appendChild(svgEl('rect', {
    x: px(x) - 23, y: py(y) - 15, width: 46, height: 30, rx: 5,
    fill: '#f9f1de', stroke: color, 'stroke-width': 1.8,
  }))
  boardEl.appendChild(svgEl('rect', {
    x: px(x) - 19.5, y: py(y) - 11.5, width: 39, height: 23, rx: 3,
    fill: 'none', stroke: color, 'stroke-width': 0.8, opacity: 0.45,
  }))
  var label = svgEl('text', {
    x: px(x), y: py(y), 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-size': 16, 'font-family': PIECE_FONT, 'font-weight': 600, fill: color,
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
export const junqi = { manifest, engine, viewHtml } as const
