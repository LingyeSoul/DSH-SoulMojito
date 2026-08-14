/**
 * 世界书互转：ST 世界书文件（entries map 形态）↔ 卡内嵌 CharacterBook（数组形态）。
 * ST 语义：卡内嵌书导入时，规范字段映射到 ST 原生字段，ST 自有高级字段
 * （probability/depth/position 数字/selectiveLogic…）经 entries[].extensions 袋往返。
 */

import type { CharacterBook, CharacterBookEntry, LoreEntry, WorldBookIR } from './types.js'

export class WorldBookFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldBookFormatError'
  }
}

/* --------------------------- ST 文件形态 --------------------------- */

/** 解析 ST 世界书文件对象（{ entries: { [uid]: entry } }）。 */
export function parseWorldInfoFile(name: string, obj: Record<string, unknown>): WorldBookIR {
  const rawEntries = obj['entries']
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) {
    throw new WorldBookFormatError("world info file has no 'entries' object")
  }
  const entries: LoreEntry[] = []
  for (const value of Object.values(rawEntries)) {
    if (typeof value !== 'object' || value === null) continue
    entries.push(normalizeEntry(value as Record<string, unknown>))
  }
  entries.sort((a, b) => a.uid - b.uid)
  const { ['entries']: _dropped, ...extra } = obj
  return { name, entries, extra: Object.keys(extra).length > 0 ? (extra as Record<string, unknown>) : undefined }
}

/** 序列化为 ST 世界书文件对象（entries 为 uid 字符串 → 条目 map，按 uid 升序）。 */
export function serializeWorldInfoFile(ir: WorldBookIR): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  for (const entry of [...ir.entries].sort((a, b) => a.uid - b.uid)) {
    entries[String(entry.uid)] = entryToFileObject(entry)
  }
  return { ...(ir.extra ?? {}), entries }
}

/* -------------------------- 规范化 / 重建 -------------------------- */

const KNOWN_FIELDS = new Set([
  'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized',
  'selective', 'selectiveLogic', 'addMemo', 'order', 'position', 'disable',
  'ignoreBudget', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion',
  'probability', 'useProbability', 'depth', 'outletName', 'group', 'groupOverride',
  'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring',
  'automationId', 'role', 'sticky', 'cooldown', 'delay', 'triggers',
  'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
  'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'extra',
])

/** ST 文件条目 → LoreEntry（字段宽松归一，未知键进 extra 袋）。 */
export function normalizeEntry(raw: Record<string, unknown>): LoreEntry {
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(k)) extra[k] = v
  }
  return {
    uid: num(raw['uid'], 0),
    key: strArray(raw['key']),
    keysecondary: strArray(raw['keysecondary']),
    comment: str(raw['comment']),
    content: str(raw['content']),
    constant: bool(raw['constant'], false),
    vectorized: bool(raw['vectorized'], false),
    selective: bool(raw['selective'], true),
    selectiveLogic: num(raw['selectiveLogic'], 0),
    addMemo: bool(raw['addMemo'], false),
    order: num(raw['order'], 100),
    position: num(raw['position'], 0),
    disable: bool(raw['disable'], false),
    ignoreBudget: bool(raw['ignoreBudget'], false),
    excludeRecursion: bool(raw['excludeRecursion'], false),
    preventRecursion: bool(raw['preventRecursion'], false),
    delayUntilRecursion: num(raw['delayUntilRecursion'], 0),
    probability: num(raw['probability'], 100),
    useProbability: bool(raw['useProbability'], true),
    depth: num(raw['depth'], 4),
    outletName: str(raw['outletName']),
    group: str(raw['group']),
    groupOverride: bool(raw['groupOverride'], false),
    groupWeight: num(raw['groupWeight'], 100),
    scanDepth: nullableNum(raw['scanDepth']),
    caseSensitive: nullableBool(raw['caseSensitive']),
    matchWholeWords: nullableBool(raw['matchWholeWords']),
    useGroupScoring: nullableBool(raw['useGroupScoring']),
    automationId: str(raw['automationId']),
    role: num(raw['role'], 0),
    sticky: nullableNum(raw['sticky']),
    cooldown: nullableNum(raw['cooldown']),
    delay: nullableNum(raw['delay']),
    triggers: strArray(raw['triggers']),
    matchPersonaDescription: bool(raw['matchPersonaDescription'], false),
    matchCharacterDescription: bool(raw['matchCharacterDescription'], false),
    matchCharacterPersonality: bool(raw['matchCharacterPersonality'], false),
    matchCharacterDepthPrompt: bool(raw['matchCharacterDepthPrompt'], false),
    matchScenario: bool(raw['matchScenario'], false),
    matchCreatorNotes: bool(raw['matchCreatorNotes'], false),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

/** LoreEntry → ST 文件条目对象（已知字段展开，extra 袋合入）。 */
export function entryToFileObject(entry: LoreEntry): Record<string, unknown> {
  const { extra, ...fields } = entry
  return { ...fields, ...(extra ?? {}) }
}

/* ------------------------ 卡内嵌书（规范形态） ------------------------ */

/** 解析卡内嵌 CharacterBook → WorldBookIR（book 字段映射 + extensions 袋恢复 ST 自有字段）。 */
export function parseCharacterBook(book: CharacterBook): WorldBookIR {
  const entries = (book.entries ?? []).map((raw, index) => bookEntryToLoreEntry(raw, index))
  return { name: book.name ?? '', entries }
}

/** ST 自有字段经 extensions 袋携带的键（char-data.js 写回卡内嵌书时的键名）。 */
const BOOK_EXT_ST_KEYS = new Set([
  'position', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion',
  'probability', 'useProbability', 'depth', 'selectiveLogic', 'group',
  'group_override', 'group_weight', 'prevent_recursion', 'scan_depth',
  'match_whole_words', 'use_group_scoring', 'case_sensitive', 'automation_id',
  'role', 'vectorized', 'display_index', 'delay', 'sticky', 'cooldown', 'triggers',
])

function bookEntryToLoreEntry(raw: CharacterBookEntry, index: number): LoreEntry {
  const ext = raw.extensions ?? {}
  // extensions 袋里的 ST 自有字段优先（ST 导出卡内嵌书时把自己的字段写进这里）
  const uid = numOr(raw.id, ext['uid'], index)
  const entry = normalizeEntry({
    uid,
    key: raw.keys ?? [],
    keysecondary: raw.secondary_keys ?? [],
    comment: raw.comment ?? raw.name ?? '',
    content: raw.content ?? '',
    constant: boolOr(raw.constant, ext['constant'], false),
    disable: raw.enabled === false,
    order: numOr(ext['order'], raw.insertion_order, 100),
    position: bookPositionToSt(raw.position, ext['position']),
    selective: boolOr(raw.selective, ext['selective'], true),
    selectiveLogic: num(ext['selectiveLogic'], 0),
    caseSensitive: nullableBoolOr(raw.case_sensitive, ext['case_sensitive']),
    probability: numOr(ext['probability'], 100, 100),
    useProbability: boolOr(ext['useProbability'], true, true),
    depth: numOr(ext['depth'], 4, 4),
    group: str(ext['group']),
    groupOverride: bool(ext['group_override'], false),
    groupWeight: numOr(ext['group_weight'], 100, 100),
    excludeRecursion: boolOr(ext['exclude_recursion'], false, false),
    preventRecursion: boolOr(ext['prevent_recursion'], false, false),
    delayUntilRecursion: numOr(ext['delay_until_recursion'], 0, 0),
    scanDepth: nullableNum(ext['scan_depth']),
    matchWholeWords: nullableBool(ext['match_whole_words']),
    useGroupScoring: nullableBool(ext['use_group_scoring']),
    role: num(ext['role'], 0),
    vectorized: bool(ext['vectorized'], false),
    sticky: nullableNum(ext['sticky']),
    cooldown: nullableNum(ext['cooldown']),
    delay: nullableNum(ext['delay']),
    triggers: strArray(ext['triggers']),
  })
  // 规范原生但未消费的字段（priority/use_regex 等）入 extra 保底往返
  const carried: Record<string, unknown> = {}
  if (raw.priority !== undefined) carried['book.priority'] = raw.priority
  if (raw.use_regex !== undefined) carried['book.use_regex'] = raw.use_regex
  if (raw.name !== undefined) carried['book.name'] = raw.name
  if (Object.keys(carried).length > 0) entry.extra = { ...(entry.extra ?? {}), ...carried }
  return entry
}

/** LoreEntry → 卡内嵌书条目（规范字段 + ST 自有字段写回 extensions 袋，对齐 ST 导出行为）。 */
export function loreEntryToBookEntry(entry: LoreEntry): CharacterBookEntry {
  const ext: Record<string, unknown> = {
    position: entry.position,
    exclude_recursion: entry.excludeRecursion,
    prevent_recursion: entry.preventRecursion,
    delay_until_recursion: entry.delayUntilRecursion,
    probability: entry.probability,
    useProbability: entry.useProbability,
    depth: entry.depth,
    selectiveLogic: entry.selectiveLogic,
    group: entry.group,
    group_override: entry.groupOverride,
    group_weight: entry.groupWeight,
    use_group_scoring: entry.useGroupScoring,
    case_sensitive: entry.caseSensitive,
    scan_depth: entry.scanDepth,
    match_whole_words: entry.matchWholeWords,
    automation_id: entry.automationId,
    role: entry.role,
    vectorized: entry.vectorized,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    triggers: entry.triggers,
    uid: entry.uid,
  }
  return {
    keys: entry.key,
    secondary_keys: entry.keysecondary,
    content: entry.content,
    enabled: !entry.disable,
    insertion_order: entry.order,
    case_sensitive: entry.caseSensitive ?? false,
    selective: entry.selective,
    constant: entry.constant,
    position: stPositionToBook(entry.position),
    id: entry.uid,
    comment: entry.comment,
    extensions: ext,
  }
}

/** WorldBookIR → 卡内嵌 CharacterBook。 */
export function toCharacterBook(ir: WorldBookIR): CharacterBook {
  return {
    name: ir.name,
    entries: ir.entries.map(loreEntryToBookEntry),
  }
}

function bookPositionToSt(bookPos: unknown, extPos: unknown): number {
  if (typeof extPos === 'number') return extPos
  if (bookPos === 'after_char') return 1
  return 0
}

function stPositionToBook(position: number): 'before_char' | 'after_char' {
  // 规范只定义 before/after；ST 的其余位置（AN/@D/EM/outlet）语义存于 extensions.position
  return position === 1 ? 'after_char' : 'before_char'
}

/* ------------------------------ 小工具 ------------------------------ */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function numOr(v: unknown, v2: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : num(v2, fallback)
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function boolOr(v: unknown, v2: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : bool(v2, fallback)
}

function nullableBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function nullableBoolOr(v: unknown, v2: unknown): boolean | null {
  return typeof v === 'boolean' ? v : nullableBool(v2)
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
