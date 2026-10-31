/**
 * 入站 → 会话 relay 文本（决策 2026-10-31-im-owner-designation /
 * 2026-10-31-im-inbound-coalescing / 2026-10-31-im-message-refs）。
 *
 * 纯函数模块：只拼别人已经验证过的正文，不碰 db、定时器与协议。`router.ts` 负责
 * 去重/访问控制/绑定/媒体物化，这里只决定模型看到的头部、发言人行与附件摘要。
 *
 * 隐私纪律：头部只带 `peer` alias、`msg-` 引用与时间，不带平台身份；主人标记
 * 是唯一新增的身份语义，且**权威信号只在头部**（`owner=1` / `ownerItems=…`）。
 * 正文行首的 `[主人]` 只是展示，用户文本里的同形序列会被转义。
 */

import { imMessageRef } from './refs.js'
import type { ImInbound } from './types.js'

/**
 * 群聊主人标记（决策 2026-10-31-im-owner-designation）：紧贴在主人发言行的
 * `[昵称]` 前缀之前，即 `[主人][昵称] 正文`。**只是展示**——身份以头部
 * `owner=1` / `ownerItems=…` 为准；私聊不拼这行前缀。
 */
export const IM_OWNER_LINE_PREFIX = '[主人]'

/** 用户文本里的同形标记转义成全角：与插件前缀不再逐字相同。 */
const IM_OWNER_ESCAPED_LINE_PREFIX = '［主人］'

/** 保留昵称：与主人标记同形，展示时回退成「群成员」，避免整行看起来像标记。 */
const IM_OWNER_RESERVED_NAME = '主人'

/**
 * 昵称归一化：NFKC（全角转半角）、去零宽字符、去方括号、折叠空白。保留词判断
 * 与展示都用同一份结果，避免 `主人` + 零宽/空格/方括号绕过。
 */
function normalizeDisplayName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 用户文本里的行首 `[主人]` 转成全角 `［主人］`：正文永远不可能产生与插件标记
 * 完全一致的行（多行正文、附件路径里的换行都走这里）。
 */
function escapeOwnerMarkerLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (
      line.startsWith(IM_OWNER_LINE_PREFIX)
        ? `${IM_OWNER_ESCAPED_LINE_PREFIX}${line.slice(IM_OWNER_LINE_PREFIX.length)}`
        : line
    ))
    .join('\n')
}

/**
 * 入站正文 → 插进会话的插件来源消息正文。
 *
 * 头部给模型五件事：这是 IM 消息不是 DSH 用户输入、来源渠道与范围、回复要用
 * 哪个 peer alias、这条消息的稳定引用与接收时间（`im_send` 的 `replyTo` 可用
 * `msg=` 指回它）、以及 `owner=1` 这个权威主人标记。引用是哈希，不带平台身份。
 * 群聊的发言人前缀由 `imUserTextOf` 提供，`[主人]` 只是展示。
 */
export function relayTextOf(inbound: ImInbound, body: string, alias: string, options?: { owner?: boolean }): string {
  const scope = inbound.scope === 'group' ? '群聊' : '私聊'
  const ownerFlag = options?.owner === true ? ' owner=1' : ''
  return [
    `[IM ${inbound.channel}/${scope} peer=${alias} msg=${imMessageRef(inbound.dedupeKey)} time=${new Date(inbound.receivedAt).toISOString()}${ownerFlag}]`,
    body,
    `（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${alias}。）`,
  ].join('\n')
}

/**
 * 入站文本 → 会话里的一条用户消息。
 *
 * 群聊必须带发言人前缀：一个会话里可能有多个人说话，模型只能从文本看出「这是
 * 另一个人说的」。私聊不加前缀，避免每句话都被名字噪声切碎。最终文本逐行转义
 * 行首的 `[主人]`，用户正文/附件路径都不能伪造插件标记行。
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
  return withAttachments === '' ? undefined : escapeOwnerMarkerLines(withAttachments)
}

/**
 * 平台显示名：QQ 群成员昵称、OneBot 名片等是安全可读的；私聊/C2C 的
 * `senderName` 常是 openid 前缀，不能当名字用——此时宁可缺省。
 *
 * 归一化后剥掉方括号与空白；归一化结果恰好是保留词「主人」时回退到「群成员」，
 * 否则 `[主人] 正文` 会被当成主人标记行。
 */
export function displaySenderNameOf(inbound: ImInbound): string | undefined {
  const name = normalizeDisplayName(inbound.senderName)
  if (name === '' || name === IM_OWNER_RESERVED_NAME) return undefined
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