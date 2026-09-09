import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatRevisionConflictError, type TavernSessionBinding, type TavernState } from '../../../tavern-store/src/index.js'
import { RegexPlacement, type CharacterCardIR, type ChatLogIR, type ChatMessage, type RegexScriptIR } from '../../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../../tavern-script/src/index.js'
import { sessionEvents } from '../../../bind/src/index.js'
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
  /** 投影器规范化视图；宿主原生会话（rc.6 events / 0.1.2 snapshotEvents）经
   * host-session 兼容层读取，不要求本形状完整。 */
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
    const events = [...sessionEvents(session) as readonly NativeSessionEvent[]].sort((left, right) => left.seq - right.seq)
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
 * Import saved messages as session-level surface events without creating loop
 * boundaries. The native AgentLoop then owns the first live turn and starts it
 * at one. Model sources satisfy host validation; plugin markers prevent
 * projection back into the saved chat. Prompt-only regex and macros never
 * alter stored text.
 *
 * Imported assistant messages carry explicit `turn: 0` and per-import step
 * numbers: the client conversation assembler publishes assistant messages at
 * `{ turn, step }` coordinates read straight off the event payload, and a
 * message without them dies with "published invalid turn undefined", which
 * kills the whole event-feed subscriber and renders the chat empty. Turn
 * containers are created implicitly from payload coordinates, so no
 * turn/start|end events are needed and the host blank criterion (a logged
 * turn/start) stays false. Turn 0 keeps imports below the live loop's first
 * turn (its lastTurn defaults to 0, so live turn 1 never collides).
 */
export function historyImportAppends(
  chat: ChatLogIR,
  sessionId: string,
  scripts: RegexScriptIR[],
  expand: ((text: string) => string) | undefined,
): SessionImportAppend[] {
  const promptScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const promptView = (message: ChatMessage, index: number): string => {
    const transformed = promptScripts.length === 0
      ? message.mes
      : applyRegexScripts(message.mes, promptScripts, RegexPlacement.AI_OUTPUT, {}, { depth: chat.messages.length - 1 - index })
    return expand ? expand(transformed) : transformed
  }

  const appends: SessionImportAppend[] = []
  let assistantCount = 0

  for (const [index, message] of chat.messages.entries()) {
    if (message.is_system === true || typeof message.mes !== 'string' || message.mes.trim() === '') continue
    const origin = message.extra?.agentTavern as Record<string, unknown> | undefined
    if (origin?.sessionId === sessionId) continue
    if (message.is_user === true) {
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
    assistantCount += 1
    appends.push({
      type: 'assistant/message',
      data: {
        turn: 0,
        step: assistantCount,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: promptView(message, index) }],
          // The host rejects assistant messages without a model source.
          source: {
            kind: 'model',
            ...TAVERN_MIRROR_MODEL_SOURCE,
            plugin: 'dsh-tavern',
            form: assistantCount === 1 ? 'greeting' : 'history',
          },
        },
      },
      surfaceOp: 'append',
    })
  }
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
  for (const event of sessionEvents(session) as readonly NativeSessionEvent[]) {
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
