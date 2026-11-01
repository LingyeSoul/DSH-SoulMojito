/**
 * `pruneSessionBindings` 的存储侧契约（决策 2026-11-02-stale-session-binding-reclaim）。
 *
 * 三条不可退让的性质：
 * - 一次写盘清完全部候选（不逐条删）；
 * - 没有候选时一个字节都不写（`report` 模式依赖这条保持只读）；
 * - 删除面是 `observed ∩ remove`：调用方判定之后别处新写入的绑定不在
 *   `remove` 里，永不删。
 */
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TavernStore, type TavernSessionBinding } from '../src/index.js'

const PINNED_MTIME = new Date('2001-02-03T04:05:06.000Z')

const BINDING: TavernSessionBinding = { architecture: 'st', character: 'ExampleCard', chatId: 'example-chat.jsonl' }

async function withStore(fn: (store: TavernStore, stateFile: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tavern-store-prune-'))
  try {
    const root = path.join(dir, 'root')
    await fn(await TavernStore.open(root), path.join(root, 'state.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function seed(store: TavernStore, bindings: Record<string, TavernSessionBinding>): Promise<void> {
  await store.updateState(() => ({ sessionBindings: { ...bindings } }))
}

/** 记录写盘次数（实例属性遮蔽原型方法；写入仍走真实路径）。 */
function countWrites(store: TavernStore): string[] {
  const writes: string[] = []
  const original = store.updateState.bind(store)
  store.updateState = async (update) => {
    writes.push('updateState')
    return await original(update)
  }
  return writes
}

describe('TavernStore.pruneSessionBindings', () => {
  it('一次写盘删掉 remove 内的候选，remove 外的条目与其值不动', async () => {
    await withStore(async (store, stateFile) => {
      await seed(store, { 'session-a': BINDING, 'session-b': BINDING, 'session-c': BINDING })
      const beforeRaw = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>
      const writes = countWrites(store)

      const result = await store.pruneSessionBindings(new Set(['session-b']))

      expect(result).toEqual({ removed: ['session-b'], retained: 2 })
      expect(writes).toEqual(['updateState'])
      expect(Object.keys((await store.getState()).sessionBindings).sort()).toEqual(['session-a', 'session-c'])
      const afterRaw = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>
      delete beforeRaw['sessionBindings']
      delete afterRaw['sessionBindings']
      expect(afterRaw).toEqual(beforeRaw)
    })
  })

  it('没有候选时零写入（字节与 mtime 都不动）', async () => {
    await withStore(async (store, stateFile) => {
      await seed(store, { 'session-a': BINDING, 'session-b': BINDING })
      await utimes(stateFile, PINNED_MTIME, PINNED_MTIME)
      const before = await readFile(stateFile)
      const writes = countWrites(store)

      const result = await store.pruneSessionBindings(new Set())

      expect(result).toEqual({ removed: [], retained: 2 })
      expect(writes).toHaveLength(0)
      expect(await readFile(stateFile)).toEqual(before)
      expect((await stat(stateFile)).mtimeMs).toBe(PINNED_MTIME.getTime())
    })
  })

  it('只删 observed ∩ remove：调用期间别处新增、且不在 remove 里的绑定不被删', async () => {
    await withStore(async (store) => {
      await seed(store, { 'session-old': BINDING, 'session-new': BINDING })
      // 快照故意漏掉 session-new：它代表「调用方判定之后、本次写盘之前」另一条
      // 路径刚写进的绑定。remove 来自判定时刻，因而只含 session-old。
      const observed = store.getState.bind(store)
      store.getState = async () => {
        const state = await observed()
        return { ...state, sessionBindings: { 'session-old': state.sessionBindings['session-old'] } }
      }

      const result = await store.pruneSessionBindings(new Set(['session-old']))

      expect(result).toEqual({ removed: ['session-old'], retained: 1 })
      const persisted = (await observed()).sessionBindings
      expect(Object.keys(persisted)).toEqual(['session-new'])
    })
  })

  it('remove 里但不在快照里的 id 不计入删除面（observed ∩ remove）', async () => {
    await withStore(async (store) => {
      await seed(store, { 'session-kept': BINDING })

      const result = await store.pruneSessionBindings(new Set(['session-kept', 'session-never-observed']))

      expect(result).toEqual({ removed: ['session-kept'], retained: 0 })
    })
  })
})
