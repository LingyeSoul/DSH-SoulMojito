/**
 * Live-agent and binding resolution for the body session readers.
 *
 * Split out of `body-session.ts` so the session module stays inside the source
 * budget; the session module re-exports every symbol, so existing importers
 * keep their entry point.
 */

import type { BodyAgentLike, BodySessionLike } from './body-runtime.js'
import {
  errorMessage,
  isRecord,
  warn,
  type BodyAgentsHost,
  type BodyBindingHost,
  type BodyBindingView,
} from './body-session-contract.js'

/** Narrow one host value to the live-agent surface the body runtime needs. */
export function bodyAgentOf(value: unknown): BodyAgentLike | undefined {
  if (!isRecord(value)) return undefined
  const session = value['session']
  if (!isBodySession(session)) return undefined
  if (typeof value['followup'] !== 'function') return undefined
  return value as unknown as BodyAgentLike
}

/** Resolve a live agent from `ctx.agents.get`. */
export function resolveLiveAgent(ctx: BodyAgentsHost, sessionId: string): BodyAgentLike | undefined {
  const agents = ctx.agents
  const get = agents?.get
  if (agents === undefined || typeof get !== 'function') return undefined
  try {
    return bodyAgentOf(get.call(agents, sessionId))
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: agents.get failed', { sessionId, error: errorMessage(error) })
    return undefined
  }
}

/** All live agents the host exposes; empty on hosts without `agents.list`. */
export function listLiveAgents(ctx: BodyAgentsHost): readonly BodyAgentLike[] {
  const agents = ctx.agents
  const list = agents?.list
  if (agents === undefined || typeof list !== 'function') return []
  let values: unknown
  try {
    values = list.call(agents)
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: agents.list failed', { error: errorMessage(error) })
    return []
  }
  if (!Array.isArray(values)) return []
  const agentsOut: BodyAgentLike[] = []
  for (const value of values) {
    const agent = bodyAgentOf(value)
    if (agent !== undefined) agentsOut.push(agent)
  }
  return agentsOut
}

/** Resolve one session's Tavern binding through the injected resolver. */
export async function resolveBodyBinding(
  ctx: BodyBindingHost,
  sessionId: string,
): Promise<BodyBindingView | undefined> {
  const bindingOf = ctx.bindingOf
  if (typeof bindingOf !== 'function') {
    warn(ctx, 'dsh-soulmojito body: no binding resolver is wired; body operations disabled', {
      reason: 'architecture-mismatch',
      sessionId,
    })
    return undefined
  }
  try {
    return await bindingOf(sessionId)
  } catch (error) {
    warn(ctx, 'dsh-soulmojito body: binding lookup failed', { sessionId, error: errorMessage(error) })
    return undefined
  }
}

/** Only AgentTavern single-character sessions own body operations. */
export function bodyBindingEligible(binding: BodyBindingView | undefined): boolean {
  return binding !== undefined && binding.architecture === 'agent-tavern' && binding.group !== true
}

function isBodySession(value: unknown): value is BodySessionLike {
  if (!isRecord(value)) return false
  return typeof value['append'] === 'function'
}
