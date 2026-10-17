/** Memoized AgentNovel store singletons shared by agent.ts and every tool module.
 *  Single-instance discipline: never open a second copy of these stores. */

import { MemoryStore, NovelStore, TavernStore } from '../../../../tavern-store/src/index.js'
import { dshHomePath } from '../../dsh-home.js'

let tavernStorePromise: Promise<TavernStore> | undefined
let novelStorePromise: Promise<NovelStore> | undefined
let memoryStorePromise: Promise<MemoryStore> | undefined

export function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= TavernStore.open(dshHomePath('tavern')))
}

export function novelStore(): Promise<NovelStore> {
  return (novelStorePromise ??= NovelStore.open(dshHomePath('tavern')))
}

export function memoryStore(): Promise<MemoryStore> {
  return (memoryStorePromise ??= MemoryStore.open(dshHomePath('tavern')))
}
