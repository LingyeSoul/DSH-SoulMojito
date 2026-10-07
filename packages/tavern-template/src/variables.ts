/**
 * 模板变量系统（对照 ST-Prompt-Template `setvar/getvar` 家族的公开语义）。
 *
 * 作用域（dsh-tavern 适配，见提案 0008 §1 偏差表）：
 * - `local`：聊天局部变量（`chat_metadata.variables`，任意 JSON）；
 * - `global`：`state.scriptGlobals`（既有类型约束：仅标量）；
 * - `message`：无楼层变量面，映射到 local；
 * - `cache`：本代模板临时视图（快照起点 + 写穿透）；
 * - `initial`：`[InitialVariables]` 提供的初值树。
 *
 * `variables` 视图 = global → initial → local 深合并快照；任何写入同时写穿 cache
 * （对齐 ST「无论 scope 为何，临时变量都会更新」）。
 */

import {
  deepClone,
  deepMerge,
  getPath,
  insertAtPath,
  isObjectLike,
  setPath,
  unsetPath,
  type JsonObject,
  type PrimitiveValue,
} from './paths.js'

export type VarScope = 'global' | 'local' | 'message' | 'cache' | 'initial'
export type VarFlag = 'nx' | 'xx' | 'n' | 'nxs' | 'xxs'
export type VarResult = 'old' | 'new' | 'fullcache'

export interface TemplateVariableStores {
  /** 聊天局部变量存储（宿主持有引用，写穿即持久化候选）。 */
  local: JsonObject
  /** 全局变量存储（标量）。 */
  global: Record<string, PrimitiveValue>
  /** InitialVariables 初值树（可缺省）。 */
  initial?: JsonObject
}

interface NormalizedOptions {
  scope: VarScope
  inscope: VarScope
  outscope: VarScope
  flags: VarFlag
  results: VarResult
  defaults?: unknown
  min?: number | null
  max?: number | null
  clone: boolean
}

const SCOPES: readonly VarScope[] = ['global', 'local', 'message', 'cache', 'initial']
const FLAGS: readonly VarFlag[] = ['nx', 'xx', 'n', 'nxs', 'xxs']
const RESULTS: readonly VarResult[] = ['old', 'new', 'fullcache']

function normalizeOptions(input: unknown, base: NormalizedOptions): NormalizedOptions {
  const out = { ...base }
  const apply = (key: string, _value: unknown): boolean => {
    if (SCOPES.includes(key as VarScope)) {
      out.scope = key as VarScope
      return true
    }
    if (FLAGS.includes(key as VarFlag)) {
      out.flags = key as VarFlag
      return true
    }
    if (RESULTS.includes(key as VarResult)) {
      out.results = key as VarResult
      return true
    }
    return false
  }
  if (typeof input === 'string') {
    if (apply(input, true)) return out
    throw new TypeError(`unknown option shorthand: ${input}`)
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      switch (key) {
        case 'scope': out.scope = value as VarScope; break
        case 'inscope': out.inscope = value as VarScope; break
        case 'outscope': out.outscope = value as VarScope; break
        case 'flags': out.flags = value as VarFlag; break
        case 'results': out.results = value as VarResult; break
        case 'defaults': out.defaults = value; break
        case 'min': out.min = value as number | null; break
        case 'max': out.max = value as number | null; break
        case 'clone': out.clone = value === true; break
        case 'dryRun': break // dsh-tavern 单遍计算，无准备期（文档化偏差）
        case 'noCache': break // 我们的 cache 写穿透，无需该开关
        case 'index': break // 楼层变量索引，无楼层面
        case 'withMsg': break
        case 'merge': break // 深合并是本实现默认行为
        default: break // 未知键忽略（向前兼容）
      }
    }
    return out
  }
  return out
}

export interface InjectedPrompt {
  prompt: string
  order: number
  uid: string
  seq: number
}

export class TemplateVariableSystem {
  private readonly local: JsonObject
  private readonly global: Record<string, PrimitiveValue>
  private readonly initial: JsonObject
  /** 临时视图：global→initial→local 深合并快照 + 写穿透。 */
  readonly cache: JsonObject
  private readonly injected = new Map<string, InjectedPrompt[]>()
  private injectSeq = 0

  constructor(stores: TemplateVariableStores) {
    this.local = stores.local
    this.global = stores.global
    this.initial = stores.initial ?? {}
    this.cache = {}
    this.rebuildView()
  }

  /** 从 global→initial→local 重建 cache 视图（丢弃已有写穿透叠加）。 */
  private rebuildView(): void {
    for (const key of Object.keys(this.cache)) delete this.cache[key]
    deepMerge(this.cache, this.global as unknown as JsonObject)
    deepMerge(this.cache, this.initial)
    deepMerge(this.cache, deepClone(this.local))
  }

  /**
   * 重置 initial 作用域并重建视图（ST「每次加载重算覆盖」语义）。
   * 必须先于任何模板渲染调用（重建会丢弃渲染期写穿透）。
   */
  setInitialVariables(data: JsonObject): void {
    for (const key of Object.keys(this.initial)) delete this.initial[key]
    deepMerge(this.initial, data)
    this.rebuildView()
  }

  /** `variables` 常量（模板内可变视图）。 */
  view(): JsonObject {
    return this.cache
  }

  /** 最终 local 值（宿主持久化用；返回原引用）。 */
  localStore(): JsonObject {
    return this.local
  }

  private scopeStore(scope: VarScope): JsonObject | Record<string, PrimitiveValue> {
    switch (scope) {
      case 'global': return this.global
      case 'initial': return this.initial
      case 'local':
      case 'message': return this.local
      case 'cache': return this.cache
    }
  }

  /** flags 判定：nx/xx 基于 cache 视图，nxs/xxs 基于目标 scope（对照 ST 语义）。 */
  private flagAllows(flags: VarFlag, key: string, scope: VarScope): boolean {
    switch (flags) {
      case 'nx': return getPath(this.cache, key) === undefined
      case 'xx': return getPath(this.cache, key) !== undefined
      case 'nxs': return getPath(this.scopeStore(scope), key) === undefined
      case 'xxs': return getPath(this.scopeStore(scope), key) !== undefined
      case 'n': return true
    }
  }

  private writeScope(scope: VarScope, key: string, value: unknown): void {
    if (key === '') {
      // key=null 语义：整体替换变量树
      if (scope === 'global' || scope === 'cache') {
        throw new TypeError('cannot replace the entire global/cache variable tree; use local or initial scope')
      }
      const store = this.scopeStore(scope) as JsonObject
      for (const k of Object.keys(store)) delete store[k]
      if (isObjectLike(value)) deepMerge(store, value as JsonObject)
      // 非 object 整树替换无意义，静默忽略（对照 _.merge 行为）
      return
    }
    if (scope === 'global') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new TypeError(
          `global scope only accepts string|number|boolean in dsh-tavern (scriptGlobals constraint); got ${typeof value}. Use local scope for object trees.`)
      }
      this.global[key] = value
      return
    }
    if (scope === 'cache') return
    setPath(this.scopeStore(scope) as JsonObject, key, deepClone(value))
  }

  getVar(key: string | null, options: unknown = {}): unknown {
    const opts = normalizeOptions(options, {
      scope: 'cache', inscope: 'cache', outscope: 'message',
      flags: 'n', results: 'new', clone: false,
    })
    const store = key === null ? this.cache : this.scopeStore(opts.scope)
    const value = key === null ? store : getPath(store, key)
    if (value === undefined) return opts.defaults
    return opts.clone ? deepClone(value) : value
  }

  setVar(key: string | null, value: unknown, options: unknown = {}): unknown {
    const opts = normalizeOptions(options, {
      scope: 'message', inscope: 'cache', outscope: 'message',
      flags: 'n', results: 'new', clone: false,
    })
    const path = key ?? ''
    const old = getPath(this.cache, path)
    if (!this.flagAllows(opts.flags, path, opts.scope)) return undefined
    this.writeScope(opts.scope, path, value)
    // 写穿透 cache
    if (path === '') {
      if (isObjectLike(value)) {
        for (const k of Object.keys(this.cache)) delete this.cache[k]
        deepMerge(this.cache, value as JsonObject)
      }
    } else {
      setPath(this.cache, path, deepClone(value))
    }
    switch (opts.results) {
      case 'old': return old
      case 'new': return value
      case 'fullcache': return deepClone(this.cache)
    }
  }

  incDecVar(key: string, delta: number, options: unknown = {}, sign: 1 | -1): unknown {
    const opts = normalizeOptions(options, {
      scope: 'message', inscope: 'cache', outscope: 'message',
      flags: 'n', results: 'new', clone: false, defaults: 0,
    })
    const current = getPath(this.scopeStore(opts.inscope), key)
    const base = typeof current === 'number' ? current : opts.defaults
    const start = typeof base === 'number' ? base : Number(base)
    if (!Number.isFinite(start)) throw new TypeError(`incvar/decvar target "${key}" is not numeric`)
    let next = start + sign * delta
    if (typeof opts.min === 'number') next = Math.max(opts.min, next)
    if (typeof opts.max === 'number') next = Math.min(opts.max, next)
    return this.setVar(key, next, { ...optionsAsRecord(options), scope: opts.outscope, results: opts.results, defaults: undefined })
  }

  delVar(key: string, index?: string | number, options: unknown = {}): unknown {
    const opts = normalizeOptions(options, {
      scope: 'message', inscope: 'cache', outscope: 'message',
      flags: 'n', results: 'new', clone: false,
    })
    const old = getPath(this.cache, key)
    if (!this.flagAllows(opts.flags, key, opts.scope)) return undefined
    unsetPath(this.scopeStore(opts.scope) as JsonObject, key, index)
    if (opts.scope !== 'cache') unsetPath(this.cache, key, index)
    return opts.results === 'old' ? old : opts.results === 'fullcache' ? deepClone(this.cache) : true
  }

  insVar(key: string, value: unknown, index?: string | number, options: unknown = {}): unknown {
    const opts = normalizeOptions(options, {
      scope: 'message', inscope: 'cache', outscope: 'message',
      flags: 'n', results: 'new', clone: false,
    })
    insertAtPath(this.scopeStore(opts.scope) as JsonObject, key, deepClone(value), index)
    insertAtPath(this.cache, key, deepClone(value), index)
    return opts.results === 'old' ? undefined : opts.results === 'fullcache' ? deepClone(this.cache) : value
  }

  /* ------------------------- injectPrompt 注册表 ------------------------- */

  injectPrompt(key: string, prompt: string, order = 100, _sticky = 0, uid = ''): void {
    const list = this.injected.get(key) ?? []
    list.push({ prompt, order, uid, seq: this.injectSeq++ })
    this.injected.set(key, list)
  }

  getPromptsInjected(key: string, postprocess: Array<{ search: string | RegExp; replace: string }> = []): string {
    const list = [...(this.injected.get(key) ?? [])].sort((a, b) => a.order - b.order || a.seq - b.seq)
    return list
      .map((item) => {
        let text = item.prompt
        for (const rule of postprocess) text = text.replace(rule.search, rule.replace)
        return text
      })
      .join('\n')
  }

  hasPromptsInjected(key: string): boolean {
    return this.injected.has(key)
  }
}

function optionsAsRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}
