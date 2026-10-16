/**
 * 内置游戏：地牢爬行 / Dungeon Crawl（提案 0018 §4.1 内置序列第八款，2026-10-16）。
 *
 * 需求源：用户「游戏服务扩展支持 Roguelike/RPG 模式——当前小游戏有一些单调」。
 * 品类论证见 decisions/2026-10-16-dungeon-crawl-builtin.md：游戏桥契约约束的是
 * 形态（回合制、JSON state、确定性纯函数引擎），不约束品类——本作是第一款
 * 非对称对抗（探索者 vs 地下城主）的 Roguelike 内置，验证「Agent 当 DM」的
 * 叙事节奏在既有桥上零核心改动可跑。
 *
 * 语义定位：roles ['hero','world']——人类缺省执 hero（探索者），Agent 缺省执
 * world（地下城主）。英雄在 12×12 程序化地宫里向下爬三层，第三层石阶尽头是
 * 炎魔君王，斩杀即通关；英雄 HP 归零则地下城吞噬冒险者。
 *
 * 迷雾与防偷看（21 点「暗牌延迟决定」+ 记忆翻牌「未翻开牌面不进 state」同款
 * 不变式）：state 对视图/Agent 全明（viewOf 与 game_state 无按角色投影通道），
 * 因此**未揭示的格子在 state 里不存在**：
 * - 岩壁布局：carveFloor(seed, depth) 是纯函数（醉汉游走凿洞，连通性由构造
 *   保证），引擎随时重算，但**布局永不进 state**——视图只渲染 state.tiles
 *   里已揭示的格子；
 * - 陷阱：armed 陷阱在任何 state/视图载荷里不存在，hash 判定发生在英雄踏上
 *   的那一刻，踩中才写 trapSprung（双方都无法提前偷看）；
 * - 怪物/物品：揭示半径（切比雪夫 ≤2）扫过时才从纯函数快照进 state.tiles。
 *
 * 节奏与自动续弈（§21 两道闸的语义对齐）：探索（move/drink/descend/拾取/踩
 * 陷阱）全部在英雄动作内结算、turn 停在 hero——纯探索零 Agent 调用；只有踏上
 * 活怪格才把 turn 交给 world（遭遇先手），战斗逐手交替。wake 的回合闸
 * （turnReachedAgent）恰好在「遭遇/怪物还击待命」时投递通知——引擎是节奏
 * 作者：值得 Agent 开口（遭遇/搏杀/终局）的节点才交回合。
 *
 * 确定性纪律：全文除 createGame 缺省 seed（node:crypto randomInt 的唯一随机
 * 点）外无任何随机/时间源。两条纯随机流：
 * - 静态流 hash01(seed, depth, x, y, salt)：布局游走方向、格内容（怪/物/陷阱
 *   的类别与数值）——坐标寻址，任意时刻可重算；
 * - 战斗流 hash01(seed, state.rolls, ...)：伤害浮动 ±1、猛击命中、掉落——
 *   rolls 游标在 state 里，同输入两次调用 deep-equal（§3.2 硬约束）。
 *
 * state 形状（运行时补充契约：顶层 turn 为当前行动方角色；终局后留在最后
 * 行动方、保持合法角色值）：
 * { turn:'hero'|'world', seed, rolls, depth(1..3),
 *   hero: { x, y, hp, maxHp, atk, def, potions, gold, weapon, armor },
 *   tiles: { "x,y": { kind:'floor'|'stairs'|'wall', monster?, item?, trapSprung? } }
 *     ——仅已揭示格；下楼即弃（楼梯坍塌，无回溯）；
 *   finished, winner:'hero'|'world'|null }
 *
 * 数值面（v1 明示裁剪，见决策文档）：英雄 30HP/攻4/防0/药水3 起（药水 +15）；
 * 怪物随深度成长（HP 6+3d、攻 1+d，各 +0/1 浮动）；武器铁剑+1（1 层）/
 * 秘银剑+2（2 层起）、护甲皮甲+1（1 层）/板甲+2（2 层起），更优才换装；
 * Boss 炎魔君王 32HP/攻5。贪心直奔楼梯脚本（仁慈 DM）通关率约四成、凶狠
 * DM（恒猛击）约三成——人类探索拾取与战术回避显著优于脚本，难度锚定于此。
 * 不实现：饥饿/背包管理/远程/法术/怪物移动/卖装备。
 *
 * 装载形态与井字棋/大富翁同款：静态 import TS 引擎 + viewHtml 字符串常量
 * （内联预览局面由引擎 createGame({seed:1}) 模块期实时生成——与引擎开局态
 * 零漂移，优于手工粘贴的静态副本）。保留动作 resign 由运行时统一处理。
 *
 * 视图反馈层（2026-10-16 用户需求「攻击等交互事件应该弹出显眼的提示，在 PC
 * 上支持 WASD 和方向键以及 JKL 绑定操作」）：事件提示栈（dc-toast-stack——
 * 每次局面真变化把该手 summary 弹提示，**地图内浮层、底部锚定**（零布局
 * 位移——三次迭代：初版顶部浮层挡画面 → 文档流位致操作栏抖动 → 最终底部
 * 锚定浮层，入口区无遮挡且不抖），遭遇/陷阱/倒下 danger、通关 finale，
 * 至多 3 条、到点自清）+ 飘字伤害
 * （dc-float-num——英雄受击红/怪物受创橙/治疗绿/击杀 💀，按格位上浮）+
 * PC 键盘（WASD/方向键移动、J/K/L = 攻击/喝药/下楼，与按钮共用同一合法面：
 * 按钮 disabled 即按键不动作，带 Ctrl/Alt/Meta 修饰键不劫持）。纯视图层：
 * 引擎/桥协议/sessions 零改动，指纹 + HP 差分判定保证轮询重复下发不弹
 * （象棋将军提示层同款纪律）。
 */

import { randomInt } from 'node:crypto'
import type { GameEngine, GameManifest } from '../standard.js'

/** 引擎唯一权威清单（内置自我门控无意义，engines 刻意缺席）。 */
const MANIFEST: GameManifest = {
  id: 'dsh-soulmojito.dungeon-crawl',
  name: '地牢爬行',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['hero', 'world'] },
  turnBased: true,
  actionVocabulary: '探索者（hero）：移动 {type:\'move\', dir:\'up\'|\'down\'|\'left\'|\'right\'}（上/下/左/右走一格，踏入怪物格即遭遇战）、攻击 {type:\'attack\'}（与同格怪物搏斗，伤害=攻击力±1）、喝药 {type:\'drink\'}（+12 HP，战斗中喝药会把回合让给怪物）、下楼 {type:\'descend\'}（站在石阶🪜上时下探更深一层）；拾取/陷阱/掉落在移动内自动结算。地下城主（world，Agent 扮演）：怪物回合三选一——{type:\'attack\'}（攻击英雄，伤害=攻击力±1-防御）、{type:\'heavy\'}（35% 落空、命中双倍伤害的猛击）、{type:\'defend\'}（架势防御，英雄下一击伤害减半）。目标：下到地下 3 层斩杀炎魔君王🐲；英雄 HP 归零则地下城获胜。认输 {type:\'resign\'} 由运行时统一处理',
}

type Role = 'hero' | 'world'
type Dir = 'up' | 'down' | 'left' | 'right'

/** 网格 12×12，内部可凿区 [1,10]²，边界恒岩壁。 */
const SIZE = 12
const INNER_MIN = 1
const INNER_MAX = 10
/** 最深层（石阶尽头是 Boss）。 */
const MAX_DEPTH = 3
/** 揭示半径（切比雪夫距离）。 */
const SIGHT = 2
/** 每层凿洞目标格数（40+4×深度：44/48/52）。 */
const carveTarget = (depth: number): number => 40 + depth * 4
/** 格内容概率（互斥单掷）：怪物 / 物品 / 陷阱。 */
const monsterChance = (depth: number): number => 0.24 + depth * 0.02
const ITEM_CHANCE = 0.15
const TRAP_CHANCE = 0.10
/** 药水治疗量 / 猛击落空率 / 击杀掉药率。 */
const POTION_HEAL = 15
const HEAVY_MISS = 0.35
const LOOT_POTION = 0.20

interface Monster {
  name: string
  hp: number
  maxHp: number
  atk: number
  boss?: boolean
  /** world 的 defend 旗：英雄下一击伤害减半，结算即清。 */
  braced?: boolean
}

type ItemKind = 'potion' | 'weapon' | 'armor' | 'gold'

interface Item {
  kind: ItemKind
  name: string
  /** weapon/armor 的战力加成。 */
  power?: number
  /** gold 的数额。 */
  amount?: number
}

/** 已揭示格（state.tiles 的值形态）——armed 陷阱与未揭示格永不进 state。 */
interface Tile {
  kind: 'floor' | 'stairs' | 'wall'
  monster?: Monster
  item?: Item
  trapSprung?: boolean
}

interface Hero {
  x: number
  y: number
  hp: number
  maxHp: number
  atk: number
  def: number
  potions: number
  gold: number
  weapon: string
  armor: string
}

interface DungeonState {
  turn: Role
  seed: number
  /** 战斗流游标（伤害浮动/猛击/掉落）。 */
  rolls: number
  depth: number
  hero: Hero
  tiles: Record<string, Tile>
  finished: boolean
  winner: Role | null
}

interface ApplyResult {
  state: DungeonState
  events: string[]
  finished: boolean
  winner: Role | null
  summary: string
}

/* ------------------------------ 纯随机流 ------------------------------ */

/** FNV 变体整数折叠 → [0,1) 确定性浮点（纯函数，无模块态）。 */
function hash01(...parts: number[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    h = Math.imul(h ^ (part | 0), 0x01000193) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** 战斗流浮点（消耗一枚游标）。 */
function roll01(next: DungeonState, saltA: number, saltB: number): number {
  const r = hash01(next.seed, next.rolls, saltA, saltB)
  next.rolls += 1
  return r
}

/** 战斗流 ±1 浮动。 */
function roll3(next: DungeonState, saltA: number, saltB: number): number {
  const r = roll01(next, saltA, saltB)
  return r < 1 / 3 ? -1 : r < 2 / 3 ? 0 : 1
}

/* ------------------------------ 地宫生成（纯函数） ------------------------------ */

interface FloorPlan {
  carved: Set<string>
  stairs: { x: number; y: number }
}

const DIR_DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const DIR_CN: Record<Dir, string> = { up: '北', down: '南', left: '西', right: '东' }

const keyOf = (x: number, y: number): string => `${x},${y}`

/**
 * 醉汉游走凿洞（连通性由构造保证——每格新凿必与已凿区相邻）：入口恒 (1,1)，
 * 石阶 = 最后凿出的格。纯函数 of (seed, depth)，布局永不进 state。
 */
function carveFloor(seed: number, depth: number): FloorPlan {
  const target = carveTarget(depth)
  const carved = new Set<string>([keyOf(1, 1)])
  let x = 1
  let y = 1
  let stairs = { x: 1, y: 1 }
  for (let n = 0; carved.size < target; n += 1) {
    const r = hash01(seed, depth, n, 0x51)
    const delta = [[0, -1], [0, 1], [-1, 0], [1, 0]][Math.floor(r * 4)]!
    x = Math.min(INNER_MAX, Math.max(INNER_MIN, x + delta[0]!))
    y = Math.min(INNER_MAX, Math.max(INNER_MIN, y + delta[1]!))
    const key = keyOf(x, y)
    if (!carved.has(key)) {
      carved.add(key)
      stairs = { x, y }
    }
  }
  return { carved, stairs }
}

function isCarved(plan: FloorPlan, x: number, y: number): boolean {
  return plan.carved.has(keyOf(x, y))
}

/* ------------------------------ 格内容（纯函数，坐标寻址） ------------------------------ */

const MONSTER_NAMES: string[][] = [
  ['史莱姆', '巨型鼠', '洞穴蝙蝠'],
  ['骷髅兵', '毒蜘蛛', '座狼'],
  ['石魔像', '暗影', '炎魔仆从'],
]
const BOSS_NAME = '炎魔君王'
/** 武器/护甲按深度查表：更优才换装。 */
const WEAPON_OF_DEPTH: Array<{ name: string; power: number }> = [
  { name: '铁剑', power: 1 },
  { name: '秘银剑', power: 2 },
  { name: '秘银剑', power: 2 },
]
const ARMOR_OF_DEPTH: Array<{ name: string; power: number }> = [
  { name: '皮甲', power: 1 },
  { name: '板甲', power: 2 },
  { name: '板甲', power: 2 },
]

/** 格内容类别（互斥单掷：怪 > 物 > 陷阱 > 空）；入口/石阶格恒空。 */
type ContentClass = 'monster' | 'item' | 'trap' | 'none'

function contentClassAt(seed: number, depth: number, x: number, y: number): ContentClass {
  const r = hash01(seed, depth, x, y, 0x11)
  if (r < monsterChance(depth)) return 'monster'
  if (r < monsterChance(depth) + ITEM_CHANCE) return 'item'
  if (r < monsterChance(depth) + ITEM_CHANCE + TRAP_CHANCE) return 'trap'
  return 'none'
}

function monsterAt(seed: number, depth: number, x: number, y: number): Monster {
  const nameIdx = Math.floor(hash01(seed, depth, x, y, 0x12) * 3)
  const name = MONSTER_NAMES[depth - 1]![nameIdx]!
  const hpBonus = Math.floor(hash01(seed, depth, x, y, 0x13) * 2)
  const atkBonus = Math.floor(hash01(seed, depth, x, y, 0x14) * 2)
  const hp = 6 + depth * 3 + hpBonus
  return { name, hp, maxHp: hp, atk: 1 + depth + atkBonus }
}

function bossMonster(): Monster {
  return { name: BOSS_NAME, hp: 32, maxHp: 32, atk: 5, boss: true }
}

function itemAt(seed: number, depth: number, x: number, y: number): Item {
  const r = hash01(seed, depth, x, y, 0x15)
  if (r < 0.40) return { kind: 'potion', name: '治疗药水' }
  if (r < 0.60) {
    const weapon = WEAPON_OF_DEPTH[depth - 1]!
    return { kind: 'weapon', name: weapon.name, power: weapon.power }
  }
  if (r < 0.75) {
    const armor = ARMOR_OF_DEPTH[depth - 1]!
    return { kind: 'armor', name: armor.name, power: armor.power }
  }
  const amount = 5 + Math.floor(hash01(seed, depth, x, y, 0x16) * 9)
  return { kind: 'gold', name: '金币', amount }
}

/** 陷阱判定（armed 陷阱不进 state，踏上即判）。入口紧邻格（切比雪夫 ≤1）不设陷阱——开局礼貌。 */
function trapAt(seed: number, depth: number, x: number, y: number): boolean {
  if (contentClassAt(seed, depth, x, y) !== 'trap') return false
  if (Math.max(Math.abs(x - 1), Math.abs(y - 1)) <= 1) return false
  return true
}

/* ------------------------------ 揭示（迷雾散开） ------------------------------ */

/**
 * 以 (cx,cy) 为中心揭示切比雪夫 ≤SIGHT 的格子：凿区 → floor/stairs（内容此刻
 * 才从纯函数快照进 state——延迟决定），非凿区 → wall（岩壁可示，洞后不可知）。
 * 只补新格，已揭示格不动（怪物血量等可变态不受再揭示影响）。
 */
function revealAround(state: DungeonState, plan: FloorPlan): void {
  const { x: cx, y: cy } = state.hero
  for (let y = cy - SIGHT; y <= cy + SIGHT; y += 1) {
    for (let x = cx - SIGHT; x <= cx + SIGHT; x += 1) {
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
      const key = keyOf(x, y)
      if (state.tiles[key] !== undefined) continue
      if (!isCarved(plan, x, y)) {
        state.tiles[key] = { kind: 'wall' }
        continue
      }
      const isStairs = plan.stairs.x === x && plan.stairs.y === y
      const tile: Tile = isStairs ? { kind: 'stairs' } : { kind: 'floor' }
      // Boss 只生成一次、只在最深层的石阶格（2026-10-16 实弹修复：初版把
      // 「depth===MAX_DEPTH 的怪物格」全放成 Boss——第 3 层满地炎魔君王、
      // 且杀路径上任意一只即通关，石阶巢穴形同虚设）。石阶格不吃常规内容，
      // 1/2 层石阶恒干净。
      if (isStairs && state.depth === MAX_DEPTH) {
        tile.monster = bossMonster()
      } else if (!isStairs && !(x === 1 && y === 1)) {
        const cls = contentClassAt(state.seed, state.depth, x, y)
        if (cls === 'monster') tile.monster = monsterAt(state.seed, state.depth, x, y)
        else if (cls === 'item') tile.item = itemAt(state.seed, state.depth, x, y)
      }
      state.tiles[key] = tile
    }
  }
}

/** 英雄是否与活怪同格（遭遇中）。 */
function engagedMonsterOf(state: DungeonState): Monster | undefined {
  return state.tiles[keyOf(state.hero.x, state.hero.y)]?.monster
}

/** 动作收尾的回合判定：战斗中在双方间交替，其余恒回英雄（引擎即节奏作者）。 */
function settleTurn(next: DungeonState, actor: Role): void {
  if (next.finished) return
  const engaged = engagedMonsterOf(next) !== undefined
  next.turn = engaged ? (actor === 'hero' ? 'world' : 'hero') : 'hero'
}

function cloneState(state: DungeonState): DungeonState {
  return structuredClone(state)
}

/* ------------------------------ 动作实现 ------------------------------ */

function readDir(action: Record<string, unknown>): Dir {
  const dir = action.dir
  if (typeof dir !== 'string' || !(dir in DIR_DELTA)) {
    throw new Error(`移动方向必须是 up/down/left/right，收到「${String(dir)}」`)
  }
  return dir as Dir
}

/** 英雄移动：探索 / 拾取 / 陷阱 / 踏入怪物格遭遇。 */
function heroMove(next: DungeonState, action: Record<string, unknown>): void {
  const dir = readDir(action)
  const [dx, dy] = DIR_DELTA[dir]
  const tx = next.hero.x + dx!
  const ty = next.hero.y + dy!
  if (tx < 0 || tx >= SIZE || ty < 0 || ty >= SIZE) {
    throw new Error(`那一步越过了地牢边界`)
  }
  const plan = carveFloor(next.seed, next.depth)
  if (!isCarved(plan, tx, ty)) {
    throw new Error(`前方（${tx},${ty}）是未凿开的岩壁`)
  }
  next.hero.x = tx
  next.hero.y = ty
  next.events.push(`英雄向${DIR_CN[dir]}探索`)
  revealAround(next, plan)

  const tile = next.tiles[keyOf(tx, ty)]!
  if (tile.monster !== undefined) {
    const monster = tile.monster
    next.events.push(`遭遇 ${monster.name}！战斗开始${monster.boss === true ? '——石阶尽头的君主苏醒了' : ''}`)
    return
  }
  // 拾取（自动）。
  if (tile.item !== undefined) {
    const item = tile.item
    if (item.kind === 'potion') {
      next.hero.potions += 1
      delete tile.item
      next.events.push(`拾获 治疗药水（现有 ${next.hero.potions} 瓶）`)
    } else if (item.kind === 'gold') {
      const amount = item.amount ?? 0
      next.hero.gold += amount
      delete tile.item
      next.events.push(`拾获 ${amount} 金币`)
    } else if (item.kind === 'weapon') {
      const power = item.power ?? 0
      // 与英雄身上的实际武器比（hero.atk = 基础 4 + 武器加成），不与当层表比——
      // 带着旧武器下层的英雄仍能拾取本层更好的掉落。
      if (power > next.hero.atk - 4) {
        next.hero.atk = 4 + power
        next.hero.weapon = item.name
        delete tile.item
        next.events.push(`装备 ${item.name}（攻击 → ${next.hero.atk}）`)
      } else {
        next.events.push(`你掂了掂${item.name}，还是继续用${next.hero.weapon}`)
      }
    } else {
      const power = item.power ?? 0
      if (power > next.hero.def) {
        next.hero.def = power
        next.hero.armor = item.name
        delete tile.item
        next.events.push(`装备 ${item.name}（防御 → ${next.hero.def}）`)
      } else {
        next.events.push(`你摸了摸${item.name}，还是继续穿${next.hero.armor}`)
      }
    }
  }
  // 陷阱（armed 陷阱踏上才判定，踩中即显形）。
  if (trapAt(next.seed, next.depth, tx, ty) && tile.trapSprung !== true) {
    tile.trapSprung = true
    const dmg = 2 + next.depth
    next.hero.hp -= dmg
    next.events.push(`踩中陷阱！尖刺从地面弹出（-${dmg} HP），英雄剩 ${Math.max(0, next.hero.hp)}/${next.hero.maxHp}`)
    if (next.hero.hp <= 0) {
      next.hero.hp = 0
      next.finished = true
      next.winner = 'world'
      next.events.push('英雄倒下了……地下城吞噬了冒险者')
    }
  }
}

/** 英雄攻击：±1 浮动，架势防御减半；击杀结算掉落（金币恒掉、20% 药水）。 */
function heroAttack(next: DungeonState): void {
  const monster = engagedMonsterOf(next)
  if (monster === undefined) {
    throw new Error('英雄面前没有怪物——先移动到怪物格才能攻击')
  }
  const raw = next.hero.atk + roll3(next, 0xa1, 0x5a)
  const dmg = monster.braced === true ? Math.max(1, Math.floor(raw / 2)) : Math.max(1, raw)
  const wasBraced = monster.braced === true
  monster.braced = false
  monster.hp -= dmg
  if (monster.hp > 0) {
    next.events.push(`英雄命中 ${monster.name}（-${dmg}${wasBraced ? '，被架势化解了一半' : ''}），${monster.name} 剩 ${monster.hp} HP`)
    return
  }
  monster.hp = 0
  next.events.push(`英雄命中 ${monster.name}（-${dmg}），${monster.name} 倒下了`)
  const tile = next.tiles[keyOf(next.hero.x, next.hero.y)]!
  delete tile.monster
  // 掉落：金币恒掉，药水 20%。
  const gold = 3 + next.depth + Math.floor(roll01(next, 0x61, 0x16) * 4)
  next.hero.gold += gold
  next.events.push(`${monster.name} 掉落 ${gold} 金币`)
  if (roll01(next, 0x0d, 0x09) < LOOT_POTION) {
    next.hero.potions += 1
    next.events.push(`${monster.name} 掉落 治疗药水（现有 ${next.hero.potions} 瓶）`)
  }
  if (monster.boss === true && next.depth === MAX_DEPTH) {
    next.finished = true
    next.winner = 'hero'
    next.events.push(`英雄斩杀 ${BOSS_NAME}，携 ${next.hero.gold} 金币凯旋——地牢爬行通关！`)
  }
}

/** 英雄喝药：+12 HP（不超上限）；战斗中喝药把回合让给怪物。 */
function heroDrink(next: DungeonState): void {
  if (next.hero.potions <= 0) {
    throw new Error('没有治疗药水了')
  }
  if (next.hero.hp >= next.hero.maxHp) {
    throw new Error(`英雄状态良好（${next.hero.hp}/${next.hero.maxHp}），不需要喝药`)
  }
  next.hero.potions -= 1
  const healed = Math.min(next.hero.maxHp, next.hero.hp + POTION_HEAL) - next.hero.hp
  next.hero.hp += healed
  next.events.push(`英雄喝下治疗药水（+${healed} HP，剩 ${next.hero.hp}/${next.hero.maxHp}）`)
}

/** 英雄下楼：弃当前层揭示（楼梯坍塌，无回溯），新层入口重揭示。 */
function heroDescend(next: DungeonState): void {
  const tile = next.tiles[keyOf(next.hero.x, next.hero.y)]
  if (tile?.kind !== 'stairs') {
    throw new Error('这里没有向下的石阶——找到 🪜 才能下楼')
  }
  if (next.depth >= MAX_DEPTH) {
    throw new Error(`地下 ${MAX_DEPTH} 层的石阶尽头是${BOSS_NAME}的巢穴——击败它即是通关`)
  }
  next.depth += 1
  next.hero.x = 1
  next.hero.y = 1
  next.tiles = {}
  revealAround(next, carveFloor(next.seed, next.depth))
  next.events.push(`英雄沿石阶下行，来到地下 ${next.depth} 层；身后的楼梯轰然坍塌`)
}

/** 怪物回合三择：attack / heavy（35% 落空、命中 ×2）/ defend（下一击减半）。 */
function worldAct(next: DungeonState, action: Record<string, unknown>): void {
  const monster = engagedMonsterOf(next)
  if (monster === undefined) {
    throw new Error('当前没有与英雄接战的怪物')
  }
  const kind = action.type
  if (kind === 'attack') {
    const base = monster.atk + roll3(next, 0x3a, 0xa3) - next.hero.def
    const dmg = Math.max(1, base)
    next.hero.hp -= dmg
    next.events.push(`${monster.name} 击中英雄（-${dmg}），英雄剩 ${Math.max(0, next.hero.hp)}/${next.hero.maxHp}`)
  } else if (kind === 'heavy') {
    if (roll01(next, 0xee, 0xfe) < HEAVY_MISS) {
      next.events.push(`${monster.name} 蓄力猛击，却被英雄侧身闪过！`)
    } else {
      const base = monster.atk + roll3(next, 0x3b, 0xb3) - next.hero.def
      const dmg = Math.max(2, base * 2)
      next.hero.hp -= dmg
      next.events.push(`${monster.name} 全力猛击命中（-${dmg}），英雄剩 ${Math.max(0, next.hero.hp)}/${next.hero.maxHp}`)
    }
  } else if (kind === 'defend') {
    monster.braced = true
    next.events.push(`${monster.name} 收紧身形，摆出防御架势`)
    return
  } else {
    throw new Error(`不支持的动作类型「${String(kind)}」：world 只实现 attack/heavy/defend（resign 由运行时统一处理）`)
  }
  if (next.hero.hp <= 0) {
    next.hero.hp = 0
    next.finished = true
    next.winner = 'world'
    next.events.push('英雄倒下了……地下城吞噬了冒险者')
  }
}

/* ------------------------------ 引擎面 ------------------------------ */

/** applyAction 的工作态：clone 后逐动作填充（events 先挂后串）。 */
interface WorkState extends DungeonState {
  events: string[]
}

function freshHero(): Hero {
  return { x: 1, y: 1, hp: 30, maxHp: 30, atk: 4, def: 0, potions: 3, gold: 0, weapon: '木棍', armor: '布衣' }
}

const engine: GameEngine = {
  meta: MANIFEST,

  /** 开局：地下 1 层，入口 (1,1) 揭示半径 2；options.seed（正整数）可复现。 */
  createGame(options?: unknown): { state: DungeonState } {
    const seedOption = (options as { seed?: unknown } | undefined)?.seed
    const seed = typeof seedOption === 'number' && Number.isInteger(seedOption) && seedOption > 0
      ? seedOption
      : randomInt(1, 0x7fffffff)
    const state: DungeonState = {
      turn: 'hero',
      seed,
      rolls: 0,
      depth: 1,
      hero: freshHero(),
      tiles: {},
      finished: false,
      winner: null,
    }
    revealAround(state, carveFloor(seed, 1))
    return { state }
  },

  legalActions(state: DungeonState): Array<Record<string, unknown>> {
    if (state.finished) return []
    const plan = carveFloor(state.seed, state.depth)
    const actions: Array<Record<string, unknown>> = []
    if (state.turn === 'hero') {
      for (const dir of ['up', 'down', 'left', 'right'] as const) {
        const [dx, dy] = DIR_DELTA[dir]
        if (isCarved(plan, state.hero.x + dx!, state.hero.y + dy!)) {
          actions.push({ type: 'move', dir })
        }
      }
      if (engagedMonsterOf(state) !== undefined) actions.push({ type: 'attack' })
      if (state.hero.potions > 0 && state.hero.hp < state.hero.maxHp) actions.push({ type: 'drink' })
      const tile = state.tiles[keyOf(state.hero.x, state.hero.y)]
      if (tile?.kind === 'stairs' && state.depth < MAX_DEPTH) actions.push({ type: 'descend' })
    } else {
      if (engagedMonsterOf(state) !== undefined) {
        actions.push({ type: 'attack' }, { type: 'heavy' }, { type: 'defend' })
      }
    }
    return actions
  },

  applyAction(state: DungeonState, action: unknown, actor: string): ApplyResult {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('动作必须是 JSON 对象')
    }
    const typed = action as { type?: unknown }
    if (typeof typed.type !== 'string' || typed.type === '') {
      throw new Error('动作缺少 type 字段')
    }
    if (typed.type === 'resign') {
      throw new Error('resign 是保留动作，由运行时统一处理（引擎不实现）')
    }
    if (state.finished) {
      throw new Error(`对局已结束（${state.winner === 'hero' ? '英雄通关' : '英雄倒下'}），不能再行动`)
    }
    if (actor !== 'hero' && actor !== 'world') {
      throw new Error(`未知角色「${String(actor)}」：本游戏角色为 hero/world`)
    }
    if (actor !== state.turn) {
      throw new Error(actor === 'hero' ? '现在轮到地下城主（world）行动，英雄不能移动' : '现在轮到英雄（hero）行动，怪物不能出手')
    }

    const next = cloneState(state) as WorkState
    next.events = []
    if (actor === 'hero') {
      if (typed.type === 'move') heroMove(next, typed as Record<string, unknown>)
      else if (typed.type === 'attack') heroAttack(next)
      else if (typed.type === 'drink') heroDrink(next)
      else if (typed.type === 'descend') heroDescend(next)
      else throw new Error(`不支持的动作类型「${typed.type}」：hero 只实现 move/attack/drink/descend（resign 由运行时统一处理）`)
    } else {
      worldAct(next, typed as Record<string, unknown>)
    }
    settleTurn(next, actor)
    const events = next.events
    delete (next as Partial<WorkState>).events
    return { state: next, events, finished: next.finished, winner: next.winner, summary: events.join('，') }
  },

  /** 落子前局面上的可叙述文案（narration 素材，sessions 在 applyAction 之前取）。 */
  describe(state: DungeonState, actor: string, action: unknown): string {
    if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
      const typed = action as { type?: unknown; dir?: unknown }
      if (typeof typed.type !== 'string') return `${String(actor)} 的动作未被本引擎识别`
      if (typed.type === 'move') {
        const dir = typeof typed.dir === 'string' && typed.dir in DIR_DELTA ? typed.dir as Dir : null
        return dir === null ? '英雄踏出探索的一步' : `英雄向${DIR_CN[dir]}探索`
      }
      if (typed.type === 'attack') {
        const monster = engagedMonsterOf(state)
        if (actor === 'hero') return monster === undefined ? '英雄挥剑劈空' : `英雄挥剑斩向${monster.name}`
        return monster === undefined ? '怪物扑向英雄' : `${monster.name}向英雄发起攻击`
      }
      if (typed.type === 'heavy') {
        const monster = engagedMonsterOf(state)
        return monster === undefined ? '怪物蓄力猛击' : `${monster.name}蓄力猛击`
      }
      if (typed.type === 'defend') {
        const monster = engagedMonsterOf(state)
        return monster === undefined ? '怪物摆出防御架势' : `${monster.name}收紧身形防御`
      }
      if (typed.type === 'drink') return '英雄摸出治疗药水'
      if (typed.type === 'descend') return '英雄沿石阶下探更深的黑暗'
      return `${String(actor)} 的动作未被本引擎识别`
    }
    return `${String(actor)} 的动作未被本引擎识别`
  },
}

export const manifest: GameManifest = MANIFEST
export { engine as dungeonCrawlEngine }

/**
 * 测试探针（供 games-dungeon-crawl.spec.ts 取证——镜像大富翁导出 tiles/
 * chanceCards 的纪律：导出只读数据面，不导出行为）。carveInfo 让测试能对任意
 * seed/depth 做 BFS 寻路构造受控局面；trapAt/contentAt 支撑防偷看不变式用例。
 */
export const dungeonProbe = {
  carveInfo(seed: number, depth: number): { size: number; entrance: { x: number; y: number }; stairs: { x: number; y: number }; carved: string[] } {
    const plan = carveFloor(seed, depth)
    return { size: plan.carved.size, entrance: { x: 1, y: 1 }, stairs: { x: plan.stairs.x, y: plan.stairs.y }, carved: [...plan.carved] }
  },
  trapAt,
  contentAt: contentClassAt,
  monsterAt,
  itemAt,
} as const

/* ------------------------------ 内联视图（§3.3） ------------------------------ */

/** 预览局面（无 token）：模块期由引擎真实生成（seed 1 开局态），与引擎零漂移。 */
function previewPayload(): Record<string, unknown> {
  const { state } = engine.createGame({ seed: 1 })
  return { state, turn: 'hero', legal: engine.legalActions(state), finished: false, summary: '静态预览（无 token）' }
}

const PREVIEW_JSON = JSON.stringify(previewPayload())

export const viewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>地牢爬行 · dsh-soulmojito 游戏桥</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    background: #14120f; color: #e8e2d4;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
  }
  header { width: 100%; max-width: 360px; display: flex; justify-content: space-between; font-size: 14px; padding-bottom: 6px; }
  .session-id { color: #9a9184; font-size: 11px; font-variant-numeric: tabular-nums; }
  #stats { width: 100%; max-width: 360px; display: flex; align-items: center; gap: 8px; font-size: 12px;
    background: #1e1b16; border: 1px solid #3a352b; border-radius: 6px; padding: 6px 8px; }
  .hp-wrap { flex: 1; min-width: 80px; }
  .hp-bar { height: 8px; border-radius: 4px; background: #31281f; overflow: hidden; margin-top: 3px; }
  .hp-fill { height: 100%; background: linear-gradient(90deg, #a23333, #c4553d); width: 100%; }
  .stat { color: #c9bfa8; white-space: nowrap; }
  #banner { width: 100%; max-width: 360px; border: 1px solid #3a352b; background: #1e1b16; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; text-align: center; margin: 8px 0; line-height: 1.5; }
  #banner.world { color: #e0996a; }
  #banner.over { color: #d4b95e; }
  #board-wrap { position: relative; width: 100%; max-width: 360px; }
  #board { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; width: 100%; }
  .cell {
    aspect-ratio: 1; min-height: 0; border-radius: 3px; font-size: 13px; line-height: 1;
    display: flex; align-items: center; justify-content: center; user-select: none;
    background: #0c0a08; overflow: hidden;
  }
  .cell.wall { background: #2e2a22; box-shadow: inset 0 0 0 1px #241f18; }
  .cell.floor { background: #221e17; box-shadow: inset 0 0 0 1px #2d2820; }
  .cell.stairs { background: #33290f; box-shadow: inset 0 0 0 1px #57431a; }
  .cell.hero-at { outline: 2px solid #d4b95e; outline-offset: -2px; z-index: 1; }
  .cell.engage { outline: 2px solid #c4553d; outline-offset: -2px; }
  /* 事件提示栈（2026-10-16 用户需求「攻击等交互事件应弹出显眼提示」）：
     每次局面变化把该手 summary 以浮层提示弹出——遭遇/倒下/陷阱加重为 danger、
     通关/终局为 finale；2.8s 后淡出，栈内至多 3 条。 */
  /* 事件提示栈（2026-10-16 用户需求「攻击等交互事件应弹出显眼提示」）：地图内
     浮层、**底部锚定**（绝对定位零布局位移——文档流位会随提示增删把操作栏推上
     推下、界面抖动，用户实弹反馈后回位地图内；对照初版顶部锚定挡住入口区，
     底部锚定让左上入口与早期探索区全程无遮挡，3 条封顶 + 2.8s 淡出控制占地）：
     遭遇/倒下/陷阱加重为 danger、通关为 finale。 */
  #dc-toast-stack { position: absolute; bottom: 6px; left: 0; right: 0; display: flex;
    flex-direction: column; align-items: center; gap: 4px; pointer-events: none; z-index: 5; }
  .dc-toast { background: rgba(18, 14, 9, 0.88); border: 1px solid #57431a; color: #f0dfae;
    padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); text-align: center; max-width: 92%;
    animation: dc-toast-in 0.18s ease-out, dc-fade-out 0.5s ease-in 2.8s forwards; }
  .dc-toast.danger { border-color: #c4553d; color: #ffbca8; }
  .dc-toast.finale { border-color: #d4b95e; color: #ffe9a8; box-shadow: 0 0 14px rgba(212, 185, 94, 0.35); }
  /* 飘字伤害数字：英雄受击红 / 怪物受创橙 / 治疗绿 / 击杀骷髅，随格位上浮消散。 */
  .dc-float-num { position: absolute; z-index: 6; font-weight: 800; font-size: 15px; pointer-events: none;
    text-shadow: 0 1px 2px #000; animation: dc-rise 1.1s ease-out forwards; }
  .dc-float-num.hurt { color: #ff5b5b; }
  .dc-float-num.dmg { color: #ff8f6b; }
  .dc-float-num.heal { color: #7fe08a; }
  @keyframes dc-rise { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-26px); } }
  @keyframes dc-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes dc-fade-out { to { opacity: 0; } }
  #controls { width: 100%; max-width: 360px; display: flex; gap: 10px; margin-top: 10px; justify-content: space-between; }
  .pad { display: grid; grid-template-columns: repeat(3, 40px); grid-template-rows: repeat(2, 34px); gap: 4px; }
  .pad button, #actions button {
    border: 1px solid #4a4335; background: #262117; color: #e8e2d4; border-radius: 6px;
    font-size: 15px; cursor: pointer;
  }
  .pad button:disabled, #actions button:disabled { opacity: 0.35; cursor: default; }
  .pad button:not(:disabled):hover, #actions button:not(:disabled):hover { background: #35301f; }
  .pad .blank { visibility: hidden; }
  #actions { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  #actions button { font-size: 13px; padding: 0 8px; text-align: left; }
  .k { display: inline-block; margin-left: 6px; padding: 0 5px; border: 1px solid #6a5f45; border-radius: 4px;
    font-size: 10px; color: #b3a888; font-weight: 600; }
  footer { margin-top: 8px; font-size: 11px; color: #8d857a; text-align: center; width: 100%; max-width: 360px; line-height: 1.6; }
</style>
</head>
<body data-game="dsh-soulmojito.dungeon-crawl">
<header><span>🏰 地牢爬行</span><span class="session-id" id="session-id"></span></header>
<div id="stats">
  <div class="hp-wrap"><span id="hp-text" class="stat"></span><div class="hp-bar"><div class="hp-fill" id="hp-fill"></div></div></div>
  <span class="stat" id="stat-line"></span>
</div>
<div id="banner">等待对局…</div>
<div id="board-wrap">
  <div id="dc-toast-stack"></div>
  <div id="board"></div>
</div>
<div id="controls">
  <div class="pad">
    <span class="blank"></span><button id="btn-up" disabled>↑</button><span class="blank"></span>
    <button id="btn-left" disabled>←</button><button id="btn-down" disabled>↓</button><button id="btn-right" disabled>→</button>
  </div>
  <div id="actions">
    <button id="btn-attack" disabled>⚔️ 攻击<span class="k">J</span></button>
    <button id="btn-drink" disabled>🧪 喝药<span class="k">K</span></button>
    <button id="btn-descend" disabled>🪜 下楼<span class="k">L</span></button>
  </div>
</div>
<footer>踏入怪物格进入遭遇战，地下城主（AI）驱动怪物回合。<br>PC 键盘：WASD / 方向键移动 · J 攻击 · K 喝药 · L 下楼。<br>找到 🪜 下到地下 3 层，斩杀 🐲 炎魔君王即通关。</footer>
<script>
'use strict'
/* 桥协议（提案 0018 §3.3）：下行 dsh-soulmojito:game-state（token 对账）、
   上行 dsh-soulmojito:game-action。token 从 location.search 自读；无 token
   渲染静态预览（模块期由引擎真实生成的开局态）。 */
var params = new URLSearchParams(window.location.search)
var TOKEN = params.get('token')
var PREVIEW = ${PREVIEW_JSON}
var board = document.getElementById('board')
var boardWrap = document.getElementById('board-wrap')
var toastStack = document.getElementById('dc-toast-stack')
var banner = document.getElementById('banner')
var EMOJI_ITEM = { potion: '🧪', weapon: '⚔️', armor: '🛡️', gold: '💰' }
/* 上一帧指纹与血量锚点：局面真变化才弹提示/飘字（轮询重复下发不弹）。 */
var lastSeen = { fp: '', heroHp: -1, monHp: -1 }

function byId(id) { return document.getElementById(id) }

function send(action) {
  try { window.parent.postMessage({ type: 'dsh-soulmojito:game-action', token: TOKEN, action: action }, '*') } catch (_) {}
}

function bindDir(id, dir) {
  byId(id).addEventListener('click', function () { send({ type: 'move', dir: dir }) })
}
bindDir('btn-up', 'up'); bindDir('btn-down', 'down'); bindDir('btn-left', 'left'); bindDir('btn-right', 'right')
byId('btn-attack').addEventListener('click', function () { send({ type: 'attack' }) })
byId('btn-drink').addEventListener('click', function () { send({ type: 'drink' }) })
byId('btn-descend').addEventListener('click', function () { send({ type: 'descend' }) })

/* 事件提示：该手 summary 弹浮层（关键词分级），栈内至多 3 条、到点自清。 */
function toastClassOf(text) {
  if (text.indexOf('通关') >= 0) return 'finale'
  if (text.indexOf('遭遇') >= 0 || text.indexOf('陷阱') >= 0 || text.indexOf('倒下') >= 0) return 'danger'
  return ''
}
function showToast(text) {
  var host = document.createElement('div')
  var cls = toastClassOf(text)
  host.className = 'dc-toast' + (cls === '' ? '' : ' ' + cls)
  host.textContent = text
  toastStack.appendChild(host)
  while (toastStack.children.length > 3) toastStack.removeChild(toastStack.firstChild)
  setTimeout(function () { if (host.parentNode === toastStack) toastStack.removeChild(host) }, 3400)
}

/* 飘字伤害：按格位上浮（offsetLeft/offsetTop 相对定位锚 board-wrap），到点自清。 */
function floatNumber(x, y, text, cls) {
  var cell = board.children[y * 12 + x]
  if (cell === undefined || cell === null) return
  var host = document.createElement('div')
  host.className = 'dc-float-num ' + cls
  host.textContent = text
  host.style.left = (cell.offsetLeft + (cell.offsetWidth || 0) / 2 - 14) + 'px'
  host.style.top = (cell.offsetTop - 4) + 'px'
  boardWrap.appendChild(host)
  setTimeout(function () { if (host.parentNode === boardWrap) boardWrap.removeChild(host) }, 1200)
}

/* PC 键盘（2026-10-16 用户需求）：WASD/方向键移动、J/K/L 三动作——与按钮共用
   同一合法面（按钮 disabled 即不动作），带修饰键的组合不劫持（浏览器快捷键）。 */
var KEY_DIRS = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' }
var KEY_ACTIONS = { j: ['btn-attack', 'attack'], k: ['btn-drink', 'drink'], l: ['btn-descend', 'descend'] }
document.addEventListener('keydown', function (event) {
  if (!TOKEN || event.ctrlKey || event.altKey || event.metaKey) return
  var key = String(event.key || '').toLowerCase()
  var dir = KEY_DIRS[key]
  if (dir !== undefined) {
    var btnId = dir === 'up' ? 'btn-up' : dir === 'down' ? 'btn-down' : dir === 'left' ? 'btn-left' : 'btn-right'
    if (!byId(btnId).disabled) {
      event.preventDefault()
      send({ type: 'move', dir: dir })
    }
    return
  }
  var bound = KEY_ACTIONS[key]
  if (bound !== undefined && !byId(bound[0]).disabled) {
    event.preventDefault()
    send({ type: bound[1] })
  }
})

function fingerprint(state, view, monsterHere) {
  return [state.hero.x, state.hero.y, state.hero.hp, state.hero.potions, state.hero.gold,
    state.hero.atk, state.hero.def, view.turn, view.finished ? 1 : 0, monsterHere ? monsterHere.hp : ''].join('|')
}

function render(view, session, live) {
  var state = view.state
  var hero = state.hero
  var legal = {}
  for (var i = 0; i < (view.legal || []).length; i += 1) {
    var a = view.legal[i]
    if (a.type === 'move') legal[a.dir] = true
    else legal[a.type] = true
  }
  var monsterHere = state.tiles[hero.x + ',' + hero.y] && state.tiles[hero.x + ',' + hero.y].monster

  /* 事件提示与飘字（只在实时下行且局面真变化时——预览/重复轮询不弹）：
     HP 差分 → 英雄受击/治疗飘字、怪物受创/阵亡飘字；summary → 提示栈。 */
  var fp = fingerprint(state, view, monsterHere)
  if (live && lastSeen.fp !== '' && fp !== lastSeen.fp) {
    if (lastSeen.heroHp >= 0 && hero.hp !== lastSeen.heroHp) {
      floatNumber(hero.x, hero.y, hero.hp < lastSeen.heroHp ? String(lastSeen.heroHp - hero.hp) : '+' + String(hero.hp - lastSeen.heroHp),
        hero.hp < lastSeen.heroHp ? 'hurt' : 'heal')
    }
    if (lastSeen.monHp > 0) {
      if (monsterHere && monsterHere.hp < lastSeen.monHp) floatNumber(hero.x, hero.y, String(lastSeen.monHp - monsterHere.hp), 'dmg')
      else if (!monsterHere) floatNumber(hero.x, hero.y, '💀', 'dmg')
    }
    if (view.summary) showToast(view.summary)
  }
  lastSeen = { fp: fp, heroHp: hero.hp, monHp: monsterHere ? monsterHere.hp : -1 }

  byId('session-id').textContent = session ? session.id : ''
  byId('hp-text').textContent = 'HP ' + hero.hp + '/' + hero.maxHp
  byId('hp-fill').style.width = Math.max(0, Math.round(hero.hp * 100 / hero.maxHp)) + '%'
  byId('stat-line').textContent = '地下' + state.depth + '/3层 ⚔️' + hero.atk + ' 🛡️' + hero.def + ' 🧪×' + hero.potions + ' 💰' + hero.gold

  if (view.finished) {
    banner.className = 'over'
    banner.textContent = view.summary || '对局结束'
  } else if (monsterHere) {
    banner.className = ''
    banner.textContent = '⚔️ ' + monsterHere.name + ' ' + monsterHere.hp + '/' + monsterHere.maxHp +
      (view.turn === 'world' ? ' · 地下城主行动中…' : ' · 你的回合')
  } else if (view.turn === 'world') {
    banner.className = 'world'
    banner.textContent = '地下城主行动中…'
  } else {
    banner.className = ''
    banner.textContent = view.summary ? view.summary : '你的回合 · 探索地牢'
  }

  board.innerHTML = ''
  for (var y = 0; y < 12; y += 1) {
    for (var x = 0; x < 12; x += 1) {
      var cell = document.createElement('div')
      var tile = state.tiles[x + ',' + y]
      var text = ''
      cell.className = 'cell' + (tile ? ' ' + tile.kind : '')
      if (tile) {
        if (tile.monster) text += tile.monster.boss ? '🐲' : '👹'
        if (tile.item) text += EMOJI_ITEM[tile.item.kind] || '✨'
        if (tile.trapSprung) text += '🕳️'
        if (tile.kind === 'stairs' && !tile.monster) text += '🪜'
      }
      if (x === hero.x && y === hero.y) {
        text = '🧙' + text
        cell.className += monsterHere ? ' engage' : ' hero-at'
      }
      cell.textContent = text
      board.appendChild(cell)
    }
  }

  var myTurn = !view.finished && view.turn === 'hero'
  byId('btn-up').disabled = !(myTurn && legal.up)
  byId('btn-down').disabled = !(myTurn && legal.down)
  byId('btn-left').disabled = !(myTurn && legal.left)
  byId('btn-right').disabled = !(myTurn && legal.right)
  byId('btn-attack').disabled = !(myTurn && legal.attack)
  byId('btn-drink').disabled = !(myTurn && legal.drink)
  byId('btn-descend').disabled = !(myTurn && legal.descend)
}

window.addEventListener('message', function (event) {
  var data = event.data
  if (!data || data.type !== 'dsh-soulmojito:game-state' || data.token !== TOKEN) return
  render(data.view, data.session, true)
})

if (!TOKEN) {
  render(PREVIEW, null, false)
}
</script>
</body>
</html>
`

/** registry 装载形态：{manifest, engine, viewHtml} 三件套（内置源）。 */
export const dungeonCrawl = { manifest, engine, viewHtml } as const
