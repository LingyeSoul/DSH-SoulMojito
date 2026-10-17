/**
 * AgentTavern tool surface shared base (2026-10-17 source split).
 *
 * Cross-domain types, the tool factory, scope resolution and the write-scope
 * gate live here. Memoized store singletons live in stores.ts; domain tool
 * slices live in the sibling modules and are concatenated by agent.ts in the
 * original registration order.
 */

import { stringArg } from '../../tool-args.js'
import { tavernStore } from './stores.js'

export const DEFAULT_USER = 'User'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (_args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: ToolExecution) => Promise<unknown>
}

export interface ToolExecution {
  agent?: { id?: string }
  signal?: AbortSignal
}

export interface BindingContext {
  agentId: string
  character: string
  chatId: string
}

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


export function objectOutput(properties: Record<string, unknown>, optionalKeys: readonly string[] = ['value', 'revision', 'updatedAt']): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties).filter((key) => !optionalKeys.includes(key)), additionalProperties: false }
}


const MEMORY_SCOPES = ['chat', 'character', 'agent', 'global'] as const
const VARIABLE_SCOPES = ['chat', 'character', 'agent', 'global', 'turn'] as const

type ToolMemoryScope = (typeof MEMORY_SCOPES)[number]
type ToolVariableScope = (typeof VARIABLE_SCOPES)[number]

export function memoryScopeParameter(required: boolean): Record<string, unknown> {
  return { type: 'string', enum: [...MEMORY_SCOPES], ...(required ? { required: true } : {}) }
}

export function variableScopeParameter(required: boolean): Record<string, unknown> {
  return { type: 'string', enum: [...VARIABLE_SCOPES], ...(required ? { required: true } : {}) }
}

interface ScopeTarget {
  scope: ToolMemoryScope | ToolVariableScope
  scopeId: string
}

function scopeTarget(name: string, binding: BindingContext): ScopeTarget {
  if (name === 'chat') return { scope: 'chat', scopeId: binding.chatId }
  if (name === 'character') return { scope: 'character', scopeId: binding.character }
  if (name === 'agent') return { scope: 'agent', scopeId: binding.agentId }
  if (name === 'global') return { scope: 'global', scopeId: 'global' }
  if (name === 'turn') return { scope: 'turn', scopeId: binding.agentId }
  throw new Error(`unsupported AgentTavern scope '${name}'`)
}

export function selectedMemoryScopes(scope: unknown, binding: BindingContext): Array<{ scope: ToolMemoryScope; scopeId: string }> {
  const names = scope === undefined ? [...MEMORY_SCOPES] : [stringArg(scope)]
  return names.map((name) => {
    if (name === 'turn') throw new Error(`unsupported AgentTavern scope '${name}'`)
    return scopeTarget(name, binding) as { scope: ToolMemoryScope; scopeId: string }
  })
}

export function selectedVariableScope(scope: unknown, binding: BindingContext): { scope: ToolVariableScope; scopeId: string } {
  return scopeTarget(stringArg(scope), binding) as { scope: ToolVariableScope; scopeId: string }
}

/** global 作用域写入必须由用户在设置中显式开启；读取不受限。 */
export async function assertWriteScopeAllowed(scope: ToolMemoryScope | ToolVariableScope): Promise<void> {
  if (scope !== 'global') return
  const state = await (await tavernStore()).getState()
  if (state.agentTavernAllowGlobalWrites !== true) {
    throw new Error('global scope writes are disabled; ask the user to enable them in the Tavern settings')
  }
}

export async function bindingFor(exec: ToolExecution): Promise<BindingContext> {
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string' || agentId.trim() === '') throw new Error('AgentTavern tool requires the current agent')
  const binding = (await (await tavernStore()).getState()).sessionBindings[agentId]
  if (!binding || binding.architecture !== 'agent-tavern' || binding.group === true) {
    throw new Error('AgentTavern binding is unavailable for this agent')
  }
  return { agentId, character: binding.character, chatId: binding.chatId }
}


export function identitySummaryOf(data: { extensions?: Record<string, unknown> }): string | undefined {
  const agentTavern = data.extensions?.agentTavern as Record<string, unknown> | undefined
  const summary = agentTavern?.identitySummary
  return typeof summary === 'string' && summary.trim() !== '' ? summary : undefined
}
