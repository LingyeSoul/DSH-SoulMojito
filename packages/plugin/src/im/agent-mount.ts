/**
 * 把 IM 工具挂到原生会话（决策 2026-10-31-im-native-session-binding）。
 *
 * 宿主把 preset 插件挂进 **agent 会话域**，`ctx.tools.register` 是挂载域注册
 * （见 `mods/agent-mount.ts` 的宿主语义定案）。因此工具不能只在 agent-tavern
 * preset 里注册：普通原生会话（standard、novel、workbench……）也要能用
 * `im_send`。index bundle 在 `agent/created`、启动时的 `agents.list()` 以及
 * `agent/status` 三个入口把同一组工具注册进 `agent.ctx.tools`，按 agent id
 * 去重；`agent/disposed` 反注册。
 *
 * 工具执行时的身份仍只来自 `exec.agent.id` + `state.imPeers` 反查，注册位置
 * 不改变「不能跨会话发送」的保证。
 */

import type { HostAgentLike } from '../host-contract.js'
import { createImTools, type ImToolsDeps } from './tools.js'

interface AgentToolsServiceLike {
  register?: (tool: unknown) => unknown
}

interface AgentContextLike {
  tools?: AgentToolsServiceLike
}

const disposersByAgent = new Map<string, Array<() => void>>()
const warnedAgents = new Set<string>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentIdOf(agent: HostAgentLike): string | undefined {
  const id = agent.id
  if (typeof id === 'string' && id.trim() !== '') return id
  const sessionId = agent.session?.id
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined
}

/**
 * 注册一次；同一 agent 已挂过就是空操作。返回是否在本次调用里完成注册。
 * 宿主 ctx 形状不对（没有 tools.register）时返回 false 并留给下一次入口重试。
 */
export function mountImToolsOnAgent(deps: ImToolsDeps, agent: HostAgentLike): boolean {
  const agentId = agentIdOf(agent)
  if (agentId === undefined || disposersByAgent.has(agentId)) return false
  // 子代理会话不绑 IM：它的 session id 不会出现在 imPeers 里，注册工具只会扩大面。
  const header = agent.session?.header as { origin?: unknown; delegationDepth?: unknown } | undefined
  if (header?.origin === 'subagent'
    || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) return false
  const tools = (agent.ctx as AgentContextLike | undefined)?.tools
  const register = tools?.register
  if (typeof register !== 'function') {
    // 只报一次：agent/status 会反复重试，同一个形状问题不该刷屏。
    if (!warnedAgents.has(agentId)) {
      warnedAgents.add(agentId)
      deps.logger?.warn?.(
        `dsh-soulmojito im: agent ${agentId} has no tools.register; IM tools are not mounted, so the model cannot reply with im_send`,
      )
    }
    return false
  }
  const disposers: Array<() => void> = []
  for (const tool of createImTools(deps)) {
    try {
      const disposer = register.call(tools, tool)
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    } catch (error) {
      deps.logger?.warn?.(`dsh-soulmojito im: registering ${tool.name} on agent ${agentId} failed: ${messageOf(error)}`)
      // 单个工具注册失败不拖垮其它工具；下一次入口会整体重试。
      for (const dispose of disposers) dispose()
      return false
    }
  }
  disposersByAgent.set(agentId, disposers)
  warnedAgents.delete(agentId)
  deps.logger?.debug?.(`dsh-soulmojito im: mounted ${disposers.length} IM tools on agent ${agentId}`)
  return true
}

/** `agent/disposed`：释放该 agent 的全部工具注册。 */
export function unmountImToolsForAgent(agentId: string): void {
  const disposers = disposersByAgent.get(agentId)
  if (disposers === undefined) return
  disposersByAgent.delete(agentId)
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // 宿主已经拆掉挂载域时反注册可能抛错；这里只负责清理本地记账。
    }
  }
}

/** 插件卸载：释放全部注册。 */
export function unmountAllImTools(): void {
  for (const agentId of [...disposersByAgent.keys()]) unmountImToolsForAgent(agentId)
}
