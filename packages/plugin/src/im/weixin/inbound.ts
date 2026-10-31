/**
 * 微信入站消息的纯归一（提案 0024 §2.2 / M4）。
 *
 * 拆分边界：`channel.ts` 保留连接与状态——长轮询、`get_updates_buf` 游标、
 * `context_token` 记账、typing、出站串行链与 `materializeMedia`（依赖
 * `cdnBaseUrl` / 运行期 controller / media store）；本文件只放「一条平台消息 →
 * 一条 `ImInbound`」的纯映射：`message_type` 与群消息过滤、正文组装、媒体占位源、
 * 去重键、缺 `message_id` 时的内容指纹与昵称兜底。
 *
 * 这里不读实例状态、不产生副作用：`now`（通道时钟的当前值）由调用方传入；
 * 被忽略消息的 debug 日志由通道按 `reason` 原样补记，日志与账号前缀属于连接侧。
 */

import { createHash } from 'node:crypto'
import { imDedupeKey, type ImInbound } from '../types.js'
import type { WeixinMessage } from './api.js'
import { WeixinChannelError } from './errors.js'
import type { WeixinInboundMediaSource } from './media.js'

/** 昵称兜底：协议不给显示名，用 from_user_id 前几位给模型一个稳定标签。 */
const PEER_LABEL_LENGTH = 8
/** 无 `message_id` 时内容指纹的时间桶：同一桶内的相同内容视为重放。 */
const WEIXIN_FALLBACK_DEDUPE_BUCKET_MS = 10 * 60 * 1_000

/** 一条平台消息的归一结果：可投递的 `ImInbound` 与待物化媒体源，或按协议忽略的原因。 */
export type WeixinInboundOutcome =
  | {
    readonly kind: 'delivered'
    readonly inbound: ImInbound
    readonly sources: readonly WeixinInboundMediaSource[]
  }
  | {
    readonly kind: 'ignored'
    /** `message-type`：`message_type === 2`（机器人自己的回显）；`group`：带 `group_id` 的群消息。 */
    readonly reason: 'message-type' | 'group'
  }

/**
 * 单条消息 → `ImInbound` + 待物化的媒体源，或被忽略的原因。`message_type === 2`
 * 与带 `group_id` 的群消息按协议主动忽略；正文取 text_item，没有正文时用语音转录。
 * 这里**不下载**附件：下载由路由在通过访问控制后触发。
 */
export function weixinInboundOf(message: WeixinMessage, accountId: string, now: number): WeixinInboundOutcome {
  if (message.messageType === 2) return { kind: 'ignored', reason: 'message-type' }
  // 协议层有 group_id 不等于功能支持：本轮只做私聊（提案 §1）。
  if (message.groupId !== undefined) return { kind: 'ignored', reason: 'group' }
  const peerId = message.fromUserId?.trim() ?? ''
  if (peerId === '') {
    throw new WeixinChannelError(
      'WEIXIN_BAD_MESSAGE',
      `weixin account '${accountId}' got a message without from_user_id; it cannot be routed to any peer`,
    )
  }
  const textParts: string[] = []
  const voiceParts: string[] = []
  const mediaSources: WeixinInboundMediaSource[] = []
  for (const item of message.items) {
    if (item.type === 1 && item.text !== undefined) {
      textParts.push(item.text)
      continue
    }
    if (item.type === 3) {
      if (item.voiceText !== undefined) {
        voiceParts.push(item.voiceText)
        continue
      }
      mediaSources.push({ kind: 'voice', item })
      continue
    }
    if (item.type === 2 || item.type === 4 || item.type === 5) {
      mediaSources.push({ kind: item.type === 2 ? 'image' : item.type === 4 ? 'file' : 'video', item })
    }
  }
  const text = textParts.length > 0 ? textParts.join('\n') : voiceParts.join('\n')
  const messageId = message.messageId
  const receivedAt = now
  return {
    kind: 'delivered',
    inbound: {
      channel: 'weixin',
      accountId,
      scope: 'private',
      peerId,
      senderId: peerId,
      senderName: peerId.slice(0, PEER_LABEL_LENGTH),
      text,
      // 占位 ref 保留在摘要里；物化成功后由 loadMedia 换成带 localPath 的版本。
      media: mediaSources.map((source) => ({ kind: source.kind })),
      // 平台不给 message_id 时改用内容指纹：随机 UUID 每次重放都换键，24h 去重日志
      // 永远挡不住重放。代价：平台既不给 id 也不给时间戳，同一 10 分钟桶内的相同内容
      // 会被当成重放丢弃（后到的那条被吞）；跨桶到来的重放仍可能重复投递。
      dedupeKey: imDedupeKey('weixin', accountId, 'private', peerId, messageId ?? fallbackMessageId(message, receivedAt)),
      receivedAt,
    },
    sources: mediaSources,
  }
}

/**
 * 平台缺 `message_id` 时的确定性降级 id：同一份平台身份 + 内容 + 时间桶 → 同一个键。
 *
 * 只收平台身份与消息内容：游标与序号会随重放变化，`context_token` 是按对端记账的
 * 会话能力不是消息身份，两者都不能进指纹。
 *
 * 代价必须写明：内容指纹无法区分「两条真正相同的消息」，所以再带上由 `receivedAt`
 * 推出的 10 分钟桶——**同一桶内两条真正相同的内容会被判成重放，后到的那条被 24h
 * 去重日志吞掉**；反过来，跨桶到来的重放又可能重复投递。两个方向都做不完美。
 */
function fallbackMessageId(message: WeixinMessage, receivedAt: number): string {
  const bucket = Math.floor(receivedAt / WEIXIN_FALLBACK_DEDUPE_BUCKET_MS)
  // 数组固定字段顺序：对象键序与 undefined 的序列化差异会让同一内容算出不同哈希。
  const canonical = JSON.stringify([
    message.fromUserId ?? null,
    message.messageType ?? null,
    message.groupId ?? null,
    message.items.map((item) => [
      item.type,
      item.text ?? null,
      item.voiceText ?? null,
      item.mediaUrl ?? null,
      item.fullUrl ?? null,
      item.encryptQueryParam ?? null,
      item.thumbUrl ?? null,
      item.aesKeyHex ?? null,
      item.aesKey ?? null,
      item.fileName ?? null,
      item.size ?? null,
    ]),
    bucket,
  ])
  return `fallback-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}