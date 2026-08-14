/**
 * Prompt 装配流水线（ST Chat Completion 语义）。
 *
 * 对齐 ST `openai.js`/`PromptManager.js` 的装配行为：
 * - prompt_order（默认 dummy id 100000）遍历，enabled 条目按序装配；
 * - marker 展开：worldInfoBefore/After、charDescription/charPersonality/scenario、
 *   personaDescription、dialogueExamples、chatHistory；
 * - 角色卡 system_prompt / post_history_instructions 分别覆盖 main / jailbreak
 *   （空串回落预设；支持 {{original}}）；
 * - wi_format / scenario_format / personality_format 包裹；
 * - openai_max_context / openai_max_tokens 预算裁剪（保最近消息）；
 * - squash_system_messages：相邻 system 合并；
 * - 用户条目绝对位置注入（injection_position=1 @Depth）MVP 支持深度插入。
 *
 * 宏展开与 token 计数经依赖注入（上层接 @dsh-tavern/macros）。
 */

import type { ChatMessage, CharacterCardIR, PresetIR, PresetPrompt, PromptOrderSet } from '@dsh-tavern/format'

export interface AssembleDeps {
  /** 宏展开（上层接 tavern-macros）。 */
  expand: (text: string) => string
  countTokens: (text: string) => number
}

export interface DepthInjection {
  depth: number
  role: 'system' | 'user' | 'assistant'
  text: string
}

export interface AssembleInput {
  card: CharacterCardIR
  preset: PresetIR
  personaDescription?: string
  /** 聊天历史（旧→新）。is_system 消息跳过（ST 注释语义）。 */
  messages: ChatMessage[]
  /** 世界书激活文本（已按 ST 顺序拼接的条目串）。 */
  worldInfoBefore: string[]
  worldInfoAfter: string[]
  /** position 5/6：示例消息块前后。 */
  beforeExamples?: string[]
  afterExamples?: string[]
  /** @Depth 注入（世界书 atDepth 条目 + 作者注等的统一通道）。 */
  depthInjections?: DepthInjection[]
  /** 上下文长度覆盖（默认取 preset.sampler.openai_max_context）。 */
  maxContextTokens?: number
  maxResponseTokens?: number
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AssembleResult {
  messages: LlmMessage[]
  stats: {
    promptTokens: number
    historyKept: number
    historyDropped: number
  }
  warnings: string[]
}

const HISTORY_DUMMY_ID = 100000

export function assemblePrompt(input: AssembleInput, deps: AssembleDeps): AssembleResult {
  const { expand, countTokens } = deps
  const warnings: string[] = []
  const sampler = input.preset.sampler
  const wiFormat = typeof sampler['wi_format'] === 'string' ? (sampler['wi_format'] as string) : '{0}'
  const scenarioFormat = typeof sampler['scenario_format'] === 'string' ? (sampler['scenario_format'] as string) : '{{scenario}}'
  const personalityFormat = typeof sampler['personality_format'] === 'string' ? (sampler['personality_format'] as string) : '{{personality}}'
  const squash = sampler['squash_system_messages'] === true
  const maxContext = input.maxContextTokens ?? numOr(sampler['openai_max_context'], 4096)
  const maxResponse = input.maxResponseTokens ?? numOr(sampler['openai_max_tokens'], 400)

  const order = resolvePromptOrder(input.preset)
  const byId = new Map(input.preset.prompts.map((p) => [p.identifier, p]))

  const preHistory: LlmMessage[] = []
  const postHistory: LlmMessage[] = []
  let historyInjected = false

  for (const slot of order) {
    const prompt = byId.get(slot.identifier)
    if (prompt === undefined) continue
    // chatHistory 之后的位置（jailbreak/UJB 等）进 postHistory
    const target = historyInjected ? postHistory : preHistory

    if ('marker' in prompt && prompt.marker) {
      switch (prompt.identifier) {
        case 'chatHistory': {
          historyInjected = true // 后续条目进入 postHistory
          break
        }
        case 'worldInfoBefore':
          pushText(target, 'system', wrapAll(wiFormat, input.worldInfoBefore, expand), squash)
          break
        case 'worldInfoAfter':
          pushText(target, 'system', wrapAll(wiFormat, input.worldInfoAfter, expand), squash)
          break
        case 'charDescription':
          pushText(target, 'system', expand(input.card.data.description).trim(), squash)
          break
        case 'charPersonality':
          pushText(target, 'system', expand(personalityFormat.replace('{{personality}}', input.card.data.personality)).trim(), squash)
          break
        case 'scenario':
          pushText(target, 'system', expand(scenarioFormat.replace('{{scenario}}', input.card.data.scenario)).trim(), squash)
          break
        case 'personaDescription':
          if (input.personaDescription) pushText(target, 'system', expand(input.personaDescription).trim(), squash)
          break
        case 'dialogueExamples':
          pushText(target, 'system', wrapAll('{0}', input.beforeExamples ?? [], expand), squash)
          pushText(target, 'system', formatExamples(input, expand), squash)
          pushText(target, 'system', wrapAll('{0}', input.afterExamples ?? [], expand), squash)
          break
        default:
          break // 未知 marker 忽略（ST 行为：无内容即跳过）
      }
      continue
    }

    // 内容条目
    const contentPrompt = prompt as Extract<PresetPrompt, { marker?: false }>
    let content = contentPrompt.content ?? ''
    switch (contentPrompt.identifier) {
      case 'main': {
        // 卡 system_prompt 覆盖；{{original}} 回落预设内容
        const override = input.card.data.systemPrompt.trim()
        if (override.length > 0) content = override.replace(/\{\{original\}\}/gi, content)
        break
      }
      case 'jailbreak': {
        const override = input.card.data.postHistoryInstructions.trim()
        if (override.length > 0) content = override.replace(/\{\{original\}\}/gi, content)
        break
      }
      default:
        break
    }
    if (content.trim().length === 0) continue
    pushText(target, contentPrompt.role ?? 'system', expand(content), squash)
  }

  // 聊天历史裁剪：非历史部分先计 token，剩余预算保最新消息
  const preTokens = preHistory.reduce((n, m) => n + countTokens(m.content), 0)
  const postTokens = postHistory.reduce((n, m) => n + countTokens(m.content), 0)
  const budget = maxContext - maxResponse - preTokens - postTokens

  const usable = input.messages.filter((m) => !m.is_system && typeof m.mes === 'string' && m.mes.length > 0)
  const kept: LlmMessage[] = []
  let used = 0
  let dropped = 0
  for (let i = usable.length - 1; i >= 0; i--) {
    const msg = usable[i]!
    const tokens = countTokens(msg.mes)
    if (used + tokens > budget && kept.length > 0) {
      dropped = i + 1
      break
    }
    used += tokens
    kept.unshift({ role: msg.is_user ? 'user' : 'assistant', content: msg.mes })
  }
  if (dropped > 0) warnings.push(`context budget exceeded: dropped ${dropped} oldest message(s)`)

  // @Depth 注入：depth=0 是最底（历史末尾之后），depth=N 插入倒数第 N 条之前
  const history = [...kept]
  for (const injection of [...(input.depthInjections ?? [])].sort((a, b) => b.depth - a.depth)) {
    const idx = Math.max(0, history.length - injection.depth)
    history.splice(idx, 0, { role: injection.role, content: expand(injection.text) })
  }

  // 至少一条 user 消息保障（全空历史 + 无注入时给空 user 位）
  const messages = squashMessages([...preHistory, ...history, ...postHistory], squash)
  return {
    messages,
    stats: {
      promptTokens: messages.reduce((n, m) => n + countTokens(m.content), 0),
      historyKept: kept.length,
      historyDropped: dropped,
    },
    warnings,
  }
}

/* ------------------------------ 内部 ------------------------------ */

function resolvePromptOrder(preset: PresetIR): Array<{ identifier: string; enabled: boolean }> {
  const set: PromptOrderSet | undefined =
    preset.promptOrder.find((o) => o.character_id === HISTORY_DUMMY_ID) ?? preset.promptOrder[0]
  return set?.order ?? []
}

function wrapAll(wiFormat: string, texts: string[], expand: (t: string) => string): string {
  return texts
    .filter((t) => t.trim().length > 0)
    .map((t) => wiFormat.replace('{0}', expand(t)))
    .join('\n')
}

function formatExamples(input: AssembleInput, expand: (t: string) => string): string {
  const example = input.card.data.mesExample.trim()
  if (example.length === 0) return ''
  const separator = typeof input.preset.sampler['new_example_chat_prompt'] === 'string'
    ? (input.preset.sampler['new_example_chat_prompt'] as string)
    : ''
  return `${separator}${expand(example)}`.trim()
}

function pushText(target: LlmMessage[], role: LlmMessage['role'], text: string, squash: boolean): void {
  if (text.length === 0) return
  if (squash) {
    const last = target[target.length - 1]
    if (last !== undefined && last.role === 'system' && role === 'system') {
      last.content += `\n\n${text}`
      return
    }
  }
  target.push({ role, content: text })
}

function squashMessages(messages: LlmMessage[], squash: boolean): LlmMessage[] {
  if (!squash) return messages
  const out: LlmMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last !== undefined && last.role === m.role) {
      last.content += `\n\n${m.content}`
    } else {
      out.push({ ...m })
    }
  }
  return out
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
