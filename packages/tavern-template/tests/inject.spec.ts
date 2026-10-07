import { describe, expect, it } from 'vitest'
import {
  applyGenerateInjections,
  applyInjectEntries,
  applyRenderInjections,
  classifySpecialEntry,
  parseInjectParams,
  parseInitialVariables,
  type SpecialEntry,
  type TemplateMessage,
} from '../src/inject.js'

const render = async (text: string, extra?: Record<string, unknown>) => {
  if (extra && 'matched_message' in extra) return `[${extra.matched_message_index}]${text}`
  return text.replace(/<%[-=]?\s*([\s\S]*?)\s*%>/g, (_m, code: string) => String(eval(code)))
}
const cond = async (c: string) => c.includes('true')
const warn: Array<string> = []
const push = (m: string) => {
  warn.push(m)
}

function entry(overrides: Partial<SpecialEntry> & Pick<SpecialEntry, 'kind' | 'content'>): SpecialEntry {
  return { book: 'main', uid: 1, comment: overrides.kind, order: 100, ...overrides }
}

const base = (): TemplateMessage[] => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user', content: 'bye' },
]

describe('条目分类', () => {
  it('标题标签全集', () => {
    expect(classifySpecialEntry({ comment: '[GENERATE:BEFORE] x', content: 'c' })?.kind).toBe('generate-before')
    expect(classifySpecialEntry({ comment: '[GENERATE:AFTER]', content: 'c' })?.kind).toBe('generate-after')
    expect(classifySpecialEntry({ comment: '[GENERATE:1:BEFORE]', content: 'c' })?.kind).toBe('generate-idx-before')
    expect(classifySpecialEntry({ comment: '[GENERATE:-2:AFTER]', content: 'c' })?.arg).toBe('-2')
    expect(classifySpecialEntry({ comment: '[GENERATE:REGEX:^User.*]', content: 'c' })?.kind).toBe('generate-regex')
    expect(classifySpecialEntry({ comment: '[RENDER:BEFORE]', content: 'c' })?.kind).toBe('render-before')
    expect(classifySpecialEntry({ comment: '[RENDER:AFTER]', content: 'c' })?.kind).toBe('render-after')
    expect(classifySpecialEntry({ comment: '[InitialVariables]', content: 'c' })?.kind).toBe('initial')
    expect(classifySpecialEntry({ comment: '@INJECT pos=0,role=system', content: 'c' })?.kind).toBe('inject')
    expect(classifySpecialEntry({ comment: '普通条目', content: 'c' })).toBeNull()
  })

  it('内容装饰器：generate/render/initial + 装饰器剥离', () => {
    const r = classifySpecialEntry({ comment: '', content: '@@generate_before\n@@if variables.a > 5\n正文' })
    expect(r?.kind).toBe('generate-before')
    expect(r?.content).toBe('正文')
    expect(r?.ifCondition).toBe('variables.a > 5')
    const r2 = classifySpecialEntry({ comment: '', content: '@@initial_variables\n{"a": 1}' })
    expect(r2?.kind).toBe('initial')
    expect(r2?.content).toBe('{"a": 1}')
  })

  it('未知装饰器丢弃；@@@ 转义保留', () => {
    const r = classifySpecialEntry({ comment: '', content: '@@whatever\n@@@keepme\nbody' })
    expect(r).toBeNull() // 无特殊语义，且内容首行装饰器被剥离
    const r2 = classifySpecialEntry({ comment: '', content: '@@@plain text' })
    expect(r2).toBeNull()
  })

  it('@@private 包裹块作用域', () => {
    const r = classifySpecialEntry({ comment: '[GENERATE:BEFORE]', content: '@@private\nlet x = 1;<% print(x) %>' })
    expect(r?.content).toContain('<% { %>')
    expect(r?.content).toContain('<% } %>')
  })
})

describe('GENERATE 注入', () => {
  it('BEFORE/AFTER 首尾拼接（order 升序）', async () => {
    const messages = await applyGenerateInjections(base(), [
      entry({ kind: 'generate-before', content: 'B2', order: 200 }),
      entry({ kind: 'generate-before', content: 'B1', order: 50 }),
      entry({ kind: 'generate-after', content: 'A1' }),
    ], render, {}, cond, push)
    expect(messages[0]!.content).toBe('B1\nB2\nsys')
    expect(messages[messages.length - 1]!.content).toBe('bye\nA1')
  })

  it('idx 定位（0 基，负数从尾，越界告警）', async () => {
    const messages = await applyGenerateInjections(base(), [
      entry({ kind: 'generate-idx-after', arg: '1', content: 'X' }),
      entry({ kind: 'generate-idx-before', arg: '-1', content: 'Y' }),
      entry({ kind: 'generate-idx-before', arg: '99', content: 'Z' }),
    ], render, {}, cond, push)
    expect(messages[1]!.content).toBe('hello\nX')
    expect(messages[3]!.content).toBe('Y\nbye')
    expect(warn.some((w) => w.includes('out of range'))).toBe(true)
  })

  it('REGEX 逐匹配消息前缀注入并暴露 matched_*', async () => {
    const messages = await applyGenerateInjections(base(), [
      entry({ kind: 'generate-regex', arg: '^h', content: 'MATCH' }),
    ], render, {}, cond, push)
    expect(messages[1]!.content).toBe('[1]MATCH\nhello')
    expect(messages[3]!.content).toBe('bye')
  })

  it('@@if false 跳过条目', async () => {
    const messages = await applyGenerateInjections(base(), [
      entry({ kind: 'generate-before', content: 'NO', ifCondition: 'false-ish' }),
      entry({ kind: 'generate-before', content: 'YES', ifCondition: 'true' }),
    ], render, {}, cond, push)
    expect(messages[0]!.content).toBe('YES\nsys')
  })

  it('渲染失败跳过不中断', async () => {
    const failing = async () => {
      throw new Error('boom')
    }
    const messages = await applyGenerateInjections(base(), [
      entry({ kind: 'generate-before', content: 'X' }),
    ], failing, {}, cond, push)
    expect(messages[0]!.content).toBe('sys')
    expect(warn.some((w) => w.includes('render failed'))).toBe(true)
  })
})

describe('@INJECT', () => {
  it('参数解析三种模式', () => {
    expect(parseInjectParams('pos=1,role=system', { order: 5 })?.instruction).toEqual({ type: 'pos', pos: 1, role: 'system', order: 5 })
    expect(parseInjectParams('target=user,index=-1,at=after,role=assistant', { order: 1 })?.instruction).toMatchObject({ type: 'target', target: 'user', targetIndex: -1, at: 'after' })
    expect(parseInjectParams(`regex="^User.*",at=after`, { order: 1 })?.instruction).toMatchObject({ type: 'regex', regex: '^User.*', at: 'after' })
    expect(parseInjectParams('bogus', { order: 1 })).toBeNull()
  })

  it('pos 模式：0=开头、正数 1 基、-1=末位之前', async () => {
    const out = await applyInjectEntries(base(), [
      entry({ kind: 'inject', arg: 'pos=0,role=system', content: 'P0' }),
      entry({ kind: 'inject', arg: 'pos=2,role=user', content: 'P2' }),
      entry({ kind: 'inject', arg: 'pos=-1,role=assistant', content: 'PN' }),
    ], render, {}, cond, push)
    // 预期：[P0, sys, P2, hello, hi there, PN, bye]
    expect(out[0]).toEqual({ role: 'system', content: 'P0' })
    expect(out[1]!.content).toBe('sys')
    expect(out[2]).toEqual({ role: 'user', content: 'P2' })
    expect(out[3]!.content).toBe('hello')
    expect(out[out.length - 2]).toEqual({ role: 'assistant', content: 'PN' })
    expect(out[out.length - 1]!.content).toBe('bye')
  })

  it('target 模式：按角色第 N 条（负数从尾）before/after', async () => {
    const out = await applyInjectEntries(base(), [
      entry({ kind: 'inject', arg: 'target=user,index=2,at=after,role=system', content: 'T' }),
      entry({ kind: 'inject', arg: 'target=assistant,role=user', content: 'A' }),
    ], render, {}, cond, push)
    const tIdx = out.findIndex((m) => m.content === 'T')
    expect(tIdx).toBeGreaterThan(0)
    expect(out[tIdx - 1]).toEqual({ role: 'user', content: 'bye' })
    const aIdx = out.findIndex((m) => m.content === 'A')
    expect(out[aIdx + 1]!.role).toBe('assistant')
    expect(out[aIdx + 1]!.content).toBe('hi there')
  })

  it('regex 模式：首个匹配消息前插入（大小写不敏感）', async () => {
    const out = await applyInjectEntries(base(), [
      entry({ kind: 'inject', arg: 'regex=HELLO,role=system', content: 'R' }),
    ], render, {}, cond, push)
    expect(out.findIndex((m) => m.content === 'R')).toBe(1)
  })

  it('空内容与非概率门控', async () => {
    const out = await applyInjectEntries(base(), [
      entry({ kind: 'inject', arg: 'pos=0,role=system', content: '   ' }),
      entry({ kind: 'inject', arg: 'pos=0,role=system', content: 'KEPT', useProbability: true, probability: 100 }),
    ], render, {}, cond, push)
    expect(out[0]!.content).toBe('KEPT')
  })
})

describe('RENDER 与 InitialVariables', () => {
  it('RENDER 前后缀拼接', async () => {
    const out = await applyRenderInjections('mid', [
      entry({ kind: 'render-after', content: 'S2', order: 200 }),
      entry({ kind: 'render-after', content: 'S1', order: 50 }),
      entry({ kind: 'render-before', content: 'P' }),
    ], render, {}, cond, push)
    expect(out).toBe('PmidS1S2')
  })

  it('InitialVariables：JSON / YAML / 非对象拒绝', () => {
    expect(parseInitialVariables('{"hakimi": {"affection": 0}}', push)).toEqual({ hakimi: { affection: 0 } })
    expect(parseInitialVariables('hakimi:\n  affection: 0\n  status: normal\n', push)).toEqual({ hakimi: { affection: 0, status: 'normal' } })
    expect(parseInitialVariables('[1,2]', push)).toBeNull()
    expect(parseInitialVariables('not: [valid', push)).toBeNull()
  })
})
