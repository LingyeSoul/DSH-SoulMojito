/** AgentNovel body commit and writer delegation tool slice (registration order 10-12). */

import {
  NovelCapabilityError,
  requirementWatermark,
  type CanonChange,
  type NovelSnapshot,
  type SceneCompletion,
  type WritingUnit,
} from '../../../../tavern-store/src/index.js'
import { stringArg } from '../../tool-args.js'
import { type DeductionExecAgent, type SubagentRuntimeLike, subagentRuntimeOf } from '../../agent-tavern/deduce.js'
import {
  MAX_WRITER_DISPATCHES_PER_UNIT,
  assembleWriterPackInput,
  draftUnitViaSubagent,
  findWriterDelegation,
  findWriterDelegationByUnit,
  releaseWriterDelegation,
  retainWriterDelegation,
  runDelegatedWriter,
  type WriterDelegation,
  type WriterDelegationReceipt,
} from '../writer.js'
import {
  objectOutput,
  resolveNovelBinding,
  snapshotOf,
  tool,
  type NovelBindingResolution,
  type ToolDefinition,
  type ToolExecution,
} from './shared.js'
import { novelStore } from './stores.js'


export function bodyTools(): ToolDefinition[] {
  return [
    tool('novel_body_commit', 'Commit body prose for a claimed unit and end the writing turn (§10.4/§11). Paragraphs are plain text with no Markdown and no chapter headings; paragraphs carrying structural labels, unit ids or wrap-up notes (e.g. "chapter 6 scene 6-1 收束", "下一章 ch-007 …") are rejected — completion status belongs in sceneCompletion, never in prose. Canon change sources may use commit-<n>#<index> or inline references into this candidate body; the server fills in the commit id (§10.4). A stale-unit rejection means the execution token did not match the live claim — if the token was lost, release the unit with novel_unit_release and re-claim it for a fresh token instead of retrying the same dead claim.', {
      unitId: { type: 'string', required: true },
      executionToken: { type: 'string', description: 'Token returned by novel_unit_claim; delegated writer runs omit it.' },
      paragraphs: { type: 'array', required: true, items: { type: 'string' }, description: 'Non-empty plain-text paragraphs of pure narration; blank entries are rejected, and so are unit bookkeeping lines — chapter/scene labels and ids, headings, wrap-up notes ("收束", "完结") and next-unit previews.' },
      sceneCompletion: { ...sceneCompletionParameter, required: true },
      canonChanges: { ...canonChangesParameter, required: true },
    }, commitOutput, async (args, exec) => {
      const binding = await resolveNovelBinding(exec)
      const novelId = binding.novelId
      const unitId = stringArg(args.unitId)
      // §6.2 delegated scope: a writer subagent may only commit its delegated
      // unit — any other unit id is rejected before any store call. This is
      // the tool-layer front gate; the commitBody token-hash check stays the
      // final guard.
      if (binding.delegatedUnitId !== undefined && unitId !== binding.delegatedUnitId) {
        throw new Error(`delegated writer may only commit unit '${binding.delegatedUnitId}' of novel '${novelId}' (§6.2 delegation scope)`)
      }
      // Tool-layer structural validation (§11: runtime structure checks first).
      const paragraphs = args.paragraphs
      if (!Array.isArray(paragraphs) || paragraphs.length === 0) throw new Error('paragraphs must be a non-empty array of plain-text strings')
      for (const paragraph of paragraphs) {
        if (typeof paragraph !== 'string') throw new Error('paragraphs must be strings')
        if (paragraph.trim() === '') throw new Error('paragraphs must not contain blank entries (§6.3: empty bodies cannot be committed)')
      }
      const bookkeeping = proseBookkeepingIn(paragraphs as string[])
      if (bookkeeping !== undefined) throw new Error(bookkeeping)
      const completion = normalizeSceneCompletion(args.sceneCompletion)
      if (!Array.isArray(args.canonChanges)) throw new Error('canonChanges must be an array (§8.2)')
      const snapshot = await snapshotOf(novelId)
      // §10.3 idempotent retry: a unit that already committed resolves inline
      // sources against its own existing commit, so an identical retry replays
      // the original receipt instead of hashing to a different business content.
      const inlineTargetCommitId = snapshot.commits.find((commit) => commit.unitId === unitId)?.commitId
        ?? `commit-${snapshot.commits.length + 1}`
      const canonChanges = (args.canonChanges as CanonChange[]).map((change) => {
        if (typeof change !== 'object' || change === null || !Array.isArray(change.sources)) {
          throw new Error('each canon change must carry kind, summary and a sources array')
        }
        return { ...change, sources: change.sources.map((source) => resolveCanonSource(source, inlineTargetCommitId)) }
      })
      const receipt = await (await novelStore()).commitBody(novelId, {
        unitId,
        executionToken: executionTokenFor(args, exec, binding),
        paragraphs: paragraphs as string[],
        sceneCompletion: completion,
        canonChanges,
      })
      return {
        commitId: receipt.commitId,
        unitId: receipt.unitId,
        bodyHash: receipt.bodyHash,
        effectiveCharacters: receipt.effectiveCharacters,
        deltaCharacters: receipt.deltaCharacters,
        totalCharacters: receipt.totalCharacters,
        revision: receipt.revision,
        duplicate: receipt.duplicate,
        source: { kind: 'novel-commit', id: receipt.commitId },
      }
    }),
    tool('novel_writer_draft', 'Delegate the drafting of one claimed writing unit to a one-shot tool-free writer subagent (0007 §5.1, W1). Flow: claim the unit with novel_unit_claim first, then call this tool; it assembles a bounded writer pack from the store (story, chapter, scene, character pages, lore, body tail, foreshadowing, canon, unit parameters), spawns the writer, and returns the candidate draft ({paragraphs, sceneCompletion, canonChanges}). The candidate is NOT committed prose: review it, then submit exactly once with novel_body_commit. Pack assembly or writer failures throw structured errors and never degrade to silent partial output.', {
      unitId: { type: 'string', required: true, description: 'The claimed writing unit id from novel_unit_claim.' },
    }, writerDraftOutput, async (args, exec) => {
      const { novelId, unitId, parent, runtime, snapshot, unit } = await requireWriterLaunchContext(exec, args, '5.1', (candidate) => {
        if (candidate.state !== 'claimed') {
          throw new Error(`writing unit '${candidate.unitId}' is '${candidate.state}', not claimed — claim it with novel_unit_claim before drafting (§6.2)`)
        }
      })
      const store = await novelStore()
      const input = await assembleWriterPackInput({ novelStore: store, snapshot, unit, mode: 'full' })
      const drafted = await draftUnitViaSubagent({ runtime, parent, signal: exec.signal, novelId, unitId }, input)
      return {
        unitId,
        candidate: {
          paragraphs: [...drafted.candidate.paragraphs],
          sceneCompletion: drafted.candidate.sceneCompletion,
          canonChanges: [...drafted.candidate.canonChanges],
        },
        stopReason: drafted.stopReason,
      }
    }),
    tool('novel_writer_delegate', 'Delegate a writing unit end-to-end to a delegated writer subagent (0007 §5.2, W2). The tool claims the unit internally, spawns a writer holding a single-unit delegation that researches with read tools and commits itself, verifies the commit against the store snapshot (never trusting model self-report), and returns the receipt (commitId, effective characters, scene completion). The main agent never touches body bytes. Pass executionToken only when you already claimed this unit manually via novel_unit_claim (the claim is adopted); otherwise omit it. Calling again after a success replays the receipt idempotently. Dispatches per claim are capped (budgets.writerDispatchLimit, default 3); failures retain the claim for re-dispatch until the limit is reached.', {
      unitId: { type: 'string', required: true, description: 'The writing unit to delegate (prepared, or already claimed by you).' },
      executionToken: { type: 'string', description: 'Only for adopting a manual claim: the token returned by your novel_unit_claim. Omit it in the normal subagent flow — the tool claims internally.' },
    }, writerDelegateOutput, async (args, exec) => {
      const { novelId, unitId, parent, runtime, snapshot, unit } = await requireWriterLaunchContext(exec, args, '5.2')
      const store = await novelStore()

      // Unit dispatch state machine (0007 §5.2/§5.3).
      let delegation: WriterDelegation
      if (unit.state === 'committed') {
        // Idempotent success (0005 §12 retry discipline): replay the receipt
        // straight from the commit record; the consumed claim is released.
        releaseWriterDelegation(novelId, unitId)
        const commit = snapshot.commits.find((entry) => entry.unitId === unitId)
        if (commit === undefined) throw new Error(`unit '${unitId}' is committed but carries no commit record (inconsistent snapshot)`)
        return {
          unitId,
          commitId: commit.commitId,
          effectiveChars: commit.effectiveCharacters,
          sceneCompletion: { completed: commit.sceneCompleted, basis: commit.completionBasis, outstandingGoals: [...commit.outstandingGoals] },
        }
      }
      if (unit.state === 'prepared') {
        // Internal claim: outline revision and watermark come from the snapshot
        // the driver's notice interpolated the same values from — a racing
        // revision surfaces the store's CAS conflict verbatim.
        const outlineRevision = snapshot.outline?.outlineRevision
        if (outlineRevision === undefined || outlineRevision === null) {
          throw new Error('novel has no outline yet; a writing unit cannot be delegated without one (§6.3)')
        }
        const claim = await store.claimUnit(novelId, {
          unitId,
          expectedOutlineRevision: outlineRevision,
          expectedRequirementSequence: requirementWatermark(snapshot.requirements),
          // Explicit null — same deferral as the author-side claim (0007 §6.3).
          hostTurn: null,
        })
        delegation = {
          novelId,
          unitId,
          executionToken: claim.executionToken,
          intentId: snapshot.run.inFlightIntent?.intentId ?? null,
          grantedAt: new Date().toISOString(),
          dispatchCount: 1,
        }
      } else if (unit.state === 'claimed') {
        const retained = findWriterDelegationByUnit(novelId, unitId)
        if (retained !== undefined) {
          // Same-claim re-dispatch (§5.3): the token is unconsumed and the unit
          // still claimed, so the previous dispatch count carries forward.
          const nextDispatch = retained.dispatchCount + 1
          if (nextDispatch > dispatchLimitFor(snapshot)) {
            releaseWriterDelegation(novelId, unitId)
            throw new Error(`writer re-dispatch limit reached for unit '${unitId}': ${dispatchLimitFor(snapshot)} dispatches exhausted on this claim (§5.3) — end the turn and let the failure path release the unit`)
          }
          delegation = { ...retained, dispatchCount: nextDispatch, grantedAt: new Date().toISOString() }
        } else if (typeof args.executionToken === 'string' && args.executionToken.trim() !== '') {
          // Adoption of a manual claim: dispatchCount starts at 1; the token's
          // validity is ultimately proven by the commitBody hash check.
          delegation = {
            novelId,
            unitId,
            executionToken: stringArg(args.executionToken),
            intentId: snapshot.run.inFlightIntent?.intentId ?? null,
            grantedAt: new Date().toISOString(),
            dispatchCount: 1,
          }
        } else {
          throw new Error(`unit '${unitId}' is already claimed but no writer delegation is registered for it: in subagent mode call novel_writer_delegate directly (it claims internally) instead of claiming manually first, or pass the executionToken returned by your novel_unit_claim (§5.2)`)
        }
      } else {
        // superseded / anything else: the unit left the claimable states.
        releaseWriterDelegation(novelId, unitId)
        throw new Error(`writing unit '${unitId}' is '${unit.state}' and cannot be delegated (§6.2)`)
      }

      // Drop any retained copy so the live run-scoped entry is the only one;
      // runDelegatedWriter registers under the spawn run id and clears it in
      // its finally block.
      releaseWriterDelegation(novelId, unitId)
      let receipt: WriterDelegationReceipt
      try {
        receipt = await runDelegatedWriter({ runtime, parent, signal: exec.signal, novelStore: store }, delegation)
      } catch (cause) {
        // Failure retains the claim for same-claim re-dispatch (§5.3). The
        // registry stays a volatile in-process map: a process crash wipes it
        // and recovery goes through the existing stop/retry path (claimed and
        // uncommitted units are reset to prepared with attempt+1, §12.3) — no
        // duplicated prose, no new persisted state.
        retainWriterDelegation(delegation)
        throw cause
      }
      // Success: the token is consumed and the unit committed — nothing to
      // retain. Accounting mirrors noteDeduceRun: successful delegations only,
      // best-effort, never breaking the tool result.
      try {
        await store.noteWriterRun(novelId)
      } catch {
        /* best-effort accounting only */
      }
      return {
        unitId: receipt.unitId,
        commitId: receipt.commitId,
        effectiveChars: receipt.effectiveChars,
        sceneCompletion: {
          completed: receipt.sceneCompletion.completed,
          basis: receipt.sceneCompletion.basis,
          outstandingGoals: [...receipt.sceneCompletion.outstandingGoals],
        },
        dispatchCount: delegation.dispatchCount,
      }
    }),
  ]
}

const canonChangesParameter: Record<string, unknown> = {
  type: 'array',
  description: "Canon changes with paragraph sources (§8.2). A source is 'commit-<n>', 'commit-<n>#<index>', 'inline' or 'inline#<index>'; inline references point into this candidate body and get the real commit id filled in by the server (§10.4).",
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['event', 'character-state', 'relation', 'foreshadowing', 'variable'] },
      summary: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
      detail: { type: 'object', additionalProperties: true },
    },
    required: ['kind', 'summary', 'sources'],
  },
}

const sceneCompletionParameter: Record<string, unknown> = {
  type: 'object',
  description: 'Scene completion declaration (§6.3/§10.4): a completed scene or a continuation fragment with the next anchor.',
  additionalProperties: false,
  properties: {
    completed: { type: 'boolean', description: 'True only when the scene goal is fully achieved on screen.' },
    basis: { type: 'string', description: 'Why the scene is (or is not yet) complete.' },
    outstandingGoals: { type: 'array', items: { type: 'string' }, description: 'Scene goals still open; may be omitted, defaults to none.' },
    nextAnchor: { type: ['string', 'null'], description: 'Continuation anchor for the next fragment; null (or omitted) when the scene is complete.' },
  },
  required: ['completed', 'basis'],
}

const commitOutput = objectOutput({
  commitId: { type: 'string' }, unitId: { type: 'string' }, bodyHash: { type: 'string' },
  effectiveCharacters: { type: 'integer' }, deltaCharacters: { type: 'integer' },
  totalCharacters: { type: 'integer' }, revision: { type: 'string' }, duplicate: { type: 'boolean' },
  source: { type: 'object', additionalProperties: true },
})
const writerDraftOutput = objectOutput({
  unitId: { type: 'string' },
  candidate: { type: 'object', additionalProperties: true, description: 'Candidate draft in the novel_body_commit payload shape: paragraphs (string[]), sceneCompletion, canonChanges.' },
  stopReason: { type: 'string' },
})
const writerDelegateOutput = objectOutput({
  unitId: { type: 'string' },
  commitId: { type: 'string' },
  effectiveChars: { type: 'integer' },
  sceneCompletion: { type: 'object', additionalProperties: true },
  dispatchCount: { type: 'integer' },
}, ['dispatchCount'])

/* ---------------------------- prose guard (§11) ---------------------------- */

/**
 * Structural prose guard: some models mirror scheduler-notice bookkeeping into
 * body paragraphs (observed in the 2026-09-18 real-model run: trailing
 * "chapter 6 scene 6-1 收束。", "chapter 6 完结。下一章 ch-007，…" inside nine
 * commits of a 150-chapter plan). High-precision patterns only — a false
 * rejection stalls a writing turn — so narration that merely mentions a
 * chapter inline ("他翻到第三章") stays allowed.
 */
const STRUCTURAL_PROSE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchapter\s*[-#]?\s*\d+/i, 'chapter numbering'],
  [/\bscene\s*[-#]?\s*\d+\s*-\s*\d+/i, 'scene numbering'],
  [/\b(?:ch-\d{3,}|scene-\d+(?:-\d+)?|sc-\d+(?:-\d+)?|unit-\d+)\b/i, 'outline unit ids'],
  [/^#{1,6}\s/, 'a Markdown heading'],
  [/^第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节]\s*[^。！？!?…]{0,24}$/, 'a chapter heading'],
]

const COMPLETION_NOTE_PARAGRAPH = /^(?:收束|完结|全书完|全文完|大结局|未完待续|待续|the\s*end|完)[。.!！~～\s]*$/i

/** Returns the rejection message for the first bookkeeping paragraph, or undefined. */
function proseBookkeepingIn(paragraphs: readonly string[]): string | undefined {
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!
    for (const [pattern, label] of STRUCTURAL_PROSE_PATTERNS) {
      if (pattern.test(paragraph)) {
        return `paragraphs[${index}] carries ${label} ('${excerptOf(paragraph)}'): structural labels, unit ids and headings never enter prose (§11) — strip the bookkeeping, keep pure narration, and declare completion in sceneCompletion instead`
      }
    }
    if (COMPLETION_NOTE_PARAGRAPH.test(paragraph)) {
      return `paragraphs[${index}] is a completion note, not prose ('${excerptOf(paragraph)}'): wrap-up or ending markers never enter body paragraphs (§11) — declare completion in sceneCompletion instead`
    }
  }
  return undefined
}

function excerptOf(paragraph: string): string {
  return `${paragraph.slice(0, 60)}${paragraph.length > 60 ? '…' : ''}`
}

/* ------------------------- argument tolerance (§11) ------------------------- */

/**
 * Models legitimately omit fields whose absence has exactly one empty meaning
 * — null for nullable scalars, no entries for arrays (a real-model run showed
 * `sceneCompletion.nextAnchor` dropped when the scene completed, which forced
 * a full payload regeneration on retry). The tool layer fills the explicit
 * empty value; the store contract stays strict and semantic fields (ids,
 * revisions, non-empty strings, canon sources) remain required.
 */
function normalizeSceneCompletion(value: unknown): SceneCompletion {
  if (typeof value !== 'object' || value === null) {
    throw new Error('sceneCompletion must carry completed (boolean), a non-empty basis, outstandingGoals (string[]) and nextAnchor (string|null)')
  }
  const completion = value as Record<string, unknown>
  const outstandingGoals = completion.outstandingGoals
  const nextAnchor = completion.nextAnchor
  if (typeof completion.completed !== 'boolean'
    || typeof completion.basis !== 'string' || completion.basis.trim() === ''
    || (outstandingGoals !== undefined && (!Array.isArray(outstandingGoals) || outstandingGoals.some((goal) => typeof goal !== 'string')))
    || (nextAnchor !== undefined && nextAnchor !== null && typeof nextAnchor !== 'string')) {
    throw new Error('sceneCompletion must carry completed (boolean), a non-empty basis, outstandingGoals (string[]) and nextAnchor (string|null)')
  }
  return {
    completed: completion.completed,
    basis: completion.basis,
    outstandingGoals: Array.isArray(outstandingGoals) ? outstandingGoals as string[] : [],
    nextAnchor: nextAnchor === undefined ? null : nextAnchor as string | null,
  }
}

/** Resolves inline canon sources to the target commit id (§10.4: the server fills in the commitId). */
function resolveCanonSource(source: unknown, targetCommitId: string): string {
  if (typeof source !== 'string' || source.trim() === '') throw new Error('canon sources must be non-empty strings')
  if (source === 'inline') return targetCommitId
  if (source.startsWith('inline#')) {
    const index = Number(source.slice('inline#'.length))
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid inline canon source '${source}' (expected inline#<index>)`)
    return `${targetCommitId}#${index}`
  }
  if (!/^commit-\d+(?:#\d+)?$/.test(source)) {
    throw new Error(`invalid canon source '${source}' (expected commit-<n>, commit-<n>#<index>, 'inline' or 'inline#<index>')`)
  }
  return source
}

/**
 * §6.2/§6.3: delegated writers never carry the execution token on a
 * model-visible channel — the in-process registry pays the claim, so a
 * delegated commit always uses the registry token (a writer cannot hold a
 * valid token: claim is author-only, so honouring a model-supplied one could
 * only produce a guaranteed hash failure). Authors supply the token from
 * novel_unit_claim; the commitBody hash check stays the final guard for both.
 */
function executionTokenFor(args: Record<string, unknown>, exec: ToolExecution, binding: NovelBindingResolution): string {
  if (binding.delegatedUnitId !== undefined) {
    const delegation = findWriterDelegation(exec.agent?.id ?? '')
    if (delegation === undefined) {
      throw new Error('writer delegation is no longer active for this agent (§6.2: delegation not found — fail-closed; the writer run must fail or retry after the delegation registers)')
    }
    return delegation.executionToken
  }
  return stringArg(args.executionToken)
}

/** Per-claim writer dispatch ceiling (0007 §5.3): the budgets override wins,
 *  the built-in default otherwise. */
function dispatchLimitFor(snapshot: NovelSnapshot): number {
  return snapshot.config.budgets.writerDispatchLimit ?? MAX_WRITER_DISPATCHES_PER_UNIT
}

/** Shared launch preamble of the two writer tools (0007 §5.1/§5.2): resolve
 *  the author binding, refuse nested delegations, then load the unit and the
 *  subagent runtime. The optional guard runs after the unit resolves and
 *  before the runtime probe — caller argument errors (like a wrong unit
 *  state) must not be masked by a deployment gap. */
async function requireWriterLaunchContext(exec: ToolExecution, args: Record<string, unknown>, section: '5.1' | '5.2', guard?: (unit: WritingUnit) => void): Promise<{
  novelId: string
  unitId: string
  parent: DeductionExecAgent | undefined
  runtime: SubagentRuntimeLike
  snapshot: NovelSnapshot
  unit: WritingUnit
}> {
  const binding = await resolveNovelBinding(exec)
  if (binding.delegatedUnitId !== undefined) {
    throw new Error('Delegated writers cannot spawn further writers (0007 §13: nested writer delegation is out of scope)')
  }
  const unitId = stringArg(args.unitId)
  const snapshot = await snapshotOf(binding.novelId)
  const unit = snapshot.units.find((item) => item.unitId === unitId)
  if (unit === undefined) throw new Error(`writing unit '${unitId}' does not exist in this novel`)
  guard?.(unit)
  const parent = exec.agent as DeductionExecAgent | undefined
  const runtime = subagentRuntimeOf(parent)
  if (!runtime) {
    throw new NovelCapabilityError({ reason: `subagent runtime is unavailable in this deployment; enable the dsh-subagent bundle with an in-process "spawn" provider to run writer subagents (0007 §${section})` })
  }
  return { novelId: binding.novelId, unitId, parent, runtime, snapshot, unit }
}
