/**
 * `context_token` 持久化（提案 0024 §4.2 的 `context-tokens.json`）。
 *
 * 微信回复必须回带最近一条入站消息的 context token；它只活在这条会话里，
 * 重启后仍要能回话，因此按账号落盘。形状是 `{ [peerId]: token }`：
 *
 * ```text
 * $DSH_HOME/soulmojito/im/weixin/<accountId>/context-tokens.json
 * ```
 *
 * 单纯读不到（首次绑定）返回空表；文件损坏必须报错，不能当成「没有 token」
 * 静默继续——那会让每一轮回复都缺通行证。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface WeixinContextTokenStore {
  load(): Promise<Record<string, string>>
  save(tokens: Readonly<Record<string, string>>): Promise<void>
}

export type WeixinContextTokenErrorCode = 'WEIXIN_TOKEN_STORE_CORRUPT' | 'WEIXIN_TOKEN_STORE_IO'

export class WeixinContextTokenError extends Error {
  readonly code: WeixinContextTokenErrorCode
  readonly path: string

  constructor(code: WeixinContextTokenErrorCode, message: string, path: string) {
    super(message)
    this.name = 'WeixinContextTokenError'
    this.code = code
    this.path = path
  }
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]+$/
/** 与密钥文件同档：token 是回复通行证，不该比密钥更宽松。 */
const FILE_MODE = 0o600

export function openWeixinContextTokens(root: string, accountId: string): WeixinContextTokenStore {
  // accountId 同时是目录名：只放开安全字符，从根上挡掉路径穿越。
  if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId === '.' || accountId === '..') {
    throw new TypeError(
      `weixin context token store got an illegal accountId ${JSON.stringify(accountId)}: only [A-Za-z0-9._-] is allowed`,
    )
  }
  const file = join(resolve(root), 'weixin', accountId, 'context-tokens.json')
  return {
    load: () => loadTokens(file),
    save: (tokens) => saveTokens(file, tokens),
  }
}

async function loadTokens(file: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return {}
    throw new WeixinContextTokenError('WEIXIN_TOKEN_STORE_IO', `failed to read ${file}: ${reasonOf(cause)}`, file)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new WeixinContextTokenError(
      'WEIXIN_TOKEN_STORE_CORRUPT',
      `corrupt token file ${file}: not valid JSON: ${reasonOf(cause)}`,
      file,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WeixinContextTokenError('WEIXIN_TOKEN_STORE_CORRUPT', `corrupt token file ${file}: the top level is not an object`, file)
  }
  const tokens: Record<string, string> = {}
  for (const [peerId, token] of Object.entries(value)) {
    if (peerId.trim() === '' || typeof token !== 'string' || token === '') {
      throw new WeixinContextTokenError(
        'WEIXIN_TOKEN_STORE_CORRUPT',
        `corrupt token file ${file}: the token for ${JSON.stringify(peerId)} is not a non-empty string`,
        file,
      )
    }
    tokens[peerId] = token
  }
  return tokens
}

/** tmp + rename：崩溃时读者只会看到旧文件或新文件，不会读到半截 JSON。 */
async function saveTokens(file: string, tokens: Readonly<Record<string, string>>): Promise<void> {
  const snapshot: Record<string, string> = {}
  for (const [peerId, token] of Object.entries(tokens)) {
    if (typeof token !== 'string' || token === '') {
      throw new TypeError(`weixin context token for ${JSON.stringify(peerId)} must be a non-empty string`)
    }
    snapshot[peerId] = token
  }
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    await fs.rename(tmp, file)
  } catch (cause) {
    // 清理失败不掩盖原始错误：真正要上报的是这次写失败。
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw new WeixinContextTokenError('WEIXIN_TOKEN_STORE_IO', `failed to write ${file}: ${reasonOf(cause)}`, file)
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
