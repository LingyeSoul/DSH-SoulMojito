/**
 * AgentNovel host capability report (proposal 0005 §16).
 *
 * Pure feature detection in the style of packages/bind/src/host-shape.ts:
 * typeof probes only, never version numbers. Fail-closed: a missing core
 * contract item makes the whole preset unavailable — no silent degradation
 * to a manual chat. Event emission itself cannot be probed statically, so
 * per-event entries only verify that the subscription hook exists and say
 * so explicitly in the reason text.
 */

export const AGENT_NOVEL_PRESET_ID = 'agent-novel'

export interface AgentNovelCapabilities {
  available: boolean
  missing: string[]
  reasons: string[]
  checkedAt: string
}

export interface AgentNovelCapabilityContext {
  agents?: unknown
  agentPresets?: unknown
  systemPrompt?: unknown
  tools?: unknown
  on?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** Event types the novel lifecycle must subscribe to (§9.1 receive barrier, §12.1 scheduling). */
const REQUIRED_EVENT_TYPES = ['session/event', 'agent/created', 'agent/status'] as const

export function inspectAgentNovelCapabilities(ctx: AgentNovelCapabilityContext | null | undefined): AgentNovelCapabilities {
  const missing: string[] = []
  const reasons: string[] = []
  const need = (id: string, ok: boolean, reason: string): void => {
    if (ok) return
    missing.push(id)
    reasons.push(reason)
  }

  const agents = isObject(ctx?.agents) ? ctx?.agents as Record<string, unknown> : undefined
  need('agents', agents !== undefined, "host context exposes no 'agents' service object (§16 followup scheduling)")
  need('agents.withoutInitiator', isFunction(agents?.withoutInitiator), "agents.withoutInitiator is not callable; agent-initiated followups without a user initiator cannot be driven (§16)")

  const presets = isObject(ctx?.agentPresets) ? ctx?.agentPresets as Record<string, unknown> : undefined
  need('agentPresets.mount', isFunction(presets?.mount), "agentPresets.mount is not callable; the novel preset cannot be mounted (§16)")
  need('agentPresets.recompose', isFunction(presets?.recompose), "agentPresets.recompose is not callable; preset recomposition for the novel architecture is unavailable (§16)")

  const systemPrompt = isObject(ctx?.systemPrompt) ? ctx?.systemPrompt as Record<string, unknown> : undefined
  need('systemPrompt.section', isFunction(systemPrompt?.section), "systemPrompt.section is not callable; the novel kernel cannot be registered (§11)")
  need('tools.register', isFunction(isObject(ctx?.tools) ? (ctx?.tools as Record<string, unknown>).register : undefined), "tools.register is not callable; the novel tool surface cannot be registered (§11)")

  for (const eventType of REQUIRED_EVENT_TYPES) {
    need(
      `on:${eventType}`,
      isFunction(ctx?.on),
      `event subscription for '${eventType}' is unavailable: the host exposes no 'on' hook, and actual emission of the event type cannot be probed statically (§16)`,
    )
  }

  return {
    available: missing.length === 0,
    missing,
    reasons,
    checkedAt: new Date().toISOString(),
  }
}
