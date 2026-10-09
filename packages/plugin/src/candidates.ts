/**
 * 行动候选生成（提案 0010，Turn Candidates 功能复刻）。
 *
 * 候选生成与正文生成解耦：一个独立轻量请求，基于近期历史 + 角色卡摘要 +
 * Guides + 可选反馈，产出 3–6 个「人物行动 / 场景变化」候选。候选是
 * 建议非指令——本模块只生成与存储，不存在自动执行路径（面板语义是
 * 「填入输入框」，用户可修改后发送）。
 *
 * Guides 读取遵循提案 0009 的存储形状
 * `chat.header.chat_metadata.guides: Array<{id,text,createdAt}>`；注入块首行
 * 标注复用 guides.ts 的 GUIDES_BLOCK_HEADER 常量防漂移（决策
 * 2026-10-09-dedup-refactor），但排序与形状容错在本模块内自带：CandidateGuide
 * 的 createdAt 可选，guides.ts 的 normalizeGuides 会丢弃无 createdAt 的条目，
 * 行为差异刻意保留。
 */

import { ChatRevisionConflictError, type ChatSnapshot, type TavernModelSelection } from '../../tavern-store/src/index.js'
import type { ChatLogIR } from '../../tavern-format/src/index.js'
import { GUIDES_BLOCK_HEADER } from './guides.js'
import { optionalFeedback } from './rewrite.js'

const CANDIDATE_HISTORY_WINDOW = 10
const CANDIDATE_MAX_COUNT = 6
const CANDIDATE_MAX_TEXT_LENGTH = 200
/** 角色卡 description 节选上限：候选请求是轻量请求，不整卡搬运。 */
const CANDIDATE_CARD_EXCERPT = 1500
const DEFAULT_USER = 'User'

export type CandidateKind = 'action' | 'scene'

export interface CandidateItem {
  kind: CandidateKind
  text: string
}

/** 随聊天持久化的候选载荷：面板渲染「当前候选 + 上次按什么意见生成」。 */
export interface StoredCandidates {
  items: CandidateItem[]
  generatedAt: string
  feedback?: string
}

/** 提案 0009 的 guide 存储形状（只读消费，不负责增删校验）。 */
export interface CandidateGuide {
  id: string
  text: string
  createdAt?: string
}

export interface CandidateCharacterSummary {
  name: string
  description?: string
  personality?: string
  scenario?: string
}

export interface CandidateHistoryMessage {
  name: string
  isUser: boolean
  text: string
}

export interface BuildCandidateRequestInput {
  character: CandidateCharacterSummary
  userName: string
  /** 聊天楼层（本函数自行取最近 10 条非系统层）。 */
  history: CandidateHistoryMessage[]
  guides?: CandidateGuide[]
  /** 带意见重新生成：用户对上一轮候选的修订意见。 */
  feedback?: string
  /** 上一轮候选（带意见重新生成时据此修订）。 */
  previousCandidates?: CandidateItem[]
}

export interface CandidateRequest {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

function excerpt(text: string | undefined, max: number): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** Guides 注入块：与提案 0009 的正文注入同格式（首行标注 + 每条一行，创建时间升序）。 */
function formatGuidesBlock(guides: CandidateGuide[]): string | undefined {
  if (guides.length === 0) return undefined
  const lines = guides
    .slice()
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .map((guide) => `- ${guide.text}`)
  return [GUIDES_BLOCK_HEADER, ...lines].join('\n')
}

/**
 * 候选请求构造（纯函数）。system 是候选生成器指令：产出 3–6 个候选、
 * 严格 JSON 数组 [{kind:'action'|'scene', text}]、每项 ≤200 字符、基于
 * 历史与角色、只提议不推进剧情。feedback 时携带上一轮候选并要求据此修订。
 */
export function buildCandidateRequest(input: BuildCandidateRequestInput): CandidateRequest {
  const systemParts: string[] = [
    [
      'You propose candidate inputs for an ongoing roleplay chat.',
      'Based on the character, the user persona, the recent chat history and any conversation guides, propose 3 to 6 candidates for what the user could send next.',
      'Rules:',
      `- Each candidate is at most ${CANDIDATE_MAX_TEXT_LENGTH} characters and is written as the user's next message.`,
      '- kind "action" proposes something the user\'s character does or says; kind "scene" proposes a scene change or a narrative shift.',
      '- Ground every candidate in the provided history and character; do not advance the plot yourself and do not narrate outcomes — only propose.',
      '- Reply with ONLY a strict JSON array of objects, e.g. [{"kind":"action","text":"..."},{"kind":"scene","text":"..."}]. No prose, no code fences.',
    ].join('\n'),
  ]

  const card: string[] = [`Character: ${input.character.name}`]
  const description = excerpt(input.character.description, CANDIDATE_CARD_EXCERPT)
  if (description !== undefined) card.push(`Description: ${description}`)
  const personality = excerpt(input.character.personality, CANDIDATE_CARD_EXCERPT)
  if (personality !== undefined) card.push(`Personality: ${personality}`)
  const scenario = excerpt(input.character.scenario, CANDIDATE_CARD_EXCERPT)
  if (scenario !== undefined) card.push(`Scenario: ${scenario}`)
  card.push(`User persona name: ${input.userName}`)
  systemParts.push(card.join('\n'))

  const guidesBlock = formatGuidesBlock(input.guides ?? [])
  if (guidesBlock !== undefined) systemParts.push(guidesBlock)

  if (input.feedback !== undefined) {
    const revision: string[] = []
    if (input.previousCandidates !== undefined && input.previousCandidates.length > 0) {
      revision.push('Previous candidates (the user reviewed them and asked for a revision):')
      for (const item of input.previousCandidates) {
        revision.push(`- [${item.kind}] ${item.text}`)
      }
    }
    revision.push(`User feedback on the candidates: ${input.feedback}`)
    revision.push('Revise the candidates according to the feedback: keep what the feedback does not object to, and replace or adjust what it asks to change. Follow the same output rules.')
    systemParts.push(revision.join('\n'))
  }

  const history = input.history.slice(-CANDIDATE_HISTORY_WINDOW)
  const messages: CandidateRequest['messages'] = history.map((m) => ({
    role: m.isUser ? 'user' : 'assistant',
    content: `[${m.name}] ${m.text}`,
  }))
  messages.push({
    role: 'user',
    content: input.feedback !== undefined
      ? 'Propose 3 to 6 candidate inputs for the user\'s next message, revising the previous candidates according to the user feedback. Reply with ONLY the JSON array.'
      : 'Propose 3 to 6 candidate inputs for the user\'s next message. Reply with ONLY the JSON array.',
  })

  return { system: systemParts.join('\n\n'), messages }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 提取首个平衡的 JSON 数组（容忍代码围栏与前后杂质）。 */
function extractFirstJsonArray(text: string): unknown[] {
  const trimmed = text.trim()
  const direct = tryParseJson(trimmed)
  if (Array.isArray(direct)) return direct
  const start = trimmed.indexOf('[')
  if (start === -1) throw new Error('candidate output contains no JSON array')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escaped) { escaped = false; continue }
    if (inString && ch === '\\') { escaped = true; continue }
    if (ch === '"') inString = !inString
    else if (!inString && ch === '[') depth++
    else if (!inString && ch === ']') {
      depth--
      if (depth === 0) {
        const parsed = tryParseJson(trimmed.slice(start, i + 1))
        if (parsed === undefined) throw new Error('candidate output is not valid JSON')
        if (!Array.isArray(parsed)) throw new Error('candidate output is not a JSON array')
        return parsed
      }
    }
  }
  throw new Error('candidate output contains no JSON array')
}

function normalizeCandidateText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, CANDIDATE_MAX_TEXT_LENGTH) : ''
}

/**
 * 候选解析（容错）：提取首个 JSON 数组；字符串项兜底 kind:'action'；
 * 对象项取 kind/text 并 clamp（kind 非 scene/action 兜底 action，缺文本丢弃）；
 * 超过 6 个截断；0 个有效项抛错（让用户重试，不落聊天）。
 */
export function parseCandidates(text: string): CandidateItem[] {
  const raw = extractFirstJsonArray(text)
  const items: CandidateItem[] = []
  for (const entry of raw) {
    if (items.length >= CANDIDATE_MAX_COUNT) break
    if (typeof entry === 'string') {
      const candidate = normalizeCandidateText(entry)
      if (candidate !== '') items.push({ kind: 'action', text: candidate })
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const candidate = normalizeCandidateText(record.text)
    if (candidate === '') continue
    items.push({ kind: record.kind === 'scene' ? 'scene' : 'action', text: candidate })
  }
  if (items.length === 0) throw new Error('candidate output contained no usable candidates')
  return items
}

/** 读 `chat.header.chat_metadata.candidates`；形状不合（旧聊天/被污染）返回 undefined。 */
export function readStoredCandidates(chat: ChatLogIR): StoredCandidates | undefined {
  const raw = chat?.header?.chat_metadata?.candidates
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.items)) return undefined
  const items: CandidateItem[] = []
  for (const entry of record.items) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = normalizeCandidateText((entry as Record<string, unknown>).text)
    if (candidate === '') continue
    items.push({
      kind: (entry as Record<string, unknown>).kind === 'scene' ? 'scene' : 'action',
      text: candidate,
    })
  }
  if (items.length === 0) return undefined
  return {
    items,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    ...(typeof record.feedback === 'string' && record.feedback !== '' ? { feedback: record.feedback } : {}),
  }
}

/** 写 `chat.header.chat_metadata.candidates`（调用方负责 saveChat 持久化）。 */
export function writeStoredCandidates(chat: ChatLogIR, payload: StoredCandidates): void {
  chat.header.chat_metadata.candidates = {
    items: payload.items,
    generatedAt: payload.generatedAt,
    ...(payload.feedback !== undefined && payload.feedback !== '' ? { feedback: payload.feedback } : {}),
  }
}

/** 提案 0009 形状的 guides 读取：无效条目跳过，非数组视为无 guides。 */
function readGuides(chat: ChatLogIR): CandidateGuide[] {
  const raw = chat?.header?.chat_metadata?.guides
  if (!Array.isArray(raw)) return []
  const guides: CandidateGuide[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.text !== 'string' || record.text.trim() === '') continue
    guides.push({
      id: typeof record.id === 'string' ? record.id : '',
      text: record.text,
      ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    })
  }
  return guides
}

interface CandidateDb {
  getCharacter(name: string): Promise<{
    card: { data: { name?: string; description?: string; personality?: string; scenario?: string } }
  } | undefined>
  saveChat(characterName: string, chatId: string, log: ChatLogIR, expectedRevision?: string): Promise<string>
}

type CandidateStreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind: string; failure?: { message?: string } } }

interface CandidateContext {
  llm: { stream: (request: unknown) => AsyncIterable<CandidateStreamChunk> }
  agentDefaultModel: { currentSelection(): TavernModelSelection }
}

export interface CandidateGenerationOptions {
  state: {
    activePersona?: string
    sessionBindings?: Record<string, { architecture?: string }>
    modelSelections?: Record<string, TavernModelSelection>
  }
  characterName: string
  chatId: string
  snapshot: ChatSnapshot
  /** CAS 期望 revision（与 generate 同语义：不等于 snapshot.revision 即 409）。 */
  revision: string
  /** 带意见重新生成（空串等价无意见）。 */
  feedback?: string
  sessionId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  signal?: AbortSignal
}

export interface CandidateGenerationResult {
  items: CandidateItem[]
  generatedAt: string
  revision: string
}

/** AgentTavern 绑定不暴露候选入口（提案 0009/0004 红线）；路由层另做同款前置检查。 */
function assertStCandidateBinding(state: CandidateGenerationOptions['state'], sessionId: string | undefined): void {
  if (typeof sessionId !== 'string') return
  if (state.sessionBindings?.[sessionId]?.architecture === 'agent-tavern') {
    throw new Error('AgentTavern sessions use the DSH native AgentLoop; candidates are unavailable.')
  }
}

/**
 * 候选请求执行：校验绑定与 revision CAS → 构建请求 → ctx.llm.stream 非流式
 * 收集（模型选择与 runGeneration 同推导：explicit ?? saved ?? fallback）→
 * 解析 → 写 chat_metadata.candidates → saveChat → 返回候选与新 revision。
 * 任何失败（流错误/空输出/解析失败）都不触碰聊天持久化（revision 不动）。
 */
export async function runCandidateGeneration(
  ctx: CandidateContext,
  db: CandidateDb,
  options: CandidateGenerationOptions,
): Promise<CandidateGenerationResult> {
  const { state, characterName, chatId, snapshot } = options
  assertStCandidateBinding(state, options.sessionId)
  if (options.revision !== snapshot.revision) {
    throw new ChatRevisionConflictError(options.revision, snapshot.revision)
  }
  const chat = snapshot.chat
  const character = await db.getCharacter(characterName)
  if (!character) throw new Error(`character '${characterName}' not found`)
  const feedback = optionalFeedback(options.feedback)
  const previous = feedback !== undefined ? readStoredCandidates(chat) : undefined

  const request = buildCandidateRequest({
    character: {
      name: character.card.data.name || characterName,
      description: character.card.data.description,
      personality: character.card.data.personality,
      scenario: character.card.data.scenario,
    },
    userName: state.activePersona ?? DEFAULT_USER,
    history: chat.messages
      .filter((m) => !m.is_system)
      .map((m) => ({ name: m.name, isUser: m.is_user, text: m.mes })),
    guides: readGuides(chat),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(previous !== undefined ? { previousCandidates: previous.items } : {}),
  })

  // 模型选择：与 runGeneration 同语义（explicit ?? saved ?? fallback；reasoning
  // 推导同款——显式/会话选择缺省时回落默认选择的 effort，且仅当模型一致）。
  const fallback = ctx.agentDefaultModel.currentSelection()
  const saved = options.sessionId !== undefined ? state.modelSelections?.[options.sessionId] : undefined
  const explicit = options.provider !== undefined && options.model !== undefined
    ? {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      }
    : undefined
  const choice = explicit ?? saved ?? fallback
  const provider = choice.provider
  const model = choice.model
  const reasoningEffort = explicit?.reasoningEffort ?? saved?.reasoningEffort
    ?? (provider === fallback.provider && model === fallback.model ? fallback.reasoningEffort : undefined)

  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages: request.messages.map((m) => ({
      id: crypto.randomUUID(),
      role: m.role,
      content: [{ type: 'text', text: m.content }],
      // 候选请求不带 sessionId：source 仅标注来源，dsh-llm 不校验（同 runGeneration）。
      source: m.role === 'assistant' ? { kind: 'model', provider, model } : { kind: 'user' },
    })),
    system: request.system,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure?.message ?? 'candidate generation failed')
    }
  }
  if (text.trim() === '') throw new Error('model returned no candidates')

  const items = parseCandidates(text)
  const generatedAt = new Date().toISOString()
  writeStoredCandidates(chat, { items, generatedAt, ...(feedback !== undefined ? { feedback } : {}) })
  const revision = await db.saveChat(characterName, chatId, chat, snapshot.revision)
  return { items, generatedAt, revision }
}
