/**
 * QQ 通道（提案 0024 M3）：入站归一、群 @ 门控、出站分片与上限、markdown 能力、
 * 连接相位、账号落库与回滚、扫码绑定状态机、运行期 SDK 加载。
 *
 * 全程不连真实 QQ、也不要求本机安装腾讯包：`QQBot` 构造与扫码连接器都从工厂
 * 注入，假件只做三件事——发事件、记下 `sendText`/`sendMarkdown` 的调用、按需失败。
 * 真实 SDK 的形状由 `im/qq/sdk.ts` 的结构类型与加载期校验锁住，测试不复刻。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import type { PluginContext } from '../src/host-contract.js'
import { clearOneBotSeatForTest } from '../src/im/onebot/seat.js'
import type { QQBindCredential, QQConnector, QQConnectorCallbacks, QQConnectorOptions } from '../src/im/qq/bind.js'
import { QQChannel } from '../src/im/qq/channel.js'
import { loadQqConnector, loadQqSdk, qqRuntimeRoot, qqRuntimeStatus } from '../src/im/qq/sdk.js'
import type { QqBotLike, QqInboundMessage, QqMessageResponse, QqReplyTarget } from '../src/im/qq/sdk.js'
import type { ImRuntime } from '../src/im/runtime.js'
import { createImRuntime } from '../src/im/runtime.js'
import { ImStore } from '../src/im/store.js'
import { imDedupeKey, type ImAccountRef, type ImBindStatus, type ImInbound, type ImTarget, type OutboundPart } from '../src/im/types.js'

const NOW = 1_760_000_000_000
const ACCOUNT_ID = '10000001'
const SYNTHETIC_SECRET = 'synthetic-app-secret'

type SendMethod = 'sendText' | 'sendMarkdown'

interface SentRecord {
  method: SendMethod
  target: QqReplyTarget
  content: string
}

interface FakeBotOptions {
  /** 正文等于该串时发送抛错，用来验证单条失败上抛。 */
  failOnContent?: string
  /** `start()` 直接 reject，用来验证启动失败必须抛。 */
  startError?: Error
  /** 每次发送前的延迟：没有出站串行时并发轮次会交错。 */
  sendDelayMs?: number
}

interface FakeBot {
  readonly sent: SentRecord[]
  on(event: string, handler: (...args: unknown[]) => unknown): FakeBot
  start(): Promise<void>
  stop(): void
  sendText(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
  sendMarkdown(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
  emit(event: string, ...args: unknown[]): Promise<void>
}

function settleDelay(ms: number | undefined): Promise<void> {
  if (ms === undefined) return Promise.resolve()
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function fakeBot(options: FakeBotOptions): FakeBot {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const sent: SentRecord[] = []
  const bot: FakeBot = {
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return bot
    },
    async start() {
      if (options.startError !== undefined) throw options.startError
      await bot.emit('ready', { session_id: 'fake-session' })
    },
    stop() {},
    async sendText(target, content) {
      return send('sendText', target, content)
    },
    async sendMarkdown(target, content) {
      return send('sendMarkdown', target, content)
    },
    async emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) await handler(...args)
    },
  }
  async function send(method: SendMethod, target: QqReplyTarget, content: string): Promise<QqMessageResponse> {
    await settleDelay(options.sendDelayMs)
    if (options.failOnContent !== undefined && content === options.failOnContent) {
      throw new Error('synthetic send failure')
    }
    sent.push({ method, target, content })
    return { id: `out-${sent.length}` }
  }
  return bot
}

function c2cMessage(overrides: Partial<QqInboundMessage>): QqInboundMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'openid-owner-1',
    content: '你好',
    messageId: 'c2c-msg-1',
    timestamp: String(NOW),
    replyTarget: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'c2c-msg-1' },
    ...overrides,
  }
}

function groupMessage(overrides: Partial<QqInboundMessage>): QqInboundMessage {
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'member-openid-1',
    senderName: '小明',
    content: '群里的问候',
    messageId: 'group-msg-1',
    timestamp: String(NOW),
    groupOpenid: 'group-openid-9',
    replyTarget: { scope: 'group', targetId: 'group-openid-9', msgId: 'group-msg-1' },
    ...overrides,
  }
}

function textPart(text: string, index: number, total: number): OutboundPart {
  return { kind: 'text', text, index, total }
}

function privateTarget(replyTo: string | undefined): ImTarget {
  return {
    channel: 'qq',
    accountId: ACCOUNT_ID,
    scope: 'private',
    peerId: 'openid-owner-1',
    ...(replyTo === undefined ? {} : { replyTo }),
  }
}

interface ChannelHarness {
  channel: QQChannel
  bot: FakeBot
  delivered: ImInbound[]
  signal: AbortSignal
}

interface HarnessOptions {
  bot: FakeBotOptions
  requireMention: boolean
  markdownSupport: boolean
}

function channelHarness(options: HarnessOptions): ChannelHarness {
  const bot = fakeBot(options.bot)
  const delivered: ImInbound[] = []
  const controller = new AbortController()
  const channel = new QQChannel({
    accountId: ACCOUNT_ID,
    secret: { appId: ACCOUNT_ID, appSecret: SYNTHETIC_SECRET },
    router: { handle: async (inbound) => { delivered.push(inbound) } },
    groupRequireMention: async () => options.requireMention,
    createBot: () => bot as unknown as QqBotLike,
    markdownSupport: options.markdownSupport,
    now: () => NOW,
  })
  return { channel, bot, delivered, signal: controller.signal }
}

describe('qq channel inbound', () => {
  it('maps c2c and group messages onto ImInbound with stable dedupe keys', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      await harness.bot.emit('message', {}, c2cMessage({}))
      await harness.bot.emit('message', {}, groupMessage({}))

      expect(harness.delivered[0]).toEqual({
        channel: 'qq',
        accountId: ACCOUNT_ID,
        scope: 'private',
        peerId: 'openid-owner-1',
        senderId: 'openid-owner-1',
        senderName: 'openid-o',
        text: '你好',
        media: [],
        replyTo: 'c2c-msg-1',
        dedupeKey: imDedupeKey('qq', ACCOUNT_ID, 'private', 'openid-owner-1', 'c2c-msg-1'),
        receivedAt: NOW,
      })
      expect(harness.delivered[1]).toMatchObject({
        scope: 'group',
        peerId: 'group-openid-9',
        senderId: 'member-openid-1',
        senderName: '小明',
        text: '群里的问候',
        dedupeKey: imDedupeKey('qq', ACCOUNT_ID, 'group', 'group-openid-9', 'group-msg-1'),
      })
    } finally {
      await harness.channel.stop()
    }
  })

  it('falls back to a random dedupe id when the payload carries no message id', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const truncated = c2cMessage({
        senderId: '',
        senderName: undefined,
        messageId: '',
        replyTarget: { scope: 'c2c', targetId: 'openid-owner-2' },
      })
      await harness.bot.emit('message', {}, truncated)
      // 同一毫秒的第二条残缺消息：用时间戳做键会撞上第一条被当重放丢掉。
      await harness.bot.emit('message', {}, truncated)
      const [first, second] = harness.delivered
      expect(first).toMatchObject({
        peerId: 'openid-owner-2',
        senderId: 'openid-owner-2',
        senderName: 'openid-o',
      })
      expect(first?.replyTo).toBeUndefined()
      expect(first?.dedupeKey).toMatch(/^qq:10000001:private:openid-owner-2:[0-9a-f-]{36}$/)
      expect(second?.dedupeKey).not.toBe(first?.dedupeKey)
    } finally {
      await harness.channel.stop()
    }
  })
})

describe('qq group mention gate', () => {
  it('drops unmentioned group messages while the setting is on and passes everything once it is off', async () => {
    let requireMention = true
    const bot = fakeBot({})
    const delivered: ImInbound[] = []
    const controller = new AbortController()
    const channel = new QQChannel({
      accountId: ACCOUNT_ID,
      secret: { appId: ACCOUNT_ID, appSecret: SYNTHETIC_SECRET },
      router: { handle: async (inbound) => { delivered.push(inbound) } },
      groupRequireMention: async () => requireMention,
      createBot: () => bot as unknown as QqBotLike,
      markdownSupport: false,
      now: () => NOW,
    })
    await channel.start(controller.signal)
    try {
      await bot.emit('message', {}, groupMessage({ rawEventType: 'GROUP_MESSAGE_CREATE' }))
      expect(delivered).toHaveLength(0)

      await bot.emit('message', {}, groupMessage({ messageId: 'group-msg-2' }))
      expect(delivered).toHaveLength(1)

      await bot.emit('message', {}, groupMessage({
        rawEventType: 'GROUP_MESSAGE_CREATE',
        messageId: 'group-msg-3',
        mentions: [{ is_you: true }],
      }))
      expect(delivered).toHaveLength(2)

      // 私聊不参与 @ 门控：设置开着也照常投递。
      await bot.emit('message', {}, c2cMessage({}))
      expect(delivered).toHaveLength(3)

      requireMention = false
      await bot.emit('message', {}, groupMessage({ rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'group-msg-4' }))
      expect(delivered).toHaveLength(4)
    } finally {
      await channel.stop()
    }
  })
})

describe('qq channel outbound', () => {
  it('sends every part in order, anchors replyTo as msgId, and surfaces a single failed part', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const receipt = await harness.channel.send(privateTarget('in-1'), [
        textPart('第一段', 0, 2),
        textPart('第二段', 1, 2),
      ])
      expect(harness.bot.sent).toEqual([
        { method: 'sendText', target: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'in-1' }, content: '第一段' },
        { method: 'sendText', target: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'in-1' }, content: '第二段' },
      ])
      expect(receipt).toEqual({ parts: 2, at: NOW, messageId: 'out-2' })

      // 无 replyTo = 主动推送：replyTarget 里不能出现残留的 msgId。
      await harness.channel.send(privateTarget(undefined), [textPart('主动推送', 0, 1)])
      expect(harness.bot.sent[2]?.target).toEqual({ scope: 'c2c', targetId: 'openid-owner-1' })

      // 群聊同样可发，落点是 group scope + 群 openid。
      await harness.channel.send({
        channel: 'qq',
        accountId: ACCOUNT_ID,
        scope: 'group',
        peerId: 'group-openid-9',
      }, [textPart('群里回一句', 0, 1)])
      expect(harness.bot.sent[3]?.target).toEqual({ scope: 'group', targetId: 'group-openid-9' })

      await expect(harness.channel.send({ ...privateTarget(undefined), channel: 'onebot' }, [textPart('x', 0, 1)]))
        .rejects.toMatchObject({ code: 'QQ_BAD_TARGET' })
    } finally {
      await harness.channel.stop()
    }

    const failing = channelHarness({ bot: { failOnContent: '炸' }, requireMention: false, markdownSupport: false })
    await failing.channel.start(failing.signal)
    try {
      await expect(failing.channel.send(privateTarget('in-2'), [
        textPart('先发这段', 0, 2),
        textPart('炸', 1, 2),
      ])).rejects.toMatchObject({
        code: 'QQ_SEND_FAILED',
        message: expect.stringContaining('part 2/2'),
      })
      // 失败不是静默的：第一段已经发出，第二段抛出，调用方据此知道回复不完整。
      expect(failing.bot.sent).toEqual([
        { method: 'sendText', target: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'in-2' }, content: '先发这段' },
      ])
    } finally {
      await failing.channel.stop()
    }
  })

  it('caps passive replies at four parts per trigger and pushes the rest proactively', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const parts = Array.from({ length: 6 }, (_unused, index) => textPart(`第 ${index + 1} 段`, index, 6))
      await harness.channel.send(privateTarget('in-6'), parts)
      const targets = harness.bot.sent.map((record) => record.target)
      expect(targets.slice(0, 4).map((target) => target.msgId)).toEqual(['in-6', 'in-6', 'in-6', 'in-6'])
      expect(targets.slice(4).map((target) => target.msgId)).toEqual([undefined, undefined])
      expect(targets.slice(4)).toEqual([
        { scope: 'c2c', targetId: 'openid-owner-1' },
        { scope: 'c2c', targetId: 'openid-owner-1' },
      ])
    } finally {
      await harness.channel.stop()
    }
  })

  it('counts the passive quota across sends for the same triggering message', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      // 同一个 msgId 被两次 send 命中：额度必须累计，第二次的前两条就应降级。
      await harness.channel.send(privateTarget('in-shared'), [
        textPart('第一次 A', 0, 3),
        textPart('第一次 B', 1, 3),
        textPart('第一次 C', 2, 3),
      ])
      await harness.channel.send(privateTarget('in-shared'), [
        textPart('第二次 A', 0, 3),
        textPart('第二次 B', 1, 3),
        textPart('第二次 C', 2, 3),
      ])
      const ids = harness.bot.sent.map((record) => record.target.msgId)
      expect(ids.slice(0, 4)).toEqual(['in-shared', 'in-shared', 'in-shared', 'in-shared'])
      expect(ids.slice(4)).toEqual([undefined, undefined])
    } finally {
      await harness.channel.stop()
    }
  })

  it('chooses sendText without markdown capability and sendMarkdown with it', async () => {
    const plain = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await plain.channel.start(plain.signal)
    try {
      await plain.channel.send(privateTarget('in-1'), [textPart('纯文本', 0, 1)])
      expect(plain.bot.sent.map((record) => record.method)).toEqual(['sendText'])
    } finally {
      await plain.channel.stop()
    }

    const rich = channelHarness({ bot: {}, requireMention: false, markdownSupport: true })
    await rich.channel.start(rich.signal)
    try {
      await rich.channel.send(privateTarget('in-1'), [textPart('**加粗**', 0, 1)])
      expect(rich.bot.sent.map((record) => record.method)).toEqual(['sendMarkdown'])
    } finally {
      await rich.channel.stop()
    }
  })

  it('serializes concurrent replies so their parts never interleave', async () => {
    const harness = channelHarness({ bot: { sendDelayMs: 5 }, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const first = harness.channel.send(privateTarget('in-a'), [textPart('A1', 0, 2), textPart('A2', 1, 2)])
      const second = harness.channel.send(privateTarget('in-b'), [textPart('B1', 0, 2), textPart('B2', 1, 2)])
      await Promise.all([first, second])
      expect(harness.bot.sent.map((record) => record.content)).toEqual(['A1', 'A2', 'B1', 'B2'])
    } finally {
      await harness.channel.stop()
    }
  })
})

describe('qq channel lifecycle', () => {
  it('moves idle → online → error → online as the gateway reports ready, disconnect and error', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    expect(harness.channel.status()).toEqual({ state: 'idle' })
    await harness.channel.start(harness.signal)
    expect(harness.channel.status()).toEqual({ state: 'online', since: NOW })

    await harness.bot.emit('disconnected', { code: 4009, reason: 'session timed out', willReconnect: true })
    expect(harness.channel.status()).toMatchObject({ state: 'error' })
    expect(harness.channel.status()).toMatchObject({ message: expect.stringContaining('4009') })

    // 重连成功即恢复：旧的断线原因不能继续把面板钉在 error 上。
    await harness.bot.emit('resumed', {})
    expect(harness.channel.status()).toEqual({ state: 'online', since: NOW })

    await harness.bot.emit('error', new Error('synthetic gateway error'))
    expect(harness.channel.status()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('synthetic gateway error'),
    })

    await harness.channel.stop()
    expect(harness.channel.status()).toEqual({ state: 'idle' })
  })

  it('rejects instead of retrying when the gateway refuses to start', async () => {
    const harness = channelHarness({ bot: { startError: new Error('invalid app secret') }, requireMention: false, markdownSupport: false })
    await expect(harness.channel.start(harness.signal)).rejects.toMatchObject({
      code: 'QQ_START_FAILED',
      message: expect.stringContaining('invalid app secret'),
    })
    expect(harness.channel.status()).toMatchObject({ state: 'error' })
    await harness.channel.stop()
  })
})

// ---- 运行期 SDK 加载 ----

let root: string
let db: TavernStore

beforeEach(async () => {
  clearOneBotSeatForTest()
  root = await mkdtemp(join(tmpdir(), 'qq-channel-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  clearOneBotSeatForTest()
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('qq runtime packages', () => {
  it('reports both missing packages with the exact install command and refuses to load them', async () => {
    const status = await qqRuntimeStatus()
    expect(status.installed).toBe(false)
    expect(status.reason).toContain(qqRuntimeRoot())
    expect(status.reason).toContain(
      'pnpm add @tencent-connect/qqbot-nodejs@1.0.5 @tencent-connect/qqbot-connector@1.2.0',
    )
    await expect(loadQqSdk()).rejects.toMatchObject({ code: 'QQ_RUNTIME_MISSING' })
    await expect(loadQqConnector()).rejects.toMatchObject({ code: 'QQ_RUNTIME_MISSING' })
  })
})

// ---- 运行时：账号与扫码绑定 ----

function fakeContext(): PluginContext {
  return { webServer: { register: () => () => {} } } as unknown as PluginContext
}

function imStore(): ImStore {
  return ImStore.open(tavernDataRoot('im'))
}

function qqAccount(accountId: string): ImAccountRef {
  return { channel: 'qq', accountId, label: '扫码绑定', createdAt: new Date(0).toISOString() }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

interface ConnectorHarness {
  connector: QQConnector
  last(): QQConnectorCallbacks
  lastOptions(): QQConnectorOptions
  readonly stops: number
}

function connectorHarness(): ConnectorHarness {
  let callbacks: QQConnectorCallbacks | undefined
  let options: QQConnectorOptions | undefined
  let stops = 0
  return {
    connector: (nextCallbacks, nextOptions) => {
      callbacks = nextCallbacks
      options = nextOptions
      return () => { stops += 1 }
    },
    last(): QQConnectorCallbacks {
      if (callbacks === undefined) throw new Error('the QQ connector was never started')
      return callbacks
    },
    lastOptions(): QQConnectorOptions {
      if (options === undefined) throw new Error('the QQ connector was never started')
      return options
    },
    get stops(): number {
      return stops
    },
  }
}

async function startBind(runtime: ImRuntime): Promise<ImBindStatus> {
  if (runtime.startQrBind === undefined) throw new Error('the IM runtime exposes no QR binding')
  return runtime.startQrBind('qq')
}

function bindStatus(runtime: ImRuntime): ImBindStatus {
  if (runtime.qrBindStatus === undefined) throw new Error('the IM runtime exposes no QR binding status')
  return runtime.qrBindStatus()
}

function cancelBind(runtime: ImRuntime): ImBindStatus {
  if (runtime.cancelQrBind === undefined) throw new Error('the IM runtime exposes no QR binding cancel')
  return runtime.cancelQrBind()
}

describe('qq runtime accounts', () => {
  it('rejects a qq account without appSecret and persists nothing', async () => {
    const runtime = createImRuntime(fakeContext(), { db, qqBot: () => fakeBot({}) as unknown as QqBotLike })
    try {
      await expect(runtime.upsertAccount(qqAccount(ACCOUNT_ID), { appId: ACCOUNT_ID }))
        .rejects.toMatchObject({ code: 'QQ_BAD_SECRET' })
      expect(await imStore().accounts()).toEqual([])
      expect(await imStore().readSecret('qq', ACCOUNT_ID)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('refuses a qq account before touching the store when the runtime sdk is missing', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      await expect(runtime.upsertAccount(qqAccount(ACCOUNT_ID), { appId: ACCOUNT_ID, appSecret: SYNTHETIC_SECRET }))
        .rejects.toMatchObject({ code: 'QQ_RUNTIME_MISSING' })
      expect(await imStore().accounts()).toEqual([])
      expect(await imStore().readSecret('qq', ACCOUNT_ID)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('deletes a newly stored qq account when the gateway refuses to start', async () => {
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => fakeBot({ startError: new Error('invalid app secret') }) as unknown as QqBotLike,
    })
    try {
      await expect(runtime.upsertAccount(qqAccount('7000009'), { appId: '7000009', appSecret: SYNTHETIC_SECRET }))
        .rejects.toMatchObject({ code: 'QQ_START_FAILED' })
      expect(await imStore().accounts()).toEqual([])
      expect(await imStore().readSecret('qq', '7000009')).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('restores the previous secret when reconfiguring a qq account fails to start', async () => {
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => fakeBot({ startError: new Error('invalid app secret') }) as unknown as QqBotLike,
    })
    try {
      await imStore().putAccount(qqAccount('7000010'), { appId: '7000010', appSecret: 'old-secret' })
      await expect(runtime.upsertAccount(qqAccount('7000010'), { appId: '7000010', appSecret: 'new-secret' }))
        .rejects.toMatchObject({ code: 'QQ_START_FAILED' })
      expect(await imStore().readSecret('qq', '7000010')).toEqual({ appId: '7000010', appSecret: 'old-secret' })
      expect((await imStore().accounts()).map((account) => account.accountId)).toEqual(['7000010'])
    } finally {
      await runtime.dispose()
    }
  })
})

describe('qq qr binding', () => {
  it('stores the scanned credential and whitelists the scanner as the private owner', async () => {
    const harness = connectorHarness()
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => fakeBot({}) as unknown as QqBotLike,
      qqConnector: harness.connector,
    })
    try {
      expect(await startBind(runtime)).toEqual({ phase: 'waiting' })
      expect(harness.lastOptions().source).toBe('dsh-soulmojito')
      // 二维码只走回调，不打印到宿主控制台。
      expect(harness.lastOptions().displayQrCodeToConsole).toBe(false)

      harness.last().onQrDisplayed?.('https://example.invalid/qq-qr')
      expect(bindStatus(runtime)).toEqual({ phase: 'waiting', url: 'https://example.invalid/qq-qr' })

      const credential: QQBindCredential = {
        appId: '7000001',
        appSecret: 'synthetic-scanned-secret',
        userOpenid: 'owner-openid-1',
      }
      harness.last().onSuccess([credential])
      expect(bindStatus(runtime).phase).toBe('saving')
      await waitFor(() => bindStatus(runtime).phase === 'idle', 3_000)

      expect(await imStore().accounts()).toMatchObject([
        { channel: 'qq', accountId: '7000001', label: 'QQ 机器人' },
      ])
      expect(await imStore().readSecret('qq', '7000001')).toEqual({
        appId: '7000001',
        appSecret: 'synthetic-scanned-secret',
      })
      const state = await db.getState()
      expect(state.imSettings?.privateAllow).toEqual(['owner-openid-1'])
      expect(runtime.views()).toMatchObject([
        { channel: 'qq', accountId: '7000001', status: { state: 'online' } },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('cancels a pending scan, aborts the connector, and ignores the late success callback', async () => {
    const harness = connectorHarness()
    const runtime = createImRuntime(fakeContext(), {
      db,
      qqBot: () => fakeBot({}) as unknown as QqBotLike,
      qqConnector: harness.connector,
    })
    try {
      await startBind(runtime)
      await expect(startBind(runtime)).rejects.toMatchObject({ code: 'QQ_BIND_BUSY' })

      const callbacks = harness.last()
      expect(cancelBind(runtime)).toEqual({ phase: 'idle' })
      expect(harness.stops).toBe(1)

      // 取消后连接器仍可能回调：已摘掉的会话不得再改写账号或白名单。
      callbacks.onSuccess([{ appId: '7000002', appSecret: 'synthetic-late-secret', userOpenid: 'owner-openid-2' }])
      callbacks.onFailure?.(new Error('已取消'))
      expect(bindStatus(runtime)).toEqual({ phase: 'idle' })
      expect(await imStore().accounts()).toEqual([])
      expect((await db.getState()).imSettings?.privateAllow).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('projects a connector failure as the failed phase with its reason', async () => {
    const harness = connectorHarness()
    const runtime = createImRuntime(fakeContext(), { db, qqConnector: harness.connector })
    try {
      await startBind(runtime)
      harness.last().onFailure(new Error('二维码已过期'))
      expect(bindStatus(runtime)).toEqual({ phase: 'failed', reason: '二维码已过期' })
      // 失败后通道没有被登记：没有凭据就不该出现账号。
      expect(await imStore().accounts()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('projects a missing connector package as the failed phase with the install command', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      await expect(startBind(runtime)).rejects.toMatchObject({ code: 'QQ_RUNTIME_MISSING' })
      const status = bindStatus(runtime)
      expect(status.phase).toBe('failed')
      expect(status.reason).toContain('pnpm add @tencent-connect/qqbot-nodejs@1.0.5')
    } finally {
      await runtime.dispose()
    }
  })
})
