/**
 * Pure outline decision and brief functions for AgentNovel
 * (docs/proposals/0005-agent-novel-architecture.md §6.3, §7.2, §8.3).
 *
 * No IO lives here: every input is a readonly snapshot from tavern-store.
 * The W3 driver depends on these exact export names.
 */

import {
  requirementWatermark,
  totalEffectiveCharacters,
  type NovelCreateConfig,
  type NovelSnapshot,
  type ScenePlan,
} from '../../../tavern-store/src/index.js'

/** Closed work union (§12.1); each kind only unlocks its matching write tools. */
export interface NovelWork {
  kind: 'outline-create' | 'outline-revise' | 'write-unit' | 'chapter-complete' | 'finish'
  chapterId: string | null
  sceneId: string | null
  reason: string
}

/** Ordered scenes of the current chapter (§6.1: scenes are the current-chapter detail layer). */
function scenesByOrder(snapshot: NovelSnapshot): ScenePlan[] {
  const outline = snapshot.outline
  if (outline === null) return []
  return [...outline.scenes].sort((left, right) => left.order - right.order)
}

/**
 * Picks the next work item (§6.3 decision order):
 * 1. no outline -> outline-create;
 * 2. unprocessed requirements (pending or blocked, §9.1 watermark) or a current
 *    chapter without executable scenes -> outline-revise;
 * 3. first unfinished scene of the current chapter (lowest order) -> write-unit;
 * 4. all current-chapter scenes finished but the chapter not completed -> chapter-complete;
 * 5. every chapter completed -> finish;
 * 6. completed run -> null.
 *
 * A scene counts as finished only when its latest body commit declared
 * sceneCompletion.completed (§6.3); continuation fragments never finish a scene.
 */
export function nextWork(snapshot: NovelSnapshot): NovelWork | null {
  if (snapshot.run.status === 'completed') return null
  const outline = snapshot.outline
  if (outline === null) {
    return {
      kind: 'outline-create',
      chapterId: null,
      sceneId: null,
      reason: 'no outline exists yet; create the initial plan from the creation requirement (§6.3)',
    }
  }
  const unprocessed = snapshot.requirements.filter((record) => record.status === 'pending' || record.status === 'blocked')
  if (unprocessed.length > 0) {
    return {
      kind: 'outline-revise',
      chapterId: null,
      sceneId: null,
      reason: `requirements: ${unprocessed.map((record) => `${record.requirementId}(${record.status})`).join(', ')} must be handled through a revision before writing continues (§9.2)`,
    }
  }
  const currentChapterId = outline.currentChapterId
  if (currentChapterId === null) {
    return {
      kind: 'outline-revise',
      chapterId: null,
      sceneId: null,
      reason: 'refine: no current chapter is selected; set currentChapterId and prepare ordered scenes (§6.3)',
    }
  }
  const scenes = scenesByOrder(snapshot)
  if (scenes.length === 0) {
    return {
      kind: 'outline-revise',
      chapterId: currentChapterId,
      sceneId: null,
      reason: `refine: chapter ${currentChapterId} has no executable scene plan; add ordered scenes (§6.3)`,
    }
  }
  const unfinished = scenes.find((scene) => !sceneFinished(snapshot, scene.sceneId))
  if (unfinished !== undefined) {
    return {
      kind: 'write-unit',
      chapterId: currentChapterId,
      sceneId: unfinished.sceneId,
      reason: `scene ${unfinished.sceneId} is the first unfinished scene of chapter ${currentChapterId} by scene order (§6.3)`,
    }
  }
  if (!snapshot.completedChapters.some((entry) => entry.chapterId === currentChapterId)) {
    return {
      kind: 'chapter-complete',
      chapterId: currentChapterId,
      sceneId: null,
      reason: `all scenes of chapter ${currentChapterId} declared complete; run the chapter completion check (§6.3)`,
    }
  }
  if (outline.chapters.every((chapter) => snapshot.completedChapters.some((entry) => entry.chapterId === chapter.chapterId))) {
    return {
      kind: 'finish',
      chapterId: null,
      sceneId: null,
      reason: 'all chapters completed; run the full completion checks (§7.3)',
    }
  }
  return {
    kind: 'outline-revise',
    chapterId: null,
    sceneId: null,
    reason: `chapter ${currentChapterId} is complete; refine the plan to select and detail the next chapter (§6.3)`,
  }
}

/** Latest commit for a scene wins; no commit at all means unfinished (§6.3). */
function sceneFinished(snapshot: NovelSnapshot, sceneId: string): boolean {
  const sceneOfUnit = new Map(snapshot.units.map((unit) => [unit.unitId, unit.sceneId]))
  for (let index = snapshot.commits.length - 1; index >= 0; index -= 1) {
    const commit = snapshot.commits[index]!
    if (sceneOfUnit.get(commit.unitId) === sceneId) return commit.sceneCompleted
  }
  return false
}

/**
 * Effective-character target range for the next unit (§7.2): the slice of the
 * tolerance band [target*(1-tolerance), hardMax or target*(1+tolerance)] that
 * remains above the committed total. Unbounded budgets put no length pressure
 * on a unit (finite run budgets still apply, §7.1); min is clamped at 0.
 */
export function unitTargetRange(config: NovelCreateConfig, committed: number): { min: number; max: number } {
  const budget = config.lengthBudget
  if (budget.kind === 'unbounded') return { min: 0, max: Number.MAX_SAFE_INTEGER }
  const lower = budget.targetCharacters * (1 - budget.toleranceRatio)
  const upper = budget.hardMaximumCharacters ?? budget.targetCharacters * (1 + budget.toleranceRatio)
  const min = Math.max(0, Math.floor(lower - committed))
  const max = Math.max(min, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(upper - committed)))
  return { min, max }
}

/**
 * Narrative pacing stage (§7.2): by committed/target ratio, switching to
 * 'ending' once the total enters the acceptable finishing window
 * [target*(1-tolerance), ...]. Unbounded budgets have no convergence point,
 * so they never reach 'late'/'ending': nothing written reads as 'early',
 * anything written reads as 'middle'.
 */
export function narrativeStage(config: NovelCreateConfig, committed: number): 'early' | 'middle' | 'late' | 'ending' {
  const budget = config.lengthBudget
  if (budget.kind === 'unbounded') return committed === 0 ? 'early' : 'middle'
  if (committed >= budget.targetCharacters * (1 - budget.toleranceRatio)) return 'ending'
  const ratio = committed / budget.targetCharacters
  if (ratio >= 2 / 3) return 'late'
  if (ratio >= 1 / 3) return 'middle'
  return 'early'
}

/** Freshest continuation anchor known for a scene: unit anchors beat the static scene plan (§6.3). */
function anchorFor(snapshot: NovelSnapshot, sceneId: string | null): string | null {
  if (sceneId === null) return null
  const units = snapshot.units.filter((unit) => unit.sceneId === sceneId)
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const anchor = units[index]!.continuationAnchor
    if (anchor !== null) return anchor
  }
  return snapshot.outline?.scenes.find((scene) => scene.sceneId === sceneId)?.continuationAnchor ?? null
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Union of every scene's participants across the whole outline (0007 §4.2 /
 * §14 deviation 3): ScenePlan carries no chapter binding, so per-chapter
 * filtering is impossible — this is the honest shape behind the writer pack's
 * character pages, the canon filter and the outline digest. Outline
 * declaration order via Set insertion.
 */
export function allParticipantsOf(outline: NonNullable<NovelSnapshot['outline']>): Set<string> {
  const participants = new Set<string>()
  for (const scene of outline.scenes) {
    for (const participant of scene.participants) participants.add(participant)
  }
  return participants
}

/* ---------------- outline digest bounds (0007 §11, Task D) ---------------- */

/** 摘要块上限：紧凑性质优先——总增量目标 ≤1k 字符（最坏情况 ~1.3k）。 */
export const BRIEF_STORY_LIMIT = 200
export const BRIEF_CONDITION_LIMIT = 160
export const BRIEF_PARTICIPANT_LIMIT = 120
export const BRIEF_PARTICIPANTS_MAX = 6

/**
 * 大纲摘要（0007 §11，inline 模式同享）：story 一句话 + 当前章进出条件 +
 * 参与者简介。纯快照投影（identitySummary 需异步资产解析，纯函数取
 * outline.characters 的 initialState/motivation 作简介），有界、空字段省略。
 * 参与者取全书场景 participants 的并集（ScenePlan 无章绑定，outline 声明序），
 * 与写手包角色页同口径，同一章连续单元间字节稳定。
 */
function pushOutlineDigest(lines: string[], snapshot: NovelSnapshot, chapterId: string | null): void {
  const outline = snapshot.outline
  if (outline === null) return
  const story = [outline.story.premise, outline.story.mainConflict].filter((part) => part.trim() !== '')
  const chapter = chapterId === null ? undefined : outline.chapters.find((candidate) => candidate.chapterId === chapterId)
  const participants = allParticipantsOf(outline)
  const intros = [...participants].slice(0, BRIEF_PARTICIPANTS_MAX).map((participant) => {
    const character = outline.characters.find((candidate) => candidate.characterId === participant || candidate.name === participant)
    if (character === undefined) return participant
    const summary = [character.initialState, character.motivation].filter((part) => part.trim() !== '').join(' · ')
    return summary === '' ? `${character.name} (${character.characterId})` : `${character.name} (${character.characterId}): ${truncateText(summary, BRIEF_PARTICIPANT_LIMIT)}`
  })
  const digest: string[] = []
  if (story.length > 0) digest.push(`- story: ${truncateText(story.join(' — '), BRIEF_STORY_LIMIT)}`)
  if (chapter !== undefined) {
    if (chapter.entryCondition.trim() !== '') digest.push(`- chapter entry: ${truncateText(chapter.entryCondition, BRIEF_CONDITION_LIMIT)}`)
    if (chapter.exitCondition.trim() !== '') digest.push(`- chapter exit: ${truncateText(chapter.exitCondition, BRIEF_CONDITION_LIMIT)}`)
  }
  for (const intro of intros) digest.push(`- participant: ${intro}`)
  if (digest.length === 0) return // 全空字段：整块省略，不输出裸标题
  lines.push('', 'Outline digest (§6.1):', ...digest)
}

/**
 * Renders the work brief (§8.3 variable tail): goal, scene plan, continuation
 * anchor, unit target range, remaining book budget, narrative stage, pending
 * directive excerpts and a lore lookup hint. World entries are never inlined
 * (§11: the model must use novel_lore_search).
 */
export function renderWorkBrief(snapshot: NovelSnapshot, work: NovelWork): string {
  const committed = totalEffectiveCharacters(snapshot.commits)
  const budget = snapshot.config.lengthBudget
  const stage = narrativeStage(snapshot.config, committed)
  const range = unitTargetRange(snapshot.config, committed)
  const lines: string[] = [
    `Novel work brief — ${snapshot.config.title} (${snapshot.novelId})`,
    `Work: ${work.kind}${work.chapterId === null ? '' : ` · chapter ${work.chapterId}`}${work.sceneId === null ? '' : ` · scene ${work.sceneId}`}`,
    `Reason: ${work.reason}`,
  ]

  if (work.kind === 'write-unit') {
    pushOutlineDigest(lines, snapshot, work.chapterId)
    const scene = snapshot.outline?.scenes.find((candidate) => candidate.sceneId === work.sceneId)
    if (scene !== undefined) {
      lines.push('', 'Scene plan (§6.1 current-chapter detail):')
      lines.push(`- goal: ${scene.goal}`)
      lines.push(`- participants: ${scene.participants.join(', ')}`)
      lines.push(`- time/location: ${scene.timeLocation}`)
      lines.push(`- causality: ${scene.causality}`)
      lines.push(`- conflict: ${scene.conflict}`)
      lines.push(`- expected change: ${scene.expectedChange}`)
    }
    const anchor = anchorFor(snapshot, work.sceneId)
    if (anchor !== null) lines.push(`- continuation anchor: ${anchor}`)
  }

  lines.push('', 'Length (§7.2):')
  lines.push(budget.kind === 'unbounded'
    ? '- unit target: unbounded (finite run budgets still apply, §7.1)'
    : `- unit target range: ${range.min}-${range.max} effective characters`)
  if (budget.kind === 'target') {
    lines.push(`- committed ${committed} of target ${budget.targetCharacters} (tolerance ${budget.toleranceRatio}${budget.hardMaximumCharacters === null ? '' : `, hard max ${budget.hardMaximumCharacters}`})`)
  }
  lines.push(`- narrative stage: ${stage}${stage === 'late' || stage === 'ending' ? ' — reduce new subplots and prioritize convergence (§7.2)' : ''}`)

  const pending = snapshot.requirements.filter((record) => record.status === 'pending').slice(0, 5)
  if (pending.length === 0) {
    lines.push('', 'Pending author directives: none.')
  } else {
    lines.push('', 'Pending author directives (verbatim, first 5, each capped at 200 characters) (§9):')
    for (const record of pending) lines.push(`- [${record.requirementId}] ${truncateText(record.text, 200)}`)
  }

  lines.push('', 'Relevant lore: use novel_lore_search over the project world snapshots for setting details; entries are not inlined here (§11).')
  lines.push(`Versions: outline ${snapshot.outline?.outlineRevision ?? 'none'}, requirement watermark ${requirementWatermark(snapshot.requirements)}.`)
  lines.push(`Run budget: ${snapshot.run.turnsRun}/${snapshot.config.budgets.maxTurns} turns.`)
  return lines.join('\n')
}
