/**
 * AgentTavern compaction curator（`dsh-tavern/compaction`）。
 *
 * 宿主 dsh-compaction-basic 的摘要模板是编码助手导向的，对角色扮演会话会把
 * 剧情状态、人物关系和记忆维护习惯摘要掉。本模块继承 basic 引擎，仅覆写
 * `summarize()`：AgentTavern 绑定的会话改用 RP 检查点模板；其余会话原样
 * 透传默认行为，编码会话零影响。触发时机、保留预算、工具结果修剪等全部
 * 复用宿主实现，本模块不重复 compaction 策略。
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
import { RP_COMPACTION_INSTRUCTION, splitCuratorConfig, type CuratorOptions } from './shared.js'

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

  constructor(ctx: unknown, config: Record<string, unknown> = {}) {
    super(ctx, basicConfigOnly(config))
    this.curator = readCuratorOptions(config)
  }

  /** 非 AgentTavern 会话透传宿主默认摘要；Tavern 会话改用 RP 检查点。 */
  async summarize(input: HostCompactionInput, agent: HostAgent, signal?: AbortSignal): Promise<HostCompactionSummary> {
    if (!(await isAgentTavernSession(agent.session.id))) return super.summarize(input, agent, signal)
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

/** 解析摘要调用目标：curator 专属配置 > 当前路由 > agent 默认。 */
function resolveCuratorTarget(config: Record<string, unknown>, curator: CuratorOptions, agent: HostAgent):
  | { provider: string; model: string }
  | undefined {
  if (curator.curatorProvider !== undefined && curator.curatorModel !== undefined) {
    return { provider: curator.curatorProvider, model: curator.curatorModel }
  }
  const routed = agent.session.requestHeader()?.config
  if (typeof routed?.provider === 'string' && routed.provider.length > 0
    && typeof routed.model === 'string' && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const options = agent.options
  if (typeof options?.provider === 'string' && options.provider.length > 0
    && typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
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

/** 存储缺失或读取失败时按非 Tavern 会话处理，摘要退回宿主默认行为。 */
async function isAgentTavernSession(sessionId: string): Promise<boolean> {
  try {
    const binding = (await (await tavernStore()).getState()).sessionBindings[sessionId]
    return binding !== undefined && binding.architecture === 'agent-tavern' && binding.group !== true
  } catch {
    return false
  }
}
