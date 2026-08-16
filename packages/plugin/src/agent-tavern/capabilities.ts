export const AGENT_TAVERN_PRESET_ID = 'agent-tavern'

export type AgentTavernCapabilityName =
  | 'preset'
  | 'scoped-prompt'
  | 'tools'
  | 'durable-events'
  | 'agent/context'
  | 'projection-aware-compaction'

export interface AgentTavernCapabilityStatus {
  available: boolean
  missing: AgentTavernCapabilityName[]
  reasons: string[]
}

export interface AgentTavernCapabilities {
  presetId: string
  native: AgentTavernCapabilityStatus
  managed: AgentTavernCapabilityStatus
  checkedAt: string
}

export interface AgentTavernAdapter {
  preset?: { mount(agentContext: unknown, presetId: string): Promise<unknown> }
  scopedPrompt?: boolean
  tools?: boolean
  durableEvents?: boolean
  contextProjection?: boolean
  projectionAwareCompaction?: boolean
}

export interface AgentTavernBootstrapOptions {
  presetId?: string
  ensurePreset?: () => Promise<void>
}

const REASONS: Record<AgentTavernCapabilityName, string> = {
  preset: 'DSH agent preset mounting is unavailable.',
  'scoped-prompt': 'DSH agent-scoped system prompt registration is unavailable.',
  tools: 'DSH native tool registration is unavailable.',
  'durable-events': 'DSH durable agent session events are unavailable.',
  'agent/context': 'The host does not expose the agent/context history projection seam.',
  'projection-aware-compaction': 'The host cannot measure compaction against the effective AgentTavern projection.',
}

export function inspectAgentTavernCapabilities(
  adapter: AgentTavernAdapter,
  presetId = AGENT_TAVERN_PRESET_ID,
): AgentTavernCapabilities {
  const nativeMissing: AgentTavernCapabilityName[] = []
  if (typeof adapter.preset?.mount !== 'function') nativeMissing.push('preset')
  if (adapter.scopedPrompt !== true) nativeMissing.push('scoped-prompt')
  if (adapter.tools !== true) nativeMissing.push('tools')
  if (adapter.durableEvents !== true) nativeMissing.push('durable-events')

  const managedMissing = [...nativeMissing]
  if (adapter.contextProjection !== true) managedMissing.push('agent/context')
  if (adapter.projectionAwareCompaction !== true) managedMissing.push('projection-aware-compaction')

  return {
    presetId,
    native: status(nativeMissing),
    managed: status(managedMissing),
    checkedAt: new Date().toISOString(),
  }
}

export async function bootstrapAgentTavernCapabilities(
  adapter: AgentTavernAdapter,
  options: AgentTavernBootstrapOptions = {},
): Promise<AgentTavernCapabilities> {
  const presetId = options.presetId ?? AGENT_TAVERN_PRESET_ID
  let result = inspectAgentTavernCapabilities(adapter, presetId)
  if (options.ensurePreset === undefined) return result

  try {
    await options.ensurePreset()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    result = {
      ...result,
      native: unavailableWithReason(result.native, 'preset', reason),
      managed: unavailableWithReason(result.managed, 'preset', reason),
    }
  }
  return result
}

function status(missing: AgentTavernCapabilityName[]): AgentTavernCapabilityStatus {
  return {
    available: missing.length === 0,
    missing: [...missing],
    reasons: missing.map((name) => REASONS[name]),
  }
}

function unavailableWithReason(
  current: AgentTavernCapabilityStatus,
  name: AgentTavernCapabilityName,
  detail: string,
): AgentTavernCapabilityStatus {
  const missing = current.missing.includes(name) ? current.missing : [name, ...current.missing]
  return { available: false, missing, reasons: [REASONS[name], detail, ...current.reasons] }
}
