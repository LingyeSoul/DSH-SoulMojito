import { afterEach, describe, expect, it } from 'vitest'
import type { HostAgentLike } from '../src/host-contract.js'
import { invalidateImToolBindingCache, mountImToolsOnAgent, unmountAllImTools, unmountImToolsForAgent } from '../src/im/agent-mount.js'
import type { ImToolsDeps } from '../src/im/tools.js'
import type { TavernStore } from '../../tavern-store/src/index.js'

const deps: ImToolsDeps = {
  db: async () => ({}) as TavernStore,
  runtime: () => undefined,
}

afterEach(() => {
  unmountAllImTools()
  invalidateImToolBindingCache()
})

function toolService(log: {
  names: string[]
  disposed: string[]
  conditions: Array<(context: { agent?: { id?: string; session?: { id?: string } } }) => boolean | Promise<boolean>>
}) {
  return {
    register: (tool: { name: string }, options?: { when?: (context: { agent?: { id?: string; session?: { id?: string } } }) => boolean | Promise<boolean> }) => {
      log.names.push(tool.name)
      if (options?.when !== undefined) log.conditions.push(options.when)
      return () => { log.disposed.push(tool.name) }
    },
  }
}

function emptyLog() {
  return { names: [] as string[], disposed: [] as string[], conditions: [] as Array<(context: { agent?: { id?: string; session?: { id?: string } } }) => boolean | Promise<boolean>> }
}

describe('mountImToolsOnAgent', () => {
  it('registers the three IM tools into the agent mount domain once', () => {
    const log = emptyLog()
    const agent: HostAgentLike = { id: 'session-a', ctx: { tools: toolService(log) } }
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toEqual(['im_identity', 'im_channels', 'im_send', 'im_time'])
    // 第二次（agent/created + agent/status 双入口）是空操作，不会重复注册。
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    expect(log.names).toHaveLength(4)
  })

  it('retries when the tools service was not ready on the first attempt', () => {
    const log = emptyLog()
    const agent: HostAgentLike = { id: 'session-a', ctx: {} }
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    // 宿主 compose 完成后 status 入口再试一次。
    ;(agent.ctx as { tools?: unknown }).tools = toolService(log)
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toHaveLength(4)
  })

  it('falls back to the session id and skips agents without any id', () => {
    const log = emptyLog()
    const fromSession: HostAgentLike = { session: { id: 'session-b' }, ctx: { tools: toolService(log) } }
    expect(mountImToolsOnAgent(deps, fromSession)).toBe(true)
    expect(mountImToolsOnAgent(deps, { ctx: { tools: toolService(log) } })).toBe(false)
    expect(log.names).toHaveLength(4)
  })

  it('warns once when the agent has no tools.register', () => {
    const warnings: string[] = []
    const withLogger: ImToolsDeps = {
      ...deps,
      logger: { warn: (message) => { warnings.push(message) } },
    }
    const agent: HostAgentLike = { id: 'session-a', ctx: {} }
    expect(mountImToolsOnAgent(withLogger, agent)).toBe(false)
    expect(mountImToolsOnAgent(withLogger, agent)).toBe(false)
    // agent/status 会反复重试；同一个形状问题只报一次。
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no tools.register')
  })

  it('logs a registration failure instead of silently losing the tool surface', () => {
    const warnings: string[] = []
    const withLogger: ImToolsDeps = {
      ...deps,
      logger: { warn: (message) => { warnings.push(message) } },
    }
    const agent: HostAgentLike = {
      id: 'session-a',
      ctx: { tools: { register: () => { throw new Error('scope is disposed') } } },
    }
    expect(mountImToolsOnAgent(withLogger, agent)).toBe(false)
    expect(warnings.some((message) => message.includes('scope is disposed'))).toBe(true)
  })

  it('skips subagent sessions', () => {
    const log = emptyLog()
    const agent: HostAgentLike = {
      id: 'subagent-1',
      session: { id: 'subagent-1', header: { origin: 'subagent' } },
      ctx: { tools: toolService(log) },
    }
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    expect(log.names).toEqual([])
  })

  it('hides IM tools from sessions without a peer binding', async () => {
    const state = {
      imPeers: {
        'qq:1:private:peer-a': { sessionId: 'session-a' },
      },
    }
    const withStore: ImToolsDeps = {
      ...deps,
      db: async () => ({ getState: async () => state }) as unknown as TavernStore,
    }
    const log = emptyLog()
    const agent: HostAgentLike = { id: 'session-a', ctx: { tools: toolService(log) } }
    expect(mountImToolsOnAgent(withStore, agent)).toBe(true)
    const condition = log.conditions[0]
    expect(condition).toBeDefined()
    expect(await condition!({ agent: { id: 'session-a' } })).toBe(true)
    expect(await condition!({ agent: { id: 'session-unbound' } })).toBe(false)

    state.imPeers['qq:1:private:peer-b'] = { sessionId: 'session-b' }
    invalidateImToolBindingCache()
    expect(await condition!({ agent: { id: 'session-b' } })).toBe(true)
  })

  it('unmounts one agent and allows a later remount', () => {
    const log = emptyLog()
    const agent: HostAgentLike = { id: 'session-a', ctx: { tools: toolService(log) } }
    mountImToolsOnAgent(deps, agent)
    unmountImToolsForAgent('session-a')
    expect(log.disposed).toEqual(['im_identity', 'im_channels', 'im_send', 'im_time'])
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toHaveLength(8)
  })
})

