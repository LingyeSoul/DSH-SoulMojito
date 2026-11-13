/**
 * Chat Completion 预设：prompts[] + prompt_order[] 结构化，
 * 其余 50+ 键（采样参数/格式串/模型选择）原样透传（sampler 袋）。
 *
 * 本文件同时承载两种**非生成**预设形态（ST 同样放在 presets/ 下）：
 * - sysprompt：`{ name, content, post_history? }` —— ST 的系统提示词选择器资产；
 * - reasoning：`{ name, prefix, suffix, separator? }` —— 思考块包裹序列。
 * 两者只做识别 + 最小校验 + 原样往返，不参与生成装配（本插件沿用 DSH 宿主
 * 的 system prompt 与思考流，不建第二套）。判定优先级在 detectPresetKind。
 */

import type { PresetIR, PresetPrompt, PromptOrderSet } from './types.js'

export class PresetFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetFormatError'
  }
}

export function parsePreset(obj: Record<string, unknown>): PresetIR {
  const promptsRaw = obj['prompts']
  if (!Array.isArray(promptsRaw)) throw new PresetFormatError("preset has no 'prompts' array")
  const prompts: PresetPrompt[] = promptsRaw.map((p, i) => {
    if (typeof p !== 'object' || p === null) throw new PresetFormatError(`prompts[${i}] is not an object`)
    return p as unknown as PresetPrompt
  })
  const orderRaw = obj['prompt_order']
  const promptOrder: PromptOrderSet[] = Array.isArray(orderRaw)
    ? orderRaw.map((o, i) => {
        if (typeof o !== 'object' || o === null || !Array.isArray((o as { order?: unknown }).order)) {
          throw new PresetFormatError(`prompt_order[${i}] is malformed`)
        }
        return o as unknown as PromptOrderSet
      })
    : []
  const sampler: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'prompts' && k !== 'prompt_order') sampler[k] = v
  }
  return { prompts, promptOrder, sampler }
}

export function serializePreset(ir: PresetIR): Record<string, unknown> {
  return {
    ...ir.sampler,
    prompts: ir.prompts,
    prompt_order: ir.promptOrder,
  }
}

/** 按 identifier 取 prompt 内容条目（非 marker）。 */
export function findPrompt(ir: PresetIR, identifier: string): PresetPrompt | undefined {
  return ir.prompts.find((p) => p.identifier === identifier)
}

/* ---------------------- 非生成类预设（sysprompt / reasoning） ---------------------- */

/** ST sysprompt 预设（`presets/sysprompt/*.json`）。 */
export interface SystemPromptPresetIR {
  name: string
  content: string
  /** ST `post_history`：system prompt 之后的历史位注入文本；缺省空串 */
  postHistory: string
  /** 原始对象（与 Context/Instruct 的 sampler 袋同义：往返不丢键） */
  sampler: Record<string, unknown>
}

/** ST reasoning 模板（`presets/reasoning/*.json`）：思考块的包裹序列。 */
export interface ReasoningTemplateIR {
  name: string
  prefix: string
  suffix: string
  separator: string
  /** 原始对象（同 sampler 袋：往返不丢键） */
  sampler: Record<string, unknown>
}

/**
 * sysprompt 形态判定。分类优先级由 `detectPresetKind` 的顺序决定，这里只判
 * “内容字符串 + 不带其它预设家族的结构键”，避免把 chat-completion 预设误判。
 */
export function isSystemPromptPresetShape(obj: Record<string, unknown>): boolean {
  return typeof obj['content'] === 'string'
    && !Array.isArray(obj['prompts'])
    && typeof obj['story_string'] !== 'string'
    && typeof obj['input_prefix'] !== 'string'
    && typeof obj['output_prefix'] !== 'string'
}

/** reasoning 模板形态判定：ST 只用 prefix/suffix（separator 可缺省）。 */
export function isReasoningTemplateShape(obj: Record<string, unknown>): boolean {
  return typeof obj['prefix'] === 'string'
    && typeof obj['suffix'] === 'string'
    && !Array.isArray(obj['prompts'])
}

/** 最小校验：只要求 ST 必备字段的类型；内容可空（ST 的 Blank 预设即空串）。 */
export function parseSystemPromptPreset(obj: Record<string, unknown>): SystemPromptPresetIR {
  if (!isSystemPromptPresetShape(obj)) {
    throw new PresetFormatError("preset is not a system prompt preset (missing 'content' string)")
  }
  return {
    name: typeof obj['name'] === 'string' ? obj['name'] : '',
    content: obj['content'] as string,
    postHistory: typeof obj['post_history'] === 'string' ? obj['post_history'] : '',
    sampler: obj,
  }
}

/** 最小校验：prefix/suffix 必须是字符串（可为空串，ST 的 Blank 模板即空）。 */
export function parseReasoningTemplate(obj: Record<string, unknown>): ReasoningTemplateIR {
  if (!isReasoningTemplateShape(obj)) {
    throw new PresetFormatError("preset is not a reasoning template (missing 'prefix'/'suffix' strings)")
  }
  return {
    name: typeof obj['name'] === 'string' ? obj['name'] : '',
    prefix: obj['prefix'] as string,
    suffix: obj['suffix'] as string,
    separator: typeof obj['separator'] === 'string' ? obj['separator'] : '',
    sampler: obj,
  }
}
