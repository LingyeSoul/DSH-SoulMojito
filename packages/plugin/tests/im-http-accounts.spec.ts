import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { PluginContext } from '../src/host-contract.js'
import { handleImApi } from '../src/http/im.js'
import type { HttpRequest, HttpResponse } from '../src/http/io.js'
import { imSenderHash } from '../src/im/owner.js'
import { createImRuntime } from '../src/im/runtime.js'
import { ImStore, ImStoreError } from '../src/im/store.js'
import type { ImRuntime } from '../src/im/runtime.js'
import { WeixinBindError } from '../src/im/weixin/bind.js'
import { WeixinChannelError } from '../src/im/weixin/channel.js'
import type { ImAccountRef, ImSettings } from '../src/im/types.js'
import { imPeerAlias, imPeerKey } from '../src/im/types.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-http-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface FakeResponse {
  statusCode: number
  writableEnded: boolean
  chunks: string[]
  setHeader: () => void
  end: (chunk?: string) => void
}

function makeRequest(body: unknown, url: string, method: string): HttpRequest {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  } as unknown as HttpRequest
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    writableEnded: false,
    chunks: [],
    setHeader: () => {},
    end: (chunk?: string) => {
      if (chunk !== undefined) response.chunks.push(chunk)
      response.writableEnded = true
    },
  }
  return response
}

function runtimeOf(overrides: Partial<ImRuntime> = {}): ImRuntime {
  return {
    capabilities: { available: true, reasons: [] },
    views: () => [],
    upsertAccount: async (account: ImAccountRef, secret: Record<string, string>) => {
      await ImStore.open(tavernDataRoot('im')).putAccount(account, { token: secret.token ?? '' })
    },
    removeAccount: async (channel, accountId) => ImStore.open(tavernDataRoot('im')).deleteAccount(channel, accountId),
    handleOneBotWebhook: async () => false,
    dispose: async () => {},
    router: { sendText: async () => { throw new Error('sendText is not part of this test') } },
    ...overrides,
  }
}

async function call(
  body: unknown,
  url: string,
  route: string,
  method: string,
  runtime: ImRuntime,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = makeResponse()
  await handleImApi(
    makeRequest(body, url, method),
    response as unknown as HttpResponse,
    new URL(url, 'http://localhost'),
    route,
    method,
    db,
    runtime,
  )
  return { statusCode: response.statusCode, body: JSON.parse(response.chunks.join('')) as Record<string, unknown> }
}

describe('im account routes', () => {
  it('creates an account, projects it from the store, and deletes it', async () => {
    const runtime = runtimeOf()
    const path = '/api/dsh-soulmojito/im/accounts'
    const accountBody = {
      channel: 'onebot',
      accountId: '10001',
      label: 'primary bot',
      secret: { token: 'secret-token' },
    }
    const created = await call(accountBody, path, 'im/accounts', 'POST', runtime)
    expect(created.statusCode).toBe(200)
    expect(await ImStore.open(tavernDataRoot('im')).accounts()).toMatchObject([
      { channel: 'onebot', accountId: '10001', label: 'primary bot' },
    ])

    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(listed.body['channels']).toMatchObject([
      { channel: 'onebot', accountId: '10001', label: 'primary bot', status: { state: 'idle' }, peers: 0 },
    ])
    // 腾讯包外挂安装：投影里必须带安装状态，面板据此显示安装按钮（不是通道故障）。
    expect(listed.body['qqRuntime']).toMatchObject({ installed: false })
    const reason = String((listed.body['qqRuntime'] as { reason?: string }).reason)
    // 自动安装：面板一键触发，绝不把 shell 命令甩给用户（2026-10-31 用户要求）。
    expect(reason).toContain('IM panel')
    expect(reason).not.toContain('pnpm add')

    const removed = await call(undefined, `${path}?channel=onebot&accountId=10001`, 'im/accounts', 'DELETE', runtime)
    expect(removed.statusCode).toBe(200)
    const after = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(after.body['channels']).toEqual([])
  })

  it('projects send pacing in GET im and applies POST im/settings to the runtime', async () => {
    const applied: ImSettings[] = []
    const runtime = runtimeOf({
      sendStatuses: () => [{
        channel: 'weixin',
        accountId: 'wechat-bot',
        allowedNow: false,
        nextSendAt: 1_700_000_030_000,
        throttleUntil: 1_700_000_300_000,
        queueDepth: 2,
      }],
      applySettings: (settings) => { applied.push(settings) },
    })
    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(listed.body['sendStatuses']).toEqual([{
      channel: 'weixin',
      accountId: 'wechat-bot',
      allowedNow: false,
      nextSendAt: 1_700_000_030_000,
      throttleUntil: 1_700_000_300_000,
      queueDepth: 2,
    }])
    expect(listed.body['settings']).toMatchObject({ groupRequireMention: true })

    const path = '/api/dsh-soulmojito/im/settings'
    const saved = await call({ settings: { weixinSendIntervalMs: 2_500 } }, path, 'im/settings', 'POST', runtime)
    expect(saved.statusCode).toBe(200)
    expect(saved.body['settings']).toMatchObject({ weixinSendIntervalMs: 2_500 })
    expect((await db.getState()).imSettings?.weixinSendIntervalMs).toBe(2_500)
    // 保存后运行中的队列立刻换挡，不等下次重启。
    expect(applied).toMatchObject([{ weixinSendIntervalMs: 2_500 }])

    const cleared = await call({ settings: { weixinSendIntervalMs: null } }, path, 'im/settings', 'POST', runtime)
    expect(cleared.statusCode).toBe(200)
    expect((await db.getState()).imSettings?.weixinSendIntervalMs).toBeUndefined()

    // 越界值不静默钳制：400 且不改动已落盘的设置。
    await expect(call({ settings: { weixinSendIntervalMs: 499 } }, path, 'im/settings', 'POST', runtime))
      .rejects.toMatchObject({ status: 400 })
    expect((await db.getState()).imSettings?.weixinSendIntervalMs).toBeUndefined()
  })

  it('answers 401 for a webhook that no account accepts', async () => {
    const path = '/api/dsh-soulmojito/im/onebot/webhook'
    const result = await call({ post_type: 'message' }, path, 'im/onebot/webhook', 'POST', runtimeOf())
    expect(result.statusCode).toBe(401)
  })

  it('lists unbound senders and binds one to a native session id', async () => {
    const key = imPeerKey('onebot', '10001', 'private', 'u1')
    await db.patchState({
      imPendingPeers: {
        [key]: { lastAt: 1_700_000_000_000, senderName: '小明' },
      },
    })
    const runtime = { ...runtimeOf(), applyImPreset: async () => ({ applied: true }) }
    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(listed.body['pendingPeers']).toEqual([{
      key,
      alias: imPeerAlias('onebot', 'private', key),
      channel: 'onebot',
      accountId: '10001',
      scope: 'private',
      peerId: 'u1',
      lastAt: new Date(1_700_000_000_000).toISOString(),
      senderName: '小明',
    }])

    const bound = await call({
      channel: 'onebot',
      accountId: '10001',
      scope: 'private',
      peerId: 'u1',
      sessionId: 'session-native',
    }, '/api/dsh-soulmojito/im/peers', 'im/peers', 'POST', runtime)
    expect(bound.statusCode).toBe(200)
    expect(bound.body['presetSwitch']).toEqual({ applied: true })
    const state = await db.getState()
    expect(state.imPeers?.[key]).toMatchObject({
      sessionId: 'session-native',
      scope: 'private',
      boundBy: 'manual',
    })
    // 绑定成功后从「未绑定对端」待办里移除。
    expect(state.imPendingPeers?.[key]).toBeUndefined()
  })

  it('rejects a binding without a native session id', async () => {
    const result = await call({
      channel: 'onebot',
      accountId: '10001',
      scope: 'private',
      peerId: 'u1',
    }, '/api/dsh-soulmojito/im/peers', 'im/peers', 'POST', runtimeOf()).catch((error: unknown) => error as { status: number; message: string })
    expect(result.status).toBe(400)
    expect(result.message).toContain('sessionId')
  })

  it('serves qr binding start/status/cancel for qq and weixin, and refuses channels without a binder', async () => {
    let phase: 'idle' | 'waiting' = 'idle'
    const verifyCodes: string[] = []
    const runtime: ImRuntime = {
      ...runtimeOf(),
      startQrBind: async () => {
        phase = 'waiting'
        return { phase: 'waiting', url: 'https://example.invalid/qq-qr' }
      },
      qrBindStatus: () => (phase === 'waiting'
        ? { phase: 'waiting', url: 'https://example.invalid/qq-qr' }
        : { phase: 'idle' }),
      submitQrVerifyCode: (code: string) => {
        verifyCodes.push(code)
        phase = 'waiting'
        return { phase: 'waiting', url: 'https://example.invalid/weixin-qr' }
      },
      cancelQrBind: () => {
        phase = 'idle'
        return { phase: 'idle' }
      },
    }
    const started = await call({ channel: 'qq' }, '/api/dsh-soulmojito/im/bind/start', 'im/bind/start', 'POST', runtime)
    expect(started.statusCode).toBe(200)
    expect(started.body).toMatchObject({ ok: true, phase: 'waiting', url: 'https://example.invalid/qq-qr' })

    const weixin = await call({ channel: 'weixin' }, '/api/dsh-soulmojito/im/bind/start', 'im/bind/start', 'POST', runtime)
    expect(weixin.statusCode).toBe(200)
    expect(weixin.body).toMatchObject({ ok: true, phase: 'waiting' })

    const verified = await call({ code: ' 246810 ' }, '/api/dsh-soulmojito/im/bind/verify', 'im/bind/verify', 'POST', runtime)
    expect(verified.statusCode).toBe(200)
    expect(verified.body).toMatchObject({ ok: true, phase: 'waiting' })
    expect(verifyCodes).toEqual([' 246810 '])

    const status = await call(undefined, '/api/dsh-soulmojito/im/bind/status', 'im/bind/status', 'GET', runtime)
    expect(status.body).toMatchObject({ ok: true, phase: 'waiting' })

    const cancelled = await call(undefined, '/api/dsh-soulmojito/im/bind/cancel', 'im/bind/cancel', 'POST', runtime)
    expect(cancelled.body).toMatchObject({ ok: true, phase: 'idle' })

    // OneBot 没有二维码：路由如实 501，不假装扫码可用。
    await expect(call({ channel: 'onebot' }, '/api/dsh-soulmojito/im/bind/start', 'im/bind/start', 'POST', runtime))
      .rejects.toMatchObject({ status: 501 })
    // 没有验证码能力（旧运行时）时同样 501。
    await expect(call({ code: '1' }, '/api/dsh-soulmojito/im/bind/verify', 'im/bind/verify', 'POST', runtimeOf()))
      .rejects.toMatchObject({ status: 501 })
    // 空验证码是用户输入错误，不是服务器故障。
    await expect(call({ code: '  ' }, '/api/dsh-soulmojito/im/bind/verify', 'im/bind/verify', 'POST', runtime))
      .rejects.toMatchObject({ status: 400 })
  })

  it('maps WeChat bind phases to 409/503 instead of an opaque 500', async () => {
    const path = '/api/dsh-soulmojito/im/bind/start'
    const busy: ImRuntime = {
      ...runtimeOf(),
      startQrBind: async () => {
        throw new WeixinBindError('WEIXIN_BIND_BUSY', 'a WeChat QR binding session is already running')
      },
    }
    await expect(call({ channel: 'weixin' }, path, 'im/bind/start', 'POST', busy))
      .rejects.toMatchObject({ status: 409 })

    const shuttingDown: ImRuntime = {
      ...runtimeOf(),
      startQrBind: async () => {
        throw new WeixinBindError('WEIXIN_BIND_ABORTED', 'the runtime is already shutting down')
      },
    }
    await expect(call({ channel: 'weixin' }, path, 'im/bind/start', 'POST', shuttingDown))
      .rejects.toMatchObject({ status: 503 })
  })

  it('answers 400 when a WeChat account is created without botToken and 503 when the channel is closed', async () => {
    const path = '/api/dsh-soulmojito/im/accounts'
    // 真实运行时：微信凭据在构造期校验，缺 botToken 时账号根本不会落盘。
    const runtime = createImRuntime(
      { webServer: { register: () => () => {} } } as unknown as PluginContext,
      { db },
    )
    try {
      await expect(call({
        channel: 'weixin',
        accountId: 'wx-bot-1',
        secret: { baseUrl: 'https://example.invalid' },
      }, path, 'im/accounts', 'POST', runtime)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('botToken'),
      })
      expect(await ImStore.open(tavernDataRoot('im')).accounts()).toEqual([])
    } finally {
      await runtime.dispose()
    }

    // 通道没在跑（WEIXIN_CLOSED）是运行时事实，不是用户输入错误。
    const closed: ImRuntime = {
      ...runtimeOf(),
      upsertAccount: async () => {
        throw new WeixinChannelError('WEIXIN_CLOSED', 'weixin account \'wx-bot-1\' is not running')
      },
    }
    await expect(call({
      channel: 'weixin',
      accountId: 'wx-bot-1',
      secret: { botToken: 'synthetic-bot-token', baseUrl: 'https://example.invalid' },
    }, path, 'im/accounts', 'POST', closed)).rejects.toMatchObject({ status: 503 })
  })
})


describe('im runtime log route', () => {
  it('projects the ring with ISO timestamps and forwards the query', async () => {
    const at = 1_700_000_000_000
    const runtime: ImRuntime = {
      ...runtimeOf(),
      logs: (query) => {
        expect(query).toEqual({ limit: 2, afterSeq: 7, minLevel: 'warn' })
        return { entries: [{ seq: 8, at, level: 'warn', text: 'dropped a weixin message' }], nextSeq: 8 }
      },
    }
    const result = await call(
      undefined,
      'http://localhost/api/dsh-soulmojito/im/logs?limit=2&after=7&level=warn',
      'im/logs',
      'GET',
      runtime,
    )
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      nextSeq: 8,
      entries: [{ seq: 8, at: new Date(at).toISOString(), level: 'warn', text: 'dropped a weixin message' }],
    })
  })

  it('rejects a bad limit instead of silently clamping it', async () => {
    const runtime: ImRuntime = { ...runtimeOf(), logs: () => ({ entries: [], nextSeq: 0 }) }
    await expect(call(undefined, 'http://localhost/api/dsh-soulmojito/im/logs?limit=0', 'im/logs', 'GET', runtime))
      .rejects.toThrow(/limit/)
  })

  it('rejects an unknown level', async () => {
    const runtime: ImRuntime = { ...runtimeOf(), logs: () => ({ entries: [], nextSeq: 0 }) }
    await expect(call(undefined, 'http://localhost/api/dsh-soulmojito/im/logs?level=loud', 'im/logs', 'GET', runtime))
      .rejects.toThrow(/level/)
  })

  it('returns an empty page when the runtime exposes no log surface', async () => {
    const result = await call(undefined, 'http://localhost/api/dsh-soulmojito/im/logs', 'im/logs', 'GET', runtimeOf())
    expect(result.body).toEqual({ ok: true, nextSeq: 0, entries: [] })
  })
})

describe('im owner routes', () => {
  const ownerPath = '/api/dsh-soulmojito/im/owner'
  const privateKey = imPeerKey('onebot', '10001', 'private', 'u1')
  const groupKey = imPeerKey('onebot', '10001', 'group', 'g1')
  const unboundKey = imPeerKey('onebot', '10001', 'group', 'g2')
  const memberHash = imSenderHash('onebot', '10001', 'member-1')
  const peerSelf = imSenderHash('onebot', '10001', 'u1')

  async function seed(): Promise<void> {
    await db.patchState({
      imPeers: {
        [privateKey]: { sessionId: 'session-private', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
        [groupKey]: { sessionId: 'session-group', scope: 'group', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
      imSenders: {
        [groupKey]: [{ id: memberHash, name: '小红', lastAt: 1_700_000_000_000 }],
        [privateKey]: [{ id: peerSelf, name: '', lastAt: 1_700_000_001_000 }],
        // 未绑定 peer 的发言人：投影必须过滤掉。
        [unboundKey]: [{ id: imSenderHash('onebot', '10001', 'ghost-sender'), name: '路人', lastAt: 1 }],
      },
      imOwners: {
        [groupKey]: { id: memberHash, name: '小红', setAt: '2026-10-31T00:00:00.000Z' },
        [unboundKey]: { id: imSenderHash('onebot', '10001', 'ghost-sender'), name: '路人', setAt: '2026-10-31T00:00:00.000Z' },
      },
    })
  }

  it('projects owners and senders for bound peers with hashes only', async () => {
    await seed()
    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtimeOf())
    expect(listed.statusCode).toBe(200)
    // 未绑定 peer 的主人/发言人不进投影。
    expect(listed.body['owners']).toEqual({
      [groupKey]: { id: memberHash, name: '小红', setAt: '2026-10-31T00:00:00.000Z' },
    })
    expect(listed.body['senders']).toEqual({
      [privateKey]: [{ id: peerSelf, name: '', lastAt: new Date(1_700_000_001_000).toISOString() }],
      [groupKey]: [{ id: memberHash, name: '小红', lastAt: new Date(1_700_000_000_000).toISOString() }],
    })
    // 私聊绑定行带对端自己的哈希；群聊没有。
    const peers = listed.body['peers'] as Array<Record<string, unknown>>
    expect(peers.find((peer) => peer['key'] === privateKey)?.['peerSelfId']).toBe(peerSelf)
    expect(peers.find((peer) => peer['key'] === groupKey)?.['peerSelfId']).toBeUndefined()
    // 投影只含 `snd-` 哈希：原始 senderId 不出现。
    const projection = JSON.stringify({
      owners: listed.body['owners'],
      senders: listed.body['senders'],
      peerSelfIds: peers.map((peer) => peer['peerSelfId']),
    })
    expect(projection).not.toContain('member-1')
    expect(projection).not.toContain('ghost-sender')
    expect(projection).toMatch(/snd-[0-9a-f]{10}/)
  })

  it('skips an out-of-range sender timestamp instead of 500ing GET im', async () => {
    const fake = {
      getState: async () => ({
        imPeers: {
          [privateKey]: { sessionId: 'session-private', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
        },
        imOwners: {},
        imSenders: { [privateKey]: [{ id: peerSelf, name: '', lastAt: 1e300 }] },
        imPendingPeers: {},
      }),
      updateState: async () => { throw new Error('GET must not write state') },
    } as unknown as TavernStore
    const response = makeResponse()
    await handleImApi(
      makeRequest(undefined, 'http://localhost/api/dsh-soulmojito/im', 'GET'),
      response as unknown as HttpResponse,
      new URL('http://localhost/api/dsh-soulmojito/im'),
      'im',
      'GET',
      fake,
      runtimeOf(),
    )
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.chunks.join('')) as { senders?: Record<string, unknown> }
    expect(body.senders?.[privateKey]).toBeUndefined()
  })

  it('drops an out-of-range pending peer timestamp and still answers GET im', async () => {
    const key = imPeerKey('onebot', '10001', 'private', 'pending-x')
    await db.patchState({ imPendingPeers: { [key]: { lastAt: 1e300 } } })
    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtimeOf())
    expect(listed.statusCode).toBe(200)
    expect(listed.body['pendingPeers']).toEqual([])
    // 真实 store 再读也丢弃：不会在下次启动后复活。
    expect((await db.getState()).imPendingPeers?.[key]).toBeUndefined()
  })

  it('filters an out-of-range pending peer in the projection layer', async () => {
    const key = imPeerKey('onebot', '10001', 'private', 'pending-x')
    const fake = {
      getState: async () => ({
        imPeers: {},
        imOwners: {},
        imSenders: {},
        imPendingPeers: { [key]: { lastAt: 1e300, senderName: 'pending raw' } },
      }),
      updateState: async () => { throw new Error('GET must not write state') },
    } as unknown as TavernStore
    const response = makeResponse()
    await handleImApi(
      makeRequest(undefined, 'http://localhost/api/dsh-soulmojito/im', 'GET'),
      response as unknown as HttpResponse,
      new URL('http://localhost/api/dsh-soulmojito/im'),
      'im',
      'GET',
      fake,
      runtimeOf(),
    )
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.chunks.join('')) as { pendingPeers?: unknown[] }
    expect(body.pendingPeers).toEqual([])
  })

  it('sets and clears an owner, and rejects non-hash sender ids', async () => {
    await seed()
    const set = await call({
      channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g1', senderId: memberHash,
    }, ownerPath, 'im/owner', 'POST', runtimeOf())
    expect(set.statusCode).toBe(200)
    expect(set.body['owner']).toMatchObject({ id: memberHash, name: '小红' })
    expect((await db.getState()).imOwners?.[groupKey]?.id).toBe(memberHash)
    // 状态里只有哈希：原始 senderId 不落盘。
    expect(JSON.stringify((await db.getState()).imOwners)).not.toContain('member-1')

    const cleared = await call({
      channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g1', senderId: null,
    }, ownerPath, 'im/owner', 'POST', runtimeOf())
    expect(cleared.statusCode).toBe(200)
    expect(cleared.body['owner']).toBeNull()
    expect((await db.getState()).imOwners?.[groupKey]).toBeUndefined()
  })

  it('accepts the peer self hash for a private peer without a recent message', async () => {
    await db.patchState({
      imPeers: {
        [privateKey]: { sessionId: 'session-private', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
    })
    const set = await call({
      channel: 'onebot', accountId: '10001', scope: 'private', peerId: 'u1', senderId: peerSelf,
    }, ownerPath, 'im/owner', 'POST', runtimeOf())
    expect(set.statusCode).toBe(200)
    expect(set.body['owner']).toMatchObject({ id: peerSelf, name: '' })
    expect((await db.getState()).imOwners?.[privateKey]?.id).toBe(peerSelf)
  })

  it('rejects unbound peers, raw ids and unknown group senders without touching state', async () => {
    await seed()
    const failure = async (body: Record<string, unknown>): Promise<{ status: number; message: string }> => (
      call(body, ownerPath, 'im/owner', 'POST', runtimeOf()).catch((error: unknown) => error as { status: number; message: string })
    )

    // 未绑定 peer：404 JSON，带绑定指引（这是响应的 404，不是异常）。
    const unbound = await call({
      channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g3', senderId: memberHash,
    }, ownerPath, 'im/owner', 'POST', runtimeOf())
    expect(unbound.statusCode).toBe(404)
    expect(String(unbound.body['message'])).toContain('no IM peer binding')
    expect(String(unbound.body['message'])).not.toContain('g3')

    // 原始 id：400，明确只收 `snd-` 哈希。
    const raw = await failure({ channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g1', senderId: 'member-1' })
    expect(raw.status).toBe(400)
    expect(raw.message).toContain('snd-')
    expect(raw.message).not.toContain('member-1')

    // 群聊里不认识的哈希：400（选择器只列最近发言人）。
    const unknown = await failure({
      channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g1',
      senderId: imSenderHash('onebot', '10001', 'somebody-else'),
    })
    expect(unknown.status).toBe(400)
    expect(unknown.message).toContain('not a recent sender')

    // 缺 senderId 不等于 null：400，不能把「没传」当成清除。
    const missing = await failure({ channel: 'onebot', accountId: '10001', scope: 'group', peerId: 'g1' })
    expect(missing.status).toBe(400)

    // 所有拒绝都不改 state。
    expect((await db.getState()).imOwners?.[groupKey]?.id).toBe(memberHash)
  })
})

describe('im error surface', () => {
  it('withholds a filesystem path from a store failure', async () => {
    const runtime: ImRuntime = {
      ...runtimeOf(),
      upsertAccount: async () => {
        throw new ImStoreError('IO', 'corrupt cursor: C:\\Users\\alice\\.dsh\\soulmojito\\im\\cursors\\x.json')
      },
    }
    const failure = await call(
      { channel: 'onebot', accountId: '10001', secret: { token: 'token-1' } },
      '/api/dsh-soulmojito/im/accounts',
      'im/accounts',
      'POST',
      runtime,
    ).catch((error: unknown) => error as { status: number; message: string })
    expect(failure.status).toBe(400)
    expect(failure.message).toContain('IM store rejected')
    expect(failure.message).not.toContain('C:\\Users')
  })
})
