/** Novel outline materialization, payload errors and requirement processing (§6.1/§9), extracted from novel.ts. */

import {
  NovelPreconditionError,
  requirementWatermark,
  type HandledRequirement,
  type OutlineChapter,
  type OutlineChapterInput,
  type RequirementRecord,
  type RequirementStatus,
  type ResolvedConflict,
  type ValidationError,
} from './novel-model.js'


/**
 * Materializes a payload chapter overlay into the complete stored chapter
 * list: droppedChapterIds and overlay ids remove/replace their previous
 * entries, omitted optional fields are inherited from the previous entry
 * with the same id, every untouched chapter is carried forward verbatim, and
 * the result is ordered by `order`.
 */
export function materializeOutlineChapters(
  overlay: readonly OutlineChapterInput[],
  previousById: ReadonlyMap<string, OutlineChapter>,
  droppedChapterIds?: readonly string[],
): OutlineChapter[] {
  const overlayById = new Map(overlay.map((chapter) => [chapter.chapterId, chapter]))
  const dropped = new Set(droppedChapterIds ?? [])
  const merged: OutlineChapter[] = []
  for (const chapter of previousById.values()) {
    if (dropped.has(chapter.chapterId) || overlayById.has(chapter.chapterId)) continue
    merged.push(structuredClone(chapter))
  }
  for (const chapter of overlay) {
    const prior = previousById.get(chapter.chapterId)
    merged.push({
      chapterId: chapter.chapterId,
      order: chapter.order,
      title: chapter.title,
      purpose: chapter.purpose,
      keyEvents: [...(chapter.keyEvents ?? prior?.keyEvents ?? [])],
      plannedCharacters: chapter.plannedCharacters ?? prior?.plannedCharacters ?? null,
      entryCondition: chapter.entryCondition,
      exitCondition: chapter.exitCondition,
    })
  }
  return merged.sort((left, right) => left.order - right.order)
}

/**
 * Field-level summary the model can act on. A bare "invalid outline payload"
 * hides which field failed; in the field the model then retried blind and
 * burned the session.
 */
export function outlinePayloadErrorMessage(errors: readonly ValidationError[]): string {
  const render = (error: ValidationError): string => {
    // Several messages already open with the field name; repeating it produced
    // "characters characters must be an array" in the field, which read as a
    // parsing glitch rather than a fixable shape error.
    const text = error.message.startsWith(`${error.field} `) ? error.message.slice(error.field.length + 1) : error.message
    return `${error.field} ${text}`
  }
  return `invalid outline payload: ${errors.map(render).join('; ')}`
}

export function applyHandledRequirements(
  records: readonly RequirementRecord[],
  handled: readonly HandledRequirement[],
  outlineRevision: string,
): RequirementRecord[] {
  const byId = new Map(handled.map((item) => [item.requirementId, item]))
  return records.map((record) => {
    const item = byId.get(record.requirementId)
    if (item === undefined) return record
    if (item.result === 'applied') {
      return { ...record, status: 'applied' as RequirementStatus, appliedRevision: outlineRevision, effectiveLocation: item.effectiveLocation ?? null, blockedReason: null, supersededBy: null, resolvedConflict: resolvedConflictOf(record, item) }
    }
    if (item.result === 'superseded') {
      return { ...record, status: 'superseded' as RequirementStatus, appliedRevision: outlineRevision, supersededBy: item.supersededBy ?? null, blockedReason: null, resolvedConflict: resolvedConflictOf(record, item) }
    }
    return { ...record, status: 'blocked' as RequirementStatus, blockedReason: item.blockedReason ?? 'blocked during outline change', appliedRevision: null, effectiveLocation: null }
  })
}

/**
 * §9.1 (line 215): resolving a blocked requirement to applied/superseded must
 * preserve the original conflict record alongside the clarification/
 * withdrawal citation. blockedReason moves into resolvedConflict.reason (the
 * live field reads null — the requirement is no longer blocked — while the
 * ledger keeps the history). validateHandledRequirements has already proved
 * resolvedBy present whenever this transition occurs, so the fallback only
 * guards a blocked -> blocked re-block, which resolves nothing.
 */
function resolvedConflictOf(record: RequirementRecord, item: HandledRequirement): ResolvedConflict | null {
  if (record.status !== 'blocked' || item.resolvedBy === undefined) return null
  return {
    reason: record.blockedReason ?? 'blocked during outline change',
    resolvedBy: { kind: item.resolvedBy.kind, messageId: item.resolvedBy.messageId },
  }
}

/** Watermark must only advance across a revision (§9.3). */
export function assertWatermarkAdvanced(before: readonly RequirementRecord[], after: readonly RequirementRecord[]): number {
  const beforeMark = requirementWatermark(before)
  const afterMark = requirementWatermark(after)
  if (afterMark < beforeMark) {
    throw new NovelPreconditionError({ rule: 'watermark-regression', violations: [`${beforeMark} -> ${afterMark}`] })
  }
  return afterMark
}
