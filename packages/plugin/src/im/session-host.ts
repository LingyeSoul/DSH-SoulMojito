/**
 * IM 会话托管（提案 0024 §3.3）。
 *
 * 这是本插件第一次**主动创建宿主 Agent**：此前所有会话都由客户端或宿主创建，
 * 插件只做观察（`games/wake.ts` 也只 followup 已有 agent）。因此这里把每个
 * 宿主 seam 都做成显式依赖并在入口探测，缺能力时 fail-closed，绝不静默退回
 * 一个「能聊天但没有 AgentTavern」的假会话。
 *
 * 本模块只认 chat/session，不认识任何 IM 协议——协议层调它，它不知道 QQ 存在。
 */

import { randomUUID } from 'node:crypto'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { seedJsrMvuVariables } from '../agent-tavern/mvu-compat.js'

/** 宿主 `ctx.agents` 的最小面（0.2.x 形状；缺失时 IM 整体不可用）。 */
export interface ImAgentsSeam {
  get?(sessionId: string): unknown
  resume?(options: Record<string, unknown>): Promise<{ agent: unknown }>
  create?(options: Record<string, unknown>): Promise<{ agent: unknown }>
}

/** 宿主 `ctx.agentPresets` 的最小面：AgentTavern 的 preset 必须能挂。 */
export interface ImPresetsSeam {
  mount?(agentContext: unknown, presetId: string): Promise<unknown>
}

export interface ImSessionCapabilities {
  available: boolean
  reasons: string[]
}

export class ImSessionError extends Error {
  readonly code:
    | 'IM_SESSION_UNAVAILABLE'
    | 'IM_CHAT_MISSING'
    | 'IM_SOURCE_MISSING'
    | 'IM_PEER_UNBOUND'
  constructor(code: ImSessionError['code'], message: string) {
    super(message)
    this.name = 'ImSessionError'
    this.code = code
  }
}

export interface ImChatRefLike {
  character: string
  chatId: string
}

export interface ImSessionDeps {
  db: TavernStore
  agents: ImAgentsSeam | undefined
  presets: ImPresetsSeam | undefined
  /** AgentTavern preset id（`AGENT_TAVERN_PRESET_ID`）。 */
  presetId: string
  /** 声明 preset；已声明时幂等。 */
  ensurePreset: () => Promise<void>
  /** Agent 工作目录；复用插件的内部工作区。 */
  workspace: () => Promise<string>
  /** 写 sessionBindings（`session/binding.ts` 的 bindSession）。 */
  bind: (sessionId: string, character: string, chatId: string) => Promise<unknown>
  /** 写穿 AgentTavern 预设投影（`agent-tavern/preset.ts`）。 */
  presetChanged: () => Promise<void>
  logger?: { warn?: (message: string) => void }
}

export interface EnsureImSessionRequest {
  mode: 'independent' | 'shared'
  peerKey: string
  sourceChat?: ImChatRefLike
  sharedChat?: ImChatRefLike
  /** 共享模式已有绑定时的会话 id；缺省则铸造。 */
  existingSessionId?: string
}

export interface EnsureImSessionResult {
  sessionId: string
  character: string
  chatId: string
}

/**
 * 能力探测：`create` 与 `resume` 至少有一个，且 preset 能挂。缺任何一项，
 * IM 不注册任何通道——半开的通道比关着的通道更难诊断。
 */
export function inspectImSessionCapabilities(
  agents: ImAgentsSeam | undefined,
  presets: ImPresetsSeam | undefined,
): ImSessionCapabilities {
  const reasons: string[] = []
  if (agents === undefined) {
    reasons.push('the host exposes no agents service')
  } else if (typeof agents.create !== 'function' && typeof agents.resume !== 'function') {
    reasons.push('the host agents service exposes neither create nor resume')
  }
  if (presets === undefined || typeof presets.mount !== 'function') {
    reasons.push('the host cannot mount an agent preset (agentPresets.mount is missing)')
  }
  return { available: reasons.length === 0, reasons }
}

/** 铸造会话 id：带 `session-` 前缀对齐宿主约定，裸 UUID 会被当成子代理会话。 */
export function mintImSessionId(): string {
  return `session-${randomUUID()}`
}

/**
 * 保证该 peer 有一个可投递的 AgentTavern 会话。
 *
 * 顺序固定：先建/取聊天 → 再拿 live agent → resume/create → 落 binding → 写穿
 * 预设投影。binding 必须在首轮之前落盘：工具面、锚定与投影器都按 binding 反查。
 */
export async function ensureImSession(
  deps: ImSessionDeps,
  request: EnsureImSessionRequest,
): Promise<EnsureImSessionResult> {
  const capability = inspectImSessionCapabilities(deps.agents, deps.presets)
  if (!capability.available) {
    throw new ImSessionError('IM_SESSION_UNAVAILABLE', `IM sessions are unavailable: ${capability.reasons.join('; ')}`)
  }
  const chat = request.mode === 'shared' ? request.sharedChat : request.sourceChat
  if (chat === undefined) {
    throw new ImSessionError('IM_SOURCE_MISSING', request.mode === 'shared'
      ? 'shared mode requires the configured shared chat'
      : 'independent mode requires the configured source chat')
  }
  if (request.mode === 'shared') {
    return bindImChat(deps, chat, request.existingSessionId)
  }
  const chatId = await createChatFromSource(deps, chat)
  const sessionId = request.existingSessionId ?? mintImSessionId()
  await ensureImAgent(deps, sessionId)
  await deps.bind(sessionId, chat.character, chatId)
  await deps.presetChanged()
  return { sessionId, character: chat.character, chatId }
}

/**
 * 手动绑定 / 共享模式的入口：聊天必须已经存在，只负责补会话与绑定。
 * 已有会话 id 时沿用它（共享模式多个 peer 同一个会话）。
 */
export async function bindImChat(
  deps: ImSessionDeps,
  chat: ImChatRefLike,
  existingSessionId: string | undefined,
): Promise<EnsureImSessionResult> {
  const capability = inspectImSessionCapabilities(deps.agents, deps.presets)
  if (!capability.available) {
    throw new ImSessionError('IM_SESSION_UNAVAILABLE', `IM sessions are unavailable: ${capability.reasons.join('; ')}`)
  }
  const chatId = await requireExistingChat(deps, chat)
  const sessionId = existingSessionId ?? mintImSessionId()
  await ensureImAgent(deps, sessionId)
  await deps.bind(sessionId, chat.character, chatId)
  await deps.presetChanged()
  return { sessionId, character: chat.character, chatId }
}

/** 共享模式先确认聊天还在：源聊天被删时宁可报错，也不要凭空造一个新的。 */
async function requireExistingChat(deps: ImSessionDeps, chat: ImChatRefLike): Promise<string> {
  const snapshot = await deps.db.getChatSnapshot(chat.character, chat.chatId)
  if (snapshot === undefined) {
    throw new ImSessionError('IM_CHAT_MISSING', `shared chat ${chat.character}/${chat.chatId} no longer exists`)
  }
  return chat.chatId
}

/**
 * 独立模式：按来源聊天的角色新建一个空聊天。
 *
 * v1 只带角色与开场白（首个 greeting），不复制来源聊天的历史、变量与正则覆盖
 * 层——IM 新会话应当是干净的。MVU 卡的初始变量仍按既有约定播种，否则第一轮
 * 结算就没有 stat_data 可写。
 */
async function createChatFromSource(deps: ImSessionDeps, source: ImChatRefLike): Promise<string> {
  const found = await deps.db.getCharacter(source.character)
  if (found === undefined) {
    throw new ImSessionError('IM_SOURCE_MISSING', `source character ${source.character} no longer exists`)
  }
  const now = new Date().toISOString()
  const card = found.card
  const seedVariables: Record<string, unknown> | undefined = (() => {
    const holder = card.data.extensions?.['agentTavern']
    if (typeof holder !== 'object' || holder === null) return undefined
    const initial = (holder as Record<string, unknown>)['initialVariables']
    if (typeof initial !== 'object' || initial === null || Array.isArray(initial)) return undefined
    const entries = Object.entries(initial as Record<string, unknown>)
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
  })()
  const variablesSeed: Record<string, unknown> = seedVariables ?? {}
  const mvuSeeded = seedJsrMvuVariables(card, { ...variablesSeed })
  const greetings = [card.data.firstMes, ...card.data.alternateGreetings]
  const chatId = await deps.db.createChat(source.character, {
    user_name: 'unused',
    character_name: 'unused',
    chat_metadata: {
      character: source.character,
      createdAt: now,
      timedWorldInfo: {},
      ...(seedVariables !== undefined || mvuSeeded ? { variables: variablesSeed } : {}),
    },
  }, [{
    name: card.data.nickname || card.data.name,
    is_user: false,
    is_system: false,
    send_date: now,
    mes: greetings[0] ?? '',
  }])
  return chatId
}

/**
 * 拿 live agent：先复用 → 再 resume → 最后 create。
 *
 * resume 对「从未存在过的会话」必然失败，这里把失败降级为 create；但会记一条
 * 带错误码的 warning——真正的 resume 故障（会话文件损坏）不能被静默吞掉。
 */
export async function ensureImAgent(deps: ImSessionDeps, sessionId: string): Promise<unknown> {
  const live = deps.agents?.get?.(sessionId)
  if (live !== undefined && live !== null) return live
  const presets = deps.presets
  if (presets === undefined || typeof presets.mount !== 'function') {
    throw new ImSessionError('IM_SESSION_UNAVAILABLE', 'the host cannot mount an agent preset')
  }
  await deps.ensurePreset()
  const workspace = await deps.workspace()
  const setup = async (agentContext: unknown): Promise<void> => {
    await presets.mount?.(agentContext, deps.presetId)
  }
  if (typeof deps.agents?.resume === 'function') {
    try {
      const resumed = await deps.agents.resume({ resumeSessionId: sessionId, setup })
      return resumed.agent
    } catch (error) {
      deps.logger?.warn?.(`dsh-soulmojito im: resume ${sessionId} failed, creating a new session: ${messageOf(error)}`)
    }
  }
  if (typeof deps.agents?.create !== 'function') {
    throw new ImSessionError('IM_SESSION_UNAVAILABLE', 'the host agents service exposes neither create nor resume')
  }
  const created = await deps.agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: deps.presetId },
    setup,
  })
  return created.agent
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 仅供路由使用：绑定缺失时的统一错误文案。 */
export function imUnboundMessage(peerKey: string): string {
  return `这个会话还没有绑定：${peerKey}。请在 DSH-SoulMojito 面板的「聊天渠道」里绑定一个聊天。`
}
