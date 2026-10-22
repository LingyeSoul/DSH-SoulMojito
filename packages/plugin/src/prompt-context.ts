import { detectPresetKind, parseContextTemplate, parseInstructTemplate, parsePreset, RegexPlacement, type ChatMessage, type RegexScriptIR } from '../../tavern-format/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { applyRegexScripts } from '../../tavern-script/src/index.js'
import { collectRegexScripts } from './tavern-assets.js'

export const DEFAULT_USER = 'User'

/**
 * AgentTavern 导入/预加载的宏展开：{{char}}=角色名，{{user}}=激活 persona 名。
 * 与 ST substituteParams 对齐；未知宏保持原样。
 */
export function tavernMacroExpand(state, characterName, character) {
  const macros = createMacroEngine({
    char: character?.card.data.nickname || character?.card.data.name || characterName,
    user: state.activePersona ?? DEFAULT_USER,
  })
  return (text) => macros.expand(text)
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
 * 返回与 messages 平行的数组；无脚本时返回 undefined。
 */
export async function displayTexts(db, state, characterName, chat) {
  const character = await db.getCharacter(characterName)
  const scripts = collectRegexScripts(state, character)
  if (scripts.every((script) => !script.markdownOnly || script.disabled)) return undefined
  return chat.messages.map((message, index) =>
    displayTextForMessage(scripts, message, chat.messages.length - 1 - index))
}

export async function presetSamplerValue(db, state, key) {
  const presetName = state.activePreset
  if (!presetName) return undefined
  const preset = await db.getPreset(presetName)
  return preset?.[key]
}

export function parsePresetOrThrow(data) {
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
export function compactionOverrideOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = typeof value.curatorProvider === 'string' ? value.curatorProvider.trim() : ''
  const model = typeof value.curatorModel === 'string' ? value.curatorModel.trim() : ''
  return provider !== '' && model !== ''
    ? { curatorProvider: provider, curatorModel: model }
    : undefined
}
