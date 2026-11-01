/**
 * Cross-bundle handles for the auxiliary stores: memories, memory vectors,
 * variables and novels.
 *
 * Same discipline as `store-handle.ts` — globalThis registry, `Symbol.for`
 * contract key, publish/revoke by entry identity, `clearXxxForTest` — and the
 * same reason, with a sharper edge: each of these classes owns the in-process
 * write serialization for its files (`MutationTail` in MemoryStore,
 * VariableStore and MemoryVectorStore; `KeyedMutationTails` per novelId in
 * NovelStore). Opened once per bundle, two bundles write through two tails, and
 * a read-modify-write in each silently loses one update; opened through this
 * module, every bundle shares one instance and therefore one tail.
 *
 * The resolvers live here rather than in `store-handle.ts` because this module's
 * `tavern-store` imports (novel.ts, variable.ts, ...) must stay out of
 * compaction.mjs and card-workbench.mjs, which inline the tavern handle alone.
 * The families are created lazily inside their own accessors for the same
 * reason at one level down: a bundle that only needs memories must not emit
 * novel.ts, and esbuild drops the accessors (and with them the class reference)
 * that nobody imports.
 *
 * Boundary of "shared": the instance is shared, the class is not — every bundle
 * inlines its own copy of `tavern-store`, so `instanceof` against these classes
 * only holds inside the bundle that constructed the value. Read the exported
 * error `code` fields instead.
 */

import { MemoryStore, MemoryVectorStore, NovelStore, VariableStore } from '../../tavern-store/src/index.js'
import {
  MEMORY_STORE_HANDLE_KEY,
  MEMORY_VECTOR_STORE_HANDLE_KEY,
  NOVEL_STORE_HANDLE_KEY,
  VARIABLE_STORE_HANDLE_KEY,
  createStoreFamily,
  type StoreFamily,
  type StoreHandle,
} from './store-handle.js'

export type MemoryStoreHandle = StoreHandle<MemoryStore>
export type MemoryVectorStoreHandle = StoreHandle<MemoryVectorStore>
export type VariableStoreHandle = StoreHandle<VariableStore>
export type NovelStoreHandle = StoreHandle<NovelStore>

let memoryStores: StoreFamily<MemoryStore> | undefined
let memoryVectorStores: StoreFamily<MemoryVectorStore> | undefined
let variableStores: StoreFamily<VariableStore> | undefined
let novelStores: StoreFamily<NovelStore> | undefined

function memoryFamily(): StoreFamily<MemoryStore> {
  return (memoryStores ??= createStoreFamily<MemoryStore>(MEMORY_STORE_HANDLE_KEY, (root) => MemoryStore.open(root)))
}

function memoryVectorFamily(): StoreFamily<MemoryVectorStore> {
  return (memoryVectorStores ??= createStoreFamily<MemoryVectorStore>(MEMORY_VECTOR_STORE_HANDLE_KEY, (root) => MemoryVectorStore.open(root)))
}

function variableFamily(): StoreFamily<VariableStore> {
  return (variableStores ??= createStoreFamily<VariableStore>(VARIABLE_STORE_HANDLE_KEY, (root) => VariableStore.open(root)))
}

function novelFamily(): StoreFamily<NovelStore> {
  return (novelStores ??= createStoreFamily<NovelStore>(NOVEL_STORE_HANDLE_KEY, (root) => NovelStore.open(root)))
}

/** Write side: install `promise` as the memory handle for `root`; see `createStoreFamily`. */
export function publishMemoryStore(root: string, promise: Promise<MemoryStore>): MemoryStoreHandle {
  return memoryFamily().publish(root, promise)
}

/** Read side: the shared MemoryStore for an absolute data root, opened on the first caller. */
export function sharedMemoryStore(root: string): Promise<MemoryStore> {
  return memoryFamily().shared(root)
}

export function clearMemoryStoreHandlesForTest(): void {
  memoryFamily().clearForTest()
}

/** Write side: install `promise` as the memory-vector handle for `root`. */
export function publishMemoryVectorStore(root: string, promise: Promise<MemoryVectorStore>): MemoryVectorStoreHandle {
  return memoryVectorFamily().publish(root, promise)
}

/** Read side: the shared MemoryVectorStore for an absolute data root, opened on the first caller. */
export function sharedMemoryVectorStore(root: string): Promise<MemoryVectorStore> {
  return memoryVectorFamily().shared(root)
}

export function clearMemoryVectorStoreHandlesForTest(): void {
  memoryVectorFamily().clearForTest()
}

/** Write side: install `promise` as the variable handle for `root`. */
export function publishVariableStore(root: string, promise: Promise<VariableStore>): VariableStoreHandle {
  return variableFamily().publish(root, promise)
}

/** Read side: the shared VariableStore for an absolute data root, opened on the first caller. */
export function sharedVariableStore(root: string): Promise<VariableStore> {
  return variableFamily().shared(root)
}

export function clearVariableStoreHandlesForTest(): void {
  variableFamily().clearForTest()
}

/** Write side: install `promise` as the novel handle for `root`. */
export function publishNovelStore(root: string, promise: Promise<NovelStore>): NovelStoreHandle {
  return novelFamily().publish(root, promise)
}

/** Read side: the shared NovelStore for an absolute data root, opened on the first caller. */
export function sharedNovelStore(root: string): Promise<NovelStore> {
  return novelFamily().shared(root)
}

export function clearNovelStoreHandlesForTest(): void {
  novelFamily().clearForTest()
}
