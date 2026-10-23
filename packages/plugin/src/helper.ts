/**
 * TavernHelper compatibility surface (2026-10-20, user request: 美化前端要深度
 * 兼容酒馆助手行为，浅克隆参考 JS-Slash-Runner).
 *
 * JS-Slash-Runner (PolyForm NonCommercial) runs message frontends same-origin and
 * copies ~200 parent APIs into the iframe. This plugin keeps its sandbox
 * (`allow-scripts`, no same-origin, CSP `connect-src 'none'`) and re-implements
 * the *observable* subset over token-checked postMessage RPC plus this HTTP
 * endpoint. Only behavior is mirrored; no JSR source is copied.
 *
 * The client always names the binding (character/chatId) from its own session
 * binding — the iframe can never address another chat. Supported families:
 * variables (global/chat/message/character read+write; character writes are an
 * overlay in state.json, never the card file), chat messages
 * (get/set/create/delete), character read, lorebook read, slash commands, regex
 * list/replace, plus a snapshot used for synchronous iframe reads.
 */
import type { ChatLogIR, ChatMessage, LoreEntry, WorldBookIR } from '../../tavern-format/src/index.js'
import { RegexPlacement, cardDataToRaw, normalizeEntry, parseCharacterBook, parseRegexScripts } from '../../tavern-format/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { renderSandboxed } from '../../tavern-template/src/index.js'
import { applyRegexScript, applyRegexScripts, runScript } from '../../tavern-script/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { ChatRevisionConflictError } from '../../tavern-store/src/index.js'
import {
  clearIdbStore,
  createIdbStore,
  deleteIdbDatabase,
  deleteIdbRecord,
  frontendStorageFor,
  openIdbDatabase,
  putFrontendStorage,
  resetFrontendStorage,
} from '../../tavern-frontend-storage/src/index.js'
import { readJson, sendJson } from './http/io.js'
import { generateWithCustomApi, listCustomApiModels } from './frontend-generation.js'
import { applyFrontendWorldbookScan } from './frontend-generation-context.js'
import { tavernDataRoot } from './dsh-home.js'
import { overlayChatScopedVariables, readChatVariables } from './mvu.js'
import { ensureChatVariables } from './agent-tavern/mvu-compat.js'
import { emitChatSaved } from './mods/events.js'
import { DEFAULT_USER } from './prompt-context.js'
import { variables } from './runtime.js'
import { collectRegexScripts } from './tavern-assets.js'

type JsonObject = Record<string, unknown>

const VARIABLE_NAME = /^[\p{L}_][\p{L}\p{N}_.-]{0,63}$/u

export async function handleHelperApi(req: unknown, res: unknown, db: TavernStore): Promise<void> {
  const body = await readJson(req as never, 8 * 1024 * 1024)
  const op = typeof body?.op === 'string' ? body.op : ''
  const character = requireString(body?.character, 'character')
  const chatId = typeof body?.chatId === 'string' ? body.chatId : ''
  const state = await db.getState()

  switch (op) {
    case 'snapshot':
      return sendJson(res, 200, { ok: true, value: await buildSnapshot(db, state, character, chatId) })
    case 'variables.replace':
      return sendJson(res, 200, {
        ok: true,
        value: await replaceVariables(db, state, character, chatId, body),
      })
    case 'mvu.replace':
      return sendJson(res, 200, {
        ok: true,
        value: await replaceMvuData(db, character, chatId, body),
      })
    // JSR 生成桥（2026-10-22）：卡前端自带 OpenAI 兼容 API 源。服务端代发
    // /models 与 /chat/completions，API Key 只进 outbound header，不回传、不落盘。
    // chatId 必须存在：只有真正绑定到聊天的 iframe 才能发起生成。
    case 'models': {
      requireSessionChatId(chatId, 'models')
      return sendJson(res, 200, {
        ok: true,
        value: { models: await listCustomApiModels({ apiurl: body?.apiurl, key: body?.key }) },
      })
    }
    case 'generate': {
      requireSessionChatId(chatId, 'generate')
      const config = await applyFrontendWorldbookScan(db, state, character, chatId, body?.config)
      return sendJson(res, 200, {
        ok: true,
        value: { text: await generateWithCustomApi(config) },
      })
    }
    // 沙箱 localStorage 持久层（2026-10-22）：按角色保存小型设置，供下一次
    // srcdoc 同步播种。存储上限 512KB/角色；写走 updateState 的串行队列。
    case 'storage.get': {
      requireSessionChatId(chatId, 'storage.get')
      return sendJson(res, 200, {
        ok: true,
        value: { storage: frontendStorageFor(state, character) },
      })
    }
    case 'storage.set': {
      requireSessionChatId(chatId, 'storage.set')
      return sendJson(res, 200, {
        ok: true,
        value: await putFrontendStorage(db, character, body?.storage),
      })
    }
    case 'storage.reset': {
      requireSessionChatId(chatId, 'storage.reset')
      return sendJson(res, 200, {
        ok: true,
        value: await resetFrontendStorage(db, character),
      })
    }
    // 虚拟 IndexedDB 的控制面（2026-10-22）：数据本身走 frontend/idb/put|get
    // 二进制路由，这里只处理 open / create-store / delete 等小 JSON 操作。
    // 所有名字由服务端 hash 后落盘，iframe 无法寻址别的角色或目录。
    case 'idb.open': {
      requireSessionChatId(chatId, 'idb.open')
      return sendJson(res, 200, {
        ok: true,
        value: await openIdbDatabase(tavernDataRoot(), character, body?.name, body?.version),
      })
    }
    case 'idb.store.create': {
      requireSessionChatId(chatId, 'idb.store.create')
      return sendJson(res, 200, {
        ok: true,
        value: await createIdbStore(tavernDataRoot(), character, body?.db, body?.store, body?.keyPath),
      })
    }
    case 'idb.delete': {
      requireSessionChatId(chatId, 'idb.delete')
      return sendJson(res, 200, {
        ok: true,
        value: await deleteIdbRecord(tavernDataRoot(), character, body?.db, body?.store, body?.key),
      })
    }
    case 'idb.clear': {
      requireSessionChatId(chatId, 'idb.clear')
      return sendJson(res, 200, {
        ok: true,
        value: await clearIdbStore(tavernDataRoot(), character, body?.db, body?.store),
      })
    }
    case 'idb.delete-db': {
      requireSessionChatId(chatId, 'idb.delete-db')
      return sendJson(res, 200, {
        ok: true,
        value: await deleteIdbDatabase(tavernDataRoot(), character, body?.db),
      })
    }
    case 'messages.get':
      return sendJson(res, 200, { ok: true, value: await getMessages(db, character, chatId, body) })
    case 'messages.set':
      return sendJson(res, 200, {
        ok: true,
        value: await mutateMessages(db, character, chatId, 'set', body),
      })
    case 'messages.create':
      return sendJson(res, 200, {
        ok: true,
        value: await mutateMessages(db, character, chatId, 'create', body),
      })
    case 'messages.delete':
      return sendJson(res, 200, {
        ok: true,
        value: await mutateMessages(db, character, chatId, 'delete', body),
      })
    case 'messages.rotate':
      return sendJson(res, 200, {
        ok: true,
        value: await rotateMessages(db, character, chatId, body),
      })
    case 'slash':
      return sendJson(res, 200, {
        ok: true,
        value: await runHelperSlash(db, state, character, chatId, requireString(body?.command, 'command')),
      })
    case 'character.list':
      return sendJson(res, 200, { ok: true, value: { names: await db.listCharacters() } })
    case 'character.get': {
      const requested = typeof body?.name === 'string' && body.name !== '' && body.name !== 'current'
        ? body.name
        : character
      const file = await db.getCharacter(requested)
      return sendJson(res, 200, {
        ok: true,
        value: { character: file === undefined ? null : cardDataToRaw(file.card) },
      })
    }
    case 'lorebook.list': {
      const names = await visibleWorldNames(db, character, chatId)
      return sendJson(res, 200, { ok: true, value: { names, active: state.activeWorlds } })
    }
    case 'lorebook.get': {
      const name = typeof body?.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : await defaultLorebookName(db, state, character)
      if (name === undefined) throw new Error('no active lorebook')
      const resolved = await loadLorebook(db, character, chatId, name)
      if (resolved === undefined || resolved.extra?.['__jsrDeleted'] === true) {
        throw new Error(`lorebook '${name}' not found (no session copy, no worlds/ asset and no matching character card book)`)
      }
      return sendJson(res, 200, {
        ok: true,
        value: { name, entries: resolved.entries.map((entry) => worldbookReaderEntry(entry, name)) },
      })
    }
    // Session world copy (2026-10-21): scripts write the chat overlay only.
    // `worlds/<name>.json` and the card's embedded book stay read-only, so a
    // runaway script can never corrupt the shared asset. `lorebook.reset`
    // drops the overlay and falls back to the base asset.
    case 'lorebook.put':
      return sendJson(res, 200, {
        ok: true,
        value: await putLorebook(db, character, chatId, body),
      })
    case 'lorebook.create':
      return sendJson(res, 200, {
        ok: true,
        value: await createLorebook(db, character, chatId, body),
      })
    case 'lorebook.delete':
      return sendJson(res, 200, {
        ok: true,
        value: await deleteLorebookSession(db, character, chatId, body),
      })
    case 'lorebook.reset': {
      const name = requireString(body?.name, 'name')
      if (chatId === '') throw new Error('chatId is required for lorebook.reset (session scope only)')
      await serializeSessionWrite(`${character}\u0000${chatId}\u0000${name}`, async () => {
        await db.deleteChatWorld(character, chatId, name)
      })
      return sendJson(res, 200, { ok: true, value: { name, reset: true } })
    }
    case 'chat.world.set':
      return sendJson(res, 200, {
        ok: true,
        value: await setChatWorld(db, character, chatId, body),
      })
    case 'presets.put':
      return sendJson(res, 200, {
        ok: true,
        value: await putSessionPreset(db, character, chatId, body),
      })
    case 'personas.put':
      return sendJson(res, 200, {
        ok: true,
        value: await putSessionPersona(db, character, chatId, body),
      })
    case 'template.render':
      return sendJson(res, 200, {
        ok: true,
        value: { text: await renderFrontendTemplate(db, state, character, chatId, body) },
      })
    // 会话脚本树副本（2026-10-21）：GM 面板改写的 Zod 源码按聊天持久化，刷新
    // 后仍可读；角色卡文件与基础脚本树保持只读。执行语义不变——只有用户手动
    // 运行卡脚本时才会跑副本内容，服务端 MVU 不执行 Zod。
    case 'scripts.get': {
      requireSessionChatId(chatId, 'scripts.get')
      const type = requireScriptTreeType(body?.type)
      return sendJson(res, 200, { ok: true, value: await readScriptTrees(db, state, character, chatId, type) })
    }
    case 'scripts.put':
      return sendJson(res, 200, {
        ok: true,
        value: await putChatScripts(db, state, character, chatId, body),
      })
    case 'scripts.patch': {
      requireSessionChatId(chatId, 'scripts.patch')
      return sendJson(res, 200, {
        ok: true,
        value: await patchScriptNode(db, character, chatId, body),
      })
    }
    case 'script.variables.replace': {
      requireSessionChatId(chatId, 'script.variables.replace')
      return sendJson(res, 200, {
        ok: true,
        value: await replaceScriptVariables(db, character, chatId, body),
      })
    }
    case 'scripts.reset': {
      requireSessionChatId(chatId, 'scripts.reset')
      const type = requireScriptTreeType(body?.type)
      await serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
        await resetScriptTrees(db, character, chatId, type)
      })
      return sendJson(res, 200, { ok: true, value: { reset: true } })
    }
    case 'regex.get': {
      // 卡级脚本跟随会话角色卡：返回当前角色可见的全局 + 卡内合并集，而不是
      // 直接吐全局表（否则别的卡的脚本会泄漏到 JSR 读取面）。
      const scripts = collectRegexScripts(state, await db.getCharacter(character))
      return sendJson(res, 200, { ok: true, value: { scripts } })
    }
    case 'regex.format': {
      const text = typeof body?.text === 'string' ? body.text : ''
      const placement = typeof body?.placement === 'number' ? body.placement : 2
      // TavernHelper 的 formatAsTavernRegexedString 语义：应用给定脚本（通常是
      // getTavernRegexes 的结果）；未给时用当前会话角色可见的启用脚本。正则只做
      // 文本变换，不回写任何状态。
      const provided = Array.isArray(body?.scripts) ? parseRegexScripts(body.scripts) : undefined
      const scripts = (provided ?? collectRegexScripts(state, await db.getCharacter(character)))
        .filter((script) => !script.disabled)
      return sendJson(res, 200, {
        ok: true,
        value: {
          text: applyRegexScripts(text, scripts, placement, { expand: (value: string) => value }, {
            ...(typeof body?.depth === 'number' ? { depth: body.depth } : {}),
          }),
        },
      })
    }
    default:
      throw new Error(`unsupported helper op '${op}'`)
  }
}

/* ------------------------------- snapshot ------------------------------- */

/**
 * Sync-read payload for the iframe. Mirrors TavernHelper's synchronous getters:
 * variables of every scope, the last message variables, and a message window.
 * Everything is a clone — the iframe mutates its own copy and writes back
 * through `variables.replace` / `messages.*`.
 */
async function buildSnapshot(db: TavernStore, state: TavernState, character: string, chatId: string) {
  const file = await db.getCharacter(character)
  const characterNames = await db.listCharacters()
  const characterId = characterNames.indexOf(character)
  const personas = await db.listPersonas()
  const personaValues: Record<string, unknown> = {}
  for (const name of personas) {
    const persona = await db.getPersona(name)
    if (persona !== undefined) personaValues[name] = cloneJson(persona)
  }
  const presets = await db.listPresets()
  const presetValues: Record<string, unknown> = {}
  for (const name of presets) {
    const preset = await db.getPreset(name)
    if (preset !== undefined) presetValues[name] = cloneJson(preset)
  }
  const characterData = file === undefined ? null : cardDataToRaw(file.card)
  const shared = {
    characterName: character,
    characterId: characterId < 0 ? 0 : characterId,
    userName: state.activePersona ?? DEFAULT_USER,
    personaDescription: '',
    avatar: avatarPath(character),
    characterData,
    characters: { names: characterNames, ids: characterNames.map((_, index) => String(index)) },
    personas: {
      names: personas,
      ids: personas.map((name) => name),
      active: state.activePersona ?? null,
      values: personaValues,
    },
    presets: { names: presets, active: state.activePreset ?? null, values: presetValues },
  }
  if (chatId === '') {
    return {
      ...shared,
      chatId: '',
      chatMetadata: {},
      messages: [],
      messageCount: 0,
      lastMessageId: -1,
      variables: {
        global: cloneJson(plainObject(state.scriptGlobals) ?? {}),
        chat: {},
        message: {},
        character: characterVariablesFor(state, character, file?.card.data.extensions?.['variables']),
      },
      scriptTrees: null,
      scriptTreesByType: { character: null, preset: null, global: null },
      scriptVariables: {},
      regexScripts: splitRegexScripts(state, file),
      worlds: {
        names: await visibleWorldNames(db, character, chatId),
        active: state.activeWorlds,
        char: characterWorldLinks(file),
        chat: null,
      },
    }
  }
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' not found`)
  const chat = snapshot.chat
  const chatVariables = await readChatScope(db, chat, chatId)
  const overlay = await db.getChatJsrOverlay(character, chatId)
  if (overlay?.presets !== undefined) {
    for (const [name, preset] of Object.entries(overlay.presets)) presetValues[name] = cloneJson(preset)
    shared.presets.names = [...new Set([...presets, ...Object.keys(overlay.presets)])].sort()
  }
  if (overlay?.personas !== undefined) {
    for (const [name, persona] of Object.entries(overlay.personas)) personaValues[name] = cloneJson(persona)
    shared.personas.names = [...new Set([...personas, ...Object.keys(overlay.personas)])].sort()
    shared.personas.ids = shared.personas.names.map((name) => name)
  }
  const lastIndex = chat.messages.length - 1
  const persona = state.activePersona ? await db.getPersona(state.activePersona) : undefined
  const presetTrees = state.activePreset === undefined
    ? null
    : await activePresetScriptTrees(db, state.activePreset)
  return {
    ...shared,
    personaDescription: persona?.description ?? '',
    chatId,
    chatMetadata: cloneJson(chat.header.chat_metadata ?? {}),
    messages: chat.messages.map((message, index) => toJsrMessage(message, index)),
    messageCount: chat.messages.length,
    lastMessageId: lastIndex,
    variables: {
      global: cloneJson(plainObject(state.scriptGlobals) ?? {}),
      chat: cloneJson(chatVariables),
      message: lastIndex >= 0 ? cloneJson(readMessageVariables(chat.messages[lastIndex])) : {},
      character: characterVariablesFor(state, character, file?.card.data.extensions?.['variables']),
    },
    scriptTrees: overlay === undefined ? null : cloneJson(overlay.trees?.character ?? overlay.scriptTrees),
    scriptTreesByType: {
      character: overlay === undefined ? null : cloneJson(overlay.trees?.character ?? overlay.scriptTrees),
      preset: presetTrees,
      global: overlay?.trees?.global === undefined ? null : cloneJson(overlay.trees.global),
    },
    scriptVariables: cloneJson(overlay?.scriptVariables ?? {}),
    regexScripts: splitRegexScripts(state, file),
    worlds: {
      names: await visibleWorldNames(db, character, chatId),
      active: state.activeWorlds,
      char: characterWorldLinks(file),
      chat: chatWorldName(chat),
    },
  }
}

/** Character-linked world books: `extensions.world` first, embedded book second. */
function characterWorldLinks(file: { card: { data: { extensions: Record<string, unknown>; characterBook?: { name?: string } } } } | undefined) {
  const linked = file?.card.data.extensions['world']
  const primary = typeof linked === 'string' && linked.trim() !== '' ? linked.trim() : null
  const embedded = file?.card.data.characterBook?.name
  return {
    primary,
    additional: [] as string[],
    embedded: typeof embedded === 'string' && embedded.trim() !== '' ? embedded.trim() : null,
  }
}

/** Chat-bound world book (ST stores it in `chat_metadata.world`). */
function chatWorldName(chat: ChatLogIR): string | null {
  const world = plainObject(chat.header.chat_metadata)?.['world']
  return typeof world === 'string' && world.trim() !== '' ? world.trim() : null
}

/** Active preset's embedded JSR script tree, read-only for the sandbox. */
async function activePresetScriptTrees(db: TavernStore, presetName: string): Promise<unknown[] | null> {
  const preset = await db.getPreset(presetName)
  const extensions = plainObject(preset?.['extensions'])
  const helper = plainObject(extensions?.['tavern_helper'])
  const scripts = helper?.['scripts']
  return Array.isArray(scripts) ? cloneJson(scripts) : null
}

/**
 * Regex scripts split by JSR scope. Session writes are not supported for regex
 * assets yet, so every entry comes from the state-level tables plus the card's
 * embedded `extensions.regex_scripts`.
 */
function splitRegexScripts(
  state: TavernState,
  file: { card: { data: { name: string; extensions: Record<string, unknown> } } } | undefined,
): { global: unknown[]; character: unknown[]; preset: unknown[] } {
  const cardName = file?.card.data.name
  const global: unknown[] = []
  const character: unknown[] = []
  const preset: unknown[] = []
  for (const script of state.regexScripts) {
    const cardOwner = state.regexScriptOwners?.[script.id]
    const presetOwner = state.regexScriptPresetOwners?.[script.id]
    if (cardOwner !== undefined && cardOwner === cardName) character.push(cloneJson(script))
    else if (presetOwner !== undefined && presetOwner === state.activePreset) preset.push(cloneJson(script))
    else if (cardOwner === undefined && presetOwner === undefined) global.push(cloneJson(script))
  }
  const embedded = file?.card.data.extensions['regex_scripts']
  if (embedded !== undefined && embedded !== null) {
    for (const script of parseRegexScripts(embedded)) character.push(cloneJson(script))
  }
  return { global, character, preset }
}

/**
 * Character scope read: a frontend overlay wins over the card's read-only
 * `extensions.variables`. Cards use `updateVariablesWith` on this scope, so the
 * overlay is normally a complete table (not a partial patch).
 */
function characterVariablesFor(state: TavernState, character: string, cardVariables: unknown): JsonObject {
  const overlay = plainObject(state.characterVariables?.[character])
  if (overlay !== undefined) return cloneJson(overlay)
  return cloneJson(plainObject(cardVariables) ?? {})
}

function avatarPath(character: string): string {
  return `/api/dsh-soulmojito/avatar/${encodeURIComponent(character)}`
}

/* ------------------------------- variables ------------------------------- */

async function readChatScope(db: TavernStore, chat: ChatLogIR, chatId: string): Promise<JsonObject> {
  const base = readChatVariables(chat)
  const bound = await isAgentTavernBound(db, chatId)
  if (!bound) return base
  const scoped = await (await variables()).listAll('chat', chatId)
  return overlayChatScopedVariables(base, scoped)
}

async function replaceVariables(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<JsonObject> {
  const scope = requireVariableScope(body?.scope)
  const tree = requireObject(body?.variables, 'variables')
  if (scope === 'global') {
    await db.updateState(() => ({ scriptGlobals: tree }))
    return tree
  }
  // Character scope writes an overlay in state.json; the card file and its
  // `extensions.variables` stay read-only (same trust boundary as lorebooks).
  if (scope === 'character') {
    await db.updateState((current) => ({
      characterVariables: {
        ...(current.characterVariables ?? {}),
        [character]: cloneJson(tree),
      },
    }))
    return tree
  }
  // Multiple card scripts start together (MVU + status panel + front-end) and
  // write the same chat at once. Serializing helper writes prevents avoidable
  // CAS 500s during that startup burst; the store CAS still guards host writes.
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000chat`, () => retryChatWrite(async () => {
    if (scope === 'chat') {
      const snapshot = await requireChat(db, character, chatId)
      const chat = snapshot.chat
      if (Object.keys(tree).length > 0) chat.header.chat_metadata.variables = tree
      else delete chat.header.chat_metadata.variables
      await persistChat(db, character, chatId, chat, snapshot.revision)
      if (await isAgentTavernBound(db, chatId)) {
        // stat_data 是单个嵌套树（禁止 flatten：卡里键名含 `&`，flat 名会被
        // VariableStore 拒绝）；镜像失败不反噬聊天主写入，聊天文件仍是权威。
        try {
          await mirrorChatScope(chatId, tree)
        } catch (error) {
          console.warn(`dsh-soulmojito: chat-scope mirror skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return tree
    }
    const snapshot = await requireChat(db, character, chatId)
    const index = resolveMessageId(snapshot.chat.messages, body?.messageId)
    const message = snapshot.chat.messages[index]
    message.variables = tree
    await persistChat(db, character, chatId, snapshot.chat, snapshot.revision)
    return tree
  }))
}

/**
 * AgentTavern keeps two readers for chat state: `chat_metadata.variables`
 * (ST-compatible display tree, `$` keys included) and the chat-scope
 * VariableStore consumed by MVU/tools. A helper replace writes both so a
 * TavernHelper HUD and the MVU status bar never drift apart.
 */
/**
 * 前端 `Mvu.replaceMvuData` 的写穿：更新目标楼层变量 + 聊天权威变量树，
 * 并尽量镜像到 chat 作用域。状态栏按钮改完数据后，下一轮投影从同一棵树继续。
 */
async function replaceMvuData(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<JsonObject> {
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000chat`, () => retryChatWrite(async () => {
    const snapshot = await requireChat(db, character, chatId)
    const chat = snapshot.chat
    const stat = requireObject(body?.statData, 'statData')
    const chatVariables = ensureChatVariables(chat)
    chatVariables['stat_data'] = stat
    chatVariables['initialized_lorebooks'] = true
    let messageId = -1
    if (chat.messages.length > 0) {
      messageId = body?.messageId === undefined ? chat.messages.length - 1 : resolveMessageId(chat.messages, body.messageId)
      const message = chat.messages[messageId]
      message.variables = {
        ...(plainObject(message.variables) ?? {}),
        stat_data: cloneJson(stat),
      }
    }
    const revision = await persistChat(db, character, chatId, chat, snapshot.revision)
    try {
      const store = await variables()
      const existing = await store.get('chat', chatId, 'stat_data')
      await store.set('chat', chatId, 'stat_data', stat as never, existing?.revision)
    } catch (error) {
      console.warn(`dsh-soulmojito: MVU chat-scope mirror skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { stat_data: cloneJson(stat), messageId, revision }
  }))
}

async function mirrorChatScope(chatId: string, tree: JsonObject): Promise<void> {
  const store = await variables()
  const entries = variableEntriesForMirror(tree)
  const nextNames = new Set(entries.map((entry) => entry.name))
  for (const entry of await store.listAll('chat', chatId)) {
    if (nextNames.has(entry.name) || entry.name.startsWith('$')) continue
    await store.delete('chat', chatId, entry.name)
  }
  if (entries.length > 0) {
    await store.patch('chat', chatId, entries.map((entry) => ({ name: entry.name, value: entry.value as never })))
  }
}

/**
 * Helper/前端写回的变量树 → chat 作用域 flat 条目。`stat_data` 保持整树单值：
 * MVU 卡的键名包含 `&`（如 `身份&职业`），flat 化会被 VariableStore 的名字
 * 规则拒绝；整树单值也让前端 `Mvu.getMvuData` 与 EJS 的 `getvar('stat_data')`
 * 严格同源。
 */
function variableEntriesForMirror(tree: JsonObject): Array<{ name: string; value: unknown }> {
  const out: Array<{ name: string; value: unknown }> = []
  collectVariableEntries(tree, '', out)
  return out
}

function collectVariableEntries(tree: JsonObject, prefix: string, out: Array<{ name: string; value: unknown }>): void {
  for (const [key, entry] of Object.entries(tree)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (prefix === '' && (key === 'stat_data' || key === 'previous_stat_data') && isPlainObject(entry)) {
      out.push({ name, value: entry })
      continue
    }
    if (isPlainObject(entry)) collectVariableEntries(entry, name, out)
    else if (VARIABLE_NAME.test(name)) out.push({ name, value: entry })
  }
}

async function isAgentTavernBound(db: TavernStore, chatId: string): Promise<boolean> {
  const state = await db.getState()
  return Object.values(state.sessionBindings).some((binding) => binding.architecture === 'agent-tavern' && binding.chatId === chatId)
}

/**
 * Reader shape for frontend scripts: ST fields stay intact, JSR aliases are
 * added (`name`/`enabled`/`strategy.keys`). Aliases are stripped back to ST
 * fields before a session copy is written.
 */
function worldbookReaderEntry(entry: LoreEntry, world: string): JsonObject {
  return {
    ...cloneJson(entry),
    world,
    name: entry.comment,
    enabled: entry.disable !== true,
    strategy: {
      type: entry.constant === true ? 'constant' : entry.vectorized === true ? 'vectorized' : 'selective',
      keys: cloneJson(entry.key),
      keys_secondary: cloneJson(entry.keysecondary),
    },
  }
}

/** JSR entry aliases → ST fields; `world` is a read-side annotation. */
function worldbookWriterEntry(entry: JsonObject): JsonObject {
  const next = cloneJson(entry)
  delete next['world']
  const strategy = isPlainObject(next['strategy']) ? next['strategy'] : undefined
  if (strategy !== undefined) {
    if (Array.isArray(strategy['keys'])) {
      next['key'] = strategy['keys'].filter((key): key is string => typeof key === 'string')
    }
    const secondary = strategy['keys_secondary'] ?? strategy['secondary_keys']
    if (Array.isArray(secondary)) {
      next['keysecondary'] = secondary.filter((key): key is string => typeof key === 'string')
    }
    if (strategy['type'] === 'constant') next['constant'] = true
    if (strategy['type'] === 'vectorized') next['vectorized'] = true
    delete next['strategy']
  }
  if (typeof next['enabled'] === 'boolean') {
    next['disable'] = next['enabled'] !== true
    delete next['enabled']
  }
  if (typeof next['name'] === 'string') {
    next['comment'] = next['name']
    delete next['name']
  }
  return next
}

/** 角色卡绑定的世界书（extensions.world）优先，其次全局激活书，最后卡内嵌书。 */
async function defaultLorebookName(db: TavernStore, state: TavernState, character: string): Promise<string | undefined> {
  const file = await db.getCharacter(character)
  const world = file?.card.data.extensions?.['world']
  const linked = typeof world === 'string' && world.trim() !== '' ? world.trim() : undefined
  if (linked !== undefined) return linked
  const active = state.activeWorlds[0]
  if (active !== undefined) return active
  const embedded = file?.card.data.characterBook?.name
  return typeof embedded === 'string' && embedded.trim() !== '' ? embedded.trim() : undefined
}

/* ------------------------------ world books ------------------------------ */

/**
 * Resolves a world book by precedence: session copy → imported asset → card
 * embedded book (only when `name` matches the linked/embedded name).
 */
async function loadLorebook(
  db: TavernStore,
  character: string,
  chatId: string,
  name: string,
): Promise<WorldBookIR | undefined> {
  if (chatId !== '') {
    const copy = await db.getChatWorld(character, chatId, name)
    if (copy !== undefined) return copy
  }
  const world = await db.getWorld(name)
  if (world !== undefined) return world
  const card = (await db.getCharacter(character))?.card
  const book = card?.data.characterBook
  if (book === undefined) return undefined
  const linked = card.data.extensions['world']
  const linkedName = typeof linked === 'string' && linked.trim() !== '' ? linked.trim() : undefined
  const embeddedName = typeof book.name === 'string' && book.name.trim() !== '' ? book.name.trim() : undefined
  if (name !== linkedName && name !== embeddedName) return undefined
  return parseCharacterBook(book)
}

/**
 * Read-modify-write serialization per session resource: scripts and the GM
 * console can fire concurrent world-book or script-tree writes; without a chain
 * the last writer would silently drop the other's changes.
 */
const sessionWriteChains = new Map<string, Promise<void>>()

async function serializeSessionWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionWriteChains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(operation)
  const settled = run.then(() => {}, () => {})
  sessionWriteChains.set(key, settled)
  try {
    return await run
  } finally {
    if (sessionWriteChains.get(key) === settled) sessionWriteChains.delete(key)
  }
}

/**
 * Host generation and helper writes can still race outside the serialization
 * chain. A CAS failure is retryable because every operation here re-reads the
 * latest chat before applying its whole-tree update; never retry a blind write.
 */
async function retryChatWrite<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof ChatRevisionConflictError)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
  throw lastError
}

async function putLorebook(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string; entries: JsonObject[] }> {
  const name = requireString(body?.name, 'name').trim()
  if (chatId === '') throw new Error('chatId is required for lorebook.put (scripts write the session copy)')
  const raw = requireLorebookEntries(body?.entries)
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000${name}`, async () => {
    const base = await loadLorebook(db, character, chatId, name)
    if (base === undefined) {
      throw new Error(`lorebook '${name}' not found: the session copy has nothing to extend (import the world or link it to the card first)`)
    }
    const entries = normalizeLorebookEntries(raw)
    await db.putChatWorld(character, chatId, {
      name,
      entries,
      ...(base.extra === undefined ? {} : { extra: cloneJson(base.extra) }),
    })
    return { name, entries: entries.map((entry) => worldbookReaderEntry(entry, name)) }
  })
}

/**
 * `entries` must be an array of objects; `world` is a read-side annotation from
 * `lorebook.get` and JSR aliases (`name`/`enabled`/`strategy`) are converted
 * back to ST fields before normalization. Missing/duplicate uids get a fresh
 * number because the lore engine addresses entries by uid.
 */
function requireLorebookEntries(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('entries must be an array of world book entries')
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`entries[${index}] must be an object (got ${entry === null ? 'null' : typeof entry})`)
    return worldbookWriterEntry(entry)
  })
}

function normalizeLorebookEntries(raw: JsonObject[]) {
  const seen = new Set<number>()
  let nextUid = raw.reduce((max, entry) => {
    const uid = entry['uid']
    return typeof uid === 'number' && Number.isInteger(uid) && uid > max ? uid : max
  }, -1) + 1
  return raw.map((entry) => {
    const normalized = normalizeEntry(entry)
    if (!Number.isInteger(normalized.uid) || normalized.uid < 0 || seen.has(normalized.uid)) {
      while (seen.has(nextUid)) nextUid += 1
      normalized.uid = nextUid
      nextUid += 1
    }
    seen.add(normalized.uid)
    return normalized
  })
}

/**
 * World-book names visible in this chat: shared assets plus session-created
 * copies, minus books a script deleted for this chat (empty tombstone copy).
 */
async function visibleWorldNames(
  db: TavernStore,
  character: string,
  chatId: string,
): Promise<string[]> {
  const base = await db.listWorlds()
  const session = chatId === '' ? [] : await db.listChatWorlds(character, chatId)
  const names = [...new Set([...base, ...session])].sort()
  const visible: string[] = []
  for (const name of names) {
    if (chatId === '') {
      visible.push(name)
      continue
    }
    const copy = await db.getChatWorld(character, chatId, name)
    if (copy?.extra?.['__jsrDeleted'] === true) continue
    visible.push(name)
  }
  return visible
}

/** Session-scoped world-book creation: the base `worlds/` asset is untouched. */
async function createLorebook(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string; entries: JsonObject[] }> {
  requireSessionChatId(chatId, 'lorebook.create')
  const name = requireString(body?.name, 'name').trim()
  const raw = body?.entries === undefined ? [] : requireLorebookEntries(body.entries)
  const entries = normalizeLorebookEntries(raw)
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000${name}`, async () => {
    if (await db.getWorld(name) !== undefined) {
      throw new Error(`world book '${name}' is a shared asset; a sandboxed frontend can only create session copies (choose another name or edit it through the panel)`)
    }
    if (await db.getChatWorld(character, chatId, name) !== undefined) {
      throw new Error(`world book '${name}' already exists in this chat`)
    }
    await db.putChatWorld(character, chatId, { name, entries, extra: { __jsrSession: true } })
    return { name, entries: entries.map((entry) => worldbookReaderEntry(entry, name)) }
  })
}

/**
 * Session-scoped delete. A book that only exists in the session copy is
 * removed; a shared asset is shadowed by an empty tombstone so generation and
 * reads treat it as gone for this chat while `worlds/<name>.json` stays intact.
 */
async function deleteLorebookSession(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string; deleted: boolean }> {
  requireSessionChatId(chatId, 'lorebook.delete')
  const name = requireString(body?.name, 'name').trim()
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000${name}`, async () => {
    const base = await db.getWorld(name)
    const copy = await db.getChatWorld(character, chatId, name)
    if (base === undefined && copy === undefined) throw new Error(`world book '${name}' not found`)
    if (base === undefined) {
      await db.deleteChatWorld(character, chatId, name)
      return { name, deleted: true }
    }
    await db.putChatWorld(character, chatId, {
      name,
      entries: [],
      extra: { ...(copy?.extra === undefined ? {} : copy.extra), __jsrDeleted: true },
    })
    return { name, deleted: true }
  })
}

/** Chat-bound world book (`chat_metadata.world`); session-scoped by definition. */
async function setChatWorld(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string | null }> {
  requireSessionChatId(chatId, 'chat.world.set')
  const raw = body?.name
  const name = raw === null || raw === undefined || raw === '' ? null : requireString(raw, 'name').trim()
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000chat`, () => retryChatWrite(async () => {
    const snapshot = await requireChat(db, character, chatId)
    const chat = snapshot.chat
    chat.header.chat_metadata = chat.header.chat_metadata ?? {}
    if (name === null) delete (chat.header.chat_metadata as JsonObject)['world']
    else (chat.header.chat_metadata as JsonObject)['world'] = name
    await persistChat(db, character, chatId, chat, snapshot.revision)
    return { name }
  }))
}

/** Session-scoped preset copy (JSR preset writes never touch the shared file). */
async function putSessionPreset(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string; preset: JsonObject }> {
  requireSessionChatId(chatId, 'presets.put')
  const name = requireString(body?.name, 'name').trim()
  const preset = requireObject(body?.preset, 'preset')
  return serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
    await db.putChatJsrOverlay(character, chatId, (current) => {
      const base = current ?? { version: 1, scriptTrees: [] }
      return { ...base, presets: { ...(base.presets ?? {}), [name]: preset } }
    })
    return { name, preset }
  })
}

/** Session-scoped persona copy (JSR persona writes never touch state.json). */
async function putSessionPersona(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ name: string; persona: JsonObject }> {
  requireSessionChatId(chatId, 'personas.put')
  const name = requireString(body?.name, 'name').trim()
  const persona = requireObject(body?.persona, 'persona')
  return serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
    await db.putChatJsrOverlay(character, chatId, (current) => {
      const base = current ?? { version: 1, scriptTrees: [] }
      return { ...base, personas: { ...(base.personas ?? {}), [name]: persona } }
    })
    return { name, persona }
  })
}

/**
 * `EjsTemplate.evalTemplate` host side: render card-authored EJS text with the
 * same sandbox as the generation pipeline. Variable setters mutate the chat copy
 * and persist once; world-book/card/preset reads go through the chat's session
 * copies so a frontend template sees what generation would see.
 */
async function renderFrontendTemplate(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<string> {
  const code = requireString(body?.code, 'code')
  const context = isPlainObject(body?.context) ? cloneJson(body.context) : {}
  const file = await db.getCharacter(character)
  const chat = chatId === '' ? undefined : (await requireChat(db, character, chatId)).chat
  const messages = chat?.messages ?? []
  const chatVariables = chat === undefined ? {} : readChatVariables(chat)
  const globalVariables = plainObject(state.scriptGlobals) ?? {}
  let variablesDirty = false
  const readVar = (scope: 'chat' | 'global', path: string): unknown => {
    const tree = scope === 'chat' ? chatVariables : globalVariables
    return readTreePath(tree, path)
  }
  const writeVar = (scope: 'chat' | 'global', path: string, value: unknown): void => {
    const tree = scope === 'chat' ? chatVariables : globalVariables
    writeTreePath(tree, path, value)
    variablesDirty = true
  }
  const env: Record<string, unknown> = {
    ...context,
    getvar: (key: string) => readVar('chat', key),
    setvar: (key: string, value: unknown) => { writeVar('chat', key, value); return value },
    getglobalvar: (key: string) => readVar('global', key),
    setglobalvar: (key: string, value: unknown) => { writeVar('global', key, value); return value },
    getwi: async (title: string | number, book?: string) => {
      const name = typeof book === 'string' && book.trim() !== ''
        ? book.trim()
        : (await defaultLorebookName(db, state, character))
      if (name === undefined) return ''
      const resolved = await loadLorebook(db, character, chatId, name)
      if (resolved === undefined) return ''
      const entry = resolved.entries.find((candidate) =>
        (typeof title === 'number' && candidate.uid === title)
        || (typeof candidate.comment === 'string' && candidate.comment === String(title)))
      return entry === undefined ? '' : String(entry.content ?? '')
    },
    getchar: (name?: string) => {
      const data = file?.card.data
      if (data === undefined) return null
      if (name !== undefined && name !== character && name !== 'current') return null
      return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_message: data.first_mes,
        message_example: data.mes_example,
        creator_notes: data.creator_notes,
      }
    },
    getpreset: async (name: string) => {
      if (state.activePreset === undefined) return null
      const preset = await db.getPreset(state.activePreset)
      const prompts = Array.isArray(preset?.['prompts']) ? preset['prompts'] as JsonObject[] : []
      const prompt = prompts.find((candidate) => candidate['name'] === name)
      return prompt === undefined ? null : { name, content: String(prompt['content'] ?? '') }
    },
    getMessage: (index: number) => {
      const resolved = index < 0 ? messages.length + index : index
      return messages[resolved]?.mes ?? ''
    },
    getMessages: () => messages.map((message) => message.mes),
    getChatId: () => chatId,
    getCharName: () => character,
    getUserName: () => state.activePersona ?? DEFAULT_USER,
    lastMessageId: messages.length - 1,
    chat: messages.map((message) => ({ name: message.name, mes: message.mes, is_user: message.is_user === true })),
  }
  const text = await renderSandboxed(code, env, { where: 'frontend EjsTemplate' })
  if (variablesDirty && chat !== undefined) {
    chat.header.chat_metadata = chat.header.chat_metadata ?? {}
    chat.header.chat_metadata.variables = chatVariables
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (snapshot !== undefined) {
      await persistChat(db, character, chatId, chat, snapshot.revision)
    }
  }
  if (variablesDirty) await db.updateState(() => ({ scriptGlobals: globalVariables as never }))
  return text
}

/** Dot-path read for the EJS variable API (`a.b.c`). */
function readTreePath(tree: JsonObject, path: string): unknown {
  const segments = path.split('.')
  let cursor: unknown = tree
  for (const segment of segments) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/** Dot-path write for the EJS variable API; creates intermediate objects. */
function writeTreePath(tree: JsonObject, path: string, value: unknown): void {
  const segments = path.split('.')
  const leaf = segments.pop()
  if (leaf === undefined || leaf === '') throw new Error('variable path is empty')
  let cursor: JsonObject = tree
  for (const segment of segments) {
    const next = cursor[segment]
    if (!isPlainObject(next)) {
      const created: JsonObject = {}
      cursor[segment] = created
      cursor = created
      continue
    }
    cursor = next
  }
  cursor[leaf] = cloneJson(value as never)
}

/** JSR `rotateChatMessages(begin, middle, end)`: `[b,m) [m,e)` → `[m,e) [b,m)`. */
async function rotateMessages(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ revision: string; messageCount: number; lastMessageId: number }> {
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000chat`, () => retryChatWrite(async () => {
    const snapshot = await requireChat(db, character, chatId)
    const chat = snapshot.chat
    const total = chat.messages.length
    const begin = requireIndex(body?.begin, 'begin', total)
    const middle = requireIndex(body?.middle, 'middle', total)
    const end = requireIndex(body?.end, 'end', total)
    if (!(begin <= middle && middle <= end)) {
      throw new Error(`rotateChatMessages requires begin <= middle <= end (got ${begin}, ${middle}, ${end})`)
    }
    const head = chat.messages.slice(0, begin)
    const first = chat.messages.slice(begin, middle)
    const second = chat.messages.slice(middle, end)
    const tail = chat.messages.slice(end)
    chat.messages = [...head, ...second, ...first, ...tail]
    const revision = await persistChat(db, character, chatId, chat, snapshot.revision)
    return { revision, messageCount: chat.messages.length, lastMessageId: chat.messages.length - 1 }
  }))
}

function requireIndex(value: unknown, label: string, total: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > total) {
    throw new Error(`${label} must be an integer in [0, ${total}] (got ${String(value)})`)
  }
  return value
}


/* ---------------------------- script trees ---------------------------- */

function requireSessionChatId(chatId: string, op: string): void {
  if (chatId === '') throw new Error(`chatId is required for ${op} (session scope only)`)
}

/**
 * `scriptTrees` is the raw JSR node array (script + folder nodes, unknown fields
 * preserved). Only the container/entry shape is validated here; the script
 * semantics stay the card's business.
 */
function requireScriptTrees(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('scriptTrees must be an array of card script nodes')
  return value.map((node, index) => {
    if (!isPlainObject(node)) {
      throw new Error(`scriptTrees[${index}] must be an object (got ${node === null ? 'null' : typeof node})`)
    }
    return cloneJson(node)
  })
}

const SCRIPT_TREE_TYPES = ['character', 'preset', 'global'] as const
type ScriptTreeType = typeof SCRIPT_TREE_TYPES[number]

function requireScriptTreeType(value: unknown): ScriptTreeType {
  if (value === undefined || value === 'character') return 'character'
  if (value === 'preset' || value === 'global') return value
  throw new Error(`unsupported script tree type '${String(value)}' (supported: character, preset, global)`)
}

/**
 * Reads one script-tree source. Character edits live in the session overlay;
 * preset/global trees are session copies too, falling back to the active
 * preset's embedded tree when the chat never edited them.
 */
async function readScriptTrees(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  type: ScriptTreeType,
): Promise<{ type: ScriptTreeType; preset: string | null; scriptTrees: JsonObject[] | null }> {
  const overlay = await db.getChatJsrOverlay(character, chatId)
  const characterTree = overlay === undefined
    ? null
    : (overlay.trees !== undefined ? overlay.trees.character ?? null : overlay.scriptTrees)
  if (type === 'character') {
    return { type, preset: null, scriptTrees: characterTree === null ? null : cloneJson(characterTree) }
  }
  if (type === 'global') {
    const trees = overlay?.trees?.global
    return { type, preset: null, scriptTrees: trees === undefined ? null : cloneJson(trees) }
  }
  const presetName = state.activePreset ?? null
  if (presetName === null) return { type, preset: null, scriptTrees: null }
  const own = overlay?.trees?.preset?.[presetName]
  if (own !== undefined) return { type, preset: presetName, scriptTrees: cloneJson(own) }
  return { type, preset: presetName, scriptTrees: await activePresetScriptTrees(db, presetName) }
}

async function putChatScripts(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ type: ScriptTreeType; scriptTrees: JsonObject[] }> {
  requireSessionChatId(chatId, 'scripts.put')
  const type = requireScriptTreeType(body?.type)
  const scriptTrees = requireScriptTrees(body?.scriptTrees)
  return serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
    await db.putChatJsrOverlay(character, chatId, (current) => {
      const base = current ?? { version: 1, scriptTrees: [] }
      const trees = { ...(base.trees ?? {}) }
      if (type === 'character') {
        trees.character = scriptTrees
        base.scriptTrees = scriptTrees
      } else if (type === 'global') {
        trees.global = scriptTrees
      } else {
        const presetName = state.activePreset
        if (presetName === undefined) throw new Error('scripts.put type=preset requires an active preset')
        trees.preset = { ...(trees.preset ?? {}), [presetName]: scriptTrees }
      }
      return { ...base, trees }
    })
    return { type, scriptTrees }
  })
}

/**
 * Script-container metadata writes (`getScriptInfo`/`replaceScriptInfo` and the
 * button list). Only the character tree is writable; preset/global nodes stay
 * read-only so a card cannot rewrite another source's tree.
 */
async function patchScriptNode(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ scriptId: string; node: JsonObject }> {
  requireSessionChatId(chatId, 'scripts.patch')
  const scriptId = requireString(body?.scriptId, 'scriptId')
  const info = body?.info === undefined ? undefined : String(body.info)
  const buttons = body?.buttons === undefined ? undefined : requireScriptButtons(body.buttons)
  return serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
    const overlay = await db.getChatJsrOverlay(character, chatId)
    const current = overlay?.trees !== undefined
      ? overlay.trees.character ?? []
      : overlay?.scriptTrees ?? []
    const patched = patchNodeById(current, scriptId, (node) => {
      if (info !== undefined) node['info'] = info
      if (buttons !== undefined) {
        node['button'] = { ...(plainObject(node['button']) ?? {}), enabled: true, buttons }
      }
    })
    if (patched.node === null) throw new Error(`script node '${scriptId}' not found in this chat's script tree`)
    await db.putChatJsrOverlay(character, chatId, (existing) => {
      const base = existing ?? { version: 1, scriptTrees: [] }
      return {
        ...base,
        scriptTrees: patched.nodes,
        trees: { ...(base.trees ?? {}), character: patched.nodes },
      }
    })
    return { scriptId, node: patched.node }
  })
}

type ScriptButtonPayload = { name: string; visible: boolean }

function requireScriptButtons(value: unknown): ScriptButtonPayload[] {
  if (!Array.isArray(value)) throw new Error('buttons must be an array')
  return value.map((button, index) => {
    if (!isPlainObject(button)) throw new Error(`buttons[${index}] must be an object`)
    const name = requireString(button['name'], `buttons[${index}].name`)
    return { name, visible: button['visible'] !== false }
  })
}

/** Deep-copies the node list and applies `mutate` to the node with `id`. */
function patchNodeById(
  nodes: JsonObject[],
  scriptId: string,
  mutate: (node: JsonObject) => void,
): { nodes: JsonObject[]; node: JsonObject | null } {
  const copy = cloneJson(nodes)
  let found: JsonObject | null = null
  const walk = (list: JsonObject[]): void => {
    for (const node of list) {
      if (node['type'] === 'folder' && Array.isArray(node['scripts'])) {
        walk(node['scripts'] as JsonObject[])
        continue
      }
      if (node['id'] !== scriptId) continue
      mutate(node)
      found = node
    }
  }
  walk(copy)
  return { nodes: copy, node: found }
}

async function replaceScriptVariables(
  db: TavernStore,
  character: string,
  chatId: string,
  body: JsonObject,
): Promise<{ scriptId: string; variables: JsonObject }> {
  const scriptId = requireString(body?.scriptId, 'scriptId')
  const variables = requireObject(body?.variables, 'variables')
  return serializeSessionWrite(`scripts:${character}\u0000${chatId}`, async () => {
    await db.putChatJsrOverlay(character, chatId, (current) => {
      const base = current ?? { version: 1, scriptTrees: [] }
      return {
        ...base,
        scriptVariables: { ...(base.scriptVariables ?? {}), [scriptId]: variables },
      }
    })
    return { scriptId, variables }
  })
}

async function resetScriptTrees(
  db: TavernStore,
  character: string,
  chatId: string,
  type: ScriptTreeType,
): Promise<void> {
  const overlay = await db.getChatJsrOverlay(character, chatId)
  if (overlay === undefined) return
  const state = await db.getState()
  const trees = { ...(overlay.trees ?? {}) }
  if (type === 'character') {
    delete trees.character
    overlay.scriptTrees = []
  } else if (type === 'global') {
    delete trees.global
  } else {
    const presetName = state.activePreset
    if (presetName === undefined || trees.preset === undefined) return
    const presetTrees = { ...trees.preset }
    delete presetTrees[presetName]
    if (Object.keys(presetTrees).length === 0) delete trees.preset
    else trees.preset = presetTrees
  }
  const hasTrees = Object.keys(trees).length > 0
  const hasVariables = Object.keys(overlay.scriptVariables ?? {}).length > 0
  const hasPresets = Object.keys(overlay.presets ?? {}).length > 0
  const hasPersonas = Object.keys(overlay.personas ?? {}).length > 0
  if (!hasTrees && !hasVariables && !hasPresets && !hasPersonas) {
    await db.deleteChatScripts(character, chatId)
    return
  }
  await db.putChatJsrOverlay(character, chatId, () => ({
    ...overlay,
    scriptTrees: overlay.scriptTrees,
    ...(hasTrees ? { trees } : { trees: undefined }),
  }))
}

/* ------------------------------- messages ------------------------------- */

async function getMessages(db: TavernStore, character: string, chatId: string, body: JsonObject): Promise<JsonObject[]> {
  const snapshot = await requireChat(db, character, chatId)
  const range = parseRange(body?.range, snapshot.chat.messages.length - 1)
  const role = typeof body?.role === 'string' ? body.role : 'all'
  const hideState = typeof body?.hideState === 'string' ? body.hideState : 'all'
  const includeSwipes = body?.includeSwipes === true
  const messages: JsonObject[] = []
  for (let index = range[0]; index <= range[1]; index++) {
    const message = snapshot.chat.messages[index]
    if (message === undefined) continue
    if (role !== 'all' && role !== messageRole(message)) continue
    if (hideState === 'hidden' && !isHidden(message)) continue
    if (hideState === 'unhidden' && isHidden(message)) continue
    messages.push(includeSwipes ? toJsrSwiped(message, index) : toJsrMessage(message, index))
  }
  return messages
}

async function mutateMessages(
  db: TavernStore,
  character: string,
  chatId: string,
  action: 'set' | 'create' | 'delete',
  body: JsonObject,
): Promise<JsonObject> {
  return serializeSessionWrite(`${character}\u0000${chatId}\u0000chat`, () => retryChatWrite(async () => {
    const snapshot = await requireChat(db, character, chatId)
    const chat = snapshot.chat
    const state = await db.getState()
    if (action === 'set') {
      const updates = requireArray(body?.messages, 'messages')
      for (const raw of updates) {
        const update = requireObject(raw, 'messages[]')
        const index = resolveMessageId(chat.messages, update.message_id)
        applyMessageUpdate(chat.messages[index], update)
      }
    } else if (action === 'create') {
      const entries = requireArray(body?.messages, 'messages')
      const at = body?.insertBefore === 'end' || body.insertBefore === undefined
        ? chat.messages.length
        : normalizeInsertIndex(chat.messages.length, body.insertBefore)
      const created = entries.map((raw) =>
        toCreatedMessage(requireObject(raw, 'messages[]'), state.activePersona ?? DEFAULT_USER, character))
      chat.messages.splice(at, 0, ...created)
    } else {
      const ids = requireArray(body?.messageIds, 'messageIds')
      const indexes = [...new Set(ids.map((id) => resolveMessageId(chat.messages, id)))].sort((a, b) => b - a)
      for (const index of indexes) chat.messages.splice(index, 1)
    }
    const revision = await persistChat(db, character, chatId, chat, snapshot.revision)
    return {
      revision,
      messageCount: chat.messages.length,
      lastMessageId: chat.messages.length - 1,
      messages: chat.messages.map((message, index) => toJsrMessage(message, index)),
      variables: { chat: cloneJson(readChatVariables(chat)) },
    }
  }))
}

async function persistChat(db: TavernStore, character: string, chatId: string, chat: ChatLogIR, revision: string): Promise<string> {
  const next = await db.saveChat(character, chatId, chat, revision)
  await emitChatSaved(character, chatId, next, chat.messages.length)
  return next
}

async function requireChat(db: TavernStore, character: string, chatId: string) {
  if (chatId === '') throw new Error('chatId is required')
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' not found`)
  return snapshot
}

function messageRole(message: ChatMessage): 'system' | 'assistant' | 'user' {
  if (message.is_system === true) return 'system'
  return message.is_user === true ? 'user' : 'assistant'
}

function isHidden(message: ChatMessage): boolean {
  return message.is_hidden === true || plainObject(message.extra)?.['is_hidden'] === true
}

function toJsrMessage(message: ChatMessage, index: number): JsonObject {
  const extra = plainObject(message.extra) ?? {}
  const swipes = Array.isArray(message.swipes) && message.swipes.length > 0
    ? message.swipes.map((swipe) => String(swipe))
    : [typeof message.mes === 'string' ? message.mes : '']
  return {
    message_id: index,
    name: typeof message.name === 'string' ? message.name : '',
    role: messageRole(message),
    is_hidden: isHidden(message),
    message: typeof message.mes === 'string' ? message.mes : '',
    data: cloneJson(plainObject(message.variables) ?? extra),
    extra: cloneJson(extra),
    swipe_id: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
    swipes,
  }
}

function toJsrSwiped(message: ChatMessage, index: number): JsonObject {
  const swipes = Array.isArray(message.swipes) && message.swipes.length > 0
    ? message.swipes.map((swipe) => String(swipe))
    : [typeof message.mes === 'string' ? message.mes : '']
  const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info : []
  return {
    ...toJsrMessage(message, index),
    swipe_id: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
    swipes,
    swipes_data: swipes.map((_, swipeIndex) => {
      const info = plainObject(swipeInfo[swipeIndex])
      return cloneJson(plainObject(info?.['extra']) ?? {})
    }),
    swipes_info: cloneJson(swipeInfo),
  }
}

function readMessageVariables(message: ChatMessage): JsonObject {
  return plainObject(message.variables) ?? plainObject(plainObject(message.extra)?.['variables']) ?? {}
}

function resolveMessageId(messages: ChatMessage[], value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('message_id must be a finite number')
  const index = value < 0 ? messages.length + value : value
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
    throw new Error(`message_id ${value} is out of range (chat has ${messages.length} messages)`)
  }
  return index
}

function normalizeInsertIndex(length: number, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('insert_before must be a finite number or "end"')
  const index = value < 0 ? length + value : value
  if (!Number.isInteger(index) || index < 0 || index > length) throw new Error(`insert_before ${value} is out of range`)
  return index
}

function parseRange(range: unknown, lastMessageId: number): [number, number] {
  if (typeof range === 'number') {
    const index = range < 0 ? lastMessageId + 1 + range : range
    return [index, index]
  }
  if (typeof range !== 'string') throw new Error('range must be a number or a string like "0-10"')
  const resolved = range
    .replace(/\{\{\s*lastMessageId\s*\}\}/gi, String(lastMessageId))
    .replace(/\{\{\s*lastMessage\s*\}\}/gi, String(lastMessageId))
    .trim()
  const match = /^(-?\d+)\s*(?:-\s*(-?\d+)?)?$/.exec(resolved)
  if (match === null) throw new Error(`unsupported message range '${range}'`)
  const toIndex = (raw: string): number => {
    const value = Number(raw)
    return value < 0 ? lastMessageId + 1 + value : value
  }
  const start = toIndex(match[1])
  const end = match[2] === undefined ? start : toIndex(match[2])
  return [Math.max(0, Math.min(start, end)), Math.min(lastMessageId, Math.max(start, end))]
}

function applyMessageUpdate(message: ChatMessage, update: JsonObject): void {
  if (typeof update.message === 'string') message.mes = update.message
  if (typeof update.name === 'string') message.name = update.name
  if (update.role === 'system' || update.role === 'assistant' || update.role === 'user') {
    message.is_system = update.role === 'system'
    message.is_user = update.role === 'user'
  }
  if (typeof update.is_hidden === 'boolean') message.is_hidden = update.is_hidden
  const data = plainObject(update.data)
  const extra = plainObject(update.extra)
  if (data !== undefined) message.variables = cloneJson(data)
  if (extra !== undefined) message.extra = { ...(plainObject(message.extra) ?? {}), ...cloneJson(extra) }
  if (Array.isArray(update.swipes)) {
    const swipes = update.swipes.map((swipe) => String(swipe))
    message.swipes = swipes
    const swipeId = typeof update.swipe_id === 'number' ? update.swipe_id : (typeof message.swipe_id === 'number' ? message.swipe_id : 0)
    const clamped = Math.max(0, Math.min(Math.trunc(swipeId), swipes.length - 1))
    message.swipe_id = clamped
    message.mes = swipes[clamped]
  } else if (typeof update.swipe_id === 'number' && Array.isArray(message.swipes) && message.swipes.length > 0) {
    const clamped = Math.max(0, Math.min(Math.trunc(update.swipe_id), message.swipes.length - 1))
    message.swipe_id = clamped
    message.mes = String(message.swipes[clamped] ?? message.mes ?? '')
  }
  if (Array.isArray(update.swipes_info)) message.swipe_info = cloneJson(update.swipes_info) as Record<string, unknown>[]
}

function toCreatedMessage(entry: JsonObject, userName: string, characterName: string): ChatMessage {
  const role = entry.role === 'system' || entry.role === 'user' ? entry.role : 'assistant'
  const name = typeof entry.name === 'string' && entry.name !== ''
    ? entry.name
    : role === 'user' ? userName : role === 'system' ? 'System' : characterName
  const extra = { ...(plainObject(entry.data) ?? {}), ...(plainObject(entry.extra) ?? {}) }
  return {
    name,
    is_user: role === 'user',
    is_system: role === 'system',
    send_date: new Date().toISOString(),
    mes: typeof entry.message === 'string' ? entry.message : '',
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(entry.is_hidden === true ? { is_hidden: true } : {}),
  }
}

/* -------------------------------- slash -------------------------------- */

interface HelperSlashResult {
  output: string
  chatChanged: boolean
  /**
   * `/trigger` inside an STscript pipeline is a *request* for host generation,
   * never a frontend-owned generation loop. The client bridge hands the user
   * floor written by this call to the host composer once the writes land.
   */
  triggerRequested: boolean
  /** Text of the last `/send` floor in this call, i.e. the floor the bridge replaces. */
  sentText: string | null
}

/**
 * STscript through the plugin's own interpreter (variables, send/cut, regex,
 * echo). Generation control (`/regenerate`, `/stop`) stays unwired on purpose:
 * AgentTavern generation belongs to the host loop, and a frontend must not
 * become a second driver. `/trigger` is reported back as a request instead of
 * running generation here.
 */
async function runHelperSlash(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  command: string,
): Promise<HelperSlashResult> {
  const snapshot = await requireChat(db, character, chatId)
  const chat = snapshot.chat
  let revision = snapshot.revision
  const file = await db.getCharacter(character)
  const macros = createMacroEngine({
    char: file?.card.data.nickname || file?.card.data.name || character,
    user: state.activePersona ?? DEFAULT_USER,
    persona: state.activePersona ? (await db.getPersona(state.activePersona))?.description : undefined,
    lastMessage: chat.messages[chat.messages.length - 1]?.mes,
    lastUserMessage: [...chat.messages].reverse().find((message) => message.is_user)?.mes,
    lastCharMessage: [...chat.messages].reverse().find((message) => !message.is_user && !message.is_system)?.mes,
    lastMessageId: chat.messages.length - 1,
    chatId,
    local: scalarVariables(readChatVariables(chat)),
    global: scalarVariables(plainObject(state.scriptGlobals) ?? {}),
  })
  let chatChanged = false
  let triggerRequested = false
  let sentText: string | null = null
  const persist = async () => {
    chatChanged = true
    const local = macros.snapshotVars().local
    if (Object.keys(local).length > 0) chat.header.chat_metadata.variables = { ...readChatVariables(chat), ...local }
    revision = await persistChat(db, character, chatId, chat, revision)
  }
  const result = await runScript(command, {
    expand: (text) => macros.expand(text),
    getVar: (name) => macros.getVar(name),
    setVar: (name, value) => { macros.setVar(name, value) },
    deleteVar: (name) => macros.deleteVar(name),
    getGlobalVar: (name) => macros.getGlobalVar(name),
    setGlobalVar: (name, value) => { macros.setGlobalVar(name, value) },
    deleteGlobalVar: (name) => macros.deleteGlobalVar(name),
    send: async (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return
      chat.messages.push({
        name: state.activePersona ?? DEFAULT_USER,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: trimmed,
      })
      sentText = trimmed
      await persist()
    },
    // `/trigger` only records the request: the bridge replaces this call's last
    // user floor with one host composer send, so the AgentLoop stays the single
    // driver. A bare `/trigger` with no `/send` here falls back to the floor a
    // preceding `createChatMessages` created in the same iframe.
    trigger: () => {
      triggerRequested = true
    },
    cut: async (from, to) => {
      const total = chat.messages.length
      const start = from < 0 ? total + from : from
      const end = (to < 0 ? total + to : to) + 1
      chat.messages.splice(Math.max(0, start), Math.max(0, end - Math.max(0, start)))
      await persist()
    },
    echo: () => {},
    applyRegex: (scriptName, text) => {
      const script = collectRegexScripts(state, file)
        .find((candidate) => candidate.scriptName.toLowerCase() === scriptName.toLowerCase())
      if (script === undefined) return text
      return applyRegexScript(text, script, RegexPlacement.SLASH_COMMAND, { expand: (t) => macros.expand(t) }) ?? text
    },
  })
  await db.updateState(() => ({ scriptGlobals: macros.snapshotVars().global }))
  // STscript 的变量写不改变楼层（chatChanged=false），但必须落盘：ST 的
  // /setvar 是即时持久化语义，前端常把 slash 当变量写入口。
  const local = macros.snapshotVars().local
  const currentVariables = readChatVariables(chat)
  const merged = { ...currentVariables, ...local }
  const variablesDirty = JSON.stringify(merged) !== JSON.stringify(currentVariables)
  if (variablesDirty) {
    chat.header.chat_metadata.variables = merged
    revision = await persistChat(db, character, chatId, chat, revision)
  } else if (chatChanged) {
    await persistChat(db, character, chatId, chat, revision)
  }
  return {
    output: result.output,
    chatChanged: result.chatChanged || chatChanged || variablesDirty,
    triggerRequested,
    sentText: triggerRequested ? sentText : null,
  }
}

/** STscript variables are scalars; nested trees stay out of the macro engine. */
function scalarVariables(tree: JsonObject): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(tree).filter(([, value]) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
}

/* ------------------------------- contracts ------------------------------- */

export const HELPER_SCOPES = ['global', 'chat', 'message', 'character'] as const
export type HelperScope = typeof HELPER_SCOPES[number]

function requireVariableScope(value: unknown): HelperScope {
  if (value === 'global' || value === 'chat' || value === 'message' || value === 'character') return value
  throw new Error(`unsupported variable scope '${String(value)}' (supported: global, chat, message, character)`)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  return value
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return cloneJson(value)
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainObject(value: unknown): JsonObject | undefined {
  return isPlainObject(value) ? value as JsonObject : undefined
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    throw new Error('value is not JSON-serializable')
  }
}

export { HELPER_SCOPES as HELPER_VARIABLE_SCOPES }
