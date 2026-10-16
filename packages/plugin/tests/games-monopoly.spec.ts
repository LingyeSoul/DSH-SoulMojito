/**
 * 内置大富翁（dsh-soulmojito.monopoly，双人环线经营）——引擎契约与规则面测试。
 *
 * 【蓝军声明】本套件断言严格落在契约面上，不发明契约外断言；租金/净值等
 * 派生数值一律用本文件自带的独立计算函数对账（不复用被测代码）。骰子与洗牌
 * 算法不可镜像——一切牌局相关断言只锁「任意骰点/牌序都成立」的不变式，或
 * 用**探针取证的固定 seed**（本文件开头用「观察值」用例钉死 seed 7 的骰子流
 * 与 seed 1 的牌序，其余用例据此构造受控局面），不镜像 PRNG 实现。
 *
 * 契约面（v1）：
 * - 清单：id 'dsh-soulmojito.monopoly'、name '大富翁'、version '1.0.0'、
 *   players {min:2,max:2,roles:['red','blue']}、turnBased、engines 缺席；
 * - 棋盘：24 格环线——起点 1、地产 14（地价升序）、机会 4、税局 2、派出所 1、
 *   免费停车 1、年度分红 1；
 * - state（JSON-safe、顶层 turn）：{ turn, phase:'roll'|'decide',
 *   pending:'buy'|'build'|null, seed, rolls, deck, deckIndex,
 *   cash{red,blue}, pos{red,blue}, owner:(Role|null)[], level:number[],
 *   jailed, turns, lastRoll, finished, winner, ending }；
 * - 资金：起步 1500；经过或停留起点 +200（机会移动不发薪水）；税局 -150/-200、
 *   分红 +200；破产 = 任何应付不足（剩余现金归对手、对手胜）；
 * - 地产：买价=地价；加盖每级=地价一半、最高 3 级；租金=地价×等级系数
 *   （1/2/3 级 = 30%/70%/140%）；
 * - 机会卡 12 张（现金/转账/移动/前往起点/进派出所）；移动卡落地照常结算但
 *   不再连锁抽卡；牌堆尾循环；
 * - 派出所：停留或卡片送入 → 下一回合掷骰空转（暂停一次行动）；
 * - 终局：破产即终局；每人 16 回合双满按净值（现金+地价+已付加盖费）比高，
 *   相同为平局（ending 'bankruptcy'/'valuation'）；
 * - 确定性：除 createGame 缺省 seed（crypto）外全文禁 Math.random/Date.now；
 * - describe：掷骰/购买/为「X」加盖/放弃购买「X」/放弃加盖/跳过/未识别回落；
 * - 视图：自包含、桥两条消息、data-game、无覆盖层、24 格动态棋盘、四按钮随
 *   view.legal 收缩、预览局面 = 引擎 createGame({seed:1}) 开局态（逐字段对账）。
 *
 * 视图行为面：viewHtml 是内联字符串，静态锚点锁不住按钮/文案分支——本文件自带
 * 最小 DOM 垫片（零依赖）把内联脚本真跑一遍，用真实下行载荷断言按钮启用态、
 * 棋盘归属渲染、终局结果条与坐席 owner 反查（对照 21点坐席归属决策的同款纪律）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chanceCards, manifest, monopolyEngine, tiles, viewHtml } from '../src/games/builtin/monopoly.js'
import { openGamesService } from '../src/games/service.js'
import { GameRegistry } from '../src/games/registry.js'
import { checkGameEngine, checkGameManifest, currentRoleOf, jsonSizeOf, smokeTestGameEngine } from '../src/games/standard.js'
import { renderGameViewDocument } from '../src/games/view.js'

type Role = 'red' | 'blue'

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

interface MonopolyApplyResult {
  state: MonopolyState
  events: string[]
  finished: boolean
  winner: Role | null
  summary: string
}

interface MonopolyAction {
  type: 'roll' | 'buy' | 'build' | 'pass'
}

/** 引擎形状（以被测契约为准的本地视图，刻意不复用实现类型）。 */
interface MonopolyEngineShape {
  createGame(options?: unknown): { state: MonopolyState }
  legalActions(state: MonopolyState): MonopolyAction[]
  applyAction(state: MonopolyState, action: unknown, actor: string): MonopolyApplyResult
  describe(state: MonopolyState, actor: string, action: unknown): string
}

const engine = monopolyEngine as unknown as MonopolyEngineShape

const home = mkdtempSync(join(tmpdir(), 'games-monopoly-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const ENGINE_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'games', 'builtin', 'monopoly.ts'), 'utf8')

/* ------------------------------- 独立对账面 ------------------------------- */

/** 独立于引擎的租金计算（蓝军对账）：价 × 等级系数（1/2/3 级 = 30%/70%/140%）。 */
function rentFor(price: number, level: number): number {
  const factors = [0, 0.3, 0.7, 1.4]
  return Math.round(price * factors[level]!)
}

/** 独立于引擎的净值计算（蓝军对账）：现金 + Σ（地价 + 已付加盖费）。 */
function openWorth(state: MonopolyState, role: Role): number {
  let total = state.cash[role]
  for (let index = 0; index < state.owner.length; index += 1) {
    if (state.owner[index] !== role) continue
    total += tiles[index]!.price! + (state.level[index]! - 1) * Math.round(tiles[index]!.price! * 0.5)
  }
  return total
}

const apply = (state: MonopolyState, action: unknown, actor?: string): MonopolyApplyResult =>
  engine.applyAction(state, action, actor ?? state.turn)

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

/** 手工局面：以固定 seed 造合法状态，再覆盖局部字段（不改入参测试面）。 */
function craft(partial: Partial<MonopolyState> = {}): MonopolyState {
  const base = engine.createGame({ seed: 4242 }).state
  return { ...base, ...partial }
}

/**
 * 观察值探针（不镜像 PRNG）：seed 7 的骰子流从第 0 掷起 = 1,4,4,5,1,5
 * （由「探针」用例钉死）。其余受控用例用「骰点 1」（rolls=0）或「骰点 5」
 * （rolls=3）把红方从指定格掷到目标格：pos = 目标 - 骰点（不跨起点）。
 */
const PROBE_SEED = 7
const PROBE_DICE = [1, 4, 4, 5, 1, 5] as const

/** 观测第 index 掷（0 基）：局面铺满蓝方 1 级地产 + 高现金，落点无决定窗。 */
function observedRoll(index: number): number {
  const state = craft({
    seed: PROBE_SEED,
    rolls: index,
    pos: { red: 0, blue: 0 },
    cash: { red: 9000, blue: 9000 },
    owner: tiles.map(() => 'blue' as Role),
    level: tiles.map(() => 1),
  })
  const match = /掷出 (\d) 点/.exec(apply(state, { type: 'roll' }).summary)
  if (match === null) throw new Error('未观测到骰点')
  return Number(match[1])
}

/** 红方从起点掷「骰点 1」（seed 7 / rolls 0）落到 index（需 index ≥ 1，不跨起点）。 */
function redLands(index: number, extra: Partial<MonopolyState> = {}): MonopolyState {
  return craft({ seed: PROBE_SEED, rolls: 0, pos: { red: index - 1, blue: 0 }, ...extra })
}

/** 机会格受控落点：红方落到 index（须是机会格），牌序由 extra.deck 指定。 */
function redDrawsChance(chanceIndex: number, deck: number[], extra: Partial<MonopolyState> = {}): MonopolyState {
  return redLands(chanceIndex, { deck: [...deck, ...Array.from({ length: 12 - deck.length }, (_v, i) => (deck.length + i) % 12)], deckIndex: 0, ...extra })
}

/** 整局重放（确定性用例）：买得起就买、可盖就盖、其余跳过；guard 防死循环。 */
function playOut(seed: number): MonopolyState {
  let state = engine.createGame({ seed }).state
  let guard = 0
  while (!state.finished && guard < 2000) {
    guard += 1
    const legal = engine.legalActions(state)
    expect(legal.length, '任何局面建议集不为空（guard 内必终局）').toBeGreaterThan(0)
    const role = state.turn
    let action: MonopolyAction = legal[0]!
    if (state.phase === 'decide') {
      const index = state.pos[role]
      const affordable = state.pending === 'buy'
        ? state.cash[role] >= (tiles[index]!.price ?? 0)
        : state.cash[role] >= Math.round((tiles[index]!.price ?? 0) * 0.5)
      action = affordable ? (state.pending === 'buy' ? { type: 'buy' } : { type: 'build' }) : { type: 'pass' }
    }
    state = apply(state, action, role).state
  }
  expect(state.finished, 'guard 2000 内必须终局').toBe(true)
  return state
}

/* --------------------------------- 契约面 --------------------------------- */

describe('清单与引擎形状（§3.1/§3.2）', () => {
  it('manifest 通过清单校验：id 反域名、双角色 red/blue、engines 缺席', () => {
    const check = checkGameManifest(manifest)
    expect(check.ok).toBe(true)
    expect(check.errors).toEqual([])
    expect(manifest.id).toBe('dsh-soulmojito.monopoly')
    expect(manifest.name).toBe('大富翁')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    expect(manifest.turnBased).toBe(true)
    expect(manifest.engines).toBeUndefined()
    expect(manifest.actionVocabulary).toContain('roll')
    expect(manifest.actionVocabulary).toContain('buy')
    expect(manifest.actionVocabulary).toContain('build')
    expect(manifest.actionVocabulary).toContain('pass')
  })

  it('引擎 duck 校验通过，meta 与 manifest 同源', () => {
    const check = checkGameEngine(monopolyEngine)
    expect(check.ok).toBe(true)
    expect(check.engine!.meta).toEqual(manifest)
  })

  it('viewHtml 自包含（无外链/无 fetch）且含桥消息类型、data-game 标记与四按钮', () => {
    expect(viewHtml).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(viewHtml).not.toMatch(/href\s*=\s*["']https?:/i)
    expect(viewHtml).not.toContain('fetch(')
    expect(viewHtml).toContain('dsh-soulmojito:game-state')
    expect(viewHtml).toContain('dsh-soulmojito:game-action')
    expect(viewHtml).toContain('data-game="dsh-soulmojito.monopoly"')
    expect(viewHtml).toContain('id="roll-btn"')
    expect(viewHtml).toContain('id="buy-btn"')
    expect(viewHtml).toContain('id="build-btn"')
    expect(viewHtml).toContain('id="pass-btn"')
    expect(viewHtml).toContain('>掷骰<')
    expect(viewHtml).toContain('>购买<')
    expect(viewHtml).toContain('>加盖<')
    expect(viewHtml).toContain('>跳过<')
  })

  it('视图过 view 服务管线（CSP + 桥脚本注入 + 文档包装）后原内容完整', () => {
    const document = renderGameViewDocument(viewHtml)
    expect(document).toContain('data-game="dsh-soulmojito.monopoly"')
    expect(document).toContain('dshSoulMojitoGame')
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain('dsh-soulmojito:game-action')
  })

  it('终局呈 in-flow 结果条（盘面保留、零叠压），含 7×7 环线棋盘与中央面板', () => {
    // 沿 21点 2026-10-14 截图驱动修订的既定语义：覆盖层压暗盘面被否决。
    expect(viewHtml).toContain('result-strip')
    expect(viewHtml).not.toContain('class="overlay')
    expect(viewHtml).toContain('grid-template-columns: repeat(7, 1fr)')
    expect(viewHtml).toContain('grid-template-rows: repeat(7, 1fr)')
    expect(viewHtml).toContain('id="board"')
    expect(viewHtml).toContain('id="center"')
    expect(viewHtml, '在派出所滞留提示存在（暂停一次行动的视图面）').toContain('派出所滞留')
  })

  it('引擎源码不含 Math.random / Date.now（确定性硬约束，seed 缺省走 node:crypto）', () => {
    expect(ENGINE_SOURCE).not.toContain('Math.random')
    expect(ENGINE_SOURCE).not.toContain('Date.now')
  })

  it('引擎过 smokeTestGameEngine 五关（标准面前人人平等）', () => {
    const result = smokeTestGameEngine(monopolyEngine)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('棋盘结构自检：24 格、14 地产（价升序）、4 机会、2 税局、1 派出所/停车/分红/起点', () => {
    expect(tiles).toHaveLength(24)
    const count = (kind: string): number => tiles.filter((tile) => tile.kind === kind).length
    expect(count('property')).toBe(14)
    expect(count('chance')).toBe(4)
    expect(count('tax')).toBe(2)
    expect(count('jail')).toBe(1)
    expect(count('park')).toBe(1)
    expect(count('bonus')).toBe(1)
    expect(count('start')).toBe(1)
    const prices = tiles.filter((tile) => tile.kind === 'property').map((tile) => tile.price!)
    expect(prices).toEqual([...prices].sort((left, right) => left - right))
    expect(prices[0]).toBe(100)
    expect(prices.at(-1)).toBe(750)
    // 派出所格下标是引擎内派生量的行为锚点（落格即拘留）。
    expect(tiles.findIndex((tile) => tile.kind === 'jail')).toBe(6)
  })

  it('机会卡表自检：12 张、含两类移动与三类特殊效果（结构稳定性）', () => {
    expect(chanceCards).toHaveLength(12)
    const kinds = chanceCards.map((card) => card.effect.kind)
    expect(kinds.filter((kind) => kind === 'move').length).toBeGreaterThanOrEqual(2)
    expect(kinds).toContain('goto-start')
    expect(kinds).toContain('jail')
    expect(kinds).toContain('transfer')
    expect(kinds.filter((kind) => kind === 'cash').length).toBeGreaterThanOrEqual(5)
  })

  it('窄屏（移动端）棋盘正方形保障：格子 min-height:0 + 480px 媒体查询在场', () => {
    // 2026-10-15 headless 真机量测回归：390×844 下 grid 行被格子 min-content
    // 顶开（board 370×452、格高 61 > 格宽 49）——修复是 min-height:0 + 窄屏收敛，
    // 静态锚点锁住这两处（拆修复即红）。
    expect(viewHtml).toContain('padding: 2px 3px; min-width: 0; min-height: 0;')
    expect(viewHtml).toContain('@media (max-width: 480px)')
    expect(viewHtml).toContain('.tile .t-sub, .tile .t-level, .tile .t-owner { font-size: 8px;')
  })

  it('视图地名/价签与引擎 tiles 全量对账（防漂移）', () => {
    for (const tile of tiles) {
      expect(viewHtml, `视图缺地名 ${tile.name}`).toContain(`name: '${tile.name}'`)
      if (tile.kind === 'property') expect(viewHtml, `视图缺价签 ${tile.price}`).toContain(`sub: '${tile.price}'`)
    }
    expect(viewHtml).toContain("name: '起点', sub: '经过 +200'")
    expect(viewHtml).toContain("name: '派出所', sub: '暂停一次'")
    expect(viewHtml).toContain("name: '年度分红', sub: '+200'")
    expect(viewHtml).toContain("name: '税务稽查', sub: '-150'")
    expect(viewHtml).toContain("name: '市政规费', sub: '-200'")
    expect(viewHtml).toContain("name: '免费停车', sub: '无事发生'")
  })

  it('视图静态预览局面 = 引擎 createGame({seed:1}) 开局态（逐字段对账防漂移）', () => {
    const text = /var PREVIEW_STATE = (\{[\s\S]*?\n\})/.exec(viewHtml)
    expect(text, 'viewHtml 含 PREVIEW_STATE 字面量').not.toBeNull()
    const preview = new Function(`return (${text![1]})`)() as MonopolyState
    expect(preview).toEqual(engine.createGame({ seed: 1 }).state)
  })
})

/* -------------------------------- 开局面 -------------------------------- */

describe('createGame（§3.2）', () => {
  it('初始态：红方先行、资金 1500、同在起点、地产全空地、JSON-safe、turn 合法', () => {
    const { state } = engine.createGame({ seed: 11 })
    expect(state.turn).toBe('red')
    expect(state.phase).toBe('roll')
    expect(state.pending).toBeNull()
    expect(state.cash).toEqual({ red: 1500, blue: 1500 })
    expect(state.pos).toEqual({ red: 0, blue: 0 })
    expect(state.owner).toEqual(tiles.map(() => null))
    expect(state.level).toEqual(tiles.map(() => 0))
    expect(state.jailed).toEqual({ red: false, blue: false })
    expect(state.turns).toEqual({ red: 0, blue: 0 })
    expect(state.rolls).toBe(0)
    expect(state.deckIndex).toBe(0)
    expect(state.lastRoll).toBeNull()
    expect(state.finished).toBe(false)
    expect(state.winner).toBeNull()
    expect(state.ending).toBeNull()
    expect(currentRoleOf(state, manifest.players.roles)).toBe('red')
    expect(JSON.parse(JSON.stringify(state)), '初始态 JSON-safe').toEqual(state)
  })

  it('同 seed 两次 createGame deep-equal；牌序恒为 0..11 的排列（种子扫描）', () => {
    expect(engine.createGame({ seed: 123 }).state).toEqual(engine.createGame({ seed: 123 }).state)
    const orders = new Set<string>()
    for (let seed = 1; seed <= 40; seed += 1) {
      const deck = engine.createGame({ seed }).state.deck
      expect([...deck].sort((left, right) => left - right)).toEqual(chanceCards.map((_card, index) => index))
      orders.add(deck.join(','))
    }
    expect(orders.size, '不同 seed 的洗牌结果应有多样性').toBeGreaterThan(5)
  })

  it('缺省 seed（crypto 随机）：无 options 与空对象两路都出合法开局', () => {
    for (const state of [engine.createGame().state, engine.createGame({}).state]) {
      expect(state.cash).toEqual({ red: 1500, blue: 1500 })
      expect([...state.deck].sort((left, right) => left - right)).toEqual(chanceCards.map((_card, index) => index))
      expect(Number.isInteger(state.seed)).toBe(true)
    }
  })
})

/* ------------------------------- 掷骰与移动 ------------------------------- */

describe('掷骰与移动', () => {
  it('探针取证据：seed 7 前 6 掷的观察值为 1,4,4,5,1,5（其余受控用例据此构造）', () => {
    const observed = PROBE_DICE.map((_die, index) => observedRoll(index))
    expect(observed).toEqual([...PROBE_DICE])
  })

  it('掷骰到无人地产：事件叙事 + 进入购买决定窗（turn 不变、建议集 [buy,pass]）', () => {
    const state = redLands(1) // 起点 → 鼓浪屿（100 元）
    const result = apply(state, { type: 'roll' })
    const next = result.state
    expect(result.summary).toContain('红方掷出 1 点：从「起点」到「鼓浪屿」')
    expect(result.summary).toContain('红方停留「鼓浪屿」（无人拥有，售价 100 元），可购买或跳过')
    expect(next.pos.red).toBe(1)
    expect(next.lastRoll).toBe(1)
    expect(next.rolls).toBe(1)
    expect(next.phase).toBe('decide')
    expect(next.pending).toBe('buy')
    expect(next.turn, '决定窗内不换手').toBe('red')
    expect(next.turns, '回合未收尾，计数不动').toEqual({ red: 0, blue: 0 })
    expect(engine.legalActions(next)).toEqual([{ type: 'buy' }, { type: 'pass' }])
    expect(state, '入参不被修改').toEqual(redLands(1))
  })

  it('跨起点领薪水：pos 23 掷 1 落到起点，事件含经过薪水与停留句', () => {
    const state = craft({ seed: PROBE_SEED, rolls: 0, pos: { red: 23, blue: 0 } })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('红方掷出 1 点：从「长城」到「起点」')
    expect(result.summary).toContain('经过起点，领取薪水 200 元')
    expect(result.summary).toContain('红方停留在起点')
    expect(result.state.cash.red, '薪水入账 1500+200').toBe(1700)
    expect(result.state.pos.red).toBe(0)
    expect(result.state.turn, '起点无决定窗，换手').toBe('blue')
    expect(result.state.turns.red).toBe(1)
  })

  it('现金不足自动放弃购买：不入决定窗、换手、事件说明不足', () => {
    const state = redLands(1, { cash: { red: 50, blue: 1500 } })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('「鼓浪屿」无人拥有（售价 100 元），红方现金不足无法购买')
    expect(result.state.phase).toBe('roll')
    expect(result.state.owner[1]).toBeNull()
    expect(result.state.turn).toBe('blue')
    expect(result.state.turns.red).toBe(1)
  })

  it('派出所滞留：掷骰空转（原地不动、解除滞留、正常收尾换手）', () => {
    const state = craft({ seed: PROBE_SEED, rolls: 0, pos: { red: 5, blue: 0 }, jailed: { red: true, blue: false } })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('红方在派出所滞留，暂停一次行动')
    expect(result.state.pos.red, '空转不移动').toBe(5)
    expect(result.state.jailed.red).toBe(false)
    expect(result.state.rolls, '空转不消耗骰子流').toBe(0)
    expect(result.state.lastRoll).toBeNull()
    expect(result.state.turn).toBe('blue')
    expect(result.state.turns.red).toBe(1)
  })

  it('阶段闸：decide 窗不能掷骰；roll 阶段不能购买/加盖/跳过（双向中文抛错）', () => {
    const decide = apply(redLands(1), { type: 'roll' }).state
    expectChineseThrow(() => apply(decide, { type: 'roll' }), /决定阶段/)
    const fresh = redLands(1)
    expectChineseThrow(() => apply(fresh, { type: 'buy' }), /先掷骰/)
    expectChineseThrow(() => apply(fresh, { type: 'build' }), /先掷骰/)
    expectChineseThrow(() => apply(fresh, { type: 'pass' }), /先掷骰/)
  })
})

/* ---------------------------- 地产：购买/加盖/收租 ---------------------------- */

describe('地产：购买 / 加盖 / 收租', () => {
  it('购买：扣款、归属、等级 1、事件含剩余现金、回合收尾换手', () => {
    const decide = apply(redLands(1), { type: 'roll' }).state
    const result = apply(decide, { type: 'buy' })
    const next = result.state
    expect(result.summary).toBe('红方买下「鼓浪屿」（100 元），现金剩余 1400 元')
    expect(next.cash.red).toBe(1400)
    expect(next.owner[1]).toBe('red')
    expect(next.level[1]).toBe(1)
    expect(next.turn).toBe('blue')
    expect(next.phase).toBe('roll')
    expect(next.pending).toBeNull()
    expect(next.turns.red).toBe(1)
  })

  it('放弃购买：归属不变、事件说明放弃、回合收尾', () => {
    const decide = apply(redLands(1), { type: 'roll' }).state
    const result = apply(decide, { type: 'pass' })
    expect(result.summary).toContain('红方放弃购买「鼓浪屿」')
    expect(result.state.owner[1]).toBeNull()
    expect(result.state.cash.red).toBe(1500)
    expect(result.state.turn).toBe('blue')
    expect(result.state.turns.red).toBe(1)
  })

  it('加盖：停留自有地产进入加盖窗，升级扣款（每级 = 地价一半）', () => {
    const state = redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)) })
    const landed = apply(state, { type: 'roll' })
    expect(landed.summary).toContain('「鼓浪屿」是红方的地产（1 级），可花费 50 元加盖或跳过')
    expect(landed.state.pending).toBe('build')
    expect(engine.legalActions(landed.state)).toEqual([{ type: 'build' }, { type: 'pass' }])
    const built = apply(landed.state, { type: 'build' })
    expect(built.summary).toContain('红方为「鼓浪屿」加盖到 2 级（花费 50 元），现金剩余 1450 元')
    expect(built.state.level[1]).toBe(2)
    expect(built.state.cash.red).toBe(1450)
    expect(built.state.turn).toBe('blue')
  })

  it('3 级地产再停留：不入决定窗（已是最高等级），回合直接收尾', () => {
    const state = redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 3 : 0)) })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('「鼓浪屿」已是最高等级（3 级），无需加盖')
    expect(result.state.phase).toBe('roll')
    expect(result.state.turn).toBe('blue')
  })

  it('加盖现金不足：不入决定窗、事件说明不足', () => {
    const state = redLands(1, {
      cash: { red: 30, blue: 1500 },
      owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)),
      level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)),
    })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('「鼓浪屿」可加盖（需 50 元），红方现金不足')
    expect(result.state.phase).toBe('roll')
    expect(result.state.turn).toBe('blue')
  })

  it('收租（1 级）：租金 = 地价 × 30%，双方现金对账、事件与独立计算一致', () => {
    const state = redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'blue' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)) })
    const rent = rentFor(tiles[1]!.price!, 1)
    expect(rent).toBe(30)
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('「鼓浪屿」是蓝方的地产（1 级），红方支付租金 30 元')
    expect(result.state.cash).toEqual({ red: 1470, blue: 1530 })
    expect(result.state.turn).toBe('blue')
    expect(result.state.owner[1]).toBe('blue')
  })

  it('收租（3 级高价）：长城 750 元 → 租金 1050 元，红方现金对账', () => {
    // 红方从 21 掷 1 落到 22（兵马俑）不够；长城在 23——用正向绕行：pos 22 掷 1 落到 23。
    const state = craft({
      seed: PROBE_SEED, rolls: 0, pos: { red: 22, blue: 0 },
      owner: tiles.map((_tile, index) => (index === 23 ? 'blue' as Role : null)),
      level: tiles.map((_tile, index) => (index === 23 ? 3 : 0)),
    })
    const rent = rentFor(tiles[23]!.price!, 3)
    expect(rent).toBe(1050)
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('「长城」是蓝方的地产（3 级），红方支付租金 1050 元')
    expect(result.state.cash).toEqual({ red: 450, blue: 2550 })
  })

  it('收租破产：现金不足 → 终局（剩余现金归对手、对手胜、ending bankrupt、建议集空）', () => {
    const state = craft({
      seed: PROBE_SEED, rolls: 0, pos: { red: 22, blue: 0 }, cash: { red: 100, blue: 1500 },
      owner: tiles.map((_tile, index) => (index === 23 ? 'blue' as Role : null)),
      level: tiles.map((_tile, index) => (index === 23 ? 3 : 0)),
    })
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('红方现金不足支付「长城」租金（需 1050 元，仅有 100 元），破产')
    expect(result.summary).toContain('破产清算：剩余现金 100 元归蓝方')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('blue')
    expect(result.state.ending).toBe('bankrupt')
    expect(result.state.cash).toEqual({ red: 0, blue: 1600 })
    expect(engine.legalActions(result.state)).toEqual([])
    expectChineseThrow(() => apply(result.state, { type: 'roll' }, 'red'), /已结束/)
  })

  it('决定窗错配：build 窗里 buy/pass 的合法面与拒绝面', () => {
    const state = redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)) })
    const decide = apply(state, { type: 'roll' }).state
    expectChineseThrow(() => apply(decide, { type: 'buy' }), /没有可购买的地产/)
    const passed = apply(decide, { type: 'pass' })
    expect(passed.summary).toContain('红方放弃为「鼓浪屿」加盖')
    expect(passed.state.level[1]).toBe(1)
  })
})

/* ------------------------ 税局 / 分红 / 停车 / 派出所格 ------------------------ */

describe('税局 / 分红 / 免费停车 / 派出所格', () => {
  it('税局两档：税务稽查 -150、市政规费 -200（事件与现金对账）', () => {
    const first = apply(redLands(4), { type: 'roll' })
    expect(first.summary).toContain('红方缴纳「税务稽查」150 元')
    expect(first.state.cash.red).toBe(1350)
    expect(first.state.turn).toBe('blue')
    const second = apply(redLands(16), { type: 'roll' })
    expect(second.summary).toContain('红方缴纳「市政规费」200 元')
    expect(second.state.cash.red).toBe(1300)
  })

  it('税费破产：现金不足 → 破产归对手（ending bankrupt）', () => {
    const result = apply(redLands(4, { cash: { red: 80, blue: 1500 } }), { type: 'roll' })
    expect(result.summary).toContain('红方现金不足支付「税务稽查」150 元（需 150 元，仅有 80 元），破产')
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('blue')
    expect(result.state.cash).toEqual({ red: 0, blue: 1580 })
  })

  it('年度分红 +200：入账与事件', () => {
    const result = apply(redLands(12), { type: 'roll' })
    expect(result.summary).toContain('红方在年度分红领取 200 元')
    expect(result.state.cash.red).toBe(1700)
    expect(result.state.turn).toBe('blue')
  })

  it('免费停车：无事件结算（no-op），回合正常收尾', () => {
    const result = apply(redLands(10), { type: 'roll' })
    expect(result.summary).toContain('红方免费停车，本回合无事发生')
    expect(result.state.cash.red).toBe(1500)
    expect(result.state.turn).toBe('blue')
  })

  it('派出所格：落格即拘留（暂停一次行动），下一次掷骰空转', () => {
    const landed = apply(redLands(6), { type: 'roll' })
    expect(landed.summary).toContain('红方被请进派出所，暂停一次行动')
    expect(landed.state.jailed.red).toBe(true)
    expect(landed.state.turn).toBe('blue')
    // 蓝方掷骰后回到红方：红方空转一次，拘留解除。
    const blueRoll = apply(landed.state, { type: 'roll' }, 'blue')
    expect(blueRoll.state.turn).toBe('red')
    const skipped = apply(blueRoll.state, { type: 'roll' }, 'red')
    expect(skipped.summary).toContain('红方在派出所滞留，暂停一次行动')
    expect(skipped.state.jailed.red).toBe(false)
    expect(skipped.state.turn).toBe('blue')
  })
})

/* --------------------------------- 机会卡 --------------------------------- */

describe('机会卡（现金 / 移动 / 前往起点 / 进派出所 / 转账）', () => {
  it('现金卡两向：+300 入账、-200 支出（事件含卡面文案与 deckIndex 前移）', () => {
    const gain = apply(redDrawsChance(2, [0]), { type: 'roll' })
    expect(gain.summary).toContain('机会：银行分红，领取 300 元')
    expect(gain.state.cash.red).toBe(1800)
    expect(gain.state.deckIndex).toBe(1)
    const loss = apply(redDrawsChance(2, [1]), { type: 'roll' })
    expect(loss.summary).toContain('机会：缴纳所得税 200 元')
    expect(loss.state.cash.red).toBe(1300)
  })

  it('移动卡：照常结算落点（落入无人地产进购买窗）、不发薪水', () => {
    // 机会格 2 + 前进 3 → 平遥古城（200 元，无人拥有）。
    const result = apply(redDrawsChance(2, [2]), { type: 'roll' })
    expect(result.summary).toContain('机会：前进 3 格')
    expect(result.summary).toContain('机会移动：红方从「机会」前进 3 格到「平遥古城」（不发薪水）')
    expect(result.state.pos.red).toBe(5)
    expect(result.state.phase).toBe('decide')
    expect(result.state.pending).toBe('buy')
    expect(result.state.cash.red, '移动不发薪水').toBe(1500)
  })

  it('移动卡跨起点不发薪水：机会格 2 后退 3 → 长城（23），现金不增', () => {
    const result = apply(redDrawsChance(2, [3]), { type: 'roll' })
    expect(result.summary).toContain('机会：后退 3 格')
    expect(result.summary).toContain('机会移动：红方从「机会」后退 3 格到「长城」（不发薪水）')
    expect(result.state.pos.red).toBe(23)
    expect(result.state.cash.red, '不发薪水').toBe(1500)
  })

  it('机会→机会连锁抑制：前进 4 从 14 到 18 不再抽卡（deckIndex 只 +1）', () => {
    // 红方从 13 掷 1 落到 14（机会），卡「前进 4 格」→ 18（机会格）二次落地。
    const state = redDrawsChance(14, [11])
    const result = apply(state, { type: 'roll' })
    expect(result.summary).toContain('机会：前进 4 格')
    expect(result.summary).toContain('机会移动：红方从「机会」前进 4 格到「机会」（不发薪水）')
    expect(result.summary).toContain('红方再次停留在机会格，本次不再抽卡')
    expect(result.state.pos.red).toBe(18)
    expect(result.state.deckIndex, '只消耗一张卡').toBe(1)
    expect(result.state.turn, '无决定窗，回合收尾').toBe('blue')
  })

  it('前往起点卡：pos=0 且领薪水（+200）', () => {
    const result = apply(redDrawsChance(2, [4]), { type: 'roll' })
    expect(result.summary).toContain('机会：受邀前往起点，领取薪水 200 元')
    expect(result.summary).toContain('红方抵达起点，领取薪水 200 元')
    expect(result.state.pos.red).toBe(0)
    expect(result.state.cash.red).toBe(1700)
  })

  it('进派出所卡：移到派出所格并拘留', () => {
    const result = apply(redDrawsChance(2, [5]), { type: 'roll' })
    expect(result.summary).toContain('机会：被请进派出所，暂停一次行动')
    expect(result.state.pos.red).toBe(6)
    expect(result.state.jailed.red).toBe(true)
    expect(result.state.turn).toBe('blue')
  })

  it('转账卡：向对手支付 100（双方现金对账）；现金不足则破产归对手', () => {
    const paid = apply(redDrawsChance(2, [6]), { type: 'roll' })
    expect(paid.summary).toContain('机会：向对手支付 100 元')
    expect(paid.state.cash).toEqual({ red: 1400, blue: 1600 })
    const bust = apply(redDrawsChance(2, [6], { cash: { red: 60, blue: 1500 } }), { type: 'roll' })
    expect(bust.summary).toContain('红方现金不足支付机会卡支付（需 100 元，仅有 60 元），破产')
    expect(bust.finished).toBe(true)
    expect(bust.winner).toBe('blue')
    expect(bust.state.cash).toEqual({ red: 0, blue: 1560 })
  })

  it('支出卡破产：-200 现金不足 → 破产归对手', () => {
    const result = apply(redDrawsChance(2, [1], { cash: { red: 100, blue: 1500 } }), { type: 'roll' })
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('blue')
    expect(result.state.ending).toBe('bankrupt')
  })

  it('牌堆循环：deckIndex 越尾取模（11 → 取 deck[11]，12 → 回 deck[0]）', () => {
    const deck = chanceCards.map((_card, index) => index)
    const last = apply(redDrawsChance(2, deck, { deckIndex: 11 }), { type: 'roll' })
    expect(last.summary).toContain(`机会：${chanceCards[11]!.text}`)
    expect(last.state.deckIndex).toBe(12)
    const wrapped = apply(redDrawsChance(2, deck, { deckIndex: 12 }), { type: 'roll' })
    expect(wrapped.summary).toContain(`机会：${chanceCards[0]!.text}`)
    expect(wrapped.state.deckIndex).toBe(13)
  })
})

/* -------------------------------- 回合与终局 -------------------------------- */

describe('回合计数与终局（破产 / 上限净值）', () => {
  it('回合计数：掷骰 + 购买只记 1 回合（购买不重复计）', () => {
    const decide = apply(redLands(1), { type: 'roll' }).state
    const bought = apply(decide, { type: 'buy' }).state
    expect(bought.turns).toEqual({ red: 1, blue: 0 })
    const blueRoll = apply(bought, { type: 'roll' }, 'blue')
    expect(blueRoll.state.turns).toEqual({ red: 1, blue: 1 })
  })

  it('上限净值终局：双方 15 回合后收尾 → 按净值比高（含地产投入）', () => {
    const state = craft({
      seed: PROBE_SEED, rolls: 0, pos: { red: 0, blue: 6 },
      cash: { red: 1200, blue: 1000 },
      owner: tiles.map((_tile, index) => (index === 21 ? 'red' as Role : index === 1 ? 'blue' as Role : null)),
      level: tiles.map((_tile, index) => (index === 21 ? 2 : index === 1 ? 1 : 0)),
      turns: { red: 15, blue: 15 },
    })
    const redWorth = openWorth(state, 'red')
    const blueWorth = openWorth(state, 'blue')
    expect(redWorth).toBe(1200 + 650 + 325) // 九寨沟 650 + 一级加盖 325
    expect(blueWorth).toBe(1000 + 100)
    const redRoll = apply(state, { type: 'roll' }) // 红方第 16 回合：掷 1 落到蓝方的鼓浪屿（付租 30）
    expect(redRoll.summary).toContain('红方支付租金 30 元')
    expect(redRoll.state.turns).toEqual({ red: 16, blue: 15 })
    expect(redRoll.finished, '红方收尾时蓝方还差一回合，不终局').toBe(false)
    // 蓝方第 16 回合：从 6 掷 4 落到免费停车（中性落点）→ 收尾即双方满 16 → 净值终局。
    const result = apply(redRoll.state, { type: 'roll' }, 'blue')
    expect(result.summary).toContain('蓝方免费停车')
    expect(result.summary).toContain(`达到 16 回合上限，按净值结算：红方 ${redWorth - 30} 元、蓝方 ${blueWorth + 30} 元——红方胜`)
    expect(result.finished).toBe(true)
    expect(result.winner).toBe('red')
    expect(result.state.ending).toBe('valuation')
    expect(result.state.turns).toEqual({ red: 16, blue: 16 })
    expect(engine.legalActions(result.state)).toEqual([])
  })

  it('上限净值平局：净值相同 → winner null', () => {
    // 受控落点：两侧同掷 4 点落到税务稽查（各缴 150），无地无差 → 净值相同。
    const state = craft({
      seed: PROBE_SEED, rolls: 1,
      cash: { red: 1000, blue: 1000 },
      turns: { red: 15, blue: 15 },
      pos: { red: 0, blue: 0 },
    })
    const redRoll = apply(state, { type: 'roll' }) // 红方缴税 150 → 850
    expect(redRoll.summary).toContain('红方缴纳「税务稽查」150 元')
    expect(redRoll.state.turns).toEqual({ red: 16, blue: 15 })
    expect(redRoll.finished, '红方满 16 时蓝方还差一回合').toBe(false)
    const result = apply(redRoll.state, { type: 'roll' }, 'blue') // 蓝方同额缴税 → 850 → 终局
    expect(result.summary).toContain('达到 16 回合上限，按净值结算：红方 850 元、蓝方 850 元——平局')
    expect(result.summary).toContain('平局')
    expect(result.finished).toBe(true)
    expect(result.winner).toBeNull()
    expect(result.state.ending).toBe('valuation')
  })

  it('破产优先于上限：最后一回合破产仍按破产结算', () => {
    const state = craft({
      seed: PROBE_SEED, rolls: 0, pos: { red: 22, blue: 0 }, cash: { red: 100, blue: 1500 },
      owner: tiles.map((_tile, index) => (index === 23 ? 'blue' as Role : null)),
      level: tiles.map((_tile, index) => (index === 23 ? 3 : 0)),
      turns: { red: 15, blue: 15 },
    })
    const result = apply(state, { type: 'roll' })
    expect(result.state.ending).toBe('bankrupt')
    expect(result.winner).toBe('blue')
  })
})

/* ------------------------------ 建议集 / 叙述面 ------------------------------ */

describe('legalActions 建议集（§3.2）', () => {
  it('五态：初始 [roll]、购买窗 [buy,pass]、加盖窗 [build,pass]、滞留仍 [roll]、终局 []', () => {
    const fresh = engine.createGame({ seed: 5 }).state
    expect(engine.legalActions(fresh)).toEqual([{ type: 'roll' }])
    expect(engine.legalActions(fresh)).toEqual(engine.legalActions(fresh))
    const buyWindow = apply(redLands(1), { type: 'roll' }).state
    expect(engine.legalActions(buyWindow)).toEqual([{ type: 'buy' }, { type: 'pass' }])
    const buildWindow = apply(redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)) }), { type: 'roll' }).state
    expect(engine.legalActions(buildWindow)).toEqual([{ type: 'build' }, { type: 'pass' }])
    const jailed = craft({ jailed: { red: true, blue: false } })
    expect(engine.legalActions(jailed)).toEqual([{ type: 'roll' }])
    const settled = playOut(5)
    expect(engine.legalActions(settled)).toEqual([])
  })
})

describe('describe 叙述（§3.2）', () => {
  it('掷骰 / 购买 / 加盖 / 放弃（购买与加盖）/ 未识别回落', () => {
    const fresh = redLands(1)
    expect(engine.describe(fresh, 'red', { type: 'roll' })).toBe('红方掷骰子')
    const buyWindow = apply(fresh, { type: 'roll' }).state
    expect(engine.describe(buyWindow, 'red', { type: 'buy' })).toBe('红方购买「鼓浪屿」（100 元）')
    expect(engine.describe(buyWindow, 'red', { type: 'pass' })).toBe('红方放弃购买「鼓浪屿」')
    const buildWindow = apply(redLands(1, { owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)), level: tiles.map((_tile, index) => (index === 1 ? 1 : 0)) }), { type: 'roll' }).state
    expect(engine.describe(buildWindow, 'red', { type: 'build' })).toBe('红方为「鼓浪屿」加盖（花费 50 元）')
    expect(engine.describe(buildWindow, 'red', { type: 'pass' })).toBe('红方放弃加盖')
    expect(engine.describe(fresh, 'blue', { type: 'roll' })).toBe('蓝方掷骰子')
    expect(engine.describe(fresh, 'red', { type: 'resign' })).toContain('未被本引擎识别')
    expect(engine.describe(fresh, 'red', {})).toContain('未被本引擎识别')
  })
})

/* --------------------------------- 确定性 --------------------------------- */

describe('确定性（§3.2 硬约束）', () => {
  it('同 state 同 action 两次 apply deep-equal、入参不变（掷骰 / 购买 / 抽卡三态）', () => {
    const rollState = redLands(2)
    const rollSnapshot = structuredClone(rollState)
    expect(apply(rollState, { type: 'roll' })).toEqual(apply(rollState, { type: 'roll' }))
    expect(rollState).toEqual(rollSnapshot)

    const decide = apply(redLands(1), { type: 'roll' }).state
    const decideSnapshot = structuredClone(decide)
    expect(apply(decide, { type: 'buy' })).toEqual(apply(decide, { type: 'buy' }))
    expect(apply(decide, { type: 'pass' })).toEqual(apply(decide, { type: 'pass' }))
    expect(decide).toEqual(decideSnapshot)

    const chanceState = redDrawsChance(2, [0])
    const chanceSnapshot = structuredClone(chanceState)
    expect(apply(chanceState, { type: 'roll' })).toEqual(apply(chanceState, { type: 'roll' }))
    expect(chanceState).toEqual(chanceSnapshot)
  })

  it('整局重放两次 deep-equal：同 seed 同策略打完整局，终局形态合法', () => {
    for (const seed of [1, 7, 23, 2026]) {
      const first = playOut(seed)
      const second = playOut(seed)
      expect(second).toEqual(first)
      expect(['bankrupt', 'valuation']).toContain(first.ending)
      expect(['red', 'blue', null]).toContain(first.winner)
      expect(first.finished).toBe(true)
      expect(JSON.parse(JSON.stringify(first)), '终局态 JSON-safe').toEqual(first)
    }
  })

  it('确定性不依赖外部输入：同 seed 的整局事件流两次一致（掷骰叙事可重放）', () => {
    const replay = (seed: number): string[] => {
      const lines: string[] = []
      let state = engine.createGame({ seed }).state
      let guard = 0
      while (!state.finished && guard < 2000) {
        guard += 1
        const legal = engine.legalActions(state)
        const action: MonopolyAction = state.phase === 'decide' ? { type: 'pass' } : legal[0]!
        const result = apply(state, action, state.turn)
        state = result.state
        if (result.events.length > 0) lines.push(result.summary)
      }
      return lines
    }
    expect(replay(99)).toEqual(replay(99))
    expect(replay(99).length).toBeGreaterThan(5)
  })
})

/* --------------------------------- 状态尺寸 --------------------------------- */

describe('状态尺寸（§3.2：序列化 <64KB）', () => {
  it('中局与终局态各一：jsonSizeOf 远小于 65536', () => {
    const mid = apply(redLands(2), { type: 'roll' }).state
    expect(jsonSizeOf(mid)).toBeLessThan(65536)
    const settled = playOut(31)
    expect(jsonSizeOf(settled)).toBeLessThan(65536)
    expect(jsonSizeOf(engine.createGame({ seed: 1 }).state)).toBeLessThan(65536)
  })
})

/* ------------------------------ 非法动作全家族 ------------------------------ */

describe('非法动作全家族（中文抛错）', () => {
  const fresh = (): MonopolyState => engine.createGame({ seed: 9 }).state

  it('动作形状：非对象 / 缺 type / 未知 type / resign 保留动作', () => {
    expectChineseThrow(() => apply(fresh(), null))
    expectChineseThrow(() => apply(fresh(), 42))
    expectChineseThrow(() => apply(fresh(), 'roll'))
    expectChineseThrow(() => apply(fresh(), [{ type: 'roll' }]))
    expectChineseThrow(() => apply(fresh(), {}))
    expectChineseThrow(() => apply(fresh(), { type: 'dice' }))
    expectChineseThrow(() => apply(fresh(), { type: 'resign' }))
  })

  it('角色与回合：未知角色 / 非本方回合（两个方向）', () => {
    expectChineseThrow(() => engine.applyAction(fresh(), { type: 'roll' }, 'purple'))
    expectChineseThrow(() => engine.applyAction(fresh(), { type: 'roll' }, 'blue'), /轮到/)
    const afterRed = apply(fresh(), { type: 'roll' }).state
    expectChineseThrow(() => engine.applyAction(afterRed, { type: 'roll' }, 'red'), /轮到/)
  })

  it('终局后：结算态再 roll/buy/build/pass 一律拒绝', () => {
    const settled = playOut(7)
    for (const action of [{ type: 'roll' }, { type: 'buy' }, { type: 'build' }, { type: 'pass' }]) {
      expectChineseThrow(() => engine.applyAction(settled, action, settled.turn), /已结束/)
    }
  })
})

/* --------------------------- 视图行为（DOM 垫片） --------------------------- */

class FakeElement {
  children: FakeElement[] = []
  className = ''
  textContent = ''
  disabled = false
  style: Record<string, string> = {}
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
    if (name === 'class') this.className = value
  }
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
}

const VIEW_ELEMENT_IDS = [
  'banner', 'meta', 'board', 'log', 'dice', 'result-strip', 'strip-result', 'strip-sub', 'hint',
  'roll-btn', 'buy-btn', 'build-btn', 'pass-btn',
  'red-owner', 'blue-owner', 'red-cash', 'blue-cash', 'red-info', 'blue-info', 'card-red', 'card-blue',
] as const

interface ViewHarness {
  el(id: string): FakeElement
  dispatch(payload: unknown): void
}

/** 打开视图脚本（search 带 token 即实时面，不带即预览面）；createElement 建的
 *  元素按 setAttribute('id') 登记进同一注册表（棋盘格 tile-N 可查）。 */
function openMonopolyView(search: string): ViewHarness {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(viewHtml)
  expect(script, 'viewHtml 含内联脚本').not.toBeNull()
  const registry = new Map<string, FakeElement>(VIEW_ELEMENT_IDS.map((id): [string, FakeElement] => [id, new FakeElement('div')]))
  class Registered extends FakeElement {
    override setAttribute(name: string, value: string): void {
      super.setAttribute(name, value)
      if (name === 'id') registry.set(value, this)
    }
  }
  const listeners: Array<(event: { data: unknown }) => void> = []
  const documentShim = {
    getElementById: (id: string): FakeElement | null => registry.get(id) ?? null,
    createElement: (tagName: string): FakeElement => new Registered(tagName),
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

/** 下行 dsh-soulmojito:game-state 载荷（token 与视图 URL 的 token 对账）。 */
function gameState(session: unknown, view: unknown): unknown {
  return { type: 'dsh-soulmojito:game-state', token: 't', session, view }
}

/** 会话快照（玩家表按 manifest roles 规范序：red 前、blue 后）。 */
function sessionFixture(blueOwner: 'human' | 'agent'): Record<string, unknown> {
  return {
    id: 'g-a1b2c3d4',
    gameId: 'dsh-soulmojito.monopoly',
    gameName: '大富翁',
    players: [
      { role: 'red', owner: blueOwner === 'human' ? 'agent' : 'human' },
      { role: 'blue', owner: blueOwner },
    ],
    finished: false,
    winner: null,
    summary: '',
  }
}

/** 视图载荷（GameViewPayload 形状：全量 state + legal + finished + summary）。 */
function viewFixture(params: { state: MonopolyState; legal: MonopolyAction[]; summary?: string }): Record<string, unknown> {
  return {
    state: params.state,
    turn: params.state.turn,
    legal: params.legal,
    finished: params.state.finished,
    summary: params.summary ?? '',
  }
}

describe('视图行为（DOM 垫片：按钮随 legal 收缩 / 棋盘归属渲染 / 终局与坐席）', () => {
  it('人类回合（掷骰阶段）：仅「掷骰」可用，其余禁用；提示与棋盘归属渲染正确', () => {
    const harness = openMonopolyView('?token=t')
    const state = craft({
      owner: tiles.map((_tile, index) => (index === 1 ? 'blue' as Role : null)),
      level: tiles.map((_tile, index) => (index === 1 ? 2 : 0)),
    })
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({ state, legal: [{ type: 'roll' }], summary: '' })))
    expect(harness.el('roll-btn').disabled).toBe(false)
    expect(harness.el('buy-btn').disabled).toBe(true)
    expect(harness.el('build-btn').disabled).toBe(true)
    expect(harness.el('pass-btn').disabled).toBe(true)
    expect(harness.el('hint').textContent).toContain('点「掷骰」前进')
    expect(harness.el('red-owner').textContent).toBe('你')
    expect(harness.el('blue-owner').textContent).toBe('AI')
    expect(harness.el('red-cash').textContent).toBe('1500 元')
    // 棋盘：24 格、蓝方 2 级地产的归属色/星级/租金副文案。
    expect(harness.el('tile-23')).toBeDefined()
    const tileOne = harness.el('tile-1')
    expect(tileOne.className).toContain('owner-blue')
    expect(tileOne.children[2]!.textContent).toContain('★★ 2 级')
    expect(tileOne.children[3]!.textContent).toBe('蓝方')
    expect(tileOne.children[1]!.textContent).toBe('租 70')
  })

  it('购买决定窗：仅「购买/跳过」可用；提示含售价与租金说明', () => {
    const harness = openMonopolyView('?token=t')
    const state = apply(redLands(9), { type: 'roll' }).state // 落到 9 西湖（300）
    expect(state.pending).toBe('buy')
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      state,
      legal: [{ type: 'buy' }, { type: 'pass' }],
      summary: '红方停留「西湖」（无人拥有，售价 300 元），可购买或跳过',
    })))
    expect(harness.el('roll-btn').disabled).toBe(true)
    expect(harness.el('buy-btn').disabled).toBe(false)
    expect(harness.el('build-btn').disabled).toBe(true)
    expect(harness.el('pass-btn').disabled).toBe(false)
    expect(harness.el('hint').textContent).toContain('可花费 300 元购买')
    expect(harness.el('log').textContent).toContain('停留「西湖」')
    expect(harness.el('dice').textContent).toBe('骰点 1')
  })

  it('AI 回合：四按钮全禁用；横幅与提示按 owner 生成（不写死缺省坐席）', () => {
    const harness = openMonopolyView('?token=t')
    const state = craft({ turn: 'blue' })
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({ state, legal: [{ type: 'roll' }] })))
    expect(harness.el('roll-btn').disabled).toBe(true)
    expect(harness.el('pass-btn').disabled).toBe(true)
    expect(harness.el('banner').textContent).toContain('蓝方 · AI 思考中')
    expect(harness.el('hint').textContent).toBe('蓝方（AI）行动中，动作将自动出现在棋盘上。')
    // 人类坐另一侧（坐席非缺省）：AI 执 red 时提示必须说红方（AI）。
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({ state: craft({ turn: 'red' }), legal: [{ type: 'roll' }] })))
    expect(harness.el('hint').textContent).toBe('红方（AI）行动中，动作将自动出现在棋盘上。')
    expect(harness.el('red-owner').textContent).toBe('AI')
    expect(harness.el('blue-owner').textContent).toBe('你')
  })

  it('终局：结果条按 owner 落章（你/AI/平局），盘面完整保留、四按钮禁用', () => {
    const harness = openMonopolyView('?token=t')
    const settled = craft({
      finished: true, winner: 'red', ending: 'valuation',
      cash: { red: 2000, blue: 900 },
      owner: tiles.map((_tile, index) => (index === 1 ? 'red' as Role : null)),
      level: tiles.map((_tile, index) => (index === 1 ? 3 : 0)),
    })
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({
      state: settled,
      legal: [],
      summary: '达到 16 回合上限，按净值结算：红方 2950 元、蓝方 900 元——红方胜',
    })))
    expect(harness.el('strip-result').textContent).toBe('红方胜（你）')
    expect(harness.el('strip-sub').textContent).toContain('按净值结算')
    expect(harness.el('result-strip').className).toBe('result-strip')
    expect(harness.el('roll-btn').disabled).toBe(true)
    expect(harness.el('tile-1').className).toContain('owner-red')
    expect(harness.el('tile-23').className).toContain('tile')
    // 坐席反查：人类坐蓝方时落「(你)」章。
    const flipped = craft({ finished: true, winner: 'blue', ending: 'bankrupt' })
    harness.dispatch(gameState(sessionFixture('human'), viewFixture({ state: flipped, legal: [], summary: '红方破产' })))
    expect(harness.el('strip-result').textContent).toBe('蓝方胜（你）')
    // 平局不落 owner 章。
    harness.dispatch(gameState(sessionFixture('agent'), viewFixture({ state: craft({ finished: true, winner: null, ending: 'valuation' }), legal: [] })))
    expect(harness.el('strip-result').textContent).toBe('平局')
  })

  it('预览（无 token）：静态开局局面（资金 1500、24 格棋board、按钮全禁用）', () => {
    const harness = openMonopolyView('')
    expect(harness.el('banner').className).toBe('preview')
    expect(harness.el('banner').textContent).toContain('预览模式')
    for (const id of ['roll-btn', 'buy-btn', 'build-btn', 'pass-btn']) expect(harness.el(id).disabled).toBe(true)
    expect(harness.el('red-cash').textContent).toBe('1500 元')
    expect(harness.el('tile-0').children[0]!.textContent).toBe('起点')
    expect(harness.el('tile-23').children[0]!.textContent).toBe('长城')
    expect(harness.el('log').textContent).toContain('预览模式')
  })
})

/* ----------------------------- 端到端（真实服务） ----------------------------- */

describe('端到端会话（真实 GamesService，开箱可玩面）', () => {
  it('开局 → 人类与 Agent 交替落子到终局：视图/叙述/终审全链路', async () => {
    const service = await openGamesService({ root: join(home, 'tavern'), hostVersion: '0.6.5' })
    try {
      const { session, view } = await service.start({ gameId: 'dsh-soulmojito.monopoly', character: 'Seraphina', chatId: 'mp-chat' })
      expect(session.gameId).toBe('dsh-soulmojito.monopoly')
      expect(session.players).toEqual([
        { role: 'red', owner: 'human' },
        { role: 'blue', owner: 'agent' },
      ])
      expect(view.finished).toBe(false)
      expect(view.turn).toBe('red')
      expect(view.legal).toEqual([{ type: 'roll' }])

      let current = view
      let guard = 0
      while (!current.finished && guard < 300) {
        guard += 1
        const legal = current.legal
        expect(legal.length, 'guard 内建议集非空').toBeGreaterThan(0)
        const role = current.turn as Role
        const state = current.state as MonopolyState
        const action = (() => {
          if (state.phase === 'decide') {
            const index = state.pos[role]
            if (state.pending === 'buy' && state.cash[role] >= (tiles[index]!.price ?? 0) + 50) return { type: 'buy' as const }
            if (state.pending === 'build' && state.cash[role] >= 400) return { type: 'build' as const }
            return { type: 'pass' as const }
          }
          return { type: 'roll' as const }
        })()
        if (role === 'red') {
          const move = await service.humanAction(session.id, action)
          if (action.type === 'roll') expect(move.describe).toBe('红方掷骰子')
          current = move.view
        } else {
          const move = await service.agentMove(session.id, action)
          if (action.type === 'roll') expect(move.describe).toBe('蓝方掷骰子')
          current = move.view
        }
        if (!current.finished) {
          const wrongSide = current.turn === 'red' ? 'blue' : 'red'
          const attempt = wrongSide === 'red'
            ? () => service.humanAction(session.id, { type: 'roll' })
            : () => service.agentMove(session.id, { type: 'roll' })
          await expect(attempt(), '非当前行动方动作被运行时把守').rejects.toThrow()
        }
      }
      expect(current.finished, 'guard 300 内必须终局').toBe(true)
      expect(current.legal).toEqual([])
      const settled = current.state as MonopolyState
      expect(['bankrupt', 'valuation']).toContain(settled.ending)
      expect(current.summary.length).toBeGreaterThan(0)
      // 终局后视图条与结算句：审阅面完整（人类可从结果条读胜负）。
      expect(viewHtml).toContain('result-strip')
    } finally {
      service.dispose()
    }
  })

  it('registry 列出 builtin 大富翁：source builtin、status ok、engine/view 可用', async () => {
    const registry = await GameRegistry.open({ root: join(home, 'tavern'), hostVersion: '0.6.5' })
    const summary = registry.summaries().find((candidate) => candidate.id === 'dsh-soulmojito.monopoly')
    expect(summary).toBeDefined()
    expect(summary!.source).toBe('builtin')
    expect(summary!.status).toBe('ok')
    expect(summary!.name).toBe('大富翁')
    expect(summary!.players).toEqual({ min: 2, max: 2, roles: ['red', 'blue'] })
    const entry = registry.get('dsh-soulmojito.monopoly')!
    expect(entry.engine).not.toBeNull()
    expect(entry.viewHtml).toContain('data-game="dsh-soulmojito.monopoly"')
  })
})
