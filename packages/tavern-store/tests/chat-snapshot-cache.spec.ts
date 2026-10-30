/**
 * getChatSnapshot cache contract.
 *
 * `GET body` reads the same chat once per assistant row, so the read path keeps
 * a bounded parse cache. These tests pin the observable contract: a warm read
 * must not touch the file, an external rewrite must invalidate the entry, the
 * returned snapshot must be caller-owned, and the entry count must stay capped.
 * A hit is asserted through the cache counters and a file-read spy rather than
 * through equal return values, because equal values do not prove anything was
 * cached.
 */
import { promises as fsPromises } from 'node:fs'
import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_CHAT_SNAPSHOT_CACHE_ENTRIES, TavernStore } from '../src/index.js'
import type { ChatLogIR } from '@dsh-soulmojito/format'

const CHARACTER = 'Cache Char'

/** Minimal chat log; message text is the only varying field. */
function chatLog(...texts: string[]): ChatLogIR {
  return {
    header: { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    messages: texts.map((text) => ({
      name: CHARACTER,
      is_user: false,
      is_system: false,
      send_date: 'now',
      mes: text,
    })),
  }
}

/** Fresh store per test: the cache is process-local, so tests must not share one. */
async function withStore(run: (store: TavernStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tavern-chat-cache-'))
  try {
    await run(await TavernStore.open(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** saveChat assumes the character directory exists; seed it for a bare store. */
async function seedChat(
  store: TavernStore,
  dir: string,
  chatId: string,
  log: ChatLogIR,
  expectedRevision?: string,
): Promise<string> {
  await fsPromises.mkdir(path.join(dir, 'chats', CHARACTER), { recursive: true })
  return store.saveChat(CHARACTER, chatId, log, expectedRevision)
}

describe('getChatSnapshot cache', () => {
  it('serves the second read from memory without reading the chat file again', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'cache-hit.jsonl'
      await seedChat(store, dir, chatId, chatLog('first'))
      const file = path.join(dir, 'chats', CHARACTER, chatId)

      const first = await store.getChatSnapshot(CHARACTER, chatId)
      expect(first?.chat.messages[0]?.mes).toBe('first')

      const readFile = vi.spyOn(fsPromises, 'readFile')
      try {
        const second = await store.getChatSnapshot(CHARACTER, chatId)
        expect(second).toEqual(first)
        // The hit is proven by "no read of this file at all", not by equal values.
        expect(readFile.mock.calls.filter((call) => String(call[0]) === file)).toEqual([])
      } finally {
        readFile.mockRestore()
      }
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 })
    })
  })

  it('re-parses when an outside writer rewrites the file with the same size and a new mtime', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'external-write.jsonl'
      await seedChat(store, dir, chatId, chatLog('aaaa'))
      const file = path.join(dir, 'chats', CHARACTER, chatId)

      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.messages[0]?.mes).toBe('aaaa')
      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.messages[0]?.mes).toBe('aaaa')
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 })

      // In-place rewrite (same inode) of identical byte length: only the mtime
      // can tell the two versions apart, so move it explicitly forward instead
      // of relying on filesystem timestamp granularity.
      const before = await fsPromises.stat(file)
      const bytes = await fsPromises.readFile(file, 'utf8')
      await writeFile(file, bytes.replace('aaaa', 'bbbb'))
      await utimes(file, before.atime, new Date(before.mtimeMs + 2000))

      const updated = await store.getChatSnapshot(CHARACTER, chatId)
      expect(updated?.chat.messages[0]?.mes).toBe('bbbb')
      expect(updated?.revision).not.toBe(undefined)
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 1, misses: 2, size: 1 })
    })
  })

  it('returns a caller-owned copy so mutating a hit cannot corrupt the cache', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'copy.jsonl'
      const seeded = chatLog('original')
      seeded.messages[0]!.swipes = ['original']
      seeded.messages[0]!.extra = { nested: { depth: 1 } }
      await seedChat(store, dir, chatId, seeded)
      await store.getChatSnapshot(CHARACTER, chatId)

      const hit = await store.getChatSnapshot(CHARACTER, chatId)
      expect(hit).toBeDefined()
      hit!.chat.messages[0]!.mes = 'mutated'
      hit!.chat.messages[0]!.swipes![0] = 'mutated swipe'
      const nested = hit!.chat.messages[0]!.extra!['nested'] as Record<string, unknown>
      nested['depth'] = 99
      hit!.chat.header.chat_metadata['touched'] = true

      const reread = await store.getChatSnapshot(CHARACTER, chatId)
      expect(reread?.chat.messages[0]?.mes).toBe('original')
      expect(reread?.chat.messages[0]?.swipes).toEqual(['original'])
      expect(reread?.chat.messages[0]?.extra).toEqual({ nested: { depth: 1 } })
      expect(reread?.chat.header.chat_metadata).toEqual({})
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 2, misses: 1, size: 1 })
    })
  })

  it('keeps the entry count capped and evicts the least recently used chat', async () => {
    await withStore(async (store, dir) => {
      const ids = Array.from(
        { length: MAX_CHAT_SNAPSHOT_CACHE_ENTRIES + 1 },
        (_, index) => `cap-${index}.jsonl`,
      )
      for (const id of ids) await seedChat(store, dir, id, chatLog(id))
      for (const id of ids) await store.getChatSnapshot(CHARACTER, id)

      expect(store.chatSnapshotCacheStats()).toMatchObject({
        size: MAX_CHAT_SNAPSHOT_CACHE_ENTRIES,
        hits: 0,
        misses: ids.length,
      })

      // The oldest entry was evicted, so this chat has to be parsed again.
      await store.getChatSnapshot(CHARACTER, ids[0]!)
      expect(store.chatSnapshotCacheStats()).toMatchObject({ hits: 0, misses: ids.length + 1 })

      // The newest entry is still there and answers without a parse.
      await store.getChatSnapshot(CHARACTER, ids[ids.length - 1]!)
      expect(store.chatSnapshotCacheStats()).toMatchObject({
        hits: 1,
        misses: ids.length + 1,
        size: MAX_CHAT_SNAPSHOT_CACHE_ENTRIES,
      })
    })
  })

  it('never caches a corrupt chat file: every read still throws the parse error', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'corrupt.jsonl'
      const file = path.join(dir, 'chats', CHARACTER, chatId)
      await fsPromises.mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, '{ not jsonl')

      await expect(store.getChatSnapshot(CHARACTER, chatId)).rejects.toThrow(/not valid JSON/)
      await expect(store.getChatSnapshot(CHARACTER, chatId)).rejects.toThrow(/not valid JSON/)
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 0, misses: 2, size: 0 })

      // A repaired file is served normally afterwards: the failure was not cached.
      await seedChat(store, dir, chatId, chatLog('repaired'))
      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.messages[0]?.mes).toBe('repaired')
    })
  })

  it('never serves a stale parse after saveChat writes a log of equal length', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'save-invalidates.jsonl'
      const revision = await seedChat(store, dir, chatId, chatLog('aaaa'))
      await store.getChatSnapshot(CHARACTER, chatId)
      await store.getChatSnapshot(CHARACTER, chatId)
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 })
      const file = path.join(dir, 'chats', CHARACTER, chatId)

      // Pin the explicit invalidation itself: on filesystems where the atomic
      // tmp+rename replacement already changes every fingerprint term, the
      // behavioral assertion below would stay green even without the call.
      const invalidate = vi.spyOn(
        store as unknown as { invalidateChatSnapshot: (file: string) => void },
        'invalidateChatSnapshot',
      )
      try {
        // Same serialized byte length: an explicit invalidation, not the size
        // change, has to make the next read return the new body.
        await store.saveChat(CHARACTER, chatId, chatLog('bbbb'), revision)
        expect(invalidate).toHaveBeenCalledWith(file)
      } finally {
        invalidate.mockRestore()
      }

      const after = await store.getChatSnapshot(CHARACTER, chatId)
      expect(after?.chat.messages[0]?.mes).toBe('bbbb')
      expect(after?.revision).not.toBe(revision)
      expect(store.chatSnapshotCacheStats()).toEqual({ hits: 1, misses: 2, size: 1 })
    })
  })

  it('still yields undefined when the file vanishes between stat and read', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'vanishing.jsonl'
      await seedChat(store, dir, chatId, chatLog('kept'))

      // First read on a cold cache: `stat` succeeds, the read then sees the
      // file gone. The read path's contract is `undefined` for a missing
      // file, not a raw ENOENT.
      const vanished = Object.assign(new Error("ENOENT: no such file or directory, open 'gone'"), {
        code: 'ENOENT',
      })
      const readFile = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(vanished)
      try {
        expect(await store.getChatSnapshot(CHARACTER, chatId)).toBeUndefined()
      } finally {
        readFile.mockRestore()
      }
    })
  })

  it('keeps an array-shaped legacy line an array across a cache hit', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'array-line.jsonl'
      const file = path.join(dir, 'chats', CHARACTER, chatId)
      await fsPromises.mkdir(path.dirname(file), { recursive: true })
      await writeFile(
        file,
        `${JSON.stringify({ user_name: 'u', character_name: 'c', chat_metadata: {} })}\n${JSON.stringify(['legacy', 'row'])}\n`,
      )

      const cold = await store.getChatSnapshot(CHARACTER, chatId)
      expect(Array.isArray(cold?.chat.messages[0])).toBe(true)

      // The cached copy must not reshape the row: `Object.keys` on an array
      // would turn the cache hit into a plain object with index keys.
      const warm = await store.getChatSnapshot(CHARACTER, chatId)
      expect(Array.isArray(warm?.chat.messages[0])).toBe(true)
      expect(warm?.chat.messages[0]).toEqual(['legacy', 'row'])
      expect(store.chatSnapshotCacheStats()).toMatchObject({ hits: 1, misses: 1, size: 1 })
    })
  })

  it('re-parses when a replacement keeps size and mtime but not creation time', async () => {
    await withStore(async (store, dir) => {
      const chatId = 'ctime-replace.jsonl'
      await seedChat(store, dir, chatId, chatLog('aaaa'))
      const file = path.join(dir, 'chats', CHARACTER, chatId)
      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.messages[0]?.mes).toBe('aaaa')

      // A fresh file renames over the original (new inode / creation time),
      // then size and mtime are pinned back: only the creation-time
      // fingerprint term can still separate the two versions.
      const before = await fsPromises.stat(file)
      const bytes = await fsPromises.readFile(file, 'utf8')
      const replacement = path.join(path.dirname(file), `${chatId}.replace.tmp`)
      await writeFile(replacement, bytes.replace('aaaa', 'bbbb'))
      await rename(replacement, file)
      await utimes(file, before.atime, new Date(before.mtimeMs))

      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.messages[0]?.mes).toBe('bbbb')
    })
  })
})
