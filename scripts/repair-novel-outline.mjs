/**
 * Repair an outline silently shrunk by a windowed-echo revise (the accident
 * class behind the droppedChapterIds guard): re-append the chapters that
 * vanished, verbatim from the last intact revision, as a forward
 * novel_outline_revise — existing chapters, story, characters and
 * foreshadowing are kept verbatim; nothing is dropped, so the store's
 * drop-acknowledgement guard stays silent.
 *
 * Usage:
 *   node scripts/repair-novel-outline.mjs [<tavern-root>] <novel-id> <source-revision> [--expect-chapters <n>]
 *
 * <tavern-root> defaults to $DSH_HOME/tavern (then ~/.dsh/tavern); it is the
 * tavern root (~/.dsh/tavern), NOT the dsh home — the wrong layer silently
 * creates an empty novels/ dir. Needs a built packages/tavern-store/lib
 * (pnpm build:plugin). Quit `dsh web` first: the §10.2 write lock otherwise
 * rejects the script's writes.
 *
 * First run: nvl-mu6hgxns-57520484, 150→12 shrink repaired from
 * b4e7fc2650d24824 (2026-09-18).
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { TavernStore, NovelStore } from '../packages/tavern-store/lib/index.js'

const args = process.argv.slice(2)
const expectIndex = args.indexOf('--expect-chapters')
const expectedChapters = expectIndex === -1 ? undefined : Number(args[expectIndex + 1])
const positional = args.filter((_, index) => index !== expectIndex && index !== expectIndex + 1)
const rootArg = positional[0]?.startsWith('-') ? undefined : positional[0]
const novelId = positional[rootArg === undefined ? 0 : 1]
const sourceRevision = positional[rootArg === undefined ? 1 : 2]
if (!novelId || !sourceRevision || Number.isNaN(expectedChapters)) {
  console.error('usage: node scripts/repair-novel-outline.mjs [<tavern-root>] <novel-id> <source-revision> [--expect-chapters <n>]')
  process.exit(2)
}
const home = rootArg ?? (() => {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), 'tavern')
})()

const tavern = await TavernStore.open(home)
const novels = await NovelStore.open(home)

const cur = await novels.getNovel(novelId)
if (cur === null) throw new Error(`novel ${novelId} not found`)
if (expectedChapters !== undefined && cur.outline.chapters.length !== expectedChapters) {
  throw new Error(`expected ${expectedChapters} chapters, found ${cur.outline.chapters.length} — refusing (double-apply?)`)
}
const source = JSON.parse(
  fs.readFileSync(`${home}/novels/${novelId}/revisions/${sourceRevision}.json`, 'utf8'),
).snapshot.outline
const currentIds = new Set(cur.outline.chapters.map((chapter) => chapter.chapterId))
const missing = source.chapters.filter((chapter) => !currentIds.has(chapter.chapterId))
if (missing.length === 0) throw new Error('source adds no missing chapters — nothing to repair (double-apply?)')
if (currentIds.size + missing.length !== source.chapters.length) throw new Error('source/missing chapter mismatch')
const chapters = [...cur.outline.chapters, ...missing].sort((left, right) => left.order - right.order)
for (let order = 1; order <= chapters.length; order += 1) {
  if (chapters[order - 1].order !== order) throw new Error(`restored plan has an order gap at ${order}`)
}
const firstUncompleted = chapters.find((chapter) => !cur.completedChapters.some((e) => e.chapterId === chapter.chapterId))?.chapterId
  ?? cur.outline.currentChapterId

const result = await novels.reviseOutline(novelId, {
  expectedRevision: cur.revision,
  expectedOutlineRevision: cur.outline.outlineRevision,
  reason: `repair outline shrink: re-append ${missing.length} chapters (${missing[0].chapterId}..${missing[missing.length - 1].chapterId}) silently dropped by a windowed-echo revise (source revision ${sourceRevision}); existing chapters kept verbatim`,
  changes: {
    story: cur.outline.story,
    characters: cur.outline.characters,
    chapters,
    currentChapterId: firstUncompleted,
    scenes: [],
    foreshadowing: cur.outline.foreshadowing,
  },
  handledRequirements: [],
})
console.log('revised to revision', result.revision, 'outlineRevision', result.outlineRevision)

const after = await novels.getNovel(novelId)
console.log('chapters:', after.outline.chapters.length)
console.log('first uncompleted:', after.outline.chapters.map((c) => c.chapterId).find((id) => !after.completedChapters.some((e) => e.chapterId === id)))
console.log('currentChapterId:', after.outline.currentChapterId, '| scenes:', after.outline.scenes.length)
console.log('completed:', after.completedChapters.length, '| commits:', after.commits.length)
console.log('run:', after.run.status, after.run.pauseReason ?? '', after.run.phase)
