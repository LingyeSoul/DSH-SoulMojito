/**
 * AgentTavern 预注入消息捕获（提示词查看器 Agent 模式的前半，决策
 * 2026-10-11-agent-prompt-viewer）。
 *
 * agent/pre-step waterfall 最外层监听：index.ts 在 registerAgentTavernAnchor
 * **之后** prepend 注册（后 prepend 者更外层），await next() 返回时看到的是
 * 含锚定/开场提醒的最终进入批次。只捕获**本插件注入**的消息
 * （isHostPluginMessageSource 识别 source；用户真实消息与宿主自有注入不计）
 * 与轮/步标记；section 装配快照与合成入缓冲在 agent.ts 的
 * recordAgentTavernPromptViewFor（agent/request 链尾，那边能拿到实发配置）。
 *
 * 纪律（与 prompt-viewer 同源）：纯观察——捕获路径整体吞错，任何异常都不改写
 * decision，原样透传（本监听在宿主 waterfall 链上，抛错会炸宿主循环）。
 */

import { isHostPluginMessageSource } from '../../../bind/src/index.js'

/** 单个 agent（= 会话）的最近一次 pre-step 捕获。 */
export interface AgentStepCapture {
  /** 轮/步标记（宿主 payload 未携带时 undefined）。 */
  turn: number | undefined
  step: number | undefined
  /** 本 step 插件注入的消息原样批次（recordPromptView 侧统一脱壳成纯文本）。 */
  injected: readonly unknown[]
}

/** agentId（= 绑定键 = 会话 id）→ 最近一次 pre-step 捕获。模块级单例，与
 *  prompt-viewer 的环形缓冲同进程生命周期；按插入序上限淘汰最旧（会话数有界，
 *  长进程不积压）。 */
const agentStepCaptures = new Map<string, AgentStepCapture>()
const AGENT_STEP_CAPTURE_LIMIT = 16

interface PreStepPayloadLike {
  agent?: { session?: { id?: string } }
  turn?: unknown
  step?: unknown
}

interface PreStepDecisionLike {
  kind?: string
  messages?: unknown[]
}

/**
 * 注册 pre-step 捕获监听（index.ts 的 apply 调用，anchor 之后）。决策对象
 * 原样透传——本监听只旁观，是链条上唯一的「零改写」参与者。
 */
export function registerAgentTavernPromptCapture(ctx: {
  on?: (event: string, listener: (payload: unknown, next: () => unknown) => unknown, options?: unknown) => unknown
}): void {
  ctx.on?.('agent/pre-step', async (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => {
    const decision = await next()
    try {
      // 非 enter（拒绝/中止路径）没有进入批次，无需捕获。
      if (decision?.kind === 'enter') agentViewerCaptureStep(payload, decision)
    } catch {
      // 纯观察：捕获失败绝不影响 decision。
    }
    return decision
  }, { prepend: true })
}

function agentViewerCaptureStep(payload: PreStepPayloadLike, decision: PreStepDecisionLike): void {
  const agentId = payload.agent?.session?.id
  if (typeof agentId !== 'string' || agentId.trim() === '') return
  const injected = (Array.isArray(decision.messages) ? decision.messages : [])
    .filter((message) => isHostPluginMessageSource((message as { source?: unknown } | null)?.source))
  // 重置插入序：同一 agent 的捕获永远在 Map 尾部（最近活跃）。
  agentStepCaptures.delete(agentId)
  agentStepCaptures.set(agentId, {
    turn: typeof payload.turn === 'number' ? payload.turn : undefined,
    step: typeof payload.step === 'number' ? payload.step : undefined,
    injected,
  })
  while (agentStepCaptures.size > AGENT_STEP_CAPTURE_LIMIT) {
    const oldest = agentStepCaptures.keys().next().value
    if (oldest === undefined) break
    agentStepCaptures.delete(oldest)
  }
}

/** 读取某 agent 的最近一次 pre-step 捕获（无则 undefined）。合成方在异步绑定
 *  查询前同步取快照——读盘期间会话可能已推进到下一 step。 */
export function agentStepCaptureOf(agentId: string | undefined): Readonly<AgentStepCapture> | undefined {
  if (typeof agentId !== 'string') return undefined
  return agentStepCaptures.get(agentId)
}

/** 清空捕获（测试隔离用）。 */
export function resetAgentStepCaptures(): void {
  agentStepCaptures.clear()
}
