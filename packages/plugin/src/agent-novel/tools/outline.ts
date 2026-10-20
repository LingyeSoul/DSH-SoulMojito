/** AgentNovel status/requirements/outline tool slice (registration order 1-6). */

import {
  effectiveNovelCharacters,
  importProgressOf,
  requirementWatermark,
  type HandledRequirement,
  type NovelOutlineChanges,
  type NovelOutlinePayload,
} from '../../../../tavern-store/src/index.js'
import { clampInt, limitText, stringArg } from '../../tool-args.js'
import { recordProbeAgentId } from '../usage.js'
import { authorBindingFor, novelBindingFor, objectOutput, pageCursor, snapshotOf, tool, type ToolDefinition } from './shared.js'
import { novelStore } from './stores.js'


export function outlineTools(): ToolDefinition[] {
  return [
    tool('novel_status_read', 'Read the novel run state: status, phase, pause reason, current unit, outline revision, requirement watermark, budgets and length progress. No parameters; the novel identity comes from the session binding.', {}, statusOutput, async (_args, exec) => {
      // P1 探针记录槽（0007 §9，Task D）：无条件 best-effort 覆盖写本次执行
      // 身份，drain 后即空——正常路径零行为影响（见 usage.ts 模块头）。
      recordProbeAgentId(exec.agent?.id)
      const novelId = await novelBindingFor(exec)
      const snapshot = await snapshotOf(novelId)
      const budget = snapshot.config.lengthBudget
      const committed = effectiveNovelCharacters(snapshot)
      const upper = budget.kind === 'target'
        ? budget.hardMaximumCharacters ?? budget.targetCharacters * (1 + budget.toleranceRatio)
        : null
      return {
        novelId,
        status: snapshot.run.status,
        phase: snapshot.run.phase,
        ...(snapshot.run.pauseReason !== null ? { pauseReason: snapshot.run.pauseReason } : {}),
        ...(snapshot.run.pauseDetail !== null ? { pauseDetail: snapshot.run.pauseDetail } : {}),
        ...(snapshot.run.currentUnitId !== null ? { currentUnitId: snapshot.run.currentUnitId } : {}),
        ...(snapshot.outline !== null ? { outlineRevision: snapshot.outline.outlineRevision } : {}),
        revision: snapshot.revision,
        watermark: requirementWatermark(snapshot.requirements),
        pendingRequirements: snapshot.requirements.filter((record) => record.status === 'pending').length,
        blockedRequirements: snapshot.requirements.filter((record) => record.status === 'blocked').length,
        chaptersCompleted: snapshot.completedChapters.length,
        chaptersTotal: snapshot.outline?.chapters.length ?? 0,
        committedCharacters: committed,
        lengthBudget: budget.kind === 'unbounded'
          ? { kind: 'unbounded' }
          : {
              kind: 'target',
              targetCharacters: budget.targetCharacters,
              toleranceRatio: budget.toleranceRatio,
              ...(budget.hardMaximumCharacters !== null ? { hardMaximumCharacters: budget.hardMaximumCharacters } : {}),
            },
        ...(upper !== null ? { remainingCharacters: Math.max(0, Math.ceil(upper - committed)) } : {}),
        turnsRun: snapshot.run.turnsRun,
        maxTurns: snapshot.config.budgets.maxTurns,
        ...(snapshot.import !== null && snapshot.import !== undefined
          ? {
              import: {
                sourceName: snapshot.import.sourceName,
                sourceFormat: snapshot.import.sourceFormat,
                ...importProgressOf(snapshot.import),
                bibleRevision: snapshot.import.bibleSummary?.bibleRevision ?? null,
              },
            }
          : {}),
        source: { kind: 'novel-status', id: novelId, revision: snapshot.revision },
        truncated: false,
      }
    }),
    tool('novel_requirements_read', 'Read the author directive ledger (§9.1) with statuses, effective locations, block reasons and supersession, paginated.', {
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous page; omit for the first page.' },
      limit: { type: 'integer', description: 'Page size, capped at 50. Default 20.' },
    }, requirementsReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const snapshot = await snapshotOf(novelId)
      const cursor = pageCursor(args.cursor)
      const limit = clampInt(args.limit, 1, 50, 20)
      const ordered = [...snapshot.requirements].sort((left, right) => left.sequence - right.sequence)
      const page = ordered.slice(cursor, cursor + limit)
      const nextCursor = cursor + page.length < ordered.length ? String(cursor + page.length) : null
      return {
        requirements: page.map((record) => ({
          requirementId: record.requirementId,
          sequence: record.sequence,
          hostMessageId: record.hostMessageId,
          text: limitText(record.text, 4000),
          status: record.status,
          receivedAt: record.receivedAt,
          ...(record.appliedRevision !== null ? { appliedRevision: record.appliedRevision } : {}),
          ...(record.effectiveLocation !== null ? { effectiveLocation: record.effectiveLocation } : {}),
          ...(record.blockedReason !== null ? { blockedReason: record.blockedReason } : {}),
          ...(record.supersededBy !== null ? { supersededBy: record.supersededBy } : {}),
          // §9.1: the preserved conflict record of a resolved blocked directive
          // (cited clarification/withdrawal + original reason). `?? null`
          // amnesties legacy snapshots created before the field existed.
          ...((record.resolvedConflict ?? null) !== null ? { resolvedConflict: record.resolvedConflict } : {}),
        })),
        ...(nextCursor !== null ? { nextCursor } : {}),
        sourceCount: page.length,
        source: { kind: 'novel-requirements', id: novelId, revision: snapshot.revision },
        truncated: nextCursor !== null || page.some((record) => record.text.length > 4000),
      }
    }),
    tool('novel_outline_read', 'Read the current outline plan: story, characters, a bounded window of chapters, the current chapter scenes, foreshadowing and the project asset references (§6/§11).', {
      chapterFrom: { type: 'integer', description: 'Only chapters with order >= this value; default 1.' },
      chapterCount: { type: 'integer', description: 'Chapter window size, capped at 30. Default 10.' },
    }, outlineReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const snapshot = await snapshotOf(novelId)
      const outline = snapshot.outline
      if (outline === null) throw new Error('novel has no outline yet; create it with novel_outline_create first (§6.3)')
      const chapters = [...outline.chapters].sort((left, right) => left.order - right.order)
      const from = clampInt(args.chapterFrom, 1, Number.MAX_SAFE_INTEGER, 1)
      const count = clampInt(args.chapterCount, 1, 30, 10)
      const visible = chapters.filter((chapter) => chapter.order >= from)
      const selected = visible.slice(0, count)
      return {
        outlineRevision: outline.outlineRevision,
        ...(outline.parentRevision !== null ? { parentRevision: outline.parentRevision } : {}),
        reason: outline.reason,
        story: outline.story,
        characters: outline.characters.map((character) => ({
          characterId: character.characterId,
          name: character.name,
          ...(character.assetRef !== undefined ? { assetRef: character.assetRef } : {}),
          initialState: character.initialState,
          motivation: character.motivation,
          relations: [...character.relations],
          arc: character.arc,
        })),
        chapters: selected.map((chapter) => ({
          chapterId: chapter.chapterId,
          order: chapter.order,
          title: chapter.title,
          purpose: chapter.purpose,
          keyEvents: [...chapter.keyEvents],
          plannedCharacters: chapter.plannedCharacters,
          entryCondition: chapter.entryCondition,
          exitCondition: chapter.exitCondition,
        })),
        ...(outline.currentChapterId !== null ? { currentChapterId: outline.currentChapterId } : {}),
        scenes: outline.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          order: scene.order,
          goal: scene.goal,
          participants: [...scene.participants],
          timeLocation: scene.timeLocation,
          causality: scene.causality,
          conflict: scene.conflict,
          expectedChange: scene.expectedChange,
          ...(scene.continuationAnchor !== undefined ? { continuationAnchor: scene.continuationAnchor } : {}),
        })),
        foreshadowing: outline.foreshadowing.map((item) => ({
          id: item.id,
          description: item.description,
          plantAt: item.plantAt,
          payoffAt: item.payoffAt,
          required: item.required,
          status: item.status,
        })),
        assets: snapshot.assets.map((asset) => ({
          kind: asset.kind,
          sourceId: asset.sourceId,
          displayName: asset.displayName,
          contentHash: asset.contentHash,
          ...(asset.specVersion !== null ? { specVersion: asset.specVersion } : {}),
        })),
        chaptersTotal: chapters.length,
        truncated: visible.length > selected.length,
        source: { kind: 'novel-outline', id: novelId, revision: snapshot.revision },
      }
    }),
    tool('novel_outline_create', 'Create the initial outline and process the first requirement batch (§4.3/§6.3). Only succeeds while no outline exists; conflicts surface the store error. story and the full chapter plan are required; characters, scenes and foreshadowing may be omitted and default to none.', {
      expectedRevision: { type: 'string', required: true, description: 'Snapshot revision you read via novel_status_read.' },
      outline: { ...outlineCreateParameter, required: true },
      handledRequirements: { ...handledRequirementsParameter, description: 'Processing results for the pending requirements; the creation requirement must be handled here. May be omitted only when nothing is handled.' },
    }, outlineWriteOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const result = await (await novelStore()).createOutline(novelId, {
        expectedRevision: stringArg(args.expectedRevision),
        outline: normalizeOutlinePayload(args.outline, 'create'),
        handledRequirements: handledRequirementsArg(args.handledRequirements),
      })
      return { outlineRevision: result.outlineRevision, revision: result.revision, watermark: result.watermark, source: { kind: 'novel-outline-create', id: novelId } }
    }),
    tool('novel_outline_revise', 'Atomically revise the plan and the handled directive results (§9.3). Never touches committed prose; rejected while a unit is claimed. changes is an overlay across every layer: send only what changes — omitted layers (story, characters, scenes, foreshadowing, currentChapterId, chapters) are carried forward unchanged; a layer you do send replaces wholesale ([] clears it); chapter entries upsert by chapterId and droppedChapterIds removes explicitly.', {
      expectedRevision: { type: 'string', required: true, description: 'Snapshot revision you read via novel_status_read.' },
      expectedOutlineRevision: { type: 'string', required: true, description: 'Outline revision this revision is based on.' },
      reason: { type: 'string', required: true, description: 'Why the plan changes; cite the directive ids or planning reason.' },
      changes: { ...outlineReviseParameter, required: true },
      handledRequirements: { ...handledRequirementsParameter, description: 'Per-directive results for the pending contiguous prefix. May be omitted only when nothing is handled.' },
    }, outlineWriteOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const result = await (await novelStore()).reviseOutline(novelId, {
        expectedRevision: stringArg(args.expectedRevision),
        expectedOutlineRevision: stringArg(args.expectedOutlineRevision),
        reason: stringArg(args.reason),
        changes: normalizeOutlinePayload(args.changes, 'revise'),
        handledRequirements: handledRequirementsArg(args.handledRequirements),
      })
      return { outlineRevision: result.outlineRevision, revision: result.revision, watermark: result.watermark, source: { kind: 'novel-outline-revise', id: novelId } }
    }),
    tool('novel_requirement_block', 'Mark a directive as blocked against committed facts and pause the novel (§9.4). Cite the exact body sources of the conflict.', {
      expectedRevision: { type: 'string', required: true },
      requirementId: { type: 'string', required: true },
      conflictReason: { type: 'string', required: true, description: 'Why the directive contradicts committed facts.' },
      bodySources: { type: 'array', items: { type: 'string' }, description: "Conflicting paragraphs as commit-<n>#<index> references; may be omitted or empty." },
    }, blockOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      if (args.bodySources !== undefined && (!Array.isArray(args.bodySources) || args.bodySources.some((source) => typeof source !== 'string'))) {
        throw new Error('bodySources must be an array of strings')
      }
      const result = await (await novelStore()).blockRequirement(novelId, {
        expectedRevision: stringArg(args.expectedRevision),
        requirementId: stringArg(args.requirementId),
        conflictReason: stringArg(args.conflictReason),
        bodySources: args.bodySources ?? [],
      })
      return { revision: result.revision, source: { kind: 'novel-requirement-block', id: novelId } }
    }),
  ]
}

/* --------------------------- parameter schemas --------------------------- */

/* Shared layer schemas (§6.1). On create every layer is part of the initial
 * plan (the tool layer defaults omitted empty collections); on revise every
 * layer is an overlay — omitted layers are carried forward, a present layer
 * replaces wholesale and an explicit [] clears it (2026-10-09). */
const outlineLayerProperties: Record<string, unknown> = {
  story: {
    type: 'object', additionalProperties: false,
    description: 'Story layer; may be omitted on revise (carried forward unchanged).',
    properties: {
      premise: { type: 'string' }, theme: { type: 'string' }, mainConflict: { type: 'string' },
      endingDirection: { type: 'string' },
      taboos: { type: 'array', items: { type: 'string' }, description: 'May be omitted; defaults to no taboos.' },
    },
    required: ['premise', 'theme', 'mainConflict', 'endingDirection'],
  },
  characters: {
    type: 'array',
    description: 'Character layer; replaces wholesale when present ([] clears). May be omitted on create (defaults to none) and on revise (carried forward unchanged).',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        characterId: { type: 'string', description: 'Stable id matching [A-Za-z0-9][A-Za-z0-9_-]{0,63} (§5).' },
        name: { type: 'string' },
        assetRef: { type: 'string', description: 'contentHash of a project character asset from novel_outline_read assets (§5).' },
        initialState: { type: 'string' }, motivation: { type: 'string' },
        relations: { type: 'array', items: { type: 'string' }, description: 'May be omitted; defaults to no relations.' },
        arc: { type: 'string' },
      },
      required: ['characterId', 'name', 'initialState', 'motivation', 'arc'],
    },
  },
  chapters: {
    type: 'array',
    description: 'Chapter overlay (revise) / complete plan (create): send every chapter you are adding or rewriting in full; chapters you leave out are carried forward unchanged, so never page or echo the whole plan just to advance the current chapter. Removal happens only via droppedChapterIds.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        chapterId: { type: 'string' }, order: { type: 'integer' }, title: { type: 'string' }, purpose: { type: 'string' },
        keyEvents: { type: 'array', items: { type: 'string' }, description: 'May be omitted: inherited from the existing chapter of the same id on revise, none for new chapters; send [] to clear.' },
        plannedCharacters: { type: ['integer', 'null'], description: 'Planned effective characters, null when unplanned; may be omitted (inherited on revise, null otherwise).' },
        entryCondition: { type: 'string' }, exitCondition: { type: 'string' },
      },
      required: ['chapterId', 'order', 'title', 'purpose', 'entryCondition', 'exitCondition'],
    },
  },
  droppedChapterIds: {
    type: 'array',
    description: 'chapterIds intentionally removed from the plan (revise only). They must exist and carry no committed prose; omit the field when nothing is removed.',
    items: { type: 'string' },
  },
  currentChapterId: { type: ['string', 'null'], description: 'chapterId of the current chapter; null only when chapters is empty. May be omitted on revise (carried forward).' },
  scenes: {
    type: 'array', description: 'Ordered scene plans of the current chapter (§6.1 detail layer); replaces wholesale when present ([] clears). May be omitted on create (defaults to none) and on revise (carried forward unchanged — send the new chapter\'s scenes when advancing).',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        sceneId: { type: 'string' }, order: { type: 'integer' }, goal: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' }, description: 'May be omitted; defaults to no participants.' },
        timeLocation: { type: 'string' },
        causality: { type: 'string' }, conflict: { type: 'string' }, expectedChange: { type: 'string' },
        continuationAnchor: { type: 'string' },
      },
      required: ['sceneId', 'order', 'goal', 'timeLocation', 'causality', 'conflict', 'expectedChange'],
    },
  },
  foreshadowing: {
    type: 'array',
    description: 'Foreshadowing ledger; replaces wholesale when present ([] clears). May be omitted on create (defaults to none) and on revise (carried forward unchanged).',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, description: { type: 'string' },
        plantAt: { type: ['string', 'null'], description: 'May be omitted or null when unplanned.' },
        payoffAt: { type: ['string', 'null'], description: 'May be omitted or null when unplanned.' },
        required: { type: 'boolean' }, status: { type: 'string', enum: ['open', 'planted', 'resolved'] },
      },
      required: ['id', 'description', 'required', 'status'],
    },
  },
}

/* No nested `required` key here: compileParameters consumes the top-level
 * descriptor's `required` as the tool-layer required flag (the spread at the
 * use site would clobber any JSON-schema required list), so layer requirements
 * live in the description and are enforced by the store validator. */
const outlineCreateParameter: Record<string, unknown> = {
  type: 'object',
  description: 'Full initial outline payload (§6.1): story and the complete chapter plan are required; characters, current-chapter scenes and foreshadowing may be omitted and default to none.',
  additionalProperties: false,
  properties: outlineLayerProperties,
}

const outlineReviseParameter: Record<string, unknown> = {
  type: 'object',
  description: 'Outline overlay (§6.1): every layer may be omitted — omitted layers are carried forward unchanged. Send a layer only to replace it wholesale ([] clears it); chapter entries upsert by chapterId, and droppedChapterIds removes chapters explicitly.',
  additionalProperties: false,
  properties: outlineLayerProperties,
}

const handledRequirementsParameter: Record<string, unknown> = {
  type: 'array',
  description: 'Directive processing results submitted with this outline change (§9.3); the contiguous pending prefix must advance.',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      requirementId: { type: 'string' },
      result: { type: 'string', enum: ['applied', 'superseded', 'blocked'] },
      effectiveLocation: { type: 'string' }, blockedReason: { type: 'string' }, supersededBy: { type: 'string' },
      resolvedBy: {
        type: 'object',
        description: 'Required exactly when this entry resolves a BLOCKED directive to applied/superseded (§9.1): cite the user clarification or withdrawal message. messageId is the hostMessageId of that message as listed by novel_requirements_read; unknown ids are rejected.',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['clarification', 'withdrawal'], description: 'clarification = the user restated the intent; withdrawal = the user explicitly dropped it.' },
          messageId: { type: 'string', description: 'hostMessageId of the clarification/withdrawal directive.' },
        },
        required: ['kind', 'messageId'],
      },
    },
    required: ['requirementId', 'result'],
  },
}

/* ------------------------------ output schemas ------------------------------ */

const statusOutput = objectOutput({
  novelId: { type: 'string' }, status: { type: 'string' }, phase: { type: 'string' },
  pauseReason: { type: 'string' }, pauseDetail: { type: 'string' }, currentUnitId: { type: 'string' },
  outlineRevision: { type: 'string' }, revision: { type: 'string' }, watermark: { type: 'integer' },
  pendingRequirements: { type: 'integer' }, blockedRequirements: { type: 'integer' },
  chaptersCompleted: { type: 'integer' }, chaptersTotal: { type: 'integer' },
  committedCharacters: { type: 'integer' }, lengthBudget: { type: 'object', additionalProperties: true },
  remainingCharacters: { type: 'integer' }, turnsRun: { type: 'integer' }, maxTurns: { type: 'integer' },
  import: { type: 'object', additionalProperties: true },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['pauseReason', 'pauseDetail', 'currentUnitId', 'outlineRevision', 'remainingCharacters', 'import'])
const requirementsReadOutput = objectOutput({
  requirements: { type: 'array', items: { type: 'object', additionalProperties: true } },
  nextCursor: { type: 'string' }, sourceCount: { type: 'integer' },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['nextCursor'])
const outlineReadOutput = objectOutput({
  outlineRevision: { type: 'string' }, parentRevision: { type: 'string' }, reason: { type: 'string' },
  story: { type: 'object', additionalProperties: true },
  characters: { type: 'array', items: { type: 'object', additionalProperties: true } },
  chapters: { type: 'array', items: { type: 'object', additionalProperties: true } },
  currentChapterId: { type: 'string' },
  scenes: { type: 'array', items: { type: 'object', additionalProperties: true } },
  foreshadowing: { type: 'array', items: { type: 'object', additionalProperties: true } },
  assets: { type: 'array', items: { type: 'object', additionalProperties: true } },
  chaptersTotal: { type: 'integer' },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['parentRevision', 'currentChapterId'])
const outlineWriteOutput = objectOutput({
  outlineRevision: { type: 'string' }, revision: { type: 'string' }, watermark: { type: 'integer' },
  source: { type: 'object', additionalProperties: true },
})
const blockOutput = objectOutput({ revision: { type: 'string' }, source: { type: 'object', additionalProperties: true } })
function handledRequirementsArg(value: unknown): HandledRequirement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('handledRequirements must be an array (§10.4)')
  return value as HandledRequirement[]
}

/* ------------------------- argument tolerance (§11) ------------------------- */

/** Fills omitted empty-meaning fields of an outline payload; anything the
 * model did send passes through untouched so the store reports real shape
 * errors instead of the normalizer silently masking them. Chapter
 * keyEvents/plannedCharacters stay omitted on purpose: the store inherits
 * them from the existing chapter on revise (§6.1 overlay semantics).
 * 'create' defaults the optional collections (characters, scenes,
 * foreshadowing) to [] — on create absence has exactly one empty meaning,
 * while on revise absence means carry-forward (§6.1 overlay, 2026-10-09) and
 * must pass through to the store untouched. */
function normalizeOutlinePayload(value: unknown, mode: 'create' | 'revise'): NovelOutlinePayload | NovelOutlineChanges {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value as NovelOutlinePayload
  const outline = { ...(value as Record<string, unknown>) }
  if (mode === 'create') {
    if (outline.characters === undefined) outline.characters = []
    if (outline.scenes === undefined) outline.scenes = []
    if (outline.foreshadowing === undefined) outline.foreshadowing = []
  }
  if (isJsonObject(outline.story)) {
    const story = { ...(outline.story as Record<string, unknown>) }
    if (story.taboos === undefined) story.taboos = []
    outline.story = story
  }
  if (Array.isArray(outline.characters)) {
    outline.characters = (outline.characters as unknown[]).map((entry) => {
      if (!isJsonObject(entry)) return entry
      const character = { ...(entry as Record<string, unknown>) }
      if (character.relations === undefined) character.relations = []
      return character
    })
  }
  if (Array.isArray(outline.scenes)) {
    outline.scenes = (outline.scenes as unknown[]).map((entry) => {
      if (!isJsonObject(entry)) return entry
      const scene = { ...(entry as Record<string, unknown>) }
      if (scene.participants === undefined) scene.participants = []
      return scene
    })
  }
  if (Array.isArray(outline.foreshadowing)) {
    outline.foreshadowing = (outline.foreshadowing as unknown[]).map((entry) => {
      if (!isJsonObject(entry)) return entry
      const item = { ...(entry as Record<string, unknown>) }
      if (item.plantAt === undefined) item.plantAt = null
      if (item.payoffAt === undefined) item.payoffAt = null
      return item
    })
  }
  return outline as unknown as NovelOutlinePayload | NovelOutlineChanges
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
