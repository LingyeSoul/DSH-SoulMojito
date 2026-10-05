import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatRevisionConflictError, type TavernSessionBinding, type TavernState } from '../../../tavern-store/src/index.js'
import { RegexPlacement, type CharacterCardIR, type ChatLogIR, type ChatMessage, type RegexScriptIR } from '../../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../../tavern-script/src/index.js'
import { hostPluginMessageSource, hostSessionFormatVersion, isHostPluginMessageSource, sessionEvents, type HostSessionLog } from '../../../bind/src/index.js'
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

/**
 * 会话事件是否带 dsh-tavern 写入标记（导入镜像、锚定提醒、插件通知）。
 * 预加载通知（summary 以 "AgentTavern preload: " 开头）除外：它不构成
 * "会话已启动"，客户端修复路径的重复激活不能被它锁死。model 镜像靠合成
 * provider/model 对识别——released v0 Session disposition 禁止 model
 * source 携带 plugin/form 等额外成员。
 */
export function isTavernSessionMarker(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as Record<string, unknown>
  if (record.kind === 'model') return record.provider === 'dsh-tavern' && record.model === 'agent-tavern-import'
  if (!isHostPluginMessageSource(record)) return false
  return !(typeof record.summary === 'string' && record.summary.startsWith('AgentTavern preload: '))
}

function isTavernMirrorSource(source: unknown): boolean {
  return isTavernSessionMarker(source)
}

/** 宿主会话要求 assistant 消息的 source 必须是 model 来源且带 provider/model； */
/** 导入的镜像消息用合成 provider/model 补足校验，合成 provider/model 对即镜像标记。 */
const TAVERN_MIRROR_MODEL_SOURCE = { provider: 'dsh-tavern', model: 'agent-tavern-import' } as const

/**
 * Import saved messages as real turn boundaries. The native AgentLoop then
 * continues ABOVE the imported turns; the caller must advance the live loop's
 * turn base (see `advanceHostTurnBase`) or the loop's first live turn repeats
 * an imported turn number and the session stops being readable.
 *
 * Host admission (DSH `0.2.0-rc.2`, session format v4) requires every
 * `assistant/message` to sit inside an OPEN turn and step whose numbers equal
 * its payload coordinates:
 *
 * - `assistant/message` with neither an open turn nor an open step dies with
 *   `SessionFormatError: assistant/message does not match an open turn and step`,
 *   which marks the WHOLE persisted session corrupt — creation fails, history
 *   stops loading, and later session operations fail with it.
 * - Bare payload coordinates cannot repair that: turn numbers must be dense and
 *   start at 1 (`nextTurn` starts at 1), so `turn: 0` can never be opened by any
 *   `turn/start` (`turn/start does not open the expected turn`).
 * - Dropping the coordinates instead (0.3.1 shape) breaks the client fold with
 *   `published invalid turn undefined`, which empties the conversation.
 *
 * So the import mirrors a real conversation: each user message opens a turn,
 * every assistant message is one step inside the current turn, and every turn
 * closes with `reason: { kind: 'completed' }` like the loop's own zero-message
 * turns. Model sources satisfy host validation; plugin markers (shape branched
 * by session format version, see hostPluginMessageSource) prevent projection
 * back into the saved chat. Prompt-only regex and macros never alter stored
 * text.
 */
export function historyImportAppends(
  chat: ChatLogIR,
  sessionId: string,
  scripts: RegexScriptIR[],
  expand: ((text: string) => string) | undefined,
  session?: HostSessionLog,
): SessionImportAppend[] {
  const promptScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const promptView = (message: ChatMessage, index: number): string => {
    const transformed = promptScripts.length === 0
      ? message.mes
      : applyRegexScripts(message.mes, promptScripts, RegexPlacement.AI_OUTPUT, {}, { depth: chat.messages.length - 1 - index })
    return expand ? expand(transformed) : transformed
  }

  const appends: SessionImportAppend[] = []
  // v4 宿主（rc.2 起）的 assistant 结算契约是「`usage` 或 `stream` 至少一个」：
  // token-meter 的 usageOf() 在两者都缺失时把 undefined 交给
  // lastAssistantStreamChunk()，后者读 `stream.length` 抛 TypeError，投影单元
  // 无法物化，该会话的 stateOf()/snapshot() 全部失败——原生「新建会话」复用该
  // 会话时直接报 gateway/internal: Cannot read properties of undefined
  // (reading 'length')。导入消息没有流式记录，写空数组是诚实的（不产生 usage、
  // 投影不变）。v0-v3 宿主把流式记录放在独立的 assistant/chunk 事件里，写入
  // v4 专属成员会毒化老工件，因此按版本分支。
  const settlement = (hostSessionFormatVersion(session) ?? 0) >= 4 ? { stream: [] } : {}
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
      // 一个用户消息开启一个 turn（与 live loop 的真实语义一致）。
      closeTurn()
      openTurn()
      appends.push({
        type: 'user/message',
        data: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: promptView(message, index) }],
          source: hostPluginMessageSource(session),
        },
        surfaceOp: 'append',
      })
      continue
    }
    if (!turnOpen) openTurn()
    step += 1
    // step/start 与 step/end 必须包住 assistant/message：v4 准入要求
    // assistant/message 的 turn/step 与当前打开的 step 完全一致。
    appends.push({ type: 'step/start', data: { turn, step } })
    appends.push({
      type: 'assistant/message',
      data: {
        turn,
        step,
        ...settlement,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: promptView(message, index) }],
          // The host rejects assistant messages without a model source; the
          // synthetic provider/model pair doubles as the mirror marker because
          // released v0 dispositions admit no extra members on model sources.
          source: {
            kind: 'model',
            ...TAVERN_MIRROR_MODEL_SOURCE,
          },
        },
      },
      surfaceOp: 'append',
    })
    appends.push({ type: 'step/end', data: { turn, step } })
  }
  closeTurn()
  return appends
}

/**
 * 导入计划写入的最后一个 turn 号；没有 turn 边界时返回 undefined。
 * 调用方用它推进 live loop 的轮次基线。
 */
export function lastImportedTurn(appends: readonly SessionImportAppend[]): number | undefined {
  let last: number | undefined
  for (const append of appends) {
    const value = append.data?.turn
    if (append.type === 'turn/start' && Number.isSafeInteger(value) && (last === undefined || (value as number) > last)) {
      last = value as number
    }
  }
  return last
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
