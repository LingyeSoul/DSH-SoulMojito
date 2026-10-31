import { afterEach, describe, expect, it } from 'vitest'
import type { HostAgentLike } from '../src/host-contract.js'
import { mountImToolsOnAgent, unmountAllImTools, unmountImToolsForAgent } from '../src/im/agent-mount.js'
import type { ImToolsDeps } from '../src/im/tools.js'
import type { TavernStore } from '../../tavern-store/src/index.js'

const deps: ImToolsDeps = {
  db: async () => ({}) as TavernStore,
  runtime: () => undefined,
}

afterEach(() => {
  unmountAllImTools()
})

function toolService(log: { names: string[]; disposed: string[] }) {
  return {
    register: (tool: { name: string }) => {
      log.names.push(tool.name)
      return () => { log.disposed.push(tool.name) }
    },
  }
}

describe('mountImToolsOnAgent', () => {
  it('registers the three IM tools into the agent mount domain once', () => {
    const log = { names: [] as string[], disposed: [] as string[] }
    const agent: HostAgentLike = { id: 'session-a', ctx: { tools: toolService(log) } }
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toEqual(['im_identity', 'im_channels', 'im_send'])
    // 第二次（agent/created + agent/status 双入口）是空操作，不会重复注册。
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    expect(log.names).toHaveLength(3)
  })

  it('retries when the tools service was not ready on the first attempt', () => {
    const log = { names: [] as string[], disposed: [] as string[] }
    const agent: HostAgentLike = { id: 'session-a', ctx: {} }
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    // 宿主 compose 完成后 status 入口再试一次。
    ;(agent.ctx as { tools?: unknown }).tools = toolService(log)
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toHaveLength(3)
  })

  it('falls back to the session id and skips agents without any id', () => {
    const log = { names: [] as string[], disposed: [] as string[] }
    const fromSession: HostAgentLike = { session: { id: 'session-b' }, ctx: { tools: toolService(log) } }
    expect(mountImToolsOnAgent(deps, fromSession)).toBe(true)
    expect(mountImToolsOnAgent(deps, { ctx: { tools: toolService(log) } })).toBe(false)
    expect(log.names).toHaveLength(3)
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
    const log = { names: [] as string[], disposed: [] as string[] }
    const agent: HostAgentLike = {
      id: 'subagent-1',
      session: { id: 'subagent-1', header: { origin: 'subagent' } },
      ctx: { tools: toolService(log) },
    }
    expect(mountImToolsOnAgent(deps, agent)).toBe(false)
    expect(log.names).toEqual([])
  })

  it('unmounts one agent and allows a later remount', () => {
    const log = { names: [] as string[], disposed: [] as string[] }
    const agent: HostAgentLike = { id: 'session-a', ctx: { tools: toolService(log) } }
    mountImToolsOnAgent(deps, agent)
    unmountImToolsForAgent('session-a')
    expect(log.disposed).toEqual(['im_identity', 'im_channels', 'im_send'])
    expect(mountImToolsOnAgent(deps, agent)).toBe(true)
    expect(log.names).toHaveLength(6)
  })
})
