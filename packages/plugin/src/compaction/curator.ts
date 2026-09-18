/**
 * AgentTavern compaction curator（`dsh-tavern/compaction`）。
 *
 * 宿主 dsh-compaction-basic 的摘要模板是编码助手导向的，对角色扮演会话会把
 * 剧情状态、人物关系和记忆维护习惯摘要掉。本模块继承 basic 引擎，覆写两点：
 * `summarize()`——剧情会话（AgentTavern 非分组、AgentNovel 作者）改用 RP 检查点
 * 模板，其余会话原样透传默认行为；`compactIfNeeded()` 的 pressure 触发——改用
 * 宿主 contextPressure 投影的真实 usage 锚定闸门，取代对中文严重低估的启发式
 * 估算（docs/proposals/0006-usage-anchored-compaction-pressure.md）。压缩机制
 * 本身（prune、保留预算、重试循环）全部委托宿主实现。
 *
 * 宿主 peer 依赖（dsh-compaction-basic / dsh-llm）不打包、也不做静态 bare
 * import：`link:` 挂载下插件真实路径在宿主 profile 之外，Node 的 parent
 * 目录解析碰不到宿主 node_modules。改为运行时从宿主安装锚（process.argv[1]）
 * 解析后按 URL 动态 import——ESM 缓存按 URL 取模，拿到的是与宿主完全相同的
 * 模块实例（Service/类身份零漂移）；锚不可用时回退标准解析，覆盖 profile
 * 物理安装（closure fallback）形态。
 *
 * 隔离说明：本文件属于宿主 compaction 服务替换，不属于 AgentTavern 生成
 * 路径（gates 的 agent-tavern-isolation 因此不扫描本目录）；摘要调用与
 * 宿主 basic 的默认 summarizer 同为 ctx.llm.stream 辅助调用。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { importHostPackage } from '../../../bind/src/index.js'
import { TavernStore } from '../../../tavern-store/src/index.js'
import {
  DEFAULT_USAGE_THRESHOLD_RATIO,
  RP_COMPACTION_INSTRUCTION,
  isStorySessionBinding,
  mergeSummarizerTarget,
  splitCuratorConfig,
  usagePressureDecision,
  type CuratorOptions,
  type UsagePressureState,
} from './shared.js'

export const name = 'dsh-tavern/compaction'

/** curator 依赖的最小宿主类型面；运行时实例来自宿主安装。 */
interface HostCompactionSummary {
  summary: Array<{ type: 'text'; text: string }>
  rawOutput?: unknown[]
  llmStreamCall?: boolean
  provider: string
  model: string
  maxTokens?: number
  usage?: unknown
}

interface HostCompactionInput {
  system?: unknown
  tools?: readonly unknown[]
  messages: readonly unknown[]
}

interface HostAgent {
  session: {
    id: string
    requestHeader(): { config?: { provider?: string; model?: string } } | undefined
  }
  options?: { provider?: string; model?: string }
}

interface HostBasicEngine {
  new (ctx: unknown, config?: Record<string, unknown>): {
    ctx: any
    config: Record<string, unknown>
    compactIfNeeded(agent: HostAgent, trigger: string, signal?: AbortSignal): Promise<unknown>
    summarize(input: HostCompactionInput, agent: HostAgent, signal?: AbortSignal): Promise<HostCompactionSummary>
  }
}

interface HostBlockAssembler {
  new (): {
    finish: { kind: string; failure?: { message: string; code: string } }
    usage: unknown
    push(chunk: unknown): void
    blocks(): Array<{ type: string; text?: string }>
  }
}

interface HostLlmModule {
  BlockAssembler: HostBlockAssembler
  createUserMessage(options: unknown): unknown
  contentHasImage(blocks: unknown): boolean
  LlmError: new (message: string, code: string) => Error
}

/** 宿主 dsh-compaction-basic 的 basic 配置键集；curator 行配置整体透传该契约。 */
const BASIC_CONFIG_KEYS = new Set([
  'thresholdRatio', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
])

const { BasicCompactionEngine } = await importHostPackage<HostBasicEngine>('@deepseek-ai/dsh-compaction-basic')
const { BlockAssembler, createUserMessage, contentHasImage, LlmError } = await importHostPackage<HostLlmModule>('@deepseek-ai/dsh-llm')

export class TavernCompactionCurator extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  private readonly curator: CuratorOptions
  private readonly usageThresholdRatio: number

  constructor(ctx: unknown, config: Record<string, unknown> = {}) {
    super(ctx, basicConfigOnly(config))
    this.curator = readCuratorOptions(config)
    this.usageThresholdRatio = this.curator.usageThresholdRatio ?? DEFAULT_USAGE_THRESHOLD_RATIO
    info(ctx, `dsh-tavern/compaction curator loaded: usageThresholdRatio=${this.usageThresholdRatio} curatorTarget=${this.curator.curatorProvider ?? ''}/${this.curator.curatorModel ?? '(route)'} summarization=${JSON.stringify((this.config as Record<string, unknown>).summarizationProvider ?? '')}`)
  }

  /**
   * 真实用量闸门（提案 0006 §4.2）：pressure 触发先按 contextPressure 投影决策——
   * 真实压力未到直接拦截（防启发式高估导致过早压缩）；锚定不可用（冷启动、投影
   * 缺失）维持宿主原生行为；真实压力已到则委托宿主压力路径，若宿主启发式门没过
   * （低估超过策略阈值补偿范围）再以 context-overflow 无门限路径兜底一次。
   * context-overflow 触发本身原样透传，宿主溢出恢复不受影响。
   */
  async compactIfNeeded(agent: HostAgent, trigger: string, signal?: AbortSignal): Promise<unknown> {
    if (trigger !== 'pressure') {
      // 溢出恢复路径：宿主 context-overflow 分支用启发式 measure 选 range，对中文
      // 低估可能导致 range=null 静默放弃。这里先打诊断，便于区分"配置未生效"与
      // "宿主启发式选不出可压范围"。
      if (trigger === 'context-overflow') {
        const state = pressureStateOf(this.ctx, agent.session)
        info(this.ctx, `curator overflow-recovery: pressureTokens=${state?.pressureTokens ?? 'none'} surfaceTokens=${state?.surfaceTokens ?? 'none'} contextWindow=${state?.contextWindow ?? 'none'}`)
      }
      return super.compactIfNeeded(agent, trigger, signal)
    }
    const state = pressureStateOf(this.ctx, agent.session)
    const decision = usagePressureDecision(state, this.usageThresholdRatio)
    if (decision.kind === 'block') return null
    if (decision.kind === 'passthrough') return super.compactIfNeeded(agent, trigger, signal)
    const result = await super.compactIfNeeded(agent, trigger, signal)
    if (result !== null && result !== undefined) return result
    try {
      return await super.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (error) {
      warn(this.ctx, `usage-anchored compaction fallback failed: ${messageOf(error)}`)
      return null
    }
  }

  /** 非剧情会话透传宿主默认摘要；剧情会话改用 RP 检查点。 */
  async summarize(input: HostCompactionInput, agent: HostAgent, signal?: AbortSignal): Promise<HostCompactionSummary> {
    if (!(await isStorySession(agent.session.id))) return super.summarize(input, agent, signal)
    return summarizeStoryCheckpoint(this.ctx, this.config, this.curator, input, agent, signal)
  }
}

export default TavernCompactionCurator

/** 行配置只保留宿主 basic 契约键；curator 键单独读取。basic 自身的
 * resolveConfig 会对透传键做 fail-closed 校验，与直接挂载 basic 等价。 */
function basicConfigOnly(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => BASIC_CONFIG_KEYS.has(key)))
}

function readCuratorOptions(config: Record<string, unknown>): CuratorOptions {
  const { curator } = splitCuratorConfig(config)
  return curator
}

/** 容忍式读取宿主 contextPressure 投影状态；服务缺失、抛错或形状漂移一律
 * 返回 undefined（提案 0006 §4.4 降级路径），不新增 static inject 硬依赖。 */
function pressureStateOf(ctx: any, session: HostAgent['session']): UsagePressureState | undefined {
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    return typeof state === 'object' && state !== null ? (state as UsagePressureState) : undefined
  } catch {
    return undefined
  }
}

function warn(ctx: any, message: string): void {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // 宿主 logger 不可用时静默：新增闸门绝不因日志失败打断压缩流程。
  }
}

function info(ctx: any, message: string): void {
  try {
    ctx.logger?.info?.(message)
  } catch {
    // 同上。
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 解析剧情会话摘要目标：面板运行时覆盖（提案 0006 §4.3）> 部署层 curator
 * 行配置 > 会话路由 > agent 选项；存储读取失败时运行时层按未设置处理。 */
async function resolveCuratorTarget(
  config: Record<string, unknown>,
  curator: CuratorOptions,
  agent: HostAgent,
): Promise<{ provider: string; model: string } | undefined> {
  let runtime: { curatorProvider?: string; curatorModel?: string } | undefined
  try {
    runtime = (await (await tavernStore()).getState()).compaction
  } catch {
    runtime = undefined
  }
  const routed = agent.session.requestHeader()?.config
  return mergeSummarizerTarget({
    runtime,
    config: curator,
    routed: { provider: routed?.provider, model: routed?.model },
    agentOptions: { provider: agent.options?.provider, model: agent.options?.model },
  })
}

/** 复刻 basic 默认 summarizer 的调用与 fail-closed 语义，仅替换指令模板。 */
async function summarizeStoryCheckpoint(
  ctx: any,
  config: Record<string, unknown>,
  curator: CuratorOptions,
  input: HostCompactionInput,
  agent: HostAgent,
  signal?: AbortSignal,
): Promise<HostCompactionSummary> {
  const target = resolveCuratorTarget(config, curator, agent)
  if (target === undefined) {
    throw new Error('no provider/model available for AgentTavern story compaction: route one request or set curatorProvider and curatorModel')
  }
  const assembler = new BlockAssembler()
  const messages = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: RP_COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-tavern' },
    }),
  ]
  const maxTokens = curator.curatorMaxTokens
    ?? (typeof config.maxTokens === 'number' ? config.maxTokens : 8192)
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('AgentTavern story compaction produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** 拒绝视觉输出；摘要只保留文本块。 */
function summaryText(blocks: Array<{ type: string; text?: string }>): Array<{ type: 'text'; text: string }> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
}

/** 把摘要终止状态映射为 fail-closed 错误；正常 finish 返回 undefined。 */
function finishError(finish: { kind: string; failure?: { message: string; code: string } }): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const failure = finish.failure ?? { message: 'summarization failed', code: 'UNKNOWN' }
      const error = new Error(failure.message)
      ;(error as Error & { code?: string }).code = failure.code
      return error
    }
    case 'max-tokens':
      return new Error('summarization truncated at the token cap (incomplete checkpoint)')
    default:
      return undefined
  }
}

let tavernStorePromise: Promise<TavernStore> | undefined

function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= TavernStore.open(dshHomePath('tavern')))
}

function dshHomePath(...segments: string[]): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), ...segments)
}

/** 存储缺失、读取失败或绑定不完整时按非剧情会话处理，摘要退回宿主默认行为。 */
async function isStorySession(sessionId: string): Promise<boolean> {
  try {
    const binding = (await (await tavernStore()).getState()).sessionBindings[sessionId]
    return isStorySessionBinding(binding)
  } catch {
    return false
  }
}
