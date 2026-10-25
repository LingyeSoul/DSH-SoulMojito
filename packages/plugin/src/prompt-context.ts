import { detectPresetKind, parseContextTemplate, parseInstructTemplate, parsePreset, RegexPlacement, type ChatLogIR, type ChatMessage, type CharacterCardIR, type RegexScriptIR } from '../../tavern-format/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { applyRegexScripts } from '../../tavern-script/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { collectSessionRegexScripts } from './regex-session.js'

export const DEFAULT_USER = 'User'

/**
 * AgentTavern 导入/预加载的宏展开：{{char}}=角色名，{{user}}=激活 persona 名。
 * 与 ST substituteParams 对齐；未知宏保持原样。
 */
export function tavernMacroExpand(
  state: Pick<TavernState, 'activePersona'>,
  characterName: string,
  character: { card: CharacterCardIR } | undefined,
): (text: string) => string {
  const macros = createMacroEngine({
    char: character?.card.data.nickname || character?.card.data.name || characterName,
    user: state.activePersona ?? DEFAULT_USER,
  })
  return (text: string): string => macros.expand(text)
}

/**
 * One message's display text: the stored text already carries the save-layer
 * AI_OUTPUT transform, so only markdownOnly scripts are applied on top here
 * (ST semantics: display-only scripts never reach the prompt or the save).
 */
export function displayTextForMessage(scripts: RegexScriptIR[], message: ChatMessage, depth: number): string {
  const displayScripts = scripts.filter((script) => script.markdownOnly && !script.disabled)
  const text = message.mes ?? ''
  return displayScripts.length === 0
    ? text
    : applyRegexScripts(text, displayScripts, RegexPlacement.AI_OUTPUT, { expand: (value) => value }, { depth })
}

/**
 * markdownOnly AI_OUTPUT 脚本的展示层文本（ST 语义：仅改显示，不进 prompt、不落盘）。
 * 返回与 messages 平行的数组；无脚本时返回 undefined。会话正则覆盖层与生成
 * 管线读同一份集合，聊天级改写会立即反映到浏览器展示。
 */
export async function displayTexts(
  db: Pick<TavernStore, 'getCharacter' | 'getChatJsrOverlay'>,
  state: TavernState,
  characterName: string,
  chatId: string,
  chat: ChatLogIR,
): Promise<string[] | undefined> {
  const character = await db.getCharacter(characterName)
  const scripts = await collectSessionRegexScripts(db, state, characterName, chatId, character)
  if (scripts.every((script) => !script.markdownOnly || script.disabled)) return undefined
  return chat.messages.map((message, index) =>
    displayTextForMessage(scripts, message, chat.messages.length - 1 - index))
}

export async function presetSamplerValue(
  db: Pick<TavernStore, 'getPreset'>,
  state: Pick<TavernState, 'activePreset'>,
  key: string,
): Promise<unknown> {
  const presetName = state.activePreset
  if (!presetName) return undefined
  const preset = await db.getPreset(presetName)
  return preset?.[key]
}

export function parsePresetOrThrow(data: Record<string, unknown>): void {
  const kind = detectPresetKind(data)
  if (kind === 'chat-completion') {
    parsePreset(data)
    return
  }
  if (kind === 'context') {
    parseContextTemplate(data)
    return
  }
  if (kind === 'instruct') {
    parseInstructTemplate(data)
    return
  }
  if (kind === 'textgen-sampler') return
  throw new Error('preset format not recognized (expected chat completion prompts, context, instruct, or textgen sampler)')
}

/** 压缩总结模型覆盖（提案 0006 §4.3）：成对非空 provider/model 才生效，
 * null/空串/半空一律清除为 undefined（回落部署配置与会话路由）。 */
export function compactionOverrideOf(value: unknown): { curatorProvider: string; curatorModel: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const provider = typeof record['curatorProvider'] === 'string' ? record['curatorProvider'].trim() : ''
  const model = typeof record['curatorModel'] === 'string' ? record['curatorModel'].trim() : ''
  return provider !== '' && model !== ''
    ? { curatorProvider: provider, curatorModel: model }
    : undefined
}
