/**
 * 模板运行时：保护块预处理 + `node:vm` 沙箱执行。
 *
 * 沙箱上下文为全新 vm context（仅标准 JS 内建，无 require/process/timer/网络）；
 * 模板可见的全部宿主能力都经 env 显式注入。隔离级别与仓库既有教义一致
 * （gates 对 client 代码同样只做 `node:vm` 沙箱），不承诺对抗恶意模板。
 */

import vm from 'node:vm'
import { compileTemplate } from './syntax.js'

/** 这些块内的 `<%`/`%>` 转为字面量（不执行）：escape-ejs 显式保护 + 推理标签保护。 */
export function protectBlocks(source: string): string {
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
  return source.includes('<%')
}

export interface RenderOptions {
  /** 渲染失败时的伪位置标签（诊断用）。 */
  where?: string
}

/**
 * 在沙箱中渲染模板。env 提供模板可见的全部变量与函数；
 * `__append`/`__escape`/`print`/`__out` 注入 env（非枚举，`variables` 等用户对象不受影响）。
 */
/** 构造沙箱 env：宿主 env + 非枚举的 __out/__append/__escape/print 通道。 */
function buildSandboxEnv(env: Record<string, unknown>): Record<string, unknown> {
  let out = ''
  const sandboxEnv: Record<string, unknown> = Object.create(null)
  Object.assign(sandboxEnv, env)
  const defineHidden = (key: string, descriptor: PropertyDescriptor): void => {
    Object.defineProperty(sandboxEnv, key, { ...descriptor, enumerable: false, configurable: true })
  }
  defineHidden('__out', {
    get: () => out,
    set: (value: unknown) => {
      out = String(value ?? '')
    },
  })
  defineHidden('__append', {
    value: (value: unknown) => {
      out += value === null || value === undefined ? '' : String(value)
    },
  })
  defineHidden('__escape', { value: htmlEscape })
  defineHidden('print', {
    value: (...args: unknown[]) => {
      out += args.map((a) => (a === null || a === undefined ? '' : String(a))).join(' ')
    },
  })
  return sandboxEnv
}

export async function renderSandboxed(source: string, env: Record<string, unknown>, options: RenderOptions = {}): Promise<string> {
  try {
    const protectedSource = protectBlocks(source)
    const sandboxEnv = buildSandboxEnv(env)
    const factory = compile(protectedSource).script.runInNewContext(sandboxEnv) as (e: Record<string, unknown>) => Promise<string>
    return await factory(sandboxEnv)
  } catch (err) {
    const where = options.where ? ` (${options.where})` : ''
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    throw new Error(`template execution failed${where}: ${message}`)
  }
}

/** 在同一沙箱语义下求值单个表达式（@@if 装饰器条件用）。 */
export async function evalExpressionSandboxed(expression: string, env: Record<string, unknown>): Promise<unknown> {
  const wrapper = `(async function (__env) { with (__env) { return await (${expression}); } })`
  const script = new vm.Script(wrapper, { filename: 'tavern-template-expr.ejs' })
  const sandboxEnv: Record<string, unknown> = Object.create(null)
  Object.assign(sandboxEnv, env)
  const factory = script.runInNewContext(sandboxEnv) as (e: Record<string, unknown>) => Promise<unknown>
  return await factory(sandboxEnv)
}
