/**
 * Bootstrap `worldEntryCounts` cache (2026-10-25).
 *
 * Bootstrap needs the number of entries in every world book for the panel list,
 * but reading and JSON-parsing every book on each page refresh costs O(total
 * world bytes). This module keeps a bounded per-process projection keyed by the
 * store namespace (the data root) plus world name, and re-reads a book only when
 * its file size or mtime changes.
 *
 * Corrupt books stay out of the projection exactly like the uncached loop: the
 * bootstrap response remains 200 and the panel falls back to 0. The negative
 * result is cached too, so an unchanged corrupt file is not re-parsed.
 */
import type { TavernStore } from '../../../tavern-store/src/index.js'

const MAX_CACHE_ENTRIES = 4096

interface CachedWorldCount {
  size: number
  mtimeMs: number
  /** null = the file exists but failed to parse; omit it from the projection. */
  count: number | null
}

const cache = new Map<string, CachedWorldCount>()

/** Test hook: drop every cached projection (process-local only). */
export function resetWorldEntryCountCache(): void {
  cache.clear()
}

export async function collectWorldEntryCounts(
  db: Pick<TavernStore, 'worldFileFingerprints' | 'getWorld'>,
  namespace: string,
): Promise<Record<string, number>> {
  const fingerprints = await db.worldFileFingerprints()
  const prefix = `${namespace}\u0000`
  const seen = new Set<string>()
  const counts: Record<string, number> = {}

  for (const fingerprint of fingerprints) {
    const key = `${prefix}${fingerprint.name}`
    seen.add(key)
    const cached = cache.get(key)
    if (cached !== undefined && cached.size === fingerprint.size && cached.mtimeMs === fingerprint.mtimeMs) {
      if (cached.count !== null) counts[fingerprint.name] = cached.count
      continue
    }
    let count: number | null = null
    try {
      const book = await db.getWorld(fingerprint.name)
      if (book !== undefined) count = book.entries.length
    } catch {
      // Corrupt/unreadable book: keep bootstrap alive and omit its count.
    }
    cache.delete(key)
    cache.set(key, { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, count })
    if (count !== null) counts[fingerprint.name] = count
    evictOverflow()
  }

  // Deleted worlds must not keep their projection alive until the size cap
  // evicts it: a later book with the same name must start from a fresh read.
  for (const key of cache.keys()) {
    if (key.startsWith(prefix) && !seen.has(key)) cache.delete(key)
  }

  return counts
}

function evictOverflow(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}