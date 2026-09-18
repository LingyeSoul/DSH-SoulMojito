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

import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { TavernStore } from './store.js'
import type { CharacterCardIR } from '@dsh-tavern/format'
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
  countEffectiveCharacters,
  finishGuardViolations,
  requirementWatermark,
  stableStringify,
  summarizeNovel,
  totalEffectiveCharacters,
  validateCreateConfig,
  validateOutlinePayload,
  validateRunBudgets,
  type BodyCommit,
  type CanonChange,
  type ChapterCompletion,
  type CommitReceipt,
  type HandledRequirement,
  type NovelAssetRef,
  type NovelCreateConfig,
  type NovelOutline,
  type NovelOutlinePayload,
  type NovelPauseReason,
  type NovelRunBudgets,
  type NovelRunState,
  type NovelSnapshot,
  type NovelSummary,
  type OutlineChapter,
  type RequirementRecord,
  type RequirementStatus,
  type SceneCompletion,
  type WorkIntentKind,
  type WorkIntentRecord,
  type WritingUnit,
} from './novel-model.js'

const SCHEMA_VERSION = 1
const NOVEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const REQUIREMENT_SOURCES = new Set(['composer', 'panel', 'internal'])
const CANON_KINDS = new Set(['event', 'character-state', 'relation', 'foreshadowing', 'variable'])
const SOURCE_REF_PATTERN = /^(commit-\d+)(?:#(\d+))?$/
/** Paragraph separator for the fixed body-file serialization (§10.4). */
const PARAGRAPH_SEPARATOR = '\n\n'

/** Process identity shared by every bundled copy of this module: the build
 *  ships tavern-store inside several entry bundles (index.mjs and novel.mjs
 *  both mutate novels), and two NovelStore instances in one process are the
 *  same writer that may re-enter each other's ownership (§10.2). A constant
 *  local to one copy would make the bundles reject each other under the same
 *  pid, so the identity lives on globalThis. */
const BOOT_ID: string = (globalThis as { __dshTavernNovelBootId?: string }).__dshTavernNovelBootId ??= randomBytes(16).toString('hex')

/** Command-line shapes of a live dsh host: the global install path
 *  (`node …@deepseek-ai/dsh/lib/bin.js web`) or a bare `dsh web` invocation.
 *  Deliberately narrow so a path merely containing "dsh" (a checkout of this
 *  repo, the profile dir `~/.dsh`) never reads as a competing writer. */
const DSH_HOST_COMMAND = /@deepseek-ai[\\/]dsh\b|(?:^|[\\/ \t"'])dsh(?:\.(?:cmd|js|ps1|exe|bat))?["']?[ \t]+web\b/

/** Full command line of a pid, or undefined when the pid is gone and null
 *  when the platform cannot tell. Windows asks CIM (an absent process yields
 *  empty output, a broken shell yields an error); Linux reads /proc; darwin
 *  asks ps. */
function commandLineOf(pid: number): Promise<string | undefined | null> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) resolve(null)
        else resolve(stdout.trim() === '' ? undefined : stdout.trim())
      })
    })
  }
  if (process.platform === 'linux') {
    return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then(
      (raw) => raw.split('\0').join(' ').trim() || undefined,
      (cause) => { const code = (cause as NodeJS.ErrnoException).code; return code === 'ENOENT' || code === 'ESRCH' ? undefined : null },
    )
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (error, stdout) => {
        if (error) resolve(Number((error as NodeJS.ErrnoException).code) === 1 ? undefined : null)
        else resolve(stdout.trim() === '' ? undefined : stdout.trim())
      })
    })
  }
  return Promise.resolve(null)
}

/** Whether the recorded pid still names a writer that could mutate novels
 *  (§10.2: stale ownership is recovered on evidence, never on a timeout).
 *  False proves the writer is gone: the pid is dead, was recycled to a
 *  non-dsh process, or is this very pid under a foreign boot id (every live
 *  module in this process shares BOOT_ID). An undecidable probe stays
 *  conservative and reports a live writer. */
async function isLiveDshWriter(pid: number): Promise<boolean> {
  if (pid === process.pid) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  let alive = true
  try {
    process.kill(pid, 0)
  } catch (cause) {
    alive = (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (!alive) return false
  const command = await commandLineOf(pid)
  if (command === undefined) return false
  if (command === null) return true
  return DSH_HOST_COMMAND.test(command)
}

interface OwnerFile {
  pid: number
  bootId: string
  acquiredAt: string
}

/** §13 duration budget: folds the open active window into the cumulative
 * total and closes it. Paused runs and legacy snapshots (created before the
 * window fields existed) have no open window — legacy history is amnestied
 * rather than reconstructed from wall-clock, which would charge host downtime
 * to the writing budget all over again. */
function foldActiveDuration(run: NovelRunState, nowMs: number): { activeDurationMs: number; activeWindowStart: null } {
  const open = run.status === 'active' && run.activeWindowStart !== undefined && run.activeWindowStart !== null
    ? Math.max(0, nowMs - Date.parse(run.activeWindowStart))
    : 0
  return { activeDurationMs: (run.activeDurationMs ?? 0) + open, activeWindowStart: null }
}

/** Elapsed active milliseconds under the §13 duration budget right now. */
function elapsedActiveDuration(run: NovelRunState, nowMs: number): number {
  const open = run.status === 'active' && run.activeWindowStart !== undefined && run.activeWindowStart !== null
    ? Math.max(0, nowMs - Date.parse(run.activeWindowStart))
    : 0
  return (run.activeDurationMs ?? 0) + open
}

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

export class NovelStore {
  private readonly novelsRoot: string
  private readonly mutationTails = new Map<string, Promise<void>>()
  /** Serialized async projection updates per novel; deleteNovel drains them. */
  private readonly projectionTails = new Map<string, Promise<void>>()

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
      for (const sub of ['revisions', 'assets', 'bodies', path.join('projections', 'chapters')]) {
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
      // Manual mode waits for outline approval before any writing (§4.3). There
      // is no outline yet, so awaitingApprovalRevision stays null until the
      // first createOutline pins it to a real revision.
      const run: NovelRunState = config.approvalMode === 'manual'
        ? {
            status: 'paused',
            phase: 'outlining',
            pauseReason: 'awaiting-approval',
            pauseDetail: 'manual mode: waiting for the initial outline',
            resumeHint: 'approve the outline after it is created (§4.3)',
            currentUnitId: null,
            turnsRun: 0,
            deduceRuns: 0,
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
        : {
            status: 'active',
            phase: 'outlining',
            pauseReason: null,
            pauseDetail: null,
            resumeHint: null,
            currentUnitId: null,
            turnsRun: 0,
            deduceRuns: 0,
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
      }
      const snapshot: NovelSnapshot = {
        novelId,
        revision: '',
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        config: structuredClone(config),
        assets,
        outline: null,
        requirements: [requirement],
        units: [],
        commits: [],
        completedChapters: [],
        premiseNote: null,
        run,
        contentRevision: '',
        countPolicyVersion: 1,
      }
      snapshot.contentRevision = contentRevisionOf(snapshot)
      const revision = await this.publish(dir, null, snapshot, 'create-novel')
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
    input: { expectedRevision: string; patch: { title?: string; genre?: string; premiseNote?: string; budgets?: NovelRunBudgets }; cause: string },
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
      await this.projectionTails.get(novelId)?.catch(() => {})
      await fs.rm(dir, { recursive: true, force: true })
      return true
    })
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
    if (payloadErrors.length > 0) throw new NovelConfigError({ message: 'invalid outline payload', errors: payloadErrors })
    if (input.outline.droppedChapterIds?.length) {
      throw new NovelConfigError({
        message: 'invalid outline payload',
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
        chapters: structuredClone(input.outline.chapters),
        currentChapterId: input.outline.currentChapterId,
        scenes: structuredClone(input.outline.scenes),
        foreshadowing: structuredClone(input.outline.foreshadowing),
      }
      const requirements = applyHandledRequirements(current.requirements, handled, outlineRevision)
      const watermark = assertWatermarkAdvanced(current.requirements, requirements)
      const run = this.runAfterOutlineChange(current.run, current.config.approvalMode, outlineRevision, requirements)
      const next: NovelSnapshot = { ...current, updatedAt: new Date().toISOString(), outline: built, requirements, run }
      const revision = await this.publish(dir, current.revision, next, `outline-create:${outlineRevision}`)
      return { outlineRevision, revision, watermark }
    })
  }

  /**
   * Atomically revises the plan and the handled requirement results (§9.3).
   * Rejected while any unit is claimed (§9.2) and never drops or reorders
   * chapters that contain committed bodies (§6.1).
   */
  async reviseOutline(
    novelId: string,
    input: { expectedRevision: string; expectedOutlineRevision: string; reason: string; changes: NovelOutlinePayload; handledRequirements: readonly HandledRequirement[] },
  ): Promise<{ outlineRevision: string; revision: string; watermark: number }> {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new NovelConfigError({ message: 'revision reason must be a non-empty string' })
    const payloadErrors = validateOutlinePayload(input.changes)
    if (payloadErrors.length > 0) throw new NovelConfigError({ message: 'invalid outline payload', errors: payloadErrors })
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
      this.assertProtectedChapters(previous, current, input.changes.chapters)
      this.assertAcknowledgedChapterDrops(previous, input.changes)
      const handled = this.validateHandledRequirements(current, input.handledRequirements)
      const outlineRevision = hash16({ kind: 'outline', parent: previous.outlineRevision, reason: input.reason, payload: input.changes })
      const built: NovelOutline = {
        outlineRevision,
        parentRevision: previous.outlineRevision,
        reason: input.reason,
        sourceRequirementIds: handled.map((item) => item.requirementId),
        story: structuredClone(input.changes.story),
        characters: structuredClone(input.changes.characters),
        chapters: structuredClone(input.changes.chapters),
        currentChapterId: input.changes.currentChapterId,
        scenes: structuredClone(input.changes.scenes),
        foreshadowing: structuredClone(input.changes.foreshadowing),
      }
      const requirements = applyHandledRequirements(current.requirements, handled, outlineRevision)
      const watermark = assertWatermarkAdvanced(current.requirements, requirements)
      const run = this.runAfterOutlineChange(current.run, current.config.approvalMode, outlineRevision, requirements)
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
      // Preparing the same scene twice returns the existing prepared unit.
      const existing = current.units.find((unit) => unit.chapterId === input.chapterId && unit.sceneId === input.sceneId && unit.state === 'prepared')
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

  /** Retires an unclaimed unit (§6.2); claimed units must finish or be stopped. */
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
        let total = 0
        for (const commit of current.commits) {
          total += commit.effectiveCharacters
          if (commit.commitId === existing.commitId) break
        }
        return {
          commitId: existing.commitId,
          unitId: unit.unitId,
          bodyHash: existing.bodyHash,
          effectiveCharacters: existing.effectiveCharacters,
          deltaCharacters: existing.effectiveCharacters,
          totalCharacters: total,
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
      const totalBefore = totalEffectiveCharacters(current.commits)
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
      return { revision, totalCharacters: totalEffectiveCharacters(next.commits) }
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
      const phase = current.outline === null ? 'outlining' : blocked.length > 0 || pending.length > 0 ? 'revising' : 'writing'
      const next: NovelSnapshot = {
        ...current,
        updatedAt: new Date().toISOString(),
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

  /* -------------------------------- reads -------------------------------- */

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
    const selected = current.commits.filter((commit) =>
      (query.chapterId === undefined || commit.chapterId === query.chapterId)
      && (query.unitId === undefined || commit.unitId === query.unitId))
    const flattened: Array<{ commitId: string; paragraphIndex: number; chapterId: string; text: string }> = []
    for (const commit of selected) {
      const paragraphs = await this.readBodyParagraphs(novelId, dir, commit.bodyHash, commit.paragraphCount)
      paragraphs.forEach((text, index) => flattened.push({ commitId: commit.commitId, paragraphIndex: index, chapterId: commit.chapterId, text }))
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

  /* ------------------------------- internal ------------------------------- */

  private novelDir(novelId: string): string {
    if (!NOVEL_ID_PATTERN.test(novelId)) throw new Error(`invalid novel id '${novelId}'`)
    return path.join(this.novelsRoot, novelId)
  }

  private mutate<T>(novelId: string, operation: () => Promise<T>): Promise<T> {
    // In-process serialization per novel, mirroring store.ts stateMutationTail.
    const tail = this.mutationTails.get(novelId) ?? Promise.resolve()
    const result = tail.catch(() => {}).then(operation)
    this.mutationTails.set(novelId, result.then(() => {}, () => {}))
    return result
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
      || !Array.isArray(snapshot.units) || !Array.isArray(snapshot.commits)) {
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
    const tail = this.projectionTails.get(snapshot.novelId) ?? Promise.resolve()
    const projected = tail.catch(() => {}).then(() => this.updateProjections(dir, withRevision))
    this.projectionTails.set(snapshot.novelId, projected.then(() => {}, () => {}))
    projected.catch(() => {})
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
        for (const commit of snapshot.commits.filter((item) => item.chapterId === chapterId)) {
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
   * §6.1 allows pruning uncommitted chapters, but only explicitly: the revise
   * payload replaces the whole plan, so a model that merely echoes back the
   * chapter window it read (a 150-chapter plan shrank to its 12 written
   * chapters in the field) must not silently delete the unwritten rest. Every
   * previous chapter absent from the payload must be declared in
   * droppedChapterIds; declarations must reference real, actually-removed
   * chapters.
   */
  private assertAcknowledgedChapterDrops(previous: NovelOutline, changes: NovelOutlinePayload): void {
    const declared = new Set(changes.droppedChapterIds ?? [])
    const nextIds = new Set(changes.chapters.map((chapter) => chapter.chapterId))
    const previousIds = previous.chapters.map((chapter) => chapter.chapterId)
    const violations: string[] = []
    for (const id of declared) {
      if (!previousIds.includes(id)) violations.push(`drop-not-planned:${id}`)
      else if (nextIds.has(id)) violations.push(`drop-contradicts-payload:${id}`)
    }
    const unacknowledged = previousIds.filter((id) => !nextIds.has(id) && !declared.has(id))
    const shown = unacknowledged.slice(0, 20)
    for (const id of shown) violations.push(`chapter-dropped-without-acknowledgement:${id}`)
    if (unacknowledged.length > shown.length) {
      violations.push(`plus ${unacknowledged.length - shown.length} more silent drops; carry forward every existing chapter or list each removed chapterId in droppedChapterIds`)
    }
    if (violations.length > 0) throw new NovelPreconditionError({ rule: 'unacknowledged-chapter-drops', violations })
  }

  /** Run-state transitions after an outline create/revise (§4.3, §9.4). */
  private runAfterOutlineChange(run: NovelRunState, approvalMode: 'automatic' | 'manual', outlineRevision: string, requirements: readonly RequirementRecord[]): NovelRunState {
    const blocked = requirements.some((record) => record.status === 'blocked')
    if (run.awaitingApprovalRevision !== null || approvalMode === 'manual' && run.pauseReason === 'awaiting-approval') {
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

/* ------------------------------ pure helpers ------------------------------ */

function applyHandledRequirements(
  records: readonly RequirementRecord[],
  handled: readonly HandledRequirement[],
  outlineRevision: string,
): RequirementRecord[] {
  const byId = new Map(handled.map((item) => [item.requirementId, item]))
  return records.map((record) => {
    const item = byId.get(record.requirementId)
    if (item === undefined) return record
    if (item.result === 'applied') {
      return { ...record, status: 'applied' as RequirementStatus, appliedRevision: outlineRevision, effectiveLocation: item.effectiveLocation ?? null, blockedReason: null, supersededBy: null }
    }
    if (item.result === 'superseded') {
      return { ...record, status: 'superseded' as RequirementStatus, appliedRevision: outlineRevision, supersededBy: item.supersededBy ?? null, blockedReason: null }
    }
    return { ...record, status: 'blocked' as RequirementStatus, blockedReason: item.blockedReason ?? 'blocked during outline change', appliedRevision: null, effectiveLocation: null }
  })
}

/** Watermark must only advance across a revision (§9.3). */
function assertWatermarkAdvanced(before: readonly RequirementRecord[], after: readonly RequirementRecord[]): number {
  const beforeMark = requirementWatermark(before)
  const afterMark = requirementWatermark(after)
  if (afterMark < beforeMark) {
    throw new NovelPreconditionError({ rule: 'watermark-regression', violations: [`${beforeMark} -> ${afterMark}`] })
  }
  return afterMark
}

function validateCanonChanges(changes: readonly CanonChange[], commits: readonly BodyCommit[], upcomingCommitId: string, upcomingParagraphCount: number): void {
  if (!Array.isArray(changes)) throw new NovelConfigError({ message: 'canonChanges must be an array' })
  for (const change of changes) {
    if (typeof change !== 'object' || change === null || !CANON_KINDS.has(change.kind)
      || typeof change.summary !== 'string' || change.summary.trim() === ''
      || !Array.isArray(change.sources)) {
      throw new NovelConfigError({ message: 'invalid canon change entry' })
    }
    if (change.detail !== undefined && (typeof change.detail !== 'object' || change.detail === null || Array.isArray(change.detail))) {
      throw new NovelConfigError({ message: 'canon change detail must be an object' })
    }
    for (const source of change.sources) {
      if (typeof source !== 'string') throw new NovelConfigError({ message: 'canon sources must be strings' })
      // §8.2: sources must fall into this or previously committed bodies.
      const match = SOURCE_REF_PATTERN.exec(source)
      if (match === null) throw new NovelConfigError({ message: `invalid canon source '${source}' (expected <commitId> or <commitId>#<index>)` })
      const commitId = match[1]
      const indexRaw = match[2]
      if (commitId === undefined) throw new NovelConfigError({ message: `invalid canon source '${source}'` })
      if (commitId === upcomingCommitId) {
        if (indexRaw !== undefined && Number(indexRaw) >= upcomingParagraphCount) {
          throw new NovelConfigError({ message: `canon source '${source}' references a paragraph beyond the candidate body` })
        }
        continue
      }
      const existing = commits.find((commit) => commit.commitId === commitId)
      if (existing === undefined) throw new NovelConfigError({ message: `canon source '${source}' references an unknown commit` })
      if (indexRaw !== undefined && Number(indexRaw) >= existing.paragraphCount) {
        throw new NovelConfigError({ message: `canon source '${source}' references a paragraph beyond commit ${commitId}` })
      }
    }
  }
}

function parseOwnerFile(novelId: string, ownerPath: string, raw: string): OwnerFile {
  try {
    const owner = JSON.parse(raw) as OwnerFile
    if (typeof owner !== 'object' || owner === null || !Number.isInteger(owner.pid) || typeof owner.bootId !== 'string') {
      throw new Error('invalid shape')
    }
    return owner
  } catch (cause) {
    throw new NovelStorageCorruptionError({ novelId, path: ownerPath, detail: `.owner.json is unreadable: ${(cause as Error).message}` })
  }
}

/** World name attached to a character card, mirroring store.ts materializeEmbeddedBook naming. */
function embeddedWorldName(card: CharacterCardIR): string | null {
  const book = card.data.characterBook
  if (book === undefined || book === null) return null
  const linked = card.data.extensions['world']
  if (typeof linked === 'string' && linked.trim() !== '') return linked.trim()
  if (typeof book.name === 'string' && book.name.trim() !== '') return book.name.trim()
  return card.data.name
}

/** Content projection version (§14.1): body, chapter display info, completions. */
function contentRevisionOf(snapshot: NovelSnapshot): string {
  return hash16({
    chapters: (snapshot.outline?.chapters ?? []).map((chapter) => ({ chapterId: chapter.chapterId, order: chapter.order, title: chapter.title })),
    completedChapters: snapshot.completedChapters,
    commits: snapshot.commits.map((commit) => ({ commitId: commit.commitId, bodyHash: commit.bodyHash, effectiveCharacters: commit.effectiveCharacters })),
  })
}

function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hash16(value: unknown): string {
  return sha256hex(stableStringify(value)).slice(0, 16)
}

function jsonBytes(obj: unknown): Uint8Array {
  return textBytes(JSON.stringify(obj, null, 2))
}

function textBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

async function tryReadText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

/**
 * Immutable object write (§10.2 step 2): tmp file + fsync + rename. Existing
 * files are left untouched (content-addressed). Body and asset objects and
 * revision files all use this path; the file handle is synced before closing.
 */
async function writeImmutableBytes(file: string, bytes: Uint8Array): Promise<void> {
  try {
    await fs.access(file)
    return
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, file)
}

/**
 * HEAD replacement (§10.2 step 4): tmp + fsync + rename is the logical commit
 * point. On Windows, Node's fs.rename replaces the existing target
 * (MoveFileExW MOVEFILE_REPLACE_EXISTING), verified by the test suite on a
 * real NTFS filesystem; one retry covers transient EPERM/EBUSY contention.
 */
async function replaceHead(head: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${head}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.rename(tmp, head)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
      try { await fs.rm(tmp, { force: true }) } catch { /* best effort */ }
      throw cause
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
    await fs.rename(tmp, head)
  }
}

/** Simple atomic write for rebuildable projections (no fsync needed). */
async function writeAtomicText(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

async function readDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}
