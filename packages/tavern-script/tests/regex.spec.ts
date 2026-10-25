import { describe, expect, it } from 'vitest'
import { RegexPlacement, parseRegexScript } from '@dsh-soulmojito/format'
import {
  applyRegexScript,
  applyRegexScripts,
  applyRegexScriptsToLines,
  compileScriptRegex,
  MAX_SCRIPT_REGEX_INPUT_LENGTH,
  MAX_SCRIPT_REGEX_PATTERN_LENGTH,
  type RegexScriptWarning,
} from '../src/regex.js'

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

  it('keeps replacement $ sequences literal (ST function-replacement semantics)', () => {
    // 卡内美化前端把整份 HTML/JS 塞进 replaceString；`'$__META_EXTENSIBLE__$'`
    // 尾部的 `$'` 若按字符串替换会插入匹配点后的原文，撕坏注入的 <script>。
    const body = "const keep = '$__META_EXTENSIBLE__$';\nconst tpl = `${value}`;"
    const script = parseRegexScript({ findRegex: '\\[FORM\\]', replaceString: body })
    expect(applyRegexScript('[FORM]tail', script, RegexPlacement.AI_OUTPUT)).toBe(`${body}tail`)
  })

  it('expands {{match}} and trims captured groups', () => {
    const script = parseRegexScript({ findRegex: '\\[(.+?)\\]', replaceString: '<$1>{{match}}', trimStrings: ['!'] })
    expect(applyRegexScript('[a!]', script, RegexPlacement.AI_OUTPUT)).toBe('<a>[a]')
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

describe('regex safety gate (ReDoS mitigation)', () => {
  it('rejects a catastrophic nested quantifier quickly and observably', () => {
    const script = parseRegexScript({ scriptName: 'Catastrophic', findRegex: '(a+)+$', replaceString: 'owned' })
    const warnings: RegexScriptWarning[] = []
    const input = `${'a'.repeat(20_000)}!`
    const started = performance.now()
    const result = applyRegexScript(input, script, RegexPlacement.AI_OUTPUT, {
      onWarning: (warning) => warnings.push(warning),
    })
    const elapsed = performance.now() - started

    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
    expect(warnings.map((warning) => warning.code)).toEqual(['unsafe-regex'])
    expect(warnings[0]!.scriptName).toBe('Catastrophic')
    expect(compileScriptRegex(script)).toBeNull()
  })

  it.each([
    '(a*)*',
    '(.*)*',
    '(a|aa)+',
    '(?:a+){20}',
    '(a*a*)',
  ])('rejects the known catastrophic shape %s', (findRegex) => {
    const script = parseRegexScript({ findRegex, replaceString: 'x' })
    const warnings: RegexScriptWarning[] = []
    expect(compileScriptRegex(script, { onWarning: (warning) => warnings.push(warning) })).toBeNull()
    expect(applyRegexScript('a'.repeat(64), script, RegexPlacement.AI_OUTPUT)).toBeNull()
    expect(warnings[0]?.code).toBe('unsafe-regex')
  })

  it('still applies normal and complex linear patterns', () => {
    const normal = parseRegexScript({ findRegex: '(foo) (bar)', replaceString: '$2 $1' })
    expect(applyRegexScript('foo bar', normal, RegexPlacement.AI_OUTPUT)).toBe('bar foo')

    const email = parseRegexScript({
      scriptName: 'Email',
      findRegex: '[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}',
      replaceString: '<email>',
    })
    expect(compileScriptRegex(email)).not.toBeNull()
    expect(applyRegexScript('contact qa@example.test now', email, RegexPlacement.AI_OUTPUT))
      .toBe('contact <email> now')

    const alternation = parseRegexScript({ findRegex: '(?:cat|dog)+', replaceString: 'pet' })
    expect(compileScriptRegex(alternation)).not.toBeNull()
    expect(applyRegexScript('catdogcat', alternation, RegexPlacement.AI_OUTPUT)).toBe('pet')

    const wildcardThenWhitespace = parseRegexScript({ findRegex: '.*\\s+', replaceString: '' })
    expect(compileScriptRegex(wildcardThenWhitespace)).not.toBeNull()
  })

  it('enforces the input length cap and reports it', () => {
    const script = parseRegexScript({ scriptName: 'Cap', findRegex: 'a', replaceString: 'b' })
    const atLimit = 'a'.repeat(MAX_SCRIPT_REGEX_INPUT_LENGTH)
    const atLimitResult = applyRegexScript(atLimit, script, RegexPlacement.AI_OUTPUT)
    expect(atLimitResult).not.toBeNull()
    expect(atLimitResult!.length).toBe(MAX_SCRIPT_REGEX_INPUT_LENGTH)
    expect(atLimitResult![0]).toBe('b')

    const overLimit = 'a'.repeat(MAX_SCRIPT_REGEX_INPUT_LENGTH + 1)
    const warnings: RegexScriptWarning[] = []
    expect(applyRegexScript(overLimit, script, RegexPlacement.AI_OUTPUT, {
      onWarning: (warning) => warnings.push(warning),
    })).toBeNull()
    expect(warnings.map((warning) => warning.code)).toEqual(['input-too-long'])
    expect(applyRegexScripts(overLimit, [script], RegexPlacement.AI_OUTPUT)).toBe(overLimit)
  })

  it('leaves text unchanged when an unsafe script is skipped and still applies later scripts', () => {
    const unsafe = parseRegexScript({ findRegex: '(a+)+$', replaceString: 'owned' })
    const safe = parseRegexScript({ findRegex: '!$', replaceString: '?' })
    const text = `${'a'.repeat(128)}!`
    const warnings: RegexScriptWarning[] = []

    expect(applyRegexScripts(text, [unsafe], RegexPlacement.AI_OUTPUT)).toBe(text)
    expect(applyRegexScripts(text, [unsafe, safe], RegexPlacement.AI_OUTPUT, {
      onWarning: (warning) => warnings.push(warning),
    })).toBe(`${'a'.repeat(128)}?`)
    expect(warnings.map((warning) => warning.code)).toEqual(['unsafe-regex'])
  })

  it('rejects oversized patterns before compiling them', () => {
    const script = parseRegexScript({
      scriptName: 'Huge',
      findRegex: 'a'.repeat(MAX_SCRIPT_REGEX_PATTERN_LENGTH + 1),
      replaceString: 'x',
    })
    const warnings: RegexScriptWarning[] = []
    expect(compileScriptRegex(script, { onWarning: (warning) => warnings.push(warning) })).toBeNull()
    expect(warnings.map((warning) => warning.code)).toEqual(['unsafe-regex'])
    expect(warnings[0]!.detail).toContain('pattern-too-long')
  })

  it('reports invalid regex through the same optional warning channel', () => {
    const invalid = parseRegexScript({ scriptName: 'Broken', findRegex: '[' })
    const warnings: RegexScriptWarning[] = []
    expect(applyRegexScript('text', invalid, RegexPlacement.AI_OUTPUT, {
      onWarning: (warning) => warnings.push(warning),
    })).toBeNull()
    expect(warnings.map((warning) => warning.code)).toEqual(['invalid-regex'])
  })
})
