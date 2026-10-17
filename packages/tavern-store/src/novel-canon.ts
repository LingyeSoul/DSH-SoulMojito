/** Novel canon-change validation (§8.2), extracted from novel.ts. */

import { NovelConfigError, type BodyCommit, type CanonChange } from './novel-model.js'


const CANON_KINDS = new Set(['event', 'character-state', 'relation', 'foreshadowing', 'variable'])
const SOURCE_REF_PATTERN = /^(commit-\d+)(?:#(\d+))?$/

export function validateCanonChanges(changes: readonly CanonChange[], commits: readonly BodyCommit[], upcomingCommitId: string, upcomingParagraphCount: number): void {
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
