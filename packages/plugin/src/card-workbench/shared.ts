/**
 * 写卡工作台共享底座（决策 2026-10-09-dedup-refactor 域拆分）。
 *
 * agent.ts 原为 2100 行单文件：22 个工具（card / world / preset / material 四域）
 * 的 schema、参数解析、摘要与执行核混装。拆分后本模块承载跨域共享的底座：
 * TavernStore 懒单例（全工作台唯一实例——单写者纪律，严禁在域模块里另开一份）、
 * requireCharacter、工具构造工厂（tool / objectOutput）、确认协议错误文案与
 * card/world 方案工具共用的 titleArg。各域工具与域 helper 在 tools-card /
 * tools-world / tools-preset / tools-material；agent.ts 仍是 bundle 入口
 * （KERNEL + 预设投影挂载 + apply）与工具聚合器（createTools 按既有顺序拼装）。
 */

import { TavernStore, type CharacterFile } from '../../../tavern-store/src/index.js'
import { dshHomePath } from '../dsh-home.js'

let tavernStorePromise: Promise<TavernStore> | undefined

export function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= TavernStore.open(dshHomePath('tavern')))
}

export async function requireCharacter(name: string): Promise<CharacterFile> {
  const found = await (await tavernStore()).getCharacter(name)
  if (found === undefined) throw new Error(`character '${name}' not found`)
  return found
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (_args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: ToolExecution) => Promise<unknown>
}

/** 宿主工具执行身份面（dsh-agent 的 ToolExecutionInput.agent）：id 即会话
 *  id，session 是活会话对象，ctx 是 agent 作用域 Context。全部可选——老宿主
 *  与测试 stub 可能不带，探测失败按缺失处理。 */
export interface WorkbenchExecAgent {
  id?: string
  session?: unknown
  ctx?: {
    get?: (name: string) => unknown
    sessionTitle?: unknown
  }
}

export interface ToolExecution {
  agent?: WorkbenchExecAgent
  signal?: AbortSignal
}

export const CONFIRMATION_ERROR = 'confirmation required: present the per-field before/after plan to the user and call again with confirmed: true only after they explicitly approve it'

export function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  schema: Record<string, unknown>,
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    name,
    description,
    parameters: compileParameters(properties),
    output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}

function compileParameters(properties: Record<string, unknown>): Record<string, unknown> {
  const required: string[] = []
  const compiled = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [key, value]
    const property = { ...value as Record<string, unknown> }
    if (property.required === true) required.push(key)
    delete property.required
    return [key, property]
  }))
  return {
    type: 'object',
    properties: compiled,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export function objectOutput(properties: Record<string, unknown>, optionalKeys: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties).filter((key) => !optionalKeys.includes(key)), additionalProperties: false }
}

/** 方案标题参数（card_plan_propose / world_plan_propose 共用）。 */
export function titleArg(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('title must be a non-empty string')
  if (value.length > 200) throw new Error('title exceeds the 200-character limit')
  return value
}
