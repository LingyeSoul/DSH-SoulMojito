import { describe, expect, it } from 'vitest'
import {
  TextCompletionFormatError,
  detectPresetKind,
  parseContextTemplate,
  parseInstructTemplate,
} from '../src/textcompletion.js'

describe('text completion presets', () => {
  it('classifies preset objects by shape', () => {
    expect(detectPresetKind({ prompts: [], prompt_order: [] })).toBe('chat-completion')
    expect(detectPresetKind({ story_string: '{{description}}' })).toBe('context')
    expect(detectPresetKind({ input_prefix: '\nUser: ', output_prefix: '\nAI: ' })).toBe('instruct')
    expect(detectPresetKind({ temp: 0.7, rep_pen: 1.1 })).toBe('textgen-sampler')
    expect(detectPresetKind({ unrelated: true })).toBe('unknown')
  })

  it('parses context templates with defaults', () => {
    const ir = parseContextTemplate({
      story_string: 'X',
      story_string_position: 1,
      story_string_depth: 4,
      example_separator: '---',
    })
    expect(ir.storyString).toBe('X')
    expect(ir.storyStringPosition).toBe(1)
    expect(ir.storyStringDepth).toBe(4)
    expect(ir.storyStringRole).toBe('system')
    expect(ir.exampleSeparator).toBe('---')
    expect(parseContextTemplate({ story_string: '' }).exampleSeparator).toBe('\n')
  })

  it('parses instruct templates with defaults', () => {
    const ir = parseInstructTemplate({
      input_prefix: '<|user|>',
      output_prefix: '<|bot|>',
      names_behavior: 1,
      wrap: true,
    })
    expect(ir.inputPrefix).toBe('<|user|>')
    expect(ir.outputPrefix).toBe('<|bot|>')
    expect(ir.inputSuffix).toBe('')
    expect(ir.namesBehavior).toBe(1)
    expect(ir.wrap).toBe(true)
  })

  it('rejects mismatched shapes', () => {
    expect(() => parseContextTemplate({ temp: 1 })).toThrow(TextCompletionFormatError)
    expect(() => parseInstructTemplate({ story_string: 'x' })).toThrow(TextCompletionFormatError)
  })
})
