// 多Agent推演：基于宿主 SubAgent seam（ctx.subagents）的 in-process spawn 驱动，
// 为每个推演角色派生一个一次性子 Agent。角色只见场景与角色简报，不携带
// 父会话上下文（spawn 语义），工具被 toolFilter 清空以保持纯推理；跨轮
// 传导靠本模块维护的无状态 transcript，不依赖 continuable 持久化。综合
// 由调用方（RP 主 Agent）完成——它才是叙事者，本工具只回传各轮角色站位。

export const DEDUCE_PROVIDER = 'spawn'
export const DEDUCE_MAX_ROLES = 5
export const DEDUCE_MIN_ROLES = 2
export const DEDUCE_MAX_ROUNDS = 3
export const DEDUCE_POSITION_LIMIT = 4000

export interface DeductionRole {
  name: string
  brief: string
}

export interface DeductionRequest {
  scenario: string
  roles: DeductionRole[]
  rounds: number
}

export interface DeductionPosition {
  name: string
  round: number
  text: string
}

export interface DeductionFailure {
  name: string
  round: number
  stopReason: string
  diagnostic?: string
}

export interface DeductionResult {
  scenario: string
  rounds: number
  roleCount: number
  positions: DeductionPosition[]
  failures: DeductionFailure[]
  truncated: boolean
}

export interface SubagentRuntimeLike {
  start(provider: string, request: {
    label?: string
    prompt: ContentBlockLike[]
    parent: unknown
    signal: AbortSignal
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
  }): Promise<SubagentRunLike>
}

export interface SubagentRunLike {
  id: string
  result: Promise<{ output: ContentBlockLike[]; stopReason: string; diagnostic?: string }>
  dispose(): Promise<void>
}

export interface ContentBlockLike {
  type?: string
  text?: string
}

export interface DeductionExecAgent {
  id?: string
  ctx?: {
    subagents?: unknown
    get?: (name: string) => unknown
  }
}

/**
 * 从调用方 Agent 的作用域 ctx 上探测宿主 SubagentRuntime。运行时探针，
 * 不 inject 声明——未部署 dsh-subagent 的宿主上本工具给出明确报错而不是
 * 让插件加载失败。
 */
export function subagentRuntimeOf(parent: DeductionExecAgent | undefined): SubagentRuntimeLike | undefined {
  const ctx = parent?.ctx
  if (!ctx) return undefined
  const direct = ctx.subagents
  if (isRuntime(direct)) return direct
  try {
    const looked = ctx.get?.('subagents')
    if (isRuntime(looked)) return looked as SubagentRuntimeLike
  } catch {
    // 未部署 subagent 服务时 get 可能抛错；按缺失处理。
  }
  return undefined
}

function isRuntime(candidate: unknown): candidate is SubagentRuntimeLike {
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as SubagentRuntimeLike).start === 'function'
}

export function parseDeductionRequest(args: Record<string, unknown>): DeductionRequest {
  const scenario = boundedText(args.scenario, 2000, 'scenario')
  const rawRoles = args.roles
  if (!Array.isArray(rawRoles) || rawRoles.length < DEDUCE_MIN_ROLES) {
    throw new Error(`roles requires at least ${DEDUCE_MIN_ROLES} entries`)
  }
  if (rawRoles.length > DEDUCE_MAX_ROLES) {
    throw new Error(`roles accepts at most ${DEDUCE_MAX_ROLES} entries`)
  }
  const roles = rawRoles.map((entry) => {
    const role = entry as Record<string, unknown>
    return {
      name: boundedText(role?.name, 80, 'role name'),
      brief: boundedText(role?.brief, 1500, 'role brief'),
    }
  })
  const names = new Set(roles.map((role) => role.name))
  if (names.size !== roles.length) throw new Error('deduction role names must be unique')
  let rounds = 1
  if (Number.isInteger(args.rounds)) rounds = Math.max(1, Math.min(DEDUCE_MAX_ROUNDS, args.rounds as number))
  return { scenario, roles, rounds }
}

/**
 * 无状态多轮推演。每一轮内全部角色并行派生一次性子 Agent；后续轮把此前
 * 各轮的站位写进角色 prompt 形成交叉推演。任何单角色失败不阻断其余角色，
 * 全员失败才抛错。所有 run 在 settle 后立即 dispose。
 */
export async function runDeduction(deps: {
  subagents: SubagentRuntimeLike
  parent: unknown
  signal?: AbortSignal
}, request: DeductionRequest): Promise<DeductionResult> {
  const { subagents, parent } = deps
  const signal = deps.signal ?? new AbortController().signal
  const positions: DeductionPosition[] = []
  const failures: DeductionFailure[] = []
  const transcript: DeductionPosition[] = []
  let truncated = false

  for (let round = 1; round <= request.rounds; round += 1) {
    signal.throwIfAborted()
    const settled = await Promise.all(request.roles.map(async (role) => {
      let run: SubagentRunLike | undefined
      try {
        run = await subagents.start(DEDUCE_PROVIDER, {
          label: `dsh-tavern deduce · ${role.name}`,
          prompt: [{ type: 'text', text: roleRoundPrompt({ role, scenario: request.scenario, round, transcript }) }],
          parent,
          signal,
          toolFilter: { allow: [] },
        })
        const result = await run.result
        return { role, result }
      } finally {
        await run?.dispose().catch(() => {})
      }
    }))
    for (const entry of settled) {
      if (entry.result.stopReason !== 'completed') {
        failures.push({
          name: entry.role.name,
          round,
          stopReason: entry.result.stopReason,
          ...(entry.result.diagnostic !== undefined ? { diagnostic: entry.result.diagnostic } : {}),
        })
        continue
      }
      const text = textOf(entry.result.output)
      if (text === '') {
        failures.push({ name: entry.role.name, round, stopReason: 'empty-output' })
        continue
      }
      const clipped = text.length > DEDUCE_POSITION_LIMIT
      if (clipped) truncated = true
      positions.push({ name: entry.role.name, round, text: text.slice(0, DEDUCE_POSITION_LIMIT) })
      transcript.push(positions[positions.length - 1]!)
    }
  }
  if (positions.length === 0) {
    const detail = failures[0]?.diagnostic ?? failures[0]?.stopReason ?? 'no detail'
    throw new Error(`all deduction roles failed: ${detail}`)
  }
  return { scenario: request.scenario, rounds: request.rounds, roleCount: request.roles.length, positions, failures, truncated }
}

export function roleRoundPrompt(input: {
  role: DeductionRole
  scenario: string
  round: number
  transcript: readonly DeductionPosition[]
}): string {
  const { role, scenario, round, transcript } = input
  const lines = [
    `You are "${role.name}" in a multi-role scenario deduction exercise.`,
    `Role brief: ${role.brief}`,
    `Scenario to deduce: ${scenario}`,
    '',
    'This is a hypothetical exercise inside a roleplay session. Tools are unavailable here: do not call tools, and never mention tools, memory, or the exercise mechanics in your answer.',
    'Speak only as this role, first person. In at most 3 sentences: what you perceive, what you want, what you do next, and the outcome you predict.',
  ]
  if (round > 1) {
    lines.push('', `Round ${round} of the deduction. Positions from earlier rounds:`)
    for (const entry of transcript) {
      lines.push(`[round ${entry.round}] ${entry.name}: ${entry.text}`)
    }
    lines.push(`Continue as "${role.name}" in round ${round}: react to the other positions (hold, adapt, or counter) and sharpen your predicted outcome. At most 3 sentences.`)
  }
  return lines.join('\n')
}

function textOf(output: ContentBlockLike[]): string {
  return output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim().slice(0, max)
}
