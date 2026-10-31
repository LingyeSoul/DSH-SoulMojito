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
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostLogger } from '../host-contract.js'
import { projectImText } from './project.js'
import { PendingOrigins, assistantTextOfTurn, turnBlockedOf, turnFailedOf, userMessageIdsOfTurn, type ImSessionEventLike } from './reply.js'
import { imAccessAllows, imChunkLimit } from './settings.js'
import { imUnboundMessage, type EnsureImSessionRequest, type EnsureImSessionResult } from './session-host.js'
import type { ImLogSink } from './log.js'
import type { ImChannelId, ImInbound, ImMediaRef, ImOutboundMedia, ImPeerBinding, ImScope, ImSendReceipt, ImSettings, ImTarget, OutboundPart } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey, imPeerKeyParts } from './types.js'

/** 轮次失败时的固定话术：不回模型原文，也不暴露内部错误。 */
export const IM_TURN_FAILED = '（这一轮没有生成成功，稍后再试）'

/**
 * 轮次在第一步之前被宿主拒绝时的话术（典型：会话已被归档）。必须可行动——
 * 「稍后再试」对归档状态是错的方向，重试多少次都一样。
 */
export const IM_TURN_BLOCKED = '（这个会话暂时不能继续：可能已在 DSH 里被归档，请先取消归档再发一次）'

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
  /**
   * 媒体文件的合法根（内部工作区）。给定时 `sendMedia` 拒绝根目录之外的文件：
   * 模型不能被诱导把密钥/聊天记录当附件发出去。缺省（测试假件）不启用。
   */
  workspaceRoot?: () => Promise<string>
  logger?: HostLogger
  /** 面板「IM 运行日志」的落点；缺省时只写宿主日志。 */
  log?: ImLogSink
}

export interface ImRouter {
  /**
   * 一条入站消息：不阻塞调用方，通道的事件循环可以继续收消息。
   *
   * `loadMedia` 是惰性媒体物化：路由先完成去重与访问控制，只有通过之后才调用
   * 它下载/解密。被拒绝的 peer 与重复投递因此不会触发任何落盘或网络请求。
   */
  inbound(inbound: ImInbound, options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> }): Promise<void>
  /** 该会话的某一轮结束：把正文回给发起这一轮的那个 peer。 */
  finishTurn(sessionId: string, turn: number, events: readonly ImSessionEventLike[]): Promise<void>
  /**
   * 主动发一条文本给已绑定的 peer（`im_send` 的落点）。绑定存在性在这里再验
   * 一次：工具面只保证「绑到本会话」，路由保证「peer 真的有绑定」。
   */
  sendText(peerKey: string, text: string): Promise<ImSendReceipt>
  /** 主动发一条媒体（可选配文）；目标校验与 `sendText` 同一套。 */
  sendMedia(peerKey: string, media: ImOutboundMedia): Promise<ImSendReceipt>
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

  async function inbound(
    inboundMessage: ImInbound,
    options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> },
  ): Promise<void> {
    const now = deps.now()
    const peerKey = imPeerKey(inboundMessage.channel, inboundMessage.accountId, inboundMessage.scope, inboundMessage.peerId)
    const alias = imPeerAlias(inboundMessage.channel, inboundMessage.scope, peerKey)
    if (await deps.seenDedupe(inboundMessage.dedupeKey, now)) {
      deps.log?.note('debug', `ignored a duplicate ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias} (dedupe)`)
      return
    }
    const settings = await settingsOf()
    if (!imAccessAllows(settings, inboundMessage.scope, inboundMessage.peerId)) {
      deps.log?.note(
        'warn',
        `dropped a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias}: the access policy does not allow this peer (mode is allowlist and the peer is not listed, or the scope is disabled)`,
      )
      return
    }
    // 媒体只在通过访问控制之后才物化：白名单外的人不能靠附件让进程下载/解密/写盘。
    // 物化失败不能拖垮正文——去重条目已经记下，抛错等于让这条消息永远不再重投。
    let media: readonly ImMediaRef[] = inboundMessage.media
    if (options?.loadMedia !== undefined) {
      try {
        media = await options.loadMedia()
      } catch (error) {
        deps.log?.note(
          'warn',
          `media for a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias} failed to load; delivering it without local copies: ${messageOf(error)}`,
        )
      }
    }
    const message: ImInbound = media === inboundMessage.media ? inboundMessage : { ...inboundMessage, media }
    const target: ImTarget = {
      channel: message.channel,
      accountId: message.accountId,
      scope: message.scope,
      peerId: message.peerId,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    }
    const text = imUserTextOf(message)
    if (text === undefined) {
      deps.log?.note('debug', `ignored a ${message.channel}/${message.scope} message from ${alias}: no text and no attachments`)
      return
    }
    const binding = await resolveBinding(peerKey, message.scope, settings)
    if (binding === undefined) {
      await notifyUnbound(target, peerKey, alias, now)
      return
    }
    deps.log?.note(
      'info',
      `accepted a ${message.channel}/${message.scope} message from ${alias} (${text.length} chars) for session ${binding.sessionId}`,
    )
    const messageId = `im-${randomUUID()}`
    origins.remember(binding.sessionId, messageId, peerKey, target, now)
    try {
      await deps.followup(binding.sessionId, { id: messageId, text })
    } catch (error) {
      origins.forgetSession(binding.sessionId)
      deps.log?.note('error', `could not deliver a message from ${alias} to session ${binding.sessionId}: ${messageOf(error)}`)
      deps.logger?.warn?.(`dsh-soulmojito im: followup to ${binding.sessionId} failed: ${messageOf(error)}`)
      await sendNotice(target, IM_TURN_FAILED, alias)
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
    if (origin === undefined) {
      // 这是「发了没反应」最可能的落点：宿主这轮不是 IM 起的，或 id 对不上。
      deps.log?.note(
        'debug',
        `turn ${turn} of session ${sessionId} has no pending IM origin; no IM reply was sent`,
      )
      return
    }
    const alias = imPeerAlias(origin.target.channel, origin.target.scope, origin.peerKey)
    if (turnFailedOf(events, turn)) {
      deps.log?.note('warn', `turn ${turn} failed before a reply could be produced; sent the fixed notice to ${alias}`)
      await sendNotice(origin.target, IM_TURN_FAILED, alias)
      return
    }
    if (turnBlockedOf(events, turn)) {
      // 归档会话的 pre-step 拒绝：整轮没有发过任何请求，重试无用，必须说清方向。
      deps.log?.note('warn', `turn ${turn} was blocked by the host before any step ran (is the session archived?); sent the blocked notice to ${alias}`)
      await sendNotice(origin.target, IM_TURN_BLOCKED, alias)
      return
    }
    const text = assistantTextOfTurn(events, turn)
    // 空轮（只有工具调用、没有正文）不推 IM：用户看到一条空气比看到旧话更糟。
    if (text === undefined) {
      deps.log?.note('info', `turn ${turn} produced no assistant text; nothing was sent to ${alias}`)
      return
    }
    const settings = await settingsOf()
    const rendered = await deps.render(origin.target, text)
    const parts = projectImText(rendered, origin.target.channel, imChunkLimit(origin.target.channel, settings))
    try {
      await deps.send(origin.target, parts.map((part, index) => ({
        kind: 'text' as const,
        text: part,
        index,
        total: parts.length,
      })))
      deps.log?.note('info', `replied to ${alias} with ${parts.length} part(s), ${rendered.length} chars`)
    } catch (error) {
      deps.log?.note('error', `sending the reply to ${alias} failed: ${messageOf(error)}`)
      throw error
    }
  }

  async function sendText(peerKey: string, text: string): Promise<ImSendReceipt> {
    const body = text.trim()
    if (body === '') {
      throw new ImSendError('IM_SEND_INVALID', 'IM text is empty after trimming whitespace')
    }
    const { target, channel, scope, settings } = await sendTargetOf(peerKey)
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
      deps.log?.note('error', `im_send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`)
      throw new ImSendError('IM_SEND_FAILED', `IM send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`, { cause: error })
    }
    deps.log?.note('info', `im_send delivered ${chunks.length} part(s) to ${imPeerAlias(channel, scope, peerKey)}`)
    return { parts: chunks.length, at: deps.now() }
  }

  async function sendMedia(peerKey: string, media: ImOutboundMedia): Promise<ImSendReceipt> {
    if (media.localPath === undefined && media.url === undefined) {
      throw new ImSendError('IM_SEND_INVALID', 'media needs a localPath (preferred) or a url')
    }
    if (media.localPath !== undefined && media.localPath.trim() === '') {
      throw new ImSendError('IM_SEND_INVALID', 'media.localPath is blank; pass an absolute file path or omit it')
    }
    if (media.localPath !== undefined) await assertInsideWorkspace(media.localPath)
    const { target, channel, scope, settings } = await sendTargetOf(peerKey)
    const caption = media.caption?.trim() ?? ''
    // 配文也走按渠道的切分：微信 1800 的上限对 4000 字配文同样成立。
    const captionChunks = caption === ''
      ? []
      : projectImText(caption, channel, imChunkLimit(channel, settings))
    const parts: OutboundPart[] = captionChunks.map((text, index) => ({
      kind: 'text' as const,
      text,
      index,
      total: 1,
    }))
    parts.push({
      kind: media.kind,
      ...(media.localPath === undefined ? {} : { localPath: media.localPath }),
      ...(media.url === undefined ? {} : { url: media.url }),
      ...(media.name === undefined ? {} : { name: media.name }),
      index: parts.length,
      total: 1,
    })
    // total 必须先定下来再发：通道用 index/total 加序号，事后改不了。
    for (const part of parts) part.total = parts.length
    try {
      await deps.send(target, parts)
    } catch (error) {
      deps.log?.note('error', `im_send media to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`)
      throw new ImSendError('IM_SEND_FAILED', `IM media send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`, { cause: error })
    }
    deps.log?.note('info', `im_send delivered a ${media.kind} to ${imPeerAlias(channel, scope, peerKey)}`)
    return { parts: parts.length, at: deps.now() }
  }

  /**
   * 调用方给的 peerKey → 出站目标。绑定存在性每次都验：工具面只保证「绑到本
   * 会话」，路由保证「peer 真的有绑定」。
   */
  async function sendTargetOf(peerKey: string): Promise<{
    target: ImTarget
    channel: ImChannelId
    scope: ImScope
    settings: ImSettings
  }> {
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
      throw new ImSendError('IM_SEND_UNBOUND', `IM peer '${peerKey}' has no binding; bind it in the dsh-soulmojito IM panel first`)
    }
    return {
      target: {
        channel,
        accountId: parts.accountId,
        scope,
        peerId: parts.peerId,
      },
      channel,
      scope,
      settings: state.imSettings ?? DEFAULT_IM_SETTINGS,
    }
  }

  /**
   * 媒体路径必须落在内部工作区内：模型不能把密钥、聊天记录或用户任意文件当
   * 附件发出去（群里的陌生人可以诱导它这么做）。realpath 同时挡住符号链接逃逸。
   */
  async function assertInsideWorkspace(localPath: string): Promise<void> {
    if (deps.workspaceRoot === undefined) return
    let root: string
    let target: string
    try {
      root = await realpath(await deps.workspaceRoot())
      target = await realpath(localPath)
    } catch (cause) {
      throw new ImSendError('IM_SEND_INVALID', `media path '${localPath}' cannot be resolved: ${messageOf(cause)}`)
    }
    const rel = relative(root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ImSendError(
        'IM_SEND_INVALID',
        `media path '${localPath}' is outside the session workspace; only files under the workspace (for example downloaded attachments) can be sent`,
      )
    }
  }

  async function notifyUnbound(target: ImTarget, peerKey: string, alias: string, now: number): Promise<void> {
    const last = noticed.get(peerKey)
    if (last !== undefined && now - last < UNBOUND_NOTICE_TTL_MS) {
      deps.log?.note('debug', `no binding for ${alias}; the bind notice is still suppressed`)
      return
    }
    noticed.set(peerKey, now)
    deps.log?.note('info', `no binding for ${alias}; replied with the bind notice`)
    await sendNotice(target, imUnboundMessage(peerKey), alias)
  }

  async function sendNotice(target: ImTarget, text: string, alias: string): Promise<void> {
    try {
      await deps.send(target, [{ kind: 'text', text, index: 0, total: 1 }])
    } catch (error) {
      // 只写日志环一条：`deps.logger` 本身就是同一个 sink 的镜像，写两次会重复。
      deps.log?.note('error', `sending a notice to ${alias} failed: ${messageOf(error)}`)
    }
  }

  return {
    inbound,
    finishTurn,
    sendText,
    sendMedia,
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

/**
 * 附件摘要：本地路径必须进正文——模型只有看到路径才能用文件工具打开它。远程
 * 地址只说明「未下载」，不把 URL 塞进上下文（既不可取用，也会被复述出去）。
 */
function attachmentSummaryOf(inbound: ImInbound): string | undefined {
  if (inbound.media.length === 0) return undefined
  const labels = inbound.media.slice(0, 6).map((media) => {
    const label = media.kind === 'image' ? '图片' : media.kind === 'voice' ? '语音' : media.kind === 'video' ? '视频' : '文件'
    if (media.localPath !== undefined) return `${label}（${media.localPath}）`
    if (media.url !== undefined) return `${label}（未下载）`
    return label
  })
  const rest = inbound.media.length > labels.length ? `等 ${inbound.media.length} 个` : ''
  return `（附件：${labels.join('、')}${rest}）`
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
