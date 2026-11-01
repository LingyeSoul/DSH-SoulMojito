/**
 * Cross-bundle store handles: one data root must yield one instance per store
 * family (one parsed-state cache, one mutation tail each), different roots must
 * never share one, and the publish/revoke ordering must survive the overlapping
 * fibers of a hot reload. A later case pins the remaining store injection seam
 * (`openStore`) so a future refactor cannot let the shared handle bypass it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, MemoryVectorStore, NovelStore, TavernStore, VariableStore } from '../../tavern-store/src/index.js'
import { registerAgentTavernCardState } from '../src/agent-tavern/card-state.js'
import {
  memoryStore as agentTavernMemoryStore,
  memoryVectorStore as agentTavernMemoryVectorStore,
  tavernStore as agentTavernStore,
  variableStore as agentTavernVariableStore,
} from '../src/agent-tavern/tools/stores.js'
import { memoryStore as agentNovelMemoryStore, novelStore as agentNovelNovelStore } from '../src/agent-novel/tools/stores.js'
import { tavernStore as cardWorkbenchStore } from '../src/card-workbench/shared.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import { memories, memoryVectors, novelStore, store as indexStore, variables } from '../src/runtime.js'
import {
  clearMemoryStoreHandlesForTest,
  clearMemoryVectorStoreHandlesForTest,
  clearNovelStoreHandlesForTest,
  clearVariableStoreHandlesForTest,
  publishMemoryStore,
  publishMemoryVectorStore,
  publishNovelStore,
  publishVariableStore,
  sharedMemoryStore,
  sharedMemoryVectorStore,
  sharedNovelStore,
  sharedVariableStore,
} from '../src/shared-stores.js'
import { clearTavernStoreHandlesForTest, publishTavernStore, sharedTavernStore } from '../src/store-handle.js'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-store-handle-'))
  homes.push(home)
  return home
}

function clearAllHandles(): void {
  clearTavernStoreHandlesForTest()
  clearMemoryStoreHandlesForTest()
  clearMemoryVectorStoreHandlesForTest()
  clearVariableStoreHandlesForTest()
  clearNovelStoreHandlesForTest()
}

beforeEach(() => {
  clearAllHandles()
})

afterEach(() => {
  clearAllHandles()
  delete process.env.DSH_HOME
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes.length = 0
})

describe('shared TavernStore handle', () => {
  it('resolves one instance for repeated calls on the same root', async () => {
    const root = join(makeHome(), 'soulmojito')

    const first = await sharedTavernStore(root)
    const second = await sharedTavernStore(root)

    expect(second).toBe(first)
    expect(first.rootPath).toBe(root)
  })

  it('never shares an instance across data roots', async () => {
    const firstRoot = join(makeHome(), 'soulmojito')
    const secondRoot = join(makeHome(), 'soulmojito')

    const first = await sharedTavernStore(firstRoot)
    const second = await sharedTavernStore(secondRoot)

    expect(second).not.toBe(first)
    expect(first.rootPath).toBe(firstRoot)
    expect(second.rootPath).toBe(secondRoot)
  })

  it('hands every entry point in this module graph the same instance for one DSH home', async () => {
    process.env.DSH_HOME = makeHome()

    // These are the index, agent and card-workbench entry points. In this spec
    // they import the same module graph, so this pins the shared-handle wiring
    // rather than bundle isolation: two separate esbuild products run in one
    // process share the instance through the globalThis registry (verified with
    // a throwaway two-product probe, which is why the key is a Symbol.for and
    // not a module-local Map).
    const viaIndex = await indexStore()
    const viaAgent = await agentTavernStore()
    const viaWorkbench = await cardWorkbenchStore()
    const viaHandle = await sharedTavernStore(tavernDataRoot())

    expect(viaAgent).toBe(viaIndex)
    expect(viaWorkbench).toBe(viaIndex)
    expect(viaHandle).toBe(viaIndex)
    expect(viaIndex.rootPath).toBe(tavernDataRoot())
  })

  it('keeps a newer publish alive when the older one is revoked', async () => {
    const root = join(makeHome(), 'soulmojito')
    const stale = { rootPath: root } as unknown as TavernStore
    const current = { rootPath: root } as unknown as TavernStore

    // A hot reload publishes in an order nobody controls: the outgoing fiber's
    // disposer runs after the incoming fiber already published.
    const outgoing = publishTavernStore(root, Promise.resolve(stale))
    publishTavernStore(root, Promise.resolve(current))
    outgoing.revoke()

    expect(await sharedTavernStore(root)).toBe(current)
  })

  it('keeps a publish alive when an older revoker from another module generation runs', async () => {
    const root = join(makeHome(), 'soulmojito')
    const stale = { rootPath: root } as unknown as TavernStore
    const current = { rootPath: root } as unknown as TavernStore

    // Two module generations stand in for two bundles: each evaluates its own
    // copy of this module, so each would start its own publish counter at 1.
    // Identity lives in the shared globalThis registry, so the older revoker
    // must not touch the newer entry.
    const firstGeneration = await import('../src/store-handle.js')
    const outgoing = firstGeneration.publishTavernStore(root, Promise.resolve(stale))
    vi.resetModules()
    const nextGeneration = await import('../src/store-handle.js')
    nextGeneration.publishTavernStore(root, Promise.resolve(current))

    outgoing.revoke()

    expect(await nextGeneration.sharedTavernStore(root)).toBe(current)
  })

  it('detaches the root once the live publish is revoked', async () => {
    const root = join(makeHome(), 'soulmojito')
    const current = publishTavernStore(root, Promise.resolve({ rootPath: root } as unknown as TavernStore))

    await expect(sharedTavernStore(root)).resolves.toBe(await current.promise)

    current.revoke()

    // No handle left: the next resolve opens a fresh instance instead of
    // resurrecting the revoked one.
    expect(await sharedTavernStore(root)).not.toBe(await current.promise)
  })

  it('still honours the openStore injection seam instead of the shared handle', async () => {
    process.env.DSH_HOME = makeHome()
    let handleReads = 0
    let injectedReads = 0
    const poisoned = {
      getState: async () => { handleReads += 1; return { sessionBindings: {} } },
    } as unknown as TavernStore
    publishTavernStore(tavernDataRoot(), Promise.resolve(poisoned))

    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    registerAgentTavernCardState(
      {
        on: (event, registered) => {
          if (event === 'agent/pre-step') listener = registered as never
          return () => {}
        },
      },
      {
        openStore: async () => ({
          getState: async () => { injectedReads += 1; return { sessionBindings: {} } },
        }) as never,
      },
    )

    const decision = { kind: 'enter', messages: [] }
    const result = await listener!(
      { agent: { session: { id: 'injection-seam' } }, turn: 1, step: 1 },
      async () => decision,
    )

    expect(result).toBe(decision)
    expect(injectedReads).toBe(1)
    expect(handleReads).toBe(0)
  })
})

describe('shared auxiliary store handles', () => {
  const families = [
    ['MemoryStore', sharedMemoryStore],
    ['MemoryVectorStore', sharedMemoryVectorStore],
    ['VariableStore', sharedVariableStore],
    ['NovelStore', sharedNovelStore],
  ] as const

  it.each(families)('%s resolves one instance for a root and never shares across roots', async (_name, shared) => {
    const firstRoot = join(makeHome(), 'soulmojito')
    const secondRoot = join(makeHome(), 'soulmojito')

    const first = await shared(firstRoot)
    const second = await shared(firstRoot)
    const other = await shared(secondRoot)

    expect(second).toBe(first)
    expect(other).not.toBe(first)
  })

  it('keeps every family in its own registry', async () => {
    const root = join(makeHome(), 'soulmojito')
    const poisonedMemory = { root } as unknown as MemoryStore
    const poisonedNovel = { root } as unknown as NovelStore
    publishMemoryStore(root, Promise.resolve(poisonedMemory))
    publishNovelStore(root, Promise.resolve(poisonedNovel))

    // A publish on one family never answers another family's lookup: the
    // registries are per key, so a redefined or revoked family cannot re-point
    // its neighbours.
    expect(await sharedMemoryStore(root)).toBe(poisonedMemory)
    expect(await sharedMemoryVectorStore(root)).not.toBe(poisonedMemory)
    expect(await sharedVariableStore(root)).not.toBe(poisonedMemory)
    expect(await sharedTavernStore(root)).not.toBe(poisonedMemory)
    expect(await sharedNovelStore(root)).toBe(poisonedNovel)

    // Clearing one family publishes nothing and drops nothing elsewhere.
    clearMemoryStoreHandlesForTest()
    expect(await sharedMemoryStore(root)).not.toBe(poisonedMemory)
    expect(await sharedNovelStore(root)).toBe(poisonedNovel)
  })

  it('keeps a newer publish alive when an older generation revokes it', async () => {
    const root = join(makeHome(), 'soulmojito')
    const staleMemory = { root } as unknown as MemoryStore
    const staleVectors = { root } as unknown as MemoryVectorStore
    const staleVariables = { root } as unknown as VariableStore
    const staleNovels = { root } as unknown as NovelStore

    // Two module generations stand in for two bundles: each evaluates its own
    // copy of `shared-stores`, so the outgoing revoker must leave the incoming
    // publish alone even though both wrote the same contract key.
    const outgoing = await import('../src/shared-stores.js')
    const revokers = [
      outgoing.publishMemoryStore(root, Promise.resolve(staleMemory)),
      outgoing.publishMemoryVectorStore(root, Promise.resolve(staleVectors)),
      outgoing.publishVariableStore(root, Promise.resolve(staleVariables)),
      outgoing.publishNovelStore(root, Promise.resolve(staleNovels)),
    ]

    vi.resetModules()
    const incoming = await import('../src/shared-stores.js')
    const currentMemory = { root } as unknown as MemoryStore
    const currentVectors = { root } as unknown as MemoryVectorStore
    const currentVariables = { root } as unknown as VariableStore
    const currentNovels = { root } as unknown as NovelStore
    incoming.publishMemoryStore(root, Promise.resolve(currentMemory))
    incoming.publishMemoryVectorStore(root, Promise.resolve(currentVectors))
    incoming.publishVariableStore(root, Promise.resolve(currentVariables))
    incoming.publishNovelStore(root, Promise.resolve(currentNovels))

    for (const revoker of revokers) revoker.revoke()

    expect(await incoming.sharedMemoryStore(root)).toBe(currentMemory)
    expect(await incoming.sharedMemoryVectorStore(root)).toBe(currentVectors)
    expect(await incoming.sharedVariableStore(root)).toBe(currentVariables)
    expect(await incoming.sharedNovelStore(root)).toBe(currentNovels)
  })

  it('detaches a root once its live publish is revoked', async () => {
    const root = join(makeHome(), 'soulmojito')
    const current = publishMemoryStore(root, Promise.resolve({ root } as unknown as MemoryStore))

    await expect(sharedMemoryStore(root)).resolves.toBe(await current.promise)

    current.revoke()

    // No handle left: the next resolve opens a fresh instance instead of
    // resurrecting the revoked one.
    expect(await sharedMemoryStore(root)).not.toBe(await current.promise)
  })

  it('hands the runtime accessors and every bundle-side accessor the same instance', async () => {
    process.env.DSH_HOME = makeHome()
    // Fresh module generation: the accessors memoize their handle per module,
    // and this case must not inherit a home resolved by an earlier case.
    // This spec shares one module graph across all three entry points, so the
    // case pins the wiring; real product isolation goes through the globalThis
    // registries exercised by the two-generation cases above.
    vi.resetModules()
    const runtime = await import('../src/runtime.js')
    const tavernTools = await import('../src/agent-tavern/tools/stores.js')
    const novelTools = await import('../src/agent-novel/tools/stores.js')

    const memory = await runtime.memories()
    const variable = await runtime.variables()
    const vectors = await runtime.memoryVectors()
    const novels = await runtime.novelStore()

    // runtime.ts stays the canonical entry; agent.mjs and novel.mjs reach the
    // same instance (same mutation tail) through the shared handles.
    expect(await tavernTools.memoryStore()).toBe(memory)
    expect(await novelTools.memoryStore()).toBe(memory)
    expect(await tavernTools.variableStore()).toBe(variable)
    expect(await tavernTools.memoryVectorStore()).toBe(vectors)
    expect(await novelTools.novelStore()).toBe(novels)
    expect(await runtime.store()).toBe(await tavernTools.tavernStore())
  })
})
