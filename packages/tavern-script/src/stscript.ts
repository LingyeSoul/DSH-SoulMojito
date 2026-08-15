/**
 * STscript 解释器（命令子集，clean-room 实现可观察语义）。
 *
 * 支持：`|` 管道、双引号参数、`key=value` 命名参数、宏展开（{{pipe}} 管道注入，
 * 其余宏经 env.expand）、递归单命令执行（/if 分支）。
 *
 * 命令集：echo / comment / setvar / getvar / setglobalvar / getglobalvar /
 * addvar / incvar / decvar / hasvar / hasglobalvar / delvar / delglobalvar /
 * if(left/right/op/then/else) / random / roll / pick / send / trigger /
 * regenerate / stop / cut。
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

const NUMERIC_OPS: Record<string, (a: number, b: number) => boolean> = {
  '=': (a, b) => a === b,
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

/** 执行一条命令；piped 是上一条命令的输出（注入 {{pipe}} 或末位参数）。 */
async function runCommand(command: ScriptCommand, env: ScriptEnv, piped: string | null): Promise<{ output: string; chatChanged: boolean }> {
  const withPipe = (): ScriptCommand => {
    if (piped === null || piped === '') return command
    if (command.raw.includes('{{pipe}}')) {
      return { ...command, args: command.args.map((a) => a.replace(/\{\{pipe\}\}/gi, piped)), raw: command.raw.replace(/\{\{pipe\}\}/gi, piped) }
    }
    return { ...command, args: [...command.args, piped], raw: `${command.raw} ${piped}`.trim() }
  }
  const cmd = withPipe()
  const rng = env.rng ?? Math.random
  const changed = (): { output: string; chatChanged: boolean } => ({ output: '', chatChanged: true })

  switch (cmd.name) {
    case 'echo':
    case 'comment': {
      const text = cmd.raw
      if (cmd.name === 'echo') env.echo?.(text)
      return { output: text, chatChanged: false }
    }
    case 'setvar':
    case 'setglobalvar': {
      const setter = cmd.name === 'setvar' ? env.setVar : env.setGlobalVar
      const target = varTarget(cmd)
      if (target.name === '') throw new ScriptError(`/${cmd.name} requires a variable name`)
      setter(target.name, target.value)
      return changed()
    }
    case 'getvar':
    case 'getglobalvar': {
      const getter = cmd.name === 'getvar' ? env.getVar : env.getGlobalVar
      const name = cmd.args[0] ?? ''
      if (name === '') throw new ScriptError(`/${cmd.name} requires a variable name`)
      return { output: String(getter(name) ?? ''), chatChanged: false }
    }
    case 'addvar': {
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
      return changed()
    }
    case 'incvar':
    case 'decvar': {
      const name = cmd.args[0] ?? ''
      const current = toNumber(String(env.getVar(name) ?? '0')) ?? 0
      env.setVar(name, current + (cmd.name === 'incvar' ? 1 : -1))
      return changed()
    }
    case 'hasvar':
    case 'hasglobalvar': {
      const checker = cmd.name === 'hasvar' ? env.getVar : env.getGlobalVar
      return { output: truthyString(String(checker(cmd.args[0] ?? '') !== undefined)), chatChanged: false }
    }
    case 'delvar':
    case 'delglobalvar': {
      const remover = cmd.name === 'delvar' ? env.deleteVar : env.deleteGlobalVar
      remover(cmd.args[0] ?? '')
      return changed()
    }
    case 'if': {
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
      return runNested(branch, env)
    }
    case 'random': {
      const raw = cmd.raw.trim()
      const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(raw)
      if (range !== null) {
        const low = Number(range[1])
        const high = Number(range[2])
        const min = Math.min(low, high)
        return { output: String(min + Math.floor(rng() * (Math.max(low, high) - min + 1))), chatChanged: false }
      }
      return { output: pickRandom(splitChoices(raw), rng), chatChanged: false }
    }
    case 'roll':
      return { output: String(parseRoll(cmd.raw.trim() || '1d6', rng)), chatChanged: false }
    case 'pick':
      return { output: pickRandom(splitChoices(cmd.raw), rng), chatChanged: false }
    case 'send': {
      const action = await requireAction(env.send, 'send')
      await action(cmd.raw)
      return changed()
    }
    case 'trigger': {
      const action = await requireAction(env.trigger, 'trigger')
      await action(cmd.args[0])
      return changed()
    }
    case 'regenerate': {
      const action = await requireAction(env.regenerate, 'regenerate')
      await action()
      return changed()
    }
    case 'stop': {
      const action = await requireAction(env.stop, 'stop')
      action()
      return changed()
    }
    case 'cut': {
      const action = await requireAction(env.cut, 'cut')
      const range = /^(-?\d+)(?:\s*-\s*(-?\d+))?$/.exec(cmd.raw.trim())
      if (range === null) throw new ScriptError(`/cut expects a range like 0-2, got: ${cmd.raw.trim()}`)
      const from = Number(range[1])
      const to = range[2] === undefined ? from : Number(range[2])
      await action(Math.min(from, to), Math.max(from, to))
      return changed()
    }
    default:
      throw new ScriptError(`unknown command: /${cmd.name}`)
  }
}

async function runNested(commandText: string, env: ScriptEnv): Promise<{ output: string; chatChanged: boolean }> {
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
