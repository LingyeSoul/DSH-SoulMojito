/**
 * MVU `$schema` 变量写入守卫（提案 0012 延伸，竞品参考 C-1，2026-10-11）。
 *
 * 语义参考 LittleWhiteBox variables/state2 的「模板不是提示词建议而是写入守卫」
 * （docs/exploration/2026-10-11-jsr-lwb-reference.md §3.2，280 行规格书），
 * 按本插件的两条结算写入路径 clean-room 重新实现（不复制其代码）：
 *
 * - ST 生成 / mvu/retry：模板输出渲染写穿 `chat_metadata.variables` 后，由
 *   mvu.ts 的 applyMvuSettlementGuard 做整树守卫 pass——diff 出叶子级变更逐路径
 *   守卫，clamp 写回、reject 回滚到基线值，失败项并入回执 failures。
 * - AgentTavern `tavern_variable_settle`：逐项写 chat 作用域变量前按路径守卫
 *   （guardMvuWrite），reject 走既有单项失败路径。
 *
 * 模板语法（JSON，声明在变量树根的 `$schema` 子树，来源见 readMvuSchema）：
 *
 *     "$schema": {
 *       "mvu": {                          // 模板对象含子键定义 → 键集锁定
 *         "favor":  { "$range": [0, 100], "$step": 10 },   // 数字：越界 clamp、步长截断
 *         "mood":   { "$enum": ["calm", "tense"] },        // 字符串枚举：非成员拒绝
 *         "name":   { "$ro": true },                        // 只读：变更即拒绝
 *         "stats":  { "hp": 0, "mp": 0 },                   // 嵌套锁定对象
 *         "allies": { "*": { "hp": 0 } },                   // "*" 通配键：动态对象
 *         "notes":  {},                                    // 空对象：开放，不校验子键
 *         "bag":    [ { "item": "", "count": 0 } ]          // 数组：首元素为项模板
 *       }
 *     }
 *
 * - 原语字面量按例定类型（0 → number、"" → string、true → boolean）；
 * - 指令键（`$range` / `$step` / `$enum` / `$ro` / `$type`）作用在所在节点；
 *   只含指令键的节点是约束节点（类型由 `$type` 或指令推断：range/step → number，
 *   enum → string）；
 * - 根 `$schema` 是命名空间映射不是锁：未声明的顶层名不受守卫（保留非 MVU 的
 *   chat 变量共存）；声明了子键的对象节点才锁定键集。
 *
 * 与 state2 的差异（详见 decisions/2026-10-11-mvu-schema-guard.md）：数字字符串
 * 不宽松转换（不强转，类型不符即失败项）；整体对象写不要求模板字段齐全（多键
 * 拒绝、因写入而**丢掉**既有模板字段才拒绝）；`$step` 按单次写变更幅度截断
 * （state2 的 inc 语义翻译到绝对值写入）；`$ro` 拒绝「会改变值的写入」，同值
 * 幂等写放行（ST 叶子 diff 天然只送变更路径，两面对齐）。
 */

import type { CharacterCardIR, ChatLogIR } from '../../tavern-format/src/index.js'

export type MvuGuardRejectKind = 'type-mismatch' | 'enum-violation' | 'readonly' | 'structure'

export interface MvuGuardOk {
  ok: true
  /** 守卫放行（或 clamp 后）应写入的值。 */
  value: unknown
  /** clamp / step 调整说明（进回执 reason），无调整则缺省。 */
  note?: string
}

export interface MvuGuardReject {
  ok: false
  kind: MvuGuardRejectKind
  reason: string
}

export type MvuGuardResult = MvuGuardOk | MvuGuardReject

/* ------------------------------ 模板解析 ------------------------------ */

interface GuardNode {
  typeLock?: 'number' | 'string' | 'boolean' | 'object' | 'array'
  /** object 节点模式：locked=键集锁定 / wildcard=动态键 / open=开放。 */
  objectMode?: 'locked' | 'wildcard' | 'open'
  children?: Map<string, GuardNode>
  wildcard?: GuardNode
  /** array 项模板。 */
  item?: GuardNode
  min?: number
  max?: number
  step?: number
  enumValues?: unknown[]
  ro?: boolean
}

const DIRECTIVE_KEYS = ['$range', '$step', '$enum', '$ro', '$type'] as const
const TYPE_LOCKS = ['number', 'string', 'boolean', 'object', 'array'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRange(raw: unknown): { min: number; max: number } | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const min = raw[0]
  const max = raw[1]
  if (typeof min !== 'number' || !Number.isFinite(min) || typeof max !== 'number' || !Number.isFinite(max)) return undefined
  return { min: Math.min(min, max), max: Math.max(min, max) }
}

/** 模板原语 → 守卫节点；null / 形状不合 → undefined（该路径不受守卫）。 */
function resolveTemplateNode(raw: unknown): GuardNode | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { typeLock: 'number' }
  if (typeof raw === 'string') return { typeLock: 'string' }
  if (typeof raw === 'boolean') return { typeLock: 'boolean' }
  if (Array.isArray(raw)) {
    // 数组项模板由首元素决定（state2 约定）；空数组 = 项不受校验。
    return { typeLock: 'array', ...(raw.length > 0 ? { item: resolveTemplateNode(raw[0]) } : {}) }
  }
  if (!isPlainObject(raw)) return undefined
  const range = parseRange(raw.$range)
  const step = typeof raw.$step === 'number' && Number.isFinite(raw.$step) && raw.$step > 0 ? raw.$step : undefined
  const enumValues = Array.isArray(raw.$enum) && raw.$enum.length > 0 ? raw.$enum : undefined
  const ro = raw.$ro === true ? true : undefined
  const typeLockDirect = typeof raw.$type === 'string' && (TYPE_LOCKS as readonly string[]).includes(raw.$type)
    ? raw.$type as GuardNode['typeLock']
    : undefined
  const directives = {
    ...(range !== undefined ? { min: range.min, max: range.max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(enumValues !== undefined ? { enumValues } : {}),
    ...(ro !== undefined ? { ro } : {}),
  }
  const childKeys = Object.keys(raw).filter((key) => !DIRECTIVE_KEYS.includes(key as (typeof DIRECTIVE_KEYS)[number]))
  if (childKeys.length === 0) {
    // 约束节点：类型来自 $type，其次由指令推断（range/step → number、enum → string）；
    // 只有 $ro 时类型不限。
    const typeLock = typeLockDirect ?? (range !== undefined || step !== undefined ? 'number' : enumValues !== undefined ? 'string' : undefined)
    if (typeLock === undefined && Object.keys(directives).length === 0) {
      // {} 空对象 = 开放对象：子键任意、不校验。
      return { typeLock: 'object', objectMode: 'open' }
    }
    if (typeLock === 'object') return { typeLock, objectMode: 'open', ...directives }
    if (typeLock === 'array') return { typeLock, ...directives }
    return { ...(typeLock !== undefined ? { typeLock } : {}), ...directives }
  }
  const wildcardRaw = childKeys.includes('*') ? raw['*'] : undefined
  const namedKeys = childKeys.filter((key) => key !== '*')
  const children = new Map<string, GuardNode>()
  for (const key of namedKeys) {
    const child = resolveTemplateNode(raw[key])
    if (child !== undefined) children.set(key, child)
  }
  const objectMode = wildcardRaw !== undefined ? 'wildcard' : 'locked'
  const wildcard = wildcardRaw !== undefined ? resolveTemplateNode(wildcardRaw) : undefined
  return {
    typeLock: 'object',
    objectMode,
    ...(children.size > 0 ? { children } : {}),
    ...(wildcard !== undefined ? { wildcard } : {}),
    ...directives,
  }
}

const schemaCache = new WeakMap<object, GuardNode | undefined>()

/** 解析 `$schema` 原始树为守卫节点；根强制为命名空间映射（未声明顶层名不受守卫）。 */
export function resolveMvuSchema(raw: unknown): GuardNode | undefined {
  if (!isPlainObject(raw)) return undefined
  const cached = schemaCache.get(raw)
  if (cached !== undefined || schemaCache.has(raw)) return cached
  const resolved = resolveTemplateNode(raw)
  const root = resolved !== undefined && resolved.objectMode === 'locked' ? { ...resolved, objectMode: 'open' } : resolved
  schemaCache.set(raw, root)
  return root
}

/* ------------------------------ Schema 来源 ------------------------------ */

/** 变量树根 `$schema` 子树（只特判这一个键；其余 `$` 开头键不动，兼容既有卡）。 */
export function stripMvuSchema<T extends Record<string, unknown>>(tree: T): Record<string, unknown> {
  if (!('$schema' in tree) || !isPlainObject(tree.$schema)) return tree
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tree)) {
    if (key === '$schema') continue
    out[key] = value
  }
  return out
}

const INITIAL_VARIABLES_KEY = 'initial_variables'

function cardSchema(card: CharacterCardIR | undefined): unknown {
  const holder = card?.data?.extensions?.['agentTavern']
  if (!isPlainObject(holder)) return undefined
  const initial = holder.initialVariables
  return isPlainObject(initial) ? initial.$schema : undefined
}

function treeSchema(tree: unknown): unknown {
  return isPlainObject(tree) ? tree.$schema : undefined
}

/**
 * 守卫 schema 来源（先到先得）：
 * 1. 聊天变量树根 `$schema`（新聊天由卡 extensions.agentTavern.initialVariables
 *    深拷贝播种而来，支持按聊天演进）；
 * 2. 卡 `data.extensions.agentTavern.initialVariables.$schema`（0013 工作台/
 *    card_apply_mvu 产物；覆盖 schema 后加卡前创建的旧聊天与 flat store 持有
 *    变量的 AgentTavern 聊天）；
 * 3. `chat_metadata.initial_variables.$schema`（世界书 [InitialVariables] 携带，
 *    每次生成重算）。
 */
export function readMvuSchema(
  chat: ChatLogIR,
  card?: CharacterCardIR,
  variablesOverride?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const candidates = [
    treeSchema(variablesOverride ?? (chat?.header?.chat_metadata?.variables as unknown)),
    cardSchema(card),
    treeSchema(chat?.header?.chat_metadata?.[INITIAL_VARIABLES_KEY]),
  ]
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && Object.keys(candidate).length > 0) return candidate
  }
  return undefined
}

/* ------------------------------ 值守卫 ------------------------------ */

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function mvuValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => mvuValuesEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!mvuValuesEqual(left[key], right[key])) return false
    }
    return true
  }
  return false
}

interface ValidateOk {
  ok: true
  value: unknown
  notes: string[]
}
type ValidateResult = ValidateOk | MvuGuardReject

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value
  if (min !== undefined && out < min) out = min
  if (max !== undefined && out > max) out = max
  return out
}

function validateValue(node: GuardNode, value: unknown, current: unknown, path: string, notes: string[]): ValidateResult {
  if (node.ro === true && !mvuValuesEqual(value, current)) {
    return { ok: false, kind: 'readonly', reason: 'read-only field' }
  }
  if (Array.isArray(value)) {
    if (node.typeLock !== undefined && node.typeLock !== 'array') {
      return { ok: false, kind: 'type-mismatch', reason: `expected ${node.typeLock}, got array` }
    }
    if (node.item === undefined) return { ok: true, value, notes }
    const currentItems = Array.isArray(current) ? current : []
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const result = validateValue(node.item, value[i], currentItems[i], `${path}[${i}]`, notes)
      if (!result.ok) return result
      out.push(result.value)
    }
    return { ok: true, value: out, notes }
  }
  if (isPlainObject(value)) {
    if (node.typeLock !== undefined && node.typeLock !== 'object') {
      return { ok: false, kind: 'type-mismatch', reason: `expected ${node.typeLock}, got object` }
    }
    if (node.objectMode !== 'locked' && node.objectMode !== 'wildcard') return { ok: true, value, notes }
    const currentObject = isPlainObject(current) ? current : {}
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const child = node.children?.get(key) ?? node.wildcard
      if (child === undefined) {
        return { ok: false, kind: 'structure', reason: `key '${key}' is not in the schema template` }
      }
      const result = validateValue(child, value[key], currentObject[key], path === '' ? key : `${path}.${key}`, notes)
      if (!result.ok) return result
      next[key] = result.value
    }
    if (node.objectMode === 'locked') {
      // 整对象写入会替换该路径的完整值：写入导致既有模板字段丢失 = 删除模板字段，拒绝。
      for (const key of node.children?.keys() ?? []) {
        if (!(key in value) && key in currentObject) {
          return { ok: false, kind: 'structure', reason: `template field '${key}' would be deleted by this write` }
        }
      }
    }
    return { ok: true, value: next, notes }
  }
  if (node.typeLock !== undefined && typeName(value) !== node.typeLock) {
    return { ok: false, kind: 'type-mismatch', reason: `expected ${node.typeLock}, got ${typeName(value)}` }
  }
  if (node.enumValues !== undefined && !node.enumValues.some((allowed) => mvuValuesEqual(allowed, value))) {
    return { ok: false, kind: 'enum-violation', reason: `value ${JSON.stringify(value)} is not one of [${node.enumValues.map((entry) => JSON.stringify(entry)).join(', ')}]` }
  }
  if (typeof value === 'number' && Number.isFinite(value) && (node.min !== undefined || node.max !== undefined || node.step !== undefined)) {
    let out = value
    // $step：单次写变更幅度截断（state2 inc 语义的绝对值写翻译）；无既有数值（首写）不截断。
    if (node.step !== undefined && typeof current === 'number' && Number.isFinite(current)) {
      const delta = out - current
      const capped = Math.max(-node.step, Math.min(node.step, delta))
      if (capped !== delta) {
        notes.push(`${path}: guard step: delta ${delta > 0 ? '+' : ''}${delta} capped to ${capped > 0 ? '+' : ''}${capped}`)
        out = current + capped
      }
    }
    const clamped = clampNumber(out, node.min, node.max)
    if (clamped !== out) {
      notes.push(`${path}: guard clamp: ${out} -> ${clamped}`)
      out = clamped
    }
    return { ok: true, value: out, notes }
  }
  return { ok: true, value, notes }
}

/**
 * 按点分路径守卫一次变量写入（settle 工具逐项调用；ST 整树 pass 也按叶子路径
 * 调用）。`value === undefined` 表示删除（回滚路径语义）。current 为该路径当前
 * 值（ro / step 判定用），缺省 undefined（新增键）。
 */
export function guardMvuWrite(schema: unknown, path: string, value: unknown, current: unknown): MvuGuardResult {
  const segments = path.split('.').filter((segment) => segment !== '')
  if (segments.length === 0) return { ok: true, value }
  if (segments[0] === '$schema') {
    return { ok: false, kind: 'readonly', reason: 'the $schema subtree is the declared guard contract and cannot be settled' }
  }
  const root = resolveMvuSchema(schema)
  if (root === undefined) return { ok: true, value }

  let cursor: GuardNode | undefined = root
  let parent: GuardNode | undefined
  let roChain = root.ro === true
  let violation: string | undefined
  for (let i = 0; i < segments.length && cursor !== undefined; i++) {
    const segment = segments[i]!
    if (cursor.typeLock === 'array') {
      parent = cursor
      if (!/^\d+$/.test(segment)) {
        violation ??= `'${segments.slice(0, i + 1).join('.')}' expects an array index, not '${segment}'`
        cursor = undefined
      } else {
        cursor = cursor.item
      }
    } else if (cursor.objectMode !== undefined) {
      parent = cursor
      const named = cursor.children?.get(segment)
      if (named !== undefined) cursor = named
      else if (cursor.objectMode === 'wildcard' && cursor.wildcard !== undefined) cursor = cursor.wildcard
      else if (cursor.objectMode === 'locked') {
        violation ??= `'${segments.slice(0, i + 1).join('.')}' is not in the schema template`
        cursor = undefined
      } else cursor = undefined
    } else {
      // 标量模板下再写嵌套路径 = 在标量位置造结构，按结构违规拒绝
      if (cursor.typeLock !== undefined && cursor.objectMode === undefined) {
        violation ??= `'${segments.slice(0, i + 1).join('.')}' expects ${cursor.typeLock}, not a nested path`
      }
      parent = cursor
      cursor = undefined
    }
    if (cursor !== undefined && cursor.ro === true) roChain = true
  }
  if (violation !== undefined) return { ok: false, kind: 'structure', reason: violation }

  const lastSegment = segments[segments.length - 1]!
  // 删除：模板声明的字段不可删（结构锁定）；ro 覆盖的路径不可删；未声明键放行。
  if (value === undefined) {
    if (roChain) return { ok: false, kind: 'readonly', reason: 'read-only field' }
    if (parent?.objectMode === 'locked' && parent.children?.has(lastSegment)) {
      return { ok: false, kind: 'structure', reason: `template field '${lastSegment}' cannot be deleted` }
    }
    return { ok: true, value: undefined }
  }
  if (roChain && !mvuValuesEqual(value, current)) {
    return { ok: false, kind: 'readonly', reason: 'read-only field' }
  }
  if (cursor === undefined) return { ok: true, value }
  const result = validateValue(cursor, value, current, segments.join('.'), [])
  if (!result.ok) return result
  return { ok: true, value: result.value, ...(result.notes.length > 0 ? { note: result.notes.join('; ') } : {}) }
}

/* ------------------------------ 树路径工具 ------------------------------ */

/** 读取点分路径的值（中间层不是普通对象时视为缺省）。 */
export function getMvuTreePath(tree: Record<string, unknown> | undefined, path: string): unknown {
  let cursor: unknown = tree
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}
