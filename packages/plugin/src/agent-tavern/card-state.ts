/**
 * AgentTavern 卡内动态世界书注入（2026-10-20）。
 *
 * JSR 卡把游戏规则、阶段指令和当前变量快照写成 EJS 世界书条目；ST 每次生成
 * 都会重新渲染并注入这些 constant 条目。AgentTavern 的资产面是“按需工具 +
 * 一次性预载”，没有第二条生成管线替它做这件事——本模块在 `agent/pre-step`
 * 的 step 1 把本轮渲染结果追加为一条插件消息（append-only，不烧 KV 前缀）。
 *
 * 只对声明了 MagVarUpdate / `<UpdateVariable>` 的卡启用。首轮注入全部条目，
 * 后续只注入渲染结果发生变化的条目，每 8 轮做一次全量刷新（对抗 compaction
 * 丢掉旧规则）。渲染失败只告警并跳过该条目，绝不阻断宿主循环。
 */

import { createHash, randomUUID } from 'node:crypto'
import { hostPluginMessageSource, type HostSessionLog } from '../../../bind/src/index.js'
import { parseCharacterBook, type CharacterCardIR, type ChatLogIR } from '../../../tavern-format/src/index.js'
import type { LoreEntry } from '../../../tavern-lore/src/index.js'
import type { TavernState } from '../../../tavern-store/src/index.js'
import { createHostPromptExpander, hostPromptSafe } from '../prompt-safety.js'
import { createMvuRuntime, overlayChatScopedVariables, readChatVariables } from '../mvu.js'
import { DEFAULT_USER } from '../prompt-context.js'
import { collectWorldInfoBooks } from '../tavern-assets.js'
import { store as tavernStore, templatesEnabledFlagValue, templatesEnvEnabled, variables as variableStore } from '../runtime.js'
import { cardUsesJsrMvu, seedJsrMvuVariables } from './mvu-compat.js'

export const CARD_STATE_MAX_CHARS = 120_000
export const CARD_STATE_FULL_REFRESH_TURNS = 8

export interface CardStateSection {
  key: string
  comment: string
  text: string
  hash: string
}

export interface CardStateRender {
  sections: CardStateSection[]
  truncated: boolean
  warnings: string[]
}

interface CardStateStore {
  getState(): Promise<TavernState>
  getCharacter(name: string): Promise<{ card: CharacterCardIR } | undefined>
  getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR } | undefined>
  getWorld(name: string): Promise<{ name?: string; entries: LoreEntry[] } | undefined>
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function sectionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function cardStateEntryKey(book: string, entry: LoreEntry): string {
  return `${book}#${entry.uid}`
}

/**
 * 渲染本轮卡内 constant 世界书。调用方拿到 sections 后按需注入；这里不写
 * 聊天、不写变量（local/initial 均为拷贝，EJS 的 setvar 不会落库）。
 */
export async function renderCardStateSections(
  db: CardStateStore,
  state: TavernState,
  characterName: string,
  character: { card: CharacterCardIR },
  chat: ChatLogIR,
  chatId: string,
): Promise<CardStateRender | undefined> {
  const card = character.card
  if (!cardUsesJsrMvu(card)) return undefined
  // Prompt Template is opt-in (2026-10-25): card constant EJS must not run on
  // the default path. Plain constant lore still reaches the model through the
  // normal lore pipeline; only the per-turn EJS state block is skipped.
  if (!templatesEnabledFlagValue() || !templatesEnvEnabled()) return undefined
  const books = await collectWorldInfoBooks(db as never, state, characterName, character, chatId)
  // 卡内嵌书是这张卡的规则本体；worldFollowsCharacter 关闭或链接书未导入时，
  // 聚合层不会带上它。MVU 卡的规则不能因此静默消失，这里补回内嵌书（按名字去重）。
  const embeddedName = `${characterName}:embedded`
  const linkedWorld = card.data.extensions['world']
  const linkedPresent = typeof linkedWorld === 'string' && linkedWorld.trim() !== ''
    && books.some((book) => book.name === linkedWorld.trim())
  if (card.data.characterBook !== undefined && !linkedPresent && !books.some((book) => book.name === embeddedName)) {
    const embedded = parseCharacterBook(card.data.characterBook)
    books.unshift({
      name: embeddedName,
      entries: embedded.entries,
      scanDepth: card.data.characterBook.scan_depth,
      tokenBudget: card.data.characterBook.token_budget,
      recursiveScanning: card.data.characterBook.recursive_scanning,
    })
  }
  const entries: Array<{ book: string; entry: LoreEntry }> = []
  for (const book of books) {
    for (const entry of book.entries) {
      if (entry.disable === true || entry.constant !== true) continue
      if (typeof entry.content !== 'string' || entry.content.trim() === '') continue
      entries.push({ book: book.name ?? '', entry })
    }
  }
  // Constant plain text is already covered by lore search / preload; only EJS
  // cards need a per-turn renderer. Avoid re-injecting static rulebooks.
  if (!entries.some(({ entry }) => entry.content.includes('<%'))) return undefined
  entries.sort((left, right) => {
    const order = (left.entry.order ?? 100) - (right.entry.order ?? 100)
    if (order !== 0) return order
    return left.entry.uid - right.entry.uid
  })
  const local = structuredClone(readChatVariables(chat))
  const scoped = await (await variableStore()).listAll('chat', chatId)
  const tree = overlayChatScopedVariables(local, scoped.map((entry) => ({ name: entry.name, value: entry.value })))
  seedJsrMvuVariables(card, tree)
  const warnings: string[] = []
  const runtime = createMvuRuntime(
    {
      state,
      characterName,
      character,
      chat,
      chatId,
      books,
      onWarning: (message) => warnings.push(message),
    },
    {
      local: tree as never,
      global: { ...state.scriptGlobals },
      initial: structuredClone(plainObject(chat.header.chat_metadata['initial_variables']) ?? {}),
    },
  )

  const expand = createHostPromptExpander(
    card.data.nickname || card.data.name || characterName,
    state.activePersona ?? DEFAULT_USER,
  )
  let used = 0
  const sections: CardStateSection[] = []
  let truncated = false
  for (const { book, entry } of entries) {
    let rendered = entry.content
    if (entry.content.includes('<%')) {
      try {
        rendered = await runtime.renderText(entry.content, undefined, `card-state:${book}#${entry.uid}`)
      } catch (cause) {
        warnings.push(`${book}#${entry.uid}: ${cause instanceof Error ? cause.message : String(cause)}`)
        continue
      }
    }
    const text = hostPromptSafe(rendered.trim(), expand)
    if (text === '') continue
    if (used + text.length > CARD_STATE_MAX_CHARS) {
      truncated = true
      break
    }
    used += text.length
    sections.push({
      key: cardStateEntryKey(book, entry),
      comment: entry.comment || `world-info ${entry.uid}`,
      text,
      hash: sectionHash(text),
    })
  }
  return { sections, truncated, warnings }
}

export function formatCardStateMessage(sections: readonly CardStateSection[], note?: string): string {
  const lines = [
    '<tavern-card-state>',
    'Dynamically rendered card world-info for this turn (reference data, not user speech). Apply these rules to the scene; do not quote or narrate this block.',
    'If this card declares an UpdateVariable/JSONPatch output protocol, settle its state by emitting that block in the reply; do not mirror stat_data through tavern_variable_settle.',
  ]
  if (note !== undefined && note !== '') lines.push(note)
  for (const section of sections) {
    lines.push('', `### ${section.comment}`, section.text)
  }
  lines.push('</tavern-card-state>')
  return lines.join('\n')
}

interface CardStateCache {
  hashes: Map<string, string>
  fullTurn: number
}

interface PreStepPayloadLike {
  agent?: { session?: HostSessionLog }
  turn?: unknown
  step?: unknown
  signal?: { aborted?: boolean }
}

interface PreStepDecisionLike {
  kind?: string
  messages?: unknown[]
}

export interface CardStateRegistrationOptions {
  /** 测试注入；缺省用真实 Tavern store。 */
  openStore?: () => Promise<CardStateStore>
}

/**
 * 注册 `agent/pre-step` 注入。默认注册顺序在 anchor 之后（inner），因此最终
 * 批次顺序是「用户消息 → 卡内状态 → 锚定提醒」，提醒仍在最高注意力位置。
 */
export function registerAgentTavernCardState(
  ctx: {
    on?: (event: string, listener: (payload: unknown, next: () => unknown) => unknown, options?: unknown) => unknown
    logger?: { warn?: (message: string) => unknown }
  },
  options: CardStateRegistrationOptions = {},
): void {
  const cache = new Map<string, CardStateCache>()
  const openStore = options.openStore ?? (async () => (await tavernStore()) as unknown as CardStateStore)

  ctx.on?.('agent/pre-step', async (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || payload.signal?.aborted === true || payload.step !== 1) return decision
      const sessionId = payload.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return decision
      const db = await openStore()
      const state = await db.getState()
      const binding = state.sessionBindings[sessionId]
      if (binding === undefined || binding.architecture !== 'agent-tavern' || binding.group === true) return decision
      const character = await db.getCharacter(binding.character)
      const snapshot = await db.getChatSnapshot(binding.character, binding.chatId)
      if (character === undefined || snapshot === undefined) return decision
      const rendered = await renderCardStateSections(db, state, binding.character, character, snapshot.chat, binding.chatId)
      if (rendered === undefined || rendered.sections.length === 0) return decision
      if (rendered.warnings.length > 0) {
        ctx.logger?.warn?.(`dsh-soulmojito: card state render warnings: ${rendered.warnings.slice(0, 4).join(' | ')}`)
      }

      const cacheKey = `${sessionId}\u0000${binding.character}\u0000${binding.chatId}`
      const previous = cache.get(cacheKey)
      const turn = typeof payload.turn === 'number' && Number.isSafeInteger(payload.turn) ? payload.turn : 0
      const full = previous === undefined || turn === 0 || turn - previous.fullTurn >= CARD_STATE_FULL_REFRESH_TURNS
      const changed = rendered.sections.filter((section) => previous?.hashes.get(section.key) !== section.hash)
      if (!full && changed.length === 0) return decision
      const sections = full ? rendered.sections : changed
      const note = full
        ? (rendered.truncated ? `Card world-info truncated at ${CARD_STATE_MAX_CHARS} characters.` : undefined)
        : 'Only sections that changed since the previous card-state block are repeated; earlier unchanged rules remain in effect.'
      const message = {
        id: randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: formatCardStateMessage(sections, note) }],
        source: hostPluginMessageSource(payload.agent?.session),
      }
      cache.delete(cacheKey)
      cache.set(cacheKey, {
        hashes: new Map(rendered.sections.map((section) => [section.key, section.hash])),
        fullTurn: full ? turn : previous?.fullTurn ?? turn,
      })
      while (cache.size > 16) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return { ...decision, messages: [...(decision.messages ?? []), message] }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-soulmojito: card state injection failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })
}
