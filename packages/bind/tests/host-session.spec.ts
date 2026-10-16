import { describe, expect, it } from 'vitest'
import {
  TAVERN_PLUGIN_SOURCE_KIND,
  hostPluginMessageSource,
  isHostPluginMessageSource,
  readSessionEvents,
  sessionEvents,
  type HostSessionLog,
} from '../src/host-session.js'

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

describe('hostPluginMessageSource', () => {
  it('emits the producer-owned kind on v4 sessions (DSH 0.2.0-rc.2+)', () => {
    expect(hostPluginMessageSource({ header: { version: 4 } })).toEqual({ kind: TAVERN_PLUGIN_SOURCE_KIND })
    expect(hostPluginMessageSource({ header: { version: 5 } })).toEqual({ kind: TAVERN_PLUGIN_SOURCE_KIND })
  })

  it('emits the producer-owned kind with extra members preserved and no plugin member', () => {
    expect(hostPluginMessageSource({ header: { version: 4 } }, { form: 'notice', summary: 'Tavern closed' }))
      .toEqual({ form: 'notice', summary: 'Tavern closed', kind: TAVERN_PLUGIN_SOURCE_KIND })
  })

  it('keeps the v0 shape for format versions 0-3, missing headers and stub sessions', () => {
    expect(hostPluginMessageSource({ header: { version: 0 } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource({ header: { version: 3 } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource(undefined)).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource(null)).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource(makeHostSessionAgent())).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
  })

  it('ignores non-safe-integer header versions (fail-safe to the v0 shape)', () => {
    expect(hostPluginMessageSource({ header: { version: '4' } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource({ header: { version: 4.5 } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
    expect(hostPluginMessageSource({ header: { version: Number.NaN } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
  })
})

describe('isHostPluginMessageSource', () => {
  it('matches the v4 producer-owned kind and the legacy v0-v3 shape', () => {
    expect(isHostPluginMessageSource({ kind: TAVERN_PLUGIN_SOURCE_KIND })).toBe(true)
    expect(isHostPluginMessageSource({ kind: 'plugin', plugin: 'dsh-soulmojito' })).toBe(true)
    expect(isHostPluginMessageSource({ kind: TAVERN_PLUGIN_SOURCE_KIND, form: 'notice', summary: 'x' })).toBe(true)
  })

  it('rejects other producers, user/model sources and malformed values', () => {
    expect(isHostPluginMessageSource({ kind: 'plugin', plugin: 'other-plugin' })).toBe(false)
    expect(isHostPluginMessageSource({ kind: 'user' })).toBe(false)
    expect(isHostPluginMessageSource({ kind: 'model', provider: 'p', model: 'm' })).toBe(false)
    expect(isHostPluginMessageSource({})).toBe(false)
    expect(isHostPluginMessageSource('plugin:dsh-soulmojito')).toBe(false)
    expect(isHostPluginMessageSource(null)).toBe(false)
  })
})

describe('改名兼容（2026-10-16 dsh-tavern → DSH-SoulMojito）', () => {
  it('读取端双认旧名：v4 producer kind 与 v0-v3 plugin 成员的 dsh-tavern 值', () => {
    expect(isHostPluginMessageSource({ kind: 'plugin:dsh-tavern' })).toBe(true)
    expect(isHostPluginMessageSource({ kind: 'plugin:dsh-tavern', form: 'notice', summary: 'Tavern closed' })).toBe(true)
    expect(isHostPluginMessageSource({ kind: 'plugin', plugin: 'dsh-tavern' })).toBe(true)
  })

  it('写入端恒用新名（不产生新的旧名痕迹）', () => {
    expect(hostPluginMessageSource({ header: { version: 4 } })).toEqual({ kind: 'plugin:dsh-soulmojito' })
    expect(hostPluginMessageSource({ header: { version: 0 } })).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito' })
  })

  it('陌生生产者在两个命名空间下都不误收', () => {
    expect(isHostPluginMessageSource({ kind: 'plugin:dsh-tavernish' })).toBe(false)
    expect(isHostPluginMessageSource({ kind: 'plugin', plugin: 'dsh-tavernish' })).toBe(false)
  })
})
