/**
 * AgentNovel memory-index projector and exporter
 * (docs/proposals/0005-agent-novel-architecture.md §8.2, §14.1, §14.2).
 *
 * The NovelStore commit record is the canon authority; the MemoryStore only
 * holds a rebuildable retrieval index in the namespaced chat scope
 * `novel:<novelId>` (§8.2). Exports are generated from one fixed HEAD snapshot
 * and contain only work product: metadata, outline and committed prose. They
 * never contain prompts, deduction transcripts, errors or raw private assets
 * (§14.2). A missing or inconsistent body object raises
 * NovelStorageCorruptionError instead of producing a truncated file.
 *
 * ZIP output is a self-written stored (uncompressed) archive with CRC32 from
 * node:zlib — no new dependencies (§15).
 */

import { promises as fs } from 'node:fs'
import { crc32 } from 'node:zlib'
import * as path from 'node:path'
import {
  NovelNotFoundError,
  NovelPreconditionError,
  NovelStorageCorruptionError,
  countEffectiveCharacters,
  isValidNovelId,
  summarizeNovel,
  type BodyCommit,
  type MemoryStore,
  type MemoryWrite,
  type NovelSnapshot,
  type NovelStore,
} from '../../../tavern-store/src/index.js'
import { novelScopeId } from './scope.js'

/** Fixed body-file serialization (§10.4); must match the store writer. */
const PARAGRAPH_SEPARATOR = '\n\n'

export type NovelExportFormat = 'md' | 'zip'

export interface NovelExport {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export class NovelProjector {
  private constructor(
    private readonly tavernRoot: string,
    private readonly store: NovelStore,
    private readonly memory: Pick<MemoryStore, 'put' | 'read' | 'forget'>,
  ) {}

  static async open(
    tavernRoot: string,
    store: NovelStore,
    memory: Pick<MemoryStore, 'put' | 'read' | 'forget'>,
  ): Promise<NovelProjector> {
    return new NovelProjector(tavernRoot, store, memory)
  }

  /* ----------------------------- memory index (§8.2) ----------------------------- */

  /**
   * Writes the commit's canon changes and a scene summary into the novel
   * memory namespace with stable ids `novel-<novelId>-<commitId>-<i>`
   * (canon changes first, the scene summary last). Idempotent: re-indexing an
   * unchanged commit rewrites nothing and adds no duplicate records.
   */
  async indexCommit(novelId: string, commitId: string): Promise<void> {
    const snapshot = await this.requireSnapshot(novelId)
    const commit = snapshot.commits.find((candidate) => candidate.commitId === commitId)
    if (commit === undefined) throw new NovelPreconditionError({ rule: 'commit-not-found', violations: [commitId] })
    const paragraphs = await this.readCommitParagraphs(novelId, commit)
    const scopeId = novelScopeId(novelId)
    for (const record of memoryRecordsFor(novelId, commit, paragraphs)) {
      // Read including deleted records: a rebuild-forgetting of this stable id
      // leaves a tombstone whose revision is required for the CAS rewrite.
      const existing = await this.memory.read(record.id, 'chat', scopeId, true)
      if (existing !== undefined) {
        // CAS rewrite via the read revision; identical live content is a no-op.
        if (existing.content === record.content && existing.deletedAt === undefined) continue
        await this.memory.put(record, existing.revision)
        continue
      }
      try {
        await this.memory.put(record)
      } catch (cause) {
        // A concurrent writer created the stable id first; its content wins.
        if (cause instanceof Error && cause.name === 'MemoryRevisionConflictError') continue
        throw cause
      }
    }
  }

  /**
   * Full rebuild from the commit index (§12.3 restart recovery): clears the
   * namespace, then re-indexes every commit in order.
   */
  async rebuildMemoryIndex(novelId: string): Promise<{ indexed: number }> {
    const snapshot = await this.requireSnapshot(novelId)
    const scopeId = novelScopeId(novelId)
    // Clear the whole namespace: stale records from older layouts must not
    // survive a rebuild either (§12.3 rebuild from the commit index).
    for (const stale of await this.existingMemoryRecords(novelId)) {
      await this.memory.forget(stale.id, 'chat', scopeId, stale.revision)
    }
    for (const commit of snapshot.commits) {
      await this.indexCommit(novelId, commit.commitId)
    }
    return { indexed: snapshot.commits.length }
  }

  /* ------------------------- projection recovery (§12.3) ------------------------- */

  /** Whether the store's reading projection carries a projection-pending marker (§13). */
  async projectionPending(novelId: string): Promise<boolean> {
    this.assertNovelId(novelId)
    const statusPath = path.join(this.novelDir(novelId), 'projections', 'status.json')
    let raw: string | undefined
    try {
      raw = await fs.readFile(statusPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw cause
    }
    try {
      const parsed = JSON.parse(raw) as { state?: unknown }
      return parsed.state === 'projection-pending' || (parsed.state === undefined && !('status' in parsed))
    } catch {
      return true // unparseable marker: attempt the rebuild
    }
  }

  /** Rebuilds the chapter markdown projections from the authoritative snapshot. */
  async repairProjections(novelId: string): Promise<void> {
    const snapshot = await this.requireSnapshot(novelId)
    // §14.2 consistency first: verify every body object before writing files.
    const paragraphsByChapter = await this.readAllCommitParagraphs(novelId, snapshot)
    const projectionsDir = path.join(this.novelDir(novelId), 'projections')
    await fs.rm(path.join(projectionsDir, 'chapters'), { recursive: true, force: true })
    await fs.mkdir(path.join(projectionsDir, 'chapters'), { recursive: true })
    const titleByChapter = new Map((snapshot.outline?.chapters ?? []).map((chapter) => [chapter.chapterId, chapter.title]))
    for (const [chapterId, commitGroups] of paragraphsByChapter) {
      const parts: string[] = [`# ${titleByChapter.get(chapterId) ?? chapterId}`, '']
      for (const paragraphs of commitGroups) parts.push(paragraphs.join(PARAGRAPH_SEPARATOR), '')
      await writeAtomicText(path.join(projectionsDir, 'chapters', `${chapterId}.md`), `${parts.join(PARAGRAPH_SEPARATOR).trimEnd()}\n`)
    }
    const summary = summarizeNovel(snapshot)
    await writeAtomicText(path.join(projectionsDir, 'status.json'), JSON.stringify({
      novelId: snapshot.novelId,
      revision: snapshot.revision,
      contentRevision: snapshot.contentRevision,
      status: summary.status,
      phase: summary.phase,
      pauseReason: summary.pauseReason,
      chaptersCompleted: summary.chaptersCompleted,
      chaptersTotal: summary.chaptersTotal,
      effectiveCharacters: summary.effectiveCharacters,
      updatedAt: snapshot.updatedAt,
    }, null, 2))
  }

  /* ------------------------------- export (§14.2) ------------------------------- */

  async exportNovel(novelId: string, format: NovelExportFormat): Promise<NovelExport> {
    const snapshot = await this.requireSnapshot(novelId)
    // §14.2: verify every required body object exists and hashes out before
    // producing a single export byte; corruption refuses to deliver.
    const paragraphsByChapter = await this.readAllCommitParagraphs(novelId, snapshot)
    const head = renderHead(snapshot)
    const chapters = orderedChapters(snapshot).map((chapter) => ({
      order: chapter.order,
      title: chapter.title,
      body: chapterBody(paragraphsByChapter.get(chapter.chapterId) ?? []),
    }))
    const base = sanitizeFilename(snapshot.config.title)
    if (format === 'md') {
      const document = [
        head,
        ...chapters.map((chapter) => [`# ${chapter.title}`, '', chapter.body].join('\n')),
      ].join('\n\n')
      return {
        filename: `${base}.md`,
        contentType: 'text/markdown; charset=utf-8',
        bytes: textBytes(`${document.trimEnd()}\n`),
      }
    }
    const entries: Array<{ name: string; data: Uint8Array }> = [
      { name: 'README.md', data: textBytes(head) },
      ...chapters.map((chapter) => ({
        name: `chapters/${String(chapter.order).padStart(2, '0')}-${sanitizeFilename(chapter.title) || 'chapter'}.md`,
        data: textBytes(`${['# ' + chapter.title, '', chapter.body].join('\n').trimEnd()}\n`),
      })),
    ]
    return {
      filename: `${base}.zip`,
      contentType: 'application/zip',
      bytes: buildStoredZip(entries),
    }
  }

  /* --------------------------------- internals --------------------------------- */

  private assertNovelId(novelId: string): void {
    if (!isValidNovelId(novelId)) throw new NovelNotFoundError({ novelId })
  }

  private novelDir(novelId: string): string {
    this.assertNovelId(novelId)
    return path.join(this.tavernRoot, 'novels', novelId)
  }

  private async requireSnapshot(novelId: string): Promise<NovelSnapshot> {
    this.assertNovelId(novelId)
    const snapshot = await this.store.getNovel(novelId)
    if (snapshot === undefined) throw new NovelNotFoundError({ novelId })
    return snapshot
  }

  /**
   * Reads one commit's immutable body object and verifies it against the
   * commit record: existence, fixed paragraph count and the effective-character
   * invariant (countPolicyVersion 1 ignores whitespace, so the joined text
   * must count exactly `effectiveCharacters`).
   */
  private async readCommitParagraphs(novelId: string, commit: BodyCommit): Promise<string[]> {
    const bodyPath = path.join(this.novelDir(novelId), 'bodies', `${commit.bodyHash}.txt`)
    let raw: string
    try {
      raw = await fs.readFile(bodyPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NovelStorageCorruptionError({ novelId, path: bodyPath, detail: `committed body object of ${commit.commitId} is missing` })
      }
      throw cause
    }
    const paragraphs = raw.split(PARAGRAPH_SEPARATOR)
    if (paragraphs.length !== commit.paragraphCount) {
      throw new NovelStorageCorruptionError({
        novelId,
        path: bodyPath,
        detail: `body object paragraph count ${paragraphs.length} does not match commit ${commit.commitId} record ${commit.paragraphCount}`,
      })
    }
    if (countEffectiveCharacters(raw) !== commit.effectiveCharacters) {
      throw new NovelStorageCorruptionError({
        novelId,
        path: bodyPath,
        detail: `body object effective characters do not match commit ${commit.commitId} record ${commit.effectiveCharacters}`,
      })
    }
    return paragraphs
  }

  private async readAllCommitParagraphs(novelId: string, snapshot: NovelSnapshot): Promise<Map<string, string[][]>> {
    const byChapter = new Map<string, string[][]>()
    for (const commit of snapshot.commits) {
      const paragraphs = await this.readCommitParagraphs(novelId, commit)
      const list = byChapter.get(commit.chapterId) ?? []
      list.push(paragraphs)
      byChapter.set(commit.chapterId, list)
    }
    return byChapter
  }

  /** Enumerates the raw memory records of the novel namespace (MemoryStore layout). */
  private async existingMemoryRecords(novelId: string): Promise<Array<{ id: string; revision: string }>> {
    const dir = path.join(this.tavernRoot, 'memories', 'chat', encodeURIComponent(novelScopeId(novelId)))
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
    const records: Array<{ id: string; revision: string }> = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as { id?: unknown; revision?: unknown }
      if (typeof parsed.id === 'string' && typeof parsed.revision === 'string') {
        records.push({ id: parsed.id, revision: parsed.revision })
      }
    }
    return records
  }
}

/* --------------------------------- helpers --------------------------------- */

/** A planned memory write with the required stable id. */
interface PlannedMemoryRecord extends MemoryWrite {
  id: string
}

/** Stable-id memory records for one commit: canon changes then the scene summary (§8.2). */
function memoryRecordsFor(novelId: string, commit: BodyCommit, paragraphs: readonly string[]): PlannedMemoryRecord[] {
  const scopeId = novelScopeId(novelId)
  const records: PlannedMemoryRecord[] = commit.canonChanges.map((change, index) => ({
    id: `novel-${novelId}-${commit.commitId}-${index}`,
    scope: 'chat',
    scopeId,
    kind: 'semantic',
    content: `[${change.kind}] ${change.summary} (sources: ${change.sources.join(', ')})`,
    tags: ['novel', 'canon', change.kind],
    importance: 0.6,
    confidence: 1,
    source: { kind: 'novel-commit', novelId, commitId: commit.commitId, unitId: commit.unitId, chapterId: commit.chapterId },
  }))
  records.push({
    id: `novel-${novelId}-${commit.commitId}-${commit.canonChanges.length}`,
    scope: 'chat',
    scopeId,
    kind: 'episodic',
    content: `Scene prose ${commit.commitId} (${commit.completionBasis}): ${paragraphs.join(' ').slice(0, 300)}`,
    tags: ['novel', 'scene'],
    importance: 0.4,
    confidence: 1,
    source: { kind: 'novel-commit', novelId, commitId: commit.commitId, unitId: commit.unitId, chapterId: commit.chapterId },
  })
  return records
}

function orderedChapters(snapshot: NovelSnapshot): NonNullable<NovelSnapshot['outline']>['chapters'] {
  return [...(snapshot.outline?.chapters ?? [])].sort((left, right) => left.order - right.order)
}

function chapterBody(commitGroups: readonly string[][]): string {
  const parts: string[] = []
  for (const paragraphs of commitGroups) {
    for (const paragraph of paragraphs) parts.push(paragraph)
  }
  return parts.join(PARAGRAPH_SEPARATOR)
}

/** Metadata + outline document (§14.2): never requirements, prompts or diagnostics. */
function renderHead(snapshot: NovelSnapshot): string {
  const summary = summarizeNovel(snapshot)
  const lines: string[] = [
    `# ${snapshot.config.title}`,
    '',
    `- Novel ID: ${snapshot.novelId}`,
    `- Status: ${summary.status}${summary.pauseReason === null ? '' : ` (${summary.pauseReason})`}`,
    `- Effective characters: ${summary.effectiveCharacters} (count policy version ${snapshot.countPolicyVersion}: Unicode code points, letters and digits only)`,
    `- Outline revision: ${snapshot.outline?.outlineRevision ?? 'none'}`,
    `- Exported at HEAD revision: ${snapshot.revision} (fixed snapshot, §14.2)`,
    `- Updated: ${snapshot.updatedAt}`,
  ]
  if (snapshot.outline !== null) {
    const outline = snapshot.outline
    lines.push('', '## Outline', '')
    lines.push('- Premise: ' + outline.story.premise)
    lines.push('- Theme: ' + outline.story.theme)
    lines.push('- Main conflict: ' + outline.story.mainConflict)
    lines.push('- Ending direction: ' + outline.story.endingDirection)
    if (outline.story.taboos.length > 0) lines.push('- Taboos: ' + outline.story.taboos.join('; '))
    lines.push('', '### Chapters', '')
    for (const chapter of orderedChapters(snapshot)) {
      const completed = snapshot.completedChapters.some((entry) => entry.chapterId === chapter.chapterId)
      lines.push(`${chapter.order}. ${chapter.title} — ${chapter.purpose}${completed ? ' (completed)' : ''}`)
    }
    if (outline.foreshadowing.length > 0) {
      lines.push('', '### Foreshadowing', '')
      for (const item of outline.foreshadowing) {
        lines.push(`- ${item.id} — ${item.description} [${item.status}]${item.required ? ' (required)' : ''}`)
      }
    }
  }
  return lines.join('\n')
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
  return cleaned
}

function textBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

async function writeAtomicText(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/* --------------------------- stored ZIP writer (§14.2) --------------------------- */

interface ZipEntry {
  name: string
  data: Uint8Array
}

const ZIP_UTF8_FLAG = 0x0800
/** Fixed DOS timestamp 1980-01-01 00:00 (deterministic output). */
const DOS_TIME = 0x0000
const DOS_DATE = 0x0021

/**
 * Minimal ZIP container with stored (uncompressed) entries: local file
 * headers, one central directory and the EOCD record. Names carry the UTF-8
 * flag bit; CRC32 comes from node:zlib. No external dependencies (§15).
 */
function buildStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = textBytes(entry.name)
    const checksum = crc32(entry.data) >>> 0
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true) // version needed
    localView.setUint16(6, ZIP_UTF8_FLAG, true)
    localView.setUint16(8, 0, true) // method: stored
    localView.setUint16(10, DOS_TIME, true)
    localView.setUint16(12, DOS_DATE, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true) // version made by
    centralView.setUint16(6, 20, true) // version needed
    centralView.setUint16(8, ZIP_UTF8_FLAG, true)
    centralView.setUint16(10, 0, true) // method: stored
    centralView.setUint16(12, DOS_TIME, true)
    centralView.setUint16(14, DOS_DATE, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true) // extra length
    centralView.setUint16(32, 0, true) // comment length
    centralView.setUint16(34, 0, true) // disk start
    centralView.setUint16(36, 0, true) // internal attributes
    centralView.setUint32(38, 0, true) // external attributes
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    localChunks.push(local, entry.data)
    centralChunks.push(central)
    offset += local.length + entry.data.length
  }
  const centralOffset = offset
  let centralSize = 0
  for (const chunk of centralChunks) centralSize += chunk.length
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(4, 0, true)
  eocdView.setUint16(6, 0, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, centralOffset, true)
  eocdView.setUint16(20, 0, true)
  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}
