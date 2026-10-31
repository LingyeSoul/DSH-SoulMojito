/**
 * 入站路由（提案 0024 §3.8 / 决策 2026-10-31-im-native-session-binding）：
 * 去重 → 白名单 → 绑定 → **立即**插进绑定的原生 DSH 会话。
 *
 * 这里刻意没有队列、没有 debounce、没有「等人说完」：宿主 AgentLoop 自己收
 * inbox，插件再攒一层只会让「立即投递」变成一句空话。唯一的时间维度是去重与
 * 未绑定提示的抑制窗口。
 *
 * 绑定缺失时：把 peer 记进 `imPendingPeers`（面板「未绑定对端」待办）并回一条
 * 提示，**不代建会话**。回复也不由插件自动发——入站消息以插件来源插入会话后，
 * 由模型调用 `im_send` 自己回复（决策 2026-10-31-im-native-session-binding）。
 *
 * 所有宿主能力都从 deps 进来，路由本身不认识 ctx、不认识协议。
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostLogger } from '../host-contract.js'
import { projectImText } from './project.js'
import { imAccessAllows, imChunkLimit } from './settings.js'
import type { ImLogSink } from './log.js'
import type { ImChannelId, ImInbound, ImMediaRef, ImOutboundMedia, ImScope, ImSendReceipt, ImSettings, ImTarget, OutboundPart } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey, imPeerKeyParts } from './types.js'

/** 未绑定提示：对端只知道「没绑上」，具体绑定发生在 DSH 面板。 */
export const IM_UNBOUND_NOTICE = '（消息已收到，但这个对端还没有绑定 DSH 会话；请在 dsh-soulmojito 的 IM 面板把它绑到一个会话）'

/** 会话不在线时的提示：不装作插入成功，也不反复重试。 */
export const IM_SESSION_NOT_LIVE = '（消息已收到，但绑定的 DSH 会话当前不可投递（未打开或不是 AgentLoop 会话）；请打开它或改绑后再发一次）'

/** 其它插入失败（inbox/日志写入等）：别让对端按「未打开」的提示做无效重试。 */
export const IM_DELIVERY_FAILED = '（消息已收到，但插入绑定的 DSH 会话失败；请稍后再发一次）'

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

/** 被动回复锚点的有效期：平台消息的被动回复窗口远短于此，过期就不带。 */
const REPLY_ANCHOR_TTL_MS = 5 * 60_000

/** 面板待办上限：只留最近 50 个未绑定对端，防止陌生人群刷爆 state。 */
const MAX_PENDING_PEERS = 50

export interface ImAgentMessage {
  id: string
  text: string
  /** 宿主消息来源的一行摘要（`source.summary`），不含正文与平台身份。 */
  summary: string
}

export interface ImRouterDeps {
  db: TavernStore
  now: () => number
  /** true = 这条消息已经投递过（平台重连会补发同一条）。 */
  seenDedupe: (dedupeKey: string, now: number) => Promise<boolean>
  /**
   * 把一条插件来源的消息立即插进绑定会话的 inbox。会话不在线时必须抛错
   * （路由据此回 `IM_SESSION_NOT_LIVE`，不假装成功）。
   */
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
  /**
   * 主动发一条文本给已绑定的 peer（`im_send` 的落点）。绑定存在性在这里再验
   * 一次：工具面只保证「绑到本会话」，路由保证「peer 真的有绑定」。
   */
  sendText(peerKey: string, text: string): Promise<ImSendReceipt>
  /** 主动发一条媒体（可选配文）；目标校验与 `sendText` 同一套。 */
  sendMedia(peerKey: string, media: ImOutboundMedia): Promise<ImSendReceipt>
}

export function createImRouter(deps: ImRouterDeps): ImRouter {
  const noticed = new Map<string, number>()
  /**
   * 被动回复锚点：QQ 的被动回复必须带回触发消息的 `msg_id`，否则只能走主动推送
   * （官方机器人对主动消息有权限/时效限制）。模型只看到 alias，不需要知道平台
   * 消息 id；路由在入站时记下最近一条，`im_send` 出站时自动带上。
   */
  const replyAnchors = new Map<string, { replyTo: string; at: number }>()

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
    const target: ImTarget = {
      channel: inboundMessage.channel,
      accountId: inboundMessage.accountId,
      scope: inboundMessage.scope,
      peerId: inboundMessage.peerId,
      ...(inboundMessage.replyTo === undefined ? {} : { replyTo: inboundMessage.replyTo }),
    }
    const binding = await boundSessionOf(peerKey)
    if (binding === undefined) {
      // 未绑定：不代建会话，也不为陌生人下载/解密/落盘附件。用占位 ref 生成摘要，
      // 记进面板待办并回一条固定提示；正文不落 state。
      const unboundBody = imUserTextOf(inboundMessage)
      if (unboundBody === undefined) {
        deps.log?.note('debug', `ignored a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias}: no text and no attachments`)
        return
      }
      await rememberPendingPeer(peerKey, inboundMessage, alias, now)
      await notifyUnbound(target, peerKey, alias, now)
      return
    }
    // 媒体只在通过访问控制**且已绑定**之后才物化：白名单外的人与未绑定对端
    // 都不能靠附件让进程下载/解密/写盘。物化失败不拖垮正文——去重条目已经记下，
    // 抛错等于让这条消息永远不再重投。
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
    // 记下被动回复锚点：模型随后调用 im_send 时，QQ 才能把回复挂到这条消息上。
    if (message.replyTo !== undefined) replyAnchors.set(peerKey, { replyTo: message.replyTo, at: now })
    const body = imUserTextOf(message)
    if (body === undefined) {
      deps.log?.note('debug', `ignored a ${message.channel}/${message.scope} message from ${alias}: no text and no attachments`)
      return
    }
    const text = relayTextOf(message, body, alias)
    deps.log?.note(
      'info',
      `accepted a ${message.channel}/${message.scope} message from ${alias} (${body.length} chars) for session ${binding.sessionId}`,
    )
    const messageId = `im-${randomUUID()}`
    try {
      // 与小说驱动器同一种插入方式：插件来源消息 + followup，宿主 loop 自己排轮。
      await deps.followup(binding.sessionId, {
        id: messageId,
        text,
        summary: `IM ${message.channel}/${message.scope} message from ${alias}`,
      })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      deps.log?.note('error', `could not insert a message from ${alias} into session ${binding.sessionId}: ${messageOf(error)}`)
      deps.logger?.warn?.(`dsh-soulmojito im: inserting into ${binding.sessionId} failed: ${messageOf(error)}`)
      await sendNotice(target, code === 'IM_SESSION_NOT_LIVE' ? IM_SESSION_NOT_LIVE : IM_DELIVERY_FAILED, alias)
      return
    }
    deps.log?.note('debug', `inserted an IM message from ${alias} into session ${binding.sessionId} (${messageId})`)
  }

  /**
   * 绑定只按原生会话 id 解析；没有自动绑定。旧版 `character/chatId` 绑定
   * 在 store 归一化时已降级成 sessionId，行为与手动绑定一致。
   */
  async function boundSessionOf(peerKey: string): Promise<{ sessionId: string } | undefined> {
    const state = await deps.db.getState()
    const binding = state.imPeers?.[peerKey]
    return binding === undefined ? undefined : { sessionId: binding.sessionId }
  }

  /**
   * 未绑定待办：只记时间与平台显示名（绝不把 openid 前缀当名字）。
   * 每次写入按 lastAt 裁剪到最近 50 条，陌生人群刷不爆 state。
   */
  async function rememberPendingPeer(
    peerKey: string,
    message: ImInbound,
    alias: string,
    now: number,
  ): Promise<void> {
    const senderName = message.scope === 'group' ? displaySenderNameOf(message) : undefined
    const next = await deps.db.updateState((current) => {
      // 绑定可能在本条入站读到「没有绑定」之后、写 pending 之前完成；此时以绑定为准，
      // 不再长出一条同 key 的待办。
      if (current.imPeers?.[peerKey] !== undefined) return {}
      const pending = { ...(current.imPendingPeers ?? {}) }
      pending[peerKey] = {
        lastAt: now,
        ...(senderName === undefined ? {} : { senderName }),
      }
      const recent = Object.entries(pending)
        .sort((left, right) => right[1].lastAt - left[1].lastAt)
        .slice(0, MAX_PENDING_PEERS)
      return { imPendingPeers: Object.fromEntries(recent) }
    })
    if (next.imPeers?.[peerKey] !== undefined) {
      deps.log?.note('debug', `binding for ${alias} appeared before the pending write; pending not recorded`)
      return
    }
    deps.log?.note('info', `no binding for ${alias}; recorded it in the IM panel pending peers`)
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
    const anchor = replyAnchors.get(peerKey)
    const fresh = anchor !== undefined && deps.now() - anchor.at <= REPLY_ANCHOR_TTL_MS
    if (anchor !== undefined && !fresh) replyAnchors.delete(peerKey)
    return {
      target: {
        channel,
        accountId: parts.accountId,
        scope,
        peerId: parts.peerId,
        ...(fresh ? { replyTo: anchor.replyTo } : {}),
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
    await sendNotice(target, IM_UNBOUND_NOTICE, alias)
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
    sendText,
    sendMedia,
  }
}

/**
 * 入站正文 → 插进会话的插件来源消息正文。
 *
 * 头部给模型三件事：这是 IM 消息不是 DSH 用户输入、来源渠道与范围、回复要用
 * 哪个 peer alias。群聊的发言人前缀由 `imUserTextOf` 提供。
 */
export function relayTextOf(inbound: ImInbound, body: string, alias: string): string {
  const scope = inbound.scope === 'group' ? '群聊' : '私聊'
  return [
    `[IM ${inbound.channel}/${scope} peer=${alias}]`,
    body,
    `（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${alias}。）`,
  ].join('\n')
}

/**
 * 入站文本 → 会话里的一条用户消息。
 *
 * 群聊必须带发言人前缀：一个会话里可能有多个人说话，模型只能从文本看出「这是
 * 另一个人说的」。私聊不加前缀，避免每句话都被名字噪声切碎。
 */
export function imUserTextOf(inbound: ImInbound): string | undefined {
  const body = inbound.text.trim()
  const attachments = attachmentSummaryOf(inbound)
  const composed = inbound.scope === 'group'
    ? `[${displaySenderNameOf(inbound) ?? '群成员'}] ${body}`.trim()
    : body
  const withAttachments = attachments === undefined
    ? composed
    : `${composed}${composed === '' ? '' : '\n'}${attachments}`.trim()
  return withAttachments === '' ? undefined : withAttachments
}

/**
 * 平台显示名：QQ 群成员昵称、OneBot 名片等是安全可读的；私聊/C2C 的
 * `senderName` 常是 openid 前缀，不能当名字用——此时宁可缺省。
 */
function displaySenderNameOf(inbound: ImInbound): string | undefined {
  const name = inbound.senderName.trim()
  if (name === '') return undefined
  const id = inbound.senderId.trim()
  if (id.startsWith(name)) return undefined
  return name
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** peerKey 的渠道段只认三条真实通道；其余值说明绑定键被手改坏了。 */
function channelOf(value: string): ImChannelId | undefined {
  return value === 'qq' || value === 'weixin' || value === 'onebot' ? value : undefined
}
