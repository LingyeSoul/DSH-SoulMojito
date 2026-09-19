import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-novel/agent.js'
import { inspectWriterSubagentCapabilities } from '../src/agent-novel/capabilities.js'
import { drainToolOutputBytes, drainWriterRunUsage, noteToolOutputBytes, recordWriterRunUsage } from '../src/agent-novel/usage.js'
import {
  MAX_WRITER_DISPATCHES_PER_UNIT,
  NovelWriterPackError,
  NovelWriterRunError,
  WRITER_ALLOW_LIST,
  WRITER_BODY_TAIL_LIMIT,
  WRITER_CANON_MAX,
  WRITER_CHARACTER_PAGES_MAX,
  WRITER_FORESHADOWING_MAX,
  WRITER_LORE_ENTRIES_MAX,
  WRITER_PROTOCOL_DELEGATED,
  WRITER_PROTOCOL_FULL,
  WRITER_STORY_FIELD_LIMIT,
  WRITER_TRUNCATION_MARKER,
  assembleWriterPackInput,
  draftUnitViaSubagent,
  findWriterDelegation,
  findWriterDelegationByUnit,
  parseWriterCandidate,
  registerWriterDelegation,
  removeWriterDelegation,
  renderWriterPackFull,
  renderWriterPackTrimmed,
  runDelegatedWriter,
  type ContentBlockLike,
  type ProjectCharacterPage,
  type SubagentRuntimeLike,
  type WriterDelegation,
  type WriterNovelStoreLike,
  type WriterPackInput,
} from '../src/agent-novel/writer.js'
import {
  NovelStore,
  TavernStore,
  type BodyCommit,
  type CanonChange,
  type NovelAssetRef,
  type NovelCreateConfig,
  type NovelOutline,
  type NovelOutlinePayload,
  type NovelSnapshot,
  type WritingUnit,
} from '../../tavern-store/src/index.js'

/* ------------------------------- fixtures ------------------------------- */

const CHARACTER_HASH = 'a'.repeat(64)
const WORLD_HASH = 'b'.repeat(64)

function characterPageFixture(overrides?: Partial<ProjectCharacterPage>): ProjectCharacterPage {
  return {
    characterId: 'keeper',
    name: '看守人',
    nickname: '看守人',
    description: '守塔三十年',
    personality: '沉默',
    scenario: '灯塔',
    source: { kind: 'novel-character-snapshot', id: CHARACTER_HASH },
    truncated: false,
    ...overrides,
  }
}

function packInputFixture(overrides?: Partial<WriterPackInput>): WriterPackInput {
  return {
    novelId: 'novel-1',
    unitId: 'unit-1',
    outlineRevision: 'or-1',
    chapterHasCommits: true,
    story: { premise: '灯塔与风暴', theme: '孤独', mainConflict: '人与海', endingDirection: '灯长明', taboos: ['禁用第一人称'], styleNotes: '冷峻克制' },
    chapter: { chapterId: 'ch-1', order: 1, title: '风暴之夜', purpose: '点亮灯塔', entryCondition: '平静', exitCondition: '风暴过去' },
    scene: { sceneId: 'sc-1', order: 1, goal: '守住塔顶', participants: ['keeper'], timeLocation: '塔顶', causality: '承接前文', conflict: '人与海', expectedChange: '决心', continuationAnchor: null },
    characters: [characterPageFixture()],
    lore: [{ book: '《风暴志》', keys: ['风暴'], content: '风暴来袭的征兆。', truncated: false }],
    bodyTail: '风暴在午夜抵达。',
    foreshadowing: [{ id: 'f-1', description: '旧日志', plantAt: 'ch-1', payoffAt: null, required: true, status: 'planted' }],
    canon: [{ commitId: 'commit-1', kind: 'character-state', summary: 'keeper 决定留下' }],
    unitParams: { targetRange: { min: 0, max: 9007199254740991 }, narrativeStage: 'early', remainingCharacters: null },
    ...overrides,
  }
}

const CONFIG: NovelCreateConfig = {
  title: '灯塔',
  requirement: '写一个灯塔看守人的短篇',
  language: 'zh',
  genre: 'literary',
  narrativePerspective: 'third-person',
  styleNotes: '冷峻克制',
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
}

const OUTLINE: NovelOutline = {
  outlineRevision: 'or-1',
  parentRevision: null,
  reason: 'initial outline',
  sourceRequirementIds: ['req-1'],
  story: { premise: '灯塔与风暴', theme: '孤独', mainConflict: '人与海', endingDirection: '灯长明', taboos: ['禁用第一人称'] },
  characters: [{
    characterId: 'keeper',
    name: '看守人',
    assetRef: CHARACTER_HASH,
    initialState: '独居',
    motivation: '守灯',
    relations: [],
    arc: '从麻木到释怀',
  }],
  chapters: [
    {
      chapterId: 'ch-1',
      order: 1,
      title: '风暴之夜',
      purpose: '点亮灯塔',
      keyEvents: [],
      plannedCharacters: null,
      entryCondition: '平静',
      exitCondition: '风暴过去',
    },
    {
      chapterId: 'ch-9',
      order: 9,
      title: '远期',
      purpose: '远期章节',
      keyEvents: [],
      plannedCharacters: null,
      entryCondition: '—',
      exitCondition: '—',
    },
  ],
  currentChapterId: 'ch-1',
  scenes: [{
    sceneId: 'sc-1',
    order: 1,
    goal: '风暴逼近灯塔',
    participants: ['keeper'],
    timeLocation: '塔顶',
    causality: '承接前文',
    conflict: '人与海',
    expectedChange: '决心',
    continuationAnchor: '锚点A',
  }],
  foreshadowing: [
    { id: 'f-1', description: '旧日志', plantAt: 'ch-1', payoffAt: null, required: true, status: 'planted' },
    { id: 'f-2', description: '已回收', plantAt: 'ch-1', payoffAt: null, required: false, status: 'resolved' },
    { id: 'f-3', description: '远期伏笔', plantAt: 'ch-9', payoffAt: null, required: false, status: 'open' },
  ],
}

const ASSETS: readonly NovelAssetRef[] = [
  { kind: 'character', sourceId: 'char-keeper', displayName: '看守人', contentHash: CHARACTER_HASH, specVersion: null },
  { kind: 'world', sourceId: 'world-storm', displayName: '《风暴志》', contentHash: WORLD_HASH, specVersion: null },
]

const ASSET_OBJECTS: Record<string, unknown> = {
  [CHARACTER_HASH]: { data: { name: '看守人', description: '守塔三十年', personality: '沉默', scenario: '灯塔' } },
  [WORLD_HASH]: { entries: [
    { uid: 1, key: ['风暴'], content: '风暴来袭的征兆。', disable: false },
    { uid: 2, key: ['无关'], content: '无关条目', disable: true },
  ] },
}

const BODY_PARAGRAPHS = [
  { commitId: 'commit-1', paragraphIndex: 0, chapterId: 'ch-1', text: '风暴在午夜抵达。' },
  { commitId: 'commit-1', paragraphIndex: 1, chapterId: 'ch-1', text: '他握紧了栏杆。' },
]

function unitFixture(state: WritingUnit['state'] = 'claimed'): WritingUnit {
  return {
    unitId: 'unit-1',
    chapterId: 'ch-1',
    sceneId: 'sc-1',
    label: 'unit-1',
    state,
    attempt: 1,
    claimedRevision: 'or-1',
    claimedRequirementSequence: 1,
    hostTurn: null,
    goal: '风暴逼近时守住塔顶',
    continuationAnchor: null,
    lastError: null,
    executionTokenHash: null,
  }
}

function commitFixture(canonChanges: readonly CanonChange[] = []): BodyCommit {
  return {
    commitId: 'commit-1',
    unitId: 'unit-1',
    chapterId: 'ch-1',
    attempt: 1,
    bodyHash: 'c'.repeat(64),
    paragraphCount: 2,
    effectiveCharacters: 120,
    sceneCompleted: true,
    completionBasis: '灯重新亮起',
    outstandingGoals: [],
    canonChanges,
    outlineRevision: 'or-1',
    requirementSequence: 1,
    committedAt: '2026-09-18T00:00:00.000Z',
  }
}

function snapshotFixture(options: {
  outline?: NovelOutline | null
  units?: readonly WritingUnit[]
  commits?: readonly BodyCommit[]
} = {}): NovelSnapshot {
  return {
    novelId: 'novel-1',
    revision: 'rev-1',
    schemaVersion: 1,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    config: CONFIG,
    assets: ASSETS,
    outline: options.outline === undefined ? OUTLINE : options.outline,
    requirements: [],
    units: options.units ?? [unitFixture()],
    commits: options.commits ?? [],
    completedChapters: [],
    premiseNote: null,
    run: {
      status: 'active',
      phase: 'writing',
      pauseReason: null,
      pauseDetail: null,
      resumeHint: null,
      currentUnitId: 'unit-1',
      turnsRun: 1,
      deduceRuns: 0,
      writerRuns: 0,
      startedAt: '2026-09-18T00:00:00.000Z',
      completedAt: null,
      lastProgressSignature: null,
      stalledTurns: 0,
      consecutiveFailures: 0,
      lastError: null,
      inFlightIntent: null,
      awaitingApprovalRevision: null,
      usageSamples: [],
    },
    contentRevision: 'cr-1',
    countPolicyVersion: 1,
  }
}

function fakeStore(snapshot: NovelSnapshot, options: {
  assets?: Record<string, unknown>
  paragraphs?: typeof BODY_PARAGRAPHS
} = {}): WriterNovelStoreLike {
  const assets = options.assets ?? ASSET_OBJECTS
  const paragraphs = options.paragraphs ?? BODY_PARAGRAPHS
  return {
    readAsset: async (_novelId, contentHash) => assets[contentHash],
    readBody: async () => ({ paragraphs, nextCursor: null }),
    getNovel: async () => snapshot,
  }
}

function delegationFixture(overrides?: Partial<WriterDelegation>): WriterDelegation {
  return {
    novelId: 'novel-1',
    unitId: 'unit-1',
    executionToken: 'tok-1',
    intentId: 'intent-1',
    grantedAt: '2026-09-18T00:00:00.000Z',
    dispatchCount: 1,
    ...overrides,
  }
}

interface WriterStartCall {
  provider: string
  label?: string
  promptText: string
  toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
}

function scriptedWriterRuntime(script: {
  output?: ContentBlockLike[]
  stopReason?: string
  diagnostic?: string
  onStart?: () => void
  resultGate?: Promise<void>
} = {}) {
  const calls: WriterStartCall[] = []
  const disposed: string[] = []
  let counter = 0
  const runtime: SubagentRuntimeLike = {
    async start(provider, request) {
      counter += 1
      const id = `writer-${counter}`
      calls.push({
        provider,
        label: request.label,
        promptText: request.prompt.map((block) => block.text ?? '').join('\n'),
        toolFilter: request.toolFilter,
      })
      script.onStart?.()
      const value = {
        output: script.output ?? [{ type: 'text', text: 'ok' }],
        stopReason: script.stopReason ?? 'completed',
        ...(script.diagnostic !== undefined ? { diagnostic: script.diagnostic } : {}),
      }
      return {
        id,
        result: (script.resultGate ?? Promise.resolve()).then(() => value),
        async dispose() {
          disposed.push(id)
        },
      }
    },
  }
  return { runtime, calls, disposed }
}

function packErrorOf(render: () => string): NovelWriterPackError {
  try {
    render()
  } catch (cause) {
    if (cause instanceof NovelWriterPackError) return cause
    throw cause
  }
  throw new Error('expected renderWriterPack* to throw NovelWriterPackError')
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

const delegationTable = (): Map<string, WriterDelegation> =>
  (globalThis as Record<symbol, Map<string, WriterDelegation>>)[Symbol.for('dsh-tavern:novel-writer-delegations')]!

const CANDIDATE_JSON = JSON.stringify({
  paragraphs: ['风暴抵达了塔顶。', '他握紧栏杆。'],
  sceneCompletion: { completed: false, basis: '锚点未收', outstandingGoals: ['顶住风暴'], nextAnchor: '破晓前' },
  canonChanges: [{ kind: 'event', summary: '风暴抵达', sources: ['inline#0'] }],
})

/* ----------------------------- pack rendering ----------------------------- */

describe('agent-novel writer pack rendering', () => {
  it('emits the blocks in the fixed order with the protocol first', () => {
    const pack = renderWriterPackFull(packInputFixture())
    expect(pack.startsWith(WRITER_PROTOCOL_FULL)).toBe(true)
    const markers = ['## Story', '## Characters', '## Chapter', '## Scene', '## Lore', '## Body tail', '## Foreshadowing', '## Canon', '## Unit parameters']
    const positions = markers.map((marker) => pack.indexOf(marker))
    expect(positions.every((position) => position >= 0)).toBe(true)
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1]!)
    }
  })

  it('clips oversized story fields with a truncation marker', () => {
    const premise = '甲'.repeat(WRITER_STORY_FIELD_LIMIT + 100)
    const pack = renderWriterPackFull(packInputFixture({ story: { ...packInputFixture().story, premise } }))
    expect(pack).toContain(`premise: ${'甲'.repeat(WRITER_STORY_FIELD_LIMIT)}${WRITER_TRUNCATION_MARKER}`)
    expect(pack).not.toContain(`premise: ${'甲'.repeat(WRITER_STORY_FIELD_LIMIT + 1)}`)
  })

  it('omits empty fields and whole empty blocks', () => {
    const base = packInputFixture()
    const pack = renderWriterPackFull(packInputFixture({
      chapterHasCommits: false,
      story: { ...base.story, taboos: [], styleNotes: '' },
      scene: { ...base.scene, participants: [], continuationAnchor: null },
      characters: [],
      lore: [],
      bodyTail: '',
      foreshadowing: [],
      canon: [],
    }))
    for (const absent of ['## Characters', '## Lore', '## Body tail', '## Foreshadowing', '## Canon', '- taboos:', '- style:', '- participants:', '- continuation anchor:']) {
      expect(pack).not.toContain(absent)
    }
    for (const present of ['## Story', '## Chapter', '## Scene', '## Unit parameters']) {
      expect(pack).toContain(present)
    }
  })

  it('caps character pages at the configured maximum', () => {
    const pages = Array.from({ length: WRITER_CHARACTER_PAGES_MAX + 1 }, (_, index) =>
      characterPageFixture({ characterId: `c-${index}`, name: `角色${index}` }))
    const pack = renderWriterPackFull(packInputFixture({ scene: { ...packInputFixture().scene, participants: [] }, characters: pages }))
    expect(pack.match(/### /g)).toHaveLength(WRITER_CHARACTER_PAGES_MAX)
  })

  it('keeps only the last WRITER_BODY_TAIL_LIMIT characters of the body tail with a head marker', () => {
    const long = '风'.repeat(WRITER_BODY_TAIL_LIMIT + 400)
    const pack = renderWriterPackFull(packInputFixture({ bodyTail: long }))
    expect(pack).toContain(`${WRITER_TRUNCATION_MARKER}${'风'.repeat(WRITER_BODY_TAIL_LIMIT)}`)
    expect(pack).not.toContain('风'.repeat(WRITER_BODY_TAIL_LIMIT + 1))
  })

  it('caps lore entries, foreshadowing items and canon facts', () => {
    const pack = renderWriterPackFull(packInputFixture({
      lore: Array.from({ length: WRITER_LORE_ENTRIES_MAX + 1 }, (_, index) => ({ book: `书${index}`, keys: [], content: `条目${index}`, truncated: false })),
      foreshadowing: Array.from({ length: WRITER_FORESHADOWING_MAX + 1 }, (_, index) => ({ id: `f-${index}`, description: `伏笔${index}`, plantAt: null, payoffAt: null, required: false, status: 'open' as const })),
      canon: Array.from({ length: WRITER_CANON_MAX + 1 }, (_, index) => ({ commitId: `commit-${index}`, kind: 'character-state' as const, summary: `keeper 事实${index}` })),
    }))
    expect(pack.match(/^- \[书\d+\]/gm)).toHaveLength(WRITER_LORE_ENTRIES_MAX)
    expect(pack.match(/^- \[open\] f-\d+/gm)).toHaveLength(WRITER_FORESHADOWING_MAX)
    expect(pack.match(/^- \[commit-\d+\] character-state:/gm)).toHaveLength(WRITER_CANON_MAX)
    // canon 保留最近 12 条（丢弃最早一条）
    expect(pack).toContain('[commit-1] character-state:')
    expect(pack).not.toContain('[commit-0] character-state:')
  })

  it('marks lore content that the matching core already clipped', () => {
    const pack = renderWriterPackFull(packInputFixture({
      lore: [{ book: '《风暴志》', keys: [], content: 'x'.repeat(100), truncated: true }],
    }))
    expect(pack).toContain('x'.repeat(100) + WRITER_TRUNCATION_MARKER)
  })

  it('trims to the delegated protocol and drops character/lore/foreshadowing/canon pages', () => {
    const pack = renderWriterPackTrimmed(packInputFixture())
    expect(pack.startsWith(WRITER_PROTOCOL_DELEGATED)).toBe(true)
    for (const absent of ['## Characters', '## Lore', '## Foreshadowing', '## Canon']) {
      expect(pack).not.toContain(absent)
    }
    for (const present of ['## Story', '## Chapter', '## Scene', '## Body tail', '## Unit parameters']) {
      expect(pack).toContain(present)
    }
  })
})

/* ---------------------------- byte stability ---------------------------- */

describe('agent-novel writer pack byte stability', () => {
  it('renders byte-identical output for identical material', () => {
    expect(renderWriterPackFull(packInputFixture())).toBe(renderWriterPackFull(packInputFixture()))
    expect(renderWriterPackTrimmed(packInputFixture())).toBe(renderWriterPackTrimmed(packInputFixture()))
  })

  it('keeps the stable prefix byte-identical when only tail fields change', () => {
    const base = packInputFixture()
    const changed = packInputFixture({
      scene: { ...base.scene, goal: '另一个目标', continuationAnchor: '新锚点' },
      lore: [{ book: '《新志》', keys: ['新'], content: '新条目', truncated: false }],
      bodyTail: '全新正文尾部',
      foreshadowing: [{ id: 'f-9', description: '新伏笔', plantAt: null, payoffAt: null, required: true, status: 'open' }],
      canon: [{ commitId: 'commit-9', kind: 'relation', summary: '新事实' }],
      unitParams: { targetRange: { min: 100, max: 900 }, narrativeStage: 'ending', remainingCharacters: 42 },
    })
    const a = renderWriterPackFull(base)
    const b = renderWriterPackFull(changed)
    const boundary = a.indexOf('## Scene')
    expect(boundary).toBeGreaterThan(0)
    expect(a.slice(0, boundary)).toBe(b.slice(0, b.indexOf('## Scene')))
    expect(a).not.toBe(b)
  })

  it('does change the prefix when prefix material changes', () => {
    const base = packInputFixture()
    const changed = packInputFixture({ story: { ...base.story, premise: '另一个前提' } })
    const a = renderWriterPackFull(base)
    const b = renderWriterPackFull(changed)
    expect(a.slice(0, a.indexOf('## Scene'))).not.toBe(b.slice(0, b.indexOf('## Scene')))
  })

  it('extends the body tail append-only within a chapter under the cap', () => {
    const short = renderWriterPackFull(packInputFixture({ bodyTail: '前文。' }))
    const grown = renderWriterPackFull(packInputFixture({ bodyTail: '前文。后续追加的段落。' }))
    expect(grown.startsWith(short.slice(0, short.indexOf('## Body tail')))).toBe(true)
    expect(grown).toContain('前文。后续追加的段落。')
  })
})

/* ------------------------------- fail-loud ------------------------------- */

describe('agent-novel writer pack fail-loud validation', () => {
  it('rejects a null outline revision defensively', () => {
    const error = packErrorOf(() => renderWriterPackFull(packInputFixture({ outlineRevision: null })))
    expect(error).toBeInstanceOf(NovelWriterPackError)
    expect(error.novelId).toBe('novel-1')
    expect(error.unitId).toBe('unit-1')
    expect(error.missingBlocks).toContain('outline-revision')
  })

  it('rejects an empty body tail when the chapter already has commits', () => {
    const error = packErrorOf(() => renderWriterPackFull(packInputFixture({ chapterHasCommits: true, bodyTail: '' })))
    expect(error.missingBlocks).toEqual(['body-tail'])
    // 无提交时空尾部合法（首单元）
    expect(() => renderWriterPackFull(packInputFixture({ chapterHasCommits: false, bodyTail: '' }))).not.toThrow()
  })

  it('rejects scene participants with no character or canon coverage', () => {
    const error = packErrorOf(() => renderWriterPackFull(packInputFixture({ scene: { ...packInputFixture().scene, participants: ['keeper', 'ghost'] } })))
    expect(error.missingBlocks).toContain('character:ghost')
    expect(error.missingBlocks).not.toContain('character:keeper')
  })

  it('counts canon coverage only from canon facts that survive the cap', () => {
    // 13 条正典裁掉最早一条；ghost 的唯一覆盖在被裁的 commit-0 里 → 必须拒绝
    const canon = Array.from({ length: WRITER_CANON_MAX + 1 }, (_, index) =>
      ({ commitId: `commit-${index}`, kind: 'character-state' as const, summary: index === 0 ? 'ghost 现身' : 'keeper 事实' }))
    const error = packErrorOf(() => renderWriterPackFull(packInputFixture({
      characters: [],
      canon,
      scene: { ...packInputFixture().scene, participants: ['ghost'] },
    })))
    expect(error.missingBlocks).toEqual(['character:ghost'])
  })

  it('skips the character coverage check in trimmed mode', () => {
    expect(() => renderWriterPackTrimmed(packInputFixture({
      characters: [],
      canon: [],
      scene: { ...packInputFixture().scene, participants: ['ghost'] },
    }))).not.toThrow()
  })
})

/* --------------------------- candidate parsing --------------------------- */

describe('agent-novel writer candidate parsing', () => {
  it('parses a plain JSON reply', () => {
    const candidate = parseWriterCandidate(CANDIDATE_JSON)
    expect(candidate.paragraphs).toEqual(['风暴抵达了塔顶。', '他握紧栏杆。'])
    expect(candidate.sceneCompletion).toMatchObject({ completed: false, nextAnchor: '破晓前' })
    expect(candidate.canonChanges).toEqual([{ kind: 'event', summary: '风暴抵达', sources: ['inline#0'] }])
  })

  it('tolerates code fences and stray prose around the JSON object', () => {
    expect(parseWriterCandidate('```json\n' + CANDIDATE_JSON + '\n```').paragraphs).toHaveLength(2)
    expect(parseWriterCandidate(`好的，以下是候选稿：\n${CANDIDATE_JSON}\n以上。`).paragraphs).toHaveLength(2)
  })

  it('rejects non-JSON, non-object and malformed paragraphs shapes', () => {
    expect(() => parseWriterCandidate('这不是 JSON')).toThrow('writer candidate is not a JSON object')
    expect(() => parseWriterCandidate('[1,2,3]')).toThrow('writer candidate must be a single JSON object')
    expect(() => parseWriterCandidate('{"paragraphs": []}')).toThrow('paragraphs must be a non-empty array')
    expect(() => parseWriterCandidate('{"paragraphs": ["a"], "sceneCompletion": null}')).toThrow('sceneCompletion must be an object')
    expect(() => parseWriterCandidate('{"paragraphs": ["a"], "sceneCompletion": {}, "canonChanges": 1}')).toThrow('canonChanges must be an array')
  })
})

/* --------------------------- delegation registry --------------------------- */

describe('agent-novel writer delegation registry', () => {
  beforeEach(() => {
    for (const runId of [...delegationTable().keys()]) removeWriterDelegation(runId)
  })

  it('anchors the table on globalThis so every bundle shares one map', () => {
    const table = delegationTable()
    expect(table).toBeInstanceOf(Map)
    registerWriterDelegation('run-anchor', delegationFixture())
    // 模拟"另一 bundle"：绕过模块导出，直接从 globalThis Symbol 取同一底层 Map
    expect(table.get('run-anchor')?.unitId).toBe('unit-1')
    removeWriterDelegation('run-anchor')
    expect(table.has('run-anchor')).toBe(false)
  })

  it('returns defensive copies so callers cannot mutate stored entries', () => {
    registerWriterDelegation('run-copy', delegationFixture())
    const found = findWriterDelegation('run-copy')
    expect(found).toMatchObject({ novelId: 'novel-1', unitId: 'unit-1', executionToken: 'tok-1' })
    found!.dispatchCount = 99
    expect(findWriterDelegation('run-copy')!.dispatchCount).toBe(1)
    removeWriterDelegation('run-copy')
  })

  it('finds a delegation by novel and unit and clears it on remove', () => {
    registerWriterDelegation('run-a', delegationFixture())
    registerWriterDelegation('run-b', delegationFixture({ novelId: 'novel-2', unitId: 'unit-2' }))
    expect(findWriterDelegationByUnit('novel-1', 'unit-1')?.executionToken).toBe('tok-1')
    expect(findWriterDelegationByUnit('novel-2', 'unit-2')?.dispatchCount).toBe(1)
    expect(findWriterDelegationByUnit('novel-1', 'unit-2')).toBeUndefined()
    removeWriterDelegation('run-a')
    expect(findWriterDelegation('run-a')).toBeUndefined()
    expect(findWriterDelegationByUnit('novel-1', 'unit-1')).toBeUndefined()
    removeWriterDelegation('run-b')
  })

  it('fixes the per-unit dispatch ceiling at three', () => {
    expect(MAX_WRITER_DISPATCHES_PER_UNIT).toBe(3)
    expect(WRITER_ALLOW_LIST).toEqual([
      'novel_status_read', 'novel_outline_read', 'novel_character_read', 'novel_lore_search',
      'novel_body_read', 'novel_body_search', 'novel_facts_read', 'memory_search', 'memory_read', 'novel_body_commit',
    ])
  })
})

/* ------------------------------ assembly ------------------------------ */

describe('agent-novel writer pack assembly', () => {
  it('assembles the full pack material from a snapshot', async () => {
    const snapshot = snapshotFixture({
      commits: [commitFixture([
        { kind: 'character-state', summary: 'keeper 决定留下', sources: ['inline#0'] },
        { kind: 'event', summary: 'keeper 点亮了灯', sources: ['inline#1'] },
        { kind: 'relation', summary: '与世隔绝', sources: ['inline#2'] },
      ])],
    })
    const input = await assembleWriterPackInput({ novelStore: fakeStore(snapshot), snapshot, unit: unitFixture(), mode: 'full' })
    expect(input.outlineRevision).toBe('or-1')
    expect(input.chapterHasCommits).toBe(true)
    expect(input.characters.map((page) => page.characterId)).toEqual(['keeper'])
    expect(input.characters[0]).toMatchObject({ name: '看守人', description: '守塔三十年', personality: '沉默', scenario: '灯塔' })
    expect(input.bodyTail).toBe('风暴在午夜抵达。\n\n他握紧了栏杆。')
    expect(input.lore).toEqual([{ book: '《风暴志》', keys: ['风暴'], content: '风暴来袭的征兆。', truncated: false }])
    expect(input.canon).toEqual([{ commitId: 'commit-1', kind: 'character-state', summary: 'keeper 决定留下' }])
    expect(input.foreshadowing.map((item) => item.id)).toEqual(['f-1'])
    expect(input.scene.continuationAnchor).toBe('锚点A')
    // unbounded 预算下已有提交 → 'middle'（outline.ts narrativeStage 语义）
    expect(input.unitParams).toMatchObject({ narrativeStage: 'middle', remainingCharacters: null })
  })

  it('prefers the freshest unit continuation anchor over the scene plan', async () => {
    const snapshot = snapshotFixture()
    const unit = { ...unitFixture(), continuationAnchor: '更新的锚点' }
    const input = await assembleWriterPackInput({ novelStore: fakeStore(snapshot), snapshot, unit, mode: 'full' })
    expect(input.scene.continuationAnchor).toBe('更新的锚点')
  })

  it('trims character/lore/canon assembly in delegated mode but keeps foreshadowing and the tail', async () => {
    const snapshot = snapshotFixture({ commits: [commitFixture([{ kind: 'character-state', summary: 'keeper 决定留下', sources: ['inline'] }])] })
    const input = await assembleWriterPackInput({ novelStore: fakeStore(snapshot), snapshot, unit: unitFixture(), mode: 'trimmed' })
    expect(input.characters).toEqual([])
    expect(input.lore).toEqual([])
    expect(input.canon).toEqual([])
    expect(input.foreshadowing.map((item) => item.id)).toEqual(['f-1'])
    expect(input.bodyTail).not.toBe('')
    const pack = renderWriterPackTrimmed(input)
    expect(pack.startsWith(WRITER_PROTOCOL_DELEGATED)).toBe(true)
    expect(pack).not.toContain('## Characters')
  })

  it('rejects assembly without an outline', async () => {
    const snapshot = snapshotFixture({ outline: null })
    const error = await assembleWriterPackInput({ novelStore: fakeStore(snapshot), snapshot, unit: unitFixture(), mode: 'full' })
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(NovelWriterPackError)
    expect((error as NovelWriterPackError).missingBlocks).toEqual(['outline-revision'])
  })

  it('rejects a unit whose scene is not in the current scene plan', async () => {
    const snapshot = snapshotFixture()
    const error = await assembleWriterPackInput({ novelStore: fakeStore(snapshot), snapshot, unit: { ...unitFixture(), sceneId: 'sc-x' }, mode: 'full' })
      .then(() => undefined, (cause: unknown) => cause)
    expect((error as NovelWriterPackError).missingBlocks).toEqual(['scene'])
  })

  it('fails loudly at render time when commits exist but the body tail is empty', async () => {
    // 篡改快照场景（§12 连续性守卫）：有提交而无尾部 → NovelWriterPackError
    const snapshot = snapshotFixture({ commits: [commitFixture()] })
    const input = await assembleWriterPackInput({ novelStore: fakeStore(snapshot, { paragraphs: [] }), snapshot, unit: unitFixture(), mode: 'full' })
    const error = packErrorOf(() => renderWriterPackFull(input))
    expect(error.missingBlocks).toEqual(['body-tail'])
  })
})

/* --------------------------- W1 orchestration --------------------------- */

describe('agent-novel writer W1 draftUnitViaSubagent', () => {
  it('spawns a tool-free writer and returns the parsed candidate', async () => {
    const fake = scriptedWriterRuntime({ output: [{ type: 'text', text: CANDIDATE_JSON }] })
    const result = await draftUnitViaSubagent(
      { runtime: fake.runtime, parent: { id: 'parent-1' }, novelId: 'novel-1', unitId: 'unit-1' },
      packInputFixture(),
    )
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.provider).toBe('spawn')
    expect(fake.calls[0]!.label).toBe('dsh-tavern novel-writer · unit-1')
    expect(fake.calls[0]!.toolFilter).toEqual({ allow: [] })
    expect(fake.calls[0]!.promptText.startsWith(WRITER_PROTOCOL_FULL)).toBe(true)
    expect(fake.calls[0]!.promptText).toContain('## Story')
    expect(result.stopReason).toBe('completed')
    expect(result.candidate.paragraphs).toEqual(['风暴抵达了塔顶。', '他握紧栏杆。'])
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('throws a structured error for a non-completed stopReason', async () => {
    const fake = scriptedWriterRuntime({ stopReason: 'error', diagnostic: 'route unavailable' })
    const error = await draftUnitViaSubagent(
      { runtime: fake.runtime, parent: null, novelId: 'novel-1', unitId: 'unit-1' },
      packInputFixture(),
    ).then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(NovelWriterRunError)
    expect(error).toMatchObject({ novelId: 'novel-1', unitId: 'unit-1', stopReason: 'error', diagnostic: 'route unavailable' })
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('throws a structured error for empty output', async () => {
    const fake = scriptedWriterRuntime({ output: [] })
    const error = await draftUnitViaSubagent(
      { runtime: fake.runtime, parent: null, novelId: 'novel-1', unitId: 'unit-1' },
      packInputFixture(),
    ).then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ stopReason: 'empty-output' })
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('throws a structured error for output that is not the candidate JSON', async () => {
    const fake = scriptedWriterRuntime({ output: [{ type: 'text', text: '抱歉，我写不出来。' }] })
    const error = await draftUnitViaSubagent(
      { runtime: fake.runtime, parent: null, novelId: 'novel-1', unitId: 'unit-1' },
      packInputFixture(),
    ).then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(NovelWriterRunError)
    expect(error).toMatchObject({ stopReason: 'invalid-candidate' })
    expect(error.diagnostic).toContain('writer candidate is not a JSON object')
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('propagates start-time infrastructure faults', async () => {
    const runtime: SubagentRuntimeLike = {
      async start() {
        throw new Error('depth exhausted')
      },
    }
    await expect(draftUnitViaSubagent(
      { runtime, parent: null, novelId: 'novel-1', unitId: 'unit-1' },
      packInputFixture(),
    )).rejects.toThrow('depth exhausted')
  })
})

/* --------------------------- W2 orchestration --------------------------- */

describe('agent-novel writer W2 runDelegatedWriter', () => {
  beforeEach(() => {
    for (const runId of [...delegationTable().keys()]) removeWriterDelegation(runId)
  })

  it('spawns with the closed allow list and returns a receipt verified from the store', async () => {
    const snapshot = snapshotFixture({ units: [unitFixture('committed')], commits: [commitFixture()] })
    const fake = scriptedWriterRuntime({ output: [{ type: 'text', text: 'committed' }] })
    const receipt = await runDelegatedWriter(
      { runtime: fake.runtime, parent: null, novelStore: fakeStore(snapshot) },
      delegationFixture(),
    )
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.provider).toBe('spawn')
    expect(fake.calls[0]!.toolFilter).toEqual({ allow: [...WRITER_ALLOW_LIST] })
    expect(fake.calls[0]!.promptText.startsWith(WRITER_PROTOCOL_DELEGATED)).toBe(true)
    expect(fake.calls[0]!.promptText).not.toContain('## Characters')
    expect(receipt).toEqual({
      commitId: 'commit-1',
      unitId: 'unit-1',
      effectiveChars: 120,
      sceneCompletion: { completed: true, basis: '灯重新亮起', outstandingGoals: [] },
    })
    expect(findWriterDelegation('writer-1')).toBeUndefined()
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('registers the delegation only after start() resolves and removes it when the run settles', async () => {
    let gate: () => void = () => {}
    const resultGate = new Promise<void>((resolve) => { gate = resolve })
    let seenDuringStart: WriterDelegation | undefined
    const snapshot = snapshotFixture({ units: [unitFixture('committed')], commits: [commitFixture()] })
    const fake = scriptedWriterRuntime({
      resultGate,
      onStart: () => { seenDuringStart = findWriterDelegation('writer-1') },
    })
    const promise = runDelegatedWriter(
      { runtime: fake.runtime, parent: null, novelStore: fakeStore(snapshot) },
      delegationFixture(),
    )
    await flush()
    // §6.2 竞态窗口（已接受）：start() 返回前注册表必然为空；窗口内查不到委托 →
    // 工具 fail-closed（delegation not found），不存在未授权写入。
    expect(seenDuringStart).toBeUndefined()
    expect(findWriterDelegation('writer-1')).toMatchObject({ novelId: 'novel-1', unitId: 'unit-1', executionToken: 'tok-1' })
    gate()
    await promise
    expect(findWriterDelegation('writer-1')).toBeUndefined()
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('fails with a structured error and clears the delegation when the unit never commits', async () => {
    const snapshot = snapshotFixture({ units: [unitFixture('claimed')], commits: [] })
    const fake = scriptedWriterRuntime({ stopReason: 'completed' })
    const error = await runDelegatedWriter(
      { runtime: fake.runtime, parent: null, novelStore: fakeStore(snapshot) },
      delegationFixture(),
    ).then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(NovelWriterRunError)
    expect(error).toMatchObject({ novelId: 'novel-1', unitId: 'unit-1', stopReason: 'completed' })
    expect(error!.message).toContain('is not committed in the store')
    expect(findWriterDelegation('writer-1')).toBeUndefined()
    expect(fake.disposed).toEqual(['writer-1'])
  })

  it('surfaces a non-completed stopReason in the verification failure detail', async () => {
    const snapshot = snapshotFixture({ units: [unitFixture('claimed')], commits: [] })
    const fake = scriptedWriterRuntime({ stopReason: 'aborted', diagnostic: 'parent turn aborted' })
    const error = await runDelegatedWriter(
      { runtime: fake.runtime, parent: null, novelStore: fakeStore(snapshot) },
      delegationFixture(),
    ).then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ stopReason: 'aborted', diagnostic: 'parent turn aborted' })
    expect(fake.disposed).toEqual(['writer-1'])
  })
})

/* ---------------------- tool integration (Task C, 0007) ---------------------- */
/* 真实 NovelStore + agent.ts 工具面（apply 捕获范式）。写手身份 = fake runtime 的
   run.id 同时充当子代理 exec.agent.id——P1（spawn run 身份与 exec.agent.id 可关
   联）在测试内按成立对待；真机关联性是 capabilities 探针的事（Task D）。真实
   store 是 mutating 测试，放文件最后（既有纪律）。 */

const AUTHOR = 'integration-author'

interface IntegrationTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string; ctx?: { get?: (name: string) => unknown } } }): Promise<any>
}

describe('agent-novel writer tool integration', () => {
  let home: string
  let tavern: TavernStore
  let novels: NovelStore
  let novelId: string
  let tools: Map<string, IntegrationTool>
  let outlineRevision: string
  const authorExec = { agent: { id: AUTHOR } }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-novel-writer-integration-'))
    process.env.DSH_HOME = home
    tavern = await TavernStore.open(join(home, 'tavern'))
    await tavern.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '看守人',
        description: '守塔三十年的老人。',
        personality: '沉默',
        scenario: '北方礁石上的灯塔',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    await tavern.importWorldFile('风暴志', {
      entries: {
        '0': {
          uid: 0, key: ['风暴'], keysecondary: [], comment: '风暴',
          content: '风暴来袭前海鸟会先逃走。', constant: false,
          selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    novels = await NovelStore.open(join(home, 'tavern'))
    const created = await novels.createNovel(tavern, {
      title: '灯塔·委托篇',
      requirement: '写一个灯塔看守人的短篇',
      language: 'zh',
      genre: 'literary',
      narrativePerspective: 'third-person',
      styleNotes: '冷峻克制',
      lengthBudget: { kind: 'unbounded' },
      maxChapters: null,
      approvalMode: 'automatic',
      characterNames: ['看守人'],
      worldNames: ['风暴志'],
      budgets: {
        maxTurns: 100,
        maxDurationMs: 3_600_000,
        stallThresholdTurns: 10,
        consecutiveFailureLimit: 3,
        externalRetry: { maxAttempts: 2, backoffMs: 500 },
        maxDeduceRuns: 5,
      },
    })
    novelId = created.novelId
    await tavern.updateState(() => ({
      sessionBindings: { [AUTHOR]: { architecture: 'agent-novel', novelId } },
    }))
    tools = new Map()
    apply({
      agent: { id: AUTHOR },
      tools: { register: (tool) => { tools.set(tool.name, tool as IntegrationTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)

    const characterHash = (await novels.getNovel(novelId))!.assets.find((asset) => asset.kind === 'character')!.contentHash
    const outlineCreated = await tools.get('novel_outline_create')!.execute({
      expectedRevision: created.revision,
      outline: {
        story: { premise: '灯塔与风暴', theme: '孤独', mainConflict: '人与海', endingDirection: '灯长明', taboos: [] },
        characters: [{ characterId: 'keeper', name: '看守人', assetRef: characterHash, initialState: '独居', motivation: '守灯', relations: [], arc: '从麻木到释怀' }],
        chapters: [{ chapterId: 'ch-1', order: 1, title: '风暴之夜', purpose: '点亮灯塔', keyEvents: [], plannedCharacters: null, entryCondition: '平静', exitCondition: '风暴过去' }],
        currentChapterId: 'ch-1',
        scenes: [{ sceneId: 'sc-1', order: 1, goal: '风暴逼近时守住塔顶', participants: ['keeper'], timeLocation: '塔顶', causality: '承接前文', conflict: '人与海', expectedChange: '决心' }],
        foreshadowing: [{ id: 'f-1', description: '旧日志里的风暴周期', plantAt: 'ch-1', payoffAt: null, required: false, status: 'open' }],
      },
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
    }, authorExec)
    outlineRevision = outlineCreated.outlineRevision
  })

  afterAll(async () => {
    delete process.env.DSH_HOME
    // Async projections may still be settling; Windows rmdir needs retries.
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

  beforeEach(() => {
    for (const runId of [...delegationTable().keys()]) removeWriterDelegation(runId)
  })

  function execWithRuntime(runtime: SubagentRuntimeLike, agentId: string = AUTHOR) {
    return { agent: { id: agentId, ctx: { get: (name: string) => (name === 'subagents' ? runtime : undefined) } } }
  }

  /** W2 写手：start() 返回（注册表已登记）之后才执行其 novel_body_commit 工具调用。 */
  function writerThatCommits(runId: string, commitArgs: Record<string, unknown>) {
    const calls: WriterStartCall[] = []
    const runtime: SubagentRuntimeLike = {
      async start(provider, request) {
        calls.push({
          provider,
          label: request.label,
          promptText: request.prompt.map((block) => block.text ?? '').join('\n'),
          toolFilter: request.toolFilter,
        })
        const writerExec = { agent: { id: runId } }
        const result = (async () => {
          await flush() // 让 start() 的微任务续体先完成注册表登记（§6.2 竞态窗口）
          await tools.get('novel_body_commit')!.execute(commitArgs, writerExec)
          return { output: [{ type: 'text', text: 'committed' }], stopReason: 'completed' }
        })()
        return { id: runId, result, async dispose() {} }
      },
    }
    return { runtime, calls }
  }

  /** 从不提交的写手：runDelegatedWriter 的 store 快照核验必然失败（§5.2）。 */
  function writerThatNeverCommits(prefix: string): SubagentRuntimeLike {
    let counter = 0
    return {
      async start() {
        counter += 1
        return {
          id: `${prefix}-${counter}`,
          result: Promise.resolve({ output: [{ type: 'text', text: '写不出来' }], stopReason: 'completed' }),
          async dispose() {},
        }
      },
    }
  }

  function writerCommitArgs(unitId: string, paragraphs: readonly string[]): Record<string, unknown> {
    return {
      unitId,
      paragraphs: [...paragraphs],
      // 有意不携带 executionToken：委托路径由注册表注入（§6.3 token 不经模型可见通道）。
      sceneCompletion: { completed: true, basis: '风暴中守住塔顶', outstandingGoals: [], nextAnchor: null },
      canonChanges: [{ kind: 'event', summary: '风暴抵达', sources: ['inline#0'] }],
    }
  }

  function expectLosslessRoundtrip(value: unknown): void {
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  }

  it('novel_writer_draft returns the parsed candidate for a claimed unit, then the author commits it (W1)', async () => {
    const { unitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' })
    expect(unitId).toBe('unit-1')
    const claim = await tools.get('novel_unit_claim')!.execute({
      unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1,
    }, authorExec)

    const calls: WriterStartCall[] = []
    const draftRuntime: SubagentRuntimeLike = {
      async start(provider, request) {
        calls.push({
          provider,
          label: request.label,
          promptText: request.prompt.map((block) => block.text ?? '').join('\n'),
          toolFilter: request.toolFilter,
        })
        return { id: 'draft-run-1', result: Promise.resolve({ output: [{ type: 'text', text: CANDIDATE_JSON }], stopReason: 'completed' }), async dispose() {} }
      },
    }
    const drafted = await tools.get('novel_writer_draft')!.execute({ unitId }, execWithRuntime(draftRuntime))
    expect(drafted).toMatchObject({ unitId, stopReason: 'completed' })
    expect(drafted.candidate.paragraphs).toEqual(['风暴抵达了塔顶。', '他握紧栏杆。'])
    expect(drafted.candidate.sceneCompletion).toMatchObject({ completed: false, nextAnchor: '破晓前' })
    expectLosslessRoundtrip(drafted)
    // W1 spawn 形状：toolFilter 清空 + 全量包（含角色页）。
    expect(calls[0]!.provider).toBe('spawn')
    expect(calls[0]!.toolFilter).toEqual({ allow: [] })
    expect(calls[0]!.promptText.startsWith(WRITER_PROTOCOL_FULL)).toBe(true)
    expect(calls[0]!.promptText).toContain('## Story')
    expect(calls[0]!.promptText).toContain('## Characters')

    // 候选稿由作者审阅后带自己的 token 提交（W1：写手产稿，作者提交）。
    const committed = await tools.get('novel_body_commit')!.execute({
      unitId,
      executionToken: claim.executionToken,
      paragraphs: drafted.candidate.paragraphs,
      sceneCompletion: drafted.candidate.sceneCompletion,
      canonChanges: drafted.candidate.canonChanges,
    }, authorExec)
    expect(committed).toMatchObject({ commitId: 'commit-1', unitId, duplicate: false })
    expectLosslessRoundtrip(committed)
    // W1 是产稿不是委托：不写 writerRuns，也不登记委托。
    expect((await novels.getNovel(novelId))?.run.writerRuns).toBe(0)
    expect(findWriterDelegationByUnit(novelId, unitId)).toBeUndefined()
  })

  it('novel_writer_draft rejects a unit that is not claimed (no runtime needed: state check first)', async () => {
    await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' }) // unit-2
    await expect(tools.get('novel_writer_draft')!.execute({ unitId: 'unit-2' }, authorExec))
      .rejects.toThrow("'prepared', not claimed")
  })

  it('rejects delegated writers at the author-only gates and enforces the delegated commit scope', async () => {
    registerWriterDelegation('writer-run-x', {
      novelId, unitId: 'unit-2', executionToken: 'tok-x', intentId: null,
      grantedAt: new Date().toISOString(), dispatchCount: 1,
    })
    const writerExec = { agent: { id: 'writer-run-x' } }
    // 委托身份可以读（allow 列表内）：binding 解析经委托注册表。
    const status = await tools.get('novel_status_read')!.execute({}, writerExec)
    expect(status.novelId).toBe(novelId)
    // claim 是作者专属（纵深防御：claim 本就不在 WRITER_ALLOW_LIST）。
    await expect(tools.get('novel_unit_claim')!.execute({
      unitId: 'unit-2', expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1,
    }, writerExec)).rejects.toThrow('Unit claiming must be performed by the delegating author')
    // 写手不能再派写手（§13）。
    await expect(tools.get('novel_writer_draft')!.execute({ unitId: 'unit-2' }, writerExec))
      .rejects.toThrow('Delegated writers cannot spawn further writers')
    await expect(tools.get('novel_writer_delegate')!.execute({ unitId: 'unit-2' }, writerExec))
      .rejects.toThrow('Delegated writers cannot spawn further writers')
    // allow 列表外的作者工具在工具层被拒（防 toolFilter 失效的纵深防御）。
    await expect(tools.get('novel_outline_revise')!.execute({}, writerExec))
      .rejects.toThrow('not part of the delegated writer allow list')
    await expect(tools.get('novel_finish')!.execute({ expectedRevision: 'x', basis: 'x' }, writerExec))
      .rejects.toThrow('not part of the delegated writer allow list')
    // §12 委托越权：写手提交非 delegatedUnitId 被工具层拒绝（先于任何 store 调用）。
    await expect(tools.get('novel_body_commit')!.execute(writerCommitArgs('unit-1', ['越权正文。']), writerExec))
      .rejects.toThrow("delegated writer may only commit unit 'unit-2'")
    // 委托 miss：未注册身份走既有 binding 错误。
    await expect(tools.get('novel_body_commit')!.execute(writerCommitArgs('unit-1', ['无门正文。']), { agent: { id: 'unregistered-writer' } }))
      .rejects.toThrow('AgentNovel binding is unavailable')
    removeWriterDelegation('writer-run-x')
  })

  it('novel_writer_delegate claims internally, injects the token into the writer commit and returns a verified receipt (W2)', async () => {
    const writer = writerThatCommits('w2-run-1', writerCommitArgs('unit-2', ['风暴中他点起了灯。']))
    const before = (await novels.getNovel(novelId))!.run.writerRuns
    const receipt = await tools.get('novel_writer_delegate')!.execute({ unitId: 'unit-2' }, execWithRuntime(writer.runtime))
    expect(receipt).toMatchObject({ unitId: 'unit-2', commitId: 'commit-2', dispatchCount: 1 })
    expect(receipt.effectiveChars).toBeGreaterThan(0)
    expect(receipt.sceneCompletion).toMatchObject({ completed: true, basis: '风暴中守住塔顶' })
    expectLosslessRoundtrip(receipt)
    // spawn 形状：封闭 allow 列表 + trimmed 协议包（无角色页）。
    expect(writer.calls[0]!.provider).toBe('spawn')
    expect(writer.calls[0]!.toolFilter).toEqual({ allow: [...WRITER_ALLOW_LIST] })
    expect(writer.calls[0]!.promptText.startsWith(WRITER_PROTOCOL_DELEGATED)).toBe(true)
    expect(writer.calls[0]!.promptText).not.toContain('## Characters')
    // 写手 commit 未携带 executionToken——注册表注入，token 哈希仍是最终守卫。
    let snapshot = await novels.getNovel(novelId)
    expect(snapshot?.units.find((unit) => unit.unitId === 'unit-2')?.state).toBe('committed')
    expect(snapshot?.run.writerRuns).toBe(before + 1)
    expect(findWriterDelegationByUnit(novelId, 'unit-2')).toBeUndefined()
    // 幂等重试（0005 §12 纪律）：committed 单元直接回放回执，不再 spawn、不再计数。
    const replay = await tools.get('novel_writer_delegate')!.execute({ unitId: 'unit-2' }, execWithRuntime(writer.runtime))
    expect(writer.calls).toHaveLength(1)
    expect(replay).toMatchObject({ unitId: 'unit-2', commitId: 'commit-2' })
    expect(replay.dispatchCount).toBeUndefined()
    expectLosslessRoundtrip(replay)
    snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.writerRuns).toBe(before + 1)
  })

  it('novel_writer_delegate adopts a manual claim when the author passes the executionToken', async () => {
    await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' }) // unit-3
    const claim = await tools.get('novel_unit_claim')!.execute({
      unitId: 'unit-3', expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1,
    }, authorExec)
    const before = (await novels.getNovel(novelId))!.run.writerRuns
    const writer = writerThatCommits('w2-run-adopt', writerCommitArgs('unit-3', ['灯芯在风里稳住了。']))
    const receipt = await tools.get('novel_writer_delegate')!.execute({
      unitId: 'unit-3', executionToken: claim.executionToken,
    }, execWithRuntime(writer.runtime))
    expect(receipt).toMatchObject({ unitId: 'unit-3', commitId: 'commit-3', dispatchCount: 1 })
    expect((await novels.getNovel(novelId))?.run.writerRuns).toBe(before + 1)
  })

  it('records host-reported usage and writer prose size for the turn-end sample (P4, §7)', async () => {
    // 槽位单元行为：非法形状静默忽略，只收非负有限数值字段；drain 后复位。
    drainWriterRunUsage()
    recordWriterRunUsage({ outputChars: -1, usage: { inputTokens: 120, outputTokens: 'x', cachedTokens: 30 } })
    expect(drainWriterRunUsage()).toEqual({ outputChars: null, usage: { inputTokens: 120, cachedTokens: 30 } })
    expect(drainWriterRunUsage()).toEqual({ outputChars: null, usage: null })
    // 集成：宿主 run result 携带 usage 字段的委托成功后，槽内留下 token 计数
    // 与写手正文有效字符（driver 的 turn/end 采样 drain 进 NovelUsageSample）。
    const { unitId: usageUnitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' })
    const runtime: SubagentRuntimeLike = {
      // result 在 start() 体内启动（同学科于 writerThatCommits）：flush 的宏任务
      // 必须排在 registerWriterDelegation 之后，否则写手 commit 撞注册表 miss。
      async start() {
        const result = (async () => {
          await flush()
          await tools.get('novel_body_commit')!.execute(writerCommitArgs(usageUnitId, ['风暴停了，塔顶的灯还亮着。']), { agent: { id: 'w2-usage-run' } })
          return { output: [{ type: 'text', text: 'committed' }], stopReason: 'completed' as const, usage: { inputTokens: 1500, outputTokens: 260 } }
        })()
        return { id: 'w2-usage-run', result, async dispose() {} }
      },
    }
    await tools.get('novel_writer_delegate')!.execute({ unitId: usageUnitId }, execWithRuntime(runtime))
    const usage = drainWriterRunUsage()
    expect(usage.usage).toEqual({ inputTokens: 1500, outputTokens: 260 })
    expect(usage.outputChars).toBeGreaterThan(0)
    drainWriterRunUsage()
  })

  it('retains failed delegations for same-claim re-dispatch and enforces the 3-dispatch ceiling (§5.3)', async () => {
    const { unitId: ceilingUnitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' })
    const silent = writerThatNeverCommits('w2-fail')
    const before = (await novels.getNovel(novelId))!.run.writerRuns
    for (let dispatch = 1; dispatch <= MAX_WRITER_DISPATCHES_PER_UNIT; dispatch += 1) {
      await expect(tools.get('novel_writer_delegate')!.execute({ unitId: ceilingUnitId }, execWithRuntime(silent)))
        .rejects.toBeInstanceOf(NovelWriterRunError)
      // 失败后委托按单元保留：token 未消费、dispatchCount 累计，供同认领重派。
      const retained = findWriterDelegationByUnit(novelId, ceilingUnitId)
      expect(retained?.dispatchCount).toBe(dispatch)
      expect(retained?.executionToken).toMatch(/^[0-9a-f]{48}$/)
    }
    // 第 4 次派发超上限：结构化拒绝 + 条目释放；单元保持 claimed 交由既有失败路径处置。
    await expect(tools.get('novel_writer_delegate')!.execute({ unitId: ceilingUnitId }, execWithRuntime(silent)))
      .rejects.toThrow('writer re-dispatch limit reached')
    expect(findWriterDelegationByUnit(novelId, ceilingUnitId)).toBeUndefined()
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.units.find((unit) => unit.unitId === ceilingUnitId)?.state).toBe('claimed')
    // 失败不计数（§7：成功委托才计数）。
    expect(snapshot?.run.writerRuns).toBe(before)
  })

  it('honors budgets.writerDispatchLimit over the built-in default (§5.3)', async () => {
    // 前序 ceiling 测试按语义留下 claimed 单元；单一 in-flight 纪律下先经
    // stop（claimed→prepared，token 吊销）→ resume 腾出 claim 位（§12.3）。
    await novels.stop(novelId)
    await novels.resume(novelId)
    const { unitId: limitUnitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'sc-1', goal: '风暴逼近时守住塔顶' })
    const snapshotBefore = (await novels.getNovel(novelId))!
    await novels.patchNovelMeta(novelId, {
      expectedRevision: snapshotBefore.revision,
      patch: { budgets: { ...snapshotBefore.config.budgets, writerDispatchLimit: 1 } },
      cause: 'test-writer-dispatch-limit',
    })
    const silent = writerThatNeverCommits('w2-limit')
    // 上限 1：首派（dispatchCount=1）失败后按单元保留，第二次派发即超限拒绝。
    await expect(tools.get('novel_writer_delegate')!.execute({ unitId: limitUnitId }, execWithRuntime(silent)))
      .rejects.toBeInstanceOf(NovelWriterRunError)
    await expect(tools.get('novel_writer_delegate')!.execute({ unitId: limitUnitId }, execWithRuntime(silent)))
      .rejects.toThrow('writer re-dispatch limit reached')
    expect(findWriterDelegationByUnit(novelId, limitUnitId)).toBeUndefined()
  })

  it('samples successful tool output bytes per tool name and drains to zero (W0, §7)', async () => {
    // 先清空本 describe 前序测试累计的字节，再验证算术。
    drainToolOutputBytes()
    noteToolOutputBytes('probe-tool', 5)
    noteToolOutputBytes('probe-tool', 7)
    noteToolOutputBytes('other-tool', 3)
    noteToolOutputBytes('probe-tool', Number.NaN)
    noteToolOutputBytes('probe-tool', -1)
    expect(drainToolOutputBytes()).toEqual({ 'probe-tool': 12, 'other-tool': 3 })
    expect(drainToolOutputBytes()).toEqual({})
    // tool() 工厂集成：一次成功的状态读恰落一个键，字节数与 JSON 序列化一致。
    const status = await tools.get('novel_status_read')!.execute({}, authorExec)
    const drained = drainToolOutputBytes()
    expect(Object.keys(drained)).toEqual(['novel_status_read'])
    expect(drained['novel_status_read']).toBe(Buffer.byteLength(JSON.stringify(status), 'utf8'))
    // 工具失败不采样（execute 抛出即无字节）。
    await expect(tools.get('novel_status_read')!.execute({}, { agent: { id: 'nobody' } }))
      .rejects.toThrow('AgentNovel binding is unavailable')
    expect(drainToolOutputBytes()).toEqual({})
  })

  /* ------------- writer-subagent capability probes (0007 §9, Task D) ------------- */

  describe('writer subagent capability probes', () => {
  /** 每次探针 spawn 的剧本：是否真的执行 novel_status_read、以哪个执行身份、回复什么。 */
  function probeRuntime(step: (spawnIndex: number) => { callTool?: boolean; execAgentId?: string; output?: string } = () => ({ output: 'ok' })) {
    const calls: WriterStartCall[] = []
    let counter = 0
    const runtime: SubagentRuntimeLike = {
      async start(provider, request) {
        counter += 1
        const spawnIndex = counter
        const runId = `probe-run-${spawnIndex}`
        calls.push({
          provider,
          label: request.label,
          promptText: request.prompt.map((block) => block.text ?? '').join('\n'),
          toolFilter: request.toolFilter,
        })
        const script = step(spawnIndex)
        const result = (async () => {
          if (script.callTool === true) {
            // 子代理真实执行 novel_status_read：无绑定会抛错（预期），但
            // recordProbeAgentId 在绑定解析前已记录执行身份（P1 探针依赖）。
            await tools.get('novel_status_read')!.execute({}, { agent: { id: script.execAgentId ?? runId } }).catch(() => {})
          }
          return {
            output: [{ type: 'text', text: script.output ?? 'ok' }],
            stopReason: 'completed' as const,
          }
        })()
        return { id: runId, result, async dispose() {} }
      },
    }
    return { runtime, calls }
  }

  it('P1 passes when the subagent tool execution identity equals the spawn run id', async () => {
    const { runtime, calls } = probeRuntime(() => ({ callTool: true, output: 'ok' }))
    const report = await inspectWriterSubagentCapabilities({ runtime, parent: { id: AUTHOR } })
    expect(report.spawnOk).toBe(true)
    expect(report.p1).toMatchObject({ status: 'pass' })
    expect(report.p1.detail).toContain('probe-run-1')
    expect(report.p3).toMatchObject({ status: 'deferred-to-e2e' })
    // P1 spawn uses a closed allow list containing exactly the probe tool.
    expect(calls[0]?.toolFilter).toEqual({ allow: ['novel_status_read'] })
    expect(calls[0]?.promptText).toContain('novel_status_read')
    expect(report.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Lossless discipline: no undefined values, JSON roundtrip stable.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('P1 fails when the subagent never executes the probe tool; P2 turns inconclusive', async () => {
    const { runtime } = probeRuntime(() => ({ output: 'ok' }))
    const report = await inspectWriterSubagentCapabilities({ runtime })
    expect(report.spawnOk).toBe(true)
    expect(report.p1.status).toBe('fail')
    expect(report.p1.detail).toContain('never executed')
    expect(report.p2.status).toBe('inconclusive')
    expect(report.p2.detail).toContain('allow-reachable half unproven')
  })

  it('P1 fails on an identity mismatch (exec.agent.id differs from the run id)', async () => {
    const { runtime } = probeRuntime(() => ({ callTool: true, execAgentId: 'some-other-agent', output: 'ok' }))
    const report = await inspectWriterSubagentCapabilities({ runtime })
    expect(report.p1.status).toBe('fail')
    expect(report.p1.detail).toContain('some-other-agent')
    expect(report.p1.detail).toContain('probe-run-1')
  })

  it('P2 fails hard when the probe tool executes under an empty allow list', async () => {
    const { runtime, calls } = probeRuntime(() => ({ callTool: true, output: 'tool-ran' }))
    const report = await inspectWriterSubagentCapabilities({ runtime })
    expect(report.p1.status).toBe('pass')
    expect(calls[1]?.toolFilter).toEqual({ allow: [] })
    expect(report.p2.status).toBe('fail')
    expect(report.p2.detail).toContain('empty allow list')
  })

  it('P2 passes observationally when the empty-allow subagent reports the tool unavailable', async () => {
    const { runtime } = probeRuntime((spawnIndex) => (spawnIndex === 1 ? { callTool: true, output: 'ok' } : { output: 'unavailable' }))
    const report = await inspectWriterSubagentCapabilities({ runtime })
    expect(report.p1.status).toBe('pass')
    expect(report.p2.status).toBe('pass')
    expect(report.p2.detail).toContain('observational')
  })

  it('P2 is inconclusive when the empty-allow subagent answers ambiguously', async () => {
    const { runtime } = probeRuntime((spawnIndex) => (spawnIndex === 1 ? { callTool: true, output: 'ok' } : { output: '我不知道这个工具' }))
    const report = await inspectWriterSubagentCapabilities({ runtime })
    expect(report.p2.status).toBe('inconclusive')
    expect(report.p2.detail).toContain('model compliance')
  })

  it('a missing runtime yields a spawnOk:false fail-closed report', async () => {
    const report = await inspectWriterSubagentCapabilities({})
    expect(report.spawnOk).toBe(false)
    expect(report.p1.status).toBe('fail')
    expect(report.p1.detail).toContain('subagent runtime is unavailable')
    expect(report.p2.status).toBe('fail')
    expect(report.p3.status).toBe('deferred-to-e2e')
  })
  })
})
