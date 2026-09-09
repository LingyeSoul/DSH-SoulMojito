import { describe, expect, it } from 'vitest'
import { connectHostWorkspace, createClientShapeTrace } from '../src/client/host-probe.js'

function uiWorkspaceHost() {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      get: (serviceId: string) => serviceId === 'uiWorkspace'
        ? { connectWorkspace: (id: string) => { calls.push(`uiWorkspace:${id}`); return { via: 'uiWorkspace', id } } }
        : undefined,
    },
  }
}

function legacyWorkspacesHost() {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      get: () => undefined,
      workspaces: {
        connectWorkspace: (id: string) => { calls.push(`workspaces:${id}`); return { via: 'workspaces', id } },
      },
    },
  }
}

describe('connectHostWorkspace', () => {
  it('prefers the 0.1.2 uiWorkspace service face', () => {
    const { ctx, calls } = uiWorkspaceHost()
    const trace = createClientShapeTrace()
    const result = connectHostWorkspace(ctx, 'w-1', trace) as { via: string }
    expect(result.via).toBe('uiWorkspace')
    expect(calls).toEqual(['uiWorkspace:w-1'])
    expect(trace.connectPath).toBe('uiWorkspace')
    expect(trace.connectCalls).toBe(1)
  })

  it('falls back to the rc.6 workspaces controller face when uiWorkspace is absent', () => {
    const { ctx, calls } = legacyWorkspacesHost()
    const trace = createClientShapeTrace()
    const result = connectHostWorkspace(ctx, 'w-2', trace) as { via: string }
    expect(result.via).toBe('workspaces')
    expect(calls).toEqual(['workspaces:w-2'])
    expect(trace.connectPath).toBe('workspaces')
  })

  it('falls back to workspaces when ctx.get is unavailable at all', () => {
    const { ctx, calls } = legacyWorkspacesHost()
    delete (ctx as Record<string, unknown>).get
    const trace = createClientShapeTrace()
    connectHostWorkspace(ctx, 'w-3', trace)
    expect(calls).toEqual(['workspaces:w-3'])
    expect(trace.connectPath).toBe('workspaces')
  })

  it('throws with a semantic message and records "unavailable" when no face exists', () => {
    const trace = createClientShapeTrace()
    expect(() => connectHostWorkspace({}, 'w-4', trace)).toThrow('no workspace connect face')
    expect(trace.connectPath).toBe('unavailable')
    expect(trace.connectCalls).toBe(1)
  })

  it('works without a trace and keeps the trace untouched', () => {
    const { ctx } = uiWorkspaceHost()
    expect(() => connectHostWorkspace(ctx, 'w-5')).not.toThrow()
  })

  it('accumulates call counts across connections', () => {
    const { ctx } = uiWorkspaceHost()
    const trace = createClientShapeTrace()
    connectHostWorkspace(ctx, 'w-a', trace)
    connectHostWorkspace(ctx, 'w-b', trace)
    expect(trace.connectCalls).toBe(2)
  })
})

describe('createClientShapeTrace', () => {
  it('starts with no path and zero calls', () => {
    const trace = createClientShapeTrace()
    expect(trace.connectPath).toBeUndefined()
    expect(trace.connectCalls).toBe(0)
  })
})
