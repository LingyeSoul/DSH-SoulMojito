/**
 * AgentNovel file storage adapter (docs/proposals/0005-agent-novel-architecture.md §10).
 *
 * Layout under `<tavernRoot>/novels/<novelId>/`:
 *
 * ```text
 * HEAD.json                      # pure pointer: { novelId, revision, schemaVersion, updatedAt }
 * revisions/<revisionId>.json    # immutable full snapshot (content-addressed by revision)
 * assets/<contentHash>.json      # immutable asset snapshots (§5)
 * bodies/<contentHash>.txt       # immutable body paragraphs (§10.1)
 * projections/chapters/<chapterId>.md  # rebuildable reading projections (§14.1)
 * projections/status.json        # rebuildable status projection / projection-pending marker
 * .owner.json                    # single-writer ownership: { pid, bootId, acquiredAt }
 * ```
 *
 * Commit discipline (§10.2): every state mutation goes through `mutate()`,
 * which serializes per novelId in-process, re-reads HEAD, verifies ownership,
 * validates preconditions, builds the complete next snapshot, writes immutable
 * objects (fsync), writes the revision file (fsync), then atomically replaces
 * HEAD (logical commit point). Projections update asynchronously afterwards.
 *
 * Windows note: HEAD replacement uses `fs.rename(tmp, head)`. libuv implements
 * rename on Windows via MoveFileExW with MOVEFILE_REPLACE_EXISTING, so the
 * replace-existing semantics are the same as store.ts `writeAtomic`; a single
 * retry covers transient EPERM/EBUSY from antivirus scanners. This behaviour
 * is exercised by the test suite on a real Windows filesystem (§10.2 N1).
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { KeyedMutationTails } from './mutation-tail.js'
import * as path from 'node:path'
import { writeAtomicText } from './fs-atomic.js'
import type { TavernStore } from './store.js'
import type { CharacterCardIR } from '@dsh-soulmojito/format'
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
  appliedBodyRevision,
  bodyRevisionCovers,
  countEffectiveCharacters,
  effectiveChapterCharacters,
  effectiveNovelCharacters,
  finishGuardViolations,
  isValidNovelId,
  isWriterMode,
  requirementWatermark,
  stableStringify,
  summarizeNovel,
  validateCreateConfig,
  validateOutlineConsistency,
  validateOutlinePayload,
  validateRunBudgets,
  type BodyCommit,
  type BodyRevisionRecord,
  type CanonChange,
  type ChapterCompletion,
  type CommitReceipt,
  type HandledRequirement,
  type NovelAssetRef,
  type NovelCreateConfig,
  type NovelOutline,
  type NovelOutlineChanges,
  type NovelOutlinePayload,
  type NovelPauseReason,
  type NovelRunBudgets,
  type NovelRunState,
  type NovelSnapshot,
  type NovelSummary,
  type NovelUsageSample,
  type OutlineChapter,
  type RequirementRecord,
  type RequirementStatus,
  type ResolvedConflict,
  type SceneCompletion,
  type WorkIntentKind,
  type WorkIntentRecord,
  type WriterMode,
  type WritingUnit,
} from './novel-model.js'
import {
  IMPORT_MAX_PART_ATTEMPTS,
  buildImportDigest,
  normaliseImportBible,
  normaliseImportExtraction,
  parseImportedNovelText,
  validateImportFormat,
  validateImportSourceName,
  validatePartTarget,
  type ImportBiblePayload,
  type ImportBibleRecord,
  type ImportBibleSummary,
  type ImportCharacter,
  type ImportExtraction,
  type ImportFormat,
  type ImportWorldEntry,
  type ImportedPart,
  type NovelImportState,
  type ParsedImport,
} from './novel-import.js'
import { excerptAround } from './tokenize.js'
import { validateCanonChanges } from './novel-canon.js'
import {
  applyHandledRequirements,
  assertWatermarkAdvanced,
  materializeOutlineChapters,
  outlinePayloadErrorMessage,
} from './novel-outline.js'
import { USAGE_SAMPLE_LIMIT, validateUsageSample } from './novel-usage.js'
import {
  BOOT_ID,
  elapsedActiveDuration,
  foldActiveDuration,
  isLiveDshWriter,
  parseOwnerFile,
  type OwnerFile,
} from './novel-owner.js'
import {
  hash16,
  jsonBytes,
  readDirectories,
  replaceHead,
  sha256hex,
  textBytes,
  tryReadText,
  writeImmutableBytes,
} from './novel-io.js'
import { contentRevisionOf, embeddedWorldName } from './novel-projection.js'

const SCHEMA_VERSION = 1
const REQUIREMENT_SOURCES = new Set(['composer', 'panel', 'internal'])

/** Paragraph separator for the fixed body-file serialization (§10.4). */
const PARAGRAPH_SEPARATOR = '\n\n'

interface HeadFile {
  novelId: string
  revision: string
  schemaVersion: number
  updatedAt: string
}

interface RevisionFile {
  schemaVersion: number
  revision: string
  parentRevision: string | null
  cause: string
  committedAt: string
  snapshot: NovelSnapshot
}

/** Input for createImportedNovel: raw text is parsed inside the store. */
export interface NovelImportSourceInput {
  name: string
  format: ImportFormat
  text: string
  partTargetCharacters: number
}

interface ImportedSource {
  name: string
  format: ImportFormat
  importedAt: string
  partTargetCharacters: number
  parsed: ParsedImport
}

export class NovelStore {
  private readonly novelsRoot: string
  private readonly mutationTails = new KeyedMutationTails<string>()
  /** Serialized async projection updates per novel; deleteNovel drains them. */
  private readonly projectionTails = new KeyedMutationTails<string>()

  private constructor(root: string) {
    this.novelsRoot = path.join(root, 'novels')
  }

  static async open(tavernRoot: string): Promise<NovelStore> {
    await fs.mkdir(path.join(tavernRoot, 'novels'), { recursive: true })
    return new NovelStore(tavernRoot)
  }

  /* ------------------------------ projects ------------------------------ */

  /**
   * Creates a project: validates config, snapshots the selected assets
   * (character-embedded world books merge into worldNames, §5), registers the
   * first requirement and writes the initial snapshot. Missing source assets
   * throw NovelConfigError instead of becoming empty objects (§15).
   */
  async createNovel(
    tavern: Pick<TavernStore, 'getCharacter' | 'getWorld'>,
    config: NovelCreateConfig,
  ): Promise<{ novelId: string; revision: string; requirementId: string }> {
    return this.createProject(tavern, config, null)
  }

  /**
   * Creates a continuation project from an imported source (proposal 0020 §3).
   * The source is parsed before any directory exists; parts are written as
   * immutable imports/parts/<partId>.txt objects, and the run starts in the
   * `importing` phase so extraction runs before the continuation outline.
   */
  async createImportedNovel(
    tavern: Pick<TavernStore, 'getCharacter' | 'getWorld'>,
    config: NovelCreateConfig,
    source: NovelImportSourceInput,
  ): Promise<{ novelId: string; revision: string; requirementId: string; import: { chapterCount: number; partCount: number; totalCharacters: number } }> {
    const errors = validateCreateConfig(config)
    if (errors.length > 0) throw new NovelConfigError({ message: 'invalid novel config', errors })
    const name = validateImportSourceName(source.name)
    const format = validateImportFormat(source.format)
    const partTargetCharacters = validatePartTarget(source.partTargetCharacters)
    const parsed = parseImportedNovelText({
      text: source.text,
      format,
      titleFallback: config.title,
      partTargetCharacters,
    })
    const created = await this.createProject(tavern, config, {
      name,
      format,
      importedAt: new Date().toISOString(),
      partTargetCharacters,
      parsed,
    })
    return {
      ...created,
      import: {
        chapterCount: parsed.chapters.length,
        partCount: parsed.parts.length,
        totalCharacters: parsed.totalCharacters,
      },
    }
  }

  private async createProject(
    tavern: Pick<TavernStore, 'getCharacter' | 'getWorld'>,
    config: NovelCreateConfig,
    source: ImportedSource | null,
  ): Promise<{ novelId: string; revision: string; requirementId: string }> {
    const errors = validateCreateConfig(config)
    if (errors.length > 0) throw new NovelConfigError({ message: 'invalid novel config', errors })

    // Read and validate source assets before touching the novels root.
    const characters: Array<{ name: string; card: CharacterCardIR }> = []
    for (const name of config.characterNames) {
      const file = await tavern.getCharacter(name)
      if (file === undefined) {
        throw new NovelConfigError({ message: `source character '${name}' not found (§15: missing assets must fail, not degrade to empty objects)` })
      }
      characters.push({ name, card: file.card })
    }
    // Merge character-embedded world books into the explicit world selection (§5).
    const embeddedWorlds = new Set<string>()
    for (const { card } of characters) {
      const embedded = embeddedWorldName(card)
      if (embedded !== null) embeddedWorlds.add(embedded)
    }
    const worldNames = [...new Set([...config.worldNames, ...embeddedWorlds])]
    const worlds: Array<{ name: string; book: object }> = []
    for (const name of worldNames) {
      const book = await tavern.getWorld(name)
      if (book === undefined) {
        throw new NovelConfigError({ message: `source world '${name}' not found (§15: missing assets must fail, not degrade to empty objects)` })
      }
      worlds.push({ name, book: book as unknown as object })
    }

    const novelId = `nvl-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    return this.mutate(novelId, async () => {
      const dir = this.novelDir(novelId)
      const directories = ['revisions', 'assets', 'bodies', path.join('projections', 'chapters')]
      if (source !== null) directories.push(path.join('imports', 'parts'), path.join('imports', 'extractions'), path.join('imports', 'bibles'))
      for (const sub of directories) {
        await fs.mkdir(path.join(dir, sub), { recursive: true })
      }
      await this.ensureOwnership(novelId, dir)

      // Immutable asset objects, content-addressed by full sha256 (§5, §10.1).
      const assets: NovelAssetRef[] = []
      for (const { name, card } of characters) {
        const contentHash = sha256hex(stableStringify(card))
        await writeImmutableBytes(path.join(dir, 'assets', `${contentHash}.json`), jsonBytes(card))
        assets.push({
          kind: 'character',
          sourceId: name,
          displayName: card.data.name,
          contentHash,
          specVersion: typeof card.specVersion === 'string' && card.specVersion !== '' ? card.specVersion : null,
        })
      }
      for (const { name, book } of worlds) {
        const contentHash = sha256hex(stableStringify(book))
        await writeImmutableBytes(path.join(dir, 'assets', `${contentHash}.json`), jsonBytes(book))
        assets.push({ kind: 'world', sourceId: name, displayName: name, contentHash, specVersion: null })
      }

      const now = new Date().toISOString()
      const imported: NovelImportState | null = source === null
        ? null
        : {
            sourceName: source.name,
            sourceFormat: source.format,
            importedAt: source.importedAt,
            totalCharacters: source.parsed.totalCharacters,
            partTargetCharacters: source.partTargetCharacters,
            chapterSource: source.parsed.chapterSource,
            chapters: source.parsed.chapters.map((chapter) => ({
              chapterId: chapter.chapterId,
              order: chapter.order,
              title: chapter.title,
              effectiveCharacters: chapter.effectiveCharacters,
              partIds: [...chapter.partIds],
            })),
            parts: source.parsed.parts.map((part): ImportedPart => ({
              partId: part.partId,
              chapterId: part.chapterId,
              order: part.order,
              effectiveCharacters: part.effectiveCharacters,
              contentHash: sha256hex(part.text),
              status: 'pending',
              attempts: 0,
              extractionHash: null,
              summary: null,
              error: null,
            })),
            bibleHash: null,
            bibleSummary: null,
          }
      if (source !== null) {
        for (const part of source.parsed.parts) {
          await writeImmutableBytes(path.join(dir, 'imports', 'parts', `${part.partId}.txt`), textBytes(part.text))
        }
      }
      // Manual mode waits for outline approval before any writing (§4.3). An
      // imported project still runs extraction first: part extraction is
      // research, not prose, and the approval gate opens on the continuation
      // outline (createOutline re-enters awaiting-approval in manual mode).
      const runActive = source !== null || config.approvalMode === 'automatic'
      const run: NovelRunState = runActive
        ? {
            status: 'active',
            phase: source === null ? 'outlining' : 'importing',
            pauseReason: null,
            pauseDetail: null,
            resumeHint: null,
            currentUnitId: null,
            turnsRun: 0,
            deduceRuns: 0,
            writerRuns: 0,
            usageSamples: [],
            startedAt: now,
            completedAt: null,
            lastProgressSignature: null,
            stalledTurns: 0,
            consecutiveFailures: 0,
            lastError: null,
            inFlightIntent: null,
            awaitingApprovalRevision: null,
            activeDurationMs: 0,
            activeWindowStart: now,
          }
        : {
            status: 'paused',
            phase: 'outlining',
            pauseReason: 'awaiting-approval',
            pauseDetail: 'manual mode: waiting for the initial outline',
            resumeHint: 'approve the outline after it is created (§4.3)',
            currentUnitId: null,
            turnsRun: 0,
            deduceRuns: 0,
            writerRuns: 0,
            usageSamples: [],
            startedAt: now,
            completedAt: null,
            lastProgressSignature: null,
            stalledTurns: 0,
            consecutiveFailures: 0,
            lastError: null,
            inFlightIntent: null,
            awaitingApprovalRevision: null,
            activeDurationMs: 0,
            activeWindowStart: null,
          }
      // First requirement: the creation requirement with a stable host message
      // id derived from the project id (§4.1: request retries must not register
      // the same directive twice).
      const requirement: RequirementRecord = {
        requirementId: 'req-1',
        hostMessageId: `create:${novelId}`,
        sequence: 1,
        text: config.requirement,
        receivedAt: now,
        receivedUnitId: null,
        status: 'pending',
        appliedRevision: null,
        effectiveLocation: null,
        blockedReason: null,
        supersededBy: null,
        resolvedConflict: null,
      }
      const snapshot: NovelSnapshot = {
        novelId,
        revision: '',
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        // Storage-layer normalization (0007 §8): absent writerMode becomes
        // 'inline' at creation — an explicit default, not mode magic; the
        // panel can switch it later via patchNovelMeta.
        config: { ...structuredClone(config), writerMode: config.writerMode ?? 'inline' },
        assets,
        outline: null,
        requirements: [requirement],
        units: [],
        commits: [],
        completedChapters: [],
        premiseNote: null,
        import: imported,
        bodyRevisions: [],
        run,
        contentRevision: '',
        countPolicyVersion: 1,
      }
      snapshot.contentRevision = contentRevisionOf(snapshot)
      const revision = await this.publish(dir, null, snapshot, source === null ? 'create-novel' : 'create-imported-novel')
      return { novelId, revision, requirementId: 'req-1' }
    })
  }

  async listNovels(): Promise<NovelSummary[]> {
    const summaries: NovelSummary[] = []
    for (const entry of await readDirectories(this.novelsRoot)) {
      // A directory without HEAD.json is a crashed create, never a novel.
      const snapshot = await this.readSnapshot(entry)
      if (snapshot === undefined) continue
      summaries.push(summarizeNovel(snapshot))
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.novelId.localeCompare(right.novelId))
    return summaries
  }

  /** HEAD or referenced revision corruption throws NovelStorageCorruptionError (§10.3). */
  async getNovel(novelId: string): Promise<NovelSnapshot | undefined> {
    return this.readSnapshot(novelId)
  }

  async patchNovelMeta(
    novelId: string,
    input: { expectedRevision: string; patch: { title?: string; genre?: string; premiseNote?: string; budgets?: NovelRunBudgets; writerMode?: WriterMode }; cause: string },
  ): Promise<{ revision: string }> {
    if (typeof input.cause !== 'string' || input.cause.trim() === '') throw new NovelConfigError({ message: 'patch cause must be a non-empty string' })
    const patch = input.patch
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim() === '')) {
      throw new NovelConfigError({ message: 'patch.title must be a non-empty string' })
    }
    if (patch.genre !== undefined && (typeof patch.genre !== 'string' || patch.genre.trim() === '')) {
      throw new NovelConfigError({ message: 'patch.genre must be a non-empty string' })
    }
    if (patch.premiseNote !== undefined && typeof patch.premiseNote !== 'string') {
      throw new NovelConfigError({ message: 'patch.premiseNote must be a string' })
    }
    // 0007 §8: writerMode switches meet the creation contract's enum; a
    // switch only affects the next unit, claimed units finish under the mode
    // they were claimed in (enforced by the caller-side notice branching).
    if (patch.writerMode !== undefined && !isWriterMode(patch.writerMode)) {
      throw new NovelConfigError({
        message: "patch.writerMode must be 'inline' or 'subagent'",
        errors: [{ field: 'writerMode', message: "writerMode must be 'inline' or 'subagent'" }],
      })
    }
    // Edited budgets meet the created ones' contract (§7.1); the panel sends
    // the complete object, so partial objects fall out as field errors.
    const budgetErrors = patch.budgets === undefined ? [] : validateRunBudgets(patch.budgets)
    if (budgetErrors.length > 0) throw new NovelConfigError({ message: 'invalid patch.budgets', errors: budgetErrors })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        config: {
          ...current.config,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
          // Budgets are read fresh from the snapshot by turn accounting
          // (noteTurn/noteDeduceRun), so an edit applies from the next turn
          // without touching a live run (§13).
          ...(patch.budgets !== undefined ? { budgets: structuredClone(patch.budgets) } : {}),
          ...(patch.writerMode !== undefined ? { writerMode: patch.writerMode } : {}),
        },
        premiseNote: patch.premiseNote ?? current.premiseNote,
      }
      const revision = await this.publish(dir, current.revision, next, `patch-meta:${input.cause}`)
      return { revision }
    })
  }

  async deleteNovel(novelId: string): Promise<boolean> {
    return this.mutate(novelId, async () => {
      const dir = this.novelDir(novelId)
      const current = await this.readSnapshot(novelId)
      if (current === undefined) return false
      await this.ensureOwnership(novelId, dir)
      // Drain in-flight projection writes so they cannot recreate the directory.
      await this.projectionTails.drain(novelId)
      await fs.rm(dir, { recursive: true, force: true })
      return true
    })
  }

  /* -------------------- imported source (proposal 0020) -------------------- */

  /** Reads one immutable source part with integrity checks (hash + count). */
  async importSourcePart(novelId: string, partId: string): Promise<{ part: ImportedPart; text: string }> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const part = current.import?.parts.find((candidate) => candidate.partId === partId)
    if (part === undefined) throw new NovelPreconditionError({ rule: 'import-part-not-found', violations: [partId] })
    if (!/^imp-[0-9]+$/.test(part.partId)) {
      throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: 'the import state carries an invalid part id' })
    }
    const dir = this.novelDir(novelId)
    const partPath = path.join(dir, 'imports', 'parts', `${part.partId}.txt`)
    const text = await tryReadText(partPath)
    if (text === undefined) {
      throw new NovelStorageCorruptionError({ novelId, path: partPath, detail: 'imported source part is missing' })
    }
    if (sha256hex(text) !== part.contentHash || countEffectiveCharacters(text) !== part.effectiveCharacters) {
      throw new NovelStorageCorruptionError({ novelId, path: partPath, detail: `imported source part '${part.partId}' does not match its snapshot record` })
    }
    return { part, text }
  }

  /**
   * Counts one extraction attempt before the model runs. A part already
   * extracted is an idempotent no-op; exhausting the retry budget is a hard
   * precondition error so the tool can pause with a concrete reason.
   */
  async beginImportPartAttempt(novelId: string, partId: string): Promise<{ attempt: number; alreadyExtracted: boolean; revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status !== 'active') throw new NovelPreconditionError({ rule: 'not-active' })
      const part = current.import?.parts.find((candidate) => candidate.partId === partId)
      if (part === undefined) throw new NovelPreconditionError({ rule: 'import-part-not-found', violations: [partId] })
      if (part.status === 'extracted') return { attempt: part.attempts, alreadyExtracted: true, revision: current.revision }
      if (part.attempts >= IMPORT_MAX_PART_ATTEMPTS) {
        throw new NovelPreconditionError({
          rule: 'import-part-exhausted',
          violations: [`${part.partId}:${part.attempts}`],
        })
      }
      const attempt = part.attempts + 1
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        import: {
          ...current.import!,
          parts: current.import!.parts.map((candidate) => candidate.partId === partId
            ? { ...candidate, attempts: attempt, status: 'pending' as const, error: null }
            : candidate),
        },
      }
      const revision = await this.publish(dir, current.revision, next, `import-attempt:${partId}:${attempt}`)
      return { attempt, alreadyExtracted: false, revision }
    })
  }

  async recordImportExtraction(
    novelId: string,
    input: { partId: string; extraction: ImportExtraction },
  ): Promise<{ revision: string; duplicate: boolean; extractedParts: number; partCount: number }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status !== 'active') throw new NovelPreconditionError({ rule: 'not-active' })
      const part = current.import?.parts.find((candidate) => candidate.partId === input.partId)
      if (part === undefined) throw new NovelPreconditionError({ rule: 'import-part-not-found', violations: [input.partId] })
      const extraction = normaliseImportExtraction(input.extraction, part.partId, part.chapterId)
      const extractionHash = sha256hex(stableStringify(extraction))
      if (part.status === 'extracted') {
        if (part.extractionHash === extractionHash) {
          return {
            revision: current.revision,
            duplicate: true,
            extractedParts: current.import!.parts.filter((candidate) => candidate.status === 'extracted').length,
            partCount: current.import!.parts.length,
          }
        }
        throw new NovelPreconditionError({ rule: 'import-part-extracted', violations: [part.partId] })
      }
      await writeImmutableBytes(path.join(dir, 'imports', 'extractions', `${extractionHash}.json`), jsonBytes(extraction))
      const parts = current.import!.parts.map((candidate) => candidate.partId === part.partId
        ? {
            ...candidate,
            status: 'extracted' as const,
            extractionHash,
            summary: extraction.summary,
            error: null,
          }
        : candidate)
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        import: { ...current.import!, parts },
      }
      const revision = await this.publish(dir, current.revision, next, `import-extraction:${part.partId}`)
      return {
        revision,
        duplicate: false,
        extractedParts: parts.filter((candidate) => candidate.status === 'extracted').length,
        partCount: parts.length,
      }
    })
  }

  async failImportPart(
    novelId: string,
    input: { partId: string; error: string },
  ): Promise<{ revision: string; attempts: number; exhausted: boolean; pending: number }> {
    if (typeof input.error !== 'string' || input.error.trim() === '') throw new NovelConfigError({ message: 'import failure reason must be a non-empty string' })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const part = current.import?.parts.find((candidate) => candidate.partId === input.partId)
      if (part === undefined) throw new NovelPreconditionError({ rule: 'import-part-not-found', violations: [input.partId] })
      if (part.status === 'extracted') {
        return {
          revision: current.revision,
          attempts: part.attempts,
          exhausted: false,
          pending: current.import!.parts.filter((candidate) => candidate.status !== 'extracted').length,
        }
      }
      const error = input.error.length <= 1200 ? input.error : `${input.error.slice(0, 1200)}…`
      const parts = current.import!.parts.map((candidate) => candidate.partId === part.partId
        ? { ...candidate, status: 'failed' as const, error }
        : candidate)
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        import: { ...current.import!, parts },
      }
      const revision = await this.publish(dir, current.revision, next, `import-failure:${part.partId}`)
      return {
        revision,
        attempts: part.attempts,
        exhausted: part.attempts >= IMPORT_MAX_PART_ATTEMPTS,
        pending: parts.filter((candidate) => candidate.status !== 'extracted').length,
      }
    })
  }

  async readImportExtraction(novelId: string, partId: string): Promise<ImportExtraction | undefined> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const part = current.import?.parts.find((candidate) => candidate.partId === partId)
    if (part === undefined) throw new NovelPreconditionError({ rule: 'import-part-not-found', violations: [partId] })
    if (part.extractionHash === null) return undefined
    if (!/^[0-9a-f]{64}$/.test(part.extractionHash)) {
      throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: `part '${partId}' carries an invalid extraction hash` })
    }
    return this.readImmutableJson<ImportExtraction>(novelId, path.join('imports', 'extractions', `${part.extractionHash}.json`), 'import extraction')
  }

  async readImportBible(novelId: string): Promise<ImportBibleRecord | undefined> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const hash = current.import?.bibleHash ?? null
    if (hash === null) return undefined
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: 'the import state carries an invalid bible hash' })
    }
    return this.readImmutableJson<ImportBibleRecord>(novelId, path.join('imports', 'bibles', `${hash}.json`), 'import bible')
  }

  /**
   * Fuses extraction results into the project bible and materialises character
   * and world assets (proposal 0020 §4). All parts must be extracted first;
   * retries with the same bible replay the existing receipt.
   */
  async applyImportMerge(
    novelId: string,
    input: { expectedRevision: string; bible: ImportBiblePayload },
  ): Promise<{ revision: string; bibleRevision: string; assetsAdded: number; summary: ImportBibleSummary; duplicate: boolean }> {
    const bible = normaliseImportBible(input.bible)
    const bibleRevision = hash16(bible)
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const state = current.import
      if (state === null || state === undefined) throw new NovelPreconditionError({ rule: 'import-missing' })
      if (state.bibleHash !== null) {
        if (!/^[0-9a-f]{64}$/.test(state.bibleHash)) {
          throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: 'the import state carries an invalid bible hash' })
        }
        const existing = await this.readImmutableJson<ImportBibleRecord>(novelId, path.join('imports', 'bibles', `${state.bibleHash}.json`), 'import bible')
        if (existing.bibleRevision === bibleRevision) {
          const summary = state.bibleSummary ?? bibleSummaryOf(existing)
          return { revision: current.revision, bibleRevision, assetsAdded: 0, summary, duplicate: true }
        }
        throw new NovelPreconditionError({ rule: 'import-already-merged', violations: [state.bibleHash] })
      }
      if (current.run.status !== 'active') throw new NovelPreconditionError({ rule: 'not-active' })
      this.assertRevision(current, input.expectedRevision)
      const pending = state.parts.filter((part) => part.status !== 'extracted')
      if (pending.length > 0) {
        throw new NovelPreconditionError({ rule: 'import-parts-pending', violations: pending.slice(0, 20).map((part) => part.partId) })
      }
      const mergedAt = new Date().toISOString()
      const record: ImportBibleRecord = {
        ...bible,
        bibleRevision,
        mergedAt,
        sourcePartCount: state.parts.length,
      }
      const bibleHash = sha256hex(stableStringify(record))
      await writeImmutableBytes(path.join(dir, 'imports', 'bibles', `${bibleHash}.json`), jsonBytes(record))

      const assets = [...current.assets]
      const knownHashes = new Set(assets.map((asset) => asset.contentHash))
      let assetsAdded = 0
      const characterNames = new Set<string>()
      for (const character of bible.characters) {
        const card = importCharacterCard(character)
        const contentHash = sha256hex(stableStringify(card))
        if (!knownHashes.has(contentHash)) {
          await writeImmutableBytes(path.join(dir, 'assets', `${contentHash}.json`), jsonBytes(card))
          knownHashes.add(contentHash)
          assetsAdded += 1
        }
        let displayName = character.name
        let suffix = 2
        while (characterNames.has(displayName)) {
          displayName = `${character.name} (${suffix})`
          suffix += 1
        }
        characterNames.add(displayName)
        if (!assets.some((asset) => asset.contentHash === contentHash)) {
          assets.push({
            kind: 'character',
            sourceId: `import:${displayName}`,
            displayName,
            contentHash,
            specVersion: '2.0',
          })
        }
      }
      if (bible.worldEntries.length > 0) {
        const world = importWorldBook(current.config.title, bible.worldEntries)
        const contentHash = sha256hex(stableStringify(world))
        if (!knownHashes.has(contentHash)) {
          await writeImmutableBytes(path.join(dir, 'assets', `${contentHash}.json`), jsonBytes(world))
          knownHashes.add(contentHash)
          assetsAdded += 1
        }
        if (!assets.some((asset) => asset.contentHash === contentHash)) {
          assets.push({
            kind: 'world',
            sourceId: `import:${current.config.title}`,
            displayName: world.name,
            contentHash,
            specVersion: null,
          })
        }
      }
      const summary = bibleSummaryOf(record)
      const next: NovelSnapshot = {
        ...current,
        updatedAt: mergedAt,
        assets,
        import: { ...state, bibleHash, bibleSummary: summary },
        run: current.run.status === 'active' ? { ...current.run, phase: 'outlining' } : current.run,
      }
      const revision = await this.publish(dir, current.revision, next, `import-merge:${bibleRevision}`)
      return { revision, bibleRevision, assetsAdded, summary, duplicate: false }
    })
  }

  /**
   * Merge digest for the author agent (proposal 0020 §4.2): sampled summaries,
   * deduped characters/world entries, timeline head+tail and the source tail.
   * Bounded by design so a 100-part book never overflows the author context.
   */
  async readImportDigest(novelId: string): Promise<ReturnType<typeof buildImportDigest> | undefined> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const state = current.import
    if (state === null || state === undefined) return undefined
    const extractions: ImportExtraction[] = []
    for (const part of state.parts) {
      if (part.extractionHash === null) continue
      if (!/^[0-9a-f]{64}$/.test(part.extractionHash)) {
        throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: `part '${part.partId}' carries an invalid extraction hash` })
      }
      extractions.push(await this.readImmutableJson<ImportExtraction>(novelId, path.join('imports', 'extractions', `${part.extractionHash}.json`), 'import extraction'))
    }
    return buildImportDigest({ state, extractions, sourceTail: await this.importSourceTail(novelId, 4000) })
  }

  /** Tail of the imported source, read from the last parts backwards. */
  async importSourceTail(novelId: string, maxCharacters: number): Promise<string> {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new NovelConfigError({ message: 'maxCharacters must be a positive integer' })
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const state = current.import
    if (state === null || state === undefined) return ''
    let tail = ''
    for (let index = state.parts.length - 1; index >= 0 && tail.length < maxCharacters; index -= 1) {
      const part = state.parts[index]!
      const source = await this.importSourcePart(novelId, part.partId)
      tail = tail === '' ? source.text : `${source.text}\n\n${tail}`
    }
    return tail.slice(-maxCharacters)
  }

  /**
   * Pages the imported source by chapter or part. Cursors are character
   * offsets; text is returned verbatim and bounded by `limit`.
   */
  async readImportSource(
    novelId: string,
    query: { chapterId?: string; partId?: string; cursor?: string; limit?: number },
  ): Promise<{ text: string; nextCursor: string | null; chapterId: string | null; partId: string | null; title: string | null }> {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new NovelConfigError({ message: 'limit must be a positive integer' })
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor)
    if (!Number.isInteger(cursor) || cursor < 0) throw new NovelConfigError({ message: 'cursor must be a non-negative integer string' })
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const state = current.import
    if (state === null || state === undefined) throw new NovelPreconditionError({ rule: 'import-missing' })
    let selected = [...state.parts].sort((left, right) => left.order - right.order)
    let title: string | null = null
    if (query.partId !== undefined) {
      selected = selected.filter((part) => part.partId === query.partId)
      title = state.chapters.find((chapter) => chapter.chapterId === selected[0]?.chapterId)?.title ?? null
    } else if (query.chapterId !== undefined) {
      selected = selected.filter((part) => part.chapterId === query.chapterId)
      title = state.chapters.find((chapter) => chapter.chapterId === query.chapterId)?.title ?? null
    }
    if (selected.length === 0) throw new NovelPreconditionError({ rule: 'import-chapter-not-found', violations: [query.chapterId ?? query.partId ?? ''] })
    const texts: string[] = []
    for (const part of selected) {
      texts.push((await this.importSourcePart(novelId, part.partId)).text)
    }
    const full = texts.join('\n\n')
    const limit = query.limit ?? 12000
    const text = full.slice(cursor, cursor + limit)
    return {
      text,
      nextCursor: cursor + text.length < full.length ? String(cursor + text.length) : null,
      chapterId: query.partId !== undefined ? selected[0]!.chapterId : query.chapterId ?? null,
      partId: query.partId ?? null,
      title,
    }
  }

  /** Ordered scan over imported source parts; returns bounded excerpts. */
  async searchImportSource(
    novelId: string,
    input: { query: string; limit: number },
  ): Promise<{ hits: Array<{ partId: string; chapterId: string; chapterTitle: string; partOrder: number; excerpt: string }>; scannedParts: number; truncated: boolean }> {
    if (typeof input.query !== 'string' || input.query.trim() === '') throw new NovelConfigError({ message: 'query must be a non-empty string' })
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new NovelConfigError({ message: 'limit must be a positive integer' })
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const state = current.import
    if (state === null || state === undefined) throw new NovelPreconditionError({ rule: 'import-missing' })
    const tokens = [...new Set(input.query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    if (tokens.length === 0) throw new NovelConfigError({ message: 'query contains no searchable tokens' })
    const chapterTitle = new Map(state.chapters.map((chapter) => [chapter.chapterId, chapter.title]))
    const hits: Array<{ partId: string; chapterId: string; chapterTitle: string; partOrder: number; excerpt: string }> = []
    let truncated = false
    let scannedParts = 0
    for (const part of [...state.parts].sort((left, right) => left.order - right.order)) {
      scannedParts += 1
      const text = (await this.importSourcePart(novelId, part.partId)).text
      const haystack = text.toLocaleLowerCase()
      if (!tokens.every((token) => haystack.includes(token))) continue
      if (hits.length >= input.limit) {
        truncated = true
        break
      }
      hits.push({
        partId: part.partId,
        chapterId: part.chapterId,
        chapterTitle: chapterTitle.get(part.chapterId) ?? part.chapterId,
        partOrder: part.order,
        excerpt: excerptAround(text, tokens, 500),
      })
    }
    return { hits, scannedParts, truncated }
  }

  /* --------------------- body revisions (proposal 0020 §5) --------------------- */

  /** Stages a pending replacement of a chapter's effective body. */
  async createBodyRevision(
    novelId: string,
    input: { chapterId: string; instruction: string; paragraphs: readonly string[]; expectedContentRevision: string },
  ): Promise<{ revisionId: string; revision: string; bodyHash: string; effectiveCharacters: number }> {
    if (typeof input.instruction !== 'string' || input.instruction.trim() === '') throw new NovelConfigError({ message: 'revision instruction must be a non-empty string' })
    if (input.instruction.length > 4000) throw new NovelConfigError({ message: 'revision instruction exceeds 4000 characters' })
    if (!Array.isArray(input.paragraphs) || input.paragraphs.length === 0) throw new NovelConfigError({ message: 'revision paragraphs must be a non-empty array' })
    for (const paragraph of input.paragraphs) {
      if (typeof paragraph !== 'string' || paragraph.trim() === '') throw new NovelConfigError({ message: 'revision paragraphs must be non-empty strings' })
      if (paragraph.includes(PARAGRAPH_SEPARATOR)) throw new NovelConfigError({ message: `paragraph must not contain the fixed separator '${JSON.stringify(PARAGRAPH_SEPARATOR)}'` })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.contentRevision !== input.expectedContentRevision) {
        // The optimizer read an older effective body; committing this revision
        // would silently drop commits or a newer applied revision.
        throw new NovelRevisionConflictError({ expected: input.expectedContentRevision, actual: current.contentRevision, detail: 'contentRevision' })
      }
      const chapterExists = current.outline?.chapters.some((chapter) => chapter.chapterId === input.chapterId)
        ?? false
      if (!chapterExists) throw new NovelPreconditionError({ rule: 'chapter-not-found', violations: [input.chapterId] })
      if (current.units.some((unit) => unit.chapterId === input.chapterId && unit.state === 'claimed')) {
        throw new NovelPreconditionError({ rule: 'unit-claimed', violations: [input.chapterId] })
      }
      const commits = current.commits.filter((commit) => commit.chapterId === input.chapterId)
      if (commits.length === 0) throw new NovelPreconditionError({ rule: 'chapter-empty', violations: [input.chapterId] })
      const paragraphs = [...input.paragraphs]
      const bodyHash = sha256hex(stableStringify(paragraphs))
      const effectiveCharacters = paragraphs.reduce((total, paragraph) => total + countEffectiveCharacters(paragraph), 0)
      if (effectiveCharacters === 0) throw new NovelConfigError({ message: 'revision paragraphs contain no effective characters' })
      await writeImmutableBytes(path.join(dir, 'bodies', `${bodyHash}.txt`), textBytes(paragraphs.join(PARAGRAPH_SEPARATOR)))
      const now = new Date().toISOString()
      const records = (current.bodyRevisions ?? []).map((record) => record.chapterId === input.chapterId && record.status === 'pending'
        ? { ...record, status: 'discarded' as const }
        : record)
      const record: BodyRevisionRecord = {
        revisionId: `rev-${randomBytes(6).toString('hex')}`,
        chapterId: input.chapterId,
        instruction: input.instruction.trim(),
        bodyHash,
        paragraphCount: paragraphs.length,
        effectiveCharacters,
        coveredCommitIds: commits.map((commit) => commit.commitId),
        baseContentRevision: input.expectedContentRevision,
        status: 'pending',
        createdAt: now,
        appliedAt: null,
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: now,
        bodyRevisions: [...records, record],
      }
      const revision = await this.publish(dir, current.revision, next, `body-revision:${record.revisionId}`)
      return { revisionId: record.revisionId, revision, bodyHash, effectiveCharacters }
    })
  }

  /** Applies a pending revision; the previous applied revision becomes superseded. */
  async applyBodyRevision(
    novelId: string,
    input: { revisionId: string; expectedRevision: string },
  ): Promise<{ revision: string; effectiveCharacters: number; totalCharacters: number }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      const record = (current.bodyRevisions ?? []).find((candidate) => candidate.revisionId === input.revisionId)
      if (record === undefined) throw new NovelPreconditionError({ rule: 'body-revision-not-found', violations: [input.revisionId] })
      if (record.status !== 'pending') throw new NovelPreconditionError({ rule: 'body-revision-not-pending', violations: [`${record.revisionId}:${record.status}`] })
      if (current.contentRevision !== record.baseContentRevision) {
        throw new NovelRevisionConflictError({ expected: record.baseContentRevision, actual: current.contentRevision, detail: 'body revision base content' })
      }
      if (current.units.some((unit) => unit.chapterId === record.chapterId && unit.state === 'claimed')) {
        throw new NovelPreconditionError({ rule: 'unit-claimed', violations: [record.chapterId] })
      }
      if (!/^[0-9a-f]{64}$/.test(record.bodyHash)) {
        throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: `body revision '${record.revisionId}' carries an invalid body hash` })
      }
      const revisionParagraphs = await this.readBodyParagraphs(novelId, dir, record.bodyHash, record.paragraphCount)
      const revisionCharacters = revisionParagraphs.reduce((total, paragraph) => total + countEffectiveCharacters(paragraph), 0)
      if (revisionCharacters !== record.effectiveCharacters) {
        throw new NovelStorageCorruptionError({ novelId, path: path.join(dir, 'bodies', `${record.bodyHash}.txt`), detail: `body revision '${record.revisionId}' effective characters do not match its record` })
      }
      const chapterBefore = effectiveChapterCharacters(current, record.chapterId)
      const totalAfter = effectiveNovelCharacters(current) - chapterBefore + record.effectiveCharacters
      const budget = current.config.lengthBudget
      if (budget.kind === 'target' && budget.hardMaximumCharacters !== null && totalAfter > budget.hardMaximumCharacters) {
        throw new NovelLengthLimitError({ current: totalAfter, target: budget.targetCharacters, hardMaximum: budget.hardMaximumCharacters })
      }
      const now = new Date().toISOString()
      const records = (current.bodyRevisions ?? []).map((candidate) => {
        if (candidate.chapterId !== record.chapterId) return candidate
        if (candidate.revisionId === record.revisionId) return { ...candidate, status: 'applied' as const, appliedAt: now }
        if (candidate.status === 'applied') return { ...candidate, status: 'superseded' as const }
        return candidate
      })
      const next: NovelSnapshot = { ...current, updatedAt: now, bodyRevisions: records }
      next.contentRevision = contentRevisionOf(next)
      const revision = await this.publish(dir, current.revision, next, `body-revision-apply:${record.revisionId}`)
      return { revision, effectiveCharacters: record.effectiveCharacters, totalCharacters: totalAfter }
    })
  }

  async discardBodyRevision(
    novelId: string,
    input: { revisionId: string; expectedRevision: string },
  ): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      const record = (current.bodyRevisions ?? []).find((candidate) => candidate.revisionId === input.revisionId)
      if (record === undefined) throw new NovelPreconditionError({ rule: 'body-revision-not-found', violations: [input.revisionId] })
      if (record.status !== 'pending') throw new NovelPreconditionError({ rule: 'body-revision-not-pending', violations: [`${record.revisionId}:${record.status}`] })
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        bodyRevisions: (current.bodyRevisions ?? []).map((candidate) => candidate.revisionId === record.revisionId
          ? { ...candidate, status: 'discarded' as const }
          : candidate),
      }
      next.contentRevision = contentRevisionOf(next)
      const revision = await this.publish(dir, current.revision, next, `body-revision-discard:${record.revisionId}`)
      return { revision }
    })
  }

  async readBodyRevision(novelId: string, revisionId: string): Promise<{ record: BodyRevisionRecord; paragraphs: readonly string[] }> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const record = (current.bodyRevisions ?? []).find((candidate) => candidate.revisionId === revisionId)
    if (record === undefined) throw new NovelPreconditionError({ rule: 'body-revision-not-found', violations: [revisionId] })
    if (!/^[0-9a-f]{64}$/.test(record.bodyHash)) {
      throw new NovelStorageCorruptionError({ novelId, path: this.novelDir(novelId), detail: `body revision '${revisionId}' carries an invalid body hash` })
    }
    const dir = this.novelDir(novelId)
    const paragraphs = await this.readBodyParagraphs(novelId, dir, record.bodyHash, record.paragraphCount)
    const counted = paragraphs.reduce((total, paragraph) => total + countEffectiveCharacters(paragraph), 0)
    if (counted !== record.effectiveCharacters) {
      throw new NovelStorageCorruptionError({ novelId, path: path.join(dir, 'bodies', `${record.bodyHash}.txt`), detail: `body revision '${revisionId}' effective characters do not match its record` })
    }
    return { record, paragraphs }
  }

  /* --------------------------- requirements (§9) --------------------------- */

  /**
   * Registers an author directive. Idempotent on hostMessageId (§9.1).
   * Completed novels reject new directives with NovelCapabilityError (§9.2).
   */
  async receiveRequirement(
    novelId: string,
    input: { hostMessageId: string; text: string; sourceKind: 'composer' | 'panel' | 'internal' },
  ): Promise<{ requirementId: string; sequence: number; revision: string; duplicate: boolean }> {
    if (typeof input.hostMessageId !== 'string' || input.hostMessageId.trim() === '') throw new NovelConfigError({ message: 'hostMessageId must be a non-empty string' })
    if (typeof input.text !== 'string' || input.text.trim() === '') throw new NovelConfigError({ message: 'requirement text must be a non-empty string' })
    if (!REQUIREMENT_SOURCES.has(input.sourceKind)) throw new NovelConfigError({ message: `sourceKind must be one of composer|panel|internal` })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') {
        throw new NovelCapabilityError({ reason: 'novel completed: new requirements are rejected; create a new novel instead (§9.2)' })
      }
      const existing = current.requirements.find((record) => record.hostMessageId === input.hostMessageId)
      if (existing !== undefined) {
        return { requirementId: existing.requirementId, sequence: existing.sequence, revision: current.revision, duplicate: true }
      }
      const sequence = current.requirements.reduce((max, record) => Math.max(max, record.sequence), 0) + 1
      const record: RequirementRecord = {
        requirementId: `req-${sequence}`,
        hostMessageId: input.hostMessageId,
        sequence,
        text: input.text,
        receivedAt: new Date().toISOString(),
        receivedUnitId: current.run.currentUnitId,
        status: 'pending',
        appliedRevision: null,
        effectiveLocation: null,
        blockedReason: null,
        supersededBy: null,
        resolvedConflict: null,
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: record.receivedAt,
        requirements: [...current.requirements, record],
      }
      const revision = await this.publish(dir, current.revision, next, `requirement:${sequence}`)
      return { requirementId: record.requirementId, sequence, revision, duplicate: false }
    })
  }

  /* ----------------------------- outline (§6) ----------------------------- */

  /** Creates the initial outline and processes the first requirement batch (§4.3). */
  async createOutline(
    novelId: string,
    input: { expectedRevision: string; outline: NovelOutlinePayload; handledRequirements: readonly HandledRequirement[] },
  ): Promise<{ outlineRevision: string; revision: string; watermark: number }> {
    const payloadErrors = validateOutlinePayload(input.outline)
    if (payloadErrors.length > 0) throw new NovelConfigError({ message: outlinePayloadErrorMessage(payloadErrors), errors: payloadErrors })
    const chapters = materializeOutlineChapters(input.outline.chapters, new Map())
    const consistencyErrors = validateOutlineConsistency(chapters, input.outline.currentChapterId)
    if (consistencyErrors.length > 0) throw new NovelConfigError({ message: outlinePayloadErrorMessage(consistencyErrors), errors: consistencyErrors })
    if (input.outline.droppedChapterIds?.length) {
      throw new NovelConfigError({
        message: outlinePayloadErrorMessage([{ field: 'droppedChapterIds', message: 'nothing can be dropped when creating the initial outline' }]),
        errors: [{ field: 'droppedChapterIds', message: 'nothing can be dropped when creating the initial outline' }],
      })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      if (current.outline !== null) throw new NovelPreconditionError({ rule: 'outline-exists' })
      const handled = this.validateHandledRequirements(current, input.handledRequirements)
      const outlineRevision = hash16({ kind: 'outline', parent: null, reason: 'initial outline', payload: input.outline })
      const built: NovelOutline = {
        outlineRevision,
        parentRevision: null,
        reason: 'initial outline',
        sourceRequirementIds: handled.map((item) => item.requirementId),
        story: structuredClone(input.outline.story),
        characters: structuredClone(input.outline.characters),
        chapters,
        currentChapterId: input.outline.currentChapterId,
        scenes: structuredClone(input.outline.scenes),
        foreshadowing: structuredClone(input.outline.foreshadowing),
      }
      const requirements = applyHandledRequirements(current.requirements, handled, outlineRevision)
      const watermark = assertWatermarkAdvanced(current.requirements, requirements)
      const run = this.runAfterOutlineChange(current.run, current.config.approvalMode, outlineRevision, requirements, true)
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), outline: built, requirements, run }
      const revision = await this.publish(dir, current.revision, next, `outline-create:${outlineRevision}`)
      return { outlineRevision, revision, watermark }
    })
  }

  /**
   * Atomically revises the plan and the handled requirement results (§9.3).
   * Rejected while any unit is claimed (§9.2) and never drops or reorders
   * chapters that contain committed bodies (§6.1).
   *
   * `changes` is an overlay across every layer (§6.1, 2026-10-09): chapters
   * upsert by id with omitted optional fields inherited, and every other
   * collection (story, characters, scenes, foreshadowing, currentChapterId)
   * is carried forward from the previous outline when omitted — a present
   * layer replaces wholesale, so an explicit [] clears it. A model working
   * from a windowed novel_outline_read advances the plan by submitting only
   * what it changes.
   */
  async reviseOutline(
    novelId: string,
    input: { expectedRevision: string; expectedOutlineRevision: string; reason: string; changes: NovelOutlineChanges; handledRequirements: readonly HandledRequirement[] },
  ): Promise<{ outlineRevision: string; revision: string; watermark: number }> {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new NovelConfigError({ message: 'revision reason must be a non-empty string' })
    const payloadErrors = validateOutlinePayload(input.changes, 'revise')
    if (payloadErrors.length > 0) throw new NovelConfigError({ message: outlinePayloadErrorMessage(payloadErrors), errors: payloadErrors })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      const previous = current.outline
      if (previous === null) throw new NovelPreconditionError({ rule: 'outline-missing' })
      if (previous.outlineRevision !== input.expectedOutlineRevision) {
        throw new NovelRevisionConflictError({ expected: input.expectedOutlineRevision, actual: previous.outlineRevision, detail: 'outline revision' })
      }
      if (current.units.some((unit) => unit.state === 'claimed')) {
        // §9.2: outline revisions require no claimed writing units.
        throw new NovelRevisionConflictError({ expected: input.expectedRevision, actual: current.revision, detail: 'claimed writing units in flight' })
      }
      this.assertChapterDropDeclarations(previous, input.changes)
      const previousById = new Map(previous.chapters.map((chapter) => [chapter.chapterId, chapter]))
      const chapters = materializeOutlineChapters(input.changes.chapters ?? [], previousById, input.changes.droppedChapterIds)
      // §6.1 overlay (2026-10-09): omitted layers are carried forward from the
      // previous outline; a present layer replaces wholesale ([] clears it).
      const story = input.changes.story ?? previous.story
      const characters = input.changes.characters ?? previous.characters
      const scenes = input.changes.scenes ?? previous.scenes
      const foreshadowing = input.changes.foreshadowing ?? previous.foreshadowing
      const currentChapterId = input.changes.currentChapterId !== undefined ? input.changes.currentChapterId : previous.currentChapterId
      const consistencyErrors = validateOutlineConsistency(chapters, currentChapterId)
      if (consistencyErrors.length > 0) {
        throw new NovelConfigError({ message: outlinePayloadErrorMessage(consistencyErrors), errors: consistencyErrors })
      }
      this.assertProtectedChapters(previous, current, chapters)
      const handled = this.validateHandledRequirements(current, input.handledRequirements)
      const outlineRevision = hash16({ kind: 'outline', parent: previous.outlineRevision, reason: input.reason, payload: { story, characters, chapters, currentChapterId, scenes, foreshadowing } })
      const built: NovelOutline = {
        outlineRevision,
        parentRevision: previous.outlineRevision,
        reason: input.reason,
        sourceRequirementIds: handled.map((item) => item.requirementId),
        story: structuredClone(story),
        characters: structuredClone(characters),
        chapters,
        currentChapterId,
        scenes: structuredClone(scenes),
        foreshadowing: structuredClone(foreshadowing),
      }
      const requirements = applyHandledRequirements(current.requirements, handled, outlineRevision)
      const watermark = assertWatermarkAdvanced(current.requirements, requirements)
      const run = this.runAfterOutlineChange(current.run, current.config.approvalMode, outlineRevision, requirements, false)
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), outline: built, requirements, run }
      const revision = await this.publish(dir, current.revision, next, `outline-revise:${outlineRevision}`)
      return { outlineRevision, revision, watermark }
    })
  }

  /** Marks a requirement as blocked against committed facts and pauses (§9.4). */
  async blockRequirement(
    novelId: string,
    input: { expectedRevision: string; requirementId: string; conflictReason: string; bodySources: readonly string[] },
  ): Promise<{ revision: string }> {
    if (typeof input.conflictReason !== 'string' || input.conflictReason.trim() === '') throw new NovelConfigError({ message: 'conflictReason must be a non-empty string' })
    if (!Array.isArray(input.bodySources) || input.bodySources.some((source) => typeof source !== 'string')) {
      throw new NovelConfigError({ message: 'bodySources must be an array of strings' })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      this.assertRevision(current, input.expectedRevision)
      const record = current.requirements.find((item) => item.requirementId === input.requirementId)
      if (record === undefined) {
        throw new NovelRequirementConflictError({ requirementId: input.requirementId, conflictReason: 'requirement not found' })
      }
      if (record.status !== 'pending' && record.status !== 'blocked') {
        throw new NovelRequirementConflictError({ requirementId: record.requirementId, conflictReason: `requirement is '${record.status}', only pending requirements can be blocked`, bodySources: input.bodySources })
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        requirements: current.requirements.map((item) => item.requirementId === record.requirementId
          ? { ...item, status: 'blocked' as RequirementStatus, blockedReason: input.conflictReason }
          : item),
        run: {
          ...current.run,
          status: 'paused',
          pauseReason: 'requirement-conflict',
          pauseDetail: `${input.conflictReason}${input.bodySources.length > 0 ? ` (sources: ${input.bodySources.join(', ')})` : ''}`,
          resumeHint: 'clarify or withdraw the requirement, then resume (§9.4)',
        },
      }
      const revision = await this.publish(dir, current.revision, next, `requirement-block:${record.requirementId}`)
      return { revision }
    })
  }

  /* ------------------------------ units (§6.2) ------------------------------ */

  async prepareUnit(
    novelId: string,
    input: { chapterId: string; sceneId: string; label: string; goal: string; continuationAnchor?: string | null },
  ): Promise<{ unitId: string }> {
    for (const [field, value] of [['chapterId', input.chapterId], ['sceneId', input.sceneId], ['label', input.label], ['goal', input.goal]] as const) {
      if (typeof value !== 'string' || value.trim() === '') throw new NovelConfigError({ message: `${field} must be a non-empty string` })
    }
    if (input.continuationAnchor !== undefined && input.continuationAnchor !== null && typeof input.continuationAnchor !== 'string') {
      throw new NovelConfigError({ message: 'continuationAnchor must be a string or null' })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status !== 'active') throw new NovelPreconditionError({ rule: 'not-active' })
      const outline = current.outline ?? (() => { throw new NovelPreconditionError({ rule: 'outline-missing' }) })()
      if (!outline.chapters.some((chapter) => chapter.chapterId === input.chapterId)) throw new NovelPreconditionError({ rule: 'chapter-not-found', violations: [input.chapterId] })
      if (!outline.scenes.some((scene) => scene.sceneId === input.sceneId)) throw new NovelPreconditionError({ rule: 'scene-not-found', violations: [input.sceneId] })
      // Preparing a scene with an in-flight unit (prepared or claimed) returns
      // that unit instead of creating a second one: a claimed unit is being
      // written, and a duplicate would strand and later fail finish-guards as
      // unit-in-flight. Committed units do not block: continuation fragments
      // prepare a fresh unit after the previous one committed.
      const existing = current.units.find((unit) => unit.chapterId === input.chapterId && unit.sceneId === input.sceneId && (unit.state === 'prepared' || unit.state === 'claimed'))
      if (existing !== undefined) return { unitId: existing.unitId }
      const unitId = `unit-${current.units.length + 1}`
      const unit: WritingUnit = {
        unitId,
        chapterId: input.chapterId,
        sceneId: input.sceneId,
        label: input.label,
        state: 'prepared',
        attempt: 0,
        claimedRevision: null,
        claimedRequirementSequence: null,
        hostTurn: null,
        goal: input.goal,
        continuationAnchor: input.continuationAnchor ?? null,
        lastError: null,
        executionTokenHash: null,
      }
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), units: [...current.units, unit] }
      await this.publish(dir, current.revision, next, `prepare-unit:${unitId}`)
      return { unitId }
    })
  }

  /** Retires an unclaimed unit (§6.2); claimed units must finish, be released (releaseClaim) or be stopped. */
  async supersedeUnit(novelId: string, input: { unitId: string; reason: string }): Promise<void> {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new NovelConfigError({ message: 'reason must be a non-empty string' })
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const unit = current.units.find((item) => item.unitId === input.unitId)
      if (unit === undefined) throw new NovelPreconditionError({ rule: 'unit-not-found', violations: [input.unitId] })
      if (unit.state === 'claimed') throw new NovelPreconditionError({ rule: 'unit-claimed', violations: [input.unitId] })
      if (unit.state !== 'prepared') throw new NovelPreconditionError({ rule: 'unit-not-prepared', violations: [input.unitId] })
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        units: current.units.map((item) => item.unitId === unit.unitId
          ? { ...item, state: 'superseded' as const, lastError: input.reason, executionTokenHash: null }
          : item),
      }
      await this.publish(dir, current.revision, next, `supersede-unit:${unit.unitId}`)
    })
  }

  /**
   * Claims a unit: requires status active, every received requirement processed
   * with none blocked (§9.2), outline revision and watermark CAS, and the unit
   * still prepared. Attempt increments on every claim (§6.2).
   */
  async claimUnit(
    novelId: string,
    input: { unitId: string; expectedOutlineRevision: string; expectedRequirementSequence: number; hostTurn?: number | null },
  ): Promise<{ unitId: string; executionToken: string; attempt: number }> {
    if (!Number.isInteger(input.expectedRequirementSequence) || input.expectedRequirementSequence < 0) {
      throw new NovelConfigError({ message: 'expectedRequirementSequence must be a non-negative integer' })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status !== 'active') throw new NovelPreconditionError({ rule: 'not-active' })
      // §12.1: claim re-verifies versions first (outline revision, watermark),
      // then run/requirement preconditions.
      const outline = current.outline ?? (() => { throw new NovelPreconditionError({ rule: 'outline-missing' }) })()
      if (outline.outlineRevision !== input.expectedOutlineRevision) {
        throw new NovelRevisionConflictError({ expected: input.expectedOutlineRevision, actual: outline.outlineRevision, detail: 'outline revision at claim' })
      }
      const watermark = requirementWatermark(current.requirements)
      if (watermark !== input.expectedRequirementSequence) {
        throw new NovelRevisionConflictError({ expected: String(input.expectedRequirementSequence), actual: String(watermark), detail: 'requirement watermark at claim' })
      }
      const unprocessed = current.requirements
        .filter((record) => record.status === 'pending' || record.status === 'blocked')
        .map((record) => `${record.requirementId}:${record.status}`)
      if (unprocessed.length > 0) throw new NovelPreconditionError({ rule: 'requirements-unprocessed', violations: unprocessed })
      if (current.units.some((unit) => unit.state === 'claimed')) throw new NovelPreconditionError({ rule: 'unit-in-flight' })
      const unit = current.units.find((item) => item.unitId === input.unitId)
      if (unit === undefined) throw new NovelPreconditionError({ rule: 'unit-not-found', violations: [input.unitId] })
      if (unit.state !== 'prepared') throw new NovelStaleUnitError({ unitId: unit.unitId, attempt: unit.attempt })
      const executionToken = randomBytes(24).toString('hex')
      const attempt = unit.attempt + 1
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        units: current.units.map((item) => item.unitId === unit.unitId
          ? {
              ...item,
              state: 'claimed' as const,
              attempt,
              claimedRevision: outline.outlineRevision,
              claimedRequirementSequence: watermark,
              hostTurn: input.hostTurn ?? null,
              executionTokenHash: sha256hex(executionToken),
            }
          : item),
        run: { ...current.run, currentUnitId: unit.unitId },
      }
      await this.publish(dir, current.revision, next, `claim-unit:${unit.unitId}:${attempt}`)
      return { unitId: unit.unitId, executionToken, attempt }
    })
  }

  /**
   * Releases a claimed unit back to prepared (§6.2): revokes the claim's
   * execution token, increments the attempt and records the reason as the
   * unit's lastError; the next claim mints a fresh token on the same unit id
   * (0005 §6.2: retries reuse the unit id through a new execution token).
   * Author-side counterpart of the §13 stop disposition for one unit — the
   * recovery path when a claim's token was lost before the commit (a
   * stale-token rejection leaves the unit latched in flight with no tool able
   * to finish or retire it).
   */
  async releaseClaim(novelId: string, input: { unitId: string; reason: string }): Promise<{ unitId: string; attempt: number }> {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new NovelConfigError({ message: 'reason must be a non-empty string' })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const unit = current.units.find((item) => item.unitId === input.unitId)
      if (unit === undefined) throw new NovelPreconditionError({ rule: 'unit-not-found', violations: [input.unitId] })
      if (unit.state !== 'claimed') throw new NovelPreconditionError({ rule: 'unit-not-claimed', violations: [input.unitId] })
      const attempt = unit.attempt + 1
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        units: current.units.map((item) => item.unitId === unit.unitId
          ? {
              ...item,
              state: 'prepared' as const,
              attempt,
              claimedRevision: null,
              claimedRequirementSequence: null,
              hostTurn: null,
              executionTokenHash: null,
              lastError: input.reason,
            }
          : item),
        run: current.run.currentUnitId === unit.unitId ? { ...current.run, currentUnitId: null } : current.run,
      }
      await this.publish(dir, current.revision, next, `release-claim:${unit.unitId}:${attempt}`)
      return { unitId: unit.unitId, attempt }
    })
  }

  /**
   * Explicit body commit (§10.3/§10.4). Order of checks: duplicate receipt
   * first, then execution token, then hard length limit (before any file is
   * written), then the immutable body object and snapshot publish.
   */
  async commitBody(
    novelId: string,
    input: { unitId: string; executionToken: string; paragraphs: readonly string[]; sceneCompletion: SceneCompletion; canonChanges: readonly CanonChange[] },
  ): Promise<CommitReceipt> {
    if (!Array.isArray(input.paragraphs)) throw new NovelConfigError({ message: 'paragraphs must be an array of strings' })
    for (const paragraph of input.paragraphs) {
      if (typeof paragraph !== 'string') throw new NovelConfigError({ message: 'paragraphs must be strings' })
      if (paragraph.includes(PARAGRAPH_SEPARATOR)) {
        throw new NovelConfigError({ message: `paragraph must not contain the fixed separator '${JSON.stringify(PARAGRAPH_SEPARATOR)}' (§10.4 fixed serialization)` })
      }
    }
    const completion = input.sceneCompletion
    if (typeof completion !== 'object' || completion === null || typeof completion.completed !== 'boolean'
      || typeof completion.basis !== 'string' || completion.basis.trim() === ''
      || !Array.isArray(completion.outstandingGoals) || completion.outstandingGoals.some((goal) => typeof goal !== 'string')
      || !(completion.nextAnchor === null || typeof completion.nextAnchor === 'string')) {
      throw new NovelConfigError({ message: 'invalid sceneCompletion' })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const unit = current.units.find((item) => item.unitId === input.unitId)
      if (unit === undefined) throw new NovelPreconditionError({ rule: 'unit-not-found', violations: [input.unitId] })

      // 1. Duplicate receipt check precedes token validation (§10.3).
      const businessHash = sha256hex(stableStringify({
        paragraphs: input.paragraphs,
        sceneCompletion: completion,
        canonChanges: input.canonChanges,
      }))
      const existing = current.commits.find((commit) => commit.unitId === unit.unitId)
      if (existing !== undefined) {
        if (existing.bodyHash !== businessHash) throw new NovelDuplicateCommitError({ unitId: unit.unitId, existingCommitId: existing.commitId })
        return {
          commitId: existing.commitId,
          unitId: unit.unitId,
          bodyHash: existing.bodyHash,
          effectiveCharacters: existing.effectiveCharacters,
          deltaCharacters: existing.effectiveCharacters,
          totalCharacters: effectiveNovelCharacters(current),
          revision: current.revision,
          duplicate: true,
        }
      }

      // 2. Execution token check.
      if (unit.state !== 'claimed') throw new NovelStaleUnitError({ unitId: unit.unitId, attempt: unit.attempt })
      if (unit.executionTokenHash !== sha256hex(input.executionToken)) throw new NovelStaleUnitError({ unitId: unit.unitId, attempt: unit.attempt })

      // 3. Body sanity.
      if (input.paragraphs.length === 0 || input.paragraphs.every((paragraph) => paragraph.trim() === '')) {
        throw new NovelPreconditionError({ rule: 'empty-body' })
      }

      // 4. Hard maximum is checked before anything is written (§7.2).
      const budget = current.config.lengthBudget
      const delta = input.paragraphs.reduce((sum, paragraph) => sum + countEffectiveCharacters(paragraph), 0)
      const totalBefore = effectiveNovelCharacters(current)
      const totalAfter = totalBefore + delta
      if (budget.kind === 'target' && budget.hardMaximumCharacters !== null && totalAfter > budget.hardMaximumCharacters) {
        throw new NovelLengthLimitError({ current: totalAfter, target: budget.targetCharacters, hardMaximum: budget.hardMaximumCharacters })
      }

      // 5. Canon change sources must fall into this or earlier committed bodies (§8.2).
      const upcomingCommitId = `commit-${current.commits.length + 1}`
      validateCanonChanges(input.canonChanges, current.commits, upcomingCommitId, input.paragraphs.length)

      // 6. Immutable body object (fsync), then the snapshot publish.
      await writeImmutableBytes(path.join(dir, 'bodies', `${businessHash}.txt`), textBytes(input.paragraphs.join(PARAGRAPH_SEPARATOR)))
      const commit: BodyCommit = {
        commitId: upcomingCommitId,
        unitId: unit.unitId,
        chapterId: unit.chapterId,
        attempt: unit.attempt,
        bodyHash: businessHash,
        paragraphCount: input.paragraphs.length,
        effectiveCharacters: delta,
        sceneCompleted: completion.completed,
        completionBasis: completion.basis,
        outstandingGoals: [...completion.outstandingGoals],
        canonChanges: structuredClone(input.canonChanges),
        outlineRevision: unit.claimedRevision ?? current.outline?.outlineRevision ?? '',
        requirementSequence: unit.claimedRequirementSequence ?? requirementWatermark(current.requirements),
        committedAt: new Date().toISOString(),
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: commit.committedAt,
        units: current.units.map((item) => item.unitId === unit.unitId
          ? { ...item, state: 'committed' as const, executionTokenHash: null }
          : item),
        commits: [...current.commits, commit],
        run: { ...current.run, currentUnitId: null, stalledTurns: 0, phase: 'writing' },
      }
      next.contentRevision = contentRevisionOf(next)
      const revision = await this.publish(dir, current.revision, next, `commit-body:${commit.commitId}`)
      return {
        commitId: commit.commitId,
        unitId: unit.unitId,
        bodyHash: commit.bodyHash,
        effectiveCharacters: delta,
        deltaCharacters: delta,
        totalCharacters: totalAfter,
        revision,
        duplicate: false,
      }
    })
  }

  /* ------------------------- chapter / finish (§7) ------------------------- */

  async completeChapter(
    novelId: string,
    input: { chapterId: string; expectedContentRevision: string; basis: string; openItems: readonly string[] },
  ): Promise<{ revision: string }> {
    if (typeof input.basis !== 'string' || input.basis.trim() === '') throw new NovelConfigError({ message: 'basis must be a non-empty string' })
    if (!Array.isArray(input.openItems) || input.openItems.some((item) => typeof item !== 'string')) {
      throw new NovelConfigError({ message: 'openItems must be an array of strings' })
    }
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.contentRevision !== input.expectedContentRevision) {
        throw new NovelRevisionConflictError({ expected: input.expectedContentRevision, actual: current.contentRevision, detail: 'contentRevision' })
      }
      const outline = current.outline ?? (() => { throw new NovelPreconditionError({ rule: 'outline-missing' }) })()
      const chapter = outline.chapters.find((item) => item.chapterId === input.chapterId)
      if (chapter === undefined) throw new NovelPreconditionError({ rule: 'chapter-not-found', violations: [input.chapterId] })
      if (current.completedChapters.some((entry) => entry.chapterId === input.chapterId)) {
        throw new NovelPreconditionError({ rule: 'chapter-completed', violations: [input.chapterId] })
      }
      if (!current.commits.some((commit) => commit.chapterId === input.chapterId)) {
        throw new NovelPreconditionError({ rule: 'chapter-empty', violations: [input.chapterId] })
      }
      const completion: ChapterCompletion = {
        chapterId: input.chapterId,
        basis: input.basis,
        openItems: [...input.openItems],
        completedAt: new Date().toISOString(),
      }
      const completedChapters = [...current.completedChapters, completion]
      const next: NovelSnapshot = {
        ...current,
        updatedAt: completion.completedAt,
        completedChapters,
        run: { ...current.run, phase: completedChapters.length >= outline.chapters.length ? 'finishing' : current.run.phase },
      }
      next.contentRevision = contentRevisionOf(next)
      const revision = await this.publish(dir, current.revision, next, `chapter-complete:${input.chapterId}`)
      return { revision }
    })
  }

  /** Finish guards are program-verifiable only (§7.3); violations list why not. */
  async finishNovel(novelId: string, input: { expectedRevision: string; basis: string }): Promise<{ revision: string; totalCharacters: number }> {
    if (typeof input.basis !== 'string' || input.basis.trim() === '') throw new NovelConfigError({ message: 'basis must be a non-empty string' })
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') throw new NovelCapabilityError({ reason: 'novel completed' })
      this.assertRevision(current, input.expectedRevision)
      const violations = finishGuardViolations(current)
      if (violations.length > 0) throw new NovelPreconditionError({ rule: 'finish-guards', violations })
      const now = new Date().toISOString()
      const next: NovelSnapshot = {
        ...current,
        updatedAt: now,
        run: {
          ...current.run,
          status: 'completed',
          phase: 'finishing',
          pauseReason: null,
          pauseDetail: null,
          resumeHint: null,
          currentUnitId: null,
          inFlightIntent: null,
          completedAt: now,
        },
      }
      const revision = await this.publish(dir, current.revision, next, 'finish-novel')
      return { revision, totalCharacters: effectiveNovelCharacters(next) }
    })
  }

  /* ------------------------------- run (§12) ------------------------------- */

  /** At most one in-flight intent per novel; repeated calls are idempotent (§12.1). */
  async recordWorkIntent(
    novelId: string,
    input: { kind: WorkIntentKind; unitId?: string | null; expectedOutlineRevision?: string | null; expectedRequirementSequence?: number | null; hostTurn?: number | null },
  ): Promise<{ intentId: string; revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') throw new NovelCapabilityError({ reason: 'novel completed' })
      const inFlight = current.run.inFlightIntent
      if (inFlight !== null) return { intentId: inFlight.intentId, revision: current.revision }
      const record: WorkIntentRecord = {
        intentId: `wi-${randomBytes(6).toString('hex')}`,
        kind: input.kind,
        unitId: input.unitId ?? null,
        expectedOutlineRevision: input.expectedOutlineRevision ?? null,
        expectedRequirementSequence: input.expectedRequirementSequence ?? null,
        hostTurn: input.hostTurn ?? null,
        createdAt: new Date().toISOString(),
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: record.createdAt,
        run: { ...current.run, inFlightIntent: record },
      }
      const revision = await this.publish(dir, current.revision, next, `work-intent:${record.kind}`)
      return { intentId: record.intentId, revision }
    })
  }

  async resolveWorkIntent(novelId: string, input: { intentId: string; outcome: 'delivered' | 'failed' | 'cancelled'; error?: string }): Promise<void> {
    if (!['delivered', 'failed', 'cancelled'].includes(input.outcome)) throw new NovelConfigError({ message: "outcome must be 'delivered' | 'failed' | 'cancelled'" })
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      const inFlight = current.run.inFlightIntent
      // Resolving an unknown or already-resolved intent is an idempotent no-op.
      if (inFlight === null || inFlight.intentId !== input.intentId) return
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        run: {
          ...current.run,
          inFlightIntent: null,
          ...(input.outcome === 'failed' ? { lastError: input.error ?? `work intent ${inFlight.intentId} failed` } : {}),
        },
      }
      await this.publish(dir, current.revision, next, `work-intent-resolve:${input.intentId}:${input.outcome}`)
    })
  }

  async pause(novelId: string, input: { reason: NovelPauseReason; detail?: string; resumeHint?: string }): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') throw new NovelCapabilityError({ reason: 'novel completed' })
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        run: {
          ...current.run,
          ...foldActiveDuration(current.run, Date.now()),
          // §13: pausing revokes unclaimed intents; claimed units may still finish.
          status: 'paused',
          pauseReason: input.reason,
          pauseDetail: input.detail ?? null,
          resumeHint: input.resumeHint ?? null,
          inFlightIntent: null,
        },
      }
      const revision = await this.publish(dir, current.revision, next, `pause:${input.reason}`)
      return { revision }
    })
  }

  /**
   * Resume authorizes work again. With blocked requirements present the novel
   * resumes into active/revising for planning, while body claims stay blocked
   * by the claim guard until conflicts are resolved (§9.4).
   */
  async resume(novelId: string): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') throw new NovelCapabilityError({ reason: 'novel completed' })
      if (current.run.status !== 'paused') throw new NovelPreconditionError({ rule: 'not-paused' })
      if (current.run.pauseReason === 'awaiting-approval') {
        throw new NovelPreconditionError({ rule: 'awaiting-approval', violations: ['use approveOutline or requestRevision (§9.2)'] })
      }
      const blocked = current.requirements.filter((record) => record.status === 'blocked')
      const pending = current.requirements.filter((record) => record.status === 'pending')
      const importing = current.import !== null && current.import !== undefined && current.import.bibleHash === null
      const phase = importing
        ? 'importing'
        : current.outline === null ? 'outlining' : blocked.length > 0 || pending.length > 0 ? 'revising' : 'writing'
      // An explicit resume also authorizes a fresh retry budget for unfinished
      // extraction parts (the failure path pauses after attempts run out).
      // Extracted parts and their results are never touched.
      const imported = importing
        ? {
            ...current.import!,
            parts: current.import!.parts.map((part) => part.status === 'extracted'
              ? part
              : { ...part, attempts: 0, status: 'pending' as const, error: null }),
          }
        : current.import
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        ...(importing ? { import: imported } : {}),
        run: {
          ...current.run,
          status: 'active',
          phase,
          pauseReason: null,
          pauseDetail: null,
          // An explicit resume is a user override of the pause: the stall
          // counter resets and the duration budget gets a fresh full
          // allowance. The turn count stays cumulative (§13) — a hard cap
          // is raised through config, not through resume clicks. Restart
          // recovery never calls this, so a crash loop cannot farm budget.
          stalledTurns: 0,
          activeDurationMs: 0,
          activeWindowStart: new Date().toISOString(),
          resumeHint: blocked.length > 0 ? 'planning authorized; body claims stay blocked until conflicts are resolved (§9.4)' : null,
        },
      }
      const revision = await this.publish(dir, current.revision, next, 'resume')
      return { revision }
    })
  }

  /**
   * Immediate stop (§9.4/§13): revokes in-flight execution tokens by returning
   * claimed, uncommitted units to prepared with attempt+1 and records the stop
   * as their lastError; the novel stays paused even if new directives arrive.
   */
  async stop(novelId: string): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') throw new NovelCapabilityError({ reason: 'novel completed' })
      const now = new Date().toISOString()
      const next: NovelSnapshot = {
        ...current,
        updatedAt: now,
        units: current.units.map((unit) => unit.state === 'claimed'
          ? {
              ...unit,
              state: 'prepared' as const,
              attempt: unit.attempt + 1,
              claimedRevision: null,
              claimedRequirementSequence: null,
              hostTurn: null,
              executionTokenHash: null,
              lastError: 'stopped: execution token revoked by immediate stop (§13)',
            }
          : unit),
        run: {
          ...current.run,
          ...foldActiveDuration(current.run, Date.now()),
          status: 'paused',
          pauseReason: 'stopped',
          pauseDetail: 'immediate stop: execution tokens revoked',
          resumeHint: 'resume explicitly after reviewing pending directives (§9.4)',
          currentUnitId: null,
          inFlightIntent: null,
        },
      }
      const revision = await this.publish(dir, current.revision, next, 'stop')
      return { revision }
    })
  }

  /** Manual outline approval binds a concrete outline revision (§4.3). */
  async approveOutline(novelId: string, input: { expectedOutlineRevision: string }): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status !== 'paused' || current.run.pauseReason !== 'awaiting-approval') {
        throw new NovelPreconditionError({ rule: 'not-awaiting-approval' })
      }
      const unprocessed = current.requirements
        .filter((record) => record.status === 'pending' || record.status === 'blocked')
        .map((record) => `${record.requirementId}:${record.status}`)
      if (unprocessed.length > 0) throw new NovelPreconditionError({ rule: 'requirements-unprocessed', violations: unprocessed })
      const outline = current.outline ?? (() => { throw new NovelPreconditionError({ rule: 'outline-missing' }) })()
      if (outline.outlineRevision !== input.expectedOutlineRevision) {
        throw new NovelRevisionConflictError({ expected: input.expectedOutlineRevision, actual: outline.outlineRevision, detail: 'outline approval' })
      }
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        run: {
          ...current.run,
          status: 'active',
          phase: 'writing',
          pauseReason: null,
          pauseDetail: null,
          resumeHint: null,
          awaitingApprovalRevision: null,
          // Approval re-enters active: open a fresh duration window (§13).
          activeWindowStart: new Date().toISOString(),
        },
      }
      const revision = await this.publish(dir, current.revision, next, `approve-outline:${outline.outlineRevision}`)
      return { revision }
    })
  }

  /** "Update outline" authorizes exactly one planning pass (§4.3). */
  async requestRevision(novelId: string): Promise<{ revision: string }> {
    return this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.pauseReason !== 'awaiting-approval') throw new NovelPreconditionError({ rule: 'not-awaiting-approval' })
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        run: {
          ...current.run,
          status: 'active',
          phase: 'revising',
          pauseReason: null,
          pauseDetail: null,
          resumeHint: null,
          // The authorized planning pass re-enters active: fresh window (§13).
          activeWindowStart: new Date().toISOString(),
        },
      }
      const revision = await this.publish(dir, current.revision, next, 'request-revision')
      return { revision }
    })
  }

  /** Merges the progress signature inside the lock (§10.3); resets stall count. */
  async noteProgress(novelId: string, input: { signature: string }): Promise<void> {
    if (typeof input.signature !== 'string' || input.signature.trim() === '') throw new NovelConfigError({ message: 'signature must be a non-empty string' })
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') return
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
        run: { ...current.run, lastProgressSignature: input.signature, stalledTurns: 0 },
      }
      await this.publish(dir, current.revision, next, 'note-progress')
    })
  }

  /** Turn accounting; crossing a budget/stall threshold auto-pauses (§13). */
  async noteTurn(novelId: string, input: { failed: boolean; error?: string }): Promise<void> {
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') return
      const budgets = current.config.budgets
      let run: NovelRunState = {
        ...current.run,
        turnsRun: current.run.turnsRun + 1,
        stalledTurns: current.run.stalledTurns + 1,
        consecutiveFailures: input.failed ? current.run.consecutiveFailures + 1 : 0,
        // §13 run error trail: a failed turn records it and the next
        // successful turn clears it, so the surfaced "recent error" always
        // reflects failures not yet followed by success — never a zombie
        // from a turn that has long since recovered.
        lastError: input.failed ? input.error ?? current.run.lastError : null,
      }
      if (run.status === 'active') {
        if (run.consecutiveFailures >= budgets.consecutiveFailureLimit) {
          run = { ...run, status: 'paused', pauseReason: 'budget', pauseDetail: `consecutive failure limit ${budgets.consecutiveFailureLimit} reached` }
        } else if (run.stalledTurns >= budgets.stallThresholdTurns) {
          run = { ...run, status: 'paused', pauseReason: 'stalled', pauseDetail: `no progress for ${run.stalledTurns} turns` }
        } else if (run.turnsRun >= budgets.maxTurns) {
          run = { ...run, status: 'paused', pauseReason: 'budget', pauseDetail: `max turns ${budgets.maxTurns} reached` }
        } else if (run.startedAt !== null && elapsedActiveDuration(run, Date.now()) >= budgets.maxDurationMs) {
          run = { ...run, ...foldActiveDuration(run, Date.now()), status: 'paused', pauseReason: 'budget', pauseDetail: 'max duration reached' }
        }
      }
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), run }
      await this.publish(dir, current.revision, next, `note-turn:${input.failed ? 'failed' : 'ok'}`)
    })
  }

  /** Deduction run accounting (§8.1/§13): merges deduceRuns++ inside the lock;
   *  crossing maxDeduceRuns auto-pauses with a budget reason. */
  async noteDeduceRun(novelId: string): Promise<void> {
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') return
      const budgets = current.config.budgets
      let run: NovelRunState = { ...current.run, deduceRuns: current.run.deduceRuns + 1 }
      if (run.status === 'active' && run.deduceRuns >= budgets.maxDeduceRuns) {
        run = { ...run, status: 'paused', pauseReason: 'budget', pauseDetail: `max deduction runs ${budgets.maxDeduceRuns} reached` }
      }
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), run }
      await this.publish(dir, current.revision, next, 'note-deduce-run')
    })
  }

  /**
   * Writer-subagent run accounting (0007 §7): merges writerRuns++ inside the
   * lock. Deliberately no hard cap and no auto-pause — NovelRunBudgets gains
   * no new limit; the hard budget edges stay with maxTurns/maxDurationMs.
   * The `?? 0` amnesties legacy snapshots created before the field existed.
   */
  async noteWriterRun(novelId: string): Promise<void> {
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') return
      const run: NovelRunState = { ...current.run, writerRuns: (current.run.writerRuns ?? 0) + 1 }
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), run }
      await this.publish(dir, current.revision, next, 'note-writer-run')
    })
  }

  /**
   * Appends one W0 usage sample (0007 §7, audit-grade — never authoritative
   * billing): mutate + publish without CAS, same as noteTurn; completed runs
   * short-circuit. Bounded ring: only the most recent 50 samples are kept,
   * older ones dropped. The `?? []` amnesties legacy snapshots.
   */
  async noteUsageSample(novelId: string, sample: NovelUsageSample): Promise<void> {
    const errors = validateUsageSample(sample)
    if (errors.length > 0) throw new NovelConfigError({ message: 'invalid usage sample', errors })
    await this.mutate(novelId, async () => {
      const { dir, current } = await this.beginMutation(novelId)
      if (current.run.status === 'completed') return
      const stored: NovelUsageSample = {
        recordedAt: sample.recordedAt,
        turn: sample.turn,
        toolBytes: { ...sample.toolBytes },
        ...(sample.writerOutputChars !== undefined ? { writerOutputChars: sample.writerOutputChars } : {}),
        ...(sample.usage !== undefined ? { usage: { ...sample.usage } } : {}),
      }
      const run: NovelRunState = {
        ...current.run,
        usageSamples: [...(current.run.usageSamples ?? []), stored].slice(-USAGE_SAMPLE_LIMIT),
      }
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), run }
      await this.publish(dir, current.revision, next, 'note-usage-sample')
    })
  }

  /* -------------------------------- reads -------------------------------- */

  /**
   * Reads effective body paragraphs in story order. An applied body revision
   * replaces the commits it covered (proposal 0020 §5); commits committed after
   * the revision append after it. A unitId filter keeps the raw commit view
   * because revisions are chapter-scoped.
   */
  async readBody(
    novelId: string,
    query: { chapterId?: string; unitId?: string; cursor?: string; limit?: number },
  ): Promise<{ paragraphs: readonly { commitId: string; paragraphIndex: number; chapterId: string; text: string }[]; nextCursor: string | null }> {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new NovelConfigError({ message: 'limit must be a positive integer' })
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor)
    if (!Number.isInteger(cursor) || cursor < 0) throw new NovelConfigError({ message: 'cursor must be a non-negative integer string' })
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    const dir = this.novelDir(novelId)
    const flattened: Array<{ commitId: string; paragraphIndex: number; chapterId: string; text: string }> = []
    if (query.unitId !== undefined) {
      const selected = current.commits.filter((commit) =>
        (query.chapterId === undefined || commit.chapterId === query.chapterId) && commit.unitId === query.unitId)
      for (const commit of selected) {
        const paragraphs = await this.readBodyParagraphs(novelId, dir, commit.bodyHash, commit.paragraphCount)
        paragraphs.forEach((text, index) => flattened.push({ commitId: commit.commitId, paragraphIndex: index, chapterId: commit.chapterId, text }))
      }
    } else {
      const chapterIds = query.chapterId !== undefined
        ? [query.chapterId]
        : [...new Set(current.commits.map((commit) => commit.chapterId))]
      for (const chapterId of chapterIds) {
        const revision = appliedBodyRevision(current, chapterId)
        if (revision !== null) {
          const paragraphs = await this.readBodyParagraphs(novelId, dir, revision.bodyHash, revision.paragraphCount)
          paragraphs.forEach((text, index) => flattened.push({ commitId: revision.revisionId, paragraphIndex: index, chapterId, text }))
        }
        for (const commit of current.commits) {
          if (commit.chapterId !== chapterId) continue
          if (revision !== null && bodyRevisionCovers(revision, commit.commitId)) continue
          const paragraphs = await this.readBodyParagraphs(novelId, dir, commit.bodyHash, commit.paragraphCount)
          paragraphs.forEach((text, index) => flattened.push({ commitId: commit.commitId, paragraphIndex: index, chapterId, text }))
        }
      }
    }
    const limit = query.limit ?? Number.MAX_SAFE_INTEGER
    const page = flattened.slice(cursor, cursor + limit)
    const nextCursor = cursor + page.length < flattened.length ? String(cursor + page.length) : null
    return { paragraphs: page, nextCursor }
  }

  async bodyHashOf(novelId: string, commitId: string): Promise<string | null> {
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    return current.commits.find((commit) => commit.commitId === commitId)?.bodyHash ?? null
  }

  /**
   * Reads one fixed asset snapshot by content hash (§5: project snapshots
   * stay readable after the source tavern asset is edited or deleted). Pure
   * read with fail-closed resolution: only hashes referenced by the current
   * snapshot resolve, so arbitrary file reads are impossible (§15).
   */
  async readAsset(novelId: string, contentHash: string): Promise<unknown> {
    if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new NovelConfigError({ message: 'contentHash must be a full sha256 hex string' })
    }
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    if (!current.assets.some((asset) => asset.contentHash === contentHash)) {
      throw new NovelPreconditionError({ rule: 'asset-not-referenced', violations: [contentHash] })
    }
    const assetPath = path.join(this.novelDir(novelId), 'assets', `${contentHash}.json`)
    const raw = await tryReadText(assetPath)
    if (raw === undefined) {
      throw new NovelStorageCorruptionError({ novelId, path: assetPath, detail: 'referenced asset object is missing' })
    }
    try {
      return JSON.parse(raw)
    } catch (cause) {
      throw new NovelStorageCorruptionError({ novelId, path: assetPath, detail: `asset object is not valid JSON: ${(cause as Error).message}` })
    }
  }

  private async readImmutableJson<T>(novelId: string, relativePath: string, label: string): Promise<T> {
    const filePath = path.join(this.novelDir(novelId), relativePath)
    const raw = await tryReadText(filePath)
    if (raw === undefined) {
      throw new NovelStorageCorruptionError({ novelId, path: filePath, detail: `${label} is missing` })
    }
    try {
      return JSON.parse(raw) as T
    } catch (cause) {
      throw new NovelStorageCorruptionError({ novelId, path: filePath, detail: `${label} is not valid JSON: ${(cause as Error).message}` })
    }
  }

  /* ------------------------------- internal ------------------------------- */

  private novelDir(novelId: string): string {
    if (!isValidNovelId(novelId)) throw new Error(`invalid novel id '${novelId}'`)
    return path.join(this.novelsRoot, novelId)
  }

  private mutate<T>(novelId: string, operation: () => Promise<T>): Promise<T> {
    // In-process serialization per novel, mirroring store.ts stateMutationTail.
    return this.mutationTails.enqueue(novelId, operation)
  }

  /** Re-reads HEAD inside the mutation entry and verifies write ownership. */
  private async beginMutation(novelId: string): Promise<{ dir: string; current: NovelSnapshot }> {
    const dir = this.novelDir(novelId)
    const current = await this.readSnapshot(novelId)
    if (current === undefined) throw new NovelNotFoundError({ novelId })
    await this.ensureOwnership(novelId, dir)
    return { dir, current }
  }

  private assertRevision(current: NovelSnapshot, expected: string): void {
    if (current.revision !== expected) {
      throw new NovelRevisionConflictError({ expected, actual: current.revision, detail: 'snapshot revision' })
    }
  }

  /**
   * Single-writer ownership (§10.2 end): `.owner.json` must belong to this
   * process (pid + process-shared bootId, so multiple instances — and the
   * several bundled copies of this module — in one process re-enter). A
   * recorded writer that provably cannot write again (dead pid, pid recycled
   * to a non-dsh process, foreign boot id under this pid) is taken over
   * automatically; only a live dsh-shaped pid — or an undecidable probe —
   * is refused as a concurrent writer.
   */
  private async ensureOwnership(novelId: string, dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    const ownerPath = path.join(dir, '.owner.json')
    // Two recoverers with the same evidence can race the wx acquire; bounded
    // retries re-read the winner's token instead of failing.
    for (let attempt = 0; ; attempt++) {
      const raw = await tryReadText(ownerPath)
      if (raw !== undefined) {
        const owner = parseOwnerFile(novelId, ownerPath, raw)
        if (owner.pid === process.pid && owner.bootId === BOOT_ID) return
        if (await isLiveDshWriter(owner.pid)) {
          throw new NovelOwnershipError({
            novelId,
            pid: owner.pid,
            alive: true,
            detail: 'another writer holds the novel; single-writer ownership refuses concurrent writers (§10.2)',
          })
        }
        await fs.rm(ownerPath, { force: true })
      }
      const token: OwnerFile = { pid: process.pid, bootId: BOOT_ID, acquiredAt: new Date().toISOString() }
      try {
        const fh = await fs.open(ownerPath, 'wx')
        try {
          await fh.writeFile(jsonBytes(token))
          await fh.sync()
        } finally {
          await fh.close()
        }
        return
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 3) continue
        throw cause
      }
    }
  }

  /**
   * HEAD is the only authority (§10.1). Returns undefined when no HEAD exists
   * (never-committed project); corruption of HEAD or its referenced revision
   * throws NovelStorageCorruptionError without silent fallback (§10.3).
   */
  private async readSnapshot(novelId: string): Promise<NovelSnapshot | undefined> {
    const dir = this.novelDir(novelId)
    const headPath = path.join(dir, 'HEAD.json')
    const headRaw = await tryReadText(headPath)
    if (headRaw === undefined) return undefined
    let head: HeadFile
    try {
      head = JSON.parse(headRaw) as HeadFile
    } catch (cause) {
      throw new NovelStorageCorruptionError({ novelId, path: headPath, detail: `HEAD.json is not valid JSON: ${(cause as Error).message}` })
    }
    if (typeof head !== 'object' || head === null || head.novelId !== novelId
      || typeof head.revision !== 'string' || !/^[0-9a-f]{16}$/.test(head.revision)
      || head.schemaVersion !== SCHEMA_VERSION) {
      throw new NovelStorageCorruptionError({ novelId, path: headPath, detail: 'HEAD.json has an invalid shape' })
    }
    const revisionPath = path.join(dir, 'revisions', `${head.revision}.json`)
    const revisionRaw = await tryReadText(revisionPath)
    if (revisionRaw === undefined) {
      throw new NovelStorageCorruptionError({ novelId, path: revisionPath, detail: 'HEAD references a missing revision file' })
    }
    let file: RevisionFile
    try {
      file = JSON.parse(revisionRaw) as RevisionFile
    } catch (cause) {
      throw new NovelStorageCorruptionError({ novelId, path: revisionPath, detail: `revision file is not valid JSON: ${(cause as Error).message}` })
    }
    const snapshot = file.snapshot
    if (typeof file !== 'object' || file === null || file.schemaVersion !== SCHEMA_VERSION
      || file.revision !== head.revision || typeof snapshot !== 'object' || snapshot === null
      || snapshot.novelId !== novelId || snapshot.revision !== head.revision
      || typeof snapshot.updatedAt !== 'string' || typeof snapshot.config !== 'object'
      || typeof snapshot.run !== 'object' || !Array.isArray(snapshot.requirements)
      || !Array.isArray(snapshot.units) || !Array.isArray(snapshot.commits)
      || (snapshot.import !== undefined && snapshot.import !== null
        && (typeof snapshot.import !== 'object' || !Array.isArray(snapshot.import.parts) || !Array.isArray(snapshot.import.chapters)))
      || (snapshot.bodyRevisions !== undefined && !Array.isArray(snapshot.bodyRevisions))) {
      throw new NovelStorageCorruptionError({ novelId, path: revisionPath, detail: 'revision file has an invalid shape' })
    }
    return snapshot
  }

  private async readBodyParagraphs(novelId: string, dir: string, bodyHash: string, paragraphCount: number): Promise<string[]> {
    const bodyPath = path.join(dir, 'bodies', `${bodyHash}.txt`)
    const raw = await tryReadText(bodyPath)
    if (raw === undefined) {
      throw new NovelStorageCorruptionError({ novelId, path: bodyPath, detail: 'committed body object is missing' })
    }
    const paragraphs = raw.split(PARAGRAPH_SEPARATOR)
    if (paragraphs.length !== paragraphCount) {
      throw new NovelStorageCorruptionError({ novelId, path: bodyPath, detail: `body object paragraph count ${paragraphs.length} does not match commit record ${paragraphCount}` })
    }
    return paragraphs
  }

  /**
   * §10.2 commit protocol: immutable objects are written by the callers; here
   * we write the revision file (tmp + fsync + rename), then atomically replace
   * HEAD (the logical commit point), then update projections asynchronously.
   */
  private async publish(dir: string, parentRevision: string | null, snapshot: NovelSnapshot, cause: string): Promise<string> {
    const revision = hash16({ ...snapshot, revision: undefined })
    const withRevision: NovelSnapshot = { ...snapshot, revision }
    const file: RevisionFile = {
      schemaVersion: SCHEMA_VERSION,
      revision,
      parentRevision,
      cause,
      committedAt: new Date().toISOString(),
      snapshot: withRevision,
    }
    await writeImmutableBytes(path.join(dir, 'revisions', `${revision}.json`), jsonBytes(file))
    const head: HeadFile = { novelId: snapshot.novelId, revision, schemaVersion: SCHEMA_VERSION, updatedAt: snapshot.updatedAt }
    await replaceHead(path.join(dir, 'HEAD.json'), jsonBytes(head))
    // §10.2 step 5: projections are asynchronous; failure marks
    // projection-pending without rolling back committed state. Updates are
    // serialized per novel and drained by deleteNovel.
    void this.projectionTails.enqueue(snapshot.novelId, () => this.updateProjections(dir, withRevision)).catch(() => {})
    return revision
  }

  private async updateProjections(dir: string, snapshot: NovelSnapshot): Promise<void> {
    const projectionsDir = path.join(dir, 'projections')
    try {
      await fs.mkdir(path.join(projectionsDir, 'chapters'), { recursive: true })
      const summary = summarizeNovel(snapshot)
      await writeAtomicText(path.join(projectionsDir, 'status.json'), JSON.stringify({
        novelId: snapshot.novelId,
        revision: snapshot.revision,
        contentRevision: snapshot.contentRevision,
        status: summary.status,
        phase: summary.phase,
        pauseReason: summary.pauseReason,
        chaptersCompleted: summary.chaptersCompleted,
        chaptersTotal: summary.chaptersTotal,
        effectiveCharacters: summary.effectiveCharacters,
        updatedAt: snapshot.updatedAt,
      }, null, 2))
      const titleByChapter = new Map<string, string>((snapshot.outline?.chapters ?? []).map((chapter) => [chapter.chapterId, chapter.title]))
      for (const chapterId of new Set(snapshot.commits.map((commit) => commit.chapterId))) {
        const parts: string[] = [`# ${titleByChapter.get(chapterId) ?? chapterId}`, '']
        const revision = appliedBodyRevision(snapshot, chapterId)
        if (revision !== null) {
          const paragraphs = await this.readBodyParagraphs(snapshot.novelId, dir, revision.bodyHash, revision.paragraphCount)
          parts.push(paragraphs.join(PARAGRAPH_SEPARATOR), '')
        }
        for (const commit of snapshot.commits) {
          if (commit.chapterId !== chapterId) continue
          if (revision !== null && bodyRevisionCovers(revision, commit.commitId)) continue
          const paragraphs = await this.readBodyParagraphs(snapshot.novelId, dir, commit.bodyHash, commit.paragraphCount)
          parts.push(paragraphs.join(PARAGRAPH_SEPARATOR), '')
        }
        await writeAtomicText(path.join(projectionsDir, 'chapters', `${chapterId}.md`), `${parts.join(PARAGRAPH_SEPARATOR).trimEnd()}\n`)
      }
    } catch (cause) {
      // §13: mark projection-pending; authoritative bodies are untouched.
      try {
        await writeAtomicText(path.join(projectionsDir, 'status.json'), JSON.stringify({
          state: 'projection-pending',
          novelId: snapshot.novelId,
          revision: snapshot.revision,
          error: String(cause),
        }, null, 2))
      } catch {
        // Best effort marker only.
      }
    }
  }

  private validateHandledRequirements(current: NovelSnapshot, handled: readonly HandledRequirement[]): HandledRequirement[] {
    if (!Array.isArray(handled)) throw new NovelConfigError({ message: 'handledRequirements must be an array' })
    const seen = new Set<string>()
    for (const item of handled) {
      if (typeof item !== 'object' || item === null || typeof item.requirementId !== 'string') {
        throw new NovelConfigError({ message: 'handledRequirements entries must carry a requirementId' })
      }
      if (item.result !== 'applied' && item.result !== 'superseded' && item.result !== 'blocked') {
        throw new NovelConfigError({ message: `invalid handled result for '${item.requirementId}'` })
      }
      if (seen.has(item.requirementId)) {
        throw new NovelPreconditionError({ rule: 'duplicate-requirement', violations: [item.requirementId] })
      }
      seen.add(item.requirementId)
      const record = current.requirements.find((candidate) => candidate.requirementId === item.requirementId)
      if (record === undefined) {
        throw new NovelPreconditionError({ rule: 'requirement-not-found', violations: [item.requirementId] })
      }
      // §9.1: pending requirements are processed by a revision; blocked ones
      // may only move to applied/superseded after user clarification.
      if (record.status !== 'pending' && record.status !== 'blocked') {
        throw new NovelPreconditionError({ rule: 'requirement-state', violations: [`${item.requirementId}:${record.status}`] })
      }
      if (item.result === 'blocked' && (item.blockedReason === undefined || item.blockedReason.trim() === '')) {
        throw new NovelPreconditionError({ rule: 'blocked-reason', violations: [item.requirementId] })
      }
      if (item.supersededBy !== undefined && typeof item.supersededBy !== 'string') {
        throw new NovelConfigError({ message: 'supersededBy must be a string' })
      }
      // §9.1 (line 215): a blocked requirement only becomes applied/superseded
      // after the user clarifies or explicitly withdraws — the entry MUST cite
      // that message. The citation must resolve to a received directive's
      // hostMessageId (the receive barrier registers every real user message
      // before any revision runs), mirroring canon sources which must resolve
      // to real commits; an unresolvable id is a fabricated citation.
      if (record.status === 'blocked' && (item.result === 'applied' || item.result === 'superseded')) {
        const ref = item.resolvedBy
        if (typeof ref !== 'object' || ref === null
          || (ref.kind !== 'clarification' && ref.kind !== 'withdrawal')
          || typeof ref.messageId !== 'string' || ref.messageId.trim() === '') {
          throw new NovelPreconditionError({ rule: 'blocked-resolution-citation', violations: [item.requirementId] })
        }
        if (!current.requirements.some((candidate) => candidate.hostMessageId === ref.messageId)) {
          throw new NovelPreconditionError({ rule: 'blocked-resolution-citation', violations: [`${item.requirementId}:unknown message '${ref.messageId}'`] })
        }
      } else if (item.resolvedBy !== undefined) {
        // The citation is load-bearing only for blocked resolutions; on any
        // other entry it is an unrelated field and must not enter the model (§11).
        throw new NovelConfigError({ message: `resolvedBy is only valid when resolving a blocked requirement to applied/superseded (§9.1): '${item.requirementId}'` })
      }
    }
    return handled.map((item) => ({ ...item }))
  }

  /**
   * Chapters containing committed bodies (or explicit completions) must be
   * kept, and no retained old chapter may cross over a protected chapter in
   * either direction (§6.1: committed chapters cannot be deleted or
   * reordered; newly added chapters are free to go anywhere).
   */
  private assertProtectedChapters(previous: NovelOutline, current: NovelSnapshot, nextChapters: readonly OutlineChapter[]): void {
    const oldOrder = [...previous.chapters].sort((left, right) => left.order - right.order).map((chapter) => chapter.chapterId)
    const oldIndexById = new Map(oldOrder.map((chapterId, index) => [chapterId, index]))
    const protectedIds = new Set(oldOrder.filter((chapterId) =>
      current.commits.some((commit) => commit.chapterId === chapterId)
      || current.completedChapters.some((entry) => entry.chapterId === chapterId)))
    const nextOrder = [...nextChapters].sort((left, right) => left.order - right.order).map((chapter) => chapter.chapterId)
    const nextIndexById = new Map(nextOrder.map((chapterId, index) => [chapterId, index]))
    const violations: string[] = []
    for (const protectedId of protectedIds) {
      const protectedIndex = nextIndexById.get(protectedId)
      const oldProtectedIndex = oldIndexById.get(protectedId) ?? 0
      if (protectedIndex === undefined) {
        violations.push(`chapter-missing:${protectedId}`)
        continue
      }
      for (const otherId of oldOrder) {
        if (otherId === protectedId) continue
        const otherIndex = nextIndexById.get(otherId)
        if (otherIndex === undefined) continue // dropped uncommitted chapter: allowed
        const wasBefore = (oldIndexById.get(otherId) ?? 0) < oldProtectedIndex
        const isBefore = otherIndex < protectedIndex
        if (wasBefore !== isBefore) violations.push(`chapter-reordered:${protectedId}`)
      }
    }
    if (violations.length > 0) throw new NovelPreconditionError({ rule: 'committed-chapters', violations })
  }

  /**
   * §6.1 allows pruning uncommitted chapters, but only explicitly. Revise is
   * an overlay — chapters absent from the payload are carried forward, so a
   * model echoing back only the window it read (the 150→16 field shrink) can
   * no longer silently delete the unwritten rest; deletion is structurally
   * impossible without an explicit droppedChapterIds entry. Declarations must
   * reference real chapters that are actually absent from the payload;
   * committed/completed chapters are guarded by assertProtectedChapters.
   */
  private assertChapterDropDeclarations(previous: NovelOutline, changes: NovelOutlineChanges): void {
    const declared = new Set(changes.droppedChapterIds ?? [])
    const nextIds = new Set((changes.chapters ?? []).map((chapter) => chapter.chapterId))
    const previousIds = previous.chapters.map((chapter) => chapter.chapterId)
    const violations: string[] = []
    for (const id of declared) {
      if (!previousIds.includes(id)) violations.push(`drop-not-planned:${id}`)
      else if (nextIds.has(id)) violations.push(`drop-contradicts-payload:${id}`)
    }
    if (violations.length > 0) throw new NovelPreconditionError({ rule: 'invalid-chapter-drops', violations })
  }

  /** Run-state transitions after an outline create/revise (§4.3, §9.4). */
  private runAfterOutlineChange(
    run: NovelRunState,
    approvalMode: 'automatic' | 'manual',
    outlineRevision: string,
    requirements: readonly RequirementRecord[],
    initialOutline: boolean,
  ): NovelRunState {
    const blocked = requirements.some((record) => record.status === 'blocked')
    // A manual-mode project waits for approval on its first continuation
    // outline even when it entered the outlining phase from import extraction
    // (proposal 0020 §3): the initial gate is not tied to creation-time pause.
    if (run.awaitingApprovalRevision !== null
      || (approvalMode === 'manual' && (run.pauseReason === 'awaiting-approval' || initialOutline))) {
      // Still inside the initial approval gate: revisions re-enter awaiting (§4.3).
      return {
        ...run,
        status: 'paused',
        phase: 'outlining',
        pauseReason: 'awaiting-approval',
        pauseDetail: 'outline saved; waiting for approval',
        resumeHint: 'approve the outline or request another revision (§4.3)',
        awaitingApprovalRevision: outlineRevision,
      }
    }
    if (blocked) {
      return { ...run, status: 'paused', phase: run.phase === 'outlining' ? 'outlining' : run.phase, pauseReason: 'requirement-conflict', pauseDetail: 'a requirement was marked blocked during the outline change', resumeHint: 'clarify or withdraw blocked requirements, then resume (§9.4)' }
    }
    if (run.status === 'active') {
      return { ...run, phase: 'writing' }
    }
    // Paused for other reasons (user request, stop, budget...): stay paused.
    return run
  }
}

/* --------------------------- import asset builders --------------------------- */

function bibleSummaryOf(record: ImportBibleRecord): ImportBibleSummary {
  return {
    bibleRevision: record.bibleRevision,
    mergedAt: record.mergedAt,
    sourcePartCount: record.sourcePartCount,
    premise: record.story.premise,
    endingDirection: record.story.endingDirection,
    characterCount: record.characters.length,
    worldEntryCount: record.worldEntries.length,
    timelineCount: record.timeline.length,
  }
}

/** Minimal V2 card shape consumed by resolveCharacterPage (data.* fields). */
function importCharacterCard(character: ImportCharacter): Record<string, unknown> {
  const description = [character.identity, character.appearance, character.stateAtEnd]
    .filter((part) => part.trim() !== '')
    .join('\n\n')
  const data: Record<string, unknown> = {
    name: character.name,
    description,
    personality: character.personality,
    scenario: character.role,
    first_mes: '',
    mes_example: '',
    creator_notes: 'Extracted from an imported novel (AgentNovel continuation).',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: ['imported', 'agent-novel'],
    creator: 'AgentNovel import',
    character_version: '',
    extensions: {
      importAliases: [...character.aliases],
      importRelationships: character.relationships.map((relationship) => ({ ...relationship })),
      importConfidence: character.confidence,
      importMotivation: character.motivation,
    },
  }
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
    raw: structuredClone(data),
  }
}

/** World book in the raw SillyTavern shape read by novel_lore_search. */
function importWorldBook(title: string, entries: readonly ImportWorldEntry[]): { name: string; entries: Record<string, unknown>[] } {
  return {
    name: `导入原作设定 · ${title}`,
    entries: entries.map((entry, index) => ({
      uid: index,
      key: [...entry.keys],
      keysecondary: [],
      comment: entry.title,
      content: entry.content,
      constant: false,
      selective: entry.keys.length > 0,
      order: 100,
      position: 0,
      disable: false,
      addMemo: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: false,
      depth: 4,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      triggers: [],
      ...(entry.category !== '' ? { importCategory: entry.category } : {}),
    })),
  }
}
