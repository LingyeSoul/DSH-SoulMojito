import { describe, expect, it } from 'vitest'
import { ScriptError, registerStscriptCommand, runScript, stscriptCommandNames, type ScriptEnv } from '../src/stscript.js'

function makeEnv(overrides: Partial<ScriptEnv> = {}): ScriptEnv & { sent: string[]; systemed: string[]; triggered: (string | undefined)[]; cutCalls: [number, number][] } {
  const local = new Map<string, string | number | boolean>()
  const global = new Map<string, string | number | boolean>()
  const state = { sent: [] as string[], systemed: [] as string[], triggered: [] as (string | undefined)[], cutCalls: [] as [number, number][] }
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
    system: (text) => { state.systemed.push(text) },
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

  it('posts a system message with /sys', async () => {
    const env = makeEnv()
    const result = await runScript('/sys state synced', env)
    expect(env.systemed).toEqual(['state synced'])
    expect(result).toMatchObject({ output: '', chatChanged: true })
  })

  it('keeps newlines inside command arguments instead of splitting scripts', async () => {
    const env = makeEnv()
    const sheet = '**name**: ExampleChar\n**gender**: example'
    await runScript(`/sys first line\n${sheet}`, env)
    expect(env.systemed).toEqual([`first line\n${sheet}`])

    const sendEnv = makeEnv()
    await runScript('/send line one\nline two | /trigger', sendEnv)
    expect(sendEnv.sent).toEqual(['line one\nline two'])
    expect(sendEnv.triggered).toEqual([undefined])
  })

  it('starts a new command only for lines that begin with a slash', async () => {
    const env = makeEnv()
    const result = await runScript('/setvar first 1\n/setvar second 2\n/getvar second', env)
    expect(result.output).toBe('2')
    expect(env.getVar('first')).toBe('1')
    expect(env.getVar('second')).toBe('2')
  })

  it('rejects chat actions when the environment lacks them', async () => {
    const env = makeEnv({ send: undefined, system: undefined, trigger: undefined, cut: undefined })
    await expect(runScript('/send hi', env)).rejects.toThrow('/send')
    await expect(runScript('/sys hi', env)).rejects.toThrow('/sys')
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
      'sys',
      'trigger',
      'regenerate',
      'stop',
      'cut',
      'regex',
      'continue',
      'swipe',
      'hide',
      'unhide',
      'move',
      'rename',
      'branch',
      'checkpoint',
      'listvar',
      'flushvar',
      'run', 'qr',
      'times',
      'while',
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

describe('chat action commands (contract §2.7)', () => {
  interface ActionCalls {
    continued: number
    swipes: number[]
    hidden: Array<[number, number]>
    unhidden: Array<[number, number]>
    moved: Array<[number, number]>
    renamed: string[]
    branched: Array<[number | undefined, string | undefined]>
    checkpoints: Array<number | undefined>
    listed: number
    flushed: number
    ran: string[]
  }

  function makeCalls(): ActionCalls {
    return {
      continued: 0, swipes: [], hidden: [], unhidden: [], moved: [], renamed: [],
      branched: [], checkpoints: [], listed: 0, flushed: 0, ran: [],
    }
  }

  function makeActionEnv(calls: ActionCalls): ScriptEnv {
    return makeEnv({
      continue: () => { calls.continued += 1 },
      swipe: (delta) => { calls.swipes.push(delta) },
      hide: (from, to) => { calls.hidden.push([from, to]) },
      unhide: (from, to) => { calls.unhidden.push([from, to]) },
      move: (from, to) => { calls.moved.push([from, to]) },
      rename: (name) => { calls.renamed.push(name) },
      branch: (messageId, name) => { calls.branched.push([messageId, name]) },
      checkpoint: (messageId) => { calls.checkpoints.push(messageId) },
      listVars: () => { calls.listed += 1; return 'a=1\nb=2' },
      flushVars: () => { calls.flushed += 1 },
      runQuickReply: (name) => { calls.ran.push(name) },
    })
  }

  it('/continue and /swipe forward to the env with the ST defaults', async () => {
    const calls = makeCalls()
    const env = makeActionEnv(calls)
    const continued = await runScript('/continue', env)
    expect(continued.chatChanged).toBe(true)
    expect(calls.continued).toBe(1)
    await runScript('/swipe', env)
    await runScript('/swipe 2', env)
    await runScript('/swipe -1', env)
    expect(calls.swipes).toEqual([1, 2, -1])
    await expect(runScript('/swipe abc', env)).rejects.toThrow('/swipe expects an integer')
  })

  it('/hide and /unhide accept ranges, single indices and the last-floor default', async () => {
    const calls = makeCalls()
    const env = makeActionEnv(calls)
    await runScript('/hide 0-4', env)
    await runScript('/hide 3', env)
    await runScript('/hide 1 3', env)
    await runScript('/hide', env)
    await runScript('/unhide 2', env)
    expect(calls.hidden).toEqual([[0, 4], [3, 3], [1, 3], [-1, -1]])
    expect(calls.unhidden).toEqual([[2, 2]])
    await expect(runScript('/hide abc', env)).rejects.toThrow('/hide expects indices')
  })

  it('/move requires both indices', async () => {
    const calls = makeCalls()
    const env = makeActionEnv(calls)
    await runScript('/move 1 3', env)
    expect(calls.moved).toEqual([[1, 3]])
    await expect(runScript('/move 1', env)).rejects.toThrow('/move expects two indices')
  })

  it('/rename /branch /checkpoint map positional arguments onto the env', async () => {
    const calls = makeCalls()
    const env = makeActionEnv(calls)
    await runScript('/rename New Title', env)
    await runScript('/branch', env)
    await runScript('/branch 4', env)
    await runScript('/branch 4 alt name', env)
    await runScript('/branch name only', env)
    await runScript('/checkpoint', env)
    await runScript('/checkpoint 3', env)
    expect(calls.renamed).toEqual(['New Title'])
    expect(calls.branched).toEqual([
      [undefined, undefined],
      [4, undefined],
      [4, 'alt name'],
      [undefined, 'name only'],
    ])
    expect(calls.checkpoints).toEqual([undefined, 3])
    await expect(runScript('/rename', env)).rejects.toThrow('/rename requires a name')
  })

  it('/listvar /flushvar /run forward to the env', async () => {
    const calls = makeCalls()
    const env = makeActionEnv(calls)
    const listed = await runScript('/listvar', env)
    expect(listed.output).toBe('a=1\nb=2')
    expect(listed.chatChanged).toBe(false)
    await runScript('/flushvar', env)
    await runScript('/run my-set', env)
    await runScript('/qr other-set', env)
    expect(calls.listed).toBe(1)
    expect(calls.flushed).toBe(1)
    expect(calls.ran).toEqual(['my-set', 'other-set'])
    await expect(runScript('/run', env)).rejects.toThrow('/run requires a quick reply set name')
  })

  it('/times repeats the nested command and aggregates output/chatChanged', async () => {
    const env = makeActionEnv(makeCalls())
    const counted = await runScript('/times 3 /incvar counter', env)
    expect(counted.chatChanged).toBe(true)
    expect(env.getVar('counter')).toBe(3)

    const sent = makeEnv()
    const repeated = await runScript('/times 2 /send hi', sent)
    expect(repeated.chatChanged).toBe(true)
    expect(sent.sent).toEqual(['hi', 'hi'])

    await expect(runScript('/times nope /echo hi', env)).rejects.toThrow('/times expects a count')
    await expect(runScript('/times', env)).rejects.toThrow('/times expects a count')
    await expect(runScript('/times 100000 /echo hi', env)).rejects.toThrow('/times count is too large')
  })

  it('/while reports unsupported instead of half-implementing a loop', async () => {
    await expect(runScript('/while left=1 right=1 op=== then="/echo hi"', makeEnv()))
      .rejects.toThrow('/while is not supported')
  })

  it('new commands report unsupported when the environment lacks the capability', async () => {
    const env = makeEnv()
    await expect(runScript('/continue', env)).rejects.toThrow('/continue is not available')
    await expect(runScript('/swipe', env)).rejects.toThrow('/swipe is not available')
    await expect(runScript('/hide 0-1', env)).rejects.toThrow('/hide is not available')
    await expect(runScript('/unhide 0-1', env)).rejects.toThrow('/unhide is not available')
    await expect(runScript('/move 0 1', env)).rejects.toThrow('/move is not available')
    await expect(runScript('/rename x', env)).rejects.toThrow('/rename is not available')
    await expect(runScript('/branch', env)).rejects.toThrow('/branch is not available')
    await expect(runScript('/checkpoint', env)).rejects.toThrow('/checkpoint is not available')
    await expect(runScript('/listvar', env)).rejects.toThrow('/listvar is not available')
    await expect(runScript('/flushvar', env)).rejects.toThrow('/flushvar is not available')
    await expect(runScript('/run set', env)).rejects.toThrow('/run is not available')
    await expect(runScript('/qr set', env)).rejects.toThrow('/qr is not available')
  })
})
