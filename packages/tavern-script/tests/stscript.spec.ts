import { describe, expect, it } from 'vitest'
import { ScriptError, runScript, type ScriptEnv } from '../src/stscript.js'

function makeEnv(overrides: Partial<ScriptEnv> = {}): ScriptEnv & { sent: string[]; triggered: (string | undefined)[]; cutCalls: [number, number][] } {
  const local = new Map<string, string | number | boolean>()
  const global = new Map<string, string | number | boolean>()
  const state = { sent: [] as string[], triggered: [] as (string | undefined)[], cutCalls: [] as [number, number][] }
  return {
    ...state,
    expand: (text) => text,
    getVar: (name) => local.get(name),
    setVar: (name, value) => { local.set(name, value) },
    deleteVar: (name) => local.delete(name),
    getGlobalVar: (name) => global.get(name),
    setGlobalVar: (name, value) => { global.set(name, value) },
    deleteGlobalVar: (name) => global.delete(name),
    rng: () => 0.42,
    send: (text) => { state.sent.push(text) },
    trigger: (member) => { state.triggered.push(member) },
    regenerate: () => { state.triggered.push('__regen__') },
    stop: () => {},
    cut: (from, to) => { state.cutCalls.push([from, to]) },
    ...overrides,
  }
}

describe('STscript interpreter', () => {
  it('runs echo and pipes output into {{pipe}}', async () => {
    const env = makeEnv()
    const result = await runScript('/echo hello | /echo said: {{pipe}}', env)
    expect(result.output).toBe('said: hello')
  })

  it('appends piped output as the last argument when {{pipe}} is unused', async () => {
    const env = makeEnv()
    await runScript('/echo 10 | /setvar score', env)
    expect(env.getVar('score')).toBe('10')
  })

  it('handles setvar/getvar in key=value and quoted forms', async () => {
    const env = makeEnv()
    await runScript('/setvar score=10 | /getvar score', env)
    expect(env.getVar('score')).toBe('10')
    await runScript('/setvar note="a b c" | /getvar note', env)
    expect(env.getVar('note')).toBe('a b c')
  })

  it('incvar/decvar/addvar mutate numerically and concatenate strings', async () => {
    const env = makeEnv()
    await runScript('/setvar n=5 | /incvar n | /incvar n | /getvar n', env)
    expect(Number(env.getVar('n'))).toBe(7)
    await runScript('/decvar n | /getvar n', env)
    expect(Number(env.getVar('n'))).toBe(6)
    await runScript('/setvar s=ab | /addvar s=cd | /getvar s', env)
    expect(env.getVar('s')).toBe('abcd')
    await runScript('/setvar n=1 | /addvar n=10 | /getvar n', env)
    expect(Number(env.getVar('n'))).toBe(11)
  })

  it('supports global variable commands', async () => {
    const env = makeEnv()
    await runScript('/setglobalvar theme=dark | /getglobalvar theme | /hasglobalvar missing', env)
    expect(env.getGlobalVar('theme')).toBe('dark')
  })

  it('hasvar/delvar report and remove', async () => {
    const env = makeEnv()
    await runScript('/setvar x=1 | /hasvar x', env)
    const present = await runScript('/hasvar x', env)
    expect(present.output).toBe('true')
    await runScript('/delvar x', env)
    const absent = await runScript('/hasvar x', env)
    expect(absent.output).toBe('false')
  })

  it('evaluates /if with numeric and string comparisons and branches', async () => {
    const env = makeEnv()
    const numeric = await runScript('/if left=5 right=5 op=== then="/echo same" else="/echo diff"', env)
    expect(numeric.output).toBe('same')
    const strings = await runScript('/if left=abc right=abd op=== then="/echo same" else="/echo diff"', env)
    expect(strings.output).toBe('diff')
    const contains = await runScript('/if left="hello world" right=world op=contains then="/echo yes"', env)
    expect(contains.output).toBe('yes')
    const notEqual = await runScript('/if left=a right=b op=!= then="/echo differs"', env)
    expect(notEqual.output).toBe('differs')
  })

  it('rolls dice with the injected rng and validates specs', async () => {
    const env = makeEnv()
    const result = await runScript('/roll 2d6', env)
    // rng() = 0.42 → 每骰 floor(0.42*6)+1 = 3
    expect(result.output).toBe('6')
    await expect(runScript('/roll nonsense', env)).rejects.toThrow(ScriptError)
  })

  it('picks from comma or :: lists and numeric ranges', async () => {
    const env = makeEnv()
    expect((await runScript('/random a,b,c', env)).output).toBe('b') // floor(0.42*3)=1
    expect((await runScript('/random x::y', env)).output).toBe('x')
    expect((await runScript('/random 1-10', env)).output).toBe('5')
  })

  it('executes chat actions and reports chatChanged', async () => {
    const env = makeEnv()
    const result = await runScript('/send hi there | /trigger Alice | /cut 0-2', env)
    expect(env.sent).toEqual(['hi there'])
    expect(env.triggered).toEqual(['Alice'])
    expect(env.cutCalls).toEqual([[0, 2]])
    expect(result.chatChanged).toBe(true)
  })

  it('rejects chat actions when the environment lacks them', async () => {
    const env = makeEnv({ send: undefined, trigger: undefined, cut: undefined })
    await expect(runScript('/send hi', env)).rejects.toThrow('/send')
    await expect(runScript('/trigger', env)).rejects.toThrow('/trigger')
    await expect(runScript('/cut 0', env)).rejects.toThrow('/cut')
  })

  it('rejects unknown commands and non-slash input', async () => {
    const env = makeEnv()
    await expect(runScript('/frobnicate', env)).rejects.toThrow(ScriptError)
    await expect(runScript('hello world', env)).rejects.toThrow(ScriptError)
  })

  it('skips // comment lines and executes multi-line scripts', async () => {
    const env = makeEnv()
    const result = await runScript('// just a note\n/setvar a=1\n/getvar a', env)
    expect(result.output).toBe('1')
  })
})
