/**
 * AgentTavern 历史导入落地（提案 0024 §3.3「开场白导入」）。
 *
 * 命令激活（`session/command.ts`）与 IM 新建会话（`im/session-host.ts`）必须让
 * 模型看到同一份开场白/历史，所以「拿一份已生成的 historyImport 计划去写入、
 * 读回校验、失败兜底关 turn、推进轮次基线」只允许有这一份实现。
 *
 * 协议细节（见 `bind/confirmable-write.ts`）：
 * - 写入后按「计划前缀连续落在日志尾部」读回对齐；
 * - 只有日志尾部恰为干净前缀（无计划外残渣）时，才允许补写缺失后缀一次；
 * - 两次尝试后仍不齐：error 日志如实报告，兜底关闭半个导入，激活继续；
 * - 轮次基线只推进到读回确认的轮号——以日志为准，不以计划为准。
 *
 * 这里刻意不碰绑定与资产：绑定由调用方先落库，导入失败只降级为 warn/error，
 * 历史仍留在 JSONL 可重放。
 */

import { landedPlanAppends, sessionEvents } from '../../../bind/src/index.js'
import { lastImportedTurn, type SessionImportAppend } from '../agent-tavern/projector.js'
import {
  advanceHostTurnBase,
  canAdvanceHostTurnBase,
  closeImportBracket,
  lastLoggedTurn,
  type TraceAgentLike,
  type TraceSession,
} from './trace.js'

export interface HistoryImportLogger {
  warn?: (message: string) => void
  error?: (message: string) => void
}

export type HistoryImportStatus = 'applied' | 'partial' | 'skipped'

/** 调用方持有的宿主 agent 最小面（与 trace.ts 同源；导出供 IM 会话托管标注类型）。 */
export type HistoryImportAgent = TraceAgentLike

export interface HistoryImportOutcome {
  status: HistoryImportStatus
  /** 读回确认已落地的计划项数。 */
  landed: number
  /** 计划总项数。 */
  total: number
}

export interface ApplyHistoryImportOptions {
  agent: HistoryImportAgent
  plan: readonly SessionImportAppend[]
  logger?: HistoryImportLogger
}

export function applyAgentTavernHistoryImport(options: ApplyHistoryImportOptions): HistoryImportOutcome {
  const { agent, plan } = options
  const total = plan.length
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') {
    // IM 的 live agent 在缺 session seam 的宿主上只失去开场白镜像；绑定本身
    // 不阻断，历史仍在 Tavern JSONL 里。
    options.logger?.warn?.('AgentTavern history import skipped: the host agent exposes no appendable session, so the greeting stays in the Tavern JSONL only.')
    return { status: 'skipped', landed: 0, total }
  }
  const importedTurn = lastImportedTurn(plan)
  if (importedTurn !== undefined && !canAdvanceHostTurnBase(agent)) {
    // 导入带真实 turn 边界；宿主 loop 的轮次基线不可推进时不能写入，
    // 否则 live loop 的首轮会重复导入轮号，v4 准入把整个会话判成损坏。
    // 代价是这次激活不留导入 marker，"已启动"锁定不建立——宁可在未知宿主上
    // 保留一个合法会话，也不要一个锁死却损坏的会话。
    options.logger?.warn?.('AgentTavern history import skipped: the host session exposes no advanceable turn base, so imported turn boundaries would desynchronise the live loop.')
    return { status: 'skipped', landed: 0, total }
  }
  const logger = options.logger
  // D-2 confirmable save（决策 2026-10-11-confirmable-session-writes）：宿主
  // append 可能吞写——返回成功而日志无痕迹（LWB saveChatConditional 教训）。
  // 此时按旧逻辑把基线推进到计划轮号，live 首轮会撞号，v4 准入判整个会话
  // 损坏。协议：写入后按「计划前缀连续落在日志尾部」读回对齐；不齐且日志
  // 尾部恰为干净前缀（无计划外残渣）时，补写缺失后缀重试一次——后缀接续
  // 密集轮号，不产生重复轮号；尾部有残渣时任何重放都会重复边界事件，禁止
  // 重试。两次尝试后仍不齐：一行 error 如实报告两次结果，兜底关闭半个
  // 导入，激活继续（既有导入失败降级：历史留在 JSONL 可重放，绑定不阻断）。
  // 轮次基线只推进到读回确认的轮号——以日志为准，不以计划为准。
  const appendable = session as TraceSession & { append(type: string, data: unknown, opts?: unknown): unknown }
  const baseLength = sessionEvents(session).length
  const appendItem = (item: SessionImportAppend) => {
    appendable.append(item.type, item.data, item.surfaceOp === undefined ? undefined : { surfaceOp: item.surfaceOp })
  }
  let attemptError: unknown
  try {
    for (const item of plan) appendItem(item)
  } catch (error) {
    attemptError = error
  }
  let landed = landedPlanAppends(session, plan, baseLength)
  const firstLanded = landed
  let retryRefused = false
  if (landed < total && attemptError === undefined
    && sessionEvents(session).length === baseLength + landed) {
    try {
      for (const item of plan.slice(landed)) appendItem(item)
    } catch (error) {
      attemptError = error
    }
    landed = Math.max(landed, landedPlanAppends(session, plan, baseLength))
  } else if (landed < total && attemptError === undefined) {
    retryRefused = true
  }
  if (attemptError !== undefined) {
    // 导入失败不阻断绑定；用户仍可直接对话，缺失的历史留在 JSONL 可重放。
    logger?.warn?.(`AgentTavern history import failed: ${attemptError instanceof Error ? attemptError.message : String(attemptError)}`)
  } else if (landed < total) {
    const attempts = retryRefused
      ? `attempt 1: ${firstLanded}/${total} appends visible; suffix retry refused — the log tail holds unplanned events, replaying would duplicate turn boundaries`
      : `attempt 1: ${firstLanded}/${total} appends visible, attempt 2: ${landed}/${total}`
    logger?.error?.(`AgentTavern history import could not be confirmed by read-back (${attempts}); degrading to the verified prefix — the missing history stays in the Tavern JSONL and remains replayable`)
  }
  if (landed < total) {
    // 半个导入必须兜底关闭已打开的 step/turn，否则损坏的是整个会话。
    closeImportBracket(agent, {
      kind: 'error',
      error: { message: 'AgentTavern history import failed', code: 'TAVERN_IMPORT' },
    })
  }
  const verifiedTurn = lastLoggedTurn(agent)
  if (verifiedTurn !== undefined) advanceHostTurnBase(agent, verifiedTurn)
  return { status: landed < total ? 'partial' : 'applied', landed, total }
}
