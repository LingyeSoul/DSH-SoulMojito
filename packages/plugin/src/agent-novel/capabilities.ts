/**
 * AgentNovel host capability report (proposal 0005 §16).
 *
 * Pure feature detection in the style of packages/bind/src/host-shape.ts:
 * typeof probes only, never version numbers. Fail-closed: a missing core
 * contract item makes the whole preset unavailable — no silent degradation
 * to a manual chat. Event emission itself cannot be probed statically, so
 * per-event entries only verify that the subscription hook exists and say
 * so explicitly in the reason text.
 *
 * The writer-subagent probes (proposal 0007 §9 P1–P3) are deliberately NOT
 * part of inspectAgentNovelCapabilities: they need real subagent spawns and
 * must never run on the plugin startup path. They live in
 * inspectWriterSubagentCapabilities below and are triggered only from
 * explicit request surfaces (novel creation with writerMode=subagent, the
 * debug probe route).
 */

import type { SubagentRuntimeLike, SubagentRunLike } from '../agent-tavern/deduce.js'
import { takeProbeAgentId } from './usage.js'

export const AGENT_NOVEL_PRESET_ID = 'agent-novel'

export interface AgentNovelCapabilities {
  available: boolean
  missing: string[]
  reasons: string[]
  checkedAt: string
}

export interface AgentNovelCapabilityContext {
  agents?: unknown
  agentPresets?: unknown
  systemPrompt?: unknown
  tools?: unknown
  on?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** Event types the novel lifecycle must subscribe to (§9.1 receive barrier, §12.1 scheduling). */
const REQUIRED_EVENT_TYPES = ['session/event', 'agent/created', 'agent/status'] as const

export function inspectAgentNovelCapabilities(ctx: AgentNovelCapabilityContext | null | undefined): AgentNovelCapabilities {
  const missing: string[] = []
  const reasons: string[] = []
  const need = (id: string, ok: boolean, reason: string): void => {
    if (ok) return
    missing.push(id)
    reasons.push(reason)
  }

  const agents = isObject(ctx?.agents) ? ctx?.agents as Record<string, unknown> : undefined
  need('agents', agents !== undefined, "host context exposes no 'agents' service object (§16 followup scheduling)")
  need('agents.withoutInitiator', isFunction(agents?.withoutInitiator), "agents.withoutInitiator is not callable; agent-initiated followups without a user initiator cannot be driven (§16)")

  const presets = isObject(ctx?.agentPresets) ? ctx?.agentPresets as Record<string, unknown> : undefined
  need('agentPresets.mount', isFunction(presets?.mount), "agentPresets.mount is not callable; the novel preset cannot be mounted (§16)")
  need('agentPresets.recompose', isFunction(presets?.recompose), "agentPresets.recompose is not callable; preset recomposition for the novel architecture is unavailable (§16)")

  const systemPrompt = isObject(ctx?.systemPrompt) ? ctx?.systemPrompt as Record<string, unknown> : undefined
  need('systemPrompt.section', isFunction(systemPrompt?.section), "systemPrompt.section is not callable; the novel kernel cannot be registered (§11)")
  need('tools.register', isFunction(isObject(ctx?.tools) ? (ctx?.tools as Record<string, unknown>).register : undefined), "tools.register is not callable; the novel tool surface cannot be registered (§11)")

  for (const eventType of REQUIRED_EVENT_TYPES) {
    need(
      `on:${eventType}`,
      isFunction(ctx?.on),
      `event subscription for '${eventType}' is unavailable: the host exposes no 'on' hook, and actual emission of the event type cannot be probed statically (§16)`,
    )
  }

  return {
    available: missing.length === 0,
    missing,
    reasons,
    checkedAt: new Date().toISOString(),
  }
}

/* ---------------- writer-subagent runtime probes (0007 §9) ---------------- */

/** One probe outcome; lossless-JSON discipline: every field is concrete. */
export interface WriterProbeItem {
  status: 'pass' | 'fail' | 'inconclusive'
  detail: string
}

/** P3 is not automatable in-process (needs a real-model E2E sequence). */
export interface WriterProbeDeferred {
  status: 'deferred-to-e2e'
  reason: string
}

export interface WriterProbeReport {
  probedAt: string
  /** False when no subagent could be spawned at all (runtime missing or start threw). */
  spawnOk: boolean
  /** P1 identity correlation: exec.agent.id inside the subagent equals the spawn run id (§6.2/§9). */
  p1: WriterProbeItem
  /** P2 allow-list effectiveness: allow-reachable (proven by P1's spawn) plus allow-outside-denied (observational). */
  p2: WriterProbeItem
  p3: WriterProbeDeferred
}

export interface WriterProbeDeps {
  /** Subagent runtime discovered from a request context; undefined yields a spawnOk:false report. */
  runtime?: SubagentRuntimeLike
  /** Parent handle for spawn lineage (the author agent when available). */
  parent?: unknown
  signal?: AbortSignal
}

const PROBE_TOOL = 'novel_status_read'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputExcerptOf(output: ReadonlyArray<{ type?: string; text?: string }>): string {
  const text = output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
  return text === '' ? '(no text output)' : `output '${text.slice(0, 120)}'`
}

/** One scripted spawn; never throws — failures come back as ok:false. */
async function probeSpawn(deps: WriterProbeDeps, label: string, prompt: string, allow: readonly string[] | null): Promise<
  | { ok: true; runId: string; result: { output: Array<{ type?: string; text?: string }>; stopReason: string; diagnostic?: string } }
  | { ok: false; error: string }
> {
  const runtime = deps.runtime
  if (runtime === undefined || typeof runtime.start !== 'function') {
    return { ok: false, error: 'subagent runtime is unavailable in this deployment (enable the dsh-subagent bundle with an in-process "spawn" provider, 0007 §5)' }
  }
  const signal = deps.signal ?? new AbortController().signal
  let run: SubagentRunLike | undefined
  try {
    run = await runtime.start('spawn', {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent: deps.parent,
      signal,
      ...(allow === null ? {} : { toolFilter: { allow } }),
    })
  } catch (error) {
    return { ok: false, error: `spawn failed: ${messageOf(error)}` }
  }
  try {
    const result = await run.result
    return { ok: true, runId: run.id, result }
  } catch (error) {
    return { ok: false, error: `run result rejected: ${messageOf(error)}` }
  } finally {
    try {
      await run.dispose()
    } catch {
      /* teardown races on a degraded runtime are expected */
    }
  }
}

/**
 * P1 (0007 §9): spawn a subagent whose allow list contains exactly
 * novel_status_read and instruct it to call the tool once. The tool body
 * records its exec.agent.id into the one-shot probe slot (see usage.ts); after
 * the run settles, the recorded id must equal the spawn run id. The tool is
 * expected to FAIL with a binding error inside the probe (the run has no novel
 * session binding) — the record happens before binding resolution, so the
 * failure is fine; only the identity correlation matters.
 */
async function probeIdentityCorrelation(deps: WriterProbeDeps): Promise<{ item: WriterProbeItem; spawnOk: boolean }> {
  takeProbeAgentId() // clear leftovers from unrelated novel_status_read calls
  const spawn = await probeSpawn(
    deps,
    'dsh-tavern writer-probe · p1-identity',
    `Host capability probe. Call the tool ${PROBE_TOOL} exactly once, then reply with exactly: ok. The tool may return an error about a missing novel binding — that is expected and fine; still reply ok after the single call.`,
    [PROBE_TOOL],
  )
  if (!spawn.ok) return { item: { status: 'fail', detail: `P1 spawn did not complete: ${spawn.error}` }, spawnOk: false }
  const recorded = takeProbeAgentId()
  if (recorded === spawn.runId) {
    return {
      item: { status: 'pass', detail: `subagent tool execution carried exec.agent.id '${recorded}' equal to the spawn run id; the delegation registry key (0007 §6.2) is derivable` },
      spawnOk: true,
    }
  }
  const detail = recorded === null
    ? `${PROBE_TOOL} never executed inside the probe subagent (stopReason ${spawn.result.stopReason}; ${outputExcerptOf(spawn.result.output)}) — the model may have skipped the call; re-run the probe before treating this as a host gap`
    : `exec.agent.id '${recorded}' does not match the spawn run id '${spawn.runId}' (stopReason ${spawn.result.stopReason}) — subagent tool executions are not attributable to their run`
  return { item: { status: 'fail', detail }, spawnOk: true }
}

/**
 * P2 (0007 §9): the allow-reachable half is proven by the P1 spawn (the tool
 * executed under allow: [novel_status_read]). The allow-outside-denied half
 * spawns a second subagent with an empty allow list and observes its report:
 * only a tool execution observed under allow: [] is a hard fail (the host
 * toolFilter is not enforced); a model-reported "unavailable" passes
 * observationally; anything else is inconclusive (model compliance is never
 * guaranteed, 0007 §9 P2 wording).
 */
async function probeAllowList(deps: WriterProbeDeps, p1: WriterProbeItem, spawnOk: boolean): Promise<WriterProbeItem> {
  if (!spawnOk) return { status: 'fail', detail: `allow-reachable half not probed: the P1 spawn itself failed (${p1.detail})` }
  if (p1.status !== 'pass') {
    return { status: 'inconclusive', detail: `allow-reachable half unproven because P1 did not confirm a tool execution inside an allow-listed subagent (${p1.detail})` }
  }
  takeProbeAgentId()
  const spawn = await probeSpawn(
    deps,
    'dsh-tavern writer-probe · p2-allowlist',
    `Host capability probe. Try calling the tool ${PROBE_TOOL} once. If the tool is available to you, reply with exactly: tool-ran. If the tool is not available to you, reply with exactly: unavailable.`,
    [],
  )
  if (!spawn.ok) return { status: 'fail', detail: `P2 spawn did not complete: ${spawn.error}` }
  const recorded = takeProbeAgentId()
  if (recorded !== null) {
    return { status: 'fail', detail: `${PROBE_TOOL} executed inside a subagent spawned with an empty allow list (exec.agent.id '${recorded}') — the host toolFilter does not enforce allow lists` }
  }
  const text = spawn.result.output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text ?? '').trim().toLocaleLowerCase())
    .join('\n')
  if (text.includes('unavailable')) {
    return { status: 'pass', detail: `allow-reachable proven by the P1 execution; the empty-allow subagent reported the tool unavailable (observational — model-reported, not a host-side denial proof)` }
  }
  return {
    status: 'inconclusive',
    detail: `allow-reachable proven by the P1 execution; the empty-allow subagent neither executed the tool nor clearly reported it unavailable (stopReason ${spawn.result.stopReason}; ${outputExcerptOf(spawn.result.output)}) — model compliance limits the probe; re-run or verify on a real E2E delegation`,
  }
}

/**
 * Runtime probe of the writer-subagent host contracts (0007 §9 P1–P3). Never
 * runs on the startup path; callers decide the surface (novel creation gate,
 * debug route). P1 fail blocks writerMode=subagent (W2) fail-closed: the
 * caller returns the report with the rejection instead of silently degrading.
 */
export async function inspectWriterSubagentCapabilities(deps: WriterProbeDeps = {}): Promise<WriterProbeReport> {
  const { item: p1, spawnOk } = await probeIdentityCorrelation(deps)
  const p2 = await probeAllowList(deps, p1, spawnOk)
  return {
    probedAt: new Date().toISOString(),
    spawnOk,
    p1,
    p2,
    p3: {
      status: 'deferred-to-e2e',
      reason: 'end-to-end delegation (research → commit → out-of-scope rejection timing) requires a real-model run; not automatable in-process (0007 §9 P3)',
    },
  }
}
