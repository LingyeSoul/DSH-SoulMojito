/**
 * QQ 出站投递规划（提案 0024 §2.1 / M3·M5）。
 *
 * 从 `channel.ts` 抽出：群聊只对**纯文字**整批重切（媒体与文字混排会打乱
 * 「说明 → 媒体」的配对顺序），重切把所有内容留在平台的四格被动回复额度内；
 * 超出额度时尾巴只能主动推送，用 `overflow` 告知调用方并 warn。
 */

import { IM_CHUNK_DEFAULTS } from '../settings.js'
import type { ImScope, OutboundMediaPart, OutboundPart, OutboundTextPart } from '../types.js'

/** 同一条触发消息的被动回复上限；平台口径是 4 条，第 5 条起降级主动推送。 */
export const PASSIVE_REPLY_LIMIT = 4
/** 单段上限：与项目切分默认值同源（QQ 4500）。 */
const GROUP_PART_MAX_CHARS = IM_CHUNK_DEFAULTS['qq']

/* ----------------------------- 出站投递规划 ----------------------------- */

/** 一次平台调用：文字（含媒体说明）或媒体本身。 */
interface QqTextDelivery {
  readonly kind: 'text'
  readonly text: string
  readonly index: number
  readonly total: number
}

interface QqMediaDelivery {
  readonly kind: 'media'
  readonly part: OutboundMediaPart
}

type QqDelivery = QqTextDelivery | QqMediaDelivery

interface QqDeliveryPlan {
  readonly deliveries: readonly QqDelivery[]
  /** 群聊长文超出 4 片被动额度：尾巴只能主动推送（已 warn，不丢内容）。 */
  readonly overflow: boolean
}

/** 群聊多段投递的重切片计划。 */
export interface GroupPartPlan {
  readonly parts: string[]
  readonly overflow: boolean
}

/**
 * 群聊多段投递的切片计划（纯函数）。
 *
 * - ≤4 片：原样返回——短回复与私聊链路都不该被重切。
 * - >4 片且总字数 ≤ 4 × maxCharsPerPart：按 `ceil(total/4)` 重切成 ≤4 片，
 *   全部落在平台的被动回复额度内。
 * - >4 片且装不下：按 maxCharsPerPart 切满前 4 片（被动前缀），其余片交给
 *   调用方降级成主动推送——**绝不丢内容**，只把结论标进 `overflow`。
 *
 * 切点不拆代理对（emoji 等增补平面字符占两个 code unit，切开会渲染成替换符）；
 * 空文本返回空计划：没有内容就没有可发的消息。
 */
export function planGroupParts(texts: readonly string[], maxCharsPerPart: number): GroupPartPlan {
  if (texts.length <= PASSIVE_REPLY_LIMIT) return { parts: [...texts], overflow: false }
  const width = Math.max(1, Math.floor(maxCharsPerPart))
  // 原片已是一段段独立文本（projectImText 逐片 trim），必须用空行重新粘起来再切；
  // join('') 会把段落和代码块边界直接吃掉。
  const joined = texts.join('\n\n')
  if (joined === '') return { parts: [], overflow: false }
  const overflow = joined.length > width * PASSIVE_REPLY_LIMIT
  const chunkWidth = overflow ? width : Math.max(1, Math.ceil(joined.length / PASSIVE_REPLY_LIMIT))
  return { parts: qqChunkText(joined, chunkWidth), overflow }
}

/**
 * 按 code unit 切分，只在代理对边界处**向后扩一格**；宽度 1 撞上代理对时整对
 * 保留。扩而不缩：缩一格会让下一片多吃一个 code unit，片数就可能超 4；宽一个
 * code unit 对字符上限无害（上限本身留了余量）。
 */
function qqChunkText(text: string, width: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + width)
    if (end < text.length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
      end += 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 出站 parts → 平台调用序列；媒体的 caption 先单发一条文字，顺序固定。 */
export function planDeliveries(scope: ImScope, parts: readonly OutboundPart[]): QqDeliveryPlan {
  const planned = scope === 'group' ? planGroupDelivery(parts) : { parts, overflow: false }
  const deliveries: QqDelivery[] = []
  for (const part of planned.parts) {
    if (part.kind === 'text') {
      deliveries.push({ kind: 'text', text: part.text, index: part.index, total: part.total })
      continue
    }
    const caption = nonEmpty(part.caption)
    if (caption !== undefined) deliveries.push({ kind: 'text', text: caption, index: part.index, total: part.total })
    deliveries.push({ kind: 'media', part })
  }
  return { deliveries, overflow: planned.overflow }
}

/**
 * 群聊才重切，且只在**纯文字**整批上重切：媒体与文字混排时重切会打乱
 * 「说明 → 媒体」的配对顺序，这种批次按原片序发送（被动额度仍由主循环记账）。
 */
function planGroupDelivery(parts: readonly OutboundPart[]): { parts: readonly OutboundPart[]; overflow: boolean } {
  const texts: string[] = []
  for (const part of parts) {
    if (part.kind !== 'text') return { parts, overflow: false }
    texts.push(part.text)
  }
  const plan = planGroupParts(texts, GROUP_PART_MAX_CHARS)
  if (plan.parts.length === texts.length) return { parts, overflow: plan.overflow }
  return {
    parts: plan.parts.map((text, index): OutboundTextPart => ({ kind: 'text', text, index, total: plan.parts.length })),
    overflow: plan.overflow,
  }
}

/** 空白即「没有」：平台字段可能给了空串，不能当有效值。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
