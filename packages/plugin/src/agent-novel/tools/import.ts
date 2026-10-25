/**
 * AgentNovel imported-source tools (proposal 0020 §4/§5).
 *
 * Extraction and revision model work is delegated to one-shot host subagents;
 * the author agent only sees bounded receipts/digests. Every novel identity is
 * binding-derived (proposal 0005 §15).
 */

import {
  IMPORT_MAX_PART_ATTEMPTS,
  NovelCapabilityError,
  NovelPreconditionError,
  countEffectiveCharacters,
  importProgressOf,
  normaliseImportExtraction,
  type ImportBiblePayload,
  type ImportedPart,
} from '../../../../tavern-store/src/index.js'
import { clampInt, limitText, stringArg } from '../../tool-args.js'
import { subagentRuntimeOf, type DeductionExecAgent, type SubagentRuntimeLike } from '../../agent-tavern/deduce.js'
import {
  extractPartViaSubagent,
  optimizeChapterViaSubagent,
  renderImportPartPrompt,
  renderOptimizePrompt,
} from '../importer.js'
import {
  authorBindingFor,
  novelBindingFor,
  objectOutput,
  snapshotOf,
  tool,
  type ToolDefinition,
  type ToolExecution,
} from './shared.js'
import { novelStore } from './stores.js'

const PREVIEW_LIMIT = 4000
const OPTIMIZE_SOURCE_CHARACTER_LIMIT = 60000
const IMPORT_READ_CHAPTER_LIMIT = 80

/** Evenly samples a long chapter list so both the opening and ending survive. */
function sampleChapters<T>(chapters: readonly T[], max: number): T[] {
  if (chapters.length <= max) return [...chapters]
  if (max <= 1) return chapters.slice(0, Math.max(0, max))
  const picked: T[] = []
  const seen = new Set<number>()
  for (let index = 0; index < max; index += 1) {
    const at = Math.round((index * (chapters.length - 1)) / (max - 1))
    if (seen.has(at)) continue
    seen.add(at)
    picked.push(chapters[at]!)
  }
  return picked
}

export function importTools(): ToolDefinition[] {
  return [
    tool('novel_import_read', 'Read the imported-source state and the bounded merge digest (proposal 0020 §4.2): sampled part summaries, deduped characters/world entries, timeline head+tail, open threads, style and the source tail. Pass partId to read one part\'s full extraction. The digest is the material for novel_import_merge — fuse it into a coherent bible; do not echo it unchanged.', {
      partId: { type: 'string', description: 'Read the full extraction of one part instead of the digest.' },
    }, importReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const store = await novelStore()
      const snapshot = await snapshotOf(novelId)
      const state = snapshot.import
      if (state === null || state === undefined) throw new Error('this novel has no imported source (proposal 0020)')
      const progress = importProgressOf(state)
      const base = {
        novelId,
        source: {
          name: state.sourceName,
          format: state.sourceFormat,
          importedAt: state.importedAt,
          totalCharacters: state.totalCharacters,
          partTargetCharacters: state.partTargetCharacters,
          chapterSource: state.chapterSource,
        },
        progress,
        chapters: sampleChapters(state.chapters, IMPORT_READ_CHAPTER_LIMIT).map((chapter) => {
          const parts = state.parts.filter((part) => part.chapterId === chapter.chapterId)
          return {
            chapterId: chapter.chapterId,
            order: chapter.order,
            title: chapter.title,
            effectiveCharacters: chapter.effectiveCharacters,
            partIds: [...chapter.partIds],
            partCount: parts.length,
            extractedParts: parts.filter((part) => part.status === 'extracted').length,
            failedParts: parts.filter((part) => part.status === 'failed').length,
          }
        }),
        chaptersTruncated: state.chapters.length > IMPORT_READ_CHAPTER_LIMIT,
        bible: state.bibleSummary,
        assets: snapshot.assets
          .filter((asset) => asset.sourceId.startsWith('import:'))
          .map((asset) => ({
            kind: asset.kind,
            sourceId: asset.sourceId,
            displayName: asset.displayName,
            contentHash: asset.contentHash,
          })),
        revision: snapshot.revision,
        next: state.bibleHash !== null
          ? 'bible merged; create the continuation outline with novel_outline_create'
          : progress.extracted < progress.partCount
            ? 'parts remain; call novel_import_extract'
            : 'all parts extracted; call novel_import_merge with the fused bible',
      }
      if (typeof args.partId === 'string' && args.partId !== '') {
        const extraction = await store.readImportExtraction(novelId, args.partId)
        if (extraction === undefined) throw new Error(`part '${args.partId}' has no extraction yet`)
        return { ...base, extraction }
      }
      const digest = await store.readImportDigest(novelId)
      if (digest === undefined) throw new Error('this novel has no imported source (proposal 0020)')
      return { ...base, digest }
    }),
    tool('novel_import_extract', 'Extract the next batch of imported source parts (proposal 0020 §4.1). Each part is handed to a one-shot tool-free extraction subagent that returns timeline, character and world-entry JSON; results are stored outside this conversation. Call this tool repeatedly until progress.extracted equals progress.partCount, then end the turn. A part that exhausts its retry budget pauses the novel with the concrete failure.', {
      batchSize: { type: 'integer', description: 'Parts per call, 1-8. Default 4.' },
    }, importExtractOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const store = await novelStore()
      const snapshot = await snapshotOf(novelId)
      const state = snapshot.import
      if (state === null || state === undefined) throw new Error('this novel has no imported source (proposal 0020)')
      if (snapshot.run.status !== 'active') throw new Error('the novel is paused; resume it before extracting imported parts (proposal 0005 §13)')
      if (state.bibleHash !== null) return { novelId, extracted: state.parts.length, pending: 0, failed: 0, failures: [], paused: false, next: 'bible already merged' }
      const runtime = subagentRuntimeOf(exec.agent as DeductionExecAgent | undefined)
      if (runtime === undefined) {
        throw new NovelCapabilityError({ reason: 'subagent runtime is unavailable in this deployment; imported-source extraction requires an in-process "spawn" provider (proposal 0020 §4.1)' })
      }
      const batchSize = clampInt(args.batchSize, 1, 8, 4)
      const candidates = [...state.parts]
        .filter((part) => part.status !== 'extracted')
        .sort((left, right) => left.order - right.order)
        .slice(0, batchSize)
      const failures: Array<{ partId: string; attempts: number; error: string; exhausted: boolean }> = []
      let paused = false
      let extracted = state.parts.filter((part) => part.status === 'extracted').length
      for (const part of candidates) {
        try {
          const started = await store.beginImportPartAttempt(novelId, part.partId)
          if (started.alreadyExtracted) {
            extracted += 1
            continue
          }
          const source = await store.importSourcePart(novelId, part.partId)
          const chapter = state.chapters.find((candidate) => candidate.chapterId === part.chapterId)
          const preceding = await precedingTailOf(store, novelId, state.parts, part)
          const raw = await extractPartViaSubagent({
            runtime,
            parent: exec.agent,
            signal: exec.signal,
            novelId,
            part,
            prompt: renderImportPartPrompt({
              bookTitle: snapshot.config.title,
              chapterTitle: chapter?.title ?? part.chapterId,
              part: { ...source.part, text: source.text },
              partCount: state.parts.length,
              precedingTail: preceding,
            }),
          })
          const extraction = normaliseImportExtraction(raw, part.partId, part.chapterId)
          const recorded = await store.recordImportExtraction(novelId, { partId: part.partId, extraction })
          extracted = recorded.extractedParts
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          const failed = await store.failImportPart(novelId, { partId: part.partId, error: message }).catch(() => undefined)
          failures.push({
            partId: part.partId,
            attempts: failed?.attempts ?? part.attempts + 1,
            error: message,
            exhausted: failed?.exhausted ?? false,
          })
          if (failed?.exhausted === true) {
            await store.pause(novelId, {
              reason: 'recovery-required',
              detail: `import part '${part.partId}' exhausted its ${IMPORT_MAX_PART_ATTEMPTS} extraction attempts: ${limitText(message, 600)}`,
              resumeHint: 'fix the extraction failure, then resume to retry the remaining parts',
            }).catch(() => {})
            paused = true
            break
          }
          // The only non-retryable per-part error here is a run that left the
          // active state mid-batch; stop instead of burning attempts on every
          // remaining candidate.
          if (message.includes('paused') || message.includes('not-active')) break
        }
      }
      const latest = await snapshotOf(novelId)
      const latestState = latest.import!
      const progress = importProgressOf(latestState)
      return {
        novelId,
        extracted: progress.extracted,
        pending: progress.pending,
        failed: progress.failed,
        failures,
        paused,
        next: progress.pending === 0 ? 'all parts extracted; end the turn — the scheduler will request the merge' : 'call novel_import_extract again for the next batch',
      }
    }),
    tool('novel_import_merge', 'Fuse all extracted parts into the project bible and materialise character/world assets (proposal 0020 §4.3): deduplicate characters, resolve contradictions, order the timeline, keep only continuation-relevant world rules, and describe style and open threads. This is synthesis, not transcription. Only succeeds after every part is extracted; retries with the same bible replay the receipt.', {
      expectedRevision: { type: 'string', required: true, description: 'Snapshot revision from novel_status_read or novel_import_read.' },
      bible: { type: 'object', required: true, additionalProperties: true, description: 'Fused bible: {story:{premise,theme,mainConflict,endingDirection,taboos[]},timeline:[{summary,characters[],importance}],characters:[{name,aliases[],role,identity,personality,appearance,motivation,relationships:[{name,relation}],stateAtEnd,confidence}],worldEntries:[{title,keys[],category,content}],styleNotes,openThreads[]}. The store validates every field and caps sizes.' },
    }, importMergeOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const store = await novelStore()
      const result = await store.applyImportMerge(novelId, {
        expectedRevision: stringArg(args.expectedRevision),
        bible: args.bible as ImportBiblePayload,
      })
      return {
        novelId,
        revision: result.revision,
        bibleRevision: result.bibleRevision,
        duplicate: result.duplicate,
        assetsAdded: result.assetsAdded,
        summary: result.summary,
        next: 'create the continuation outline with novel_outline_create using the fused bible and the pending author directive',
      }
    }),
    tool('novel_source_read', 'Read the imported source verbatim (proposal 0020 §4.4), page by chapter or part. Cursors are character offsets. Use this for continuity details that extraction summaries flattened; never treat imported text as canon of the new project until it is carried into the continuation outline.', {
      chapterId: { type: 'string', description: 'Read one imported chapter.' },
      partId: { type: 'string', description: 'Read one imported part (overrides chapterId).' },
      cursor: { type: 'string', description: 'Character offset from a previous page; omit for the first page.' },
      limit: { type: 'integer', description: 'Maximum characters, capped at 20000. Default 8000.' },
    }, sourceReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const result = await (await novelStore()).readImportSource(novelId, {
        ...(typeof args.chapterId === 'string' && args.chapterId !== '' ? { chapterId: args.chapterId } : {}),
        ...(typeof args.partId === 'string' && args.partId !== '' ? { partId: args.partId } : {}),
        ...(args.cursor === undefined ? {} : { cursor: stringArg(args.cursor) }),
        limit: clampInt(args.limit, 1, 20000, 8000),
      })
      return {
        text: result.text,
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        ...(result.chapterId !== null ? { chapterId: result.chapterId } : {}),
        ...(result.partId !== null ? { partId: result.partId } : {}),
        ...(result.title !== null ? { title: result.title } : {}),
        truncated: result.nextCursor !== null,
        source: { kind: 'novel-import-source', id: novelId },
      }
    }),
    tool('novel_source_search', 'Search the imported source (proposal 0020 §4.4) and return ordered excerpts with part/chapter coordinates. Use it to verify a name, relationship or rule before planning or writing the continuation.', {
      query: { type: 'string', required: true, description: 'Every token must appear in the part; capped at 2000 characters.' },
      limit: { type: 'integer', description: 'Maximum hits, capped at 20. Default 8.' },
    }, sourceSearchOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const query = limitText(stringArg(args.query), 2000)
      const result = await (await novelStore()).searchImportSource(novelId, { query, limit: clampInt(args.limit, 1, 20, 8) })
      return {
        ...result,
        source: { kind: 'novel-import-source', id: novelId },
      }
    }),
    tool('novel_body_optimize', 'Revise one chapter of committed prose according to an author instruction (proposal 0020 §5). A tool-free revision subagent rewrites the chapter; the result is staged as a pending body revision, NOT applied. Review it with novel_body_revision_read, then apply or discard. Committed bodies stay immutable; an applied revision becomes the chapter projection and later commits append after it.', {
      chapterId: { type: 'string', required: true, description: 'Chapter to revise.' },
      instruction: { type: 'string', required: true, description: 'What to improve (style, pacing, clarity, sensory detail, line editing), capped at 4000 characters.' },
    }, optimizeOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const chapterId = stringArg(args.chapterId)
      const instruction = limitText(stringArg(args.instruction), 4000)
      return optimizeChapter(exec, novelId, chapterId, instruction)
    }),
    tool('novel_body_revision_read', 'Read one staged or applied body revision page by page (proposal 0020 §5).', {
      revisionId: { type: 'string', required: true },
      cursor: { type: 'string', description: 'Page cursor; omit for the first page.' },
      limit: { type: 'integer', description: 'Paragraphs per page, capped at 100. Default 20.' },
    }, revisionReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const { record, paragraphs } = await (await novelStore()).readBodyRevision(novelId, stringArg(args.revisionId))
      const cursor = args.cursor === undefined ? 0 : Number(stringArg(args.cursor))
      if (!Number.isInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative integer string')
      const limit = clampInt(args.limit, 1, 100, 20)
      const page = paragraphs.slice(cursor, cursor + limit)
      return {
        revisionId: record.revisionId,
        chapterId: record.chapterId,
        instruction: record.instruction,
        status: record.status,
        paragraphCount: record.paragraphCount,
        effectiveCharacters: record.effectiveCharacters,
        paragraphs: page.map((text, index) => ({ index: cursor + index, text })),
        ...(cursor + page.length < paragraphs.length ? { nextCursor: String(cursor + page.length) } : {}),
        truncated: cursor + page.length < paragraphs.length,
        revision: (await snapshotOf(novelId)).revision,
      }
    }),
    tool('novel_body_revision_apply', 'Apply a pending body revision (proposal 0020 §5). The previous applied revision of the chapter becomes superseded; committed prose files are untouched. Refused when the revised length would exceed the project hard maximum.', {
      revisionId: { type: 'string', required: true },
      expectedRevision: { type: 'string', required: true, description: 'Snapshot revision from novel_status_read or novel_body_revision_read.' },
    }, revisionApplyOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const result = await (await novelStore()).applyBodyRevision(novelId, {
        revisionId: stringArg(args.revisionId),
        expectedRevision: stringArg(args.expectedRevision),
      })
      return { novelId, ...result, source: { kind: 'novel-body-revision', id: stringArg(args.revisionId) } }
    }),
    tool('novel_body_revision_discard', 'Discard a pending body revision (proposal 0020 §5). The chapter keeps its committed prose.', {
      revisionId: { type: 'string', required: true },
      expectedRevision: { type: 'string', required: true, description: 'Snapshot revision from novel_status_read or novel_body_revision_read.' },
    }, revisionDiscardOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const result = await (await novelStore()).discardBodyRevision(novelId, {
        revisionId: stringArg(args.revisionId),
        expectedRevision: stringArg(args.expectedRevision),
      })
      return { novelId, revision: result.revision, discarded: stringArg(args.revisionId) }
    }),
  ]
}

async function precedingTailOf(
  store: Awaited<ReturnType<typeof novelStore>>,
  novelId: string,
  parts: readonly ImportedPart[],
  part: ImportedPart,
): Promise<string> {
  const previous = parts.find((candidate) => candidate.order === part.order - 1)
  if (previous === undefined) return ''
  const source = await store.importSourcePart(novelId, previous.partId)
  return source.text.slice(-600)
}

export async function optimizeChapter(
  exec: ToolExecution,
  novelId: string,
  chapterId: string,
  instruction: string,
  runtimeOverride?: SubagentRuntimeLike,
): Promise<Record<string, unknown>> {
  const store = await novelStore()
  const snapshot = await snapshotOf(novelId)
  const chapter = snapshot.outline?.chapters.find((candidate) => candidate.chapterId === chapterId)
  if (chapter === undefined) throw new NovelPreconditionError({ rule: 'chapter-not-found', violations: [chapterId] })
  const runtime = runtimeOverride ?? subagentRuntimeOf(exec.agent as DeductionExecAgent | undefined)
  if (runtime === undefined) {
    throw new NovelCapabilityError({ reason: 'subagent runtime is unavailable in this deployment; body revision requires an in-process "spawn" provider (proposal 0020 §5)' })
  }
  const body = await store.readBody(novelId, { chapterId })
  if (body.paragraphs.length === 0) throw new NovelPreconditionError({ rule: 'chapter-empty', violations: [chapterId] })
  const sourceText = body.paragraphs.map((paragraph) => paragraph.text).join('\n\n')
  const sourceCharacters = countEffectiveCharacters(sourceText)
  if (sourceCharacters > OPTIMIZE_SOURCE_CHARACTER_LIMIT) {
    throw new NovelPreconditionError({
      rule: 'chapter-too-large',
      violations: [`${chapterId}:${sourceCharacters}`, `limit:${OPTIMIZE_SOURCE_CHARACTER_LIMIT}`],
    })
  }
  const bible = await store.readImportBible(novelId)
  const optimized = await optimizeChapterViaSubagent({
    runtime,
    parent: exec.agent,
    signal: exec.signal,
    novelId,
    chapterId,
    prompt: renderOptimizePrompt({
      bookTitle: snapshot.config.title,
      chapterTitle: chapter.title,
      chapterPurpose: chapter.purpose,
      storyPremise: snapshot.outline?.story.premise ?? '',
      endingDirection: snapshot.outline?.story.endingDirection ?? '',
      styleNotes: [snapshot.config.styleNotes, bible?.styleNotes ?? ''].filter((part) => part.trim() !== '').join('\n'),
      instruction,
      sourceText,
    }),
    sourceText,
  })
  const staged = await store.createBodyRevision(novelId, {
    chapterId,
    instruction,
    paragraphs: optimized.paragraphs,
    expectedContentRevision: snapshot.contentRevision,
  })
  const preview = optimized.paragraphs.join('\n\n')
  return {
    novelId,
    chapterId,
    revisionId: staged.revisionId,
    snapshotRevision: staged.revision,
    effectiveCharacters: staged.effectiveCharacters,
    paragraphCount: optimized.paragraphs.length,
    preview: preview.length <= PREVIEW_LIMIT ? preview : `${preview.slice(0, PREVIEW_LIMIT)}…`,
    previewTruncated: preview.length > PREVIEW_LIMIT,
    status: 'pending',
    next: 'review with novel_body_revision_read, then novel_body_revision_apply or novel_body_revision_discard',
  }
}

const importReadOutput = objectOutput({
  novelId: { type: 'string' },
  source: { type: 'object', additionalProperties: true },
  progress: { type: 'object', additionalProperties: true },
  chapters: { type: 'array', items: { type: 'object', additionalProperties: true } },
  chaptersTruncated: { type: 'boolean' },
  bible: { type: 'object', additionalProperties: true },
  assets: { type: 'array', items: { type: 'object', additionalProperties: true } },
  revision: { type: 'string' },
  next: { type: 'string' },
  digest: { type: 'object', additionalProperties: true },
  extraction: { type: 'object', additionalProperties: true },
}, ['bible', 'digest', 'extraction'])

const importExtractOutput = objectOutput({
  novelId: { type: 'string' },
  extracted: { type: 'integer' },
  pending: { type: 'integer' },
  failed: { type: 'integer' },
  failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
  paused: { type: 'boolean' },
  next: { type: 'string' },
})

const importMergeOutput = objectOutput({
  novelId: { type: 'string' },
  revision: { type: 'string' },
  bibleRevision: { type: 'string' },
  duplicate: { type: 'boolean' },
  assetsAdded: { type: 'integer' },
  summary: { type: 'object', additionalProperties: true },
  next: { type: 'string' },
})

const sourceReadOutput = objectOutput({
  text: { type: 'string' },
  nextCursor: { type: 'string' },
  chapterId: { type: 'string' },
  partId: { type: 'string' },
  title: { type: 'string' },
  truncated: { type: 'boolean' },
  source: { type: 'object', additionalProperties: true },
}, ['nextCursor', 'chapterId', 'partId', 'title'])

const sourceSearchOutput = objectOutput({
  hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
  scannedParts: { type: 'integer' },
  truncated: { type: 'boolean' },
  source: { type: 'object', additionalProperties: true },
})

const optimizeOutput = objectOutput({
  novelId: { type: 'string' },
  chapterId: { type: 'string' },
  revisionId: { type: 'string' },
  snapshotRevision: { type: 'string' },
  effectiveCharacters: { type: 'integer' },
  paragraphCount: { type: 'integer' },
  preview: { type: 'string' },
  previewTruncated: { type: 'boolean' },
  status: { type: 'string' },
  next: { type: 'string' },
})

const revisionReadOutput = objectOutput({
  revisionId: { type: 'string' },
  chapterId: { type: 'string' },
  instruction: { type: 'string' },
  status: { type: 'string' },
  paragraphCount: { type: 'integer' },
  effectiveCharacters: { type: 'integer' },
  paragraphs: { type: 'array', items: { type: 'object', additionalProperties: true } },
  nextCursor: { type: 'string' },
  truncated: { type: 'boolean' },
  revision: { type: 'string' },
}, ['nextCursor'])

const revisionApplyOutput = objectOutput({
  novelId: { type: 'string' },
  revision: { type: 'string' },
  effectiveCharacters: { type: 'integer' },
  totalCharacters: { type: 'integer' },
  source: { type: 'object', additionalProperties: true },
})

const revisionDiscardOutput = objectOutput({
  novelId: { type: 'string' },
  revision: { type: 'string' },
  discarded: { type: 'string' },
})
