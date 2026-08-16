import { describe, expect, it, vi } from 'vitest'
import {
  bootstrapAgentTavernCapabilities,
  inspectAgentTavernCapabilities,
} from '../src/agent-tavern/capabilities.js'
import { createDshAgentTavernAdapter } from '../src/agent-tavern/dsh-adapter.js'

describe('AgentTavern host capabilities', () => {
  it('enables native and fails managed closed without the projection seams', () => {
    const result = inspectAgentTavernCapabilities({
      preset: { mount: async () => ({ id: 'agent-tavern' }) },
      scopedPrompt: true,
      tools: true,
      durableEvents: true,
    })
    expect(result.native).toEqual({ available: true, missing: [], reasons: [] })
    expect(result.managed.available).toBe(false)
    expect(result.managed.missing).toEqual(['agent/context', 'projection-aware-compaction'])
  })

  it('reports every missing native dependency instead of falling back to ST', () => {
    const result = inspectAgentTavernCapabilities({})
    expect(result.native.available).toBe(false)
    expect(result.native.missing).toEqual(['preset', 'scoped-prompt', 'tools', 'durable-events'])
    expect(result.managed.missing).toContain('agent/context')
  })

  it('surfaces preset provisioning failures in both modes', async () => {
    const result = await bootstrapAgentTavernCapabilities({
      preset: { mount: async () => ({ id: 'agent-tavern' }) },
      scopedPrompt: true,
      tools: true,
      durableEvents: true,
    }, { ensurePreset: async () => { throw new Error('preset root is read-only') } })
    expect(result.native.available).toBe(false)
    expect(result.native.missing).toContain('preset')
    expect(result.native.reasons).toContain('preset root is read-only')
  })

  it('maps the rc.6 context into the narrow adapter', async () => {
    const mount = vi.fn(async () => ({ id: 'agent-tavern' }))
    const adapter = createDshAgentTavernAdapter({
      agentPresets: { mount },
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: () => {} },
      agents: { get: () => undefined, create: () => undefined },
    })
    const capabilities = inspectAgentTavernCapabilities(adapter)
    expect(capabilities.native.available).toBe(true)
    await adapter.preset!.mount({ scoped: true }, 'agent-tavern')
    expect(mount).toHaveBeenCalledWith({ scoped: true }, 'agent-tavern')
  })
})
