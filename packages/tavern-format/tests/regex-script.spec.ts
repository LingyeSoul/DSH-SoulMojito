import { describe, expect, it } from 'vitest'
import {
  RegexPlacement,
  hasPlacement,
  parseRegexScript,
  parseRegexScripts,
  serializeRegexScript,
} from '../src/regex-script.js'

describe('regex scripts', () => {
  it('parses arrays, wrapped arrays, and card-level bags', () => {
    const script = { scriptName: 'S', findRegex: '/a/g', replaceString: 'b' }
    expect(parseRegexScripts([script])).toHaveLength(1)
    expect(parseRegexScripts({ scripts: [script] })).toHaveLength(1)
    expect(parseRegexScripts({ regex_scripts: [script] })).toHaveLength(1)
    expect(parseRegexScripts(script)).toHaveLength(1)
  })

  it('applies ST defaults and validates placement values', () => {
    const ir = parseRegexScript({ scriptName: 'S', findRegex: 'x', placement: [2, 2, 99, '5'] })
    expect(ir.placement).toEqual([2])
    expect(ir.disabled).toBe(false)
    expect(ir.runOnEdit).toBe(false)
    expect(ir.substituteRegex).toBe(false)
    expect(ir.minDepth).toBeNull()
    expect(ir.maxDepth).toBeNull()
    expect(ir.replaceString).toBe('')
    expect(ir.id).not.toBe('')
  })

  it('defaults empty placement to AI_OUTPUT', () => {
    expect(hasPlacement(parseRegexScript({ findRegex: 'x' }), RegexPlacement.AI_OUTPUT)).toBe(true)
  })

  it('keeps unknown fields in the extra bag and round-trips', () => {
    const ir = parseRegexScript({ scriptName: 'S', findRegex: 'x', custom: { a: 1 }, minDepth: 2, maxDepth: 8 })
    const out = serializeRegexScript(ir)
    expect(out['custom']).toEqual({ a: 1 })
    expect(out['minDepth']).toBe(2)
    expect(out['maxDepth']).toBe(8)
    expect(parseRegexScript(out)).toEqual(ir)
  })

  it('rejects entries without a pattern', () => {
    expect(() => parseRegexScript({ scriptName: 'S' })).toThrow(/findRegex/)
  })
})
