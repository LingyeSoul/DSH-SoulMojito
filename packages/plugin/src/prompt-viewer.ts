/**
 * 提示词查看器（A-6，2026-10-11）：ST 生成循环的调试眼睛。
 *
 * 记录每轮**实际发给 LLM 的最终请求**（pre-llm hook 全部跑完之后、llm.stream
 * 之前——mod 改写后的实发形状，看到即实发）与世界书激活轨迹（loreTrace），
 * 管理面板「提示词」分区经 `GET /api/dsh-soulmojito/prompts` 只读查看。
 *
 * 纪律（decisions/2026-10-11-prompt-viewer.md）：
 * - **纯观察**：记录失败被整体吞掉 + 宿主日志一行，绝不影响生成路径
 *   （stream-delta / Mod 日志缓冲同款「只观察不反噬」纪律）；
 * - **内存态**：进程内环形缓冲，每聊天保留最近 10 条、总量封顶 50（FIFO 淘汰），
 *   重启即失——与 Mod 日志查看器的客户端环形缓冲同款取舍，不落盘；
 * - **跨 bundle 单实例**：本模块被 index.mjs（ST 循环记录 + prompts 路由）与
 *   agent.mjs（Agent 模式记录）各打包一份，模块级变量互不可见——缓冲必须锚定
 *   globalThis（Symbol.for，同 cross-bundle-events / mods-cross-bundle 纪律），
 *   否则面板只能读到本 bundle 写入的那一半（Agent 会话记录恒空，2026-10-21
 *   线上症状：发消息后查看器永远「暂无记录」）；
 * - **范围**：ST 循环记录完整实发请求；Agent 模式（mode='agent-tavern'，
 *   决策 2026-10-11-agent-prompt-viewer）记录**插件预注入面**——LLM 请求由
 *   宿主 AgentLoop 发出，宿主拼装的完整请求（system 头物化 + 历史 projection）
 *   插件不可见，能看到并如实记录的是：systemPrompt section/context 装配文本、
 *   pre-step 插件注入消息、agent/request 链尾实发调用配置（面板如实标注）。
 */

import type { ActivationResult } from '../../tavern-lore/src/index.js'

/** 每聊天保留的最近记录数。 */
export const PROMPT_VIEWER_PER_CHAT = 10
/** 进程内总记录上限（跨聊天合计，FIFO 淘汰最旧）。 */
export const PROMPT_VIEWER_TOTAL = 50

/** 单条消息的文本形态（脱壳：role + content 纯文本，非文本块记占位标记）。 */
export interface PromptViewerMessage {
  role: string
  content: string
}

/** loreTrace 单条激活条目：字段以 lore 包 ActivationResult 实际可得为准。 */
export interface PromptViewerLoreEntry {
  /** 来源书标识（book.name 或 #index）。 */
  world: string
  /** 条目 uid（书内编号）。 */
  uid: number
  /** 条目名（entry.comment / Memo；无 Memo 时为空串）。 */
  name: string
  /** 命中的主键词。 */
  matchedKeys: string[]
  /** 插入位置（WI_POSITION 原始数值，面板侧映射标签）。 */
  position: number
  /** position=4 时的深度。 */
  depth: number
  /** 插入顺序（越大越靠近上下文末端）。 */
  order: number
  /** 激活原因（constant / primary-key / primary-and-secondary / sticky / decorator）。 */
  reason: string
  /** 蓝灯常驻条目。 */
  constant: boolean
  /** 概率结果：use=是否参与掷骰、value=配置概率、roll=实际掷值（参与掷骰且
   *  引擎记录时才有——sticky 旁路不掷）。probability=100 的默认条目不带此块。 */
  probability?: { use: boolean; value: number; roll?: number }
  /** 是否经递归轮激活（INITIAL 轮为 false；不含来源链——引擎不追踪）。 */
  viaRecursion?: boolean
}

/** 世界书激活轨迹（同轮 prompt-viewer 记录对齐）。 */
export interface PromptViewerLoreTrace {
  entries: PromptViewerLoreEntry[]
  /** 扫描总轮数（INITIAL + RECURSION + MIN_ACTIVATIONS）。 */
  scanRounds: number
  /** 其中 RECURSION 轮数。 */
  recursionRounds: number
  /** 激活内容实际占用 token（lore 包估算口径）。 */
  budgetUsed: number
  /** 全局预算上限（含 cap 截断后）。 */
  budgetLimit: number
}

/** 一轮生成的实发请求记录（JSON 可序列化的纯数据）。 */
export interface PromptViewerRecord {
  /** 记录时刻（ISO 时间戳）。 */
  at: string
  /** 进程内单调序号（同毫秒内也可定序）。 */
  seq: number
  character: string
  chatId: string
  mode: string
  /** 实发 system 段（无则 undefined——与请求的「无内容不带键」语义一致）。 */
  system: string | undefined
  messages: PromptViewerMessage[]
  /** 实发采样参数（provider/model/temperature 等；无密钥类字段，见 sanitizeParams）。 */
  params: Record<string, unknown>
  /** token 估算（system + 全部消息，approximateTokens 同公式）。 */
  promptTokens: number
  loreTrace: PromptViewerLoreTrace | undefined
  /** Agent 模式补充面（ST 循环记录恒 undefined）。 */
  agent: PromptViewerAgentFace | undefined
}

/** Agent 模式预注入面的单个 systemPrompt section/context 装配快照。 */
export interface PromptViewerAgentSection {
  /** section 名（内置五段 dsh-soulmojito:agent-* / mod 段 dsh-soulmojito:mod:*）。 */
  name: string
  /** 注册 order（宿主拼装序）。 */
  order: number
  /** 装配文本（空文本段已摘除——与宿主对空 context 的摘除语义一致）。 */
  text: string
}

/** Agent 模式（mode='agent-tavern'）记录的补充面：宿主拼装的完整请求不可见
 *  （上下文是宿主 projection），此处是插件预注入面的结构化明细——system 字段
 *  是 sections 文本的 '\n\n' 拼接（供 token 估算与快速浏览），分面明细以本块为准。 */
export interface PromptViewerAgentFace {
  /** 宿主会话 id（= sessionBindings 绑定键）。 */
  sessionId: string | undefined
  /** 最近一次 agent/pre-step 的轮标记（宿主 payload 未携带时 undefined）。 */
  turn: number | undefined
  /** 最近一次 agent/pre-step 的步标记。 */
  step: number | undefined
  /** systemPrompt section/context 装配快照（按 order 升序，含 mod section）。 */
  sections: PromptViewerAgentSection[]
}

/** 记录点输入：request 即 pre-llm dispatch 之后的实发请求对象；lore 为本轮
 *  激活结果（loreTrace 的构建也在 recordPromptView 的守护区内完成——记录路径
 *  的任何一环，包括 trace 提取，都不允许击穿生成）。Agent 模式记录由
 *  agent-tavern 侧合成（agent.ts 的 recordAgentTavernPromptViewFor），request
 *  三字段填预注入面内容，agent 块带结构化明细。 */
export interface PromptViewerInput {
  character: string
  chatId: string
  mode: string
  request: { messages?: unknown; system?: unknown; params?: unknown }
  lore?: ActivationResult
  agent?: PromptViewerAgentFace
}

type HostLogger = { warn?: (message: string) => unknown }

/* ------------------------------ 环形缓冲 ------------------------------ */

/**
 * 跨 bundle 共享状态锚点（key 逐字稳定，不得改名）。index.mjs 与 agent.mjs
 * 各有一份 prompt-viewer.ts 的打包产物；Symbol.for 是同一 realm 内的全局键，
 * 两份产物因此共读同一份 records / seq / 故障注入槽。
 */
const PROMPT_VIEWER_STATE_KEY = Symbol.for('dsh-soulmojito:prompt-viewer')

interface PromptViewerState {
  records: PromptViewerRecord[]
  nextSeq: number
  /** 测试专用故障注入（生产恒 undefined）：让记录路径抛错以验证吞错纪律。 */
  faultInjector?: () => void
}

function viewerState(): PromptViewerState {
  const holder = globalThis as Record<symbol, PromptViewerState | undefined>
  return (holder[PROMPT_VIEWER_STATE_KEY] ??= { records: [], nextSeq: 1 })
}

/**
 * 记录一轮实发请求。**永不抛错**：任何失败被吞掉并向宿主日志写一行
 * （logger 可缺省）——调试眼睛瞎了不能带瞎生成。
 */
export function recordPromptView(input: PromptViewerInput, logger?: HostLogger): void {
  try {
    const state = viewerState()
    state.faultInjector?.()
    const messages = normalizeMessages(input.request?.messages)
    const system = typeof input.request?.system === 'string' ? input.request.system : undefined
    const record: PromptViewerRecord = {
      at: new Date().toISOString(),
      seq: state.nextSeq++,
      character: String(input.character),
      chatId: String(input.chatId),
      mode: String(input.mode),
      system,
      messages,
      params: sanitizeParams(input.request?.params),
      promptTokens: approximateTokens(system ?? '') + messages.reduce((sum, m) => sum + approximateTokens(m.content), 0),
      // loreTrace 提取也在本 try 内：trace 构建抛错同样被吞掉，绝不反噬生成。
      loreTrace: input.lore === undefined ? undefined : buildLoreTrace(input.lore),
      // Agent 模式补充面浅拷贝入缓冲：与调用方后续持有对象隔离（纯防御）。
      agent: input.agent === undefined ? undefined : { ...input.agent, sections: input.agent.sections.map((section) => ({ ...section })) },
    }
    state.records.push(record)
    // 每聊天保留最近 PER_CHAT 条（FIFO：淘汰同 chatId 最旧）。
    const records = state.records
    let perChat = 0
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]!.chatId === record.chatId) perChat++
      if (perChat > PROMPT_VIEWER_PER_CHAT) {
        records.splice(i, 1)
        perChat--
      }
    }
    // 总量封顶 TOTAL（FIFO：淘汰全局最旧）。
    if (records.length > PROMPT_VIEWER_TOTAL) state.records = records.slice(records.length - PROMPT_VIEWER_TOTAL)
  } catch (error) {
    logger?.warn?.(`dsh-soulmojito: prompt-viewer record failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 查询记录：可选过滤，按时间倒序（seq 降序——最新在前）。 */
export function listPromptViews(filter: { character?: string; chatId?: string } = {}): PromptViewerRecord[] {
  return viewerState().records
    .filter((record) =>
      (filter.character === undefined || record.character === filter.character)
      && (filter.chatId === undefined || record.chatId === filter.chatId))
    .slice()
    .sort((a, b) => b.seq - a.seq)
}

/** 清空缓冲（测试隔离用）。 */
export function resetPromptViews(): void {
  const state = viewerState()
  state.records = []
  state.nextSeq = 1
}

/** 测试专用：注入记录路径故障（传 undefined 清除）。 */
export function setPromptViewerFaultInjector(fn?: () => void): void {
  viewerState().faultInjector = fn
}

/* --------------------------- loreTrace 提取 --------------------------- */

/**
 * 从 lore 包激活结果提取追踪轨迹。只收**已激活**条目；未激活候选的逐条诊断
 * （含概率未过、预算淘汰）不在 v1 记录面——lore 包 diagnostics 可得，留作 v2。
 */
export function buildLoreTrace(lore: ActivationResult): PromptViewerLoreTrace {
  const diagnostics = lore.diagnostics?.entries ?? {}
  const entries: PromptViewerLoreEntry[] = lore.allActivated.map((entry) => {
    const raw = entry.entry as { constant?: boolean; useProbability?: boolean; probability?: number }
    const diag = diagnostics[entry.entryId]
    const useProbability = raw.useProbability === true
    const probabilityValue = typeof raw.probability === 'number' ? raw.probability : 100
    return {
      world: entry.book,
      uid: entry.uid,
      name: typeof entry.entry?.comment === 'string' ? entry.entry.comment : '',
      matchedKeys: [...entry.matchedKeys],
      position: entry.position,
      depth: entry.depth,
      order: entry.order,
      reason: entry.activationReason,
      constant: raw.constant === true,
      ...(useProbability && probabilityValue < 100 ? { probability: { use: true, value: probabilityValue, ...(diag?.probabilityRoll !== undefined ? { roll: diag.probabilityRoll } : {}) } } : {}),
      ...(entry.viaRecursion !== undefined ? { viaRecursion: entry.viaRecursion } : {}),
    }
  })
  return {
    entries,
    scanRounds: lore.diagnostics?.scanRounds ?? 0,
    recursionRounds: lore.diagnostics?.recursionRounds ?? 0,
    budgetUsed: lore.diagnostics?.budgetUsed ?? 0,
    budgetLimit: lore.diagnostics?.budgetLimit ?? 0,
  }
}

/* ------------------------------ 内部 ------------------------------ */

/**
 * token 估算：与 agent-tavern/agent.ts 的 approximateTokens 同公式
 * （Math.max(1, Math.ceil(len / 4))，runGeneration 的 countTokens 用
 * len/3.5——两者同为仓库既有「字符长度近似」口径，此处取 agent 侧命名同款）。
 */
function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

/** 消息序列脱壳：role + content 纯文本形态；非文本块记占位标记。 */
function normalizeMessages(messages: unknown): PromptViewerMessage[] {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    const record = (message ?? {}) as { role?: unknown; content?: unknown }
    return {
      role: typeof record.role === 'string' ? record.role : 'unknown',
      content: normalizeContent(record.content),
    }
  })
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        const type = block !== null && typeof block === 'object' ? String((block as { type?: unknown }).type ?? 'unknown') : 'unknown'
        return `[${type} block]`
      })
      .join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text
  }
  return '[non-text content]'
}

/**
 * 采样参数净化复制。llm.stream 走宿主路由，实发 params 本就不含密钥
 * （provider/model/temperature/maxTokens/reasoningEffort，index.ts llmRequest
 * 构造点核实）；但 pre-llm hook 可注入任意键，防御性丢弃密钥样键名 + 非原始值
 * 字符串化，保证记录面永不成为密钥泄漏面。
 */
const SECRETISH_KEY = /secret|password|authorization|credential|apikey/i

function sanitizeParams(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (SECRETISH_KEY.test(key)) continue
    if (value === undefined) continue
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else {
      try {
        out[key] = JSON.stringify(value)
      } catch {
        out[key] = String(value)
      }
    }
  }
  return out
}
