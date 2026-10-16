/**
 * 内置游戏：21点 / Blackjack（提案 0018 §4.1 内置序列第五款，2026-10-14）。
 *
 * 需求源：用户「并行实现新内置游戏21点」+ 同日中途改版「改成AI做庄」。
 * 装载形态与 builtin/tic-tac-toe.ts、gomoku.ts、xiangqi.ts、junqi.ts 同款——
 * 静态 import 的 TS 引擎 + viewHtml 字符串常量内联（mood-tracker UI_PAGE
 * 先例），零文件依赖、随插件分发；决策与边界见
 * decisions/2026-10-14-blackjack-builtin.md。
 *
 * 语义定位（v2 最终面）：玩家 vs AI 庄家——roles ['player','dealer']，人类
 * 缺省执 player、Agent 缺省执 dealer（sessions.start 缺省 roles[0] 归人类、
 * game_start 的 role 缺省取另一方 →「AI 做庄」是开箱默认）。**庄家手由
 * Agent 真实来打**：庄家回合轮到 Agent，逐张补牌、最后停牌；v1 曾是
 * 「双方各执一手牌对赌、庄家只是引擎机制」，用户中途裁定改为真正的庄家
 * 角色（v1 形态与变更留档见决策文档）。
 *
 * 规则面（v1 明示裁剪，决策文档同款）：
 * - 点数：A 记 1 或 11（取不爆的最大值），J/Q/K 记 10，其余按面值；
 * - 玩家：到 21 点自动停牌（含初始天牌），超过 21 点即爆牌并立即结算；
 * - 庄家：**赌场家规由引擎强制执行**（<17 点只许补牌、≥17 点只许停牌——
 *   违规动作中文抛错；S17 软 17 也停）——庄家自由决策会显著抬升庄家优势，
 *   家规是公平性基石；每张补牌仍是 Agent 的一手调用（叙述素材）；
 * - 亮暗牌：玩家停牌那一刻同手亮明暗牌（此后 Agent 按家规补牌）；
 *   玩家爆牌结算时庄家只亮牌不补牌（赌场同规：无人可比）；
 * - 不实现：下注/筹码、加倍（double down）、分牌（split）、保险（insurance）、
 *   天牌（Blackjack）特殊赔付——两张 21 只是普通 21 点（自动停牌覆盖）；
 * - 保留动作 resign 由运行时统一处理（引擎收到一律抛错）。
 *
 * **暗牌延迟决定（核心公平性设计）**：玩家回合期庄家只有 1 张明牌，暗牌在
 * 玩家停牌（或爆牌结算）时才从牌靴游标续发并立即亮明——桥契约里 state 对
 * 视图/Agent 全明（viewOf 与 game_state 工具无按角色投影的通道），「信息不
 * 存在」是唯一防偷看手段；统计上与「开局先扣暗牌、停牌再摊」对玩家无差别，
 * 且揭晓时玩家已无决策可受影响。
 *
 * 确定性纪律：全文除 createGame 缺省 seed（node:crypto randomInt 的唯一
 * 随机点）外无任何随机/时间源。牌靴 = 分块流：全局第 i 张 = 第
 * floor(i/52) 块的第 i%52 张；第 k 块（0 基）用 mulberry32(seed 与 k 双乘
 * 混淆) 对规范牌序 0..51 做 Fisher-Yates——块间互不重叠、取之不尽（无耗尽
 * 边界、无切牌），引擎任何时刻只凭 {seed, dealt} 即可重放出下一张。
 * createGame(options) 读 options.seed（number 则用之，烟测传 {seed:1}）；
 * 发牌序 P1,P2,庄家明牌（流下标 0..2）；玩家初始 21 则自动停牌、
 * turn='dealer'（createGame 无事件面，只体现于 state）；无重发分支——庄家
 * 回合的家规建议集恒非空（单张明牌 ≤11 点 <17）。
 *
 * state 形状（运行时补充契约：顶层 turn 为当前行动方角色名；终局后留在
 * 最后行动方、保持合法角色值）：
 * { turn: 'player' | 'dealer', seed, dealt（牌靴游标）,
 *   hands: { player: Card[]; dealer: Card[] }（Card = { r, s }，r 为
 *   'A'|'2'|…|'10'|'J'|'Q'|'K'，s 为 '♠'|'♥'|'♦'|'♣'；玩家回合期 dealer
 *   恒 1 张明牌）,
 *   totals: { player, dealer }（引擎维护的最佳点数；玩家回合期 dealer 为
 *   明牌点数，A 明牌记 11——单张的最佳点数）,
 *   finished, winner: 'player' | 'dealer' | null }
 * 终局不变量：finished ⇒ hands.dealer.length ≥ 2（暗牌必已亮）。
 *
 * 叙述（events/summary/describe 统一；牌面 = 花色+点数，如 ♠A、♥10）：
 * 玩家要牌得 X（当前 N 点）/ 玩家停牌（N 点）/ 玩家已到 21 点，自动停牌 /
 * 玩家爆牌（N 点）/ 庄家亮出暗牌：X（合计 N 点）/ 庄家补牌得 X（当前 N 点）/
 * 庄家停牌（N 点）/ 庄家爆牌（N 点）/ 结算：玩家 N 点、庄家 M 点——庄家胜
 * （玩家胜/平局；单爆——对方胜）。summary = 本手事件用「，」串接（终局手以
 * 结算句收尾；describe 在落子前 state 基础上取当前点数）。庄家动作词汇是
 * 「补牌」不是「要牌」（赌场语义）。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面；玩家回合（按
 * session.players 的 owner 判定）才启用「要牌/停牌」按钮；庄家区玩家回合期
 * 渲染明牌 + 一张纯装饰的背面牌占位（暗牌点数揭晓前不存在，绝不伪造）。
 *
 * 坐席归属纪律（2026-10-14 用户坐庄实况修订）：人类未必执 player——game_start
 * 的 role 推演出坐庄对局（g-9136e61b：人类坐庄、Agent 执 player）。视图一切
 * 「谁是谁」的表述都按 owner 反查落笔，绝不把默认坐席（AI 坐庄）写死：修复前
 * 提示层硬编码「庄家（AI）按规则补牌中」/「停牌交给庄家」，用户坐庄时前者把
 * 执 player 的 AI 说成庄家（即用户实况「结算后显示时 AI 坐庄」）、后者把庄家
 * 当成对手（叫坐庄的用户「交给庄家」）。现提示按当前行动方的角色 + owner 生成
 * （庄家（AI）按家规补牌中 / 玩家（AI）行动中 / 你是庄家——只讲家规）；按钮随
 * view.legal 收缩（坐庄时合法集恒只剩一条，绝不展示引擎必拒的动作）；终局结果
 * 条在角色名后附 owner（庄家胜（你）/ 玩家胜（AI）），结算时点不留坐席歧义。
 */

import { randomInt } from 'node:crypto'
import type { GameEngine, GameManifest } from '../standard.js'

/** 规范牌序的点数面（i%13）；花色面（floor(i/13)）见 SUITS。 */
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const SUITS: readonly Suit[] = ['♠', '♥', '♦', '♣']
/** 单副牌张数（一个牌靴块的大小）。 */
const SHOE_CHUNK = 52

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.blackjack',
  name: '21点',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['player', 'dealer'] },
  turnBased: true,
  actionVocabulary: "要牌 {type:'hit'} / 停牌 {type:'stand'}：玩家对庄家——轮到玩家时决定是否再要一张牌（目标是手牌点数尽量接近 21 点且不超过，A 记 1 或 11，J/Q/K 记 10），到 21 点自动停牌、超过 21 点即爆牌；玩家停牌或爆牌后庄家亮暗牌并按家规补牌（低于 17 点必须补、达到 17 点及以上必须停），比点数定胜负（玩家爆庄家胜、庄家爆玩家胜、高者胜、同点平局）；认输 {type:'resign'} 由运行时统一处理",
}

type Role = 'player' | 'dealer'

type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'
type Suit = '♠' | '♥' | '♦' | '♣'

/** 一张牌：r 点数面、s 花色面（叙述用 s+r，如 ♠A、♥10）。 */
interface Card {
  r: Rank
  s: Suit
}

interface BlackjackState {
  turn: Role
  seed: number
  /** 牌靴游标：已消费的流位置。 */
  dealt: number
  /** 玩家回合期 hands.dealer 恒 1 张明牌；暗牌在玩家停牌/爆牌结算时续发（≥2）。 */
  hands: { player: Card[]; dealer: Card[] }
  totals: { player: number; dealer: number }
  finished: boolean
  winner: Role | null
}

/** 庄家家规阈值：最佳点数 ≥17 必须停牌（S17——软 17 也停）。 */
const DEALER_STAND_AT = 17

function sideName(role: Role): string {
  return role === 'player' ? '玩家' : '庄家'
}

/** 牌面文本：花色+点数（♠A、♥10）。 */
function cardText(card: Card): string {
  return card.s + card.r
}

/** 一手的最佳点数：A 全按 1 计后再尽量把一张 A 升为 11（不爆的最大值）。 */
function bestTotal(hand: Card[]): number {
  let total = 0
  let aces = 0
  for (const card of hand) {
    if (card.r === 'A') {
      aces += 1
      total += 1
    } else if (card.r === 'J' || card.r === 'Q' || card.r === 'K') {
      total += 10
    } else {
      total += Number(card.r)
    }
  }
  while (aces > 0 && total + 10 <= 21) {
    total += 10
    aces -= 1
  }
  return total
}

/** 深拷贝 state（逐手牌逐张、totals 逐字段），绝不共享可变结构。 */
function cloneState(state: BlackjackState): BlackjackState {
  return {
    turn: state.turn,
    seed: state.seed,
    dealt: state.dealt,
    hands: {
      player: state.hands.player.map((card) => ({ ...card })),
      dealer: state.hands.dealer.map((card) => ({ ...card })),
    },
    totals: { ...state.totals },
    finished: state.finished,
    winner: state.winner,
  }
}

/** mulberry32：32 位种子 PRNG（实现短小、可复现，质量足够洗 52 张牌）。 */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 规范牌序 0..51 → 牌面：i%13 定点数（A..K）、floor(i/13) 定花色（♠♥♦♣）。 */
function cardOfIndex(index: number): Card {
  return { r: RANKS[index % 13]!, s: SUITS[Math.floor(index / 13)]! }
}

/**
 * 牌靴流的第 index 张（0 基全局下标）：第 floor(index/52) 块用
 * mulberry32(seed 与块号双乘混淆) 对 0..51 做 Fisher-Yates 后取
 * index%52 位。同 seed 相邻块牌序互不相关；块取之不尽，无耗尽边界。
 */
function cardAt(seed: number, index: number): Card {
  const chunk = Math.floor(index / SHOE_CHUNK)
  const rand = mulberry32((Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(chunk + 1, 0x85EBCA77)) | 0)
  const order: number[] = Array.from({ length: SHOE_CHUNK }, (_, i) => i)
  for (let i = SHOE_CHUNK - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const swap = order[i]!
    order[i] = order[j]!
    order[j] = swap
  }
  return cardOfIndex(order[index % SHOE_CHUNK]!)
}

/** 从 next 的游标摸一张并入手牌（游标同步前移、点数重算），返回该牌。 */
function drawInto(next: BlackjackState, role: Role): Card {
  const card = cardAt(next.seed, next.dealt)
  next.dealt += 1
  next.hands[role] = [...next.hands[role], { ...card }]
  next.totals[role] = bestTotal(next.hands[role])
  return card
}

/**
 * 亮暗牌：暗牌此刻才从牌靴游标续发并入庄家手（文件头「暗牌延迟决定」——
 * 玩家停牌/爆牌结算时才揭晓，此前明牌之外无信息存在于任何一面）。
 */
function revealHole(next: BlackjackState, events: string[]): void {
  const card = drawInto(next, 'dealer')
  events.push(`庄家亮出暗牌：${cardText(card)}（合计 ${next.totals.dealer} 点）`)
}

/** 玩家爆牌即结算：亮暗牌但不补牌（赌场同规：无人可比），庄家胜。 */
function settlePlayerBust(next: BlackjackState, events: string[]): void {
  revealHole(next, events)
  events.push(`结算：玩家爆牌（${next.totals.player} 点）——庄家胜`)
  next.finished = true
  next.winner = 'dealer'
}

/** 庄家停牌即终局比点：庄家高于玩家 → 庄家胜，低于 → 玩家胜，同点 → 平局。 */
function settleDealerStand(next: BlackjackState, events: string[]): void {
  const playerTotal = next.totals.player
  const dealerTotal = next.totals.dealer
  const winner: Role | null = dealerTotal > playerTotal ? 'dealer' : playerTotal > dealerTotal ? 'player' : null
  events.push(`结算：玩家 ${playerTotal} 点、庄家 ${dealerTotal} 点——${winner === null ? '平局' : `${sideName(winner)}胜`}`)
  next.finished = true
  next.winner = winner
}

const engine: GameEngine = {
  meta: MANIFEST,

  /**
   * 开局：读 options.seed（number 则用之；缺省用 node:crypto 随机整数——
   * 全文唯一的随机点）。玩家 2 张（P1,P2）+ 庄家 1 张明牌（流下标 0..2，
   * dealt=3）；玩家初始恰好 21 点 → 自动停牌、turn='dealer'（无事件面，
   * 只体现于 state——createGame 契约不含 events）。
   */
  createGame(options?: unknown): { state: BlackjackState } {
    const record = options !== null && typeof options === 'object' && !Array.isArray(options)
      ? options as { seed?: unknown }
      : {}
    const seed = typeof record.seed === 'number' && Number.isFinite(record.seed)
      ? record.seed
      : randomInt(0, 0x8000_0000)

    const player = [cardAt(seed, 0), cardAt(seed, 1)]
    const dealer = [cardAt(seed, 2)]
    const state: BlackjackState = {
      turn: 'player',
      seed,
      dealt: 3,
      hands: { player, dealer },
      totals: { player: bestTotal(player), dealer: bestTotal(dealer) },
      finished: false,
      winner: null,
    }
    if (state.totals.player === 21) state.turn = 'dealer'
    return { state }
  },

  /**
   * 当前行动方的建议集：终局 → []；玩家回合恒 [{type:'hit'}, {type:'stand'}]
   * （此序）；庄家回合按家规——最佳点数 <17 恰 [{type:'hit'}]、≥17 恰
   * [{type:'stand'}]（唯一合法动作，家规即引擎级非法动作闸）。
   */
  legalActions(state: BlackjackState): Array<{ type: 'hit' } | { type: 'stand' }> {
    if (state.finished) return []
    if (state.turn === 'dealer') {
      return state.totals.dealer < DEALER_STAND_AT ? [{ type: 'hit' }] : [{ type: 'stand' }]
    }
    return [{ type: 'hit' }, { type: 'stand' }]
  },

  /**
   * 行动并推进局面。校验顺序（镜像 gomoku）：动作形状 → type 已知 → 未终局
   * → 角色合法 → actor===turn → 家规（庄家动作面）→ 应用；任一不过抛 Error
   * （中文报错）。绝不改入参 state——深拷贝出新态。
   *
   * 玩家 hit：摸一张；>21 爆牌 → 立即结算（亮暗牌、庄家不补牌、庄家胜）；
   * ==21 自动停牌 → turn='dealer' + 亮暗牌；<21 turn 不变。
   * 玩家 stand：turn='dealer' + 亮暗牌（同一手内完成）。
   * 庄家 hit（家规 <17 才许）：摸一张；>21 爆牌 → 立即结算（玩家胜）；
   * 否则 turn 不变（<17 继续补、17-21 转 [stand] 待停）。
   * 庄家 stand（家规 ≥17 才许）：终局比点（庄家胜/玩家胜/平局）。
   */
  applyAction(state: BlackjackState, action: unknown, actor: string): {
    state: BlackjackState
    events: string[]
    finished: boolean
    winner: Role | null
    summary: string
  } {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    const typed = action as { type?: unknown }
    if (typeof typed.type !== 'string' || typed.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (typed.type !== 'hit' && typed.type !== 'stand') {
      throw new Error(`不支持的动作类型「${typed.type}」：本引擎只实现 hit/stand（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再行动')
    }
    if (actor !== 'player' && actor !== 'dealer') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 player/dealer`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${String(actor)} 不能行动`)
    }
    const role: Role = actor

    // 赌场家规（庄家动作面唯一合法路径，引擎即监察）——先于深拷贝拒绝。
    if (role === 'dealer') {
      if (typed.type === 'hit' && state.totals.dealer >= DEALER_STAND_AT) {
        throw new Error(`庄家点数已达 ${DEALER_STAND_AT} 点，必须停牌（庄家规则）`)
      }
      if (typed.type === 'stand' && state.totals.dealer < DEALER_STAND_AT) {
        throw new Error(`庄家点数不足 ${DEALER_STAND_AT} 点，必须补牌（庄家规则）`)
      }
    }

    const next = cloneState(state)
    const events: string[] = []

    if (role === 'player') {
      if (typed.type === 'hit') {
        const card = drawInto(next, 'player')
        const total = next.totals.player
        events.push(`玩家要牌得 ${cardText(card)}（当前 ${total} 点）`)
        if (total > 21) {
          events.push(`玩家爆牌（${total} 点）`)
          settlePlayerBust(next, events)
        } else if (total === 21) {
          events.push('玩家已到 21 点，自动停牌')
          next.turn = 'dealer'
          revealHole(next, events)
        }
      } else {
        events.push(`玩家停牌（${next.totals.player} 点）`)
        next.turn = 'dealer'
        revealHole(next, events)
      }
    } else {
      if (typed.type === 'hit') {
        const card = drawInto(next, 'dealer')
        const total = next.totals.dealer
        events.push(`庄家补牌得 ${cardText(card)}（当前 ${total} 点）`)
        if (total > 21) {
          events.push(`庄家爆牌（${total} 点）`)
          events.push(`结算：庄家爆牌（${total} 点）——玩家胜`)
          next.finished = true
          next.winner = 'player'
        }
        // <17 继续补、17-21 转 [stand] 待停：turn 保持 'dealer'。
      } else {
        events.push(`庄家停牌（${next.totals.dealer} 点）`)
        settleDealerStand(next, events)
      }
    }
    return { state: next, events, finished: next.finished, winner: next.winner, summary: events.join('，') }
  },

  /** 人类可读的一手描述（Agent 在对话里角色化叙述用；落子前 state 的点数。
   *  庄家动作词汇是「补牌」不是「要牌」（赌场语义）。 */
  describe(state: BlackjackState, actor: string, action: unknown): string {
    const role: Role = actor === 'dealer' ? 'dealer' : 'player'
    const type = action !== null && typeof action === 'object' && !Array.isArray(action)
      ? (action as { type?: unknown }).type
      : undefined
    const verb = role === 'dealer' ? '补牌' : '要牌'
    if (type === 'hit') return `${sideName(role)}${verb}（当前 ${state.totals[role]} 点）`
    if (type === 'stand') return `${sideName(role)}停牌（当前 ${state.totals[role]} 点）`
    return `${sideName(role)}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as blackjackEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置 21 点随 bundle 分发）。
 * 桌面绿绒赌桌：上方庄家区（玩家回合期明牌 + 纯装饰背面牌占位；亮牌后只显牌），
 * 下方玩家手牌区（owner 标注 你/AI），爆牌红示、21 点金示；终局结果以盘面
 * 之下的结果条呈现（终局盘面完整保留、零叠压——见 .result-strip 注释）。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>21点 · dsh-soulmojito 游戏桥</title>
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
  #banner.turn-player { background: #12241a; border-color: #3f6b52; }
  #banner.turn-dealer { background: #232016; border-color: #6b5e3f; }
  #banner.finished    { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview     { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  .table {
    position: relative; width: 100%; max-width: 560px;
    border-radius: 14px; padding: 16px 14px 14px;
    background: radial-gradient(ellipse at 50% 0%, #1f7a52 0%, #17593d 55%, #103f2c 100%);
    border: 6px solid #5b3a20;
    box-shadow: 0 6px 24px rgba(0,0,0,.5), inset 0 0 80px rgba(0,0,0,.28);
    display: flex; flex-direction: column; gap: 12px;
  }
  .zone {
    background: rgba(0, 0, 0, .16); border: 1px solid rgba(255,255,255,.06);
    border-radius: 10px; padding: 8px 10px;
  }
  .zone.active { border-color: rgba(255, 215, 106, .55); }
  .zone-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 7px; }
  .zone-name { font-size: 13px; font-weight: 600; letter-spacing: 1px; }
  .owner-tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; margin-left: 6px; font-weight: 400; }
  .owner-tag.human { background: #1d4d33; color: #b8ecc9; }
  .owner-tag.agent { background: #27364e; color: #b9c8e6; }
  .score { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; color: #eef4e9; }
  .score.bust { color: #ff8574; }
  .score.gold { color: #ffd76a; }
  .cards { display: flex; flex-wrap: wrap; gap: 7px; min-height: 84px; align-items: center; }
  .card {
    width: 56px; height: 82px; border-radius: 7px;
    background: linear-gradient(160deg, #fdfbf4, #ece6d6);
    color: #1d2430; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    box-shadow: 0 2px 7px rgba(0,0,0,.38); font-weight: 700; user-select: none;
  }
  .card .r { font-size: 20px; line-height: 1; }
  .card .s { font-size: 17px; line-height: 1; }
  .card.red { color: #b03a2e; }
  .card.back {
    background: repeating-linear-gradient(45deg, #2c3e63 0, #2c3e63 5px, #243352 5px, #243352 10px);
    border: 4px solid #e9e2cf;
    box-shadow: 0 2px 7px rgba(0,0,0,.38), inset 0 0 0 1px rgba(255,255,255,.12);
  }
  .actions { width: 100%; max-width: 560px; display: flex; gap: 10px; margin-top: 12px; }
  .actions button {
    flex: 1; padding: 11px 0; font-size: 15px; font-weight: 600; letter-spacing: 4px;
    border-radius: 9px; border: 1px solid #caa84f; background: #1e5c40; color: #f2ead4;
    cursor: pointer; transition: background .15s, opacity .15s;
  }
  .actions button:hover:not(:disabled) { background: #26714f; }
  .actions button:disabled { opacity: .45; cursor: not-allowed; background: #22312a; border-color: #3d4f44; color: #a9b3a5; }
  .result-strip {
    width: 100%; max-width: 560px; margin-top: 12px;
    border-radius: 10px; padding: 12px 16px;
    background: #101812; border: 1px solid rgba(202, 168, 79, .5);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    /* 终局结果条（2026-10-14 截图驱动修订）：覆盖层压暗盘面与「结束时应该
       显示游戏盘面」的既定语义冲突（0.6.3 用户需求）+ 白卡渗色在 .74/.92
       下均可辨——改为盘面之下的 in-flow 结果条：盘面完整可见、文字零叠压。 */
  }
  .result-strip.hidden { display: none; }
  .result-strip .result { font-size: 24px; font-weight: 700; color: #f5e7bd; letter-spacing: 3px; }
  .result-strip .sub { font-size: 13px; color: #cdc3a6; text-align: center; line-height: 1.7; }
  footer {
    width: 100%; max-width: 560px; margin-top: 10px;
    font-size: 12px; color: #8d887e; text-align: center; line-height: 1.6;
  }
</style>
</head>
<body data-game="dsh-soulmojito.blackjack">
<header>
  <span class="game-name">21点</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="table" id="table">
  <div class="zone" id="dealer-zone">
    <div class="zone-head">
      <span class="zone-name">庄家<span class="owner-tag" id="dealer-owner"></span></span>
      <span class="score" id="dealer-score"></span>
    </div>
    <div class="cards" id="dealer-cards"></div>
  </div>
  <div class="zone" id="player-zone">
    <div class="zone-head">
      <span class="zone-name">玩家<span class="owner-tag" id="player-owner"></span></span>
      <span class="score" id="player-score"></span>
    </div>
    <div class="cards" id="player-cards"></div>
  </div>
</div>
<div class="result-strip hidden" id="result-strip">
  <div class="result" id="strip-result"></div>
  <div class="sub" id="strip-sub">对局结束</div>
</div>
<div class="actions">
  <button type="button" id="hit-btn" disabled>要牌</button>
  <button type="button" id="stand-btn" disabled>停牌</button>
</div>
<footer id="hint"></footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账、全量重渲染）、
   上行 dsh-soulmojito:game-action（合法性由服务端引擎终审）。token 从 location.search
   自读；无 token（浏览器直接打开）渲染静态预览局面。人类回合才启用「要牌/停牌」
   按钮——AI 回合的动作经下行自动出现在赌桌上。坐席纪律（2026-10-14 修订）：人
   类未必执 player（可坐庄），文案一律按 owner 反查生成、按钮随 view.legal 收缩，
   绝不把「AI 坐庄」的默认坐席写死。 */

var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var current = null /* 最近一条 game-state：{ state, legal, finished, summary, session } */

var bannerEl = document.getElementById('banner')
var metaEl = document.getElementById('meta')
var stripEl = document.getElementById('result-strip')
var stripResultEl = document.getElementById('strip-result')
var stripSubEl = document.getElementById('strip-sub')
var hintEl = document.getElementById('hint')
var hitBtn = document.getElementById('hit-btn')
var standBtn = document.getElementById('stand-btn')
var zoneEls = {
  dealer: document.getElementById('dealer-zone'),
  player: document.getElementById('player-zone'),
}
var cardsEls = {
  dealer: document.getElementById('dealer-cards'),
  player: document.getElementById('player-cards'),
}
var scoreEls = {
  dealer: document.getElementById('dealer-score'),
  player: document.getElementById('player-score'),
}
var ownerEls = {
  dealer: document.getElementById('dealer-owner'),
  player: document.getElementById('player-owner'),
}

/* 无 token 的静态演示局面（对局中期，totals 自洽）：玩家 ♠K♥4（14 点）、
   庄家明牌 ♣A（11 点），轮玩家（庄家暗牌未揭晓——牌背占位）。 */
var PREVIEW_STATE = {
  turn: 'player', seed: 1, dealt: 3,
  hands: {
    player: [{ r: 'K', s: '♠' }, { r: '4', s: '♥' }],
    dealer: [{ r: 'A', s: '♣' }],
  },
  totals: { player: 14, dealer: 11 },
  finished: false, winner: null,
}
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-soulmojito.blackjack',
  players: [
    { role: 'player', owner: 'human' },
    { role: 'dealer', owner: 'agent' },
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

function sideName(role) { return role === 'player' ? '玩家' : '庄家' }

function endText(state, session) {
  /* 坐席归属（2026-10-14 修订）：结果条在角色名后附 owner（庄家胜（你）/
     玩家胜（AI））——人类可坐庄，只报角色名会让「谁赢了」留歧义。owner 缺席
     （无 session）时回落纯角色名。 */
  if (state.winner !== 'player' && state.winner !== 'dealer') return '平局'
  var text = sideName(state.winner) + '胜'
  var owner = ownerOf(session, state.winner)
  if (owner === 'human') return text + '（你）'
  if (owner === 'agent') return text + '（AI）'
  return text
}

function humanTurn(act) {
  if (!act.state || act.state.finished) return false
  return ownerOf(act.session, act.state.turn) !== 'agent'
}

function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild) }

function cardEl(card) {
  var el = document.createElement('div')
  el.className = 'card' + (card.s === '♥' || card.s === '♦' ? ' red' : '')
  var rank = document.createElement('div')
  rank.className = 'r'
  rank.textContent = card.r
  var suit = document.createElement('div')
  suit.className = 's'
  suit.textContent = card.s
  el.appendChild(rank)
  el.appendChild(suit)
  return el
}

function backCardEl() {
  /* 纯装饰占位：庄家暗牌结算时才从牌靴决定（引擎侧「暗牌延迟决定」），
     点数此刻不存在——绝不伪造牌面。 */
  var el = document.createElement('div')
  el.className = 'card back'
  el.setAttribute('aria-label', '庄家暗牌占位（结算时才决定）')
  return el
}

function renderCards(role, cards) {
  clearEl(cardsEls[role])
  for (var i = 0; i < cards.length; i++) cardsEls[role].appendChild(cardEl(cards[i]))
}

function setScore(role, total, label) {
  /* label: ''（默认）| '停牌' | '爆牌' | '明牌'——点数旁的状态词。 */
  var text = total + ' 点'
  if (label === '明牌') text = '明牌 ' + total + ' 点'
  else if (label === '爆牌') text = total + ' 点 · 爆牌'
  else if (label === '停牌') text = total + ' 点 · 停牌'
  scoreEls[role].textContent = text
  scoreEls[role].className = 'score' + (total > 21 ? ' bust' : total === 21 ? ' gold' : '')
}

function handLabel(state, role) {
  /* 玩家：爆牌 / 已停牌（turn 已移到庄家即玩家定局——无 stood 旗，由回合推导）；
     庄家：爆牌（亮牌后由点数推导）。 */
  if (state.totals[role] > 21) return '爆牌'
  if (role === 'player' && state.turn === 'dealer' && !state.finished) return '停牌'
  return ''
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

function renderTable(state) {
  zoneEls.dealer.setAttribute('class', 'zone')
  zoneEls.player.setAttribute('class', 'zone')
  if (!state) {
    clearEl(cardsEls.dealer); clearEl(cardsEls.player)
    scoreEls.dealer.textContent = ''; scoreEls.player.textContent = ''
    scoreEls.dealer.className = 'score'; scoreEls.player.className = 'score'
    return
  }
  renderCards('dealer', state.hands.dealer)
  renderCards('player', state.hands.player)
  setScore('player', state.totals.player, handLabel(state, 'player'))
  if (state.hands.dealer.length >= 2) {
    /* 暗牌已揭晓（玩家停牌/爆牌结算时亮明）：只显牌，不再有装饰牌背。 */
    setScore('dealer', state.totals.dealer, handLabel(state, 'dealer'))
  } else {
    cardsEls.dealer.appendChild(backCardEl())
    setScore('dealer', state.totals.dealer, '明牌')
  }
  if (!state.finished) zoneEls[state.turn].setAttribute('class', 'zone active')
}

function render() {
  var act = active()
  var state = act.state
  var live = current !== null || TOKEN !== null

  setOwner('player', act.session ? ownerOf(act.session, 'player') : null)
  setOwner('dealer', act.session ? ownerOf(act.session, 'dealer') : null)
  renderTable(state)

  if (!live) metaEl.textContent = '预览模式'
  else if (!state) metaEl.textContent = '等待会话…'
  else metaEl.textContent = (act.session && act.session.id ? '对局 ' + act.session.id : '对局中') + ' · 已发 ' + state.dealt + ' 张'

  var cls = 'preview'
  var text = '预览模式：由 dsh-soulmojito 游戏服务装载后启用交互'
  if (live) {
    if (!state) {
      text = '等待对局状态…'
    } else if (state.finished) {
      cls = 'finished'
      text = act.summary ? '对局结束 · ' + act.summary : '对局结束：' + endText(state, act.session)
    } else {
      cls = state.turn === 'player' ? 'turn-player' : 'turn-dealer'
      var owner = ownerOf(act.session, state.turn)
      text = sideName(state.turn) + (owner === 'agent' ? ' · AI 思考中…' : owner === 'human' ? ' · 轮到你行动' : '行动中')
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

  var canAct = !!(live && TOKEN && state && !state.finished && humanTurn(act))
  /* 按钮随 legal 收缩（2026-10-14 修订）：人类坐庄时合法集恒只剩一条（不足 17
     只许补、≥17 只许停），另一颗按钮必须禁用而不是可点后被引擎打回；legal 空
     （无会话/引擎报错回落）时维持旧行为——按钮仍可点，由服务端终审。 */
  var constrain = act.legal.length > 0
  var allows = { hit: false, stand: false }
  for (var legalIndex = 0; legalIndex < act.legal.length; legalIndex++) {
    var legalEntry = act.legal[legalIndex]
    if (legalEntry && (legalEntry.type === 'hit' || legalEntry.type === 'stand')) allows[legalEntry.type] = true
  }
  hitBtn.disabled = !(canAct && (!constrain || allows.hit))
  standBtn.disabled = !(canAct && (!constrain || allows.stand))

  if (!live) {
    hintEl.textContent = '这是静态演示局面：由 dsh-soulmojito 游戏服务装载后，赌桌将接收实时状态并启用要牌/停牌按钮。'
  } else if (!state) {
    hintEl.textContent = '正在连接 dsh-soulmojito 游戏服务…'
  } else if (state.finished) {
    hintEl.textContent = '对局已结束。可在对局面板中开新一局，或让 AI 再来一盘。'
  } else if (humanTurn(act)) {
    /* 坐席分支（2026-10-14 修订）：人类执 player 沿用对局教学文案；人类坐庄时
       不得出现「交给庄家」（在叫坐庄的人把牌交给庄家）——只讲家规：不足 17
       必须补、≥17 必须停，动作面由 legal 收缩后的按钮承载。 */
    hintEl.textContent = ownerOf(act.session, 'player') === 'human'
      ? '轮到你行动：要牌再摸一张（A 记 1 或 11，超过 21 点即爆牌，到 21 点自动停牌），或停牌交给庄家（庄家按规则补到 17 点及以上）。'
      : '轮到你行动：你是庄家——点数不足 17 必须补牌、达到 17 点及以上必须停牌（庄家规则），按钮只保留规则允许的动作。'
  } else if (state.turn === 'dealer') {
    hintEl.textContent = '庄家（AI）按家规补牌中，动作将自动出现在赌桌上。'
  } else {
    hintEl.textContent = '玩家（AI）行动中，动作将自动出现在赌桌上。'
  }
}

/* 上行 dsh-soulmojito:game-action：人类回合（未终局、owner 非 agent）才发。
   合法性由服务端引擎终审——按钮只提供 hit/stand 两个固定动作。 */
function send(action) {
  if (!TOKEN) return
  var act = active()
  if (!act.state || act.state.finished || !humanTurn(act)) return
  window.parent.postMessage(
    { type: 'dsh-soulmojito:game-action', token: TOKEN, action: action },
    '*',
  )
}
hitBtn.addEventListener('click', function () { send({ type: 'hit' }) })
standBtn.addEventListener('click', function () { send({ type: 'stand' }) })

render()
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const blackjack = { manifest, engine, viewHtml } as const
