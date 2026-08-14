import { describe, expect, it } from 'vitest'
import { createMacroEngine } from '../src/index.js'

const fixed = new Date(2026, 7, 14, 15, 5, 9)
const make = (over = {}) => createMacroEngine({
  char: 'ExampleCard', user: 'Tester', persona: 'A traveler', chatId: 'chat-1',
  card: { description: 'Dryad', personality: 'gentle', scenario: 'forest', mesExample: 'example', systemPrompt: 'card prompt', postHistoryInstructions: 'stay', charDepthPrompt: 'depth', creatorNotes: 'notes' },
  lastMessage: 'last', lastUserMessage: 'user last', lastCharMessage: 'char last', lastMessageId: 8,
  model: 'gpt-test', maxContextTokens: 4096, maxResponseTokens: 300, idleDurationSeconds: 330,
  now: () => fixed, rng: () => 0.5, ...over,
})

describe('macro engine', () => {
  it('names, legacy and optional group', () => {
    expect(make().expand('{{char}}/{{USER}}/<BOT>/<USER>/{char}/{user}/{{notChar}}')).toBe('ExampleCard/Tester/ExampleCard/Tester/ExampleCard/Tester/Tester')
    expect(make({ group: 'A, B' }).expand('{{group}}/{{charIfNotGroup}}')).toBe('A, B/A, B')
  })
  it('card, persona, history and runtime fields', () => {
    expect(make().expand('{{persona}}|{{description}}|{{personality}}|{{scenario}}|{{charPrompt}}|{{charInstruction}}|{{charDepthPrompt}}|{{charCreatorNotes}}|{{mesExamples}}')).toBe('A traveler|Dryad|gentle|forest|card prompt|stay|depth|notes|example')
    expect(make().expand('{{lastMessage}}/{{lastUserMessage}}/{{lastCharMessage}}/{{lastMessageId}}/{{model}}/{{maxPrompt}}/{{maxResponseTokens}}')).toBe('last/user last/char last/8/gpt-test/4096/300')
  })
  it('time/date formatting fixed clock', () => {
    const out = make().expand('{{time}}|{{date}}|{{isotime}}|{{isodate}}|{{datetimeformat::yyyy-MM-dd HH:mm:ss}}|{{idleDuration}}')
    expect(out).toContain('3:05 PM')
    expect(out).toContain('August 14, 2026')
    expect(out).toContain('15:05|2026-08-14|2026-08-14 15:05:09|6 minutes')
  })
  it('random comma/escaped comma, pick stability, dice', () => {
    expect(make().expand('{{random:a,b,c}}')).toBe('b')
    expect(make().expand('{{random:a\\,x,b}}')).toBe('b')
    const e = make(); expect(e.expand('{{pick::a::b::c}}')).toBe(e.expand('{{pick::a::b::c}}'))
    expect(make().expand('{{roll::2d6+3}}')).toBe('11')
    expect(make().expand('{{roll:d20}}')).toBe('')
  })
  it('local/global variable mutation', () => {
    const e = make({ local: { n: 1 }, global: { g: 'x' } })
    expect(e.expand('{{getvar::n}}|{{incvar::n::2}}|{{getvar::n}}')).toBe('1|3|3')
    expect(e.expand('{{setvar::x::v}}{{getvar::x}}')).toBe('v')
    expect(e.expand('{{getglobalvar::g}}|{{setglobalvar::z::9}}{{getglobalvar::z}}')).toBe('x|9')
    expect(e.expand('{{hasvar::x}}|{{deletevar::x}}{{hasvar::x}}')).toBe('true|false')
  })
  it('tools/comments/unknown/custom macro', () => {
    const e = make(); e.registerMacro('upper', (args) => args.join(':').toUpperCase())
    expect(e.expand('a{{newline}}b{{space}}c{{noop}}{{// hide}}{{upper::x::y}}')).toBe('a\nb cX:Y')
    expect(e.expand('{{unknown::x}}')).toBe('{{unknown::x}}')
    expect(e.expand('a\n{{trim}}\nb')).toBe('ab')
  })
})
