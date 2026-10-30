/**
 * 出站文本投影（提案 0024 §3.7）。
 *
 * 输入是**展示层文本**（`displayTextForMessage` 跑完 markdownOnly 正则之后的
 * 结果），输出是可以直接交给渠道适配层切分好的纯文本段落。这里不读 store、
 * 不碰协议：纯函数，全部可表驱动测试。
 *
 * 三层剥离的顺序不能换：
 * 1. 美化前端文档与 MVU 块必须先走 `stripFrontendDocuments`——它认识完整的
 *    文档形态，先切分会把 ```` ```html ```` 拆散，之后再也识别不出来。
 * 2. 微信再剥 markdown 标记（它不渲染）。
 * 3. 最后才按渠道上限切分。
 */

import { stripFrontendDocuments } from '../frontend-documents.js'
import type { ImChannelId } from './types.js'

/** 投影后为空时的固定短句：不发明文错误，也不静默丢弃。 */
export const IM_EMPTY_REPLY = '（无文本回复）'

export class ImProjectError extends Error {
  readonly code = 'IM_PROJECT_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ImProjectError'
  }
}

/**
 * 把一段展示文本投影成若干条可直接发送的纯文本。
 *
 * `limit` 必须为正整数；调用方从 `imChunkLimit()` 取（渠道默认 + 用户覆盖）。
 */
export function projectImText(displayText: string, channel: ImChannelId, limit: number): string[] {
  assertLimit(limit)
  const collapsed = stripFrontendDocuments(displayText)
  const normalized = channel === 'weixin' ? stripWeixinMarkdown(collapsed) : collapsed
  const text = normalizeBlankLines(normalized)
  if (text === '') return [IM_EMPTY_REPLY]
  const parts = channel === 'qq' ? chunkMarkdown(text, limit) : chunkParagraphs(text, limit)
  return parts.length === 0 ? [IM_EMPTY_REPLY] : parts
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ImProjectError(`chunk limit must be a positive integer, received ${String(limit)}`)
  }
}

function normalizeBlankLines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 微信不渲染 markdown（官方参考实现同样做字符级过滤）。这里采取更保守的
 * 策略：所有强调标记一律剥掉只留正文，代码围栏与表格原样保留——它们即使
 * 不渲染，读起来也不误导。
 */
export function stripWeixinMarkdown(text: string): string {
  const lines = text.split('\n')
  let fence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      continue
    }
    let next = line
      // 图片整个丢掉：微信里只剩一串不可读的 markdown。
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // 标题标记剥掉，保留文字。
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      // 删除线 / 粗体 / 斜体：反复替换以覆盖嵌套，最后清掉残余单个标记符。
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/___([^_]+)___/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1$2')
      // 行内代码的反引号去掉，内容保留。
      .replace(/`([^`\n]+)`/g, '$1')
      // 引用标记。
      .replace(/^\s{0,3}>\s?/, '')
    next = next.replace(/[ \t]+$/, '')
    out.push(next)
  }
  return out.join('\n')
}

/**
 * QQ 的 Markdown 感知切分：不切断代码围栏与表格行。
 *
 * 围栏跨越切分点时，先把当前块补一个闭合围栏再发送，下一块以同样的 info
 * string 重开——否则用户会看到半截代码块加一堆被渲染成正文的源码。
 */
export function chunkMarkdown(text: string, limit: number): string[] {
  assertLimit(limit)
  const lines = text.split('\n')
  const parts: string[] = []
  let buffer: string[] = []
  let bufferLength = 0
  let fenceInfo: string | undefined

  const flush = (reopen: boolean): void => {
    if (buffer.length === 0) return
    const body = buffer.join('\n')
    if (reopen && fenceInfo !== undefined) {
      parts.push(`${body}\n\`\`\``)
      buffer = [`\`\`\`${fenceInfo}`]
      bufferLength = 3 + fenceInfo.length
      return
    }
    parts.push(body)
    buffer = []
    bufferLength = 0
  }

  for (const line of lines) {
    const fenceMatch = /^\s*```(.*)$/.exec(line)
    const isFence = fenceMatch !== null
    // +1 补换行：切分按最终字节长度估算，宁可早切一点也不超限。
    const cost = line.length + (buffer.length === 0 ? 0 : 1)
    if (bufferLength + cost > limit && buffer.length > 0) {
      const keepFence = fenceInfo !== undefined
      flush(keepFence)
    }
    if (line.length > limit && buffer.length === 0) {
      // 单行超限（例如一整个压缩过的 JSON）：按字符硬切，保留围栏状态。
      for (const piece of hardSplit(line, limit)) parts.push(piece)
      bufferLength = 0
      continue
    }
    buffer.push(line)
    bufferLength += cost
    if (isFence) {
      if (fenceInfo === undefined) fenceInfo = fenceMatch[1] ?? ''
      else fenceInfo = undefined
    }
  }
  flush(false)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** 段落切分：微信与 OneBot 用。段内超长再硬切。 */
export function chunkParagraphs(text: string, limit: number): string[] {
  assertLimit(limit)
  const paragraphs = text.split(/\n{2,}/)
  const parts: string[] = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    const candidate = buffer === '' ? trimmed : `${buffer}\n\n${trimmed}`
    if (candidate.length <= limit) {
      buffer = candidate
      continue
    }
    if (buffer !== '') {
      parts.push(buffer)
      buffer = ''
    }
    if (trimmed.length <= limit) {
      buffer = trimmed
      continue
    }
    const pieces = hardSplit(trimmed, limit)
    for (const piece of pieces.slice(0, -1)) parts.push(piece)
    buffer = pieces[pieces.length - 1] ?? ''
  }
  if (buffer !== '') parts.push(buffer)
  return parts
}

/** 按字符硬切，避免把代理对（emoji）劈成两半。 */
function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length)
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    if (end <= cursor) end = Math.min(cursor + limit, text.length)
    pieces.push(text.slice(cursor, end))
    cursor = end
  }
  return pieces
}
