/**
 * 入站路由（提案 0024 §3.8）：去重 → 白名单 → 绑定 → **立即** followup。
 *
 * 这里刻意没有队列、没有 debounce、没有「等人说完」：宿主 AgentLoop 自己收
 * inbox，插件再攒一层只会让「立即投递」变成一句空话。唯一的时间维度是去重与
 * 未绑定提示的抑制窗口。
 *
 * 所有宿主能力都从 deps 进来，路由本身不认识 ctx、不认识协议。
 */

import { randomUUID } from 'node:crypto'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostLogger } from '../host-contract.js'
import { projectImText } from './project.js'
import { PendingOrigins, assistantTextOfTurn, turnFailedOf, userMessageIdsOfTurn, type ImSessionEventLike } from './reply.js'
import { imAccessAllows, imChunkLimit } from './settings.js'
import { imUnboundMessage, type EnsureImSessionRequest, type EnsureImSessionResult } from './session-host.js'
import type { OutboundPart, ImChannelId, ImInbound, ImPeerBinding, ImSendReceipt, ImSettings, ImTarget } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey, imPeerKeyParts } from './types.js'

/** 轮次失败时的固定话术：不回模型原文，也不暴露内部错误。 */
export const IM_TURN_FAILED = '（这一轮没有生成成功，稍后再试）'

/**
 * 主动发送的结构化失败（提案 0024 §3.6 的 `im_send`）：绑定缺失、目标非法与
 * 传输失败必须能区分，工具面据此如实点名原因，而不是一句通用异常。
 */
export class ImSendError extends Error {
  readonly code: 'IM_SEND_INVALID' | 'IM_SEND_INVALID_TARGET' | 'IM_SEND_UNBOUND' | 'IM_SEND_FAILED'
  constructor(
    code: ImSendError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ImSendError'
    this.code = code
  }
}


/** 未绑定提示的抑制窗口：同一个 peer 十分钟内只被提醒一次。 */
const UNBOUND_NOTICE_TTL_MS = 10 * 60_000

export interface ImAgentMessage {
  id: string
  text: string
}

export interface ImRouterDeps {
  db: TavernStore
  now: () => number
  /** true = 这条消息已经投递过（平台重连会补发同一条）。 */
  seenDedupe: (dedupeKey: string, now: number) => Promise<boolean>
  ensureSession: (request: EnsureImSessionRequest) => Promise<EnsureImSessionResult>
  /** Host-side text rendering: display-layer regex scripts for this chat. */
  render: (target: ImTarget, text: string) => Promise<string>
  followup: (sessionId: string, message: ImAgentMessage) => Promise<void>
  send: (target: ImTarget, parts: readonly OutboundPart[]) => Promise<void>
  logger?: HostLogger
}

export interface ImRouter {
  /** 一条入站消息：不阻塞调用方，通道的事件循环可以继续收消息。 */
  inbound(inbound: ImInbound): Promise<void>
  /** 该会话的某一轮结束：把正文回给发起这一轮的那个 peer。 */
  finishTurn(sessionId: string, turn: number, events: readonly ImSessionEventLike[]): Promise<void>
  /**
   * 主动发一条文本给已绑定的 peer（`im_send` 的落点）。绑定存在性在这里再验
   * 一次：工具面只保证「绑到本会话」，路由保证「peer 真的有绑定」。
   */
  sendText(peerKey: string, text: string): Promise<ImSendReceipt>
  /** 供测试与面板观测。 */
  pending(sessionId: string): number
}

export function createImRouter(deps: ImRouterDeps): ImRouter {
  const origins = new PendingOrigins({ ttlMs: 10 * 60_000, maxPerSession: 200 })
  const noticed = new Map<string, number>()

  async function settingsOf(): Promise<ImSettings> {
    const state = await deps.db.getState()
    return state.imSettings ?? DEFAULT_IM_SETTINGS
  }

  async function inbound(inboundMessage: ImInbound): Promise<void> {
    const now = deps.now()
    if (await deps.seenDedupe(inboundMessage.dedupeKey, now)) return
    const settings = await settingsOf()
    if (!imAccessAllows(settings, inboundMessage.scope, inboundMessage.peerId)) {
      deps.logger?.warn?.(`dsh-soulmojito im: dropped ${inboundMessage.channel}/${inboundMessage.peerId} (access policy)`)
      return
    }
    const target: ImTarget = {
      channel: inboundMessage.channel,
      accountId: inboundMessage.accountId,
      scope: inboundMessage.scope,
      peerId: inboundMessage.peerId,
      ...(inboundMessage.replyTo === undefined ? {} : { replyTo: inboundMessage.replyTo }),
    }
    const text = imUserTextOf(inboundMessage)
    if (text === undefined) return
    const peerKey = imPeerKey(inboundMessage.channel, inboundMessage.accountId, inboundMessage.scope, inboundMessage.peerId)
    const binding = await resolveBinding(peerKey, inboundMessage.scope, settings)
    if (binding === undefined) {
      await notifyUnbound(target, peerKey, now)
      return
    }
    const messageId = `im-${randomUUID()}`
    origins.remember(binding.sessionId, messageId, peerKey, target, now)
    try {
      await deps.followup(binding.sessionId, { id: messageId, text })
    } catch (error) {
      origins.forgetSession(binding.sessionId)
      deps.logger?.warn?.(`dsh-soulmojito im: followup to ${binding.sessionId} failed: ${messageOf(error)}`)
      await sendNotice(target, IM_TURN_FAILED)
    }
  }

  async function resolveBinding(peerKey: string, scope: 'private' | 'group', settings: ImSettings): Promise<ImPeerBinding | undefined> {
    const state = await deps.db.getState()
    const existing = state.imPeers?.[peerKey]
    if (existing !== undefined) return existing
    if (settings.bindingMode === 'manual') return undefined
    const request: EnsureImSessionRequest = {
      mode: settings.bindingMode,
      peerKey,
      ...(settings.sourceChat === undefined ? {} : { sourceChat: settings.sourceChat }),
      ...(settings.sharedChat === undefined ? {} : { sharedChat: settings.sharedChat }),
      ...sharedSessionOf(state.imPeers, settings),
    }
    const result = await deps.ensureSession(request)
    const binding: ImPeerBinding = {
      sessionId: result.sessionId,
      character: result.character,
      chatId: result.chatId,
      scope,
      boundBy: 'auto',
      createdAt: new Date(deps.now()).toISOString(),
    }
    await deps.db.updateState((current) => ({
      imPeers: { ...(current.imPeers ?? {}), [peerKey]: binding },
    }))
    return binding
  }

  async function finishTurn(sessionId: string, turn: number, events: readonly ImSessionEventLike[]): Promise<void> {
    const now = deps.now()
    const origin = origins.resolve(sessionId, userMessageIdsOfTurn(events, turn), now)
    if (origin === undefined) return
    if (turnFailedOf(events, turn)) {
      await sendNotice(origin.target, IM_TURN_FAILED)
      return
    }
    const text = assistantTextOfTurn(events, turn)
    // 空轮（只有工具调用、没有正文）不推 IM：用户看到一条空气比看到旧话更糟。
    if (text === undefined) return
    const settings = await settingsOf()
    const rendered = await deps.render(origin.target, text)
    const parts = projectImText(rendered, origin.target.channel, imChunkLimit(origin.target.channel, settings))
    await deps.send(origin.target, parts.map((part, index) => ({
      kind: 'text' as const,
      text: part,
      index,
      total: parts.length,
    })))
  }

  async function sendText(peerKey: string, text: string): Promise<ImSendReceipt> {
    const body = text.trim()
    if (body === '') {
      throw new ImSendError('IM_SEND_INVALID', 'IM text is empty after trimming whitespace')
    }
    const parts = imPeerKeyParts(peerKey)
    if (parts === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `malformed IM peer key '${peerKey}'; expected '<channel>:<accountId>:<scope>:<peerId>'`)
    }
    const channel = channelOf(parts.channel)
    if (channel === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `IM peer key '${peerKey}' names unknown channel '${parts.channel}'`)
    }
    const scope = parts.scope === 'private' || parts.scope === 'group' ? parts.scope : undefined
    if (scope === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `IM peer key '${peerKey}' names unknown scope '${parts.scope}'`)
    }
    const state = await deps.db.getState()
    if (state.imPeers?.[peerKey] === undefined) {
      throw new ImSendError('IM_SEND_UNBOUND', `IM peer '${peerKey}' has no binding; bind it in the DSH-SoulMojito IM panel first`)
    }
    const settings = state.imSettings ?? DEFAULT_IM_SETTINGS
    const target: ImTarget = {
      channel,
      accountId: parts.accountId,
      scope,
      peerId: parts.peerId,
    }
    const chunks = projectImText(body, channel, imChunkLimit(channel, settings))
    try {
      await deps.send(target, chunks.map((chunk, index) => ({
        kind: 'text' as const,
        text: chunk,
        index,
        total: chunks.length,
      })))
    } catch (error) {
      // 主动发送失败必须上抛：工具层要如实告诉模型这条消息没出去。
      throw new ImSendError('IM_SEND_FAILED', `IM send to ${peerKey} failed: ${messageOf(error)}`, { cause: error })
    }
    return { parts: chunks.length, at: deps.now() }
  }

  async function notifyUnbound(target: ImTarget, peerKey: string, now: number): Promise<void> {
    const last = noticed.get(peerKey)
    if (last !== undefined && now - last < UNBOUND_NOTICE_TTL_MS) return
    noticed.set(peerKey, now)
    await sendNotice(target, imUnboundMessage(peerKey))
  }

  async function sendNotice(target: ImTarget, text: string): Promise<void> {
    try {
      await deps.send(target, [{ kind: 'text', text, index: 0, total: 1 }])
    } catch (error) {
      deps.logger?.warn?.(`dsh-soulmojito im: notice to ${target.channel}/${target.peerId} failed: ${messageOf(error)}`)
    }
  }

  return {
    inbound,
    finishTurn,
    sendText,
    pending: (sessionId: string) => origins.pendingCount(sessionId),
  }
}

/**
 * 入站文本 → 会话里的一条用户消息。
 *
 * 群聊必须带发言人前缀：Tavern 这里是单角色时间线，模型只能从文本看出「这是
 * 另一个人说的」。私聊不加前缀，避免每句话都被名字噪声切碎。
 */
export function imUserTextOf(inbound: ImInbound): string | undefined {
  const body = inbound.text.trim()
  const attachments = attachmentSummaryOf(inbound)
  const composed = inbound.scope === 'group'
    ? `[${inbound.senderName || inbound.senderId}] ${body}`.trim()
    : body
  const withAttachments = attachments === undefined
    ? composed
    : `${composed}${composed === '' ? '' : '\n'}${attachments}`.trim()
  return withAttachments === '' ? undefined : withAttachments
}

function attachmentSummaryOf(inbound: ImInbound): string | undefined {
  if (inbound.media.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const media of inbound.media) {
    const label = media.kind === 'image' ? '图片' : media.kind === 'voice' ? '语音' : media.kind === 'video' ? '视频' : '文件'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return `（附件：${[...counts].map(([label, count]) => `${label}×${count}`).join('、')}）`
}

/** 共享模式：已经有 peer 绑到同一个聊天时，复用它的会话 id。 */
function sharedSessionOf(
  peers: Record<string, ImPeerBinding> | undefined,
  settings: ImSettings,
): { existingSessionId?: string } {
  if (settings.bindingMode !== 'shared' || settings.sharedChat === undefined) return {}
  const { character, chatId } = settings.sharedChat
  for (const binding of Object.values(peers ?? {})) {
    if (binding.character === character && binding.chatId === chatId) return { existingSessionId: binding.sessionId }
  }
  return {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** peerKey 的渠道段只认三条真实通道；其余值说明绑定键被手改坏了。 */
function channelOf(value: string): ImChannelId | undefined {
  return value === 'qq' || value === 'weixin' || value === 'onebot' ? value : undefined
}
