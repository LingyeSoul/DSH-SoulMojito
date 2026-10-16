/**
 * dsh-soulmojito.gomoku —— 五子棋引擎（dsh-soulmojito 游戏桥标准 v1 的第一个参照实现）。
 *
 * 契约来源：docs/proposals/0018-agent-game-bridge.md §3.2「引擎契约」——Node 侧权威的
 * 无状态纯函数对象：createGame / legalActions / applyAction / describe。零依赖纯 ESM；
 * state 任意时刻 deep-JSON-safe；applyAction 同输入两次调用结果 deep-equal（全文不
 * 引入任何随机源或时间源——确定性是导入期烟测的硬约束，见提案 §4.6）。
 *
 * 规则裁剪（如实声明，与根 README 标注一致）：
 * - 15×15 棋盘，黑先；自由五子棋（free-style）规则：任意方向 ≥5 连即胜（长连也算胜），
 *   连珠禁手（三三/四四/长连禁）不实现。
 * - 保留动作 resign（认输）按提案 §3.2 由未来运行时统一处理：本引擎不实现，
 *   收到 type 不是 'place' 的动作一律抛错（中文报错，绝不静默）。
 * - legalActions 返回有界建议集（提案 §3.2：≤64）：空盘只有天元一点；此后取与既有
 *   棋子切比雪夫距离 ≤2 的空点，按确定性邻居加权打分排序（(y, x) 字典序 tiebreak）
 *   截断至 64。applyAction 按全量规则校验任意空点——建议集之外的空点同样合法，
 *   合法性终审永远在 applyAction（Node 权威，视图/Agent 不可作弊）。
 * - 五子棋是确定性游戏：createGame(options) 的 options/seed 接受但忽略。
 *
 * 坐标约定：x 为列 0-14（棋谱记法 A-O），y 为行 0-14（棋谱记法 1-15），天元 = (7,7) = H8。
 */

const SIZE = 15
const EMPTY = 0
const BLACK = 1
const WHITE = 2
const MAX_CANDIDATES = 64

/** 棋谱列名（A-O），同时用于 describe 的坐标文本。 */
const COLUMNS = 'ABCDEFGHIJKLMNO'
/** 胜利连珠长度的中文数字（自由规则下长连 6-15 都可能出现）。 */
const CN_NUMERALS = {
  5: '五', 6: '六', 7: '七', 8: '八', 9: '九',
  10: '十', 11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五',
}
/** 胜负判定的四个方向：横、竖、主对角（↘）、副对角（↗）。 */
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]

/** 与 game.json 完全一致的冗余字段（提案 §6：运行时以 engine.meta 为准，清单不符时安装期警告）。 */
const META = {
  id: 'dsh-soulmojito.gomoku',
  name: '五子棋',
  version: '1.0.0',
  engines: { 'dsh-soulmojito': '^0.6.0' },
  players: { min: 2, max: 2, roles: ['black', 'white'] },
  turnBased: true,
  actionVocabulary:
    "落子 {type:'place', x, y}，x/y 为 0-14 整数坐标（列 A-O、行 1-15）；认输 {type:'resign'} 由运行时统一处理",
}

/** 坐标 → 棋谱记法，如 (7,7) → 'H8'。 */
function coordName(x, y) {
  return COLUMNS[x] + String(y + 1)
}

function stoneName(role) {
  return role === 'black' ? '黑棋' : '白棋'
}

function sideName(role) {
  return role === 'black' ? '黑方' : '白方'
}

function other(role) {
  return role === 'black' ? 'white' : 'black'
}

/** 棋盘内且为整数坐标。 */
function isOnBoard(x, y) {
  return (
    Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < SIZE && y >= 0 && y < SIZE
  )
}

/**
 * 整数坐标解析（决策 2026-10-14-quoted-coordinate-tolerance）：数字原样；
 * 整数的字符串形态（"1"、"1.0"——模型桥把工具参数数字写成引号串的实弹习惯）
 * 归一为数字；其余（小数、空串、非数文本）返回 null。界内/规则合法性仍由
 * applyAction 终审（本函数只管「是不是一个整数」）。
 */
function parseCoord(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return null
  const parsed = Number(text)
  return Number.isInteger(parsed) ? parsed : null
}

/** 深拷贝 state（board 逐行、lastMove/winLine 逐点），绝不共享可变结构。 */
function cloneState(state) {
  return {
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    ply: state.ply,
    lastMove: state.lastMove ? { x: state.lastMove.x, y: state.lastMove.y } : null,
    finished: state.finished,
    winner: state.winner,
    winLine: state.winLine ? state.winLine.map((p) => ({ x: p.x, y: p.y })) : null,
  }
}

/**
 * 以 (x, y) 刚落的子为锚，找出过该点的 ≥5 连（自由规则：长连也算）。
 * 返回连珠坐标数组（按 x 升序、竖线按 y 升序——确定性输出），无五连返回 null。
 */
function findWinLine(board, x, y) {
  const stone = board[y][x]
  if (stone === EMPTY) return null
  for (const [dx, dy] of DIRECTIONS) {
    const cells = [{ x, y }]
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (isOnBoard(cx, cy) && board[cy][cx] === stone) {
        cells.push({ x: cx, y: cy })
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (cells.length >= 5) {
      cells.sort((a, b) => (a.x - b.x) || (a.y - b.y))
      return cells
    }
  }
  return null
}

export default {
  meta: META,

  /** 开局：空盘黑先。options（含 seed）接受但忽略——五子棋无随机性。 */
  createGame(_options) {
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
   * 当前行棋方的建议落点（有界建议集，非全量合法点）：
   * - 已终局 → []；
   * - 空盘 → 只有天元 (7,7)；
   * - 否则 → 与既有棋子切比雪夫距离 ≤2 的空点，按邻居加权计数打分
   *   （距离 1 记 2 分、距离 2 记 1 分）降序、(y, x) 字典序 tiebreak，截断至 64。
   * 全部确定性：无随机、无时间依赖。
   */
  legalActions(state) {
    if (state.finished) return []
    if (state.ply === 0) return [{ type: 'place', x: 7, y: 7 }]

    const candidates = []
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (state.board[y][x] !== EMPTY) continue
        let score = 0
        let nearStone = false
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue
            if (state.board[ny][nx] === EMPTY) continue
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
   * 落子并推进局面。校验顺序：动作形状 → type → 未终局 → 行棋方 → 坐标 → 空点；
   * 任一不过抛 Error（中文报错）。绝不改入参 state——深拷贝出新态。
   * 返回 { state, events, finished, winner, summary }；胜时新态附 winLine（连珠坐标数组）。
   */
  applyAction(state, action, actor) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    if (typeof action.type !== 'string' || action.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (action.type !== 'place') {
      throw new Error(`不支持的动作类型「${action.type}」：本引擎只实现 place（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再落子')
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能落子`)
    }
    const x = parseCoord(action.x)
    const y = parseCoord(action.y)
    if (x === null || y === null || !isOnBoard(x, y)) {
      throw new Error(`落子坐标必须是 0-${SIZE - 1} 的整数，收到 x=${String(action.x)}、y=${String(action.y)}`)
    }
    if (state.board[y][x] !== EMPTY) {
      throw new Error(`${coordName(x, y)} 已有棋子，不能落在已占点上`)
    }

    const next = cloneState(state)
    next.board[y][x] = actor === 'black' ? BLACK : WHITE
    next.ply = state.ply + 1
    next.lastMove = { x, y }
    next.turn = other(actor)

    const move = `${stoneName(actor)}落于 ${coordName(x, y)}`
    const events = [move]
    let summary = move
    const winLine = findWinLine(next.board, x, y)
    if (winLine) {
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
  describe(_state, actor, action) {
    if (action !== null && typeof action === 'object' && !Array.isArray(action) && action.type === 'place') {
      const x = parseCoord(action.x)
      const y = parseCoord(action.y)
      if (x !== null && y !== null && isOnBoard(x, y)) {
        return `${stoneName(actor)}落于 ${coordName(x, y)}`
      }
    }
    return `${stoneName(actor)}的动作未被本引擎识别`
  },
}
