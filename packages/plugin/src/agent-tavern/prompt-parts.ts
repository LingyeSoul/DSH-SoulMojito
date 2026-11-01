/**
 * Agent prompt 部件注册表（决策 2026-11-02-agent-prompt-takeover）。
 *
 * 宿主 `dsh-system-prompt` 的 `complete: true` 语义：装配结果只保留**一个**
 * complete section，其余 section 全部丢弃（`sections: [completeSection]`；
 * 多个 complete 段同时生效会直接抛错）。AgentTavern 因此把整份 system prompt
 * 收归自己：agent bundle 注册唯一 complete 段（`agent-prompt`），段文本由本
 * 注册表按 order 拼接——kernel / preset 在这里，IM 段（im-agent bundle）也在
 * 这里；mod 段由 agent bundle 从跨 bundle 快照并入（不进本表）。
 *
 * 为什么必须锚 globalThis：agent.mjs 与 im-agent.mjs 是 esbuild 各自打包的死
 * 产物，模块级 Map 跨 bundle 不互见（cross-bundle-events / mod-registry 同学科）。
 * key 字符串是 bundle 间互见契约，不得变更。
 *
 * scope 区分两类部件：`system` 进最终 system prompt；`context` 走宿主的
 * `systemPrompt.context()` runtime snapshot（每步一条 user 消息，位于上下文
 * 末尾），不属于 system 头——上下文通道保持原注册面，不进 complete 段。
 */

/** 部件去向：system 头，还是每步的 runtime snapshot。 */
export type AgentPromptScope = 'system' | 'context'

/** 一个可拼进 prompt 的部件（文本回调拿装配上下文里的 agent id）。 */
export interface AgentPromptPart {
  name: string
  order: number
  scope: AgentPromptScope
  text: (agentId: string | undefined) => string
}

/** 求值后的部件（空文本已摘除）。 */
export interface AgentPromptPiece {
  name: string
  order: number
  scope: AgentPromptScope
  text: string
}

const partsSymbol = Symbol.for('dsh-soulmojito:agent-prompt-parts')

function partStore(): Map<string, AgentPromptPart> {
  const holder = globalThis as Record<symbol, Map<string, AgentPromptPart> | undefined>
  return (holder[partsSymbol] ??= new Map())
}

/**
 * 注册（或同名覆盖）一个部件。返回反注册：只有当前项仍是自己时才删除——
 * 重复挂载（recompose）的同名覆盖不会被旧挂载的清理带走。
 */
export function registerAgentPromptPart(part: AgentPromptPart): () => void {
  const parts = partStore()
  parts.set(part.name, part)
  return () => {
    if (parts.get(part.name) === part) parts.delete(part.name)
  }
}

/** 读取已注册部件（order 升序，同 order 保持注册序）。 */
export function registeredAgentPromptParts(): AgentPromptPart[] {
  return [...partStore().values()].sort((a, b) => a.order - b.order)
}

/** 按 agent 求值全部部件：order 升序，空文本摘除（宿主对空 section 同款语义）。 */
export function agentPromptPieces(agentId: string | undefined): AgentPromptPiece[] {
  return registeredAgentPromptParts()
    .map((part) => ({ name: part.name, order: part.order, scope: part.scope, text: part.text(agentId) }))
    .filter((piece) => piece.text !== '')
}

/** 测试隔离用：清空注册表（模块加载期注册的部件需由调用方重新注册）。 */
export function resetAgentPromptPartsForTest(): void {
  partStore().clear()
}
