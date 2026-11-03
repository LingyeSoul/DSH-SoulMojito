import { parseRegexScripts } from '../../../tavern-format/src/index.js'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { getIdbRecord, IDB_MAX_RECORD_BYTES, putIdbRecordFromFile } from '../../../tavern-frontend-storage/src/index.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { collectCardScriptBundle } from '../card-scripts.js'
import { tavernDataRoot } from '../dsh-home.js'
import { latestFrontendMessage, stripFrontendDocuments } from '../frontend-documents.js'
import { handleFrontendGenerationStream, handleHelperApi } from '../helper.js'
import { createHelperBinding, deleteHelperBinding, helperTokenFromRequest } from '../helper-bindings.js'
import { generate, runTavernScript } from '../generation/pipeline.js'
import { emitAssetsSaved, emitChatSaved } from '../mods/events.js'
import { displayTextForMessage, displayTexts } from '../prompt-context.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import {
  store,
  variables,
} from '../runtime.js'
import { normalizeChatId } from '../session/trace.js'
import { HttpError } from './errors.js'
import type { PluginContext } from '../host-contract.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asChatLog, asRecord } from './json-records.js'
import { EARLY_STORE_ROUTES, PRE_STORE_ROUTES, STORE_ROUTES } from './routes.js'

// The body handler moved to `body-api.ts`; the router module keeps re-exporting
// it so callers that import it from here do not break.
export { handleAgentTavernBodyApi } from './body-api.js'

export const API = '/api/dsh-soulmojito'
export async function handleApi(ctx: PluginContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  const url = new URL(req.url ?? API, 'http://localhost')
  const route = url.pathname.slice(API.length).replace(/^\//, '')
  const method = req.method ?? 'GET'

  for (const entry of PRE_STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method })
    return
  }

  const db = await store()

  for (const entry of EARLY_STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method, db })
    return
  }

  for (const entry of STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method, db })
    return
  }

  if (method === 'GET' && route.startsWith('world/')) {
    const name = decodeURIComponent(route.slice('world/'.length))
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    return sendJson(res, 200, { ok: true, book })
  }

  if (method === 'PUT' && route.startsWith('world/')) {
    const oldName = decodeURIComponent(route.slice('world/'.length))
    const body = await readJson(req, 10 * 1024 * 1024)
    const data = asRecord(body.data)
    if (typeof body.name !== 'string' || body.name.trim() === '' || data === undefined) {
      throw new Error('expected { name, data }')
    }
    const name = body.name
    const book = await db.importWorldFile(name, data)
    await emitAssetsSaved('world', book.name)
    if (name !== oldName) {
      await db.deleteWorld(oldName)
      await db.updateState((current) => ({ activeWorlds: current.activeWorlds.map((item) => item === oldName ? name : item) }))
    }
    return sendJson(res, 200, { ok: true, name: book.name, book })
  }

  if (method === 'GET' && route.startsWith('export/world/')) {
    const name = decodeURIComponent(route.slice('export/world/'.length))
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    const bytes = await db.exportWorld(name)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(`${name}.json`)}"`)
    res.end(Buffer.from(bytes))
    return
  }

  if (method === 'DELETE' && route === 'world') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    await db.deleteWorld(name)
    const state = await db.updateState((current) => ({
      activeWorlds: current.activeWorlds.filter((world) => world !== name),
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'DELETE' && route === 'preset') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const preset = await db.getPreset(name)
    if (!preset) return sendJson(res, 404, { ok: false, message: 'preset not found' })
    await db.deletePreset(name)
    const state = await db.updateState((current) => ({
      activePreset: current.activePreset === name ? undefined : current.activePreset,
    }))
    // 删除激活预设会回落内置默认预设：AgentTavern 投影同样要写穿。
    await emitAgentPresetChanged()
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'GET' && route.startsWith('export/preset/')) {
    const name = decodeURIComponent(route.slice('export/preset/'.length))
    const preset = await db.getPreset(name)
    if (!preset) return sendJson(res, 404, { ok: false, message: 'preset not found' })
    const bytes = await db.exportPreset(name)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(`${name}.json`)}"`)
    res.end(Buffer.from(bytes))
    return
  }

  if (method === 'GET' && route === 'variables') {
    const state = await db.getState()
    return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
  }

  if (method === 'PUT' && route === 'variables') {
    const body = await readJson(req)
    if (body.globals === null || typeof body.globals !== 'object' || Array.isArray(body.globals)) {
      throw new Error('expected { globals }')
    }
    const globals: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(body.globals)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`global '${key}' must be a string, number or boolean`)
      }
      globals[key] = value
    }
    const state = await db.updateState(() => ({ scriptGlobals: globals }))
    return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
  }

  if (method === 'GET' && route === 'regex') {
    await db.ensureRegexScriptOwners()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  if (method === 'PUT' && route === 'regex') {
    await db.ensureRegexScriptOwners()
    // Card frontends may keep large HTML/state regex replacements (multi-MB).
    // The default 2 MiB body cap rejected the panel's full-list save with a
    // connection reset while the request was still streaming.
    const body = await readJson(req, 25 * 1024 * 1024)
    const scripts = Array.isArray(body.scripts) ? parseRegexScripts(body.scripts) : undefined
    if (scripts === undefined) throw new Error('expected { scripts }')
    const state = await db.replaceRegexScripts(scripts)
    return sendJson(res, 200, {
      ok: true,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  if (method === 'POST' && route === 'import/regex') {
    await db.ensureRegexScriptOwners()
    const body = await readJson(req, 25 * 1024 * 1024)
    if (!Array.isArray(body.data) && typeof body.data !== 'object') throw new Error('expected { data }')
    const imported = await db.importRegexScripts(body.data)
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      imported,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // 存量卡回填：导入时自动物化只覆盖此后导入的卡，旧卡需显式同步一次。
  if (method === 'POST' && route === 'regex/sync-cards') {
    await db.ensureRegexScriptOwners()
    const result = await db.backfillRegexScriptsFromCharacters()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      ...result,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // 存量预设回填：预设内嵌 regex 的导入期物化同样只覆盖此后导入的预设。
  if (method === 'POST' && route === 'regex/sync-presets') {
    await db.ensureRegexScriptOwners()
    const result = await db.backfillRegexScriptsFromPresets()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      ...result,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // Server-issued helper binding (2026-10-25): the host page owns the session
  // binding, so its FrontendFrame exchanges the current character/chatId for a
  // token on mount. Helper and frontend/generate routes resolve identity from
  // the token instead of trusting the sandbox payload. Both routes sit inside
  // the same origin/content-type trust guard as the rest of the API.
  if (method === 'POST' && route === 'helper/bind') {
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

  if (method === 'POST' && route === 'helper/unbind') {
    const body = await readJson(req)
    const token = helperTokenFromRequest(req) ?? (typeof body?.token === 'string' ? body.token.trim() : '')
    if (token !== '') deleteHelperBinding(token)
    return sendJson(res, 200, { ok: true })
  }

  // 酒馆助手兼容面（2026-10-20）：美化前端 iframe 经 token 校验的 postMessage
  // RPC 转发到这里。沙箱不放宽（无 same-origin、CSP connect-src 'none'），
  // 能力在宿主侧代理；character/chatId 由客户端按自身会话绑定注入，iframe
  // 无法寻址别的聊天。
  if (method === 'POST' && route === 'helper') {
    return handleHelperApi(req, res, db)
  }

  if (method === 'POST' && route === 'frontend/generate') {
    return handleFrontendGenerationStream(req, res, db)
  }

  // 卡脚本右栏（2026-10-21）：JSR 卡的常驻脚本树在
  // `data.extensions.tavern_helper.scripts`。插件仍不自动执行脚本树；这里只
  // 供「卡脚本」tab 列出启用的脚本，用户点「运行」后才在沙箱 iframe 里跑一份。
  // 带 chatId 时优先会话脚本树副本（GM 面板持久化的 Zod 源码）。
  if (method === 'GET' && route === 'card/scripts') {
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
  if (method === 'GET' && route === 'frontend/idb/get') {
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

  if (method === 'POST' && route === 'frontend/idb/put') {
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
  if (method === 'GET' && route === 'frontend/storage') {
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
  if (method === 'GET' && route === 'frontend/latest') {
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
  if (method === 'GET' && route === 'display') {
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

  if (route.startsWith('chat/')) {
    const chatId = decodeURIComponent(route.slice('chat/'.length))
    const state = await db.getState()
    const character = url.searchParams.get('character') || state.activeCharacter
    if (!character) throw new Error('no active character')
    if (method === 'GET') {
      const snapshot = await db.getChatSnapshot(character, chatId)
      return snapshot
        ? sendJson(res, 200, { ok: true, chat: snapshot.chat, revision: snapshot.revision, displays: await displayTexts(db, state, character, chatId, snapshot.chat) })
        : sendJson(res, 404, { ok: false, message: 'chat not found' })
    }
    if (method === 'PUT') {
      const body = await readJson(req)
      const chat = asChatLog(body.chat)
      if (chat === undefined || typeof body.revision !== 'string') {
        throw new Error('expected { chat, revision }')
      }
      const revision = await db.saveChat(character, chatId, chat, body.revision)
      await emitChatSaved(character, chatId, revision, chat.messages.length)
      return sendJson(res, 200, { ok: true, chat, revision })
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (typeof body.name !== 'string' || typeof body.revision !== 'string') {
        throw new Error('expected { name, revision }')
      }
      const nextChatId = normalizeChatId(body.name)
      await db.renameChat(character, chatId, nextChatId, body.revision)
      const state = await db.updateState((current) => ({
        sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings).map(([sessionId, binding]) => [
          sessionId,
          binding.character === character && binding.chatId === chatId
            ? { ...binding, character, chatId: nextChatId }
            : binding,
        ])),
      }))
      const snapshot = await db.getChatSnapshot(character, nextChatId)
      return sendJson(res, 200, {
        ok: true,
        id: nextChatId,
        chat: snapshot?.chat,
        revision: snapshot?.revision,
        state,
      })
    }
    if (method === 'DELETE') {
      const body = await readJson(req)
      if (typeof body.revision !== 'string') throw new Error('expected { revision }')
      const deleted = await db.deleteChat(character, chatId, body.revision)
      if (deleted) {
        await db.updateState((current) => ({
          sessionBindings: Object.fromEntries(
            Object.entries(current.sessionBindings)
              .filter(([, binding]) => binding.character !== character || binding.chatId !== chatId),
          ),
        }))
      }
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { ok: false, message: 'chat not found' })
    }
  }

  if (method === 'POST' && route === 'generate') {
    return generate(ctx, req, res, db)
  }

  if (method === 'POST' && route === 'script') {
    return runTavernScript(ctx, req, res, db)
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}
