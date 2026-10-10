import { describe, expect, it } from 'vitest'
import { ScriptError, registerStscriptCommand, runScript, stscriptCommandNames, type ScriptEnv } from '../src/stscript.js'

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

describe('/regex command', () => {
  it('passes the named script and trailing positional text to applyRegex', async () => {
    const calls: Array<[string, string]> = []
    const env = makeEnv({ applyRegex: (name, text) => { calls.push([name, text]); return `(${text})` } })
    const result = await runScript('/regex name=Strip hello world', env)
    expect(calls).toEqual([['Strip', 'hello world']])
    expect(result.output).toBe('(hello world)')
    expect(result.chatChanged).toBe(false)
  })

  it('accepts the script name as the first positional argument', async () => {
    const calls: Array<[string, string]> = []
    const env = makeEnv({ applyRegex: (name, text) => { calls.push([name, text]); return text } })
    await runScript('/regex Strip foo bar', env)
    expect(calls).toEqual([['Strip', 'foo bar']])
  })

  it('feeds piped output as the input text', async () => {
    const calls: Array<[string, string]> = []
    const env = makeEnv({ applyRegex: (name, text) => { calls.push([name, text]); return text.toUpperCase() } })
    const result = await runScript('/echo hello | /regex name=Strip', env)
    expect(calls).toEqual([['Strip', 'hello']])
    expect(result.output).toBe('HELLO')
  })

  it('requires a script name', async () => {
    const env = makeEnv({ applyRegex: () => 'unused' })
    await expect(runScript('/regex', env)).rejects.toThrow('/regex requires a script name')
  })

  it('rejects /regex when the environment has no applyRegex', async () => {
    const env = makeEnv({ applyRegex: undefined })
    await expect(runScript('/regex name=Strip hi', env)).rejects.toThrow('/regex is not available')
  })

  it('awaits async applyRegex handlers', async () => {
    const env = makeEnv({ applyRegex: async (name, text) => `${name}:${text}` })
    const result = await runScript('/regex name=A b c', env)
    expect(result.output).toBe('A:b c')
  })
})

describe('STscript command registry (proposal 0015 P0)', () => {
  it('carries the complete builtin command set in the table', () => {
    // 头注释命令清单的机器对照：主名 + 别名全部在表（switch 时代的等价面）。
    expect(stscriptCommandNames()).toEqual([
      'echo', 'comment',
      'setvar', 'setglobalvar',
      'getvar', 'getglobalvar',
      'addvar',
      'incvar', 'decvar',
      'hasvar', 'hasglobalvar',
      'delvar', 'delglobalvar',
      'if',
      'random',
      'roll',
      'pick',
      'send',
      'trigger',
      'regenerate',
      'stop',
      'cut',
      'regex',
    ])
  })

  it('keeps unknown-command errors verbatim through the table lookup', async () => {
    const env = makeEnv()
    await expect(runScript('/definitelynot', env)).rejects.toThrow('unknown command: /definitelynot')
  })

  it('runs commands registered through the registration entry', async () => {
    registerStscriptCommand({
      name: 'shout',
      run: (cmd) => ({ output: cmd.raw.toUpperCase(), chatChanged: false }),
    })
    const env = makeEnv()
    expect((await runScript('/echo soft | /shout', env)).output).toBe('SOFT')
  })

  it('supports aliases in registered commands', async () => {
    registerStscriptCommand({
      name: 'mark',
      aliases: ['bookmark'],
      run: (cmd) => ({ output: `marked:${cmd.name}`, chatChanged: false }),
    })
    const env = makeEnv()
    expect((await runScript('/mark', env)).output).toBe('marked:mark')
    expect((await runScript('/bookmark', env)).output).toBe('marked:bookmark')
  })

  it('passes the shared tools (rng/changed/runNested) to handlers', async () => {
    registerStscriptCommand({
      name: 'diceprobe',
      run: (cmd, env, tools) => {
        expect(typeof tools.rng).toBe('function')
        return tools.changed()
      },
    })
    const env = makeEnv()
    const result = await runScript('/diceprobe', env)
    expect(result.chatChanged).toBe(true)
    expect(result.output).toBe('')
  })

  // P2（提案 0015 §3.3）：registerStscriptCommand 返回反注册——mod 宿主的
  // dispose 链落点。只摘自己那一次注册：重载后的旧 disposer 不误删同名新注册。
  it('returns an unregister that removes the command and its aliases', async () => {
    const off = registerStscriptCommand({
      name: 'tempcmd',
      aliases: ['tempalias'],
      run: (cmd) => ({ output: `t:${cmd.raw}`, chatChanged: false }),
    })
    const env = makeEnv()
    expect((await runScript('/tempcmd x', env)).output).toBe('t:x')
    expect((await runScript('/tempalias y', env)).output).toBe('t:y')
    off()
    await expect(runScript('/tempcmd x', makeEnv())).rejects.toThrow('unknown command: /tempcmd')
    await expect(runScript('/tempalias y', makeEnv())).rejects.toThrow('unknown command: /tempalias')
    // 幂等：重复 off 不炸、不误删后续同名注册。
    expect(() => off()).not.toThrow()
  })

  it('a stale unregister never removes a newer same-name registration', async () => {
    const first = registerStscriptCommand({ name: 'reused', run: () => ({ output: 'first', chatChanged: false }) })
    first()
    registerStscriptCommand({ name: 'reused', run: () => ({ output: 'second', chatChanged: false }) })
    first() // 旧 disposer：不得摘掉新注册
    const env = makeEnv()
    expect((await runScript('/reused', env)).output).toBe('second')
  })
})
