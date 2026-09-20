import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyNovelSurface } from '../src/agent-novel/agent.js'
import type { SubagentRuntimeLike } from '../src/agent-tavern/deduce.js'
import { NovelStore, TavernStore, type NovelOutlinePayload } from '../../tavern-store/src/index.js'

const CHARACTER = '酒保'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Full driver-shaped agent: the novel-open kick captures it (proposal 0005 §12.1). */
function makeNovelAgent(id: string) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const followups: unknown[] = []
  return {
    id,
    ctx: { id },
    status: 'idle' as const,
    followups,
    followup: async (message: unknown) => { followups.push(message) },
    whenIdle: async () => {},
    session: {
      id,
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    },
  }
}

/** Plain command-only agent (no driver surface): binding + marker still work. */
function makePlainAgent(id: string) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  return {
    id,
    ctx: { id },
    session: {
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    },
  }
}

/** Minimal shape of the captured agent-novel tool surface (apply 捕获范式). */
interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { agent?: { id?: string } }) => Promise<unknown>
}

function makeRequest(body: unknown, url: string, method = 'POST') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeGetRequest(url: string) {
  return { method: 'GET', url, on: () => undefined, destroy: () => {} }
}

function makeResponse() {
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const response = {
    chunks,
    headers,
    statusCode: 0,
    writableEnded: false,
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
    write: (chunk: string | Buffer) => { chunks.push(Buffer.from(chunk)); return true },
    end: (chunk?: string | Buffer) => {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function jsonBody(response: { chunks: Buffer[] }) {
  return JSON.parse(Buffer.concat(response.chunks).toString('utf8'))
}

async function until(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return condition()
}

async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return await predicate()
}

function novelConfig(overrides: Record<string, unknown> = {}) {
  return {
    title: '灯下酒馆',
    requirement: '写一个酒馆老板与常客的故事',
    language: 'zh',
    genre: '奇幻',
    narrativePerspective: 'third-person',
    styleNotes: '',
    lengthBudget: { kind: 'unbounded' },
    maxChapters: null,
    approvalMode: 'automatic',
    characterNames: [CHARACTER],
    worldNames: [],
    budgets: {
      maxTurns: 50,
      maxDurationMs: 3_600_000,
      stallThresholdTurns: 6,
      consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 3, backoffMs: 10 },
      maxDeduceRuns: 5,
    },
    ...overrides,
  }
}

function minimalOutlinePayload(chapterId = 'ch-1'): NovelOutlinePayload {
  return {
    story: { premise: '灯下酒馆的夜晚', theme: '陪伴', mainConflict: '老客要离开', endingDirection: '告别', taboos: [] },
    characters: [{ characterId: 'keeper', name: '老板', initialState: '擦杯', motivation: '留住客人', relations: [], arc: '学会放手' }],
    chapters: [{
      chapterId,
      order: 1,
      title: '第一章 打烊之前',
      purpose: '建立酒馆日常',
      keyEvents: [],
      plannedCharacters: null,
      entryCondition: '夜晚开始',
      exitCondition: '客人离开',
    }],
    currentChapterId: chapterId,
    scenes: [{
      sceneId: 'sc-1',
      order: 1,
      goal: '老板与常客的第一段对话',
      participants: ['老板'],
      timeLocation: '吧台',
      causality: '故事开始',
      conflict: '无',
      expectedChange: '彼此认识',
    }],
    foreshadowing: [{ id: 'fore-1', description: '柜子里的旧照片', plantAt: 'sc-1', payoffAt: null, required: true, status: 'open' }],
  }
}

describe('AgentNovel command bridge and HTTP contract', () => {
  let home: string
  let store: TavernStore
  let novels: NovelStore
  let handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string; text?: string }>
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let degradedApiHandler: (req: unknown, res: unknown) => Promise<void>
  let sessionEventHandlers: Array<(session: unknown, event: unknown) => void>
  let agents: Map<string, unknown>
  let recomposeCalls: Array<{ agent: unknown; presetId: string }>
  let novelTools: Map<string, CapturedTool>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-novel-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    novels = await NovelStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A test character', personality: '', scenario: '', first_mes: '欢迎光临',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: {},
      },
    })
    agents = new Map()
    novelTools = new Map()
    recomposeCalls = []
    sessionEventHandlers = []
    const apiHandlers: Array<(req: unknown, res: unknown) => Promise<void>> = []
    let definitions: Array<{ handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string; text?: string }> }> = []

    const baseCtx = {
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: (def: never) => { definitions.push(def) } },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandlers.push(def.handler); return () => {} } },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    }

    // Mount #1: degraded host (no agents/agentPresets/on) — the capability
    // gate must reject novel creation before touching config validation.
    apply({
      ...baseCtx,
    } as never)
    degradedApiHandler = apiHandlers[0]!
    definitions = []

    // Mount #2: full host — the driver subscribes through the same `on`.
    apply({
      ...baseCtx,
      on: (event: string, handlerFn: (session: unknown, event: unknown) => void) => {
        if (event === 'session/event') sessionEventHandlers.push(handlerFn)
        return () => {}
      },
      agentPresets: {
        mount: async () => ({ id: 'agent-novel' }),
        recompose: async (agent: unknown, presetId: string) => {
          recomposeCalls.push({ agent, presetId })
          return { id: presetId }
        },
      },
      agents: {
        get: (id: string) => agents.get(id),
        withoutInitiator: <T>(op: () => T) => op(),
      },
      tools: { register: (tool: { name: string }) => { novelTools.set(tool.name, tool as CapturedTool) } },
    } as never)
    // The novel tool surface rides the bundled preset on a real host (proposal
    // 0005 §17); the harness mounts it directly so the writer-probe fake
    // runtime can execute novel_status_read the way a real subagent would.
    applyNovelSurface({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: (tool: { name: string }) => { novelTools.set(tool.name, tool as CapturedTool) } },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    })
    expect(definitions).toHaveLength(1)
    expect((definitions[0] as { name?: string }).name).toBe('dsh-tavern-session')
    handler = definitions[0]!.handler
    apiHandler = apiHandlers.at(-1)!
    expect(apiHandler).not.toBe(degradedApiHandler)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('fails closed with reasons when the host lacks the AgentNovel capability contract', async () => {
    const res = makeResponse()
    await degradedApiHandler(makeRequest(novelConfig(), '/api/dsh-tavern/novels'), res)
    expect(res.statusCode).toBe(503)
    const body = jsonBody(res)
    expect(body).toMatchObject({ ok: false, code: 'NOVEL_CAPABILITY' })
    expect(Array.isArray(body.reasons)).toBe(true)
    expect(body.reasons.length).toBeGreaterThan(0)
    expect(body.message).toContain(body.reasons[0])
  })

  it('reports the agentNovel capability block on bootstrap', async () => {
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/bootstrap'), res)
    expect(res.statusCode).toBe(200)
    const agentNovel = jsonBody(res).agentNovel
    expect(agentNovel).toMatchObject({ available: true, missing: [], reasons: [] })
    expect(typeof agentNovel.checkedAt).toBe('string')
  })

  it('rejects an invalid create config with field violations', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(novelConfig({ title: ' ' }), '/api/dsh-tavern/novels'), res)
    expect(res.statusCode).toBe(400)
    const body = jsonBody(res)
    expect(body).toMatchObject({ ok: false, code: 'NOVEL_CONFIG' })
    expect(body.violations).toContainEqual(expect.objectContaining({ field: 'title' }))
  })

  it('creates, lists and reads an automatic novel end to end', async () => {
    const create = makeResponse()
    await apiHandler(makeRequest(novelConfig(), '/api/dsh-tavern/novels'), create)
    expect(create.statusCode).toBe(200)
    const { novel } = jsonBody(create)
    expect(novel).toMatchObject({ title: '灯下酒馆', status: 'active', phase: 'outlining' })
    expect(typeof novel.novelId).toBe('string')
    expect(typeof novel.revision).toBe('string')

    const list = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/novels'), list)
    expect(list.statusCode).toBe(200)
    const listed = jsonBody(list).novels
    expect(Array.isArray(listed)).toBe(true)
    expect(listed).toContainEqual(expect.objectContaining({ novelId: novel.novelId, status: 'active' }))

    const detail = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${novel.novelId}`), detail)
    expect(detail.statusCode).toBe(200)
    const full = jsonBody(detail).novel
    expect(full).toMatchObject({
      novelId: novel.novelId,
      title: '灯下酒馆',
      status: 'active',
      phase: 'outlining',
      pauseReason: null,
      revision: novel.revision,
      chaptersCompleted: 0,
      chaptersTotal: 0,
      targetCharacters: null,
    })
    expect(full.config).toMatchObject({ genre: '奇幻', characterNames: [CHARACTER] })
    expect(full.pauseDetail).toBeNull()
    expect(full.resumeHint).toBeNull()
    expect(full.chapters).toEqual([])
    expect(full.outlineSummary).toBeNull()
    expect(full.budget).toMatchObject({ turnsRun: 0, maxTurns: 50, deduceRuns: 0, maxDeduceRuns: 5, writerRuns: 0, usageSamples: [], remainingCharacters: null })
    expect(full.requirements).toHaveLength(1)
    expect(full.requirements[0]).toMatchObject({ requirementId: 'req-1', sequence: 1, status: 'pending', text: '写一个酒馆老板与常客的故事' })
  })

  it('returns 404 for an unknown novel detail', async () => {
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/novels/missing-one'), res)
    expect(res.statusCode).toBe(404)
    expect(jsonBody(res)).toMatchObject({ ok: false, code: 'NOVEL_NOT_FOUND' })
  })

  it('projects writerRuns and usage samples in the detail budget block (0007 §7)', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '写手投影' }) as never)
    await novels.noteWriterRun(created.novelId)
    await novels.noteUsageSample(created.novelId, {
      recordedAt: '2026-09-18T00:00:00.000Z',
      turn: 3,
      toolBytes: { novel_outline_read: 2048 },
      writerOutputChars: 1200,
    })
    const res = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}`), res)
    expect(res.statusCode).toBe(200)
    const budget = jsonBody(res).novel.budget
    // deduceRuns convention: writerRuns sits beside the budget edges and
    // usageSamples is the audit ring; both are always present in the client
    // contract (the client reads budget.writerRuns / budget.usageSamples).
    expect(budget.writerRuns).toBe(1)
    expect(budget.usageSamples).toEqual([
      { recordedAt: '2026-09-18T00:00:00.000Z', turn: 3, toolBytes: { novel_outline_read: 2048 }, writerOutputChars: 1200 },
    ])
  })

  it('blocks writerMode=subagent creation with probe evidence when no subagent runtime exists (0007 §9 fail-closed)', async () => {
    const before = (await novels.listNovels()).length
    const res = makeResponse()
    await apiHandler(makeRequest(novelConfig({ title: '被闸门拦下的写手小说', writerMode: 'subagent' }), '/api/dsh-tavern/novels'), res)
    expect(res.statusCode).toBe(400)
    const body = jsonBody(res)
    expect(body).toMatchObject({ ok: false, code: 'NOVEL_WRITER_PROBE' })
    expect(body.message).toContain("writerMode 'inline'")
    // The probe report rides along as evidence; without a runtime P1 must fail.
    expect(body.probe).toMatchObject({ spawnOk: false, p1: { status: 'fail' } })
    // Fail-closed means fail-closed: nothing was created.
    expect((await novels.listNovels())).toHaveLength(before)
  })

  it('serves the writer probe report on GET novels/writer-probe (0007 §9)', async () => {
    const res = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/novels/writer-probe'), res)
    expect(res.statusCode).toBe(200)
    const body = jsonBody(res)
    expect(body.ok).toBe(true)
    expect(body.channel).toBe('none') // this test host exposes no subagent runtime
    expect(body.probe.spawnOk).toBe(false)
    expect(body.probe.p1.status).toBe('fail')
    expect(body.probe.p3).toMatchObject({ status: 'deferred-to-e2e' })
  })

  it('serves a null outline before the plan exists', async () => {
    const created = await novels.createNovel(store, novelConfig() as never)
    const res = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/outline`), res)
    expect(res.statusCode).toBe(200)
    expect(jsonBody(res)).toEqual({ ok: true, outline: null })
  })

  it('drives the manual approval flow through update-outline and approve-outline', async () => {
    // Novel A: approve the pinned outline revision (manual creation rides the
    // same HTTP POST roundtrip; it must come back paused).
    const createA = makeResponse()
    await apiHandler(makeRequest(novelConfig({ title: '手动A', approvalMode: 'manual' }), '/api/dsh-tavern/novels'), createA)
    expect(createA.statusCode).toBe(200)
    expect(jsonBody(createA).novel).toMatchObject({ status: 'paused', phase: 'outlining' })
    const createdA = { novelId: jsonBody(createA).novel.novelId as string }
    let snapshot = await novels.getNovel(createdA.novelId)
    await novels.createOutline(createdA.novelId, {
      expectedRevision: snapshot!.revision,
      outline: minimalOutlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'ch-1' }],
    })
    snapshot = await novels.getNovel(createdA.novelId)
    const outlineRevision = snapshot!.outline!.outlineRevision

    const wrong = makeResponse()
    await apiHandler(makeRequest({ expectedOutlineRevision: 'deadbeefdeadbeef' }, `/api/dsh-tavern/novels/${createdA.novelId}/approve-outline`), wrong)
    expect(wrong.statusCode).toBe(409)
    const conflict = jsonBody(wrong)
    expect(conflict).toMatchObject({ ok: false, code: 'NOVEL_REVISION_CONFLICT', actualRevision: outlineRevision })

    const approve = makeResponse()
    await apiHandler(makeRequest({ expectedOutlineRevision: outlineRevision }, `/api/dsh-tavern/novels/${createdA.novelId}/approve-outline`), approve)
    expect(approve.statusCode).toBe(200)
    expect(jsonBody(approve)).toEqual({ ok: true, revision: (await novels.getNovel(createdA.novelId))!.revision })

    const detailA = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${createdA.novelId}`), detailA)
    expect(jsonBody(detailA).novel).toMatchObject({ status: 'active', phase: 'writing' })

    // Novel B: "update outline" authorizes exactly one revising pass.
    const createdB = await novels.createNovel(store, novelConfig({ title: '手动B', approvalMode: 'manual' }) as never)
    snapshot = await novels.getNovel(createdB.novelId)
    await novels.createOutline(createdB.novelId, {
      expectedRevision: snapshot!.revision,
      outline: minimalOutlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'ch-1' }],
    })
    const revise = makeResponse()
    await apiHandler(makeRequest({}, `/api/dsh-tavern/novels/${createdB.novelId}/update-outline`), revise)
    expect(revise.statusCode).toBe(200)
    expect(jsonBody(revise).ok).toBe(true)
    const detailB = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${createdB.novelId}`), detailB)
    expect(jsonBody(detailB).novel).toMatchObject({ status: 'active', phase: 'revising' })
  })

  it('binds a session through novel-open, marks the preset once and kicks the driver', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '驱动测试' }) as never)
    const agent = makeNovelAgent('novel-session-a')
    agents.set(agent.id, agent)

    const result = await handler({ agent, rawInput: base64Url({ action: 'novel-open', novelId: created.novelId }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['novel-session-a']).toEqual({
      architecture: 'agent-novel',
      novelId: created.novelId,
      character: '',
      chatId: '',
    })
    // Bundled preset installed into the user layer (proposal 0005 §17).
    expect(existsSync(join(home, '.agent-presets', 'agent-novel', 'preset.yml'))).toBe(true)
    expect(readFileSync(join(home, '.agent-presets', 'agent-novel', 'agent.cordis.yml'), 'utf8'))
      .toContain("name: 'dsh-tavern/novel'")
    // Marker + recompose exactly once; no placeholder turn events.
    expect(agent.session.events).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'agent-novel' } }])
    expect(recomposeCalls).toContainEqual({ agent: agent.ctx, presetId: 'agent-novel' })

    // §12.1 driver kick: the outline-create notice reaches the live agent.
    expect(await until(() => agent.followups.length > 0)).toBe(true)
    const notice = agent.followups[0] as { content?: Array<{ text?: string }>; source?: { form?: string; summary?: string } }
    expect(notice.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-tavern', form: 'notice' })
    expect(notice.source?.summary).toContain('AgentNovel work notice')
    expect(notice.content?.[0]?.text).toContain('Novel work brief')

    // Idempotent re-open: no extra marker, no second recompose.
    const recomposeCount = recomposeCalls.length
    const again = await handler({ agent, rawInput: base64Url({ action: 'novel-open', novelId: created.novelId }) })
    expect(again.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(1)
    expect(recomposeCalls).toHaveLength(recomposeCount)
  })

  it('reports an error for novel-open of an unknown novel', async () => {
    const agent = makePlainAgent('novel-session-missing')
    const result = await handler({ agent, rawInput: base64Url({ action: 'novel-open', novelId: 'missing-one' }) })
    expect(result).toMatchObject({ kind: 'error' })
    expect(result.text).toContain('not found')
    expect((await store.getState()).sessionBindings['novel-session-missing']).toBeUndefined()
  })

  it('refuses novel-open on a session that already started AgentTavern', async () => {
    const now = new Date().toISOString()
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused', chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '欢迎光临。' }])
    const agent = makePlainAgent('novel-session-tavern-locked')
    const open = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(open.kind).toBe('success')

    const created = await novels.createNovel(store, novelConfig({ title: '冲突测试' }) as never)
    await expect(handler({
      agent,
      rawInput: base64Url({ action: 'novel-open', novelId: created.novelId }),
    })).rejects.toThrow('already started')
    // The AgentTavern binding survives the refused rebind.
    expect((await store.getState()).sessionBindings['novel-session-tavern-locked']).toMatchObject({
      architecture: 'agent-tavern',
      character: CHARACTER,
      chatId,
    })
  })

  it('persists real user messages through the receive barrier and ignores plugin notices', async () => {
    const dispatch = (event: unknown) => sessionEventHandlers.at(-1)!({ id: 'novel-session-a' }, event)
    const requirementCount = async () => {
      const detail = makeResponse()
      const bound = (await store.getState()).sessionBindings['novel-session-a'] as { novelId: string }
      await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${bound.novelId}`), detail)
      return jsonBody(detail).novel.requirements.length
    }

    dispatch({ type: 'user/message', data: { id: 'msg-real-1', content: [{ type: 'text', text: '让常客在第三章回来' }], source: { kind: 'user' } } })
    expect(await untilAsync(async () => (await requirementCount()) === 2)).toBe(true)
    expect(await requirementCount()).toBe(2)

    // Host retries of the same message id dedupe to one ledger record.
    dispatch({ type: 'user/message', data: { id: 'msg-real-1', content: [{ type: 'text', text: '让常客在第三章回来' }], source: { kind: 'user' } } })
    // Driver notices (plugin source) are never directives.
    dispatch({ type: 'user/message', data: { id: 'msg-notice-1', content: [{ type: 'text', text: 'scheduled work' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: 'AgentNovel work notice (novel nvl-x, intent wi-x)' } } })
    dispatch({ type: 'user/message', data: { id: 'msg-notice-2', content: [{ type: 'text', text: 'closed' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice' } } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await requirementCount()).toBe(2)

    const detail = makeResponse()
    const bound = (await store.getState()).sessionBindings['novel-session-a'] as { novelId: string }
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${bound.novelId}`), detail)
    const requirement = jsonBody(detail).novel.requirements.find((item: { sequence?: number }) => item.sequence === 2)
    expect(requirement).toMatchObject({ status: 'pending', text: '让常客在第三章回来' })
  })

  it('aggregates chapters, paginates the body and exports markdown/zip', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '正文测试' }) as never)
    let snapshot = await novels.getNovel(created.novelId)
    await novels.createOutline(created.novelId, {
      expectedRevision: snapshot!.revision,
      outline: minimalOutlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'ch-1' }],
    })
    snapshot = await novels.getNovel(created.novelId)
    const outlineRevision = snapshot!.outline!.outlineRevision
    const { unitId } = await novels.prepareUnit(created.novelId, {
      chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '老板与常客的第一段对话',
    })
    const claim = await novels.claimUnit(created.novelId, {
      unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1,
    })
    await novels.commitBody(created.novelId, {
      unitId,
      executionToken: claim.executionToken,
      paragraphs: ['第一段正文。', '第二段正文。'],
      sceneCompletion: { completed: true, basis: 'scene goal met', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })

    const detail = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}`), detail)
    const full = jsonBody(detail).novel
    expect(full.chapters).toEqual([
      { chapterId: 'ch-1', order: 1, title: '第一章 打烊之前', state: 'writing', committedCharacters: 10 },
    ])
    expect(full.outlineSummary).toMatchObject({
      outlineRevision,
      story: { premise: '灯下酒馆的夜晚', theme: '陪伴', endingDirection: '告别' },
      foreshadowing: [expect.objectContaining({ id: 'fore-1', required: true, status: 'open' })],
    })
    expect(full.budget.remainingCharacters).toBeNull()

    const outline = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/outline`), outline)
    const plan = jsonBody(outline).outline
    expect(plan.outlineRevision).toBe(outlineRevision)
    expect(plan.chapters[0]).toMatchObject({ chapterId: 'ch-1', title: '第一章 打烊之前' })

    const bodyPage = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/body?chapterId=ch-1`), bodyPage)
    expect(jsonBody(bodyPage)).toEqual({
      ok: true,
      paragraphs: [
        { commitId: 'commit-1', paragraphIndex: 0, chapterId: 'ch-1', text: '第一段正文。' },
        { commitId: 'commit-1', paragraphIndex: 1, chapterId: 'ch-1', text: '第二段正文。' },
      ],
      nextCursor: null,
    })

    const pageOne = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/body?chapterId=ch-1&limit=1`), pageOne)
    expect(jsonBody(pageOne).paragraphs).toHaveLength(1)
    expect(jsonBody(pageOne).nextCursor).toBe('1')
    const pageTwo = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/body?chapterId=ch-1&limit=1&cursor=1`), pageTwo)
    expect(jsonBody(pageTwo)).toMatchObject({ ok: true, nextCursor: null })
    expect(jsonBody(pageTwo).paragraphs[0]).toMatchObject({ text: '第二段正文。' })

    const md = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/export?format=md`), md)
    expect(md.statusCode).toBe(200)
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(md.headers['content-disposition']).toContain('attachment; filename=')
    const mdBytes = Buffer.concat(md.chunks)
    expect(mdBytes.length).toBeGreaterThan(0)
    expect(mdBytes.toString('utf8')).toContain('# 正文测试')
    expect(mdBytes.toString('utf8')).toContain('第一段正文。')

    const zip = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}/export?format=zip`), zip)
    expect(zip.statusCode).toBe(200)
    expect(zip.headers['content-type']).toBe('application/zip')
    const zipBytes = Buffer.concat(zip.chunks)
    expect(zipBytes.length).toBeGreaterThan(0)
    expect(zipBytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('pause, resume and stop surface the new revision', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '控制测试' }) as never)
    const pause = makeResponse()
    await apiHandler(makeRequest({}, `/api/dsh-tavern/novels/${created.novelId}/pause`), pause)
    expect(pause.statusCode).toBe(200)
    expect(jsonBody(pause).ok).toBe(true)
    expect((await novels.getNovel(created.novelId))!.run.pauseReason).toBe('user-request')

    const stop = makeResponse()
    await apiHandler(makeRequest({}, `/api/dsh-tavern/novels/${created.novelId}/stop`), stop)
    expect(stop.statusCode).toBe(200)
    expect((await novels.getNovel(created.novelId))!.run.pauseReason).toBe('stopped')

    const resume = makeResponse()
    await apiHandler(makeRequest({}, `/api/dsh-tavern/novels/${created.novelId}/resume`), resume)
    expect(resume.statusCode).toBe(200)
    expect(jsonBody(resume).revision).toBe((await novels.getNovel(created.novelId))!.revision)
    expect((await novels.getNovel(created.novelId))!.run.status).toBe('active')
  })

  it('patches meta with CAS and echoes the actual revision on conflict', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '补丁测试' }) as never)
    const current = (await novels.getNovel(created.novelId))!.revision

    const stale = makeResponse()
    await apiHandler(makeRequest({
      expectedRevision: 'deadbeefdeadbeef',
      patch: { title: '新标题' },
      cause: 'panel-edit',
    }, `/api/dsh-tavern/novels/${created.novelId}`, 'PATCH'), stale)
    expect(stale.statusCode).toBe(409)
    expect(jsonBody(stale)).toMatchObject({ ok: false, code: 'NOVEL_REVISION_CONFLICT', actualRevision: current })

    const patch = makeResponse()
    await apiHandler(makeRequest({
      expectedRevision: current,
      patch: { title: '补丁后的标题', genre: '悬疑' },
      cause: 'panel-edit',
    }, `/api/dsh-tavern/novels/${created.novelId}`, 'PATCH'), patch)
    expect(patch.statusCode).toBe(200)
    const next = (await novels.getNovel(created.novelId))!
    expect(jsonBody(patch)).toEqual({ ok: true, revision: next.revision })
    expect(next.config).toMatchObject({ title: '补丁后的标题', genre: '悬疑' })

    // 预算补丁：面板编辑最大轮数（长章节场景）；noteTurn 实时读快照，下一轮生效。
    const budgetPatch = makeResponse()
    await apiHandler(makeRequest({
      expectedRevision: next.revision,
      patch: { budgets: { ...next.config.budgets, maxTurns: 321 } },
      cause: 'panel-edit',
    }, `/api/dsh-tavern/novels/${created.novelId}`, 'PATCH'), budgetPatch)
    expect(budgetPatch.statusCode).toBe(200)
    const budgeted = (await novels.getNovel(created.novelId))!
    expect(jsonBody(budgetPatch)).toEqual({ ok: true, revision: budgeted.revision })
    expect(budgeted.config.budgets.maxTurns).toBe(321)
    expect(budgeted.config.budgets.externalRetry).toEqual(next.config.budgets.externalRetry)

    const badBudget = makeResponse()
    await apiHandler(makeRequest({
      expectedRevision: budgeted.revision,
      patch: { budgets: { ...budgeted.config.budgets, maxTurns: 0 } },
      cause: 'panel-edit',
    }, `/api/dsh-tavern/novels/${created.novelId}`, 'PATCH'), badBudget)
    expect(badBudget.statusCode).toBe(400)
    expect(jsonBody(badBudget)).toMatchObject({ ok: false, code: 'NOVEL_CONFIG' })
  })

  // Mutating (session binding + novel + probe spawns), so it sits beside the
  // terminal deletion test under the shared-state discipline.
  it('creates a writerMode=subagent novel over HTTP when the creation probe passes (0007 §9 happy path)', async () => {
    // Scripted fake runtime: the P1 spawn really executes novel_status_read
    // with exec.agent.id = run.id — the binding miss throws afterwards, which
    // is expected, because the identity record happens before binding
    // resolution (usage.ts probe slot). The empty-allow P2 spawn never touches
    // the tool and reports it unavailable (observational pass, §9 P2 wording).
    let counter = 0
    const calls: Array<{ label: string | undefined; allow: readonly string[] }> = []
    const probeRuntime: SubagentRuntimeLike = {
      async start(_provider, request) {
        counter += 1
        const spawnIndex = counter
        const allow = [...(request.toolFilter?.allow ?? [])]
        calls.push({ label: request.label, allow })
        const result = (async () => {
          if (allow.includes('novel_status_read')) {
            await novelTools.get('novel_status_read')!.execute({}, { agent: { id: `probe-run-${spawnIndex}` } }).catch(() => {})
          }
          return {
            output: [{ type: 'text', text: spawnIndex === 1 ? 'ok' : 'unavailable' }],
            stopReason: 'completed' as const,
          }
        })()
        return { id: `probe-run-${spawnIndex}`, result, async dispose() {} }
      },
    }
    // bound-agent channel: the exact discovery path novel_writer_delegate uses
    // at runtime (exec.agent → subagentRuntimeOf) — discoverWriterProbeRuntime's
    // preferred channel, so a pass here proves the path W2 actually runs on.
    agents.set('probe-host-agent', {
      id: 'probe-host-agent',
      ctx: { id: 'probe-host-agent', get: (name: string) => (name === 'subagents' ? probeRuntime : undefined) },
    })
    const host = await novels.createNovel(store, novelConfig({ title: '探针宿主' }) as never)
    await store.updateState((current) => ({
      sessionBindings: {
        ...current.sessionBindings,
        'probe-host-agent': { architecture: 'agent-novel', novelId: host.novelId, character: '', chatId: '' },
      },
    }))

    const res = makeResponse()
    await apiHandler(makeRequest(novelConfig({ title: '写手子代理小说', writerMode: 'subagent' }), '/api/dsh-tavern/novels'), res)
    expect(res.statusCode).toBe(200)
    const body = jsonBody(res)
    expect(body).toMatchObject({ ok: true, novel: { title: '写手子代理小说', status: 'active', phase: 'outlining' } })
    // The gate really spawned both probes: the closed allow list, then the
    // empty one — no probe, no creation.
    expect(calls.map((call) => call.allow)).toEqual([['novel_status_read'], []])
    // Explicit subagent mode is stored verbatim; the absent-mode inline
    // normalization is the store layer's contract (novel.ts) and is asserted
    // in the novel-store spec, not re-proven here.
    const detail = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/novels/${body.novel.novelId as string}`), detail)
    expect(jsonBody(detail).novel.config).toMatchObject({ writerMode: 'subagent' })
  })

  // Mutating tests last (shared-state discipline): deletion is terminal.
  it('DELETE clears the session bindings before removing the novel and stays idempotent', async () => {
    const created = await novels.createNovel(store, novelConfig({ title: '删除测试' }) as never)
    const agent = makePlainAgent('novel-session-delete')
    await handler({ agent, rawInput: base64Url({ action: 'novel-open', novelId: created.novelId }) })
    expect((await store.getState()).sessionBindings['novel-session-delete']).toMatchObject({ novelId: created.novelId })

    const res = makeResponse()
    await apiHandler({ ...makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}`), method: 'DELETE' }, res)
    expect(res.statusCode).toBe(200)
    expect(jsonBody(res)).toEqual({ ok: true })

    const state = await store.getState()
    expect(state.sessionBindings['novel-session-delete']).toBeUndefined()
    const ids = (await novels.listNovels()).map((summary) => summary.novelId)
    expect(ids).not.toContain(created.novelId)

    const again = makeResponse()
    await apiHandler({ ...makeGetRequest(`/api/dsh-tavern/novels/${created.novelId}`), method: 'DELETE' }, again)
    expect(again.statusCode).toBe(200)
    expect(jsonBody(again)).toEqual({ ok: true })
  })
})
