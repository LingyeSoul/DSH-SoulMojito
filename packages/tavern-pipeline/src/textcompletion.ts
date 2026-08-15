/**
 * Text Completion 装配（ST 语义：story_string 模板 + instruct 消息序列 + 采样预算）。
 *
 * - story_string 支持 Handlebars 子集：`{{#if field}}…{{else}}…{{/if}}` 与 `{{field}}`
 *   占位（field ∈ values 键或宏引擎的任意宏）。
 * - instruct 开启时历史按 `input_prefix/output_prefix` 包装；`names_behavior` 控制
 *   说话者名字注入（0=仅用户消息带名，1=全部带名，-1=不带名）。
 * - instruct 关闭时裸文本 + `example_separator` 连接。
 * - 预算：story 计入后按剩余预算保最新历史（同 chat completion 语义）。
 */

import type { ChatMessage, ContextTemplateIR, InstructTemplateIR } from '@dsh-tavern/format'
import type { AssembleDeps, DepthInjection } from './pipeline.js'

export interface TextCompletionInput {
  context: ContextTemplateIR
  instruct?: InstructTemplateIR
  speakerName: string
  userName: string
  /** 发言者卡字段（群聊为当前发言者，单聊为角色卡） */
  speakerFields: {
    description?: string
    personality?: string
    scenario?: string
    systemPrompt?: string
    postHistoryInstructions?: string
    mesExample?: string
  }
  personaDescription?: string
  systemPrompt?: string
  worldInfoBefore: string[]
  worldInfoAfter: string[]
  messages: ChatMessage[]
  /** @Depth 注入（世界书 atDepth 等）按 instruct system 序列内联为独立段 */
  depthInjections?: DepthInjection[]
  maxContextTokens?: number
  maxResponseTokens?: number
}

export interface TextCompletionResult {
  prompt: string
  stats: {
    promptTokens: number
    historyKept: number
    historyDropped: number
  }
  warnings: string[]
}

interface StoryValues {
  [key: string]: string
}

export function assembleTextCompletion(input: TextCompletionInput, deps: AssembleDeps): TextCompletionResult {
  const warnings: string[] = []
  const { expand, countTokens } = deps
  const maxContext = input.maxContextTokens ?? 4096
  const maxResponse = input.maxResponseTokens ?? 400
  const instruct = input.instruct
  const namesMode = instruct?.namesBehavior ?? 0

  const joinBlocks = (blocks: string[]): string =>
    blocks.filter((block) => block.trim() !== '').join('\n')

  const values: StoryValues = {
    char: input.speakerName,
    user: input.userName,
    system: expand(input.systemPrompt ?? input.speakerFields.systemPrompt ?? ''),
    description: '',
    personality: '',
    scenario: '',
    persona: input.personaDescription ?? '',
    wiBefore: joinBlocks(input.worldInfoBefore),
    wiAfter: joinBlocks(input.worldInfoAfter),
  }
  for (const field of ['description', 'personality', 'scenario'] as const) {
    const raw = input.speakerFields[field]
    if (typeof raw === 'string' && raw.trim() !== '') values[field] = expand(raw)
  }

  const story = renderStoryString(input.context.storyString, values, expand).trim()

  // 历史预算：story 先占，剩余保最新
  const storyTokens = countTokens(story)
  const budget = maxContext - maxResponse - storyTokens
  const usable = input.messages.filter((m) => !m.is_system && typeof m.mes === 'string' && m.mes.length > 0)
  const formatted: Array<{ text: string; tokens: number }> = []
  for (const message of usable) {
    formatted.push({ text: formatMessage(message, input, namesMode), tokens: 0 })
  }
  for (const item of formatted) item.tokens = countTokens(item.text)
  let used = 0
  let dropped = 0
  const kept: string[] = []
  for (let i = formatted.length - 1; i >= 0; i--) {
    const item = formatted[i]!
    if (used + item.tokens > budget && kept.length > 0) {
      dropped = i + 1
      break
    }
    used += item.tokens
    kept.unshift(item.text)
  }
  if (dropped > 0) warnings.push(`context budget exceeded: dropped ${dropped} oldest message(s)`)

  // @Depth 注入映射为文本段（倒插，depth=0 在最底）
  const history = [...kept]
  for (const injection of [...(input.depthInjections ?? [])].sort((a, b) => b.depth - a.depth)) {
    const segment = instruct
      ? `${instruct.systemSequence}${expand(injection.text)}${instruct.systemSequenceEnd}`
      : expand(injection.text)
    history.splice(Math.max(0, history.length - injection.depth), 0, segment)
  }

  const historyText = instruct
    ? history.join('')
    : joinBlocks(history)
  const prompt = joinBlocks([story, historyText])
  return {
    prompt: prompt.endsWith('\n') ? prompt : `${prompt}\n`,
    stats: {
      promptTokens: storyTokens + used,
      historyKept: kept.length,
      historyDropped: dropped,
    },
    warnings,
  }
}

/* ------------------------------ 内部 ------------------------------ */

function formatMessage(message: ChatMessage, input: TextCompletionInput, namesMode: number): string {
  const instruct = input.instruct
  if (instruct === undefined) {
    return message.mes
  }
  const isUser = message.is_user
  const prefix = isUser ? instruct.inputPrefix : instruct.outputPrefix
  const suffix = isUser ? instruct.inputSuffix : instruct.outputSuffix
  const name = message.name || (isUser ? input.userName : input.speakerName)
  const includeName = namesMode === 1 || (namesMode === 0 && isUser)
  return `${prefix}${includeName ? `${name}: ` : ''}${message.mes}${suffix}`
}

/**
 * 渲染 story_string：先展开 `{{#if}}` 块，再逐 token 替换 `{{field}}`。
 * 未识别的字段交给宏引擎（expand）；宏后仍残留的 `{{…}}` 原样保留。
 */
export function renderStoryString(template: string, values: StoryValues, expand: (text: string) => string): string {
  let text = template
  // {{#if field}} … {{else}} … {{/if}}（允许空白与嵌套一层）
  const ifPattern = /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/
  let previous: string
  do {
    previous = text
    text = text.replace(ifPattern, (_match, field: string, thenBranch: string, elseBranch: string | undefined) => {
      const value = values[field]
      return (value !== undefined && value.trim() !== '') ? thenBranch : (elseBranch ?? '')
    })
  } while (text !== previous)

  return text.replace(/\{\{(\w+)\}\}/g, (match, field: string) => {
    if (field in values) return values[field] ?? ''
    const expanded = expand(match)
    return expanded
  })
}
