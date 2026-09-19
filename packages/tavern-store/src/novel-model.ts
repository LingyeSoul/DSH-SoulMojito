/**
 * Pure domain layer for AgentNovel (docs/proposals/0005-agent-novel-architecture.md).
 *
 * This module contains strict types, error classes and pure functions only.
 * No IO lives here; the file-system adapter is novel.ts. Comments reference
 * proposal sections as §n.
 */

/* ------------------------------- status ------------------------------- */

export type NovelStatus = 'active' | 'paused' | 'completed'
export type NovelPhase = 'outlining' | 'revising' | 'writing' | 'finishing'

/** Structured pause reasons; each must map to an actionable resume path (§12.1, §13). */
export type NovelPauseReason =
  | 'user-request'
  | 'stopped'
  | 'awaiting-approval'
  | 'requirement-conflict'
  | 'budget'
  | 'stalled'
  | 'recovery-required'
  | 'projection-pending'
  | 'capacity'

/* ------------------------------- budget ------------------------------- */

/** Story length contract (§7.1). Unbounded still requires finite run budgets. */
export type LengthBudget =
  | { kind: 'unbounded' }
  | { kind: 'target'; targetCharacters: number; toleranceRatio: number; hardMaximumCharacters: number | null }

/** Explicit run budgets; every field must be positive (§7.1, §13). */
export interface NovelRunBudgets {
  maxTurns: number
  maxDurationMs: number
  stallThresholdTurns: number
  consecutiveFailureLimit: number
  externalRetry: { maxAttempts: number; backoffMs: number }
  maxDeduceRuns: number
  /** Per-claim writer dispatch ceiling (0007 §5.3): total dispatches per
   *  claim including the first. Optional so legacy snapshots stay valid;
   *  absent falls back to the built-in default of 3. A retry parameter,
   *  not a cost edge — §7's "no new limit" scopes budget stops like
   *  maxTurns/maxDurationMs. */
  writerDispatchLimit?: number
}

/** Where write-unit model execution happens (0007 §8). */
export type WriterMode = 'inline' | 'subagent'

export function isWriterMode(value: unknown): value is WriterMode {
  return value === 'inline' || value === 'subagent'
}

export interface NovelCreateConfig {
  title: string
  requirement: string
  language: string
  genre: string
  narrativePerspective: string
  styleNotes: string
  lengthBudget: LengthBudget
  maxChapters: number | null
  approvalMode: 'automatic' | 'manual'
  characterNames: readonly string[]
  worldNames: readonly string[]
  budgets: NovelRunBudgets
  /** Where write-unit model execution happens (0007 §8): 'inline' = the
   *  author agent writes inside its own session; 'subagent' = a one-shot
   *  writer subagent per unit. Optional on input so legacy fixtures and
   *  callers stay valid; the store normalizes absent values to 'inline' at
   *  creation (W3 may flip the default after A/B, not before). */
  writerMode?: WriterMode
}

/** Counting policy version fixed in the project (§7.1): 1 = Unicode code
 *  points, letters/digits only (Han included), whitespace/punctuation/formatting ignored. */
export const NOVEL_COUNT_POLICY_VERSION = 1

/* ----------------------------- validation ----------------------------- */

export interface ValidationError {
  field: string
  message: string
}

/**
 * Counts effective characters under countPolicyVersion 1 (§7.1): iterate by
 * Unicode code point (not UTF-16 units), count letters and numbers only.
 * Han characters count as one each; English counts per letter; whitespace,
 * punctuation, formatting symbols and emoji (including surrogate pairs /
 * ZWJ sequences) are ignored.
 */
export function countEffectiveCharacters(text: string): number {
  let count = 0
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) count += 1
  }
  return count
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Structural validation for run budgets (§7.1, §13). Shared by creation and
 * meta patches so edited budgets meet the same contract as created ones.
 */
export function validateRunBudgets(budgets: unknown): ValidationError[] {
  if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) {
    return [{ field: 'budgets', message: 'budgets is required' }]
  }
  const errors: ValidationError[] = []
  const b = budgets as Record<string, unknown>
  for (const field of ['maxTurns', 'maxDurationMs', 'stallThresholdTurns', 'consecutiveFailureLimit', 'maxDeduceRuns'] as const) {
    if (!isPositiveInteger(b[field])) {
      errors.push({ field: `budgets.${field}`, message: `${field} must be a positive integer` })
    }
  }
  const retry = b.externalRetry
  if (typeof retry !== 'object' || retry === null || Array.isArray(retry)
    || !isPositiveInteger((retry as Record<string, unknown>).maxAttempts)
    || !isPositiveInteger((retry as Record<string, unknown>).backoffMs)) {
    errors.push({ field: 'budgets.externalRetry', message: 'externalRetry.maxAttempts and backoffMs must be positive integers' })
  }
  if (b.writerDispatchLimit !== undefined && !isPositiveInteger(b.writerDispatchLimit)) {
    errors.push({ field: 'budgets.writerDispatchLimit', message: 'writerDispatchLimit must be a positive integer' })
  }
  return errors
}

/**
 * Structural validation for creation config (§7.1: obviously incompatible
 * configs are rejected, never silently clamped). Returns concrete errors;
 * createNovel throws NovelConfigError when the list is non-empty.
 */
export function validateCreateConfig(config: NovelCreateConfig): ValidationError[] {
  const errors: ValidationError[] = []
  const c = config as unknown as Record<string, unknown>
  for (const field of ['title', 'requirement', 'language', 'genre', 'narrativePerspective'] as const) {
    if (typeof c[field] !== 'string' || (c[field] as string).trim() === '') {
      errors.push({ field, message: `${field} must be a non-empty string` })
    }
  }
  if (typeof c.styleNotes !== 'string') {
    errors.push({ field: 'styleNotes', message: 'styleNotes must be a string' })
  }
  const budget = c.lengthBudget
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
    errors.push({ field: 'lengthBudget', message: 'lengthBudget is required' })
  } else {
    const b = budget as Record<string, unknown>
    if (b.kind !== 'unbounded' && b.kind !== 'target') {
      errors.push({ field: 'lengthBudget.kind', message: "lengthBudget.kind must be 'unbounded' or 'target'" })
    } else if (b.kind === 'target') {
      if (!isPositiveInteger(b.targetCharacters)) {
        errors.push({ field: 'lengthBudget.targetCharacters', message: 'targetCharacters must be a positive integer' })
      }
      const tolerance = b.toleranceRatio
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
        errors.push({ field: 'lengthBudget.toleranceRatio', message: 'toleranceRatio must be within [0, 1)' })
      }
      const hardMax = b.hardMaximumCharacters
      if (hardMax !== null && hardMax !== undefined) {
        if (!isPositiveInteger(hardMax)) {
          errors.push({ field: 'lengthBudget.hardMaximumCharacters', message: 'hardMaximumCharacters must be a positive integer or null' })
        } else if (isPositiveInteger(b.targetCharacters) && hardMax < b.targetCharacters) {
          errors.push({ field: 'lengthBudget.hardMaximumCharacters', message: 'hardMaximumCharacters must not be lower than targetCharacters' })
        }
      } else if (hardMax === undefined) {
        errors.push({ field: 'lengthBudget.hardMaximumCharacters', message: 'hardMaximumCharacters must be a positive integer or null' })
      }
    }
  }
  if (c.maxChapters !== null && c.maxChapters !== undefined && !isPositiveInteger(c.maxChapters)) {
    errors.push({ field: 'maxChapters', message: 'maxChapters must be a positive integer or null' })
  }
  if (c.approvalMode !== 'automatic' && c.approvalMode !== 'manual') {
    errors.push({ field: 'approvalMode', message: "approvalMode must be 'automatic' or 'manual'" })
  }
  // 0007 §8: writerMode is an explicit two-value enum; absent means the
  // store-side 'inline' default applies (creation normalizes it).
  if (c.writerMode !== undefined && !isWriterMode(c.writerMode)) {
    errors.push({ field: 'writerMode', message: "writerMode must be 'inline' or 'subagent'" })
  }
  for (const field of ['characterNames', 'worldNames'] as const) {
    const list = c[field]
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || name.trim() === '')) {
      errors.push({ field, message: `${field} must be an array of non-empty strings` })
    } else if (new Set(list as string[]).size !== (list as string[]).length) {
      errors.push({ field, message: `${field} must not contain duplicates` })
    }
  }
  errors.push(...validateRunBudgets(c.budgets))
  return errors
}

/** Total committed effective characters (§7.2: recomputed from commit records). */
export function totalEffectiveCharacters(commits: readonly BodyCommit[]): number {
  return commits.reduce((total, commit) => total + commit.effectiveCharacters, 0)
}

/**
 * Length check for finishing (§7.3). Target mode requires the total to fall
 * into [target * (1 - tolerance), hardMax or target * (1 + tolerance)].
 */
export function lengthWithinBudget(total: number, budget: LengthBudget): boolean {
  if (budget.kind === 'unbounded') return true
  const lower = budget.targetCharacters * (1 - budget.toleranceRatio)
  const upper = budget.hardMaximumCharacters ?? budget.targetCharacters * (1 + budget.toleranceRatio)
  return total >= lower && total <= upper
}

/* ------------------------------- outline ------------------------------- */

export interface OutlineStory {
  premise: string
  theme: string
  mainConflict: string
  endingDirection: string
  taboos: readonly string[]
}

export interface OutlineCharacter {
  characterId: string
  name: string
  assetRef?: string
  initialState: string
  motivation: string
  relations: readonly string[]
  arc: string
}

export interface OutlineChapter {
  chapterId: string
  order: number
  title: string
  purpose: string
  keyEvents: readonly string[]
  plannedCharacters: number | null
  entryCondition: string
  exitCondition: string
}

/**
 * Chapter as supplied in a payload: the optional fields may be omitted. On
 * revise an omitted field is inherited from the existing chapter with the
 * same id; on create (and for newly inserted chapters) it defaults to an
 * empty list / unplanned.
 */
export interface OutlineChapterInput {
  chapterId: string
  order: number
  title: string
  purpose: string
  keyEvents?: readonly string[]
  plannedCharacters?: number | null
  entryCondition: string
  exitCondition: string
}

/** Current-chapter scene plan (§6.1 detail layer). */
export interface ScenePlan {
  sceneId: string
  order: number
  goal: string
  participants: readonly string[]
  timeLocation: string
  causality: string
  conflict: string
  expectedChange: string
  continuationAnchor?: string
}

export interface Foreshadowing {
  id: string
  description: string
  plantAt: string | null
  payoffAt: string | null
  required: boolean
  status: 'open' | 'planted' | 'resolved'
}

/** Versioned plan (§6). outlineRevision identity is content-derived. */
export interface NovelOutline {
  outlineRevision: string
  parentRevision: string | null
  reason: string
  sourceRequirementIds: readonly string[]
  story: OutlineStory
  characters: readonly OutlineCharacter[]
  chapters: readonly OutlineChapter[]
  currentChapterId: string | null
  scenes: readonly ScenePlan[]
  foreshadowing: readonly Foreshadowing[]
}

/** Outline content supplied by the author agent; revision metadata is store-side.
 * On revise, `chapters` is an overlay: each entry replaces (or inserts) the
 * same-id chapter and every untouched chapter is carried forward unchanged. */
export interface NovelOutlinePayload {
  story: OutlineStory
  characters: readonly OutlineCharacter[]
  chapters: readonly OutlineChapterInput[]
  currentChapterId: string | null
  scenes: readonly ScenePlan[]
  foreshadowing: readonly Foreshadowing[]
/**
   * Revision-only: chapterIds intentionally pruned from the plan (§6.1 allows
   * dropping uncommitted chapters). Chapters absent from `chapters` are
   * carried forward, so a windowed novel_outline_read echo can never shrink
   * the plan; only ids listed here are removed.
   */
  droppedChapterIds?: readonly string[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** Structural validation of an outline payload (stable IDs, §5/§6.1). */
export function validateOutlinePayload(payload: NovelOutlinePayload): ValidationError[] {
  const errors: ValidationError[] = []
  const p = payload as unknown as Record<string, unknown>
  const story = p.story
  if (typeof story !== 'object' || story === null || Array.isArray(story)) {
    errors.push({ field: 'story', message: 'story is required' })
  } else {
    for (const field of ['premise', 'theme', 'mainConflict', 'endingDirection'] as const) {
      if (typeof (story as Record<string, unknown>)[field] !== 'string' || ((story as Record<string, unknown>)[field] as string).trim() === '') {
        errors.push({ field: `story.${field}`, message: `${field} must be a non-empty string` })
      }
    }
    if (!Array.isArray((story as Record<string, unknown>).taboos) || (story as { taboos: unknown[] }).taboos.some((t) => typeof t !== 'string')) {
      errors.push({ field: 'story.taboos', message: 'taboos must be an array of strings' })
    }
  }
  const characters = p.characters
  if (!Array.isArray(characters)) {
    errors.push({ field: 'characters', message: 'characters must be an array' })
  } else {
    const seen = new Set<string>()
    characters.forEach((character, index) => {
      const c = character as Record<string, unknown>
      if (!isSafeId(c.characterId)) {
        errors.push({ field: `characters[${index}].characterId`, message: 'characterId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' })
      } else if (seen.has(c.characterId)) {
        errors.push({ field: `characters[${index}].characterId`, message: `duplicate characterId '${c.characterId}'` })
      } else {
        seen.add(c.characterId)
      }
      for (const field of ['name', 'initialState', 'motivation', 'arc'] as const) {
        if (typeof c[field] !== 'string' || (c[field] as string).trim() === '') {
          errors.push({ field: `characters[${index}].${field}`, message: `${field} must be a non-empty string` })
        }
      }
      if (!Array.isArray(c.relations) || (c.relations as unknown[]).some((r) => typeof r !== 'string')) {
        errors.push({ field: `characters[${index}].relations`, message: 'relations must be an array of strings' })
      }
    })
  }
  const chapterIds = new Set<string>()
  const orders: number[] = []
  const chapters = p.chapters
  if (!Array.isArray(chapters)) {
    errors.push({ field: 'chapters', message: 'chapters must be an array' })
  } else {
    chapters.forEach((chapter, index) => {
      const c = chapter as Record<string, unknown>
      if (!isSafeId(c.chapterId)) {
        errors.push({ field: `chapters[${index}].chapterId`, message: 'chapterId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' })
      } else if (chapterIds.has(c.chapterId)) {
        errors.push({ field: `chapters[${index}].chapterId`, message: `duplicate chapterId '${c.chapterId}'` })
      } else {
        chapterIds.add(c.chapterId)
      }
      if (!isPositiveInteger(c.order)) {
        errors.push({ field: `chapters[${index}].order`, message: 'order must be a positive integer' })
      } else {
        orders.push(c.order)
      }
      for (const field of ['title', 'purpose', 'entryCondition', 'exitCondition'] as const) {
        if (typeof c[field] !== 'string' || (c[field] as string).trim() === '') {
          errors.push({ field: `chapters[${index}].${field}`, message: `${field} must be a non-empty string` })
        }
      }
      if (c.keyEvents !== undefined && (!Array.isArray(c.keyEvents) || (c.keyEvents as unknown[]).some((e) => typeof e !== 'string'))) {
        errors.push({ field: `chapters[${index}].keyEvents`, message: 'keyEvents must be an array of strings when provided' })
      }
      if (c.plannedCharacters !== null && c.plannedCharacters !== undefined && !isPositiveInteger(c.plannedCharacters)) {
        errors.push({ field: `chapters[${index}].plannedCharacters`, message: 'plannedCharacters must be a positive integer or null' })
      }
    })
    if (orders.length > 0 && new Set(orders).size !== orders.length) {
      errors.push({ field: 'chapters.order', message: 'chapter order values must be unique' })
    }
  }
  const currentChapterId = p.currentChapterId
  if (currentChapterId !== null && currentChapterId !== undefined && typeof currentChapterId !== 'string') {
    errors.push({ field: 'currentChapterId', message: 'currentChapterId must be a string or null' })
  }
  const scenes = p.scenes
  if (!Array.isArray(scenes)) {
    errors.push({ field: 'scenes', message: 'scenes must be an array' })
  } else {
    const seen = new Set<string>()
    scenes.forEach((scene, index) => {
      const s = scene as Record<string, unknown>
      if (!isSafeId(s.sceneId)) {
        errors.push({ field: `scenes[${index}].sceneId`, message: 'sceneId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' })
      } else if (seen.has(s.sceneId)) {
        errors.push({ field: `scenes[${index}].sceneId`, message: `duplicate sceneId '${s.sceneId}'` })
      } else {
        seen.add(s.sceneId)
      }
      if (!isPositiveInteger(s.order)) {
        errors.push({ field: `scenes[${index}].order`, message: 'order must be a positive integer' })
      }
      for (const field of ['goal', 'timeLocation', 'causality', 'conflict', 'expectedChange'] as const) {
        if (typeof s[field] !== 'string' || (s[field] as string).trim() === '') {
          errors.push({ field: `scenes[${index}].${field}`, message: `${field} must be a non-empty string` })
        }
      }
      if (!Array.isArray(s.participants) || (s.participants as unknown[]).some((x) => typeof x !== 'string')) {
        errors.push({ field: `scenes[${index}].participants`, message: 'participants must be an array of strings' })
      }
    })
  }
  const foreshadowing = p.foreshadowing
  if (!Array.isArray(foreshadowing)) {
    errors.push({ field: 'foreshadowing', message: 'foreshadowing must be an array' })
  } else {
    const seen = new Set<string>()
    foreshadowing.forEach((item, index) => {
      const f = item as Record<string, unknown>
      if (!isSafeId(f.id)) {
        errors.push({ field: `foreshadowing[${index}].id`, message: 'id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' })
      } else if (seen.has(f.id)) {
        errors.push({ field: `foreshadowing[${index}].id`, message: `duplicate foreshadowing id '${f.id}'` })
      } else {
        seen.add(f.id)
      }
      if (typeof f.description !== 'string' || (f.description as string).trim() === '') {
        errors.push({ field: `foreshadowing[${index}].description`, message: 'description must be a non-empty string' })
      }
      if (f.status !== 'open' && f.status !== 'planted' && f.status !== 'resolved') {
        errors.push({ field: `foreshadowing[${index}].status`, message: "status must be 'open' | 'planted' | 'resolved'" })
      }
      if (typeof f.required !== 'boolean') {
        errors.push({ field: `foreshadowing[${index}].required`, message: 'required must be a boolean' })
      }
    })
  }
  const droppedChapterIds = p.droppedChapterIds
  if (droppedChapterIds !== undefined) {
    if (!Array.isArray(droppedChapterIds) || droppedChapterIds.some((id) => !isSafeId(id))) {
      errors.push({ field: 'droppedChapterIds', message: 'droppedChapterIds must be an array of chapterIds matching [A-Za-z0-9][A-Za-z0-9_-]{0,63}' })
    } else if (new Set(droppedChapterIds).size !== droppedChapterIds.length) {
      errors.push({ field: 'droppedChapterIds', message: 'droppedChapterIds must not contain duplicates' })
    }
  }
  return errors
}

/**
 * Cross-field outline checks that depend on the full chapter set — the merged
 * plan on revise (payload overlay + carried-forward chapters), the payload
 * itself on create: order values unique across the whole set, and a
 * currentChapterId that references an existing chapter whenever any exist.
 */
export function validateOutlineConsistency(
  chapters: readonly { chapterId: string; order: number }[],
  currentChapterId: string | null | undefined,
): ValidationError[] {
  const errors: ValidationError[] = []
  const orders = chapters.map((chapter) => chapter.order)
  if (new Set(orders).size !== orders.length) {
    errors.push({ field: 'chapters.order', message: 'chapter order values must be unique across the plan (payload orders collide with carried-forward chapters)' })
  }
  const ids = new Set(chapters.map((chapter) => chapter.chapterId))
  if (currentChapterId !== null && currentChapterId !== undefined) {
    if (!ids.has(currentChapterId)) {
      errors.push({ field: 'currentChapterId', message: 'currentChapterId must reference a chapter in the plan' })
    }
  } else if (ids.size > 0) {
    errors.push({ field: 'currentChapterId', message: 'currentChapterId is required when chapters exist' })
  }
  return errors
}

/* ----------------------------- requirements ----------------------------- */

export type RequirementStatus = 'pending' | 'applied' | 'superseded' | 'blocked'

/** Author directive ledger entry (§9.1). */
export interface RequirementRecord {
  requirementId: string
  hostMessageId: string
  sequence: number
  text: string
  receivedAt: string
  receivedUnitId: string | null
  status: RequirementStatus
  appliedRevision: string | null
  effectiveLocation: string | null
  blockedReason: string | null
  supersededBy: string | null
}

/**
 * Processing watermark (§9.1): the sequence of the contiguous prefix of
 * requirements (ordered by sequence) whose status is applied or superseded.
 * blocked never counts as processed; a pending hole stops the prefix.
 */
export function requirementWatermark(records: readonly RequirementRecord[]): number {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence)
  let watermark = 0
  for (const record of ordered) {
    if (record.status !== 'applied' && record.status !== 'superseded') break
    watermark = record.sequence
  }
  return watermark
}

/** Per-requirement processing result submitted with an outline revision (§9.3). */
export interface HandledRequirement {
  requirementId: string
  result: 'applied' | 'superseded' | 'blocked'
  effectiveLocation?: string
  blockedReason?: string
  /** Replacing requirement id for 'superseded' (§9.1: keep the replacement id). */
  supersededBy?: string
}

/* -------------------------------- units -------------------------------- */

export type WritingUnitState = 'prepared' | 'claimed' | 'committed' | 'superseded'

/** A schedulable scene fragment (§6.2). */
export interface WritingUnit {
  unitId: string
  chapterId: string
  sceneId: string
  label: string
  state: WritingUnitState
  attempt: number
  claimedRevision: string | null
  claimedRequirementSequence: number | null
  hostTurn: number | null
  goal: string
  continuationAnchor: string | null
  lastError: string | null
  /** sha256 of the raw execution token issued at claim time; null when not claimed.
   *  Persisted so stop()/restart revocation survives process restarts (§9.4, §12.3). */
  executionTokenHash: string | null
}

/* ------------------------------- commits ------------------------------- */

export interface CanonChange {
  kind: 'event' | 'character-state' | 'relation' | 'foreshadowing' | 'variable'
  summary: string
  /** Paragraph sources as `<commitId>` or `<commitId>#<paragraphIndex>` (§10.4). */
  sources: readonly string[]
  detail?: Record<string, string>
}

/** Immutable body commit record (§10.1/§10.4). */
export interface BodyCommit {
  commitId: string
  unitId: string
  chapterId: string
  attempt: number
  /** Business content hash: sha256 over paragraphs + scene completion + canon changes (§10.3). */
  bodyHash: string
  paragraphCount: number
  effectiveCharacters: number
  sceneCompleted: boolean
  completionBasis: string
  outstandingGoals: readonly string[]
  canonChanges: readonly CanonChange[]
  outlineRevision: string
  requirementSequence: number
  committedAt: string
}

/** Scene completion declaration supplied with a body commit. */
export interface SceneCompletion {
  completed: boolean
  basis: string
  outstandingGoals: readonly string[]
  nextAnchor: string | null
}

/** Successful commit receipt (§10.4). duplicate=true re-plays the original receipt. */
export interface CommitReceipt {
  commitId: string
  unitId: string
  bodyHash: string
  effectiveCharacters: number
  deltaCharacters: number
  totalCharacters: number
  revision: string
  duplicate: boolean
}

/** Chapter completion is an explicit operation separate from body commits (§6.2). */
export interface ChapterCompletion {
  chapterId: string
  basis: string
  openItems: readonly string[]
  completedAt: string
}

/* --------------------------------- run --------------------------------- */

export type WorkIntentKind = 'outline-create' | 'outline-revise' | 'write-unit' | 'chapter-complete' | 'finish'

/** Persisted work intent; at most one in flight per novel (§12.1). */
export interface WorkIntentRecord {
  intentId: string
  kind: WorkIntentKind
  unitId: string | null
  expectedOutlineRevision: string | null
  expectedRequirementSequence: number | null
  hostTurn: number | null
  createdAt: string
}

/**
 * One W0 usage sampling point (0007 §7): audit-grade observation, never an
 * authoritative billing record. toolBytes accumulates output bytes per tool
 * name over one turn; writerOutputChars is the subagent writer's prose size
 * when the unit ran delegated; usage carries host-reported token counters
 * when the runtime exposes them (probe P4, fail-open — observation only).
 * Kept as a bounded ring: the store retains the most recent 50 samples and
 * drops the oldest, so snapshots stay lossless and finite.
 */
export interface NovelUsageSample {
  recordedAt: string
  turn: number
  toolBytes: Record<string, number>
  writerOutputChars?: number
  usage?: Record<string, number>
}

export interface NovelRunState {
  status: NovelStatus
  phase: NovelPhase
  pauseReason: NovelPauseReason | null
  pauseDetail: string | null
  resumeHint: string | null
  currentUnitId: string | null
  turnsRun: number
  deduceRuns: number
  /** Completed writer-subagent delegations (0007 §7): a counter aligned with
   *  deduceRuns but deliberately uncapped — hard budget edges stay with
   *  maxTurns/maxDurationMs; NovelRunBudgets gains no new cost limit (the
   *  §5.3 writerDispatchLimit retry parameter aside). */
  writerRuns: number
  startedAt: string | null
  completedAt: string | null
  lastProgressSignature: string | null
  stalledTurns: number
  consecutiveFailures: number
  lastError: string | null
  inFlightIntent: WorkIntentRecord | null
  /** Outline revision pending manual approval (§4.3); null when not awaiting. */
  awaitingApprovalRevision: string | null
  /** Cumulative active milliseconds for the §13 duration budget: pause
   * windows and host downtime never consume it. Absent on legacy snapshots,
   * where the open window falls back to startedAt until the first fold. */
  activeDurationMs?: number
  /** Start of the current active window; null while paused. */
  activeWindowStart?: string | null
  /** Most recent usage samples (0007 §7, W0): audit-only ring, last 50 kept. */
  usageSamples: NovelUsageSample[]
}

/* -------------------------------- assets ------------------------------- */

/** Fixed asset snapshot reference (§5): identity is the content hash, not specVersion. */
export interface NovelAssetRef {
  kind: 'character' | 'world'
  sourceId: string
  displayName: string
  contentHash: string
  specVersion: string | null
}

/* ------------------------------- snapshot ------------------------------ */

/** The full immutable project snapshot referenced by HEAD.json (§10.1). */
export interface NovelSnapshot {
  novelId: string
  /** Global snapshot version; sha256-16hex of the snapshot content (excludes this field). */
  revision: string
  schemaVersion: 1
  createdAt: string
  updatedAt: string
  config: NovelCreateConfig
  assets: readonly NovelAssetRef[]
  outline: NovelOutline | null
  requirements: readonly RequirementRecord[]
  units: readonly WritingUnit[]
  commits: readonly BodyCommit[]
  /** Explicit chapter completions (§6.2); chapters only complete via completeChapter. */
  completedChapters: readonly ChapterCompletion[]
  /** Author meta note editable without touching config semantics (§14.3 right panel). */
  premiseNote: string | null
  run: NovelRunState
  /** Content projection version: only body/chapter display info/canon changes bump it (§14.1). */
  contentRevision: string
  /** Fixed counting policy for effective characters (§7.1). */
  countPolicyVersion: 1
}

export interface NovelSummary {
  novelId: string
  title: string
  status: NovelStatus
  phase: NovelPhase
  pauseReason: NovelPauseReason | null
  chaptersCompleted: number
  chaptersTotal: number
  effectiveCharacters: number
  targetCharacters: number | null
  updatedAt: string
  lastError: string | null
}

/** Pure snapshot -> list row projection (§14.3 novel list). */
export function summarizeNovel(snapshot: NovelSnapshot): NovelSummary {
  return {
    novelId: snapshot.novelId,
    title: snapshot.config.title,
    status: snapshot.run.status,
    phase: snapshot.run.phase,
    pauseReason: snapshot.run.pauseReason,
    chaptersCompleted: snapshot.completedChapters.length,
    chaptersTotal: snapshot.outline?.chapters.length ?? 0,
    effectiveCharacters: totalEffectiveCharacters(snapshot.commits),
    targetCharacters: snapshot.config.lengthBudget.kind === 'target' ? snapshot.config.lengthBudget.targetCharacters : null,
    updatedAt: snapshot.updatedAt,
    lastError: snapshot.run.lastError,
  }
}

/**
 * Program-verifiable finish guards (§7.3): completion is never model-reported.
 * Returns violation descriptions; empty list means finishing is allowed.
 */
export function finishGuardViolations(snapshot: NovelSnapshot): readonly string[] {
  const violations: string[] = []
  const outline = snapshot.outline
  if (outline === null) {
    violations.push('outline-missing')
    return violations
  }
  const completedIds = new Set(snapshot.completedChapters.map((entry) => entry.chapterId))
  for (const chapter of outline.chapters) {
    if (!completedIds.has(chapter.chapterId)) violations.push(`chapters-incomplete:${chapter.chapterId}`)
  }
  for (const item of outline.foreshadowing) {
    if (item.required && item.status !== 'resolved') violations.push(`foreshadowing-unresolved:${item.id}`)
  }
  for (const record of snapshot.requirements) {
    if (record.status === 'pending' || record.status === 'blocked') violations.push(`requirement-unprocessed:${record.requirementId}`)
  }
  for (const unit of snapshot.units) {
    if (unit.state === 'prepared' || unit.state === 'claimed') violations.push(`unit-in-flight:${unit.unitId}`)
  }
  const total = totalEffectiveCharacters(snapshot.commits)
  if (!lengthWithinBudget(total, snapshot.config.lengthBudget)) violations.push(`length-out-of-budget:${total}`)
  return violations
}

/* ------------------------------ canonical ------------------------------ */

/**
 * Deterministic JSON serialization: object keys sorted, no whitespace,
 * undefined-valued keys omitted. Used for all content hashing so revision /
 * content hashes are stable across processes and key insertion order.
 */
export function stableStringify(value: unknown): string {
  return serialize(value)

  function serialize(input: unknown): string {
    if (input === null) return 'null'
    switch (typeof input) {
      case 'string':
        return JSON.stringify(input)
      case 'number':
        return Number.isFinite(input) ? JSON.stringify(input) : 'null'
      case 'boolean':
        return input ? 'true' : 'false'
      case 'object': {
        if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`
        const record = input as Record<string, unknown>
        const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`
      }
      default:
        return 'null'
    }
  }
}

/* -------------------------------- errors ------------------------------- */

/** Base shape for all novel errors: a stable machine-readable code (§13). */
export interface NovelErrorFields {
  readonly code: string
}

export class NovelConfigError extends Error {
  readonly code = 'NOVEL_CONFIG'
  readonly errors: readonly ValidationError[]

  constructor({ message, errors = [] }: { message: string; errors?: readonly ValidationError[] }) {
    super(message)
    this.name = 'NovelConfigError'
    this.errors = errors
  }
}

export class NovelRevisionConflictError extends Error {
  readonly code = 'NOVEL_REVISION_CONFLICT'
  readonly expectedRevision: string
  readonly actualRevision: string | null
  readonly detail: string | null

  constructor({ expected, actual = null, detail = null }: { expected: string; actual?: string | null; detail?: string | null }) {
    super(`Novel revision conflict: expected ${expected}, actual ${actual ?? 'none'}${detail === null ? '' : ` (${detail})`}`)
    this.name = 'NovelRevisionConflictError'
    this.expectedRevision = expected
    this.actualRevision = actual
    this.detail = detail
  }
}

export class NovelStaleUnitError extends Error {
  readonly code = 'NOVEL_STALE_UNIT'
  readonly unitId: string
  readonly attempt: number

  constructor({ unitId, attempt }: { unitId: string; attempt: number }) {
    super(`Stale writing unit '${unitId}' (attempt ${attempt}): the claim was superseded, revoked or already consumed.`)
    this.name = 'NovelStaleUnitError'
    this.unitId = unitId
    this.attempt = attempt
  }
}

export class NovelRequirementConflictError extends Error {
  readonly code = 'NOVEL_REQUIREMENT_CONFLICT'
  readonly requirementId: string
  readonly conflictReason: string
  readonly bodySources: readonly string[]

  constructor({ requirementId, conflictReason, bodySources = [] }: { requirementId: string; conflictReason: string; bodySources?: readonly string[] }) {
    super(`Requirement '${requirementId}' conflicts with committed facts: ${conflictReason}`)
    this.name = 'NovelRequirementConflictError'
    this.requirementId = requirementId
    this.conflictReason = conflictReason
    this.bodySources = bodySources
  }
}

export class NovelDuplicateCommitError extends Error {
  readonly code = 'NOVEL_DUPLICATE_COMMIT'
  readonly unitId: string
  readonly existingCommitId: string

  constructor({ unitId, existingCommitId }: { unitId: string; existingCommitId: string }) {
    super(`Unit '${unitId}' already committed as '${existingCommitId}' with different business content.`)
    this.name = 'NovelDuplicateCommitError'
    this.unitId = unitId
    this.existingCommitId = existingCommitId
  }
}

export class NovelLengthLimitError extends Error {
  readonly code = 'NOVEL_LENGTH_LIMIT'
  readonly current: number
  readonly target: number | null
  readonly hardMaximum: number | null

  constructor({ current, target = null, hardMaximum = null }: { current: number; target?: number | null; hardMaximum?: number | null }) {
    super(`Length limit exceeded: ${current} effective characters (target ${target ?? 'none'}, hard maximum ${hardMaximum ?? 'none'}). The candidate body was not written.`)
    this.name = 'NovelLengthLimitError'
    this.current = current
    this.target = target
    this.hardMaximum = hardMaximum
  }
}

export class NovelOwnershipError extends Error {
  readonly code = 'NOVEL_OWNERSHIP'
  readonly novelId: string
  readonly pid: number | null
  readonly alive: boolean

  constructor({ novelId, pid = null, alive = false, detail }: { novelId: string; pid?: number | null; alive?: boolean; detail: string }) {
    super(`Novel '${novelId}' is owned by pid ${pid ?? 'unknown'} (${alive ? 'running' : 'not running'}): ${detail}`)
    this.name = 'NovelOwnershipError'
    this.novelId = novelId
    this.pid = pid
    this.alive = alive
  }
}

export class NovelCapabilityError extends Error {
  readonly code = 'NOVEL_CAPABILITY'
  readonly reason: string

  constructor({ reason }: { reason: string }) {
    super(`Novel capability error: ${reason}`)
    this.name = 'NovelCapabilityError'
    this.reason = reason
  }
}

export class NovelStorageCorruptionError extends Error {
  readonly code = 'NOVEL_STORAGE_CORRUPTION'
  readonly novelId: string
  readonly path: string
  readonly detail: string

  constructor({ novelId, path, detail }: { novelId: string; path: string; detail: string }) {
    super(`Novel storage corruption in '${novelId}' at ${path}: ${detail}`)
    this.name = 'NovelStorageCorruptionError'
    this.novelId = novelId
    this.path = path
    this.detail = detail
  }
}

export class NovelNotFoundError extends Error {
  readonly code = 'NOVEL_NOT_FOUND'
  readonly novelId: string

  constructor({ novelId }: { novelId: string }) {
    super(`Novel '${novelId}' not found.`)
    this.name = 'NovelNotFoundError'
    this.novelId = novelId
  }
}

/** State-dependent precondition failure with a machine-readable rule id (§13). */
export class NovelPreconditionError extends Error {
  readonly code = 'NOVEL_PRECONDITION'
  readonly rule: string
  readonly violations: readonly string[]

  constructor({ rule, violations = [] }: { rule: string; violations?: readonly string[] }) {
    super(`Novel precondition '${rule}' failed${violations.length === 0 ? '' : `: ${violations.join('; ')}`}`)
    this.name = 'NovelPreconditionError'
    this.rule = rule
    this.violations = violations
  }
}
