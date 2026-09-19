import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BRIEF_PARTICIPANT_LIMIT,
  BRIEF_PARTICIPANTS_MAX,
  BRIEF_STORY_LIMIT,
  narrativeStage,
  nextWork,
  renderWorkBrief,
  unitTargetRange,
} from '../src/agent-novel/outline.js'
import { isNovelAuthorMessage, receiveAuthorMessage, stableMessageKey } from '../src/agent-novel/requirements.js'
import { AGENT_NOVEL_PRESET_ID, inspectAgentNovelCapabilities, type AgentNovelCapabilityContext } from '../src/agent-novel/capabilities.js'
import {
  NovelCapabilityError,
  NovelNotFoundError,
  NovelStore,
  TavernStore,
  type BodyCommit,
  type NovelCreateConfig,
  type NovelOutline,
  type NovelSnapshot,
  type OutlineChapter,
  type RequirementRecord,
  type ScenePlan,
  type WritingUnit,
} from '../../tavern-store/src/index.js'

/* ------------------------------- fixtures ------------------------------- */

function configFixture(overrides?: Partial<NovelCreateConfig>): NovelCreateConfig {
  return {
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
      externalRetry: { maxAttempts: 2, backoffMs: 500 },
      maxDeduceRuns: 5,
    },
    ...overrides,
  }
}

function chaptersFixture(count = 1): OutlineChapter[] {
  return Array.from({ length: count }, (_, index) => ({
    chapterId: `ch-${index + 1}`,
    order: index + 1,
    title: `第${index + 1}章`,
    purpose: '推进主线',
    keyEvents: ['事件'],
    plannedCharacters: null,
    entryCondition: '前章结束',
    exitCondition: '本章目标达成',
  }))
}

function scenesFixture(orders: number[] = [1, 2]): ScenePlan[] {
  return orders.map((order, index) => ({
    sceneId: `sc-${index + 1}`,
    order,
    goal: `场景目标 ${order}`,
    participants: ['keeper'],
    timeLocation: '塔顶 / 深夜',
    causality: '承接前文',
    conflict: '风暴',
    expectedChange: '决心',
    ...(order === 2 ? { continuationAnchor: '锚点：风暴前夕' } : {}),
  }))
}

function outlineFixture(options: { scenes?: ScenePlan[]; currentChapterId?: string | null; chapters?: OutlineChapter[] } = {}): NovelOutline {
  return {
    outlineRevision: 'or-1',
    parentRevision: null,
    reason: 'initial outline',
    sourceRequirementIds: ['req-1'],
    story: { premise: 'p', theme: 't', mainConflict: 'c', endingDirection: 'e', taboos: [] },
    characters: [],
    chapters: options.chapters ?? chaptersFixture(),
    currentChapterId: options.currentChapterId === undefined ? 'ch-1' : options.currentChapterId,
    scenes: options.scenes ?? scenesFixture(),
    foreshadowing: [],
  }
}

function requirementFixture(sequence: number, status: RequirementRecord['status'] = 'pending'): RequirementRecord {
  return {
    requirementId: `req-${sequence}`,
    hostMessageId: `m-${sequence}`,
    sequence,
    text: sequence === 2 ? '把结局改得更苦一些。'.padEnd(220, '细') : '增加暴风雪',
    receivedAt: '2026-09-16T00:00:00.000Z',
    receivedUnitId: null,
    status,
    appliedRevision: null,
    effectiveLocation: null,
    blockedReason: null,
    supersededBy: null,
  }
}

function unitFixture(unitId: string, sceneId: string, anchor: string | null = null, state: WritingUnit['state'] = 'committed'): WritingUnit {
  return {
    unitId,
    chapterId: 'ch-1',
    sceneId,
    label: unitId,
    state,
    attempt: 1,
    claimedRevision: 'or-1',
    claimedRequirementSequence: 1,
    hostTurn: null,
    goal: `goal of ${sceneId}`,
    continuationAnchor: anchor,
    lastError: null,
    executionTokenHash: null,
  }
}

function commitFixture(index: number, unitId: string, sceneCompleted: boolean, effective = 10): BodyCommit {
  return {
    commitId: `commit-${index}`,
    unitId,
    chapterId: 'ch-1',
    attempt: 1,
    bodyHash: `hash-${index}`,
    paragraphCount: 1,
    effectiveCharacters: effective,
    sceneCompleted,
    completionBasis: 'basis',
    outstandingGoals: [],
    canonChanges: [],
    outlineRevision: 'or-1',
    requirementSequence: 1,
    committedAt: '2026-09-16T00:00:00.000Z',
  }
}

interface SnapshotOptions {
  status?: NovelSnapshot['run']['status']
  config?: NovelCreateConfig
  outline?: NovelOutline | null
  requirements?: RequirementRecord[]
  units?: WritingUnit[]
  commits?: BodyCommit[]
  completedChapters?: string[]
}

function snapshotFixture(options: SnapshotOptions = {}): NovelSnapshot {
  return {
    novelId: 'nvl-test',
    revision: 'r1',
    schemaVersion: 1,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    config: options.config ?? configFixture(),
    assets: [],
    outline: options.outline === undefined ? outlineFixture() : options.outline,
    requirements: options.requirements ?? [],
    units: options.units ?? [],
    commits: options.commits ?? [],
    completedChapters: (options.completedChapters ?? []).map((chapterId) => ({
      chapterId,
      basis: 'done',
      openItems: [],
      completedAt: '2026-09-16T00:00:00.000Z',
    })),
    premiseNote: null,
    run: {
      status: options.status ?? 'active',
      phase: 'writing',
      pauseReason: null,
      pauseDetail: null,
      resumeHint: null,
      currentUnitId: null,
      turnsRun: 3,
      deduceRuns: 0,
      startedAt: '2026-09-16T00:00:00.000Z',
      completedAt: null,
      lastProgressSignature: null,
      stalledTurns: 0,
      consecutiveFailures: 0,
      lastError: null,
      inFlightIntent: null,
      awaitingApprovalRevision: null,
    },
    contentRevision: 'c1',
    countPolicyVersion: 1,
  }
}

/* ------------------------------- nextWork ------------------------------- */

describe('nextWork decision order (§6.3)', () => {
  it('returns null for completed runs', () => {
    expect(nextWork(snapshotFixture({ status: 'completed' }))).toBeNull()
  })

  it('plans the initial outline before anything else', () => {
    const work = nextWork(snapshotFixture({ outline: null, requirements: [requirementFixture(1)] }))
    expect(work).toMatchObject({ kind: 'outline-create', chapterId: null, sceneId: null })
    expect(work!.reason).toContain('no outline')
  })

  it('revises before writing when directives are unprocessed', () => {
    const pending = nextWork(snapshotFixture({ requirements: [requirementFixture(1, 'applied'), requirementFixture(2, 'pending')] }))
    expect(pending).toMatchObject({ kind: 'outline-revise' })
    expect(pending!.reason).toContain('requirements')
    expect(pending!.reason).toContain('req-2(pending)')
    const blocked = nextWork(snapshotFixture({ requirements: [requirementFixture(2, 'blocked')] }))
    expect(blocked).toMatchObject({ kind: 'outline-revise' })
    expect(blocked!.reason).toContain('req-2(blocked)')
  })

  it('revises when the current chapter has no executable scenes', () => {
    const none = nextWork(snapshotFixture({ outline: outlineFixture({ scenes: [] }) }))
    expect(none).toMatchObject({ kind: 'outline-revise', chapterId: 'ch-1' })
    expect(none!.reason).toContain('refine')
    const noCurrent = nextWork(snapshotFixture({ outline: outlineFixture({ currentChapterId: null }) }))
    expect(noCurrent).toMatchObject({ kind: 'outline-revise' })
    expect(noCurrent!.reason).toContain('no current chapter')
  })

  it('writes the first unfinished scene, including never-written ones', () => {
    const work = nextWork(snapshotFixture())
    expect(work).toMatchObject({ kind: 'write-unit', chapterId: 'ch-1', sceneId: 'sc-1' })
  })

  it('keeps a scene unfinished while its latest commit is a continuation fragment', () => {
    const snapshot = snapshotFixture({
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-1')],
      commits: [commitFixture(1, 'unit-1', false), commitFixture(2, 'unit-2', false)],
    })
    expect(nextWork(snapshot)).toMatchObject({ kind: 'write-unit', sceneId: 'sc-1' })
    // The latest commit decides: sc-1 finished, so the next unfinished scene by
    // order wins even though the array order differs from the scene order.
    const finished = snapshotFixture({
      outline: outlineFixture({ scenes: [scenesFixture([2, 1])[1]!, scenesFixture([2, 1])[0]!] }),
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-1')],
      commits: [commitFixture(1, 'unit-1', false), commitFixture(2, 'unit-2', true)],
    })
    expect(nextWork(finished)).toMatchObject({ kind: 'write-unit', sceneId: 'sc-2' })
    const secondDone = snapshotFixture({
      outline: outlineFixture({ scenes: [scenesFixture([2, 1])[1]!, scenesFixture([2, 1])[0]!] }),
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-1'), unitFixture('unit-3', 'sc-2')],
      commits: [commitFixture(1, 'unit-1', false), commitFixture(2, 'unit-2', true), commitFixture(3, 'unit-3', true)],
    })
    expect(nextWork(secondDone)).toMatchObject({ kind: 'chapter-complete', chapterId: 'ch-1' })
  })

  it('completes the chapter after all its scenes finish', () => {
    const snapshot = snapshotFixture({
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-2')],
      commits: [commitFixture(1, 'unit-1', true), commitFixture(2, 'unit-2', true)],
    })
    const work = nextWork(snapshot)
    expect(work).toMatchObject({ kind: 'chapter-complete', chapterId: 'ch-1', sceneId: null })
    expect(work!.reason).toContain('completion check')
  })

  it('refines towards the next chapter after the current one completes', () => {
    const snapshot = snapshotFixture({
      outline: outlineFixture({ chapters: chaptersFixture(2) }),
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-2')],
      commits: [commitFixture(1, 'unit-1', true), commitFixture(2, 'unit-2', true)],
      completedChapters: ['ch-1'],
    })
    expect(nextWork(snapshot)).toMatchObject({ kind: 'outline-revise' })
    expect(nextWork(snapshot)!.reason).toContain('next chapter')
  })

  it('finishes only after every chapter is completed', () => {
    const snapshot = snapshotFixture({
      units: [unitFixture('unit-1', 'sc-1'), unitFixture('unit-2', 'sc-2')],
      commits: [commitFixture(1, 'unit-1', true), commitFixture(2, 'unit-2', true)],
      completedChapters: ['ch-1'],
    })
    const work = nextWork(snapshot)
    expect(work).toMatchObject({ kind: 'finish', chapterId: null, sceneId: null })
    expect(work!.reason).toContain('§7.3')
  })
})

/* --------------------------- ranges and stages --------------------------- */

describe('unitTargetRange boundaries (§7.2)', () => {
  it('treats unbounded budgets as no length pressure', () => {
    expect(unitTargetRange(configFixture(), 12345)).toEqual({ min: 0, max: Number.MAX_SAFE_INTEGER })
  })

  it('slices the tolerance band above the committed total', () => {
    const config = configFixture({ lengthBudget: { kind: 'target', targetCharacters: 1000, toleranceRatio: 0.1, hardMaximumCharacters: null } })
    expect(unitTargetRange(config, 0)).toEqual({ min: 900, max: 1100 })
    expect(unitTargetRange(config, 950)).toEqual({ min: 0, max: 150 })
    expect(unitTargetRange(config, 1100)).toEqual({ min: 0, max: 0 })
    const hardMax = configFixture({ lengthBudget: { kind: 'target', targetCharacters: 1000, toleranceRatio: 0.1, hardMaximumCharacters: 1050 } })
    expect(unitTargetRange(hardMax, 0)).toEqual({ min: 900, max: 1050 })
  })
})

describe('narrativeStage (§7.2)', () => {
  const config = configFixture({ lengthBudget: { kind: 'target', targetCharacters: 900, toleranceRatio: 0.1, hardMaximumCharacters: null } })

  it('maps the committed/target ratio onto stages', () => {
    expect(narrativeStage(config, 100)).toBe('early')
    expect(narrativeStage(config, 350)).toBe('middle')
    expect(narrativeStage(config, 650)).toBe('late')
    expect(narrativeStage(config, 810)).toBe('ending')
    expect(narrativeStage(config, 950)).toBe('ending')
  })

  it('never converges without a target', () => {
    expect(narrativeStage(configFixture(), 0)).toBe('early')
    expect(narrativeStage(configFixture(), 500)).toBe('middle')
  })
})

describe('renderWorkBrief (§8.3)', () => {
  it('carries anchors, budgets, stage and the lore hint for a write-unit', () => {
    const config = configFixture({ lengthBudget: { kind: 'target', targetCharacters: 5000, toleranceRatio: 0.2, hardMaximumCharacters: null } })
    const snapshot = snapshotFixture({
      config,
      requirements: [requirementFixture(1, 'applied')],
      units: [unitFixture('unit-1', 'sc-1', '锚点：风暴前夕')],
      commits: [commitFixture(1, 'unit-1', false, 1000)],
    })
    const work = nextWork(snapshot)
    expect(work).toMatchObject({ kind: 'write-unit', sceneId: 'sc-1' })
    const brief = renderWorkBrief(snapshot, work!)
    expect(brief).toContain('continuation anchor: 锚点：风暴前夕')
    expect(brief).toContain('unit target range: 3000-5000 effective characters')
    expect(brief).toContain('committed 1000 of target 5000')
    expect(brief).toContain('narrative stage: early')
    expect(brief).toContain('novel_lore_search')
    expect(brief).toContain('3/100 turns')
    expect(brief).toContain('Pending author directives: none.')
  })

  it('summarizes pending directives verbatim while revising', () => {
    const snapshot = snapshotFixture({ requirements: [requirementFixture(1, 'applied'), requirementFixture(2, 'pending')] })
    const work = nextWork(snapshot)
    expect(work).toMatchObject({ kind: 'outline-revise' })
    const brief = renderWorkBrief(snapshot, work!)
    expect(brief).toContain('[req-2]')
    expect(brief).toContain('把结局改得更苦一些')
    expect(brief).toContain('3/100 turns')
    expect(brief).not.toContain('增加暴风雪')
  })

  it('warns about convergence near the target', () => {
    const config = configFixture({ lengthBudget: { kind: 'target', targetCharacters: 1000, toleranceRatio: 0.1, hardMaximumCharacters: null } })
    const snapshot = snapshotFixture({ config, commits: [commitFixture(1, 'unit-1', false, 950)] })
    const brief = renderWorkBrief(snapshot, nextWork(snapshot)!)
    expect(brief).toContain('narrative stage: ending')
    expect(brief).toContain('reduce new subplots')
  })
})

describe('renderWorkBrief outline digest (0007 §11)', () => {
  function digestSnapshot(outline: NovelOutline): NovelSnapshot {
    return snapshotFixture({ outline })
  }

  function digestFixture(options: {
    premise?: string
    mainConflict?: string
    entryCondition?: string
    exitCondition?: string
    participants?: string[]
    characters?: Array<{ characterId: string; name: string; initialState: string; motivation: string }>
  } = {}): NovelSnapshot {
    const outline = {
      ...outlineFixture(),
      story: {
        premise: options.premise ?? '看守人发现海面异象',
        theme: '孤独与守望',
        mainConflict: options.mainConflict ?? '人与海',
        endingDirection: '黎明到来',
        taboos: [],
      },
      chapters: [{
        chapterId: 'ch-1',
        order: 1,
        title: '第一章',
        purpose: '推进主线',
        keyEvents: [],
        plannedCharacters: null,
        entryCondition: options.entryCondition ?? '前章结束',
        exitCondition: options.exitCondition ?? '本章目标达成',
      }],
      characters: options.characters ?? [{
        characterId: 'keeper', name: '守塔人', initialState: '平静值守', motivation: '守到最后一次日出', relations: [], arc: '从逃避到直面',
      }],
      scenes: [{
        sceneId: 'sc-1', order: 1, goal: '发现海面异象并做出决定',
        participants: options.participants ?? ['keeper'],
        timeLocation: '塔顶 / 深夜', causality: '承接开篇', conflict: '风暴逼近', expectedChange: '下定决心',
      }],
    } satisfies NovelOutline
    return digestSnapshot(outline)
  }

  it('adds the bounded outline digest before the scene plan for a write-unit', () => {
    const snapshot = digestFixture()
    const work = nextWork(snapshot)
    expect(work).toMatchObject({ kind: 'write-unit' })
    const brief = renderWorkBrief(snapshot, work!)
    expect(brief).toContain('Outline digest (§6.1):')
    expect(brief).toContain('story: 看守人发现海面异象 — 人与海')
    expect(brief).toContain('chapter entry: 前章结束')
    expect(brief).toContain('chapter exit: 本章目标达成')
    expect(brief).toContain('participant: 守塔人 (keeper): 平静值守 · 守到最后一次日出')
    // The digest precedes the scene plan (global context before local detail).
    expect(brief.indexOf('Outline digest')).toBeLessThan(brief.indexOf('Scene plan'))
    // Revision work shares the brief renderer but carries no digest.
    const revising = snapshotFixture({ requirements: [requirementFixture(1)] })
    expect(renderWorkBrief(revising, nextWork(revising)!)).not.toContain('Outline digest')
  })

  it('clips the story line and participant summaries to their bounds', () => {
    const snapshot = digestFixture({
      premise: '甲'.repeat(BRIEF_STORY_LIMIT + 50),
      mainConflict: '',
      characters: [{
        characterId: 'keeper', name: '守塔人',
        initialState: '乙'.repeat(BRIEF_PARTICIPANT_LIMIT + 20),
        motivation: '',
      }],
    })
    const brief = renderWorkBrief(snapshot, nextWork(snapshot)!)
    expect(brief).toContain(`story: ${'甲'.repeat(BRIEF_STORY_LIMIT)}…`)
    expect(brief).not.toContain(`story: ${'甲'.repeat(BRIEF_STORY_LIMIT + 1)}`)
    expect(brief).toContain(`守塔人 (keeper): ${'乙'.repeat(BRIEF_PARTICIPANT_LIMIT)}…`)
    expect(brief).not.toContain(`守塔人 (keeper): ${'乙'.repeat(BRIEF_PARTICIPANT_LIMIT + 1)}`)
  })

  it('caps participants at the configured maximum', () => {
    const snapshot = digestFixture({
      participants: Array.from({ length: BRIEF_PARTICIPANTS_MAX + 2 }, (_, index) => `p-${index}`),
      characters: [],
    })
    const brief = renderWorkBrief(snapshot, nextWork(snapshot)!)
    expect(brief.match(/- participant: /g)).toHaveLength(BRIEF_PARTICIPANTS_MAX)
    expect(brief).toContain('participant: p-0')
    expect(brief).not.toContain('participant: p-6')
  })

  it('omits empty digest fields and the whole block when nothing is present', () => {
    const partial = digestFixture({ premise: '', mainConflict: '', entryCondition: '' })
    const brief = renderWorkBrief(partial, nextWork(partial)!)
    expect(brief).toContain('Outline digest (§6.1):')
    expect(brief).not.toContain('- story:')
    expect(brief).not.toContain('- chapter entry:')
    expect(brief).toContain('- chapter exit:')

    const empty = digestSnapshot({
      ...outlineFixture(),
      story: { premise: '', theme: '', mainConflict: '', endingDirection: '', taboos: [] },
      chapters: [{
        chapterId: 'ch-1', order: 1, title: '第一章', purpose: '推进主线', keyEvents: [],
        plannedCharacters: null, entryCondition: '', exitCondition: '',
      }],
      characters: [],
      scenes: [{
        sceneId: 'sc-1', order: 1, goal: '发现异象', participants: [],
        timeLocation: '塔顶', causality: '承接', conflict: '风暴', expectedChange: '决心',
      }],
    })
    expect(renderWorkBrief(empty, nextWork(empty)!)).not.toContain('Outline digest')
  })

  it('keeps the digest increment bounded (compact brief budget)', () => {
    const snapshot = digestFixture({
      premise: '甲'.repeat(400),
      mainConflict: '乙'.repeat(400),
      participants: Array.from({ length: BRIEF_PARTICIPANTS_MAX }, (_, index) => `p-${index}`),
      characters: Array.from({ length: BRIEF_PARTICIPANTS_MAX }, (_, index) => ({
        characterId: `p-${index}`, name: `角色${index}`,
        initialState: '丙'.repeat(300), motivation: '丁'.repeat(300),
      })),
    })
    const withDigest = renderWorkBrief(snapshot, nextWork(snapshot)!)
    const withoutDigest = withDigest.replace(/^Outline digest \(§6\.1\):\n(?:- .*\n)*- .*(?=\n\nScene plan)/m, '')
    expect(withDigest.length - withoutDigest.length).toBeLessThanOrEqual(1400)
  })
})

/* ------------------------------ requirements ------------------------------ */

describe('requirements receive adapter (§9.1)', () => {
  it('derives stable host message ids', () => {
    expect(stableMessageKey('sess-1', 'm-1')).toMatch(/^[0-9a-f]{64}$/)
    expect(stableMessageKey('sess-1', 'm-1')).toBe(stableMessageKey('sess-1', 'm-1'))
    expect(stableMessageKey('sess-1', 'm-1')).not.toBe(stableMessageKey('sess-2', 'm-1'))
    expect(stableMessageKey('sess-1', 'm-1')).not.toBe(stableMessageKey('sess-1', 'm-2'))
  })

  it('discriminates real user author messages like the projector', () => {
    const message = {
      type: 'user/message',
      data: { id: 'm-1', role: 'user', content: [{ type: 'text', text: '让主角早点登场' }], source: { kind: 'user' } },
    }
    expect(isNovelAuthorMessage(message)).toBe(true)
    expect(isNovelAuthorMessage({ type: 'user/message', data: { ...message.data, source: { kind: 'plugin', plugin: 'dsh-tavern' } } })).toBe(false)
    expect(isNovelAuthorMessage({ type: 'assistant/message', data: message.data })).toBe(false)
    expect(isNovelAuthorMessage({ type: 'user/message', data: { ...message.data, content: [] } })).toBe(false)
    expect(isNovelAuthorMessage({ type: 'user/message' })).toBe(false)
    expect(isNovelAuthorMessage({})).toBe(false)
  })
})

describe('receiveAuthorMessage against a real store', () => {
  let home: string
  let tavern: TavernStore
  let novels: NovelStore
  let novelId: string

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-novel-outline-'))
    tavern = await TavernStore.open(home)
    novels = await NovelStore.open(home)
    const created = await novels.createNovel(tavern, configFixture())
    novelId = created.novelId
  })

  afterAll(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(home, { recursive: true, force: true })
        break
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw cause
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  })

  const userEvent = (id: string, text: string) => ({
    type: 'user/message',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  })

  it('persists, dedupes and rejects unparseable events without throwing', async () => {
    const first = await receiveAuthorMessage(novels, novelId, 'sess-1', userEvent('m-1', '增加暴风雪'))
    expect(first).toEqual({ accepted: true, duplicate: false })
    const replay = await receiveAuthorMessage(novels, novelId, 'sess-1', userEvent('m-1', '增加暴风雪'))
    expect(replay).toEqual({ accepted: true, duplicate: true })
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.requirements).toHaveLength(2)
    expect(snapshot?.requirements[1]).toMatchObject({ status: 'pending', text: '增加暴风雪', hostMessageId: stableMessageKey('sess-1', 'm-1') })

    const notUser = await receiveAuthorMessage(novels, novelId, 'sess-1', { type: 'user/message', data: { id: 'm-2', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin' } } })
    expect(notUser.accepted).toBe(false)
    expect(notUser.duplicate).toBe(false)
    expect(notUser.reason).toBeDefined()
    const garbage = await receiveAuthorMessage(novels, novelId, 'sess-1', { type: 'turn/start', data: { turn: 3 } })
    expect(garbage.accepted).toBe(false)
    expect((await novels.getNovel(novelId))?.requirements).toHaveLength(2)

    const missing = await receiveAuthorMessage(novels, 'nvl-missing', 'sess-1', userEvent('m-3', 'x'))
    expect(missing.accepted).toBe(false)
    expect(missing.reason).toContain('NovelNotFoundError')
  })

  it('captures NovelCapabilityError as accepted:false with its reason, without throwing', async () => {
    const fake = {
      receiveRequirement: async () => { throw new NovelCapabilityError({ reason: 'novel completed: new requirements are rejected (§9.2)' }) },
    } as unknown as NovelStore
    const result = await receiveAuthorMessage(fake, 'nvl-x', 'sess-1', userEvent('m-9', 'x'))
    expect(result).toEqual({ accepted: false, duplicate: false, reason: 'novel completed: new requirements are rejected (§9.2)' })
  })
})

/* ------------------------------ capabilities ------------------------------ */

const FULL_CONTEXT: AgentNovelCapabilityContext = {
  agents: { withoutInitiator: () => Promise.resolve(undefined) },
  agentPresets: { mount: () => Promise.resolve(undefined), recompose: () => Promise.resolve(undefined) },
  systemPrompt: { section: () => undefined, context: () => undefined },
  tools: { register: () => undefined },
  on: () => undefined,
}

describe('inspectAgentNovelCapabilities (§16)', () => {
  it('is available on a full host context', () => {
    const report = inspectAgentNovelCapabilities(FULL_CONTEXT)
    expect(report).toMatchObject({ available: true, missing: [], reasons: [] })
    expect(AGENT_NOVEL_PRESET_ID).toBe('agent-novel')
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('fails closed per missing core item with concrete reasons', () => {
    const report = inspectAgentNovelCapabilities({ ...FULL_CONTEXT, agents: { get: () => undefined } })
    expect(report.available).toBe(false)
    expect(report.missing).toEqual(['agents.withoutInitiator'])
    expect(report.reasons[0]).toContain('withoutInitiator')

    const noOn = inspectAgentNovelCapabilities({ ...FULL_CONTEXT, on: undefined })
    expect(noOn.available).toBe(false)
    expect(noOn.missing).toEqual(['on:session/event', 'on:agent/created', 'on:agent/status'])
    for (const reason of noOn.reasons) expect(reason).toContain('cannot be probed statically')
  })

  it('defends against empty or malformed contexts', () => {
    const empty = inspectAgentNovelCapabilities({})
    expect(empty.available).toBe(false)
    expect(empty.missing).toEqual([
      'agents',
      'agents.withoutInitiator',
      'agentPresets.mount',
      'agentPresets.recompose',
      'systemPrompt.section',
      'tools.register',
      'on:session/event',
      'on:agent/created',
      'on:agent/status',
    ])
    expect(empty.missing).toHaveLength(empty.reasons.length)
    const nullish = inspectAgentNovelCapabilities(null)
    expect(nullish.available).toBe(false)
    expect(nullish.missing).toHaveLength(9)
  })
})
