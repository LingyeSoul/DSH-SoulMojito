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
 * variables (global/chat/message read+write, character read-only), chat messages
 * (get/set/create/delete), character read, lorebook read, slash commands, regex
 * list/replace, plus a snapshot used for synchronous iframe reads.
 */
import type { ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import { RegexPlacement, parseRegexScripts } from '../../tavern-format/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { applyRegexScript, applyRegexScripts, runScript } from '../../tavern-script/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { readJson, sendJson } from './http/io.js'
import { overlayScopedVariables, readChatVariables } from './mvu.js'
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
    case 'slash':
      return sendJson(res, 200, {
        ok: true,
        value: await runHelperSlash(db, state, character, chatId, requireString(body?.command, 'command')),
      })
    case 'character.list':
      return sendJson(res, 200, { ok: true, value: { names: await db.listCharacters() } })
    case 'lorebook.list':
      return sendJson(res, 200, {
        ok: true,
        value: { names: await db.listWorlds(), active: state.activeWorlds },
      })
    case 'lorebook.get': {
      const name = typeof body?.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : await defaultLorebookName(db, state, character)
      if (name === undefined) throw new Error('no active lorebook')
      const book = await db.getWorld(name)
      if (book === undefined) throw new Error(`lorebook '${name}' not found`)
      return sendJson(res, 200, {
        ok: true,
        value: { name, entries: book.entries.map((entry) => ({ world: name, ...entry })) },
      })
    }
    case 'regex.get':
      return sendJson(res, 200, { ok: true, value: { scripts: state.regexScripts } })
    case 'regex.format': {
      const text = typeof body?.text === 'string' ? body.text : ''
      const placement = typeof body?.placement === 'number' ? body.placement : 2
      // TavernHelper 的 formatAsTavernRegexedString 语义：应用给定脚本（通常是
      // getTavernRegexes 的结果）；未给时用当前全局启用脚本。正则只做文本变换，
      // 不回写任何状态。
      const provided = Array.isArray(body?.scripts) ? parseRegexScripts(body.scripts) : undefined
      const scripts = (provided ?? state.regexScripts).filter((script) => !script.disabled)
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
  if (chatId === '') {
    return {
      characterName: character,
      userName: state.activePersona ?? DEFAULT_USER,
      personaDescription: '',
      chatId: '',
      chatMetadata: {},
      messages: [],
      messageCount: 0,
      lastMessageId: -1,
      variables: {
        global: cloneJson(plainObject(state.scriptGlobals) ?? {}),
        chat: {},
        message: {},
        character: cloneJson(plainObject(file?.card.data.extensions?.['variables']) ?? {}),
      },
      characterData: file?.card.data ?? null,
      avatar: avatarPath(character),
    }
  }
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' not found`)
  const chat = snapshot.chat
  const chatVariables = await readChatScope(db, chat, chatId)
  const lastIndex = chat.messages.length - 1
  const persona = state.activePersona ? await db.getPersona(state.activePersona) : undefined
  return {
    characterName: character,
    userName: state.activePersona ?? DEFAULT_USER,
    personaDescription: persona?.description ?? '',
    chatId,
    chatMetadata: chat.header.chat_metadata ?? {},
    messages: chat.messages.map((message, index) => toJsrMessage(message, index)),
    messageCount: chat.messages.length,
    lastMessageId: lastIndex,
    variables: {
      global: cloneJson(plainObject(state.scriptGlobals) ?? {}),
      chat: cloneJson(chatVariables),
      message: lastIndex >= 0 ? cloneJson(readMessageVariables(chat.messages[lastIndex])) : {},
      character: cloneJson(plainObject(file?.card.data.extensions?.['variables']) ?? {}),
    },
    characterData: file?.card.data ?? null,
    avatar: avatarPath(character),
  }
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
  return overlayScopedVariables(base, scoped)
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
  if (scope === 'chat') {
    const snapshot = await requireChat(db, character, chatId)
    const chat = snapshot.chat
    if (Object.keys(tree).length > 0) chat.header.chat_metadata.variables = tree
    else delete chat.header.chat_metadata.variables
    await persistChat(db, character, chatId, chat, snapshot.revision)
    if (await isAgentTavernBound(db, chatId)) await mirrorChatScope(chatId, tree)
    return tree
  }
  if (scope === 'message') {
    const snapshot = await requireChat(db, character, chatId)
    const index = resolveMessageId(snapshot.chat.messages, body?.messageId)
    const message = snapshot.chat.messages[index]
    message.variables = tree
    await persistChat(db, character, chatId, snapshot.chat, snapshot.revision)
    return tree
  }
  throw new Error('character variables are read-only in DSH-SoulMojito')
}

/**
 * AgentTavern keeps two readers for chat state: `chat_metadata.variables`
 * (ST-compatible display tree, `$` keys included) and the chat-scope
 * VariableStore consumed by MVU/tools. A helper replace writes both so a
 * TavernHelper HUD and the MVU status bar never drift apart.
 */
async function mirrorChatScope(chatId: string, tree: JsonObject): Promise<void> {
  const store = await variables()
  const leaves = flattenVariableTree(tree).filter((leaf) => VARIABLE_NAME.test(leaf.name))
  const nextNames = new Set(leaves.map((leaf) => leaf.name))
  for (const entry of await store.listAll('chat', chatId)) {
    if (nextNames.has(entry.name) || entry.name.startsWith('$')) continue
    await store.delete('chat', chatId, entry.name)
  }
  if (leaves.length > 0) {
    await store.patch('chat', chatId, leaves.map((leaf) => ({ name: leaf.name, value: leaf.value as never })))
  }
}

function flattenVariableTree(value: JsonObject, prefix = '', out: Array<{ name: string; value: unknown }> = []) {
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (isPlainObject(entry)) flattenVariableTree(entry, name, out)
    else out.push({ name, value: entry })
  }
  return out
}

async function isAgentTavernBound(db: TavernStore, chatId: string): Promise<boolean> {
  const state = await db.getState()
  return Object.values(state.sessionBindings).some((binding) => binding.architecture === 'agent-tavern' && binding.chatId === chatId)
}

/** 角色卡绑定的世界书（extensions.world）优先，其次全局激活书。 */
async function defaultLorebookName(db: TavernStore, state: TavernState, character: string): Promise<string | undefined> {
  const file = await db.getCharacter(character)
  const world = file?.card.data.extensions?.['world']
  const linked = typeof world === 'string' && world.trim() !== '' ? world.trim() : undefined
  return linked ?? state.activeWorlds[0]
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
  return {
    message_id: index,
    name: typeof message.name === 'string' ? message.name : '',
    role: messageRole(message),
    is_hidden: isHidden(message),
    message: typeof message.mes === 'string' ? message.mes : '',
    data: cloneJson(plainObject(message.variables) ?? extra),
    extra: cloneJson(extra),
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

/**
 * STscript through the plugin's own interpreter (variables, send/cut, regex,
 * echo). Generation control (`/trigger`, `/regenerate`, `/stop`) stays
 * unwired on purpose: AgentTavern generation belongs to the host loop, and a
 * frontend must not become a second driver.
 */
async function runHelperSlash(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  command: string,
): Promise<{ output: string; chatChanged: boolean }> {
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
      await persist()
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
  return { output: result.output, chatChanged: result.chatChanged || chatChanged || variablesDirty }
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
