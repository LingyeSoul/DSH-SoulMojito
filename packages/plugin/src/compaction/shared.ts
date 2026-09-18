/**
 * AgentTavern compaction curator 的纯数据部分：不依赖任何宿主包，
 * 可被单元测试直接导入。宿主 dsh-compaction-basic 的摘要是编码助手导向的
 * （Files and Code / Pending Jobs），会把角色扮演状态摘要掉；这里提供
 * RP 检查点模板与其余配置切分，以及 usage 锚定的压力闸门决策
 * （docs/proposals/0006-usage-anchored-compaction-pressure.md）。
 */

/** 与宿主 basic 包相同的 checkpoint 包裹标签；摘要规则需要引用它识别旧检查点。 */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'

export const RP_COMPACTION_INSTRUCTION = [
  'You are now acting as the compaction curator for this AgentTavern roleplay session. Condense the conversation ABOVE into a structured checkpoint that lets the same character resume the story with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Story So Far',
  "- [the plot in order: key events, turning points, and what changed for the user's character]",
  '',
  '## Characters',
  "- [per recurring character: identity, relationship to the user's character, current location, state (health, possessions, mood), promises and debts]",
  '',
  '## World Canon',
  '- [established facts from world books and narration: places, factions, powers, items, history. Only what was established; never invent.]',
  '',
  '## Open Threads',
  '- [unresolved situations, unanswered questions, foreshadowing, pending decisions]',
  '',
  '## Current Scene',
  '- [time, place, who is present, the exact situation at this checkpoint]',
  '',
  '## Memory Maintenance',
  '- [what was recorded with the memory or variable tools, and which significant facts above are still unrecorded and should be written next]',
  '',
  '## Critical Context',
  '- [user instructions about style, pacing, content boundaries, and anything the user asked to remember]',
  '',
  'Rules:',
  '- Write in the same language as the conversation.',
  '- Preserve names, titles, numbers, and quoted phrases verbatim.',
  '- Record only what the conversation established; do not add interpretation or invent facts.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** curator 专属配置键；不属于宿主 dsh-compaction-basic 的配置契约。 */
export const CURATOR_CONFIG_KEYS = ['curatorProvider', 'curatorModel', 'curatorMaxTokens', 'usageThresholdRatio'] as const

export interface CuratorOptions {
  curatorProvider?: string
  curatorModel?: string
  curatorMaxTokens?: number
  /** 真实用量闸门比例（提案 0006 §4.3），(0,1]，缺省 DEFAULT_USAGE_THRESHOLD_RATIO。 */
  usageThresholdRatio?: number
}

/** 从整行配置中分离 curator 专属键与其余宿主 basic 配置；非法值静默丢弃。 */
export function splitCuratorConfig(config: Record<string, unknown>): { curator: CuratorOptions; basic: Record<string, unknown> } {
  const curator: CuratorOptions = {}
  const basic: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'curatorProvider') {
      if (typeof value === 'string' && value.trim() !== '') curator.curatorProvider = value
    } else if (key === 'curatorModel') {
      if (typeof value === 'string' && value.trim() !== '') curator.curatorModel = value
    } else if (key === 'curatorMaxTokens') {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) curator.curatorMaxTokens = value
    } else if (key === 'usageThresholdRatio') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1) curator.usageThresholdRatio = value
    } else {
      basic[key] = value
    }
  }
  return { curator, basic }
}

//#region usage 锚定压力闸门（docs/proposals/0006-usage-anchored-compaction-pressure.md §4）

/**
 * 宿主 dsh-token-meter `contextPressure` 投影（state v4）的最小读取面。
 * 可选字段缺失表示会话尚无真实 usage 样本、或宿主状态形状已漂移。
 */
export interface UsagePressureState {
  /** 最近一次请求的真实 prompt 用量（input + cacheRead + cacheWrite）。 */
  pressureTokens?: number
  /** 采样时点的启发式表面总量；与 pressureTokens 同时落盘。 */
  sampledSurfaceTokens?: number
  /** 当前启发式表面总量（带压缩影子价修正）。 */
  surfaceTokens?: number
  /** 最近 request/context 申报的模型窗口。 */
  contextWindow?: number
}

/** 真实用量闸门对宿主压力触发的三态决策。 */
export type PressureDecision =
  | { kind: 'delegate' }
  | { kind: 'block' }
  | { kind: 'passthrough' }

/** 闸门默认比例：真实值无估算误差，30% 余量覆盖单步增长；pre-step 每步重查。 */
export const DEFAULT_USAGE_THRESHOLD_RATIO = 0.7

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 镜像宿主 wire view 的"下一次请求"占用估计（不得自创公式）：
 * max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)；样本或采样点
 * 缺失返回 undefined（无法锚定），surfaceTokens 缺失时按采样点退化（公式即样本本身）。
 */
export function projectedPressureTokens(state: UsagePressureState): number | undefined {
  if (!finiteNumber(state.pressureTokens) || !finiteNumber(state.sampledSurfaceTokens)) return undefined
  const surface = finiteNumber(state.surfaceTokens) ? state.surfaceTokens : state.sampledSurfaceTokens
  return Math.max(0, state.pressureTokens + surface - state.sampledSurfaceTokens)
}

/**
 * 真实用量闸门决策：投影可锚定时，projected ≥ ratio × contextWindow 才放行
 * 宿主压力压缩（delegate），否则拦截（block）；无法锚定一律 passthrough
 * （冷启动会话、投影未注册、宿主服务缺失、窗口非法）。
 */
export function usagePressureDecision(state: UsagePressureState | undefined, usageThresholdRatio: number): PressureDecision {
  if (state === undefined || !finiteNumber(state.contextWindow) || state.contextWindow <= 0) return { kind: 'passthrough' }
  const projected = projectedPressureTokens(state)
  if (projected === undefined) return { kind: 'passthrough' }
  return projected >= usageThresholdRatio * state.contextWindow ? { kind: 'delegate' } : { kind: 'block' }
}

//#endregion

//#region 剧情会话判定（提案 0006 §6）

/** 会话绑定的最小读取面：字段宽容，存储层是权威形状。 */
export interface StoryBindingShape {
  architecture?: unknown
  group?: unknown
  novelId?: unknown
}

/**
 * 剧情会话判定：AgentTavern 非分组会话，或绑定完整的 AgentNovel 作者会话
 * （novelId 缺失或空白的 novel 绑定视为非法，回落宿主默认摘要）。
 */
export function isStorySessionBinding(binding: StoryBindingShape | undefined): boolean {
  if (binding === undefined || typeof binding !== 'object') return false
  if (binding.architecture === 'agent-novel') {
    return typeof binding.novelId === 'string' && binding.novelId.trim() !== ''
  }
  return binding.architecture === 'agent-tavern' && binding.group !== true
}

//#endregion

//#region 剧情会话摘要目标解析（提案 0006 §4.3 运行时覆盖）

/** 已解析的摘要调用目标。 */
export interface SummarizerTarget {
  provider: string
  model: string
}

/** 摘要目标解析的候选层：运行时覆盖 > 部署层静态配置 > 会话路由 > agent 选项。 */
export interface SummarizerTargetLayers {
  /** Tavern 面板写入的运行时覆盖（TavernStore state.compaction）。 */
  runtime?: { curatorProvider?: unknown; curatorModel?: unknown }
  /** 部署层 curator 行配置（profile patch）。 */
  config?: CuratorOptions
  /** 会话最近一次请求头里的路由目标。 */
  routed?: { provider?: unknown; model?: unknown }
  /** agent 构造选项携带的模型。 */
  agentOptions?: { provider?: unknown; model?: unknown }
}

function targetPair(provider: unknown, model: unknown): SummarizerTarget | undefined {
  return typeof provider === 'string' && provider.trim().length > 0
    && typeof model === 'string' && model.trim().length > 0
    ? { provider, model }
    : undefined
}

/**
 * 逐层解析剧情会话的摘要目标；全部缺失返回 undefined（调用方 fail-closed
 * 报"no provider/model available"）。半空的 provider/model 对一律忽略。
 */
export function mergeSummarizerTarget(layers: SummarizerTargetLayers): SummarizerTarget | undefined {
  return targetPair(layers.runtime?.curatorProvider, layers.runtime?.curatorModel)
    ?? targetPair(layers.config?.curatorProvider, layers.config?.curatorModel)
    ?? targetPair(layers.routed?.provider, layers.routed?.model)
    ?? targetPair(layers.agentOptions?.provider, layers.agentOptions?.model)
}

//#endregion
