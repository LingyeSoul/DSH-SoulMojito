// Frontend-surface routes lifted out of `handleApi`: the helper binding
// handshake, the sandboxed frontend document/IDB/storage reads, and the
// single-message display projection.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { getIdbRecord, IDB_MAX_RECORD_BYTES, putIdbRecordFromFile } from '../../../tavern-frontend-storage/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { collectCardScriptBundle } from '../card-scripts.js'
import { tavernDataRoot } from '../dsh-home.js'
import { latestFrontendMessage, stripFrontendDocuments } from '../frontend-documents.js'
import { handleFrontendGenerationStream, handleHelperApi } from '../helper.js'
import { createHelperBinding, deleteHelperBinding, helperTokenFromRequest } from '../helper-bindings.js'
import { displayTextForMessage } from '../prompt-context.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

// Server-issued helper binding (2026-10-25): the host page owns the session
// binding, so its FrontendFrame exchanges the current character/chatId for a
// token on mount. Helper and frontend/generate routes resolve identity from
// the token instead of trusting the sandbox payload. Both routes sit inside
// the same origin/content-type trust guard as the rest of the API.
export async function handleHelperBindRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  const character = typeof body?.character === 'string' ? body.character : ''
  const chatId = typeof body?.chatId === 'string' ? body.chatId : ''
  if (character.trim() === '' || chatId.trim() === '') {
    throw new HttpError(400, 'character and chatId are required')
  }
  // Identity is only issued for a chat that exists and belongs to the named
  // character; a token is never minted for a guessed or foreign chat id.
  let exists = false
  try {
    exists = await db.getChatSnapshot(character, chatId) !== undefined
  } catch (error) {
    // The store rejects malformed chat ids before touching disk; that is still
    // "no such chat", not a server fault.
    if (!(error instanceof Error) || error.message !== 'invalid chat id') throw error
  }
  if (!exists) {
    throw new HttpError(404, `chat '${chatId}' not found for character '${character}'`)
  }
  return sendJson(res, 200, { ok: true, token: createHelperBinding(character, chatId) })
}

export async function handleHelperUnbindRoute(
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  const token = helperTokenFromRequest(req) ?? (typeof body?.token === 'string' ? body.token.trim() : '')
  if (token !== '') deleteHelperBinding(token)
  return sendJson(res, 200, { ok: true })
}

// 酒馆助手兼容面（2026-10-20）：美化前端 iframe 经 token 校验的 postMessage
// RPC 转发到这里。沙箱不放宽（无 same-origin、CSP connect-src 'none'），
// 能力在宿主侧代理；character/chatId 由客户端按自身会话绑定注入，iframe
// 无法寻址别的聊天。
export async function handleHelperRoute(
  req: HttpRequest,
  res: HttpResponse,
  db: TavernStore,
): Promise<void> {
  return handleHelperApi(req, res, db)
}

export async function handleFrontendGenerateRoute(
  req: HttpRequest,
  res: HttpResponse,
  db: TavernStore,
): Promise<void> {
  return handleFrontendGenerationStream(req, res, db)
}

// 卡脚本右栏（2026-10-21）：JSR 卡的常驻脚本树在
// `data.extensions.tavern_helper.scripts`。插件仍不自动执行脚本树；这里只
// 供「卡脚本」tab 列出启用的脚本，用户点「运行」后才在沙箱 iframe 里跑一份。
// 带 chatId 时优先会话脚本树副本（GM 面板持久化的 Zod 源码）。
export async function handleCardScriptsRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  if (!character) throw new Error('character query is required')
  const chatId = url.searchParams.get('chatId')
  const file = await db.getCharacter(character)
  if (!file) return sendJson(res, 404, { ok: false, message: `character '${character}' not found` })
  const scriptTrees = chatId === null ? undefined : await db.getChatScripts(character, chatId)
  const includeDisabled = url.searchParams.get('includeDisabled') === '1'
  const { world, scripts } = collectCardScriptBundle(file.card, scriptTrees, includeDisabled)
  return sendJson(res, 200, { ok: true, character, world, scripts })
}

// 虚拟 IndexedDB 的二进制数据面（2026-10-22）：控制面走 helper JSON，
// 记录体走这里。只由宿主页（已绑定会话）调用；iframe 不能直接访问该路由。
export async function handleIdbGetRoute(
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  if (!character) throw new Error('character query is required')
  const record = await getIdbRecord(
    tavernDataRoot(),
    character,
    url.searchParams.get('db'),
    url.searchParams.get('store'),
    url.searchParams.get('key'),
  )
  // A miss is not an error: IndexedDB's get() fires onsuccess with result
  // undefined. A 404 here becomes an exception in the shim, which cards that
  // treat any IndexedDB failure as a corrupt cache surface to the user.
  if (record === undefined) {
    res.statusCode = 204
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-length', String(record.size))
  res.setHeader('x-dsh-idb-meta', Buffer.from(JSON.stringify(record.meta), 'utf8').toString('base64url'))
  await pipeline(createReadStream(record.path), res)
  return
}

export async function handleIdbPutRoute(
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  if (!character) throw new Error('character query is required')
  const dbName = url.searchParams.get('db')
  const storeName = url.searchParams.get('store')
  const key = url.searchParams.get('key')
  if (dbName === null || storeName === null || key === null) {
    throw new Error('db, store and key queries are required')
  }
  const declared = Number(req.headers?.['content-length'] ?? '')
  if (Number.isFinite(declared) && declared > IDB_MAX_RECORD_BYTES) {
    req.destroy?.()
    throw new Error(`idb record is too large (${declared} > ${IDB_MAX_RECORD_BYTES} bytes)`)
  }
  const temporaryDir = await mkdtemp(join(tmpdir(), 'dsh-soulmojito-idb-'))
  const temporaryPath = join(temporaryDir, 'record.bin')
  try {
    await pipeline(req, createWriteStream(temporaryPath))
    const metaHeader = typeof req.headers?.['x-dsh-idb-meta'] === 'string' ? req.headers['x-dsh-idb-meta'] : ''
    let meta: Record<string, unknown> = {}
    if (metaHeader !== '') {
      try {
        const parsed = JSON.parse(Buffer.from(metaHeader, 'base64url').toString('utf8')) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>
        else throw new Error('meta must be an object')
      } catch (error) {
        throw new Error(`x-dsh-idb-meta is not valid base64url JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const result = await putIdbRecordFromFile(tavernDataRoot(), character, dbName, storeName, key, temporaryPath, meta)
    return sendJson(res, 200, { ok: true, value: result })
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

// 美化前端 localStorage 的初始播种（2026-10-22）：沙箱 iframe 的 localStorage
// 是内存实现，FrontendFrame 在构建 srcdoc 之前先取本角色的持久表，同步注入
// 到 shim；写入仍走 helper 的 storage.set。只读、按角色隔离。
export async function handleFrontendStorageRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  if (!character) throw new Error('character query is required')
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    storage: state.frontendStorage?.[character] ?? {},
  })
}

// 美化前端（AgentTavern 右栏展示面，2026-10-20）：native conversation 由宿主
// 渲染，消息里的完整 HTML 没有插件正文 slot。右栏 tab 只取「最新一条带完整
// HTML 的楼层」——面板按 5s 轮询，回传整份聊天在长聊天上会是 MB 级；这里在
// 服务端完成抽取，只传文档本身。displayTexts 与内联 transcript 同一展示层
// （markdownOnly regex 脚本），不另造一套文本。
export async function handleFrontendLatestRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const state = await db.getState()
  const character = url.searchParams.get('character') || state.activeCharacter
  const chatId = url.searchParams.get('chatId')
  if (!character) throw new Error('no active character')
  if (!chatId) throw new Error('chatId query is required')
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
  // 只从最新楼层向前渲染到第一条带完整文档的楼层：长篇聊天里对全部楼层
  // 重跑 markdownOnly 正则会把 5s 轮询变成 CPU 热点。会话正则覆盖层与生成
  // 读同一份集合，卡前端写入的展示脚本无需等下一次刷新。
  const card = await db.getCharacter(character)
  const scripts = await collectSessionRegexScripts(db, state, character, chatId, card)
  const message = latestFrontendMessage(snapshot.chat.messages, (entry, index) =>
    displayTextForMessage(scripts, entry, snapshot.chat.messages.length - 1 - index))
  return sendJson(res, 200, {
    ok: true,
    revision: snapshot.revision,
    messageCount: snapshot.chat.messages.length,
    ...(message === undefined ? {} : { message }),
  })
}

// One projected message's display text (AgentTavern native conversation
// cannot render the plugin transcript). The projector stores the save-layer
// text in the JSONL under extra.agentTavern.messageId; this lookup applies
// markdownOnly scripts on top so the native assistant row matches the ST
// display layer without transferring the whole chat.
export async function handleDisplayRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  const chatId = url.searchParams.get('chatId')
  const messageId = url.searchParams.get('messageId')
  if (!character || !chatId || !messageId) throw new Error('character, chatId and messageId are required')
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
  const index = snapshot.chat.messages.findIndex((message) => {
    const extra = message.extra?.agentTavern
    return typeof extra === 'object' && extra !== null && (extra as Record<string, unknown>).messageId === messageId
  })
  if (index < 0) return sendJson(res, 200, { ok: true, text: null })
  const state = await db.getState()
  const card = await db.getCharacter(character)
  const scripts = await collectSessionRegexScripts(db, state, character, chatId, card)
  return sendJson(res, 200, {
    ok: true,
    text: stripFrontendDocuments(displayTextForMessage(scripts, snapshot.chat.messages[index]!, snapshot.chat.messages.length - 1 - index)),
  })
}
