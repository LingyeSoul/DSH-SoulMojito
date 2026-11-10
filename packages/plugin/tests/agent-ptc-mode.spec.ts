import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyAgentPtcMode,
  clearAllAgentPtcModes,
  clearAgentPtcMode,
  refreshAgentPtcMode,
} from '../src/agent-ptc-mode.js'
import { handleStateUpdateRoute } from '../src/http/panel-state-routes.js'
import type { PluginContext } from '../src/host-contract.js'
import { store } from '../src/runtime.js'

const BOUND_AGENT = 'agent-tavern-1'
const ST_AGENT = 'st-agent-1'
const IM_STANDARD_AGENT = 'im-standard-1'

interface FakeInjectionCall {
  readonly agentId: string
  readonly deps: readonly string[]
}

interface FakeAgent {
  id: string
  status: string
  ctx: unknown
  whenIdle?: () => Promise<unknown>
}

function makeAgent(
  agentId: string,
  presentations: string[],
  disposals: string[],
  calls: FakeInjectionCall[],
  whenIdle?: () => Promise<unknown>,
): FakeAgent {
  return {
    id: agentId,
    status: 'idle',
    ...(whenIdle === undefined ? {} : { whenIdle }),
    ctx: {
      get: (name: string) => {
        if (name === 'ptcRuntime') return { language: 'typescript' }
        if (name === 'tools') {
          return {
            presentAs: () => {},
            modeFor: () => 'native',
            sdkSection: () => ({ text: '' }),
            collapseSection: () => ({ text: '' }),
          }
        }
        return undefined
      },
      inject: (deps: readonly string[], callback: (context: unknown) => unknown) => {
        calls.push({ agentId, deps })
        callback({
          tools: {
            presentAs: (mode: string) => {
              presentations.push(`${agentId}:${mode}`)
            },
          },
        })
        return {
          dispose: () => {
            disposals.push(agentId)
          },
        }
      },
    },
  }
}

interface MockRequest {
  method: string
  url: string
  headers: Record<string, string>
  destroy: () => void
  on: (event: string, listener: (value?: unknown) => void) => undefined
}

function makeRequest(body: unknown): MockRequest {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url: '/api/dsh-soulmojito/state',
    headers: { 'content-type': 'application/json' },
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

describe('agent PTC mode', () => {
  let home: string
  let presentations: string[]
  let disposals: string[]
  let calls: FakeInjectionCall[]
  let boundAgent: FakeAgent
  let stAgent: FakeAgent
  let imStandardAgent: FakeAgent

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-ptc-'))
    process.env.DSH_HOME = home
    const db = await store()
    await db.updateState(() => ({
      agentPtcMode: true,
      sessionBindings: {
        [BOUND_AGENT]: {
          architecture: 'agent-tavern',
          contextMode: 'dsh-native',
          character: 'PTC Character',
          chatId: 'ptc-chat',
        },
        'agent-novel-1': {
          architecture: 'agent-novel',
          character: '',
          chatId: '',
          novelId: 'ptc-novel',
        },
        'workbench-1': {
          architecture: 'card-workbench',
          character: '',
          chatId: '',
          sourceCharacter: 'PTC Character',
          sourceChatId: 'ptc-chat',
          createdCard: '',
        },
        [ST_AGENT]: { architecture: 'st', character: 'PTC Character', chatId: 'st-chat' },
      },
      imPeers: {
        'qq:acct:private:peer-im': {
          sessionId: IM_STANDARD_AGENT,
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
        'qq:acct:private:peer-st': {
          sessionId: ST_AGENT,
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    }))
    presentations = []
    disposals = []
    calls = []
    boundAgent = makeAgent(BOUND_AGENT, presentations, disposals, calls)
    stAgent = makeAgent(ST_AGENT, presentations, disposals, calls)
    imStandardAgent = makeAgent(IM_STANDARD_AGENT, presentations, disposals, calls)
  })

  afterAll(async () => {
    await clearAllAgentPtcModes(undefined)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('declares PTC on bound Tavern agents only and disposes on switch-off', async () => {
    expect(await applyAgentPtcMode(boundAgent as never, undefined)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deps).toEqual(['tools', 'ptcRuntime'])
    expect(presentations).toEqual([`${BOUND_AGENT}:ptc`])

    // Idempotent: a second lifecycle event does not stack a second declaration.
    expect(await applyAgentPtcMode(boundAgent as never, undefined)).toBe(false)
    expect(calls).toHaveLength(1)

    // ST runs outside the native AgentLoop and keeps its native surface even
    // when an IM peer is bound to it.
    expect(await applyAgentPtcMode(stAgent as never, undefined)).toBe(false)
    expect(calls).toHaveLength(1)

    // IM binding is a first-class agent surface: a standard session with no
    // Tavern architecture binding still receives PTC.
    expect(await applyAgentPtcMode(imStandardAgent as never, undefined)).toBe(true)
    expect(calls).toHaveLength(2)
    expect(presentations).toContain(`${IM_STANDARD_AGENT}:ptc`)

    await clearAgentPtcMode(BOUND_AGENT, undefined)
    expect(disposals).toEqual([BOUND_AGENT])
    expect(await applyAgentPtcMode(boundAgent as never, undefined)).toBe(true)
  })

  it('reconciles live agents after the behavior switch changes', async () => {
    await clearAllAgentPtcModes(undefined)
    presentations.length = 0
    disposals.length = 0
    calls.length = 0

    const ctx = {
      agents: { list: () => [boundAgent, stAgent] },
      tools: {
        presentAs: () => {},
        modeFor: () => 'native',
        sdkSection: () => ({ text: '' }),
        collapseSection: () => ({ text: '' }),
      },
      get: (name: string) => name === 'ptcRuntime' ? { language: 'typescript' } : undefined,
      inject: () => undefined,
      logger: { warn: () => {} },
    } as unknown as PluginContext

    await refreshAgentPtcMode(ctx)
    expect(presentations).toEqual([`${BOUND_AGENT}:ptc`])

    const db = await store()
    await db.patchState({ agentPtcMode: false })
    await refreshAgentPtcMode(ctx)
    expect(disposals).toEqual([BOUND_AGENT])
  })

  it('leaves a running turn on its current tool surface until idle', async () => {
    await clearAllAgentPtcModes(undefined)
    presentations.length = 0
    disposals.length = 0
    calls.length = 0
    const db = await store()
    await db.patchState({ agentPtcMode: true })
    boundAgent.status = 'running'
    const ctx = {
      agents: { list: () => [boundAgent] },
      tools: {},
      get: () => ({ language: 'typescript' }),
      logger: { warn: () => {} },
    } as unknown as PluginContext
    await refreshAgentPtcMode(ctx)
    expect(presentations).toEqual([])

    boundAgent.status = 'idle'
    await refreshAgentPtcMode(ctx)
    expect(presentations).toEqual([`${BOUND_AGENT}:ptc`])
  })

  it('waits for a running agent to become idle before declaring PTC', async () => {
    await clearAllAgentPtcModes(undefined)
    presentations.length = 0
    disposals.length = 0
    calls.length = 0
    const db = await store()
    await db.patchState({ agentPtcMode: true })
    const gate = Promise.withResolvers<void>()
    const agent = makeAgent(BOUND_AGENT, presentations, disposals, calls, () => gate.promise)
    agent.status = 'running'

    expect(await applyAgentPtcMode(agent as never, undefined)).toBe(false)
    expect(presentations).toEqual([])

    agent.status = 'idle'
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(presentations).toEqual([`${BOUND_AGENT}:ptc`])
  })

  it('adopts a preset-provided PTC executor instead of shadowing it', async () => {
    await clearAllAgentPtcModes(undefined)
    const db = await store()
    await db.patchState({ agentPtcMode: true })
    const scoped = new Map<object, unknown>()
    let setCalls = 0
    const presetExecutor = { sections: [{ name: 'tools:ptc-only', text: 'preset PTC' }] }
    const agent = {
      id: 'agent-novel-1',
      status: 'idle',
      ctx: {
        get: (name: string) => name === 'ptcRuntime' ? { language: 'typescript' } : undefined,
        tools: {
          setExecutor: () => { setCalls += 1 },
          selectExecutor: () => presetExecutor,
          definitions: () => [],
          scoped: {
            get: (key: object) => scoped.get(key),
            has: (key: object) => scoped.has(key),
            delete: (key: object) => scoped.delete(key),
          },
        },
        plugin: () => { throw new Error('must not mount a second executor') },
      },
    }
    const warnings: string[] = []
    expect(await applyAgentPtcMode(agent as never, { warn: (message) => { warnings.push(message) } })).toBe(false)
    expect(setCalls).toBe(0)
    expect(warnings).toEqual([])
  })

  it('rejects the HTTP write before persisting when the host cannot render PTC', async () => {
    const db = await store()
    await db.patchState({ agentPtcMode: false })
    const ctx = {
      tools: { register: () => {} },
      get: () => undefined,
      agents: { list: () => [] },
    } as unknown as PluginContext
    await expect(handleStateUpdateRoute(
      ctx,
      db,
      makeRequest({ agentPtcMode: true }) as never,
      makeResponse() as never,
    )).rejects.toThrow('PTC mode is unavailable')
    expect((await db.getState()).agentPtcMode).toBe(false)
  })

  it('persists the IM native switch even when the host cannot render PTC', async () => {
    const db = await store()
    await db.patchState({ imNativeAgentMode: false, agentPtcMode: false })
    const ctx = {
      tools: { register: () => {} },
      get: () => undefined,
      agents: { list: () => [] },
    } as unknown as PluginContext
    const res = makeResponse()
    await handleStateUpdateRoute(
      ctx,
      db,
      makeRequest({ imNativeAgentMode: true }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect((await db.getState()).imNativeAgentMode).toBe(true)
  })

  it('persists and reconciles through the HTTP state route', async () => {
    await clearAllAgentPtcModes(undefined)
    presentations.length = 0
    disposals.length = 0
    calls.length = 0
    const db = await store()
    const ctx = {
      agents: { list: () => [boundAgent, stAgent] },
      tools: {
        presentAs: () => {},
        modeFor: () => 'native',
        sdkSection: () => ({ text: '' }),
        collapseSection: () => ({ text: '' }),
      },
      get: (name: string) => name === 'ptcRuntime' ? { language: 'typescript' } : undefined,
      inject: () => undefined,
      logger: { warn: () => {} },
    } as unknown as PluginContext
    const res = makeResponse()
    await handleStateUpdateRoute(
      ctx,
      db,
      makeRequest({ agentPtcMode: true }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect((await db.getState()).agentPtcMode).toBe(true)
    expect(presentations).toEqual([`${BOUND_AGENT}:ptc`])

    const off = makeResponse()
    await handleStateUpdateRoute(
      ctx,
      db,
      makeRequest({ agentPtcMode: false }) as never,
      off as never,
    )
    expect(off.statusCode).toBe(200)
    expect(disposals).toEqual([BOUND_AGENT])
  })
})
