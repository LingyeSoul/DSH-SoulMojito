import { describe, expect, it } from 'vitest'
import { parseContextTemplate, parseInstructTemplate } from '@dsh-tavern/format'
import { assembleTextCompletion, renderStoryString } from '../src/textcompletion.js'

const deps = {
  expand: (text: string) => text.replace(/\{\{char\}\}/g, 'Alice').replace(/\{\{user\}\}/g, 'Bob'),
  countTokens: (text: string) => Math.ceil(text.length / 4),
}

const context = parseContextTemplate({
  story_string: [
    '{{#if system}}{{system}}',
    '{{/if}}{{#if description}}{{description}}',
    '{{/if}}{{#if personality}}Personality: {{personality}}',
    '{{/if}}{{#if scenario}}Scenario: {{scenario}}',
    '{{/if}}{{#if wiBefore}}Lore: {{wiBefore}}',
    '{{/if}}{{#if persona}}User is {{persona}}{{/if}}',
  ].join(''),
})

const speakerFields = {
  description: 'A knight.',
  personality: 'Brave.',
  scenario: 'A castle.',
}

function message(mes: string, is_user: boolean, name = '') {
  return { name, is_user, is_system: false, send_date: 'now', mes }
}

describe('story_string rendering', () => {
  it('expands if-blocks by non-empty values and drops empty branches', () => {
    const out = renderStoryString(
      '{{#if description}}D:{{description}}{{/if}}{{#if missing}}no{{else}}fallback{{/if}}',
      { description: 'x', missing: '' },
      deps.expand,
    )
    expect(out).toBe('D:xfallback')
  })

  it('leaves unknown macros to the macro engine untouched', () => {
    const out = renderStoryString('{{unknown}} {{char}}', { char: 'Alice' }, deps.expand)
    expect(out).toBe('{{unknown}} Alice')
  })
})

describe('text completion assembly', () => {
  it('builds the story block and bare history without instruct', () => {
    const result = assembleTextCompletion({
      context,
      speakerName: 'Alice',
      userName: 'Bob',
      speakerFields,
      worldInfoBefore: ['Dragons exist.'],
      worldInfoAfter: [],
      messages: [message('Hi.', true, 'Bob'), message('Greetings.', false, 'Alice')],
    }, deps)
    expect(result.prompt).toContain('A knight.')
    expect(result.prompt).toContain('Lore: Dragons exist.')
    expect(result.prompt).toContain('Hi.\nGreetings.')
    expect(result.prompt.endsWith('\n')).toBe(true)
    expect(result.stats.historyDropped).toBe(0)
  })

  it('formats history with instruct sequences and names_behavior', () => {
    const instruct = parseInstructTemplate({
      input_prefix: '<|user|>',
      input_suffix: '',
      output_prefix: '<|assistant|>',
      output_suffix: '\n',
      names_behavior: 1,
    })
    const result = assembleTextCompletion({
      context,
      instruct,
      speakerName: 'Alice',
      userName: 'Bob',
      speakerFields,
      worldInfoBefore: [],
      worldInfoAfter: [],
      messages: [message('Hello.', true, 'Bob'), message('Hey.', false, 'Alice')],
    }, deps)
    expect(result.prompt).toContain('<|user|>Bob: Hello.')
    expect(result.prompt).toContain('<|assistant|>Alice: Hey.\n')
  })

  it('omits names for assistant messages when names_behavior is 0', () => {
    const instruct = parseInstructTemplate({
      input_prefix: 'User: ',
      output_prefix: 'AI: ',
      names_behavior: 0,
    })
    const result = assembleTextCompletion({
      context,
      instruct,
      speakerName: 'Alice',
      userName: 'Bob',
      speakerFields,
      worldInfoBefore: [],
      worldInfoAfter: [],
      messages: [message('Hello.', true, 'Bob'), message('Hey.', false, 'Alice')],
    }, deps)
    expect(result.prompt).toContain('User: Bob: Hello.')
    expect(result.prompt).toContain('AI: Hey.')
  })

  it('drops oldest history when the budget overflows', () => {
    const result = assembleTextCompletion({
      context,
      speakerName: 'Alice',
      userName: 'Bob',
      speakerFields: { description: 'x'.repeat(400) },
      worldInfoBefore: [],
      worldInfoAfter: [],
      messages: [
        message('old message that should be dropped for budget reasons', true, 'Bob'),
        message('kept', true, 'Bob'),
      ],
      maxContextTokens: 160,
      maxResponseTokens: 55,
    }, deps)
    expect(result.stats.historyDropped).toBe(1)
    expect(result.stats.historyKept).toBe(1)
    expect(result.prompt).toContain('kept')
    expect(result.prompt).not.toContain('old message')
    expect(result.warnings.join(' ')).toContain('dropped 1')
  })

  it('injects depth injections near the end of history', () => {
    const result = assembleTextCompletion({
      context,
      speakerName: 'Alice',
      userName: 'Bob',
      speakerFields,
      worldInfoBefore: [],
      worldInfoAfter: [],
      messages: [message('one', true, 'Bob'), message('two', true, 'Bob')],
      depthInjections: [{ depth: 0, role: 'system', text: '[AN]' }],
    }, deps)
    expect(result.prompt.trim().endsWith('[AN]')).toBe(true)
  })
})
