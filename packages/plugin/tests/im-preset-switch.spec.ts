import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import type { HostAgentLike, PluginContext } from '../src/host-contract.js'
import { createImRuntime } from '../src/im/runtime.js'
import { imPeerKey } from '../src/im/types.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-preset-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface FakeAgent {
  agent: HostAgentLike
  events: Array<{ type: string; data: unknown }>
  recomposed: string[]
  status: 'idle' | 'running'
}

function fakeAgent(options: {
  id?: string
  status?: 'idle' | 'running'
  initialPreset?: string
  architecture?: 'agent-tavern' | 'agent-novel' | 'card-workbench' | 'st'
} = {}): FakeAgent {
  const id = options.id ?? 'session-a'
  const events: Array<{ type: string; data: unknown }> = []
  if (options.initialPreset !== undefined) {
    events.push({ type: 'agent-preset/selected', data: { agentPreset: options.initialPreset } })
  }
  const recomposed: string[] = []
  const agent: HostAgentLike = {
    id,
    status: options.status ?? 'idle',
    ctx: { tools: { register: () => () => {} } },
    session: {
      id,
      header: { version: 4 },
      events,
      append: (type: string, data: unknown) => {
        events.push({ type, data })
      },
    },
    followup: async () => {},
  }
  return { agent, events, recomposed, status: options.status ?? 'idle' }
}

function contextOf(state: FakeAgent, options: { architecture?: string } = {}): PluginContext {
  return {
    webServer: { register: () => () => {} },
    agents: { get: (id: string) => (id === 'session-a' ? state.agent : undefined) },
    agentPresets: {
      recompose: async (_agentContext: unknown, presetId: string) => {
        state.recomposed.push(presetId)
        return { id: presetId }
      },
    },
  } as unknown as PluginContext
}

async function bindPeer(architecture?: string): Promise<void> {
  const key = imPeerKey('qq', 'acct', 'private', 'peer-a')
  await db.updateState((state) => ({
    imPeers: {
      [key]: { sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
    },
    ...(architecture === undefined
      ? {}
      : {
        sessionBindings: {
          ...state.sessionBindings,
          'session-a': { architecture: architecture as never, character: '', chatId: '' },
        },
      }),
  }))
}

describe('IM binding switches the session to AgentTavernIM', () => {
  it('recomposes a live idle session and writes the preset marker', async () => {
    await bindPeer()
    const fake = fakeAgent()
    const runtime = createImRuntime(contextOf(fake), { db })
    try {
      const result = await runtime.applyImPreset?.('session-a')
      expect(result).toEqual({ applied: true })
      expect(fake.recomposed).toEqual(['agent-tavern-im'])
      expect(fake.events).toContainEqual({
        type: 'agent-preset/selected',
        data: { agentPreset: 'agent-tavern-im' },
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('defers while the session is running instead of recomposing mid-turn', async () => {
    await bindPeer()
    const fake = fakeAgent({ status: 'running' })
    const runtime = createImRuntime(contextOf(fake), { db })
    try {
      const result = await runtime.applyImPreset?.('session-a')
      expect(result?.applied).toBe(false)
      expect(result?.reason).toContain('running')
      expect(fake.recomposed).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('does not switch a novel/workbench/ST session', async () => {
    await bindPeer('card-workbench')
    const fake = fakeAgent()
    const runtime = createImRuntime(contextOf(fake), { db })
    try {
      const result = await runtime.applyImPreset?.('session-a')
      expect(result?.applied).toBe(false)
      expect(result?.reason).toContain("session architecture 'card-workbench'")
      expect(fake.recomposed).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('is idempotent when the session already carries the IM preset', async () => {
    await bindPeer()
    const fake = fakeAgent({ initialPreset: 'agent-tavern-im' })
    const runtime = createImRuntime(contextOf(fake), { db })
    try {
      expect(await runtime.applyImPreset?.('session-a')).toEqual({ applied: true })
      expect(fake.recomposed).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('only touches sessions with an IM binding during the startup sweep', async () => {
    await bindPeer()
    const bound = fakeAgent()
    const unbound = fakeAgent({ id: 'session-b' })
    const runtime = createImRuntime(contextOf(bound), { db })
    try {
      await runtime.ensurePresetForAgent?.(unbound.agent)
      expect(unbound.recomposed).toEqual([])
      await runtime.ensurePresetForAgent?.(bound.agent)
      expect(bound.recomposed).toEqual(['agent-tavern-im'])
    } finally {
      await runtime.dispose()
    }
  })
})
