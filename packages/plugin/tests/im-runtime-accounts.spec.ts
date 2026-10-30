import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { PluginContext } from '../src/host-contract.js'
import { API } from '../src/http/router.js'
import { createImRuntime } from '../src/im/runtime.js'
import { clearOneBotSeatForTest } from '../src/im/onebot/seat.js'
import { ImStore } from '../src/im/store.js'
import type { ImAccountRef } from '../src/im/types.js'

const ACCOUNT: ImAccountRef = {
  channel: 'onebot',
  accountId: '10001',
  label: 'primary bot',
  createdAt: new Date(0).toISOString(),
}

let root: string
let db: TavernStore

beforeEach(async () => {
  clearOneBotSeatForTest()
  root = await mkdtemp(join(tmpdir(), 'im-runtime-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  clearOneBotSeatForTest()
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function fakeContext(registerUpgrade?: (route: { path: string }) => () => void): PluginContext {
  const webServer = {
    register: () => () => {},
    ...(registerUpgrade === undefined ? {} : { registerUpgrade }),
  }
  return { webServer } as unknown as PluginContext
}

function store(): ImStore {
  return ImStore.open(tavernDataRoot('im'))
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('im runtime account lifecycle', () => {
  it('registers the upgrade route once per process and never unregisters it per runtime', async () => {
    let registrations = 0
    let registeredPath: string | undefined
    const host = fakeContext((route) => {
      registrations += 1
      registeredPath = route.path
      return () => { throw new Error('the upgrade seat must not be unregistered by a runtime instance') }
    })
    const first = createImRuntime(host, { db })
    expect(registeredPath).toBe(`${API}/im/onebot/ws`)
    await first.upsertAccount(ACCOUNT, { token: 'secret-token' })
    expect(first.views()).toMatchObject([
      { channel: 'onebot', accountId: '10001', status: { state: 'idle' }, peers: 0 },
    ])
    expect(await store().readSecret('onebot', '10001')).toEqual({ token: 'secret-token' })
    await first.dispose()
    // 重载后的第二个实例复用同一席位：不重复注册，也不把路由拆掉（审查 P1-1）。
    const second = createImRuntime(host, { db })
    await second.dispose()
    expect(registrations).toBe(1)
  })

  it('removes the account and reports whether anything was removed', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      await runtime.upsertAccount(ACCOUNT, { token: 'secret-token' })
      expect(await runtime.removeAccount('onebot', '10001')).toBe(true)
      expect(runtime.views()).toEqual([])
      expect(await store().readSecret('onebot', '10001')).toBeUndefined()
      expect(await runtime.removeAccount('onebot', '10001')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('restores a stored account on the next runtime', async () => {
    const first = createImRuntime(fakeContext(), { db })
    await first.upsertAccount(ACCOUNT, { token: 'secret-token' })
    await first.dispose()

    const second = createImRuntime(fakeContext(), { db })
    try {
      await waitFor(() => second.views().length === 1, 3_000)
      expect(second.views()[0]).toMatchObject({ channel: 'onebot', accountId: '10001', status: { state: 'idle' } })
    } finally {
      await second.dispose()
    }
  })

  it('refuses a channel without an adapter instead of persisting a dead account', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      await expect(runtime.upsertAccount({ ...ACCOUNT, channel: 'weixin' }, { token: 'secret-token' }))
        .rejects.toMatchObject({ code: 'IM_CHANNEL_UNSUPPORTED' })
      expect(await store().accounts()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('reports the missing registerUpgrade seam instead of pretending reverse websocket works', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      expect(runtime.capabilities.reasons.join(' ')).toContain('webServer.registerUpgrade')
    } finally {
      await runtime.dispose()
    }
  })
})
