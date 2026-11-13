import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PresetFormatError,
  findPrompt,
  isReasoningTemplateShape,
  isSystemPromptPresetShape,
  parsePreset,
  parseReasoningTemplate,
  parseSystemPromptPreset,
  serializePreset,
  stableDeepEqual,
} from '../src/index.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const defaultPreset = () => JSON.parse(readFileSync(`${fixturesDir}/preset-Default.json`, 'utf8')) as Record<string, unknown>

describe('真实预设：ST Default.json', () => {
  it('解析出 prompts 与 prompt_order，marker 注入点齐备', () => {
    const ir = parsePreset(defaultPreset())
    expect(ir.prompts.length).toBeGreaterThan(8)
    const identifiers = ir.prompts.filter((p) => 'marker' in p && p.marker).map((p) => p.identifier)
    for (const marker of ['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples']) {
      expect(identifiers, `marker ${marker}`).toContain(marker)
    }
    expect(ir.promptOrder.length).toBeGreaterThan(0)
  })

  it('sampler 袋保留采样参数', () => {
    const ir = parsePreset(defaultPreset())
    expect(typeof ir.sampler['temperature']).toBe('number')
    expect(typeof ir.sampler['openai_max_context']).toBe('number')
    expect(typeof ir.sampler['wi_format']).toBe('string')
  })

  it('roundtrip：serialize 输出与原对象语义一致（键序无关）', () => {
    const ir = parsePreset(defaultPreset())
    expect(stableDeepEqual(defaultPreset(), serializePreset(ir))).toBe(true)
  })

  it('findPrompt 定位 main/jailbreak 保留 identifier', () => {
    const ir = parsePreset(defaultPreset())
    const main = findPrompt(ir, 'main')
    expect(main).toBeDefined()
    expect((main as { content?: unknown }).content).toBeTypeOf('string')
    expect(findPrompt(ir, 'jailbreak')).toBeDefined()
  })
})

describe('非生成类预设：sysprompt / reasoning', () => {
  it('解析 ST sysprompt（name/content/post_history）并保留原始对象', () => {
    const data = { name: 'Roleplay - Simple', content: 'You are {{char}}.', post_history: 'Be brief.', unrelated: 1 }
    const ir = parseSystemPromptPreset(data)
    expect(ir).toMatchObject({ name: 'Roleplay - Simple', content: 'You are {{char}}.', postHistory: 'Be brief.' })
    expect(ir.sampler).toBe(data)
    // ST 的 Blank 预设 content 为空串，仍然合法（最小校验只看类型）
    expect(parseSystemPromptPreset({ name: 'Blank', content: '' }).content).toBe('')
  })

  it('解析 ST reasoning 模板（prefix/suffix，separator 可缺省）', () => {
    const ir = parseReasoningTemplate({ name: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' })
    expect(ir.name).toBe('DeepSeek')
    expect(ir.prefix).toBe('<think>\n')
    expect(ir.suffix).toBe('\n</think>')
    expect(ir.separator).toBe('')
  })

  it('最小校验：缺 ST 必备字段即拒绝，带 prompts[] 的不算这两类', () => {
    expect(() => parseSystemPromptPreset({ name: 'x' })).toThrow(PresetFormatError)
    expect(() => parseReasoningTemplate({ name: 'x', prefix: '<t>' })).toThrow(PresetFormatError)
    expect(isSystemPromptPresetShape({ prompts: [], content: 'x' })).toBe(false)
    expect(isReasoningTemplateShape({ prompts: [], prefix: '', suffix: '' })).toBe(false)
  })
})
