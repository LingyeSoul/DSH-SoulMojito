/**
 * AgentNovel automatic scheduling driver (docs/proposals/0005-agent-novel-architecture.md §12).
 *
 * The driver contains no LLM: it reads the persisted run state and wakes the
 * bound author agent through the host followup mechanism (§12.1). Scheduling
 * is at-least-once (§12.2): intents are persisted before the followup, while
 * claims, commit dedup and execution generations keep every unit at most one
 * successful body commit. Structural host types are local (mirroring
 * agent-tavern/agent.ts AgentContextLike); the dsh-goal-round-driver is the
 * behavioural reference (withoutInitiator wrapping, status re-arm, turn/end
 * edges), never an import.
 *
 * Known host traps covered here (see tests):
 * - Cordis service gating has two shapes on an inactive fiber: `agents.get(id)`
 *   may return undefined, and merely reading `agents.withoutInitiator` may
 *   throw. Every host service access degrades individually.
 * - AgentLoop dispatches `turn/end` synchronously from `turn()`'s finally,
 *   before `kick()`'s finally clears `running`; a drive started from that edge
 *   can observe `status === 'running'`. The driver levels the edge by awaiting
 *   `whenIdle()` once and re-arming instead of returning bare.
 * - Synthetic turn/start|turn/end events are never appended to sessions; the
 *   kickoff guarantee is the agent liveness carried by the novel-open command.
 * - Driver notices carry a plugin source (never a user source), which is what
 *   the requirements receive barrier keys on (§9.1); the notice's novel and
 *   intent identity rides in the message id and the source summary because the
 *   released v0 Session dispositions admit only {kind, plugin, form, sections,
 *   summary} members on plugin sources, with form limited to instructions |
 *   catalog | snapshot | notice | relay | recall.
 */

import {
  requirementWatermark,
  type NovelSnapshot,
  type NovelStore,
  type TavernStore,
} from '../../../tavern-store/src/index.js'
import { nextWork, renderWorkBrief, type NovelWork } from './outline.js'
import { drainToolOutputBytes, drainWriterRunUsage } from './usage.js'

/* ------------------------------ host shapes ------------------------------ */

export interface NovelDriverHost {
  /** Host agents service; every property read degrades individually (§16). */
  agents?: { withoutInitiator?: <T>(op: () => T) => T; get?: (id: string) => DriverAgentLike | undefined } | Record<string, unknown> | unknown
  on?: (event: string, handler: (payload: never) => void | Promise<void>) => unknown
  effect?: (fn: () => void, name: string) => void
  /** Optional structured logger (§13 structured fields); falls back to console. */
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void }
}

/** Local structural type of the public host Agent handle (§16). */
export interface DriverAgentLike {
  id: string
  session: { id: string }
  status: 'idle' | 'running'
  followup: (message: unknown) => Promise<unknown> | unknown
  whenIdle: () => Promise<void>
}

/** Optional projection-recovery hook (§12.1/§12.3); NovelProjector implements it. */
export interface NovelProjectionRepair {
  projectionPending(novelId: string): Promise<boolean>
  repairProjections(novelId: string): Promise<void>
}

export interface NovelDriverOptions {
  store: NovelStore
  tavern: Pick<TavernStore, 'getState'>
  projector?: NovelProjectionRepair
}

/* ------------------------------ driver state ------------------------------ */

interface NovelDriveState {
  requested: boolean
  run: Promise<void> | undefined
  /** Intent ids whose followup was delivered and whose turn end is awaited (§12.2). */
  readonly queued: Set<string>
  /** Kickoff (initial outline-create notice) delivered in this driver lifetime. */
  kickoffSent: boolean
  warnedNoAgent: boolean
  /** Last session turn number accounted; dedupes duplicate turn/end edges. */
  lastAccountedTurn: number
}

/* --------------------------------- driver --------------------------------- */

export class NovelDriver {
  private readonly store: NovelStore
  private readonly tavern: Pick<TavernStore, 'getState'>
  private readonly projector: NovelProjectionRepair | undefined
  private disposed = false
  private readonly states = new Map<string, NovelDriveState>()
  private readonly liveAgents = new Map<string, DriverAgentLike>()
  private readonly novelSessions = new Map<string, string>()
  private readonly sessionNovels = new Map<string, string>()
  private readonly disposers: Array<() => unknown> = []

  private constructor(private readonly host: NovelDriverHost, options: NovelDriverOptions) {
    this.store = options.store
    this.tavern = options.tavern
    this.projector = options.projector
  }

  /** Creates the driver and subscribes agent/created, agent/disposed and agent/status (§12.1). */
  static create(host: NovelDriverHost, options: NovelDriverOptions): NovelDriver {
    const driver = new NovelDriver(host, options)
    driver.mount()
    return driver
  }

  private mount(): void {
    const subscribe = (): void => {
      this.subscribeTo('agent/created', (payload) => {
        const agent = agentOf(payload)
        if (agent !== null) this.liveAgents.set(agent.id, agent)
      })
      this.subscribeTo('agent/disposed', (payload) => {
        const agent = agentOf(payload)
        if (agent !== null) this.liveAgents.delete(agent.id)
      })
      this.subscribeTo('agent/status', (payload) => {
        const agent = agentOf(payload)
        if (agent === null) return
        // Keep the freshest reference; this also captures agents that existed
        // before mount whose created event was missed on a degraded fiber.
        this.liveAgents.set(agent.id, agent)
        if ((payload as { status?: unknown }).status !== 'idle') return
        void this.scheduleForSession(agent)
      })
    }
    const effect = this.host.effect
    if (typeof effect === 'function') {
      try {
        effect(subscribe, 'dsh-tavern:novel-driver')
        return
      } catch {
        // Degrade to a bare subscription when the effect hook is gated.
      }
    }
    subscribe()
  }

  private subscribeTo(event: string, handler: (payload: never) => void): void {
    try {
      const on = this.host.on
      if (typeof on !== 'function') return
      const dispose = on(event, handler)
      if (typeof dispose === 'function') this.disposers.push(dispose as () => unknown)
    } catch (error) {
      this.logWarn('subscribe-failed', { event, errorCode: errorCodeOf(error) })
    }
  }

  /* ------------------------------ entry points ------------------------------ */

  /** Called by the internal novel-open command: captures the agent, applies the
   *  horizontal kickoff gate and schedules (§12.1). The command handler always
   *  receives a live agent, which is the cold-session kickoff guarantee. */
  async handleNovelOpen(agent: DriverAgentLike, novelId: string): Promise<void> {
    if (this.disposed) return
    this.liveAgents.set(agent.id, agent)
    this.sessionNovels.set(agent.session.id, novelId)
    this.novelSessions.set(novelId, agent.id)
    try {
      const snapshot = await this.store.getNovel(novelId)
      // §12.3 horizontal kickoff recovery: chapters on disk prove the kickoff
      // was already delivered even though this driver lost the memory state.
      if ((snapshot?.outline?.chapters.length ?? 0) > 0) this.stateFor(novelId).kickoffSent = true
    } catch (error) {
      this.logWarn('novel-open-read-failed', { novelId, sessionId: agent.session.id, errorCode: errorCodeOf(error) })
    }
    this.schedule(novelId)
  }

  /** Session event edge (§12.1): turn/end of a bound novel session accounts the
   *  turn (§13), resolves the delivered work intent and schedules the next
   *  work. Duplicate edges of the same turn boundary are deduped; drives that
   *  observe a still-running agent level out via whenIdle. */
  async handleSessionEvent(session: { id: string }, event: { type?: string; data?: unknown }): Promise<void> {
    if (this.disposed || event.type !== 'turn/end') return
    const novelId = await this.novelOfSession(session.id)
    if (novelId === null) return
    const state = this.stateFor(novelId)
    const turn = turnOf(event.data)
    if (turn !== null && turn <= state.lastAccountedTurn) return
    if (turn !== null) state.lastAccountedTurn = turn
    try {
      const snapshot = await this.store.getNovel(novelId)
      if (snapshot !== undefined && snapshot.run.status !== 'completed') {
        const failed = failedStopReason(event.data)
        await this.store.noteTurn(novelId, {
          failed,
          ...(failed ? { error: `turn ended with stop reason ${stopReasonOf(event.data)}` } : {}),
        })
        await this.sampleToolUsage(novelId, turn)
        const signature = progressSignature(snapshot)
        if (signature !== snapshot.run.lastProgressSignature) {
          await this.store.noteProgress(novelId, { signature })
        }
        const inFlight = snapshot.run.inFlightIntent
        if (inFlight !== null && state.queued.has(inFlight.intentId)) {
          await this.store.resolveWorkIntent(novelId, { intentId: inFlight.intentId, outcome: 'delivered' })
          state.queued.delete(inFlight.intentId)
        }
      }
    } catch (error) {
      this.logWarn('turn-accounting-failed', { novelId, sessionId: session.id, operation: 'note-turn', errorCode: errorCodeOf(error) })
    }
    this.schedule(novelId)
  }

  /**
   * W0 usage sampling (0007 §7): after a successful noteTurn, drain the
   * in-process per-tool output-byte accumulator and the writer-run observation
   * slot (P4 fail-open: host-reported usage counters and the delegated
   * writer's prose size) and persist one audit sample. Audit-grade, never
   * authoritative: both slots are process-global without novel attribution,
   * so with multiple novels running concurrently the drained values are
   * attributed to the novel whose turn just ended — a known limitation
   * accepted for an observation-only signal. Sampling failures are logged and
   * never affect accounting or scheduling. Turn edges without a session turn
   * number (degraded host shape) still account the turn but skip the sample:
   * the recorded turn ordinal must come from the same source as the
   * accounting edge.
   */
  private async sampleToolUsage(novelId: string, turn: number | null): Promise<void> {
    if (turn === null) return
    try {
      const toolBytes = drainToolOutputBytes()
      const writerUsage = drainWriterRunUsage()
      if (Object.keys(toolBytes).length === 0 && writerUsage.outputChars === null && writerUsage.usage === null) return
      await this.store.noteUsageSample(novelId, {
        recordedAt: new Date().toISOString(),
        turn,
        toolBytes,
        ...(writerUsage.outputChars !== null ? { writerOutputChars: writerUsage.outputChars } : {}),
        ...(writerUsage.usage !== null ? { usage: writerUsage.usage } : {}),
      })
    } catch (error) {
      this.logWarn('usage-sample-failed', { novelId, operation: 'note-usage-sample', errorCode: errorCodeOf(error) })
    }
  }

  /* ------------------------------- scheduling ------------------------------- */

  /** External re-arm for user-driven state flips (resume, outline approval,
   * revision authorization): those routes turn a paused novel active without
   * any session event, and an idle agent produces no turn/end or agent/status
   * edge — without this poke the active novel would never be scheduled again
   * (§12.1 edges alone cannot wake it). */
  kick(novelId: string): void {
    this.schedule(novelId)
  }

  private stateFor(novelId: string): NovelDriveState {
    const existing = this.states.get(novelId)
    if (existing !== undefined) return existing
    const state: NovelDriveState = { requested: false, run: undefined, queued: new Set<string>(), kickoffSent: false, warnedNoAgent: false, lastAccountedTurn: 0 }
    this.states.set(novelId, state)
    return state
  }

  private schedule(novelId: string): void {
    if (this.disposed) return
    const state = this.stateFor(novelId)
    state.requested = true
    if (state.run !== undefined) return
    const loop = this.withoutInitiator((): Promise<void> => this.driveLoop(novelId, state))
    state.run = loop
    const retire = (): void => {
      if (state.run === loop) state.run = undefined
      if (state.requested && !this.disposed) this.schedule(novelId)
    }
    loop.then(retire, (error) => {
      // driveLoop never rejects by contract; a degraded wrapper still might.
      this.logWarn('drive-loop-rejected', { novelId, operation: 'drive', errorCode: errorCodeOf(error) })
      retire()
    })
  }

  private async scheduleForSession(agent: DriverAgentLike): Promise<void> {
    const novelId = await this.novelOfSession(agent.session.id)
    if (novelId !== null) this.schedule(novelId)
  }

  private async driveLoop(novelId: string, state: NovelDriveState): Promise<void> {
    while (state.requested && !this.disposed) {
      state.requested = false
      try {
        await this.drive(novelId, state)
      } catch (error) {
        // §12.1: a drive failure is logged with structured fields, never fatal.
        this.logWarn('drive-failed', { novelId, operation: 'drive', errorCode: errorCodeOf(error) })
      }
    }
  }

  /** One serialized pass of the §12.1 drive pseudocode for a single novel. */
  private async drive(novelId: string, state: NovelDriveState): Promise<void> {
    const snapshot = await this.store.getNovel(novelId)
    if (snapshot === undefined) {
      this.states.delete(novelId)
      this.novelSessions.delete(novelId)
      for (const [sessionId, bound] of this.sessionNovels) {
        if (bound === novelId) this.sessionNovels.delete(sessionId)
      }
      return
    }
    if (snapshot.run.status !== 'active') return // §12.3: paused/completed never self-wake

    const agent = await this.agentFor(novelId)
    if (agent === null) {
      if (!state.warnedNoAgent) {
        state.warnedNoAgent = true
        this.logWarn('no-live-agent', { novelId, operation: 'drive' })
      }
      return // cold session: agent/created plus agent/status(idle) re-arm
    }
    state.warnedNoAgent = false

    if (agent.status !== 'idle') {
      // Level the turn edge: turn/end can fire while status is still 'running'
      // because the AgentLoop clears idle after dispatching the edge.
      try {
        await agent.whenIdle()
      } catch (error) {
        this.logWarn('when-idle-failed', { novelId, sessionId: agent.session.id, operation: 'when-idle', errorCode: errorCodeOf(error) })
      }
      state.requested = true
      return
    }

    if (this.projector !== undefined) {
      let pending = false
      try {
        pending = await this.projector.projectionPending(novelId)
      } catch (error) {
        this.logWarn('projection-pending-check-failed', { novelId, operation: 'projection-pending', errorCode: errorCodeOf(error) })
      }
      if (pending) {
        try {
          await this.projector.repairProjections(novelId)
        } catch (error) {
          this.logWarn('projection-repair-failed', { novelId, operation: 'projection-repair', errorCode: errorCodeOf(error) })
          await this.store.pause(novelId, {
            reason: 'projection-pending',
            detail: `projection repair failed: ${messageOf(error)}`,
            resumeHint: 'repair the reading projections, then resume explicitly (§13)',
          })
          return
        }
      }
    }

    const inFlight = snapshot.run.inFlightIntent
    if (inFlight !== null && state.queued.has(inFlight.intentId)) return // delivered, awaiting its turn end (§12.2)

    const work = nextWork(snapshot)
    if (work === null) return
    if (work.kind === 'outline-create' && inFlight === null && this.kickoffDelivered(novelId, snapshot)) {
      return // horizontal kickoff gate: never re-nag the initial outline (§12.3)
    }

    let unitId: string | null = null
    let briefSnapshot = snapshot
    if (work.kind === 'write-unit' && work.chapterId !== null && work.sceneId !== null) {
      // A claimed unit for this scene is being written right now. Its commit —
      // or its turn ending — re-arms the drive, so wait instead of preparing a
      // duplicate unit or re-delivering the same brief (a claim legitimately
      // survives its turn ending, §12.1; the nextWork scene check is
      // commit-based and cannot see it). A merely prepared unit does not
      // skip: the in-flight intent machinery may still owe it a delivery.
      const claimedSibling = snapshot.units.find((unit) => unit.chapterId === work.chapterId && unit.sceneId === work.sceneId && unit.state === 'claimed')
      if (claimedSibling !== undefined) return
      const scene = snapshot.outline?.scenes.find((candidate) => candidate.sceneId === work.sceneId)
      if (scene === undefined) {
        this.logWarn('scene-missing', { novelId, sceneId: work.sceneId })
        return
      }
      try {
        // §6.3: the driver prepares the unit for the first unfinished scene;
        // preparing the same scene is idempotent in the store.
        const prepared = await this.store.prepareUnit(novelId, {
          chapterId: work.chapterId,
          sceneId: scene.sceneId,
          label: scene.goal.slice(0, 80),
          goal: scene.goal,
          continuationAnchor: anchorForScene(snapshot, scene.sceneId),
        })
        unitId = prepared.unitId
        briefSnapshot = (await this.store.getNovel(novelId)) ?? snapshot
      } catch (error) {
        this.logWarn('prepare-unit-failed', { novelId, sceneId: work.sceneId, errorCode: errorCodeOf(error) })
        return
      }
    }

    // §12.1: persist the work intent BEFORE the followup; the call is
    // idempotent and reuses an existing in-flight intent (crash window).
    const intent = await this.store.recordWorkIntent(novelId, {
      kind: work.kind,
      ...(unitId !== null ? { unitId } : {}),
      expectedOutlineRevision: briefSnapshot.outline?.outlineRevision ?? null,
      expectedRequirementSequence: requirementWatermark(briefSnapshot.requirements),
    })
    if (state.queued.has(intent.intentId)) return

    const message = buildNoticeMessage(novelId, intent.intentId, briefSnapshot, work, unitId)
    try {
      await this.deliverFollowup(agent, novelId, intent.intentId, message, briefSnapshot.config.budgets.externalRetry)
    } catch (error) {
      // §13: bounded retries exhausted -> resolve failed and pause stalled.
      this.logWarn('followup-failed', { novelId, sessionId: agent.session.id, intentId: intent.intentId, errorCode: errorCodeOf(error) })
      try {
        await this.store.resolveWorkIntent(novelId, {
          intentId: intent.intentId,
          outcome: 'failed',
          error: `followup delivery failed: ${messageOf(error)}`,
        })
        await this.store.pause(novelId, {
          reason: 'stalled',
          detail: `followup delivery failed after ${briefSnapshot.config.budgets.externalRetry.maxAttempts} attempts: ${messageOf(error)}`,
          resumeHint: 'resume explicitly after reviewing the delivery failure (§13)',
        })
      } catch (handled) {
        this.logWarn('followup-failure-handling-failed', { novelId, intentId: intent.intentId, operation: 'pause', errorCode: errorCodeOf(handled) })
      }
      return
    }
    state.queued.add(intent.intentId)
    if (work.kind === 'outline-create') state.kickoffSent = true
  }

  private async deliverFollowup(
    agent: DriverAgentLike,
    novelId: string,
    intentId: string,
    message: unknown,
    retry: { maxAttempts: number; backoffMs: number },
  ): Promise<void> {
    let lastError: unknown = new Error('followup delivery was not attempted')
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        await agent.followup(message)
        return
      } catch (error) {
        lastError = error
        this.logWarn('followup-attempt-failed', { novelId, sessionId: agent.session.id, intentId, errorCode: errorCodeOf(error), attempt })
        if (attempt < retry.maxAttempts) await new Promise((resolve) => setTimeout(resolve, retry.backoffMs))
      }
    }
    throw lastError
  }

  /* -------------------------------- recovery -------------------------------- */

  /** Restart recovery (§12.3). Never crosses a paused state automatically. */
  async recover(): Promise<void> {
    let summaries
    try {
      summaries = await this.store.listNovels()
    } catch (error) {
      this.logWarn('recovery-list-failed', { operation: 'recover', errorCode: errorCodeOf(error) })
      return
    }
    let bindings: Record<string, { architecture: string; novelId?: unknown }>
    try {
      bindings = (await this.tavern.getState()).sessionBindings as Record<string, { architecture: string; novelId?: unknown }>
    } catch (error) {
      this.logWarn('recovery-bindings-failed', { operation: 'recover', errorCode: errorCodeOf(error) })
      return
    }
    const sessionsByNovel = new Map<string, string[]>()
    for (const [sessionId, binding] of Object.entries(bindings)) {
      if (binding.architecture !== 'agent-novel' || typeof binding.novelId !== 'string') continue
      const list = sessionsByNovel.get(binding.novelId) ?? []
      list.push(sessionId)
      sessionsByNovel.set(binding.novelId, list)
    }
    for (const summary of summaries) {
      const sessions = sessionsByNovel.get(summary.novelId) ?? []
      if (sessions.length === 0) continue
      // The binding map is registered for every bound novel regardless of
      // status: a restart while paused must still leave the kick path able
      // to discover the bound agent (§12.1); scheduling below stays
      // active-only.
      for (const sessionId of sessions) this.sessionNovels.set(sessionId, summary.novelId)
      if (summary.status !== 'active') continue // §12.3 step 3
      let snapshot: NovelSnapshot | undefined
      try {
        snapshot = await this.store.getNovel(summary.novelId)
      } catch (error) {
        this.logWarn('recovery-read-failed', { novelId: summary.novelId, operation: 'recover', errorCode: errorCodeOf(error) })
        continue
      }
      if (snapshot === undefined) continue
      // §12.3 step 4: only revoke after the old execution provably ended.
      const agent = this.liveAgentForSessions(sessions)
      if (snapshot.run.inFlightIntent !== null) {
        if (agent !== null && agent.status === 'running') {
          try {
            await this.store.pause(summary.novelId, {
              reason: 'recovery-required',
              detail: 'bound agent is still running; cannot prove the previous execution ended (§12.3)',
              resumeHint: 'wait for or stop the running agent, then resume explicitly',
            })
          } catch (error) {
            this.logWarn('recovery-pause-failed', { novelId: summary.novelId, operation: 'recover', errorCode: errorCodeOf(error) })
          }
          continue
        }
        try {
          await this.store.resolveWorkIntent(summary.novelId, { intentId: snapshot.run.inFlightIntent.intentId, outcome: 'cancelled' })
        } catch (error) {
          this.logWarn('recovery-resolve-failed', { novelId: summary.novelId, operation: 'recover', errorCode: errorCodeOf(error) })
        }
      }
      // Claimed units without a live agent are left untouched: the stop/retry
      // path owns their recovery (§12.3 step 4).
      // §12.3 step 5: rebuild expired projections before scheduling again.
      if (this.projector !== undefined) {
        try {
          if (await this.projector.projectionPending(summary.novelId)) await this.projector.repairProjections(summary.novelId)
        } catch (error) {
          this.logWarn('recovery-projection-failed', { novelId: summary.novelId, operation: 'recover', errorCode: errorCodeOf(error) })
          try {
            await this.store.pause(summary.novelId, {
              reason: 'recovery-required',
              detail: `projection repair failed during recovery: ${messageOf(error)}`,
            })
          } catch {
            /* already logged above */
          }
          continue
        }
      }
      this.schedule(summary.novelId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        const result = dispose()
        if (result instanceof Promise) await result.catch(() => {})
      } catch {
        // Teardown races on a degraded fiber are expected; nothing to undo.
      }
    }
    const runs: Array<Promise<void>> = []
    for (const state of this.states.values()) {
      if (state.run !== undefined) runs.push(state.run)
    }
    await Promise.allSettled(runs)
    this.states.clear()
    this.liveAgents.clear()
    this.novelSessions.clear()
    this.sessionNovels.clear()
  }

  /* --------------------------------- lookups --------------------------------- */

  private kickoffDelivered(novelId: string, snapshot: NovelSnapshot): boolean {
    if (this.states.get(novelId)?.kickoffSent === true) return true
    return (snapshot.outline?.chapters.length ?? 0) > 0
  }

  private async novelOfSession(sessionId: string): Promise<string | null> {
    const cached = this.sessionNovels.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const binding = (await this.tavern.getState()).sessionBindings[sessionId]
      if (binding === undefined || binding.architecture !== 'agent-novel') return null
      this.sessionNovels.set(sessionId, binding.novelId)
      return binding.novelId
    } catch (error) {
      this.logWarn('binding-read-failed', { sessionId, operation: 'binding', errorCode: errorCodeOf(error) })
      return null
    }
  }

  private liveAgentFor(novelId: string): DriverAgentLike | null {
    const preferred = this.novelSessions.get(novelId)
    if (preferred !== undefined) {
      const agent = this.liveAgents.get(preferred)
      if (agent !== undefined && this.agentStillLive(agent)) return agent
    }
    for (const agent of this.liveAgents.values()) {
      if (this.sessionNovels.get(agent.session.id) === novelId && this.agentStillLive(agent)) return agent
    }
    return null
  }

  /** liveAgentFor plus service discovery (§12.1 cold map): a host restart can
   * mount the plugin after the session remounted, so no agent/* event ever
   * reaches the driver, and recover's registration alone leaves paused
   * novels without an in-memory agent. Falls back to the host's agents
   * service keyed by bound session id, re-verifies the binding and adopts
   * the handle. Async because the binding re-check reads the tavern state. */
  private async agentFor(novelId: string): Promise<DriverAgentLike | null> {
    const registered = this.liveAgentFor(novelId)
    if (registered !== null) return registered
    for (const [sessionId, bound] of this.sessionNovels) {
      if (bound !== novelId) continue
      const agent = agentLikeOf(this.agentsGet(sessionId))
      if (agent === null) continue
      let bindingValid = false
      try {
        const state = (await this.tavern.getState()) as { sessionBindings?: Record<string, { architecture?: string; novelId?: unknown }> }
        const binding = state.sessionBindings?.[agent.session.id]
        bindingValid = binding?.architecture === 'agent-novel' && binding.novelId === novelId
      } catch {
        // A gated state read cannot disprove the binding; the recovery-time
        // registration is trusted as-is.
        bindingValid = true
      }
      if (!bindingValid) continue
      this.liveAgents.set(agent.id, agent)
      this.novelSessions.set(novelId, agent.id)
      return agent
    }
    return null
  }

  /** Gated probe of the host agents service; null when absent or throwing. */
  private agentsGet(sessionId: string): unknown {
    try {
      const agents = (this.host as { agents?: unknown }).agents
      if (typeof agents !== 'object' || agents === null) return null
      const get = (agents as { get?: unknown }).get
      if (typeof get !== 'function') return null
      return (get as (id: string) => unknown).call(agents, sessionId) ?? null
    } catch {
      return null
    }
  }

  private liveAgentForSessions(sessionIds: readonly string[]): DriverAgentLike | null {
    for (const agent of this.liveAgents.values()) {
      if (sessionIds.includes(agent.session.id) && this.agentStillLive(agent)) return agent
    }
    return null
  }

  /** Gated service probe with the two degradation shapes: undefined or throw. */
  private agentStillLive(agent: DriverAgentLike): boolean {
    try {
      const agents = (this.host as { agents?: unknown }).agents
      if (typeof agents !== 'object' || agents === null) return true
      const get = (agents as { get?: unknown }).get
      if (typeof get !== 'function') return true
      return get.call(agents, agent.id) === agent
    } catch {
      return true // cannot disprove liveness on a gated fiber; trust our map
    }
  }

  private withoutInitiator<T>(op: () => T): T {
    let wrap: ((operation: () => T) => T) | undefined
    try {
      const agents = (this.host as { agents?: unknown }).agents
      if (typeof agents === 'object' && agents !== null) {
        const candidate = (agents as { withoutInitiator?: unknown }).withoutInitiator
        if (typeof candidate === 'function') wrap = candidate as (operation: () => T) => T
      }
    } catch {
      // Property access itself threw on the inactive fiber; run bare.
    }
    if (wrap === undefined) return op()
    try {
      return wrap(op)
    } catch {
      return op()
    }
  }

  private logWarn(operation: string, fields: Record<string, unknown>): void {
    const record: Record<string, unknown> = { ...fields, operation }
    try {
      const warn = this.host.logger?.warn
      if (typeof warn === 'function') warn(`novel-driver: ${operation}`, record)
      else console.warn(`novel-driver: ${operation}`, JSON.stringify(record))
    } catch {
      // Logging must never kill the driver.
    }
  }
}

/** Standalone restart-recovery entry (§12.3). */
export async function recoverNovels(driver: NovelDriver): Promise<void> {
  await driver.recover()
}

/* --------------------------------- helpers --------------------------------- */

function agentOf(payload: unknown): DriverAgentLike | null {
  if (typeof payload !== 'object' || payload === null) return null
  return agentLikeOf((payload as { agent?: unknown }).agent)
}

/** Shape probe shared by the agent/* events and service discovery. */
function agentLikeOf(candidate: unknown): DriverAgentLike | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const agent = candidate as { id?: unknown; session?: unknown; status?: unknown; followup?: unknown; whenIdle?: unknown }
  if (typeof agent.id !== 'string' || typeof agent.followup !== 'function' || typeof agent.whenIdle !== 'function') return null
  if (typeof agent.session !== 'object' || agent.session === null || typeof (agent.session as { id?: unknown }).id !== 'string') return null
  if (agent.status !== 'idle' && agent.status !== 'running') return null
  return agent as DriverAgentLike
}

function turnOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const turn = (data as { turn?: unknown }).turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null
}

function stopReasonOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return 'unknown'
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return 'unknown'
  const kind = (reason as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : 'unknown'
}

/** §13: abnormal turn endings count as failed turns. */
function failedStopReason(data: unknown): boolean {
  const reason = stopReasonOf(data)
  return reason === 'max-tokens' || reason === 'aborted'
}

/**
 * Per-phase progress signature (§13): only substantive fields participate.
 * Pure outline rewording, repeated retrieval or memory refreshes never change
 * a writing/revising signature, so they cannot reset the stall counter.
 */
export function progressSignature(snapshot: NovelSnapshot): string {
  switch (snapshot.run.phase) {
    case 'outlining':
      return snapshot.outline === null ? 'outline:none' : `outline:${snapshot.outline.outlineRevision}`
    case 'revising':
      return `watermark:${requirementWatermark(snapshot.requirements)}`
    case 'writing':
      return `commits:${snapshot.commits.length};chapters:${snapshot.completedChapters.length}`
    case 'finishing':
      return snapshot.run.status === 'completed'
        ? 'finished'
        : `violations:${countFinishViolations(snapshot)}`
  }
}

function countFinishViolations(snapshot: NovelSnapshot): number {
  // Local recount of finishGuardViolations without importing store internals.
  let violations = 0
  const outline = snapshot.outline
  if (outline === null) return 1
  const completed = new Set(snapshot.completedChapters.map((entry) => entry.chapterId))
  for (const chapter of outline.chapters) {
    if (!completed.has(chapter.chapterId)) violations += 1
  }
  for (const item of outline.foreshadowing) {
    if (item.required && item.status !== 'resolved') violations += 1
  }
  for (const record of snapshot.requirements) {
    if (record.status === 'pending' || record.status === 'blocked') violations += 1
  }
  for (const unit of snapshot.units) {
    if (unit.state === 'prepared' || unit.state === 'claimed') violations += 1
  }
  return violations
}

/** Freshest continuation anchor of a scene: unit anchors beat the static plan (§6.3). */
function anchorForScene(snapshot: NovelSnapshot, sceneId: string): string | null {
  const units = snapshot.units.filter((unit) => unit.sceneId === sceneId)
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const anchor = units[index]!.continuationAnchor
    if (anchor !== null) return anchor
  }
  return snapshot.outline?.scenes.find((scene) => scene.sceneId === sceneId)?.continuationAnchor ?? null
}

function workInstruction(snapshot: NovelSnapshot, work: NovelWork, unitId: string | null): string {
  const outlineRevision = snapshot.outline?.outlineRevision ?? 'none'
  const watermark = requirementWatermark(snapshot.requirements)
  switch (work.kind) {
    case 'outline-create':
      return 'Kickoff work (§6.3): read the creation directive with novel_requirements_read, then create the initial plan with novel_outline_create (expectedRevision from novel_status_read; handle the pending directive in handledRequirements). End the turn after the outline is saved.'
    case 'outline-revise':
      return `Planning work (§6.3/§9.3): ${work.reason} Read the pending directives (novel_requirements_read) and the plan (novel_outline_read), then submit novel_outline_revise with the handled requirement results, or novel_requirement_block for directives conflicting with committed facts. The revise chapters are an overlay: send only the chapters you add or rewrite in full (omitted keyEvents are inherited) and set currentChapterId — untouched chapters are carried forward automatically, so do not page or re-echo the whole plan; removing a chapter requires its chapterId in droppedChapterIds. End the turn afterwards.`
    case 'write-unit': {
      // 0007 §7/§8: writerMode read from the post-prepare brief snapshot (the
      // re-read after prepareUnit), so a mid-flight PATCH is honoured by the
      // next unit; legacy snapshots without the field read as inline.
      if ((snapshot.config.writerMode ?? 'inline') === 'subagent') {
        return `Delegated writing unit ${unitId} (§6.2, writerMode=subagent): call novel_writer_delegate { unitId: '${unitId}' } directly — do NOT call novel_unit_claim first; the delegate tool claims the unit internally (a manual claim is only adopted when you pass its executionToken). The delegated writer subagent researches, writes and commits the prose itself: never write body text yourself in this mode. Check the returned receipt (commitId, effective characters, sceneCompletion — verified against the store, never model-reported) and end the turn immediately afterwards (§11). If the delegation fails, end the turn as well so the failure path can release the unit (§5.3).`
      }
      return `Writing unit ${unitId} (§6.2): claim it first with novel_unit_claim { unitId: '${unitId}', expectedOutlineRevision: '${outlineRevision}', expectedRequirementSequence: ${watermark} }, write the scene prose, then commit exactly once with novel_body_commit (plain-text paragraphs, the scene completion declaration and canon changes with paragraph sources). Paragraphs are pure narration: chapter/scene labels, headings, wrap-up notes ("收束", "完结") and next-unit previews never enter prose (§11). End the turn immediately after the commit (§11).`
    }
    case 'chapter-complete':
      return `Chapter completion check (§6.3): verify the committed bodies with novel_body_read, then call novel_chapter_complete { chapterId: '${work.chapterId}', expectedContentRevision: '${snapshot.contentRevision}', basis, openItems }. End the turn afterwards.`
    case 'finish':
      return `All chapters are complete (§7.3): run the completion checks and call novel_finish { expectedRevision: '${snapshot.revision}', basis }. The store verifies every guard; self-reported completion is never accepted.`
  }
}

/** Driver notice message. The plugin source keeps the requirements receive
 *  barrier from counting it as an author message (§9.1); novel and intent
 *  identity ride in the message id and the summary because the released v0
 *  Session dispositions admit no other plugin-source members. */
function buildNoticeMessage(novelId: string, intentId: string, snapshot: NovelSnapshot, work: NovelWork, unitId: string | null): unknown {
  const text = [
    renderWorkBrief(snapshot, work),
    ...(unitId !== null ? [`Prepared writing unit for this brief: ${unitId}.`] : []),
    '',
    workInstruction(snapshot, work, unitId),
    '',
    `Automated scheduler notice (work intent ${intentId}); not an author directive (§9.1).`,
  ].join('\n')
  return {
    id: `novel-notice-${intentId}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: `AgentNovel work notice (novel ${novelId}, intent ${intentId})` },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.name : typeof error
}
