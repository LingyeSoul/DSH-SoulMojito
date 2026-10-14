/**
 * 内置 21 点（dsh-tavern.blackjack，v2：玩家对 AI 庄家）——引擎契约与规则面测试。
 *
 * 【蓝军声明】本套件由独立于实现者的测试角色按 v2 契约重写（v1 双人对赌形态已随
 * 改版作废，全部行为断言重写）：所有断言严格落在契约面上，不发明契约外断言；点数
 * 一律用本文件自带的独立计算函数对账（不复用被测代码）。契约与实现的分歧如实上报，
 * 不为跑绿迁就实现。
 *
 * 契约面（v2）：
 * - 清单：id 'dsh-tavern.blackjack'、name '21点'、version '1.0.0'、
 *   players {min:2,max:2,roles:['player','dealer']}、turnBased、engines 缺席；
 * - state（JSON-safe、顶层 turn）：{ turn:'player'|'dealer', seed, dealt,
 *   hands{player,dealer}, totals{player,dealer}, finished, winner }，
 *   Card={r:'A'..|'K', s:'♠♥♦♣'}；对局期庄家 1 张明牌，亮暗牌后 ≥2；
 * - 点数：A 记 1 或 11 取不爆最大，J/Q/K=10；
 * - createGame(options)：读 options.seed（缺省 crypto 随机）；玩家 2 张 + 庄家
 *   1 张明牌、dealt=3；玩家恰好 21 → turn='dealer'（发牌自动停牌、无事件面），
 *   否则 turn='player'；同 seed 两次 deep-equal；
 * - 玩家回合：hit 摸牌（恰 21 → 自动停牌 + 亮暗牌；>21 → 爆牌即结算
 *   winner='dealer'、亮暗牌且庄家不补牌；<21 → turn 不变）；stand → 事件
 *   玩家停牌（N 点）+ turn='dealer' + 亮暗牌；
 * - 庄家家规：totals.dealer<17 必须补（建议集恰 [hit]）、≥17 必须停（恰 [stand]）；
 *   补爆 → winner='player' 结算；停 → 比点数三态（高者胜、同点 winner=null）；
 * - describe：玩家要牌/停牌（当前 N 点）、庄家补牌/停牌（当前 N 点）、未识别回落；
 * - 确定性：同 state+action 两次 apply deep-equal、不改入参；整局重放 deep-equal；
 *   源码禁 Math.random / Date.now（seed 缺省走 node:crypto）。
 *
 * 测试位置构造说明（蓝军主武器）：洗牌算法不可镜像，一切牌局相关断言只锁
 * 「任意牌都成立」的不变式——手工局面（craft state）把手牌/seed/dealt/turn 直接
 * 写死，让关键分支对给定 seed 确定：安全 hit 用 2+3=5 点低手（任意牌后 ≤16 不换
 * 手）；软 21（A+K）摸任意牌不爆（A 降 1 重估）；爆牌/补到 17-21/补爆等分支用
 * 探针取证的固定 seed（注释标明取证结论），不镜像洗牌；一切结算只锁
 * 「finished ⇒ 庄家 ≥2 张」与文案模板/点数对账。
 *
 * 视图锚点裁定（2026-10-14）：契约原文「视图含 庄家亮出暗牌」经复核收窄——该文案
 * 是引擎事件/运行时 summary 载荷（视图经 game-state 下行拿 summary 渲染），静止
 * viewHtml 源码不含它是正确实现。运行时该文案的锁定归本文件引擎侧用例（stand/
 * 爆牌/21 自动停牌的 events/summary 子串断言）；视图侧只锁静态锚点：data-game、
 * 桥消息、result-strip 结果条、庄家/玩家 zone 标签、无覆盖层。
 *
 * 视图坐席归属（2026-10-14 用户坐庄回归）：静态锚点锁不住文案分支——「庄家（AI）
 * 按规则补牌中」在用户坐庄（Agent 执 player）时把 AI 说成庄家，即用户实况
 * 「庄家和玩家的显示反了（结算后显示时 AI 坐庄）」。本文件自带最小 DOM 垫片把
 * viewHtml 内联脚本真跑一遍，用真实下行载荷按 owner 断言提示/按钮/结果条。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { blackjackEngine, manifest, viewHtml } from '../src/games/builtin/blackjack.js'
import { openGamesService } from '../src/games/service.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, jsonSizeOf, smokeTestGameEngine } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Role = 'player' | 'dealer'
type Suit = '♠' | '♥' | '♦' | '♣'
type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'

interface Card {
  r: Rank
  s: Suit
}

interface BlackjackState {
  turn: Role
  seed: number
  dealt: number
  hands: { player: Card[]; dealer: Card[] }
  totals: { player: number; dealer: number }
  finished: boolean
  winner: Role | null
}

interface BlackjackApplyResult {
  state: BlackjackState
  events: string[]
  finished: boolean
  winner: Role | null
  summary: string
}

interface BlackjackAction {
  type: 'hit' | 'stand'
}

/** 引擎形状（以被测 v2 契约为准的本地视图，刻意不复用实现类型）。 */
interface BlackjackEngineShape {
  createGame(options?: unknown): { state: BlackjackState }
  legalActions(state: BlackjackState): BlackjackAction[]
  applyAction(state: BlackjackState, action: unknown, actor: string): BlackjackApplyResult
  describe(state: BlackjackState, actor: string, action: unknown): string
}

const engine = blackjackEngine as unknown as BlackjackEngineShape

const home = mkdtempSync(join(tmpdir(), 'games-blackjack-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const ENGINE_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'games', 'builtin', 'blackjack.ts'), 'utf8')

const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const SUITS: readonly Suit[] = ['♠', '♥', '♦', '♣']

/** '♥8' → {r:'8', s:'♥'}（'♦10' 同理：前 1 位花色、其余点数）。 */
function card(code: string): Card {
  return { s: code.slice(0, 1) as Suit, r: code.slice(1) as Rank }
}

/** 独立于引擎的点数计算（蓝军对账）：A 记 1 或 11 取不爆最大，J/Q/K=10。 */
function handTotal(hand: Card[]): number {
  let total = 0
  let aces = 0
  for (const c of hand) {
    if (c.r === 'A') {
      total += 1
      aces += 1
    } else if (c.r === 'J' || c.r === 'Q' || c.r === 'K') {
      total += 10
    } else {
      total += Number(c.r)
    }
  }
  while (aces > 0 && total + 10 <= 21) {
    total += 10
    aces -= 1
  }
  return total
}

/** 手工局面：手牌/seed/turn 直接写死（totals 用独立点数函数重算填充；
 *  dealt 取明面张数之和——发牌游标的自洽锚点，不镜像洗牌）。 */
function stateOf(partial: {
  turn: Role
  player: string[]
  dealer: string[]
  seed?: number
  dealt?: number
}): BlackjackState {
  const player = partial.player.map(card)
  const dealer = partial.dealer.map(card)
  return {
    turn: partial.turn,
    seed: partial.seed ?? 4242,
    dealt: partial.dealt ?? player.length + dealer.length,
    hands: { player, dealer },
    totals: { player: handTotal(player), dealer: handTotal(dealer) },
    finished: false,
    winner: null,
  }
}

const apply = (state: BlackjackState, action: unknown, actor?: string): BlackjackApplyResult =>
  engine.applyAction(state, action, actor ?? state.turn)

/** 契约亮暗牌事件模板：以结果态（庄家第 2 张 = 亮出的暗牌）对账，不镜像洗牌。 */
function revealEventOf(next: BlackjackState): string {
  const hole = next.hands.dealer[1]!
  return `庄家亮出暗牌：${hole.s}${hole.r}（合计 ${next.totals.dealer} 点）`
}

/** 断言抛 Error 且文案含中文（契约：非法动作抛错而非静默，中文报错）。 */
function expectChineseThrow(fn: () => unknown, pattern?: RegExp): void {
  try {
    fn()
  } catch (cause) {
    expect(cause).toBeInstanceOf(Error)
    const message = (cause as Error).message
    expect(message).toMatch(/[\u4e00-\u9fff]/)
    if (pattern !== undefined) expect(message).toMatch(pattern)
    return
  }
  throw new Error('期望抛出中文 Error，但调用静默返回了')
}

/** 任意 createGame 产出的初始局面不变式（蓝军独立对账，与实现无关）。 */
function expectFreshDeal(s: BlackjackState): void {
  expect(s.hands.player, '玩家初始 2 张').toHaveLength(2)
  expect(s.hands.dealer, '庄家对局期 1 张明牌').toHaveLength(1)
  for (const c of [...s.hands.player, ...s.hands.dealer]) {
    expect(RANKS, `牌面 ${c.r}`).toContain(c.r)
    expect(SUITS, `花色 ${c.s}`).toContain(c.s)
  }
  expect(s.totals, 'totals 双方独立重算对账').toEqual({
    player: handTotal(s.hands.player),
    dealer: handTotal(s.hands.dealer),
  })
  expect(s.dealt, '明面 3 张已发出').toBe(3)
  expect(s.finished).toBe(false)
  expect(s.winner).toBeNull()
  expect(Number.isInteger(s.seed), 'seed 是整数').toBe(true)
  expect(['player', 'dealer']).toContain(s.turn)
  if (s.turn === 'dealer') {
    // 契约开局分支：玩家恰好 21 → 发牌自动停牌、回合交给庄家。
    // 除此之外不存在自动换手的理由——非 21 却 turn='dealer' 一律算违契。
    expect(s.totals.player, '自动停牌只可能因玩家 21 点').toBe(21)
  }
  expect(JSON.parse(JSON.stringify(s)), '初始态 JSON-safe').toEqual(s)
}

/** 终局共同不变式（蓝军独立对账）：finished ⇒ 庄家 ≥2 张、totals 重算对账。 */
function expectTerminalInvariants(next: BlackjackState): void {
  expect(next.finished).toBe(true)
  expect(next.hands.dealer.length, 'finished ⇒ 亮暗牌已完成（庄家 ≥2 张）').toBeGreaterThanOrEqual(2)
  expect(next.totals.player, '玩家 totals 独立重算对账').toBe(handTotal(next.hands.player))
  expect(next.totals.dealer, '庄家 totals 独立重算对账').toBe(handTotal(next.hands.dealer))
  expect(['player', 'dealer', null]).toContain(next.winner)
  expect(JSON.parse(JSON.stringify(next)), '终局态 JSON-safe').toEqual(next)
}

/** 整局重放（确定性用例）：seed 驱动——玩家 <17 要牌否则停牌，庄家按 legalActions
 *  循环打到终局；guard=50 防死循环（一手至多一张牌，正常对局远小于）。 */
function playOut(seed: number): BlackjackState {
  let state = engine.createGame({ seed }).state
  let guard = 0
  while (!state.finished && guard < 50) {
    guard += 1
    let action: BlackjackAction
    if (state.turn === 'player') {
      action = state.totals.player < 17 ? { type: 'hit' } : { type: 'stand' }
    } else {
      const suggestions = engine.legalActions(state)
      expect(suggestions.length, '庄家回合建议集恰一动作（补或停）').toBe(1)
      action = suggestions[0] as BlackjackAction
    }
    state = apply(state, action).state
  }
  expect(state.finished, 'guard 50 内必须终局').toBe(true)
  return state
}

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 player/dealer、engines 缺席', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-tavern.blackjack')
    expect(manifest.name).toBe('21点')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['player', 'dealer'] })
    expect(manifest.turnBased).toBe(true)
    expect(manifest.engines).toBeUndefined()
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(blackjackEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型与 data-game 标记', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-tavern:game-state')
    expect(viewHtml).toContain('dsh-tavern:game-action')
    expect(viewHtml).toContain('data-game="dsh-tavern.blackjack"')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(viewHtml)
    expect(document).toContain('data-game="dsh-tavern.blackjack"')
    expect(document).toContain('dshTavernGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-tavern:game-action')
  })

  it('终局呈结果条：含 result-strip/描边/底色锚点，含玩家与庄家 zone 标签，不含旧覆盖层', () => {
    // 截图驱动修订（2026-10-14）：终局覆盖层废弃，改为盘面之下的 in-flow 结果条。
    expect(viewHtml).toContain('result-strip')
    expect(viewHtml).toContain('rgba(202, 168, 79, .5)')
    expect(viewHtml).toContain('#101812')
    expect(viewHtml).not.toContain('class="overlay')
    expect(viewHtml, '庄家明牌标签').toContain('明牌')
    expect(viewHtml, '玩家 zone 标签').toContain('<span class="zone-name">玩家')
    expect(viewHtml, '庄家 zone 标签').toContain('<span class="zone-name">庄家')
  })

  it('引擎源码不含 Math.random / Date.now（确定性硬约束，seed 缺省走 node:crypto）', () => {
    expect(ENGINE_SOURCE).not.toContain('Math.random')
    expect(ENGINE_SOURCE).not.toContain('Date.now')
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(blackjackEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

/* -------------------------------------------------------------- 视图行为垫片 ---
 * 2026-10-14 用户坐庄回归（g-9136e61b 实况）：视图提示层曾硬编码默认坐席——
 * 「庄家（AI）按规则补牌中」在用户坐庄（Agent 执 player）时把 AI 说成庄家、
 * 「停牌交给庄家」把坐庄的人类当成对手，即用户实况「庄家和玩家的显示反了
 * （结算后显示时 AI 坐庄）」。viewHtml 是内联字符串，静态锚点锁不住文案分支
 * ——这里用最小 DOM 垫片把内联脚本真跑一遍，用真实下行载荷按 owner 断言。
 * 垫片只实现视图用到的面（getElementById/createElement/children/className/
 * textContent/setAttribute/addEventListener），零依赖、零浏览器。 */

class FakeElement {
  children: FakeElement[] = []
  className = ''
  textContent = ''
  disabled = false
  readonly attrs: Record<string, string> = {}
  readonly listeners = new Map<string, Array<() => void>>()
  constructor(readonly tagName: string) {}
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }
  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
    // 真实 DOM 的 setAttribute('class') 同步 className（renderTable 走 setAttribute）。
    if (name === 'class') this.className = value
  }
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
}

const VIEW_ELEMENT_IDS = [
  'banner', 'meta', 'result-strip', 'strip-result', 'strip-sub', 'hint',
  'hit-btn', 'stand-btn',
  'dealer-zone', 'player-zone', 'dealer-cards', 'player-cards',
  'dealer-score', 'player-score', 'dealer-owner', 'player-owner',
] as const

interface ViewHarness {
  el(id: string): FakeElement
  dispatch(payload: unknown): void
}

/** 打开视图脚本（search 带 token 即实时面，不带即预览面）。 */
function openBlackjackView(search: string): ViewHarness {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(viewHtml)
  expect(script, 'viewHtml 含内联脚本').not.toBeNull()
  const registry = new Map<string, FakeElement>(
    VIEW_ELEMENT_IDS.map((id): [string, FakeElement] => [id, new FakeElement('div')]),
  )
  const listeners: Array<(event: { data: unknown }) => void> = []
  const documentShim = {
    getElementById: (id: string): FakeElement | null => registry.get(id) ?? null,
    createElement: (tagName: string): FakeElement => new FakeElement(tagName),
  }
  const windowShim = {
    location: { search },
    parent: { postMessage: (): void => {} },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void): void => {
      if (type === 'message') listeners.push(listener)
    },
  }
  const run = new Function('window', 'document', 'URLSearchParams', script![1]!) as (
    window: unknown, document: unknown, urlSearchParams: unknown,
  ) => void
  run(windowShim, documentShim, URLSearchParams)
  return {
    el: (id) => {
      const el = registry.get(id)
      if (el === undefined) throw new Error(`缺垫片元素 ${id}`)
      return el
    },
    dispatch: (payload) => {
      for (const listener of [...listeners]) listener({ data: payload })
    },
  }
}

/** 下行 dsh-tavern:game-state 载荷（token 与视图 URL 的 token 对账）。 */
function gameState(session: unknown, view: unknown): unknown {
  return { type: 'dsh-tavern:game-state', token: 't', session, view }
}

/** 会话快照（玩家表按 manifest roles 规范序：player 前、dealer 后）。 */
function sessionFixture(dealerOwner: 'human' | 'agent'): Record<string, unknown> {
  return {
    id: 'g-9136e61b',
    gameId: 'dsh-tavern.blackjack',
    gameName: '21点',
    players: [
      { role: 'player', owner: dealerOwner === 'human' ? 'agent' : 'human' },
      { role: 'dealer', owner: dealerOwner },
    ],
    finished: false,
    winner: null,
    summary: '',
  }
}

/** 视图载荷（GameViewPayload 形状：全量 state + legal + finished + summary）。 */
function viewFixture(params: {
  turn: 'player' | 'dealer'
  hands: { player: Card[]; dealer: Card[] }
  totals: { player: number; dealer: number }
  legal: BlackjackAction[]
  finished?: boolean
  winner?: Role | null
  summary?: string
}): Record<string, unknown> {
  const finished = params.finished === true
  return {
    state: {
      turn: params.turn,
      seed: 1,
      dealt: params.hands.player.length + params.hands.dealer.length,
      hands: params.hands,
      totals: params.totals,
      finished,
      winner: params.winner ?? null,
    },
    turn: params.turn,
    legal: params.legal,
    finished,
    summary: params.summary ?? '',
  }
}

describe('视图坐席归属（2026-10-14 用户坐庄回归）', () => {
  it('用户坐庄：AI（执 player）回合提示不称庄家，人类（坐庄）回合提示只讲家规，按钮随 legal 收缩', () => {
    const harness = openBlackjackView('?token=t')
    // AI 回合：Agent 执 player——提示必须说「玩家（AI）」，绝不出现「庄家（AI）」。
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({
      turn: 'player',
      hands: { player: [card('♦2'), card('♦4'), card('♥6')], dealer: [card('♠7')] },
      totals: { player: 20, dealer: 7 },
      legal: [{ type: 'hit' }, { type: 'stand' }],
      summary: '玩家要牌得 ♥6（当前 20 点）',
    })))
    expect(harness.el('dealer-owner').textContent, '庄家区 owner 反查 = 人类').toBe('你')
    expect(harness.el('dealer-owner').className).toBe('owner-tag human')
    expect(harness.el('player-owner').textContent, '玩家区 owner 反查 = Agent').toBe('AI')
    expect(harness.el('hint').textContent).toBe('玩家（AI）行动中，动作将自动出现在赌桌上。')
    expect(harness.el('hint').textContent).not.toContain('庄家（AI）')
    expect(harness.el('banner').textContent, '横幅按当前行动方角色 + owner').toContain('玩家 · AI 思考中')

    // 人类（坐庄）回合、庄家 16 点：家规只许补牌——停牌按钮必须禁用（旧实现两颗都可点）。
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♦2'), card('♦4'), card('♦7'), card('♥A'), card('♥6')], dealer: [card('♠7'), card('♥9')] },
      totals: { player: 20, dealer: 16 },
      legal: [{ type: 'hit' }],
      summary: '玩家停牌（20 点），庄家亮出暗牌：♥9（合计 16 点）',
    })))
    expect(harness.el('hint').textContent, '坐庄人类回合：只讲家规').toContain('你是庄家')
    expect(harness.el('hint').textContent, '坐庄人类回合不得出现「交给庄家」').not.toContain('交给庄家')
    expect(harness.el('hit-btn').disabled, '家规只许补牌').toBe(false)
    expect(harness.el('stand-btn').disabled, '家规只许补牌：停牌必须禁用').toBe(true)

    // 庄家 21 点：家规只许停牌——补牌按钮必须禁用。
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♦2'), card('♦4'), card('♦7'), card('♥A'), card('♥6')], dealer: [card('♠7'), card('♥9'), card('♣5')] },
      totals: { player: 20, dealer: 21 },
      legal: [{ type: 'stand' }],
      summary: '庄家补牌得 ♣5（当前 21 点）',
    })))
    expect(harness.el('hit-btn').disabled, '家规只许停牌：补牌必须禁用').toBe(true)
    expect(harness.el('stand-btn').disabled).toBe(false)

    // 终局（g-9136e61b 实况：庄家 21 胜玩家 20）：结果条按 owner 落章。
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♦2'), card('♦4'), card('♦7'), card('♥A'), card('♥6')], dealer: [card('♠7'), card('♥9'), card('♣5')] },
      totals: { player: 20, dealer: 21 },
      legal: [],
      finished: true,
      winner: 'dealer',
      summary: '庄家停牌（21 点），结算：玩家 20 点、庄家 21 点——庄家胜',
    })))
    expect(harness.el('strip-result').textContent, '坐庄人类胜：结果条附 owner').toBe('庄家胜（你）')
    expect(harness.el('result-strip').className).toBe('result-strip')
    expect(harness.el('hint').textContent).toContain('对局已结束')
  })

  it('默认面（人类执 player、AI 坐庄）：提示与教学文案维持不变，结果条落 AI 章，平局不落章', () => {
    const harness = openBlackjackView('?token=t')
    // AI（坐庄）回合：提示保持庄家语义（家规补牌）。
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♠K'), card('♥4')], dealer: [card('♣A'), card('♠9')] },
      totals: { player: 14, dealer: 20 },
      legal: [{ type: 'stand' }],
      summary: '玩家停牌（14 点），庄家亮出暗牌：♠9（合计 20 点）',
    })))
    expect(harness.el('hint').textContent).toBe('庄家（AI）按家规补牌中，动作将自动出现在赌桌上。')
    expect(harness.el('dealer-owner').textContent).toBe('AI')
    expect(harness.el('player-owner').textContent).toBe('你')

    // 人类（player）回合：教学文案原样，两颗按钮都可点（legal 全集）。
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      turn: 'player',
      hands: { player: [card('♠K'), card('♥4')], dealer: [card('♣A')] },
      totals: { player: 14, dealer: 11 },
      legal: [{ type: 'hit' }, { type: 'stand' }],
      summary: '玩家要牌得 ♥4（当前 14 点）',
    })))
    expect(harness.el('hint').textContent).toContain('交给庄家')
    expect(harness.el('hit-btn').disabled).toBe(false)
    expect(harness.el('stand-btn').disabled).toBe(false)

    // 终局：庄家爆牌 → 玩家（人类）胜；结果条落「你」。
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♠K'), card('♥4')], dealer: [card('♣A'), card('♠9'), card('♦9')] },
      totals: { player: 14, dealer: 28 },
      legal: [],
      finished: true,
      winner: 'player',
      summary: '庄家爆牌（28 点）——玩家胜',
    })))
    expect(harness.el('strip-result').textContent).toBe('玩家胜（你）')

    // 平局：结果条不落 owner 章。
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      turn: 'dealer',
      hands: { player: [card('♦2'), card('♥A'), card('♥2'), card('♥4')], dealer: [card('♣K'), card('♥3'), card('♣Q')] },
      totals: { player: 19, dealer: 23 },
      legal: [],
      finished: true,
      winner: null,
      summary: '结算：玩家 19 点、庄家 19 点——平局',
    })))
    expect(harness.el('strip-result').textContent).toBe('平局')
  })

  it('静态锚点：旧文案「庄家（AI）按规则补牌中」不再存在，owner 分支与 legal 收缩在源码可见', () => {
    expect(viewHtml).not.toContain('庄家（AI）按规则补牌中')
    expect(viewHtml).toContain('ownerOf(act.session, \'player\') === \'human\'')
    expect(viewHtml).toContain('你是庄家')
    expect(viewHtml).toContain('玩家（AI）行动中')
    expect(viewHtml).toContain('act.legal.length > 0')
  })
})

describe('createGame 开局（§3.2）', () => {
  it('固定 seed 开局：形状/玩家 2 张 + 庄家 1 明牌/dealt=3/totals 独立重算对账', () => {
    // 探针取证（2026-10-14）：seed 1 命中「玩家未 21」分支（totals.player=19）。
    const { state } = engine.createGame({ seed: 1 })
    expectFreshDeal(state)
    expect(state.turn, '非 21 开局轮到玩家').toBe('player')
    expect(currentRoleOf(state, manifest.players.roles)).toBe(state.turn)
    expect(engine.legalActions(state)).toEqual([{ type: 'hit' }, { type: 'stand' }])
  })

  it('玩家初始 21 分支：seed 23 命中 turn=dealer + totals.player=21 + 建议集非空', () => {
    // 契约既定取证种子：seed 23 时玩家 10+A=21 → 发牌自动停牌，回合交给庄家。
    const { state } = engine.createGame({ seed: 23 })
    expectFreshDeal(state)
    expect(state.turn).toBe('dealer')
    expect(state.totals.player).toBe(21)
    expect(state.hands.player).toHaveLength(2)
    expect(state.hands.dealer).toHaveLength(1)
    expect(state.dealt).toBe(3)
    expect(state.finished, '自动停牌不等于终局').toBe(false)
    const legal = engine.legalActions(state)
    expect(legal.length, '轮到庄家，建议集非空（不得空转）').toBeGreaterThanOrEqual(1)
    for (const action of legal) expect(typeof action.type).toBe('string')
  })

  it('初始态 JSON-safe：JSON.parse(JSON.stringify) 往返 deep-equal', () => {
    const { state } = engine.createGame({ seed: 11 })
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('同 seed 两次 createGame deep-equal（确定性从发牌就开始）', () => {
    expect(engine.createGame({ seed: 123 }).state).toEqual(engine.createGame({ seed: 123 }).state)
  })

  it('缺省 seed（crypto 随机）：无 options 与空对象两路都出合法开局', () => {
    expectFreshDeal(engine.createGame().state)
    expectFreshDeal(engine.createGame({}).state)
  })

  it('seed 扫描 1..40：每个开局都满足初始不变式（含玩家 21 自动停牌分支的钉死）', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      expectFreshDeal(engine.createGame({ seed }).state)
    }
  })
})

describe('玩家回合（hit / stand 语义，手工局面）', () => {
  it('安全 hit：2+3=5 点低手摸任意牌后 ≤16——张数+1、totals 重算对账、turn 不变', () => {
    // 5 点 + 任意牌（最大 A=11）≤16：必不爆、必不自动停牌、必不换手。
    const state = stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'], seed: 7 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(result.finished).toBe(false)
    expect(result.winner).toBeNull()
    expect(next.hands.player).toHaveLength(3)
    expect(next.hands.dealer, '庄家未亮牌前恒 1 张明牌').toHaveLength(1)
    expect(next.turn, '安全 hit 不换手').toBe('player')
    expect(next.totals.player, '摸后 totals 独立重算对账').toBe(handTotal(next.hands.player))
    expect(next.totals.player).toBeLessThanOrEqual(16)
    expect(next.totals.dealer).toBe(handTotal(next.hands.dealer))
    expect(RANKS).toContain(next.hands.player[2]!.r)
    expect(SUITS).toContain(next.hands.player[2]!.s)
    // 事件面沿用「（当前 N 点）」点数模板（seed 7 摸 ♠J → 15 点）。
    expect(result.events.join('\n')).toContain('玩家要牌得')
    expect(result.events.join('\n')).toContain('（当前 15 点）')
  })

  it('hit 到恰好 21：自动停牌 + turn=dealer + 亮暗牌，不结算', () => {
    // 探针取证：seed 8 时 20 点（10+Q）摸 ♣A → 恰 21，庄家亮暗牌 ♦8（18 点）。
    const state = stateOf({ turn: 'player', player: ['♠10', '♥Q'], dealer: ['♠K'], seed: 8 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(next.totals.player).toBe(21)
    expect(next.totals.player).toBe(handTotal(next.hands.player))
    expect(next.hands.player).toHaveLength(3)
    const text = result.events.join('\n')
    expect(text).toContain('玩家已到 21 点，自动停牌')
    expect(text, '恰 21 也亮暗牌（事件与结果态对账）').toContain(revealEventOf(next))
    expect(next.hands.dealer, '亮暗牌后庄家 2 张').toHaveLength(2)
    expect(next.turn, '自动停牌换手到庄家').toBe('dealer')
    expect(result.finished).toBe(false)
    expect(next.finished).toBe(false)
    expect(result.winner).toBeNull()
    expect(engine.legalActions(next), '庄家 18 ≥17 → 只能停').toEqual([{ type: 'stand' }])
  })

  it('软 21 边界：A+K 摸任意牌不爆（A 降 1 重估）——恰 21 自动停牌，否则留在玩家回合', () => {
    // A+K=21（软）：摸 10 值牌 → 1+10+10=21 仍是 21（自动停牌而非爆牌）；
    // 摸小牌 → A 降 1 后 <21，留在玩家回合。两支都钉死（seed 3 命中前者、
    // seed 1 命中后者，均已探针取证）。
    for (const [seed, expectTurn] of [[3, 'dealer'], [1, 'player']] as const) {
      const state = stateOf({ turn: 'player', player: ['♠A', '♥K'], dealer: ['♠9'], seed })
      const result = apply(state, { type: 'hit' })
      const next = result.state
      expect(next.totals.player, `seed=${seed} 软 21 摸牌后不爆`).toBeLessThanOrEqual(21)
      expect(next.totals.player, `seed=${seed} 独立重算对账`).toBe(handTotal(next.hands.player))
      expect(next.turn, `seed=${seed} 分支换手`).toBe(expectTurn)
      if (next.totals.player === 21) {
        expect(result.events.join('\n'), 'A 降值后仍 21 → 自动停牌').toContain('玩家已到 21 点，自动停牌')
        expect(next.hands.dealer).toHaveLength(2)
      } else {
        expect(result.events.join('\n'), '未到 21 留在玩家回合').not.toContain('自动停牌')
        expect(next.hands.dealer).toHaveLength(1)
      }
      expect(result.finished).toBe(false)
      expect(result.winner).toBeNull()
    }
  })

  it('爆牌即结算：玩家 >21 → 亮暗牌 + 庄家不补牌 + winner=dealer + 结算句', () => {
    // 探针取证：seed 1 时 20 点（10+Q）摸 ♣6 → 26 爆；庄家亮暗牌 ♦5（15 点）后不补牌。
    const state = stateOf({ turn: 'player', player: ['♠10', '♥Q'], dealer: ['♠K'], seed: 1 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(next.totals.player, '独立点数函数证 >21').toBeGreaterThan(21)
    expect(next.totals.player).toBe(26)
    expect(next.totals.player).toBe(handTotal(next.hands.player))
    const text = result.events.join('\n')
    expect(text).toContain(`玩家爆牌（${next.totals.player} 点）`)
    expect(text, '爆牌即结算文案').toContain(`结算：玩家爆牌（${next.totals.player} 点）——庄家胜`)
    expect(text, '爆牌也亮暗牌').toContain(revealEventOf(next))
    expect(next.hands.dealer, '玩家爆牌后庄家只亮暗牌、不补牌').toHaveLength(2)
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('dealer')
    expect(next.winner).toBe('dealer')
    expectTerminalInvariants(next)
  })

  it('stand：事件 玩家停牌（N 点）+ turn=dealer + 亮暗牌（庄家恰 2 张、手牌不动）', () => {
    // 探针取证：seed 7 时庄家暗牌 ♠J（K+J=20），停牌换手后合法面转 [stand]。
    const state = stateOf({ turn: 'player', player: ['♠10', '♥8'], dealer: ['♠K'], seed: 7 })
    const result = apply(state, { type: 'stand' })
    const next = result.state
    const text = result.events.join('\n')
    expect(text).toContain('玩家停牌（18 点）')
    expect(text, '亮暗牌事件与结果态对账').toContain(revealEventOf(next))
    expect(revealEventOf(next), '取证锚点：seed 7 亮 ♠J（合计 20 点）').toBe('庄家亮出暗牌：♠J（合计 20 点）')
    expect(next.hands.dealer, '亮暗牌后恰 2 张').toHaveLength(2)
    expect(next.hands.player, '停牌不动手牌').toEqual(state.hands.player)
    expect(next.turn).toBe('dealer')
    expect(next.totals.dealer).toBe(handTotal(next.hands.dealer))
    expect(result.finished, '庄家未停牌，不结算').toBe(false)
    expect(result.winner).toBeNull()
    expect(result.summary).toContain('玩家停牌（18 点）')
  })
})

describe('庄家回合（家规：<17 必补、≥17 必停）', () => {
  it('补牌不换手：11 点补 ♦J 到 21——张数+1、事件模板、turn 不变、建议集转 [stand]', () => {
    // 探针取证：seed 2 时庄家 5+6=11 补 ♦J → 21（≥17 仍未自动停，等 stand）。
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠5', '♥6'], seed: 2 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(next.hands.dealer).toHaveLength(3)
    expect(next.totals.dealer).toBe(21)
    expect(next.totals.dealer).toBe(handTotal(next.hands.dealer))
    expect(result.events.join('\n'), '补牌事件模板').toContain('庄家补牌得 ♦J（当前 21 点）')
    expect(next.turn, '补到 21 仍留在庄家回合（等待停牌）').toBe('dealer')
    expect(result.finished).toBe(false)
    expect(result.winner).toBeNull()
    expect(engine.legalActions(next), '21 ≥17 转 [stand]').toEqual([{ type: 'stand' }])
  })

  it('补到 17 仍停留：K+6=16 补 ♦A 到 17（软 17）——turn 不变、建议集转 [stand]', () => {
    // 探针取证：seed 5 时庄家 K+6=16 补 ♦A → 17。
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠K', '♥6'], seed: 5 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(next.totals.dealer).toBe(17)
    expect(next.totals.dealer).toBe(handTotal(next.hands.dealer))
    expect(result.events.join('\n')).toContain('庄家补牌得 ♦A（当前 17 点）')
    expect(next.turn).toBe('dealer')
    expect(result.finished).toBe(false)
    expect(engine.legalActions(next), '17 ≥17 转 [stand]').toEqual([{ type: 'stand' }])
  })

  it('补爆即结算：庄家 >21 → winner=player + 终局（玩家点数不动）', () => {
    // 探针取证：seed 2 时庄家 K+6=16 补 ♦J → 26 爆。
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠K', '♥6'], seed: 2 })
    const result = apply(state, { type: 'hit' })
    const next = result.state
    expect(next.totals.dealer, '独立点数函数证 >21').toBeGreaterThan(21)
    expect(next.totals.dealer).toBe(26)
    expect(next.totals.dealer).toBe(handTotal(next.hands.dealer))
    const text = result.events.join('\n')
    expect(text).toContain('庄家补牌得 ♦J（当前 26 点）')
    expect(text).toContain('庄家爆牌（26 点）')
    expect(text).toContain('结算：庄家爆牌（26 点）——玩家胜')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('player')
    expect(next.winner).toBe('player')
    expect(next.hands.player, '庄家回合不动玩家手牌').toEqual(state.hands.player)
    expectTerminalInvariants(next)
  })

  it('stand 三态之一 庄家高：玩家 18、庄家 19 → winner=dealer + 结算句', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥8'], dealer: ['♠10', '♦9'] })
    const result = apply(state, { type: 'stand' })
    const next = result.state
    const text = result.events.join('\n')
    expect(text).toContain('庄家停牌（19 点）')
    expect(text, '结算句模板').toContain('结算：玩家 18 点、庄家 19 点——庄家胜')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('dealer')
    expect(next.winner).toBe('dealer')
    expect(engine.legalActions(next)).toEqual([])
    expectTerminalInvariants(next)
  })

  it('stand 三态之二 玩家高：玩家 20、庄家 18 → winner=player + 结算句', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠K', '♥Q'], dealer: ['♠10', '♦8'] })
    const result = apply(state, { type: 'stand' })
    const next = result.state
    expect(result.events.join('\n')).toContain('结算：玩家 20 点、庄家 18 点——玩家胜')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('player')
    expect(next.winner).toBe('player')
    expectTerminalInvariants(next)
  })

  it('stand 三态之三 同点：双方 18 → winner=null + 平局句', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠K', '♥8'], dealer: ['♠9', '♦9'] })
    const result = apply(state, { type: 'stand' })
    const next = result.state
    expect(result.events.join('\n')).toContain('结算：玩家 18 点、庄家 18 点——平局')
    expect(result.finished).toBe(true)
    expect(result.winner).toBeNull()
    expect(next.winner).toBeNull()
    expect(engine.legalActions(next)).toEqual([])
    expectTerminalInvariants(next)
  })
})

describe('家规边界（<17 必补、≥17 必停，违者中文抛错）', () => {
  it('庄家 ≥17 时 hit 被拒：抛错文案含 17', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠10', '♦9'] })
    expectChineseThrow(() => engine.applyAction(state, { type: 'hit' }, 'dealer'), /17/)
  })

  it('庄家 <17 时 stand 被拒：抛错文案含 17', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠5', '♥6'] })
    expectChineseThrow(() => engine.applyAction(state, { type: 'stand' }, 'dealer'), /17/)
  })
})

describe('非法动作全家族（中文抛错）', () => {
  const fresh = (): BlackjackState => stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'] })

  it('动作形状：非对象 / 缺 type / 未知 type / resign 保留动作', () => {
    expectChineseThrow(() => apply(fresh(), null))
    expectChineseThrow(() => apply(fresh(), 42))
    expectChineseThrow(() => apply(fresh(), 'hit'))
    expectChineseThrow(() => apply(fresh(), [{ type: 'hit' }]))
    expectChineseThrow(() => apply(fresh(), {}))
    expectChineseThrow(() => apply(fresh(), { type: 'double' }))
    // resign 是保留动作（运行时统一处理），引擎必须拒绝而非静默。
    expectChineseThrow(() => apply(fresh(), { type: 'resign' }))
  })

  it('角色：未知角色 / 非本方回合（两个方向）', () => {
    const playerTurn = fresh()
    expectChineseThrow(() => engine.applyAction(playerTurn, { type: 'hit' }, 'purple'))
    expectChineseThrow(() => engine.applyAction(playerTurn, { type: 'hit' }, 'dealer'))
    const dealerTurn = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠7', '♥5'] })
    expectChineseThrow(() => engine.applyAction(dealerTurn, { type: 'hit' }, 'player'))
  })

  it('终局后：结算态再 hit / stand 一律拒绝', () => {
    const settled = apply(stateOf({ turn: 'dealer', player: ['♠10', '♥8'], dealer: ['♠10', '♦9'] }), { type: 'stand' }).state
    expect(settled.finished).toBe(true)
    expectChineseThrow(() => engine.applyAction(settled, { type: 'hit' }, 'player'))
    expectChineseThrow(() => engine.applyAction(settled, { type: 'stand' }, 'player'))
  })
})

describe('legalActions 建议集四态（§3.2）', () => {
  it('玩家回合：恰好 [{hit},{stand}]，两次调用 deep-equal', () => {
    const state = stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'] })
    const first = engine.legalActions(state)
    expect(first).toEqual([{ type: 'hit' }, { type: 'stand' }])
    expect(engine.legalActions(state)).toEqual(first)
  })

  it('庄家回合 <17：恰好 [{hit}]（家规只许补牌）', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠7', '♥5'] })
    expect(engine.legalActions(state)).toEqual([{ type: 'hit' }])
  })

  it('庄家回合 ≥17：恰好 [{stand}]（家规只许停牌）', () => {
    const state = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠10', '♦9'] })
    expect(engine.legalActions(state)).toEqual([{ type: 'stand' }])
  })

  it('终局：空数组', () => {
    const settled = playOut(31)
    expectTerminalInvariants(settled)
    expect(engine.legalActions(settled)).toEqual([])
  })
})

describe('describe 叙述（§3.2）', () => {
  it('玩家两动作：玩家要牌（当前 14 点）/ 玩家停牌（当前 14 点）', () => {
    const state = stateOf({ turn: 'player', player: ['♠10', '♥4'], dealer: ['♠K'] })
    expect(engine.describe(state, 'player', { type: 'hit' })).toBe('玩家要牌（当前 14 点）')
    expect(engine.describe(state, 'player', { type: 'stand' })).toBe('玩家停牌（当前 14 点）')
  })

  it('庄家两动作：庄家补牌（当前 12 点）/ 庄家停牌（当前 19 点）', () => {
    const twelve = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠7', '♥5'] })
    expect(engine.describe(twelve, 'dealer', { type: 'hit' })).toBe('庄家补牌（当前 12 点）')
    const nineteen = stateOf({ turn: 'dealer', player: ['♠10', '♥9'], dealer: ['♠10', '♥9'] })
    expect(engine.describe(nineteen, 'dealer', { type: 'stand' })).toBe('庄家停牌（当前 19 点）')
  })

  it('未识别动作回落：resign / 未知 type / 缺 type 均含「未被本引擎识别」', () => {
    const state = stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'] })
    expect(engine.describe(state, 'player', { type: 'resign' })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'player', { type: 'double' })).toContain('未被本引擎识别')
    expect(engine.describe(state, 'player', {})).toContain('未被本引擎识别')
  })
})

describe('确定性（§3.2 硬约束）', () => {
  it('同 state 同 action 两次 apply deep-equal，入参快照不变（seed 在 state 内是唯一随机锚）', () => {
    const hitState = stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'], seed: 7 })
    const hitSnapshot = structuredClone(hitState)
    const hitFirst = apply(hitState, { type: 'hit' })
    const hitSecond = apply(hitState, { type: 'hit' })
    expect(hitFirst).toEqual(hitSecond)
    expect(hitState).toEqual(hitSnapshot)

    const standState = stateOf({ turn: 'player', player: ['♠10', '♥8'], dealer: ['♠K'], seed: 7 })
    const standSnapshot = structuredClone(standState)
    const standFirst = apply(standState, { type: 'stand' })
    const standSecond = apply(standState, { type: 'stand' })
    expect(standFirst).toEqual(standSecond)
    expect(standState).toEqual(standSnapshot)
  })

  it('整局重放两次 deep-equal：同 seed 打完整局到终局（guard 50），终局不变式成立', () => {
    const firstRun = playOut(999)
    expect(firstRun.finished).toBe(true)
    expectTerminalInvariants(firstRun)
    expect(playOut(999)).toEqual(firstRun)
    // 多种子终局不变式扫描（同策略同 seed → 同终局，重放链稳定）。
    for (const seed of [1, 7, 23, 2026]) {
      const settled = playOut(seed)
      expectTerminalInvariants(settled)
      expect(playOut(seed)).toEqual(settled)
    }
  })
})

describe('状态尺寸（§3.2：序列化 <64KB）', () => {
  it('对局中与终局态各一：jsonSizeOf 远小于 65536', () => {
    const mid = apply(stateOf({ turn: 'player', player: ['♠2', '♥3'], dealer: ['♠K'], seed: 7 }), { type: 'hit' }).state
    expect(jsonSizeOf(mid)).toBeLessThan(65536)
    const settled = playOut(2026)
    expectTerminalInvariants(settled)
    expect(jsonSizeOf(settled)).toBeLessThan(65536)
  })
})

describe('端到端会话（真实 GamesService，开箱可玩面）', () => {
  it('开局 → 人类停牌 → Agent 按家规补/停到结算：视图/叙述/终审全链路', async () => {
    const service = await openGamesService({ root: join(home, 'tavern'), hostVersion: '0.6.4' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-tavern.blackjack', character: 'ExampleCard', chatId: 'bj-chat' })
      expect(session.gameId).toBe('dsh-tavern.blackjack')
      expect(session.players).toEqual([
        { role: 'player', owner: 'human' },
        { role: 'dealer', owner: 'agent' },
      ])
      expect(view.finished).toBe(false)
      const opening = view.state as BlackjackState
      expect(opening.hands.player, '玩家 2 张').toHaveLength(2)
      expect(opening.hands.dealer, '庄家 1 张明牌').toHaveLength(1)
      expect(opening.dealt).toBe(3)
      expect(opening.totals.player).toBe(handTotal(opening.hands.player))

      let current = view
      if (view.turn === 'player') {
        expect(view.legal).toEqual([{ type: 'hit' }, { type: 'stand' }])
        // 人类停牌（HTTP 面路径）→ describe 即叙述文案（落子前局面）。
        const human = await service.humanAction(session.id, { type: 'stand' })
        expect(human.describe).toBe(`玩家停牌（当前 ${opening.totals.player} 点）`)
        expect(human.view.turn, '停牌换手到庄家').toBe('dealer')
        current = human.view
      } else {
        // createGame 无 options → crypto 随机 seed：玩家发牌即 21 自动停牌是合法分支
        // （引擎面由 seed 23 钉死），端到端按随机发牌自适应。
        expect(opening.totals.player).toBe(21)
      }

      // 人类回合外再动作被运行时的回合/owner 规则把守。
      if (!current.finished) {
        await expect(service.humanAction(session.id, { type: 'hit' })).rejects.toThrow('请等待 AI 落子')
      }

      // Agent 按庄家 legalActions（家规恰一动作：<17 补、≥17 停）循环到终局。
      let guard = 0
      while (!current.finished && guard < 50) {
        guard += 1
        expect(current.turn, '庄家回合').toBe('dealer')
        expect(current.legal, '庄家建议集恰一动作（补或停）').toHaveLength(1)
        const move = await service.agentMove(session.id, current.legal[0]!)
        expect(move.describe).toMatch(/^庄家(补牌|停牌)（当前 \d+ 点）$/)
        current = move.view
      }
      expect(current.finished, 'guard 50 内必须终局').toBe(true)
      expect(current.legal, '终局建议集为空').toEqual([])

      const settled = current.state as BlackjackState
      expectTerminalInvariants(settled)
      expect(settled.hands.player, '端到端人类只停牌不补牌').toHaveLength(2)
      expect(settled.totals.dealer > 21 || settled.totals.dealer >= 17, '家规：庄家 ≥17 或爆').toBe(true)
      expect(current.summary).toContain('结算：')
      if (current.summary.includes('——庄家胜')) expect(settled.winner).toBe('dealer')
      else if (current.summary.includes('——玩家胜')) expect(settled.winner).toBe('player')
      else expect(settled.winner).toBeNull()
    } finally {
      service.dispose()
    }
  })
})
