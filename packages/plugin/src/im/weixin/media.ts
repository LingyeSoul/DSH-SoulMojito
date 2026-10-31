/**
 * 微信 iLink CDN 媒体（提案 0024 §2.2 / M5）。
 *
 * 协议只有一条链路：`getuploadurl` 换上传地址 → 把 **AES-128-ECB 密文** POST 上去
 * → 响应头 `x-encrypted-param` 就是发消息时引用的 `encrypt_query_param`。下载反过来：
 * 拉密文、按 `aes_key` 解密。这里只放纯计算与单次传输，重试策略、限流、日志
 * 由通道决定。
 *
 * 三条必须记住的事实：
 * 1. AES-128-ECB + PKCS#7，Node 内置 crypto 就够，不引第三方包；
 * 2. `media.aes_key` 是 base64，解出来可能是 16 字节明文，也可能是 32 字符的
 *    hex 字符串——后者再按 hex 解成 16 字节；图片的 `image_item.aeskey` 直接是 hex；
 * 3. 出站引用里 `aes_key` 是 **hex 字符串** 的 base64，不是密钥本身的 base64。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import { isImMediaExtension, type ImMediaStore } from '../media-store.js'
import type { ImMediaKind, ImMediaRef } from '../types.js'
import {
  getUploadUrl,
  sendMessage,
  sendMessageItems,
  type WeixinApiContext,
  type WeixinMessageItem,
} from './api.js'

/** 单个入站附件的上限：超过就只留引用，不下载（提案 §7「落地媒体」）。 */
export const WEIXIN_MEDIA_MAX_BYTES = 20 * 1024 * 1024
/** 单个附件的传输超时；附件不是回复正文，卡住 20s 也没必要等。 */
export const WEIXIN_MEDIA_TIMEOUT_MS = 20_000
/** 上传失败最多试 3 次（含首次）；4xx 立刻放弃。 */
const UPLOAD_ATTEMPTS = 3

const AES_KEY_BYTES = 16
const AES_BLOCK_SIZE = 16
const IMAGE_AES_KEY_HEX = /^[0-9a-fA-F]{32}$/
const HEX_TEXT_LENGTH = 32

export type WeixinMediaErrorCode =
  | 'WEIXIN_MEDIA_BAD_KEY'
  | 'WEIXIN_MEDIA_DECRYPT_FAILED'
  | 'WEIXIN_MEDIA_DOWNLOAD_FAILED'
  | 'WEIXIN_MEDIA_UPLOAD_FAILED'
  | 'WEIXIN_MEDIA_TOO_LARGE'
  | 'WEIXIN_MEDIA_UNSUPPORTED'

export class WeixinMediaError extends Error {
  readonly code: WeixinMediaErrorCode
  /** HTTP 状态；只有传输层错误才有。 */
  readonly status: number | undefined

  constructor(code: WeixinMediaErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WeixinMediaError'
    this.code = code
    this.status = options?.status
  }
}

/** 媒体传输的注入面：CDN 入口、外部中止信号与单次超时。 */
export interface WeixinMediaRequestContext {
  cdnBaseUrl: string
  signal?: AbortSignal
  timeoutMs: number
}

/** `media.aes_key`（base64）→ 16 字节密钥；错误信息只报长度，不回报密钥。 */
export function parseAesKey(key: string, label: string): Buffer {
  const text = key.trim()
  if (text === '') {
    throw new WeixinMediaError('WEIXIN_MEDIA_BAD_KEY', `${label} is an empty AES key; expected base64 of 16 bytes`)
  }
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === AES_KEY_BYTES) return decoded
  if (decoded.length === HEX_TEXT_LENGTH) {
    const hex = decoded.toString('utf8')
    if (IMAGE_AES_KEY_HEX.test(hex)) return Buffer.from(hex, 'hex')
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_BAD_KEY',
      `${label} decodes to 32 bytes that are not a 32-character hex key; expected base64 of 16 bytes or of a hex string`,
    )
  }
  throw new WeixinMediaError(
    'WEIXIN_MEDIA_BAD_KEY',
    `${label} decodes to ${decoded.length} bytes; expected base64 of 16 bytes or of a 32-character hex string`,
  )
}

/** 图片专用：`image_item.aeskey` 直接是 32 字符 hex。 */
export function parseImageAesKey(hexKey: string): Buffer {
  const text = hexKey.trim()
  if (!IMAGE_AES_KEY_HEX.test(text)) {
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_BAD_KEY',
      `image_item.aeskey must be 32 hex characters, got ${text.length} characters that are not all hex`,
    )
  }
  return Buffer.from(text, 'hex')
}

/** PKCS#7 补齐后的密文长度（整块对齐，空明文也有一个整块）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new TypeError(`aesEcbPaddedSize needs a non-negative safe integer, got ${String(plaintextSize)}`)
  }
  return (Math.floor(plaintextSize / AES_BLOCK_SIZE) + 1) * AES_BLOCK_SIZE
}

export function encryptAesEcb(buf: Buffer, key: Buffer): Buffer {
  requireAesKey(key, 'encryptAesEcb')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

export function decryptAesEcb(buf: Buffer, key: Buffer): Buffer {
  requireAesKey(key, 'decryptAesEcb')
  if (buf.length === 0 || buf.length % AES_BLOCK_SIZE !== 0) {
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_DECRYPT_FAILED',
      `AES-128-ECB ciphertext is ${buf.length} bytes; it must be a non-zero multiple of ${AES_BLOCK_SIZE}`,
    )
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(buf), decipher.final()])
  } catch (cause) {
    // 密钥错或密文被截断都会落到这里；错误里不带密钥与密文内容。
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_DECRYPT_FAILED',
      `AES-128-ECB decrypt failed for ${buf.length} bytes: ${reasonOf(cause)}`,
      { cause },
    )
  }
}

/** `GET {cdnBase}/download?encrypted_query_param=…`。 */
export function cdnDownloadUrl(cdnBase: string, encryptQueryParam: string): string {
  return `${normalizeCdnBaseUrl(cdnBase)}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

/** `POST {cdnBase}/upload?encrypted_query_param=…&filekey=…`。 */
export function cdnUploadUrl(cdnBase: string, uploadParam: string, filekey: string): string {
  return `${normalizeCdnBaseUrl(cdnBase)}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

export interface WeixinDownloadRequest {
  /** 协议要求优先用 `media.full_url`；给了就不再拼 CDN 地址。 */
  fullUrl?: string
  encryptQueryParam?: string
  /** undefined 表示这份字节是明文（图片没有密钥时就是这样）。 */
  aesKey?: Buffer
  maxBytes: number
  /** 日志/错误里的固定标签，不含 URL 或密钥。 */
  label: string
}

/** 下载（必要时解密）一个附件；HTTP 状态与超时都映射成本模块的错误。 */
export async function downloadAndDecrypt(
  context: WeixinMediaRequestContext,
  request: WeixinDownloadRequest,
): Promise<Buffer> {
  const url =
    request.fullUrl ??
    (request.encryptQueryParam === undefined ? undefined : cdnDownloadUrl(context.cdnBaseUrl, request.encryptQueryParam))
  if (url === undefined) {
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_DOWNLOAD_FAILED',
      `${request.label} carries neither media.full_url nor encrypt_query_param; there is nothing to download`,
    )
  }
  return withTransport('WEIXIN_MEDIA_DOWNLOAD_FAILED', request.label, context, async (signal) => {
    const response = await fetch(url, { method: 'GET', signal })
    if (!response.ok) {
      const detail = await response.text()
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_DOWNLOAD_FAILED',
        `${request.label} returned HTTP ${response.status}: ${snippet(detail)}`,
        { status: response.status },
      )
    }
    const declared = contentLengthOf(response)
    // 密文可能比明文多一个 PKCS#7 填充块（最多 16 字节）：上限按密文放宽，解密后再按明文复核。
    const ciphertextCap = request.maxBytes + AES_BLOCK_SIZE
    if (declared !== undefined && declared > ciphertextCap) {
      await response.body?.cancel().catch(() => undefined)
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_TOO_LARGE',
        `${request.label} declares ${declared} bytes; the cap is ${request.maxBytes} bytes of plaintext`,
      )
    }
    const body = await readBoundedBody(response, ciphertextCap, request.label)
    const plaintext = request.aesKey === undefined ? body : decryptAesEcb(body, request.aesKey)
    if (plaintext.byteLength > request.maxBytes) {
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_TOO_LARGE',
        `${request.label} decrypts to ${plaintext.byteLength} bytes; the cap is ${request.maxBytes} bytes`,
      )
    }
    return plaintext
  })
}

/**
 * 边读边计数的 body 读取：`content-length` 缺失或撒谎时也只在内存里留到上限为止。
 * 超限立刻 cancel 并抛错，不让异常 CDN 把进程撑爆。
 */
async function readBoundedBody(response: Response, cap: number, label: string): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > cap) {
      throw new WeixinMediaError('WEIXIN_MEDIA_TOO_LARGE', `${label} is ${buffer.byteLength} bytes; the cap is ${cap} bytes of ciphertext`)
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
        throw new WeixinMediaError('WEIXIN_MEDIA_TOO_LARGE', `${label} exceeds ${cap} bytes of ciphertext`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export interface WeixinUploadRequest {
  /** 已经解析好的上传地址（`upload_full_url` 优先，否则 `cdnUploadUrl` 拼出来的）。 */
  url: string
  ciphertext: Buffer
  /** 日志/错误里的固定标签，不含 URL。 */
  label: string
}

export interface WeixinUploadReceipt {
  /** 响应头 `x-encrypted-param`：发消息时要回带的引用。 */
  encryptQueryParam: string
  ciphertextSize: number
}

/**
 * 上传密文。成功判据是 HTTP 200 **且** 有非空 `x-encrypted-param`：
 * 没有这个头，服务端就没记住这次上传，发消息时无从引用。
 */
export async function uploadToWeixinCdn(
  context: WeixinMediaRequestContext,
  request: WeixinUploadRequest,
): Promise<WeixinUploadReceipt> {
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const encryptQueryParam = await uploadOnce(context, request)
      return { encryptQueryParam, ciphertextSize: request.ciphertext.byteLength }
    } catch (cause) {
      lastError = cause
      if (!isRetryableUpload(cause)) throw cause
    }
  }
  throw new WeixinMediaError(
    'WEIXIN_MEDIA_UPLOAD_FAILED',
    `${request.label} failed after ${UPLOAD_ATTEMPTS} attempts: ${reasonOf(lastError)}`,
    { cause: lastError },
  )
}

export interface WeixinUploadedMedia {
  encryptQueryParam: string
  /** 16 字节密钥的 hex（32 字符）；发消息时只发它的 base64。 */
  aesKeyHex: string
  ciphertextSize: number
}

export interface WeixinMediaItemRequest {
  kind: ImMediaKind
  uploaded: WeixinUploadedMedia
  /** 文件项必填；图片/视频不用。 */
  fileName: string
  /** 明文大小；文件项的 `len` 用它。 */
  plaintextSize: number
}

/**
 * 出站媒体 item（`msg.item_list` 的一项）。
 *
 * `aes_key` 是 **hex 字符串** 的 base64——参考实现如此，服务端据此解出同一把
 * 16 字节密钥；直接发密钥的 base64 会解不开。
 */
export function buildWeixinMediaItem(request: WeixinMediaItemRequest): Record<string, unknown> {
  const media = {
    encrypt_query_param: request.uploaded.encryptQueryParam,
    aes_key: Buffer.from(request.uploaded.aesKeyHex, 'utf8').toString('base64'),
    encrypt_type: 1,
  }
  if (request.kind === 'image') {
    return { type: 2, image_item: { media, mid_size: request.uploaded.ciphertextSize } }
  }
  if (request.kind === 'video') {
    return { type: 5, video_item: { media, video_size: request.uploaded.ciphertextSize } }
  }
  if (request.kind === 'file') {
    if (request.fileName.trim() === '') {
      throw new WeixinMediaError('WEIXIN_MEDIA_UNSUPPORTED', 'a weixin file item needs a non-empty file name')
    }
    return {
      type: 4,
      file_item: { media, file_name: request.fileName, len: String(request.plaintextSize) },
    }
  }
  throw new WeixinMediaError(
    'WEIXIN_MEDIA_UNSUPPORTED',
    `weixin has no outbound '${request.kind}' item: the iLink reference implementation only sends images, videos and files`,
  )
}

/** `getuploadurl.media_type`：1 图片、2 视频、3 文件、4 语音。 */
export function weixinMediaTypeOf(kind: ImMediaKind): 1 | 2 | 3 | 4 {
  if (kind === 'image') return 1
  if (kind === 'video') return 2
  if (kind === 'file') return 3
  return 4
}

/** 媒体路径的日志注入面：调用方补账号前缀，消息里不得带 URL 或密钥。 */
export interface WeixinMediaLog {
  debug: (message: string) => void
  warn: (message: string) => void
}

/** 通道启动时的媒体 TTL 清理；失败只经 `warn` 上报，绝不阻断上线。 */
export async function sweepExpiredMedia(
  media: ImMediaStore,
  ttlMs: number,
  log: WeixinMediaLog,
): Promise<void> {
  try {
    const removed = await media.cleanupOlderThan(ttlMs)
    if (removed > 0) log.debug(`removed ${removed} expired media file(s)`)
  } catch (error) {
    log.warn(`sweeping expired media failed: ${reasonOf(error)}`)
  }
}

/** 入站媒体：item 本身加上归一的 kind（type 2/4/5 与转录缺失的语音）。 */
export interface WeixinInboundMediaSource {
  readonly kind: ImMediaKind
  readonly item: WeixinMessageItem
}

/** 入站落盘的注入面；`log` 只收固定文案，调用方补账号前缀。 */
export interface WeixinInboundMediaContext {
  cdnBaseUrl: string
  timeoutMs: number
  signal?: AbortSignal
  /** 缺省时只产出远端引用，不落盘（测试与嵌入场景）。 */
  media?: ImMediaStore
  channel: string
  accountId: string
  log: WeixinMediaLog
}

/**
 * 把一条消息里的媒体项依次落盘。顺序与 item 一致；任何一项失败都只 warn，
 * ref 仍然保留远端字段——模型至少能看到「（附件：图片）」。
 */
export async function materializeInboundMedia(
  context: WeixinInboundMediaContext,
  sources: readonly WeixinInboundMediaSource[],
): Promise<ImMediaRef[]> {
  const refs: ImMediaRef[] = []
  for (const source of sources) {
    const item = source.item
    const ref: ImMediaRef = {
      kind: source.kind,
      ...(item.mediaUrl === undefined ? {} : { url: item.mediaUrl }),
      ...(item.fileName === undefined ? {} : { name: item.fileName }),
      ...(item.size === undefined ? {} : { size: item.size }),
    }
    const localPath = await saveInboundMedia(context, source.kind, item)
    refs.push(localPath === undefined ? ref : { ...ref, localPath })
  }
  return refs
}

async function saveInboundMedia(
  context: WeixinInboundMediaContext,
  kind: ImMediaKind,
  item: WeixinMessageItem,
): Promise<string | undefined> {
  const media = context.media
  if (media === undefined) return undefined
  if (item.fullUrl === undefined && item.encryptQueryParam === undefined) return undefined
  if (item.size !== undefined && item.size > WEIXIN_MEDIA_MAX_BYTES) {
    context.log.warn(
      `inbound ${kind} is ${item.size} bytes, above the ${WEIXIN_MEDIA_MAX_BYTES}-byte cap; kept as a reference without a local copy`,
    )
    return undefined
  }
  let key: Buffer | undefined
  try {
    key = inboundAesKeyOf(item, kind)
  } catch (error) {
    context.log.warn(`inbound ${kind} has an unusable AES key; kept as a reference without a local copy: ${reasonOf(error)}`)
    return undefined
  }
  if (key === undefined && kind !== 'image') {
    context.log.warn(
      `inbound ${kind} carries no media.aes_key; the CDN payload cannot be decrypted, kept as a reference without a local copy`,
    )
    return undefined
  }
  const extension = inboundExtensionOf(kind, item)
  if (extension === undefined) {
    context.log.warn(`inbound ${kind} has no allowlisted file extension; kept as a reference without a local copy`)
    return undefined
  }
  let bytes: Buffer
  try {
    bytes = await downloadAndDecrypt(
      {
        cdnBaseUrl: context.cdnBaseUrl,
        timeoutMs: context.timeoutMs,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      {
        ...(item.fullUrl === undefined ? {} : { fullUrl: item.fullUrl }),
        ...(item.encryptQueryParam === undefined ? {} : { encryptQueryParam: item.encryptQueryParam }),
        ...(key === undefined ? {} : { aesKey: key }),
        maxBytes: WEIXIN_MEDIA_MAX_BYTES,
        label: `weixin inbound ${kind}`,
      },
    )
  } catch (error) {
    context.log.warn(`downloading an inbound ${kind} failed; kept as a reference without a local copy: ${reasonOf(error)}`)
    return undefined
  }
  try {
    return await media.save({
      channel: context.channel,
      accountId: context.accountId,
      bytes,
      extension,
      ...(item.fileName === undefined ? {} : { originalName: item.fileName }),
    })
  } catch (error) {
    context.log.warn(`saving an inbound ${kind} failed; kept as a reference without a local copy: ${reasonOf(error)}`)
    return undefined
  }
}

/**
 * 解密密钥优先级：`image_item.aeskey`（hex）> `media.aes_key`（base64）。
 * 图片没有密钥是合法的（CDN 上就是明文）；其它类型由调用方判缺。
 */
function inboundAesKeyOf(item: WeixinMessageItem, kind: ImMediaKind): Buffer | undefined {
  if (item.aesKeyHex !== undefined) {
    // 协议变体：`image_item.aeskey` 存在但不是合法 hex 时，回退到 `media.aes_key`——
    // 一份坏字段不该让本来能下载的图片直接失败。
    try {
      return parseImageAesKey(item.aesKeyHex)
    } catch (error) {
      if (item.aesKey === undefined) throw error
      return parseAesKey(item.aesKey, `${kind} media.aes_key`)
    }
  }
  if (item.aesKey === undefined) return undefined
  return parseAesKey(item.aesKey, `${kind} media.aes_key`)
}

/** 没有文件名/URL 扩展名时的兜底：语音按 silk、图片按 png、视频按 mp4。 */
const DEFAULT_EXTENSIONS: Readonly<Record<ImMediaKind, string | undefined>> = {
  image: 'png',
  voice: 'silk',
  video: 'mp4',
  file: undefined,
}

/**
 * 落盘扩展名：原文件名 > URL 路径 > 类型兜底。不在白名单里的值一律当「没有」，
 * 免得下载完才被 store 拒绝（白下 20MB）。
 */
function inboundExtensionOf(kind: ImMediaKind, item: WeixinMessageItem): string | undefined {
  const candidates = [extensionOf(item.fileName), extensionOf(item.fullUrl ?? item.mediaUrl), DEFAULT_EXTENSIONS[kind]]
  for (const candidate of candidates) {
    if (candidate !== undefined && isImMediaExtension(candidate)) return candidate
  }
  return undefined
}

/** 从一个名字或 URL 里取扩展名；解析不了就当没有（只是少一条提示）。 */
function extensionOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  let path = value
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname
    } catch {
      return undefined
    }
  }
  const extension = extname(path).replace(/^\.+/, '').toLowerCase()
  return extension === '' ? undefined : extension
}

/** 出站媒体：一次上传 + （可选说明文字）+ 一次媒体消息。 */
export interface WeixinOutboundMediaRequest {
  kind: ImMediaKind
  /** 本地文件；微信只接受本地字节，远端 URL 不在这里下载。 */
  localPath: string
  name?: string
  caption?: string
}

export interface WeixinOutboundMediaContext {
  /** `sendmessage` 的注入面（入口、token、中止信号）。 */
  api: WeixinApiContext
  cdnBaseUrl: string
  /** `getuploadurl` 与 CDN 上传的超时。 */
  uploadTimeoutMs: number
  signal?: AbortSignal
  toUserId: string
  contextToken?: string
}

/**
 * 读本地文件 → 加密 → `getuploadurl` → CDN 上传 → 说明文字 → 媒体消息。
 *
 * 密钥与 filekey 每次随机：同一份文件重发不能复用引用，否则服务端按幂等丢掉
 * 第二次。说明文字必须单独一条、先发：协议一次只认一项媒体。
 */
export async function sendWeixinMedia(
  context: WeixinOutboundMediaContext,
  request: WeixinOutboundMediaRequest,
): Promise<string | undefined> {
  const bytes = await readLocalMedia(request.localPath, request.kind)
  const fileName = request.name?.trim() || basename(request.localPath)
  const key = randomBytes(16)
  const aesKeyHex = key.toString('hex')
  const filekey = randomBytes(16).toString('hex')
  const ciphertext = encryptAesEcb(bytes, key)
  const upload = await getUploadUrl(
    { ...context.api, timeoutMs: context.uploadTimeoutMs },
    {
      filekey,
      mediaType: weixinMediaTypeOf(request.kind),
      toUserId: context.toUserId,
      rawsize: bytes.byteLength,
      rawfilemd5: md5Hex(bytes),
      filesize: ciphertext.byteLength,
      aeskeyHex: aesKeyHex,
    },
  )
  const uploadUrl =
    upload.uploadFullUrl ??
    (upload.uploadParam === undefined ? undefined : cdnUploadUrl(context.cdnBaseUrl, upload.uploadParam, filekey))
  if (uploadUrl === undefined) {
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_UPLOAD_FAILED',
      `getuploadurl returned neither upload_full_url nor upload_param for a ${request.kind}`,
    )
  }
  const uploaded = await uploadToWeixinCdn(
    {
      cdnBaseUrl: context.cdnBaseUrl,
      timeoutMs: context.uploadTimeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    { url: uploadUrl, ciphertext, label: `weixin ${request.kind} upload` },
  )
  if (request.caption !== undefined && request.caption.trim() !== '') {
    await sendMessage(context.api, {
      toUserId: context.toUserId,
      text: request.caption,
      ...(context.contextToken === undefined ? {} : { contextToken: context.contextToken }),
    })
  }
  const item = buildWeixinMediaItem({
    kind: request.kind,
    uploaded: {
      encryptQueryParam: uploaded.encryptQueryParam,
      aesKeyHex,
      ciphertextSize: uploaded.ciphertextSize,
    },
    fileName,
    plaintextSize: bytes.byteLength,
  })
  const sent = await sendMessageItems(context.api, {
    toUserId: context.toUserId,
    items: [item],
    ...(context.contextToken === undefined ? {} : { contextToken: context.contextToken }),
  })
  return sent.messageId
}

/** 明文 md5：协议字段叫 `rawfilemd5`，服务端用它校验上传内容。 */
function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex')
}

async function readLocalMedia(path: string, kind: ImMediaKind): Promise<Buffer> {
  // 上传前先看大小：出站也守 20MB，绝不为了发一条消息把任意大文件读进内存。
  try {
    const stats = await fs.stat(path)
    if (!stats.isFile()) {
      throw new WeixinMediaError('WEIXIN_MEDIA_UNSUPPORTED', `the local ${kind} path '${path}' is not a regular file`)
    }
    if (stats.size > WEIXIN_MEDIA_MAX_BYTES) {
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_TOO_LARGE',
        `the local ${kind} file is ${stats.size} bytes; the cap is ${WEIXIN_MEDIA_MAX_BYTES} bytes`,
      )
    }
  } catch (cause) {
    if (cause instanceof WeixinMediaError) throw cause
    if (isErrno(cause, 'ENOENT')) {
      throw new WeixinMediaError('WEIXIN_MEDIA_UNSUPPORTED', `the local ${kind} file '${path}' does not exist`, {
        cause,
      })
    }
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_UNSUPPORTED',
      `could not inspect the local ${kind} file '${path}': ${reasonOf(cause)}`,
      { cause },
    )
  }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(path)
  } catch (cause) {
    throw new WeixinMediaError(
      'WEIXIN_MEDIA_UNSUPPORTED',
      `could not read the local ${kind} file '${path}': ${reasonOf(cause)}`,
      { cause },
    )
  }
  if (bytes.byteLength === 0) {
    throw new WeixinMediaError('WEIXIN_MEDIA_UNSUPPORTED', `the local ${kind} file '${path}' is empty`)
  }
  return bytes
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code
}

async function uploadOnce(context: WeixinMediaRequestContext, request: WeixinUploadRequest): Promise<string> {
  return withTransport('WEIXIN_MEDIA_UPLOAD_FAILED', request.label, context, async (signal) => {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: request.ciphertext,
      signal,
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_UPLOAD_FAILED',
        `${request.label} returned HTTP ${response.status}: ${snippet(detail)}`,
        { status: response.status },
      )
    }
    const encryptQueryParam = response.headers.get('x-encrypted-param')?.trim() ?? ''
    await response.arrayBuffer()
    if (encryptQueryParam === '') {
      throw new WeixinMediaError(
        'WEIXIN_MEDIA_UPLOAD_FAILED',
        `${request.label} returned HTTP ${response.status} without a non-empty x-encrypted-param header; the upload cannot be referenced`,
      )
    }
    return encryptQueryParam
  })
}

/**
 * 4xx 是「这次请求本身有问题」：换一次也一样，立刻上报。
 * 5xx、网络失败与缺失响应头都可能是瞬时的，按 attempt 预算重试。
 */
function isRetryableUpload(cause: unknown): boolean {
  if (!(cause instanceof WeixinMediaError)) return false
  if (cause.code !== 'WEIXIN_MEDIA_UPLOAD_FAILED') return false
  return cause.status === undefined || cause.status >= 500
}

/**
 * 把一次传输放进「外部中止 + 本地超时」的保护里，并把网络错误折叠成统一的
 * 媒体错误。fetch 的失败信息可能带 URL（里面有 encrypted_query_param），
 * 因此只报告错误种类与 errno，不回报原文。
 */
async function withTransport<T>(
  code: 'WEIXIN_MEDIA_DOWNLOAD_FAILED' | 'WEIXIN_MEDIA_UPLOAD_FAILED',
  label: string,
  context: WeixinMediaRequestContext,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, context.timeoutMs)
  timer.unref?.()
  const onAbort = (): void => { controller.abort() }
  if (context.signal !== undefined) {
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await run(controller.signal)
  } catch (cause) {
    if (cause instanceof WeixinMediaError) throw cause
    if (context.signal?.aborted === true) {
      throw new WeixinMediaError(code, `${label} was aborted`, { cause })
    }
    if (timedOut) {
      throw new WeixinMediaError(code, `${label} timed out after ${context.timeoutMs}ms`, { cause })
    }
    throw transportError(code, label, cause)
  } finally {
    clearTimeout(timer)
    context.signal?.removeEventListener('abort', onAbort)
  }
}

function transportError(
  code: 'WEIXIN_MEDIA_DOWNLOAD_FAILED' | 'WEIXIN_MEDIA_UPLOAD_FAILED',
  label: string,
  cause: unknown,
): WeixinMediaError {
  return new WeixinMediaError(code, `${label} failed: ${transportReason(cause)}`, { cause })
}

/**
 * fetch 的错误链里第一层的 message 可能是整条 URL；这里只留错误名与 errno，
 * 保证日志里永远没有上传/下载参数。
 */
function transportReason(cause: unknown): string {
  if (!(cause instanceof Error)) return typeof cause
  const parts: string[] = [cause.name]
  const code = (cause as { code?: unknown }).code
  if (typeof code === 'string') parts.push(code)
  const inner = cause.cause
  if (inner instanceof Error) {
    const innerCode = (inner as { code?: unknown }).code
    if (typeof innerCode === 'string') parts.push(innerCode)
  }
  return parts.join(' ')
}

function contentLengthOf(response: Response): number | undefined {
  const header = response.headers.get('content-length')
  if (header === null) return undefined
  const value = Number.parseInt(header, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * CDN 入口的唯一校验点：绝对 http(s) URL，去掉尾部斜杠。通道构造期调用它，
 * 坏地址在账号上线前就被拒绝。
 */
export function normalizeCdnBaseUrl(cdnBase: string): string {
  const text = cdnBase.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch (cause) {
    throw new TypeError(`the weixin CDN base ${JSON.stringify(cdnBase)} is not an absolute URL`, { cause })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`the weixin CDN base ${JSON.stringify(cdnBase)} must be http(s), got '${parsed.protocol}'`)
  }
  return text
}

function requireAesKey(key: Buffer, label: string): void {
  if (key.length !== AES_KEY_BYTES) {
    throw new TypeError(`${label} needs a ${AES_KEY_BYTES}-byte AES-128 key, got ${key.length} bytes`)
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
