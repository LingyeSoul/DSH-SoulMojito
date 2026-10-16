/**
 * 内置游戏：记忆翻牌对战（Concentration / 记忆配对，提案 0018 §4.1 内置序列
 * 第六款，2026-10-15）。
 *
 * 需求源：用户「新建内置游戏 记忆翻牌对战 轮流翻牌，配对成功得分」。装载形态
 * 与 builtin/tic-tac-toe.ts、gomoku.ts、xiangqi.ts、junqi.ts、blackjack.ts 同款
 * ——静态 import 的 TS 引擎 + viewHtml 字符串常量内联，零文件依赖、随插件分发；
 * 决策与边界见 decisions/2026-10-15-memory-match-builtin.md。
 *
 * 规则面（v1 明示裁剪，决策文档同款）：
 * - 盘面 4×4 = 16 张牌、8 种图案各两张；牌位下标行主序 0-15（列 A-D、行 1-4，
 *   0=A1、3=D1、4=A2、15=D4）。
 * - 一手 = 翻开两张未翻开的牌（动作 {type:'flip', a, b}）——**一次动作结算完整
 *   一手**（原子性：无「翻开第一张等第二张」的中间态），与 token 经济裁定
 *   （§14 每手一次工具调用、行动载荷不随对局膨胀）一致。
 * - 配对成功：两张图案相同 → 得 1 分、两张保持翻开（定格）、**同一方继续翻**
 *   （经典 Concentration 规则：配对 = 得分 + 保留回合；「轮流」体现在失配换手）。
 *   若未来要「严格轮流、配对不保留回合」变体，应另立游戏 id 或单点修改本引擎。
 * - 失配：两张翻回背面、换对方翻牌。
 * - 终局：8 对全部配完 —— 比总分，高者胜、同分平局（winner null）。16 张全
 *   翻开本身就是终局 payoff（视图终局保留完整盘面，同 0.6.3 既有语义）。
 * - 不实现：计时/步数限制、先手让子、多副牌加大盘面、悔棋（重放日志支撑但 v1
 *   不做）；保留动作 resign 由运行时统一处理（引擎收到一律抛错）。
 *
 * **隐藏信息设计（本款最关键一条，如实标注）**：桥契约里 state 对视图
 * （game-state 下行）与 Agent（game_state 工具）全明，无按角色投影的通道——
 * 未翻开的牌面**不进 state**：state 只携带已被双方看见的事实（已配对的定格面、
 * lastFlip 的最近一手）；任意牌位的图案由 seed 确定性派生（layoutOf），翻牌
 * 那一刻才物化。与 21 点牌靴同款信任模型（state 带 seed 与派生纪律，不是答案
 * 本身）——程序化重建 RNG 可推演全盘，但「读取 state 直接得到答案」不存在，
 * 这是全明 state 下能做到的防偷看上限，如实标注。
 * 记忆面公平性（如实）：Agent 可用 game_history 复读往手 describe（含牌面），
 * 人类只能靠记忆 + 「上一手」横幅与翻回预览——工具面的审计日志是桥的既定
 * 设计（不可裁剪），视图侧以横幅/预览辅助，不提供持久历史面。
 *
 * 确定性纪律：全文除 createGame 缺省 seed（node:crypto randomInt 的唯一随机点）
 * 外无任何随机/时间源。同 state + 同 action 两次 applyAction deep-equal；深拷贝
 * 出态、绝不改入参。
 *
 * state 形状（运行时补充契约：顶层 `turn` 为当前行动方角色名；终局后留在最后
 * 行动方、保持合法角色值）：
 * { turn: 'red' | 'blue', seed, board: (null | 图案字符串)[16]（null = 背面，
 *   字符串 = 已配对定格）、scores: { red, blue }（已配对数）、ply（已翻手数）、
 *   lastFlip: { cards: [a, b], faces: [fa, fb], match } | null（最近一手——供
 *   视图翻回预览与叙述，两张面双方都已看见、零泄漏）、finished, winner }
 *
 * 叙述（events/summary/describe 统一；牌位 = 列 A-D + 行 1-4，图案用单字汉字）：
 * `红方翻开 A1（月）与 C3（月）：配对成功，得 1 分（比分 红方 2–蓝方 1）`、
 * `红方翻开 A1（月）与 C3（星）：不是一对，翻回，轮到蓝方`；终局收尾
 * `对局结束：红方 5–蓝方 3，红方胜`（`……平局`）；summary 以「，」串联。
 * 牌面用汉字而非表情符号（2026-10-15 截图驱动修订，如实留档）：真机验收环境
 * （极简 Linux，仅 CJK 字体）里 emoji 全部渲染成豆腐块，单字汉字与 UI 同一
 * 字体上下文、渲染有保证，且象棋/军棋已有汉字棋子的先例。
 * describe 在落子前 state 上取（牌面由 seed 派生，配对结果与比分同手可算）——
 * game_move 只回 describe，配对与否/续手与否必须写进这条叙述里。
 *
 * legalActions 是**建议集**（§3.2 ≤64）而非合法性依据：语义 = 「任意两张未
 * 翻开的牌」（图案未知时任意对等价）；开局 C(16,2)=120 超界，按行主序截断至
 * 64（前 15 对为 (0,j)，任意截断下每个未翻开牌位都被覆盖）。applyAction 按
 * 全量规则终审任意动作。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面（对局中期 + 翻回
 * 预览形态）。人类回合才启用选牌：点一张（高亮待选）再点第二张提交 {a,b}；
 * 失配时视图做 ~1.4s「翻回预览」（两张短暂亮面后翻回，动画期间不写任何状态）；
 * 配对定格金框、终局盘面完整保留 + 结果条（盘面之下 in-flow，同 21 点纪律）。
 * 一切「谁是谁」的表述按 session.players 的 owner 反查落笔（人类未必执红——
 * 坐席归属纪律同 21 点：绝不把默认坐席写死）。
 */

import { randomInt } from 'node:crypto'
import { parseBoardCoord, type GameEngine, type GameManifest } from '../standard.js'

const COLS = 4
const ROWS = 4
/** 牌位总数（牌面下标 0-15，行主序）。 */
const CARDS = COLS * ROWS
/** 8 种图案各两张——单字汉字：与 UI 同一 CJK 字体上下文（emoji 在极简 Linux
 *  真机环境渲染成豆腐块，2026-10-15 截图驱动修订）；叙述里的角色（「翻开的
 *  是月」「不是一对——月与星」）。 */
const FACES = ['月', '星', '花', '雷', '鱼', '蝶', '山', '水'] as const
/** 对数 = 图案数（终局分数上限）。 */
const PAIRS = FACES.length
/** 建议集上限（§3.2：≤64）。开局 C(16,2)=120 超界，行主序截断。 */
const MAX_SUGGESTIONS = 64
const COLUMN_LETTERS = 'ABCD'

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.memory-match',
  name: '记忆翻牌对战',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['red', 'blue'] },
  turnBased: true,
  actionVocabulary: "翻牌 {type:'flip', a, b}：a/b 为 0-15 的牌位下标（行主序——0-3 第一行、4-7 第二行……列 A-D、行 1-4，如 0=A1、5=B2、15=D4）。每手翻开两张未翻开的牌：图案相同即配对成功（得 1 分、两张保持翻开、同一方继续翻）；不同则两张翻回、换对方。8 对全部配完后比较得分定胜负；认输 {type:'resign'} 由运行时统一处理",
}

type Side = 'red' | 'blue'

interface MemoryState {
  turn: Side
  /** 布局种子（未翻开的牌面由此确定性派生，不物化进 state——见文件头）。 */
  seed: number
  board: (string | null)[]
  scores: { red: number; blue: number }
  /** 已翻手数（每手 = 一次翻两张尝试）。 */
  ply: number
  lastFlip: { cards: [number, number]; faces: [string, string]; match: boolean } | null
  finished: boolean
  winner: Side | null
}

function sideName(side: Side): string {
  return side === 'red' ? '红方' : '蓝方'
}

function other(side: Side): Side {
  return side === 'red' ? 'blue' : 'red'
}

/** 牌位名：下标 → 列 A-D + 行 1-4（0=A1、3=D1、4=A2……15=D4）。 */
function cardName(index: number): string {
  return COLUMN_LETTERS[index % COLS]! + String(Math.floor(index / COLS) + 1)
}

/** 牌位下标合法判定（0-15 整数）。 */
function isCardIndex(value: number): boolean {
  return value >= 0 && value < CARDS
}

/** 深拷贝 state（board/scores/lastFlip 逐字段），绝不共享可变结构。 */
function cloneState(state: MemoryState): MemoryState {
  return {
    turn: state.turn,
    seed: state.seed,
    board: state.board.slice(),
    scores: { ...state.scores },
    ply: state.ply,
    lastFlip: state.lastFlip === null ? null : {
      cards: [state.lastFlip.cards[0], state.lastFlip.cards[1]],
      faces: [state.lastFlip.faces[0], state.lastFlip.faces[1]],
      match: state.lastFlip.match,
    },
    finished: state.finished,
    winner: state.winner,
  }
}

/** mulberry32：32 位种子 PRNG（实现短小、可复现；与 21 点同款，混淆常量不同）。 */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 牌面布局：8 图案各两张（16 张）用 mulberry32(seed 混淆) 做 Fisher-Yates，
 * 返回 16 长度数组（下标 → 图案）。纯函数、无副作用；state 只存 seed，任一
 * 时刻凭 {seed, 下标} 即可重放该牌位的图案（文件头「隐藏信息设计」）。
 */
function layoutOf(seed: number): string[] {
  const deck: string[] = []
  for (const face of FACES) deck.push(face, face)
  const rand = mulberry32((Math.imul(seed | 0, 0x9E3779B1) ^ 0x2545F491) | 0)
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const swap = deck[i]!
    deck[i] = deck[j]!
    deck[j] = swap
  }
  return deck
}

/** 裁决：高者胜、同分平局（winner null）。 */
function winnerOf(scores: { red: number; blue: number }): Side | null {
  if (scores.red > scores.blue) return 'red'
  if (scores.blue > scores.red) return 'blue'
  return null
}

/** 已配对张数（视图 meta 与终局判定共用）。 */
function matchedCountOf(board: (string | null)[]): number {
  return board.filter((cell) => cell !== null).length
}

/** 配对句（describe 与 events/summary 同一模板——单一措辞来源）。 */
function matchSentence(side: Side, a: number, b: number, faceA: string, faceB: string, scores: { red: number; blue: number }): string {
  return `${sideName(side)}翻开 ${cardName(a)}（${faceA}）与 ${cardName(b)}（${faceB}）：配对成功，得 1 分（比分 红方 ${scores.red}–蓝方 ${scores.blue}）`
}

/** 失配句（同款单一措辞来源）。 */
function mismatchSentence(side: Side, a: number, b: number, faceA: string, faceB: string, next: Side): string {
  return `${sideName(side)}翻开 ${cardName(a)}（${faceA}）与 ${cardName(b)}（${faceB}）：不是一对，翻回，轮到${sideName(next)}`
}

const engine: GameEngine = {
  meta: MANIFEST,

  /**
   * 开局：读 options.seed（number 则用之；缺省用 node:crypto 随机整数——全文
   * 唯一的随机点）。16 张全背面、比分 0–0、红方先手（roles[0]）。
   */
  createGame(options?: unknown): { state: MemoryState } {
    const record = options !== null && typeof options === 'object' && !Array.isArray(options)
      ? options as { seed?: unknown }
      : {}
    const seed = typeof record.seed === 'number' && Number.isFinite(record.seed)
      ? record.seed
      : randomInt(0, 0x8000_0000)
    return {
      state: {
        turn: 'red',
        seed,
        board: Array.from({ length: CARDS }, () => null),
        scores: { red: 0, blue: 0 },
        ply: 0,
        lastFlip: null,
        finished: false,
        winner: null,
      },
    }
  },

  /**
   * 建议集 = 全部（i<j）未翻开牌位对，行主序排序，截断至 64。开局 120 对 →
   * 64（前 15 对即 (0,j) 全跨度，任意截断下每个未翻开牌位都被覆盖）；中局
   * C(n,2) ≤ 64 时即全集。终局空数组。
   */
  legalActions(state: MemoryState): Array<{ type: 'flip'; a: number; b: number }> {
    if (state.finished) return []
    const covered: number[] = []
    for (let index = 0; index < state.board.length; index += 1) {
      if (state.board[index] === null) covered.push(index)
    }
    const actions: Array<{ type: 'flip'; a: number; b: number }> = []
    for (let x = 0; x < covered.length; x += 1) {
      for (let y = x + 1; y < covered.length; y += 1) {
        actions.push({ type: 'flip', a: covered[x]!, b: covered[y]! })
      }
    }
    return actions.slice(0, MAX_SUGGESTIONS)
  },

  /**
   * 行动并推进局面。校验顺序（镜像 gomoku/blackjack）：动作形状 → type 已知
   * → 未终局 → 角色合法 → actor===turn → 坐标（整数字符串归一，parseBoardCoord）
   * → 两张不同 → 两张都还在背面；任一不过抛 Error（中文报错）。绝不改入参
   * state——深拷贝出新态。
   *
   * 配对：+1 分、两张定格、turn 不变（同一方继续）；配完最后一对即终局
   * （winner 按总分，同分平局）。失配：turn 换对方。lastFlip 记录本手两张的
   * 下标/面/结果（视图翻回预览与「上一手」叙述用）。
   */
  applyAction(state: MemoryState, action: unknown, actor: string): {
    state: MemoryState
    events: string[]
    finished: boolean
    winner: Side | null
    summary: string
  } {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    const typed = action as { type?: unknown; a?: unknown; b?: unknown }
    if (typeof typed.type !== 'string' || typed.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (typed.type !== 'flip') {
      throw new Error(`不支持的动作类型「${typed.type}」：本引擎只实现 flip（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再翻牌')
    }
    if (actor !== 'red' && actor !== 'blue') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 red/blue`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能翻牌`)
    }
    const side: Side = actor
    const a = parseBoardCoord(typed.a)
    const b = parseBoardCoord(typed.b)
    if (a === null || b === null || !isCardIndex(a) || !isCardIndex(b)) {
      throw new Error(`翻牌坐标必须是 0-${CARDS - 1} 的整数牌位下标（列 A-D、行 1-4），收到 a=${String(typed.a)}、b=${String(typed.b)}`)
    }
    if (a === b) {
      throw new Error('不能在同一手翻开同一张牌')
    }
    if (state.board[a] !== null) {
      throw new Error(`牌位 ${cardName(a)} 已配对翻开，不能重复翻开`)
    }
    if (state.board[b] !== null) {
      throw new Error(`牌位 ${cardName(b)} 已配对翻开，不能重复翻开`)
    }

    const next = cloneState(state)
    const faces = layoutOf(next.seed)
    const faceA = faces[a]!
    const faceB = faces[b]!
    const match = faceA === faceB
    next.ply = state.ply + 1
    next.lastFlip = { cards: [a, b], faces: [faceA, faceB], match }

    const events: string[] = []
    if (match) {
      next.board[a] = faceA
      next.board[b] = faceB
      next.scores[side] += 1
      events.push(matchSentence(side, a, b, faceA, faceB, next.scores))
      if (matchedCountOf(next.board) === CARDS) {
        next.finished = true
        next.winner = winnerOf(next.scores)
        const verdict = next.winner === null ? '平局' : `${sideName(next.winner)}胜`
        events.push(`对局结束：红方 ${next.scores.red}–蓝方 ${next.scores.blue}，${verdict}`)
      }
    } else {
      next.turn = other(side)
      events.push(mismatchSentence(side, a, b, faceA, faceB, next.turn))
    }
    return { state: next, events, finished: next.finished, winner: next.winner, summary: events.join('，') }
  },

  /**
   * 人类可读的一手描述（Agent 在对话里角色化叙述用；落子前 state、牌面由
   * seed 派生——配对结果与续手/换手同手可算，写进叙述）。校验与 applyAction
   * 同序的宽松版：任一不过回落到「未被本引擎识别」，绝不抛错。
   */
  describe(state: MemoryState, actor: string, action: unknown): string {
    const side: Side = actor === 'blue' ? 'blue' : 'red'
    if (
      action !== null && typeof action === 'object' && !Array.isArray(action)
      && (action as { type?: unknown }).type === 'flip'
    ) {
      const typed = action as { a?: unknown; b?: unknown }
      const a = parseBoardCoord(typed.a)
      const b = parseBoardCoord(typed.b)
      if (a !== null && b !== null && isCardIndex(a) && isCardIndex(b) && a !== b
        && state.board[a] === null && state.board[b] === null) {
        const faces = layoutOf(state.seed)
        const faceA = faces[a]!
        const faceB = faces[b]!
        if (faceA === faceB) {
          const scores = {
            red: state.scores.red + (side === 'red' ? 1 : 0),
            blue: state.scores.blue + (side === 'blue' ? 1 : 0),
          }
          const cleared = matchedCountOf(state.board) === CARDS - 2
          return `${matchSentence(side, a, b, faceA, faceB, scores)}${cleared ? '，全部配对完毕' : '，继续翻牌'}`
        }
        return mismatchSentence(side, a, b, faceA, faceB, other(side))
      }
    }
    return `${sideName(side)}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as memoryMatchEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置记忆翻牌随 bundle
 * 分发）。绿绒牌桌 4×4：人类回合点两张未翻开的牌（第一张高亮待选、点同张
 * 取消、第二张提交 {type:'flip',a,b}）；失配时 ~1.4s 翻回预览（两张短暂亮面，
 * 纯视图动画、不写状态）；配对定格金框；比分板按 owner 标注 你/AI 与当前行动
 * 方；终局盘面完整保留 + 盘面之下 in-flow 结果条（同 21 点截图驱动纪律）。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆翻牌对战 · dsh-soulmojito 游戏桥</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #12161d; color: #ece7db;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 10px 10px 14px;
  }
  header {
    width: 100%; max-width: 400px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    padding: 4px 2px 8px;
  }
  .game-name { font-size: 16px; font-weight: 600; letter-spacing: 1px; }
  .meta {
    font-size: 12px; color: #9a948a; font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #banner {
    width: 100%; max-width: 400px;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; text-align: center;
    margin-bottom: 10px; border: 1px solid #3a3f4a; background: #22262e;
    transition: background .2s;
  }
  #banner.turn-red  { background: #2a1c19; border-color: #7a4a3a; }
  #banner.turn-blue { background: #182130; border-color: #3f5b7a; }
  #banner.finished  { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview   { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  .scoreboard { width: 100%; max-width: 400px; display: flex; gap: 8px; margin-bottom: 10px; }
  .side {
    flex: 1; border-radius: 9px; border: 1px solid #333945; background: #20242c;
    padding: 7px 10px; display: flex; justify-content: space-between; align-items: baseline;
    font-size: 13px; transition: border-color .2s, background .2s;
  }
  .side.active { border-color: rgba(255, 215, 106, .6); background: #262b35; }
  .owner-tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; margin-left: 6px; font-weight: 400; }
  .owner-tag.human { background: #1d4d33; color: #b8ecc9; }
  .owner-tag.agent { background: #27364e; color: #b9c8e6; }
  .side .score { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; color: #eef4e9; }
  .board {
    position: relative; width: 100%; max-width: 400px;
    border-radius: 14px; padding: 14px;
    background: radial-gradient(ellipse at 50% 0%, #1f7a52 0%, #17593d 55%, #103f2c 100%);
    border: 6px solid #5b3a20;
    box-shadow: 0 6px 24px rgba(0,0,0,.5), inset 0 0 80px rgba(0,0,0,.28);
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
  }
  .card {
    position: relative; aspect-ratio: 1; border-radius: 9px;
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; user-select: none;
    transition: box-shadow .15s, transform .15s;
  }
  .card .pos {
    position: absolute; top: 4px; left: 6px; font-size: 9px; letter-spacing: .5px;
    color: #cfc9bd; opacity: .55; font-variant-numeric: tabular-nums;
  }
  .card.back {
    background: repeating-linear-gradient(45deg, #2c3e63 0, #2c3e63 6px, #243352 6px, #243352 12px);
    border: 1px solid #3c4f78;
    box-shadow: 0 2px 7px rgba(0,0,0,.38), inset 0 0 0 1px rgba(255,255,255,.10);
  }
  .card.back::after {
    content: '?'; font-size: 20px; font-weight: 700; color: rgba(236, 231, 219, .30);
  }
  .card.back.clickable { cursor: pointer; }
  .card.back.clickable:hover { border-color: #8fb4ff; box-shadow: 0 0 0 1px rgba(143,180,255,.55); }
  .card.selected { outline: 3px solid #7fb2ff; outline-offset: 1px; transform: translateY(-1px); }
  .card.peek {
    background: linear-gradient(160deg, #fdfbf4, #ece6d6); color: #1d2430;
    box-shadow: 0 0 0 2px rgba(127, 178, 255, .80), 0 2px 10px rgba(0,0,0,.4);
  }
  .card.peek .pos { color: #6b6f7d; opacity: .8; }
  .card.matched {
    background: linear-gradient(160deg, #f6efdd, #e7ddc4); color: #2a2f3a;
    box-shadow: 0 0 0 2px rgba(202, 168, 79, .55), 0 2px 7px rgba(0,0,0,.38);
  }
  .card.matched .pos { color: #6b5f45; opacity: .8; }
  .result-strip {
    width: 100%; max-width: 400px; margin-top: 12px;
    border-radius: 10px; padding: 12px 16px;
    background: #101812; border: 1px solid rgba(202, 168, 79, .5);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    /* 终局结果条：盘面之下 in-flow（21 点截图驱动纪律——覆盖层压暗与「终局
       保留盘面」语义冲突；16 张全翻开正是本游戏的终局 payoff）。 */
  }
  .result-strip.hidden { display: none; }
  .result-strip .result { font-size: 24px; font-weight: 700; color: #f5e7bd; letter-spacing: 3px; }
  .result-strip .sub { font-size: 13px; color: #cdc3a6; text-align: center; line-height: 1.7; }
  footer {
    width: 100%; max-width: 400px; margin-top: 10px;
    font-size: 12px; color: #8d887e; text-align: center; line-height: 1.6;
  }
</style>
</head>
<body data-game="dsh-soulmojito.memory-match">
<header>
  <span class="game-name">记忆翻牌对战</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="scoreboard">
  <div class="side" id="side-red">
    <span>红方<span class="owner-tag" id="owner-red"></span></span>
    <span class="score" id="score-red">0</span>
  </div>
  <div class="side" id="side-blue">
    <span>蓝方<span class="owner-tag" id="owner-blue"></span></span>
    <span class="score" id="score-blue">0</span>
  </div>
</div>
<div class="board" id="board"></div>
<div class="result-strip hidden" id="result-strip">
  <div class="result" id="strip-result"></div>
  <div class="sub" id="strip-sub">对局结束</div>
</div>
<footer id="hint"></footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账、全量重渲染）、
   上行 dsh-soulmojito:game-action（合法性由服务端引擎终审）。token 从 location.search
   自读；无 token（浏览器直接打开）渲染静态预览局面。人类回合才启用翻牌：点第一张
   高亮待选（再点同张取消）、点第二张即提交 {type:'flip',a,b}；失配时做 ~1.4s
   「翻回预览」（纯视图动画——牌面来自 state.lastFlip，双方都看见过、零泄漏，
   动画期间不写任何状态）。坐席纪律（同 21 点）：人类未必执红，一切 你/AI 标注
   按 session.players 的 owner 反查落笔。 */

var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var current = null /* 最近一条 game-state：{ state, legal, finished, summary, session } */

var boardEl = document.getElementById('board')
var bannerEl = document.getElementById('banner')
var metaEl = document.getElementById('meta')
var stripEl = document.getElementById('result-strip')
var stripResultEl = document.getElementById('strip-result')
var stripSubEl = document.getElementById('strip-sub')
var hintEl = document.getElementById('hint')
var sideEls = { red: document.getElementById('side-red'), blue: document.getElementById('side-blue') }
var scoreEls = { red: document.getElementById('score-red'), blue: document.getElementById('score-blue') }
var ownerEls = { red: document.getElementById('owner-red'), blue: document.getElementById('owner-blue') }
var CARD_COUNT = 16
var PAIRS = 8
var PEEK_MS = 1400

var selected = []
var sending = false
var sendTimer = null
var lastSig = null
var peekKey = ''
var peekActive = false
var peekTimer = null

/* 无 token 的静态演示局面（对局中期，各字段自洽）：红蓝各配成 1 对、
   最近一手 (C1,D2) 失配（两张已翻回——视图不保留历史，只演示翻回预览形态）。 */
var PREVIEW_STATE = {
  turn: 'red', seed: 1,
  board: ['月', '月', null, null, null, null, '星', null, null, null, '星', null, null, null, null, null],
  scores: { red: 1, blue: 1 },
  ply: 5,
  lastFlip: { cards: [2, 7], faces: ['花', '雷'], match: false },
  finished: false, winner: null,
}
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-soulmojito.memory-match',
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
  var state = view.state || null
  current = {
    state: state,
    legal: Array.isArray(view.legal) ? view.legal : [],
    finished: view.finished === true,
    summary: typeof view.summary === 'string' ? view.summary : '',
    session: data.session && typeof data.session === 'object' ? data.session : null,
  }
  handleState(state)
  render()
})

function active() {
  if (current) return current
  if (TOKEN !== null) {
    /* 已由游戏服务装载但首条 game-state 未到：空桌等待，不借预览局面。 */
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

function sideName(role) { return role === 'red' ? '红方' : '蓝方' }

function posName(index) {
  return 'ABCD'.charAt(index % 4) + String(Math.floor(index / 4) + 1)
}

function signatureOf(state) {
  if (!state) return ''
  var flip = 'none'
  if (state.lastFlip) {
    flip = state.lastFlip.cards[0] + ',' + state.lastFlip.cards[1] + ',' + (state.lastFlip.match ? '1' : '0')
  }
  return state.ply + '|' + state.turn + '|' + state.scores.red + '|' + state.scores.blue + '|' + flip + '|' + (state.finished ? 'end' : 'live')
}

/* 局面变化 → 清空本地选择/发送锁；失配的新一手 → 启动翻回预览（纯动画）。 */
function handleState(state) {
  var sig = signatureOf(state)
  if (lastSig === null) {
    peekKey = state && state.lastFlip ? JSON.stringify(state.lastFlip) : ''
  } else if (sig !== lastSig) {
    selected = []
    sending = false
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null }
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null }
    peekActive = false
    var key = state && state.lastFlip ? JSON.stringify(state.lastFlip) : ''
    if (state && !state.finished && state.lastFlip && state.lastFlip.match === false && key !== peekKey) {
      peekActive = true
      peekKey = key
      peekTimer = setTimeout(function () { peekActive = false; peekTimer = null; render() }, PEEK_MS)
    } else {
      peekKey = key
    }
  }
  lastSig = sig
}

function canAct() {
  if (!TOKEN || !current || !current.state || current.state.finished) return false
  if (sending) return false
  return ownerOf(current.session, current.state.turn) === 'human'
}

/* 上行 dsh-soulmojito:game-action；合法性由服务端引擎终审（视图只会提交两张
   背面牌，且选中集在提交后被发送锁冻结，直到局面更新或 4s 解锁兜底）。 */
function send(action) {
  if (!TOKEN) return
  window.parent.postMessage(
    { type: 'dsh-soulmojito:game-action', token: TOKEN, action: action },
    '*',
  )
}

function onPick(index) {
  if (!canAct()) return
  var state = current.state
  if (!state || state.board[index] !== null) return
  var at = selected.indexOf(index)
  if (at >= 0) {
    selected.splice(at, 1)
    render()
    return
  }
  selected.push(index)
  if (selected.length >= 2) {
    var a = selected[0]
    var b = selected[1]
    sending = true
    send({ type: 'flip', a: a, b: b })
    if (sendTimer) clearTimeout(sendTimer)
    sendTimer = setTimeout(function () { sending = false; render() }, 4000)
  }
  render()
}

function peekFaceAt(state, index) {
  if (!peekActive || !state || !state.lastFlip) return null
  if (state.lastFlip.cards[0] === index) return state.lastFlip.faces[0]
  if (state.lastFlip.cards[1] === index) return state.lastFlip.faces[1]
  return null
}

function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild) }

function appendText(parent, className, text) {
  var span = document.createElement('span')
  span.className = className
  span.textContent = text
  parent.appendChild(span)
}

function renderBoard(state) {
  var board = state ? state.board : null
  var matched = 0
  clearEl(boardEl)
  for (var index = 0; index < CARD_COUNT; index++) {
    var face = board ? board[index] : null
    var peek = face === null ? peekFaceAt(state, index) : null
    var el = document.createElement('div')
    var cls = 'card'
    if (face !== null && face !== undefined) { cls += ' matched'; matched += 1 }
    else if (peek !== null) cls += ' peek'
    else cls += ' back'
    if (selected.indexOf(index) >= 0) cls += ' selected'
    var acting = canAct() && face === null && selected.indexOf(index) < 0
    if (acting) cls += ' clickable'
    el.className = cls
    appendText(el, 'pos', posName(index))
    if (face !== null && face !== undefined) appendText(el, 'face', face)
    else if (peek !== null) appendText(el, 'face', peek)
    if (acting) {
      ;(function (cardIndex) {
        el.addEventListener('click', function () { onPick(cardIndex) })
      })(index)
    }
    boardEl.appendChild(el)
  }
  return matched
}

function setOwner(role, owner) {
  if (owner === 'human') {
    ownerEls[role].textContent = '你'
    ownerEls[role].className = 'owner-tag human'
  } else if (owner === 'agent') {
    ownerEls[role].textContent = 'AI'
    ownerEls[role].className = 'owner-tag agent'
  } else {
    ownerEls[role].textContent = ''
    ownerEls[role].className = 'owner-tag'
  }
}

function endText(state, session) {
  if (state.winner !== 'red' && state.winner !== 'blue') return '平局'
  var text = sideName(state.winner) + '胜'
  var owner = ownerOf(session, state.winner)
  if (owner === 'human') return text + '（你）'
  if (owner === 'agent') return text + '（AI）'
  return text
}

function render() {
  var act = active()
  var state = act.state
  var live = current !== null || TOKEN !== null

  setOwner('red', act.session ? ownerOf(act.session, 'red') : null)
  setOwner('blue', act.session ? ownerOf(act.session, 'blue') : null)
  var matched = renderBoard(state)

  sideEls.red.className = 'side' + (!state || state.finished ? '' : state.turn === 'red' ? ' active' : '')
  sideEls.blue.className = 'side' + (!state || state.finished ? '' : state.turn === 'blue' ? ' active' : '')
  scoreEls.red.textContent = state ? String(state.scores.red) : '0'
  scoreEls.blue.textContent = state ? String(state.scores.blue) : '0'

  if (!live) metaEl.textContent = '预览模式'
  else if (!state) metaEl.textContent = '等待会话…'
  else metaEl.textContent = (act.session && act.session.id ? '对局 ' + act.session.id : '对局中')
    + ' · 已翻 ' + state.ply + ' 手 · 已配对 ' + (matched / 2) + '/' + PAIRS

  var cls = 'preview'
  var text = '预览模式：由 dsh-soulmojito 游戏服务装载后启用交互'
  if (live) {
    if (!state) {
      text = '等待对局状态…'
    } else if (state.finished) {
      cls = 'finished'
      text = act.summary ? '对局结束 · ' + act.summary : '对局结束：' + endText(state, act.session)
    } else {
      cls = state.turn === 'red' ? 'turn-red' : 'turn-blue'
      var owner = ownerOf(act.session, state.turn)
      var who = sideName(state.turn) + (owner === 'agent' ? '（AI）' : owner === 'human' ? '（你）' : '')
      text = who + (owner === 'agent' ? ' 思考中…' : owner === 'human' ? ' · 轮到你翻开两张牌' : ' · 行动中')
      if (act.summary) text += ' · ' + act.summary
    }
  }
  bannerEl.className = cls
  bannerEl.textContent = text

  var finished = !!(live && state && state.finished)
  stripEl.className = finished ? 'result-strip' : 'result-strip hidden'
  if (finished) {
    stripResultEl.textContent = endText(state, act.session)
    stripSubEl.textContent = act.summary || '对局结束'
  }

  if (!live) {
    hintEl.textContent = '这是静态预览局面：由 dsh-soulmojito 游戏服务装载后，牌桌将接收实时状态并启用翻牌。'
  } else if (!state) {
    hintEl.textContent = '正在连接 dsh-soulmojito 游戏服务…'
  } else if (state.finished) {
    hintEl.textContent = '对局已结束。可在对局面板中开新一局，或让 AI 再来一盘。'
  } else if (sending) {
    hintEl.textContent = '正在翻开…'
  } else if (canAct()) {
    hintEl.textContent = '轮到你：点击两张未翻开的牌（同一张再点一次取消）。配成一对得 1 分并继续翻；没配上就翻回、换对方。'
  } else {
    hintEl.textContent = 'AI 思考中，翻牌会自动出现在牌桌上。'
  }
}

render()
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const memoryMatch = { manifest, engine, viewHtml } as const
