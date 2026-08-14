/**
 * 条目归一化：填充 ST 默认值（newWorldInfoEntryDefinition）、解析内容 decorator、
 * 绑定书级上下文（书级 scanDepth/tokenBudget/recursiveScanning 回退）。
 */

import type {
  EntryPosition,
  EntryRole,
  GenerationTrigger,
  LoreEntry,
  Lorebook,
  NormalizedEntry,
  SecondaryLogic,
} from './types.js'
import { parseDecorators } from './decorators.js'

export const DEFAULT_ORDER = 100
export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100
export const DEFAULT_PROBABILITY = 100

/** 引擎内部扫描条目：归一化字段 + 书上下文 + 稳定排序索引。 */
export interface ScanEntry {
  readonly raw: NormalizedEntry
  readonly uid: number
  /** `${bookLabel}.${uid}`（ST `${world}.${uid}` 同构） */
  readonly entryId: string
  readonly bookIndex: number
  readonly bookLabel: string
  /** 书级 token 预算（null = 不限） */
  readonly bookBudget: number | null
  /** 书级递归开关（false = 本书条目不参与递归） */
  readonly bookRecursive: boolean
  readonly key: readonly string[]
  readonly keysecondary: readonly string[]
  /** decorator 剥离后的内容 */
  readonly content: string
  readonly decorators: readonly string[]
  readonly constant: boolean
  readonly disable: boolean
  readonly selective: boolean
  readonly selectiveLogic: SecondaryLogic
  readonly order: number
  readonly position: EntryPosition
  readonly ignoreBudget: boolean
  /** 书级 recursiveScanning=false 时并入 excludeRecursion 语义 */
  readonly excludeRecursion: boolean
  readonly preventRecursion: boolean
  /** true 归一为 1 */
  readonly delayUntilRecursion: number
  readonly probability: number
  readonly useProbability: boolean
  readonly depth: number
  readonly role: EntryRole
  readonly outletName: string
  readonly group: string
  readonly groupOverride: boolean
  readonly groupWeight: number
  readonly useGroupScoring: boolean | null
  readonly scanDepth: number | null
  readonly caseSensitive: boolean | null
  readonly matchWholeWords: boolean | null
  readonly sticky: number | null
  readonly cooldown: number | null
  readonly delay: number | null
  readonly triggers: readonly GenerationTrigger[]
  readonly matchPersonaDescription: boolean
  readonly matchCharacterDescription: boolean
  readonly matchCharacterPersonality: boolean
  readonly matchCharacterDepthPrompt: boolean
  readonly matchScenario: boolean
  readonly matchCreatorNotes: boolean
  /** 候选稳定序（order DESC, uid ASC, bookIndex ASC, 声明序 ASC）中的位置 */
  readonly candidateIndex: number
}

/** 书级默认扫描深度：条目 null 时回退书，再回退全局。 */
export interface BookRef {
  readonly index: number
  readonly label: string
  readonly budget: number | null
  readonly recursive: boolean
  readonly scanDepth: number | null
}

export function bookRef(book: Lorebook, index: number): BookRef {
  const label = book.name && book.name.length > 0 ? book.name : `#${index}`
  return {
    index,
    label,
    budget: typeof book.tokenBudget === 'number' && book.tokenBudget > 0 ? book.tokenBudget : null,
    recursive: book.recursiveScanning !== false,
    scanDepth: typeof book.scanDepth === 'number' && book.scanDepth >= 0 ? book.scanDepth : null,
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

/** 填充默认值，未知字段原样保留在顶层（结果透传）。 */
export function normalizeEntry(raw: LoreEntry): NormalizedEntry {
  const normalized: Record<string, unknown> = { ...raw }
  normalized['uid'] = num(raw['uid'], NaN)
  normalized['key'] = strArray(raw['key'])
  normalized['keysecondary'] = strArray(raw['keysecondary'])
  normalized['comment'] = str(raw['comment'], '')
  normalized['content'] = str(raw['content'], '')
  normalized['constant'] = bool(raw['constant'], false)
  normalized['vectorized'] = bool(raw['vectorized'], false)
  normalized['selective'] = bool(raw['selective'], true)
  normalized['selectiveLogic'] = num(raw['selectiveLogic'], 0) as SecondaryLogic
  normalized['addMemo'] = bool(raw['addMemo'], false)
  normalized['order'] = num(raw['order'], DEFAULT_ORDER)
  normalized['position'] = num(raw['position'], 0) as EntryPosition
  normalized['disable'] = bool(raw['disable'], false)
  normalized['ignoreBudget'] = bool(raw['ignoreBudget'], false)
  normalized['excludeRecursion'] = bool(raw['excludeRecursion'], false)
  normalized['preventRecursion'] = bool(raw['preventRecursion'], false)
  normalized['delayUntilRecursion'] =
    raw['delayUntilRecursion'] === true ? 1 : num(raw['delayUntilRecursion'], 0)
  normalized['matchPersonaDescription'] = bool(raw['matchPersonaDescription'], false)
  normalized['matchCharacterDescription'] = bool(raw['matchCharacterDescription'], false)
  normalized['matchCharacterPersonality'] = bool(raw['matchCharacterPersonality'], false)
  normalized['matchCharacterDepthPrompt'] = bool(raw['matchCharacterDepthPrompt'], false)
  normalized['matchScenario'] = bool(raw['matchScenario'], false)
  normalized['matchCreatorNotes'] = bool(raw['matchCreatorNotes'], false)
  normalized['probability'] = num(raw['probability'], DEFAULT_PROBABILITY)
  normalized['useProbability'] = bool(raw['useProbability'], true)
  normalized['depth'] = num(raw['depth'], DEFAULT_DEPTH)
  normalized['outletName'] = str(raw['outletName'], '')
  normalized['group'] = str(raw['group'], '')
  normalized['groupOverride'] = bool(raw['groupOverride'], false)
  normalized['groupWeight'] = num(raw['groupWeight'], DEFAULT_WEIGHT)
  normalized['scanDepth'] =
    typeof raw['scanDepth'] === 'number' && Number.isFinite(raw['scanDepth']) ? raw['scanDepth'] : null
  normalized['caseSensitive'] = typeof raw['caseSensitive'] === 'boolean' ? raw['caseSensitive'] : null
  normalized['matchWholeWords'] =
    typeof raw['matchWholeWords'] === 'boolean' ? raw['matchWholeWords'] : null
  normalized['useGroupScoring'] =
    typeof raw['useGroupScoring'] === 'boolean' ? raw['useGroupScoring'] : null
  normalized['automationId'] = str(raw['automationId'], '')
  normalized['role'] = num(raw['role'], 0) as EntryRole
  normalized['sticky'] =
    typeof raw['sticky'] === 'number' && Number.isFinite(raw['sticky']) ? raw['sticky'] : null
  normalized['cooldown'] =
    typeof raw['cooldown'] === 'number' && Number.isFinite(raw['cooldown']) ? raw['cooldown'] : null
  normalized['delay'] =
    typeof raw['delay'] === 'number' && Number.isFinite(raw['delay']) ? raw['delay'] : null
  normalized['characterFilterNames'] = strArray(raw['characterFilterNames'])
  normalized['characterFilterTags'] = strArray(raw['characterFilterTags'])
  normalized['characterFilterExclude'] = bool(raw['characterFilterExclude'], false)
  const triggers = strArray(raw['triggers']) as GenerationTrigger[]
  normalized['triggers'] = triggers
  return normalized as unknown as NormalizedEntry
}

/** 归一化条目 + 书上下文 → 扫描条目。 */
export function toScanEntry(normalized: NormalizedEntry, book: BookRef): Omit<ScanEntry, 'candidateIndex'> {
  const [decorators, content] = parseDecorators(normalized.content ?? '')
  return {
    raw: normalized,
    uid: normalized.uid,
    entryId: `${book.label}.${normalized.uid}`,
    bookIndex: book.index,
    bookLabel: book.label,
    bookBudget: book.budget,
    bookRecursive: book.recursive,
    key: normalized.key ?? [],
    keysecondary: normalized.keysecondary ?? [],
    content,
    decorators,
    constant: normalized.constant ?? false,
    disable: normalized.disable ?? false,
    selective: normalized.selective ?? true,
    selectiveLogic: normalized.selectiveLogic ?? 0,
    order: normalized.order ?? DEFAULT_ORDER,
    position: normalized.position ?? 0,
    ignoreBudget: normalized.ignoreBudget ?? false,
    excludeRecursion: (normalized.excludeRecursion ?? false) || !book.recursive,
    preventRecursion: (normalized.preventRecursion ?? false) || !book.recursive,
    delayUntilRecursion:
      normalized.delayUntilRecursion === true
        ? 1
        : typeof normalized.delayUntilRecursion === 'number'
          ? normalized.delayUntilRecursion
          : 0,
    probability: normalized.probability ?? DEFAULT_PROBABILITY,
    useProbability: normalized.useProbability ?? true,
    depth: normalized.depth ?? DEFAULT_DEPTH,
    role: normalized.role ?? 0,
    outletName: normalized.outletName ?? '',
    group: normalized.group ?? '',
    groupOverride: normalized.groupOverride ?? false,
    groupWeight: normalized.groupWeight ?? DEFAULT_WEIGHT,
    useGroupScoring: normalized.useGroupScoring ?? null,
    scanDepth: normalized.scanDepth ?? book.scanDepth,
    caseSensitive: normalized.caseSensitive ?? null,
    matchWholeWords: normalized.matchWholeWords ?? null,
    sticky: normalized.sticky ?? null,
    cooldown: normalized.cooldown ?? null,
    delay: normalized.delay ?? null,
    triggers: normalized.triggers ?? [],
    matchPersonaDescription: normalized.matchPersonaDescription ?? false,
    matchCharacterDescription: normalized.matchCharacterDescription ?? false,
    matchCharacterPersonality: normalized.matchCharacterPersonality ?? false,
    matchCharacterDepthPrompt: normalized.matchCharacterDepthPrompt ?? false,
    matchScenario: normalized.matchScenario ?? false,
    matchCreatorNotes: normalized.matchCreatorNotes ?? false,
  }
}

/**
 * 候选稳定序：order 降序（ST sortFn `b.order - a.order`），同 order 按 uid 升序、
 * 再按书序、声明序。ST 原生同 order 时保持来源分层（chat→persona→global/char），
 * 此处按确定性要求改用 uid 升序为次键（见设计决策报告）。
 */
export function sortCandidates(entries: ScanEntry[]): ScanEntry[] {
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byOrder = b.entry.order - a.entry.order
      if (byOrder !== 0) return byOrder
      const byUid = a.entry.uid - b.entry.uid
      if (byUid !== 0) return byUid
      return a.index - b.index
    })
    .map((pair, index) => ({ ...pair.entry, candidateIndex: index }))
}
