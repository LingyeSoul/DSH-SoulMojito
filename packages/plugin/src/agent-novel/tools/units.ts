/** AgentNovel writing-unit claim/release/supersede tool slice (registration order 7-9). */

import { effectiveNovelCharacters } from '../../../../tavern-store/src/index.js'
import { stringArg } from '../../tool-args.js'
import { narrativeStage, unitTargetRange } from '../outline.js'
import { objectOutput, resolveNovelBinding, snapshotOf, tool, type ToolDefinition } from './shared.js'
import { novelStore } from './stores.js'


export function unitTools(): ToolDefinition[] {
  return [
    tool('novel_unit_claim', 'Claim a prepared writing unit (§6.2/§12.1): validates the outline revision and requirement watermark, then returns the execution token, the unit goal, the continuation anchor and the unit length target range. Turn accounting happens on the session turn/end events in the scheduler; the host turn identity is NOT recorded on the claim itself (deferred backlog, proposal 0007 §6.3 — the tool execution context exposes no session/turn identity).', {
      unitId: { type: 'string', required: true },
      expectedOutlineRevision: { type: 'string', required: true, description: 'Outline revision you base this unit on.' },
      expectedRequirementSequence: { type: 'integer', required: true, description: 'Requirement watermark you read via novel_status_read.' },
    }, claimOutput, async (args, exec) => {
      // §6: claim is author-only — a delegated writer must never claim (claim
      // is not in WRITER_ALLOW_LIST; this is the tool-layer backstop when the
      // host toolFilter is absent or ineffective).
      const claimBinding = await resolveNovelBinding(exec)
      if (claimBinding.delegatedUnitId !== undefined) {
        throw new Error('Unit claiming must be performed by the delegating author (§6: claim is not part of the writer delegation)')
      }
      const novelId = claimBinding.novelId
      const snapshot = await snapshotOf(novelId)
      const claim = await (await novelStore()).claimUnit(novelId, {
        unitId: stringArg(args.unitId),
        expectedOutlineRevision: stringArg(args.expectedOutlineRevision),
        expectedRequirementSequence: nonNegativeInt(args.expectedRequirementSequence),
        // Explicit null (0007 §6.3): the tool execution context exposes no
        // host turn identity, so the claim records none — never a
        // model-supplied stand-in (§10.4: identity is server-side only).
        hostTurn: null,
      })
      const unit = snapshot.units.find((item) => item.unitId === claim.unitId)
      const committed = effectiveNovelCharacters(snapshot)
      return {
        unitId: claim.unitId,
        executionToken: claim.executionToken,
        attempt: claim.attempt,
        chapterId: unit?.chapterId ?? '',
        sceneId: unit?.sceneId ?? '',
        goal: unit?.goal ?? '',
        ...(unit?.continuationAnchor != null ? { continuationAnchor: unit.continuationAnchor } : {}),
        targetRange: unitTargetRange(snapshot.config, committed),
        narrativeStage: narrativeStage(snapshot.config, committed),
        source: { kind: 'novel-claim', id: claim.unitId },
        truncated: false,
      }
    }),
    tool('novel_unit_release', 'Release a CLAIMED writing unit back to prepared (§6.2): revokes the claim\'s execution token, increments the attempt and records the reason as the unit\'s lastError. This is the recovery path when the execution token is no longer available — typically novel_body_commit rejecting the unit as stale — after which the same unit id is re-claimed with a fresh token. Author-only: a delegated writer never releases claims.', {
      unitId: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'Why the claim is abandoned, e.g. the stale-token rejection that lost it.' },
    }, releaseOutput, async (args, exec) => {
      // §6.2 author-only: release is the claim owner's abandonment, mirrored
      // on the claim gate — a delegated writer must fail closed here.
      const binding = await resolveNovelBinding(exec)
      if (binding.delegatedUnitId !== undefined) {
        throw new Error('Unit releasing is author-only; a delegated writer never abandons claims (§6.2)')
      }
      const result = await (await novelStore()).releaseClaim(binding.novelId, {
        unitId: stringArg(args.unitId),
        reason: stringArg(args.reason),
      })
      return { unitId: result.unitId, attempt: result.attempt, state: 'prepared', source: { kind: 'novel-release', id: result.unitId } }
    }),
    tool('novel_unit_supersede', 'Retire a PREPARED writing unit whose scene already has a completed body commit — duplicate-leftover cleanup (§6.2). When finish-guards report unit-in-flight for such a unit, the scene prose already exists under the earlier commit; supersede the leftover and retry novel_finish. Refuses for units whose scene is not complete (write them instead), for claimed units (release them with novel_unit_release, finish them, or stop the run), and for delegated writers (author-only).', {
      unitId: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'Why this unit is a duplicate leftover, citing the commit that completed the scene.' },
    }, supersedeOutput, async (args, exec) => {
      const binding = await resolveNovelBinding(exec)
      if (binding.delegatedUnitId !== undefined) {
        throw new Error('Unit superseding is author-only; a delegated writer never retires units (§6.2)')
      }
      const novelId = binding.novelId
      const store = await novelStore()
      const snapshot = await snapshotOf(novelId)
      const unitId = stringArg(args.unitId)
      const unit = snapshot.units.find((item) => item.unitId === unitId)
      if (unit === undefined) throw new Error(`writing unit '${unitId}' not found`)
      if (unit.state === 'claimed') {
        throw new Error(`unit '${unitId}' is claimed: a claim must finish, be released with novel_unit_release, or be stopped before the unit can be superseded (§6.2); a claimed duplicate means an earlier execution is still holding it`)
      }
      if (unit.state !== 'prepared') throw new Error(`unit '${unitId}' is '${unit.state}' and cannot be superseded (§6.2)`)
      // Duplicate signature: the scene's latest commit already declared
      // completion. Otherwise this is real unfinished work — write it.
      const sceneOfUnit = new Map(snapshot.units.map((item) => [item.unitId, item.sceneId]))
      let completedBy: string | null = null
      for (let index = snapshot.commits.length - 1; index >= 0; index -= 1) {
        const commit = snapshot.commits[index]!
        if (sceneOfUnit.get(commit.unitId) === unit.sceneId) {
          if (commit.sceneCompleted) completedBy = commit.commitId
          break
        }
      }
      if (completedBy === null) {
        throw new Error(`scene '${unit.sceneId}' has no completed commit: unit '${unitId}' is unfinished work — claim and write it instead of superseding (§6.2)`)
      }
      const reason = stringArg(args.reason)
      await store.supersedeUnit(novelId, { unitId, reason: `${reason} (duplicate of ${unit.sceneId}; completed by ${completedBy})` })
      return { unitId, sceneId: unit.sceneId, state: 'superseded', completedBy, source: { kind: 'novel-supersede', id: unitId } }
    }),
  ]
}

const claimOutput = objectOutput({
  unitId: { type: 'string' }, executionToken: { type: 'string' }, attempt: { type: 'integer' },
  chapterId: { type: 'string' }, sceneId: { type: 'string' }, goal: { type: 'string' },
  continuationAnchor: { type: 'string' },
  targetRange: { type: 'object', additionalProperties: true }, narrativeStage: { type: 'string' },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['continuationAnchor'])
const supersedeOutput = objectOutput({
  unitId: { type: 'string' }, sceneId: { type: 'string' }, state: { type: 'string' },
  completedBy: { type: 'string' },
  source: { type: 'object', additionalProperties: true },
})
const releaseOutput = objectOutput({
  unitId: { type: 'string' }, attempt: { type: 'integer' }, state: { type: 'string' },
  source: { type: 'object', additionalProperties: true },
})
function nonNegativeInt(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('expected a non-negative integer')
  return value as number
}

// limitText / tokenizeQuery / matchesAllTokens 以及 character/lore 的解析匹配核心
// 已搬家到 ./writer.js（0007 Task B），本模块 import 使用，行为逐字等价；limitText
// 的最终落点现为 ../tool-args.js（经 writer.js re-export，决策 2026-09-09-dedup-refactor）。
// stringArg / boundedStringArg / clampInt 同决策统一于 ../tool-args.js；
// excerptAround 与 tavern 侧同源（tavern-store/src/tokenize.ts）。
