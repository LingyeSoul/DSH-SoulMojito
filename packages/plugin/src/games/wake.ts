/**
 * 人类落子自动续弈（2026-10-14 用户需求：Agent 没调 game_wait 就结束回合后，
 * 用户操作完游戏由插件自动触发 Agent 继续）。
 *
 * 触发链：人类在棋盘上落子（HTTP `POST games/action/:id`）→ service.humanAction
 * 成功后回调本模块 → 反查该聊天的 AgentTavern 绑定 → 经宿主 `agent.followup`
 * 投递一条**插件来源**的通知消息（`plugin:dsh-tavern` + form 'notice'，绝不伪装
 * 成用户消息；v0-v3 宿主形状由 hostPluginMessageSource 分支）→ Agent 新回合按
 * 懒段指引读局面续弈——**用户无需发送聊天消息**。
 *
 * 与 agent-novel driver 的关系：同一投递机制（followup + hostPluginMessageSource
 * + 结构化宿主面逐属性降级），刻意**不带**调度器/持久意图/重试——触发是「一次
 * 人类动作一条通知」的事件语义：错过由既有兜底覆盖（懒段 order -63 常驻局面
 * 摘要 + 下次任一消息唤起），送达失败只记日志、不影响落子本身。
 *
 * 防重（不产生重复/陈旧回合，token 经济）：
 * - 等待判定：`game_wait` 挂起中（handle.ts 的跨 bundle 等待登记 gameWaiters）
 *   时**不投递**——该手已由工具内唤醒覆盖，重复投递会让等待回合结束后多出
 *   一个陈旧通知回合；
 * - 一次人类动作恰一条通知（message id `game-notice-<sessionId>-<moveCount>`）；
 * - 人类动作被拒（409/非法动作）→ service 层不回调，天然无通知；
 * - 无绑定 / 非 agent-tavern / 群聊绑定 / 冷会话（agent 不在宿主 agents 注册表）
 *   → 静默跳过（懒段兜底）。
 *
 * 宿主形状纪律（镜像 agent-novel driver）：不 import 宿主类型，结构性访问；
 * `agents.get` 可能缺失/抛错/返回 undefined（fiber 未激活），逐条降级。
 */

import { hostPluginMessageSource, type HostSessionLog } from '../../../bind/src/index.js'
import { gameWaiters } from './handle.js'
import type { GameSessionSummary } from './sessions.js'

/** 结构性宿主面（调用方在 index.ts 组装；测试用替身）。 */
export interface GamesWakeHost {
  /** 宿主 agents 服务；`get(id)` 缺失/抛错/返回 undefined 都视为冷会话。 */
  agents?: unknown
  /** (character, chatId) → 本插件绑定的 AgentTavern 会话 id；无绑定/非 agent-tavern/群聊 → undefined。 */
  bindingOf?: (character: string, chatId: string) => Promise<string | undefined> | string | undefined
  logger?: { warn?: (message: string) => void }
}

/** 宿主 Agent 句柄的最小结构面（ReactLoopAgent.followup 只需 message）。 */
interface WakeAgentLike {
  session: HostSessionLog
  followup: (message: unknown) => unknown
}

function agentOf(agents: unknown, id: string): WakeAgentLike | undefined {
  try {
    const candidate = (agents as { get?: (id: string) => unknown } | undefined)?.get?.(id)
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const agent = candidate as { session?: unknown; followup?: unknown }
    if (typeof agent.followup !== 'function' || typeof agent.session !== 'object' || agent.session === null) return undefined
    return candidate as WakeAgentLike
  } catch {
    return undefined
  }
}

/** 通知文本（token 经济：最短自足——局面/轮次/词汇表由懒段与 game_state 携带）。 */
function noticeText(session: GameSessionSummary): string {
  return session.finished
    ? `自动游戏通知（非用户消息）：对局「${session.gameName}」已结束——${session.summary}。请收尾叙述。sessionId: ${session.id}`
    : `自动游戏通知（非用户消息）：对手已在「${session.gameName}」棋盘落子，继续对局。sessionId: ${session.id}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 人类落子成功后的自动唤起（service.humanAction 的出口调用；永不抛错）。
 * @returns 是否投递了 followup（false = 本轮无需/无法投递，走懒段兜底）。
 */
export async function wakeAgentOnHumanMove(host: GamesWakeHost, session: GameSessionSummary): Promise<boolean> {
  const warn = (message: string): void => {
    try {
      host.logger?.warn?.(message)
    } catch {
      // 日志面失败不影响落子与投递语义。
    }
  }
  // 等待中：工具内唤醒覆盖该手，重复投递会多出陈旧回合。
  if (gameWaiters(session.id) > 0) return false
  let agentId: string | undefined
  try {
    agentId = await host.bindingOf?.(session.chat.character, session.chat.chatId)
  } catch (error) {
    warn(`dsh-tavern: game wake binding lookup failed (${messageOf(error)})`)
    return false
  }
  if (agentId === undefined) return false
  const agent = agentOf(host.agents, agentId)
  // 冷会话（无 live agent）：没有可唤醒的回合，下次任一消息唤起时懒段提示局面。
  if (agent === undefined) return false
  const message = {
    id: `game-notice-${session.id}-${session.moveCount}`,
    role: 'user',
    content: [{ type: 'text', text: noticeText(session) }],
    source: hostPluginMessageSource(agent.session, {
      form: 'notice',
      summary: `Game move notice (${session.gameId} ${session.id}, move ${session.moveCount})`,
    }),
  }
  try {
    await agent.followup(message)
    return true
  } catch (error) {
    warn(`dsh-tavern: game wake followup failed (${messageOf(error)})`)
    return false
  }
}
