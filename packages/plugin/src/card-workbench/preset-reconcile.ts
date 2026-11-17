/**
 * Card Workbench 原生 Agent 模式的生命周期收敛（行为设置
 * `cardWorkbenchNativeAgentMode`，参考 IM native 模式）。
 *
 * 目标预设由 `preset-ids.ts` 从 state 选择；新工作台会话在 workbench-open
 * 命令里直接选目标，已存在的会话在四个入口收敛：
 * 1. `agent/created`（宿主重启恢复的会话）；
 * 2. `agent/status(idle)`（运行中会话等空闲后切）；
 * 3. 插件启动 sweep（`mountCardWorkbenchPresets`）；
 * 4. 面板写 `POST /state` 后的即时 reconcile。
 *
 * running 会话不改工具面（宿主会在下一轮 continue 用旧 surface）；等到
 * idle 再切。所有失败只记 warn，不阻断会话创建/路由。
 */

import type { HostAgentLike, PluginContext } from '../host-contract.js'
import { listLiveAgents } from '../im/session-host.js'
import { applyAgentPtcMode } from '../agent-ptc-mode.js'
import { store } from '../runtime.js'
import { lastSelectedPresetId } from '../session/preset-marker.js'
import { cardWorkbenchPresetIdFor } from './preset-ids.js'

export interface WorkbenchPresetAgent extends HostAgentLike {
  status?: unknown
  ctx?: unknown
  session?: HostAgentLike['session'] & {
    id?: string
    append?: (type: string, data: unknown, opts?: unknown) => unknown
  }
}

export interface WorkbenchPresetContext extends Pick<PluginContext, 'agentPresets' | 'logger' | 'on'> {
  agents?: PluginContext['agents']
}

export interface WorkbenchPresetApplyResult {
  applied: boolean
  preset: string
  reason?: string
}

/**
 * 把单个 bound 工作台会话切到目标预设。幂等：marker 已是目标时只补 PTC。
 * `status === 'running'` 返回 applied:false，由 idle 监听重试。
 */
export async function applyCardWorkbenchPreset(
  ctx: WorkbenchPresetContext,
  agent: WorkbenchPresetAgent,
  targetPresetId: string,
): Promise<WorkbenchPresetApplyResult> {
  const presets = ctx.agentPresets
  if (typeof presets?.recompose !== 'function') {
    return { applied: false, preset: targetPresetId, reason: 'the host cannot recompose agent presets' }
  }
  if (agent.status === 'running') {
    return { applied: false, preset: targetPresetId, reason: 'the session is running; the preset will switch when it becomes idle' }
  }
  if (lastSelectedPresetId(agent.session) === targetPresetId) {
    await applyAgentPtcModeBestEffort(agent, ctx.logger)
    return { applied: true, preset: targetPresetId }
  }
  if (typeof agent.session?.append !== 'function') {
    return { applied: false, preset: targetPresetId, reason: 'the session does not expose append(); the preset cannot be made durable' }
  }
  const preset = await presets.recompose(agent.ctx, targetPresetId)
  if (preset.id !== targetPresetId) {
    return { applied: false, preset: targetPresetId, reason: `the host selected preset '${preset.id}' instead of '${targetPresetId}'` }
  }
  agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  await applyAgentPtcModeBestEffort(agent, ctx.logger)
  return { applied: true, preset: targetPresetId }
}

/** 绑定在 card-workbench 架构上的会话才切换；其他架构保持原样。 */
export async function reconcileCardWorkbenchPresetForAgent(
  ctx: WorkbenchPresetContext,
  agent: WorkbenchPresetAgent,
): Promise<WorkbenchPresetApplyResult> {
  const sessionId = agent.session?.id ?? agent.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { applied: false, preset: '', reason: 'the agent has no session id' }
  }
  const state = await (await store()).getState()
  if (state.sessionBindings[sessionId]?.architecture !== 'card-workbench') {
    return { applied: false, preset: '', reason: 'the session has no CardWorkbench binding' }
  }
  return applyCardWorkbenchPreset(ctx, agent, cardWorkbenchPresetIdFor(state))
}

/** 启动/面板写状态后的 sweep：只处理当前活着的 bound 工作台会话。 */
export async function reconcileCardWorkbenchPresets(ctx: WorkbenchPresetContext): Promise<void> {
  const state = await (await store()).getState()
  const bound = new Set(Object.entries(state.sessionBindings)
    .filter(([, binding]) => binding.architecture === 'card-workbench')
    .map(([sessionId]) => sessionId))
  if (bound.size === 0) return
  const target = cardWorkbenchPresetIdFor(state)
  for (const agent of listLiveAgents(ctx.agents)) {
    const sessionId = agent.session?.id ?? agent.id
    if (typeof sessionId !== 'string' || !bound.has(sessionId)) continue
    try {
      const result = await applyCardWorkbenchPreset(ctx, agent, target)
      if (!result.applied && result.reason !== undefined && !result.reason.includes('running')) {
        ctx.logger?.warn?.(`dsh-soulmojito workbench: ${sessionId} was not switched to ${target}: ${result.reason}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-soulmojito workbench: switching ${sessionId} to ${target} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 生命周期挂载：恢复会话（created）、运行中会话空闲（status idle）与启动
 * sweep 都收敛到 state 选择的目标 preset。与 IM native 模式同款，不阻断
 * agent 创建。
 */
export function mountCardWorkbenchPresets(ctx: WorkbenchPresetContext): void {
  const reconcileOne = (agent: unknown): Promise<void> => {
    if (typeof agent !== 'object' || agent === null) return Promise.resolve()
    return reconcileCardWorkbenchPresetForAgent(ctx, agent as WorkbenchPresetAgent)
      .then((result) => {
        if (!result.applied && result.reason !== undefined
          && !result.reason.includes('running')
          && !result.reason.includes('no CardWorkbench binding')) {
          ctx.logger?.warn?.(`dsh-soulmojito workbench: preset reconcile skipped: ${result.reason}`)
        }
      })
      .catch((error: unknown) => {
        ctx.logger?.warn?.(`dsh-soulmojito workbench: preset reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  ctx.on?.('agent/created' as string, (payload: unknown) => {
    const agent = (payload as { agent?: unknown } | null | undefined)?.agent
    // 宿主串行 await agent/created：恢复会话的首轮必须在 loop 启动前拿到目标预设。
    return reconcileOne(agent)
  })
  ctx.on?.('agent/status' as string, (payload: unknown) => {
    const record = payload as { agent?: unknown; status?: unknown } | null | undefined
    if ((record?.status ?? (record?.agent as { status?: unknown } | undefined)?.status) !== 'idle') return
    void reconcileOne(record?.agent)
  })
  void reconcileCardWorkbenchPresets(ctx).catch((error: unknown) => {
    ctx.logger?.warn?.(`dsh-soulmojito workbench: startup preset reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function applyAgentPtcModeBestEffort(agent: WorkbenchPresetAgent, logger: WorkbenchPresetContext['logger']): Promise<void> {
  try {
    await applyAgentPtcMode(agent, logger)
  } catch (error) {
    logger?.warn?.(`dsh-soulmojito ptc: workbench preset switch apply failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}