import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatRevisionConflictError, type TavernSessionBinding, type TavernState } from '../../../tavern-store/src/index.js'
import { RegexPlacement, type CharacterCardIR, type ChatLogIR, type ChatMessage, type RegexScriptIR } from '../../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../../tavern-script/src/index.js'
import { collectRegexScripts } from '../tavern-assets.js'

export interface NativeSessionEvent {
  type: string
  seq: number
  time: number
  data: any
}

/** 一次宿主 Session.append 的计划项；surfaceOp 缺省表示 log-only 事件。 */
export interface SessionImportAppend {
  type: string
  data: Record<string, unknown>
  surfaceOp?: 'append'
}

export interface NativeSession {
  id: string
  events: readonly NativeSessionEvent[]
}

export interface ProjectorStore {
  getState(): Promise<Pick<TavernState, 'sessionBindings' | 'regexScripts'>>
  getCharacter(name: string): Promise<{ card: CharacterCardIR } | undefined>
  getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR; revision: string } | undefined>
  saveChat(character: string, chatId: string, chat: ChatLogIR, expectedRevision?: string): Promise<string>
}

export interface ProjectionCheckpoint {
  version: 1
  sessionId: string
  lastCursor: number
  status: 'ok' | 'pending'
  pendingCursor?: number
  error?: string
  updatedAt: string
}

export class AgentTavernProjector {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly checkpoints = new Map<string, ProjectionCheckpoint>()

  private constructor(
    private readonly root: string,
    private readonly store: ProjectorStore,
  ) {}

  static async open(tavernRoot: string, store: ProjectorStore): Promise<AgentTavernProjector> {
    const root = join(tavernRoot, 'projections')
    await fs.mkdir(root, { recursive: true })
    return new AgentTavernProjector(root, store)
  }

  project(session: NativeSession, event: NativeSessionEvent): Promise<void> {
    const previous = this.tails.get(session.id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.projectOne(session, event))
    this.tails.set(session.id, current)
    return current.finally(() => {
      if (this.tails.get(session.id) === current) this.tails.delete(session.id)
    })
  }

  async replay(session: NativeSession): Promise<void> {
    const events = [...session.events].sort((left, right) => left.seq - right.seq)
    for (const event of events) await this.project(session, event)
  }

  async status(sessionId: string): Promise<ProjectionCheckpoint> {
    return structuredClone(await this.readCheckpoint(sessionId))
  }

  private async projectOne(session: NativeSession, event: NativeSessionEvent): Promise<void> {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('invalid DSH event cursor')
    const checkpoint = await this.readCheckpoint(session.id)
    if (event.seq <= checkpoint.lastCursor) return

    try {
      const state = await this.store.getState()
      const binding = state.sessionBindings[session.id]
      if (binding?.architecture === 'agent-tavern' && binding.group !== true) {
        const character = await this.store.getCharacter(binding.character)
        const scripts = collectRegexScripts(state, character)
        const message = projectMessage(session, event, binding, scripts)
        if (message !== undefined) await this.appendMessage(binding, session.id, event.seq, message)
      }
      await this.writeCheckpoint({
        version: 1,
        sessionId: session.id,
        lastCursor: event.seq,
        status: 'ok',
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      const pending: ProjectionCheckpoint = {
        version: 1,
        sessionId: session.id,
        lastCursor: checkpoint.lastCursor,
        status: 'pending',
        pendingCursor: event.seq,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }
      await this.writeCheckpoint(pending)
      throw error
    }
  }

  private async appendMessage(
    binding: Extract<TavernSessionBinding, { architecture: 'agent-tavern' }>,
    sessionId: string,
    eventSeq: number,
    message: ChatMessage,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.store.getChatSnapshot(binding.character, binding.chatId)
      if (!snapshot) throw new Error('AgentTavern projection target chat not found')
      if (snapshot.chat.messages.some((candidate) => projectionIdentity(candidate, sessionId, eventSeq))) return
      const next = structuredClone(snapshot.chat)
      next.messages.push(message.is_user ? { ...message, name: next.header.user_name || 'User' } : message)
      try {
        await this.store.saveChat(binding.character, binding.chatId, next, snapshot.revision)
        return
      } catch (error) {
        if (!(error instanceof ChatRevisionConflictError) || attempt === 3) throw error
      }
    }
  }

  private async readCheckpoint(sessionId: string): Promise<ProjectionCheckpoint> {
    const cached = this.checkpoints.get(sessionId)
    if (cached) return cached
    try {
      const parsed = JSON.parse(await fs.readFile(this.checkpointPath(sessionId), 'utf8')) as ProjectionCheckpoint
      validateCheckpoint(parsed, sessionId)
      this.checkpoints.set(sessionId, parsed)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const empty: ProjectionCheckpoint = {
        version: 1,
        sessionId,
        lastCursor: -1,
        status: 'ok',
        updatedAt: new Date(0).toISOString(),
      }
      this.checkpoints.set(sessionId, empty)
      return empty
    }
  }

  private async writeCheckpoint(checkpoint: ProjectionCheckpoint): Promise<void> {
    const target = this.checkpointPath(checkpoint.sessionId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, 'utf8')
    await fs.rename(temporary, target)
    this.checkpoints.set(checkpoint.sessionId, checkpoint)
  }

  private checkpointPath(sessionId: string): string {
    const name = createHash('sha256').update(sessionId).digest('hex')
    return join(this.root, `${name}.json`)
  }
}

function projectMessage(
  session: NativeSession,
  event: NativeSessionEvent,
  binding: Extract<TavernSessionBinding, { architecture: 'agent-tavern' }>,
  scripts: RegexScriptIR[],
): ChatMessage | undefined {
  if (event.type === 'user/message') {
    if (event.data?.source?.kind !== 'user') return undefined
    const text = messageText(event.data?.content)
    if (text === '') return undefined
    return {
      name: 'User',
      is_user: true,
      is_system: false,
      send_date: eventDate(event.time),
      // ST 语义：USER_INPUT 正则在消息落库前生效（ST 管线同样保存变换后文本）。
      mes: applyRegexScripts(text, scripts, RegexPlacement.USER_INPUT),
      extra: projectionExtra(session, event, binding.contextMode, turnAt(session, event.seq)),
    }
  }

  if (event.type !== 'assistant/message') return undefined
  // 从 Tavern 聊天导入的镜像消息（开场白/历史）不再投影回 JSONL，否则会重复。
  if (isTavernMirrorSource(event.data?.message?.source)) return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content) || content.some((block) => block?.type === 'tool-call')) return undefined
  const text = messageText(content)
  if (text === '') return undefined
  // 落库层只应用非 promptOnly、非 markdownOnly 的脚本；display 与 prompt 层
  // 分别由 displayTexts 和历史导入处理。
  const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
  return {
    name: binding.character,
    is_user: false,
    is_system: false,
    send_date: eventDate(event.time),
    mes: saveScripts.length > 0 ? applyRegexScripts(text, saveScripts, RegexPlacement.AI_OUTPUT) : text,
    extra: projectionExtra(session, event, binding.contextMode, event.data?.turn, event.data?.step),
  }
}

function projectionExtra(
  session: NativeSession,
  event: NativeSessionEvent,
  contextMode: string,
  turn?: number,
  step?: number,
): Record<string, unknown> {
  return {
    agentTavern: {
      architecture: 'agent-tavern',
      contextMode,
      sessionId: session.id,
      eventSeq: event.seq,
      messageId: event.type === 'assistant/message' ? event.data?.message?.id : event.data?.id,
      ...(Number.isSafeInteger(turn) ? { turn } : {}),
      ...(Number.isSafeInteger(step) ? { step } : {}),
    },
  }
}

function projectionIdentity(message: ChatMessage, sessionId: string, eventSeq: number): boolean {
  const source = message.extra?.agentTavern as Record<string, unknown> | undefined
  return source?.sessionId === sessionId && source.eventSeq === eventSeq
}

function isTavernMirrorSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as Record<string, unknown>
  if (record.plugin !== 'dsh-tavern') return false
  return record.kind === 'plugin' || record.kind === 'model'
}

/** 宿主会话要求 assistant 消息的 source 必须是 model 来源且带 provider/model； */
/** 导入的镜像消息用合成 provider/model 补足校验，plugin/form 标记保留镜像语义。 */
const TAVERN_MIRROR_MODEL_SOURCE = { provider: 'dsh-tavern', model: 'agent-tavern-import' } as const

/**
 * 把聊天里尚未出现在原生会话中的消息（开场白、ST 时代的记录或其他会话投影的
 * 记录）转成宿主 Session.append 计划：每条用户消息开启一个新 turn，角色消息
 * 作为 turn 内的 step。角色消息的 source 是带 dsh-tavern 标记的 model 来源
 * （宿主强制 assistant 消息用 model 来源，见 TAVERN_MIRROR_MODEL_SOURCE），
 * 投影器凭 plugin 标记跳过它们，因此导入不会把消息重复写回 JSONL；不带
 * usage，也不会被统计成一次模型生成。
 *
 * scripts 提供 prompt 层正则（promptOnly AI_OUTPUT，与 ST 管线的 promptOnly
 * 历史变换一致，按消息深度过滤），使 AgentTavern 模型上下文看到与 ST 相同的
 * 变换后历史；落库文本保持不变。expand 提供 ST substituteParams 语义的宏展开
 * （{{char}}/{{user}} 等），同样只作用于模型上下文。
 */
export function historyImportAppends(
  chat: ChatLogIR,
  sessionId: string,
  scripts: RegexScriptIR[] = [],
  expand?: (text: string) => string,
): SessionImportAppend[] {
  const promptScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const promptView = (message: ChatMessage, index: number): string => {
    const transformed = promptScripts.length === 0
      ? message.mes
      : applyRegexScripts(message.mes, promptScripts, RegexPlacement.AI_OUTPUT, {}, { depth: chat.messages.length - 1 - index })
    return expand ? expand(transformed) : transformed
  }

  const appends: SessionImportAppend[] = []
  let turn = 0
  let step = 0
  let turnOpen = false

  const openTurn = () => {
    turn += 1
    step = 0
    turnOpen = true
    appends.push({ type: 'turn/start', data: { turn } })
  }
  const closeTurn = () => {
    if (!turnOpen) return
    turnOpen = false
    appends.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }

  for (const [index, message] of chat.messages.entries()) {
    if (message.is_system === true || typeof message.mes !== 'string' || message.mes.trim() === '') continue
    const origin = message.extra?.agentTavern as Record<string, unknown> | undefined
    if (origin?.sessionId === sessionId) continue
    if (message.is_user === true) {
      closeTurn()
      openTurn()
      appends.push({
        type: 'user/message',
        data: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: promptView(message, index) }],
          source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' },
        },
        surfaceOp: 'append',
      })
      continue
    }
    if (!turnOpen) openTurn()
    step += 1
    appends.push(
      { type: 'step/start', data: { turn, step } },
      {
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: promptView(message, index) }],
            // 宿主在会话加载时校验 assistant 消息必须是 model 来源；纯 plugin
            // 来源会把整个会话变成 SessionPersistenceCorruptionError 拒载。
            source: {
              kind: 'model',
              ...TAVERN_MIRROR_MODEL_SOURCE,
              plugin: 'dsh-tavern',
              form: turn === 1 && step === 1 ? 'greeting' : 'history',
            },
          },
        },
        surfaceOp: 'append',
      },
      { type: 'step/end', data: { turn, step } },
    )
  }
  closeTurn()
  return appends
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

function turnAt(session: NativeSession, cursor: number): number | undefined {
  let turn: number | undefined
  for (const event of session.events) {
    if (event.seq > cursor) break
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
  }
  return turn
}

function eventDate(time: number): string {
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
}

function validateCheckpoint(value: ProjectionCheckpoint, sessionId: string): void {
  if (value.version !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.lastCursor)
    || !['ok', 'pending'].includes(value.status)) {
    throw new Error(`invalid AgentTavern projection checkpoint for '${sessionId}'`)
  }
}
