/**
 * 内置游戏：大富翁 / Monopoly（提案 0018 §4.1 内置序列第七款，2026-10-15）。
 *
 * 需求源：用户「实现内置游戏 大富翁」。装载形态与既有一切内置同款——静态
 * import 的 TS 引擎 + viewHtml 字符串常量内联（mood-tracker UI_PAGE 先例），
 * 零文件依赖、随插件分发；决策与边界见 decisions/2026-10-15-monopoly-builtin.md。
 *
 * 形态（v1）：双人环线经营——roles ['red','blue']，人类缺省执 red、Agent 缺省
 * 执 blue（sessions.start 缺省 roles[0] 归人类、game_start 的 role 缺省取另
 * 一方）。**信息全明**：桥契约里 state 对视图与 Agent 全量下发、无按角色脱敏
 * 通道——大富翁棋盘类信息天然全明，不做暗牌/暗地契（对照 21点的「暗牌延迟
 * 决定」与军棋的「暗棋不实现：接口事实裁定」，本款无此问题）。
 *
 * 规则面（v1 明示裁剪，决策文档同款）：
 * - 棋盘：24 格环线（7×7 外圈）——起点 1、地产 14、机会 4、税局 2、派出所 1、
 *   免费停车 1、年度分红 1；红蓝从起点出发，轮流掷 1 颗骰子（1d6）前进；
 * - 薪水：掷骰移动途中**经过或停留**起点领 200 元（机会卡移动不发薪水，
 *   「前往起点」卡除外）；
 * - 地产：停留无人地产可购买（售价=地价）；停留自有地产可加盖（最高 3 级，
 *   每级加盖费 = 地价 × 0.5）；停留对手地产须付租（租金 = 地价 × 等级系数
 *   [1 级 30%、2 级 70%、3 级 140%]）；购买/加盖均为一次一手、随后回合结束；
 * - 机会：12 张卡（现金增减/前进/后退/前往起点/进派出所/向对手支付），
 *   开局按 seed 洗成牌序进 state，抽到牌堆尾后循环重抽；**机会卡移动后的
 *   落地照常结算，但再次落在机会格不再抽卡**（防移动卡连锁，裁定见下）；
 * - 派出所：停留或卡片送入 → 下一次行动暂停（该回合掷骰空转，仅消耗一次
 *   行动）；v1 无保释金/探监；
 * - 破产：任何应付（租金/税费/机会卡支出）现金不足即破产——剩余现金归对手、
 *   对局立即结束、对手获胜；
 * - 终局兜底：每人 16 回合仍未破产 → 按净值（现金 + 地产投入：地价 + 已付
 *   加盖费）比高，相同为平局（防无限对局；「回合」= 掷骰行动，购买/加盖/
 *   跳过属于同一回合）；
 * - 不实现：抵押/变卖/协商交易、多骰与连击、监狱系统（保释/出狱途径）、
 *   地产升级特殊规则（酒店/旅馆）、多人（v1 会话硬裁剪 players.max===2，
 *   见 sessions.ts）；
 * - 保留动作 resign 由运行时统一处理（引擎收到一律抛错）。
 *
 * 确定性纪律：全文除 createGame 缺省 seed（node:crypto randomInt 的唯一随机
 * 点）外无任何随机/时间源——骰子流 diceAt(seed, 第 n 掷)、机会牌洗牌均以
 * mulberry32 从 seed 派生，state 只带 {seed, rolls, deck, deckIndex} 即可
 * 完整重放整局（重启续局 = 重开会话文件重建）。
 *
 * state 形状（运行时补充契约：顶层 turn 为当前行动方角色名；终局后留在最后
 * 行动方，保持合法角色值）：
 * { turn: 'red' | 'blue',
 *   phase: 'roll' | 'decide'（decide = 停留后的购买/加盖决定窗）,
 *   pending: 'buy' | 'build' | null（decide 窗内待决事项）,
 *   seed, rolls（骰子流游标）, deck（机会牌序：CHANCE_CARDS 下标数组）,
 *   deckIndex（机会牌游标，越尾取模循环）,
 *   cash: { red, blue }, pos: { red, blue }（棋盘下标）,
 *   owner: (Role | null)[]（24 格归属）, level: number[]（0 未售 / 1-3 级）,
 *   jailed: { red, blue }, turns: { red, blue }（已结束的回合数）,
 *   lastRoll: number | null（最近骰点，视图展示用）,
 *   finished, winner: Role | null, ending: 'bankrupt' | 'valuation' | null }
 *
 * 叙述（events/summary/describe 统一；格名用「」引用，金额带「元」字）：
 * 掷骰 `红方掷出 4 点：从「鼓浪屿」到「平遥古城」` / `经过起点，领取薪水
 * 200 元` / 购买 `红方买下「西湖」（300 元），现金剩余 1700 元` / 加盖
 * `红方为「西湖」加盖到 2 级（花费 150 元），现金剩余 1550 元` / 租
 * `「西湖」是蓝方的地产（2 级），红方支付租金 150 元` / 破产 `蓝方现金不足
 * 支付「长城」租金（需 750 元，仅有 320 元），破产` + `破产清算：剩余现金
 * 320 元归红方` / 净值 `达到 20 回合上限，按净值结算：红方 3200 元、蓝方
 * 2750 元——红方胜`；summary = 本手事件用「，」串接。describe 在落子前
 * state 上取（Agent 织入对话的自然语言面，与象棋记谱同一设计动机）。
 *
 * view.html 为内联字符串常量：自包含（无外链/无 fetch）、桥协议两条消息、
 * token 从 location.search 自读、无 token 渲染静态预览局面（= 引擎
 * createGame({seed:1}) 的开局态，spec 逐字段对账防漂移）；7×7 外圈棋盘 +
 * 中央面板（双方资金/地产/位置 + 最近骰点 + 行动叙述），购买/加盖/跳过按钮
 * 随 view.legal 收缩；一切「谁是谁」的表述按 session.players 的 owner 反查
 * 落笔（不写死缺省坐席——对照 21点坐席归属决策的同款纪律）。
 */

import { randomInt } from 'node:crypto'
import type { GameEngine, GameManifest } from '../standard.js'

type Role = 'red' | 'blue'
type TileKind = 'start' | 'property' | 'chance' | 'tax' | 'jail' | 'park' | 'bonus'

/** 棋盘格：kind 定结算语义；property 带 price；tax/bonus 带 amount。 */
interface Tile {
  kind: TileKind
  name: string
  price?: number
  amount?: number
}

/** 引擎唯一权威清单（内置游戏的 manifest 与 meta 同源同值）。engines 刻意
 *  缺席：内置游戏随插件同进程分发，宿主版本即插件版本，自我门控无意义
 *  （对照：导入包的 engines 范围在 registry 装载期校验）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-tavern.monopoly',
  name: '大富翁',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['red', 'blue'] },
  turnBased: true,
  actionVocabulary: "掷骰 {type:'roll'} / 购买 {type:'buy'} / 加盖 {type:'build'} / 跳过 {type:'pass'}：红蓝双方轮流掷 1 颗骰子沿 24 格环线前进——经过或停留起点领 200 元薪水；停留无人地产可购买、停留自有地产可加盖（最高 3 级，租金为地价的 30%/70%/140%）；停留对手地产付租、税局缴费、机会格抽卡（现金/移动/进派出所）；现金不足以支付即破产（对手胜）；每人 16 回合未分胜负按净值（现金+地产投入）比高；认输 {type:'resign'} 由运行时统一处理",
}

/**
 * 24 格环线（7×7 外圈，下标即棋盘位置，0 = 起点）。地产按地价升序铺满
 * 环线各区段；税收/福利金额为 v1 平衡面（模拟调参留档见决策文档）。
 */
const BOARD: readonly Tile[] = [
  { kind: 'start', name: '起点' },
  { kind: 'property', name: '鼓浪屿', price: 100 },
  { kind: 'chance', name: '机会' },
  { kind: 'property', name: '宽窄巷子', price: 150 },
  { kind: 'tax', name: '税务稽查', amount: 150 },
  { kind: 'property', name: '平遥古城', price: 200 },
  { kind: 'jail', name: '派出所' },
  { kind: 'property', name: '丽江古城', price: 250 },
  { kind: 'chance', name: '机会' },
  { kind: 'property', name: '西湖', price: 300 },
  { kind: 'park', name: '免费停车' },
  { kind: 'property', name: '张家界', price: 350 },
  { kind: 'bonus', name: '年度分红', amount: 200 },
  { kind: 'property', name: '黄山', price: 400 },
  { kind: 'chance', name: '机会' },
  { kind: 'property', name: '泰山', price: 450 },
  { kind: 'tax', name: '市政规费', amount: 200 },
  { kind: 'property', name: '故宫', price: 500 },
  { kind: 'chance', name: '机会' },
  { kind: 'property', name: '外滩', price: 550 },
  { kind: 'property', name: '洱海', price: 600 },
  { kind: 'property', name: '九寨沟', price: 650 },
  { kind: 'property', name: '兵马俑', price: 700 },
  { kind: 'property', name: '长城', price: 750 },
]

/** 派出所格下标（由表驱动派生，改表不漂移）。 */
const JAIL_INDEX = BOARD.findIndex((tile) => tile.kind === 'jail')

/** 起步资金（v1 平衡面）。 */
const START_CASH = 1500
/** 经过/停留起点的薪水（机会移动不发薪水）。 */
const START_SALARY = 200
/** 终局兜底：每人回合上限（到限按净值比高，防无限对局）。 */
const TURN_LIMIT = 16
/** 地产最高等级（1 空地 / 2 洋房 / 3 大厦）。 */
const MAX_LEVEL = 3
/** 租金系数（下标 = 等级；1 级 30%、2 级 70%、3 级 140% 地价）。 */
const RENT_FACTORS: readonly number[] = [0, 0.3, 0.7, 1.4]
/** 加盖费系数（每升一级 = 地价 × 0.5）。 */
const BUILD_COST_FACTOR = 0.5
/** 骰子面数（1d6）。 */
const DICE_FACES = 6

/** 机会卡效果：现金增减 / 向对手支付 / 环线移动 / 前往起点 / 进派出所。 */
type ChanceEffect =
  | { kind: 'cash'; amount: number }
  | { kind: 'transfer'; amount: number }
  | { kind: 'move'; steps: number }
  | { kind: 'goto-start' }
  | { kind: 'jail' }

interface ChanceCard {
  text: string
  effect: ChanceEffect
}

/**
 * 机会卡堆（12 张，开局按 seed 洗成牌序进 state）。移动卡效应后落地照常
 * 结算但不再连锁抽卡（settleLanding 的 allowChance=false），移动不发薪水。
 */
const CHANCE_CARDS: readonly ChanceCard[] = [
  { text: '银行分红，领取 300 元', effect: { kind: 'cash', amount: 300 } },
  { text: '缴纳所得税 200 元', effect: { kind: 'cash', amount: -200 } },
  { text: '前进 3 格', effect: { kind: 'move', steps: 3 } },
  { text: '后退 3 格', effect: { kind: 'move', steps: -3 } },
  { text: '受邀前往起点，领取薪水 200 元', effect: { kind: 'goto-start' } },
  { text: '被请进派出所，暂停一次行动', effect: { kind: 'jail' } },
  { text: '向对手支付 100 元', effect: { kind: 'transfer', amount: 100 } },
  { text: '商场促销中奖，领取 150 元', effect: { kind: 'cash', amount: 150 } },
  { text: '缴纳道路养护费 150 元', effect: { kind: 'cash', amount: -150 } },
  { text: '竞猜赢奖，领取 120 元', effect: { kind: 'cash', amount: 120 } },
  { text: '赞助社区活动，支出 100 元', effect: { kind: 'cash', amount: -100 } },
  { text: '前进 4 格', effect: { kind: 'move', steps: 4 } },
]

interface MonopolyState {
  turn: Role
  phase: 'roll' | 'decide'
  pending: 'buy' | 'build' | null
  seed: number
  rolls: number
  deck: number[]
  deckIndex: number
  cash: { red: number; blue: number }
  pos: { red: number; blue: number }
  owner: Array<Role | null>
  level: number[]
  jailed: { red: boolean; blue: boolean }
  turns: { red: number; blue: number }
  lastRoll: number | null
  finished: boolean
  winner: Role | null
  ending: 'bankrupt' | 'valuation' | null
}

function sideName(role: Role): string {
  return role === 'red' ? '红方' : '蓝方'
}

function otherRole(role: Role): Role {
  return role === 'red' ? 'blue' : 'red'
}

/** 地租（等级系数 × 地价；价格为 50 的倍数、系数为 0.2/0.5/1，必为整数）。 */
function rentOf(index: number, level: number): number {
  const price = BOARD[index]!.price!
  return Math.round(price * RENT_FACTORS[level]!)
}

/** 加盖费（每级 = 地价 × 0.5；价格为 50 的倍数，必为整数）。 */
function buildCostOf(index: number): number {
  return Math.round(BOARD[index]!.price! * BUILD_COST_FACTOR)
}

/** 净值（终局兜底比高用）：现金 + Σ（地价 + 已付加盖费）。 */
function netWorth(state: MonopolyState, role: Role): number {
  let total = state.cash[role]
  for (let index = 0; index < BOARD.length; index += 1) {
    if (state.owner[index] !== role) continue
    total += BOARD[index]!.price! + (state.level[index]! - 1) * buildCostOf(index)
  }
  return total
}

/** 深拷贝 state（数组/对象逐个复制），绝不共享可变结构。 */
function cloneState(state: MonopolyState): MonopolyState {
  return {
    turn: state.turn,
    phase: state.phase,
    pending: state.pending,
    seed: state.seed,
    rolls: state.rolls,
    deck: [...state.deck],
    deckIndex: state.deckIndex,
    cash: { ...state.cash },
    pos: { ...state.pos },
    owner: [...state.owner],
    level: [...state.level],
    jailed: { ...state.jailed },
    turns: { ...state.turns },
    lastRoll: state.lastRoll,
    finished: state.finished,
    winner: state.winner,
    ending: state.ending,
  }
}

/** mulberry32：32 位种子 PRNG（与 21点同款；实现短小、可复现）。 */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 派生流种子：seed 与计数字段双乘混淆（骰子流各掷、洗牌各自独立流）。 */
function streamSeed(seed: number, counter: number): number {
  return (Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(counter + 1, 0x85EBCA77)) | 0
}

/** 第 index 掷（0 基）的骰点：1d6。 */
function diceAt(seed: number, index: number): number {
  const rand = mulberry32(streamSeed(seed, index + 1))
  return 1 + Math.floor(rand() * DICE_FACES)
}

/** 机会牌序：对 0..11 做 Fisher-Yates（seed 派生；同 seed 恒同序）。 */
function shuffledDeck(seed: number): number[] {
  const rand = mulberry32(streamSeed(seed, 0))
  const deck = CHANCE_CARDS.map((_card, index) => index)
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const swap = deck[i]!
    deck[i] = deck[j]!
    deck[j] = swap
  }
  return deck
}

/**
 * 支付（租金/税费/机会卡支出）的统一闸：现金够则扣款返回 true；不够则破产
 * ——剩余现金归对手、对局结束、对手获胜（2 人局里「银行」不存在独立实体，
 * 银行收款一律等价于资产转移给对手，决策文档同款留档）。
 */
function payOrBust(next: MonopolyState, role: Role, amount: number, label: string, events: string[]): boolean {
  if (next.cash[role] < amount) {
    const creditor = otherRole(role)
    const remaining = next.cash[role]
    next.cash[creditor] += remaining
    next.cash[role] = 0
    events.push(`${sideName(role)}现金不足支付${label}（需 ${amount} 元，仅有 ${remaining} 元），破产`)
    events.push(`破产清算：剩余现金 ${remaining} 元归${sideName(creditor)}`)
    next.finished = true
    next.winner = creditor
    next.ending = 'bankrupt'
    return false
  }
  next.cash[role] -= amount
  return true
}

/** 终局兜底：按净值比高（相同为平局）。 */
function finalizeValuation(next: MonopolyState, events: string[]): void {
  const red = netWorth(next, 'red')
  const blue = netWorth(next, 'blue')
  const winner: Role | null = red > blue ? 'red' : blue > red ? 'blue' : null
  events.push(`达到 ${TURN_LIMIT} 回合上限，按净值结算：红方 ${red} 元、蓝方 ${blue} 元——${winner === null ? '平局' : `${sideName(winner)}胜`}`)
  next.finished = true
  next.winner = winner
  next.ending = 'valuation'
}

/** 回合收尾：回合数 +1、清决定窗；双满上限 → 净值终局；否则换手。 */
function endTurn(next: MonopolyState, events: string[]): void {
  const actor = next.turn
  next.turns[actor] += 1
  next.phase = 'roll'
  next.pending = null
  if (next.turns.red >= TURN_LIMIT && next.turns.blue >= TURN_LIMIT) {
    finalizeValuation(next, events)
    return
  }
  next.turn = otherRole(actor)
}

/** 机会卡结算（落地移动卡时进入 settleLanding，allowChance=false 防连锁）。 */
function applyChance(next: MonopolyState, role: Role, card: ChanceCard, events: string[]): void {
  const effect = card.effect
  if (effect.kind === 'cash') {
    if (effect.amount >= 0) {
      next.cash[role] += effect.amount
      return
    }
    payOrBust(next, role, -effect.amount, '机会卡支出', events)
    return
  }
  if (effect.kind === 'transfer') {
    if (!payOrBust(next, role, effect.amount, '机会卡支付', events)) return
    next.cash[otherRole(role)] += effect.amount
    return
  }
  if (effect.kind === 'goto-start') {
    next.pos[role] = 0
    next.cash[role] += START_SALARY
    events.push(`${sideName(role)}抵达起点，领取薪水 ${START_SALARY} 元`)
    return
  }
  if (effect.kind === 'jail') {
    next.pos[role] = JAIL_INDEX
    next.jailed[role] = true
    events.push(`${sideName(role)}被带往派出所，暂停一次行动`)
    return
  }
  // move：机会移动不发薪水；落地照常结算但不连锁抽卡。
  const from = next.pos[role]
  const target = (from + effect.steps + BOARD.length) % BOARD.length
  next.pos[role] = target
  events.push(`机会移动：${sideName(role)}从「${BOARD[from]!.name}」${effect.steps > 0 ? '前进' : '后退'} ${Math.abs(effect.steps)} 格到「${BOARD[target]!.name}」（不发薪水）`)
  settleLanding(next, role, events, false)
}

/**
 * 落地结算（掷骰与机会移动共用）。可能设置 decide 窗（购买/加盖）置
 * next.phase/pending；可能触碰破产/终局；不负责回合收尾（调用方按
 * `!finished && phase !== 'decide'` 判断）。
 */
function settleLanding(next: MonopolyState, role: Role, events: string[], allowChance: boolean): void {
  const index = next.pos[role]
  const tile = BOARD[index]!
  if (tile.kind === 'start') {
    events.push(`${sideName(role)}停留在起点`)
    return
  }
  if (tile.kind === 'park') {
    events.push(`${sideName(role)}免费停车，本回合无事发生`)
    return
  }
  if (tile.kind === 'bonus') {
    next.cash[role] += tile.amount!
    events.push(`${sideName(role)}在${tile.name}领取 ${tile.amount} 元`)
    return
  }
  if (tile.kind === 'tax') {
    if (payOrBust(next, role, tile.amount!, `「${tile.name}」${tile.amount} 元`, events)) {
      events.push(`${sideName(role)}缴纳「${tile.name}」${tile.amount} 元`)
    }
    return
  }
  if (tile.kind === 'jail') {
    next.jailed[role] = true
    events.push(`${sideName(role)}被请进派出所，暂停一次行动`)
    return
  }
  if (tile.kind === 'chance') {
    if (!allowChance) {
      events.push(`${sideName(role)}再次停留在机会格，本次不再抽卡`)
      return
    }
    const cardIndex = next.deck[next.deckIndex % next.deck.length]!
    next.deckIndex += 1
    const card = CHANCE_CARDS[cardIndex]!
    events.push(`机会：${card.text}`)
    applyChance(next, role, card, events)
    return
  }
  // property
  const price = tile.price!
  const owner = next.owner[index]!
  if (owner === null) {
    if (next.cash[role] >= price) {
      next.phase = 'decide'
      next.pending = 'buy'
      events.push(`${sideName(role)}停留「${tile.name}」（无人拥有，售价 ${price} 元），可购买或跳过`)
    } else {
      events.push(`「${tile.name}」无人拥有（售价 ${price} 元），${sideName(role)}现金不足无法购买`)
    }
    return
  }
  if (owner === role) {
    const level = next.level[index]!
    if (level >= MAX_LEVEL) {
      events.push(`「${tile.name}」已是最高等级（${MAX_LEVEL} 级），无需加盖`)
      return
    }
    const cost = buildCostOf(index)
    if (next.cash[role] >= cost) {
      next.phase = 'decide'
      next.pending = 'build'
      events.push(`「${tile.name}」是${sideName(role)}的地产（${level} 级），可花费 ${cost} 元加盖或跳过`)
    } else {
      events.push(`「${tile.name}」可加盖（需 ${cost} 元），${sideName(role)}现金不足`)
    }
    return
  }
  const level = next.level[index]!
  const rent = rentOf(index, level)
  if (!payOrBust(next, role, rent, `「${tile.name}」租金`, events)) return
  next.cash[owner] += rent
  events.push(`「${tile.name}」是${sideName(owner)}的地产（${level} 级），${sideName(role)}支付租金 ${rent} 元`)
}

/** 决定窗的中文描述（阶段闸报错与视图提示共用）。 */
function pendingLabel(state: MonopolyState): string {
  if (state.pending === 'buy') return '购买'
  if (state.pending === 'build') return '加盖'
  return '行动'
}

const engine: GameEngine = {
  meta: MANIFEST,

  /**
   * 开局：读 options.seed（number 则用之；缺省用 node:crypto 随机整数——
   * 全文唯一的随机点）。红方先行、双方资金 START_CASH、同在起点、地产
   * 全空地（owner null / level 0）、机会牌序按 seed 洗定。
   */
  createGame(options?: unknown): { state: MonopolyState } {
    const record = options !== null && typeof options === 'object' && !Array.isArray(options)
      ? options as { seed?: unknown }
      : {}
    const seed = typeof record.seed === 'number' && Number.isFinite(record.seed)
      ? record.seed
      : randomInt(0, 0x8000_0000)
    const state: MonopolyState = {
      turn: 'red',
      phase: 'roll',
      pending: null,
      seed,
      rolls: 0,
      deck: shuffledDeck(seed),
      deckIndex: 0,
      cash: { red: START_CASH, blue: START_CASH },
      pos: { red: 0, blue: 0 },
      owner: BOARD.map(() => null),
      level: BOARD.map(() => 0),
      jailed: { red: false, blue: false },
      turns: { red: 0, blue: 0 },
      lastRoll: null,
      finished: false,
      winner: null,
      ending: null,
    }
    return { state }
  },

  /**
   * 当前行动方的建议集：终局 → []；掷骰阶段恒 [{type:'roll'}]；决定窗按
   * pending 返回 [{buy|build}, {pass}]（此序，购买/加盖在前）。
   */
  legalActions(state: MonopolyState): Array<{ type: 'roll' | 'buy' | 'build' | 'pass' }> {
    if (state.finished) return []
    if (state.phase === 'decide') {
      if (state.pending === 'buy') return [{ type: 'buy' }, { type: 'pass' }]
      if (state.pending === 'build') return [{ type: 'build' }, { type: 'pass' }]
      return [{ type: 'pass' }]
    }
    return [{ type: 'roll' }]
  },

  /**
   * 行动并推进局面。校验顺序（镜像既有一切内置）：动作形状 → type 已知 →
   * 未终局 → 角色合法 → actor===turn → 阶段闸（roll 只许在掷骰阶段；
   * buy/build/pass 只许在决定窗且 pending 匹配）→ 决定窗防御性复查（地产
   * 归属/现金）→ 应用；任一不过抛 Error（中文报错）。绝不改入参 state——
   * 深拷贝出新态。
   *
   * roll：派出所滞留则消耗本次行动（空转）；否则掷骰移动 + 过起点薪水 +
   * 落地结算；落地无决定窗则回合收尾（回合数 +1、双满上限净值终局）。
   * buy/build：扣款生效（买下置 owner=role/level=1；加盖 level+1），回合收尾。
   * pass：放弃当前决定，回合收尾。
   */
  applyAction(state: MonopolyState, action: unknown, actor: string): {
    state: MonopolyState
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
    const type = typed.type
    if (type !== 'roll' && type !== 'buy' && type !== 'build' && type !== 'pass') {
      throw new Error(`不支持的动作类型「${type}」：本引擎只实现 roll/buy/build/pass（resign 由运行时统一处理）`)
    }
    if (state.finished) {
      throw new Error('对局已结束，不能再行动')
    }
    if (actor !== 'red' && actor !== 'blue') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 red/blue`)
    }
    if (actor !== state.turn) {
      throw new Error(`现在轮到${sideName(state.turn)}，${sideName(actor)} 不能行动`)
    }
    const role: Role = actor
    if (type === 'roll' && state.phase !== 'roll') {
      throw new Error(`当前处于决定阶段（${pendingLabel(state)}），不能掷骰`)
    }
    if (type !== 'roll') {
      if (state.phase !== 'decide') {
        throw new Error('请先掷骰，再决定购买/加盖/跳过')
      }
      if (type === 'buy' && state.pending !== 'buy') {
        throw new Error('当前没有可购买的地产（购买决定只在停留无人地产时可用）')
      }
      if (type === 'build' && state.pending !== 'build') {
        throw new Error('当前没有可加盖的地产（加盖决定只在停留自有地产时可用）')
      }
    }
    // 决定窗防御性复查（正常路径由 settleLanding 保证，这里是状态被手改的兜底）。
    if (type === 'buy') {
      const tile = BOARD[state.pos[role]]!
      if (tile.kind !== 'property' || state.owner[state.pos[role]] !== null) {
        throw new Error('当前格没有可购买的地产')
      }
      if (state.cash[role] < tile.price!) {
        throw new Error(`现金不足，无法购买「${tile.name}」（需 ${tile.price} 元）`)
      }
    }
    if (type === 'build') {
      const index = state.pos[role]
      const tile = BOARD[index]!
      if (tile.kind !== 'property' || state.owner[index] !== role) {
        throw new Error('当前格没有可加盖的地产')
      }
      if (state.level[index]! >= MAX_LEVEL) {
        throw new Error(`「${tile.name}」已是最高等级（${MAX_LEVEL} 级），不能加盖`)
      }
      if (state.cash[role] < buildCostOf(index)) {
        throw new Error(`现金不足，无法为「${tile.name}」加盖（需 ${buildCostOf(index)} 元）`)
      }
    }

    const next = cloneState(state)
    const events: string[] = []

    if (type === 'roll') {
      if (next.jailed[role]) {
        next.jailed[role] = false
        events.push(`${sideName(role)}在派出所滞留，暂停一次行动`)
        endTurn(next, events)
      } else {
        const die = diceAt(next.seed, next.rolls)
        next.rolls += 1
        next.lastRoll = die
        const from = next.pos[role]
        const target = from + die
        const landing = target % BOARD.length
        next.pos[role] = landing
        events.push(`${sideName(role)}掷出 ${die} 点：从「${BOARD[from]!.name}」到「${BOARD[landing]!.name}」`)
        if (target >= BOARD.length) {
          next.cash[role] += START_SALARY
          events.push(`经过起点，领取薪水 ${START_SALARY} 元`)
        }
        settleLanding(next, role, events, true)
        if (!next.finished && next.phase !== 'decide') endTurn(next, events)
      }
    } else if (type === 'buy') {
      const index = next.pos[role]
      const tile = BOARD[index]!
      next.cash[role] -= tile.price!
      next.owner[index] = role
      next.level[index] = 1
      events.push(`${sideName(role)}买下「${tile.name}」（${tile.price} 元），现金剩余 ${next.cash[role]} 元`)
      endTurn(next, events)
    } else if (type === 'build') {
      const index = next.pos[role]
      const tile = BOARD[index]!
      const cost = buildCostOf(index)
      next.cash[role] -= cost
      next.level[index] = next.level[index]! + 1
      events.push(`${sideName(role)}为「${tile.name}」加盖到 ${next.level[index]} 级（花费 ${cost} 元），现金剩余 ${next.cash[role]} 元`)
      endTurn(next, events)
    } else {
      const tile = BOARD[next.pos[role]]!
      if (state.pending === 'buy') events.push(`${sideName(role)}放弃购买「${tile.name}」`)
      else if (state.pending === 'build') events.push(`${sideName(role)}放弃为「${tile.name}」加盖`)
      else events.push(`${sideName(role)}跳过`)
      endTurn(next, events)
    }

    return { state: next, events, finished: next.finished, winner: next.winner, summary: events.join('，') }
  },

  /** 人类可读的一手描述（Agent 在对话里角色化叙述用；落子前 state 取）。 */
  describe(state: MonopolyState, actor: string, action: unknown): string {
    const role: Role = actor === 'blue' ? 'blue' : 'red'
    const type = action !== null && typeof action === 'object' && !Array.isArray(action)
      ? (action as { type?: unknown }).type
      : undefined
    const index = state.pos[role]
    const tile = BOARD[index]!
    if (type === 'roll') return `${sideName(role)}掷骰子`
    if (type === 'buy') return `${sideName(role)}购买「${tile.name}」（${tile.price} 元）`
    if (type === 'build') return `${sideName(role)}为「${tile.name}」加盖（花费 ${buildCostOf(index)} 元）`
    if (type === 'pass') {
      if (state.pending === 'buy') return `${sideName(role)}放弃购买「${tile.name}」`
      if (state.pending === 'build') return `${sideName(role)}放弃加盖`
      return `${sideName(role)}跳过`
    }
    return `${sideName(role)}的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
/** 棋盘表（spec 防漂移对账用：视图内联地名的唯一事实来源）。 */
export const tiles: readonly Tile[] = BOARD
/** 机会卡表（spec 对账用：视图文案与 testids 的唯一事实来源）。 */
export const chanceCards: readonly ChanceCard[] = CHANCE_CARDS
export { engine as monopolyEngine }

/**
 * 内联视图（§3.3）：自包含 HTML，桥协议两条消息，token 从 location.search 读。
 * body 的 data-game 属性是 ASCII 标记（gates 用它证明内置大富翁随 bundle 分发）。
 * 7×7 外圈棋盘（24 格）+ 中央面板：双方资金/地产/位置、最近骰点、行动叙述；
 * 购买/加盖/跳过按钮随 view.legal 收缩；终局以盘面之下的 in-flow 结果条呈现
 * （终局盘面完整保留、零叠压——沿 21点 2026-10-14 截图驱动修订的既定语义）。
 */
export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大富翁 · dsh-tavern 游戏桥</title>
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
    width: 100%; max-width: 620px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    padding: 4px 2px 8px;
  }
  .game-name { font-size: 16px; font-weight: 600; letter-spacing: 1px; }
  .meta {
    font-size: 12px; color: #9a948a; font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #banner {
    width: 100%; max-width: 620px;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; text-align: center;
    margin-bottom: 10px; border: 1px solid #3a3f4a; background: #22262e;
    transition: background .2s;
  }
  #banner.turn-red    { background: #2a1618; border-color: #6b3f3f; }
  #banner.turn-blue   { background: #141f2e; border-color: #3f5a6b; }
  #banner.finished    { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  #banner.preview     { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  .board {
    position: relative; width: 100%; max-width: 620px; aspect-ratio: 1 / 1;
    display: grid; grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat(7, 1fr);
    gap: 4px;
  }
  .tile {
    position: relative; border-radius: 7px; overflow: hidden;
    background: #1a2029; border: 1px solid #2e3844;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 2px 3px; min-width: 0; min-height: 0;
  }
  .tile .t-name { font-size: 10px; font-weight: 600; line-height: 1.15; text-align: center; word-break: break-all; }
  .tile .t-sub { font-size: 9px; color: #97a3b3; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .tile.property { background: #1d2733; border-color: #33465b; }
  .tile.chance   { background: #2e2811; border-color: #6b5e2f; }
  .tile.tax      { background: #2b1a1a; border-color: #6b3f3f; }
  .tile.jail     { background: #1a2233; border-color: #3f5374; }
  .tile.park     { background: #17251c; border-color: #3f6b52; }
  .tile.bonus    { background: #2b2410; border-color: #8a6d2f; }
  .tile.start    { background: #211d33; border-color: #5a4f8a; }
  .tile.owner-red  { border-color: #c2564b; box-shadow: inset 0 0 0 1px rgba(194, 86, 75, .55); }
  .tile.owner-blue { border-color: #4b86c2; box-shadow: inset 0 0 0 1px rgba(75, 134, 194, .55); }
  .tile.current { outline: 2px solid rgba(255, 215, 106, .6); outline-offset: -1px; }
  .tile .t-level { font-size: 9px; color: #ffd76a; line-height: 1.2; min-height: 11px; }
  .tile .t-owner { font-size: 9px; line-height: 1.2; min-height: 11px; }
  .tile .t-owner.red { color: #ef9a8f; }
  .tile .t-owner.blue { color: #9ac1ef; }
  .tile .t-tokens { position: absolute; top: 3px; right: 3px; display: flex; gap: 3px; }
  .token { width: 9px; height: 9px; border-radius: 50%; border: 1px solid rgba(255,255,255,.55); }
  .token.red  { background: #c2564b; }
  .token.blue { background: #4b86c2; }
  .center {
    grid-area: 2 / 2 / 7 / 7;
    border-radius: 10px; background: #161b22; border: 1px solid #2e3844;
    display: flex; flex-direction: column; gap: 8px; padding: 10px;
    min-width: 0; min-height: 0;
  }
  .players { display: flex; gap: 8px; }
  .pcard {
    flex: 1; min-width: 0; border-radius: 8px; padding: 7px 9px;
    background: #1c2129; border: 1px solid #2e3844;
  }
  .pcard.red  { border-color: #5c3a38; }
  .pcard.blue { border-color: #38505c; }
  .pcard.active.red  { box-shadow: inset 0 0 0 1px rgba(194, 86, 75, .6); }
  .pcard.active.blue { box-shadow: inset 0 0 0 1px rgba(75, 134, 194, .6); }
  .pcard-head { display: flex; align-items: baseline; gap: 6px; }
  .pname { font-size: 13px; font-weight: 600; }
  .owner-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 400; }
  .owner-tag.human { background: #1d4d33; color: #b8ecc9; }
  .owner-tag.agent { background: #27364e; color: #b9c8e6; }
  .pcash { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .pinfo { font-size: 10px; color: #97a3b3; margin-top: 2px; line-height: 1.4; }
  .dice-row { display: flex; align-items: center; gap: 8px; }
  .dice {
    font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums;
    background: #22262e; border: 1px solid #3a3f4a; border-radius: 7px; padding: 3px 10px;
  }
  .log {
    flex: 1; min-height: 0; overflow: hidden;
    font-size: 11.5px; color: #cdc3a6; line-height: 1.6; word-break: break-word;
  }
  .actions { width: 100%; max-width: 620px; display: flex; gap: 8px; margin-top: 12px; }
  .actions button {
    flex: 1; padding: 11px 0; font-size: 14px; font-weight: 600; letter-spacing: 2px;
    border-radius: 9px; border: 1px solid #caa84f; background: #27476b; color: #f2ead4;
    cursor: pointer; transition: background .15s, opacity .15s;
  }
  .actions button:hover:not(:disabled) { background: #30598a; }
  .actions button:disabled { opacity: .45; cursor: not-allowed; background: #22312a; border-color: #3d4f44; color: #a9b3a5; }
  .result-strip {
    width: 100%; max-width: 620px; margin-top: 12px;
    border-radius: 10px; padding: 12px 16px;
    background: #101812; border: 1px solid rgba(202, 168, 79, .5);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
  }
  .result-strip.hidden { display: none; }
  .result-strip .result { font-size: 24px; font-weight: 700; color: #f5e7bd; letter-spacing: 3px; }
  .result-strip .sub { font-size: 13px; color: #cdc3a6; text-align: center; line-height: 1.7; }
  footer {
    width: 100%; max-width: 620px; margin-top: 10px;
    font-size: 12px; color: #8d887e; text-align: center; line-height: 1.6;
  }
  /* 窄屏（移动端 390 档）收敛：格子 min-content 供不起 10px/9px 字号时，
     grid 行会被内容顶开、棋盘失去正方形（2026-10-15 headless 真机量测：
     390×844 下 board 370×452、格高 61px > 格宽 49px）——字号/行高同步收紧，
     配合 .tile 的 min-height:0 保证棋盘恒为正圆环。 */
  @media (max-width: 480px) {
    .tile { padding: 1px 2px; }
    .tile .t-name { font-size: 9px; line-height: 1.05; }
    .tile .t-sub, .tile .t-level, .tile .t-owner { font-size: 8px; line-height: 1.05; min-height: 9px; }
    .pcash { font-size: 14px; }
    .pinfo { font-size: 9px; }
    .actions button { letter-spacing: 1px; font-size: 13px; padding: 10px 0; }
  }
</style>
</head>
<body data-game="dsh-tavern.monopoly">
<header>
  <span class="game-name">大富翁</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" class="preview">等待对局…</div>
<div class="board" id="board">
  <div class="center" id="center">
    <div class="players">
      <div class="pcard red" id="card-red">
        <div class="pcard-head"><span class="pname">红方</span><span class="owner-tag" id="red-owner"></span></div>
        <div class="pcash" id="red-cash"></div>
        <div class="pinfo" id="red-info"></div>
      </div>
      <div class="pcard blue" id="card-blue">
        <div class="pcard-head"><span class="pname">蓝方</span><span class="owner-tag" id="blue-owner"></span></div>
        <div class="pcash" id="blue-cash"></div>
        <div class="pinfo" id="blue-info"></div>
      </div>
    </div>
    <div class="dice-row"><span class="dice" id="dice">骰点 —</span></div>
    <div class="log" id="log"></div>
  </div>
</div>
<div class="result-strip hidden" id="result-strip">
  <div class="result" id="strip-result"></div>
  <div class="sub" id="strip-sub">对局结束</div>
</div>
<div class="actions">
  <button type="button" id="roll-btn" disabled>掷骰</button>
  <button type="button" id="buy-btn" disabled>购买</button>
  <button type="button" id="build-btn" disabled>加盖</button>
  <button type="button" id="pass-btn" disabled>跳过</button>
</div>
<footer id="hint"></footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-tavern:game-state（token 对账、全量重渲染）、
   上行 dsh-tavern:game-action（合法性由服务端引擎终审）。token 从 location.search
   自读；无 token（浏览器直接打开）渲染静态预览局面（引擎 createGame({seed:1})
   的开局态，spec 与引擎逐字段对账防漂移）。坐席纪律：一切「谁是谁」的表述按
   session.players 的 owner 反查落笔，不把缺省坐席写死；四颗按钮随 view.legal
   收缩——掷骰只在掷骰阶段亮、购买/加盖只在对应决定窗亮、跳过只在决定窗亮。 */

var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var current = null /* 最近一条 game-state：{ state, legal, finished, summary, session } */

var bannerEl = document.getElementById('banner')
var metaEl = document.getElementById('meta')
var boardEl = document.getElementById('board')
var logEl = document.getElementById('log')
var diceEl = document.getElementById('dice')
var stripEl = document.getElementById('result-strip')
var stripResultEl = document.getElementById('strip-result')
var stripSubEl = document.getElementById('strip-sub')
var hintEl = document.getElementById('hint')
var rollBtn = document.getElementById('roll-btn')
var buyBtn = document.getElementById('buy-btn')
var buildBtn = document.getElementById('build-btn')
var passBtn = document.getElementById('pass-btn')
var ownerEls = { red: document.getElementById('red-owner'), blue: document.getElementById('blue-owner') }
var cashEls = { red: document.getElementById('red-cash'), blue: document.getElementById('blue-cash') }
var infoEls = { red: document.getElementById('red-info'), blue: document.getElementById('blue-info') }
var cardEls = { red: document.getElementById('card-red'), blue: document.getElementById('card-blue') }

/* 棋盘表（与引擎 BOARD 同源：spec 用引擎导出的 tiles 逐名对账防漂移）。 */
var TILES = [
  { kind: 'start', name: '起点', sub: '经过 +200' },
  { kind: 'property', name: '鼓浪屿', sub: '100' },
  { kind: 'chance', name: '机会', sub: '抽卡' },
  { kind: 'property', name: '宽窄巷子', sub: '150' },
  { kind: 'tax', name: '税务稽查', sub: '-150' },
  { kind: 'property', name: '平遥古城', sub: '200' },
  { kind: 'jail', name: '派出所', sub: '暂停一次' },
  { kind: 'property', name: '丽江古城', sub: '250' },
  { kind: 'chance', name: '机会', sub: '抽卡' },
  { kind: 'property', name: '西湖', sub: '300' },
  { kind: 'park', name: '免费停车', sub: '无事发生' },
  { kind: 'property', name: '张家界', sub: '350' },
  { kind: 'bonus', name: '年度分红', sub: '+200' },
  { kind: 'property', name: '黄山', sub: '400' },
  { kind: 'chance', name: '机会', sub: '抽卡' },
  { kind: 'property', name: '泰山', sub: '450' },
  { kind: 'tax', name: '市政规费', sub: '-200' },
  { kind: 'property', name: '故宫', sub: '500' },
  { kind: 'chance', name: '机会', sub: '抽卡' },
  { kind: 'property', name: '外滩', sub: '550' },
  { kind: 'property', name: '洱海', sub: '600' },
  { kind: 'property', name: '九寨沟', sub: '650' },
  { kind: 'property', name: '兵马俑', sub: '700' },
  { kind: 'property', name: '长城', sub: '750' }
]

/* 7×7 外圈坐标（下标 → [row, col]，0 基；顺时针，0 在上左角）：
   0..6 上排向右、7..11 右列向下、12..18 下排向左、19..23 左列向上。 */
function ringPos(index) {
  if (index <= 6) return [0, index]
  if (index <= 11) return [index - 6, 6]
  if (index <= 18) return [6, 6 - (index - 12)]
  return [6 - (index - 18), 0]
}

var tileEls = []
function buildBoard() {
  for (var i = 0; i < TILES.length; i++) {
    var t = TILES[i]
    var el = document.createElement('div')
    el.className = 'tile ' + t.kind
    el.setAttribute('id', 'tile-' + i)
    el.setAttribute('data-index', String(i))
    var pos = ringPos(i)
    el.style.gridRow = String(pos[0] + 1)
    el.style.gridColumn = String(pos[1] + 1)
    var name = document.createElement('div'); name.className = 't-name'; name.textContent = t.name
    var sub = document.createElement('div'); sub.className = 't-sub'; sub.textContent = t.sub
    var level = document.createElement('div'); level.className = 't-level'
    var owner = document.createElement('div'); owner.className = 't-owner'
    var tokens = document.createElement('div'); tokens.className = 't-tokens'
    el.appendChild(name); el.appendChild(sub); el.appendChild(level); el.appendChild(owner); el.appendChild(tokens)
    boardEl.appendChild(el)
    tileEls.push(el)
  }
}

/* 无 token 的静态预览局面 = 引擎 createGame({seed:1}) 的开局态（spec 对账）。 */
var PREVIEW_STATE = {
  turn: 'red', phase: 'roll', pending: null,
  seed: 1, rolls: 0,
  deck: [4, 7, 2, 0, 11, 5, 1, 9, 10, 3, 8, 6],
  deckIndex: 0,
  cash: { red: 1500, blue: 1500 },
  pos: { red: 0, blue: 0 },
  owner: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  level: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  jailed: { red: false, blue: false },
  turns: { red: 0, blue: 0 },
  lastRoll: null,
  finished: false, winner: null, ending: null
}
var PREVIEW_SESSION = {
  id: '',
  gameId: 'dsh-tavern.monopoly',
  players: [
    { role: 'red', owner: 'human' },
    { role: 'blue', owner: 'agent' }
  ]
}

window.addEventListener('message', function (event) {
  var data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type !== 'dsh-tavern:game-state' || data.token !== TOKEN) return
  var view = data.view && typeof data.view === 'object' ? data.view : {}
  current = {
    state: view.state || null,
    legal: Array.isArray(view.legal) ? view.legal : [],
    finished: view.finished === true,
    summary: typeof view.summary === 'string' ? view.summary : '',
    session: data.session && typeof data.session === 'object' ? data.session : null
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

function sideName(role) { return role === 'red' ? '红方' : '蓝方' }

function endText(state, session) {
  if (state.winner !== 'red' && state.winner !== 'blue') return '平局'
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

function countOwned(state, role) {
  var count = 0
  for (var i = 0; i < state.owner.length; i++) if (state.owner[i] === role) count++
  return count
}

function setOwnerTag(role, owner) {
  var el = ownerEls[role]
  if (owner === 'human') { el.textContent = '你'; el.className = 'owner-tag human' }
  else if (owner === 'agent') { el.textContent = 'AI'; el.className = 'owner-tag agent' }
  else { el.textContent = ''; el.className = 'owner-tag' }
}

function renderPlayer(act, role) {
  var state = act.state
  if (!state) {
    cashEls[role].textContent = ''
    infoEls[role].textContent = ''
    cardEls[role].className = 'pcard ' + role
    return
  }
  cashEls[role].textContent = state.cash[role] + ' 元'
  var info = '地产 ' + countOwned(state, role) + ' 处 · 位置：' + TILES[state.pos[role]].name
  info += ' · 回合 ' + state.turns[role]
  if (state.jailed[role]) info += ' · 派出所滞留'
  infoEls[role].textContent = info
  var cls = 'pcard ' + role
  if (!state.finished && state.turn === role) cls += ' active'
  cardEls[role].className = cls
}

function renderBoard(state) {
  for (var i = 0; i < tileEls.length; i++) {
    var el = tileEls[i]
    var t = TILES[i]
    var cls = 'tile ' + t.kind
    var ownerText = ''
    var levelText = ''
    var tokens = el.children[4]
    while (tokens.firstChild) tokens.removeChild(tokens.firstChild)
    if (state) {
      var owner = state.owner[i]
      var level = state.level[i]
      if (owner === 'red' || owner === 'blue') {
        cls += ' owner-' + owner
        ownerText = sideName(owner)
        el.children[3].className = 't-owner ' + owner
      } else {
        el.children[3].className = 't-owner'
      }
      if (t.kind === 'property' && level > 0) levelText = '★'.repeat(level) + ' ' + level + ' 级'
      if (!state.finished && state.pos[state.turn] === i) cls += ' current'
      for (var r = 0; r < 2; r++) {
        var role = r === 0 ? 'red' : 'blue'
        if (state.pos[role] === i) {
          var dot = document.createElement('span')
          dot.className = 'token ' + role
          tokens.appendChild(dot)
        }
      }
      /* 归属格副文案改为租金（观感上比地价更有用）。 */
      var subText = t.sub
      if (t.kind === 'property' && owner) {
        var factors = [0, 0.3, 0.7, 1.4]
        if (level > 0) subText = '租 ' + Math.round(Number(t.sub) * factors[level])
      }
      el.children[1].textContent = subText
    } else {
      el.children[3].className = 't-owner'
      el.children[1].textContent = t.sub
    }
    el.children[2].textContent = levelText
    el.children[3].textContent = ownerText
    el.className = cls
  }
}

function render() {
  var act = active()
  var state = act.state
  var live = current !== null || TOKEN !== null

  setOwnerTag('red', act.session ? ownerOf(act.session, 'red') : null)
  setOwnerTag('blue', act.session ? ownerOf(act.session, 'blue') : null)
  renderBoard(state)
  renderPlayer(act, 'red')
  renderPlayer(act, 'blue')

  if (!live) metaEl.textContent = '预览模式'
  else if (!state) metaEl.textContent = '等待会话…'
  else metaEl.textContent = (act.session && act.session.id ? '对局 ' + act.session.id : '对局中') + ' · 回合 红 ' + state.turns.red + ' / 蓝 ' + state.turns.blue
  diceEl.textContent = state && state.lastRoll !== null ? '骰点 ' + state.lastRoll : '骰点 —'
  logEl.textContent = act.summary || (live ? '' : '预览模式：由 dsh-tavern 游戏服务装载后启用交互。')

  var cls = 'preview'
  var text = '预览模式：由 dsh-tavern 游戏服务装载后启用交互'
  if (live) {
    if (!state) {
      text = '等待对局状态…'
    } else if (state.finished) {
      cls = 'finished'
      text = act.summary ? '对局结束 · ' + act.summary : '对局结束：' + endText(state, act.session)
    } else {
      cls = state.turn === 'red' ? 'turn-red' : 'turn-blue'
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
  /* 按钮随 legal 收缩：掷骰只亮在掷骰阶段；购买/加盖/跳过只亮在对应决定窗；
     legal 空（无会话/引擎回落）时维持旧行为——按钮仍可点，由服务端终审。 */
  var constrain = act.legal.length > 0
  var allows = { roll: false, buy: false, build: false, pass: false }
  for (var i = 0; i < act.legal.length; i++) {
    var entry = act.legal[i]
    if (entry && (entry.type === 'roll' || entry.type === 'buy' || entry.type === 'build' || entry.type === 'pass')) allows[entry.type] = true
  }
  rollBtn.disabled = !(canAct && (!constrain || allows.roll))
  buyBtn.disabled = !(canAct && (!constrain || allows.buy))
  buildBtn.disabled = !(canAct && (!constrain || allows.build))
  passBtn.disabled = !(canAct && (!constrain || allows.pass))

  if (!live) {
    hintEl.textContent = '这是静态演示局面（开局）：由 dsh-tavern 游戏服务装载后，棋盘将接收实时状态并启用掷骰/购买/加盖/跳过按钮。'
  } else if (!state) {
    hintEl.textContent = '正在连接 dsh-tavern 游戏服务…'
  } else if (state.finished) {
    hintEl.textContent = '对局已结束。可在对局面板中开新一局，或让 AI 再来一盘。'
  } else if (humanTurn(act)) {
    if (state.jailed[state.turn]) {
      hintEl.textContent = '轮到你行动：你在派出所滞留——本回合掷骰将暂停一次（空转），点「掷骰」确认。'
    } else if (state.phase === 'decide' && state.pending === 'buy') {
      hintEl.textContent = '轮到你行动：停留「' + TILES[state.pos[state.turn]].name + '」——可花费 ' + TILES[state.pos[state.turn]].sub + ' 元购买，或跳过（地租为地价的 30%/70%/140%，按等级）。'
    } else if (state.phase === 'decide' && state.pending === 'build') {
      hintEl.textContent = '轮到你行动：停留自有地产「' + TILES[state.pos[state.turn]].name + '」——可加盖一级（每级费用为地价一半），或跳过。'
    } else {
      hintEl.textContent = '轮到你行动：点「掷骰」前进（经过或停留起点领 200 元薪水；停留无人地产可购买）。'
    }
  } else {
    hintEl.textContent = sideName(state.turn) + '（AI）行动中，动作将自动出现在棋盘上。'
  }
}

/* 上行 dsh-tavern:game-action：人类回合（未终局、owner 非 agent）才发。
   合法性由服务端引擎终审——按钮只提供 roll/buy/build/pass 四个固定动作。 */
function send(action) {
  if (!TOKEN) return
  var act = active()
  if (!act.state || act.state.finished || !humanTurn(act)) return
  window.parent.postMessage(
    { type: 'dsh-tavern:game-action', token: TOKEN, action: action },
    '*'
  )
}
rollBtn.addEventListener('click', function () { send({ type: 'roll' }) })
buyBtn.addEventListener('click', function () { send({ type: 'buy' }) })
buildBtn.addEventListener('click', function () { send({ type: 'build' }) })
passBtn.addEventListener('click', function () { send({ type: 'pass' }) })

buildBoard()
render()
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const monopoly = { manifest, engine, viewHtml } as const
