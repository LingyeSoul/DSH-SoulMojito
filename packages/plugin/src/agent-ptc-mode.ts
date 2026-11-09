/**
 * Behavior switch `agentPtcMode`: let bound Tavern agents use the host's native
 * PTC surface.
 *
 * The plugin owns the product decision only: which architectures participate,
 * the persisted switch, bindings, idle-safe scheduling, and logging. All DSH
 * host interaction (0.2.1 presentation seam, 0.2.2 PTC executor seam, module
 * loading, executor record cleanup, complete-prompt SDK mirroring) lives in
 * `packages/bind/src/ptc.ts`.
 */

import type { HostAgentLike, PluginContext } from './host-contract.js'
import {
  describePtcSelection,
  inspectPtcCapabilities,
  inspectPtcCapabilitiesAsync,
  mountPtc,
  type PtcHostCapabilities,
  type PtcHostContext,
  type PtcMount,
} from '../../bind/src/index.js'
import { listLiveAgents } from './im/session-host.js'
import { store } from './runtime.js'

interface PtcLogger {
  warn?: (message: string) => unknown
}

interface AgentStatusPayload {
  agent?: HostAgentLike
  status?: unknown
}

const mountedByAgent = new Map<string, PtcMount>()
const lastApplyErrorByAgent = new Map<string, string>()
const idleReconciles = new Set<string>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentIdOf(agent: HostAgentLike | undefined): string | undefined {
  const id = agent?.id
  if (typeof id === 'string' && id.trim() !== '') return id
  const sessionId = agent?.session?.id
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined
}

function isTavernAgentArchitecture(architecture: unknown): boolean {
  return architecture === 'agent-tavern'
    || architecture === 'agent-novel'
    || architecture === 'card-workbench'
}

function hostContextOf(agent: HostAgentLike): PtcHostContext | undefined {
  return agent.ctx as PtcHostContext | undefined
}

/**
 * Host capability probe used by bootstrap and the state route. The bind layer
 * preflights the 0.2.2 executor import so the switch cannot enable a seam that
 * cannot load its PTC executor.
 */
export function agentPtcCapabilitiesForHost(ctx: PluginContext): Promise<PtcHostCapabilities> {
  return inspectPtcCapabilitiesAsync(ctx as unknown as PtcHostContext)
}

/** One bound Tavern agent's live PTC state, surfaced by bootstrap diagnostics. */
export interface AgentPtcRuntimeEntry {
  readonly agentId: string
  readonly status: string | undefined
  readonly architecture: string | undefined
  readonly capable: boolean
  readonly capabilityReasons: readonly string[]
  readonly seam?: string
  readonly surface: 'ptc' | 'native' | 'unknown'
  readonly source: 'plugin' | 'preset' | 'native' | 'unknown'
  readonly mounted: boolean
  readonly lastError?: string
}

/**
 * Report what the live host agents actually expose. This reads the same agent
 * contexts the mount path uses, so a bootstrap report distinguishes "the host
 * has PTC" from "this agent scope could not take it".
 */
export function inspectAgentPtcRuntime(
  ctx: PluginContext,
  bindings: Readonly<Record<string, { architecture?: string } | undefined>>,
): readonly AgentPtcRuntimeEntry[] {
  const entries: AgentPtcRuntimeEntry[] = []
  for (const agent of listLiveAgents(ctx.agents)) {
    const agentId = agentIdOf(agent)
    if (agentId === undefined) continue
    const architecture = bindings[agentId]?.architecture
    if (!isTavernAgentArchitecture(architecture)) continue
    const status = typeof agent.status === 'string' ? agent.status : undefined
    const mounted = mountedByAgent.has(agentId)
    try {
      const host = hostContextOf(agent)
      const capabilities = host === undefined
        ? { available: false, reasons: ['the live agent exposes no scoped host context'] }
        : inspectPtcCapabilities(host)
      const lastError = lastApplyErrorByAgent.get(agentId)
      const mounted = mountedByAgent.has(agentId)
      const surface = describePtcSelection(host, agent)
      entries.push({
        agentId,
        status,
        architecture,
        capable: capabilities.available,
        capabilityReasons: capabilities.reasons,
        ...(capabilities.seam === undefined ? {} : { seam: capabilities.seam }),
        surface,
        source: surface === 'ptc' ? (mounted ? 'plugin' : 'preset') : surface === 'native' ? 'native' : 'unknown',
        mounted,
        ...(lastError === undefined ? {} : { lastError }),
      })
    } catch (error) {
      // Diagnostics must never break bootstrap; report the scope failure here.
      entries.push({
        agentId,
        status,
        architecture,
        capable: false,
        capabilityReasons: [messageOf(error)],
        surface: 'unknown',
        source: 'unknown',
        mounted,
      })
    }
  }
  return entries
}

/**
 * Mount PTC for one live agent when the switch is on and that agent belongs to
 * a bound Tavern architecture. Returns whether this call created a mount.
 */
export async function applyAgentPtcMode(
  agent: HostAgentLike,
  logger: PtcLogger | undefined,
): Promise<boolean> {
  const agentId = agentIdOf(agent)
  if (agentId === undefined || mountedByAgent.has(agentId)) return false
  // Presentation changes the wire tool surface; never flip it under a running
  // turn. The idle watch re-runs this after the current turn settles.
  if (agent.status === 'running') {
    scheduleAgentPtcReconcileWhenIdle(agent, logger)
    return false
  }
  const host = hostContextOf(agent)
  if (host === undefined) {
    lastApplyErrorByAgent.set(agentId, 'the live agent exposes no scoped host context')
    return false
  }
  const capabilities = inspectPtcCapabilities(host)
  if (!capabilities.available) {
    lastApplyErrorByAgent.set(agentId, capabilities.reasons.join(' '))
    return false
  }
  const db = await store()
  const state = await db.getState()
  if (state.agentPtcMode !== true) return false
  if (!isTavernAgentArchitecture(state.sessionBindings[agentId]?.architecture)) return false
  // A preset may already provide PTC at its own scope. Never shadow it: its
  // config and lifetime belong to the preset, and disposing our record must not
  // make the preset's executor unavailable. Adopting it also means switch-off
  // leaves preset-provided PTC in place.
  if (describePtcSelection(host, agent) === 'ptc') {
    lastApplyErrorByAgent.delete(agentId)
    return false
  }
  try {
    const mount = await mountPtc(host, agent)
    mountedByAgent.set(agentId, mount)
    lastApplyErrorByAgent.delete(agentId)
    return true
  } catch (error) {
    const message = messageOf(error)
    lastApplyErrorByAgent.set(agentId, message)
    logger?.warn?.(`dsh-soulmojito ptc: agent ${agentId} could not mount PTC: ${message}`)
    return false
  }
}

/** Remove one agent's PTC mode; safe when none exists. */
export async function clearAgentPtcMode(
  agentId: string | undefined,
  logger: PtcLogger | undefined,
): Promise<void> {
  if (agentId === undefined) return
  lastApplyErrorByAgent.delete(agentId)
  const mount = mountedByAgent.get(agentId)
  if (mount === undefined) return
  mountedByAgent.delete(agentId)
  try {
    await mount.dispose()
  } catch (error) {
    logger?.warn?.(`dsh-soulmojito ptc: disposing agent ${agentId} PTC mode failed: ${messageOf(error)}`)
  }
}

/** Remove every live declaration, used on plugin unload and switch-off. */
export async function clearAllAgentPtcModes(logger: PtcLogger | undefined): Promise<void> {
  for (const agentId of [...mountedByAgent.keys()]) await clearAgentPtcMode(agentId, logger)
}

/**
 * Reconcile one agent with the persisted switch. Running agents are skipped so
 * the wire surface never changes in the middle of a turn; the idle watch calls
 * this again once the turn settles.
 */
async function reconcileAgentPtcMode(agent: HostAgentLike, logger: PtcLogger | undefined): Promise<void> {
  if (agent.status === 'running') {
    scheduleAgentPtcReconcileWhenIdle(agent, logger)
    return
  }
  const agentId = agentIdOf(agent)
  if (agentId === undefined) return
  const state = await (await store()).getState()
  if (state.agentPtcMode === true && isTavernAgentArchitecture(state.sessionBindings[agentId]?.architecture)) {
    await applyAgentPtcMode(agent, logger)
    return
  }
  await clearAgentPtcMode(agentId, logger)
}

/**
 * A running agent cannot change its wire tool surface mid-turn. `whenIdle`
 * makes the mode converge even when the `agent/status` idle edge was missed
 * (restored sessions, a state write racing session startup, or a host that
 * coalesces status notifications).
 */
function scheduleAgentPtcReconcileWhenIdle(agent: HostAgentLike, logger: PtcLogger | undefined): void {
  const agentId = agentIdOf(agent)
  if (agentId === undefined || idleReconciles.has(agentId)) return
  if (typeof agent.whenIdle !== 'function') return
  idleReconciles.add(agentId)
  void Promise.resolve(agent.whenIdle())
    .then(() => reconcileAgentPtcMode(agent, logger))
    .catch((error: unknown) => {
      logger?.warn?.(`dsh-soulmojito ptc: waiting for agent ${agentId} idle failed: ${messageOf(error)}`)
    })
    .finally(() => {
      idleReconciles.delete(agentId)
    })
}

/**
 * Reconcile live agents with the persisted switch after a state write or a
 * plugin restart. Agents that leave the Tavern architectures lose the mode;
 * agents that join while the switch is on gain it. Running agents keep their
 * current surface until the idle watch reconciles them.
 */
export async function refreshAgentPtcMode(ctx: PluginContext): Promise<void> {
  if (typeof ctx.agents?.list !== 'function') {
    ctx.logger?.warn?.('dsh-soulmojito ptc: the host exposes no agents.list(); the switch applies to new AgentTavern sessions only')
    return
  }
  const live = listLiveAgents(ctx.agents)
  const seen = new Set<string>()
  for (const agent of live) {
    const agentId = agentIdOf(agent)
    if (agentId === undefined) continue
    seen.add(agentId)
    try {
      await reconcileAgentPtcMode(agent, ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-soulmojito ptc: reconciling agent ${agentId} failed: ${messageOf(error)}`)
    }
  }
  for (const agentId of [...mountedByAgent.keys()]) {
    if (!seen.has(agentId)) await clearAgentPtcMode(agentId, ctx.logger)
  }
}

/**
 * Reconcile PTC mode at agent lifecycle boundaries. Session activation commands
 * also call `applyAgentPtcMode` directly because the binding may be created
 * after `agent/created`; this watcher covers restored idle sessions and late
 * status transitions.
 */
export function mountAgentPtcMode(ctx: PluginContext): void {
  ctx.on?.('agent/status' as string, (payload: unknown) => {
    const record = payload as AgentStatusPayload | null | undefined
    const agent = record?.agent
    if (agent === undefined) return
    const status = record?.status ?? agent.status
    if (status !== 'idle') return
    void reconcileAgentPtcMode(agent, ctx.logger).catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-soulmojito ptc: idle reconcile failed: ${messageOf(error)}`)
    })
  })
  ctx.on?.('agent/disposed' as string, (payload: unknown) => {
    const agent = (payload as AgentStatusPayload | null | undefined)?.agent
    void clearAgentPtcMode(agentIdOf(agent), ctx.logger).catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-soulmojito ptc: disposal reconcile failed: ${messageOf(error)}`)
    })
  })
  try {
    ctx.effect(() => () => { void clearAllAgentPtcModes(ctx.logger) }, 'dsh-soulmojito: agent ptc mode')
  } catch {
    // A host that rejects a late effect only loses unload cleanup.
  }
}
