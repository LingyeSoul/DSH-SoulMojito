/** AgentNovel chapter completion, finish, character and lore tool slice (registration order 13-16). */

import { boundedStringArg, clampInt, stringArg } from '../../tool-args.js'
import { matchWorldEntries, resolveCharacterPage, tokenizeQuery } from '../writer.js'
import { authorBindingFor, novelBindingFor, objectOutput, snapshotOf, tool, type ToolDefinition } from './shared.js'
import { novelStore } from './stores.js'


export function completionTools(): ToolDefinition[] {
  return [
    tool('novel_chapter_complete', 'Complete a chapter after its bodies are committed (§6.3/§7.3): an explicit check separate from body commits, with the completion basis and open items.', {
      chapterId: { type: 'string', required: true },
      expectedContentRevision: { type: 'string', required: true, description: 'Content projection revision; changes on body/chapter display/canon changes.' },
      basis: { type: 'string', required: true, description: 'Why the chapter purpose is achieved.' },
      openItems: { type: 'array', items: { type: 'string' }, description: 'Deliberately open threads carried into later chapters; may be omitted or empty.' },
    }, chapterCompleteOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      if (args.openItems !== undefined && (!Array.isArray(args.openItems) || args.openItems.some((item) => typeof item !== 'string'))) {
        throw new Error('openItems must be an array of strings')
      }
      const result = await (await novelStore()).completeChapter(novelId, {
        chapterId: stringArg(args.chapterId),
        expectedContentRevision: stringArg(args.expectedContentRevision),
        basis: stringArg(args.basis),
        openItems: args.openItems ?? [],
      })
      return { revision: result.revision, source: { kind: 'novel-chapter-complete', id: novelId } }
    }),
    tool('novel_finish', 'Finish the novel (§7.3). The store verifies every completion condition — chapters, required foreshadowing, processed directives, no in-flight units, length budget — and surfaces violations verbatim; self-reported completion is never accepted. Recovery: when a violation reads unit-in-flight:<id> and that unit\'s scene already has a completed commit, the unit is a duplicate leftover — retire it with novel_unit_supersede and retry; never claim such a unit.', {
      expectedRevision: { type: 'string', required: true },
      basis: { type: 'string', required: true, description: 'The completion check basis: ending commit reference and resolved threads.' },
    }, finishOutput, async (args, exec) => {
      const novelId = await authorBindingFor(exec)
      const result = await (await novelStore()).finishNovel(novelId, {
        expectedRevision: stringArg(args.expectedRevision),
        basis: stringArg(args.basis),
      })
      return { revision: result.revision, totalCharacters: result.totalCharacters, source: { kind: 'novel-finish', id: novelId } }
    }),
    tool('novel_character_read', 'Read one character from the project asset snapshots (§5) — never the global tavern directory. Resolve via the outline characterId; snapshots stay readable after the source asset is edited or deleted.', {
      characterId: { type: 'string', required: true, description: 'Stable outline characterId, optionally carrying assetRef from novel_outline_read.' },
    }, characterReadOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const snapshot = await snapshotOf(novelId)
      const store = await novelStore()
      return resolveCharacterPage({ novelId, snapshot, readAsset: (id, hash) => store.readAsset(id, hash) }, stringArg(args.characterId))
    }),
    tool('novel_lore_search', 'Search only this project\'s fixed world book snapshots (§5) by entry keys and content keywords; entries return with their source content hash and never drift with global activeWorlds.', {
      query: { type: 'string', required: true, description: 'Keyword query; matches entry keys contained in the query or query words in entry content, capped at 2000 characters.' },
      limit: { type: 'integer', description: 'Maximum results, capped at 20. Default 10.' },
    }, loreSearchOutput, async (args, exec) => {
      const novelId = await novelBindingFor(exec)
      const query = boundedStringArg(args.query, 2000)
      const tokens = tokenizeQuery(query)
      if (tokens.length === 0) throw new Error('lore query requires at least one word')
      const limit = clampInt(args.limit, 1, 20, 10)
      const snapshot = await snapshotOf(novelId)
      const store = await novelStore()
      const { matched, contentTruncated } = await matchWorldEntries(
        { novelId, snapshot, readAsset: (id, hash) => store.readAsset(id, hash) },
        query,
        tokens,
      )
      const hits = matched.slice(0, limit)
      return {
        hits,
        sourceCount: hits.length,
        truncated: matched.length > hits.length || contentTruncated,
      }
    }),
  ]
}

const chapterCompleteOutput = objectOutput({ revision: { type: 'string' }, source: { type: 'object', additionalProperties: true } })
const finishOutput = objectOutput({
  revision: { type: 'string' }, totalCharacters: { type: 'integer' },
  source: { type: 'object', additionalProperties: true },
})
const characterReadOutput = objectOutput({
  characterId: { type: 'string' }, name: { type: 'string' }, nickname: { type: 'string' },
  identitySummary: { type: 'string' }, description: { type: 'string' }, personality: { type: 'string' },
  scenario: { type: 'string' }, source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['identitySummary'])
const loreSearchOutput = objectOutput({
  hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
  sourceCount: { type: 'integer' }, truncated: { type: 'boolean' },
})