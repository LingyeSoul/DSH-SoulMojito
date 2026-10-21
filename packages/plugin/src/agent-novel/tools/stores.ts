/** Memoized AgentNovel store singletons shared by agent.ts and every tool module.
 *  Single-instance discipline: never open a second copy of these stores. */

import { MemoryStore, NovelStore, TavernStore } from '../../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../../dsh-home.js'

let tavernStorePromise: Promise<TavernStore> | undefined
let novelStorePromise: Promise<NovelStore> | undefined
let memoryStorePromise: Promise<MemoryStore> | undefined

export function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= TavernStore.open(tavernDataRoot()))
}

export function novelStore(): Promise<NovelStore> {
  return (novelStorePromise ??= NovelStore.open(tavernDataRoot()))
}

export function memoryStore(): Promise<MemoryStore> {
  return (memoryStorePromise ??= MemoryStore.open(tavernDataRoot()))
}
