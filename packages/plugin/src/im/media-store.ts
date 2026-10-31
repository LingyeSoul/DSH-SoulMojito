/**
 * 下载媒体落盘（提案 0024 §7 / M5）。
 *
 * 通道拉到一个附件后只落一次盘，router 拿到的是本地路径；回复时不再回头去
 * 追远端 URL。这里只认两件事：
 * 1. 文件名由本模块生成（UUID + 白名单扩展名），平台给的名字只当诊断信息，
 *    恶意 `../../x.png` 永远进不了路径；
 * 2. 下载件是一次性的：通道启动时按 TTL 清掉旧文件，过期后没有任何读取方。
 *
 * 本模块不认识微信、QQ 或 OneBot：`channel` / `accountId` 只是目录名。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

/** 媒体根目录名；相对内部工作区，和角色卡/聊天记录等数据目录隔离。 */
export const IM_MEDIA_ROOT_DIR = 'im-media'

/**
 * 可落盘的扩展名白名单（提案 §7「MIME 白名单按扩展名」）。
 *
 * 只收本仓库通道真会转发的内容类型：图片、音视频、语音、常见文档与压缩包。
 * 扩展名不代表内容，但它是入站数据唯一能带上的类型线索；不在表里的一律拒绝。
 */
export const IM_MEDIA_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'mp4',
  'mov',
  'mp3',
  'wav',
  'silk',
  'amr',
  'ogg',
  'pdf',
  'txt',
  'md',
  'json',
  'zip',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
]

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(IM_MEDIA_EXTENSIONS)
/** channel/accountId 同时是目录名：只放开安全字符，从根上挡掉路径穿越。 */
const SAFE_OWNER_PART = /^[A-Za-z0-9._-]+$/
/** 下载件是临时数据，不该比密钥袋更宽松。 */
const FILE_MODE = 0o600

export type ImMediaStoreErrorCode =
  | 'IM_MEDIA_BAD_OWNER'
  | 'IM_MEDIA_BAD_EXTENSION'
  | 'IM_MEDIA_TOO_LARGE'
  | 'IM_MEDIA_IO'

export class ImMediaStoreError extends Error {
  readonly code: ImMediaStoreErrorCode

  constructor(code: ImMediaStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ImMediaStoreError'
    this.code = code
  }
}

export interface ImMediaStoreOptions {
  /** 内部工作区根；每次落盘/清理时解析，进程内工作区可以被替换。 */
  workspaceRoot: () => Promise<string>
  /** 清理阈值用的「现在」；测试注入假时钟。 */
  now: () => number
  /** 单个附件的大小上限（字节）。 */
  maxBytes: number
}

export interface ImMediaSaveRequest {
  channel: string
  accountId: string
  bytes: Uint8Array
  /** 不带点的扩展名（`png`、`silk`…）；只收白名单内的值。 */
  extension: string
  /** 平台给的原文件名；仅用于诊断，不会进文件路径。 */
  originalName?: string
}

export interface ImMediaStore {
  /** 落盘并返回绝对路径。 */
  save(request: ImMediaSaveRequest): Promise<string>
  /** 删除整棵 `im-media/` 树下 mtime 早于 `now - ms` 的文件，返回删除数。 */
  cleanupOlderThan(ms: number): Promise<number>
  /** 解绑账号时删掉它的媒体目录：聊天附件是 PII，不该比账号活得更久。 */
  remove(channel: string, accountId: string): Promise<boolean>
}

export function isImMediaExtension(value: string): boolean {
  return ALLOWED_EXTENSIONS.has(value.trim().replace(/^\.+/, '').toLowerCase())
}

export function openImMediaStore(options: ImMediaStoreOptions): ImMediaStore {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError(`openImMediaStore needs a positive integer maxBytes, got ${String(options.maxBytes)}`)
  }
  const maxBytes = options.maxBytes

  async function root(): Promise<string> {
    const workspace = (await options.workspaceRoot()).trim()
    if (workspace === '') throw new ImMediaStoreError('IM_MEDIA_IO', 'the internal workspace root is empty; media cannot be stored')
    return join(resolve(workspace), IM_MEDIA_ROOT_DIR)
  }

  return {
    async save(request: ImMediaSaveRequest): Promise<string> {
      const channel = requireOwnerPart(request.channel, 'channel')
      const accountId = requireOwnerPart(request.accountId, 'accountId')
      const size = request.bytes.byteLength
      if (size > maxBytes) {
        throw new ImMediaStoreError(
          'IM_MEDIA_TOO_LARGE',
          `${channel}/${accountId} media is ${size} bytes; the cap is ${maxBytes} bytes`,
        )
      }
      const extension = requireExtension(request.extension)
      const directory = join(await root(), `${channel}-${accountId}`)
      const file = join(directory, `${randomUUID()}.${extension}`)
      try {
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(file, request.bytes, { mode: FILE_MODE })
      } catch (cause) {
        // 半截文件不能被后续读取方当成完整附件；清理失败也不掩盖原始错误。
        await fs.rm(file, { force: true }).catch(() => undefined)
        throw new ImMediaStoreError('IM_MEDIA_IO', `failed to save ${channel}/${accountId} media to ${file}: ${reasonOf(cause)}`, {
          cause,
        })
      }
      return file
    },

    async cleanupOlderThan(ms: number): Promise<number> {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError(`cleanupOlderThan needs a non-negative finite TTL, got ${String(ms)}`)
      }
      return sweep(await root(), options.now() - ms)
    },

    async remove(channel: string, accountId: string): Promise<boolean> {
      const ownerChannel = requireOwnerPart(channel, 'channel')
      const ownerAccount = requireOwnerPart(accountId, 'accountId')
      const directory = join(await root(), `${ownerChannel}-${ownerAccount}`)
      try {
        const stats = await fs.stat(directory)
        if (!stats.isDirectory()) return false
      } catch (cause) {
        if (isErrno(cause, 'ENOENT')) return false
        throw new ImMediaStoreError('IM_MEDIA_IO', `failed to inspect ${directory}: ${reasonOf(cause)}`, { cause })
      }
      try {
        await fs.rm(directory, { recursive: true, force: true })
        return true
      } catch (cause) {
        throw new ImMediaStoreError('IM_MEDIA_IO', `failed to delete ${directory}: ${reasonOf(cause)}`, { cause })
      }
    },
  }
}

function requireOwnerPart(value: string, label: string): string {
  const part = value.trim()
  if (part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || !SAFE_OWNER_PART.test(part)) {
    throw new ImMediaStoreError(
      'IM_MEDIA_BAD_OWNER',
      `im media store got an illegal ${label} ${JSON.stringify(value)}: only [A-Za-z0-9._-] is allowed and it must name one directory`,
    )
  }
  return part
}

function requireExtension(value: string): string {
  const extension = value.trim().replace(/^\.+/, '').toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ImMediaStoreError(
      'IM_MEDIA_BAD_EXTENSION',
      `im media store refused extension ${JSON.stringify(value)}; allowed extensions: ${IM_MEDIA_EXTENSIONS.join(', ')}`,
    )
  }
  return extension
}

/** 递归清理；并发删除（另一个账号同时在扫）造成 ENOENT 时按已删除处理。 */
async function sweep(directory: string, cutoff: number): Promise<number> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return 0
    throw new ImMediaStoreError('IM_MEDIA_IO', `failed to list ${directory} while sweeping expired media: ${reasonOf(cause)}`, {
      cause,
    })
  }
  let removed = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      removed += await sweep(path, cutoff)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stats = await fs.stat(path)
      if (stats.mtimeMs >= cutoff) continue
      await fs.unlink(path)
      removed += 1
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) continue
      throw new ImMediaStoreError('IM_MEDIA_IO', `failed to delete expired media ${path}: ${reasonOf(cause)}`, { cause })
    }
  }
  return removed
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
