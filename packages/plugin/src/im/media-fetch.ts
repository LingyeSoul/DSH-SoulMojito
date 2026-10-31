/**
 * 普通 HTTP 附件的入站下载（QQ 等平台给的是 CDN 直链，不加密）。
 *
 * 微信走自己的 CDN + AES 流程（`weixin/media.ts`）；这里只处理「GET 一个 URL
 * 拿到字节，落进媒体仓库」的最小路径，给 QQ 用。
 *
 * 纪律：
 * 1. 大小上限先看 `content-length`，再按实际字节复核；超限直接拒绝，不落盘。
 * 2. 扩展名只从文件名/URL 路径/content-type 推断，且必须过媒体仓库的白名单。
 * 3. 失败抛结构化错误，调用方只 warn 并保留不带 localPath 的 ref。
 */

import type { ImMediaKind, ImMediaRef } from './types.js'
import type { ImMediaStore } from './media-store.js'
import { isImMediaExtension } from './media-store.js'

export type ImMediaFetchErrorCode = 'IM_MEDIA_FETCH_HTTP' | 'IM_MEDIA_FETCH_TOO_LARGE' | 'IM_MEDIA_FETCH_BAD_URL'

export class ImMediaFetchError extends Error {
  readonly code: ImMediaFetchErrorCode

  constructor(code: ImMediaFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ImMediaFetchError'
    this.code = code
  }
}

export interface InboundMediaFetchOptions {
  channel: string
  accountId: string
  media: ImMediaStore
  /** 单文件上限（字节）。 */
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
}

const FALLBACK_EXTENSION: Readonly<Record<ImMediaKind, string>> = {
  image: 'png',
  video: 'mp4',
  voice: 'mp3',
  file: 'txt',
}

/** 下载一条附件并落盘；返回带 `localPath` 的 ref。 */
export async function fetchInboundMedia(
  ref: ImMediaRef,
  options: InboundMediaFetchOptions,
): Promise<ImMediaRef> {
  if (ref.url === undefined) return ref
  const url = parseHttpUrl(ref.url)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
  timer.unref?.()
  const onAbort = (): void => { controller.abort() }
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new ImMediaFetchError(
        'IM_MEDIA_FETCH_HTTP',
        `downloading ${ref.kind} ${url.host} failed with HTTP ${response.status}`,
      )
    }
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isSafeInteger(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new ImMediaFetchError(
        'IM_MEDIA_FETCH_TOO_LARGE',
        `the remote ${ref.kind} declares ${declared} bytes; the cap is ${options.maxBytes} bytes`,
      )
    }
    const bytes = await readBoundedBody(response, options.maxBytes, ref.kind)
    if (bytes.byteLength === 0) {
      throw new ImMediaFetchError('IM_MEDIA_FETCH_HTTP', `the remote ${ref.kind} is empty`)
    }
    const extension = extensionOf(ref, url, response.headers.get('content-type'))
    const localPath = await options.media.save({
      channel: options.channel,
      accountId: options.accountId,
      bytes,
      extension,
      ...(ref.name === undefined ? {} : { originalName: ref.name }),
    })
    return { ...ref, localPath }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 边读边计数的 body 读取：`content-length` 缺失或虚报时也只在内存里留到上限为止。
 * 超限立刻 cancel 并抛错——与微信下载链路的纪律一致。
 */
async function readBoundedBody(response: Response, cap: number, kind: string): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > cap) {
      throw new ImMediaFetchError('IM_MEDIA_FETCH_TOO_LARGE', `the remote ${kind} is ${buffer.byteLength} bytes; the cap is ${cap} bytes`)
    }
    return buffer
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > cap) {
        await reader.cancel().catch(() => undefined)
        throw new ImMediaFetchError('IM_MEDIA_FETCH_TOO_LARGE', `the remote ${kind} exceeds ${cap} bytes`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new ImMediaFetchError('IM_MEDIA_FETCH_BAD_URL', `media URL '${raw}' is not a valid absolute URL`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImMediaFetchError('IM_MEDIA_FETCH_BAD_URL', `media URL '${raw}' uses protocol '${url.protocol}'; expected http(s)`)
  }
  return url
}

/** 扩展名：文件名 > URL 路径 > content-type > 按 kind 兜底。 */
function extensionOf(ref: ImMediaRef, url: URL, contentType: string | null): string {
  for (const candidate of [ref.name, decodeURIComponent(url.pathname)]) {
    if (candidate === undefined || candidate === '') continue
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(candidate)
    if (match === null) continue
    const extension = match[1]!.toLowerCase()
    if (isImMediaExtension(extension)) return extension
  }
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  const byType = EXTENSION_BY_TYPE[type]
  if (byType !== undefined) return byType
  return FALLBACK_EXTENSION[ref.kind]
}
