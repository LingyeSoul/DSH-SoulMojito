/** Novel projection materialization helpers (§5/§14.1), extracted from novel.ts. */

import type { CharacterCardIR } from '@dsh-soulmojito/format'
import { hash16 } from './novel-io.js'
import type { NovelSnapshot } from './novel-model.js'


/** World name attached to a character card, mirroring store.ts materializeEmbeddedBook naming. */
export function embeddedWorldName(card: CharacterCardIR): string | null {
  const book = card.data.characterBook
  if (book === undefined || book === null) return null
  const linked = card.data.extensions['world']
  if (typeof linked === 'string' && linked.trim() !== '') return linked.trim()
  if (typeof book.name === 'string' && book.name.trim() !== '') return book.name.trim()
  return card.data.name
}

/** Content projection version (§14.1): body, chapter display info, completions. */
export function contentRevisionOf(snapshot: NovelSnapshot): string {
  return hash16({
    chapters: (snapshot.outline?.chapters ?? []).map((chapter) => ({ chapterId: chapter.chapterId, order: chapter.order, title: chapter.title })),
    completedChapters: snapshot.completedChapters,
    commits: snapshot.commits.map((commit) => ({ commitId: commit.commitId, bodyHash: commit.bodyHash, effectiveCharacters: commit.effectiveCharacters })),
    // Pending/discarded revisions never project, so they must not invalidate
    // content-revision CAS checks (chapter completion, next commit).
    bodyRevisions: (snapshot.bodyRevisions ?? [])
      .filter((revision) => revision.status === 'applied' || revision.status === 'superseded')
      .map((revision) => ({
        revisionId: revision.revisionId,
        chapterId: revision.chapterId,
        bodyHash: revision.bodyHash,
        status: revision.status,
      })),
  })
}
