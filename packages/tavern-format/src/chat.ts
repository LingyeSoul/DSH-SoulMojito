/**
 * ST 聊天文件（jsonl）：首行 header，其后每行一条消息（含 swipes 系字段）。
 */

import type { ChatHeader, ChatLogIR, ChatMessage } from './types.js'

export class ChatFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatFormatError'
  }
}

export function parseChatLog(text: string): ChatLogIR {
  const lines = text.split('\n')
  let header: ChatHeader | undefined
  const messages: ChatMessage[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch (cause) {
      throw new ChatFormatError(`line ${i + 1} is not valid JSON: ${String(cause)}`)
    }
    if (typeof obj !== 'object' || obj === null) throw new ChatFormatError(`line ${i + 1} is not an object`)
    if (header === undefined) header = obj as ChatHeader
    else messages.push(obj as ChatMessage)
  }
  if (header === undefined) throw new ChatFormatError('chat log is empty')
  return { header, messages }
}

export function serializeChatLog(ir: ChatLogIR): string {
  const lines = [JSON.stringify(ir.header), ...ir.messages.map((m) => JSON.stringify(m))]
  return lines.join('\n') + '\n'
}

/* ------------------------- 聊天文件身份与命名 ------------------------- */

/**
 * 聊天 id 字符集与 `TavernStore.safeChatFileName` 同源：id 就是磁盘文件名，
 * 也是 URL 路径段。`#` 不在集合内（ST 的 `- checkpoint #N` 字面量因此落成
 * `- checkpoint N`），`/`、`%`、`:` 同样不可用——`/` 会撕裂路由段，`%`/`:` 在
 * URI 里需要转义且 Windows 文件名禁用 `:`。
 */
const CHAT_ID = /^[A-Za-z0-9@ _.-]+\.jsonl$/

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID.test(value) && !value.includes('..')
}

/**
 * 把用户输入的聊天名规范成聊天 id（缺省补 `.jsonl`）。非法字符不静默改写：
 * 名字进 URL 与磁盘，悄悄替换会让用户找不到自己刚导入的文件。
 */
export function chatIdOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new ChatFormatError('chat name is required')
  const id = /\.jsonl$/i.test(trimmed) ? trimmed : `${trimmed}.jsonl`
  if (!isChatId(id)) {
    throw new ChatFormatError(
      `chat name '${name}' is not a valid chat id; allowed characters are letters, digits, space, @ . _ - and it must not contain '..'`,
    )
  }
  return id
}

/** 展示名：聊天 id 去掉扩展名（UI 列表与提示文案用它，不是磁盘身份）。 */
export function chatDisplayName(chatId: string): string {
  return chatId.replace(/\.jsonl$/i, '')
}

/** 命名词干：去掉扩展名并按 store 的 `branchChat`/`forkChat` 同款字符集收敛。 */
export function chatStem(chatId: string): string {
  const stem = chatDisplayName(chatId).replace(/[^A-Za-z0-9@ _.-]/g, '_').slice(0, 80)
  return stem === '' ? 'chat' : stem
}

/**
 * 派生 id `${stem} - ${label} N.jsonl`，N 从 1 递增到不与 `existing` 冲突。
 * `existing` 是 `listChats` 的原样输出（只含 `.jsonl`，不含 overlay）。
 */
export function freeChatId(existing: readonly string[], stem: string, label: string): string {
  const base = `${chatStem(stem)} - ${label}`
  const taken = new Set(existing)
  let counter = 1
  let id = `${base} 1.jsonl`
  while (taken.has(id)) {
    counter += 1
    id = `${base} ${counter}.jsonl`
  }
  return id
}

/* --------------------------- checkpoint 谱系 --------------------------- */

export interface CheckpointParent {
  character: string
  chatId: string
  /** 复制的最后一条消息下标；父聊天为空时为 -1。 */
  messageId: number
}

/** 读 header.chat_metadata.checkpoint_parent；形状不合法的值按“不是 checkpoint”处理。 */
export function readCheckpointParent(header: ChatHeader): CheckpointParent | undefined {
  const metadata = header.chat_metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const raw = (metadata as Record<string, unknown>)['checkpoint_parent']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const { character, chatId, messageId } = record
  if (typeof character !== 'string' || typeof chatId !== 'string') return undefined
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < -1) return undefined
  return { character, chatId, messageId }
}

/**
 * 截取 `0..messageId` 生成 checkpoint 日志（缺省 `messageId` = 全部）。
 * header 深拷贝后写 `chat_metadata.checkpoint_parent`，父聊天身份与回跳点
 * 自描述，不依赖文件名推断——`name` 允许用户改，文件名字符集还砍掉了 `#`。
 */
export function toCheckpoint(
  ir: ChatLogIR,
  parent: { character: string; chatId: string },
  messageId?: number,
): { log: ChatLogIR; messageId: number } {
  const last = ir.messages.length - 1
  const end = messageId ?? last
  if (!Number.isSafeInteger(end) || end < -1 || end > last) {
    throw new ChatFormatError(`checkpoint messageId ${String(end)} is out of range (0..${last})`)
  }
  const header = structuredClone(ir.header)
  header.chat_metadata = {
    ...(header.chat_metadata ?? {}),
    checkpoint_parent: {
      character: parent.character,
      chatId: parent.chatId,
      messageId: end,
    } satisfies CheckpointParent,
  }
  return {
    log: { header, messages: ir.messages.slice(0, end + 1).map((message) => structuredClone(message)) },
    messageId: end,
  }
}

/**
 * 整聊复制的日志：全量深拷贝，但 `chat_metadata.bookmark_link` 不跟过去——
 * 那是“从某条消息分支出来”的回链，副本不是分支，留着会让副本在 UI 上指向
 * 别人的父消息。
 */
export function toDuplicate(ir: ChatLogIR): ChatLogIR {
  const header = structuredClone(ir.header)
  const metadata: Record<string, unknown> = { ...(header.chat_metadata ?? {}) }
  delete metadata['bookmark_link']
  header.chat_metadata = metadata
  return { header, messages: ir.messages.map((message) => structuredClone(message)) }
}

/* ---------------------------- 首楼开场白 ---------------------------- */

/**
 * 切换首楼（messages[0]）的 swipe：只改 `swipe_id` 与 `mes`，`swipes`/`swipe_info`
 * 原样保留。越界、无 swipe 池、首楼不是 AI 楼（开场白语义）都抛错，不静默回到 0。
 */
export function applyGreetingSwipe(ir: ChatLogIR, index: number): { log: ChatLogIR; mes: string } {
  const opening = ir.messages[0]
  if (opening === undefined) throw new ChatFormatError('chat has no opening message to swap')
  if (opening.is_user === true) throw new ChatFormatError('the opening message is a user message, not a greeting')
  const swipes = Array.isArray(opening.swipes) ? opening.swipes : []
  if (swipes.length === 0) throw new ChatFormatError('the opening message has no alternate greetings')
  if (!Number.isSafeInteger(index) || index < 0 || index >= swipes.length) {
    throw new ChatFormatError(`greeting index ${String(index)} is out of range (0..${swipes.length - 1})`)
  }
  const mes = swipes[index] ?? ''
  const log: ChatLogIR = {
    header: structuredClone(ir.header),
    messages: ir.messages.map((message) => structuredClone(message)),
  }
  log.messages[0] = { ...log.messages[0]!, swipe_id: index, mes }
  return { log, mes }
}

/* ---------------------------- 导入形状校验 ---------------------------- */

/**
 * 导入用的解析 + 形状校验。`parseChatLog` 只保证“每行是 JSON 对象”，导入是把
 * 外部文件写成自己的数据，形状错在写盘前挡下来：消息缺 `mes` 之类的记录会让
 * 后续装配与渲染拿不到正文，问题会推迟到生成时才暴露。
 * 读路径仍用宽松的 `parseChatLog`——历史文件不能因为一条缺口字段就读不出来。
 */
export function parseImportedChatLog(text: string): ChatLogIR {
  // 外部文件的行尾与 BOM 归一到本仓的 `\n`：ST 导出的 JSONL 在 Windows 编辑器里
  // 存成 CRLF 后，空行只剩 `\r`，`JSON.parse('\r')` 会报错；UTF-8 BOM 会让
  // header 行不再是 JSON。读路径（`parseChatLog`）保持原样，只在导入时放宽。
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const ir = parseChatLog(normalized)
  const header = ir.header as unknown
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new ChatFormatError('chat header must be a JSON object')
  }
  const headerRecord = header as Record<string, unknown>
  for (const key of ['user_name', 'character_name'] as const) {
    const value = headerRecord[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new ChatFormatError(`chat header field '${key}' must be a string`)
    }
  }
  const metadata = headerRecord['chat_metadata']
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new ChatFormatError("chat header field 'chat_metadata' must be an object")
  }
  ir.messages.forEach((message, position) => {
    assertImportedMessage(message, position + 2)
  })
  return ir
}

function assertImportedMessage(message: ChatMessage, line: number): void {
  const record = message as unknown
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new ChatFormatError(`line ${line} is not a message object`)
  }
  const fields = record as Record<string, unknown>
  if (typeof fields['name'] !== 'string') throw new ChatFormatError(`line ${line}: message 'name' must be a string`)
  if (typeof fields['mes'] !== 'string') throw new ChatFormatError(`line ${line}: message 'mes' must be a string`)
  if (fields['is_user'] !== undefined && typeof fields['is_user'] !== 'boolean') {
    throw new ChatFormatError(`line ${line}: message 'is_user' must be a boolean`)
  }
  if (fields['is_system'] !== undefined && typeof fields['is_system'] !== 'boolean') {
    throw new ChatFormatError(`line ${line}: message 'is_system' must be a boolean`)
  }
  const swipeId = fields['swipe_id']
  if (swipeId !== undefined && (typeof swipeId !== 'number' || !Number.isSafeInteger(swipeId) || swipeId < 0)) {
    throw new ChatFormatError(`line ${line}: message 'swipe_id' must be a non-negative integer`)
  }
  const swipes = fields['swipes']
  if (swipes !== undefined && (!Array.isArray(swipes) || swipes.some((value) => typeof value !== 'string'))) {
    throw new ChatFormatError(`line ${line}: message 'swipes' must be an array of strings`)
  }
  const swipeInfo = fields['swipe_info']
  if (swipeInfo !== undefined && (!Array.isArray(swipeInfo) || swipeInfo.some((value) => typeof value !== 'object' || value === null))) {
    throw new ChatFormatError(`line ${line}: message 'swipe_info' must be an array of objects`)
  }
}
