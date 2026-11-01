/**
 * Cross-bundle TavernStore handle (same discipline as `im/handle.ts`).
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
 * This module deliberately imports only `tavern-store`: inlining it into the
 * compaction and card-workbench bundles must not drag the index runtime graph
 * along with it.
 */

import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * Bundle-to-bundle contract key (must stay byte-identical).
 */
export const TAVERN_STORE_HANDLE_KEY = 'dsh-soulmojito:tavern-store'

const registrySymbol = Symbol.for(TAVERN_STORE_HANDLE_KEY)

interface StoreEntry {
  promise: Promise<TavernStore>
}

type StoreRegistry = Map<string, StoreEntry>

function storeRegistry(): StoreRegistry {
  const holder = globalThis as Record<symbol, StoreRegistry | undefined>
  let registry = holder[registrySymbol]
  if (registry === undefined) {
    registry = new Map()
    holder[registrySymbol] = registry
  }
  return registry
}

export interface TavernStoreHandle {
  /** The published instance for this data root. */
  readonly promise: Promise<TavernStore>
  /** Detach the handle only when this publish is still the current one. */
  readonly revoke: () => void
}

/**
 * Write side: install `promise` as the handle for `root`, returning a revoker.
 *
 * The revoker compares the entry object identity, not a per-producer sequence
 * number. The fibers of a hot reload publish in an order nobody controls, and
 * the outgoing fiber's disposer runs after the incoming one published; an
 * unconditional delete would drop the new handle. A module-level counter cannot
 * order those publishes once more than one bundle is loaded: each esbuild
 * product inlines this module, so every bundle starts its own counter at 1 and
 * two generations publish with the same number. Identity lives in the shared
 * registry, so it orders publishes from any number of bundles.
 */
export function publishTavernStore(root: string, promise: Promise<TavernStore>): TavernStoreHandle {
  const registry = storeRegistry()
  const entry: StoreEntry = { promise }
  registry.set(root, entry)
  return {
    promise,
    revoke: () => {
      if (registry.get(root) === entry) registry.delete(root)
    },
  }
}

/**
 * Read side: the shared store for an absolute data root, opened on the first
 * caller.
 *
 * Keyed by the resolved root so two DSH homes (`DSH_HOME`) never share an
 * instance, while every bundle serving the same root gets the same one — and
 * therefore the same mutation tail. Callers memoize the returned promise, so
 * the map lookup happens once per bundle, not once per call.
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
  const registry = storeRegistry()
  const existing = registry.get(root)
  if (existing !== undefined) return existing.promise
  return publishTavernStore(root, TavernStore.open(root)).promise
}

/** Test isolation: globalThis state is shared by every spec in a worker. */
export function clearTavernStoreHandlesForTest(): void {
  delete (globalThis as Record<symbol, StoreRegistry | undefined>)[registrySymbol]
}
