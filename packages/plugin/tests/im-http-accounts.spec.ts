import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { PluginContext } from '../src/host-contract.js'
import { handleImApi } from '../src/http/im.js'
import type { HttpRequest, HttpResponse } from '../src/http/io.js'
import { createImRuntime } from '../src/im/runtime.js'
import { ImStore } from '../src/im/store.js'
import type { ImRuntime } from '../src/im/runtime.js'
import { WeixinBindError } from '../src/im/weixin/bind.js'
import { WeixinChannelError } from '../src/im/weixin/channel.js'
import type { ImAccountRef } from '../src/im/types.js'

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

function runtimeOf(): ImRuntime {
  return {
    capabilities: { available: true, reasons: [] },
    views: () => [],
    upsertAccount: async (account: ImAccountRef, secret: Record<string, string>) => {
      await ImStore.open(tavernDataRoot('im')).putAccount(account, { token: secret.token ?? '' })
    },
    removeAccount: async (channel, accountId) => ImStore.open(tavernDataRoot('im')).deleteAccount(channel, accountId),
    handleOneBotWebhook: async () => false,
    bindChat: async () => { throw new Error('bindChat is not part of this test') },
    handleSessionEvent: () => {},
    dispose: async () => {},
    router: { sendText: async () => { throw new Error('sendText is not part of this test') } },
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
    // 腾讯包外挂安装：投影里必须带安装状态，面板据此显示指引（不是通道故障）。
    expect(listed.body['qqRuntime']).toMatchObject({ installed: false })
    expect(String((listed.body['qqRuntime'] as { reason?: string }).reason)).toContain(
      'pnpm add @tencent-connect/qqbot-nodejs@1.0.5',
    )

    const removed = await call(undefined, `${path}?channel=onebot&accountId=10001`, 'im/accounts', 'DELETE', runtime)
    expect(removed.statusCode).toBe(200)
    const after = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(after.body['channels']).toEqual([])
  })

  it('answers 401 for a webhook that no account accepts', async () => {
    const path = '/api/dsh-soulmojito/im/onebot/webhook'
    const result = await call({ post_type: 'message' }, path, 'im/onebot/webhook', 'POST', runtimeOf())
    expect(result.statusCode).toBe(401)
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
