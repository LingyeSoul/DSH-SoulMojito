/**
 * QQ 入站附件归一（提案 0024 §2.1 / M5）。
 *
 * 从 `channel.ts` 抽出：SDK 1.0.5 把平台事件的 `attachments` 归一进 `InboundMessage`，
 * 手写载荷或旧 build 只在 `raw.attachments` 上带同名数组，两处都认。这里只做形状
 * 归一（URL/大小/文件名/语音转录），下载由路由在通过访问控制后触发。
 */

import type { ImMediaKind, ImMediaRef } from '../types.js'
import type { QqInboundAttachment, QqInboundMessage } from './sdk.js'

/* ------------------------------- 入站媒体 ------------------------------- */

/**
 * 附件来源：SDK 1.0.5 把平台事件里的 `attachments` 归一进 `InboundMessage`
 * （d.ts 的 `InboundAttachment`）；手写载荷或旧 build 只在 `raw.attachments`
 * 上带同名数组，这里两处都认。两处都没有就是没有附件。
 */
export function qqAttachmentsOf(msg: QqInboundMessage): readonly QqInboundAttachment[] {
  if (msg.attachments !== undefined) return Array.isArray(msg.attachments) ? msg.attachments : []
  const raw = msg.raw
  if (typeof raw !== 'object' || raw === null) return []
  const attachments = (raw as { attachments?: unknown }).attachments
  return Array.isArray(attachments) ? attachments as readonly QqInboundAttachment[] : []
}

export function qqMediaOfAttachments(attachments: readonly QqInboundAttachment[]): ImMediaRef[] {
  const media: ImMediaRef[] = []
  for (const attachment of attachments) {
    const ref = qqMediaRefOf(attachment)
    if (ref !== undefined) media.push(ref)
  }
  return media
}

export function qqMediaRefOf(attachment: QqInboundAttachment): ImMediaRef | undefined {
  const kind = qqMediaKindOf(attachment.content_type)
  // 语音优先 wav 直链：`url` 可能是 silk 原始流，本仓库没有 silk 解码。
  const url = kind === 'voice'
    ? nonEmpty(attachment.voice_wav_url) ?? nonEmpty(attachment.url)
    : nonEmpty(attachment.url)
  // 没直链就没有可交付的东西：拿不到实体时只能丢，不能伪造路径。
  if (url === undefined) return undefined
  const name = nonEmpty(attachment.filename)
  const size = typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0
    ? Math.round(attachment.size)
    : undefined
  const transcript = nonEmpty(attachment.asr_refer_text)
  return {
    kind,
    url,
    ...(name === undefined ? {} : { name }),
    ...(size === undefined ? {} : { size }),
    ...(transcript === undefined ? {} : { transcript }),
  }
}

/** 语音附件的平台识别文本；多条按行拼接，进正文供模型直接阅读。 */
export function qqTranscriptsOf(attachments: readonly QqInboundAttachment[]): string {
  const lines: string[] = []
  for (const attachment of attachments) {
    const text = nonEmpty(attachment.asr_refer_text)
    if (text !== undefined) lines.push(text)
  }
  return lines.join('\n')
}

/** 平台 `content_type` → ImMediaKind；未知类型按文件交付（保守，不丢附件）。 */
export function qqMediaKindOf(contentType: string): ImMediaKind {
  const type = typeof contentType === 'string' ? contentType.trim().toLowerCase() : ''
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/') || type.startsWith('voice/') || type === 'voice') return 'voice'
  return 'file'
}

/** 空白即「没有」：平台字段可能给了空串，不能当有效值。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
