import { describe, expect, it } from 'vitest'
import type { CharacterCardIR } from '../../tavern-format/src/index.js'
import { macroCardFieldsOf, parsePresetOrThrow, tavernMacroExpand } from '../src/prompt-context.js'

// 全部合成夹具：占位名、无真实素材/路径。
const cardData: CharacterCardIR['data'] = {
  name: 'ExampleCard',
  description: 'A dryad of the test grove',
  personality: 'gentle',
  scenario: 'a synthetic grove',
  firstMes: 'Hello there',
  mesExample: 'Tester: hi\nExampleCard: yo',
  creatorNotes: 'synthetic notes',
  systemPrompt: 'card system prompt',
  postHistoryInstructions: 'stay in character',
  alternateGreetings: [],
  tags: [],
  creator: 'placeholder',
  characterVersion: '1.0',
  extensions: { depth_prompt: { prompt: 'depth reminder', depth: 4 } },
}

const character: { card: CharacterCardIR } = {
  card: { spec: 'chara_card_v2', specVersion: '2.0', data: cardData, raw: {} },
}

describe('AgentTavern 宏展开的卡字段绑定', () => {
  it('binds card fields like ST substituteParams (helper/import 同值)', () => {
    const expand = tavernMacroExpand({ activePersona: 'Tester' }, 'Fallback', character)
    expect(expand('{{char}}/{{user}}')).toBe('ExampleCard/Tester')
    expect(expand('{{description}}|{{personality}}|{{scenario}}')).toBe(
      'A dryad of the test grove|gentle|a synthetic grove',
    )
    expect(expand('{{charPrompt}}|{{charInstruction}}|{{charDepthPrompt}}|{{creatorNotes}}')).toBe(
      'card system prompt|stay in character|depth reminder|synthetic notes',
    )
  })

  it('splits cleaned and raw example macros', () => {
    const expand = tavernMacroExpand({ activePersona: 'Tester' }, 'ExampleCard', character)
    expect(expand('{{mesExamplesRaw}}')).toBe('Tester: hi\nExampleCard: yo')
    expect(expand('{{mesExamples}}')).toBe('<START>\nTester: hi\nExampleCard: yo\n')
  })

  it('leaves macros without a data source literal', () => {
    const expand = tavernMacroExpand({ activePersona: 'Tester' }, 'ExampleCard', character)
    // {{systemPrompt}} 只有预设级数据源，本通道没有 → 展开为空串（ST 的 charPrompt 之外
    // 没有 system prompt 绑定）；{{outlet::}} 连数据源都没有 → 保持宏原文。
    expect(expand('{{systemPrompt}}')).toBe('')
    expect(expand('{{outlet::Weather}}')).toBe('{{outlet::Weather}}')
  })

  it('expands card macros to empty when no card is loaded', () => {
    const expand = tavernMacroExpand({ activePersona: undefined }, 'Nameless', undefined)
    expect(expand('{{char}}/{{user}}')).toBe('Nameless/User')
    // Known card macros have a registered source but no data: empty string (ST
    // substituteParams), not the literal. Unknown macros stay literal.
    expect(expand('{{description}}')).toBe('')
    expect(expand('{{unknownMacro}}')).toBe('{{unknownMacro}}')
  })

  it('maps depth_prompt through card extensions', () => {
    expect(macroCardFieldsOf(cardData)).toMatchObject({
      charDepthPrompt: 'depth reminder',
      mesExample: 'Tester: hi\nExampleCard: yo',
      creatorNotes: 'synthetic notes',
    })
    expect(macroCardFieldsOf({ ...cardData, extensions: {} }).charDepthPrompt).toBe('')
  })
})

describe('预设导入闸门', () => {
  it('accepts ST sysprompt and reasoning presets', () => {
    // ST presets/sysprompt/*.json
    expect(() => parsePresetOrThrow({ name: 'Actor', content: 'You are {{char}}.', post_history: '' })).not.toThrow()
    expect(() => parsePresetOrThrow({ name: 'Blank', content: '' })).not.toThrow()
    // ST presets/reasoning/*.json
    expect(() => parsePresetOrThrow({
      name: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n',
    })).not.toThrow()
  })

  it('keeps validating the other preset families', () => {
    expect(() => parsePresetOrThrow({ prompts: [], prompt_order: [] })).not.toThrow()
    expect(() => parsePresetOrThrow({ input_prefix: '<|user|>', output_prefix: '<|bot|>' })).not.toThrow()
    expect(() => parsePresetOrThrow({ temp: 0.7 })).not.toThrow()
  })

  it('rejects shapes it cannot classify', () => {
    expect(() => parsePresetOrThrow({ unrelated: true })).toThrow(/preset format not recognized/)
    expect(() => parsePresetOrThrow({ prompts: [] })).toThrow(/preset format not recognized/)
  })
})
