/**
 * STscript 解释器（命令子集，clean-room 实现可观察语义）。
 *
 * 支持：`|` 管道、双引号参数、`key=value` 命名参数、宏展开（{{pipe}} 管道注入，
 * 其余宏经 env.expand）、递归单命令执行（/if 分支）。
 *
 * 命令集：echo / comment / setvar / getvar / setglobalvar / getglobalvar /
 * addvar / incvar / decvar / hasvar / hasglobalvar / delvar / delglobalvar /
 * if(left/right/op/then/else) / random / roll / pick / send / trigger /
 * regenerate / stop / cut / regex(name=…)。
 *
 * 命令以注册表承载（提案 0015 P0）：内置命令经 registerStscriptCommand 进表，
 * runCommand 做表查找；P1 的 api.stscript.registerCommand 以同一入口落注册。
 */

export type VariableValue = string | number | boolean

export interface ScriptEnv {
  /** 宏展开（{{getvar}}、{{char}} 等由上层宏引擎处理）。 */
  expand: (text: string) => string
  getVar: (name: string) => VariableValue | undefined
  setVar: (name: string, value: VariableValue) => void
  deleteVar: (name: string) => boolean
  getGlobalVar: (name: string) => VariableValue | undefined
  setGlobalVar: (name: string, value: VariableValue) => void
  deleteGlobalVar: (name: string) => boolean
  /** 随机源（random/roll/pick）。 */
  rng?: () => number
  /* ---- 聊天动作（缺省为不支持，命令报错） ---- */
  send?: (text: string) => void | Promise<void>
  trigger?: (member?: string) => void | Promise<void>
  regenerate?: () => void | Promise<void>
  stop?: () => void
  cut?: (from: number, to: number) => void | Promise<void>
  echo?: (text: string) => void
  /**
   * /regex：按名应用 SLASH_COMMAND placement 的正则脚本并返回替换后文本
   * （ST /regex 命令语义：脚本名大小写不敏感；未找到/禁用/位不符原样返回输入）。
   */
  applyRegex?: (scriptName: string, text: string) => string | Promise<string>
}

export interface ScriptResult {
  /** 最后一条命令的输出。 */
  output: string
  /** 是否触发了改变聊天的动作（send/trigger/regenerate/cut）。 */
  chatChanged: boolean
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

/* ------------------------------ 解析 ------------------------------ */

export interface ScriptCommand {
  /** 命令名（不含斜杠，小写）。 */
  name: string
  /** 原始参数串（宏已展开）。 */
  raw: string
  /** 位置参数（引号感知切分）。 */
  args: string[]
  /** 命名参数 key=value。 */
  named: Record<string, string>
}

/** 顶层按 `|` 切分（引号内不切；引号在参数解析时剥除）。 */
function splitPipeline(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of line) {
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.filter((part) => part.trim() !== '')
}

/** 引号感知的空白切分；引号成对时剥除。 */
function splitArgs(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasQuote = false
  const push = () => {
    if (current !== '' || hasQuote) args.push(current)
    current = ''
    hasQuote = false
  }
  for (const char of raw) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasQuote = true
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
  }
  push()
  return args
}

export function parseCommand(part: string, expand: (text: string) => string): ScriptCommand {
  const expanded = expand(part)
  const match = /^\/([a-zA-Z0-9_]+)\s*([\s\S]*)$/.exec(expanded.trim())
  if (match === null) throw new ScriptError(`expected a slash command, got: ${part.trim().slice(0, 40)}`)
  const name = (match[1] ?? '').toLowerCase()
  const raw = (match[2] ?? '').trim()
  const args: string[] = []
  const named: Record<string, string> = {}
  for (const arg of splitArgs(raw)) {
    const pair = /^([a-zA-Z0-9_]+)=([\s\S]*)$/.exec(arg)
    if (pair !== null) named[pair[1] ?? ''] = pair[2] ?? ''
    else args.push(arg)
  }
  return { name, raw, args, named }
}

/* ------------------------------ 执行 ------------------------------ */

const NUMERIC_OPS: Record<string, (a: number, b: number) => boolean> = {  '=': (a, b) => a === b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
}

function truthyString(value: string): string {
  return value === 'true' || value === '1' ? 'true' : 'false'
}

function toNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRoll(spec: string, rng: () => number): number {
  const match = /^(\d*)d(\d+)$/i.exec(spec.trim())
  if (match === null) {
    const single = toNumber(spec.trim())
    if (single !== null) return single
    throw new ScriptError(`invalid roll spec: ${spec}`)
  }
  const count = Math.min(Math.max(Number(match[1] || '1'), 1), 100)
  const sides = Math.max(Number(match[2]), 1)
  let total = 0
  for (let i = 0; i < count; i++) total += Math.floor(rng() * sides) + 1
  return total
}

function pickRandom(list: string[], rng: () => number): string {
  if (list.length === 0) return ''
  return list[Math.floor(rng() * list.length)] ?? ''
}

/** 拆 random/pick 候选：支持逗号与 `::` 两种分隔（ST 两种生态写法）。 */
function splitChoices(raw: string): string[] {
  if (raw.includes('::')) return raw.split('::').map((item) => item.trim()).filter((item) => item !== '')
  return raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
}

/** 解析 /setvar 族目标：`key=value` 命名形态优先，其次位置参数形态。 */
function varTarget(cmd: ScriptCommand): { name: string; value: string } {
  const first = Object.entries(cmd.named)[0]
  if (first !== undefined && cmd.args.length === 0) return { name: first[0], value: first[1] }
  return { name: cmd.args[0] ?? '', value: cmd.args.length > 1 ? cmd.args.slice(1).join(' ') : '' }
}

async function requireAction<T>(env: T | undefined, command: string): Promise<T> {
  if (env === undefined) throw new ScriptError(`/${command} is not available in this context`)
  return env
}

/* --------------------------- 命令表（registry） --------------------------- */

/** 单条命令的执行结果：output 为管道输出，chatChanged 标记是否触发改聊天动作。 */
export interface StscriptCommandResult {
  output: string
  chatChanged: boolean
}

/** 命令处理器可用的共享工具：随机源注入、chatChanged 快捷构造、递归执行入口。 */
export interface StscriptCommandContext {
  rng: () => number
  changed: () => StscriptCommandResult
  runNested: (commandText: string, env: ScriptEnv) => Promise<StscriptCommandResult>
}

export type StscriptCommandHandler = (
  cmd: ScriptCommand,
  env: ScriptEnv,
  tools: StscriptCommandContext,
) => StscriptCommandResult | Promise<StscriptCommandResult>

export interface StscriptCommandSpec {
  /** 主命令名（小写，不含斜杠）。 */
  name: string
  /** 别名（与主名落同一处理器；handler 内按 cmd.name 区分具体调用的名字）。 */
  aliases?: string[]
  run: StscriptCommandHandler
}

/**
 * 命令表（提案 0015 P0：registry 化）。内置命令全部经 registerStscriptCommand
 * 注册，行为与既有固定 switch 逐字一致；runCommand 只做表查找。P2 的
 * api.stscript.registerCommand（含命令名字符集校验、禁覆盖内置命令）以本函数
 * 为落点。返回反注册函数（移除主名与别名的表项）——内置注册方忽略返回值，
 * 形状向后兼容；mod 宿主持反注册并入 dispose 链。
 */
const commandTable = new Map<string, StscriptCommandSpec>()

export function registerStscriptCommand(spec: StscriptCommandSpec): () => void {
  commandTable.set(spec.name, spec)
  for (const alias of spec.aliases ?? []) commandTable.set(alias, spec)
  return () => {
    // 只摘自己那一次注册的表项：mod 重载后再卸载不得误删同名新注册。
    if (commandTable.get(spec.name) === spec) commandTable.delete(spec.name)
    for (const alias of spec.aliases ?? []) {
      if (commandTable.get(alias) === spec) commandTable.delete(alias)
    }
  }
}

/** 当前命令表的只读名单（含别名），按注册序。命令表等价用例的断言面。 */
export function stscriptCommandNames(): string[] {
  return [...commandTable.keys()]
}

const changedResult = (): StscriptCommandResult => ({ output: '', chatChanged: true })

const echoCommand: StscriptCommandSpec = {
  name: 'echo',
  aliases: ['comment'],
  run: (cmd, env) => {
    const text = cmd.raw
    if (cmd.name === 'echo') env.echo?.(text)
    return { output: text, chatChanged: false }
  },
}

const setvarCommand: StscriptCommandSpec = {
  name: 'setvar',
  aliases: ['setglobalvar'],
  run: (cmd, env) => {
    const setter = cmd.name === 'setvar' ? env.setVar : env.setGlobalVar
    const target = varTarget(cmd)
    if (target.name === '') throw new ScriptError(`/${cmd.name} requires a variable name`)
    setter(target.name, target.value)
    return changedResult()
  },
}

const getvarCommand: StscriptCommandSpec = {
  name: 'getvar',
  aliases: ['getglobalvar'],
  run: (cmd, env) => {
    const getter = cmd.name === 'getvar' ? env.getVar : env.getGlobalVar
    const name = cmd.args[0] ?? ''
    if (name === '') throw new ScriptError(`/${cmd.name} requires a variable name`)
    return { output: String(getter(name) ?? ''), chatChanged: false }
  },
}

const addvarCommand: StscriptCommandSpec = {
  name: 'addvar',
  run: (cmd, env) => {
    const target = varTarget(cmd)
    if (target.name === '') throw new ScriptError('/addvar requires a variable name')
    const delta = target.value === '' ? '1' : target.value
    const current = env.getVar(target.name)
    const currentNum = typeof current === 'boolean' ? null : toNumber(String(current ?? ''))
    const deltaNum = toNumber(delta)
    if (current === undefined) {
      env.setVar(target.name, delta)
    } else if (currentNum !== null && deltaNum !== null) {
      env.setVar(target.name, currentNum + deltaNum)
    } else {
      env.setVar(target.name, `${String(current)}${delta}`)
    }
    return changedResult()
  },
}

const incvarCommand: StscriptCommandSpec = {
  name: 'incvar',
  aliases: ['decvar'],
  run: (cmd, env) => {
    const name = cmd.args[0] ?? ''
    const current = toNumber(String(env.getVar(name) ?? '0')) ?? 0
    env.setVar(name, current + (cmd.name === 'incvar' ? 1 : -1))
    return changedResult()
  },
}

const hasvarCommand: StscriptCommandSpec = {
  name: 'hasvar',
  aliases: ['hasglobalvar'],
  run: (cmd, env) => {
    const checker = cmd.name === 'hasvar' ? env.getVar : env.getGlobalVar
    return { output: truthyString(String(checker(cmd.args[0] ?? '') !== undefined)), chatChanged: false }
  },
}

const delvarCommand: StscriptCommandSpec = {
  name: 'delvar',
  aliases: ['delglobalvar'],
  run: (cmd, env) => {
    const remover = cmd.name === 'delvar' ? env.deleteVar : env.deleteGlobalVar
    remover(cmd.args[0] ?? '')
    return changedResult()
  },
}

const ifCommand: StscriptCommandSpec = {
  name: 'if',
  run: async (cmd, env, tools) => {
    const left = cmd.named['left'] ?? cmd.args[0] ?? ''
    const right = cmd.named['right'] ?? cmd.args[1] ?? ''
    const op = (cmd.named['op'] ?? cmd.args[2] ?? '=').trim()
    let passes: boolean
    if (op === 'contains' || op === '!contains') {
      const contains = left.includes(right)
      passes = op === 'contains' ? contains : !contains
    } else {
      const numericOp = NUMERIC_OPS[op]
      if (numericOp === undefined) throw new ScriptError(`unsupported /if op: ${op}`)
      const leftNum = toNumber(left)
      const rightNum = toNumber(right)
      if (leftNum !== null && rightNum !== null) passes = numericOp(leftNum, rightNum)
      else if (op === '=' || op === '==') passes = left === right
      else if (op === '!=') passes = left !== right
      else passes = false // 关系运算需要数字
    }
    const branch = passes ? cmd.named['then'] : (cmd.named['else'] ?? '')
    if (branch === undefined || branch.trim() === '') return { output: '', chatChanged: false }
    return tools.runNested(branch, env)
  },
}

const randomCommand: StscriptCommandSpec = {
  name: 'random',
  run: (cmd, _env, tools) => {
    const raw = cmd.raw.trim()
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(raw)
    if (range !== null) {
      const low = Number(range[1])
      const high = Number(range[2])
      const min = Math.min(low, high)
      return { output: String(min + Math.floor(tools.rng() * (Math.max(low, high) - min + 1))), chatChanged: false }
    }
    return { output: pickRandom(splitChoices(raw), tools.rng), chatChanged: false }
  },
}

const rollCommand: StscriptCommandSpec = {
  name: 'roll',
  run: (cmd, _env, tools) =>
    ({ output: String(parseRoll(cmd.raw.trim() || '1d6', tools.rng)), chatChanged: false }),
}

const pickCommand: StscriptCommandSpec = {
  name: 'pick',
  run: (cmd, _env, tools) => ({ output: pickRandom(splitChoices(cmd.raw), tools.rng), chatChanged: false }),
}

const sendCommand: StscriptCommandSpec = {
  name: 'send',
  run: async (cmd, env) => {
    const action = await requireAction(env.send, 'send')
    await action(cmd.raw)
    return changedResult()
  },
}

const triggerCommand: StscriptCommandSpec = {
  name: 'trigger',
  run: async (cmd, env) => {
    const action = await requireAction(env.trigger, 'trigger')
    await action(cmd.args[0])
    return changedResult()
  },
}

const regenerateCommand: StscriptCommandSpec = {
  name: 'regenerate',
  run: async (_cmd, env) => {
    const action = await requireAction(env.regenerate, 'regenerate')
    await action()
    return changedResult()
  },
}

const stopCommand: StscriptCommandSpec = {
  name: 'stop',
  run: async (_cmd, env) => {
    const action = await requireAction(env.stop, 'stop')
    action()
    return changedResult()
  },
}

const cutCommand: StscriptCommandSpec = {
  name: 'cut',
  run: async (cmd, env) => {
    const action = await requireAction(env.cut, 'cut')
    const range = /^(-?\d+)(?:\s*-\s*(-?\d+))?$/.exec(cmd.raw.trim())
    if (range === null) throw new ScriptError(`/cut expects a range like 0-2, got: ${cmd.raw.trim()}`)
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    await action(Math.min(from, to), Math.max(from, to))
    return changedResult()
  },
}

const regexCommand: StscriptCommandSpec = {
  name: 'regex',
  run: async (cmd, env) => {
    // ST /regex：`/regex name=<script> [text]`（脚本名也接受首位位置参数）；
    // 输入串可由管道注入（{{pipe}} 或末位参数），缺省为空串。
    const action = await requireAction(env.applyRegex, 'regex')
    const name = cmd.named['name'] ?? cmd.args[0] ?? ''
    if (name === '') throw new ScriptError('/regex requires a script name (name=…)')
    const positional = cmd.named['name'] !== undefined ? cmd.args : cmd.args.slice(1)
    return { output: await action(name, positional.join(' ')), chatChanged: false }
  },
}

for (const spec of [
  echoCommand,
  setvarCommand,
  getvarCommand,
  addvarCommand,
  incvarCommand,
  hasvarCommand,
  delvarCommand,
  ifCommand,
  randomCommand,
  rollCommand,
  pickCommand,
  sendCommand,
  triggerCommand,
  regenerateCommand,
  stopCommand,
  cutCommand,
  regexCommand,
]) {
  registerStscriptCommand(spec)
}

/** 执行一条命令；piped 是上一条命令的输出（注入 {{pipe}} 或末位参数）。 */
async function runCommand(command: ScriptCommand, env: ScriptEnv, piped: string | null): Promise<StscriptCommandResult> {
  const withPipe = (): ScriptCommand => {
    if (piped === null || piped === '') return command
    if (command.raw.includes('{{pipe}}')) {
      return { ...command, args: command.args.map((a) => a.replace(/\{\{pipe\}\}/gi, piped)), raw: command.raw.replace(/\{\{pipe\}\}/gi, piped) }
    }
    return { ...command, args: [...command.args, piped], raw: `${command.raw} ${piped}`.trim() }
  }
  const cmd = withPipe()
  const spec = commandTable.get(cmd.name)
  if (spec === undefined) throw new ScriptError(`unknown command: /${cmd.name}`)
  return spec.run(cmd, env, {
    rng: env.rng ?? Math.random,
    changed: changedResult,
    runNested: (commandText, nestedEnv) => runNested(commandText, nestedEnv),
  })
}

async function runNested(commandText: string, env: ScriptEnv): Promise<StscriptCommandResult> {
  const command = parseCommand(commandText, env.expand)
  return runCommand(command, env, null)
}

/** 执行整段脚本（一行或多行；换行视为脚本边界，各自独立执行）。 */
export async function runScript(script: string, env: ScriptEnv): Promise<ScriptResult> {
  const lines = script.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
  let output = ''
  let chatChanged = false
  let executed = false
  for (const line of lines) {
    let piped: string | null = null
    for (const part of splitPipeline(line)) {
      const command = parseCommand(part, env.expand)
      const result = await runCommand(command, env, piped)
      output = result.output
      chatChanged = chatChanged || result.chatChanged
      piped = result.output
      executed = true
    }
  }
  if (!executed) throw new ScriptError('script has no commands')
  return { output, chatChanged }
}
