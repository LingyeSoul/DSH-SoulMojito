import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  findPrompt,
  parsePreset,
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
