import type { AgentTavernAdapter } from './capabilities.js'

export interface DshContextLike {
  agentPresets?: {
    mount?: (agentContext: unknown, presetId: string) => Promise<unknown>
  }
  systemPrompt?: {
    section?: (...args: unknown[]) => unknown
    context?: (...args: unknown[]) => unknown
  }
  tools?: {
    register?: (...args: unknown[]) => unknown
  }
  agents?: {
    get?: (...args: unknown[]) => unknown
    create?: (...args: unknown[]) => unknown
  }
}

/** Keep rc-specific service probing in one place instead of spreading it through tools. */
export function createDshAgentTavernAdapter(ctx: DshContextLike): AgentTavernAdapter {
  return {
    preset: typeof ctx.agentPresets?.mount === 'function' ? {
      mount: (agentContext, presetId) => ctx.agentPresets!.mount!(agentContext, presetId),
    } : undefined,
    scopedPrompt: typeof ctx.systemPrompt?.section === 'function'
      && typeof ctx.systemPrompt?.context === 'function',
    tools: typeof ctx.tools?.register === 'function',
    // Agent.session is the durable event source; a live registry is the host's
    // public proof that those sessions are available to the plugin.
    durableEvents: typeof ctx.agents?.get === 'function',
    contextProjection: false,
    projectionAwareCompaction: false,
  }
}
