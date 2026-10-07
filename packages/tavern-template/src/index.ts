/**
 * `@dsh-tavern/template`：ST-Prompt-Template 兼容的 EJS 模板运行时（clean-room 复刻，
 * 见 docs/proposals/0008-prompt-template.md）。
 */

import { createTemplateEnv, type TemplateHost } from './api.js'
import { hasTemplateTag, evalExpressionSandboxed, renderSandboxed } from './runtime.js'
import {
  applyGenerateInjections,
  applyInjectEntries,
  applyRenderInjections,
  classifySpecialEntry,
  parseInitialVariables,
  type SpecialEntry,
  type TemplateMessage,
  type Warn,
} from './inject.js'
import type { JsonObject } from './paths.js'
import { TemplateVariableSystem, type TemplateVariableStores } from './variables.js'

export * from './paths.js'
export * from './variables.js'
export * from './api.js'
export * from './inject.js'
export * from './runtime.js'
export * from './syntax.js'
export { parseYamlSubset, YamlSubsetError } from './yaml.js'

export interface TemplateRuntimeOptions {
  host: TemplateHost
  stores: TemplateVariableStores
  onWarning?: Warn
}

export interface TemplateRuntime {
  readonly variables: TemplateVariableSystem
  readonly defines: Record<string, unknown>
  /** 渲染一段文本；无模板标签时直通。extraEnv 追加到基础 env（world_info / matched_* 等）。 */
  renderText(text: string, extraEnv?: Record<string, unknown>, where?: string): Promise<string>
  /** @@if 装饰器条件求值（失败告警并视为 false）。 */
  evaluateCondition(condition: string): Promise<boolean>
  /** GENERATE/RENDER/@INJECT 的分类便捷入口。 */
  classify(entry: { comment?: string; content: string }): ReturnType<typeof classifySpecialEntry>
  applyGenerateInjections(messages: TemplateMessage[], entries: SpecialEntry[]): Promise<TemplateMessage[]>
  applyInjectEntries(messages: TemplateMessage[], entries: SpecialEntry[]): Promise<TemplateMessage[]>
  applyRenderInjections(text: string, entries: SpecialEntry[]): Promise<string>
  /** 解析 InitialVariables 内容（JSON 优先，YAML 子集兜底）；失败返回 null。 */
  parseInitialVariables(content: string): JsonObject | null
  /** 重置 initial 作用域并重建变量视图（须先于任何渲染；ST 每次加载重算语义）。 */
  setInitialVariables(data: Record<string, unknown>): void
}

export function createTemplateRuntime(options: TemplateRuntimeOptions): TemplateRuntime {
  const { host, stores, onWarning } = options
  const warn: Warn = onWarning ?? (() => {})
  const variables = new TemplateVariableSystem(stores)
  const defines: Record<string, unknown> = {}
  const getwiDepth = { current: 0 }
  host.onWarning = warn

  const buildEnv = (extra?: Record<string, unknown>): Record<string, unknown> => {
    const env = createTemplateEnv({ vars: variables, host, defines, getwiDepth })
    if (extra !== undefined) Object.assign(env, extra)
    return env
  }

  const renderText = async (text: string, extraEnv?: Record<string, unknown>, where?: string): Promise<string> => {
    if (!hasTemplateTag(text)) return text
    return await renderSandboxed(text, buildEnv(extraEnv), { where })
  }

  const evaluateCondition = async (condition: string): Promise<boolean> => {
    try {
      return Boolean(await evalExpressionSandboxed(condition, buildEnv()))
    } catch (err) {
      warn(`@@if condition evaluation failed ("${condition}"): ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  const evaluate = (condition: string) => evaluateCondition(condition)
  const render = (text: string, extraEnv?: Record<string, unknown>) => renderText(text, extraEnv)

  return {
    variables,
    defines,
    renderText,
    evaluateCondition,
    classify: classifySpecialEntry,
    applyGenerateInjections: (messages, entries) =>
      applyGenerateInjections(messages, entries, render, buildEnv(), evaluate, warn),
    applyInjectEntries: (messages, entries) =>
      applyInjectEntries(messages, entries, render, buildEnv(), evaluate, warn),
    applyRenderInjections: (text, entries) => applyRenderInjections(text, entries, render, buildEnv(), evaluate, warn),
    parseInitialVariables: (content) => parseInitialVariables(content, warn),
    setInitialVariables: (data) => {
      variables.setInitialVariables(data as JsonObject)
    },
  }
}
