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
import { planGroupParts, QQChannel } from '../src/im/qq/channel.js'
import { loadQqConnector, loadQqSdk, qqRuntimeRoot, qqRuntimeStatus } from '../src/im/qq/sdk.js'
import type {
  QqBotLike,
  QqInboundAttachment,
  QqInboundMessage,
  QqMediaSendOptions,
  QqMediaSendResult,
  QqMediaSource,
  QqMessageResponse,
  QqReplyTarget,
} from '../src/im/qq/sdk.js'
import type { ImRuntime } from '../src/im/runtime.js'
import { createImRuntime } from '../src/im/runtime.js'
import { ImStore } from '../src/im/store.js'
import { imDedupeKey, type ImAccountRef, type ImBindStatus, type ImInbound, type ImTarget, type OutboundMediaPart, type OutboundPart } from '../src/im/types.js'

const NOW = 1_760_000_000_000
const ACCOUNT_ID = '10000001'
const SYNTHETIC_SECRET = 'synthetic-app-secret'

type SendMethod = 'sendText' | 'sendMarkdown'
type MediaMethod = 'sendImage' | 'sendVideo' | 'sendVoice' | 'sendFile'

interface SentRecord {
  method: SendMethod
  target: QqReplyTarget
  content: string
}

interface MediaRecord {
  method: MediaMethod
  target: QqReplyTarget
  source: QqMediaSource
  opts: QqMediaSendOptions | undefined
}

interface FakeBotOptions {
  /** 正文等于该串时发送抛错，用来验证单条失败上抛。 */
  failOnContent?: string
  /** `start()` 直接 reject，用来验证启动失败必须抛。 */
  startError?: Error
  /** 每次发送前的延迟：没有出站串行时并发轮次会交错。 */
  sendDelayMs?: number
  /** 不暴露媒体方法：验证 build 缺 sendImage 等成员时的清晰报错。 */
  noMediaMethods?: boolean
}

interface FakeBot {
  readonly sent: SentRecord[]
  readonly media: MediaRecord[]
  on(event: string, handler: (...args: unknown[]) => unknown): FakeBot
  start(): Promise<void>
  stop(): void
  sendText(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
  sendMarkdown(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
  sendImage?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendVideo?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendVoice?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendFile?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  emit(event: string, ...args: unknown[]): Promise<void>
}

function settleDelay(ms: number | undefined): Promise<void> {
  if (ms === undefined) return Promise.resolve()
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function fakeBot(options: FakeBotOptions): FakeBot {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const sent: SentRecord[] = []
  const media: MediaRecord[] = []
  const bot: FakeBot = {
    sent,
    media,
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
  if (options.noMediaMethods !== true) {
    // 媒体方法的形状照官方 d.ts：target + source + opts，回执只关心 message.id。
    bot.sendImage = (target, source, opts) => sendMedia('sendImage', target, source, opts)
    bot.sendVideo = (target, source, opts) => sendMedia('sendVideo', target, source, opts)
    bot.sendVoice = (target, source, opts) => sendMedia('sendVoice', target, source, opts)
    bot.sendFile = (target, source, opts) => sendMedia('sendFile', target, source, opts)
  }
  async function send(method: SendMethod, target: QqReplyTarget, content: string): Promise<QqMessageResponse> {
    await settleDelay(options.sendDelayMs)
    if (options.failOnContent !== undefined && content === options.failOnContent) {
      throw new Error('synthetic send failure')
    }
    sent.push({ method, target, content })
    return { id: `out-${sent.length}` }
  }
  async function sendMedia(
    method: MediaMethod,
    target: QqReplyTarget,
    source: QqMediaSource,
    opts: QqMediaSendOptions | undefined,
  ): Promise<QqMediaSendResult> {
    await settleDelay(options.sendDelayMs)
    media.push({ method, target, source, opts })
    return { message: { id: `media-${media.length}` } }
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

function mediaPart(part: Omit<OutboundMediaPart, 'index' | 'total'>, index: number, total: number): OutboundPart {
  return { ...part, index, total }
}

function imagePart(index: number, total: number): OutboundPart {
  return mediaPart({ kind: 'image', localPath: `C:/tmp/img-${index + 1}.png` }, index, total)
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

function groupTarget(replyTo: string | undefined): ImTarget {
  return {
    channel: 'qq',
    accountId: ACCOUNT_ID,
    scope: 'group',
    peerId: 'group-openid-9',
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
  /** 时钟注入：只在需要跨时间桶的用例里覆盖；缺省固定在 NOW。 */
  now?: () => number
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
    now: options.now ?? (() => NOW),
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
        platformAt: NOW,
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

  it('falls back to a deterministic dedupe id when the payload carries no message id', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const truncated = c2cMessage({
        senderId: '',
        senderName: undefined,
        messageId: '',
        replyTarget: { scope: 'c2c', targetId: 'openid-owner-2' },
      })
      // 同一毫秒的重放：平台缺 id，但身份 + 内容 + 时间戳完全相同 → 同一个键。
      await harness.bot.emit('message', {}, truncated)
      await harness.bot.emit('message', {}, truncated)
      const [first, second] = harness.delivered
      expect(first).toMatchObject({
        peerId: 'openid-owner-2',
        senderId: 'openid-owner-2',
        senderName: 'openid-o',
      })
      expect(first?.replyTo).toBeUndefined()
      expect(second?.dedupeKey).toBe(first?.dedupeKey)
      expect(first?.dedupeKey).toMatch(/^qq:10000001:private:openid-owner-2:fallback-[0-9a-f]{16}$/)

      // 内容不同 → 键必须不同，落在同一毫秒也不撞。
      await harness.bot.emit('message', {}, c2cMessage({ ...truncated, content: '换了一句话' }))
      // 同一内容、平台时间戳不同 → 是另一条消息，键必须不同。
      await harness.bot.emit('message', {}, c2cMessage({ ...truncated, timestamp: String(NOW + 1) }))
      // 平台给了 id 就用平台 id，不掺内容指纹。
      await harness.bot.emit('message', {}, c2cMessage({ messageId: 'c2c-msg-2' }))
      const keys = harness.delivered.map((inbound) => inbound.dedupeKey)
      // 五条里前两条是同一键：互不相同的内容/时间/id 共四个键。
      expect(new Set(keys).size).toBe(4)
      expect(keys[2]).not.toBe(keys[0])
      expect(keys[3]).not.toBe(keys[0])
      expect(harness.delivered[4]?.dedupeKey).toBe(
        imDedupeKey('qq', ACCOUNT_ID, 'private', 'openid-owner-1', 'c2c-msg-2'),
      )
    } finally {
      await harness.channel.stop()
    }
  })

  it('changes the dedupe key when only a voice attachment field differs without a message id', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const truncated = c2cMessage({
        senderId: '',
        messageId: '',
        content: '',
        replyTarget: { scope: 'c2c', targetId: 'openid-owner-2' },
      })
      const voice = (asr: string): QqInboundAttachment => ({
        content_type: 'voice',
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=voice-same',
        asr_refer_text: asr,
      })
      await harness.bot.emit('message', {}, { ...truncated, attachments: [voice('听出来的第一版')] })
      await harness.bot.emit('message', {}, { ...truncated, attachments: [voice('听出来的第二版')] })
      const [first, second] = harness.delivered
      // 识别文本进正文：只有它不同就说明是两条不同的语音，不能撞同一个键。
      expect(first?.text).toBe('听出来的第一版')
      expect(second?.text).toBe('听出来的第二版')
      expect(second?.dedupeKey).not.toBe(first?.dedupeKey)
    } finally {
      await harness.channel.stop()
    }
  })

  it('falls back to the receivedAt bucket when the platform timestamp is missing', async () => {
    let now = NOW
    const harness = channelHarness({
      bot: {},
      requireMention: false,
      markdownSupport: false,
      now: () => now,
    })
    await harness.channel.start(harness.signal)
    try {
      const truncated = c2cMessage({
        messageId: '',
        timestamp: '',
        replyTarget: { scope: 'c2c', targetId: 'openid-owner-2' },
      })
      await harness.bot.emit('message', {}, truncated)
      // 十分钟桶内的第二次相同内容：视为重放，键必须一致。
      now = NOW + 60_000
      await harness.bot.emit('message', {}, truncated)
      const [first, second] = harness.delivered
      expect(first?.receivedAt).toBe(NOW)
      expect(second?.dedupeKey).toBe(first?.dedupeKey)

      // 下一桶里用户真的又发了一次同一条消息：键必须不同，不能被静默吞掉。
      now = NOW + 10 * 60_000
      await harness.bot.emit('message', {}, truncated)
      expect(harness.delivered[2]?.dedupeKey).not.toBe(first?.dedupeKey)
    } finally {
      await harness.channel.stop()
    }
  })

  it('turns platform attachments into media refs without downloading anything', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const imageUrl = 'https://multimedia.nt.qq.com.cn/download?fileid=image-1'
      const voiceUrl = 'https://multimedia.nt.qq.com.cn/download?fileid=voice-1'
      // 官方 d.ts 的 InboundAttachment：content_type/url/filename/size，语音另有
      // voice_wav_url 与 asr_refer_text。
      await harness.bot.emit('message', {}, c2cMessage({
        content: '看图',
        messageId: 'c2c-media-1',
        attachments: [
          { content_type: 'image/png', url: imageUrl, filename: 'cat.png', size: 2048 },
          { content_type: 'voice', url: voiceUrl, asr_refer_text: '你好' },
          // 没有直链的附件直接丢弃：QQ 通道不下载、不转存。
          { content_type: 'file', url: '' },
        ],
      }))
      // 语音的识别文本进正文：语音唯一可读的内容就是它。
      expect(harness.delivered[0]?.text).toBe('看图\n你好')
      expect(harness.delivered[0]?.media).toEqual([
        { kind: 'image', url: imageUrl, name: 'cat.png', size: 2048 },
        { kind: 'voice', url: voiceUrl, transcript: '你好' },
      ])

      // 平台原始事件（GroupMessageEvent）只在 raw.attachments 上带附件：手写载荷
      // 与旧 build 走这条，通道同样能读到。
      const videoUrl = 'https://multimedia.nt.qq.com.cn/download?fileid=video-1'
      await harness.bot.emit('message', {}, groupMessage({
        messageId: 'group-media-1',
        content: '',
        raw: {
          id: 'group-media-1',
          content: '',
          timestamp: String(NOW),
          author: { member_openid: 'member-openid-1' },
          group_openid: 'group-openid-9',
          attachments: [{ content_type: 'video/mp4', url: videoUrl, size: 4096 }],
        },
      }))
      expect(harness.delivered[1]?.media).toEqual([{ kind: 'video', url: videoUrl, size: 4096 }])
    } finally {
      await harness.channel.stop()
    }
  })

  it('normalizes the platform timestamp to milliseconds when the payload carries one', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      // 秒级时间戳（旧载荷）→ 毫秒。
      await harness.bot.emit('message', {}, c2cMessage({ timestamp: '1760000000' }))
      // 已经是毫秒的时间戳原样保留。
      await harness.bot.emit('message', {}, c2cMessage({ messageId: 'c2c-msg-2', timestamp: String(NOW) }))
      // 缺时间戳：省略 platformAt，不发明一个。
      await harness.bot.emit('message', {}, c2cMessage({ messageId: 'c2c-msg-3', timestamp: '' }))
      const [seconds, milliseconds, missing] = harness.delivered
      expect(seconds?.platformAt).toBe(1_760_000_000_000)
      expect(milliseconds?.platformAt).toBe(NOW)
      expect(missing?.platformAt).toBeUndefined()
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

  it('sends an image from localPath and puts the caption in front of it', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const receipt = await harness.channel.send(privateTarget('in-media'), [
        mediaPart({ kind: 'image', localPath: 'C:/tmp/a.png', caption: '看这张图' }, 0, 1),
      ])
      // caption 先走文本通道，媒体随后；两次都是被动回复（各占一格额度）。
      expect(harness.bot.sent).toEqual([
        { method: 'sendText', target: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'in-media' }, content: '看这张图' },
      ])
      expect(harness.bot.media).toEqual([
        {
          method: 'sendImage',
          target: { scope: 'c2c', targetId: 'openid-owner-1', msgId: 'in-media' },
          source: { localPath: 'C:/tmp/a.png' },
          opts: undefined,
        },
      ])
      expect(receipt).toEqual({ parts: 1, at: NOW, messageId: 'media-1' })
    } finally {
      await harness.channel.stop()
    }
  })

  it('keeps the openid out of a media failure message', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      harness.bot.sendImage = async () => { throw new Error('platform rejected the image') }
      const failure = await harness.channel.send(privateTarget('in-media-fail'), [
        mediaPart({ kind: 'image', localPath: 'C:/tmp/a.png' }, 0, 1),
      ]).catch((error: unknown) => error as Error)
      // 平台身份只能以 alias 出现在错误里：它会进日志环与模型上下文。
      expect(failure.message).toContain('peer-')
      expect(failure.message).not.toContain('openid-owner-1')
      expect(failure.message).toContain('platform rejected the image')
    } finally {
      await harness.channel.stop()
    }
  })

  it('counts every media send against the four passive reply slots', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      const parts = Array.from({ length: 5 }, (_unused, index) => imagePart(index, 5))
      await harness.channel.send(privateTarget('in-media-cap'), parts)
      const targets = harness.bot.media.map((record) => record.target)
      expect(targets.slice(0, 4).map((target) => target.msgId)).toEqual([
        'in-media-cap', 'in-media-cap', 'in-media-cap', 'in-media-cap',
      ])
      // 第 5 条超出额度：降级主动推送，不能挂在被动回复上。
      expect(targets[4]).toEqual({ scope: 'c2c', targetId: 'openid-owner-1' })
      expect(harness.bot.media.map((record) => record.source.localPath)).toEqual([
        'C:/tmp/img-1.png', 'C:/tmp/img-2.png', 'C:/tmp/img-3.png', 'C:/tmp/img-4.png', 'C:/tmp/img-5.png',
      ])
    } finally {
      await harness.channel.stop()
    }
  })

  it('rejects a url source for kinds the adapter refuses to download', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      await expect(harness.channel.send(privateTarget('in-voice'), [
        mediaPart({ kind: 'voice', url: 'https://example.invalid/v.silk' }, 0, 1),
      ])).rejects.toMatchObject({
        code: 'QQ_SEND_FAILED',
        message: expect.stringContaining('must be sent from a local file'),
      })
      expect(harness.bot.media).toEqual([])
    } finally {
      await harness.channel.stop()
    }
  })

  it('names the missing SDK method when the build exposes no media sender', async () => {
    const harness = channelHarness({ bot: { noMediaMethods: true }, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      await expect(harness.channel.send(privateTarget('in-1'), [imagePart(0, 1)])).rejects.toMatchObject({
        code: 'QQ_SEND_FAILED',
        message: expect.stringContaining('exposes no sendImage()'),
      })
      // 报错要指向面板重装，而不是让用户猜哪来的旧 build。
      await expect(harness.channel.send(privateTarget('in-1'), [imagePart(0, 1)]))
        .rejects.toThrow(/reinstall the runtime from the IM panel/)
    } finally {
      await harness.channel.stop()
    }
  })

  it('repacks an over-long group reply into four passive parts without losing text', async () => {
    const harness = channelHarness({ bot: {}, requireMention: false, markdownSupport: false })
    await harness.channel.start(harness.signal)
    try {
      // 6 片 × 10 字 = 60 字，远小于 4 × 4500：重切成 4 片即可全部被动回复。
      const texts = Array.from({ length: 6 }, (_unused, index) => `第${index}段0123456`)
      await harness.channel.send(groupTarget('group-msg-1'), texts.map((text, index) => textPart(text, index, texts.length)))

      expect(harness.bot.sent).toHaveLength(4)
      expect(harness.bot.sent.every((record) => record.target.msgId === 'group-msg-1')).toBe(true)
      // 重切只改切片位置：段落分隔（空行）也要跟着内容一起还原，一个字都不能丢。
      expect(harness.bot.sent.map((record) => record.content).join('')).toBe(texts.join('\n\n'))
      expect(harness.bot.sent.map((record) => record.content).join('')).toContain('\n\n')
      // 私聊不参与重切：同样的 6 片仍是「4 被动 + 2 主动」。
      await harness.channel.send(privateTarget('in-private-6'), texts.map((text, index) => textPart(text, index, texts.length)))
      expect(harness.bot.sent).toHaveLength(10)
      expect(harness.bot.sent.slice(4, 8).every((record) => record.target.msgId === 'in-private-6')).toBe(true)
      expect(harness.bot.sent.slice(8).map((record) => record.target.msgId)).toEqual([undefined, undefined])
    } finally {
      await harness.channel.stop()
    }
  })
})

describe('qq group part planning', () => {
  it('leaves four or fewer parts untouched', () => {
    expect(planGroupParts(['一', '二', '三', '四'], 10)).toEqual({
      parts: ['一', '二', '三', '四'],
      overflow: false,
    })
    expect(planGroupParts([], 10)).toEqual({ parts: [], overflow: false })
  })

  it('repacks more than four parts into at most four without splitting surrogate pairs', () => {
    const texts = ['ab😀', 'cd😀', 'ef😀', 'gh😀', 'ij😀']
    // 原片是逐段 trim 过的：重切前必须用空行重新粘起来，不能把段落边界吃掉。
    const joined = texts.join('\n\n')
    const plan = planGroupParts(texts, 100)
    expect(plan.overflow).toBe(false)
    expect(plan.parts.length).toBeLessThanOrEqual(4)
    expect(plan.parts.join('')).toBe(joined)
    // 代理对必须完整落在同一片里：切开会渲染成替换符。
    for (const part of plan.parts) {
      expect(isLowSurrogate(part.charCodeAt(0))).toBe(false)
      expect(isHighSurrogate(part.charCodeAt(part.length - 1))).toBe(false)
    }
  })

  it('flags overflow when the text cannot fit into four parts and keeps the front four full', () => {
    const texts = Array.from({ length: 5 }, (_unused, index) => `第${index}段`.padEnd(10, 'x'))
    const joined = texts.join('\n\n')
    const plan = planGroupParts(texts, 10)
    expect(plan.overflow).toBe(true)
    expect(plan.parts.length).toBeGreaterThan(4)
    expect(plan.parts.slice(0, 4).join('')).toBe(joined.slice(0, 40))
    expect(plan.parts.join('')).toBe(joined)
  })
})

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

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
  it('reports both missing packages with a panel install pointer and refuses to load them', async () => {
    const status = await qqRuntimeStatus()
    expect(status.installed).toBe(false)
    // 面板文案不带运行期目录的绝对路径（HTTP 隐私边界）。
    expect(status.reason).not.toContain(qqRuntimeRoot())
    // 用户不该被要求开终端：提示指向面板按钮，命令只留在服务端日志/测试里。
    expect(status.reason).toContain('安装 QQ 依赖')
    expect(status.reason).not.toContain('pnpm add')
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
      const qqStatus = bindStatus(runtime)
      expect(qqStatus).toMatchObject({ phase: 'waiting', url: 'https://example.invalid/qq-qr' })
      // 服务端必须顺手给出可显示的二维码图片：面板把内容串塞进 <img src> 只会破图。
      expect(qqStatus.qrSvg?.startsWith('data:image/svg+xml;base64,')).toBe(true)

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

  it('projects a missing connector package as the failed phase with the panel install pointer', async () => {
    const runtime = createImRuntime(fakeContext(), { db })
    try {
      await expect(startBind(runtime)).rejects.toMatchObject({ code: 'QQ_RUNTIME_MISSING' })
      const status = bindStatus(runtime)
      expect(status.phase).toBe('failed')
      expect(status.reason).toContain('安装 QQ 依赖')
    } finally {
      await runtime.dispose()
    }
  })
})
