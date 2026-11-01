/**
 * 失效会话绑定回收（决策 2026-11-02-stale-session-binding-reclaim）。
 *
 * 这些用例钉住的是**删除路径的安全契约**，不是功能面：
 * - 开关缺省/非法值时零读写（state.json 字节与 mtime 都不动）；
 * - `report` 只统计、零写入，日志带分组条数；
 * - `prune` 只删「宿主不认识 **且** 磁盘上也不存在」的绑定；
 * - 活会话（`agents.list` / `sessions.list`）与磁盘上仍在的会话一条不删；
 * - 删除是单次 `updateState`，其余键的值不变；
 * - 判定之后、写盘之前新写入的绑定（真实 `updateState`）不会被带走；
 * - 任一审定面缺失/不完整/抛错时整轮跳过，一条不删。
 *
 * mtime 用「钉到过去再看它变没变」判定：同一毫秒内的自然写盘会让两次
 * `mtimeMs` 相等，而钉死的旧时间与「刚刚写入」永远可区分。
 */
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TavernStore, type TavernSessionBinding, type TavernState } from '../../tavern-store/src/index.js'
import {
  reclaimStaleSessionBindings,
  registerSessionBindingReclaim,
  resolveSessionBindingReclaimConfig,
  type SessionBindingReclaimInput,
  type SessionPersistenceSeam,
} from '../src/session/reclaim.js'

const PINNED_MTIME = new Date('2001-02-03T04:05:06.000Z')

const BINDING: TavernSessionBinding = { architecture: 'st', character: 'ExampleCard', chatId: 'example-chat.jsonl' }

const openRoots: string[] = []

afterEach(async () => {
  while (openRoots.length > 0) {
    const root = openRoots.pop()!
    await rm(root, { recursive: true, force: true })
  }
})

interface Fixture {
  readonly root: string
  readonly db: TavernStore
  readonly stateFile: string
}

async function openFixture(bindings: Record<string, TavernSessionBinding>): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-soulmojito-reclaim-'))
  openRoots.push(dir)
  const root = path.join(dir, 'soulmojito')
  const db = await TavernStore.open(root)
  await db.updateState(() => ({ sessionBindings: { ...bindings } }))
  return { root, db, stateFile: path.join(root, 'state.json') }
}

/** localStorage 形态的宿主 agent/session 面（宿主 `list()` 只列活会话）。 */
function liveHost(agentIds: readonly string[], sessionIds: readonly string[]): {
  agents: { list: () => Array<{ id: string }> }
  sessions: { list: () => Array<{ id: string }> }
} {
  return {
    agents: { list: () => agentIds.map((id) => ({ id })) },
    sessions: { list: () => sessionIds.map((id) => ({ id })) },
  }
}

/** 存储面假件：`list()` 是库存，`stat()` 是单条复核。 */
function fakePersistence(options: {
  stored?: readonly string[]
  /** 只被 `stat` 认到的 id（模拟 list 与写盘之间刚落盘的会话）。 */
  materializedLate?: readonly string[]
  listError?: Error
}): { seam: SessionPersistenceSeam; calls: string[] } {
  const stored = options.stored ?? []
  const late = options.materializedLate ?? []
  const calls: string[] = []
  return {
    calls,
    seam: {
      list: async () => {
        calls.push('list')
        if (options.listError !== undefined) throw options.listError
        return stored.map((id) => ({ header: { id } }))
      },
      stat: async (id: string) => {
        calls.push(`stat:${id}`)
        return stored.includes(id) || late.includes(id) ? { header: { id } } : undefined
      },
    },
  }
}

function fakeLogger(): {
  info: Array<Record<string, unknown>>
  warn: Array<Record<string, unknown>>
  logger: { info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }
} {
  const info: Array<Record<string, unknown>> = []
  const warn: Array<Record<string, unknown>> = []
  return {
    info,
    warn,
    logger: {
      info: (...args: unknown[]) => { info.push((args[1] ?? {}) as Record<string, unknown>) },
      warn: (...args: unknown[]) => { warn.push((args[1] ?? {}) as Record<string, unknown>) },
    },
  }
}

/** 记录写盘次数（实例属性遮蔽原型方法；store 状态本身仍走真实写路径）。 */
function countWrites(db: TavernStore): string[] {
  const writes: string[] = []
  const original = db.updateState.bind(db)
  db.updateState = async (update) => {
    writes.push('updateState')
    return await original(update)
  }
  return writes
}

async function pinMtime(file: string): Promise<void> {
  await utimes(file, PINNED_MTIME, PINNED_MTIME)
}

async function mtimeOf(file: string): Promise<number> {
  return (await stat(file)).mtimeMs
}

function inputWith(fixture: Fixture, overrides: Partial<SessionBindingReclaimInput>): SessionBindingReclaimInput {
  return { mode: 'report', store: async () => fixture.db, ...overrides }
}

const THREE_BINDINGS = {
  'session-live-agent': BINDING,
  'session-live-store': BINDING,
  'session-stored': BINDING,
  'session-stale': BINDING,
}

describe('session binding reclaim · switch', () => {
  it('默认关闭：不打开 store、不读 state、不写一个字节', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const log = fakeLogger()

    await registerSessionBindingReclaim(
      { logger: log.logger },
      {
        configured: undefined,
        store: () => {
          throw new Error('the store must not open while the switch is off')
        },
      },
    )

    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(await mtimeOf(fixture.stateFile)).toBe(PINNED_MTIME.getTime())
    expect(log.info).toHaveLength(0)
    expect(log.warn).toHaveLength(0)
  })

  it('非法配置值按 off 处理，并留下结构化 warn', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const log = fakeLogger()

    await registerSessionBindingReclaim(
      { logger: log.logger },
      { configured: true, store: () => { throw new Error('store must stay closed') } },
    )

    expect(resolveSessionBindingReclaimConfig('report')).toEqual({ mode: 'report', supported: true })
    expect(resolveSessionBindingReclaimConfig('prune')).toEqual({ mode: 'prune', supported: true })
    expect(resolveSessionBindingReclaimConfig(true)).toEqual({ mode: 'off', supported: false })
    expect(log.warn).toEqual([expect.objectContaining({ reason: 'unsupported-config', configType: 'boolean' })])
    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(await mtimeOf(fixture.stateFile)).toBe(PINNED_MTIME.getTime())
  })
})

describe('session binding reclaim · report', () => {
  it('只统计：判据分组条数进报告与日志，state.json 一个字节都不动', async () => {
    const fixture = await openFixture(THREE_BINDINGS)
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const writes = countWrites(fixture.db)
    const log = fakeLogger()
    const host = liveHost(['session-live-agent'], ['session-live-store'])
    const persistence = fakePersistence({ stored: ['session-stored'] })

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'report',
      agents: host.agents,
      sessions: host.sessions,
      persistence: persistence.seam,
      logger: log.logger,
    }))

    expect(outcome).toEqual({
      status: 'done',
      report: { mode: 'report', scanned: 4, keptLive: 2, keptStored: 1, stale: 1, removed: 0, retained: 4 },
    })
    expect(writes).toHaveLength(0)
    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(await mtimeOf(fixture.stateFile)).toBe(PINNED_MTIME.getTime())
    expect(log.info).toEqual([expect.objectContaining({
      mode: 'report', scanned: 4, keptLive: 2, keptStored: 1, stale: 1, removed: 0, retained: 4,
    })])
    expect(Object.keys((await fixture.db.getState()).sessionBindings).sort()).toEqual([
      'session-live-agent', 'session-live-store', 'session-stale', 'session-stored',
    ])
    // `report` 不删，也不给被删 id 样本（那是 `prune` 的审计面）。
    expect(log.info[0]).not.toHaveProperty('removedIdSample')
  })
})

describe('session binding reclaim · prune', () => {
  it('只删「宿主不认识 + 磁盘不存在」的绑定，活会话与在盘会话一条不删', async () => {
    const fixture = await openFixture(THREE_BINDINGS)
    const writes = countWrites(fixture.db)
    const beforeRaw = JSON.parse(await readFile(fixture.stateFile, 'utf8')) as Record<string, unknown>
    const host = liveHost(['session-live-agent'], ['session-live-store'])
    const persistence = fakePersistence({ stored: ['session-stored'] })
    const log = fakeLogger()

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: persistence.seam,
      logger: log.logger,
    }))

    expect(outcome).toEqual({
      status: 'done',
      report: { mode: 'prune', scanned: 4, keptLive: 2, keptStored: 1, stale: 1, removed: 1, retained: 3 },
    })
    // 单次写：整轮只进一次 updateState。
    expect(writes).toEqual(['updateState'])

    const state = await fixture.db.getState()
    expect(state.sessionBindings['session-stale']).toBeUndefined()
    expect(state.sessionBindings['session-live-agent']).toEqual(BINDING)
    expect(state.sessionBindings['session-live-store']).toEqual(BINDING)
    expect(state.sessionBindings['session-stored']).toEqual(BINDING)

    // state.json 其余键的值不变（只少了被回收的那条绑定）。
    const afterRaw = JSON.parse(await readFile(fixture.stateFile, 'utf8')) as Record<string, unknown>
    delete beforeRaw['sessionBindings']
    delete afterRaw['sessionBindings']
    expect(afterRaw).toEqual(beforeRaw)
    expect((JSON.parse(await readFile(fixture.stateFile, 'utf8')) as TavernState).sessionBindings)
      .not.toHaveProperty('session-stale')
    // 审计面：`prune` 的汇总日志带被删 id 样本（总数看 `removed`）。
    expect(log.info).toEqual([expect.objectContaining({
      mode: 'prune', stale: 1, removed: 1, retained: 3, removedIdSample: ['session-stale'],
    })])
  })

  it('判定之后、写盘之前新写入的绑定存活，removed = stale 且 retained 非负', async () => {
    const fixture = await openFixture(THREE_BINDINGS)
    const host = liveHost(['session-live-agent'], ['session-live-store'])
    const persistence = fakePersistence({ stored: ['session-stored'] })
    const log = fakeLogger()

    // Reproduce the window the sweep opens: `agent/created` fork adoption calls
    // `bindSession`, i.e. a real `updateState`, after the reclaim snapshot was
    // read and before the sweep writes. Deleting `observed − remove` here would
    // take this brand-new binding with it; deleting `observed ∩ remove` keeps it.
    const prune = fixture.db.pruneSessionBindings.bind(fixture.db)
    let interleaved = false
    fixture.db.pruneSessionBindings = async (remove) => {
      if (!interleaved) {
        interleaved = true
        await fixture.db.updateState((state) => ({
          sessionBindings: { ...state.sessionBindings, 'session-brand-new': BINDING },
        }))
      }
      return await prune(remove)
    }

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: persistence.seam,
      logger: log.logger,
    }))

    expect(interleaved).toBe(true)
    if (outcome.status !== 'done') throw new Error(`expected a completed sweep, got ${outcome.status}`)
    const { report } = outcome
    expect(report).toEqual({
      mode: 'prune', scanned: 4, keptLive: 2, keptStored: 1, stale: 1, removed: 1, retained: 4,
    })
    expect(report.removed).toBe(report.stale)
    expect(report.retained).toBeGreaterThanOrEqual(0)

    const persisted = (await fixture.db.getState()).sessionBindings
    expect(persisted['session-brand-new']).toEqual(BINDING)
    expect(persisted['session-stale']).toBeUndefined()
    expect(Object.keys(persisted).sort()).toEqual([
      'session-brand-new', 'session-live-agent', 'session-live-store', 'session-stored',
    ])
  })

  it('list() 与写盘之间刚落盘的会话由单条 stat 复核保住', async () => {
    const fixture = await openFixture({ 'session-late': BINDING })
    const writes = countWrites(fixture.db)
    const host = liveHost([], [])

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: fakePersistence({ stored: [], materializedLate: ['session-late'] }).seam,
    }))

    expect(outcome).toEqual({
      status: 'done',
      report: { mode: 'prune', scanned: 1, keptLive: 0, keptStored: 1, stale: 0, removed: 0, retained: 1 },
    })
    expect(writes).toHaveLength(0)
    expect((await fixture.db.getState()).sessionBindings['session-late']).toEqual(BINDING)
  })

  it('活 agent 只给 session.id（老宿主形状）时同样算活会话', async () => {
    const fixture = await openFixture({ 'session-live-agent': BINDING })
    const writes = countWrites(fixture.db)
    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      // 宿主 AgentLike 的 `id` 是可选项；缺省时按承载的 session.id 认。
      agents: { list: () => [{ session: { id: 'session-live-agent' } }] },
      sessions: { list: () => [] },
      persistence: fakePersistence({}).seam,
    }))

    expect(outcome).toEqual({
      status: 'done',
      report: { mode: 'prune', scanned: 1, keptLive: 1, keptStored: 0, stale: 0, removed: 0, retained: 1 },
    })
    expect(writes).toHaveLength(0)
    expect((await fixture.db.getState()).sessionBindings['session-live-agent']).toEqual(BINDING)
  })

  it('无候选时不写盘（report 与 prune 在该盘面等价）', async () => {
    const fixture = await openFixture({ 'session-stored': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const writes = countWrites(fixture.db)
    const host = liveHost([], [])

    await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: fakePersistence({ stored: ['session-stored'] }).seam,
    }))

    expect(writes).toHaveLength(0)
    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(await mtimeOf(fixture.stateFile)).toBe(PINNED_MTIME.getTime())
  })
})

describe('session binding reclaim · fail closed', () => {
  it('宿主活会话面缺一个 list 时整轮跳过', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const log = fakeLogger()

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: { list: () => [] },
      sessions: {},
      persistence: fakePersistence({}).seam,
      logger: log.logger,
    }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'host-live-signal' })
    expect(log.warn).toEqual([expect.objectContaining({ reason: 'host-live-signal', configuredMode: 'prune' })])
    expect(await readFile(fixture.stateFile)).toEqual(before)
  })

  it('宿主会话对象的 id 读不出来时按活会话面不完整处理', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: { list: () => [] },
      sessions: { list: () => [{}, { id: 'session-x' }] },
      persistence: fakePersistence({}).seam,
    }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'host-live-signal' })
    expect((await fixture.db.getState()).sessionBindings['session-stale']).toEqual(BINDING)
  })

  it('没有存储面时整轮跳过（磁盘判据无法成立）', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    const host = liveHost([], [])

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: undefined,
    }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'session-storage-unavailable' })
    expect((await fixture.db.getState()).sessionBindings['session-stale']).toEqual(BINDING)
  })

  it('存储库存里有读不出 id 的条目时整轮跳过', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    const host = liveHost([], [])
    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: {
        list: async () => [{ header: {} }],
        stat: async () => undefined,
      },
    }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'session-storage-incomplete' })
    expect((await fixture.db.getState()).sessionBindings['session-stale']).toEqual(BINDING)
  })

  it('存储面 list 抛错时不删任何东西，register 把它收口成结构化 warn', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const log = fakeLogger()
    const host = liveHost([], [])
    const error = Object.assign(new Error('storage unavailable'), { code: 'EIO' })

    await registerSessionBindingReclaim(
      {
        agents: host.agents,
        sessions: host.sessions,
        logger: log.logger,
        get: () => fakePersistence({ listError: error }).seam,
      },
      { configured: 'prune', store: async () => fixture.db },
    )

    expect(log.warn).toEqual([
      expect.objectContaining({ reason: 'session-storage-error', errorCode: 'EIO', configuredMode: 'prune' }),
    ])
    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(await mtimeOf(fixture.stateFile)).toBe(PINNED_MTIME.getTime())
    expect((await fixture.db.getState()).sessionBindings['session-stale']).toEqual(BINDING)
  })

  it('单条 stat 抛错时整轮放弃：已确认的候选也不删', async () => {
    const fixture = await openFixture({ 'session-a': BINDING, 'session-b': BINDING })
    await pinMtime(fixture.stateFile)
    const before = await readFile(fixture.stateFile)
    const host = liveHost([], [])
    const log = fakeLogger()
    const error = Object.assign(new Error('corrupt artifact'), { code: 'SESSION_PERSISTENCE_CORRUPTION' })

    const outcome = await reclaimStaleSessionBindings(inputWith(fixture, {
      mode: 'prune',
      agents: host.agents,
      sessions: host.sessions,
      persistence: {
        list: async () => [],
        stat: async (id: string) => {
          if (id === 'session-b') throw error
          return undefined
        },
      },
      logger: log.logger,
    }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'session-storage-error' })
    expect(log.warn).toEqual([
      expect.objectContaining({ reason: 'session-storage-error', errorCode: 'SESSION_PERSISTENCE_CORRUPTION' }),
    ])
    expect(await readFile(fixture.stateFile)).toEqual(before)
    expect(Object.keys((await fixture.db.getState()).sessionBindings).sort()).toEqual(['session-a', 'session-b'])
  })

  it('prune 模式经 register 走通时只写一次', async () => {
    const fixture = await openFixture({ 'session-stale': BINDING })
    const writes = countWrites(fixture.db)
    const host = liveHost([], [])
    const log = fakeLogger()

    await registerSessionBindingReclaim(
      {
        agents: host.agents,
        sessions: host.sessions,
        logger: log.logger,
        get: () => fakePersistence({}).seam,
      },
      { configured: 'prune', store: async () => fixture.db },
    )

    expect(writes).toEqual(['updateState'])
    expect((await fixture.db.getState()).sessionBindings['session-stale']).toBeUndefined()
    expect(log.info).toEqual([expect.objectContaining({ mode: 'prune', stale: 1, removed: 1, retained: 0 })])
  })
})
