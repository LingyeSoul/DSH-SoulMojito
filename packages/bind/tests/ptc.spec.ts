import { describe, expect, it, vi } from 'vitest'

const hostPackage = vi.hoisted(() => ({ importHostPackage: vi.fn() }))
vi.mock('../src/host-package.js', () => hostPackage)

import {
  describePtcSelection,
  inspectPtcCapabilities,
  inspectPtcCapabilitiesAsync,
  mountPtc,
  renderPtcCompleteText,
  type PtcHostContext,
} from '../src/ptc.js'

function ptcExecutorModule() {
  return {
    apply(target: { tools: { setExecutor: (executor: unknown) => unknown } }) {
      target.tools.setExecutor({
        sections: [
          { name: 'tools:ptc-only', text: 'Only run_code may be called.' },
          { name: 'tools:sdk', text: (definitions: string[]) => `SDK ${definitions.join(',')}` },
        ],
      })
    },
  }
}

const RUNTIME = { language: 'typescript' }

function presentationTools(presentAs = vi.fn()) {
  return {
    presentAs,
    modeFor: (scope: unknown) => scope === 'ptc' ? 'ptc' : 'native',
    sdkSection: () => ({ text: (context: { scope?: unknown }) => `SDK for ${String(context.scope)}` }),
    collapseSection: () => ({ text: 'Only run_code may be called.' }),
  }
}

function presentationContext(presentAs = vi.fn()): PtcHostContext {
  const tools = presentationTools(presentAs)
  let disposed = 0
  return {
    tools,
    get: (name: string) => name === 'ptcRuntime' ? RUNTIME : undefined,
    inject: (_deps, callback) => {
      callback({ tools: { presentAs: (mode: string) => { presentAs(mode) } } })
      return { dispose: () => { disposed += 1 } }
    },
    status: 'idle',
  } as unknown as PtcHostContext
}

function executorTools(scope: object) {
  const scoped = new Map<object, unknown>()
  const native = { sections: [] }
  return {
    scoped,
    setExecutor(executor: unknown) {
      scoped.set(scope, { executor })
    },
    selectExecutor(key: object) {
      return (scoped.get(key) as { executor?: unknown } | undefined)?.executor ?? native
    },
    definitions: () => ['tool-a', 'tool-b'],
  }
}

function executorContext(scope: object): PtcHostContext {
  const tools = executorTools(scope)
  let disposed = 0
  return {
    tools,
    get: (name: string) => {
      if (name === 'ptcRuntime') return RUNTIME
      return undefined
    },
    plugin: (module: unknown) => {
      const target = module as { apply?: (ctx: { tools: typeof tools }) => void }
      target.apply?.({ tools })
      return { dispose: () => { disposed += 1 } }
    },
    status: 'idle',
  } as unknown as PtcHostContext
}

describe('inspectPtcCapabilities', () => {
  it('detects the 0.2.1 presentation seam', () => {
    const ctx = presentationContext()
    expect(inspectPtcCapabilities(ctx)).toMatchObject({
      available: true,
      language: 'typescript',
      seam: 'presentation',
    })
  })

  it('detects the 0.2.2 executor seam through the loader', () => {
    const ctx = executorContext({})
    expect(inspectPtcCapabilities(ctx)).toMatchObject({
      available: true,
      language: 'typescript',
      seam: 'executor',
    })
  })

  it('reports the selected executor surface', () => {
    const scope = {}
    const ctx = executorContext(scope)
    const tools = ctx.tools as ReturnType<typeof executorTools>
    expect(describePtcSelection(ctx, scope)).toBe('native')
    tools.setExecutor({
      sections: [{ name: 'tools:ptc-only', text: 'Only run_code may be called.' }],
    })
    expect(describePtcSelection(ctx, scope)).toBe('ptc')
  })

  it('reports missing runtime and unknown SDK languages', () => {
    const noRuntime = { tools: presentationTools(), inject: () => undefined } as unknown as PtcHostContext
    expect(inspectPtcCapabilities(noRuntime).reasons.join(' ')).toContain('ptcRuntime')
    const ruby = presentationContext()
    const withRuby = { ...ruby, get: (name: string) => name === 'ptcRuntime' ? { language: 'ruby' } : undefined }
    expect(inspectPtcCapabilities(withRuby).available).toBe(false)
    expect(inspectPtcCapabilities(withRuby).reasons.join(' ')).toContain('ruby')
  })

  it('reports neither seam clearly', () => {
    const capabilities = inspectPtcCapabilities({ get: () => RUNTIME } as unknown as PtcHostContext)
    expect(capabilities.available).toBe(false)
    expect(capabilities.reasons.join(' ')).toContain('0.2.2 PTC executor seam')
  })

  it('preflights the executor module import', async () => {
    hostPackage.importHostPackage.mockResolvedValueOnce(ptcExecutorModule())
    await expect(inspectPtcCapabilitiesAsync(executorContext({}))).resolves.toMatchObject({ available: true, seam: 'executor' })
    hostPackage.importHostPackage.mockRejectedValueOnce(new Error('not installed'))
    const broken = await inspectPtcCapabilitiesAsync(executorContext({}))
    expect(broken.available).toBe(false)
    expect(broken.reasons.join(' ')).toContain('not installed')
  })
})

describe('renderPtcCompleteText', () => {  it('renders the old presentation sections for a PTC scope only', () => {
    const tools = presentationTools()
    expect(renderPtcCompleteText(tools, 'ptc', undefined)).toBe('Only run_code may be called.\n\nSDK for ptc')
    expect(renderPtcCompleteText(tools, 'native', undefined)).toBe('')
  })

  it('renders the executor sections from the selected scope executor', () => {
    const scope = {}
    const tools = executorTools(scope)
    tools.setExecutor({
      sections: [
        { name: 'tools:ptc-only', text: 'Only run_code may be called.' },
        { name: 'tools:sdk', text: (definitions: string[]) => `SDK ${definitions.join(',')}` },
      ],
    })
    expect(renderPtcCompleteText(tools, scope, undefined)).toBe('Only run_code may be called.\n\nSDK tool-a,tool-b')
  })

  it('returns empty for a native executor', () => {
    expect(renderPtcCompleteText(executorTools({}), {}, undefined)).toBe('')
  })
})

describe('mountPtc', () => {
  it('mounts and disposes the old presentation seam', async () => {
    const presentAs = vi.fn()
    const ctx = presentationContext(presentAs)
    const mount = await mountPtc(ctx, {})
    expect(presentAs).toHaveBeenCalledWith('ptc')
    await mount.dispose()
    await mount.dispose()
  })

  it('mounts and disposes the executor seam, restoring native fallback', async () => {
    hostPackage.importHostPackage.mockResolvedValueOnce(ptcExecutorModule())
    const scope = {}
    const ctx = executorContext(scope)
    const tools = ctx.tools as ReturnType<typeof executorTools>
    expect(tools.scoped.has(scope)).toBe(false)
    const mount = await mountPtc(ctx, scope)
    expect(tools.scoped.has(scope)).toBe(true)
    expect(renderPtcCompleteText(tools, scope, undefined)).toContain('SDK')
    await mount.dispose()
    expect(tools.scoped.has(scope)).toBe(false)
    expect(renderPtcCompleteText(tools, scope, undefined)).toBe('')
  })

  it('does not read an unknown host-context property while mounting', async () => {
    hostPackage.importHostPackage.mockResolvedValueOnce(ptcExecutorModule())
    const scope = {}
    const ctx = executorContext(scope)
    // Real DSH agent contexts are Cordis proxies: an uninjected service name
    // throws instead of reading undefined.
    Object.defineProperty(ctx, 'status', {
      get() {
        throw new Error('cannot get property "status" without inject')
      },
    })
    const mount = await mountPtc(ctx, scope)
    await mount.dispose()
  })

  it('replaces a disposed executor record instead of treating it as a conflict', async () => {
    hostPackage.importHostPackage.mockResolvedValueOnce(ptcExecutorModule())
    const scope = {}
    const ctx = executorContext(scope)
    const tools = ctx.tools as ReturnType<typeof executorTools>
    tools.scoped.set(scope, { executor: undefined })
    const mount = await mountPtc(ctx, scope)
    expect(tools.scoped.has(scope)).toBe(true)
    await mount.dispose()
    expect(tools.scoped.has(scope)).toBe(false)
  })

  it('refuses a second executor in the same scope without touching it', async () => {
    const scope = {}
    const ctx = executorContext(scope)
    const tools = ctx.tools as ReturnType<typeof executorTools>
    const existing = { executor: { sections: [] } }
    tools.scoped.set(scope, existing)
    await expect(mountPtc(ctx, scope)).rejects.toThrow('already registered')
    expect(tools.scoped.get(scope)).toBe(existing)
  })
})
