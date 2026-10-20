import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  NovelLengthLimitError,
  NovelRevisionConflictError,
  NovelStore,
  TavernStore,
  summarizeNovel,
  type ImportExtraction,
  type NovelCreateConfig,
  type NovelOutlinePayload,
} from '../src/index.js'

const SOURCE = [
  '第一章 雾港',
  '',
  '雾从海面压进港口，灯塔只亮了一半。林舟把缆绳绕在桩上。',
  '',
  '第二章 旧信',
  '',
  '那封信在抽屉里放了十年，纸角已经发黄。他决定去北岸。',
].join('\n')

function withStores(fn: (tavern: TavernStore, novels: NovelStore, root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novel-import-store-'))
    try {
      await fn(await TavernStore.open(root), await NovelStore.open(root), root)
    } finally {
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
  }
}

function baseConfig(overrides?: Partial<NovelCreateConfig>): NovelCreateConfig {
  return {
    title: '雾港续章',
    requirement: '从旧信结尾继续写，保持冷峻的海港氛围。',
    language: 'zh',
    genre: '悬疑',
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

function outlinePayload(): NovelOutlinePayload {
  return {
    story: { premise: '旧信指向北岸', theme: '记忆', mainConflict: '真相与安稳', endingDirection: '读完信', taboos: [] },
    characters: [{
      characterId: 'lin', name: '林舟', initialState: '守港', motivation: '寻找寄信人', relations: [], arc: '从回避到直面',
    }],
    chapters: [{
      chapterId: 'ch-1', order: 1, title: '北岸', purpose: '启程', keyEvents: ['登船'], plannedCharacters: null,
      entryCondition: '读完信', exitCondition: '抵达北岸',
    }],
    currentChapterId: 'ch-1',
    scenes: [{
      sceneId: 'sc-1', order: 1, goal: '登船离港', participants: ['lin'], timeLocation: '码头 / 清晨',
      causality: '承接旧信', conflict: '雾中迷航', expectedChange: '离开',
    }],
    foreshadowing: [],
  }
}

function extraction(partId: string, chapterId: string, name: string): ImportExtraction {
  return {
    partId,
    chapterId,
    summary: `${name}在雾港发现旧信。`,
    timeline: [{ order: 1, summary: '林舟在码头收缆。', characters: [name], importance: 'major' }],
    characters: [{
      name,
      aliases: [],
      role: '主角',
      identity: '雾港守港人',
      personality: '沉默',
      appearance: '旧雨衣',
      motivation: '寻找寄信人',
      relationships: [],
      stateAtEnd: '决定北上',
      confidence: 'high',
    }],
    worldEntries: [{
      title: '雾港',
      keys: ['雾港', '灯塔'],
      category: '地点',
      content: '冬季长雾，灯塔只亮一半。',
    }],
    openThreads: ['旧信是谁寄的？'],
    style: { pointOfView: 'third', tone: '冷峻', pacing: 'slow', proseNotes: '海雾与盐味', dialogueStyle: '克制' },
  }
}

describe('NovelStore imported continuation (proposal 0020)', () => {
  it('creates an importing project, extracts parts, fuses a bible and materialises assets', withStores(async (tavern, novels) => {
    const created = await novels.createImportedNovel(tavern, baseConfig(), {
      name: '雾港.txt',
      format: 'txt',
      text: SOURCE,
      partTargetCharacters: 2000,
    })
    expect(created.import.chapterCount).toBe(2)
    expect(created.import.partCount).toBe(2)
    let snapshot = (await novels.getNovel(created.novelId))!
    expect(snapshot.run.phase).toBe('importing')
    expect(snapshot.import?.parts.map((part) => part.status)).toEqual(['pending', 'pending'])

    const digestBefore = await novels.readImportDigest(created.novelId)
    expect(digestBefore?.source.extractedParts).toBe(0)

    for (const part of snapshot.import!.parts) {
      const attempt = await novels.beginImportPartAttempt(created.novelId, part.partId)
      expect(attempt.attempt).toBe(1)
      const source = await novels.importSourcePart(created.novelId, part.partId)
      expect(source.text.length).toBeGreaterThan(0)
      await novels.recordImportExtraction(created.novelId, {
        partId: part.partId,
        extraction: extraction(part.partId, part.chapterId, '林舟'),
      })
    }
    snapshot = (await novels.getNovel(created.novelId))!
    expect(snapshot.import?.parts.every((part) => part.status === 'extracted')).toBe(true)

    const digest = await novels.readImportDigest(created.novelId)
    expect(digest?.source.extractedParts).toBe(2)
    expect(digest?.characters[0]).toMatchObject({ name: '林舟', mentions: 2 })
    expect(digest?.worldEntries[0]?.title).toBe('雾港')

    const merged = await novels.applyImportMerge(created.novelId, {
      expectedRevision: snapshot.revision,
      bible: {
        story: { premise: '雾港的旧信', theme: '记忆', mainConflict: '真相与安稳', endingDirection: '北上寻人', taboos: [] },
        timeline: digest!.timeline,
        characters: digest!.characters,
        worldEntries: digest!.worldEntries,
        styleNotes: '冷峻、潮湿、克制',
        openThreads: digest!.openThreads,
      },
    })
    expect(merged.assetsAdded).toBeGreaterThanOrEqual(2)
    const after = (await novels.getNovel(created.novelId))!
    expect(after.run.phase).toBe('outlining')
    expect(after.import?.bibleHash).not.toBeNull()
    expect(after.import?.bibleSummary).toMatchObject({ characterCount: 1, worldEntryCount: 1 })
    expect(after.assets.filter((asset) => asset.sourceId.startsWith('import:'))).toHaveLength(2)

    const bible = await novels.readImportBible(created.novelId)
    expect(bible?.story.premise).toBe('雾港的旧信')
    const replay = await novels.applyImportMerge(created.novelId, {
      expectedRevision: 'stale',
      bible: {
        story: { premise: '雾港的旧信', theme: '记忆', mainConflict: '真相与安稳', endingDirection: '北上寻人', taboos: [] },
        timeline: digest!.timeline,
        characters: digest!.characters,
        worldEntries: digest!.worldEntries,
        styleNotes: '冷峻、潮湿、克制',
        openThreads: digest!.openThreads,
      },
    })
    expect(replay.duplicate).toBe(true)

    const chapterSource = await novels.readImportSource(created.novelId, { chapterId: 'ich-1' })
    expect(chapterSource.text).toContain('灯塔')
    const hits = await novels.searchImportSource(created.novelId, { query: '十年 北岸', limit: 5 })
    expect(hits.hits).toHaveLength(1)
    expect(hits.hits[0]?.chapterId).toBe('ich-2')
  }))

  it('keeps manual mode approval on the first continuation outline after import', withStores(async (tavern, novels) => {
    const created = await novels.createImportedNovel(tavern, baseConfig({ approvalMode: 'manual' }), {
      name: '雾港.txt', format: 'txt', text: SOURCE, partTargetCharacters: 2000,
    })
    let snapshot = (await novels.getNovel(created.novelId))!
    for (const part of snapshot.import!.parts) {
      await novels.beginImportPartAttempt(created.novelId, part.partId)
      await novels.recordImportExtraction(created.novelId, {
        partId: part.partId,
        extraction: extraction(part.partId, part.chapterId, '林舟'),
      })
    }
    snapshot = (await novels.getNovel(created.novelId))!
    await novels.applyImportMerge(created.novelId, {
      expectedRevision: snapshot.revision,
      bible: {
        story: { premise: '雾港旧信', theme: '', mainConflict: '', endingDirection: '北上', taboos: [] },
        timeline: [], characters: [], worldEntries: [], styleNotes: '', openThreads: [],
      },
    })
    snapshot = (await novels.getNovel(created.novelId))!
    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: snapshot.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
    })
    expect(outlined.revision).not.toBe(snapshot.revision)
    const after = (await novels.getNovel(created.novelId))!
    expect(after.run).toMatchObject({ status: 'paused', phase: 'outlining', pauseReason: 'awaiting-approval' })
  }))

  it('resets unfinished extraction attempts only when the user resumes', withStores(async (tavern, novels) => {
    const created = await novels.createImportedNovel(tavern, baseConfig(), {
      name: '雾港.txt', format: 'txt', text: SOURCE, partTargetCharacters: 2000,
    })
    const part = (await novels.getNovel(created.novelId))!.import!.parts[0]!
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = await novels.beginImportPartAttempt(created.novelId, part.partId)
      expect(started.attempt).toBe(attempt)
      await novels.failImportPart(created.novelId, { partId: part.partId, error: `failure ${attempt}` })
    }
    await expect(novels.beginImportPartAttempt(created.novelId, part.partId))
      .rejects.toMatchObject({ rule: 'import-part-exhausted' })
    await novels.pause(created.novelId, { reason: 'recovery-required', detail: 'extraction exhausted' })
    await novels.resume(created.novelId)
    const resumed = (await novels.getNovel(created.novelId))!
    expect(resumed.run).toMatchObject({ status: 'active', phase: 'importing' })
    expect(resumed.import?.parts[0]).toMatchObject({ attempts: 0, status: 'pending', error: null })
  }))

  it('rejects merging before every part is extracted', withStores(async (tavern, novels) => {
    const created = await novels.createImportedNovel(tavern, baseConfig(), {
      name: '雾港.txt', format: 'txt', text: SOURCE, partTargetCharacters: 2000,
    })
    const snapshot = (await novels.getNovel(created.novelId))!
    await expect(novels.applyImportMerge(created.novelId, {
      expectedRevision: snapshot.revision,
      bible: {
        story: { premise: 'x', theme: '', mainConflict: '', endingDirection: 'y', taboos: [] },
        timeline: [], characters: [], worldEntries: [], styleNotes: '', openThreads: [],
      },
    })).rejects.toMatchObject({ rule: 'import-parts-pending' })
  }))
})

describe('NovelStore body revisions (proposal 0020 §5)', () => {
  it('stages, applies and discards a chapter revision without mutating commits', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
    })
    const { unitId } = await novels.prepareUnit(created.novelId, {
      chapterId: 'ch-1', sceneId: 'sc-1', label: '登船', goal: '登船离港',
    })
    const claim = await novels.claimUnit(created.novelId, {
      unitId, expectedOutlineRevision: outlined.outlineRevision, expectedRequirementSequence: 1, hostTurn: null,
    })
    await novels.commitBody(created.novelId, {
      unitId,
      executionToken: claim.executionToken,
      paragraphs: ['雾里传来船笛。', '他踏上跳板。'],
      sceneCompletion: { completed: true, basis: '登船完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    const before = (await novels.getNovel(created.novelId))!
    expect(before.commits).toHaveLength(1)
    expect(before.bodyRevisions ?? []).toHaveLength(0)

    const staged = await novels.createBodyRevision(created.novelId, {
      chapterId: 'ch-1',
      instruction: '加强海雾与船笛的感官描写',
      paragraphs: ['浓雾像湿布一样压在码头上。', '船笛从雾心传来，他踏上跳板。'],
      expectedContentRevision: before.contentRevision,
    })
    let snapshot = (await novels.getNovel(created.novelId))!
    expect(snapshot.bodyRevisions?.[0]).toMatchObject({ revisionId: staged.revisionId, status: 'pending' })
    // Pending revisions never project.
    let body = await novels.readBody(created.novelId, { chapterId: 'ch-1' })
    expect(body.paragraphs.map((paragraph) => paragraph.text)).toEqual(['雾里传来船笛。', '他踏上跳板。'])

    const applied = await novels.applyBodyRevision(created.novelId, {
      revisionId: staged.revisionId,
      expectedRevision: snapshot.revision,
    })
    expect(applied.totalCharacters).toBeGreaterThan(0)
    body = await novels.readBody(created.novelId, { chapterId: 'ch-1' })
    expect(body.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      '浓雾像湿布一样压在码头上。',
      '船笛从雾心传来，他踏上跳板。',
    ])
    expect(body.paragraphs.every((paragraph) => paragraph.commitId === staged.revisionId)).toBe(true)
    // Commit records stay immutable.
    snapshot = (await novels.getNovel(created.novelId))!
    expect(snapshot.commits[0]!.bodyHash).toBe(before.commits[0]!.bodyHash)
    expect(summarizeNovel(snapshot).effectiveCharacters).toBe(applied.totalCharacters)

    snapshot = (await novels.getNovel(created.novelId))!
    const discarded = await novels.createBodyRevision(created.novelId, {
      chapterId: 'ch-1',
      instruction: '再改一次但不应用',
      paragraphs: ['这是一版不会生效的稿子。'],
      expectedContentRevision: snapshot.contentRevision,
    })
    snapshot = (await novels.getNovel(created.novelId))!
    await novels.discardBodyRevision(created.novelId, {
      revisionId: discarded.revisionId,
      expectedRevision: snapshot.revision,
    })
    body = await novels.readBody(created.novelId, { chapterId: 'ch-1' })
    expect(body.paragraphs[0]!.text).toBe('浓雾像湿布一样压在码头上。')
  }))

  it('refuses to apply a revision that exceeds the hard maximum', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 10, toleranceRatio: 0.5, hardMaximumCharacters: 12 },
    }))
    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
    })
    const { unitId } = await novels.prepareUnit(created.novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 's', goal: 'g' })
    const claim = await novels.claimUnit(created.novelId, {
      unitId, expectedOutlineRevision: outlined.outlineRevision, expectedRequirementSequence: 1, hostTurn: null,
    })
    await novels.commitBody(created.novelId, {
      unitId,
      executionToken: claim.executionToken,
      paragraphs: ['短句。'],
      sceneCompletion: { completed: true, basis: 'ok', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    const before = (await novels.getNovel(created.novelId))!
    const staged = await novels.createBodyRevision(created.novelId, {
      chapterId: 'ch-1',
      instruction: 'expand',
      paragraphs: ['这一版会明显超过硬上限，必须被拒绝，而不是悄悄截断。'],
      expectedContentRevision: before.contentRevision,
    })
    const snapshot = (await novels.getNovel(created.novelId))!
    await expect(novels.applyBodyRevision(created.novelId, {
      revisionId: staged.revisionId,
      expectedRevision: snapshot.revision,
    })).rejects.toBeInstanceOf(NovelLengthLimitError)
    await expect(novels.applyBodyRevision(created.novelId, {
      revisionId: staged.revisionId,
      expectedRevision: 'stale',
    })).rejects.toBeInstanceOf(NovelRevisionConflictError)
  }))
})
