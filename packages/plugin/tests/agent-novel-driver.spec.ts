import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NovelDriver,
  recoverNovels,
  type DriverAgentLike,
  type NovelDriverHost,
} from '../src/agent-novel/driver.js'
import { isNovelAuthorMessage, receiveAuthorMessage } from '../src/agent-novel/requirements.js'
import { noteToolOutputBytes } from '../src/agent-novel/usage.js'
import {
  NovelStore,
  TavernStore,
  type NovelCreateConfig,
  type NovelOutlinePayload,
} from '../../tavern-store/src/index.js'

/* -------------------------------- fixtures -------------------------------- */

const SESSION_ID = 'novel-session'
const AGENT_ID = 'novelist'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Async projections may still be settling; Windows rmdir needs retries.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw cause
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }
})

async function fixture(overrides?: Partial<NovelCreateConfig>): Promise<{
  root: string
  tavern: TavernStore
  novels: NovelStore
  novelId: string
  revision: string
  config: NovelCreateConfig
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-novel-driver-'))
  roots.push(root)
  const tavern = await TavernStore.open(root)
  const novels = await NovelStore.open(root)
  const config: NovelCreateConfig = {
    title: '灯塔',
    requirement: '写一个灯塔看守人的短篇',
    language: 'zh',
    genre: 'literary',
    narrativePerspective: 'third-person',
    styleNotes: '',
    lengthBudget: { kind: 'unbounded' },
    maxChapters: null,
    approvalMode: 'automatic',
    characterNames: [],
    worldNames: [],
    budgets: {
      maxTurns: 100,
      maxDurationMs: 3_600_000,
      stallThresholdTurns: 10,
      consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 2, backoffMs: 5 },
      maxDeduceRuns: 5,
    },
    ...overrides,
  }
  const created = await novels.createNovel(tavern, config)
  await tavern.updateState(() => ({
    sessionBindings: { [SESSION_ID]: { architecture: 'agent-novel', novelId: created.novelId, character: '', chatId: '' } },
  }))
  return { root, tavern, novels, novelId: created.novelId, revision: created.revision, config }
}

function outlinePayload(): NovelOutlinePayload {
  return {
    story: { premise: '看守人发现海面异象', theme: '孤独与守望', mainConflict: '人与海', endingDirection: '黎明到来', taboos: [] },
    characters: [{
      characterId: 'keeper', name: '守塔人', initialState: '平静值守', motivation: '守到最后一次日出', relations: [], arc: '从逃避到直面',
    }],
    chapters: [{
      chapterId: 'ch-1', order: 1, title: '第一章', purpose: '推进主线', keyEvents: ['发现异象'],
      plannedCharacters: null, entryCondition: '前章结束', exitCondition: '本章目标达成',
    }],
    currentChapterId: 'ch-1',
    scenes: [{
      sceneId: 'sc-1', order: 1, goal: '发现海面异象并做出决定', participants: ['keeper'],
      timeLocation: '塔顶 / 深夜', causality: '承接开篇', conflict: '风暴逼近', expectedChange: '下定决心',
    }],
    foreshadowing: [],
  }
}

/** Creates the outline and applies req-1, leaving a claimable writing novel. */
async function createOutline(novels: NovelStore, novelId: string, expectedRevision: string): Promise<string> {
  const outlined = await novels.createOutline(novelId, {
    expectedRevision,
    outline: outlinePayload(),
    handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
  })
  return outlined.revision
}

/** Fake host agent; whenIdle's callback flips status to idle (trap shape). */
class FakeAgent implements DriverAgentLike {
  readonly session = { id: SESSION_ID }
  status: 'idle' | 'running' = 'idle'
  readonly followups: unknown[] = []
  attempts = 0
  followupError: Error | null = null

  constructor(readonly id: string) {}

  followup(message: unknown): void {
    this.attempts += 1
    if (this.followupError !== null) throw this.followupError
    this.followups.push(message)
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        this.status = 'idle'
        resolve()
      })
    })
  }
}

interface Notice {
  id: string
  role: string
  content: Array<{ type: string; text: string }>
  source: { kind: string; plugin: string; form: string; novelId: string; intentId: string }
}

function noticeOf(agent: FakeAgent, index: number): Notice {
  return agent.followups[index] as Notice
}

function textOf(notice: Notice): string {
  return notice.content.map((block) => block.text).join('')
}

interface Harness {
  host: NovelDriverHost
  emit(event: string, payload: unknown): void
  readonly warns: Array<{ message: string; fields?: Record<string, unknown> }>
}

function harness(agent?: FakeAgent): Harness {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  const warns: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const agentsById = new Map<string, DriverAgentLike>()
  if (agent !== undefined) agentsById.set(agent.id, agent)
  const host: NovelDriverHost = {
    agents: {
      withoutInitiator: <T>(op: () => T): T => op(),
      get: (id: string): DriverAgentLike | undefined => agentsById.get(id),
    },
    on: (event: string, handler: (payload: never) => void | Promise<void>) => {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler))
      }
    },
    effect: (fn: () => void) => {
      fn()
    },
    logger: { warn: (message: string, fields?: Record<string, unknown>) => { warns.push({ message, fields }) } },
  }
  const emit = (event: string, payload: unknown): void => {
    for (const handler of [...(handlers.get(event) ?? [])]) void handler(payload)
  }
  return { host, emit, warns }
}

const settle = async (ms = 60): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const turnEnd = (turn: number, kind = 'completed'): { type: string; data: { turn: number; reason: { kind: string } } } => ({
  type: 'turn/end',
  data: { turn, reason: { kind } },
})

describe('NovelDriver scheduling', () => {
  it('happy path: novel-open delivers the kickoff notice, turn/end schedules the write-unit work', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })

    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error(`expected the kickoff followup, saw ${agent.followups.length}`)
    })

    const kickoff = noticeOf(agent, 0)
    expect(kickoff.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-tavern', form: 'novel-notice', novelId })
    expect(kickoff.source.intentId).toMatch(/^wi-/)
    expect(kickoff.id).toBe(`novel-notice-${kickoff.source.intentId}`)
    expect(kickoff.role).toBe('user')
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.inFlightIntent).toMatchObject({ kind: 'outline-create', intentId: kickoff.source.intentId })
    expect(textOf(kickoff)).toContain('Novel work brief')
    expect(textOf(kickoff)).toContain('novel_outline_create')

    // The model creates the outline and its turn ends.
    await createOutline(novels, novelId, snapshot!.revision)
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the write-unit followup, saw ${agent.followups.length}`)
    })

    const writeUnit = noticeOf(agent, 1)
    expect(writeUnit.source.form).toBe('novel-notice')
    expect(textOf(writeUnit)).toContain('novel_unit_claim')
    expect(textOf(writeUnit)).toContain('unit-1')
    const after = await novels.getNovel(novelId)
    expect(after?.run.inFlightIntent?.kind).toBe('write-unit')
    expect(after?.run.inFlightIntent?.unitId).toBe('unit-1')
    expect(after?.units.find((unit) => unit.unitId === 'unit-1')).toMatchObject({ state: 'prepared', sceneId: 'sc-1' })
    // §13 accounting: one host turn counted, kickoff intent resolved delivered.
    expect(after?.run.turnsRun).toBe(1)
    expect(after?.run.inFlightIntent?.intentId).not.toBe(kickoff.source.intentId)

    await driver.dispose()
  })

  it('levels the turn/end edge: a still-running agent is awaited via whenIdle and still drives', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)

    // Trap shape: turn/end fires while the AgentLoop still reports running;
    // whenIdle's callback flips the status before resolving.
    agent.status = 'running'
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the drive to proceed after whenIdle, saw ${agent.followups.length}`)
    })
    expect(agent.status).toBe('idle')
    expect(textOf(noticeOf(agent, 1))).toContain('unit-1')
    await driver.dispose()
  })

  it('degrades a gated host whose agents service throws on property access', async () => {
    const { tavern, novels, novelId } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const handlers = new Map<string, Array<(payload: unknown) => void>>()
    const throwingAgents = new Proxy({} as Record<string, unknown>, {
      get(): Record<string, unknown> {
        throw new Error('cannot get property without inject/inactive context')
      },
    })
    const host: NovelDriverHost = {
      agents: throwingAgents,
      on: (event: string, handler: (payload: never) => void | Promise<void>) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (payload: unknown) => void)
        handlers.set(event, list)
        return () => handlers.delete(event)
      },
      effect: (fn: () => void) => {
        fn()
      },
    }
    expect(() => NovelDriver.create(host, { store: novels, tavern })).not.toThrow()
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await expect(driver.handleNovelOpen(agent, novelId)).resolves.toBeUndefined()
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error(`expected the degraded drive to deliver, saw ${agent.followups.length}`)
    })
    expect((await novels.getNovel(novelId))?.run.inFlightIntent?.kind).toBe('outline-create')
    // Re-arm events on the gated host must not crash either.
    for (const handler of [...(handlers.get('agent/status') ?? [])]) {
      void handler({ agent, status: 'idle' })
    }
    await settle()
    await driver.dispose()
  })

  it('dedupes duplicate turn/end edges of the same boundary (queued followup is not repeated)', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host, emit } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)

    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error('write-unit followup missing')
    })
    // Duplicate edge of the same turn boundary: no accounting, no schedule.
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    // An extra idle re-arm must not resolve the queued intent and re-send.
    emit('agent/status', { agent, status: 'idle' })
    await settle()
    expect(agent.followups).toHaveLength(2)
    expect((await novels.getNovel(novelId))?.run.turnsRun).toBe(1)
    await driver.dispose()
  })

  it('waits while the next scene has a claimed unit in flight: no duplicate prepare, no re-notice', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)
    const outlineRevision = (await novels.getNovel(novelId))!.outline!.outlineRevision

    // The author claims the unit, then its turn ends WITHOUT a commit (turn
    // budget, interruption, ...). The claim legitimately survives the turn.
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error('write-unit followup missing')
    })
    const unitId = (await novels.getNovel(novelId))!.run.inFlightIntent!.unitId!
    const claim = await novels.claimUnit(novelId, { unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 2 })

    // Regression: while the claim is open, a drive pass must neither prepare a
    // duplicate unit for the same scene nor deliver another notice. (Before
    // the fix this pass re-prepared the scene as a second unit and nagged the
    // agent, who then hit unit-in-flight on every claim attempt.)
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(2))
    await settle(120)
    expect(agent.followups).toHaveLength(2)
    const mid = await novels.getNovel(novelId)
    expect(mid?.units).toHaveLength(1)
    expect(mid?.units[0]).toMatchObject({ unitId, state: 'claimed' })

    // Once the claim commits, the drive unblocks on the next turn end.
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['守塔人看见了光。'],
      sceneCompletion: { completed: true, basis: '异象确认', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(3))
    await vi.waitFor(async () => {
      if (agent.followups.length < 3) throw new Error('expected the drive to unblock after the commit')
    })
    expect(textOf(noticeOf(agent, 2))).toContain('novel_chapter_complete')
    await driver.dispose()
  })

  it('ignores turn/end edges of sessions without an agent-novel binding', async () => {
    const { tavern, novels, novelId } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleSessionEvent({ id: 'some-other-session' }, turnEnd(1))
    await settle()
    expect(agent.followups).toHaveLength(0)
    expect((await novels.getNovel(novelId))?.run.turnsRun).toBe(0)
    await driver.dispose()
  })

  it('restart recovery: cancels the stale in-flight intent and never re-delivers the kickoff', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agentOne = new FakeAgent(AGENT_ID)
    const first = harness(agentOne)
    const driverOne = NovelDriver.create(first.host, { store: novels, tavern })
    await driverOne.handleNovelOpen(agentOne, novelId)
    await vi.waitFor(async () => {
      if (agentOne.followups.length < 1) throw new Error('kickoff missing')
    })
    // The kickoff turn created the outline but no turn/end was observed.
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)
    expect((await novels.getNovel(novelId))?.run.inFlightIntent).not.toBeNull()

    await driverOne.dispose()
    await driverOne.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await settle()
    expect(agentOne.followups).toHaveLength(1)

    // New driver instance: memory state is gone, horizontal recovery applies.
    const agentTwo = new FakeAgent(AGENT_ID)
    const second = harness(agentTwo)
    const driverTwo = NovelDriver.create(second.host, { store: novels, tavern })
    await recoverNovels(driverTwo)
    expect((await novels.getNovel(novelId))?.run.inFlightIntent).toBeNull()

    await driverTwo.handleNovelOpen(agentTwo, novelId)
    await vi.waitFor(async () => {
      if (agentTwo.followups.length < 1) throw new Error(`expected one followup, saw ${agentTwo.followups.length}`)
    })
    const text = textOf(noticeOf(agentTwo, 0))
    expect(text).toContain('novel_unit_claim')
    expect(text).not.toContain('Kickoff work')
    expect((await novels.getNovel(novelId))?.run.inFlightIntent?.kind).toBe('write-unit')
    await driverTwo.dispose()
  })

  it('does not self-start paused or completed novels', async () => {
    const paused = await fixture()
    await paused.novels.pause(paused.novelId, { reason: 'user-request' })
    const pausedAgent = new FakeAgent(AGENT_ID)
    const pausedHarness = harness(pausedAgent)
    const pausedDriver = NovelDriver.create(pausedHarness.host, { store: paused.novels, tavern: paused.tavern })
    await pausedDriver.handleNovelOpen(pausedAgent, paused.novelId)
    await settle()
    expect(pausedAgent.followups).toHaveLength(0)
    expect((await paused.novels.getNovel(paused.novelId))?.run.inFlightIntent).toBeNull()
    await pausedDriver.dispose()

    const completed = await fixture()
    await createOutline(completed.novels, completed.novelId, completed.revision)
    const { unitId } = await completed.novels.prepareUnit(completed.novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
    const claim = await completed.novels.claimUnit(completed.novelId, { unitId, expectedOutlineRevision: (await completed.novels.getNovel(completed.novelId))!.outline!.outlineRevision, expectedRequirementSequence: 1 })
    await completed.novels.commitBody(completed.novelId, {
      unitId, executionToken: claim.executionToken, paragraphs: ['黎明到来。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await completed.novels.completeChapter(completed.novelId, {
      chapterId: 'ch-1', expectedContentRevision: (await completed.novels.getNovel(completed.novelId))!.contentRevision, basis: '完成', openItems: [],
    })
    await completed.novels.finishNovel(completed.novelId, { expectedRevision: (await completed.novels.getNovel(completed.novelId))!.revision, basis: '完成' })
    const doneAgent = new FakeAgent(AGENT_ID)
    const doneHarness = harness(doneAgent)
    const doneDriver = NovelDriver.create(doneHarness.host, { store: completed.novels, tavern: completed.tavern })
    await doneDriver.handleNovelOpen(doneAgent, completed.novelId)
    await settle()
    expect(doneAgent.followups).toHaveLength(0)
    await doneDriver.dispose()
  })

  it('drives outline-revise instead of write-unit while directives are unprocessed', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    await createOutline(novels, novelId, revision)
    await novels.receiveRequirement(novelId, { hostMessageId: 'm-2', text: '增加暴风雪', sourceKind: 'composer' })
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('revise followup missing')
    })
    const text = textOf(noticeOf(agent, 0))
    expect(text).toContain('novel_outline_revise')
    expect(text).toContain('droppedChapterIds')
    expect(text).not.toContain('novel_unit_claim')
    expect((await novels.getNovel(novelId))?.run.inFlightIntent?.kind).toBe('outline-revise')
    await driver.dispose()
  })

  it('progress signature: pure outline rewording does not reset the stall counter, commits do', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    await createOutline(novels, novelId, revision)
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })

    // Turn 1: the outline exists, so the first signature lands and resets.
    // The wait also covers the drive's own writes (prepare/record) so the
    // revision read below cannot race the driver.
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.lastProgressSignature !== 'commits:0;chapters:0') throw new Error('signature not landed')
      if (snapshot?.run.inFlightIntent === null) throw new Error('drive not settled')
    })
    expect((await novels.getNovel(novelId))?.run.stalledTurns).toBe(0)

    // Pure rewording revision: same substantive fields, watermark unchanged.
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: (await novels.getNovel(novelId))!.outline!.outlineRevision,
      reason: '措辞润色',
      changes: outlinePayload(),
      handledRequirements: [],
    })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(2))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.turnsRun !== 2) throw new Error('turn 2 not accounted')
      if (snapshot?.run.inFlightIntent === null) throw new Error('drive not settled')
    })
    const reworded = await novels.getNovel(novelId)
    expect(reworded?.run.lastProgressSignature).toBe('commits:0;chapters:0')
    expect(reworded?.run.stalledTurns).toBe(1)

    // A committed body is real progress and resets the stall window.
    const { unitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
    const claim = await novels.claimUnit(novelId, { unitId, expectedOutlineRevision: reworded!.outline!.outlineRevision, expectedRequirementSequence: 1 })
    await novels.commitBody(novelId, {
      unitId, executionToken: claim.executionToken, paragraphs: ['风暴之夜，海面泛起不祥的光。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(3))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.lastProgressSignature !== 'commits:1;chapters:0') throw new Error('commit signature not landed')
    })
    expect((await novels.getNovel(novelId))?.run.stalledTurns).toBe(0)
    await driver.dispose()
  })

  it('bounded followup retries: exhausted delivery resolves the intent failed and pauses stalled', async () => {
    const { tavern, novels, novelId } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    agent.followupError = new Error('inbox closed')
    const { host, warns } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.pauseReason !== 'stalled') throw new Error(`expected stalled pause, saw ${snapshot?.run.pauseReason ?? 'none'}`)
    })
    expect(agent.attempts).toBe(2) // externalRetry.maxAttempts
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.inFlightIntent).toBeNull()
    expect(snapshot?.run.lastError).toContain('followup delivery failed')
    expect(warns.some((entry) => entry.fields?.operation === 'followup-attempt-failed')).toBe(true)
    await driver.dispose()
  })

  it('warns once without a live agent and re-arms through agent/created plus agent/status', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host, emit, warns } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)

    emit('agent/disposed', { agent })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (!warns.some((entry) => entry.fields?.operation === 'no-live-agent')) throw new Error('warn not landed')
    })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(2))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.turnsRun !== 2) throw new Error('turn 2 not accounted')
    })
    await settle()
    const noAgent = warns.filter((entry) => entry.fields?.operation === 'no-live-agent')
    expect(noAgent).toHaveLength(1)
    expect(noAgent[0]?.fields).toMatchObject({ novelId })
    expect(agent.followups).toHaveLength(1)

    emit('agent/created', { agent })
    emit('agent/status', { agent, status: 'idle' })
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the re-armed drive, saw ${agent.followups.length}`)
    })
    expect(textOf(noticeOf(agent, 1))).toContain('unit-1')
    await driver.dispose()
  })

  it('cold session: agent/status(idle) alone schedules the kickoff without novel-open', async () => {
    const { tavern, novels, novelId } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host, emit } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    emit('agent/created', { agent })
    emit('agent/status', { agent, status: 'idle' })
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error(`expected the status re-arm kickoff, saw ${agent.followups.length}`)
    })
    expect((await novels.getNovel(novelId))?.run.inFlightIntent?.kind).toBe('outline-create')
    await driver.dispose()
  })

  it('the requirements receive barrier rejects driver notices as non-author messages', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    const notice = noticeOf(agent, 0)
    // Feeding the driver notice back through the receive barrier must not
    // register it as an author directive (infinite-loop guard, §9.1).
    const event = {
      type: 'user/message',
      data: { id: notice.id, role: 'user', content: notice.content, source: notice.source },
    }
    expect(isNovelAuthorMessage(event)).toBe(false)
    await expect(receiveAuthorMessage(novels, novelId, SESSION_ID, event)).resolves.toMatchObject({ accepted: false })
    expect((await novels.getNovel(novelId))?.requirements).toHaveLength(1)
    expect(revision).toMatch(/^[0-9a-f]{16}$/)
    await driver.dispose()
  })

  it('kick re-arms a user-resumed novel that no session edge would wake (route poke regression)', async () => {
    // Real-machine incident (2026-09-18): the user paused the novel mid-turn
    // (aborting it), clicked resume the next morning, and the run sat active
    // with an idle agent forever — resume flips the store state without any
    // turn/end or agent/status edge, so §12.1 scheduling never fired.
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host, emit } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))!.revision)

    // User pause mid-turn: the abort edge accounts a failed turn, then the
    // novel is resumed through the HTTP route — no edge accompanies it.
    await novels.pause(novelId, { reason: 'user-request' })
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1, 'aborted'))
    await settle()
    await novels.resume(novelId)
    await settle()
    expect(agent.followups).toHaveLength(1) // the deadlock: nothing schedules
    expect((await novels.getNovel(novelId))?.run.lastError).toBe('turn ended with stop reason aborted')

    // The route's driver.kick is the only wake-up for this state.
    driver.kick(novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the post-resume work brief, saw ${agent.followups.length}`)
    })
    expect(textOf(noticeOf(agent, 1))).toContain('Novel work brief')
    expect((await novels.getNovel(novelId))?.run.inFlightIntent?.kind).toBe('write-unit')
    await driver.dispose()
  })

  it('kick discovers the bound agent through the agents service when a restart skipped every event (cold-map regression)', async () => {
    // Real-machine hole (2026-09-18, second incident): the host restarted
    // while the novel was paused — recover registered no binding and no
    // agent/* event ever reached the driver — so the resume kick found no
    // agent and silently delivered nothing.
    const { tavern, novels, novelId, revision } = await fixture()
    await createOutline(novels, novelId, revision)
    // Same id as the session: workspace agents are keyed by session id.
    const agent = new FakeAgent(SESSION_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })

    await novels.pause(novelId, { reason: 'budget', detail: 'max duration reached' })
    await driver.recover() // registers the binding map; scheduling stays active-only
    await novels.resume(novelId)
    await settle()
    expect(agent.followups).toHaveLength(0)

    driver.kick(novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error(`expected the discovered work brief, saw ${agent.followups.length}`)
    })
    expect(textOf(noticeOf(agent, 0))).toContain('Novel work brief')
    await driver.dispose()
  })
})

describe('NovelDriver writerMode notice branching (0007 §7/§8)', () => {
  /** Strips config.writerMode from the head revision file: simulates a
   *  pre-0007 on-disk snapshot, which the read side must treat as inline. */
  async function stripWriterMode(root: string, novelId: string): Promise<void> {
    const dir = join(root, 'novels', novelId)
    const head = JSON.parse(await readFile(join(dir, 'HEAD.json'), 'utf8')) as { revision: string }
    const revisionPath = join(dir, 'revisions', `${head.revision}.json`)
    const file = JSON.parse(await readFile(revisionPath, 'utf8')) as { snapshot: { config: Record<string, unknown> } }
    delete file.snapshot.config.writerMode
    await writeFile(revisionPath, JSON.stringify(file), 'utf8')
  }

  async function driveToWriteUnit(overrides?: Partial<NovelCreateConfig>): Promise<{
    novels: NovelStore
    tavern: TavernStore
    novelId: string
    revision: string
    agent: FakeAgent
    driver: NovelDriver
  }> {
    const { tavern, novels, novelId, revision } = await fixture(overrides)
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the write-unit followup, saw ${agent.followups.length}`)
    })
    return { novels, tavern, novelId, revision, agent, driver }
  }

  it('subagent mode: the write-unit notice delegates without a prior claim', async () => {
    const { agent, driver } = await driveToWriteUnit({ writerMode: 'subagent' })
    const text = textOf(noticeOf(agent, 1))
    expect(text).toContain("novel_writer_delegate { unitId: 'unit-1' }")
    expect(text).toContain('do NOT call novel_unit_claim first')
    expect(text).toContain('never write body text yourself')
    expect(text).toContain('end the turn immediately')
    expect(text).not.toContain('claim it first with novel_unit_claim')
    // The delegated mode never asks the author to commit prose itself.
    expect(text).not.toContain('commit exactly once with novel_body_commit')
    await driver.dispose()
  })

  it('inline mode (default): the write-unit instruction text is unchanged', async () => {
    const { agent, driver } = await driveToWriteUnit()
    const text = textOf(noticeOf(agent, 1))
    expect(text).toContain(`claim it first with novel_unit_claim { unitId: 'unit-1'`)
    expect(text).toContain('commit exactly once with novel_body_commit')
    expect(text).toContain('End the turn immediately after the commit (§11)')
    expect(text).not.toContain('novel_writer_delegate')
    await driver.dispose()
  })

  it('legacy snapshots without writerMode read as inline', async () => {
    const { root, tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)
    await stripWriterMode(root, novelId)
    expect((await novels.getNovel(novelId))?.config).not.toHaveProperty('writerMode')
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      if (agent.followups.length < 2) throw new Error(`expected the write-unit followup, saw ${agent.followups.length}`)
    })
    expect(textOf(noticeOf(agent, 1))).toContain('claim it first with novel_unit_claim')
    await driver.dispose()
  })
})

describe('NovelDriver turn/end usage sampling (0007 §7 W0)', () => {
  it('persists the drained per-tool output bytes with the same turn ordinal as noteTurn', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)

    noteToolOutputBytes('novel_status_read', 42)
    noteToolOutputBytes('novel_outline_read', 7)
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(1))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if ((snapshot?.run.usageSamples ?? []).length !== 1) throw new Error('usage sample not landed')
      if (snapshot?.run.turnsRun !== 1) throw new Error('turn 1 not accounted')
    })
    const sampled = (await novels.getNovel(novelId))!.run.usageSamples!
    expect(sampled).toHaveLength(1)
    expect(sampled[0]).toMatchObject({ turn: 1, toolBytes: { novel_status_read: 42, novel_outline_read: 7 } })
    expect(sampled[0]!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // The drain cleared the accumulator: a turn with no tool bytes adds no sample.
    await driver.handleSessionEvent({ id: SESSION_ID }, turnEnd(2))
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.turnsRun !== 2) throw new Error('turn 2 not accounted')
    })
    expect((await novels.getNovel(novelId))!.run.usageSamples!).toHaveLength(1)
    await driver.dispose()
  })

  it('skips the sample on degraded turn edges without a turn ordinal but still accounts', async () => {
    const { tavern, novels, novelId, revision } = await fixture()
    const agent = new FakeAgent(AGENT_ID)
    const { host } = harness(agent)
    const driver = NovelDriver.create(host, { store: novels, tavern })
    await driver.handleNovelOpen(agent, novelId)
    await vi.waitFor(async () => {
      if (agent.followups.length < 1) throw new Error('kickoff missing')
    })
    await createOutline(novels, novelId, (await novels.getNovel(novelId))?.revision ?? revision)
    noteToolOutputBytes('novel_status_read', 5)
    await driver.handleSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await vi.waitFor(async () => {
      const snapshot = await novels.getNovel(novelId)
      if (snapshot?.run.turnsRun !== 1) throw new Error('turn not accounted')
    })
    expect((await novels.getNovel(novelId))!.run.usageSamples!).toHaveLength(0)
    await driver.dispose()
  })
})
