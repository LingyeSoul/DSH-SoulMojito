/**
 * IM channel contracts (proposal 0024).
 *
 * This module is the only shared vocabulary between the protocol adapters
 * (`im/<channel>/`) and the channel-agnostic router. Adapters must not import
 * Tavern or generation modules: everything they need to know about a peer is
 * in `ImInbound`, and everything they may send back is in `OutboundPart`.
 *
 * Persisted shapes (settings, peer bindings) live in tavern-store
 * (`im-state.ts`) and are re-exported here so callers have one import site.
 */

import { createHash } from 'node:crypto'
import type { ImScope } from '../../../tavern-store/src/index.js'

export type { ImAccessMode, ImPeerBinding, ImPendingPeer, ImScope, ImSettings } from '../../../tavern-store/src/index.js'
export { DEFAULT_IM_SETTINGS, imPeerKey } from '../../../tavern-store/src/index.js'

export type ImChannelId = 'qq' | 'weixin' | 'onebot'

/** AgentTavernIM preset id declared by `cordis.patch.yml` (`preset-agent-tavern-im`). */
export const AGENT_TAVERN_IM_PRESET_ID = 'agent-tavern-im'

export type ImMediaKind = 'image' | 'voice' | 'video' | 'file'

export interface ImMediaRef {
  kind: ImMediaKind
  /** Remote URL as reported by the platform (never fetched by the router). */
  url?: string
  /** Local path when the adapter already downloaded and decrypted the asset. */
  localPath?: string
  name?: string
  /** Bytes, when the platform reports it. */
  size?: number
  /** Speech-to-text transcript for voice items. */
  transcript?: string
}

/**
 * One normalized inbound message.
 *
 * `peerId` identifies the conversation (a private user, or a group); `senderId`
 * identifies who actually spoke. They differ in group scope.
 */
export interface ImInbound {
  channel: ImChannelId
  accountId: string
  scope: ImScope
  peerId: string
  peerName?: string
  senderId: string
  senderName: string
  text: string
  media: readonly ImMediaRef[]
  /** Platform message id this message replies to, when the platform says so. */
  replyTo?: string
  /** `channel:account:messageId`; the dedupe log keeps it for 24h. */
  dedupeKey: string
  receivedAt: number
  /** 平台事件时间（毫秒），协议提供时才带上；只用于同一 peer 批次内的排序（决策 2026-10-31-im-inbound-coalescing）。 */
  platformAt?: number
}

/** Where an outbound message goes. `replyTo` is the passive-reply anchor. */
export interface ImTarget {
  channel: ImChannelId
  accountId: string
  scope: ImScope
  peerId: string
  replyTo?: string
}

/** One already-split outbound text part. Splitting happens in `project.ts`. */
export interface OutboundTextPart {
  kind: 'text'
  text: string
  /** 0-based part index and total count, so adapters can add sequence numbers. */
  index: number
  total: number
}

/**
 * One outbound media item.
 *
 * `localPath` is preferred: the adapter reads a local file instead of trusting a
 * remote URL (WeChat and QQ upload from bytes anyway). `caption` is sent before
 * the media when the platform supports it.
 */
export interface OutboundMediaPart {
  kind: ImMediaKind
  localPath?: string
  url?: string
  name?: string
  caption?: string
  index: number
  total: number
}

export type OutboundPart = OutboundTextPart | OutboundMediaPart

/** 主动发送的媒体描述（工具面 → 路由）；`localPath` 优先于 `url`。 */
export interface ImOutboundMedia {
  kind: ImMediaKind
  localPath?: string
  url?: string
  name?: string
  caption?: string
}

export interface ImSendReceipt {
  /** Platform message id of the last part, when the adapter knows it. */
  messageId?: string
  parts: number
  at: number
}

export type ImChannelStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'online'; since: number }
  | { state: 'paused'; reason: string; until?: number }
  | { state: 'error'; message: string }

/** 扫码绑定的相位（提案 0024 §4.1）：面板只读投影，协议跑在插件侧。 */
export type ImBindPhase = 'idle' | 'waiting' | 'verify' | 'saving' | 'failed'

export interface ImBindStatus {
  phase: ImBindPhase
  /** `waiting` 相位里二维码内容就绪后出现；刷新二维码时会被清掉。 */
  url?: string
  /**
   * `waiting` 相位里服务端渲染好的二维码图片（`data:image/svg+xml;base64,...`）。
   *
   * 为什么必须由服务端给：平台返回的 `url` 是**扫码器要编码的内容**，不是图片
   * 地址——面板直接把它塞进 `<img src>` 只会得到一张破图（2026-10-30 实机）。
   */
  qrSvg?: string
  /** `verify` 相位给用户的提示（微信 `need_verifycode`）。 */
  prompt?: string
  /** `failed` 相位的可读原因。 */
  reason?: string
}

/** A protocol adapter. Lifecycle is owned by `im/runtime.ts`. */
export interface ImChannel {
  readonly channel: ImChannelId
  readonly accountId: string
  /** Connect; rejects on failure (no silent retry loops inside the adapter). */
  start(signal: AbortSignal): Promise<void>
  /** Close sockets, abort polls, release upgrade routes. Idempotent. */
  stop(): Promise<void>
  status(): ImChannelStatus
  send(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt>
}

/** One account of one channel; secrets live outside this file. */
export interface ImAccountRef {
  channel: ImChannelId
  accountId: string
  label?: string
  createdAt: string
}

/** Panel projection of one channel/account pair. Never carries secrets. */
export interface ImChannelView {
  channel: ImChannelId
  accountId: string
  label?: string
  status: ImChannelStatus
  peers: number
}

/**
 * Stable dedupe key; platform retries and reconnects replay the same id.
 *
 * scope/peerId 必须进键：platform 的 `message_id` 只在单个会话内唯一，两个群
 * 恰好撞号时，缺这两段的键会把后到的一条当重放丢掉（审查 P2-2）。
 */
export function imDedupeKey(
  channel: ImChannelId,
  accountId: string,
  scope: ImScope,
  peerId: string,
  messageId: string,
): string {
  return `${channel}:${accountId}:${scope}:${peerId}:${messageId}`
}

/** Reverse of `imPeerKey`, for panel display only. */
export function imPeerKeyParts(key: string): { channel: string; accountId: string; scope: string; peerId: string } | undefined {
  const parts = key.split(':')
  if (parts.length < 4) return undefined
  const [channel, accountId, scope, ...rest] = parts
  if (channel === undefined || accountId === undefined || scope === undefined) return undefined
  return { channel, accountId, scope, peerId: rest.join(':') }
}

/**
 * 稳定别名：同一 peer 的 alias 跨重启不变，模型可以在多轮里复用；哈希让 openid
 * 永远不出现在上下文与日志里。channel + scope 进哈希，避免不同渠道同名 id 撞车。
 */
export function imPeerAlias(channel: string, scope: string, peerKey: string): string {
  return `peer-${createHash('sha256').update(`${channel}:${scope}:${peerKey}`).digest('hex').slice(0, 10)}`
}
