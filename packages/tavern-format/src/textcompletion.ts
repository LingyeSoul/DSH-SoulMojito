/**
 * ST 预设形态探测与 Text Completion 三件套 IR。
 *
 * - Context 模板（presets/context/*.json）：`story_string`（Handlebars 子集，见
 *   tavern-pipeline 的装配实现）+ story 注入位置/深度/角色等。
 * - Instruct 模板（presets/instruct/*.json）：`input_prefix`/`output_prefix` 等消息
 *   包装序列。
 * - 采样器（presets/textgen/*.json）：temp/rep_pen/top_k… 无 prompts[] 结构。
 * - sysprompt（`{name, content, post_history?}`）与 reasoning
 *   （`{name, prefix, suffix, separator?}`）：见 preset.ts，只识别 + 最小校验，
 *   本插件的生成装配不消费（宿主持有 system prompt 与思考流），导入/导出原样往返。
 *
 * 全部与 Chat Completion preset 共用 presets/ 存储；本模块按内容形态分类，
 * 不依赖文件名约定。
 */

import { isReasoningTemplateShape, isSystemPromptPresetShape } from './preset.js'

export type PresetKind =
  | 'chat-completion'
  | 'context'
  | 'instruct'
  | 'textgen-sampler'
  | 'sysprompt'
  | 'reasoning'
  | 'unknown'

export interface ContextTemplateIR {
  storyString: string
  /** 0 = 相对（顶部默认），1 = 绝对 @Depth；透传语义由 pipeline 消费 */
  storyStringPosition: number
  storyStringDepth: number
  storyStringRole: 'system' | 'user' | 'assistant'
  exampleSeparator: string
  chatStart: string
  /** 其余键原样透传 */
  sampler: Record<string, unknown>
}

export interface InstructTemplateIR {
  systemPromptPrefix: string
  systemPromptSuffix: string
  inputPrefix: string
  inputSuffix: string
  outputPrefix: string
  outputSuffix: string
  systemSequence: string
  systemSequenceEnd: string
  stopSequence: string
  /** 插入说话者名字（true = 名字进序列） */
  namesBehavior: number
  wrap: boolean
  /** 其余键原样透传 */
  sampler: Record<string, unknown>
}

export class TextCompletionFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TextCompletionFormatError'
  }
}

/** 按内容形态分类 preset 对象（顺序即优先级）。 */
export function detectPresetKind(obj: Record<string, unknown>): PresetKind {
  if (Array.isArray(obj['prompts']) && Array.isArray(obj['prompt_order'])) return 'chat-completion'
  if (typeof obj['story_string'] === 'string') return 'context'
  if (typeof obj['input_prefix'] === 'string' && typeof obj['output_prefix'] === 'string') return 'instruct'
  if (typeof obj['temp'] === 'number' || typeof obj['rep_pen'] === 'number' || typeof obj['top_k'] === 'number') {
    return 'textgen-sampler'
  }
  // sysprompt 先于 reasoning：ST 的 sysprompt 只有 content，reasoning 只有 prefix/suffix，
  // 两者不重叠，但 sysprompt 的形态更宽泛，放前面避免未来字段叠加时误判。
  if (isSystemPromptPresetShape(obj)) return 'sysprompt'
  if (isReasoningTemplateShape(obj)) return 'reasoning'
  return 'unknown'
}

export function parseContextTemplate(obj: Record<string, unknown>): ContextTemplateIR {
  if (detectPresetKind(obj) !== 'context') {
    throw new TextCompletionFormatError('preset is not a context template (missing story_string)')
  }
  const role = str(obj['story_string_role'])
  return {
    storyString: str(obj['story_string']),
    storyStringPosition: num(obj['story_string_position'], 0),
    storyStringDepth: num(obj['story_string_depth'], 0),
    storyStringRole: role === 'user' || role === 'assistant' ? role : 'system',
    exampleSeparator: str(obj['example_separator']) || '\n',
    chatStart: str(obj['chat_start']) || '',
    sampler: obj,
  }
}

export function parseInstructTemplate(obj: Record<string, unknown>): InstructTemplateIR {
  if (detectPresetKind(obj) !== 'instruct') {
    throw new TextCompletionFormatError('preset is not an instruct template (missing prefixes)')
  }
  return {
    systemPromptPrefix: str(obj['system_prompt_prefix']),
    systemPromptSuffix: str(obj['system_prompt_suffix']),
    inputPrefix: str(obj['input_prefix']),
    inputSuffix: str(obj['input_suffix']),
    outputPrefix: str(obj['output_prefix']),
    outputSuffix: str(obj['output_suffix']),
    systemSequence: str(obj['system_sequence']),
    systemSequenceEnd: str(obj['system_sequence_end']),
    stopSequence: str(obj['stop_sequence']),
    namesBehavior: num(obj['names_behavior'], 0),
    wrap: bool(obj['wrap'], false),
    sampler: obj,
  }
}

/* ------------------------------ 内部 ------------------------------ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
