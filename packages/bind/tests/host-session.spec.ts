import { describe, expect, it } from 'vitest'
import { readSessionEvents, sessionEvents, type HostSessionLog } from '../src/host-session.js'

/** rc.6 形状：Session.events 是可变数组属性。 */
function makeRc6Session(events: unknown[] = []): HostSessionLog {
  return { id: 's-rc6', events }
}

/** 0.1.2 形状：私有 log + snapshotEvents() 冻结快照，无 events 属性。 */
function makeHostSessionAgent(log: unknown[] = []): HostSessionLog {
  return {
    id: 's-012',
    log,
    snapshotEvents: () => Object.freeze([...log]),
  }
}

describe('readSessionEvents', () => {
  it('reads the rc.6 mutable events array', () => {
    const session = makeRc6Session([{ type: 'turn/start' }])
    expect(readSessionEvents(session)).toEqual([{ type: 'turn/start' }])
  })

  it('reads the 0.1.2 frozen snapshot via snapshotEvents()', () => {
    const session = makeHostSessionAgent([{ type: 'turn/start' }])
    const events = readSessionEvents(session)
    expect(events).toEqual([{ type: 'turn/start' }])
    expect(Object.isFrozen(events)).toBe(true)
  })

  it('falls through to the private log when snapshotEvents returns a non-array', () => {
    const session: HostSessionLog = {
      log: [{ type: 'user/message' }],
      snapshotEvents: () => undefined,
    }
    expect(readSessionEvents(session)).toEqual([{ type: 'user/message' }])
  })

  it('returns undefined for non-host session objects so callers can tell empty apart from unreadable', () => {
    expect(readSessionEvents({})).toBeUndefined()
    expect(readSessionEvents({ id: 'not-a-session' })).toBeUndefined()
  })

  it('returns undefined for nullish input', () => {
    expect(readSessionEvents(null)).toBeUndefined()
    expect(readSessionEvents(undefined)).toBeUndefined()
  })

  it('prefers events over snapshotEvents when both exist', () => {
    const session: HostSessionLog = {
      ...makeHostSessionAgent([{ type: 'log-only' }]),
      events: [{ type: 'events-first' }],
    }
    expect(readSessionEvents(session)).toEqual([{ type: 'events-first' }])
  })
})

describe('sessionEvents', () => {
  it('coerces every supported host shape to a readonly event array', () => {
    expect(sessionEvents(makeRc6Session([{ type: 'a' }]))).toEqual([{ type: 'a' }])
    expect(sessionEvents(makeHostSessionAgent([{ type: 'b' }]))).toEqual([{ type: 'b' }])
  })

  it('returns an empty array for unreadable or nullish sessions', () => {
    expect(sessionEvents({})).toEqual([])
    expect(sessionEvents(null)).toEqual([])
  })
})
