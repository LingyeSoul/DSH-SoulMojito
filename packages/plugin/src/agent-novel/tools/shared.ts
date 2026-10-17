/**
 * AgentNovel tool surface shared base (2026-10-17 source split).
 *
 * Cross-domain types, the tool factory, binding resolution and paging live
 * here. Memoized store singletons live in stores.ts; domain tool slices live
 * in the sibling modules and are concatenated by agent.ts in the original
 * registration order.
 */

import { NovelNotFoundError, type NovelSnapshot } from '../../../../tavern-store/src/index.js'
import { noteToolOutputBytes } from '../usage.js'
import { findWriterDelegation } from '../writer.js'
import { novelStore, tavernStore } from './stores.js'


export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (_args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: ToolExecution) => Promise<unknown>
}

export interface ToolExecution {
  agent?: { id?: string; ctx?: { subagents?: unknown; get?: (name: string) => unknown } }
  signal?: AbortSignal
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
    // W0 usage sampling (0007 §7): count successful tool output bytes per tool
    // name; audit-grade observation only — sampling must never break the tool.
    execute: async (args, exec) => {
      const result = await execute(args, exec)
      try {
        noteToolOutputBytes(name, Buffer.byteLength(JSON.stringify(result), 'utf8'))
      } catch {
        /* best-effort sampling only */
      }
      return result
    },
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

/** §4.2: the novel identity comes from the session binding alone (§15: no tool parameter may carry it). */
export async function novelBindingFor(exec: ToolExecution): Promise<string> {
  return (await resolveNovelBinding(exec)).novelId
}

export interface NovelBindingResolution {
  novelId: string
  /** Present when the caller is a delegated writer subagent (0007 §6.2): the single unit its delegation covers. */
  delegatedUnitId?: string
}

/**
 * Binding resolution order (0007 §6.2): first the session binding keyed by
 * exec.agent.id (the author); on a miss, the in-process writer delegation
 * registry keyed by the spawn run id — a delegated writer is never
 * session-bound, its authority is the delegation alone. Both misses keep the
 * existing binding error semantics (delegation validity included in the hint).
 */
export async function resolveNovelBinding(exec: ToolExecution): Promise<NovelBindingResolution> {
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string' || agentId.trim() === '') throw new Error('AgentNovel tool requires the current agent')
  const binding = (await (await tavernStore()).getState()).sessionBindings[agentId]
  if (binding !== undefined && binding.architecture === 'agent-novel' && typeof binding.novelId === 'string' && binding.novelId.trim() !== '') {
    return { novelId: binding.novelId }
  }
  const delegation = findWriterDelegation(agentId)
  if (delegation !== undefined && delegation.novelId.trim() !== '') {
    return { novelId: delegation.novelId, delegatedUnitId: delegation.unitId }
  }
  throw new Error('AgentNovel binding is unavailable for this agent (a delegated writer additionally requires an active delegation)')
}

/**
 * Author-only gate for write-sensitive tools outside WRITER_ALLOW_LIST (0007
 * §5.2/§6.2): the host toolFilter is the primary fence, this is the tool-layer
 * backstop against a missing or ineffective toolFilter. Covers
 * novel_outline_create/revise, novel_requirement_block, novel_unit_claim,
 * novel_chapter_complete, novel_finish, tavern_deduce and both writer tools.
 */
export async function authorBindingFor(exec: ToolExecution): Promise<string> {
  const binding = await resolveNovelBinding(exec)
  if (binding.delegatedUnitId !== undefined) {
    throw new Error(`this author tool is not part of the delegated writer allow list (§5.2); the delegation covers unit '${binding.delegatedUnitId}' only`)
  }
  return binding.novelId
}

export async function snapshotOf(novelId: string): Promise<NovelSnapshot> {
  const snapshot = await (await novelStore()).getNovel(novelId)
  if (snapshot === undefined) throw new NovelNotFoundError({ novelId })
  return snapshot
}

export function pageCursor(value: unknown): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('cursor must be a non-negative integer')
  return parsed
}
