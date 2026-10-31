import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { HostAgentLike, PluginContext } from '../src/host-contract.js'
import { API } from '../src/http/router.js'
import type { ImRouter } from '../src/im/router.js'
import { createImRuntime } from '../src/im/runtime.js'
import type { ImRuntime } from '../src/im/runtime.js'
import { clearOneBotSeatForTest } from '../src/im/onebot/seat.js'
import type { QqBotLike } from '../src/im/qq/sdk.js'
import { ImStore } from '../src/im/store.js'
import type { ImAccountRef } from '../src/im/types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey } from '../src/im/types.js'

const ACCOUNT: ImAccountRef = {
  channel: 'onebot',
  accountId: '10001',
  label: 'primary bot',
  createdAt: new Date(0).toISOString(),
}

/** 合成 QQ 账号：accountId 即平台 AppID，用不可达的测试号段。 */
function qqAccount(accountId: string): ImAccountRef {
  return { channel: 'qq', accountId, label: '扫码绑定', createdAt: new Date(0).toISOString() }
}

/**
 * 每次 `start()` 都以 SDK 的真实原文失败：access_token 请求被
 * `@tencent-connect/qqbot-nodejs` 的固定 10s 超时 abort。只做最小形状，
 * 通道的 listener 注册与 stop 都有落点。
 */
function networkFailingQQBot(): QqBotLike {
  return {
    on: () => undefined,
    start: async () => {
      throw new Error('Network error getting access_token: This operation was aborted')
    },
    stop: () => {},
    sendText: async () => ({ id: 'unused' }),
    sendMarkdown: async () => ({ id: 'unused' }),
  } as unknown as QqBotLike
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

/** 带一个活着 agent 的宿主：绑定会话的入站能真正插进 agent.followup。 */
function fakeContextWithAgent(agent: HostAgentLike): PluginContext {
  const sessionId = agent.session?.id ?? agent.id
  const agents = { get: (id: string) => (id === sessionId ? agent : undefined) }
  return { webServer: { register: () => () => {} }, agents } as unknown as PluginContext
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
      const peerKey = imPeerKey('onebot', '10001', 'private', 'u1')
      const otherKey = imPeerKey('onebot', '20002', 'private', 'u2')
      await db.updateState(() => ({
        imPeers: {
          [peerKey]: { sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
          [otherKey]: { sessionId: 'session-b', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
        },
        imPendingPeers: {
          [peerKey]: { lastAt: 1 },
          [otherKey]: { lastAt: 2 },
        },
      }))
      expect(await runtime.removeAccount('onebot', '10001')).toBe(true)
      expect(runtime.views()).toEqual([])
      expect(await store().readSecret('onebot', '10001')).toBeUndefined()
      const state = await db.getState()
      // 账号没了，它的绑定与待办一起删；另一个账号的记录不受影响。
      expect(state.imPeers?.[peerKey]).toBeUndefined()
      expect(state.imPendingPeers?.[peerKey]).toBeUndefined()
      expect(state.imPeers?.[otherKey]).toBeDefined()
      expect(state.imPendingPeers?.[otherKey]).toBeDefined()
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

  it('refuses a weixin account without botToken/baseUrl and persists nothing', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      // 微信凭据先验后存：缺 botToken/baseUrl 时不落盘，也不登记通道。
      await expect(runtime.upsertAccount({ ...ACCOUNT, channel: 'weixin' }, { token: 'secret-token' }))
        .rejects.toMatchObject({ code: 'WEIXIN_BAD_SECRET' })
      expect(await store().accounts()).toEqual([])
      expect(await store().readSecret('weixin', ACCOUNT.accountId)).toBeUndefined()
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

  it('flushes buffered inbound messages before stopping channels on dispose', async () => {
    // 假定时器让 600ms 窗口不自己触发：只有 dispose 的冲刷能投递这条消息。
    vi.useFakeTimers()
    const seen = { viewsAtInsert: -1, messages: [] as unknown[] }
    const runtimeRef: { current?: ImRuntime } = {}
    const agent: HostAgentLike = {
      id: 'session-a',
      session: { id: 'session-a' },
      status: 'idle',
      followup: async (message: unknown) => {
        // 插入发生时通道应仍在册：dispose 先冲刷缓冲，再停通道。
        seen.viewsAtInsert = runtimeRef.current?.views().length ?? -1
        seen.messages.push(message)
      },
    }
    const runtime = createImRuntime(fakeContextWithAgent(agent), { db })
    runtimeRef.current = runtime
    let disposed = false
    try {
      await runtime.upsertAccount(ACCOUNT, { token: '{{SECRET_zorzlc7t}}' })
      expect(runtime.views()).toHaveLength(1)
      const peerKey = imPeerKey('onebot', '10001', 'private', 'u1')
      await db.patchState({
        imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'open', groupMode: 'open' },
        imPeers: {
          [peerKey]: {
            sessionId: 'session-a',
            scope: 'private',
            boundBy: 'manual',
            createdAt: new Date(0).toISOString(),
          },
        },
      })
      const router = runtime.router as unknown as ImRouter
      await router.inbound({
        channel: 'onebot',
        accountId: '10001',
        scope: 'private',
        peerId: 'u1',
        senderId: 'u1',
        senderName: '甲',
        text: '窗口里压着的一条',
        media: [],
        dedupeKey: 'onebot:10001:private:u1:1',
        receivedAt: Date.now(),
      })
      // 窗口未到：消息还压在合流缓冲里，没有任何投递。
      expect(seen.messages).toHaveLength(0)

      await runtime.dispose()
      disposed = true
      // dispose 冲刷投递了一条；插入时账号还在册，dispose 返回后通道已清空。
      expect(seen.messages).toHaveLength(1)
      expect(seen.viewsAtInsert).toBe(1)
      expect(runtime.views()).toEqual([])
    } finally {
      if (!disposed) await runtime.dispose()
      vi.useRealTimers()
    }
  })

  it('deletes a new qq account after every retried start only hit a token network abort', async () => {
    let bots = 0
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => {
        bots += 1
        return networkFailingQQBot()
      },
      qqStartRetrySleep: async () => {},
    })
    try {
      // 启动恢复只读一次账号表：先让它读完空表，后面的 upsert 才不会被重放成第二个实例。
      await new Promise((resolve) => { setTimeout(resolve, 25) })
      await expect(runtime.upsertAccount(qqAccount('7100001'), { appId: '7100001', appSecret: 'network-secret' }))
        .rejects.toMatchObject({ code: 'QQ_START_FAILED' })
      expect(bots).toBe(3)
      // 三次网络失败后不留半残账号：账号与密钥都要回滚干净。
      expect(await store().accounts()).toEqual([])
      expect(await store().readSecret('qq', '7100001')).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('restores the previous qq secret after every retried start only hit a token network abort', async () => {
    // 既有账号先落盘：启动恢复与面板改配置都会撞上同一个重试路径。
    await store().putAccount(qqAccount('7100002'), { appId: '7100002', appSecret: 'old-secret' })
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => networkFailingQQBot(),
      qqStartRetrySleep: async () => {},
    })
    try {
      await expect(runtime.upsertAccount(qqAccount('7100002'), { appId: '7100002', appSecret: 'replacement-secret' }))
        .rejects.toMatchObject({ code: 'QQ_START_FAILED' })
      // 回滚的目标是「store 里没有连不上的配置」，不是删掉用户已有的机器人。
      expect(await store().readSecret('qq', '7100002')).toEqual({ appId: '7100002', appSecret: 'old-secret' })
      expect((await store().accounts()).map((account) => account.accountId)).toEqual(['7100002'])
    } finally {
      await runtime.dispose()
    }
  })
})
