import { describe, expect, it } from 'vitest'
import {
  IMPORT_PART_TARGET_MAX,
  IMPORT_PART_TARGET_MIN,
  NovelConfigError,
  buildImportDigest,
  normaliseImportBible,
  normaliseImportExtraction,
  parseImportedNovelText,
  validatePartTarget,
  type ImportExtraction,
  type NovelImportState,
} from '../src/index.js'

const CHINESE_BOOK = [
  '第一章 雾港',
  '',
  '雾从海面压进港口，灯塔只亮了一半。',
  '',
  '林舟把缆绳绕在桩上，听见远处有人喊他的名字。',
  '',
  '第二章 旧信',
  '',
  '那封信在抽屉里放了十年，纸角已经发黄。',
  '',
  '他读完最后一行，决定去北岸。',
].join('\n')

describe('imported-source parsing (proposal 0020 §3)', () => {
  it('detects Chinese chapter headings and keeps stable chapter/part ids', () => {
    const parsed = parseImportedNovelText({
      text: CHINESE_BOOK,
      format: 'txt',
      titleFallback: '雾港',
      partTargetCharacters: 2000,
    })
    expect(parsed.chapterSource).toBe('headings')
    expect(parsed.chapters).toHaveLength(2)
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['第一章 雾港', '第二章 旧信'])
    expect(parsed.chapters.map((chapter) => chapter.chapterId)).toEqual(['ich-1', 'ich-2'])
    expect(parsed.parts.map((part) => part.partId)).toEqual(['imp-1', 'imp-2'])
    expect(parsed.totalCharacters).toBeGreaterThan(0)
  })

  it('detects Markdown and English headings', () => {
    const markdown = parseImportedNovelText({
      text: '# One\n\nAlpha.\n\n## Two\n\nBeta.',
      format: 'md',
      titleFallback: 'Book',
      partTargetCharacters: 2000,
    })
    expect(markdown.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two'])
    const english = parseImportedNovelText({
      text: 'Chapter 1\n\nAlpha.\n\nChapter 2\n\nBeta.',
      format: 'txt',
      titleFallback: 'Book',
      partTargetCharacters: 2000,
    })
    expect(english.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2'])
  })

  it('falls back to pseudo chapters when no headings exist, then splits by length', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `段落${index + 1}：${'雾'.repeat(380)}`)
    const parsed = parseImportedNovelText({
      text: paragraphs.join('\n\n'),
      format: 'txt',
      titleFallback: '无题',
      partTargetCharacters: 2000,
    })
    expect(parsed.chapterSource).toBe('pseudo')
    expect(parsed.chapters.length).toBeGreaterThan(0)
    expect(parsed.parts.length).toBeGreaterThanOrEqual(2)
    for (const part of parsed.parts) {
      expect(part.effectiveCharacters).toBeLessThanOrEqual(2400)
    }
  })

  it('splits a single oversized paragraph at sentence boundaries', () => {
    const sentence = '风暴把屋顶掀开，雨水灌进走廊。'
    const parsed = parseImportedNovelText({
      text: sentence.repeat(300),
      format: 'txt',
      titleFallback: 'Storm',
      partTargetCharacters: 2000,
    })
    expect(parsed.parts.length).toBeGreaterThan(1)
    expect(parsed.parts.every((part) => part.effectiveCharacters > 0)).toBe(true)
  })

  it('rejects empty sources, empty prose and out-of-range part targets', () => {
    expect(() => parseImportedNovelText({ text: '   ', format: 'txt', titleFallback: 'x', partTargetCharacters: 2000 }))
      .toThrow(NovelConfigError)
    expect(() => parseImportedNovelText({ text: '\n\n', format: 'txt', titleFallback: 'x', partTargetCharacters: 2000 }))
      .toThrow(/imported source is empty/)
    expect(() => validatePartTarget(IMPORT_PART_TARGET_MIN - 1)).toThrow(NovelConfigError)
    expect(() => validatePartTarget(IMPORT_PART_TARGET_MAX + 1)).toThrow(NovelConfigError)
    expect(validatePartTarget(IMPORT_PART_TARGET_MIN)).toBe(IMPORT_PART_TARGET_MIN)
  })
})

describe('extraction and bible validation (proposal 0020 §4)', () => {
  const extraction = (name: string): ImportExtraction => ({
    partId: 'imp-1',
    chapterId: 'ich-1',
    summary: `${name} arrives at the fog harbour.`,
    timeline: [
      { order: 1, summary: 'A ship enters the harbour.', characters: [name], importance: 'major' },
      { order: 2, summary: 'The lamp flickers.', characters: [name], importance: 'minor' },
    ],
    characters: [{
      name,
      aliases: ['Captain'],
      role: 'protagonist',
      identity: 'harbour keeper',
      personality: 'quiet',
      appearance: 'salt-stained coat',
      motivation: 'find the missing letter',
      relationships: [{ name: 'Lin', relation: 'old friend' }],
      stateAtEnd: 'determined',
      confidence: 'high',
    }],
    worldEntries: [{
      title: 'Fog Harbour',
      keys: ['fog', 'harbour'],
      category: 'place',
      content: 'The harbour disappears under fog every winter.',
    }],
    openThreads: ['Who sent the letter?'],
    style: { pointOfView: 'third', tone: 'bleak', pacing: 'slow', proseNotes: 'sensory', dialogueStyle: 'terse' },
  })

  it('normalizes an extraction and enforces field caps', () => {
    const normalized = normaliseImportExtraction(extraction('Lin Zhou'), 'imp-1', 'ich-1')
    expect(normalized.characters[0]).toMatchObject({ name: 'Lin Zhou', aliases: ['Captain'] })
    expect(normalized.timeline[0]!.importance).toBe('major')
    expect(normalized.style.tone).toBe('bleak')
  })

  it('rejects malformed extraction shapes', () => {
    expect(() => normaliseImportExtraction({ summary: '' }, 'imp-1', 'ich-1')).toThrow(NovelConfigError)
    expect(() => normaliseImportExtraction({ summary: 'ok', timeline: 'nope' }, 'imp-1', 'ich-1')).toThrow(/timeline must be an array/)
  })

  it('validates a fused bible and derives merge counts', () => {
    const bible = normaliseImportBible({
      story: { premise: 'A fog-bound harbour', theme: 'memory', mainConflict: 'truth vs comfort', endingDirection: 'the letter is read', taboos: [] },
      timeline: extraction('Lin Zhou').timeline,
      characters: extraction('Lin Zhou').characters,
      worldEntries: extraction('Lin Zhou').worldEntries,
      styleNotes: 'bleak sensory prose',
      openThreads: ['Who sent the letter?'],
    })
    expect(bible.characters).toHaveLength(1)
    expect(bible.worldEntries).toHaveLength(1)
    expect(() => normaliseImportBible({ story: {}, timeline: [], characters: [], worldEntries: [], styleNotes: '', openThreads: [] })).toThrow(NovelConfigError)
  })

  it('builds a bounded digest with deduped characters and sampled summaries', () => {
    const parts = Array.from({ length: 10 }, (_, index) => ({
      partId: `imp-${index + 1}`,
      chapterId: 'ich-1',
      order: index + 1,
      effectiveCharacters: 100,
      contentHash: 'a'.repeat(64),
      status: 'extracted' as const,
      attempts: 1,
      extractionHash: 'b'.repeat(64),
      summary: `summary ${index + 1}`,
      error: null,
    }))
    const state: NovelImportState = {
      sourceName: 'Fog',
      sourceFormat: 'txt',
      importedAt: new Date(0).toISOString(),
      totalCharacters: 1000,
      partTargetCharacters: 2000,
      chapterSource: 'headings',
      chapters: [{
        chapterId: 'ich-1', order: 1, title: 'Fog Harbour', effectiveCharacters: 1000, partIds: parts.map((part) => part.partId),
      }],
      parts,
      bibleHash: null,
      bibleSummary: null,
    }
    const extractions = parts.map((part, index) => ({
      ...extraction('Lin Zhou'),
      partId: part.partId,
      summary: `summary ${index + 1}`,
    }))
    const digest = buildImportDigest({ state, extractions, sourceTail: 'tail' })
    expect(digest.source.partCount).toBe(10)
    expect(digest.source.extractedParts).toBe(10)
    expect(digest.characters).toHaveLength(1)
    expect(digest.characters[0]!.mentions).toBe(10)
    expect(digest.sampleSummaries.length).toBeLessThanOrEqual(36)
    expect(digest.sourceTail).toBe('tail')
  })

  it('hard-bounds the digest even when extractions carry huge character/world fields', () => {
    const parts = Array.from({ length: 40 }, (_, index) => ({
      partId: `imp-${index + 1}`,
      chapterId: 'ich-1',
      order: index + 1,
      effectiveCharacters: 100,
      contentHash: 'a'.repeat(64),
      status: 'extracted' as const,
      attempts: 1,
      extractionHash: 'b'.repeat(64),
      summary: `summary ${index + 1}`,
      error: null,
    }))
    const state: NovelImportState = {
      sourceName: 'Huge',
      sourceFormat: 'txt',
      importedAt: new Date(0).toISOString(),
      totalCharacters: 4000,
      partTargetCharacters: 2000,
      chapterSource: 'headings',
      chapters: [{ chapterId: 'ich-1', order: 1, title: 'One', effectiveCharacters: 4000, partIds: parts.map((part) => part.partId) }],
      parts,
      bibleHash: null,
      bibleSummary: null,
    }
    const long = '雾'.repeat(2000)
    const extractions = parts.map((part) => ({
      ...extraction('Lin Zhou'),
      partId: part.partId,
      characters: Array.from({ length: 10 }, (_, index) => ({
        ...extraction('Lin Zhou').characters[0]!,
        name: `角色${index}`,
        identity: long,
        personality: long,
        appearance: long,
        motivation: long,
        stateAtEnd: long,
      })),
      worldEntries: Array.from({ length: 10 }, (_, index) => ({
        title: `地点${index}`,
        keys: ['雾'],
        category: 'place',
        content: long,
      })),
    }))
    const digest = buildImportDigest({ state, extractions, sourceTail: '尾'.repeat(2400) })
    expect(Buffer.byteLength(JSON.stringify(digest), 'utf8')).toBeLessThanOrEqual(48 * 1024 + 64)
    expect(digest.truncated.characters).toBe(true)
    expect(digest.truncated.worldEntries).toBe(true)
  })
})
