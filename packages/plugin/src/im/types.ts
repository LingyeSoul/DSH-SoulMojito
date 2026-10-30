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

import type { ImScope } from '../../../tavern-store/src/index.js'

export type { ImAccessMode, ImBindingMode, ImChatRef, ImPeerBinding, ImScope, ImSettings } from '../../../tavern-store/src/index.js'
export { DEFAULT_IM_SETTINGS, imPeerKey } from '../../../tavern-store/src/index.js'

export type ImChannelId = 'qq' | 'weixin' | 'onebot'

export interface ImMediaRef {
  kind: 'image' | 'voice' | 'video' | 'file'
  /** Remote URL as reported by the platform (never fetched by the router). */
  url?: string
  /** Local path when the adapter already downloaded the asset. */
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
export interface OutboundPart {
  kind: 'text'
  text: string
  /** 0-based part index and total count, so adapters can add sequence numbers. */
  index: number
  total: number
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
