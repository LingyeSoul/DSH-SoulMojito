/** Memoized AgentNovel store singletons shared by agent.ts and every tool module.
 *  Single-instance discipline: never open a second copy of these stores — the
 *  handles in `src/shared-stores.ts` give every bundle the same instance (and
 *  the same per-novel mutation tails) for one data root. */

import type { MemoryStore, NovelStore, TavernStore } from '../../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../../dsh-home.js'
import { sharedMemoryStore, sharedNovelStore } from '../../shared-stores.js'
import { sharedTavernStore } from '../../store-handle.js'

let tavernStorePromise: Promise<TavernStore> | undefined
let novelStorePromise: Promise<NovelStore> | undefined
let memoryStorePromise: Promise<MemoryStore> | undefined

export function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= sharedTavernStore(tavernDataRoot()))
}

export function novelStore(): Promise<NovelStore> {
  return (novelStorePromise ??= sharedNovelStore(tavernDataRoot()))
}

export function memoryStore(): Promise<MemoryStore> {
  return (memoryStorePromise ??= sharedMemoryStore(tavernDataRoot()))
}
