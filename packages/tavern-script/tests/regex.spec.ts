import { describe, expect, it } from 'vitest'
import { RegexPlacement, parseRegexScript } from '@dsh-tavern/format'
import { applyRegexScript, applyRegexScripts, applyRegexScriptsToLines, compileScriptRegex } from '../src/regex.js'

describe('regex script engine', () => {
  it('replaces with the global flag and back-references', () => {
    const script = parseRegexScript({ scriptName: 's', findRegex: '(foo) (bar)', replaceString: '$2 $1' })
    expect(applyRegexScript('foo bar foo bar', script, RegexPlacement.AI_OUTPUT)).toBe('bar foo bar foo')
  })

  it('supports /pattern/flags literals and honors case-insensitive flags', () => {
    const script = parseRegexScript({ findRegex: '/hello/i', replaceString: 'hi', placement: [1] })
    expect(applyRegexScript('Say HELLO', script, RegexPlacement.USER_INPUT)).toBe('Say hi')
  })

  it('skips disabled scripts, wrong placements, and invalid patterns', () => {
    const disabled = parseRegexScript({ findRegex: 'x', replaceString: 'y', disabled: true })
    expect(applyRegexScript('x', disabled, RegexPlacement.AI_OUTPUT)).toBeNull()
    const placement = parseRegexScript({ findRegex: 'x', replaceString: 'y', placement: [2] })
    expect(applyRegexScript('x', placement, RegexPlacement.WORLD_INFO)).toBeNull()
    const invalid = parseRegexScript({ findRegex: '[' })
    expect(applyRegexScript('x', invalid, RegexPlacement.AI_OUTPUT)).toBeNull()
    expect(compileScriptRegex(invalid)).toBeNull()
  })

  it('removes trim strings from the result', () => {
    const script = parseRegexScript({ findRegex: 'name', replaceString: 'Alice', trimStrings: ['<br>'] })
    expect(applyRegexScript('name<br><br>', script, RegexPlacement.AI_OUTPUT)).toBe('Alice')
  })

  it('expands macros in find/replace when substituteRegex is set', () => {
    const script = parseRegexScript({
      findRegex: '{{user}}',
      replaceString: 'found-{{user}}',
      substituteRegex: true,
    })
    const result = applyRegexScript('hi User', script, RegexPlacement.AI_OUTPUT, { expand: (t) => t.replaceAll('{{user}}', 'User') })
    expect(result).toBe('hi found-User')
  })

  it('filters by message depth via minDepth/maxDepth', () => {
    const script = parseRegexScript({ findRegex: 'x', replaceString: 'y', minDepth: 0, maxDepth: 2 })
    expect(applyRegexScript('x', script, RegexPlacement.AI_OUTPUT, {}, { depth: 1 })).toBe('y')
    expect(applyRegexScript('x', script, RegexPlacement.AI_OUTPUT, {}, { depth: 5 })).toBeNull()
    expect(applyRegexScript('x', script, RegexPlacement.AI_OUTPUT)).toBe('y') // 无深度信息不过滤
  })

  it('chains multiple scripts in order', () => {
    const a = parseRegexScript({ findRegex: 'a', replaceString: 'b' })
    const b = parseRegexScript({ findRegex: 'b', replaceString: 'c' })
    expect(applyRegexScripts('a', [a, b], RegexPlacement.AI_OUTPUT)).toBe('c')
  })

  it('applies per-line with per-line depth', () => {
    const script = parseRegexScript({ findRegex: 'old', replaceString: 'new', maxDepth: 1 })
    const lines = ['old', 'old', 'old']
    const out = applyRegexScriptsToLines(lines, [script], RegexPlacement.AI_OUTPUT, {}, (i) => i)
    expect(out).toEqual(['new', 'new', 'old'])
  })
})
