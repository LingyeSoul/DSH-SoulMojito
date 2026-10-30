/**
 * 微信 iLink 通道（提案 0024 M4）：扫码（验证码 / IDC 重定向）、长轮询与游标、
 * `-14` 暂停、出站载荷与认证头。全程不联网：请求打到 `node:http` 本地桩。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { PluginContext } from '../src/host-contract.js'
import { clearOneBotSeatForTest } from '../src/im/onebot/seat.js'
import { createImRuntime, type ImRuntime } from '../src/im/runtime.js'
import { ImStore } from '../src/im/store.js'
import { imDedupeKey, type ImBindStatus, type ImInbound, type ImTarget, type OutboundPart } from '../src/im/types.js'
import { createWeixinBinding, type WeixinBindCredential } from '../src/im/weixin/bind.js'
import { WeixinChannel, WEIXIN_REAL_CLOCK } from '../src/im/weixin/channel.js'
import type { WeixinClock } from '../src/im/weixin/clock.js'

const ACCOUNT_ID = 'synthetic-bot-1'
const TOKEN = 'synthetic-bot-token'
const NOW = 1_760_000_000_000
const ONE_HOUR_MS = 60 * 60 * 1_000

// ---- 本地 HTTP 桩（真实 socket，绝不联网）----

interface StubRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Record<string, unknown> | undefined
}

interface StubReply {
  status?: number
  json?: unknown
  text?: string
}

type StubHandler = (request: StubRequest) => StubReply | Promise<StubReply>

interface Stub {
  readonly baseUrl: string
  readonly port: number
  readonly requests: StubRequest[]
  setHandler(handler: StubHandler): void
  close(): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function readRequest(req: IncomingMessage): Promise<StubRequest> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let body: Record<string, unknown> | undefined
  if (text.trim() !== '') {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the synthetic request body must be a JSON object')
    }
    body = parsed as Record<string, unknown>
  }
  return { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body }
}

function defaultReply(request: StubRequest): StubReply {
  switch (request.path) {
    case '/ilink/bot/get_bot_qrcode':
      return { json: { qrcode: 'synthetic-qrcode', qrcode_img_content: 'https://example.invalid/weixin-qr' } }
    case '/ilink/bot/get_qrcode_status':
      return { json: { status: 'wait' } }
    case '/ilink/bot/getupdates':
      return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
    case '/ilink/bot/sendmessage':
      return { json: { ret: 0, message_id: 'synthetic-server-message' } }
    case '/ilink/bot/getconfig':
      return { json: { ret: 0 } }
    case '/ilink/bot/sendtyping':
      return { json: { ret: 0 } }
    default:
      return { status: 404, json: { error: `unknown path ${request.path}` } }
  }
}

/** 一条合成入站消息；只写本用例关心的字段，其余留默认。 */
function wireMessage(fixture: {
  messageId: number | string
  fromUserId: string
  itemList: unknown[]
  messageType?: number
  groupId?: string
  contextToken?: string
}): Record<string, unknown> {
  return {
    message_id: fixture.messageId,
    from_user_id: fixture.fromUserId,
    message_type: fixture.messageType ?? 1,
    ...(fixture.groupId === undefined ? {} : { group_id: fixture.groupId }),
    ...(fixture.contextToken === undefined ? {} : { context_token: fixture.contextToken }),
    item_list: fixture.itemList,
  }
}

function textItem(text: string): unknown {
  return { type: 1, text_item: { text } }
}

/**
 * 桩端口必须避开 Node fetch（undici）的 bad-port 黑名单（最高 10080）：
 * 交给系统随机分配时偶尔会落到 5060/6000 这类端口，fetch 直接报 `bad port`。
 * 50000-59999 全部可用；撞车就换一个重试。
 */
async function startStub(handler: StubHandler): Promise<Stub> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await listenStub(handler, 50_000 + Math.floor(Math.random() * 10_000))
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`the synthetic stub could not bind a usable port: ${messageOf(lastError)}`)
}

async function listenStub(handler: StubHandler, port: number): Promise<Stub> {
  const requests: StubRequest[] = []
  let current = handler
  const server = createServer((req, res) => {
    void (async () => {
      const request = await readRequest(req)
      requests.push(request)
      // 5ms 的「长轮询」延迟：桩不该被通道打成忙循环。
      await delay(5)
      const reply = await current(request)
      const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
      res.writeHead(reply.status ?? 200, {
        'content-type': reply.text === undefined ? 'application/json' : 'text/plain; charset=utf-8',
      })
      res.end(body)
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: messageOf(error) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { resolve() })
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (next) => { current = next },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    }),
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(5)
  }
}

// ---- 时钟 ----

function fixedClock(at: number): WeixinClock {
  return {
    now: () => at,
    sleep: (ms, signal) => WEIXIN_REAL_CLOCK.sleep(ms, signal),
  }
}

interface ManualClock {
  clock: WeixinClock
  /** 推进「现在」，并放行当前挂起的 sleep。 */
  advance(ms: number): void
  /** 当前挂起的 sleep 时长；测试据此确认循环真的停在了暂停上。 */
  pendingMs(): number | undefined
}

function manualClock(start: number): ManualClock {
  let now = start
  let pending: { ms: number; resolve: () => void } | undefined
  const clock: WeixinClock = {
    now: () => now,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        pending = undefined
        resolve()
      }
      const onAbort = (): void => { finish() }
      signal.addEventListener('abort', onAbort, { once: true })
      pending = { ms, resolve: finish }
    }),
  }
  return {
    clock,
    advance(ms) {
      now += ms
      pending?.resolve()
    },
    pendingMs: () => pending?.ms,
  }
}

// ---- 通道 harness ----

interface HarnessOptions {
  baseUrl: string
  clock: WeixinClock
  typingEnabled?: boolean
  cursor?: string
  contextTokens?: Record<string, string>
  /** 可选事件序：`deliver:<n>` 与 `cursor:<value>` 按真实发生顺序落进来（F3）。 */
  events?: string[]
}

interface Harness {
  channel: WeixinChannel
  readonly delivered: ImInbound[]
  readonly cursorSaves: string[]
  readonly tokenSaves: Array<Record<string, string>>
  readonly signal: AbortSignal
  stop(): Promise<void>
}

function channelHarness(options: HarnessOptions): Harness {
  const delivered: ImInbound[] = []
  const cursorSaves: string[] = []
  const tokenSaves: Array<Record<string, string>> = []
  const controller = new AbortController()
  const events = options.events
  const channel = new WeixinChannel({
    accountId: ACCOUNT_ID,
    token: TOKEN,
    baseUrl: options.baseUrl,
    router: {
      handle: async (inbound) => {
        delivered.push(inbound)
        events?.push(`deliver:${delivered.length}`)
      },
    },
    loadCursor: async () => options.cursor,
    saveCursor: async (cursor) => {
      cursorSaves.push(cursor)
      events?.push(`cursor:${cursor}`)
    },
    loadContextTokens: async () => options.contextTokens ?? {},
    saveContextTokens: async (tokens) => { tokenSaves.push({ ...tokens }) },
    clock: options.clock,
    longPollTimeoutMs: 50,
    typingEnabled: options.typingEnabled ?? false,
  })
  return {
    channel,
    delivered,
    cursorSaves,
    tokenSaves,
    signal: controller.signal,
    stop: async () => {
      controller.abort()
      await channel.stop()
    },
  }
}

function textPart(text: string, index: number, total: number): OutboundPart {
  return { kind: 'text', text, index, total }
}

function privateTarget(): ImTarget {
  return { channel: 'weixin', accountId: ACCOUNT_ID, scope: 'private', peerId: 'wx-user-1' }
}

function getUpdatesRequests(stub: Stub): StubRequest[] {
  return stub.requests.filter((request) => request.path === '/ilink/bot/getupdates')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- 扫码绑定（绑定器直连本地桩）----

describe('weixin qr binding', () => {
  it('walks wait → scaned → redirect → need_verifycode → confirmed and reports the verified credential', async () => {
    const redirectStub = await startStub(defaultReply)
    const primary = await startStub(defaultReply)
    let statusCalls = 0
    primary.setHandler((request) => {
      if (request.path === '/ilink/bot/get_bot_qrcode') {
        return { json: { qrcode: 'synthetic-qrcode-1', qrcode_img_content: 'https://example.invalid/weixin-qr' } }
      }
      if (request.path === '/ilink/bot/get_qrcode_status') {
        statusCalls += 1
        if (statusCalls === 1) return { json: { status: 'wait' } }
        if (statusCalls === 2) return { json: { status: 'scaned' } }
        return { json: { status: 'scaned_but_redirect', redirect_host: `127.0.0.1:${redirectStub.port}` } }
      }
      return { status: 404, json: { error: `unexpected path ${request.path}` } }
    })
    redirectStub.setHandler((request) => {
      if (request.path !== '/ilink/bot/get_qrcode_status') {
        return { status: 404, json: { error: `unexpected path ${request.path}` } }
      }
      if (request.query.get('qrcode') !== 'synthetic-qrcode-1') {
        return { status: 400, json: { error: 'wrong qrcode' } }
      }
      if (request.query.get('verify_code') === '246810') {
        return {
          json: {
            status: 'confirmed',
            bot_token: TOKEN,
            ilink_bot_id: ACCOUNT_ID,
            baseurl: redirectStub.baseUrl,
            ilink_user_id: 'synthetic-user-1',
          },
        }
      }
      return { json: { status: 'need_verifycode' } }
    })
    const binding = createWeixinBinding({
      qrBaseUrl: primary.baseUrl,
      botType: '3',
      pollIntervalMs: 5,
      clock: WEIXIN_REAL_CLOCK,
      localTokenList: async () => [],
    })
    const controller = new AbortController()
    let credential: WeixinBindCredential | undefined
    try {
      const started = await binding.start({
        onSuccess: (next) => { credential = next },
      }, { signal: controller.signal })
      expect(started).toEqual({ phase: 'waiting', url: 'https://example.invalid/weixin-qr' })
      // 服务端还没要验证码：此刻提交必须被拒绝，不能把任意输入写进会话。
      expect(() => binding.submitVerifyCode('1')).toThrowError(/not 'verify'|not verify/)
      const qrRequest = primary.requests.find((request) => request.path === '/ilink/bot/get_bot_qrcode')
      expect(qrRequest?.body).toEqual({ local_token_list: [] })

      await waitFor(() => binding.status().phase === 'verify', 'the verify phase', 5_000)
      expect(binding.status()).toMatchObject({ phase: 'verify', prompt: expect.stringContaining('数字') })

      expect(binding.submitVerifyCode(' 246810 ')).toMatchObject({ phase: 'waiting' })
      await waitFor(() => credential !== undefined, 'the confirmed credential', 5_000)
      expect(credential).toEqual({
        botToken: TOKEN,
        baseUrl: redirectStub.baseUrl,
        ilinkBotId: ACCOUNT_ID,
        ilinkUserId: 'synthetic-user-1',
      })
      await waitFor(() => binding.status().phase === 'idle', 'the idle phase', 5_000)

      // IDC 重定向确实发生了：主入口只被问三次（wait/scaned/重定向），之后全部
      // 落在 redirect host，且验证码只发给 redirect host。
      const primaryPolls = primary.requests.filter((request) => request.path === '/ilink/bot/get_qrcode_status')
      expect(primaryPolls).toHaveLength(3)
      expect(redirectStub.requests.some((request) => request.query.get('verify_code') === '246810')).toBe(true)
    } finally {
      binding.dispose()
      await primary.close()
      await redirectStub.close()
    }
  })

  it('refreshes an expired QR once and fails after the second expiry', async () => {
    const stub = await startStub(defaultReply)
    let qrFetches = 0
    stub.setHandler((request) => {
      if (request.path === '/ilink/bot/get_bot_qrcode') {
        qrFetches += 1
        return {
          json: {
            qrcode: `synthetic-qrcode-${qrFetches}`,
            qrcode_img_content: `https://example.invalid/weixin-qr-${qrFetches}`,
          },
        }
      }
      if (request.path === '/ilink/bot/get_qrcode_status') return { json: { status: 'expired' } }
      return { status: 404, json: { error: `unexpected path ${request.path}` } }
    })
    const binding = createWeixinBinding({
      qrBaseUrl: stub.baseUrl,
      botType: '3',
      pollIntervalMs: 5,
      clock: WEIXIN_REAL_CLOCK,
      localTokenList: async () => [],
    })
    const controller = new AbortController()
    let failures = 0
    try {
      await binding.start({
        onSuccess: () => {},
        onFailure: () => { failures += 1 },
      }, { signal: controller.signal })
      await waitFor(() => binding.status().phase === 'failed', 'the failed phase', 5_000)
      expect(binding.status().reason).toContain('expired again after one refresh')
      // 初始一张 + expired 后刷新一张，之后不再拉码。
      expect(qrFetches).toBe(2)
      expect(failures).toBe(1)
    } finally {
      binding.dispose()
      await stub.close()
    }
  })

  it('treats binded_redirect as success without asking for new credentials', async () => {
    const stub = await startStub(defaultReply)
    stub.setHandler((request) => {
      if (request.path === '/ilink/bot/get_bot_qrcode') {
        return { json: { qrcode: 'synthetic-qrcode-bound', qrcode_img_content: 'https://example.invalid/weixin-qr' } }
      }
      if (request.path === '/ilink/bot/get_qrcode_status') return { json: { status: 'binded_redirect' } }
      return { status: 404, json: { error: `unexpected path ${request.path}` } }
    })
    const binding = createWeixinBinding({
      qrBaseUrl: stub.baseUrl,
      botType: '3',
      pollIntervalMs: 5,
      clock: WEIXIN_REAL_CLOCK,
      localTokenList: async () => [],
    })
    const controller = new AbortController()
    let alreadyBound = 0
    let credential: WeixinBindCredential | undefined
    try {
      await binding.start({
        onSuccess: (next) => { credential = next },
        onAlreadyBound: () => { alreadyBound += 1 },
      }, { signal: controller.signal })
      await waitFor(() => binding.status().phase === 'idle', 'the idle phase', 5_000)
      expect(alreadyBound).toBe(1)
      expect(credential).toBeUndefined()
      expect(binding.status()).toEqual({ phase: 'idle' })
    } finally {
      binding.dispose()
      await stub.close()
    }
  })
})

// ---- 运行时：扫码落库与通道上线 ----

let root: string
let db: TavernStore

beforeEach(async () => {
  clearOneBotSeatForTest()
  root = await mkdtemp(join(tmpdir(), 'weixin-channel-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  clearOneBotSeatForTest()
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function fakeContext(): PluginContext {
  return { webServer: { register: () => () => {} } } as unknown as PluginContext
}

function imStore(): ImStore {
  return ImStore.open(tavernDataRoot('im'))
}

function startBind(runtime: ImRuntime): Promise<ImBindStatus> {
  if (runtime.startQrBind === undefined) throw new Error('the IM runtime exposes no QR binding')
  return runtime.startQrBind('weixin')
}

function bindStatus(runtime: ImRuntime): ImBindStatus {
  if (runtime.qrBindStatus === undefined) throw new Error('the IM runtime exposes no QR binding status')
  return runtime.qrBindStatus()
}

describe('weixin runtime accounts', () => {
  it('stores the scanned credential with its baseUrl and opens the channel', async () => {
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/get_bot_qrcode') {
        return { json: { qrcode: 'synthetic-qrcode-runtime', qrcode_img_content: 'https://example.invalid/weixin-qr' } }
      }
      if (request.path === '/ilink/bot/get_qrcode_status') {
        return { json: { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: ACCOUNT_ID, baseurl: stub.baseUrl, ilink_user_id: 'synthetic-user-1' } }
      }
      return defaultReply(request)
    })
    const runtime = createImRuntime(fakeContext(), { db, weixinQrBaseUrl: stub.baseUrl })
    try {
      expect(await startBind(runtime)).toMatchObject({ phase: 'waiting' })
      await waitFor(() => bindStatus(runtime).phase === 'idle', 'the idle bind phase', 10_000)

      expect(await imStore().accounts()).toMatchObject([
        { channel: 'weixin', accountId: ACCOUNT_ID, label: '微信机器人' },
      ])
      expect(await imStore().readSecret('weixin', ACCOUNT_ID)).toEqual({
        botToken: TOKEN,
        baseUrl: stub.baseUrl,
        ilinkBotId: ACCOUNT_ID,
        ilinkUserId: 'synthetic-user-1',
      })
      const state = await db.getState()
      expect(state.imSettings?.privateAllow).toEqual(['synthetic-user-1'])

      await waitFor(
        () => runtime.views().some((view) => view.channel === 'weixin' && view.status.state === 'online'),
        'the weixin channel online',
        10_000,
      )
      expect(runtime.views()).toMatchObject([{ channel: 'weixin', accountId: ACCOUNT_ID }])
    } finally {
      await runtime.dispose()
      await stub.close()
    }
  })

})

describe('weixin inbound', () => {
  it('maps private text and media, ignores group messages, and keeps a stable dedupe key', async () => {
    const stub = await startStub(defaultReply)
    let served = false
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      served = true
      return {
        json: {
          ret: 0,
          get_updates_buf: 'cursor-inbound',
          msgs: [
            wireMessage({
              messageId: 4101,
              fromUserId: 'wx-user-1',
              contextToken: 'ctx-4101',
              itemList: [
                textItem('第一段'),
                textItem('第二段'),
                { type: 2, image_item: { media: { full_url: 'https://example.invalid/p.png' } } },
              ],
            }),
            wireMessage({
              messageId: 4102,
              fromUserId: 'wx-user-2',
              groupId: 'wx-group-9',
              itemList: [textItem('群里的问候')],
            }),
            wireMessage({
              messageId: 4103,
              fromUserId: 'wx-user-1',
              messageType: 2,
              itemList: [textItem('机器人自己的回显')],
            }),
          ],
        },
      }
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.delivered.length > 0, 'the first inbound', 5_000)
      expect(harness.delivered).toEqual([
        {
          channel: 'weixin',
          accountId: ACCOUNT_ID,
          scope: 'private',
          peerId: 'wx-user-1',
          senderId: 'wx-user-1',
          senderName: 'wx-user-',
          text: '第一段\n第二段',
          media: [{ kind: 'image', url: 'https://example.invalid/p.png' }],
          dedupeKey: imDedupeKey('weixin', ACCOUNT_ID, 'private', 'wx-user-1', '4101'),
          receivedAt: NOW,
        },
      ])
      // 群消息与机器人回显都没有、也不会被补投。
      await delay(30)
      expect(harness.delivered).toHaveLength(1)
      expect(harness.tokenSaves.at(-1)).toEqual({ 'wx-user-1': 'ctx-4101' })
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('uses the voice transcript as text and records a transcript-less voice as media', async () => {
    const stub = await startStub(defaultReply)
    let served = false
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      served = true
      return {
        json: {
          ret: 0,
          get_updates_buf: 'cursor-voice',
          msgs: [
            wireMessage({
              messageId: 'voice-1',
              fromUserId: 'wx-user-1',
              itemList: [{ type: 3, voice_item: { text: '语音转出来的文字' } }],
            }),
            wireMessage({
              messageId: 'voice-2',
              fromUserId: 'wx-user-1',
              itemList: [{ type: 3, voice_item: { media: { full_url: 'https://example.invalid/v.silk' } } }],
            }),
          ],
        },
      }
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.delivered.length === 2, 'both voice inbounds', 5_000)
      expect(harness.delivered[0]).toMatchObject({ text: '语音转出来的文字', media: [] })
      expect(harness.delivered[1]).toMatchObject({
        text: '',
        media: [{ kind: 'voice', url: 'https://example.invalid/v.silk' }],
      })
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('delivers a message that omits the optional message_type field', async () => {
    const stub = await startStub(defaultReply)
    let served = false
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      served = true
      return {
        json: {
          ret: 0,
          get_updates_buf: 'cursor-no-type',
          // 协议里 message_type 是可选的：缺字段不是「非用户消息」。
          msgs: [{ message_id: 4105, from_user_id: 'wx-user-1', item_list: [textItem('没有 message_type')] }],
        },
      }
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.delivered.length === 1, 'the inbound without message_type', 5_000)
      expect(harness.delivered[0]).toMatchObject({
        peerId: 'wx-user-1',
        text: '没有 message_type',
        dedupeKey: imDedupeKey('weixin', ACCOUNT_ID, 'private', 'wx-user-1', '4105'),
      })
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 游标 ----

describe('weixin getupdates cursor', () => {
  it('sends the previous get_updates_buf on the next long poll and persists each non-empty cursor', async () => {
    const stub = await startStub(defaultReply)
    let round = 0
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      round += 1
      if (round === 1) {
        return {
          json: {
            ret: 0,
            get_updates_buf: 'cursor-1',
            msgs: [{
              message_id: 21,
              from_user_id: 'wx-user-1',
              message_type: 1,
              item_list: [{ type: 1, text_item: { text: '一' } }],
            }],
          },
        }
      }
      return { json: { ret: 0, get_updates_buf: 'cursor-2', msgs: [] } }
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW), cursor: 'cursor-prev' })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => getUpdatesRequests(stub).length >= 3, 'the third long poll', 5_000)
      const polls = getUpdatesRequests(stub)
      expect(polls[0]?.body).toMatchObject({ get_updates_buf: 'cursor-prev' })
      expect(polls[1]?.body).toMatchObject({ get_updates_buf: 'cursor-1' })
      expect(polls[2]?.body).toMatchObject({ get_updates_buf: 'cursor-2' })
      expect(harness.cursorSaves).toEqual(['cursor-1', 'cursor-2'])
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('delivers every message of a page before persisting that page cursor', async () => {
    const stub = await startStub(defaultReply)
    let served = false
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      served = true
      return {
        json: {
          ret: 0,
          get_updates_buf: 'cursor-page-1',
          msgs: [
            wireMessage({ messageId: 31, fromUserId: 'wx-user-1', itemList: [textItem('一页里的第一条')] }),
            wireMessage({ messageId: 32, fromUserId: 'wx-user-1', itemList: [textItem('一页里的第二条')] }),
          ],
        },
      }
    })
    const events: string[] = []
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW), events })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.cursorSaves.length === 1, 'the page cursor', 5_000)
      // 游标一旦先落盘，进程在投递中途崩溃就再也拿不回这一页；顺序必须被锁死。
      await delay(30)
      expect(events).toEqual(['deliver:1', 'deliver:2', 'cursor:cursor-page-1'])
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- token 失效 ----

describe('weixin stale token', () => {
  it('pauses for one hour on ret -14 without sending any request during the pause', async () => {
    const stub = await startStub(defaultReply)
    let round = 0
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      round += 1
      if (round === 1) return { json: { ret: -14, errmsg: 'session stale' } }
      return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
    })
    const manual = manualClock(NOW)
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: manual.clock })
    try {
      await harness.channel.start(harness.signal)
      expect(harness.channel.status()).toEqual({
        state: 'paused',
        reason: expect.stringContaining('-14'),
        until: NOW + ONE_HOUR_MS,
      })
      const before = getUpdatesRequests(stub).length
      expect(before).toBe(1)

      await waitFor(() => manual.pendingMs() === ONE_HOUR_MS, 'the one-hour pause sleep', 5_000)
      manual.advance(ONE_HOUR_MS - 1)
      await delay(20)
      expect(harness.channel.status()).toMatchObject({ state: 'paused' })
      expect(getUpdatesRequests(stub)).toHaveLength(before)

      await waitFor(() => manual.pendingMs() === 1, 'the remaining one millisecond', 5_000)
      manual.advance(2)
      await waitFor(() => harness.channel.status().state === 'online', 'online after the pause', 5_000)
      expect(getUpdatesRequests(stub).length).toBeGreaterThan(before)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('refuses outbound sends while paused and skips typing without throwing', async () => {
    const stub = await startStub(defaultReply)
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      return { json: { ret: -14, errmsg: 'session stale' } }
    })
    const manual = manualClock(NOW)
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: manual.clock, typingEnabled: true })
    try {
      await harness.channel.start(harness.signal)
      expect(harness.channel.status()).toMatchObject({ state: 'paused' })

      await expect(harness.channel.send(privateTarget(), [textPart('暂停期间不该发出去', 0, 1)]))
        .rejects.toMatchObject({
          code: 'WEIXIN_PAUSED',
          message: expect.stringContaining(new Date(NOW + ONE_HOUR_MS).toISOString()),
        })
      // typing 不是关键路径：暂停期间静默跳过，不抛错也不发 getconfig。
      await harness.channel.setTyping('wx-user-1', 1)

      expect(stub.requests.filter((request) => request.path === '/ilink/bot/sendmessage')).toHaveLength(0)
      expect(stub.requests.filter((request) => request.path === '/ilink/bot/getconfig')).toHaveLength(0)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 出站 ----

describe('weixin outbound', () => {
  it('sends one request per part with message_type 2, the latest context_token and a unique client_id', async () => {
    const stub = await startStub(defaultReply)
    let served = false
    stub.setHandler((request) => {
      if (request.path !== '/ilink/bot/getupdates') return defaultReply(request)
      if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      served = true
      return {
        json: {
          ret: 0,
          get_updates_buf: 'cursor-out',
          msgs: [{
            message_id: 51,
            from_user_id: 'wx-user-1',
            message_type: 1,
            context_token: 'ctx-51',
            item_list: [{ type: 1, text_item: { text: '在吗' } }],
          }],
        },
      }
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW), contextTokens: { 'wx-user-1': 'ctx-old' } })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.delivered.length === 1, 'the inbound that provides the context token', 5_000)

      const receipt = await harness.channel.send(privateTarget(), [textPart('第一段', 0, 2), textPart('第二段', 1, 2)])
      expect(receipt).toEqual({ parts: 2, at: NOW, messageId: 'synthetic-server-message' })

      const sends = stub.requests.filter((request) => request.path === '/ilink/bot/sendmessage')
      expect(sends).toHaveLength(2)
      expect(sends[0]?.body).toMatchObject({
        msg: {
          from_user_id: '',
          to_user_id: 'wx-user-1',
          message_type: 2,
          message_state: 2,
          context_token: 'ctx-51',
          item_list: [{ type: 1, text_item: { text: '第一段' } }],
        },
        base_info: { bot_agent: 'DSH-SoulMojito' },
      })
      const firstMsg = sends[0]?.body?.['msg'] as Record<string, unknown>
      const secondMsg = sends[1]?.body?.['msg'] as Record<string, unknown>
      expect(typeof firstMsg['client_id']).toBe('string')
      expect(firstMsg['client_id']).not.toBe(secondMsg['client_id'])
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('surfaces a failed part instead of pretending the reply went out', async () => {
    const stub = await startStub(defaultReply)
    stub.setHandler((request) => {
      if (request.path === '/ilink/bot/getupdates') {
        return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      }
      return defaultReply(request)
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      stub.setHandler((request) => {
        if (request.path === '/ilink/bot/sendmessage') return { status: 500, text: 'synthetic upstream failure' }
        return defaultReply(request)
      })
      await expect(harness.channel.send(privateTarget(), [textPart('发不出去', 0, 1)]))
        .rejects.toMatchObject({ code: 'WEIXIN_SEND_FAILED', message: expect.stringContaining('part 1/1') })

      stub.setHandler((request) => {
        if (request.path === '/ilink/bot/sendmessage') return { json: { ret: -1, errmsg: 'synthetic business failure' } }
        return defaultReply(request)
      })
      await expect(harness.channel.send(privateTarget(), [textPart('业务失败', 0, 1)]))
        .rejects.toMatchObject({ code: 'WEIXIN_SEND_FAILED', message: expect.stringContaining('ret/errcode -1') })
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 认证头 ----

describe('weixin request headers', () => {
  it('sends AuthorizationType, Authorization, iLink-App-Id and a base64 uint32 X-WECHAT-UIN', async () => {
    const stub = await startStub(defaultReply)
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => getUpdatesRequests(stub).length > 0, 'the first long poll', 5_000)
      const headers = getUpdatesRequests(stub)[0]?.headers
      expect(headers?.['authorizationtype']).toBe('ilink_bot_token')
      expect(headers?.['authorization']).toBe(`Bearer ${TOKEN}`)
      expect(headers?.['ilink-app-id']).toBe('bot')
      expect(headers?.['content-type']).toBe('application/json')
      expect(String(headers?.['ilink-app-clientversion'])).toMatch(/^\d+$/)
      const uin = String(headers?.['x-wechat-uin'])
      const decoded = Buffer.from(uin, 'base64').toString('utf8')
      expect(decoded).toMatch(/^\d+$/)
      expect(Number(decoded)).toBeLessThanOrEqual(0xff_ff_ff_ff)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 输入状态 ----

describe('weixin typing', () => {
  it('keeps the reply working when the typing indicator fails', async () => {
    const stub = await startStub(defaultReply)
    stub.setHandler((request) => {
      if (request.path === '/ilink/bot/getconfig') return { status: 500, text: 'synthetic typing failure' }
      if (request.path === '/ilink/bot/getupdates') {
        return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
      }
      return defaultReply(request)
    })
    const harness = channelHarness({ baseUrl: stub.baseUrl, clock: fixedClock(NOW), typingEnabled: true })
    try {
      await harness.channel.start(harness.signal)
      const receipt = await harness.channel.send(privateTarget(), [textPart('照常回复', 0, 1)])
      expect(receipt.parts).toBe(1)
      expect(stub.requests.some((request) => request.path === '/ilink/bot/sendmessage')).toBe(true)
      // 等打字状态那次失败请求收尾，避免拆桩时留下半条连接。
      await delay(30)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})
