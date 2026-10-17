import { detectPresetKind, parseContextTemplate, parseInstructTemplate, parsePreset, RegexPlacement } from '../../tavern-format/src/index.js'
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
 * 角色卡 extensions.world 绑定且已存在的世界书名（自动激活目标）。
 * 世界书文件不存在（外部引用未导入）时返回空，不产生悬空激活。
 */
export async function characterLinkedWorlds(db, characterName) {
  const found = await db.getCharacter(characterName)
  const world = found?.card.data.extensions['world']
  if (typeof world !== 'string' || world.trim() === '') return []
  const book = await db.getWorld(world.trim())
  return book ? [book.name] : []
}

/**
 * markdownOnly AI_OUTPUT 脚本的展示层文本（ST 语义：仅改显示，不进 prompt、不落盘）。
 * 返回与 messages 平行的数组；无脚本时返回 undefined。
 */
export async function displayTexts(db, state, characterName, chat) {
  const character = await db.getCharacter(characterName)
  const scripts = collectRegexScripts(state, character)
    .filter((script) => script.markdownOnly && !script.disabled)
  if (scripts.length === 0) return undefined
  return chat.messages.map((message, index) =>
    applyRegexScripts(message.mes ?? '', scripts, RegexPlacement.AI_OUTPUT, { expand: (t) => t }, { depth: chat.messages.length - 1 - index }))
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
