/**
 * Bootstrap world entry count cache: a second projection pass must not re-read
 * unchanged books, a changed book must be re-read, and namespaces must never
 * share entries (DSH_HOME can change inside one process).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TavernStore } from '../../tavern-store/src/index.js'
import { collectWorldEntryCounts, resetWorldEntryCountCache } from '../src/http/world-entry-counts.js'

const WORLD = 'Example World'
const SECOND = 'Second Example'
const BROKEN = 'Broken Example'

function entry(uid: number, content: string) {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: `entry ${uid}`,
    content,
    constant: true,
    selective: false,
    order: 100,
    position: 0,
    disable: false,
  }
}

function book(count: number, prefix: string): Record<string, unknown> {
  return {
    entries: Object.fromEntries(
      Array.from({ length: count }, (_, uid) => [String(uid), entry(uid, `${prefix} ${uid}`)]),
    ),
  }
}

describe('world entry count cache', () => {
  let home: string
  let root: string
  let store: TavernStore

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-world-counts-'))
    root = join(home, 'soulmojito')
    store = await TavernStore.open(root)
    await store.importWorldFile(WORLD, book(2, 'example lore'))
    await store.importWorldFile(SECOND, book(1, 'second lore'))
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('re-parses only the book whose file size or mtime changed', async () => {
    resetWorldEntryCountCache()
    const reads = vi.spyOn(TavernStore.prototype, 'getWorld')
    try {
      const first = await collectWorldEntryCounts(store, root)
      expect(first).toEqual({ [WORLD]: 2, [SECOND]: 1 })
      expect(reads).toHaveBeenCalledTimes(2)

      reads.mockClear()
      const cached = await collectWorldEntryCounts(store, root)
      expect(cached).toEqual(first)
      expect(reads).not.toHaveBeenCalled()

      await store.importWorldFile(WORLD, book(3, 'updated lore'))
      reads.mockClear()
      const updated = await collectWorldEntryCounts(store, root)
      expect(updated).toEqual({ [WORLD]: 3, [SECOND]: 1 })
      expect(reads.mock.calls.map(([name]) => name)).toEqual([WORLD])
    } finally {
      reads.mockRestore()
      resetWorldEntryCountCache()
    }
  })

  it('keys entries by store namespace so another DSH root cannot reuse them', async () => {
    resetWorldEntryCountCache()
    const reads = vi.spyOn(TavernStore.prototype, 'getWorld')
    try {
      await collectWorldEntryCounts(store, root)
      reads.mockClear()
      const otherRoot = join(home, 'other-dsh-home', 'soulmojito')
      const counts = await collectWorldEntryCounts(store, otherRoot)
      expect(counts[WORLD]).toBe(3)
      // Same files and fingerprints, but a different namespace must read again.
      expect(reads.mock.calls.map(([name]) => name).sort()).toEqual([WORLD, SECOND])
    } finally {
      reads.mockRestore()
      resetWorldEntryCountCache()
    }
  })

  it('keeps corrupt books out of the projection and negative-caches them', async () => {
    const brokenPath = join(root, 'worlds', `${BROKEN}.json`)
    writeFileSync(brokenPath, 'not json')
    resetWorldEntryCountCache()
    const reads = vi.spyOn(TavernStore.prototype, 'getWorld')
    try {
      const first = await collectWorldEntryCounts(store, root)
      expect(first).not.toHaveProperty(BROKEN)
      expect(first[WORLD]).toBe(3)
      const callsAfterFirst = reads.mock.calls.length
      expect(callsAfterFirst).toBe(3)

      const second = await collectWorldEntryCounts(store, root)
      expect(second).toEqual(first)
      expect(reads).toHaveBeenCalledTimes(callsAfterFirst)
    } finally {
      reads.mockRestore()
      rmSync(brokenPath, { force: true })
      resetWorldEntryCountCache()
    }
  })
})