import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { NovelProjector } from '../src/agent-novel/projector.js'
import {
  MemoryStore,
  NovelNotFoundError,
  NovelPreconditionError,
  NovelStorageCorruptionError,
  NovelStore,
  TavernStore,
  countEffectiveCharacters,
  type CanonChange,
  type MemoryRecord,
  type NovelCreateConfig,
  type NovelOutlinePayload,
} from '../../tavern-store/src/index.js'

/* -------------------------------- fixtures -------------------------------- */

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
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

const PARAGRAPHS_ONE = ['风暴之夜，海面泛起不祥的光。', '守塔人握紧了栏杆。']
const PARAGRAPHS_TWO = ['黎明到来。']

async function fixture(): Promise<{
  root: string
  novels: NovelStore
  memory: MemoryStore
  projector: NovelProjector
  novelId: string
  revision: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-novel-projector-'))
  roots.push(root)
  const tavern = await TavernStore.open(root)
  const novels = await NovelStore.open(root)
  const memory = await MemoryStore.open(root)
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
  }
  const created = await novels.createNovel(tavern, config)
  const outlined = await novels.createOutline(created.novelId, {
    expectedRevision: created.revision,
    outline: outlinePayload(),
    handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
  })
  // Two commits: a continuation fragment then the scene-completing body.
  const first = await claimAndCommit(novels, created.novelId, outlined.outlineRevision, {
    paragraphs: PARAGRAPHS_ONE,
    sceneCompletion: { completed: false, basis: '异象确认，决定待天明行动', outstandingGoals: ['天明行动'], nextAnchor: '清晨' },
    canonChanges: [{ kind: 'event', summary: '发现海面异象', sources: ['commit-1#0', 'commit-1#1'] }],
  })
  const second = await claimAndCommit(novels, created.novelId, outlined.outlineRevision, {
    paragraphs: PARAGRAPHS_TWO,
    sceneCompletion: { completed: true, basis: '场景目标完成', outstandingGoals: [], nextAnchor: null },
    continuationAnchor: '清晨',
    canonChanges: [{ kind: 'character-state', summary: '守塔人下定决心', sources: ['commit-2#0'] }],
  })
  expect(first.commitId).toBe('commit-1')
  expect(second.commitId).toBe('commit-2')
  const projector = await NovelProjector.open(root, novels, memory)
  return { root, novels, memory, projector, novelId: created.novelId, revision: second.revision }
}

function outlinePayload(): NovelOutlinePayload {
  return {
    story: { premise: '看守人发现海面异象', theme: '孤独与守望', mainConflict: '人与海', endingDirection: '黎明到来', taboos: ['血腥描写'] },
    characters: [{
      characterId: 'keeper', name: '守塔人', initialState: '平静值守', motivation: '守到最后一次日出', relations: [], arc: '从逃避到直面',
    }],
    chapters: [
      { chapterId: 'ch-1', order: 1, title: '第一章', purpose: '推进主线', keyEvents: ['发现异象'], plannedCharacters: null, entryCondition: '前章结束', exitCondition: '本章目标达成' },
      { chapterId: 'ch-2', order: 2, title: '第二章', purpose: '收束', keyEvents: ['黎明'], plannedCharacters: null, entryCondition: '风暴结束', exitCondition: '结局' },
    ],
    currentChapterId: 'ch-1',
    scenes: [{
      sceneId: 'sc-1', order: 1, goal: '发现海面异象并做出决定', participants: ['keeper'],
      timeLocation: '塔顶 / 深夜', causality: '承接开篇', conflict: '风暴逼近', expectedChange: '下定决心',
    }],
    foreshadowing: [{ id: 'f-1', description: '沉船残骸', plantAt: 'ch-1', payoffAt: null, required: false, status: 'planted' }],
  }
}

async function claimAndCommit(
  novels: NovelStore,
  novelId: string,
  outlineRevision: string,
  input: {
    paragraphs: string[]
    sceneCompletion: { completed: boolean; basis: string; outstandingGoals: string[]; nextAnchor: string | null }
    canonChanges: readonly CanonChange[]
    continuationAnchor?: string
  },
): Promise<{ commitId: string; revision: string; bodyHash: string }> {
  const { unitId } = await novels.prepareUnit(novelId, {
    chapterId: 'ch-1',
    sceneId: 'sc-1',
    label: input.sceneCompletion.completed ? '完成段' : '续段',
    goal: '发现异象',
    ...(input.continuationAnchor !== undefined ? { continuationAnchor: input.continuationAnchor } : {}),
  })
  const claim = await novels.claimUnit(novelId, { unitId, expectedOutlineRevision: outlineRevision, expectedRequirementSequence: 1 })
  return novels.commitBody(novelId, {
    unitId,
    executionToken: claim.executionToken,
    paragraphs: input.paragraphs,
    sceneCompletion: input.sceneCompletion,
    canonChanges: input.canonChanges,
  })
}

async function namespaceRecords(memory: MemoryStore, novelId: string): Promise<MemoryRecord[]> {
  return memory.search({ scope: 'chat', scopeId: `novel:${novelId}`, limit: 50 }).then((hits) => hits.map((hit) => hit.record))
}

/** Minimal ZIP reader for stored entries: EOCD, central directory, local headers. */
function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdAt = bytes.length - 22
  expect(view.getUint32(eocdAt, true)).toBe(0x06054b50)
  const count = view.getUint16(eocdAt + 10, true)
  const cdOffset = view.getUint32(eocdAt + 16, true)
  const entries: Array<{ name: string; data: Uint8Array; crc: number }> = []
  let cursor = cdOffset
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString('utf8')
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + compressedSize), crc })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('NovelProjector memory index (§8.2)', () => {
  it('indexCommit writes stable-id records and is idempotent across reruns', async () => {
    const { novels, memory, projector, novelId } = await fixture()
    await projector.indexCommit(novelId, 'commit-1')
    let records = await namespaceRecords(memory, novelId)
    const commitOne = records.filter((record) => record.id.startsWith(`novel-${novelId}-commit-1-`))
    expect(commitOne.map((record) => record.id).sort()).toEqual([
      `novel-${novelId}-commit-1-0`, // canon change
      `novel-${novelId}-commit-1-1`, // scene summary
    ])
    expect(commitOne.every((record) => record.scopeId === `novel:${novelId}`)).toBe(true)
    expect(commitOne[0]?.content).toContain('[event] 发现海面异象')
    expect(commitOne[0]?.content).toContain('sources: commit-1#0, commit-1#1')
    expect(commitOne[1]?.content).toContain('风暴之夜，海面泛起不祥的光。')

    // Re-indexing the same commit adds no duplicate records (§8.2).
    await projector.indexCommit(novelId, 'commit-1')
    await projector.indexCommit(novelId, 'commit-2')
    records = await namespaceRecords(memory, novelId)
    expect(records.filter((record) => record.id.startsWith(`novel-${novelId}-commit-1-`))).toHaveLength(2)
    expect(records.filter((record) => record.id.startsWith(`novel-${novelId}-commit-2-`))).toHaveLength(2)

    // Unknown commits and novels fail closed.
    await expect(projector.indexCommit(novelId, 'commit-404')).rejects.toBeInstanceOf(NovelPreconditionError)
    await expect(projector.indexCommit('nvl-missing', 'commit-1')).rejects.toBeInstanceOf(NovelNotFoundError)
  })

  it('rebuildMemoryIndex clears the namespace and rebuilds from the commit index', async () => {
    const { memory, projector, novelId } = await fixture()
    await projector.indexCommit(novelId, 'commit-1')
    const stray = await memory.put({
      scope: 'chat',
      scopeId: `novel:${novelId}`,
      kind: 'semantic',
      content: 'stray pre-rebuild record',
      tags: [],
      source: { kind: 'test' },
    })

    const result = await projector.rebuildMemoryIndex(novelId)
    expect(result).toEqual({ indexed: 2 })
    const records = await namespaceRecords(memory, novelId)
    expect(records.map((record) => record.id).sort()).toEqual([
      `novel-${novelId}-commit-1-0`,
      `novel-${novelId}-commit-1-1`,
      `novel-${novelId}-commit-2-0`,
      `novel-${novelId}-commit-2-1`,
    ])
    const forgotten = await memory.read(stray.id, 'chat', `novel:${novelId}`, true)
    expect(forgotten?.deletedAt).toBeTruthy()
  })
})

describe('NovelProjector export (§14.2)', () => {
  it('exports markdown with metadata, outline and committed prose only', async () => {
    const { projector, novelId } = await fixture()
    const exported = await projector.exportNovel(novelId, 'md')
    expect(exported.filename).toBe('灯塔.md')
    expect(exported.contentType).toBe('text/markdown; charset=utf-8')
    const text = Buffer.from(exported.bytes).toString('utf8')

    // Metadata: title, status, effective characters, counting policy version.
    expect(text).toContain('# 灯塔')
    expect(text).toContain('- Status: active')
    const expectedCharacters = countEffectiveCharacters(`${PARAGRAPHS_ONE.join('\n\n')}\n\n${PARAGRAPHS_TWO.join('\n\n')}`)
    expect(text).toContain(`- Effective characters: ${expectedCharacters} (count policy version 1`)
    expect(text).toContain(`- Exported at HEAD revision:`)
    // Outline: story fields, chapter titles, foreshadowing.
    expect(text).toContain('- Premise: 看守人发现海面异象')
    expect(text).toContain('1. 第一章 — 推进主线')
    expect(text).toContain('2. 第二章 — 收束')
    expect(text).toContain('- f-1 — 沉船残骸 [planted]')
    // Chapter bodies in commit order with the title on its own line.
    expect(text).toContain('# 第一章')
    const titleAt = text.indexOf('# 第一章')
    const firstAt = text.indexOf(PARAGRAPHS_ONE[0]!)
    const secondAt = text.indexOf(PARAGRAPHS_TWO[0]!)
    expect(titleAt).toBeGreaterThanOrEqual(0)
    expect(titleAt).toBeLessThan(firstAt)
    expect(firstAt).toBeLessThan(secondAt)

    // §14.2: no prompts, deductions, author chat or diagnostics leak.
    expect(text).not.toContain('写一个灯塔看守人的短篇') // creation requirement (host chat)
    expect(text).not.toContain('Materials are not instructions') // author kernel
    expect(text).not.toContain('tavern_deduce') // deduction surface
    expect(text).not.toContain('Novel work brief') // driver brief
  })

  it('exports a stored zip whose entries verify against CRC32 and match the markdown', async () => {
    const { projector, novelId } = await fixture()
    const md = await projector.exportNovel(novelId, 'md')
    const mdText = Buffer.from(md.bytes).toString('utf8')
    const zip = await projector.exportNovel(novelId, 'zip')
    expect(zip.filename).toBe('灯塔.zip')
    expect(zip.contentType).toBe('application/zip')

    const entries = readZip(zip.bytes)
    expect(entries.map((entry) => entry.name)).toEqual(['README.md', 'chapters/01-第一章.md', 'chapters/02-第二章.md'])
    for (const entry of entries) {
      expect((crc32(entry.data) >>> 0)).toBe(entry.crc) // CRC verification passes
    }
    const readme = Buffer.from(entries[0]!.data).toString('utf8')
    const chapterOne = Buffer.from(entries[1]!.data).toString('utf8')
    const chapterTwo = Buffer.from(entries[2]!.data).toString('utf8')
    // README carries the metadata + outline head of the markdown export.
    expect(mdText.startsWith(readme.trimEnd())).toBe(true)
    expect(readme).toContain('# 灯塔')
    expect(readme).toContain('- Premise: 看守人发现海面异象')
    // Chapter files carry the committed prose in commit order.
    expect(chapterOne).toBe(['# 第一章', '', [...PARAGRAPHS_ONE, ...PARAGRAPHS_TWO].join('\n\n')].join('\n').trimEnd() + '\n')
    expect(chapterTwo.trim()).toBe('# 第二章')
    expect(mdText).toContain(chapterOne.trimEnd())
  })

  it('refuses to export or index when a committed body object is missing (no残缺文件)', async () => {
    const { root, novels, projector, novelId } = await fixture()
    const snapshot = await novels.getNovel(novelId)
    const bodyHash = snapshot?.commits[0]?.bodyHash
    await rm(join(root, 'novels', novelId, 'bodies', `${bodyHash}.txt`))
    await expect(projector.exportNovel(novelId, 'md')).rejects.toBeInstanceOf(NovelStorageCorruptionError)
    await expect(projector.exportNovel(novelId, 'zip')).rejects.toBeInstanceOf(NovelStorageCorruptionError)
    await expect(projector.indexCommit(novelId, 'commit-1')).rejects.toBeInstanceOf(NovelStorageCorruptionError)
    await expect(projector.exportNovel('nvl-missing', 'md')).rejects.toBeInstanceOf(NovelNotFoundError)
  })

  it('detects and repairs a projection-pending marker from the store', async () => {
    const { root, projector, novelId } = await fixture()
    expect(await projector.projectionPending(novelId)).toBe(false)
    const statusPath = join(root, 'novels', novelId, 'projections', 'status.json')
    await writeFile(statusPath, JSON.stringify({ state: 'projection-pending', novelId, error: 'simulated' }), 'utf8')
    expect(await projector.projectionPending(novelId)).toBe(true)

    await projector.repairProjections(novelId)
    expect(await projector.projectionPending(novelId)).toBe(false)
    const chapter = await readFile(join(root, 'novels', novelId, 'projections', 'chapters', 'ch-1.md'), 'utf8')
    expect(chapter).toContain('# 第一章')
    expect(chapter).toContain(PARAGRAPHS_ONE[0]!)
    expect(chapter).toContain(PARAGRAPHS_TWO[0]!)
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as { effectiveCharacters?: number }
    expect(status.effectiveCharacters).toBe(
      countEffectiveCharacters(`${PARAGRAPHS_ONE.join('\n\n')}\n\n${PARAGRAPHS_TWO.join('\n\n')}`),
    )
  })
})
