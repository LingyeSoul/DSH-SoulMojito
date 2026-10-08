import { describe, expect, it } from 'vitest'
import { connectHostWorkspace, createClientShapeTrace, openHostSession, retainHostSession } from '../src/client/host-probe.js'

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

function openSessionHost() {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      get: (serviceId: string) => serviceId === 'uiWorkspace'
        ? { openSession: (id: string) => { calls.push(`uiWorkspace:${id}`) } }
        : undefined,
    },
  }
}

function legacySessionsOpenHost() {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      get: () => undefined,
      sessions: {
        open: (id: string) => { calls.push(`sessions:${id}`) },
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
    expect(trace.openSessionPath).toBeUndefined()
    expect(trace.openSessionCalls).toBe(0)
    expect(trace.retainPath).toBeUndefined()
    expect(trace.retainCalls).toBe(0)
  })
})

describe('openHostSession', () => {
  it('prefers the 0.2.0 uiWorkspace.openSession face', () => {
    const { ctx, calls } = openSessionHost()
    const trace = createClientShapeTrace()
    openHostSession(ctx, 's-1', trace)
    expect(calls).toEqual(['uiWorkspace:s-1'])
    expect(trace.openSessionPath).toBe('uiWorkspace')
    expect(trace.openSessionCalls).toBe(1)
  })

  it('falls back to the legacy sessions.open face when uiWorkspace is absent', () => {
    const { ctx, calls } = legacySessionsOpenHost()
    const trace = createClientShapeTrace()
    openHostSession(ctx, 's-2', trace)
    expect(calls).toEqual(['sessions:s-2'])
    expect(trace.openSessionPath).toBe('sessions')
  })

  it('throws with a semantic message and records "unavailable" when no face exists', () => {
    const trace = createClientShapeTrace()
    expect(() => openHostSession({}, 's-3', trace)).toThrow('no session open face')
    expect(trace.openSessionPath).toBe('unavailable')
    expect(trace.openSessionCalls).toBe(1)
  })

  it('skips the sessions fallback on hosts whose sessions service has no open method', () => {
    const trace = createClientShapeTrace()
    const ctx = { get: () => undefined, sessions: { list: {} } }
    expect(() => openHostSession(ctx, 's-4', trace)).toThrow('no session open face')
    expect(trace.openSessionPath).toBe('unavailable')
  })

  it('works without a trace', () => {
    const { ctx, calls } = openSessionHost()
    expect(() => openHostSession(ctx, 's-5')).not.toThrow()
    expect(calls).toEqual(['uiWorkspace:s-5'])
  })
})

function retainHost() {
  const calls: string[] = []
  let live = false
  return {
    calls,
    ctx: {
      sessions: {
        // 宿主语义镜像：binding() 只在作用域被 retain 期间返回绑定。
        binding: (id: string) => (live ? { sessionId: id } : undefined),
        retain: (id: string, options: { source: string }) => {
          calls.push(`retain:${id}:${options.source}`)
          live = true
          return {
            release: () => {
              live = false
              calls.push(`release:${id}`)
            },
          }
        },
      },
    },
  }
}

describe('retainHostSession', () => {
  it('retains under the plugin source so binding() becomes borrowable, and releases exactly once', () => {
    const { ctx, calls } = retainHost()
    const trace = createClientShapeTrace()
    const hold = retainHostSession(ctx, 's-1', trace)
    expect(hold.path).toBe('retain')
    expect(ctx.sessions.binding('s-1')).toEqual({ sessionId: 's-1' })
    hold.release()
    expect(ctx.sessions.binding('s-1')).toBeUndefined()
    hold.release()
    expect(calls).toEqual(['retain:s-1:dsh-tavern', 'release:s-1'])
    expect(trace.retainPath).toBe('retain')
    expect(trace.retainCalls).toBe(1)
  })

  it('falls back to borrowing when the retain face is missing', () => {
    const trace = createClientShapeTrace()
    const ctx = { sessions: { binding: (id: string) => ({ sessionId: id }) } }
    const hold = retainHostSession(ctx, 's-2', trace)
    expect(hold.path).toBe('borrow')
    expect(() => hold.release()).not.toThrow()
    expect(trace.retainPath).toBe('borrow')
    expect(trace.retainCalls).toBe(1)
  })

  it('falls back to borrowing when the host refuses the retain (unknown session)', () => {
    const trace = createClientShapeTrace()
    const ctx = {
      sessions: {
        binding: (id: string) => ({ sessionId: id }),
        retain: () => {
          throw new Error('SessionCreateError')
        },
      },
    }
    const hold = retainHostSession(ctx, 's-3', trace)
    expect(hold.path).toBe('borrow')
    expect(() => hold.release()).not.toThrow()
    expect(trace.retainPath).toBe('borrow')
  })

  it('records unavailable when neither face exists', () => {
    const trace = createClientShapeTrace()
    const hold = retainHostSession({}, 's-4', trace)
    expect(hold.path).toBe('unavailable')
    expect(() => hold.release()).not.toThrow()
    expect(trace.retainPath).toBe('unavailable')
    expect(trace.retainCalls).toBe(1)
  })

  it('falls back when the retained reference has no callable release', () => {
    const trace = createClientShapeTrace()
    const ctx = { sessions: { binding: (id: string) => ({ sessionId: id }), retain: () => ({}) } }
    const hold = retainHostSession(ctx, 's-5', trace)
    expect(hold.path).toBe('borrow')
    expect(() => hold.release()).not.toThrow()
  })

  it('works without a trace', () => {
    const { ctx } = retainHost()
    const hold = retainHostSession(ctx, 's-6')
    expect(hold.path).toBe('retain')
    expect(() => hold.release()).not.toThrow()
  })

  it('invokes a host release method with its own this (ClientSessionReference shape)', () => {
    // 回归：0.2.0-rc.2 宿主的 ClientSessionReference.release() 是读
    // this.sessionId 的真方法；解构后裸调用会以 "reading 'sessionId'"
    // TypeError 炸掉整个 openTavernChat/openNovelSession/openWorkbenchSession
    // 启动链。夹具必须用方法（非闭包）才能守住这一点。
    const released: string[] = []
    class Reference {
      readonly sessionId: string
      constructor(sessionId: string) { this.sessionId = sessionId }
      release(): void { released.push(this.sessionId) }
    }
    const ctx = {
      sessions: {
        binding: () => undefined,
        retain: (id: string) => new Reference(id),
      },
    }
    const hold = retainHostSession(ctx, 's-7')
    expect(hold.path).toBe('retain')
    expect(() => hold.release()).not.toThrow()
    expect(released).toEqual(['s-7'])
  })
})
