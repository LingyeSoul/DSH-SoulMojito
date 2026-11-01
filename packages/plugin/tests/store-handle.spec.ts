/**
 * Cross-bundle TavernStore handle: one data root must yield one instance (one
 * parsed-state cache, one state mutation tail), different roots must never
 * share one, and the publish/revoke ordering must survive the overlapping
 * fibers of a hot reload. The last case pins the remaining store injection
 * seam (`openStore`) so a future refactor cannot let the shared handle bypass
 * it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TavernStore } from '../../tavern-store/src/index.js'
import { registerAgentTavernCardState } from '../src/agent-tavern/card-state.js'
import { tavernStore as agentTavernStore } from '../src/agent-tavern/tools/stores.js'
import { tavernStore as cardWorkbenchStore } from '../src/card-workbench/shared.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import { store as indexStore } from '../src/runtime.js'
import { clearTavernStoreHandlesForTest, publishTavernStore, sharedTavernStore } from '../src/store-handle.js'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-store-handle-'))
  homes.push(home)
  return home
}

beforeEach(() => {
  clearTavernStoreHandlesForTest()
})

afterEach(() => {
  clearTavernStoreHandlesForTest()
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
