/**
 * Cross-bundle store handles (same discipline as `im/handle.ts`).
 *
 * Why this must be anchored on globalThis: index.mjs, agent.mjs, novel.mjs,
 * card-workbench.mjs and compaction.mjs are separate esbuild products, so a
 * module-level singleton in one of them is invisible to the others. Before this
 * module every bundle opened its own TavernStore for the same data root, which
 * cost up to seven copies of the parsed state graph plus up to 32 parsed
 * character cards each, and — the correctness part — gave each copy its own
 * `stateMutationTail`. Two bundles patching state concurrently would then race
 * on read-modify-write and silently lose one update.
 *
 * The auxiliary stores follow the same contract through `shared-stores.ts`:
 * MemoryStore, VariableStore and MemoryVectorStore each own a `MutationTail`,
 * and NovelStore owns per-novel `KeyedMutationTails`, so a second instance per
 * bundle is a second write lane on the same files. Their key strings live here
 * so the whole bundle-to-bundle contract is readable in one place, while their
 * resolvers live in that module: this file must keep importing only TavernStore,
 * because compaction.mjs and card-workbench.mjs inline it and never use the
 * other four classes — pulling novel.ts or variable.ts in here would tax them.
 */

import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * Bundle-to-bundle contract keys (must stay byte-identical).
 *
 * One key per store family, never one shared map under one shared key: a
 * registry per family keeps a redefinition of one family's key from re-pointing
 * another family's lookups, and keeps the families' publishes from evicting each
 * other.
 */
export const TAVERN_STORE_HANDLE_KEY = 'dsh-soulmojito:tavern-store'
export const MEMORY_STORE_HANDLE_KEY = 'dsh-soulmojito:memory-store'
export const MEMORY_VECTOR_STORE_HANDLE_KEY = 'dsh-soulmojito:memory-vector-store'
export const VARIABLE_STORE_HANDLE_KEY = 'dsh-soulmojito:variable-store'
export const NOVEL_STORE_HANDLE_KEY = 'dsh-soulmojito:novel-store'

interface StoreEntry<T> {
  promise: Promise<T>
}

export interface StoreHandle<T> {
  /** The published instance for this data root. */
  readonly promise: Promise<T>
  /** Detach the handle only when this publish is still the current one. */
  readonly revoke: () => void
}

/** Publish / resolve / test-clear bound to one contract key. */
export interface StoreFamily<T> {
  readonly publish: (root: string, promise: Promise<T>) => StoreHandle<T>
  readonly shared: (root: string) => Promise<T>
  readonly clearForTest: () => void
}

/**
 * Bind one store family's handle operations to `key`, opening through `open` on
 * the first caller for a root.
 *
 * The revoker compares the entry object identity, not a per-producer sequence
 * number. The fibers of a hot reload publish in an order nobody controls, and
 * the outgoing fiber's disposer runs after the incoming one published; an
 * unconditional delete would drop the new handle. A module-level counter cannot
 * order those publishes once more than one bundle is loaded: each esbuild
 * product inlines this module, so every bundle starts its own counter at 1 and
 * two generations publish with the same number. Identity lives in the shared
 * registry, so it orders publishes from any number of bundles.
 *
 * Keyed by the resolved root so two DSH homes (`DSH_HOME`) never share an
 * instance, while every bundle serving the same root gets the same one — and
 * therefore the same mutation tail. Callers memoize the returned promise, so the
 * map lookup happens once per bundle, not once per call.
 */
export function createStoreFamily<T>(key: string, open: (root: string) => Promise<T>): StoreFamily<T> {
  const symbol = Symbol.for(key)
  const registry = (): Map<string, StoreEntry<T>> => {
    const holder = globalThis as Record<symbol, Map<string, StoreEntry<T>> | undefined>
    let entries = holder[symbol]
    if (entries === undefined) {
      entries = new Map()
      holder[symbol] = entries
    }
    return entries
  }
  const publish = (root: string, promise: Promise<T>): StoreHandle<T> => {
    const entry: StoreEntry<T> = { promise }
    registry().set(root, entry)
    return {
      promise,
      revoke: () => {
        if (registry().get(root) === entry) registry().delete(root)
      },
    }
  }
  return {
    publish,
    shared: (root) => {
      const existing = registry().get(root)
      if (existing !== undefined) return existing.promise
      return publish(root, open(root)).promise
    },
    // Test isolation: globalThis state is shared by every spec in a worker.
    clearForTest: () => {
      delete (globalThis as Record<symbol, Map<string, StoreEntry<T>> | undefined>)[symbol]
    },
  }
}

const tavernStores = createStoreFamily<TavernStore>(TAVERN_STORE_HANDLE_KEY, (root) => TavernStore.open(root))

export type TavernStoreHandle = StoreHandle<TavernStore>

/** Write side: install `promise` as the handle for `root`; see `createStoreFamily`. */
export function publishTavernStore(root: string, promise: Promise<TavernStore>): TavernStoreHandle {
  return tavernStores.publish(root, promise)
}

/**
 * Read side: the shared store for an absolute data root, opened on the first
 * caller.
 *
 * The boundary of "shared": the instance is shared, the class is not. Each
 * bundle inlines its own copy of `tavern-store`, so `instanceof` against
 * `TavernStore` or any exported error class only holds inside the bundle that
 * constructed the value — a shared instance can fail an `instanceof` check in
 * another bundle (use `isChatRevisionConflict` for the CAS-conflict case). The
 * public surface only grows across releases, so a method added in a newer
 * bundle does not exist on an instance opened by an older generation: assume
 * the shape of the generation that opened the handle, which may be older than
 * yours.
 */
export function sharedTavernStore(root: string): Promise<TavernStore> {
  return tavernStores.shared(root)
}

/** Test isolation: globalThis state is shared by every spec in a worker. */
export function clearTavernStoreHandlesForTest(): void {
  tavernStores.clearForTest()
}
