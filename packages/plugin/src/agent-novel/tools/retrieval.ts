/** AgentNovel retrieval/facts/deduction tool slice (registration order 17-22). */

import {
  NovelCapabilityError,
  excerptAround,
  type CanonChange,
} from '../../../../tavern-store/src/index.js'
import { boundedStringArg, clampInt, stringArg } from '../../tool-args.js'
import {
  DEDUCE_MAX_ROLES,
  DEDUCE_MAX_ROUNDS,
  type DeductionExecAgent,
  parseDeductionRequest,
  runDeduction,
  subagentRuntimeOf,
} from '../../agent-tavern/deduce.js'
import { novelScopeId } from '../scope.js'
import { limitText, matchesAllTokens, tokenizeQuery } from '../writer.js'
import {
  authorBindingFor,
  novelBindingFor,
  objectOutput,
  pageCursor,
  snapshotOf,
  tool,
  type ToolDefinition,
} from './shared.js'
import { memoryStore, novelStore } from './stores.js'


export function retrievalTools(): ToolDefinition[] {
  return [
    tool('novel_body_read', 'Read committed body paragraphs page by page, optionally filtered to one chapter (§14.1: committed bodies are the authority).', {
      chapterId: { type: 'string', description: 'Restrict the read to one chapter.' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous page; omit for the first page.' },
      limit: { type: 'integer', description: 'Page size, capped at 50. Default 20.' },
    }, bodyReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const result = await (await novelStore()).readBody(novelId, {
        ...(typeof args.chapterId === 'string' && args.chapterId !== '' ? { chapterId: args.chapterId } : {}),
        ...(args.cursor === undefined ? {} : { cursor: stringArg(args.cursor) }),
        limit: clampInt(args.limit, 1, 50, 20),
      })
      return {
        paragraphs: result.paragraphs.map((paragraph) => ({
          commitId: paragraph.commitId,
          paragraphIndex: paragraph.paragraphIndex,
          chapterId: paragraph.chapterId,
          text: paragraph.text,
        })),
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        truncated: result.nextCursor !== null,
        source: { kind: 'novel-body', id: novelId },
      }
    }),
    tool('novel_body_search', 'Scan committed body paragraphs in order for a query (§11): returns paragraph coordinates (commitId#index, chapter, unit) with an excerpt and one neighbouring paragraph of context.', {
      query: { type: 'string', required: true, description: 'Every word must appear in a paragraph, capped at 2000 characters.' },
      chapterId: { type: 'string', description: 'Restrict the scan to one chapter.' },
      limit: { type: 'integer', description: 'Maximum hits, capped at 20. Default 10.' },
    }, bodySearchOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const tokens = tokenizeQuery(boundedStringArg(args.query, 2000))
      if (tokens.length === 0) throw new Error('body search requires at least one word')
      const limit = clampInt(args.limit, 1, 20, 10)
      const snapshot = await snapshotOf(novelId)
      const unitOfCommit = new Map(snapshot.commits.map((commit) => [commit.commitId, commit.unitId]))
      const all = await (await novelStore()).readBody(novelId, {
        ...(typeof args.chapterId === 'string' && args.chapterId !== '' ? { chapterId: args.chapterId } : {}),
      })
      let matchCount = 0
      const hits: Array<Record<string, unknown>> = []
      for (let index = 0; index < all.paragraphs.length; index += 1) {
        const paragraph = all.paragraphs[index]!
        if (!matchesAllTokens(paragraph.text, tokens)) continue
        matchCount += 1
        if (hits.length >= limit) continue
        const neighbour = index > 0 ? all.paragraphs[index - 1] : index + 1 < all.paragraphs.length ? all.paragraphs[index + 1] : undefined
        hits.push({
          chapterId: paragraph.chapterId,
          unitId: unitOfCommit.get(paragraph.commitId) ?? '',
          commitId: paragraph.commitId,
          paragraphIndex: paragraph.paragraphIndex,
          excerpt: excerptAround(paragraph.text, tokens, 400),
          ...(neighbour !== undefined ? { context: limitText(neighbour.text, 300) } : {}),
          truncated: paragraph.text.length > 400,
        })
      }
      return {
        hits,
        sourceCount: matchCount,
        truncated: matchCount > hits.length,
      }
    }),
    tool('novel_facts_read', 'Read the committed canon (§8.2): events, character states, relations, foreshadowing and variables aggregated from body commits, each with its commit source.', {
      kind: { type: 'string', enum: ['event', 'character-state', 'relation', 'foreshadowing', 'variable'], description: 'Restrict to one canon kind.' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous page; omit for the first page.' },
      limit: { type: 'integer', description: 'Page size, capped at 100. Default 20.' },
    }, factsReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      if (args.kind !== undefined && !CANON_KINDS.has(args.kind as string)) {
        throw new Error(`unknown canon kind '${String(args.kind)}'`)
      }
      const kind = args.kind as CanonChange['kind'] | undefined
      const snapshot = await snapshotOf(novelId)
      const cursor = pageCursor(args.cursor)
      const limit = clampInt(args.limit, 1, 100, 20)
      const facts: Array<Record<string, unknown>> = []
      for (const commit of snapshot.commits) {
        for (const change of commit.canonChanges) {
          if (kind !== undefined && change.kind !== kind) continue
          facts.push({
            kind: change.kind,
            summary: change.summary,
            ...(change.detail !== undefined ? { detail: change.detail } : {}),
            sources: [...change.sources],
            commitId: commit.commitId,
            unitId: commit.unitId,
            chapterId: commit.chapterId,
            committedAt: commit.committedAt,
          })
        }
      }
      const page = facts.slice(cursor, cursor + limit)
      const nextCursor = cursor + page.length < facts.length ? String(cursor + page.length) : null
      return {
        facts: page,
        ...(nextCursor !== null ? { nextCursor } : {}),
        sourceCount: page.length,
        source: { kind: 'novel-facts', id: novelId },
        truncated: nextCursor !== null,
      }
    }),
    tool('memory_search', 'Search this novel\'s retrieval index only (§8.2: scope chat, namespace novel:<id>). A rebuildable projection of committed canon — never an independent write channel.', {
      query: { type: 'string', required: true, description: 'Lexical search query.' },
      limit: { type: 'integer', description: 'Maximum results, capped at 20. Default 10.' },
      maxTokens: { type: 'integer', description: 'Approximate content token budget, capped at 2000. Default 1200.' },
    }, memorySearchOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const store = await memoryStore()
      const hits = await store.search({
        query: stringArg(args.query),
        scope: 'chat',
        scopeId: novelScopeId(novelId),
        limit: clampInt(args.limit, 1, 20, 10),
        maxTokens: clampInt(args.maxTokens, 1, 2000, 1200),
      })
      return {
        hits: hits.map((hit) => ({
          id: hit.record.id,
          scope: hit.record.scope,
          scopeId: hit.record.scopeId,
          content: hit.record.content,
          tags: hit.record.tags,
          score: Number(hit.score.toFixed(4)),
          revision: hit.record.revision,
          source: hit.record.source,
          truncated: hit.truncated,
        })),
        sourceCount: hits.length,
        truncated: hits.some((hit) => hit.truncated),
      }
    }),
    tool('memory_read', 'Read one memory of this novel\'s retrieval index by stable id (§8.2: scope chat, namespace novel:<id>).', {
      id: { type: 'string', required: true },
    }, memoryReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const record = await (await memoryStore()).read(stringArg(args.id), 'chat', novelScopeId(novelId))
      if (record === undefined) return { found: false, id: stringArg(args.id) }
      return {
        found: true,
        id: record.id,
        scope: record.scope,
        scopeId: record.scopeId,
        kind: record.kind,
        content: record.content,
        tags: record.tags,
        importance: record.importance,
        confidence: record.confidence,
        source: record.source,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        revision: record.revision,
      }
    }),
    tool('tavern_deduce', 'Novel adapter of the multi-role deduction core (§8.1): spawn one reasoning-only subagent per role and collect positions across rounds. Results are candidates, never canon. Any role failure is reported in failures and marks the result complete:false — an incomplete deduction must not be treated as a full success.', {
      scenario: { type: 'string', required: true, description: 'The concrete situation or what-if to deduce, grounded in committed facts, capped at 2000 characters.' },
      roles: {
        type: 'array', required: true, description: `2-${DEDUCE_MAX_ROLES} roles with distinct stakes (characters, factions, an omniscient narrator). Each brief states the role's perspective, knowledge and goal.`,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique short role name, capped at 80 characters.' },
            brief: { type: 'string', description: 'Role perspective, knowledge and goal, capped at 1500 characters.' },
          },
          required: ['name', 'brief'],
          additionalProperties: false,
        },
      },
      rounds: { type: 'integer', description: `Cross-examination rounds, 1-${DEDUCE_MAX_ROUNDS}. Default 1.` },
    }, deductionOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const parent = exec.agent as DeductionExecAgent | undefined
      const subagents = subagentRuntimeOf(parent)
      if (!subagents) {
        throw new NovelCapabilityError({ reason: 'subagent runtime is unavailable in this deployment; enable the dsh-subagent bundle with an in-process "spawn" provider to run novel deductions (§8.1)' })
      }
      const result = await runDeduction({ subagents, parent, signal: exec.signal }, parseDeductionRequest(args))
      if (result.failures.length === 0) {
        // Successful deductions consume the deduction budget (§8.1/§13);
        // accounting failures must never break the tool result.
        try {
          await (await novelStore()).noteDeduceRun(novelId)
        } catch {
          /* best-effort accounting only */
        }
      }
      return {
        scenario: result.scenario,
        rounds: result.rounds,
        roleCount: result.roleCount,
        positions: result.positions,
        failures: result.failures,
        ...(result.failures.length > 0 ? { complete: false } : {}),
        truncated: result.truncated,
      }
    }),
  ]
}

const bodyReadOutput = objectOutput({
  paragraphs: { type: 'array', items: { type: 'object', additionalProperties: true } },
  nextCursor: { type: 'string' }, truncated: { type: 'boolean' },
  source: { type: 'object', additionalProperties: true },
}, ['nextCursor'])
const bodySearchOutput = objectOutput({
  hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
  sourceCount: { type: 'integer' }, truncated: { type: 'boolean' },
})
const factsReadOutput = objectOutput({
  facts: { type: 'array', items: { type: 'object', additionalProperties: true } },
  nextCursor: { type: 'string' }, sourceCount: { type: 'integer' },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['nextCursor'])
const memorySearchOutput = objectOutput({
  hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
  sourceCount: { type: 'integer' }, truncated: { type: 'boolean' },
})
const memoryReadOutput = objectOutput({
  found: { type: 'boolean' }, id: { type: 'string' }, scope: { type: 'string' }, scopeId: { type: 'string' },
  kind: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
  importance: { type: 'number' }, confidence: { type: 'number' },
  source: { type: 'object', additionalProperties: true },
  createdAt: { type: 'string' }, updatedAt: { type: 'string' }, revision: { type: 'string' },
  expiresAt: { type: 'string' },
}, ['scope', 'scopeId', 'kind', 'content', 'tags', 'importance', 'confidence', 'source', 'createdAt', 'updatedAt', 'revision', 'expiresAt'])
const deductionOutput = objectOutput({
  scenario: { type: 'string' }, rounds: { type: 'integer' }, roleCount: { type: 'integer' },
  positions: { type: 'array', items: { type: 'object', additionalProperties: true } },
  failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
  complete: { type: 'boolean' }, truncated: { type: 'boolean' },
}, ['complete'])
const CANON_KINDS = new Set(['event', 'character-state', 'relation', 'foreshadowing', 'variable'])
