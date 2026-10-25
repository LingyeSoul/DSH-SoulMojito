/**
 * B-3 记忆维护 Agent：对 chat 作用域记忆做自动纠错/合并/去重的服务端维护 run
 * （compaction curator 同族——宿主 ctx.llm.stream 辅助调用，不是 Mod、不是模型
 * 工具面；工具循环是 run 内部私有的，维护 LLM 是"记忆管理员"角色）。
 *
 * 参考语义来自 LittleWhiteBox 记忆维护 Agent（Apache-2.0，只取机制设计不抄
 * 代码，docs/exploration/2026-10-11-jsr-lwb-reference.md §3.1 A6）：跨批次
 * 事件合并、完成收据（范围并集 + 原文/记录指纹退役）、run 预算纪律。dsh 化
 * 差异记录在 decisions/2026-10-11-memory-maintenance.md。
 *
 * run 纪律：
 * - 预算：单 run 最多 MAINTENANCE_MAX_LLM_REQUESTS 次 LLM 请求（失败也计数）；
 *   开场材料超 MAINTENANCE_OPENING_MAX_CHARS 则预算减半并截断清单；
 * - 模型：ctx.llm.stream 走部署默认模型（agentDefaultModel，v1 不加配置面）；
 *   GenerateOptions.purpose 是宿主封闭枚举，本 run 不带 purpose；
 * - 证据边界：run 开始时捕获聊天快照，ReadSource/SearchSource/完成指纹都只
 *   看这份冻结快照——run 期间的原文追加不进入本次证据；
 * - 生命周期与宿主进程解耦风险：run 开始即把 lastRun 落成 running；进程重启后
 *   注册表为空，状态读取发现"running 但无人注册"就地标 error(interrupted)，
 *   不假装完成；
 * - EditMemory 整组原子提交（预检 + 应用 + 失败回滚），编辑成功记录立即经 B-2
 *   路径重嵌（embedMemoryRecord，失败不阻塞——向量 stale 由既有懒回填兜底）。
 */

import { randomUUID } from 'node:crypto'
import type { ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import type { HostLlmChunk, PluginContext } from './host-contract.js'
import {
  MemoryMaintenanceStore,
  MemoryStore,
  MemoryVectorStore,
  appendReceipt,
  excerptAround,
  floorSignature,
  matchedTokenCount,
  normalizeMemoryEmbedding,
  pendingRanges as subtractPending,
  tokenizeQuery,
  tokenThreshold,
  type MemoryEmbeddingSettings,
  type MaintenanceFloorMessage,
  type MaintenanceFloorRange,
  type MaintenanceReceipt,
  type MaintenanceRunOutcome,
  type MaintenanceRunRecord,
  type MaintenanceRunSummary,
  type MemoryRecord,
} from '../../tavern-store/src/index.js'
import { embedMemoryRecord } from './memory-hybrid.js'

/** 单 run 最多 LLM 请求次数（失败也计数；达到上限保留成果、如实收尾）。 */
export const MAINTENANCE_MAX_LLM_REQUESTS = 24
/** 开场材料（记忆清单摘要 + 待维护范围 + 指令）字符预算，超出则预算减半重装。 */
export const MAINTENANCE_OPENING_MAX_CHARS = 100_000
/** ReadMemory 每页记录数 / 每页字符上限（LWB §5.6 同款数值）。 */
export const MAINTENANCE_PAGE_RECORDS = 32
export const MAINTENANCE_PAGE_CHARS = 16_000
/** ReadSource 单次字符上限与楼面跨度上限（界 bound，防整聊天搬运）。 */
export const MAINTENANCE_SOURCE_CHARS = 24_000
export const MAINTENANCE_SOURCE_SPAN = 400
/** 维护请求的输出 token 上限。 */
export const MAINTENANCE_MAX_TOKENS = 8192
/** 对话总字符护栏：超过即按预算纪律收尾（v1 无压缩 adapter，见决策文档）。 */
export const MAINTENANCE_CONVERSATION_MAX_CHARS = 600_000
/** SearchSource 单次命中上限与摘录宽度。 */
const SEARCH_LIMIT = 20
const SEARCH_EXCERPT_CHARS = 400

/** 同 scope 已有在跑 run（HTTP 层映射 409）。 */
export class MaintenanceRunConflictError extends Error {
  readonly code = 'MAINTENANCE_RUNNING'
  constructor(character: string, chatId: string, readonly runId: string) {
    super(`a memory maintenance run is already active for ${character}/${chatId}`)
    this.name = 'MaintenanceRunConflictError'
  }
}

export interface MemoryMaintenanceScope {
  character: string
  chatId: string
}

/** 维护 run 的最小依赖面（显式注入便于测试；prod 由 index.mjs 传 memoized 实例）。 */
export interface MemoryMaintenanceDeps {
  root: string
  db: {
    getState(): Promise<{ memoryEmbedding?: unknown }>
    getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR; revision: string } | undefined>
  }
  memory: MemoryStore
  vectors: MemoryVectorStore
}

/** 宿主 ctx 的最小结构面：llm.stream（部署默认模型）+ agentDefaultModel + logger。 */
export interface MaintenanceLlmContext {
  llm: PluginContext['llm']
  agentDefaultModel: PluginContext['agentDefaultModel']
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

export type MaintenanceStreamChunk = HostLlmChunk

interface MaintenanceLoopMessage {
  role: 'user' | 'assistant' | 'tool'
  id: string
  content: Array<Record<string, unknown>>
  source: Record<string, unknown>
  toolCallId?: string
  isError?: boolean
}

export interface MemoryMaintenanceStatusView {
  status: 'running' | 'done' | 'error'
  runId?: string
  startedAt?: string
  finishedAt?: string
  summary?: MaintenanceRunSummary
  pending: { ranges: MaintenanceFloorRange[]; floors: number }
  receipts: number
}

interface ActiveRun {
  runId: string
  character: string
  chatId: string
  startedAt: string
}

/** 同 scope 单飞注册表：进程内 Map（进程重启即空 → 状态读取把遗留 running 标 interrupted）。 */
const activeRuns = new Map<string, ActiveRun>()

function scopeKey(scope: MemoryMaintenanceScope): string {
  return `${scope.character}\u0000${scope.chatId}`
}

/** 发起维护 run（wait:false 风格：立即返回 runId，执行在后台）。同 scope 409。 */
export async function startMemoryMaintenance(
  ctx: MaintenanceLlmContext,
  deps: MemoryMaintenanceDeps,
  scope: MemoryMaintenanceScope,
): Promise<{ runId: string }> {
  const key = scopeKey(scope)
  const existing = activeRuns.get(key)
  if (existing !== undefined) throw new MaintenanceRunConflictError(scope.character, scope.chatId, existing.runId)
  const active: ActiveRun = {
    runId: randomUUID(),
    character: scope.character,
    chatId: scope.chatId,
    startedAt: new Date().toISOString(),
  }
  activeRuns.set(key, active)
  void (async () => {
    try {
      await executeRun(ctx, deps, scope, active)
    } catch (error) {
      // executeRun 内部已兜底；这里是最后一层防线——状态文件如实记 error。
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-soulmojito: memory maintenance run crashed: ${message}`)
      try {
        const stateStore = await MemoryMaintenanceStore.open(deps.root)
        const state = await stateStore.read(scope.character, scope.chatId)
        await stateStore.write(scope.character, scope.chatId, {
          ...state,
          lastRun: {
            runId: active.runId,
            status: 'error',
            outcome: 'error',
            startedAt: active.startedAt,
            finishedAt: new Date().toISOString(),
            summary: { ...(state.lastRun?.summary ?? emptySummary(0)), error: message },
          },
        })
      } catch { /* 状态写不进时无更多兜底；GET 侧的 interrupted 扫描仍可救 */ }
    } finally {
      activeRuns.delete(key)
    }
  })()
  return { runId: active.runId }
}

/** 状态读取：内存注册表优先；idle 时对遗留 running 做 interrupted 扫描；现算待维护范围。 */
export async function memoryMaintenanceStatus(
  deps: MemoryMaintenanceDeps,
  scope: MemoryMaintenanceScope,
): Promise<MemoryMaintenanceStatusView> {
  const stateStore = await MemoryMaintenanceStore.open(deps.root)
  const state = await stateStore.read(scope.character, scope.chatId)
  const active = activeRuns.get(scopeKey(scope))
  if (active !== undefined) {
    return {
      status: 'running',
      runId: active.runId,
      startedAt: active.startedAt,
      pending: { ranges: [], floors: 0 },
      receipts: state.receipts.length,
    }
  }
  let lastRun = state.lastRun
  if (lastRun?.status === 'running') {
    // 注册表里没有这个 run：进程重启/宿主重挂把它孤悬了——如实标 error，不假装完成。
    lastRun = {
      ...lastRun,
      status: 'error',
      outcome: 'interrupted',
      finishedAt: new Date().toISOString(),
      summary: { ...lastRun.summary, error: 'run interrupted (host process restarted); it did not complete' },
    }
    await stateStore.write(scope.character, scope.chatId, { ...state, lastRun })
  }
  // 读取侧退役判定只现算不落盘（退役的持久化由下次 run 开始时执行）。
  const computation = await computePending(deps, scope, state.receipts)
  const view: MemoryMaintenanceStatusView = {
    status: lastRun?.status ?? 'done',
    pending: { ranges: computation.pending, floors: pendingFloorCount(computation.pending) },
    receipts: computation.validReceipts.length,
  }
  if (lastRun !== undefined) {
    view.runId = lastRun.runId
    view.startedAt = lastRun.startedAt
    if (lastRun.finishedAt !== undefined) view.finishedAt = lastRun.finishedAt
    view.summary = lastRun.summary
  }
  return view
}

function emptySummary(totalFloors: number): MaintenanceRunSummary {
  return {
    totalFloors,
    pendingRanges: [],
    pendingFloors: 0,
    editGroups: 0,
    merged: 0,
    corrected: 0,
    created: 0,
    deleted: 0,
    failedGroups: 0,
    retiredReceipts: 0,
    retiredReasons: [],
  }
}

function pendingFloorCount(ranges: readonly MaintenanceFloorRange[]): number {
  return ranges.reduce((total, range) => total + (range.headFloor - range.baseFloor + 1), 0)
}

/** 退役判定：楼面指纹不符（原文编辑/删除）或覆盖记录 revision 不符（后续写入）。 */
async function computePending(
  deps: MemoryMaintenanceDeps,
  scope: MemoryMaintenanceScope,
  receipts: readonly MaintenanceReceipt[],
): Promise<{ pending: MaintenanceFloorRange[]; validReceipts: MaintenanceReceipt[]; retiredReasons: string[]; totalFloors: number; chatMissing: boolean }> {
  let snapshot: { chat: ChatLogIR } | undefined
  try {
    snapshot = await deps.db.getChatSnapshot(scope.character, scope.chatId)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return { pending: [], validReceipts: [...receipts], retiredReasons: ['chat snapshot unavailable; pending ranges unknown'], totalFloors: 0, chatMissing: true }
  }
  const floors = snapshot.chat.messages
  const valid: MaintenanceReceipt[] = []
  const retiredReasons: string[] = []
  for (const receipt of receipts) {
    const sig = floorSignature(floors, receipt.baseFloor, receipt.headFloor)
    if (sig === undefined || sig !== receipt.floorSig) {
      retiredReasons.push(`receipt ${receipt.runId} (floors ${receipt.baseFloor}-${receipt.headFloor}) retired: chat text changed`)
      continue
    }
    let retired: string | undefined
    for (const [id, revision] of Object.entries(receipt.recordSnapshots)) {
      const current = await deps.memory.read(id, 'chat', scope.chatId, true).catch(() => undefined)
      if (current === undefined || current.revision !== revision) {
        retired = `receipt ${receipt.runId} retired: covered record '${id}' changed after maintenance`
        break
      }
    }
    if (retired !== undefined) {
      retiredReasons.push(retired)
      continue
    }
    valid.push(receipt)
  }
  return {
    pending: subtractPending(floors.length, valid),
    validReceipts: valid,
    retiredReasons,
    totalFloors: floors.length,
    chatMissing: false,
  }
}

/* ------------------------------ run 内部状态 ------------------------------ */

interface MaintenanceRunState {
  ctx: MaintenanceLlmContext
  deps: MemoryMaintenanceDeps
  scope: MemoryMaintenanceScope
  runId: string
  /** 冻结证据边界：run 开始时的消息快照（原文只读，永不改写）。 */
  floors: readonly ChatMessage[]
  provider: string
  model: string
  budget: number
  llmRequests: number
  summary: MaintenanceRunSummary
  unresolvedEdits: Set<string>
  embedConfig: MemoryEmbeddingSettings | undefined | null // null = 已解析且无配置
}

async function executeRun(
  ctx: MaintenanceLlmContext,
  deps: MemoryMaintenanceDeps,
  scope: MemoryMaintenanceScope,
  active: ActiveRun,
): Promise<void> {
  const key = scopeKey(scope)
  try {
    const stateStore = await MemoryMaintenanceStore.open(deps.root)
    const prior = await stateStore.read(scope.character, scope.chatId)
    const computation = await computePending(deps, scope, prior.receipts)
    const totalFloors = computation.totalFloors

    const summary = emptySummary(totalFloors)
    summary.pendingRanges = computation.pending
    summary.pendingFloors = pendingFloorCount(computation.pending)
    summary.retiredReceipts = computation.retiredReasons.length
    summary.retiredReasons = computation.retiredReasons

    // run 状态先声明（finish 闭包引用）：空范围/聊天缺失路径在构造前就会收尾。
    let run: MaintenanceRunState | undefined

    // run 开始即落 running（进程重启后 GET 侧 interrupted 扫描依赖这条记录）。
    await stateStore.write(scope.character, scope.chatId, {
      version: 1,
      receipts: computation.validReceipts,
      lastRun: { runId: active.runId, status: 'running', startedAt: active.startedAt, summary },
    })

    const finish = async (status: 'done' | 'error', outcome: MaintenanceRunOutcome, message?: string) => {
      summary.outcome = outcome
      const record: MaintenanceRunRecord = {
        runId: active.runId,
        status,
        outcome,
        startedAt: active.startedAt,
        finishedAt: new Date().toISOString(),
        summary: { ...summary, llmRequests: run?.llmRequests ?? 0, budget: run?.budget ?? MAINTENANCE_MAX_LLM_REQUESTS },
      }
      if (message !== undefined) {
        if (outcome === 'error') record.summary.error = message
        else record.summary.report = message
      }
      const latest = await stateStore.read(scope.character, scope.chatId)
      // 单飞保证同 scope 只有一个 run 在写；只覆写同 runId 防御性收尾。
      if (latest.lastRun?.runId === active.runId || latest.lastRun === undefined) {
        await stateStore.write(scope.character, scope.chatId, { ...latest, lastRun: record })
      }
    }

    if (computation.chatMissing) {
      await finish('error', 'error', 'chat snapshot unavailable; nothing maintained')
      return
    }
    if (summary.pendingFloors === 0) {
      // 零 LLM 调用收尾：有效收据已覆盖全部楼面。
      await finish('done', 'completed', 'nothing to maintain: valid receipts cover all floors')
      return
    }

    const snapshot = (await deps.db.getChatSnapshot(scope.character, scope.chatId))!
    const selection = ctx.agentDefaultModel.currentSelection()
    run = {
      ctx,
      deps,
      scope,
      runId: active.runId,
      floors: snapshot.chat.messages,
      provider: selection.provider,
      model: selection.model,
      budget: MAINTENANCE_MAX_LLM_REQUESTS,
      llmRequests: 0,
      summary,
      unresolvedEdits: new Set(),
      embedConfig: null,
    }

    // ---- 开场材料 + 预算纪律：超预算则预算减半并截断清单 ----
    const records = await deps.memory.list('chat', scope.chatId)
    let listing = renderMemoryListing(records, MAINTENANCE_OPENING_MAX_CHARS)
    let opening = buildOpeningMessage(run, listing)
    if (opening.length > MAINTENANCE_OPENING_MAX_CHARS) {
      run.budget = Math.ceil(MAINTENANCE_MAX_LLM_REQUESTS / 2)
      listing = renderMemoryListing(records, 20_000)
      opening = buildOpeningMessage(run, listing)
    }

    const messages: MaintenanceLoopMessage[] = [
      { role: 'user', id: randomUUID(), content: [{ type: 'text', text: opening }], source: { kind: 'user' } },
    ]

    let outcome: MaintenanceRunOutcome = 'completed'
    let errorMessage: string | undefined
    let report: string | undefined

    for (;;) {
      if (run.llmRequests >= run.budget) {
        outcome = 'budget-exhausted'
        errorMessage = `reached the run budget of ${run.budget} LLM requests; completed work is kept, unreported ranges stay pending`
        break
      }
      const conversationChars = messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0)
      if (conversationChars > MAINTENANCE_CONVERSATION_MAX_CHARS) {
        outcome = 'budget-exhausted'
        errorMessage = 'maintenance conversation exceeded the run context guard; completed work is kept'
        break
      }
      run.llmRequests += 1
      const blocks: Array<Record<string, unknown>> = []
      let textBuffer = ''
      let finishReason: { kind: string; failure?: { message?: string; code?: string } } | undefined
      try {
        for await (const chunk of ctx.llm.stream({
          provider: run.provider,
          model: run.model,
          system: MAINTENANCE_SYSTEM_PROMPT,
          messages: messages.map((message) => ({ ...message })),
          tools: MAINTENANCE_TOOL_SCHEMAS,
          maxTokens: MAINTENANCE_MAX_TOKENS,
        })) {
          if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
            blocks.push({ ...chunk.block })
          } else if (chunk.type === 'text-delta') {
            textBuffer += chunk.text
          } else if (chunk.type === 'finish') {
            finishReason = chunk.reason
          }
        }
      } catch (error) {
        // 失败也计数（上面已 +1）；v1 不自动重试，如实收尾（见决策文档）。
        outcome = 'error'
        errorMessage = `LLM request failed: ${error instanceof Error ? error.message : String(error)}`
        break
      }
      if (finishReason === undefined) {
        outcome = 'error'
        errorMessage = 'LLM stream ended without a finish chunk'
        break
      }
      if (finishReason.kind === 'error' || finishReason.kind === 'aborted') {
        outcome = 'error'
        errorMessage = `LLM stream failed (${finishReason.kind}): ${finishReason.failure?.message ?? 'unknown failure'}`
        break
      }
      if (!blocks.some((block) => block.type === 'text') && textBuffer !== '') {
        blocks.push({ type: 'text', text: textBuffer })
      }
      const toolCalls = blocks.filter((block) => block.type === 'tool-call') as Array<{ type: 'tool-call'; id: string; name: string; arguments: string }>
      messages.push({ role: 'assistant', id: randomUUID(), content: blocks, source: { kind: 'model', provider: run.provider, model: run.model } })
      if (toolCalls.length === 0) {
        report = textBuffer !== '' ? textBuffer : blocks.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('')
        break
      }
      if (finishReason.kind === 'max-tokens') {
        // 截断的 tool-call 参数不可信：本轮调用不执行，已确认的编辑保留，如实收尾。
        outcome = 'error'
        errorMessage = 'maintenance response truncated at the token cap'
        break
      }
      for (const call of toolCalls) {
        const result = await executeToolCall(run, call)
        messages.push({
          role: 'tool',
          id: randomUUID(),
          content: [{ type: 'text', text: safeJson(result.payload) }],
          source: { kind: 'tool', callId: call.id },
          toolCallId: call.id,
          ...(result.isError ? { isError: true } : {}),
        })
      }
    }

    if (outcome === 'error') {
      await finish('error', outcome, errorMessage)
      return
    }
    // 非错误收尾：预算耗尽/空范围时模型没有最终汇报，用纪律性说明补位（report）。
    const closing = report !== undefined ? report.slice(0, 2000) : errorMessage
    await finish('done', outcome, closing)
  } finally {
    activeRuns.delete(key)
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{"error":"tool result is not serializable"}'
  }
}

/* ------------------------------ 维护指令 ------------------------------ */

const MAINTENANCE_SYSTEM_PROMPT = [
  '你是这个角色扮演聊天的记忆管理员（memory maintenance agent）。你不参与剧情，只维护 chat 作用域的记忆记录：纠正与聊天原文冲突的陈述、合并跨写入批次产生的同一事件重复记录、删除被原文证伪的记忆。',
  '纪律：',
  '- 每一次改写都必须有原文依据：先用 SearchSource / ReadSource 查证相关楼层，不许凭空改写。',
  '- 合并跨批次同一事件时保留较早记录的身份（id 不变），把后续发展并入其内容并补齐来源楼层范围，删除后来的重复占位记录。',
  '- 分清历史事实与当前状态；推测与传闻不得升级为确定事实；正常记录可以不改，不得为了表现工作量而制造修改。',
  '- 证据不足时保留原记录，并在最终汇报中说明未解决的问题。',
  '- EditMemory 整组原子提交：任一 expectedRevision 冲突则整组失败，用 ReadMemory 重读后重交整组；放弃修正的条目在 CompleteMaintenance 的 abandonEdits 里声明。',
  '- 聊天原文只读，永不改写。',
  '- 工作完成后调用 CompleteMaintenance 声明本次覆盖的楼面范围（消息下标，0 起、headFloor 含端点），再简短汇报收尾。',
].join('\n')

function buildOpeningMessage(run: MaintenanceRunState, listing: string): string {
  const ranges = run.summary.pendingRanges
    .map((range) => `${range.baseFloor}-${range.headFloor}`)
    .join(', ')
  return [
    `聊天 ${run.scope.character}/${run.scope.chatId} 共 ${run.summary.totalFloors} 楼（下标 0-${Math.max(0, run.summary.totalFloors - 1)}）。`,
    `本次待维护楼面范围：${ranges}（共 ${run.summary.pendingFloors} 楼）。`,
    run.summary.retiredReasons.length > 0 ? `上次收据退役：${run.summary.retiredReasons.length} 条（原文/记忆在维护后被改动，对应范围重新待维护）。` : '',
    '',
    '当前 chat 作用域记忆清单（概要，可用 ReadMemory 翻页/过滤读取完整内容与 revision）：',
    listing,
    '',
    '维护指令：对照原文（SearchSource 关键词检索、ReadSource 按楼面范围阅读）检查上述记忆——合并跨批次重复事件（保留较早记录 id）、纠正与原文冲突的陈述、删除被证伪的记录；改写必须有原文依据。完成后 CompleteMaintenance 声明覆盖范围并简短汇报。',
  ].filter((part) => part !== '').join('\n')
}

function renderMemoryListing(records: readonly MemoryRecord[], maxChars: number): string {
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const record of records) {
    const content = record.content.length > 400 ? `${record.content.slice(0, 400)}…` : record.content
    const line = `- id=${record.id} kind=${record.kind} rev=${record.revision} imp=${record.importance} conf=${record.confidence}`
      + `${record.tags.length > 0 ? ` tags=${record.tags.join(',')}` : ''} source=${record.source.kind}\n  ${content.replace(/\n/g, ' ')}`
    if (used + line.length > maxChars) {
      truncated = true
      break
    }
    used += line.length
    lines.push(line)
  }
  if (records.length === 0) lines.push('（chat 作用域当前没有记忆记录）')
  if (truncated) lines.push(`…（清单过长截断，已列 ${lines.length}/${records.length} 条；用 ReadMemory 翻页读取）`)
  return lines.join('\n')
}

/* ------------------------------ 工具面 ------------------------------ */

const MAINTENANCE_TOOL_SCHEMAS = [
  {
    name: 'ReadMemory',
    description: 'Page through the chat-scope memory records (32 per page, ~16k chars per page). Optional kind/query filters. Returns id/content/tags/kind/revision/importance/confidence/source for each record.',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index' },
        kind: { type: 'string', enum: ['semantic', 'episodic'] },
        query: { type: 'string', description: 'Optional lexical filter over content and tags' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'SearchSource',
    description: 'Lexical search over the chat source messages (read-only). Returns matching floor indexes with excerpts. Search misses do not prove absence — try the source floors directly with ReadSource.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Lexical query; up to 3 terms require all, longer queries require ~40% term coverage' },
        limit: { type: 'integer', description: 'Maximum hits, capped at 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ReadSource',
    description: 'Read chat source messages by floor range (read-only; the chat is never rewritten). Floors are 0-based message indexes; at most 400 floors and ~24k chars per call.',
    parameters: {
      type: 'object',
      properties: {
        fromFloor: { type: 'integer' },
        toFloor: { type: 'integer' },
      },
      required: ['fromFloor', 'toFloor'],
      additionalProperties: false,
    },
  },
  {
    name: 'EditMemory',
    description: 'Atomically apply a group of memory edits. Items: {op:"update", id, expectedRevision, content?, tags?, importance?, confidence?, reason?("merge"|"correct")}, {op:"delete", id, expectedRevision}, {op:"create", content, kind, tags?, importance?, confidence?}. Any revision conflict rejects the whole group (nothing is applied); re-read and resubmit the full group.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['update', 'delete', 'create'] },
              id: { type: 'string' },
              expectedRevision: { type: 'string' },
              content: { type: 'string' },
              kind: { type: 'string', enum: ['semantic', 'episodic'] },
              tags: { type: 'array', items: { type: 'string' } },
              importance: { type: 'number' },
              confidence: { type: 'number' },
              reason: { type: 'string', enum: ['merge', 'correct'] },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'CompleteMaintenance',
    description: 'Declare the maintained floor range (0-based, inclusive). Rejected while failed EditMemory items remain unresolved (resubmit them or list their ids in abandonEdits). Ends the run with your final report.',
    parameters: {
      type: 'object',
      properties: {
        baseFloor: { type: 'integer' },
        headFloor: { type: 'integer' },
        abandonEdits: { type: 'array', items: { type: 'string' }, description: 'Record ids (or create:content-prefix keys) you explicitly give up fixing' },
      },
      required: ['baseFloor', 'headFloor'],
      additionalProperties: false,
    },
  },
] as const

interface ToolResult {
  payload: unknown
  isError: boolean
}

async function executeToolCall(
  run: MaintenanceRunState,
  call: { name: string; arguments: string },
): Promise<ToolResult> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments === '' ? '{}' : call.arguments) as Record<string, unknown>
  } catch {
    return { payload: { error: `invalid JSON arguments for ${call.name}` }, isError: true }
  }
  try {
    switch (call.name) {
      case 'ReadMemory': return { payload: await toolReadMemory(run, args), isError: false }
      case 'SearchSource': return { payload: toolSearchSource(run, args), isError: false }
      case 'ReadSource': return { payload: toolReadSource(run, args), isError: false }
      case 'EditMemory': return await toolEditMemory(run, args)
      case 'CompleteMaintenance': return await toolCompleteMaintenance(run, args)
      default: return { payload: { error: `unknown tool '${call.name}'` }, isError: true }
    }
  } catch (error) {
    return { payload: { error: error instanceof Error ? error.message : String(error) }, isError: true }
  }
}

function integerArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/* ---- ReadMemory：分页读 chat 作用域记忆 ---- */

async function toolReadMemory(run: MaintenanceRunState, args: Record<string, unknown>) {
  const page = integerArg(args.page) ?? 0
  if (page < 0 || page > 100_000) throw new Error('page must be a non-negative integer')
  const kind = args.kind === 'semantic' || args.kind === 'episodic' ? args.kind : undefined
  const query = typeof args.query === 'string' ? args.query : ''
  const tokens = query === '' ? [] : tokenizeQuery(query)
  if (query !== '' && tokens.length === 0) throw new Error('query produced no searchable tokens')

  const records = (await run.deps.memory.list('chat', run.scope.chatId))
    .filter((record) => kind === undefined || record.kind === kind)
    .filter((record) => tokens.length === 0 || matchedTokenCount(`${record.content}\n${record.tags.join(' ')}`, tokens) >= tokenThreshold(tokens.length))

  const start = page * MAINTENANCE_PAGE_RECORDS
  const pageRecords: unknown[] = []
  let used = 0
  for (const record of records.slice(start)) {
    if (pageRecords.length >= MAINTENANCE_PAGE_RECORDS) break
    const view = {
      id: record.id,
      kind: record.kind,
      content: record.content,
      tags: record.tags,
      revision: record.revision,
      importance: record.importance,
      confidence: record.confidence,
      source: record.source,
    }
    const size = JSON.stringify(view).length
    if (pageRecords.length > 0 && used + size > MAINTENANCE_PAGE_CHARS) break
    if (size > MAINTENANCE_PAGE_CHARS && pageRecords.length === 0) {
      // 单条超页预算：整条返回（不静默截断维护对象），页码照常推进。
      pageRecords.push(view)
      break
    }
    used += size
    pageRecords.push(view)
    if (used >= MAINTENANCE_PAGE_CHARS) break
  }
  const consumed = start + pageRecords.length
  return {
    total: records.length,
    page,
    pageSize: MAINTENANCE_PAGE_RECORDS,
    more: consumed < records.length,
    records: pageRecords,
  }
}

/* ---- SearchSource / ReadSource：对冻结证据快照的只读检索 ---- */
/* 分级匹配/摘录（tokenThreshold / matchedTokenCount / excerptAround）与
 * agent-tavern 词法检索同源：tavern-store/src/tokenize.ts。 */

function toolSearchSource(run: MaintenanceRunState, args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query : ''
  const tokens = tokenizeQuery(query.slice(0, 2000))
  if (tokens.length === 0) throw new Error('query requires at least one searchable token')
  const limit = Math.min(Math.max(integerArg(args.limit) ?? 10, 1), SEARCH_LIMIT)
  const required = tokenThreshold(tokens.length)
  const qualified: Array<{ floor: number; message: ChatMessage; matched: number }> = []
  for (let index = run.floors.length - 1; index >= 0; index -= 1) {
    const message = run.floors[index]!
    if (message.is_system === true || typeof message.mes !== 'string') continue
    const matched = matchedTokenCount(message.mes, tokens)
    if (matched < required) continue
    qualified.push({ floor: index, message, matched })
  }
  qualified.sort((left, right) => right.matched - left.matched || right.floor - left.floor)
  const hits = qualified.slice(0, limit).map(({ floor, message }) => {
    const excerpt = excerptAround(message.mes, tokens, SEARCH_EXCERPT_CHARS)
    return {
      floor,
      name: message.name,
      isUser: message.is_user === true,
      excerpt,
      truncated: excerpt.length < message.mes.length,
    }
  })
  return { hits, hitCount: hits.length, truncated: qualified.length > hits.length, totalFloors: run.floors.length }
}

function toolReadSource(run: MaintenanceRunState, args: Record<string, unknown>) {
  const from = integerArg(args.fromFloor)
  const to = integerArg(args.toFloor)
  if (from === undefined || to === undefined) throw new Error('fromFloor and toFloor must be integers')
  if (from < 0 || to < from) throw new Error('expected 0 <= fromFloor <= toFloor')
  if (to >= run.floors.length) throw new Error(`toFloor ${to} is beyond the last floor ${run.floors.length - 1}`)
  if (to - from + 1 > MAINTENANCE_SOURCE_SPAN) throw new Error(`floor span is capped at ${MAINTENANCE_SOURCE_SPAN} floors per call`)
  const messages: unknown[] = []
  let used = 0
  let truncated = false
  for (let floor = from; floor <= to; floor += 1) {
    const message = run.floors[floor]!
    const content = typeof message.mes === 'string' ? message.mes : ''
    const remaining = MAINTENANCE_SOURCE_CHARS - used
    const body = content.length <= remaining ? content : content.slice(0, Math.max(0, remaining))
    messages.push({
      floor,
      name: message.name,
      isUser: message.is_user === true,
      isSystem: message.is_system === true,
      content: body,
      truncated: body.length < content.length,
    })
    used += body.length
    if (body.length < content.length || used >= MAINTENANCE_SOURCE_CHARS) {
      truncated = truncated || body.length < content.length || floor < to
      break
    }
  }
  return { messages, spanFrom: from, spanTo: to, truncated, totalFloors: run.floors.length }
}

/* ---- EditMemory：整组原子提交 ---- */

interface ParsedUpdate {
  op: 'update'
  id: string
  expectedRevision: string
  content?: string
  tags?: string[]
  importance?: number
  confidence?: number
  reason?: 'merge' | 'correct'
}
interface ParsedDelete {
  op: 'delete'
  id: string
  expectedRevision: string
}
interface ParsedCreate {
  op: 'create'
  content: string
  kind: 'semantic' | 'episodic'
  tags?: string[]
  importance?: number
  confidence?: number
}
type ParsedEdit = ParsedUpdate | ParsedDelete | ParsedCreate

function parseEdits(value: unknown): ParsedEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('edits must be a non-empty array')
  const parsed: ParsedEdit[] = []
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`edits[${index}] must be an object`)
    const record = entry as Record<string, unknown>
    if (record.op === 'update') {
      if (typeof record.id !== 'string' || record.id === '') throw new Error(`edits[${index}].id is required`)
      if (typeof record.expectedRevision !== 'string' || record.expectedRevision === '') throw new Error(`edits[${index}].expectedRevision is required`)
      if (record.content !== undefined && typeof record.content !== 'string') throw new Error(`edits[${index}].content must be a string`)
      if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string'))) throw new Error(`edits[${index}].tags must be a string array`)
      if (record.importance !== undefined && (typeof record.importance !== 'number' || !Number.isFinite(record.importance))) throw new Error(`edits[${index}].importance must be a number`)
      if (record.confidence !== undefined && (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence))) throw new Error(`edits[${index}].confidence must be a number`)
      parsed.push({
        op: 'update',
        id: record.id,
        expectedRevision: record.expectedRevision,
        ...(record.content === undefined ? {} : { content: record.content }),
        ...(record.tags === undefined ? {} : { tags: record.tags as string[] }),
        ...(record.importance === undefined ? {} : { importance: Math.max(0, Math.min(1, numberField(record.importance, 'importance'))) }),
        ...(record.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, numberField(record.confidence, 'confidence'))) }),
        ...(record.reason === 'merge' ? { reason: 'merge' as const } : {}),
      })
      return
    }
    if (record.op === 'delete') {
      if (typeof record.id !== 'string' || record.id === '') throw new Error(`edits[${index}].id is required`)
      if (typeof record.expectedRevision !== 'string' || record.expectedRevision === '') throw new Error(`edits[${index}].expectedRevision is required`)
      parsed.push({ op: 'delete', id: record.id, expectedRevision: record.expectedRevision })
      return
    }
    if (record.op === 'create') {
      if (typeof record.content !== 'string' || record.content.trim() === '') throw new Error(`edits[${index}].content is required`)
      if (record.kind !== 'semantic' && record.kind !== 'episodic') throw new Error(`edits[${index}].kind must be semantic or episodic`)
      if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string'))) throw new Error(`edits[${index}].tags must be a string array`)
      parsed.push({
        op: 'create',
        content: record.content,
        kind: record.kind,
        ...(record.tags === undefined ? {} : { tags: record.tags as string[] }),
        ...(record.importance === undefined ? {} : { importance: Math.max(0, Math.min(1, numberField(record.importance, 'importance'))) }),
        ...(record.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, numberField(record.confidence, 'confidence'))) }),
      })
      return
    }
    throw new Error(`edits[${index}].op must be update, delete or create`)
  })
  return parsed
}

function editKey(edit: ParsedEdit): string {
  return edit.op === 'create' ? `create:${edit.content.slice(0, 24)}` : edit.id
}

/** 整组失败的冲突详情（含冲突项，模型据此重读后重试）。 */
async function toolEditMemory(run: MaintenanceRunState, args: Record<string, unknown>): Promise<ToolResult> {
  let edits: ParsedEdit[]
  try {
    edits = parseEdits(args.edits)
  } catch (error) {
    run.summary.failedGroups += 1
    return { payload: { error: error instanceof Error ? error.message : String(error), applied: false }, isError: true }
  }
  const digest = () => {
    for (const edit of edits) run.unresolvedEdits.delete(editKey(edit))
  }
  const markUnresolved = () => {
    for (const edit of edits) run.unresolvedEdits.add(editKey(edit))
  }

  // 预检：全部 update/delete 的存在性与 revision 先验，任何冲突整组拒绝。
  const conflicts: Array<Record<string, unknown>> = []
  for (const [index, edit] of edits.entries()) {
    if (edit.op === 'create') continue
    const current = await run.deps.memory.read(edit.id, 'chat', run.scope.chatId, true)
    if (current === undefined) {
      conflicts.push({ index, id: edit.id, problem: 'record not found in chat scope' })
      continue
    }
    if (current.revision !== edit.expectedRevision) {
      conflicts.push({ index, id: edit.id, problem: 'revision conflict', expectedRevision: edit.expectedRevision, actualRevision: current.revision })
    }
  }
  if (conflicts.length > 0) {
    run.summary.failedGroups += 1
    markUnresolved()
    return {
      payload: {
        error: 'edit group rejected: revision conflicts found; nothing was applied',
        conflicts,
        hint: 're-read the records with ReadMemory and resubmit the whole group with fresh revisions',
      },
      isError: true,
    }
  }

  // 应用 + 失败回滚（restore 需先读当前 revision——put 是 create-or-CAS）。
  const rollback: Array<() => Promise<void>> = []
  const results: unknown[] = []
  try {
    for (const edit of edits) {
      if (edit.op === 'update') {
        const previous = (await run.deps.memory.read(edit.id, 'chat', run.scope.chatId, true))!
        const record = await run.deps.memory.put({
          id: previous.id,
          scope: 'chat',
          scopeId: run.scope.chatId,
          kind: previous.kind,
          content: edit.content ?? previous.content,
          tags: edit.tags ?? previous.tags,
          importance: edit.importance ?? previous.importance,
          confidence: edit.confidence ?? previous.confidence,
          ...(previous.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }),
          // 更新保留原记录 source（出处不因维护丢失；维护归属由 revision + 收据快照证明）。
          source: previous.source,
        }, edit.expectedRevision)
        rollback.push(() => restoreRecord(run, previous))
        if (edit.reason === 'merge') run.summary.merged += 1
        else run.summary.corrected += 1
        results.push({ op: 'update', id: record.id, revision: record.revision })
      } else if (edit.op === 'delete') {
        const previous = (await run.deps.memory.read(edit.id, 'chat', run.scope.chatId, true))!
        await run.deps.memory.forget(edit.id, 'chat', run.scope.chatId, edit.expectedRevision)
        rollback.push(() => restoreRecord(run, previous))
        run.summary.deleted += 1
        results.push({ op: 'delete', id: edit.id })
      } else {
        const record = await run.deps.memory.put({
          scope: 'chat',
          scopeId: run.scope.chatId,
          kind: edit.kind,
          content: edit.content,
          ...(edit.tags === undefined ? {} : { tags: edit.tags }),
          ...(edit.importance === undefined ? {} : { importance: edit.importance }),
          ...(edit.confidence === undefined ? {} : { confidence: edit.confidence }),
          source: { kind: 'maintenance', runId: run.runId, character: run.scope.character, chatId: run.scope.chatId },
        })
        // 回滚要 CAS：forget 无 expectedRevision 时对存在记录必抛（MemoryStore 契约）。
        rollback.push(async () => {
          const current = await run.deps.memory.read(record.id, 'chat', run.scope.chatId, true).catch(() => undefined)
          if (current !== undefined) {
            await run.deps.memory.forget(record.id, 'chat', run.scope.chatId, current.revision).catch(() => {})
          }
        })
        run.summary.created += 1
        results.push({ op: 'create', id: record.id, revision: record.revision })
      }
    }
  } catch (error) {
    for (const undo of rollback.reverse()) await undo().catch(() => {})
    run.summary.failedGroups += 1
    markUnresolved()
    return {
      payload: {
        error: `edit group failed mid-apply and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        applied: false,
      },
      isError: true,
    }
  }

  digest()
  run.summary.editGroups += 1
  // 编辑成功 ⇒ 立即经 B-2 路径重嵌（失败不阻塞）；删除 ⇒ 清向量缓存（best-effort）。
  for (const edit of edits) {
    if (edit.op === 'delete') {
      await run.deps.vectors.delete(edit.id, 'chat', run.scope.chatId).catch(() => {})
    }
  }
  for (const [index, edit] of edits.entries()) {
    if (edit.op === 'update') {
      const record = await run.deps.memory.read(edit.id, 'chat', run.scope.chatId)
      if (record !== undefined) await embedEditedRecord(run, record)
    } else if (edit.op === 'create') {
      const created = results[index] as { id: string }
      const record = await run.deps.memory.read(created.id, 'chat', run.scope.chatId)
      if (record !== undefined) await embedEditedRecord(run, record)
    }
  }
  return { payload: { ok: true, applied: edits.length, results }, isError: false }
}

/** 回滚一条已应用的编辑：按当前 revision CAS 恢复全部原字段（软删记录复活：put 不带 deletedAt）。 */
async function restoreRecord(run: MaintenanceRunState, previous: MemoryRecord): Promise<void> {
  const current = await run.deps.memory.read(previous.id, 'chat', run.scope.chatId, true)
  if (current === undefined) return
  await run.deps.memory.put({
    id: previous.id,
    scope: previous.scope,
    scopeId: previous.scopeId,
    kind: previous.kind,
    content: previous.content,
    tags: previous.tags,
    importance: previous.importance,
    confidence: previous.confidence,
    ...(previous.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }),
    source: previous.source,
  }, current.revision)
}

/** 写路径嵌入（与 agent.ts embedWrittenMemory 同款失败纪律：失败不阻塞，向量 stale 由懒回填兜底）。 */
async function embedEditedRecord(run: MaintenanceRunState, record: MemoryRecord): Promise<void> {
  try {
    if (run.embedConfig === null) {
      const state = await run.deps.db.getState()
      run.embedConfig = normalizeMemoryEmbedding(state.memoryEmbedding)
    }
    if (run.embedConfig === undefined) return
    await embedMemoryRecord({
      root: run.deps.root,
      config: run.embedConfig,
      vectorStore: run.deps.vectors,
      record,
    })
  } catch { /* 嵌入失败不阻塞维护编辑 */ }
}

/* ---- CompleteMaintenance：完成收据 ---- */

async function toolCompleteMaintenance(run: MaintenanceRunState, args: Record<string, unknown>): Promise<ToolResult> {
  const base = integerArg(args.baseFloor)
  const head = integerArg(args.headFloor)
  if (base === undefined || head === undefined) throw new Error('baseFloor and headFloor must be integers')
  if (run.floors.length === 0) throw new Error('the chat has no floors to declare')
  if (base < 0 || head < base || head >= run.floors.length) {
    throw new Error(`expected 0 <= baseFloor <= headFloor <= ${run.floors.length - 1}`)
  }
  if (Array.isArray(args.abandonEdits)) {
    for (const key of args.abandonEdits) {
      if (typeof key === 'string') run.unresolvedEdits.delete(key)
    }
  }
  if (run.unresolvedEdits.size > 0) {
    return {
      payload: {
        error: 'failed EditMemory items remain unresolved; the completion is not recorded',
        unresolved: [...run.unresolvedEdits],
        hint: 'resubmit corrected EditMemory groups, or declare the ids you give up in abandonEdits',
      },
      isError: true,
    }
  }
  const sig = floorSignature(run.floors as readonly MaintenanceFloorMessage[], base, head)
  if (sig === undefined) throw new Error('floor range no longer resolvable against the run snapshot')
  const records = await run.deps.memory.list('chat', run.scope.chatId)
  const recordSnapshots: Record<string, string> = {}
  for (const record of records) recordSnapshots[record.id] = record.revision

  const stateStore = await MemoryMaintenanceStore.open(run.deps.root)
  const state = await stateStore.read(run.scope.character, run.scope.chatId)
  // appendReceipt：被新区间完全包含的旧收据让位 + 总量封顶（防无界增长）。
  const receipts = appendReceipt(state.receipts, {
    runId: run.runId,
    baseFloor: base,
    headFloor: head,
    at: new Date().toISOString(),
    floorSig: sig,
    recordSnapshots,
  })
  await stateStore.write(run.scope.character, run.scope.chatId, { ...state, receipts })

  run.summary.completion = { baseFloor: base, headFloor: head }
  return { payload: { ok: true, baseFloor: base, headFloor: head, coveredRecords: records.length }, isError: false }
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}
