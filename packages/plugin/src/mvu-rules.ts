/**
 * MVU `$rules` 条件规则引擎（提案 0012 延伸，竞品参考 C-2，2026-10-11）。
 *
 * 语义参考 LittleWhiteBox variables varevent 的「条件规则在回合后排队执行」
 * （docs/exploration/2026-10-11-jsr-lwb-reference.md §3.2/§4 C-2；LWB 为
 * Apache-2.0，只复刻可观察语义，clean-room 重新实现，不复制代码）：卡内声明
 * 确定性条件规则，在变量结算（模板写穿 + `$schema` 守卫）之后做**二次计算**
 * ——派生值、阈值触发、连锁修正——产物进同一回执管线（reason 标 `rule:<name>`）。
 *
 * 声明形状（变量树根的 `$rules` 子树，与 `$schema` 同链路同优先级读取、同剥离
 * 纪律——`$rules` 不作为变量结算/渲染/投影）：
 *
 *     "$rules": [
 *       {
 *         "name": "favor-unlock",                  // ≤64 字符，规则回执归因键
 *         "when": "getvar('mvu.favor') >= 80",      // 表达式，求值为布尔
 *         "then": {                                 // 路径 → 表达式或 JSON 字面量
 *           "mvu.flags.trusted": "true",            // 表达式（字符串）
 *           "mvu.debt": "getvar('mvu.debt') * 0.5", // 派生计算
 *           "mvu.mood": "calm"                      // JSON 字面量（字符串枚举值）
 *         }
 *       }
 *     ]
 *
 * - 表达式求值复用 `@dsh-tavern/template` 的沙箱设施（`evalExpressionSandboxed`：
 *   node:vm 全新 context、同步纯构造、无 require/process/timer/网络）；变量访问
 *   以嵌套树语义暴露 `vars`（嵌套对象）与 `getvar('<dotted.path>')` 两个入口，
 *   每次求值深拷贝工作树——表达式无法借 `vars` 引用绕过守卫直写。
 * - **确定性强制**：沙箱面收紧——`Date`/timer 以 undefined 遮蔽、`Math` 换成
 *   去掉 random 的冻结白名单视图。规则不进冻结 prompt 上下文，只需结算可复现，
 *   沙箱面收紧即可，无需源码静态筛查（取舍记录见决策文档）。
 * - **执行时机**：守卫 pass 之后、回执 diff 之前——规则在守卫后的树上做二次
 *   计算，规则产出**再过一次守卫**：clamp 调整进正常回执（reason 标注
 *   `rule:<name>` + guard note），reject 进失败项（`${path}: rule '<name>':
 *   guard <kind>: <reason>`，可重试）——对齐 C-1 守卫既有语义。
 * - **链式求值 + 有界不动点**：规则按声明序对工作副本求值，前一规则的效果对
 *   后续规则可见；一轮内产生了实际变更则再跑一轮，最多 {@link MVU_RULE_ROUNDS}
 *   轮（防互触发死循环）；到上限仍在变更 → 警告进回执 failures，如实记录。
 * - **失败纪律与 templateWarnings 同款**：`when`/`then` 求值抛错 → 该规则本轮
 *   跳过 + 警告进 failures（不炸结算）；`$rules` 形状非法 → 整卡规则失效 +
 *   警告（不炸结算）。无 `$rules` 的卡恒等返回，行为与 C-2 之前逐字节一致。
 * - 撤销交互（B-6a）：规则产生的变更与模板写穿变更同回执同字段，撤销恢复
 *   before 值即可；撤销后若条件仍满足，下次结算规则重触发——语义正确行为。
 */

import {
  deepClone,
  evalExpressionSandboxed,
} from '../../tavern-template/src/index.js'
import type { CharacterCardIR, ChatLogIR } from '../../tavern-format/src/index.js'
import {
  getMvuTreePath,
  guardMvuWrite,
  mvuValuesEqual,
  readMvuSchema,
  stripMvuControl,
} from './mvu-guard.js'

/** 单条卡内声明的条件规则。 */
export interface MvuSettlementRule {
  name: string
  when: string
  /** 路径 → 表达式字符串或 JSON 字面量（非字符串值直接作为字面量写入）。 */
  then: Record<string, unknown>
}

/** 读取结果：规则列表 / 形状非法（整卡失效）/ 未声明（恒等，golden 锁死）。 */
export type MvuRulesSource = { rules: MvuSettlementRule[] } | { invalid: string }

/** 链式求值的轮数上限（有界不动点）。 */
export const MVU_RULE_ROUNDS = 3

/** 单卡规则条数上限（与 settle 工具单批 16 项同量级的结算工作界）。 */
export const MVU_RULES_LIMIT = 32

/** 单规则 then 写入路径数上限。 */
export const MVU_RULE_THEN_LIMIT = 16

/* ------------------------------ 规则读取 ------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const INITIAL_VARIABLES_KEY = 'initial_variables'

function cardRules(card: CharacterCardIR | undefined): unknown {
  const holder = card?.data?.extensions?.['agentTavern']
  if (!isPlainObject(holder)) return undefined
  return holder.initialVariables?.$rules
}

function treeRules(tree: unknown): unknown {
  return isPlainObject(tree) ? tree.$rules : undefined
}

/** 校验 $rules 原始树（数组）为规则列表；任何一项非法 → 整卡失效（invalid）。 */
function validateMvuRules(raw: unknown): MvuSettlementRule[] {
  if (!Array.isArray(raw)) throw new Error('$rules must be an array of rule objects')
  if (raw.length === 0) return []
  if (raw.length > MVU_RULES_LIMIT) {
    throw new Error(`$rules declares ${raw.length} rules, over the cap of ${MVU_RULES_LIMIT}`)
  }
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`rule #${index} is not an object`)
    const { name, when, then } = entry
    if (typeof name !== 'string' || name.trim() === '' || name.length > 64) {
      throw new Error(`rule #${index} requires a non-empty name of at most 64 characters`)
    }
    if (typeof when !== 'string' || when.trim() === '') {
      throw new Error(`rule '${name}' requires a non-empty when expression`)
    }
    if (!isPlainObject(then) || Object.keys(then).length === 0) {
      throw new Error(`rule '${name}' requires a non-empty then map`)
    }
    if (Object.keys(then).length > MVU_RULE_THEN_LIMIT) {
      throw new Error(`rule '${name}' declares ${Object.keys(then).length} then writes, over the cap of ${MVU_RULE_THEN_LIMIT}`)
    }
    for (const [path, value] of Object.entries(then)) {
      if (path.trim() === '') throw new Error(`rule '${name}' has an empty then path`)
      if (typeof value === 'string') {
        if (value.trim() === '') throw new Error(`rule '${name}' has an empty then expression for '${path}'`)
      } else if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error(`rule '${name}' then value for '${path}' is not a JSON literal`)
      }
    }
    return { name, when, then }
  })
}

/**
 * 规则来源（与 readMvuSchema 同链路同优先级，先到先得）：
 * 1. 聊天变量树根 `$rules`（**基线**树——结算写穿不可自改规则，与 C-1 的
 *    「schema 取基线」同纪律）；
 * 2. 卡 `data.extensions.agentTavern.initialVariables.$rules`（0013 工作台/
 *    card_apply_mvu 产物；覆盖规则上卡前创建的旧聊天与 flat store 持有变量的
 *    AgentTavern 聊天——variablesOverride 传聊天播种树即此路径）；
 * 3. `chat_metadata.initial_variables.$rules`（世界书 [InitialVariables] 携带）。
 *
 * 空数组跳过（与 readMvuSchema 的「空对象跳过」同款，先到先得的下一来源继续）；
 * 形状非法返回 `{ invalid }`。
 */
export function readMvuRules(
  chat: ChatLogIR,
  card?: CharacterCardIR,
  variablesOverride?: Record<string, unknown>,
): MvuRulesSource | undefined {
  const candidates = [
    treeRules(variablesOverride ?? (chat?.header?.chat_metadata?.variables as unknown)),
    cardRules(card),
    treeRules(chat?.header?.chat_metadata?.[INITIAL_VARIABLES_KEY]),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      const rules = validateMvuRules(candidate)
      if (rules.length === 0) continue
      return { rules }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { invalid: `$rules: ${message}; all card rules are disabled for this settlement` }
    }
  }
  return undefined
}

/* --------------------------- 确定性沙箱面 --------------------------- */

/**
 * 结算可复现的沙箱面：`Date` 与 timer 以 undefined 遮蔽（with 域内访问即抛
 * TypeError → 规则按求值失败跳过），`Math` 换成去掉 random 的冻结白名单视图。
 * 与宏/模板的静态纪律对齐；vm context 的 Function 构造器逃逸不在威胁模型内
 * （与 tavern-template 同教义：不承诺对抗恶意模板，卡作者是信任方）。
 */
const SAFE_MATH_KEYS = [
  'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2',
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil',
  'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'hypot', 'imul', 'log', 'log1p',
  'log2', 'log10', 'max', 'min', 'pow', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan',
  'tanh', 'trunc',
] as const

const SAFE_MATH: Record<string, unknown> = Object.freeze(
  Object.fromEntries(SAFE_MATH_KEYS.map((key) => [key, (Math as unknown as Record<string, unknown>)[key]])),
)

const RULE_SANDBOX_SHADES: Record<string, unknown> = {
  Math: SAFE_MATH,
  Date: undefined,
  setTimeout: undefined,
  setInterval: undefined,
  setImmediate: undefined,
  queueMicrotask: undefined,
}

/** 构造规则表达式求值的 env：工作树深拷贝（剥离控制子树）+ 确定性遮蔽。 */
function buildRuleEnv(tree: Record<string, unknown>): Record<string, unknown> {
  const vars = deepClone(stripMvuControl(tree)) as Record<string, unknown>
  return {
    vars,
    getvar: (path: unknown) => (typeof path === 'string' ? getMvuTreePath(vars, path) : undefined),
    ...RULE_SANDBOX_SHADES,
  }
}

/* ------------------------------ 求值核 ------------------------------ */

/** 单条已应用规则写入（AgentTavern 侧据此持久化到 flat store 并入回执）。 */
export interface MvuRuleWrite {
  path: string
  value: unknown
  rule: string
  /** 该写入被守卫 clamp/step 调整时的说明（与 rule 名一并进回执 reason）。 */
  guardNote?: string
}

export interface MvuRuleRunResult {
  /** 警告/守卫拒绝/轮数上限告警（进回执 failures，与 templateWarnings 同纪律）。 */
  failures: string[]
  /** 实际改变了值的写入，按应用序（同名路径后写覆盖前写）。 */
  writes: MvuRuleWrite[]
  /** 路径 → `rule:<name>`（含 guard note），多次触发同路径按序拼接。 */
  notes: Record<string, string>
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function setTreePath(tree: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  const leaf = segments.pop()!
  let cursor: Record<string, unknown> = tree
  for (const segment of segments) {
    const next = cursor[segment]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[leaf] = value
}

/**
 * 规则执行核（纯函数 + mutates tree）：按声明序对工作副本求值，链式可见；
 * 一轮内产生了实际变更（守卫后值与写前值不等）则再跑一轮，最多
 * {@link MVU_RULE_ROUNDS} 轮——不动点即停（阈值置位类规则第二轮同值幂等，
 * 天然收敛）；到上限仍在变更 → 告警进 failures（卡作者需收窄 when 或调整
 * 声明序）。schema 每写入逐路径过 guardMvuWrite（C-1 语义：clamp 调整值写回、
 * reject 记失败项跳过）；控制子树（`$schema`/`$rules`）不可经规则写入。
 */
export async function runMvuRules(
  rules: MvuSettlementRule[],
  options: { schema?: Record<string, unknown>; tree: Record<string, unknown> },
): Promise<MvuRuleRunResult> {
  const failures = new Set<string>()
  const writes: MvuRuleWrite[] = []
  // 路径 → 归因段（'rule:<name>' 与 guard note）列表：多轮/多规则触发同一路径
  // 按序去重拼接（同段不重复——自触发规则三轮只记一次 rule:<name>）
  const noteParts = new Map<string, string[]>()
  const tree = options.tree
  for (let round = 1; round <= MVU_RULE_ROUNDS; round++) {
    let progressed = false
    for (const rule of rules) {
      let active = false
      try {
        active = Boolean(await evalExpressionSandboxed(rule.when, buildRuleEnv(tree)))
      } catch (error) {
        failures.add(`rule '${rule.name}': when evaluation failed: ${errorText(error)}`)
        continue
      }
      if (!active) continue
      // then 值先全部求值再写入：任一求值失败 → 整条规则本轮跳过（原子语义）
      const pending: Array<{ path: string; value: unknown }> = []
      let failed = false
      for (const [path, raw] of Object.entries(rule.then)) {
        try {
          const value = typeof raw === 'string'
            ? await evalExpressionSandboxed(raw, buildRuleEnv(tree))
            : deepClone(raw)
          if (value === undefined) throw new Error('the expression evaluated to undefined')
          pending.push({ path, value })
        } catch (error) {
          failures.add(`rule '${rule.name}': then evaluation failed for '${path}': ${errorText(error)}`)
          failed = true
          break
        }
      }
      if (failed) continue
      for (const { path, value } of pending) {
        const head = path.split('.')[0]
        if (head === '$schema' || head === '$rules') {
          failures.add(`${path}: rule '${rule.name}': guard readonly: the ${head} subtree is card-declared and cannot be settled`)
          continue
        }
        const current = getMvuTreePath(tree, path)
        const guarded = options.schema === undefined ? undefined : guardMvuWrite(options.schema, path, value, current)
        if (guarded !== undefined && !guarded.ok) {
          failures.add(`${path}: rule '${rule.name}': guard ${guarded.kind}: ${guarded.reason}`)
          continue
        }
        const finalValue = guarded === undefined ? value : guarded.value
        if (mvuValuesEqual(finalValue, current)) continue
        setTreePath(tree, path, deepClone(finalValue))
        progressed = true
        const note = ['rule:' + rule.name, guarded?.note].filter((part): part is string => part !== undefined).join('; ')
        const parts = noteParts.get(path) ?? []
        if (!parts.includes(note)) parts.push(note)
        noteParts.set(path, parts)
        writes.push({ path, value: deepClone(finalValue), rule: rule.name, ...(guarded?.note !== undefined ? { guardNote: guarded.note } : {}) })
      }
    }
    if (!progressed) break
    if (round === MVU_RULE_ROUNDS) {
      failures.add(`$rules: fixed-point iteration hit the ${MVU_RULE_ROUNDS}-round cap; rules were still producing changes in the last round (narrow the when conditions or reorder the rules)`)
    }
  }
  const notes = Object.fromEntries([...noteParts].map(([path, parts]) => [path, parts.join('; ')]))
  return { failures: [...failures], writes, notes }
}

/* --------------------------- ST 侧挂接（薄） --------------------------- */

export interface MvuRulePassResult {
  failures: string[]
  /** 路径 → `rule:<name>` 标注（与守卫 notes 经 mergeMvuRuleNotes 合并进回执）。 */
  notes: Record<string, string>
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * ST 侧规则 pass（runGeneration 与 retryMvuSettlement 共用）：守卫 pass 之后、
 * 回执 diff 之前，对守卫后的 `chat_metadata.variables` 做二次计算。
 *
 * - 规则取**基线**树根 `$rules`（卡/世界书回退，见 readMvuRules）；
 * - 模板写穿改了根 `$rules` 本身 → 回滚 + readonly 失败项（守卫不可自改，
 *   与 C-1 的 `$schema` 回滚同纪律——在规则模块做而非守卫 pass，因守卫 pass
 *   在无 `$schema` 的卡上恒等早退）；
 * - 无 `$rules`（且写穿未碰 `$rules` 键）恒等返回，行为逐字节不变（golden）。
 */
export async function applyMvuSettlementRules(
  chat: ChatLogIR,
  card: CharacterCardIR | undefined,
  before: Record<string, unknown>,
): Promise<MvuRulePassResult> {
  const metadata = chat.header.chat_metadata
  const live = plainObject(metadata.variables)
  const source = readMvuRules(chat, card, before)
  if (source === undefined && before.$rules === undefined && live?.$rules === undefined) {
    return { failures: [], notes: {} }
  }
  const variables = live ?? {}
  const failures: string[] = []
  // $rules 契约回滚：声明源是基线（或卡/世界书），本轮写穿不可自改
  if (!mvuValuesEqual(variables.$rules, before.$rules)) {
    if (before.$rules !== undefined) variables.$rules = deepClone(before.$rules)
    else delete variables.$rules
    failures.push('$rules: guard readonly: the rules subtree is card-declared and cannot be settled')
  }
  if (source === undefined) {
    // 无声明规则：只剩契约回滚（或不等比较为假——恒等）
    if (live === undefined && Object.keys(variables).length > 0) metadata.variables = variables
    return { failures, notes: {} }
  }
  if ('invalid' in source) return { failures: [...failures, source.invalid], notes: {} }
  const schema = readMvuSchema(chat, card, before)
  const run = await runMvuRules(source.rules, { ...(schema !== undefined ? { schema } : {}), tree: variables })
  if (live === undefined && Object.keys(variables).length > 0) metadata.variables = variables
  return { failures: [...failures, ...run.failures], notes: run.notes }
}

/** 守卫 notes（C-1）与规则 notes（C-2）按路径合并：同路径前后段以 `; ` 拼接。 */
export function mergeMvuRuleNotes(
  guardNotes: Record<string, string>,
  ruleNotes: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [path, note] of Object.entries(guardNotes)) merged[path] = note
  for (const [path, note] of Object.entries(ruleNotes)) {
    merged[path] = merged[path] !== undefined ? `${merged[path]}; ${note}` : note
  }
  return merged
}
