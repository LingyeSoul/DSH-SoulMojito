/**
 * Imported-source domain for AgentNovel continuation (proposal 0020).
 *
 * Pure functions only: chapter detection, part splitting, extraction/bible
 * validation and the bounded merge digest. File IO lives in novel.ts; model
 * execution lives in the plugin's agent-novel/importer.ts.
 *
 * The imported novel is prior text, not committed project prose. Parts stay as
 * immutable files and never enter `commits`; continuation units are planned and
 * written on top of the fused bible (§3).
 */

import { NovelConfigError, countEffectiveCharacters } from './novel-model.js'

/* ------------------------------ limits ------------------------------ */

export const IMPORT_PART_TARGET_MIN = 2000
export const IMPORT_PART_TARGET_MAX = 50000
export const IMPORT_PART_TARGET_DEFAULT = 12000
export const IMPORT_MAX_PARTS = 600
export const IMPORT_MAX_PART_ATTEMPTS = 3

export const IMPORT_MAX_EXTRACTION_BYTES = 256 * 1024
export const IMPORT_MAX_BIBLE_BYTES = 512 * 1024

const SUMMARY_LIMIT = 800
const TIMELINE_EVENTS_PER_PART = 20
const TIMELINE_SUMMARY_LIMIT = 400
const CHARACTERS_PER_PART = 16
const CHARACTER_FIELD_LIMIT = 2000
const RELATIONSHIPS_PER_CHARACTER = 20
const WORLD_ENTRIES_PER_PART = 16
const WORLD_CONTENT_LIMIT = 1600
const OPEN_THREADS_PER_PART = 16
const STYLE_LIMIT = 600

const DIGEST_SUMMARIES_MAX = 36
const DIGEST_TIMELINE_MAX = 80
const DIGEST_CHARACTERS_MAX = 60
const DIGEST_WORLD_ENTRIES_MAX = 80
const DIGEST_OPEN_THREADS_MAX = 40
const DIGEST_SOURCE_TAIL_LIMIT = 2400
const DIGEST_MAX_BYTES = 48 * 1024

/** Progressive compaction levels: the digest must stay a bounded author input. */
const DIGEST_LIMITS = [
  { summaries: 36, timeline: 80, characters: 60, worlds: 80, threads: 40, summaryChars: 320, timelineChars: 240, characterChars: 600, worldChars: 500, relations: 6, keyChars: 60 },
  { summaries: 28, timeline: 60, characters: 40, worlds: 50, threads: 32, summaryChars: 300, timelineChars: 220, characterChars: 450, worldChars: 450, relations: 5, keyChars: 50 },
  { summaries: 20, timeline: 40, characters: 28, worlds: 36, threads: 24, summaryChars: 280, timelineChars: 200, characterChars: 350, worldChars: 400, relations: 4, keyChars: 40 },
  { summaries: 14, timeline: 28, characters: 20, worlds: 24, threads: 18, summaryChars: 260, timelineChars: 180, characterChars: 280, worldChars: 320, relations: 3, keyChars: 32 },
  { summaries: 10, timeline: 20, characters: 12, worlds: 16, threads: 12, summaryChars: 240, timelineChars: 160, characterChars: 220, worldChars: 260, relations: 2, keyChars: 24 },
  { summaries: 6, timeline: 12, characters: 8, worlds: 10, threads: 8, summaryChars: 200, timelineChars: 140, characterChars: 180, worldChars: 200, relations: 1, keyChars: 20 },
] as const

/* ------------------------------- types ------------------------------- */

export type ImportFormat = 'txt' | 'md' | 'epub'
export type ImportPartStatus = 'pending' | 'extracted' | 'failed'

export interface ImportedChapter {
  chapterId: string
  order: number
  title: string
  effectiveCharacters: number
  partIds: readonly string[]
}

export interface ImportedPart {
  partId: string
  chapterId: string
  /** Global part order across the whole book (1-based). */
  order: number
  effectiveCharacters: number
  /** sha256 of the exact source text (storage integrity, not identity). */
  contentHash: string
  status: ImportPartStatus
  attempts: number
  extractionHash: string | null
  summary: string | null
  error: string | null
}

export interface ImportTimelineEvent {
  order: number
  summary: string
  characters: readonly string[]
  importance: 'major' | 'minor'
}

export interface ImportRelationship {
  name: string
  relation: string
}

export interface ImportCharacter {
  name: string
  aliases: readonly string[]
  role: string
  identity: string
  personality: string
  appearance: string
  motivation: string
  relationships: readonly ImportRelationship[]
  stateAtEnd: string
  confidence: 'high' | 'medium' | 'low'
}

export interface ImportWorldEntry {
  title: string
  keys: readonly string[]
  category: string
  content: string
}

export interface ImportStyle {
  pointOfView: string
  tone: string
  pacing: string
  proseNotes: string
  dialogueStyle: string
}

export interface ImportExtraction {
  partId: string
  chapterId: string
  summary: string
  timeline: readonly ImportTimelineEvent[]
  characters: readonly ImportCharacter[]
  worldEntries: readonly ImportWorldEntry[]
  openThreads: readonly string[]
  style: ImportStyle
}

export interface ImportBiblePayload {
  story: {
    premise: string
    theme: string
    mainConflict: string
    endingDirection: string
    taboos: readonly string[]
  }
  timeline: readonly ImportTimelineEvent[]
  characters: readonly ImportCharacter[]
  worldEntries: readonly ImportWorldEntry[]
  styleNotes: string
  openThreads: readonly string[]
}

export interface ImportBibleRecord extends ImportBiblePayload {
  bibleRevision: string
  mergedAt: string
  sourcePartCount: number
}

export interface ImportBibleSummary {
  bibleRevision: string
  mergedAt: string
  sourcePartCount: number
  premise: string
  endingDirection: string
  characterCount: number
  worldEntryCount: number
  timelineCount: number
}

export interface NovelImportState {
  sourceName: string
  sourceFormat: ImportFormat
  importedAt: string
  totalCharacters: number
  partTargetCharacters: number
  chapterSource: 'headings' | 'pseudo'
  chapters: readonly ImportedChapter[]
  parts: readonly ImportedPart[]
  /** Content hash of imports/bibles/<hash>.json; null until merged. */
  bibleHash: string | null
  bibleSummary: ImportBibleSummary | null
}

export interface ParsedImportPart {
  partId: string
  chapterId: string
  order: number
  text: string
  effectiveCharacters: number
}

export interface ParsedImportChapter {
  chapterId: string
  order: number
  title: string
  effectiveCharacters: number
  partIds: readonly string[]
  parts: readonly ParsedImportPart[]
}

export interface ParsedImport {
  totalCharacters: number
  chapterSource: 'headings' | 'pseudo'
  chapters: readonly ParsedImportChapter[]
  parts: readonly ParsedImportPart[]
}

export interface ImportParseInput {
  text: string
  format: ImportFormat
  titleFallback: string
  partTargetCharacters: number
}

export interface ImportDigestPartSummary {
  partId: string
  chapterId: string
  chapterTitle: string
  order: number
  summary: string
}

export interface ImportDigest {
  source: {
    name: string
    format: ImportFormat
    chapterCount: number
    partCount: number
    totalCharacters: number
    extractedParts: number
    merged: boolean
  }
  sampleSummaries: readonly ImportDigestPartSummary[]
  timeline: readonly ImportTimelineEvent[]
  characters: readonly (ImportCharacter & { mentions: number })[]
  worldEntries: readonly ImportWorldEntry[]
  style: ImportStyle | null
  openThreads: readonly string[]
  sourceTail: string
  truncated: {
    summaries: boolean
    timeline: boolean
    characters: boolean
    worldEntries: boolean
    openThreads: boolean
  }
}

/* ---------------------------- text parsing ---------------------------- */

const CN_NUMBER = '〇零一二三四五六七八九十百千万两0-9０-９'
const CHAPTER_HEADING_PATTERNS: readonly RegExp[] = [
  new RegExp(`^第\\s*[${CN_NUMBER}]+\\s*[章节回卷部篇集]\\s*[^\\n]{0,50}$`),
  /^(?:序章|楔子|引子|序言|前言|尾声|后记|终章|大结局|番外(?:篇)?(?:\s*[〇零一二三四五六七八九十百千万两0-9]+)?)\s*[^\n]{0,30}$/,
]
const EN_CHAPTER = /^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b[^\n]{0,60}$/i
const EN_SPECIAL = /^(?:prologue|epilogue|interlude|afterword|foreword|preface)\b[^\n]{0,40}$/i
const MD_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/

function normaliseText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function hasHan(text: string): boolean {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0
  return han > 0 && han >= latin
}

function headingOf(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.length > 90) return null
  const markdown = MD_HEADING.exec(trimmed)
  if (markdown !== null) {
    const title = markdown[2]!.trim()
    return title === '' ? null : title
  }
  if (CHAPTER_HEADING_PATTERNS.some((pattern) => pattern.test(trimmed))) return trimmed
  if (EN_CHAPTER.test(trimmed) || EN_SPECIAL.test(trimmed)) return trimmed
  return null
}

interface RawChapter {
  title: string | null
  lines: string[]
}

function splitRawChapters(lines: readonly string[]): RawChapter[] {
  const chapters: RawChapter[] = []
  let current: RawChapter = { title: null, lines: [] }
  for (const line of lines) {
    const heading = headingOf(line)
    if (heading !== null) {
      if (current.title !== null || current.lines.some((entry) => entry.trim() !== '')) chapters.push(current)
      current = { title: heading, lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.title !== null || current.lines.some((entry) => entry.trim() !== '')) chapters.push(current)
  return chapters
}

/** Split a paragraph that alone exceeds the target at sentence boundaries. */
function splitOversizedParagraph(paragraph: string, target: number): string[] {
  const sentences = paragraph.match(/[^。！？!?…；;\n]+[。！？!?…；;]?/g) ?? [paragraph]
  const pieces: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    if (buffer !== '' && countEffectiveCharacters(buffer) + countEffectiveCharacters(sentence) > target) {
      pieces.push(buffer.trim())
      buffer = ''
    }
    if (countEffectiveCharacters(sentence) > target * 2) {
      // No sentence boundary helps (run-on text): hard-split by code points.
      let chunk = ''
      for (const char of sentence) {
        chunk += char
        if (countEffectiveCharacters(chunk) >= target) {
          pieces.push(chunk.trim())
          chunk = ''
        }
      }
      if (chunk.trim() !== '') buffer += chunk
      continue
    }
    buffer += sentence
  }
  if (buffer.trim() !== '') pieces.push(buffer.trim())
  return pieces.filter((piece) => piece !== '')
}

function paragraphBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
}

function packParts(text: string, target: number): string[] {
  const blocks: string[] = []
  for (const block of paragraphBlocks(text)) {
    if (countEffectiveCharacters(block) > target * 1.5) {
      const pieces = splitOversizedParagraph(block, target)
      if (pieces.length === 0) continue
      blocks.push(...pieces)
    } else {
      blocks.push(block)
    }
  }
  const parts: string[] = []
  let buffer: string[] = []
  let buffered = 0
  const flush = (): void => {
    if (buffer.length > 0) {
      parts.push(buffer.join('\n\n'))
      buffer = []
      buffered = 0
    }
  }
  for (const block of blocks) {
    const size = countEffectiveCharacters(block)
    if (buffer.length > 0 && buffered + size > target) flush()
    buffer.push(block)
    buffered += size
  }
  flush()
  return parts
}

function pseudoChapters(text: string, target: number, languageZh: boolean): RawChapter[] {
  const chapterTarget = Math.max(target, target * 4)
  const chapters: RawChapter[] = []
  let buffer: string[] = []
  let buffered = 0
  const flush = (): void => {
    if (buffer.length === 0) return
    const index = chapters.length + 1
    chapters.push({ title: languageZh ? `第 ${index} 节` : `Part ${index}`, lines: buffer })
    buffer = []
    buffered = 0
  }
  for (const block of paragraphBlocks(text)) {
    const size = countEffectiveCharacters(block)
    if (buffer.length > 0 && buffered + size > chapterTarget) flush()
    buffer.push(block)
    buffered += size
  }
  flush()
  return chapters
}

export function validatePartTarget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < IMPORT_PART_TARGET_MIN || value > IMPORT_PART_TARGET_MAX) {
    throw new NovelConfigError({
      message: `partTargetCharacters must be an integer within [${IMPORT_PART_TARGET_MIN}, ${IMPORT_PART_TARGET_MAX}]`,
      errors: [{ field: 'partTargetCharacters', message: 'out of range' }],
    })
  }
  return value
}

export function validateImportSourceName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new NovelConfigError({ message: 'source name must be a non-empty string within 200 characters' })
  }
  return value.trim()
}

export function validateImportFormat(value: unknown): ImportFormat {
  if (value !== 'txt' && value !== 'md' && value !== 'epub') {
    throw new NovelConfigError({ message: "source format must be 'txt', 'md' or 'epub'" })
  }
  return value
}

/**
 * Parses plain text (EPUB is decoded by the caller) into chapters and parts.
 * Heading detection prefers explicit chapter titles; a book without headings is
 * split into pseudo chapters first, then parts, so continuation planning always
 * has chapter-level structure to work with.
 */
export function parseImportedNovelText(input: ImportParseInput): ParsedImport {
  const target = validatePartTarget(input.partTargetCharacters)
  const text = normaliseText(input.text)
  if (text === '') throw new NovelConfigError({ message: 'imported source is empty' })
  const languageZh = hasHan(text)
  const rawHeadings = splitRawChapters(text.split('\n'))
  const prefaceChapter = rawHeadings[0] !== undefined && rawHeadings[0].title === null ? rawHeadings[0] : null
  const titledChapters = rawHeadings.filter((chapter) => chapter.title !== null && chapter.lines.join('\n').trim() !== '')
  let chapterSource: 'headings' | 'pseudo' = 'headings'
  let rawChapters = titledChapters
  if (rawChapters.length < 2) {
    chapterSource = 'pseudo'
    rawChapters = pseudoChapters(text, target, languageZh)
  } else if (prefaceChapter !== null) {
    // A preface before the first heading is a chapter only when substantive.
    const preface = prefaceChapter.lines.join('\n').trim()
    if (preface !== '' && countEffectiveCharacters(preface) < 200 && rawChapters[0] !== undefined) {
      rawChapters[0] = { ...rawChapters[0], lines: [...preface.split('\n'), '', ...rawChapters[0].lines] }
    } else if (preface !== '') {
      rawChapters.unshift({ title: languageZh ? '前言' : 'Preface', lines: preface.split('\n') })
    }
  }
  const titleFallback = input.titleFallback.trim() === '' ? 'Imported novel' : input.titleFallback.trim()
  const chapters: ParsedImportChapter[] = []
  const parts: ParsedImportPart[] = []
  for (const [chapterIndex, raw] of rawChapters.entries()) {
    const body = raw.lines.join('\n').trim()
    if (body === '') continue
    const chapterId = `ich-${chapterIndex + 1}`
    const title = raw.title?.trim() ?? (languageZh ? `第 ${chapterIndex + 1} 节` : `${titleFallback} · Part ${chapterIndex + 1}`)
    const chapterParts: ParsedImportPart[] = []
    for (const partText of packParts(body, target)) {
      const partIndex = parts.length + 1
      const part: ParsedImportPart = {
        partId: `imp-${partIndex}`,
        chapterId,
        order: partIndex,
        text: partText,
        effectiveCharacters: countEffectiveCharacters(partText),
      }
      parts.push(part)
      chapterParts.push(part)
    }
    if (chapterParts.length === 0) continue
    chapters.push({
      chapterId,
      order: chapters.length + 1,
      title,
      effectiveCharacters: chapterParts.reduce((total, part) => total + part.effectiveCharacters, 0),
      partIds: chapterParts.map((part) => part.partId),
      parts: chapterParts,
    })
  }
  if (chapters.length === 0 || parts.length === 0) {
    throw new NovelConfigError({ message: 'imported source contains no non-empty prose' })
  }
  if (parts.length > IMPORT_MAX_PARTS) {
    throw new NovelConfigError({
      message: `imported source splits into ${parts.length} parts, above the ${IMPORT_MAX_PARTS}-part limit: raise partTargetCharacters or split the book`,
    })
  }
  return {
    totalCharacters: chapters.reduce((total, chapter) => total + chapter.effectiveCharacters, 0),
    chapterSource,
    chapters,
    parts,
  }
}

/* ------------------------------ validation ------------------------------ */

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function requiredText(value: unknown, field: string, max: number, errors: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} must be a non-empty string`)
    return ''
  }
  return clip(value.trim(), max)
}

function optionalText(value: unknown, field: string, max: number, errors: string[]): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`)
    return ''
  }
  return clip(value.trim(), max)
}

function stringArray(value: unknown, field: string, maxItems: number, maxLength: number, errors: string[]): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`)
    return []
  }
  const result: string[] = []
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== 'string') {
      errors.push(`${field} entries must be strings`)
      continue
    }
    const text = clip(item.trim(), maxLength)
    if (text !== '') result.push(text)
  }
  return result
}

function objectOf(value: unknown, field: string, errors: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${field} must be an object`)
    return {}
  }
  return value as Record<string, unknown>
}

function arrayOf(value: unknown, field: string, errors: string[]): unknown[] {
  // A missing/null collection has exactly one empty meaning, mirroring the
  // tool-layer tolerance elsewhere; present non-array values are still errors.
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`)
    return []
  }
  return value
}

function importanceOf(value: unknown): 'major' | 'minor' {
  return value === 'major' ? 'major' : 'minor'
}

function confidenceOf(value: unknown): 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'low' ? value : 'medium'
}

function normaliseTimeline(value: unknown, field: string, errors: string[], maxEvents: number): ImportTimelineEvent[] {
  return arrayOf(value, field, errors).slice(0, maxEvents).map((item, index) => {
    const record = objectOf(item, `${field}[${index}]`, errors)
    return {
      order: index + 1,
      summary: requiredText(record.summary, `${field}[${index}].summary`, TIMELINE_SUMMARY_LIMIT, errors),
      characters: stringArray(record.characters, `${field}[${index}].characters`, 20, 80, errors),
      importance: importanceOf(record.importance),
    }
  }).filter((event) => event.summary !== '')
}

function normaliseRelationships(value: unknown, field: string, errors: string[]): ImportRelationship[] {
  return arrayOf(value, field, errors).slice(0, RELATIONSHIPS_PER_CHARACTER).map((item, index) => {
    const record = objectOf(item, `${field}[${index}]`, errors)
    return {
      name: requiredText(record.name, `${field}[${index}].name`, 120, errors),
      relation: requiredText(record.relation, `${field}[${index}].relation`, 300, errors),
    }
  }).filter((relationship) => relationship.name !== '')
}

function normaliseCharacters(value: unknown, field: string, errors: string[], maxCharacters: number): ImportCharacter[] {
  return arrayOf(value, field, errors).slice(0, maxCharacters).map((item, index) => {
    const record = objectOf(item, `${field}[${index}]`, errors)
    return {
      name: requiredText(record.name, `${field}[${index}].name`, 120, errors),
      aliases: stringArray(record.aliases, `${field}[${index}].aliases`, 8, 80, errors),
      role: optionalText(record.role, `${field}[${index}].role`, 300, errors),
      identity: optionalText(record.identity, `${field}[${index}].identity`, CHARACTER_FIELD_LIMIT, errors),
      personality: optionalText(record.personality, `${field}[${index}].personality`, CHARACTER_FIELD_LIMIT, errors),
      appearance: optionalText(record.appearance, `${field}[${index}].appearance`, CHARACTER_FIELD_LIMIT, errors),
      motivation: optionalText(record.motivation, `${field}[${index}].motivation`, CHARACTER_FIELD_LIMIT, errors),
      relationships: normaliseRelationships(record.relationships, `${field}[${index}].relationships`, errors),
      stateAtEnd: optionalText(record.stateAtEnd, `${field}[${index}].stateAtEnd`, CHARACTER_FIELD_LIMIT, errors),
      confidence: confidenceOf(record.confidence),
    }
  }).filter((character) => character.name !== '')
}

function normaliseWorldEntries(value: unknown, field: string, errors: string[], maxEntries: number): ImportWorldEntry[] {
  return arrayOf(value, field, errors).slice(0, maxEntries).map((item, index) => {
    const record = objectOf(item, `${field}[${index}]`, errors)
    return {
      title: requiredText(record.title, `${field}[${index}].title`, 200, errors),
      keys: stringArray(record.keys, `${field}[${index}].keys`, 20, 80, errors),
      category: optionalText(record.category, `${field}[${index}].category`, 120, errors),
      content: requiredText(record.content, `${field}[${index}].content`, WORLD_CONTENT_LIMIT, errors),
    }
  }).filter((entry) => entry.title !== '' && entry.content !== '')
}

function normaliseStyle(value: unknown, field: string, errors: string[]): ImportStyle {
  if (value === undefined || value === null) {
    return { pointOfView: '', tone: '', pacing: '', proseNotes: '', dialogueStyle: '' }
  }
  const record = objectOf(value, field, errors)
  return {
    pointOfView: optionalText(record.pointOfView, `${field}.pointOfView`, STYLE_LIMIT, errors),
    tone: optionalText(record.tone, `${field}.tone`, STYLE_LIMIT, errors),
    pacing: optionalText(record.pacing, `${field}.pacing`, STYLE_LIMIT, errors),
    proseNotes: optionalText(record.proseNotes, `${field}.proseNotes`, STYLE_LIMIT, errors),
    dialogueStyle: optionalText(record.dialogueStyle, `${field}.dialogueStyle`, STYLE_LIMIT, errors),
  }
}

function throwIfErrors(errors: readonly string[], label: string): void {
  if (errors.length === 0) return
  throw new NovelConfigError({
    message: `${label} is invalid: ${errors.slice(0, 6).join('; ')}${errors.length > 6 ? `; and ${errors.length - 6} more` : ''}`,
    errors: errors.map((message) => ({ field: label, message })),
  })
}

export function normaliseImportExtraction(value: unknown, partId: string, chapterId: string): ImportExtraction {
  const errors: string[] = []
  const record = objectOf(value, 'extraction', errors)
  const extraction: ImportExtraction = {
    partId,
    chapterId,
    summary: requiredText(record.summary, 'summary', SUMMARY_LIMIT, errors),
    timeline: normaliseTimeline(record.timeline, 'timeline', errors, TIMELINE_EVENTS_PER_PART),
    characters: normaliseCharacters(record.characters, 'characters', errors, CHARACTERS_PER_PART),
    worldEntries: normaliseWorldEntries(record.worldEntries, 'worldEntries', errors, WORLD_ENTRIES_PER_PART),
    openThreads: stringArray(record.openThreads, 'openThreads', OPEN_THREADS_PER_PART, 400, errors),
    style: normaliseStyle(record.style, 'style', errors),
  }
  throwIfErrors(errors, 'import extraction')
  const bytes = Buffer.byteLength(JSON.stringify(extraction), 'utf8')
  if (bytes > IMPORT_MAX_EXTRACTION_BYTES) {
    throw new NovelConfigError({ message: `import extraction is ${bytes} bytes, above the ${IMPORT_MAX_EXTRACTION_BYTES}-byte limit` })
  }
  return extraction
}

export function normaliseImportBible(value: unknown): ImportBiblePayload {
  const errors: string[] = []
  const record = objectOf(value, 'bible', errors)
  const story = objectOf(record.story, 'bible.story', errors)
  const bible: ImportBiblePayload = {
    story: {
      premise: requiredText(story.premise, 'bible.story.premise', 3000, errors),
      theme: optionalText(story.theme, 'bible.story.theme', 1000, errors),
      mainConflict: optionalText(story.mainConflict, 'bible.story.mainConflict', 2000, errors),
      endingDirection: requiredText(story.endingDirection, 'bible.story.endingDirection', 2000, errors),
      taboos: stringArray(story.taboos, 'bible.story.taboos', 30, 200, errors),
    },
    timeline: normaliseTimeline(record.timeline, 'bible.timeline', errors, 300),
    characters: normaliseCharacters(record.characters, 'bible.characters', errors, 80),
    worldEntries: normaliseWorldEntries(record.worldEntries, 'bible.worldEntries', errors, 160),
    styleNotes: optionalText(record.styleNotes, 'bible.styleNotes', 4000, errors),
    openThreads: stringArray(record.openThreads, 'bible.openThreads', 80, 400, errors),
  }
  throwIfErrors(errors, 'import bible')
  const bytes = Buffer.byteLength(JSON.stringify(bible), 'utf8')
  if (bytes > IMPORT_MAX_BIBLE_BYTES) {
    throw new NovelConfigError({ message: `import bible is ${bytes} bytes, above the ${IMPORT_MAX_BIBLE_BYTES}-byte limit` })
  }
  return bible
}

/* -------------------------------- digest -------------------------------- */

function sampleEvenly<T>(items: readonly T[], max: number): T[] {
  if (max <= 1) return items.slice(0, Math.max(0, max))
  if (items.length <= max) return [...items]
  const picked: T[] = []
  const seen = new Set<number>()
  for (let index = 0; index < max; index += 1) {
    const at = Math.round((index * (items.length - 1)) / (max - 1))
    if (seen.has(at)) continue
    seen.add(at)
    picked.push(items[at]!)
  }
  return picked
}

function uniqueStrings(values: readonly string[], max: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]!.trim()
    const key = value.toLocaleLowerCase()
    if (value === '' || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= max) break
  }
  return result.reverse()
}

function mergeCharacters(extractions: readonly ImportExtraction[], max: number): Array<ImportCharacter & { mentions: number }> {
  const merged = new Map<string, ImportCharacter & { mentions: number }>()
  for (const extraction of extractions) {
    for (const character of extraction.characters) {
      const key = character.name.toLocaleLowerCase()
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, { ...character, mentions: 1 })
        continue
      }
      merged.set(key, {
        name: existing.name,
        aliases: [...new Set([...existing.aliases, ...character.aliases])].slice(0, 8),
        role: character.role !== '' ? character.role : existing.role,
        identity: character.identity !== '' ? character.identity : existing.identity,
        personality: character.personality !== '' ? character.personality : existing.personality,
        appearance: character.appearance !== '' ? character.appearance : existing.appearance,
        motivation: character.motivation !== '' ? character.motivation : existing.motivation,
        relationships: character.relationships.length > 0 ? [...character.relationships] : [...existing.relationships],
        stateAtEnd: character.stateAtEnd !== '' ? character.stateAtEnd : existing.stateAtEnd,
        confidence: character.confidence,
        mentions: existing.mentions + 1,
      })
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.mentions - left.mentions || left.name.localeCompare(right.name))
    .slice(0, max)
}

function mergeWorldEntries(extractions: readonly ImportExtraction[], max: number): ImportWorldEntry[] {
  const merged = new Map<string, ImportWorldEntry>()
  for (const extraction of extractions) {
    for (const entry of extraction.worldEntries) {
      const key = entry.title.toLocaleLowerCase()
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, entry)
        continue
      }
      merged.set(key, {
        title: existing.title,
        keys: [...new Set([...existing.keys, ...entry.keys])].slice(0, 20),
        category: entry.category !== '' ? entry.category : existing.category,
        content: entry.content.length >= existing.content.length ? entry.content : existing.content,
      })
    }
  }
  return [...merged.values()].slice(0, max)
}

type DigestLimit = (typeof DIGEST_LIMITS)[number]

function digestCandidate(raw: {
  source: ImportDigest['source']
  summaries: readonly ImportDigestPartSummary[]
  timeline: readonly ImportTimelineEvent[]
  characters: readonly (ImportCharacter & { mentions: number })[]
  worldEntries: readonly ImportWorldEntry[]
  style: ImportStyle | null
  openThreads: readonly string[]
  sourceTail: string
}, limits: DigestLimit): ImportDigest {
  const characterText = (value: string): string => clip(value, limits.characterChars)
  const characters = raw.characters.slice(0, limits.characters).map((character) => ({
    ...character,
    aliases: character.aliases.slice(0, 6).map((alias) => clip(alias, limits.keyChars)),
    role: clip(character.role, limits.keyChars * 2),
    identity: characterText(character.identity),
    personality: characterText(character.personality),
    appearance: characterText(character.appearance),
    motivation: characterText(character.motivation),
    stateAtEnd: characterText(character.stateAtEnd),
    relationships: character.relationships.slice(0, limits.relations).map((relationship) => ({
      name: clip(relationship.name, limits.keyChars),
      relation: clip(relationship.relation, limits.keyChars * 2),
    })),
  }))
  const worldEntries = sampleEvenly(raw.worldEntries, limits.worlds).map((entry) => ({
    ...entry,
    keys: entry.keys.slice(0, 12).map((key) => clip(key, limits.keyChars)),
    category: clip(entry.category, limits.keyChars),
    content: clip(entry.content, limits.worldChars),
  }))
  const timeline = sampleEvenly(raw.timeline, limits.timeline).map((event) => ({
    ...event,
    summary: clip(event.summary, limits.timelineChars),
    characters: event.characters.slice(0, 10).map((name) => clip(name, limits.keyChars)),
  }))
  return {
    source: raw.source,
    sampleSummaries: sampleEvenly(raw.summaries, limits.summaries).map((summary) => ({
      ...summary,
      summary: clip(summary.summary, limits.summaryChars),
    })),
    timeline,
    characters,
    worldEntries,
    style: raw.style,
    openThreads: raw.openThreads.slice(0, limits.threads).map((thread) => clip(thread, limits.timelineChars)),
    sourceTail: raw.sourceTail,
    truncated: {
      summaries: raw.summaries.length > limits.summaries,
      timeline: raw.timeline.length > limits.timeline,
      characters: raw.characters.length > limits.characters
        || characters.some((character) => character.identity.length >= limits.characterChars || character.stateAtEnd.length >= limits.characterChars),
      worldEntries: raw.worldEntries.length > limits.worlds
        || worldEntries.some((entry) => entry.content.length >= limits.worldChars),
      openThreads: raw.openThreads.length > limits.threads,
    },
  }
}

export function buildImportDigest(input: {
  state: NovelImportState
  extractions: readonly ImportExtraction[]
  sourceTail: string
}): ImportDigest {
  const byPart = new Map(input.state.parts.map((part) => [part.partId, part]))
  const ordered = [...input.extractions].sort((left, right) => (byPart.get(left.partId)?.order ?? 0) - (byPart.get(right.partId)?.order ?? 0))
  const chapterTitle = new Map(input.state.chapters.map((chapter) => [chapter.chapterId, chapter.title]))
  const summaries = ordered.map((extraction) => {
    const part = byPart.get(extraction.partId)
    return {
      partId: extraction.partId,
      chapterId: extraction.chapterId,
      chapterTitle: chapterTitle.get(extraction.chapterId) ?? extraction.chapterId,
      order: part?.order ?? 0,
      summary: extraction.summary,
    }
  })
  const allTimeline = ordered.flatMap((extraction) => extraction.timeline)
  const raw = {
    source: {
      name: input.state.sourceName,
      format: input.state.sourceFormat,
      chapterCount: input.state.chapters.length,
      partCount: input.state.parts.length,
      totalCharacters: input.state.totalCharacters,
      extractedParts: input.state.parts.filter((part) => part.status === 'extracted').length,
      merged: input.state.bibleHash !== null,
    },
    summaries,
    timeline: allTimeline.length <= DIGEST_TIMELINE_MAX
      ? allTimeline
      : [...allTimeline.slice(0, 20), ...allTimeline.slice(allTimeline.length - (DIGEST_TIMELINE_MAX - 20))],
    characters: mergeCharacters(ordered, 400),
    worldEntries: mergeWorldEntries(ordered, 400),
    style: ordered.length > 0 ? ordered[ordered.length - 1]!.style : null,
    openThreads: uniqueStrings(ordered.flatMap((extraction) => extraction.openThreads), 400),
    sourceTail: input.sourceTail.slice(-DIGEST_SOURCE_TAIL_LIMIT),
  }
  let digest = digestCandidate(raw, DIGEST_LIMITS[0]!)
  for (const limits of DIGEST_LIMITS.slice(1)) {
    if (Buffer.byteLength(JSON.stringify(digest), 'utf8') <= DIGEST_MAX_BYTES) break
    digest = digestCandidate(raw, limits)
  }
  // Even the smallest level can overflow only for a pathologically long style
  // block; the protocol caps style fields, so keep the bound explicit.
  if (Buffer.byteLength(JSON.stringify(digest), 'utf8') > DIGEST_MAX_BYTES) {
    digest = { ...digest, style: null }
  }
  return digest
}

/** Progress counters shared by the driver, tools and panel. */
export function importProgressOf(state: NovelImportState): {
  chapterCount: number
  partCount: number
  extracted: number
  failed: number
  pending: number
  merged: boolean
} {
  const extracted = state.parts.filter((part) => part.status === 'extracted').length
  const failed = state.parts.filter((part) => part.status === 'failed').length
  return {
    chapterCount: state.chapters.length,
    partCount: state.parts.length,
    extracted,
    failed,
    pending: state.parts.length - extracted,
    merged: state.bibleHash !== null,
  }
}
