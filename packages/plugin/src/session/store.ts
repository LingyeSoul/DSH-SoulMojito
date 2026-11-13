// Chat-file management on top of the Tavern store's chat primitives: JSONL
// import/export, whole-chat duplicate, checkpoints and the ST opener-greeting
// switch. The store owns bytes and CAS (`createChat`/`saveChat`/`renameChat`/
// `getChatSnapshot`); this module owns the ST semantics that span more than one
// store call — id naming, request validation, architecture gating and the
// `chat-saved` fan-out — so the HTTP handlers stay one call per route.
//
// Every user-facing failure here is an `HttpError`: its message is echoed
// verbatim, while a plain `Error` would collapse into the generic 500 body that
// intentionally hides filesystem detail (`chat '…jsonl' not found` looks like an
// internal file name to that classifier).

import {
  applyGreetingSwipe,
  ChatFormatError,
  chatDisplayName,
  chatIdOf,
  chatStem,
  freeChatId,
  isChatId,
  parseImportedChatLog,
  readCheckpointParent,
  serializeChatLog,
  toCheckpoint,
  toDuplicate,
  type ChatLogIR,
} from '../../../tavern-format/src/index.js'
import {
  ChatRevisionConflictError,
  type ChatSnapshot,
  type TavernState,
  type TavernStore,
} from '../../../tavern-store/src/index.js'
import { HttpError } from '../http/errors.js'
import { emitChatSaved } from '../mods/events.js'
import { TavernArchitectureConflictError } from './binding.js'

export interface ChatFileResult {
  /** 磁盘身份，即聊天文件名（含 `.jsonl`）。 */
  readonly chatId: string
  /** 展示名（不含 `.jsonl`），UI 提示文案用。 */
  readonly name: string
  readonly chat: ChatLogIR
  readonly revision: string
}

export interface ChatCheckpointEntry {
  readonly chatId: string
  readonly name: string
  /** 复制的最后一条消息下标（父聊天为空时为 -1）。 */
  readonly messageId: number
  readonly messageCount: number
}

export interface ImportChatInput {
  readonly character: string
  readonly name: string
  /** JSONL 文本（header 行 + 消息行）。 */
  readonly content: string
}

export interface DuplicateChatInput {
  readonly character: string
  readonly chatId: string
  readonly revision: string
  readonly name?: string
}

export interface CheckpointChatInput {
  readonly character: string
  readonly chatId: string
  readonly revision: string
  readonly messageId?: number
  readonly name?: string
}

export interface GreetingChatInput {
  readonly character: string
  readonly chatId: string
  readonly revision: string
  readonly index: number
  readonly sessionId?: string
}

/* ----------------------------- 请求字段校验 ----------------------------- */

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} is required`)
  return value
}

export function requiredRevision(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'revision is required')
  return value
}

/**
 * 聊天 id 必须落在 store 的字符集内。不先挡一次，`getChatSnapshot` 会以普通
 * `Error('invalid chat id')` 抛错，客户端拿到的是 500 而不是可解释的 400。
 */
export function requireChatId(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (!isChatId(text)) throw new HttpError(400, `${field} is not a valid chat id`)
  return text
}

function httpFromFormatError(error: unknown): never {
  if (error instanceof ChatFormatError) throw new HttpError(400, error.message)
  throw error
}

/* ------------------------------ 读取辅助 ------------------------------ */

async function requireSnapshot(db: TavernStore, character: string, chatId: string): Promise<ChatSnapshot> {
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new HttpError(404, `chat '${chatDisplayName(chatId)}' not found`)
  return snapshot
}

/**
 * `revision` 必须等于当前快照，与 `PUT chat` 的 CAS 同款。改成乐观写入会让
 * “在另一个标签页也开着这段聊天”时的复制/存档静默截掉别处的编辑。
 */
function assertRevision(snapshot: ChatSnapshot, revision: string): void {
  if (revision !== snapshot.revision) throw new ChatRevisionConflictError(revision, snapshot.revision)
}

async function requireCharacter(db: TavernStore, character: string): Promise<void> {
  if ((await db.getCharacter(character)) === undefined) {
    throw new HttpError(404, `character '${character}' not found`)
  }
}

/**
 * 以指定 id 落一个新聊天文件。
 *
 * `createChat` 生成时间戳 id 并建目录，`renameChat` 再改名到目标 id——store 没有
 * “按 id 创建”的入口，而这里必须能给出可预测的文件名（导入的 `name`、
 * checkpoint 的 `- checkpoint N`）。目标已存在时 store 的 rename 会以普通
 * `Error` 报“already exists”（含 `.jsonl`，会被错误分类器吞成 500），所以先按
 * `listChats` 挡一次并显式 409，命中竞态再转成同一个 409。
 */
async function createChatWithId(db: TavernStore, character: string, chatId: string, log: ChatLogIR): Promise<void> {
  const existing = await db.listChats(character)
  if (existing.includes(chatId)) throw new HttpError(409, `chat '${chatDisplayName(chatId)}' already exists`)
  const createdId = await db.createChat(character, log.header, log.messages)
  if (createdId === chatId) return
  try {
    await db.renameChat(character, createdId, chatId)
  } catch (cause) {
    // 留下的临时文件不能成为幽灵聊天：删掉再上抛。
    await db.deleteChat(character, createdId).catch(() => {})
    if (cause instanceof Error && /already exists/.test(cause.message)) {
      throw new HttpError(409, `chat '${chatDisplayName(chatId)}' already exists`)
    }
    throw cause
  }
}

async function resultOf(db: TavernStore, character: string, chatId: string): Promise<ChatFileResult> {
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' disappeared right after it was written`)
  return { chatId, name: chatDisplayName(chatId), chat: snapshot.chat, revision: snapshot.revision }
}

/* -------------------------------- 导入 -------------------------------- */

/** `POST import/chat`：解析校验后按 `name` 落盘；同名已存在时 409，不覆盖。 */
export async function importChatFile(db: TavernStore, input: ImportChatInput): Promise<ChatFileResult> {
  const character = requiredText(input.character, 'character')
  const name = requiredText(input.name, 'name')
  const content = requiredText(input.content, 'content')
  await requireCharacter(db, character)
  const chatId = chatIdOf(name)
  const log = (() => {
    try {
      return parseImportedChatLog(content)
    } catch (error) {
      return httpFromFormatError(error)
    }
  })()
  await createChatWithId(db, character, chatId, log)
  const result = await resultOf(db, character, chatId)
  await emitChatSaved(character, chatId, result.revision, log.messages.length)
  return result
}

/* -------------------------------- 导出 -------------------------------- */

/** `GET export/chat/<character>/<chatId>`：返回 JSONL 文本（与资产导出同为 JSON 包体）。 */
export async function exportChatFile(
  db: TavernStore,
  character: string,
  chatId: string,
): Promise<{ name: string; content: string }> {
  const owned = requireChatId(chatId, 'chatId')
  const snapshot = await requireSnapshot(db, requiredText(character, 'character'), owned)
  return { name: owned, content: serializeChatLog(snapshot.chat) }
}

/* -------------------------------- 复制 -------------------------------- */

/**
 * 整聊复制：全量拷贝，`bookmark_link` 不带过去（副本不是分支）。
 * 缺省命名 `${stem} - copy N`；给 `name` 时用它，重名自动退化成 `- copy N`。
 */
export async function duplicateChatFile(db: TavernStore, input: DuplicateChatInput): Promise<ChatFileResult> {
  const character = requiredText(input.character, 'character')
  const sourceId = requireChatId(input.chatId, 'chatId')
  const revision = requiredRevision(input.revision)
  const snapshot = await requireSnapshot(db, character, sourceId)
  assertRevision(snapshot, revision)
  const existing = await db.listChats(character)
  const requested = input.name === undefined ? undefined : chatIdOf(input.name)
  const chatId = requested !== undefined && !existing.includes(requested)
    ? requested
    : freeChatId(existing, requested ?? chatStem(sourceId), 'copy')
  const copy = toDuplicate(snapshot.chat)
  await createChatWithId(db, character, chatId, copy)
  const result = await resultOf(db, character, chatId)
  await emitChatSaved(character, chatId, result.revision, copy.messages.length)
  return result
}

/* ------------------------------ checkpoint ------------------------------ */

/**
 * 复制 `0..messageId` 为新聊天（缺省全部），header 写
 * `chat_metadata.checkpoint_parent`。命名 `${stem} - checkpoint N`：store 的聊天
 * id 字符集不含 `#`（`#` 也是 URL fragment 分隔符），ST 文档里的
 * `- checkpoint #N` 因此落成无 `#` 形态，父聊天身份由 header 自描述。
 */
export async function checkpointChatFile(db: TavernStore, input: CheckpointChatInput): Promise<ChatFileResult> {
  const character = requiredText(input.character, 'character')
  const parentId = requireChatId(input.chatId, 'chatId')
  const revision = requiredRevision(input.revision)
  if (input.messageId !== undefined
    && (typeof input.messageId !== 'number' || !Number.isSafeInteger(input.messageId) || input.messageId < 0)) {
    throw new HttpError(400, 'messageId must be a non-negative integer')
  }
  const snapshot = await requireSnapshot(db, character, parentId)
  assertRevision(snapshot, revision)
  const checkpoint = (() => {
    try {
      return toCheckpoint(snapshot.chat, { character, chatId: parentId }, input.messageId)
    } catch (error) {
      return httpFromFormatError(error)
    }
  })()
  const existing = await db.listChats(character)
  const requested = input.name === undefined ? undefined : chatIdOf(input.name)
  const chatId = requested !== undefined && !existing.includes(requested)
    ? requested
    : freeChatId(existing, requested ?? chatStem(parentId), 'checkpoint')
  await createChatWithId(db, character, chatId, checkpoint.log)
  const result = await resultOf(db, character, chatId)
  await emitChatSaved(character, chatId, result.revision, checkpoint.log.messages.length)
  return result
}

/**
 * `GET checkpoints?character&chatId`：扫该角色的聊天文件，按 header 里
 * `checkpoint_parent` 归属过滤。
 *
 * 代价说明：store 没有“只读 header”的入口，每个同类文件都要过一次
 * `getChatSnapshot`（进程内按指纹缓存、写入即失效）。同一角色下聊天数上千时
 * 这里是 O(聊天数) 次读；需要更快就得在 store 侧加 header-only 读取，不在本轮
 * 范围内——按文件名预筛会漏掉自定义命名的 checkpoint，宁可慢也不漏。
 */
export async function listCheckpoints(
  db: TavernStore,
  character: string,
  chatId: string,
): Promise<ChatCheckpointEntry[]> {
  const parentId = requireChatId(chatId, 'chatId')
  const owner = requiredText(character, 'character')
  const entries: ChatCheckpointEntry[] = []
  for (const candidate of await db.listChats(owner)) {
    const snapshot = await db.getChatSnapshot(owner, candidate)
    if (snapshot === undefined) continue
    const parent = readCheckpointParent(snapshot.chat.header)
    if (parent === undefined || parent.character !== owner || parent.chatId !== parentId) continue
    entries.push({
      chatId: candidate,
      name: chatDisplayName(candidate),
      messageId: parent.messageId,
      messageCount: snapshot.chat.messages.length,
    })
  }
  return entries
}

/* ------------------------------- 开场白 ------------------------------- */

/**
 * 该聊天的生效架构：显式 `sessionId` 优先，否则按“同一个 character+chatId 的
 * 任一绑定”判定。未绑定的聊天按 ST 处理（导入/新建的聊天默认走 ST 视图）。
 */
export function chatArchitectureOf(
  state: Pick<TavernState, 'sessionBindings'>,
  character: string,
  chatId: string,
  sessionId?: string,
): 'st' | 'agent-tavern' {
  if (typeof sessionId === 'string') {
    const bound = state.sessionBindings[sessionId]
    if (bound?.architecture === 'agent-tavern') return 'agent-tavern'
  }
  for (const binding of Object.values(state.sessionBindings)) {
    if (binding.architecture !== 'agent-tavern') continue
    if (binding.character === character && binding.chatId === chatId) return 'agent-tavern'
  }
  return 'st'
}

/**
 * `POST greeting`：切换首楼 swipe（`swipe_id` + `mes`）。只有 ST 架构有这个面板；
 * AgentTavern 的首楼是宿主会话的投影，改 JSONL 不会改变已经发给模型的上下文，
 * 所以按架构冲突 409 明确拒绝，而不是写一个看起来成功却无效的字段。
 */
export async function switchGreeting(db: TavernStore, input: GreetingChatInput): Promise<ChatFileResult & { mes: string }> {
  const character = requiredText(input.character, 'character')
  const chatId = requireChatId(input.chatId, 'chatId')
  const revision = requiredRevision(input.revision)
  if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index) || input.index < 0) {
    throw new HttpError(400, 'index must be a non-negative integer')
  }
  const state = await db.getState()
  if (chatArchitectureOf(state, character, chatId, input.sessionId) === 'agent-tavern') {
    throw new TavernArchitectureConflictError(
      'AgentTavern sessions project the opening message from the host session; switch the greeting in the ST view instead.',
    )
  }
  const snapshot = await requireSnapshot(db, character, chatId)
  assertRevision(snapshot, revision)
  const swap = (() => {
    try {
      return applyGreetingSwipe(snapshot.chat, input.index)
    } catch (error) {
      return httpFromFormatError(error)
    }
  })()
  // 用读到的 revision 做保存期 CAS：`body.revision` 校验之后仍可能被另一个标签
  // 页写入，交给 saveChat 的第二道 CAS 才不会覆盖。
  const nextRevision = await db.saveChat(character, chatId, swap.log, snapshot.revision)
  await emitChatSaved(character, chatId, nextRevision, swap.log.messages.length)
  return { chatId, name: chatDisplayName(chatId), chat: swap.log, revision: nextRevision, mes: swap.mes }
}
