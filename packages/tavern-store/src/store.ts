/**
 * Tavern 数据存储：$DSH_HOME/tavern/ 下的目录布局与 CRUD。
 *
 * ```text
 * tavern/
 * ├── characters/<name>.png|<name>.json   # PNG 原样存（保留图像与双 chunk）
 * ├── worlds/<name>.json                  # ST 世界书文件形态
 * ├── presets/<name>.json                 # ST chat completion preset 形态
 * ├── chats/<character>/<timestamp>.jsonl # ST 聊天文件形态
 * ├── personas/<name>.json                # persona 定义
 * └── state.json                          # 运行时状态（当前卡/书/预设/persona）
 * ```
 *
 * 写操作原子（tmp + rename）。Node-only（插件 Node half 使用）。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  decodeCharacterCard,
  decodeCharx,
  encodeCharacterCardJson,
  encodeCharacterCardPng,
  parseChatLog,
  parseWorldInfoFile,
  serializeChatLog,
  serializeWorldInfoFile,
  type CharacterCardIR,
  type ChatLogIR,
  type WorldBookIR,
} from '@dsh-tavern/format'

export interface TavernSessionBinding {
  character: string
  chatId: string
}

export interface TavernState {
  activeCharacter?: string
  /** 启用的世界书名列表（含卡内嵌书的角色书按卡名引用） */
  activeWorlds: string[]
  activePreset?: string
  activePersona?: string
  /** 将当前角色人格注入普通 DSH Agent 会话；默认关闭。 */
  nativeAgentPersona?: boolean
  /** DSH session 到 Tavern 角色/聊天的持久绑定。 */
  sessionBindings: Record<string, TavernSessionBinding>
  /** 每聊天元数据（最后激活时间、swipe 指针等自由袋） */
  chats: Record<string, Record<string, unknown>>
}

export interface Persona {
  name: string
  description: string
  [key: string]: unknown
}

export interface CharacterFile {
  fileName: string
  kind: 'png' | 'json' | 'charx'
  card: CharacterCardIR
}

export interface ChatSnapshot {
  chat: ChatLogIR
  revision: string
}

export class ChatRevisionConflictError extends Error {
  readonly code = 'CHAT_REVISION_CONFLICT'

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision?: string,
  ) {
    super('Chat changed in another tab. Reloaded the latest version; review it before retrying.')
    this.name = 'ChatRevisionConflictError'
  }
}

const DEFAULT_STATE: TavernState = { activeWorlds: [], sessionBindings: {}, chats: {} }

export class TavernStore {
  private chatMutationTail: Promise<void> = Promise.resolve()
  private stateMutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<TavernStore> {
    for (const dir of ['characters', 'worlds', 'presets', 'chats', 'personas']) {
      await fs.mkdir(path.join(root, dir), { recursive: true })
    }
    return new TavernStore(root)
  }

  /* ------------------------------ 角色 ------------------------------ */

  /** 导入角色卡：PNG/CHARX 原字节落盘保留资源；JSON 对象序列化落盘。重名覆盖。 */
  async importCharacter(source: Uint8Array | object): Promise<{ fileName: string; card: CharacterCardIR }> {
    let bytes: Uint8Array
    let kind: 'png' | 'json' | 'charx'
    let card: CharacterCardIR
    if (source instanceof Uint8Array) {
      if (source[0] === 0x89 && source[1] === 0x50) {
        bytes = source
        kind = 'png'
        card = decodeCharacterCard(bytes)
      } else if (source[0] === 0x50 && source[1] === 0x4b) {
        bytes = source
        kind = 'charx'
        card = decodeCharx(bytes).card
      } else {
        card = decodeCharacterCard(JSON.parse(Buffer.from(source).toString('utf8')))
        bytes = jsonBytes(encodeCharacterCardJson(card))
        kind = 'json'
      }
    } else {
      card = decodeCharacterCard(source)
      bytes = jsonBytes(encodeCharacterCardJson(card))
      kind = 'json'
    }
    const stem = safeFileName(card.data.name)
    const fileName = `${stem}.${kind}`
    await this.writeAtomic(path.join(this.root, 'characters', fileName), bytes)
    await Promise.all((['png', 'json', 'charx'] as const)
      .filter((other) => other !== kind)
      .map((other) => fs.rm(path.join(this.root, 'characters', `${stem}.${other}`), { force: true })))
    return { fileName, card }
  }

  /** 导出角色卡 PNG（带模板图）；无图像模板时导出 JSON。 */
  async exportCharacter(name: string, template?: Uint8Array): Promise<Uint8Array> {
    const file = await this.getCharacter(name)
    if (file === undefined) throw new Error(`character '${name}' not found`)
    if (file.kind === 'png') {
      const bytes = await fs.readFile(path.join(this.root, 'characters', file.fileName))
      if (template === undefined) return bytes
      return encodeCharacterCardPng(file.card, bytes)
    }
    if (file.kind === 'charx' && template === undefined) {
      return new Uint8Array(await fs.readFile(path.join(this.root, 'characters', file.fileName)))
    }
    if (template !== undefined) return encodeCharacterCardPng(file.card, template)
    return new Uint8Array(Buffer.from(JSON.stringify(encodeCharacterCardJson(file.card), null, 2), 'utf8'))
  }

  async listCharacters(): Promise<string[]> {
    const files = await this.listDir('characters')
    return [...new Set(files
      .filter((f) => /\.(png|json|charx)$/.test(f))
      .map((f) => f.replace(/\.(png|json|charx)$/, '')))]
      .sort()
  }

  async getCharacter(name: string): Promise<CharacterFile | undefined> {
    for (const kind of ['png', 'charx', 'json'] as const) {
      const fileName = `${safeFileName(name)}.${kind}`
      try {
        const bytes = new Uint8Array(await fs.readFile(path.join(this.root, 'characters', fileName)))
        const card = kind === 'png'
          ? decodeCharacterCard(bytes)
          : kind === 'charx'
            ? decodeCharx(bytes).card
            : decodeCharacterCard(JSON.parse(Buffer.from(bytes).toString('utf8')))
        return { fileName, kind, card }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    return undefined
  }

  async deleteCharacter(name: string): Promise<boolean> {
    let deleted = false
    for (const kind of ['png', 'json', 'charx'] as const) {
      const file = path.join(this.root, 'characters', `${safeFileName(name)}.${kind}`)
      try {
        await fs.unlink(file)
        deleted = true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    return deleted
  }

  /* ----------------------------- 世界书 ----------------------------- */

  async putWorld(book: WorldBookIR): Promise<void> {
    await this.writeAtomic(
      path.join(this.root, 'worlds', `${safeFileName(book.name)}.json`),
      jsonBytes(serializeWorldInfoFile(book)),
    )
  }

  /** 导入 ST 世界书文件对象。 */
  async importWorldFile(name: string, obj: Record<string, unknown>): Promise<WorldBookIR> {
    const ir = parseWorldInfoFile(name, obj)
    await this.putWorld(ir)
    return ir
  }

  async listWorlds(): Promise<string[]> {
    const files = await this.listDir('worlds')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async getWorld(name: string): Promise<WorldBookIR | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'worlds', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return parseWorldInfoFile(name, JSON.parse(Buffer.from(bytes).toString('utf8')))
  }

  async deleteWorld(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'worlds', `${safeFileName(name)}.json`), { force: true })
  }

  /* ------------------------------ 聊天 ------------------------------ */

  async createChat(characterName: string, header: ChatLogIR['header'], messages: ChatLogIR['messages'] = []): Promise<string> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      await fs.mkdir(dir, { recursive: true })
      const id = `${timestamp()}.jsonl`
      await this.writeAtomic(path.join(dir, id), chatBytes({ header, messages }))
      return id
    })
  }

  async saveChat(characterName: string, chatId: string, log: ChatLogIR, expectedRevision?: string): Promise<string> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const file = path.join(dir, safeChatFileName(chatId))
      await this.assertChatRevision(file, expectedRevision)
      const bytes = chatBytes(log)
      await this.writeAtomic(file, bytes)
      return chatRevision(bytes)
    })
  }

  async getChat(characterName: string, chatId: string): Promise<ChatLogIR | undefined> {
    return (await this.getChatSnapshot(characterName, chatId))?.chat
  }

  async getChatSnapshot(characterName: string, chatId: string): Promise<ChatSnapshot | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'chats', safeFileName(characterName), safeChatFileName(chatId)))
    if (bytes === undefined) return undefined
    return {
      chat: parseChatLog(Buffer.from(bytes).toString('utf8')),
      revision: chatRevision(bytes),
    }
  }

  async listChats(characterName: string): Promise<string[]> {
    const dir = path.join(this.root, 'chats', safeFileName(characterName))
    try {
      const files = await fs.readdir(dir)
      return files.filter((f) => f.endsWith('.jsonl')).sort()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  async renameChat(characterName: string, chatId: string, nextChatId: string, expectedRevision?: string): Promise<void> {
    await this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const source = path.join(dir, safeChatFileName(chatId))
      const target = path.join(dir, safeChatFileName(nextChatId))
      await this.assertChatRevision(source, expectedRevision)
      if (source === target) return
      if (await this.tryRead(target)) throw new Error(`chat '${nextChatId}' already exists`)
      await fs.rename(source, target)
    })
  }

  async deleteChat(characterName: string, chatId: string, expectedRevision?: string): Promise<boolean> {
    return this.mutateChat(async () => {
      const file = path.join(this.root, 'chats', safeFileName(characterName), safeChatFileName(chatId))
      try {
        await this.assertChatRevision(file, expectedRevision)
        await fs.unlink(file)
        return true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw cause
      }
    })
  }

  /* ------------------------------ 预设 ------------------------------ */

  /** 预设按原样 JSON 存取（含采样参数与 prompts/prompt_order 全量）。 */
  async putPreset(name: string, preset: Record<string, unknown>): Promise<void> {
    await this.writeAtomic(path.join(this.root, 'presets', `${safeFileName(name)}.json`), jsonBytes(preset))
  }

  async getPreset(name: string): Promise<Record<string, unknown> | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'presets', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
  }

  async listPresets(): Promise<string[]> {
    const files = await this.listDir('presets')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deletePreset(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'presets', `${safeFileName(name)}.json`), { force: true })
  }

  /* ----------------------------- persona ----------------------------- */

  async putPersona(persona: Persona): Promise<void> {
    await this.writeAtomic(path.join(this.root, 'personas', `${safeFileName(persona.name)}.json`), jsonBytes(persona))
  }

  async getPersona(name: string): Promise<Persona | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'personas', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Persona
  }

  async listPersonas(): Promise<string[]> {
    const files = await this.listDir('personas')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  /* ------------------------------ 状态 ------------------------------ */

  async getState(): Promise<TavernState> {
    await this.stateMutationTail.catch(() => {})
    return this.readState()
  }

  async patchState(patch: Partial<TavernState>): Promise<TavernState> {
    return this.updateState(() => patch)
  }

  async updateState(update: (state: TavernState) => Partial<TavernState>): Promise<TavernState> {
    return this.mutateState(async () => {
      const current = await this.readState()
      const next = { ...current, ...update(structuredClone(current)) }
      await this.writeAtomic(path.join(this.root, 'state.json'), jsonBytes(next))
      return next
    })
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async readState(): Promise<TavernState> {
    const bytes = await this.tryRead(path.join(this.root, 'state.json'))
    if (bytes === undefined) return structuredClone(DEFAULT_STATE)
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<TavernState>
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      activeWorlds: parsed.activeWorlds ?? [],
      sessionBindings: parsed.sessionBindings ?? {},
      chats: parsed.chats ?? {},
    }
  }

  private async assertChatRevision(file: string, expectedRevision?: string): Promise<void> {
    if (expectedRevision === undefined) return
    const current = await this.tryRead(file)
    const actualRevision = current === undefined ? undefined : chatRevision(current)
    if (actualRevision !== expectedRevision) {
      throw new ChatRevisionConflictError(expectedRevision, actualRevision)
    }
  }

  private mutateChat<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chatMutationTail.catch(() => {}).then(operation)
    this.chatMutationTail = result.then(() => {}, () => {})
    return result
  }

  private mutateState<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateMutationTail.catch(() => {}).then(operation)
    this.stateMutationTail = result.then(() => {}, () => {})
    return result
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(path.join(this.root, dir))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  private async tryRead(file: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await fs.readFile(file))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    }
  }

  private async writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, file)
  }
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '_unnamed'
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h ${pad(d.getMinutes())}m ${pad(d.getSeconds())}s ${pad(d.getMilliseconds(), 3)}ms`
}

function safeChatFileName(name: string): string {
  if (!/^[A-Za-z0-9@ _.-]+\.jsonl$/.test(name) || name.includes('..')) throw new Error('invalid chat id')
  return name
}

function chatBytes(log: ChatLogIR): Uint8Array {
  return new Uint8Array(Buffer.from(serializeChatLog(log), 'utf8'))
}

function chatRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url')
}

function jsonBytes(obj: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2), 'utf8'))
}
