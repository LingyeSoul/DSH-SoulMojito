import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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
  NovelStore,
  TavernStore,
  normalizeTavernSessionBinding,
  stableStringify,
  type NovelCreateConfig,
  type NovelOutlinePayload,
  type NovelUsageSample,
} from '../src/index.js'

function withStores(fn: (tavern: TavernStore, novels: NovelStore, root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novel-store-'))
    try {
      await fn(await TavernStore.open(root), await NovelStore.open(root), root)
    } finally {
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
  }
}

function baseConfig(overrides?: Partial<NovelCreateConfig>): NovelCreateConfig {
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

function outlinePayload(chapterCount = 1, foreshadowingRequired = false): NovelOutlinePayload {
  return {
    story: { premise: '看守人发现海面异象', theme: '孤独与守望', mainConflict: '人与海', endingDirection: '黎明到来', taboos: ['血腥描写'] },
    characters: [{
      characterId: 'keeper', name: '守塔人', initialState: '平静值守', motivation: '守到最后一次日出', relations: [], arc: '从逃避到直面',
    }],
    chapters: Array.from({ length: chapterCount }, (_, index) => ({
      chapterId: `ch-${index + 1}`,
      order: index + 1,
      title: `第${index + 1}章`,
      purpose: '推进主线',
      keyEvents: ['发现异象'],
      plannedCharacters: null,
      entryCondition: '前章结束',
      exitCondition: '本章目标达成',
    })),
    currentChapterId: 'ch-1',
    scenes: [{
      sceneId: 'sc-1', order: 1, goal: '发现海面异象并做出决定', participants: ['keeper'],
      timeLocation: '塔顶 / 深夜', causality: '承接开篇', conflict: '风暴逼近', expectedChange: '下定决心',
    }],
    foreshadowing: [{ id: 'f-1', description: '沉船残骸', plantAt: 'ch-1', payoffAt: null, required: foreshadowingRequired, status: 'open' }],
  }
}

/** create -> createOutline (req-1 applied), leaving a claimable novel. */
async function startedNovel(tavern: TavernStore, novels: NovelStore, overrides?: Partial<NovelCreateConfig>) {
  const created = await novels.createNovel(tavern, baseConfig(overrides))
  const outlined = await novels.createOutline(created.novelId, {
    expectedRevision: created.revision,
    outline: outlinePayload(),
    handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
  })
  return { novelId: created.novelId, revision: outlined.revision, outlineRevision: outlined.outlineRevision }
}

/** prepare + claim the first scene; returns everything commitBody needs. */
async function claimFirstScene(novels: NovelStore, novelId: string, outlineRevision: string) {
  const { unitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
  return novels.claimUnit(novelId, { unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 })
}

async function waitFor(predicate: () => Promise<boolean>, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const sampleCard = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Test Char', description: 'd', personality: 'p', scenario: 's', first_mes: 'hi',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    character_book: {
      name: 'Embedded Lore',
      entries: [{ keys: ['灯塔'], content: '灯塔的历史', enabled: true, insertion_order: 1 }],
    },
  },
}

describe('NovelStore 项目', () => {
  it('create -> getNovel 往返，首条指令与运行状态落盘', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    expect(created.requirementId).toBe('req-1')
    expect(created.revision).toMatch(/^[0-9a-f]{16}$/)
    const snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.revision).toBe(created.revision)
    expect(snapshot?.config.title).toBe('灯塔')
    expect(snapshot?.requirements).toHaveLength(1)
    expect(snapshot?.requirements[0]?.status).toBe('pending')
    expect(snapshot?.run.status).toBe('active')
    expect(snapshot?.run.phase).toBe('outlining')
    expect(snapshot?.outline).toBeNull()
    const head = JSON.parse(await readFile(path.join(root, 'novels', created.novelId, 'HEAD.json'), 'utf8')) as { revision: string }
    expect(head.revision).toBe(created.revision)
    const revisionFile = JSON.parse(await readFile(path.join(root, 'novels', created.novelId, 'revisions', `${created.revision}.json`), 'utf8')) as { snapshot: { novelId: string } }
    expect(revisionFile.snapshot.novelId).toBe(created.novelId)
    const summaries = await novels.listNovels()
    expect(summaries.map((s) => s.novelId)).toEqual([created.novelId])
    expect(summaries[0]?.title).toBe('灯塔')
    expect(summaries[0]?.status).toBe('active')

    const patched = await novels.patchNovelMeta(created.novelId, {
      expectedRevision: created.revision,
      patch: { title: '灯塔纪事', premiseNote: '关于守望' },
      cause: 'rename',
    })
    const repatched = await novels.getNovel(created.novelId)
    expect(repatched?.config.title).toBe('灯塔纪事')
    expect(repatched?.premiseNote).toBe('关于守望')
    expect(repatched?.revision).toBe(patched.revision)

    // 预算补丁：面板可编辑运行预算（长章节场景），noteTurn 实时读取快照故下一轮生效。
    const budgeted = await novels.patchNovelMeta(created.novelId, {
      expectedRevision: patched.revision,
      patch: { budgets: { ...repatched!.config.budgets, maxTurns: 500 } },
      cause: 'raise-turn-budget',
    })
    const rebudgeted = await novels.getNovel(created.novelId)
    expect(rebudgeted?.config.budgets.maxTurns).toBe(500)
    expect(rebudgeted?.config.budgets.externalRetry).toEqual(repatched?.config.budgets.externalRetry)
    expect(rebudgeted?.config.title).toBe('灯塔纪事')
    expect(rebudgeted?.revision).toBe(budgeted.revision)

    await expect(novels.patchNovelMeta(created.novelId, {
      expectedRevision: budgeted.revision,
      patch: { budgets: { ...rebudgeted!.config.budgets, maxTurns: 0 } },
      cause: 'bad-budget',
    })).rejects.toBeInstanceOf(NovelConfigError)
    await expect(novels.patchNovelMeta(created.novelId, { expectedRevision: created.revision, patch: { title: 'X' }, cause: 'stale' })).rejects.toBeInstanceOf(NovelRevisionConflictError)

    expect(await novels.deleteNovel(created.novelId)).toBe(true)
    expect(await novels.deleteNovel(created.novelId)).toBe(false)
    expect(await novels.getNovel(created.novelId)).toBeUndefined()
    await expect(novels.getNovel('nvl-missing')).resolves.toBeUndefined()
  }))

  it('资产快照：内容哈希、卡内嵌世界书并入去重、源资产缺失报错', withStores(async (tavern, novels, root) => {
    await tavern.importCharacter(sampleCard)
    const created = await novels.createNovel(tavern, baseConfig({ characterNames: ['Test Char'], worldNames: ['Embedded Lore'] }))
    const snapshot = await novels.getNovel(created.novelId)
    const assets = snapshot?.assets ?? []
    // character + embedded world deduped against the explicit selection
    expect(assets).toHaveLength(2)
    const character = assets.find((a) => a.kind === 'character')
    const world = assets.find((a) => a.kind === 'world')
    expect(character?.sourceId).toBe('Test Char')
    expect(character?.specVersion).toBe('2.0')
    expect(world?.sourceId).toBe('Embedded Lore')
    const card = (await tavern.getCharacter('Test Char'))?.card
    const expectedHash = createHash('sha256').update(stableStringify(card)).digest('hex')
    expect(character?.contentHash).toBe(expectedHash)
    const assetBytes = await readFile(path.join(root, 'novels', created.novelId, 'assets', `${expectedHash}.json`), 'utf8')
    expect(JSON.parse(assetBytes).data.name).toBe('Test Char')

    await expect(novels.createNovel(tavern, baseConfig({ characterNames: ['Ghost'] }))).rejects.toBeInstanceOf(NovelConfigError)
    await expect(novels.createNovel(tavern, baseConfig({ worldNames: ['GhostWorld'] }))).rejects.toBeInstanceOf(NovelConfigError)
    await expect(novels.createNovel(tavern, baseConfig({ lengthBudget: { kind: 'target', targetCharacters: 0, toleranceRatio: 0.1, hardMaximumCharacters: null } }))).rejects.toBeInstanceOf(NovelConfigError)
  }))
})

describe('NovelStore 指令台账（§9）', () => {
  it('同 hostMessageId 幂等，不同指令递增 sequence', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels)
    const first = await novels.receiveRequirement(novelId, { hostMessageId: 'm-2', text: '增加暴风雪', sourceKind: 'composer' })
    expect(first).toMatchObject({ requirementId: 'req-2', sequence: 2, duplicate: false })
    const retry = await novels.receiveRequirement(novelId, { hostMessageId: 'm-2', text: '增加暴风雪', sourceKind: 'panel' })
    expect(retry).toMatchObject({ requirementId: 'req-2', sequence: 2, duplicate: true })
    expect((await novels.getNovel(novelId))?.requirements).toHaveLength(2)
    const third = await novels.receiveRequirement(novelId, { hostMessageId: 'm-3', text: '提前结局', sourceKind: 'internal' })
    expect(third.sequence).toBe(3)
    await expect(novels.receiveRequirement(novelId, { hostMessageId: '', text: 'x', sourceKind: 'composer' })).rejects.toBeInstanceOf(NovelConfigError)
  }))

  it('blocked 指令：blockRequirement 暂停并保留水位；澄清后可经修订转 applied', withStores(async (tavern, novels) => {
    const { novelId, revision } = await startedNovel(tavern, novels)
    const received = await novels.receiveRequirement(novelId, { hostMessageId: 'm-2', text: '让已死的人复活', sourceKind: 'composer' })
    const blocked = await novels.blockRequirement(novelId, {
      expectedRevision: received.revision,
      requirementId: 'req-2',
      conflictReason: '与已提交正文冲突',
      bodySources: ['commit-1#0'],
    })
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.pauseReason).toBe('requirement-conflict')
    expect(snapshot?.requirements.find((r) => r.requirementId === 'req-2')?.blockedReason).toBe('与已提交正文冲突')
    // Claiming stays blocked while a blocked requirement exists.
    await novels.resume(novelId)
    const { unitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'l', goal: 'g' })
    await expect(novels.claimUnit(novelId, { unitId, expectedOutlineRevision: snapshot!.outline!.outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'requirements-unprocessed' })
    // Clarification lets a later revision move blocked -> applied (§9.1).
    const revised = await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: snapshot!.outline!.outlineRevision,
      reason: '澄清后调整',
      changes: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-2', result: 'applied', effectiveLocation: 'story.endingDirection' }],
    })
    expect(revised.watermark).toBe(2)
    expect(revision).toMatch(/^[0-9a-f]{16}$/)
    // Blocking a non-pending requirement is a conflict error.
    await expect(novels.blockRequirement(novelId, {
      expectedRevision: revised.revision,
      requirementId: 'req-2',
      conflictReason: 'again',
      bodySources: [],
    })).rejects.toBeInstanceOf(NovelRequirementConflictError)
    await expect(novels.blockRequirement(novelId, {
      expectedRevision: revised.revision,
      requirementId: 'req-404',
      conflictReason: 'missing',
      bodySources: [],
    })).rejects.toBeInstanceOf(NovelRequirementConflictError)
  }))

  it('completed 后拒收新指令', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels)
    const claim = await claimFirstScene(novels, novelId, (await novels.getNovel(novelId))!.outline!.outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['黎明终于到来，守塔人放下了望远镜。'],
      sceneCompletion: { completed: true, basis: '场景目标完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(novelId))!.contentRevision,
      basis: '主线收束',
      openItems: [],
    })
    await novels.finishNovel(novelId, { expectedRevision: (await novels.getNovel(novelId))!.revision, basis: '短篇完成' })
    await expect(novels.receiveRequirement(novelId, { hostMessageId: 'm-9', text: '再来一章', sourceKind: 'composer' }))
      .rejects.toMatchObject({ code: 'NOVEL_CAPABILITY' })
    await expect(novels.finishNovel(novelId, { expectedRevision: (await novels.getNovel(novelId))!.revision, basis: 'again' }))
      .rejects.toBeInstanceOf(NovelCapabilityError)
  }))
})

describe('NovelStore 大纲（§6）', () => {
  it('CAS 冲突回显 actualRevision；重复创建被拒；水位推进', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    await expect(novels.createOutline(created.novelId, {
      expectedRevision: 'deadbeef00112233',
      outline: outlinePayload(),
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_REVISION_CONFLICT', actualRevision: created.revision })

    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story' }],
    })
    expect(outlined.watermark).toBe(1)
    await expect(novels.createOutline(created.novelId, {
      expectedRevision: outlined.revision,
      outline: outlinePayload(),
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'outline-exists' })
    const other = await novels.createNovel(tavern, baseConfig({ title: '另一本' }))
    await expect(novels.createOutline(other.novelId, {
      expectedRevision: other.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-9', result: 'applied' }],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'requirement-not-found' })

    const received = await novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: '加一个对手', sourceKind: 'composer' })
    const revised = await novels.reviseOutline(created.novelId, {
      expectedRevision: received.revision,
      expectedOutlineRevision: outlined.outlineRevision,
      reason: '加入对手角色',
      changes: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-2', result: 'applied', effectiveLocation: 'characters' }],
    })
    expect(revised.watermark).toBe(2)
    const snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.outline?.parentRevision).toBe(outlined.outlineRevision)
    expect(snapshot?.outline?.sourceRequirementIds).toEqual(['req-2'])
    await expect(novels.reviseOutline(created.novelId, {
      expectedRevision: revised.revision,
      expectedOutlineRevision: outlined.outlineRevision,
      reason: '过期大纲版本',
      changes: outlinePayload(),
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_REVISION_CONFLICT' })
  }))

  it('含已提交正文的章节不可删除或重排', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels, { maxChapters: null })
    // Re-plan to two chapters first.
    const current = await novels.getNovel(novelId)
    const twoChapters = await novels.reviseOutline(novelId, {
      expectedRevision: current!.revision,
      expectedOutlineRevision: outlineRevision,
      reason: '扩为两章',
      changes: outlinePayload(2),
      handledRequirements: [],
    })
    const claim = await claimFirstScene(novels, novelId, twoChapters.outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['风暴之夜，海面泛起不祥的光。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    const after = await novels.getNovel(novelId)
    // Drop ch-1 (has committed body) explicitly; keep only ch-2.
    const removeCommitted = outlinePayload(2)
    removeCommitted.chapters = removeCommitted.chapters.filter((chapter) => chapter.chapterId !== 'ch-1')
    removeCommitted.currentChapterId = 'ch-2'
    removeCommitted.droppedChapterIds = ['ch-1']
    await expect(novels.reviseOutline(novelId, {
      expectedRevision: after!.revision,
      expectedOutlineRevision: after!.outline!.outlineRevision,
      reason: '删除已写章节',
      changes: removeCommitted,
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'committed-chapters', violations: [expect.stringContaining('chapter-missing:ch-1')] })

    const reordered = outlinePayload(2)
    reordered.chapters = [
      { ...reordered.chapters[1]!, order: 1 },
      { ...reordered.chapters[0]!, order: 2 },
    ]
    await expect(novels.reviseOutline(novelId, {
      expectedRevision: after!.revision,
      expectedOutlineRevision: after!.outline!.outlineRevision,
      reason: '重排已写章节',
      changes: reordered,
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', violations: [expect.stringContaining('chapter-reordered:ch-1')] })

    const kept = await novels.reviseOutline(novelId, {
      expectedRevision: after!.revision,
      expectedOutlineRevision: after!.outline!.outlineRevision,
      reason: '保留已写章节，调整后续',
      changes: outlinePayload(2),
      handledRequirements: [],
    })
    expect(kept.outlineRevision).toMatch(/^[0-9a-f]{16}$/)
  }))

  it('revise 章节是覆盖层：省略即保留，显式 droppedChapterIds 才删除（§6.1）', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels, { maxChapters: null })
    const current = await novels.getNovel(novelId)
    const grown = await novels.reviseOutline(novelId, {
      expectedRevision: current!.revision,
      expectedOutlineRevision: outlineRevision,
      reason: '扩为三章',
      changes: outlinePayload(3),
      handledRequirements: [],
    })
    // The 150->12 field regression, now structural: a payload that only
    // echoes the window the model read carries the unwritten rest forward.
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: grown.outlineRevision,
      reason: '只回显读到的窗口',
      changes: outlinePayload(1),
      handledRequirements: [],
    })
    expect((await novels.getNovel(novelId))?.outline?.chapters.map((chapter) => chapter.chapterId)).toEqual(['ch-1', 'ch-2', 'ch-3'])
    // Phantom declarations and declarations that contradict the payload are named.
    const phantom = outlinePayload(3)
    phantom.droppedChapterIds = ['ch-9', 'ch-2']
    await expect(novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: (await novels.getNovel(novelId))!.outline!.outlineRevision,
      reason: '声明了不存在的章节，且 ch-2 仍在载荷中',
      changes: phantom,
      handledRequirements: [],
    })).rejects.toMatchObject({
      rule: 'invalid-chapter-drops',
      violations: expect.arrayContaining([
        expect.stringContaining('drop-not-planned:ch-9'),
        expect.stringContaining('drop-contradicts-payload:ch-2'),
      ]),
    })
    // Declared pruning goes through and really removes the chapters.
    const pruned = outlinePayload(1)
    pruned.droppedChapterIds = ['ch-2', 'ch-3']
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: (await novels.getNovel(novelId))!.outline!.outlineRevision,
      reason: '作者确认砍掉后续两章',
      changes: pruned,
      handledRequirements: [],
    })
    expect((await novels.getNovel(novelId))?.outline?.chapters.map((chapter) => chapter.chapterId)).toEqual(['ch-1'])
  }))

  it('revise 覆盖层：可选字段继承、currentChapterId 可指向保留章节、order 冲突被拒（§6.1）', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels, { maxChapters: null })
    const base = outlinePayload(3)
    const seeded = {
      ...base,
      chapters: [
        ...base.chapters.slice(0, 1),
        { chapterId: 'ch-2', order: 2, title: '第二章', purpose: '铺垫', keyEvents: ['伏笔A', '伏笔B'], plannedCharacters: 4000, entryCondition: '前章结束', exitCondition: '目标达成' },
        ...base.chapters.slice(2),
      ] as typeof base.chapters,
    }
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: outlineRevision,
      reason: '扩为三章并给 ch-2 埋伏笔',
      changes: seeded,
      handledRequirements: [],
    })
    // Upsert ch-2 with omitted keyEvents/plannedCharacters: inherited, not wiped.
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: (await novels.getNovel(novelId))!.outline!.outlineRevision,
      reason: '改写 ch-2 标题',
      changes: { ...outlinePayload(1), chapters: [{ chapterId: 'ch-2', order: 2, title: '第二章（改）', purpose: '强化', entryCondition: '前章结束', exitCondition: '目标达成' }], currentChapterId: 'ch-2' },
      handledRequirements: [],
    })
    let outline = (await novels.getNovel(novelId))!.outline!
    const ch2 = outline.chapters.find((chapter) => chapter.chapterId === 'ch-2')!
    expect(ch2.title).toBe('第二章（改）')
    expect(ch2.keyEvents).toEqual(['伏笔A', '伏笔B'])
    expect(ch2.plannedCharacters).toBe(4000)
    // currentChapterId may point at a chapter only present through carry-forward.
    await novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: outline.outlineRevision,
      reason: '推进到未随载荷提交的章节',
      changes: { ...outlinePayload(1), chapters: [], currentChapterId: 'ch-3' },
      handledRequirements: [],
    })
    expect((await novels.getNovel(novelId))?.outline?.currentChapterId).toBe('ch-3')
    // An inserted chapter colliding with a carried-forward order is rejected with field detail.
    await expect(novels.reviseOutline(novelId, {
      expectedRevision: (await novels.getNovel(novelId))!.revision,
      expectedOutlineRevision: (await novels.getNovel(novelId))!.outline!.outlineRevision,
      reason: 'order 冲突',
      changes: { ...outlinePayload(1), chapters: [{ chapterId: 'ch-4', order: 2, title: '插入章', purpose: 'p', entryCondition: 'x', exitCondition: 'y' }] },
      handledRequirements: [],
    })).rejects.toMatchObject({
      code: 'NOVEL_CONFIG',
      message: expect.stringContaining('invalid outline payload: chapters.order'),
      errors: [expect.objectContaining({ field: 'chapters.order' })],
    })
  }))

  it('初始大纲不接受 droppedChapterIds', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const payload = outlinePayload()
    payload.droppedChapterIds = ['ch-1']
    await expect(novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: payload,
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story' }],
    })).rejects.toMatchObject({ code: 'NOVEL_CONFIG', errors: [{ field: 'droppedChapterIds' }] })
  }))

  it('修订时有已认领单元则拒绝（§9.2）', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    await claimFirstScene(novels, novelId, outlineRevision)
    const current = await novels.getNovel(novelId)
    await expect(novels.reviseOutline(novelId, {
      expectedRevision: current!.revision,
      expectedOutlineRevision: outlineRevision,
      reason: 'claimed 期间不可修订',
      changes: outlinePayload(),
      handledRequirements: [],
    })).rejects.toMatchObject({ code: 'NOVEL_REVISION_CONFLICT' })
  }))

  it('manual 模式：初始 awaiting-approval，大纲版本绑定批准', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig({ approvalMode: 'manual' }))
    let snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('paused')
    expect(snapshot?.run.pauseReason).toBe('awaiting-approval')
    expect(snapshot?.run.awaitingApprovalRevision).toBeNull()
    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied' }],
    })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.pauseReason).toBe('awaiting-approval')
    expect(snapshot?.run.awaitingApprovalRevision).toBe(outlined.outlineRevision)
    // Old revision approval is rejected.
    await expect(novels.approveOutline(created.novelId, { expectedOutlineRevision: 'old' })).rejects.toBeInstanceOf(NovelRevisionConflictError)
    // A pending requirement blocks approval (§4.3).
    const received = await novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: '改结局', sourceKind: 'composer' })
    await expect(novels.approveOutline(created.novelId, { expectedOutlineRevision: outlined.outlineRevision }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'requirements-unprocessed' })
    // requestRevision authorizes one planning pass (§4.3) ...
    await novels.requestRevision(created.novelId)
    expect((await novels.getNovel(created.novelId))?.run.status).toBe('active')
    const revised = await novels.reviseOutline(created.novelId, {
      expectedRevision: (await novels.getNovel(created.novelId))!.revision,
      expectedOutlineRevision: outlined.outlineRevision,
      reason: '按新要求调整',
      changes: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-2', result: 'applied' }],
    })
    // ... and the revision re-enters awaiting-approval bound to the new version.
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.pauseReason).toBe('awaiting-approval')
    expect(snapshot?.run.awaitingApprovalRevision).toBe(revised.outlineRevision)
    await expect(novels.approveOutline(created.novelId, { expectedOutlineRevision: outlined.outlineRevision })).rejects.toBeInstanceOf(NovelRevisionConflictError)
    await novels.approveOutline(created.novelId, { expectedOutlineRevision: revised.outlineRevision })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('active')
    expect(snapshot?.run.phase).toBe('writing')
    expect(received.duplicate).toBe(false)
  }))
})

describe('NovelStore 单元与提交（§6.2/§10.3/§10.4）', () => {
  it('认领前置：pending 指令与暂停状态阻止认领', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels)
    await novels.receiveRequirement(novelId, { hostMessageId: 'm-2', text: '改视角', sourceKind: 'composer' })
    const outlineRevision = (await novels.getNovel(novelId))!.outline!.outlineRevision
    const { unitId } = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'l', goal: 'g' })
    await expect(novels.claimUnit(novelId, { unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'requirements-unprocessed' })
    await expect(novels.claimUnit(novelId, { unitId, expectedOutlineRevision: 'wrong', expectedRequirementSequence: 1, hostTurn: 1 }))
      .rejects.toMatchObject({ code: 'NOVEL_REVISION_CONFLICT' })
    await novels.pause(novelId, { reason: 'user-request' })
    await expect(novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: 'l2', goal: 'g' }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'not-active' })
    await expect(novels.claimUnit(novelId, { unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'not-active' })
  }))

  it('同场次在途单元幂等：prepared/claimed 都返回既有单元，commit 后续段仍可开新单元', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    const prepared = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
    // Prepared idempotency (unchanged).
    await expect(novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '重复', goal: 'g' }))
      .resolves.toEqual({ unitId: prepared.unitId })

    // Regression: while the unit is claimed (turn ended without a commit), a
    // re-driven prepare for the same scene must NOT create a duplicate unit —
    // the stranded duplicate later fails finish-guards as unit-in-flight.
    const claim = await novels.claimUnit(novelId, { unitId: prepared.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 })
    expect(claim.attempt).toBe(1)
    const whileClaimed = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '重复', goal: 'g' })
    expect(whileClaimed.unitId).toBe(prepared.unitId)
    let snapshot = await novels.getNovel(novelId)
    expect(snapshot?.units).toHaveLength(1)

    // Continuation still works: after the commit, a fresh unit may be prepared.
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['第一段事实。'],
      sceneCompletion: { completed: false, basis: '场景延续', outstandingGoals: ['次日行动'], nextAnchor: '清晨' },
      canonChanges: [],
    })
    const continuation = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '续段', goal: '次日行动', continuationAnchor: '清晨' })
    expect(continuation.unitId).not.toBe(prepared.unitId)
    snapshot = await novels.getNovel(novelId)
    expect(snapshot?.units).toHaveLength(2)
  }))

  it('提交往返：令牌、计数、readBody 坐标、重复与令牌错误', withStores(async (tavern, novels, root) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    const prepared = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
    // Preparing the same scene while still prepared is idempotent.
    const duplicatePrepare = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '开场', goal: '发现异象' })
    expect(duplicatePrepare.unitId).toBe(prepared.unitId)
    const claim = await novels.claimUnit(novelId, { unitId: prepared.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 1 })
    expect(claim.attempt).toBe(1)
    const paragraphs = ['风暴之夜，海面泛起不祥的光。', '守塔人握紧了栏杆。']
    const receipt = await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs,
      sceneCompletion: { completed: true, basis: '异象确认', outstandingGoals: [], nextAnchor: '次日清晨' },
      canonChanges: [{ kind: 'event', summary: '发现海面异象', sources: ['commit-1#0', 'commit-1#1'] }],
    })
    expect(receipt.duplicate).toBe(false)
    expect(receipt.effectiveCharacters).toBe(12 + 8) // two CJK paragraphs
    expect(receipt.totalCharacters).toBe(receipt.effectiveCharacters)
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.units.find((u) => u.unitId === claim.unitId)?.state).toBe('committed')
    expect(snapshot?.commits).toHaveLength(1)
    expect(snapshot?.run.currentUnitId).toBeNull()

    // Same business content retry replays the original receipt.
    const retry = await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs,
      sceneCompletion: { completed: true, basis: '异象确认', outstandingGoals: [], nextAnchor: '次日清晨' },
      canonChanges: [{ kind: 'event', summary: '发现海面异象', sources: ['commit-1#0', 'commit-1#1'] }],
    })
    expect(retry.duplicate).toBe(true)
    expect(retry.commitId).toBe(receipt.commitId)
    expect((await novels.getNovel(novelId))?.commits).toHaveLength(1)

    // Different content for the same unit is a duplicate commit error.
    await expect(novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['不同的内容'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toMatchObject({ code: 'NOVEL_DUPLICATE_COMMIT', existingCommitId: receipt.commitId })

    // Claiming an already committed unit is stale.
    await expect(novels.claimUnit(novelId, { unitId: claim.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 2 }))
      .rejects.toBeInstanceOf(NovelStaleUnitError)

    // Token and body checks target a fresh claimed unit (§10.3: the receipt
    // check above must not mask these for uncommitted units).
    const fresh = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '续段', goal: 'g' })
    const freshClaim = await novels.claimUnit(novelId, { unitId: fresh.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 2 })
    await expect(novels.commitBody(novelId, {
      unitId: fresh.unitId,
      executionToken: 'wrong-token',
      paragraphs: ['正文'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toBeInstanceOf(NovelStaleUnitError)

    // Empty / blank-only bodies are refused (§6.3).
    await expect(novels.commitBody(novelId, {
      unitId: fresh.unitId,
      executionToken: freshClaim.executionToken,
      paragraphs: [],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'empty-body' })
    await expect(novels.commitBody(novelId, {
      unitId: fresh.unitId,
      executionToken: freshClaim.executionToken,
      paragraphs: ['  \n\t'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'empty-body' })

    // readBody with coordinates and pagination.
    const body = await novels.readBody(novelId, { chapterId: 'ch-1' })
    expect(body.paragraphs.map((p) => p.text)).toEqual(paragraphs)
    expect(body.paragraphs.map((p) => `${p.commitId}#${p.paragraphIndex}`)).toEqual(['commit-1#0', 'commit-1#1'])
    expect(body.nextCursor).toBeNull()
    const paged = await novels.readBody(novelId, { limit: 1 })
    expect(paged.paragraphs).toHaveLength(1)
    expect(paged.nextCursor).toBe('1')
    expect((await novels.readBody(novelId, { cursor: '1' })).paragraphs[0]?.text).toBe(paragraphs[1])
    expect(await novels.bodyHashOf(novelId, receipt.commitId)).toBe(receipt.bodyHash)
    expect(await novels.bodyHashOf(novelId, 'commit-404')).toBeNull()
    const bodyFile = path.join(root, 'novels', novelId, 'bodies', `${receipt.bodyHash}.txt`)
    expect(await readFile(bodyFile, 'utf8')).toBe(paragraphs.join('\n\n'))
  }))

  it('正典来源必须落在本次或此前已提交正文（§8.2）；supersedeUnit 生命周期', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['第一段事实。'],
      sceneCompletion: { completed: false, basis: '场景延续', outstandingGoals: ['次日行动'], nextAnchor: '清晨' },
      canonChanges: [{ kind: 'event', summary: '事实一', sources: ['commit-1#0'] }],
    })
    // Continuation fragment unit for the same scene.
    const next = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '续段', goal: '次日行动', continuationAnchor: '清晨' })
    expect(next.unitId).not.toBe(claim.unitId)
    const nextClaim = await novels.claimUnit(novelId, { unitId: next.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 2 })
    await expect(novels.commitBody(novelId, {
      unitId: next.unitId,
      executionToken: nextClaim.executionToken,
      paragraphs: ['第二段事实。'],
      sceneCompletion: { completed: true, basis: '场景完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [{ kind: 'relation', summary: '引用越界段落', sources: ['commit-1#5'] }],
    })).rejects.toBeInstanceOf(NovelConfigError)
    await expect(novels.commitBody(novelId, {
      unitId: next.unitId,
      executionToken: nextClaim.executionToken,
      paragraphs: ['第二段事实。'],
      sceneCompletion: { completed: true, basis: '场景完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [{ kind: 'event', summary: '引用未知提交', sources: ['commit-99#0'] }],
    })).rejects.toBeInstanceOf(NovelConfigError)
    const receipt = await novels.commitBody(novelId, {
      unitId: next.unitId,
      executionToken: nextClaim.executionToken,
      paragraphs: ['第二段事实。'],
      sceneCompletion: { completed: true, basis: '场景完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [
        { kind: 'event', summary: '引用自身', sources: ['commit-2#0'] },
        { kind: 'character-state', summary: '引用此前', sources: ['commit-1#0'] },
      ],
    })
    expect(receipt.duplicate).toBe(false)

    // supersedeUnit: prepared -> superseded; committed units cannot be superseded.
    const third = await novels.prepareUnit(novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '废弃', goal: 'g' })
    await novels.supersedeUnit(novelId, { unitId: third.unitId, reason: '计划变更' })
    expect((await novels.getNovel(novelId))?.units.find((u) => u.unitId === third.unitId)?.state).toBe('superseded')
    await expect(novels.supersedeUnit(novelId, { unitId: claim.unitId, reason: 'r' }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'unit-not-prepared' })
  }))

  it('硬上限：超限提交被拒且候选不落盘', withStores(async (tavern, novels, root) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels, {
      lengthBudget: { kind: 'target', targetCharacters: 20, toleranceRatio: 0.1, hardMaximumCharacters: 25 },
    })
    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    const longParagraphs = ['夜'.repeat(30)]
    await expect(novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: longParagraphs,
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toMatchObject({ code: 'NOVEL_LENGTH_LIMIT', hardMaximum: 25 })
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.commits).toHaveLength(0)
    const bodiesDir = path.join(root, 'novels', novelId, 'bodies')
    const files = await readdir(bodiesDir).catch(() => [] as string[])
    expect(files).toEqual([])
    // The unit stays claimable with a shorter body.
    const receipt = await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['夜色渐深。'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    expect(receipt.effectiveCharacters).toBe(4)
  }))
})

describe('NovelStore 章节与完成（§6.2/§7.3）', () => {
  it('completeChapter CAS 与空章拒绝；finish 守卫给出 violations', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    await expect(novels.completeChapter(novelId, { chapterId: 'ch-1', expectedContentRevision: 'stale', basis: 'b', openItems: [] }))
      .rejects.toMatchObject({ code: 'NOVEL_REVISION_CONFLICT' })
    await expect(novels.completeChapter(novelId, { chapterId: 'ch-1', expectedContentRevision: (await novels.getNovel(novelId))!.contentRevision, basis: 'b', openItems: [] }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'chapter-empty' })

    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['他在灯下写完了最后一页日志。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    const beforeChapter = await novels.getNovel(novelId)
    await novels.completeChapter(novelId, { chapterId: 'ch-1', expectedContentRevision: beforeChapter!.contentRevision, basis: '主线完成', openItems: [] })
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.completedChapters).toHaveLength(1)
    expect(snapshot?.run.phase).toBe('finishing')
    await expect(novels.completeChapter(novelId, { chapterId: 'ch-1', expectedContentRevision: snapshot!.contentRevision, basis: 'again', openItems: [] }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'chapter-completed' })
  }))

  it('完成守卫：伏笔必须回收、指令处理完毕、无在途单元、字数达标', withStores(async (tavern, novels) => {
    // Required foreshadowing left open blocks finishing (§7.3).
    const strictCreated = await novels.createNovel(tavern, baseConfig({ title: '伏笔篇' }))
    const strictOutlined = await novels.createOutline(strictCreated.novelId, {
      expectedRevision: strictCreated.revision,
      outline: outlinePayload(1, true),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied' }],
    })
    const claimStrict = await claimFirstScene(novels, strictCreated.novelId, strictOutlined.outlineRevision)
    await novels.commitBody(strictCreated.novelId, {
      unitId: claimStrict.unitId,
      executionToken: claimStrict.executionToken,
      paragraphs: ['他看见了沉船的桅杆。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(strictCreated.novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(strictCreated.novelId))!.contentRevision,
      basis: '完成',
      openItems: [],
    })
    await expect(novels.finishNovel(strictCreated.novelId, { expectedRevision: (await novels.getNovel(strictCreated.novelId))!.revision, basis: '完成' }))
      .rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'finish-guards', violations: [expect.stringContaining('foreshadowing-unresolved:f-1')] })

    // A requirement received before finishing blocks completion (§18 完成竞争).
    const blocked = await startedNovel(tavern, novels, { title: '守卫篇' })
    const claimBlocked = await claimFirstScene(novels, blocked.novelId, blocked.outlineRevision)
    await novels.commitBody(blocked.novelId, {
      unitId: claimBlocked.unitId,
      executionToken: claimBlocked.executionToken,
      paragraphs: ['风暴过去。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(blocked.novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(blocked.novelId))!.contentRevision,
      basis: '完成',
      openItems: [],
    })
    await novels.receiveRequirement(blocked.novelId, { hostMessageId: 'm-2', text: '改结尾', sourceKind: 'composer' })
    await expect(novels.finishNovel(blocked.novelId, { expectedRevision: (await novels.getNovel(blocked.novelId))!.revision, basis: '完成' }))
      .rejects.toMatchObject({ violations: [expect.stringContaining('requirement-unprocessed:req-2')] })

    // In-flight (prepared) units block finishing.
    const inflight = await startedNovel(tavern, novels, { title: '在途篇' })
    const claimInflight = await claimFirstScene(novels, inflight.novelId, inflight.outlineRevision)
    await novels.commitBody(inflight.novelId, {
      unitId: claimInflight.unitId,
      executionToken: claimInflight.executionToken,
      paragraphs: ['收尾之前。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(inflight.novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(inflight.novelId))!.contentRevision,
      basis: '完成',
      openItems: [],
    })
    await novels.prepareUnit(inflight.novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '多余单元', goal: 'g' })
    await expect(novels.finishNovel(inflight.novelId, { expectedRevision: (await novels.getNovel(inflight.novelId))!.revision, basis: '完成' }))
      .rejects.toMatchObject({ violations: [expect.stringContaining('unit-in-flight')] })

    // Length out of band.
    const short = await startedNovel(tavern, novels, { title: '字数篇', lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: null } })
    const claimShort = await claimFirstScene(novels, short.novelId, short.outlineRevision)
    await novels.commitBody(short.novelId, {
      unitId: claimShort.unitId,
      executionToken: claimShort.executionToken,
      paragraphs: ['太短了'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(short.novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(short.novelId))!.contentRevision,
      basis: '完成',
      openItems: [],
    })
    await expect(novels.finishNovel(short.novelId, { expectedRevision: (await novels.getNovel(short.novelId))!.revision, basis: '完成' }))
      .rejects.toMatchObject({ violations: [expect.stringContaining('length-out-of-budget')] })

    // Happy path: unbounded, foreshadowing optional.
    const happy = await startedNovel(tavern, novels, { title: '完成篇' })
    const claimHappy = await claimFirstScene(novels, happy.novelId, happy.outlineRevision)
    const receipt = await novels.commitBody(happy.novelId, {
      unitId: claimHappy.unitId,
      executionToken: claimHappy.executionToken,
      paragraphs: ['黎明终于到来，守塔人放下了望远镜。'],
      sceneCompletion: { completed: true, basis: '完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(happy.novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(happy.novelId))!.contentRevision,
      basis: '完成',
      openItems: [],
    })
    const finished = await novels.finishNovel(happy.novelId, { expectedRevision: (await novels.getNovel(happy.novelId))!.revision, basis: '短篇完成' })
    expect(finished.totalCharacters).toBe(receipt.effectiveCharacters)
    const snapshot = await novels.getNovel(happy.novelId)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.completedAt).toBeTruthy()
    expect((await novels.listNovels()).find((s) => s.novelId === happy.novelId)?.status).toBe('completed')
  }))
})

describe('NovelStore 运行状态（§12/§13）', () => {
  it('工作意图幂等，resolve 后可再登记', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels)
    const first = await novels.recordWorkIntent(novelId, { kind: 'write-unit' })
    const second = await novels.recordWorkIntent(novelId, { kind: 'finish' })
    expect(second.intentId).toBe(first.intentId)
    expect(second.revision).toBe(first.revision)
    await novels.resolveWorkIntent(novelId, { intentId: first.intentId, outcome: 'delivered' })
    expect((await novels.getNovel(novelId))?.run.inFlightIntent).toBeNull()
    const third = await novels.recordWorkIntent(novelId, { kind: 'chapter-complete' })
    expect(third.intentId).not.toBe(first.intentId)
    await novels.resolveWorkIntent(novelId, { intentId: third.intentId, outcome: 'failed', error: 'boom' })
    expect((await novels.getNovel(novelId))?.run.lastError).toBe('boom')
    // Unknown intent resolution is an idempotent no-op.
    await novels.resolveWorkIntent(novelId, { intentId: 'wi-unknown', outcome: 'cancelled' })
  }))

  it('noteTurn 超阈值自动暂停，noteProgress 重置停滞', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig({
      budgets: { ...baseConfig().budgets, stallThresholdTurns: 2, maxTurns: 5, consecutiveFailureLimit: 2 },
    }))
    await novels.noteTurn(created.novelId, { failed: false })
    await novels.noteProgress(created.novelId, { signature: 'outline-created' })
    await novels.noteTurn(created.novelId, { failed: false })
    let snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.stalledTurns).toBe(1)
    await novels.noteTurn(created.novelId, { failed: false })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('paused')
    expect(snapshot?.run.pauseReason).toBe('stalled')
    await novels.resume(created.novelId)
    await novels.noteTurn(created.novelId, { failed: true, error: 'request failed' })
    await novels.noteTurn(created.novelId, { failed: true, error: 'request failed again' })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.pauseReason).toBe('budget')
    expect(snapshot?.run.lastError).toBe('request failed again')
  }))

  it('noteDeduceRun 累计推演次数，越过 maxDeduceRuns 自动 paused(budget)', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels, { budgets: { ...baseConfig().budgets, maxDeduceRuns: 2 } })
    await novels.noteDeduceRun(novelId)
    expect((await novels.getNovel(novelId))?.run.deduceRuns).toBe(1)
    await novels.noteDeduceRun(novelId)
    const snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.deduceRuns).toBe(2)
    expect(snapshot?.run.status).toBe('paused')
    expect(snapshot?.run.pauseReason).toBe('budget')
  }))

  it('stop 撤销令牌：原令牌提交被拒，单元回 prepared 并可重新认领', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    await novels.stop(novelId)
    let snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.pauseReason).toBe('stopped')
    const unit = snapshot?.units.find((u) => u.unitId === claim.unitId)
    expect(unit?.state).toBe('prepared')
    expect(unit?.attempt).toBe(2)
    expect(unit?.executionTokenHash).toBeNull()
    await expect(novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['迟到的正文'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })).rejects.toBeInstanceOf(NovelStaleUnitError)
    await novels.resume(novelId)
    const reclaimer = await novels.claimUnit(novelId, { unitId: claim.unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1, hostTurn: 3 })
    expect(reclaimer.attempt).toBe(3)
    const receipt = await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: reclaimer.executionToken,
      paragraphs: ['重新认领后的正文。'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    expect(receipt.duplicate).toBe(false)
    snapshot = await novels.getNovel(novelId)
    expect(snapshot?.commits).toHaveLength(1)
  }))

  it('resume：awaiting-approval 引导至批准/更新大纲，其余暂停可恢复', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig({ approvalMode: 'manual' }))
    await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied' }],
    })
    await expect(novels.resume(created.novelId)).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'awaiting-approval' })
    const paused = await startedNovel(tavern, novels)
    await novels.pause(paused.novelId, { reason: 'user-request', detail: '先停一下' })
    const resumed = await novels.resume(paused.novelId)
    const snapshot = await novels.getNovel(paused.novelId)
    expect(snapshot?.run.status).toBe('active')
    expect(resumed.revision).toBe(snapshot?.revision)
    await expect(novels.resume(paused.novelId)).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION', rule: 'not-paused' })
  }))
})

describe('NovelStore 崩溃窗口（§10.3）', () => {
  it('孤儿对象不影响读取；HEAD 只见完整旧/新状态或损坏报错', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const oldRevision = created.revision
    const dir = path.join(root, 'novels', created.novelId)
    const received = await novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: '加情节', sourceKind: 'composer' })
    expect(received.revision).not.toBe(oldRevision)

    // Orphan immutable objects (written, revision/HEAD not) are invisible.
    await writeFile(path.join(dir, 'bodies', `${'a'.repeat(64)}.txt`), 'orphan', 'utf8')
    await writeFile(path.join(dir, 'revisions', `${'b'.repeat(16)}.json`), '{"orphan":true}', 'utf8')
    expect((await novels.getNovel(created.novelId))?.revision).toBe(received.revision)

    // Simulate "revision published but HEAD replacement interrupted": HEAD
    // still points at the old, complete revision.
    await writeFile(path.join(dir, 'HEAD.json'), JSON.stringify({ novelId: created.novelId, revision: oldRevision, schemaVersion: 1, updatedAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
    const rolledBack = await novels.getNovel(created.novelId)
    expect(rolledBack?.revision).toBe(oldRevision)
    expect(rolledBack?.requirements).toHaveLength(1)

    // HEAD pointing at a missing revision is corruption, never half state.
    await writeFile(path.join(dir, 'HEAD.json'), JSON.stringify({ novelId: created.novelId, revision: `${'c'.repeat(16)}`, schemaVersion: 1, updatedAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
    await expect(novels.getNovel(created.novelId)).rejects.toBeInstanceOf(NovelStorageCorruptionError)

    // Corrupt HEAD payload is corruption.
    await writeFile(path.join(dir, 'HEAD.json'), 'not-json{{', 'utf8')
    await expect(novels.getNovel(created.novelId)).rejects.toMatchObject({ code: 'NOVEL_STORAGE_CORRUPTION' })

    // Corrupt referenced revision file is corruption.
    const head = { novelId: created.novelId, revision: received.revision, schemaVersion: 1, updatedAt: '2026-09-16T00:00:00.000Z' }
    await writeFile(path.join(dir, 'HEAD.json'), JSON.stringify(head), 'utf8')
    await writeFile(path.join(dir, 'revisions', `${received.revision}.json`), '{broken', 'utf8')
    await expect(novels.getNovel(created.novelId)).rejects.toBeInstanceOf(NovelStorageCorruptionError)
    await expect(novels.listNovels()).rejects.toBeInstanceOf(NovelStorageCorruptionError)
    await expect(novels.readBody('nvl-missing', {})).rejects.toBeInstanceOf(NovelNotFoundError)
  }))

  it('投影异步生成且可等待（正文权威不受投影影响）', withStores(async (tavern, novels, root) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['投影测试段落。'],
      sceneCompletion: { completed: true, basis: 'b', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    const statusPath = path.join(root, 'novels', novelId, 'projections', 'status.json')
    await waitFor(async () => {
      try {
        const status = JSON.parse(await readFile(statusPath, 'utf8')) as { effectiveCharacters?: number }
        return status.effectiveCharacters === 6
      } catch {
        return false
      }
    })
    const chapter = await readFile(path.join(root, 'novels', novelId, 'projections', 'chapters', 'ch-1.md'), 'utf8')
    expect(chapter).toContain('# 第1章')
    expect(chapter).toContain('投影测试段落。')
  }))
})

describe('NovelStore 所有权（§10.2）', () => {
  it('同 pid 异 bootId 视为已消亡写者，自动接管', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const ownerPath = path.join(root, 'novels', created.novelId, '.owner.json')
    // 本进程所有存活模块共享 BOOT_ID，同 pid 异 bootId 只能来自早已退出的写者。
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, bootId: 'someone-else', acquiredAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
    await expect(novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
      .resolves.toMatchObject({ duplicate: false })
  }))

  it('死 pid 自动接管', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const ownerPath = path.join(root, 'novels', created.novelId, '.owner.json')
    await writeFile(ownerPath, JSON.stringify({ pid: 0x7ffffffe, bootId: 'dead-writer', acquiredAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
    await expect(novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
      .resolves.toMatchObject({ duplicate: false })
  }))

  it('pid 被非 dsh 进程复用时自动接管', { timeout: 30_000 }, withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const recycled = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
    try {
      const ownerPath = path.join(root, 'novels', created.novelId, '.owner.json')
      await writeFile(ownerPath, JSON.stringify({ pid: recycled.pid, bootId: 'recycled', acquiredAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
      await expect(novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
        .resolves.toMatchObject({ duplicate: false })
    } finally {
      recycled.kill()
    }
  }))

  it('pid 仍为存活 dsh 宿主时拒绝写入，读不受影响', { timeout: 30_000 }, withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    // 命令行形状为 `node …/dsh web` 的常驻进程冒充另一宿主。
    const standin = path.join(root, 'dsh')
    await writeFile(standin, 'setInterval(() => {}, 1e9)\n', 'utf8')
    const host = spawn(process.execPath, [standin, 'web'], { stdio: 'ignore' })
    try {
      const ownerPath = path.join(root, 'novels', created.novelId, '.owner.json')
      await writeFile(ownerPath, JSON.stringify({ pid: host.pid, bootId: 'other-host', acquiredAt: '2026-09-16T00:00:00.000Z' }), 'utf8')
      await expect(novels.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
        .rejects.toMatchObject({ code: 'NOVEL_OWNERSHIP', alive: true })
      await expect(novels.deleteNovel(created.novelId)).rejects.toBeInstanceOf(NovelOwnershipError)
      // Reads do not need the write lock.
      expect((await novels.getNovel(created.novelId))?.novelId).toBe(created.novelId)
    } finally {
      host.kill()
    }
  }))

  it('同进程多实例可重入', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const secondInstance = await NovelStore.open(root)
    await expect(secondInstance.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
      .resolves.toMatchObject({ duplicate: false })
  }))

  it('同进程多 bundle 副本可重入（index.mjs/novel.mjs 双入口回归）', withStores(async (tavern, novels, root) => {
    const created = await novels.createNovel(tavern, baseConfig())
    // 构建把 tavern-store 分别打进 index.mjs 与 novel.mjs：query import 模拟
    // 同一进程里的第二份模块注册表（novel-open 在 index 副本建小说，作者
    // 工具在 novel 副本写入）。副本各持模块级常量时这里会以同 pid 被拒。
    const specifier = '../src/novel.js?second-bundle'
    const bundled = (await import(specifier)) as typeof import('../src/novel.js')
    const secondBundle = await bundled.NovelStore.open(root)
    await expect(secondBundle.receiveRequirement(created.novelId, { hostMessageId: 'm-2', text: 'x', sourceKind: 'composer' }))
      .resolves.toMatchObject({ duplicate: false })
  }))
})

describe('agent-novel 会话绑定接线', () => {
  it('normalizeTavernSessionBinding：novelId 为身份，缺失回退，未知架构仍降级 st', () => {
    const binding = normalizeTavernSessionBinding({ architecture: 'agent-novel', novelId: 'nvl-x', character: '', chatId: '' })
    expect(binding?.architecture).toBe('agent-novel')
    if (binding?.architecture === 'agent-novel') {
      expect(binding.novelId).toBe('nvl-x')
      expect(binding.character).toBe('')
      expect(binding.chatId).toBe('')
    }
    expect(normalizeTavernSessionBinding({ architecture: 'agent-novel', character: 'c', chatId: 'c1' })).toBeUndefined()
    expect(normalizeTavernSessionBinding({ architecture: 'agent-novel', novelId: '  ', character: 'c', chatId: 'c1' })).toBeUndefined()
    expect(normalizeTavernSessionBinding({ architecture: 'weird', character: 'c', chatId: 'c1' })?.architecture).toBe('st')
    expect(normalizeTavernSessionBinding({ character: 'c', chatId: 'c1' })?.architecture).toBe('st')
  })

  it('绑定经 TavernState 持久化往返', withStores(async (tavern) => {
    const binding = normalizeTavernSessionBinding({ architecture: 'agent-novel', novelId: 'nvl-persist', character: '', chatId: '' })
    expect(binding).toBeDefined()
    await tavern.updateState((state) => ({ sessionBindings: { ...state.sessionBindings, 'sess-novel': binding! } }))
    const restored = (await tavern.getState()).sessionBindings['sess-novel']
    expect(restored?.architecture).toBe('agent-novel')
    if (restored?.architecture === 'agent-novel') expect(restored.novelId).toBe('nvl-persist')
  }))
})


describe('NovelStore readAsset（纯读，§5/§15）', () => {
  it('只解析当前快照引用的哈希；源资产删除后快照仍可读', withStores(async (tavern, novels) => {
    await tavern.importCharacter(sampleCard)
    const created = await novels.createNovel(tavern, baseConfig({ characterNames: ['Test Char'], worldNames: ['Embedded Lore'] }))
    const snapshot = await novels.getNovel(created.novelId)
    const character = snapshot?.assets.find((asset) => asset.kind === 'character')
    const world = snapshot?.assets.find((asset) => asset.kind === 'world')
    expect(character).toBeDefined()
    expect(world).toBeDefined()
    const card = (await novels.readAsset(created.novelId, character!.contentHash)) as { data?: { name?: string } }
    expect(card.data?.name).toBe('Test Char')
    const book = (await novels.readAsset(created.novelId, world!.contentHash)) as { entries?: unknown }
    expect(Array.isArray(book.entries)).toBe(true)
    await expect(novels.readAsset(created.novelId, '0'.repeat(64))).rejects.toMatchObject({ code: 'NOVEL_PRECONDITION' })
    await expect(novels.readAsset(created.novelId, 'not-a-hash')).rejects.toMatchObject({ code: 'NOVEL_CONFIG' })
    await expect(novels.readAsset('nvl-missing', character!.contentHash)).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
    await tavern.deleteCharacter('Test Char')
    await tavern.deleteWorld('Embedded Lore')
    const reread = (await novels.readAsset(created.novelId, character!.contentHash)) as { data?: { name?: string } }
    expect(reread.data?.name).toBe('Test Char')
  }))

  it('§13 duration budget counts active windows only: pause/host-down time is excluded', withStores(async (tavern, novels) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const created = await novels.createNovel(tavern, baseConfig({ budgets: {
      maxTurns: 100, maxDurationMs: 150, stallThresholdTurns: 10, consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 2, backoffMs: 5 }, maxDeduceRuns: 5,
    } }))
    let snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run).toMatchObject({ status: 'active', activeWindowStart: expect.any(String) })

    // Active time below the budget keeps the run active.
    await sleep(60)
    await novels.noteTurn(created.novelId, { failed: false })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('active')

    // A pause folds the open window and closes it; the paused span (a user
    // pause, or an overnight host shutdown in production) never consumes
    // budget, so the resume inherits only what was actually active.
    await novels.pause(created.novelId, { reason: 'user-request' })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.activeWindowStart).toBeNull()
    expect(snapshot?.run.activeDurationMs ?? 0).toBeGreaterThanOrEqual(50)
    await sleep(300)
    await novels.resume(created.novelId)
    await novels.noteTurn(created.novelId, { failed: false })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('active')
    expect(snapshot?.run.pauseReason).toBeNull()
    // An explicit resume grants a fresh full duration allowance.
    expect(snapshot?.run.activeDurationMs).toBe(0)

    // Exceeding the budget inside a fresh active window still pauses.
    await sleep(200)
    await novels.noteTurn(created.novelId, { failed: false })
    snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run).toMatchObject({ status: 'paused', pauseReason: 'budget' })
    expect(snapshot?.run.pauseDetail).toBe('max duration reached')
  }))

  it('§13 lastError is a live health signal: failed turns set it, the next successful turn clears it', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    await novels.noteTurn(created.novelId, { failed: true, error: 'turn ended with stop reason aborted' })
    expect((await novels.getNovel(created.novelId))?.run.lastError).toBe('turn ended with stop reason aborted')
    // Real-machine zombie: the run recovered (resume + kick) and turns
    // completed, yet the UI kept showing the stale aborted error.
    await novels.noteTurn(created.novelId, { failed: false })
    expect((await novels.getNovel(created.novelId))?.run.lastError).toBeNull()
    // A failure without a message keeps the previous trail.
    await novels.noteTurn(created.novelId, { failed: true })
    expect((await novels.getNovel(created.novelId))?.run.lastError).toBeNull()
  }))

  it('§13 legacy snapshots without window fields are amnestied, never charged wall-clock', withStores(async (tavern, novels, root) => {
    // Real-machine migration trap (2026-09-18): the first new-code pause of a
    // legacy snapshot folded startedAt→now wall-clock into activeDurationMs,
    // freezing the overnight host downtime as writing debt and re-pausing
    // every resumed turn. Legacy history is amnestied instead.
    const created = await novels.createNovel(tavern, baseConfig({ budgets: {
      maxTurns: 100, maxDurationMs: 100, stallThresholdTurns: 10, consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 2, backoffMs: 5 }, maxDeduceRuns: 5,
    } }))
    await novels.noteTurn(created.novelId, { failed: false })
    const head = JSON.parse(await readFile(path.join(root, 'novels', created.novelId, 'HEAD.json'), 'utf8')) as { revision: string }
    const revPath = path.join(root, 'novels', created.novelId, 'revisions', `${head.revision}.json`)
    const revision = JSON.parse(await readFile(revPath, 'utf8')) as { snapshot: { run: Record<string, unknown> } }
    delete revision.snapshot.run.activeWindowStart
    delete revision.snapshot.run.activeDurationMs
    revision.snapshot.run.startedAt = '2020-01-01T00:00:00.000Z'
    await writeFile(revPath, JSON.stringify(revision))
    await novels.noteTurn(created.novelId, { failed: false })
    const snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.run.status).toBe('active')
    expect(snapshot?.run.pauseReason).toBeNull()
  }))
})

/** One W0 usage sampling point fixture (0007 §7): distinct per turn. */
function usageSample(turn: number, overrides?: Partial<NovelUsageSample>): NovelUsageSample {
  return {
    recordedAt: `2026-09-18T00:00:${String(turn % 60).padStart(2, '0')}.000Z`,
    turn,
    toolBytes: { novel_outline_read: turn * 10 },
    ...overrides,
  }
}

describe('NovelStore 写手模式与用量采样（0007 §7/§8）', () => {
  it('writerMode：缺省归一化 inline，显式 subagent 落盘，非法值拒绝创建', withStores(async (tavern, novels) => {
    const plain = await novels.createNovel(tavern, baseConfig())
    expect((await novels.getNovel(plain.novelId))?.config.writerMode).toBe('inline')

    const delegated = await novels.createNovel(tavern, baseConfig({ writerMode: 'subagent' }))
    const snapshot = await novels.getNovel(delegated.novelId)
    expect(snapshot?.config.writerMode).toBe('subagent')
    // New runs carry the W0 observation counters from the start.
    expect(snapshot?.run.writerRuns).toBe(0)
    expect(snapshot?.run.usageSamples).toEqual([])

    await expect(novels.createNovel(tavern, baseConfig({ writerMode: 'hybrid' as NovelCreateConfig['writerMode'] })))
      .rejects.toMatchObject({ code: 'NOVEL_CONFIG', errors: [expect.objectContaining({ field: 'writerMode' })] })
  }))

  it('patchNovelMeta 切换 writerMode，非法值报 ValidationError（0007 §8）', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const patched = await novels.patchNovelMeta(created.novelId, {
      expectedRevision: created.revision,
      patch: { writerMode: 'subagent' },
      cause: 'switch-writer-mode',
    })
    const snapshot = await novels.getNovel(created.novelId)
    expect(snapshot?.config.writerMode).toBe('subagent')
    expect(snapshot?.revision).toBe(patched.revision)
    // Other config fields survive the mode switch untouched.
    expect(snapshot?.config.title).toBe('灯塔')

    await expect(novels.patchNovelMeta(created.novelId, {
      expectedRevision: patched.revision,
      patch: { writerMode: 'hybrid' as NovelCreateConfig['writerMode'] },
      cause: 'bad-writer-mode',
    })).rejects.toMatchObject({ code: 'NOVEL_CONFIG', errors: [expect.objectContaining({ field: 'writerMode' })] })
    expect((await novels.getNovel(created.novelId))?.config.writerMode).toBe('subagent')
  }))

  it('patchNovelMeta 透传 budgets.writerDispatchLimit，非法值报 ValidationError（0007 §5.3）', withStores(async (tavern, novels) => {
    const created = await novels.createNovel(tavern, baseConfig())
    const base = (await novels.getNovel(created.novelId))!.config.budgets
    const patched = await novels.patchNovelMeta(created.novelId, {
      expectedRevision: created.revision,
      patch: { budgets: { ...base, writerDispatchLimit: 1 } },
      cause: 'tighten-writer-dispatch',
    })
    expect((await novels.getNovel(created.novelId))?.config.budgets.writerDispatchLimit).toBe(1)
    await expect(novels.patchNovelMeta(created.novelId, {
      expectedRevision: patched.revision,
      patch: { budgets: { ...base, writerDispatchLimit: 0 } },
      cause: 'bad-writer-dispatch',
    })).rejects.toMatchObject({ code: 'NOVEL_CONFIG', errors: [expect.objectContaining({ field: 'budgets.writerDispatchLimit' })] })
  }))

  it('noteWriterRun 只计数不封顶，completed 短路（0007 §7）', withStores(async (tavern, novels) => {
    const { novelId, outlineRevision } = await startedNovel(tavern, novels)
    // baseConfig caps maxDeduceRuns at 5: six writer runs past it prove the
    // counter shares no hard cap with the deduce budget (proposal §7 — hard
    // edges stay with maxTurns/maxDurationMs, NovelRunBudgets gains no limit).
    for (let i = 0; i < 6; i++) await novels.noteWriterRun(novelId)
    let snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.writerRuns).toBe(6)
    expect(snapshot?.run.status).toBe('active')
    expect(snapshot?.run.pauseReason).toBeNull()

    // Finish the novel, then the counter and the sample ring freeze.
    const claim = await claimFirstScene(novels, novelId, outlineRevision)
    await novels.commitBody(novelId, {
      unitId: claim.unitId,
      executionToken: claim.executionToken,
      paragraphs: ['黎明到来，守塔人放下望远镜。'],
      sceneCompletion: { completed: true, basis: '场景目标完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await novels.completeChapter(novelId, {
      chapterId: 'ch-1',
      expectedContentRevision: (await novels.getNovel(novelId))!.contentRevision,
      basis: '主线收束',
      openItems: [],
    })
    await novels.finishNovel(novelId, { expectedRevision: (await novels.getNovel(novelId))!.revision, basis: '短篇完成' })
    await novels.noteWriterRun(novelId)
    await novels.noteUsageSample(novelId, usageSample(99))
    snapshot = await novels.getNovel(novelId)
    expect(snapshot?.run.writerRuns).toBe(6)
    expect(snapshot?.run.usageSamples).toEqual([])
  }))

  it('noteUsageSample 环形保留最近 50 条，最旧丢弃，非法采样拒绝', withStores(async (tavern, novels) => {
    const { novelId } = await startedNovel(tavern, novels)
    // Invalid shapes are rejected before any write (lossless discipline:
    // no NaN/Infinity/negative counts can reach a persisted snapshot).
    await expect(novels.noteUsageSample(novelId, usageSample(0, { recordedAt: '' }))).rejects.toMatchObject({ code: 'NOVEL_CONFIG' })
    await expect(novels.noteUsageSample(novelId, usageSample(-1))).rejects.toMatchObject({ code: 'NOVEL_CONFIG' })
    await expect(novels.noteUsageSample(novelId, usageSample(0, { toolBytes: { novel_outline_read: 12.5 } }))).rejects.toMatchObject({ code: 'NOVEL_CONFIG' })
    await expect(novels.noteUsageSample(novelId, usageSample(0, { writerOutputChars: -3 }))).rejects.toMatchObject({ code: 'NOVEL_CONFIG' })
    expect((await novels.getNovel(novelId))?.run.usageSamples).toEqual([])

    for (let turn = 0; turn < 55; turn++) {
      await novels.noteUsageSample(novelId, usageSample(turn, turn === 54 ? { writerOutputChars: 2400 } : undefined))
    }
    const snapshot = await novels.getNovel(novelId)
    const samples = snapshot?.run.usageSamples ?? []
    expect(samples).toHaveLength(50)
    // Oldest five dropped; the ring keeps turns 5..54 in arrival order.
    expect(samples.map((s) => s.turn)).toEqual(Array.from({ length: 50 }, (_, i) => i + 5))
    // Optional fields stay lossless: absent when not supplied, present when set.
    expect('writerOutputChars' in samples[0]!).toBe(false)
    expect(samples[49]?.writerOutputChars).toBe(2400)
    expect(samples[49]?.toolBytes).toEqual({ novel_outline_read: 540 })
  }))
})
