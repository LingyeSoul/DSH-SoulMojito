/**
 * 模板运行时：保护块预处理 + `node:vm` 沙箱执行。
 *
 * 沙箱上下文为全新 vm context（仅标准 JS 内建，无 require/process/timer/网络）。
 * 模板可见的全部宿主能力都经 env 显式注入，且注入方式是「context-realm 信封」：
 * 宿主只把 env 描述成可 JSON 化的 wire（函数以数字 id 表示），由宿主编写的
 * bootstrap 在 context 内物化成 context 自己的对象/数组/包装函数。因此模板
 * 拿不到任何宿主对象或宿主函数引用（`__escape.constructor`、`getvar.constructor`
 * 等都只能落到 context 的 Function 构造器，而 context 没有 process）。
 *
 * 与仓库既有教义一致（gates 对 client 代码同样只做 `node:vm` 沙箱），这里
 * 不承诺对抗 VM 实现漏洞，但明确不把宿主 Node 能力交给卡内容。
 */

import vm from 'node:vm'
import { compileTemplate } from './syntax.js'
import { BOOTSTRAP_SOURCE } from './sandbox-bootstrap.js'

/** 这些块内的 `<%`/`%>` 转为字面量（不执行）：escape-ejs 显式保护 + 推理标签保护。 */
export function protectBlocks(source: string): string {
  if (typeof source !== 'string') throw new TypeError('template source must be a string')
  return source
    .replace(/<#escape-ejs>([\s\S]*?)<#\/escape-ejs>/g, (_m, inner: string) =>
      `<#escape-ejs>${inner.replace(/<%/g, '<%%').replace(/%>/g, '%%>')}<#/escape-ejs>`)
    .replace(/<(thinking|think|reasoning)>([\s\S]*?)<\/\1>/g, (m, tag: string, inner: string) =>
      inner.includes('<%') ? `<${tag}>${inner.replace(/<%/g, '<%%').replace(/%>/g, '%%>')}</${tag}>` : m)
}

export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface CompiledEntry {
  script: vm.Script
}

/** 进程级编译缓存（key 为保护块处理后的源码；vm.Script 可跨 context 复用）。 */
const compileCache = new Map<string, CompiledEntry>()
const COMPILE_CACHE_MAX = 256

function compile(source: string): CompiledEntry {
  const cached = compileCache.get(source)
  if (cached) return cached
  const body = compileTemplate(source)
  const wrapper = `(async function (__env) { with (__env) {\n${body}\n} })`
  const script = new vm.Script(wrapper, { filename: 'tavern-template.ejs' })
  if (compileCache.size >= COMPILE_CACHE_MAX) {
    const oldest = compileCache.keys().next().value
    if (oldest !== undefined) compileCache.delete(oldest)
  }
  const entry = { script }
  compileCache.set(source, entry)
  return entry
}

/** 文本是否包含模板语法（含 `<%%` 字面量——解码也需要走渲染）。 */
export function hasTemplateTag(source: string): boolean {
  return typeof source === 'string' && source.includes('<%')
}

export interface RenderOptions {
  /** 渲染失败时的伪位置标签（诊断用）。 */
  where?: string
}

/* ------------------------------ context envelope ------------------------------ */

type HostCallable = (...args: unknown[]) => unknown

/**
 * Context-origin functions are remembered process-wide so a function stored in
 * `defines` survives into later renders with the correct call discipline. Host
 * functions are never added here; only functions that crossed from a context.
 */
const CONTEXT_FUNCTIONS = new WeakSet<HostCallable>()

interface HostFunctionEntry {
  readonly fn: HostCallable
  origin: 'host' | 'context'
}

interface HostState {
  readonly functions: HostFunctionEntry[]
  readonly ids: Map<HostCallable, number>
}

type WireValue =
  | { t: 'null' }
  | { t: 'u' }
  | { t: 's'; v: string }
  | { t: 'b'; v: boolean }
  | { t: 'n'; v: number | string }
  | { t: 'big'; v: string }
  | { t: 'ref'; v: number }

type WireNode =
  | { t: 'o'; e: Array<[string, WireValue]> }
  | { t: 'a'; n: number; e: Array<[number, WireValue]> }
  | { t: 'f'; v: number }
  | { t: 'keep' }
  | { t: 'r'; s: string; f: string; l: number }
  | { t: 'd'; v: string }

interface Wire {
  root: WireValue
  nodes: WireNode[]
}

interface HostEnvelope {
  descriptorJson: string
  state: HostState
}

type SettleCallback = (token: number, ok: 0 | 1, payloadJson: string) => void

type HostDispatch = (
  id: number,
  argsJson: string,
  contextFunctions: unknown[],
  contextArgs: unknown[],
  token: number,
  settle: SettleCallback,
  contextThis: unknown,
) => string

type SandboxBootstrap = (descriptorJson: string, dispatch: HostDispatch) => Record<string, unknown>

interface SandboxRealm {
  context: vm.Context
  env: Record<string, unknown>
}

const UNSUPPORTED_OBJECT_TAGS = new Set([
  '[object Promise]',
  '[object Map]',
  '[object Set]',
  '[object WeakMap]',
  '[object WeakSet]',
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
  '[object DataView]',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeNumber(value: number): number | string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return value
}

function normalizeLastIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function isUnsupportedObjectTag(tag: string): boolean {
  if (UNSUPPORTED_OBJECT_TAGS.has(tag)) return true
  return /^\[object (?:Uint|Int|Float|BigUint|BigInt)\w*Array\]$/.test(tag)
}

function hostFunctionId(state: HostState, fn: HostCallable): number {
  const contextOrigin = CONTEXT_FUNCTIONS.has(fn)
  const existing = state.ids.get(fn)
  if (existing !== undefined) {
    const entry = state.functions[existing]
    if (entry !== undefined && contextOrigin && entry.origin === 'host') entry.origin = 'context'
    return existing
  }
  const id = state.functions.length
  state.functions.push({ fn, origin: contextOrigin ? 'context' : 'host' })
  state.ids.set(fn, id)
  return id
}

function markContextFunction(value: unknown): void {
  if (typeof value === 'function') CONTEXT_FUNCTIONS.add(value as HostCallable)
}

/** Mark every function reachable from a context-origin result before wrapping it. */
function markContextFunctionsDeep(value: unknown, seen: Set<object>): void {
  if (typeof value === 'function') {
    CONTEXT_FUNCTIONS.add(value as HostCallable)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) markContextFunctionsDeep(item, seen)
    return
  }
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object Date]' || tag === '[object RegExp]') return
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) markContextFunctionsDeep(record[key], seen)
}

/**
 * 把宿主值编码成 wire。`mode === 'keep'` 用于宿主函数调用后的参数回写：
 * 函数值保持 context 原引用，其余对象按当前状态重新描述（用于把 `_.unset`
 * 这类原地修改同步回 context）。
 */
function encodeWire(value: unknown, state: HostState | undefined, mode: 'wrap' | 'keep'): Wire {
  const nodes: WireNode[] = []
  const seen = new Map<object, number>()

  const encode = (input: unknown): WireValue => {
    if (input === null) return { t: 'null' }
    switch (typeof input) {
      case 'undefined': return { t: 'u' }
      case 'string': return { t: 's', v: input }
      case 'boolean': return { t: 'b', v: input }
      case 'number': return { t: 'n', v: encodeNumber(input) }
      case 'bigint': return { t: 'big', v: input.toString() }
      case 'symbol': throw new TypeError('cannot cross a symbol through the template sandbox boundary')
      case 'function': {
        if (mode === 'keep') {
          nodes.push({ t: 'keep' })
        } else {
          if (state === undefined) throw new Error('host function registry is missing')
          nodes.push({ t: 'f', v: hostFunctionId(state, input as HostCallable) })
        }
        return { t: 'ref', v: nodes.length - 1 }
      }
      case 'object': break
      default: throw new TypeError(`cannot cross a ${typeof input} through the template sandbox boundary`)
    }

    const objectValue = input as object
    const existing = seen.get(objectValue)
    if (existing !== undefined) return { t: 'ref', v: existing }

    if (Array.isArray(input)) {
      const index = nodes.length
      nodes.push({ t: 'a', n: input.length, e: [] })
      seen.set(objectValue, index)
      const entries: Array<[number, WireValue]> = []
      for (const key of Object.keys(input)) {
        const numeric = Number(key)
        if (String(numeric) === key && numeric >= 0 && numeric < input.length) {
          entries.push([numeric, encode(input[numeric])])
        }
      }
      nodes[index] = { t: 'a', n: input.length, e: entries }
      return { t: 'ref', v: index }
    }

    const tag = Object.prototype.toString.call(input)
    if (tag === '[object RegExp]') {
      const index = nodes.length
      nodes.push({ t: 'r', s: '', f: '', l: 0 })
      seen.set(objectValue, index)
      const regexp = input as RegExp
      nodes[index] = { t: 'r', s: String(regexp.source), f: String(regexp.flags), l: normalizeLastIndex(regexp.lastIndex) }
      return { t: 'ref', v: index }
    }
    if (tag === '[object Date]') {
      const index = nodes.length
      nodes.push({ t: 'd', v: 'Invalid' })
      seen.set(objectValue, index)
      const time = Date.prototype.getTime.call(input as Date)
      nodes[index] = { t: 'd', v: Number.isNaN(time) ? 'Invalid' : new Date(time).toISOString() }
      return { t: 'ref', v: index }
    }
    if (isUnsupportedObjectTag(tag)) {
      throw new TypeError(`cannot cross a ${tag.slice(8, -1)} through the template sandbox boundary`)
    }

    const index = nodes.length
    nodes.push({ t: 'o', e: [] })
    seen.set(objectValue, index)
    const record = input as Record<string, unknown>
    const entries: Array<[string, WireValue]> = []
    for (const key of Object.keys(record)) entries.push([key, encode(record[key])])
    nodes[index] = { t: 'o', e: entries }
    return { t: 'ref', v: index }
  }

  return { root: encode(value), nodes }
}

function wireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`malformed sandbox bridge payload: ${label} is not a non-negative integer`)
  }
  return value
}

function wireLength(value: unknown, label: string): number {
  const length = wireInteger(value, label)
  if (length > 0xffffffff) throw new TypeError(`malformed sandbox bridge payload: ${label} is too large`)
  return length
}

function wireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`malformed sandbox bridge payload: ${label} is not a string`)
  return value
}

function wireNumber(value: unknown): number {
  if (typeof value === 'number' && !Number.isNaN(value) && value !== Infinity && value !== -Infinity) return value
  if (value === 'NaN') return NaN
  if (value === 'Infinity') return Infinity
  if (value === '-Infinity') return -Infinity
  if (value === '-0') return -0
  throw new TypeError('malformed sandbox bridge payload: invalid number')
}

/**
 * Wrap a context function that was passed as a nested object/array property.
 * Host code may invoke such callbacks with a host `this` and host-owned match
 * data; primitive-only arguments plus an ignored `this` keep the call safe.
 */
function wrapNestedContextFunction(fn: HostCallable): HostCallable {
  return (...args: unknown[]) => {
    for (const arg of args) {
      if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
        throw new TypeError('host callback arguments must be primitive when invoking a template function from host code')
      }
    }
    const result = Reflect.apply(fn, undefined, args)
    if (isThenableValue(result)) {
      throw new TypeError('template callbacks invoked from host code must be synchronous')
    }
    return result
  }
}

/**
 * 从 wire 在宿主侧物化一个深拷贝。函数的解析器由调用方提供：
 * 参数场景返回 context 函数原引用，结果场景不需要走这里（结果由 bootstrap 物化）。
 */
function decodeWire(wire: Wire, resolveFunction: (id: number) => unknown, dropPrototypeKey: boolean): unknown {
  if (!isRecord(wire) || !Array.isArray(wire.nodes)) {
    throw new TypeError('malformed sandbox bridge payload: nodes missing')
  }
  const nodes = wire.nodes
  const built: unknown[] = new Array(nodes.length)
  const rootArrayIndex = isRecord(wire.root) && wire.root.t === 'ref'
    ? wireInteger(wire.root.v, 'root reference')
    : -1
  const nestedCallbacks = new Map<HostCallable, HostCallable>()
  const callbackFor = (fn: HostCallable): HostCallable => {
    const cached = nestedCallbacks.get(fn)
    if (cached !== undefined) return cached
    const wrapped = wrapNestedContextFunction(fn)
    nestedCallbacks.set(fn, wrapped)
    return wrapped
  }
  const decode = (enc: unknown, wrapFunction: boolean): unknown => {
    if (!isRecord(enc)) throw new TypeError('malformed sandbox bridge payload: value missing')
    switch (enc.t) {
      case 'null': return null
      case 'u': return undefined
      case 's': return wireString(enc.v, 'string value')
      case 'b':
        if (typeof enc.v !== 'boolean') throw new TypeError('malformed sandbox bridge payload: invalid boolean')
        return enc.v
      case 'n': return wireNumber(enc.v)
      case 'big': return BigInt(wireString(enc.v, 'bigint value'))
      case 'ref': {
        const index = wireInteger(enc.v, 'reference')
        if (index >= built.length) throw new TypeError('malformed sandbox bridge payload: reference out of range')
        const value = built[index]
        if (wrapFunction && typeof value === 'function') {
          const node = nodes[index]
          if (isRecord(node) && node.t === 'f') return callbackFor(value as HostCallable)
        }
        return value
      }
      default: throw new TypeError(`malformed sandbox bridge payload: unknown value tag ${String(enc.t)}`)
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!isRecord(node)) throw new TypeError('malformed sandbox bridge payload: node missing')
    switch (node.t) {
      case 'o': built[i] = {}; break
      case 'a': built[i] = new Array(wireLength(node.n, 'array length')); break
      case 'f': built[i] = resolveFunction(wireInteger(node.v, 'function id')); break
      case 'r': {
        const regexp = new RegExp(wireString(node.s, 'regexp source'), wireString(node.f, 'regexp flags'))
        regexp.lastIndex = wireInteger(node.l, 'regexp lastIndex')
        built[i] = regexp
        break
      }
      case 'd': {
        const raw = wireString(node.v, 'date value')
        built[i] = raw === 'Invalid' ? new Date(NaN) : new Date(raw)
        break
      }
      default: throw new TypeError(`malformed sandbox bridge payload: unknown node tag ${String(node.t)}`)
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!isRecord(node)) continue
    if (node.t === 'o') {
      if (!Array.isArray(node.e)) throw new TypeError('malformed sandbox bridge payload: object entries missing')
      for (const rawEntry of node.e) {
        if (!Array.isArray(rawEntry) || rawEntry.length !== 2) throw new TypeError('malformed sandbox bridge payload: object entry missing')
        const key = wireString(rawEntry[0], 'object key')
        if (dropPrototypeKey && key === '__proto__') continue
        const value = decode(rawEntry[1], true)
        // Coercion hooks would otherwise be invoked by host built-ins with a
        // host-owned `this` (e.g. Math.floor(obj)). Host clones are data only.
        if ((key === 'valueOf' || key === 'toString' || key === 'toJSON') && typeof value === 'function') continue
        Object.defineProperty(built[i] as Record<string, unknown>, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
    } else if (node.t === 'a') {
      if (!Array.isArray(node.e)) throw new TypeError('malformed sandbox bridge payload: array entries missing')
      const length = wireLength(node.n, 'array length')
      for (const rawEntry of node.e) {
        if (!Array.isArray(rawEntry) || rawEntry.length !== 2) throw new TypeError('malformed sandbox bridge payload: array entry missing')
        const index = wireInteger(rawEntry[0], 'array index')
        if (index >= length) throw new TypeError('malformed sandbox bridge payload: array index out of range')
        ;(built[i] as unknown[])[index] = decode(rawEntry[1], i !== rootArrayIndex)
      }
    }
  }

  return decode(wire.root, false)
}

function readErrorInfo(error: unknown): { name: string; message: string } {
  try {
    if (error !== null && typeof error === 'object') {
      const record = error as { name?: unknown; message?: unknown }
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error'
      const message = typeof record.message === 'string' ? record.message : String(error)
      return { name, message }
    }
    return { name: 'Error', message: String(error) }
  } catch {
    return { name: 'Error', message: 'host function threw an unprintable value' }
  }
}

function decodeArgumentWire(argsJson: string, contextFunctions: unknown[]): unknown[] {
  if (typeof argsJson !== 'string' || !Array.isArray(contextFunctions)) {
    throw new TypeError('malformed sandbox bridge call')
  }
  for (const fn of contextFunctions) markContextFunction(fn)
  const wire = JSON.parse(argsJson) as Wire
  const value = decodeWire(wire, (id) => {
    if (id >= contextFunctions.length) throw new TypeError(`template sandbox function id ${id} is out of range`)
    const fn = contextFunctions[id]
    if (typeof fn !== 'function') throw new TypeError(`template sandbox function id ${id} is not callable`)
    return fn
  }, true)
  if (!Array.isArray(value)) throw new TypeError('malformed sandbox bridge call: arguments are not an array')
  return value
}

function encodePostState(args: unknown[]): Wire | undefined {
  if (!args.some((arg) => arg !== null && typeof arg === 'object')) return undefined
  try {
    return encodeWire(args, undefined, 'keep')
  } catch {
    // Host mutations that produced unencodable values are not mirrored back; the
    // call result itself still crosses the boundary.
    return undefined
  }
}

function isThenableValue(value: unknown): boolean {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}

function createHostDispatch(state: HostState): HostDispatch {
  return (id, argsJson, contextFunctions, contextArgs, token, settle, contextThis) => {
    try {
      if (contextThis === null || typeof contextThis !== 'object') {
        throw new Error('malformed sandbox bridge call: missing context this binding')
      }
      const entry = state.functions[id]
      if (entry === undefined) throw new Error(`unknown host function id ${id}`)

      if (Array.isArray(contextFunctions)) for (const fn of contextFunctions) markContextFunction(fn)
      if (Array.isArray(contextArgs)) for (const value of contextArgs) markContextFunction(value)

      if (entry.origin === 'context') {
        if (!Array.isArray(contextArgs)) throw new TypeError('malformed sandbox bridge call: context arguments are not an array')
        let result: unknown
        try {
          // Context-origin functions receive the original context values. Passing
          // host clones here would let the function inspect host prototypes.
          result = Reflect.apply(entry.fn, contextThis, contextArgs)
        } catch (error) {
          return JSON.stringify({ a: 0, ok: 0, e: readErrorInfo(error) })
        }
        markContextFunctionsDeep(result, new Set())
        if (isThenableValue(result)) {
          return JSON.stringify({
            a: 0,
            ok: 0,
            e: {
              name: 'TypeError',
              message: 'context function returned a thenable; only host-native Promises can cross the template sandbox boundary',
            },
          })
        }
        return JSON.stringify({ a: 0, ok: 1, v: encodeWire(result, state, 'wrap') })
      }

      const args = decodeArgumentWire(argsJson, contextFunctions)
      let result: unknown
      try {
        // Host functions receive cloned data and a context-owned `this`, so they
        // never observe host globals through sloppy `this` or context objects.
        result = Reflect.apply(entry.fn, contextThis, args)
      } catch (error) {
        return JSON.stringify({ a: 0, ok: 0, e: readErrorInfo(error), p: encodePostState(args) })
      }

      if (isThenableValue(result)) {
        // Only host-native Promises are assimilated here: their reactions run in
        // the host realm, so context code never receives host resolve/reject
        // functions. A context-origin thenable must be awaited by the context
        // itself; letting the host Promise machinery call its `then` would hand
        // host callbacks to untrusted code.
        if (!(result instanceof Promise)) {
          return JSON.stringify({
            a: 0,
            ok: 0,
            e: {
              name: 'TypeError',
              message: 'host function returned a non-native thenable; only host-native Promises can cross the template sandbox boundary',
            },
          })
        }
        void Promise.resolve(result).then(
          (value) => {
            let payload: Record<string, unknown>
            try {
              payload = { ok: 1, v: encodeWire(value, state, 'wrap'), p: encodePostState(args) }
            } catch (error) {
              payload = { ok: 0, e: readErrorInfo(error) }
            }
            try {
              settle(token, 1, JSON.stringify(payload))
            } catch {
              // The context may have been discarded while the host call was in flight.
            }
          },
          (error) => {
            try {
              settle(token, 0, JSON.stringify({ ok: 0, e: readErrorInfo(error), p: encodePostState(args) }))
            } catch {
              // The context may have been discarded while the host call was in flight.
            }
          },
        )
        return JSON.stringify({ a: 1 })
      }

      return JSON.stringify({ a: 0, ok: 1, v: encodeWire(result, state, 'wrap'), p: encodePostState(args) })
    } catch (error) {
      return JSON.stringify({ a: 0, ok: 0, e: readErrorInfo(error) })
    }
  }
}

function createHostEnvelope(env: Record<string, unknown>): HostEnvelope {
  const state: HostState = { functions: [], ids: new Map() }
  const wire = encodeWire(env, state, 'wrap')
  return { descriptorJson: JSON.stringify(wire), state }
}


const BOOTSTRAP_SCRIPT = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'tavern-template-bootstrap.js' })

function createSandboxRealm(env: Record<string, unknown>): SandboxRealm {
  const context = vm.createContext(Object.create(null))
  const bootstrap = BOOTSTRAP_SCRIPT.runInContext(context) as SandboxBootstrap
  const envelope = createHostEnvelope(env)
  const dispatch = createHostDispatch(envelope.state)
  const sandboxEnv = bootstrap(envelope.descriptorJson, dispatch)
  if (sandboxEnv === null || typeof sandboxEnv !== 'object') {
    throw new Error('sandbox bootstrap did not return a context environment')
  }
  return { context, env: sandboxEnv }
}

function describeThrown(err: unknown): string {
  try {
    if (err !== null && typeof err === 'object') {
      const record = err as { name?: unknown; message?: unknown }
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : undefined
      const message = typeof record.message === 'string' ? record.message : undefined
      if (name !== undefined && message !== undefined) return `${name}: ${message}`
      if (message !== undefined) return message
    }
    return String(err)
  } catch {
    return 'unprintable error value'
  }
}

/**
 * 在 context-realm 信封沙箱中渲染模板。env 提供模板可见的全部变量与函数；
 * `__append`/`__escape`/`print`/`__out` 由 context bootstrap 注入（非枚举，
 * `variables` 等用户对象不受影响）。
 */
export async function renderSandboxed(source: string, env: Record<string, unknown>, options: RenderOptions = {}): Promise<string> {
  try {
    const entry = compile(protectBlocks(source))
    const realm = createSandboxRealm(env)
    const factory = entry.script.runInContext(realm.context) as (e: Record<string, unknown>) => Promise<unknown>
    const result = await factory(realm.env)
    return typeof result === 'string' ? result : String(result)
  } catch (err) {
    const where = options.where ? ` (${options.where})` : ''
    throw new Error(`template execution failed${where}: ${describeThrown(err)}`)
  }
}

/** 在同一 context-realm 信封语义下求值单个表达式（@@if 装饰器条件用）。 */
export async function evalExpressionSandboxed(expression: string, env: Record<string, unknown>): Promise<unknown> {
  if (typeof expression !== 'string') throw new TypeError('template expression must be a string')
  const wrapper = `(async function (__env) { with (__env) { return await (${expression}); } })`
  const script = new vm.Script(wrapper, { filename: 'tavern-template-expr.ejs' })
  const realm = createSandboxRealm(env)
  const factory = script.runInContext(realm.context) as (e: Record<string, unknown>) => Promise<unknown>
  const result = await factory(realm.env)
  if (typeof result === 'function') {
    throw new TypeError('template expression returned a function; functions cannot cross the template sandbox boundary')
  }
  if (typeof result === 'symbol') {
    throw new TypeError('template expression returned a symbol; symbols cannot cross the template sandbox boundary')
  }
  try {
    return structuredClone(result)
  } catch (error) {
    throw new TypeError(`template expression result cannot be cloned across the template sandbox boundary: ${describeThrown(error)}`)
  }
}
