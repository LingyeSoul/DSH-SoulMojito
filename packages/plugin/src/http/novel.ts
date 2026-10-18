import { sessionEvents, type HostSessionLog } from '../../../bind/src/index.js'
import {
  NovelCapabilityError,
  NovelConfigError,
  NovelDuplicateCommitError,
  NovelLengthLimitError,
  NovelNotFoundError,
  NovelOwnershipError,
  NovelPreconditionError,
  NovelRequirementConflictError,
  NovelRevisionConflictError,
  NovelStaleUnitError,
  NovelStorageCorruptionError,
  isValidNovelId,
  summarizeNovel,
  totalEffectiveCharacters,
  validateCreateConfig,
  type NovelCreateConfig,
  type NovelRunBudgets,
  type NovelSnapshot,
  type NovelStore,
  type TavernStore,
  type WriterMode,
} from '../../../tavern-store/src/index.js'
import { AGENT_NOVEL_PRESET_ID, inspectAgentNovelCapabilities, inspectWriterSubagentCapabilities } from '../agent-novel/capabilities.js'
import { recoverNovels, type DriverAgentLike } from '../agent-novel/driver.js'
import { unitTargetRange } from '../agent-novel/outline.js'
import { isNovelAuthorMessage, receiveAuthorMessage } from '../agent-novel/requirements.js'
import { subagentRuntimeOf, type DeductionExecAgent, type SubagentRuntimeLike } from '../agent-tavern/deduce.js'
import { isTavernSessionMarker } from '../agent-tavern/projector.js'
import { getAgentNovelCapabilities, getNovelDriverPromise, getNovelProjectorPromise, memories, novelStore, store } from '../runtime.js'
import { TavernArchitectureConflictError } from '../session/binding.js'
import { lastSelectedPresetId } from '../session/preset-marker.js'
import { occupyHostSession } from '../session/trace.js'
import { readJson, sendJson } from './io.js'

const CARD_WORKBENCH_PRESET_ID = 'card-workbench'

/* --------------------------- AgentNovel HTTP API --------------------------- */

/**
 * Literal subpath markers of the novels route tree. They double as the
 * server-contract gate markers: parameterized routes are prefix-matched, so
 * these constants are the only stable place the subpath literals appear in
 * the bundle (see packages/plugin/scripts/gates/run.mjs).
 */
const NOVEL_SUBPATHS = ['novels/outline', 'novels/body', 'novels/export', 'novels/pause', 'novels/resume', 'novels/stop', 'novels/update-outline', 'novels/approve-outline'] as const
type NovelSubpath = (typeof NOVEL_SUBPATHS)[number]

export interface NovelApiRequest {
  method?: string
  url?: string
  on?: (event: string, listener: (chunk?: unknown) => void) => unknown
  destroy?: () => void
}

export interface NovelApiResponse {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: (chunk?: string | Uint8Array) => void
}

export interface NovelHttpFailure {
  status: number
  code: string
  /** §13/§15: corruption and ownership detail stays in the server log only. */
  sanitized: boolean
  extra?: Record<string, unknown>
}

/** Maps novel domain errors onto structured HTTP failures (proposal 0005 §13). */
export function novelHttpFailure(error: unknown): NovelHttpFailure | undefined {
  if (error instanceof NovelRevisionConflictError) {
    return { status: 409, code: error.code, sanitized: false, extra: { actualRevision: error.actualRevision } }
  }
  if (error instanceof NovelDuplicateCommitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelStaleUnitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelRequirementConflictError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelLengthLimitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelPreconditionError) {
    return {
      status: 409,
      code: error.code,
      sanitized: false,
      extra: { rule: error.rule, ...(error.violations.length > 0 ? { violations: [...error.violations] } : {}) },
    }
  }
  if (error instanceof NovelNotFoundError) return { status: 404, code: error.code, sanitized: false }
  if (error instanceof NovelConfigError) {
    return {
      status: 400,
      code: error.code,
      sanitized: false,
      ...(error.errors.length > 0 ? { extra: { violations: error.errors.map((item) => ({ field: item.field, message: item.message })) } } : {}),
    }
  }
  if (error instanceof NovelCapabilityError) return { status: 503, code: error.code, sanitized: false }
  if (error instanceof NovelStorageCorruptionError) return { status: 500, code: error.code, sanitized: true }
  if (error instanceof NovelOwnershipError) return { status: 500, code: error.code, sanitized: true }
  return undefined
}

/** Splits 'novels/<id>[/<subpath>]' against the known marker table. */
function parseNovelRoute(route: string): { novelId: string; subpath: NovelSubpath | null } | null {
  if (!route.startsWith('novels/')) return null
  const [idSegment, ...rest] = route.slice('novels/'.length).split('/')
  if (idSegment === undefined) return null
  const tail = rest.join('/')
  return {
    novelId: decodeURIComponent(idSegment),
    subpath: tail === '' ? null : NOVEL_SUBPATHS.find((marker) => marker === `novels/${tail}`) ?? null,
  }
}

async function requireNovel(db: NovelStore, novelId: string): Promise<NovelSnapshot> {
  if (!isValidNovelId(novelId)) throw new NovelNotFoundError({ novelId })
  const snapshot = await db.getNovel(novelId)
  if (snapshot === undefined) throw new NovelNotFoundError({ novelId })
  return snapshot
}

/** Detail projection for GET novels/:id (client contract, proposal 0005 §14.3). */
function novelDetail(snapshot: NovelSnapshot) {
  const summary = summarizeNovel(snapshot)
  const outline = snapshot.outline
  const completed = new Set(snapshot.completedChapters.map((entry) => entry.chapterId))
  const chapters = [...(outline?.chapters ?? [])]
    .sort((left, right) => left.order - right.order)
    .map((chapter) => {
      const chapterCommits = snapshot.commits.filter((commit) => commit.chapterId === chapter.chapterId)
      return {
        chapterId: chapter.chapterId,
        order: chapter.order,
        title: chapter.title,
        state: completed.has(chapter.chapterId)
          ? 'completed' as const
          : chapterCommits.length > 0 ? 'writing' as const : 'planned' as const,
        committedCharacters: totalEffectiveCharacters(chapterCommits),
      }
    })
  const budget = snapshot.config.lengthBudget
  return {
    novelId: summary.novelId,
    title: summary.title,
    status: summary.status,
    phase: summary.phase,
    pauseReason: summary.pauseReason,
    chaptersCompleted: summary.chaptersCompleted,
    chaptersTotal: summary.chaptersTotal,
    effectiveCharacters: summary.effectiveCharacters,
    targetCharacters: summary.targetCharacters,
    updatedAt: summary.updatedAt,
    lastError: summary.lastError,
    revision: snapshot.revision,
    config: snapshot.config,
    pauseDetail: snapshot.run.pauseDetail,
    resumeHint: snapshot.run.resumeHint,
    requirements: snapshot.requirements.map((record) => ({
      requirementId: record.requirementId,
      sequence: record.sequence,
      text: record.text,
      status: record.status,
      effectiveLocation: record.effectiveLocation,
      blockedReason: record.blockedReason,
    })),
    chapters,
    outlineSummary: outline === null ? null : {
      outlineRevision: outline.outlineRevision,
      story: { premise: outline.story.premise, theme: outline.story.theme, endingDirection: outline.story.endingDirection },
      chapterTitles: outline.chapters.map((chapter) => ({ chapterId: chapter.chapterId, title: chapter.title })),
      foreshadowing: outline.foreshadowing.map((item) => ({ id: item.id, description: item.description, status: item.status, required: item.required })),
    },
    budget: {
      turnsRun: snapshot.run.turnsRun,
      maxTurns: snapshot.config.budgets.maxTurns,
      deduceRuns: snapshot.run.deduceRuns,
      maxDeduceRuns: snapshot.config.budgets.maxDeduceRuns,
      // 0007 §7: writerRuns rides the deduceRuns convention (uncapped counter
      // beside the budget edges); usageSamples is the W0 audit ring. Both
      // coalesce so legacy snapshots lacking the fields still project a
      // constant shape — the store applies the same amnesty on write.
      writerRuns: snapshot.run.writerRuns ?? 0,
      usageSamples: snapshot.run.usageSamples ?? [],
      remainingCharacters: budget.kind === 'target'
        ? Math.max(0, unitTargetRange(snapshot.config, summary.effectiveCharacters).max)
        : null,
    },
  }
}

/**
 * Best-effort discovery of a subagent runtime for the writer probes (0007 §9).
 * Preferred channel: a live agent bound to an agent-novel session — the exact
 * channel novel_writer_delegate itself uses at runtime (exec.agent →
 * subagentRuntimeOf), so a pass proves the path W2 actually runs on. Fallback:
 * the plugin context's own service lookup. Both degrade silently to undefined
 * (gated services throw or return nothing); callers treat a missing runtime as
 * a failed probe, never as an implicit inline downgrade.
 */
async function discoverWriterProbeRuntime(ctx: unknown): Promise<{ runtime: SubagentRuntimeLike; parent: unknown; channel: 'bound-agent' | 'plugin-context' } | undefined> {
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    for (const [sessionId, binding] of Object.entries(state.sessionBindings)) {
      if (binding.architecture !== 'agent-novel') continue
      let agent: unknown
      try {
        agent = (ctx as { agents?: { get?: (id: string) => unknown } }).agents?.get?.(sessionId)
      } catch {
        continue // gated service access on an inactive fiber
      }
      const runtime = subagentRuntimeOf(agent as DeductionExecAgent | undefined)
      if (runtime !== undefined) return { runtime, parent: agent, channel: 'bound-agent' }
    }
  } catch {
    // A failed state read falls through to the context channel below.
  }
  const runtime = subagentRuntimeOf({ ctx } as DeductionExecAgent)
  return runtime === undefined ? undefined : { runtime, parent: ctx, channel: 'plugin-context' }
}

export async function handleNovelsApi(
  ctx: { agents?: unknown; agentPresets?: unknown; systemPrompt?: unknown; tools?: unknown; on?: unknown },
  req: NovelApiRequest,
  res: NovelApiResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  const novels = await novelStore()

  if (method === 'GET' && route === 'novels') {
    return sendJson(res, 200, { ok: true, novels: await novels.listNovels() })
  }

  if (method === 'POST' && route === 'novels') {
    const body = await readJson(req) as Record<string, unknown>
    // §16 fail-closed: capability reasons outrank config validation, so a
    // degraded host reports why instead of a stream of field errors.
    const capabilities = inspectAgentNovelCapabilities(ctx)
    if (!capabilities.available) {
      return sendJson(res, 503, {
        ok: false,
        message: `AgentNovel is unavailable on this host: ${capabilities.reasons.join(' ')}`,
        code: 'NOVEL_CAPABILITY',
        reasons: [...capabilities.reasons],
      })
    }
    const config = body as unknown as NovelCreateConfig
    const violations = validateCreateConfig(config)
    if (violations.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        message: 'invalid novel config',
        code: 'NOVEL_CONFIG',
        violations: violations.map((item) => ({ field: item.field, message: item.message })),
      })
    }
    // 0007 §8/§9 fail-closed creation gate: writerMode=subagent (W2) requires
    // the P1 host contract probe to pass; a failed probe (or an unresolvable
    // subagent runtime) blocks the creation with the evidence instead of
    // silently degrading to inline. The probe spawns two one-shot subagents —
    // only reachable from this explicit request surface, never at startup.
    if (config.writerMode === 'subagent') {
      const channel = await discoverWriterProbeRuntime(ctx)
      const probe = await inspectWriterSubagentCapabilities(channel)
      if (!probe.spawnOk || probe.p1.status === 'fail') {
        return sendJson(res, 400, {
          ok: false,
          message: `writer subagent mode is unavailable on this host (${probe.p1.detail}); create the novel with writerMode 'inline' instead (0007 §9)`,
          code: 'NOVEL_WRITER_PROBE',
          probe,
        })
      }
    }
    const created = await novels.createNovel(await store(), config)
    const snapshot = await novels.getNovel(created.novelId)
    const summary = snapshot === undefined ? undefined : summarizeNovel(snapshot)
    return sendJson(res, 200, {
      ok: true,
      novel: {
        novelId: created.novelId,
        title: config.title,
        status: summary?.status ?? (config.approvalMode === 'manual' ? 'paused' : 'active'),
        phase: summary?.phase ?? 'outlining',
        revision: created.revision,
      },
    })
  }

  if (method === 'GET' && route === 'novels/writer-probe') {
    // Debug surface for the writer-subagent probes (0007 §9): panels and CLI
    // can trigger the report without attempting a subagent-mode creation. The
    // literal must be matched before parseNovelRoute, which would otherwise
    // read 'writer-probe' as a novel id.
    const channel = await discoverWriterProbeRuntime(ctx)
    const probe = await inspectWriterSubagentCapabilities(channel)
    return sendJson(res, 200, { ok: true, probe, channel: channel?.channel ?? 'none' })
  }

  const parts = parseNovelRoute(route)
  if (parts === null) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
  const { novelId, subpath } = parts

  if (method === 'GET' && subpath === null) {
    const snapshot = await requireNovel(novels, novelId)
    return sendJson(res, 200, { ok: true, novel: novelDetail(snapshot) })
  }

  if (method === 'PATCH' && subpath === null) {
    const body = await readJson(req) as Record<string, unknown>
    if (typeof body.expectedRevision !== 'string' || typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
      throw new Error('expected { expectedRevision, patch }')
    }
    // patchNovelMeta validates the writerMode enum (0007 §8 Task A); the mode
    // switch only affects the next scheduled unit.
    const result = await novels.patchNovelMeta(novelId, {
      expectedRevision: body.expectedRevision,
      patch: body.patch as { title?: string; genre?: string; budgets?: NovelRunBudgets; writerMode?: WriterMode },
      cause: typeof body.cause === 'string' && body.cause.trim() !== '' ? body.cause : 'panel-edit',
    })
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }

  if (method === 'DELETE' && subpath === null) {
    // Deletion discipline (proposal 0005 §13/§4.2): revoke scheduling first
    // (tolerated on completed/missing novels), drop every session binding
    // that points at the project, then remove the project itself. Missing
    // novels stay a success so client retries are idempotent.
    await novels.pause(novelId, { reason: 'user-request', detail: 'deletion requested from the novels panel' }).catch(() => {})
    const db: TavernStore = await store()
    await db.updateState((current) => ({
      sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings)
        .filter(([, binding]) => !(binding.architecture === 'agent-novel' && binding.novelId === novelId))),
    }))
    await novels.deleteNovel(novelId)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && subpath === 'novels/pause') {
    const result = await novels.pause(novelId, {
      reason: 'user-request',
      detail: 'paused from the novels panel',
      resumeHint: 'resume explicitly to authorize further work (proposal 0005 §13)',
    })
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/resume') {
    const result = await novels.resume(novelId)
    // Resuming flips the run active with no session event in flight; the
    // driver must be poked or an idle bound agent never gets scheduled (§12.1).
    ;(await getNovelDriverPromise())?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/stop') {
    const result = await novels.stop(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/update-outline') {
    const result = await novels.requestRevision(novelId)
    // The authorized planning pass needs the driver poked like resume: no
    // session edge fires while the bound agent sits idle (§4.3/§12.1).
    ;(await getNovelDriverPromise())?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/approve-outline') {
    const body = await readJson(req).catch(() => undefined) as Record<string, unknown> | undefined
    const fromQuery = url.searchParams.get('expectedOutlineRevision')
    const expected = typeof body?.expectedOutlineRevision === 'string' && body.expectedOutlineRevision.trim() !== ''
      ? body.expectedOutlineRevision
      : fromQuery
    if (expected === null || expected === undefined || expected.trim() === '') throw new Error('expected { expectedOutlineRevision }')
    const result = await novels.approveOutline(novelId, { expectedOutlineRevision: expected })
    // Post-approval continuation previously claimed to ride "the driver's
    // existing edges" — but an idle agent emits none, so the driver is poked
    // here explicitly (proposal 0005 §4.3/§12.1).
    ;(await getNovelDriverPromise())?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }

  if (method === 'GET' && subpath === 'novels/outline') {
    const snapshot = await requireNovel(novels, novelId)
    return sendJson(res, 200, { ok: true, outline: snapshot.outline })
  }

  if (method === 'GET' && subpath === 'novels/body') {
    const chapterId = url.searchParams.get('chapterId')
    const cursor = url.searchParams.get('cursor')
    const limitRaw = url.searchParams.get('limit')
    const page = await novels.readBody(novelId, {
      ...(chapterId !== null && chapterId !== '' ? { chapterId } : {}),
      ...(cursor !== null && cursor !== '' ? { cursor } : {}),
      ...(limitRaw !== null && limitRaw !== '' ? { limit: Number(limitRaw) } : {}),
    })
    // nextCursor is null when the page is exhausted; the client treats both
    // states, null is the chosen representation.
    return sendJson(res, 200, { ok: true, paragraphs: [...page.paragraphs], nextCursor: page.nextCursor })
  }

  if (method === 'GET' && subpath === 'novels/export') {
    const projector = await getNovelProjectorPromise()
    if (projector === undefined) throw new Error('AgentNovel projector is unavailable')
    const format = url.searchParams.get('format') === 'zip' ? 'zip' as const : 'md' as const
    const exported = await projector.exportNovel(novelId, format)
    res.statusCode = 200
    res.setHeader('content-type', exported.contentType)
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(exported.filename)}"`)
    res.end(Buffer.from(exported.bytes))
    return
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

/* ------------------------- AgentNovel lifecycle ------------------------- */

export interface NovelPluginContext {
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void }
}

function errorCodeText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.name : String(error)
}

/**
 * §12.3 restart recovery: re-arm active novels and catch the memory index up
 * for every bound project. Runs once per apply, never blocks mounting.
 */
export async function recoverMountedNovels(ctx: NovelPluginContext): Promise<void> {
  const driver = await getNovelDriverPromise()
  if (driver === undefined) return
  await recoverNovels(driver)
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    for (const binding of Object.values(state.sessionBindings)) {
      if (binding.architecture !== 'agent-novel') continue
      await indexPendingCommits(ctx, binding.novelId)
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-soulmojito: AgentNovel recovery indexing failed', { operation: 'recover', errorCode: errorCodeText(error) })
  }
}

/**
 * Session/event entry for bound novel sessions (proposal 0005 §9.1/§12.1):
 * real user messages persist through the receive barrier BEFORE they can
 * unblock the next unit claim, and turn/end edges feed driver accounting.
 * Failures are logged with structured fields and never break the event stream.
 */
export async function handleNovelSessionEvent(ctx: NovelPluginContext, session: unknown, event: unknown): Promise<void> {
  const sessionId = (session as { id?: unknown } | null | undefined)?.id
  if (typeof sessionId !== 'string') return
  let novelId: string
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    const binding = state.sessionBindings[sessionId]
    if (binding === undefined || binding.architecture !== 'agent-novel') return
    novelId = binding.novelId
  } catch (error) {
    ctx.logger?.warn?.('dsh-soulmojito: AgentNovel binding read failed', { sessionId, operation: 'novel-event', errorCode: errorCodeText(error) })
    return
  }
  const record = event as { type?: unknown } | null | undefined
  try {
    if (record?.type === 'turn/end') {
      const driver = await getNovelDriverPromise()
      if (driver !== undefined) await driver.handleSessionEvent({ id: sessionId }, event as { type?: string; data?: unknown })
      await indexPendingCommits(ctx, novelId)
      return
    }
    if (isNovelAuthorMessage(event as { type?: string; data?: unknown })) {
      const outcome = await receiveAuthorMessage(await novelStore(), novelId, sessionId, event)
      if (!outcome.accepted && !outcome.duplicate) {
        ctx.logger?.warn?.('dsh-soulmojito: AgentNovel receive barrier rejected a message', {
          novelId,
          sessionId,
          operation: 'receive-requirement',
          reason: outcome.reason ?? 'unknown',
        })
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-soulmojito: AgentNovel session event handling failed', { novelId, sessionId, operation: 'novel-event', errorCode: errorCodeText(error) })
  }
}

/**
 * Commit-driven memory index catch-up (proposal 0005 §8.2): the projector
 * writes a commit's scene summary record LAST, so the absence of that stable
 * id marks the commit as unindexed. Idempotent; called from turn/end edges
 * and restart recovery without touching the store commit path.
 */
async function indexPendingCommits(ctx: NovelPluginContext, novelId: string): Promise<void> {
  const [novels, memory, projector] = await Promise.all([novelStore(), memories(), getNovelProjectorPromise()])
  if (projector === undefined) return
  const snapshot = await novels.getNovel(novelId)
  if (snapshot === undefined) return
  const scopeId = `novel:${novelId}`
  for (const commit of snapshot.commits) {
    const summaryId = `novel-${novelId}-${commit.commitId}-${commit.canonChanges.length}`
    const indexed = await memory.read(summaryId, 'chat', scopeId, true).catch(() => undefined)
    if (indexed !== undefined) continue
    try {
      await projector.indexCommit(novelId, commit.commitId)
    } catch (error) {
      ctx.logger?.warn?.('dsh-soulmojito: AgentNovel memory index write failed', { novelId, commitId: commit.commitId, operation: 'index-commit', errorCode: errorCodeText(error) })
    }
  }
}

export interface NovelCommandAgent {
  id: string
  ctx: unknown
  session: HostSessionLog & { append: (type: string, data: unknown, opts?: unknown) => void }
}

/** Structural check against DriverAgentLike; degrades silently otherwise. */
function driverCompatibleAgent(agent: unknown): agent is DriverAgentLike {
  if (typeof agent !== 'object' || agent === null) return false
  const candidate = agent as { id?: unknown; session?: unknown; status?: unknown; followup?: unknown; whenIdle?: unknown }
  return typeof candidate.id === 'string'
    && typeof candidate.session === 'object' && candidate.session !== null && typeof (candidate.session as { id?: unknown }).id === 'string'
    && (candidate.status === 'idle' || candidate.status === 'running')
    && typeof candidate.followup === 'function'
    && typeof candidate.whenIdle === 'function'
}

/**
 * Internal novel-open command handler (proposal 0005 §4.2): existence gate,
 * fail-closed capability gate (§16), architecture conflict guard, serialized
 * binding write, idempotent preset marker + recompose, then the driver kick.
 * No placeholder turn events are ever appended: the kickoff guarantee is the
 * agent liveness carried by handleNovelOpen (§12.1), which keeps real turn
 * numbering intact for client replay.
 */
export async function handleNovelOpenCommand(
  ctx: NovelPluginContext & { agentPresets?: { recompose?: (agentCtx: unknown, presetId: string) => Promise<{ id: string }> } },
  agent: NovelCommandAgent,
  novelId: string,
): Promise<{ kind: string; text: string }> {
  const db: TavernStore = await store()
  const novels = await novelStore()
  if ((await novels.getNovel(novelId)) === undefined) {
    return { kind: 'error', text: `Novel '${novelId}' not found.` }
  }
  // §16 fail-closed: refuse with the concrete reasons, never degrade to chat.
  const novelCapabilities = getAgentNovelCapabilities()
  if (!novelCapabilities.available) {
    return { kind: 'error', text: `AgentNovel is unavailable on this host: ${novelCapabilities.reasons.join(' ')}` }
  }
  await ensureAgentPresetDeclared(ctx, AGENT_NOVEL_PRESET_ID)
  const currentState = await db.getState()
  const previous = currentState.sessionBindings[agent.id]
  const activationEvents = sessionEvents(agent.session)
  // Same guard family as the AgentTavern lock: a session that already began
  // real turns (or imported history) cannot be re-bound in place (§4.2).
  const sessionStarted = activationEvents.some((event) => event.type === 'turn/start')
    || activationEvents.some((event) => {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
      const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source
      return isTavernSessionMarker(source)
    })
  const sameNovelBinding = previous?.architecture === 'agent-novel' && previous.novelId === novelId
  if (!sameNovelBinding && sessionStarted) {
    throw new TavernArchitectureConflictError('This host session already started; rebinding it to an AgentNovel project is locked (proposal 0005 §4.2).')
  }
  if (typeof ctx.agentPresets?.recompose !== 'function') {
    throw new TavernArchitectureConflictError('The host cannot recompose a blank session with the AgentNovel preset.')
  }
  await bindNovelSession(db, agent.id, novelId)
  // Idempotent marker: a repeated novel-open on the same binding neither
  // stacks markers nor recomposes twice. Read the LAST selected preset: 0.2.1
  // reuseLive can rewrite a blank session to the host default after the first
  // selection, and a `some(...)` check would miss that clobber.
  if (lastSelectedPresetId(agent.session) !== AGENT_NOVEL_PRESET_ID) {
    const preset = await ctx.agentPresets.recompose(agent.ctx, AGENT_NOVEL_PRESET_ID)
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  }
  const driver = await getNovelDriverPromise()
  if (driver !== undefined && driverCompatibleAgent(agent)) {
    // driverCompatibleAgent validated the driver surface at runtime; the cast
    // only satisfies the structural gap between the two local host shapes.
    await driver.handleNovelOpen(agent as unknown as DriverAgentLike, novelId)
  }
  return { kind: 'success', text: `Novel: ${novelId}` }
}

/** AgentNovel session binding write (proposal 0005 §4.2). */
async function bindNovelSession(db: TavernStore, sessionId: string, novelId: string) {
  return db.updateState((state) => ({
    sessionBindings: {
      ...state.sessionBindings,
      [sessionId]: { architecture: 'agent-novel', novelId, character: '', chatId: '' },
    },
  }))
}

/**
 * Internal workbench-open command handler（提案 0013）：面板「新建角色卡 →
 * 写卡 Agent」与聊天侧「交给工作台」共用的会话启动桥。与 novel-open 同族的
 * 闸门——recompose 能力 fail-closed、preset 声明校验、已开始会话锁定（同
 * 来源身份幂等重发放行，客户端存量修复借本命令补占位 turn 对）；来源
 * 聊天身份写进绑定（每个聊天对应一个写卡工作会话），已绑定其他来源的会话
 * 拒绝换绑；绑定写 + 幂等 marker + recompose + 占位 turn（无 driver 参与，
 * 工作台是纯对话式 preset，用户开口前靠占位 turn 摘除宿主 blank 复用资格，
 * 否则下一个工作台会话的 connect 会落回本会话并撞上换绑守卫——决策
 * 2026-08-16 同款机制）。
 */
export async function handleWorkbenchOpenCommand(
  ctx: NovelPluginContext & { agentPresets?: { recompose?: (agentCtx: unknown, presetId: string) => Promise<{ id: string }> } },
  agent: NovelCommandAgent,
  payload: { sourceCharacter: string; sourceChatId: string },
): Promise<{ kind: string; text: string }> {
  if (typeof ctx.agentPresets?.recompose !== 'function') {
    throw new TavernArchitectureConflictError('The host cannot recompose a blank session with the CardWorkbench preset.')
  }
  await ensureAgentPresetDeclared(ctx, CARD_WORKBENCH_PRESET_ID)
  const activationEvents = sessionEvents(agent.session)
  // 与 novel-open 同款锁定：已开始真实轮次的会话不能再原地换 preset。例外与
  // AgentTavern 的 sameTavernBinding 同因：同来源身份的幂等重发（客户端存量
  // 修复借本命令补占位 turn 对）不能被自己的占位 turn 拦下。
  const sessionStarted = activationEvents.some((event) => event.type === 'turn/start')
    || activationEvents.some((event) => {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
      const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source
      return isTavernSessionMarker(source)
    })
  const db: TavernStore = await store()
  const previous = (await db.getState()).sessionBindings[agent.id]
  const sameWorkbenchSource = previous?.architecture === 'card-workbench'
    && previous.sourceCharacter === payload.sourceCharacter
    && previous.sourceChatId === payload.sourceChatId
  if (sessionStarted && !sameWorkbenchSource) {
    throw new TavernArchitectureConflictError('This host session already started; recomposing it with the CardWorkbench preset is locked.')
  }
  if (previous?.architecture === 'card-workbench'
    && (previous.sourceCharacter !== payload.sourceCharacter || previous.sourceChatId !== payload.sourceChatId)) {
    // 必须在 marker 幂等检查之前拦截：否则不重复 recompose 但绑定被静默改写
    // 成另一个聊天的身份，工作台会话与来源聊天的一一对应会被破坏。
    throw new TavernArchitectureConflictError('This CardWorkbench session is already bound to another chat.')
  }
  await db.updateState((state) => ({
    sessionBindings: {
      ...state.sessionBindings,
      [agent.id]: {
        architecture: 'card-workbench',
        character: '',
        chatId: '',
        sourceCharacter: payload.sourceCharacter,
        sourceChatId: payload.sourceChatId,
        // 幂等重发不抹掉出卡后记下的卡名（侧边栏分组与会话标题的数据源），
        // 也不抹掉用户侧边栏显式改的名（title 压过一切派生标签）。
        createdCard: previous?.architecture === 'card-workbench' ? previous.createdCard : '',
        ...(previous?.architecture === 'card-workbench' && previous.title !== undefined ? { title: previous.title } : {}),
      },
    },
  }))
  // 幂等 marker：重复 workbench-open 不叠加 marker 也不重复 recompose。
  // 0.2.1 的 reuseLive 可能把 blank 会话改回宿主默认 preset，因此只认最后一条。
  if (lastSelectedPresetId(agent.session) !== CARD_WORKBENCH_PRESET_ID) {
    const preset = await ctx.agentPresets.recompose(agent.ctx, CARD_WORKBENCH_PRESET_ID)
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  }
  // 工作台是纯对话式 preset（无 driver kickoff），用户开口前会话没有 turn/start，
  // 宿主会把它当 blank 草稿复用——下一个 openWorkbenchSession 的 connect 就会
  // 落回本会话并撞上「已绑定其他来源」守卫，新建会话从此失败。写一对占位
  // turn 摘除复用资格（与 ST 激活同款，决策 2026-08-16；幂等，读回验证失败时
  // 仅失去保护不阻断激活）。
  occupyHostSession(agent, ctx)
  return { kind: 'success', text: 'CardWorkbench' }
}

/**
 * 断言本 bundle 声明的 preset 已在宿主 preset registry 注册。DSH 0.2.0-rc.2
 * 起 preset 不再通过 ~/.dsh/.agent-presets 目录扫描投递（registry "neither
 * scans directories nor accepts preset paths"），而是 profile 里的
 * @deepseek-ai/dsh-agent-preset 声明行——本包 cordis.patch.yml 的
 * preset-agent-tavern / preset-agent-novel insert。失败即能力闸门关闭并给出
 * 重装指引，而不是静默落到无 preset 扫描的空集。
 */
export async function ensureAgentPresetDeclared(
  ctx: { agentPresets?: { compositionInventory?: () => Promise<Array<{ id?: unknown }>> } },
  presetId: string,
): Promise<void> {
  const inventory = typeof ctx.agentPresets?.compositionInventory === 'function'
    ? await ctx.agentPresets.compositionInventory()
    : undefined
  if (!Array.isArray(inventory) || !inventory.some((entry) => entry?.id === presetId)) {
    throw new Error(
      `preset '${presetId}' is not declared on this host; reinstall the dsh-soulmojito bundle so its cordis.patch.yml preset rows mount (DSH 0.2.0-rc.2+ preset delivery)`,
    )
  }
}
