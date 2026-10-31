/**
 * 原生会话投递（决策 2026-10-31-im-native-session-binding）。
 *
 * 绑定目标是一个**宿主已经存在的 native session**：IM 入站消息以插件来源
 * 消息插进它的 inbox——运行中的会话用 `agent.steer` 插话（官方“插话发送”，
 * 在最近的 step 边界读到），空闲会话用 `agent.followup` 开新轮。模型再用
 * `im_send` 回复。插件不创建、不 resume、不导入 Tavern 聊天——会话由用户在
 * DSH 里创建并打开，插件只负责找到活着的 agent。
 *
 * 宿主形状纪律（镜像 `agent-novel/driver.ts`）：不 import 宿主类型；`agents.get`
 * 可能缺失/抛错/返回 undefined（fiber 未激活或会话未打开），逐条降级。
 */

import type { HostAgentLike } from '../host-contract.js'
import { hostPluginMessageSource, type HostSessionLog } from '../../../bind/src/index.js'
import type { ImAgentMessage } from './router.js'

/** 宿主 `ctx.agents` 的最小面。 */
export interface ImAgentsSeam {
  get?(id: string): HostAgentLike | undefined | null
  list?(): readonly HostAgentLike[]
}

export interface ImSessionCapabilities {
  readonly available: boolean
  readonly reasons: string[]
}

/** 绑定会话不在线：路由据此回「先打开会话」的提示，不假装插入成功。 */
export class ImSessionNotLiveError extends Error {
  readonly code = 'IM_SESSION_NOT_LIVE'
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`the bound DSH session '${sessionId}' has no live AgentLoop agent; open it in DSH and send again`)
    this.name = 'ImSessionNotLiveError'
    this.sessionId = sessionId
  }
}

export function inspectImSessionCapabilities(agents: ImAgentsSeam | undefined): ImSessionCapabilities {
  const reasons: string[] = []
  if (agents === undefined) {
    reasons.push('the host exposes no agents service; IM cannot insert messages into a session')
  } else if (typeof agents.get !== 'function') {
    reasons.push('the host agents service exposes no get(id); IM cannot find the bound session agent')
  }
  return { available: reasons.length === 0, reasons }
}

/**
 * 取活着的 agent。`get` 抛错（未声明 inject 的服务属性、fiber 未激活）与返回
 * undefined（会话未打开）都按「不在线」处理，由调用方给出可行动提示。
 */
export function liveAgentOf(agents: ImAgentsSeam | undefined, sessionId: string): HostAgentLike | undefined {
  if (agents?.get === undefined) return undefined
  try {
    return agents.get(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

/** 取活着的 agent；不在线或没有任何 inbox 投递面时抛结构化错误。 */
export function requireLiveAgent(agents: ImAgentsSeam | undefined, sessionId: string): HostAgentLike {
  const agent = liveAgentOf(agents, sessionId)
  if (agent === undefined) throw new ImSessionNotLiveError(sessionId)
  if (!hasInboxSeam(agent)) throw noInboxError(sessionId)
  return agent
}

/** The two host inbox seams IM can deliver through; either one is enough. */
function hasInboxSeam(agent: HostAgentLike): boolean {
  return typeof agent.followup === 'function' || typeof agent.steer === 'function'
}

function noInboxError(sessionId: string): Error {
  const error = new Error(
    `the host agent for session '${sessionId}' exposes neither followup() nor steer(); IM cannot insert a message`,
  )
  ;(error as Error & { code?: string }).code = 'IM_SESSION_NO_INBOX'
  return error
}

/** `agents.list()` 的容错读取：旧宿主没有 list 时返回空数组。 */
export function listLiveAgents(agents: ImAgentsSeam | undefined): readonly HostAgentLike[] {
  if (agents?.list === undefined) return []
  try {
    return agents.list() ?? []
  } catch {
    return []
  }
}

/**
 * 入站消息 → 宿主 inbox 的插件来源消息（followup / steer 共用同一形状）。
 *
 * - `role: 'user'` + `source.form = 'relay'`：模型把它当一轮输入，宿主 / UI 能
 *   区分「IM 转发」与本地用户输入；v4 持久化格式还要求 producer-owned source
 *   kind，`hostPluginMessageSource` 按 session header 版本给对形状。
 * - `summary` 只带渠道/范围/alias，不含正文与平台身份。
 */
export function buildImInboxMessage(
  session: HostSessionLog | null | undefined,
  message: ImAgentMessage,
): Record<string, unknown> {
  return {
    id: message.id,
    role: 'user',
    content: [{ type: 'text', text: message.text }],
    source: hostPluginMessageSource(session, { form: 'relay', summary: message.summary }),
  }
}

/** Which host inbox boundary accepted the message. */
export type ImInsertMode = 'steer' | 'followup'

/**
 * 把一条入站消息插进活着的 agent：
 *
 * - 运行中的会话走 `steer`（官方“插话发送”）：模型在最近的 step 边界读到，
 *   不必等整个 turn 结束；长回合里的新消息因此不会被拖到下一轮。
 * - 空闲会话走 `followup`：开一个自己的普通轮次，语义与宿主 UI 的空闲发送一致。
 * - 旧宿主没有 `steer` 时退化为 `followup`；两个 seam 都没有则结构化报错。
 *
 * `steer` 是同步 void；`followup` 可能返回 promise，调用方等待其失败。
 */
export async function insertImMessage(agent: HostAgentLike, message: ImAgentMessage): Promise<ImInsertMode> {
  const built = buildImInboxMessage(agent.session, message)
  if (agent.status === 'running' && typeof agent.steer === 'function') {
    agent.steer(built)
    return 'steer'
  }
  if (typeof agent.followup !== 'function') {
    throw noInboxError(agent.session?.id ?? agent.id ?? 'unknown')
  }
  await agent.followup(built)
  return 'followup'
}
