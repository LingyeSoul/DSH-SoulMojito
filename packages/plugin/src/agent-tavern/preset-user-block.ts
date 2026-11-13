/**
 * AgentTavern 预设 user 角色条目的注入通道（决策 2026-11-13-preset-user-role-injection）。
 *
 * 宿主 `agent/pre-step` waterfall 的批次只接受 `UserMessage`，且一律按 user 角色
 * 落库：预设里 `role === 'user'` 的条目既不能留在 system 头（会把用户发言说成
 * 系统规则），也不能作为 assistant 消息注入。因此它们改为一条带 plugin source
 * 的 user 消息，放在本 step 批次最前（等价于历史之前），走 append-only。
 *
 * 注入时机与幂等：
 * - 一次性：会话里从未出现过本通道的消息时注入一次；之后的 step 不再重复
 *   （不因预设内容变化重写已注入块——已落盘的 user 消息改写会烧掉其后全部
 *   KV 前缀缓存）。
 * - 压缩后重注入：dsh-compaction-basic 的压缩范围从第一个非 system 节点开始、
 *   system 头永不压缩，早期一次性消息会被摘要覆盖。因此最后一条**成功的**
 *   `compaction/end` 晚于最后一次注入时再注入一次；带 `error` 的失败压缩不改写
 *   surface，不触发重注。判定只读会话事件流位置。
 *
 * 投影安全：消息带 plugin source + `presetUserBlock` 标记，projector 按
 * `source.kind !== 'user'` 过滤，不写进 Tavern JSONL 剧情记录。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  hostPluginMessageSource,
  isHostPluginMessageSource,
  sessionEvents,
  type HostSessionEvent,
  type HostSessionLog,
} from '../../../bind/src/index.js'

interface PreStepAgentLike {
  session?: (HostSessionLog & { id?: string }) | undefined
}

interface PreStepPayloadLike {
  agent?: PreStepAgentLike | undefined
  signal?: { aborted?: boolean } | undefined
}

interface PreStepDecisionLike {
  kind?: string
  messages?: unknown[]
}

/** pre-step 注册面：只声明本通道用到的成员，调用处从宿主 Context 窄化。 */
export interface AgentPresetUserBlockContext {
  on?: (
    event: 'agent/pre-step',
    listener: (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => unknown,
    options?: unknown,
  ) => unknown
}

export interface PresetUserBlockOptions {
  /** 强制装载一次并返回当前文本（仅在需要注入时调用）。 */
  ensureUserText: (agentId: string) => Promise<string | undefined>
  /** 会话绑定判定：只有 AgentTavern 会话注入。 */
  isAgentTavernSession: (sessionId: string) => Promise<boolean>
  logger?: { warn?: (message: string) => unknown } | undefined
}

/** 本通道消息的 source 标记：`presetUserBlock` 为判别位，hash 只作诊断。 */
export function presetUserBlockSourceOf(
  session: HostSessionLog | undefined,
  text: string,
): Record<string, unknown> {
  return hostPluginMessageSource(session, {
    form: 'instructions',
    presetUserBlock: true,
    presetUserBlockHash: createHash('sha256').update(text).digest('hex').slice(0, 16),
  })
}

/** 事件是否本通道注入的 user 消息（插件 source + 标记位）。 */
export function isPresetUserBlockEvent(event: HostSessionEvent | undefined): boolean {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  if (!isHostPluginMessageSource(source)) return false
  return (source as Record<string, unknown>)['presetUserBlock'] === true
}

/**
 * 注入判定：从未注入过，或最后一次注入早于最后一次成功的 `compaction/end`。
 * 反向扫描——先遇到压缩结束 ⇒ 需要重注；先遇到本通道消息 ⇒ 已有更新的块。
 * 带 `error` 的失败压缩跳过（surface 未改写，旧块仍在）。
 */
export function presetUserBlockDue(events: readonly HostSessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'compaction/end') {
      // A failed compaction still logs compaction/end with an error, but the
      // surface was not rewritten: the previous block is still visible.
      if ((event.data as { error?: unknown } | undefined)?.error !== undefined) continue
      return true
    }
    if (isPresetUserBlockEvent(event)) return false
  }
  return true
}

export function createPresetUserBlockMessage(
  session: HostSessionLog | undefined,
  text: string,
): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: Record<string, unknown>
} {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: presetUserBlockSourceOf(session, text),
  }
}

/**
 * 注册 `agent/pre-step` 注入：先 await next() 再在批次最前插入，与
 * anchor/card-state 的 wrap 模式同源。不用 `prepend`——prompt capture 在 index
 * bundle 里先以 prepend 注册，本监听保持普通顺序即可成为其内层，查看器能看到
 * 注入后的批次；批次顺序仍由下方的显式前插决定。
 * 非 AgentTavern 会话、非进入决策、中止/失败路径一律原样返回 decision。
 */
export function registerAgentPresetUserBlock(
  ctx: AgentPresetUserBlockContext,
  options: PresetUserBlockOptions,
): void {
  const logger = options.logger
  ctx.on?.('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || payload.signal?.aborted === true) return decision
      const sessionId = payload.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return decision
      if (!presetUserBlockDue(sessionEvents(payload.agent?.session))) return decision
      // 存储与装载只发生在待注入的 step，保持其余 step 的零开销路径。
      if (!(await options.isAgentTavernSession(sessionId))) return decision
      const text = await options.ensureUserText(sessionId)
      if (text === undefined || text.trim() === '') return decision
      return {
        ...decision,
        messages: [
          createPresetUserBlockMessage(payload.agent?.session, text),
          ...(decision.messages ?? []),
        ],
      }
    } catch (error) {
      logger?.warn?.(`dsh-soulmojito: preset user block injection failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })
}