/**
 * Tavern 数据存储：$DSH_HOME/tavern/ 下的目录布局与 CRUD。
 *
 * ```text
 * tavern/
 * ├── characters/<name>.png|<name>.json   # PNG 原样存（保留图像与双 chunk）
 * ├── worlds/<name>.json                  # ST 世界书文件形态
 * ├── presets/<name>.json                 # ST preset 形态（chat completion / context / instruct / textgen）
 * ├── chats/<character>/<timestamp>.jsonl # ST 聊天文件形态（character 为角色名或群名）
 * ├── personas/<name>.json                # persona 定义
 * ├── personas/avatars/<name>.png         # persona 头像
 * ├── groups/<name>.json                  # ST 群组文件形态（members 为角色名）
 * └── state.json                          # 运行时状态（当前卡/书/预设/persona/regex/TC）
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
  decodeCharxAsset,
  encodeCharx,
  encodeCharacterCardJson,
  encodeCharacterCardPng,
  parseCharacterBook,
  parseChatLog,
  parseGroupFile,
  parseWorldInfoFile,
  serializeChatLog,
  serializeGroupFile,
  serializeWorldInfoFile,
  type CharacterCardIR,
  type ChatLogIR,
  type GroupIR,
  type RegexScriptIR,
  type WorldBookIR,
} from '@dsh-tavern/format'

export type TavernArchitecture = 'agent-tavern' | 'st'
export type TavernContextMode = 'dsh-native' | 'agent-managed'

interface TavernSessionBase {
  character: string
  chatId: string
  /** 群聊绑定时为 true；character 字段承载群名。 */
  group?: boolean
}

export type TavernSessionBinding =
  | (TavernSessionBase & {
      architecture: 'agent-tavern'
      contextMode: TavernContextMode
      /** 客户端已预绑定，等待内部命令完成 AgentTavern 初始化。 */
      initializationPending?: true
    })
  | (TavernSessionBase & {
      architecture: 'st'
    })

/** 一个 DSH session 的模型选择；缺省回落 agentDefaultModel。 */
export interface TavernModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Text Completion 管线配置（Kobold 端点与预设选择）。 */
export interface TextCompletionConfig {
  endpoint: string
  apiKey?: string
  /** 优先 SSE 流式端点，失败回退单发 */
  streaming: boolean
  contextPreset?: string
  instructPreset?: string
  samplerPreset?: string
}

export interface TavernState {
  activeCharacter?: string
  /** 启用的世界书名列表；角色绑定的世界书（extensions.world）在使用该角色时自动并入 */
  activeWorlds: string[]
  activePreset?: string
  activePersona?: string
  /** 将当前角色人格注入普通 DSH Agent 会话；默认关闭。 */
  nativeAgentPersona?: boolean
  /** DSH session 到 Tavern 角色/聊天的持久绑定。 */
  sessionBindings: Record<string, TavernSessionBinding>
  /** 新建会话的架构默认值；不影响已有 binding。 */
  defaultArchitecture: TavernArchitecture
  /** 新建 AgentTavern 会话的上下文模式；不影响已有 binding。 */
  defaultContextMode: TavernContextMode
  /** 新建 AgentTavern 会话初始化时预注入角色信息与常驻世界书条目。 */
  agentTavernPreloadAssets: boolean
  /** 允许 AgentTavern 工具写入 global 作用域的记忆/变量；默认关闭。 */
  agentTavernAllowGlobalWrites: boolean
  /** DSH session 到模型选择的持久映射；随 bindings/prune 一同清理。 */
  modelSelections: Record<string, TavernModelSelection>
  /** 每聊天元数据（最后激活时间、swipe 指针等自由袋） */
  chats: Record<string, Record<string, unknown>>
  /** 全局 regex 脚本（ST regex 扩展形态）。 */
  regexScripts: RegexScriptIR[]
  /** STscript 全局变量。 */
  scriptGlobals: Record<string, string | number | boolean>
  /** 生成管线选择：chat completion（默认）或 text completion。 */
  pipelineMode: 'chat' | 'text'
  /** Text Completion 管线配置。 */
  textCompletion?: TextCompletionConfig
}

export interface Persona {
  name: string
  description: string
  /** 描述注入位置：0=IN_PROMPT（默认），4=AT_DEPTH（配 depth/role） */
  position?: number
  depth?: number
  role?: number
  title?: string
  /** 存在 avatars/<name>.png 头像文件时为 true */
  hasAvatar?: boolean
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

const DEFAULT_STATE: TavernState = {
  activeWorlds: [],
  sessionBindings: {},
  defaultArchitecture: 'agent-tavern',
  defaultContextMode: 'dsh-native',
  agentTavernPreloadAssets: false,
  agentTavernAllowGlobalWrites: false,
  modelSelections: {},
  chats: {},
  regexScripts: [],
  scriptGlobals: {},
  pipelineMode: 'chat',
}

export class TavernStore {
  private chatMutationTail: Promise<void> = Promise.resolve()
  private stateMutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<TavernStore> {
    for (const dir of ['characters', 'worlds', 'presets', 'chats', 'personas', 'groups', 'personas/avatars']) {
      await fs.mkdir(path.join(root, dir), { recursive: true })
    }
    return new TavernStore(root)
  }

  /* ------------------------------ 角色 ------------------------------ */

  /** 导入角色卡：PNG/CHARX 原字节落盘保留资源；JSON 对象序列化落盘。重名覆盖。
   *  卡内嵌角色书自动物化为世界书文件并写回 extensions.world 链接（对齐 ST 导入语义）。 */
  async importCharacter(source: Uint8Array | object): Promise<{ fileName: string; card: CharacterCardIR; importedWorld?: string }> {
    let bytes: Uint8Array
    let kind: 'png' | 'json' | 'charx'
    let card: CharacterCardIR
    let charxAssets: Array<{ path: string; data: Uint8Array }> | undefined
    if (source instanceof Uint8Array) {
      if (source[0] === 0x89 && source[1] === 0x50) {
        bytes = source
        kind = 'png'
        card = decodeCharacterCard(bytes)
      } else if (source[0] === 0x50 && source[1] === 0x4b) {
        bytes = source
        kind = 'charx'
        const decoded = decodeCharx(bytes)
        card = decoded.card
        charxAssets = decoded.assetPaths.map((assetPath) => ({ path: assetPath, data: decodeCharxAsset(bytes, assetPath) }))
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
    const importedWorld = await this.materializeEmbeddedBook(card)
    if (importedWorld !== undefined) {
      // 链接写回了卡数据，容器需重编码以携带新 extensions.world（图像等资源经模板/资产保留）
      bytes = kind === 'png'
        ? encodeCharacterCardPng(card, bytes)
        : kind === 'charx'
          ? encodeCharx(card, charxAssets!)
          : jsonBytes(encodeCharacterCardJson(card))
    }
    const stem = safeFileName(card.data.name)
    const fileName = `${stem}.${kind}`
    await this.writeAtomic(path.join(this.root, 'characters', fileName), bytes)
    await Promise.all((['png', 'json', 'charx'] as const)
      .filter((other) => other !== kind)
      .map((other) => fs.rm(path.join(this.root, 'characters', `${stem}.${other}`), { force: true })))
    return { fileName, card, importedWorld }
  }

  /**
   * 卡内嵌角色书 → worlds/ 下的世界书文件（重名覆盖，导入以卡内嵌书为准），
   * 并把 extensions.world 链接写回卡数据。返回物化的世界书名；无内嵌书时为 undefined。
   * 命名：已有链接名 > 内嵌书自身名 > 角色名。
   */
  private async materializeEmbeddedBook(card: CharacterCardIR): Promise<string | undefined> {
    const book = card.data.characterBook
    if (!book) return undefined
    const rawLinked = card.data.extensions['world']
    const linkedName = typeof rawLinked === 'string' ? rawLinked.trim() : ''
    const bookName = linkedName !== ''
      ? linkedName
      : (typeof book.name === 'string' && book.name.trim() !== '' ? book.name.trim() : card.data.name)
    await this.putWorld({ ...parseCharacterBook(book), name: bookName })
    if (linkedName === '') {
      card.data.extensions = { ...card.data.extensions, world: bookName }
    }
    return bookName
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

  /**
   * 保存已编辑的角色卡，并尽量保留原始容器：PNG 继续写回原图的 chunks，
   * CHARX 继续保留 zip 内全部资源；名称变更时同步迁移文件名。
   */
  async updateCharacter(name: string, source: object): Promise<CharacterFile> {
    const current = await this.getCharacter(name)
    if (current === undefined) throw new Error(`character '${name}' not found`)
    const incomingData = (source as { data?: unknown }).data
    const card = typeof incomingData === 'object' && incomingData !== null && !Array.isArray(incomingData)
      && Object.prototype.hasOwnProperty.call(incomingData, 'firstMes')
      ? {
          ...current.card,
          spec: (source as { spec?: CharacterCardIR['spec'] }).spec ?? current.card.spec,
          specVersion: typeof (source as { specVersion?: unknown }).specVersion === 'string'
            ? (source as { specVersion: string }).specVersion
            : current.card.specVersion,
          data: { ...current.card.data, ...(incomingData as Partial<CharacterCardIR['data']>) },
          raw: structuredClone(current.card.raw),
        }
      : decodeCharacterCard(source)
    if (typeof card.data.name !== 'string' || card.data.name.trim() === '') {
      throw new Error('character name cannot be empty')
    }
    const nextStem = safeFileName(card.data.name)
    const currentStem = safeFileName(name)
    const collision = await this.getCharacter(card.data.name)
    if (collision !== undefined && nextStem !== currentStem) {
      throw new Error(`character '${card.data.name}' already exists`)
    }
    let bytes: Uint8Array
    let kind: 'png' | 'charx' | 'json' = current.kind
    const original = new Uint8Array(await fs.readFile(path.join(this.root, 'characters', current.fileName)))
    if (current.kind === 'png') {
      bytes = encodeCharacterCardPng(card, original)
    } else if (current.kind === 'charx') {
      const decoded = decodeCharx(original)
      bytes = encodeCharx(card, decoded.assetPaths.map((assetPath) => ({ path: assetPath, data: decodeCharxAsset(original, assetPath) })))
    } else {
      bytes = jsonBytes(encodeCharacterCardJson(card))
    }
    await this.writeAtomic(path.join(this.root, 'characters', `${nextStem}.${kind}`), bytes)
    if (currentStem !== nextStem || current.kind !== kind) {
      await fs.rm(path.join(this.root, 'characters', current.fileName), { force: true })
    }
    if (currentStem !== nextStem) {
      try {
        await fs.access(path.join(this.root, 'chats', nextStem))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
        try {
          await fs.rename(path.join(this.root, 'chats', currentStem), path.join(this.root, 'chats', nextStem))
        } catch (renameCause) {
          if ((renameCause as NodeJS.ErrnoException).code !== 'ENOENT') throw renameCause
        }
      }
    }
    for (const other of (['png', 'json', 'charx'] as const).filter((other) => other !== kind)) {
      await fs.rm(path.join(this.root, 'characters', `${nextStem}.${other}`), { force: true })
    }
    const saved = await this.getCharacter(card.data.name)
    if (saved === undefined) throw new Error(`character '${card.data.name}' could not be reloaded`)
    return saved
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
    // 对齐 ST 语义：删角色连同其聊天记录（chats/<name>/ 一并移除）。
    if (deleted) {
      await fs.rm(path.join(this.root, 'chats', safeFileName(name)), { recursive: true, force: true })
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

  async exportWorld(name: string): Promise<Uint8Array> {
    const book = await this.getWorld(name)
    if (book === undefined) throw new Error(`world '${name}' not found`)
    return jsonBytes(serializeWorldInfoFile(book))
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

  /* ------------------------------ 群组 ------------------------------ */

  async putGroup(group: GroupIR): Promise<void> {
    await this.writeAtomic(
      path.join(this.root, 'groups', `${safeFileName(group.name)}.json`),
      jsonBytes(serializeGroupFile(group)),
    )
  }

  async getGroup(name: string): Promise<GroupIR | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'groups', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return parseGroupFile(JSON.parse(Buffer.from(bytes).toString('utf8')), name)
  }

  async listGroups(): Promise<string[]> {
    const files = await this.listDir('groups')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deleteGroup(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'groups', `${safeFileName(name)}.json`), { force: true })
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

  async exportPreset(name: string): Promise<Uint8Array> {
    const preset = await this.getPreset(name)
    if (preset === undefined) throw new Error(`preset '${name}' not found`)
    return jsonBytes(preset)
  }

  async listPresets(): Promise<string[]> {
    const files = await this.listDir('presets')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deletePreset(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'presets', `${safeFileName(name)}.json`), { force: true })
  }

  /* ----------------------------- persona ----------------------------- */

  async putPersona(persona: Persona, avatar?: Uint8Array): Promise<void> {
    await this.writeAtomic(path.join(this.root, 'personas', `${safeFileName(persona.name)}.json`), jsonBytes(persona))
    if (avatar !== undefined) {
      await this.writeAtomic(path.join(this.root, 'personas', 'avatars', `${safeFileName(persona.name)}.png`), avatar)
    }
  }

  /**
   * 导入 persona PNG：内嵌 `chara`/`ccv3` 的 description 作为人设描述
   * （ST persona 导入行为），文件名 stem 作为 persona 名；头像原字节保存。
   */
  async importPersonaPng(bytes: Uint8Array, fallbackName: string): Promise<Persona> {
    let description = ''
    try {
      const card = decodeCharacterCard(bytes)
      description = card.data.description
    } catch {
      // 无内嵌卡数据：仅头像（ST 对无数据头像的行为）
    }
    const name = safeFileName(fallbackName) || 'Persona'
    const persona: Persona = { name, description, position: 0, hasAvatar: true }
    await this.putPersona(persona, bytes)
    return persona
  }

  async getPersonaAvatar(name: string): Promise<Uint8Array | undefined> {
    return this.tryRead(path.join(this.root, 'personas', 'avatars', `${safeFileName(name)}.png`))
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

  async deletePersona(name: string): Promise<boolean> {
    let deleted = false
    const json = path.join(this.root, 'personas', `${safeFileName(name)}.json`)
    const avatar = path.join(this.root, 'personas', 'avatars', `${safeFileName(name)}.png`)
    try {
      await fs.unlink(json)
      deleted = true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    await fs.rm(avatar, { force: true })
    return deleted
  }

  /* ------------------------------ 分支 ------------------------------ */

  /**
   * 从 messageId（含）截断复制为新聊天；chat_metadata.bookmark_link 记录回链。
   * 分支命名 `${stem} - branch N.jsonl`（N 递增至不冲突，字符集安全）。
   */
  async branchChat(
    characterName: string,
    chatId: string,
    messageId: number,
    expectedRevision?: string,
    name?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ chatId: string; chat: ChatLogIR }> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const source = path.join(dir, safeChatFileName(chatId))
      await this.assertChatRevision(source, expectedRevision)
      const bytes = await this.tryRead(source)
      if (bytes === undefined) throw new Error(`chat '${chatId}' not found`)
      const log = parseChatLog(Buffer.from(bytes).toString('utf8'))
      if (messageId < 0 || messageId >= log.messages.length) {
        throw new Error(`branch messageId ${messageId} out of range (0..${log.messages.length - 1})`)
      }
      const branchMessages = log.messages.slice(0, messageId + 1).map((m) => ({ ...m }))
      const header = structuredClone(log.header)
      header.chat_metadata = {
        ...(header.chat_metadata ?? {}),
        bookmark_link: { character: characterName, chatId, messageId },
        ...(metadata ?? {}),
      }
      const stem = (name !== undefined && name.trim() !== ''
        ? name.trim()
        : chatId.replace(/\.jsonl$/i, '')).replace(/\.jsonl$/i, '')
      const safeStem = stem.replace(/[^A-Za-z0-9@ _.-]/g, '_').slice(0, 80) || 'chat'
      let nextId = `${safeStem} - branch 1.jsonl`
      let counter = 1
      while (await this.tryRead(path.join(dir, nextId)) !== undefined) {
        counter += 1
        nextId = `${safeStem} - branch ${counter}.jsonl`
      }
      const branchLog: ChatLogIR = { header, messages: branchMessages }
      await this.writeAtomic(path.join(dir, nextId), chatBytes(branchLog))
      return { chatId: nextId, chat: branchLog }
    })
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
      sessionBindings: normalizeSessionBindings(parsed.sessionBindings),
      defaultArchitecture: parsed.defaultArchitecture === 'st' ? 'st' : 'agent-tavern',
      defaultContextMode: parsed.defaultContextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
      agentTavernPreloadAssets: parsed.agentTavernPreloadAssets === true,
      agentTavernAllowGlobalWrites: parsed.agentTavernAllowGlobalWrites === true,
      modelSelections: parsed.modelSelections ?? {},
      chats: parsed.chats ?? {},
      regexScripts: parsed.regexScripts ?? [],
      scriptGlobals: parsed.scriptGlobals ?? {},
      pipelineMode: parsed.pipelineMode === 'text' ? 'text' : 'chat',
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

/**
 * Normalizes persisted bindings at the read seam. Bindings from before the
 * architecture split are ST sessions so an upgrade cannot silently change
 * their generation semantics. Unsupported group AgentTavern bindings also
 * fail closed to ST until actor metadata exists in the host event stream.
 */
export function normalizeTavernSessionBinding(value: unknown): TavernSessionBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.character !== 'string' || candidate.character.trim() === '') return undefined
  if (typeof candidate.chatId !== 'string' || candidate.chatId.trim() === '') return undefined
  const base = {
    character: candidate.character,
    chatId: candidate.chatId,
    ...(candidate.group === true ? { group: true as const } : {}),
  }
  if (candidate.architecture === 'agent-tavern' && base.group !== true) {
    return {
      ...base,
      architecture: 'agent-tavern',
      contextMode: candidate.contextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
      ...(candidate.initializationPending === true ? { initializationPending: true } : {}),
    }
  }
  return { ...base, architecture: 'st' }
}

function normalizeSessionBindings(value: unknown): Record<string, TavernSessionBinding> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .map(([sessionId, binding]) => [sessionId, normalizeTavernSessionBinding(binding)] as const)
    .filter((entry): entry is readonly [string, TavernSessionBinding] => entry[1] !== undefined))
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
