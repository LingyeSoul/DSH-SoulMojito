import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatRevisionConflictError, type TavernSessionBinding } from '../../../tavern-store/src/index.js'
import type { ChatLogIR, ChatMessage } from '../../../tavern-format/src/index.js'

export interface NativeSessionEvent {
  type: string
  seq: number
  time: number
  data: any
}

export interface NativeSession {
  id: string
  events: readonly NativeSessionEvent[]
}

export interface ProjectorStore {
  getState(): Promise<{ sessionBindings: Record<string, TavernSessionBinding> }>
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
        const message = projectMessage(session, event, binding)
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
      mes: text,
      extra: projectionExtra(session, event, binding.contextMode, turnAt(session, event.seq)),
    }
  }

  if (event.type !== 'assistant/message') return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content) || content.some((block) => block?.type === 'tool-call')) return undefined
  const text = messageText(content)
  if (text === '') return undefined
  return {
    name: binding.character,
    is_user: false,
    is_system: false,
    send_date: eventDate(event.time),
    mes: text,
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
