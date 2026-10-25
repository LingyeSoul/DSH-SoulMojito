/**
 * 游戏桥标准 v1 的类型与校验（提案 0018 §3，P0）。
 *
 * 「标准游戏」= 一个目录：game.json（清单）+ engine.mjs（纯逻辑 ESM）+
 * view.html（自包含渲染页）。本模块定义三件套的 TS 类型、清单校验、
 * 引擎 duck 校验与导入期一致性烟测（§4.6），是运行时（registry/sessions）
 * 与外部游戏包作者共享的契约面——标准不是文档，是可执行断言
 * （tests/games-builtin.spec.ts / games-import.spec.ts）。
 *
 * 契约要点（§3.2 硬约束）：
 * - state 任意时刻 deep-JSON-safe（持久与重放的根基），序列化上限 64KB；
 * - applyAction 同输入两次调用结果 deep-equal（确定性——需要随机的游戏用
 *   options.seed 自行派生确定性 RNG）；
 * - applyAction 对非法动作抛错而非静默（Node 权威，视图/Agent 不可作弊）；
 * - legalActions 是有界**建议集**（≤64），不是合法性依据——applyAction 按
 *   全量规则终审任意动作（§9 摩擦 3 的措辞修正）；
 * - 保留动作 type 'resign' 由运行时统一处理，引擎收到必须抛错。
 *
 * 运行时补充契约（提案未明文、actor 推导所需——见 sessions.ts 文件头）：
 * state 顶层必须携带字符串字段 `turn`，值为当前行棋方的角色名
 * （五子棋/井字棋参照实现均如此）。烟测对此做强制校验。
 */

import { MOD_ID_PATTERN } from '../mods/manifest.js'

/** 游戏来源（提案 §4.5 三源）：内置 / 导入目录 / Mod 注册（P3 接线）。 */
export type GameSource = 'builtin' | 'imported' | 'mod'

/** 会话中的执子归属：人类（浏览器侧）或 Agent（工具侧）。 */
export type GameOwner = 'human' | 'agent'

/** 清单 game.json（§3.1）。运行时以 engine.meta 的同形冗余为准（§6）。 */
export interface GameManifest {
  /** 反域名（同 Mod 纪律）；导入目录名必须等于 id。 */
  id: string
  name: string
  version: string
  /** 宿主版本门控（复用 satisfiesVersionRange 的范围语法）。改名兼容
   * （2026-10-16）：旧键 `dsh-tavern` 双读，新写入恒用新键。 */
  engines?: { 'dsh-soulmojito'?: string; 'dsh-tavern'?: string }
  players: { min: number; max: number; roles: string[] }
  /** v1 恒真（实时游戏明确裁剪，提案 §3.1/§7-3）。 */
  turnBased: boolean
  /** 写给人/模型看的一句话动作词汇表（§3.4）。 */
  actionVocabulary: string
}

/** 动作 = 游戏自定义 JSON 对象；标准只规定 JSON-safe、≤4KB、必须有 type（§3.4）。 */
export interface GameAction {
  type: string
  [key: string]: unknown
}

/** applyAction 的返回形态（§3.2）。 */
export interface GameApplyResult {
  state: unknown
  events: string[]
  finished: boolean
  winner: string | null
  summary: string
}

/** 引擎契约（§3.2）：无状态纯函数对象，engine.mjs 默认导出。 */
export interface GameEngine {
  meta: GameManifest
  createGame(options?: unknown): { state: unknown }
  legalActions(state: unknown): GameAction[]
  applyAction(state: unknown, action: unknown, actor: string): GameApplyResult
  describe(state: unknown, actor: string, action: unknown): string
}

export type GameManifestCheck =
  | { ok: true; manifest: GameManifest; errors: string[] }
  | { ok: false; manifest?: undefined; errors: string[] }

/** state 序列化上限（§3.2：64KB；棋盘类天然满足，防滥用）。 */
export const GAME_STATE_MAX_BYTES = 65_536
/** 单动作序列化上限（§3.4：4KB）。 */
export const GAME_ACTION_MAX_BYTES = 4_096
/** 建议集上限（§3.2：≤64）。 */
export const GAME_LEGAL_ACTIONS_MAX = 64

/** 会话 id 形如 `g-<8 位十六进制>`（sessions.ts 生成）。 */
export const GAME_SESSION_ID_PATTERN = /^g-[0-9a-f]{8}$/

/**
 * 清单结构校验（§4.6 第一关）：字段/类型/players 范围/turnBased。
 * directory 传入时额外要求 id === 目录名（镜像 mod.json 纪律）。
 */
export function checkGameManifest(raw: unknown, options: { directory?: string } = {}): GameManifestCheck {
  const errors: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['game.json must be a JSON object'] }
  }
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') errors.push('id must be a non-empty string')
  else if (!MOD_ID_PATTERN.test(value.id)) errors.push('id must be [a-z0-9-] labels or reverse-domain joined by \'.\'')
  else if (options.directory !== undefined && value.id !== options.directory) {
    errors.push(`id '${value.id}' must equal the directory name '${options.directory}'`)
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') errors.push('name must be a non-empty string')
  if (typeof value.version !== 'string' || value.version.trim() === '') errors.push('version must be a non-empty string')
  if (value.engines !== undefined) {
    if (value.engines === null || typeof value.engines !== 'object' || Array.isArray(value.engines)) {
      errors.push('engines must be an object')
    } else {
      for (const key of ['dsh-soulmojito', 'dsh-tavern'] as const) {
        const range = (value.engines as Record<string, unknown>)[key]
        if (range !== undefined && typeof range !== 'string') {
          errors.push(`engines.${key} must be a version range string`)
        }
      }
    }
  }
  const players = value.players
  if (players === null || typeof players !== 'object' || Array.isArray(players)) {
    errors.push('players must be an object { min, max, roles }')
  } else {
    const spec = players as { min?: unknown; max?: unknown; roles?: unknown }
    const min = spec.min
    const max = spec.max
    if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 1 || (max as number) < (min as number)) {
      errors.push('players.min/max must be integers with 1 <= min <= max')
    }
    if (!Array.isArray(spec.roles) || spec.roles.length === 0 || !spec.roles.every((role) => typeof role === 'string' && role !== '')) {
      errors.push('players.roles must be a non-empty array of non-empty strings')
    } else if (Number.isInteger(max) && spec.roles.length !== max) {
      errors.push(`players.roles length (${spec.roles.length}) must equal players.max (${String(max)})`)
    }
    if (Array.isArray(spec.roles) && new Set(spec.roles.map(String)).size !== spec.roles.length) {
      errors.push('players.roles must not contain duplicates')
    }
  }
  // v1 明确裁剪实时游戏（提案 §3.1/§7-3）：turnBased 恒真，声明 false 直接拒。
  if (value.turnBased !== true) errors.push('turnBased must be true (real-time games are out of scope for bridge v1)')
  if (typeof value.actionVocabulary !== 'string' || value.actionVocabulary.trim() === '') {
    errors.push('actionVocabulary must be a non-empty string')
  }
  if (errors.length > 0) return { ok: false, errors }
  // Every field above is validated; this narrows the record for the manifest literal.
  const playersSpec = players as { min: number; max: number; roles: string[] }
  return {
    ok: true,
    errors,
    manifest: {
      id: value.id as string,
      name: value.name as string,
      version: value.version as string,
      ...(value.engines === undefined ? {} : { engines: value.engines as GameManifest['engines'] }),
      players: { min: playersSpec.min, max: playersSpec.max, roles: [...playersSpec.roles] },
      turnBased: true,
      actionVocabulary: value.actionVocabulary as string,
    },
  }
}

export type GameEngineCheck =
  | { ok: true; engine: GameEngine; errors: string[] }
  | { ok: false; engine?: undefined; errors: string[] }

/** 引擎 duck 校验：默认导出对象带合法 meta + 四个函数面（§3.2）。 */
export function checkGameEngine(candidate: unknown): GameEngineCheck {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['engine.mjs must default-export an object'] }
  }
  const value = candidate as Record<string, unknown>
  const metaCheck = checkGameManifest(value.meta)
  const errors: string[] = []
  if (!metaCheck.ok) errors.push(`engine.meta invalid: ${metaCheck.errors.join('; ')}`)
  for (const member of ['createGame', 'legalActions', 'applyAction', 'describe'] as const) {
    if (typeof value[member] !== 'function') errors.push(`engine.${member} must be a function`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, engine: candidate as GameEngine, errors: [] }
}

/** 深度 JSON-safe 判定：stringify→parse 往返 deep-equal（函数/undefined/NaN 会现形）。 */
export function isJsonSafe(value: unknown): boolean {
  try {
    const text = JSON.stringify(value)
    // 顶层 undefined 序列化不出（函数/_symbol 同理直接 throw），一律不算 safe。
    if (typeof text !== 'string') return false
    return deepEqual(JSON.parse(text), value)
  } catch {
    return false
  }
}

/** 结构化 deep-equal（不依赖 vitest；烟测与运行时共用）。 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort()
  const rightKeys = Object.keys(right as Record<string, unknown>).sort()
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every((key) =>
    deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** JSON 序列化字节数（上限校验共用；不可序列化时返回 Infinity）。 */
export function jsonSizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * 读取 state 当前回合角色（运行时补充契约，见文件头）：state.turn 必须是
 * manifest.players.roles 中的字符串。actor 推导的唯一依据——客户端/工具
 * 不传 actor（提案 §4.1 会话运行时的服务端定案）。
 */
export function currentRoleOf(state: unknown, roles?: readonly string[]): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('引擎 state 必须是 JSON 对象（当前回合字段 turn 无法读取）')
  }
  const turn = (state as Record<string, unknown>).turn
  if (typeof turn !== 'string' || turn === '') {
    throw new Error('引擎 state 缺少字符串字段 turn（当前回合角色），无法推导行棋方')
  }
  if (roles !== undefined && !roles.includes(turn)) {
    throw new Error(`state.turn「${turn}」不在角色表 [${roles.join(', ')}] 内`)
  }
  return turn
}

/**
 * 棋盘坐标整数解析（决策 2026-10-14-quoted-coordinate-tolerance）：数字原样；
 * 整数的字符串形态（"1"、"1.0"、" 7 "——模型桥把工具参数数字写成引号串的
 * 实弹习惯）归一为数字；其余（小数、空串、非数文本、非安全整数）返回 null。
 * 坐标语义唯一——"1" 与 1 是同一交叉点，归一不改动作含义；界内/规则合法性
 * 仍由各引擎终审（本函数只管「是不是一个整数」）。
 */
export function parseBoardCoord(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return null
  const parsed = Number(text)
  return Number.isInteger(parsed) ? parsed : null
}

export interface GameSmokeResult {
  ok: boolean
  /** 失败原因（逐项，面向游戏包作者的可读中文）。 */
  reasons: string[]
}

/**
 * 导入期一致性烟测（提案 §4.6，五关）：
 * 1. createGame 出 JSON-safe 初始态（§3.2 硬约束）且 ≤64KB、turn 合法；
 * 2. legalActions 有界（≤64）且每个建议动作形如 {type: string}；
 * 3. 首个合法动作 applyAction 连打两次 deep-equal（确定性）+ 不改入参 state；
 * 4. 非法动作必须抛错（保留动作 resign + 未知 type 双探针）；
 * 5. apply 结果形状 {state, events, finished, winner, summary} 且新态 JSON-safe。
 *
 * 任一不过即拒绝装载（registry 以 status:'broken' 入册，不抛异常不崩启动
 * ——镜像 mods 的坏 Mod 不断路语义）。内置引擎同套烟测（标准面前人人平等）。
 */
export function smokeTestGameEngine(engine: GameEngine): GameSmokeResult {
  const reasons: string[] = []
  const roles = engine.meta.players.roles

  // 第 1 关：初始态 JSON-safe + 尺寸 + turn。
  let created: { state: unknown }
  try {
    created = engine.createGame({ seed: 1 })
  } catch (cause) {
    return { ok: false, reasons: [`createGame 抛错: ${errorMessage(cause)}`] }
  }
  if (created === null || typeof created !== 'object' || !('state' in created)) {
    return { ok: false, reasons: ['createGame 必须返回 { state } 形态'] }
  }
  const state = created.state
  if (!isJsonSafe(state)) reasons.push('初始 state 不是 deep-JSON-safe')
  if (jsonSizeOf(state) > GAME_STATE_MAX_BYTES) reasons.push(`初始 state 序列化超过 ${GAME_STATE_MAX_BYTES} 字节上限`)
  let turn: string
  try {
    turn = currentRoleOf(state, roles)
  } catch (cause) {
    reasons.push(errorMessage(cause))
    return { ok: false, reasons }
  }

  // 第 2 关：建议集有界且形状合法。
  let suggestions: GameAction[]
  try {
    suggestions = engine.legalActions(state)
  } catch (cause) {
    reasons.push(`legalActions 抛错: ${errorMessage(cause)}`)
    return { ok: false, reasons }
  }
  if (!Array.isArray(suggestions)) return { ok: false, reasons: ['legalActions 必须返回数组'] }
  if (suggestions.length > GAME_LEGAL_ACTIONS_MAX) {
    reasons.push(`legalActions 建议集超过 ${GAME_LEGAL_ACTIONS_MAX} 上限（收到 ${suggestions.length}）`)
  }
  for (const action of suggestions) {
    if (action === null || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || action.type === '') {
      reasons.push('legalActions 中存在缺少 type 字符串字段的建议动作（§3.4：动作必须有 type）')
      break
    }
  }
  if (suggestions.length === 0) {
    // 回合制游戏初始局面零建议动作 ⇒ 无法验证确定性，也意味着 Agent 无从落子。
    reasons.push('初始局面的建议集为空，无法进行确定性烟测（也意味着游戏无法开始）')
    return { ok: false, reasons }
  }

  // 第 3 关：首个合法动作连打两次 deep-equal（确定性）+ 入参不可变。
  const first = suggestions[0]!
  const snapshot = structuredClone(state)
  let firstResult: GameApplyResult
  let secondResult: GameApplyResult
  try {
    firstResult = engine.applyAction(state, first, turn)
    secondResult = engine.applyAction(state, first, turn)
  } catch (cause) {
    reasons.push(`applyAction 对建议集首个动作抛错: ${errorMessage(cause)}`)
    return { ok: false, reasons }
  }
  if (!deepEqual(firstResult, secondResult)) reasons.push('applyAction 同输入两次调用结果不一致（确定性硬约束不过）')
  if (!deepEqual(state, snapshot)) reasons.push('applyAction 修改了入参 state（必须深拷贝出新态）')

  // 第 5 关：结果形状与 JSON-safe。
  const shape = firstResult as Partial<GameApplyResult>
  if (shape.state === undefined || !Array.isArray(shape.events) || typeof shape.finished !== 'boolean') {
    reasons.push('applyAction 必须返回 { state, events, finished, winner, summary }')
  } else {
    if (!isJsonSafe(shape.state)) reasons.push('applyAction 产出的新 state 不是 deep-JSON-safe')
    if (jsonSizeOf(shape.state) > GAME_STATE_MAX_BYTES) reasons.push(`applyAction 产出的 state 超过 ${GAME_STATE_MAX_BYTES} 字节上限`)
    if (shape.winner !== null && typeof shape.winner !== 'string') reasons.push('applyAction 的 winner 必须是角色字符串或 null')
    if (typeof shape.summary !== 'string') reasons.push('applyAction 的 summary 必须是字符串')
  }

  // 第 4 关：非法动作必须抛错——保留动作 resign（运行时统一处理，引擎必须拒）
  // 与未知 type 双探针（镜像五子棋契约测试的非法动作面）。
  for (const probe of [{ type: 'resign' }, { type: '__dsh_soulmojito_smoke_unknown__' }]) {
    try {
      engine.applyAction(state, probe, turn)
      reasons.push(`applyAction 对非法动作 {type:'${probe.type}'} 未抛错（必须拒绝而非静默）`)
    } catch {
      // 抛错即通过本探针。
    }
  }

  return { ok: reasons.length === 0, reasons }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
