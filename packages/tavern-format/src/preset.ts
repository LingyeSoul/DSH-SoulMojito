/**
 * Chat Completion 预设：prompts[] + prompt_order[] 结构化，
 * 其余 50+ 键（采样参数/格式串/模型选择）原样透传（sampler 袋）。
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
