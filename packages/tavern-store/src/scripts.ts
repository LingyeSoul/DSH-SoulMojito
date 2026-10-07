/**
 * Script Play 剧本库（提案 0014 P1）：导入 TXT/MD 素材为「剧本」，按段落聚合成
 * 块，供人物卡一对一绑定后分段注入 ST 生成链路。
 *
 * ```text
 * tavern/
 * └── scripts/<name>/script.json   # { name, source: {format, importedAt}, chunks: [{index, text}] }
 * ```
 *
 * 绑定不在剧本上——卡 `data.extensions.agentTavern.scriptId` 持有绑定（flizzywine
 * 语义一对一：一张卡同时最多绑一个剧本）；进度在
 * `chat.header.chat_metadata.scriptProgress`，由生成链路的对齐推进写（提案 0014 §2）。
 *
 * 纯函数（分块 / 对齐判定 / 注入块格式化 / 元数据规整）与 IO 函数（导入 / 列表 /
 * 读取 / 绑定写卡）同居本文件；写操作原子（tmp + rename），对齐 store.ts 约定。
 * Node-only（插件 Node half 使用）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { CharacterCardIR } from '@dsh-tavern/format'

export type ScriptFormat = 'txt' | 'md'

export interface ScriptChunk {
  index: number
  text: string
}

export interface ScriptSource {
  format: ScriptFormat
  importedAt: string
}

export interface ScriptRecord {
  name: string
  source: ScriptSource
  chunks: ScriptChunk[]
}

export interface ScriptSummary {
  name: string
  format: ScriptFormat
  importedAt: string
  chunkCount: number
  totalCharacters: number
}

export interface ScriptProgress {
  scriptName: string
  chunkIndex: number
  alignedAt: string
}

/** 分块目标 ~1200 字符/块；硬上限 2000（超长段落按句读边界回切，找不到则硬切）。 */
export const SCRIPT_CHUNK_TARGET = 1200
export const SCRIPT_CHUNK_HARD_MAX = 2000

/** 注入块预算：定位说明 + 当前块全文 + 下一块前 600 字符，总长 ≤2400。 */
export const SCRIPT_BLOCK_BUDGET = 2400
export const SCRIPT_NEXT_PREVIEW = 600

/** 对齐覆盖率阈值：最近助手楼层覆盖当前块区分性词元的比例 ≥0.35 判定对齐。 */
export const SCRIPT_ADVANCE_COVERAGE = 0.35

/** 段落分隔（聚合块内段落用），与 novel.ts 正文序列化的约定一致。 */
const PARAGRAPH_SEPARATOR = '\n\n'

/** 剧本块内出现 ≥3 次的词视为高频非区分性词，不参与对齐判定。 */
const HIGH_FREQUENCY_THRESHOLD = 3

/** 词元口径：小写化后 \p{L}\p{N} 连续段且长度 ≥2。 */
const TOKEN_PATTERN = /[\p{L}\p{N}]{2,}/gu

/* ------------------------------ 纯函数 ------------------------------ */

/**
 * 内容按段落聚合分块：空行分隔的段落为最小单元，贪心聚合到 ≥1200 字符即成块；
 * 单块不超过 2000（超限先封块再开新块，超长段落先按句读边界回切）。空白段落
 * 丢弃；全空白内容返回空数组（导入侧据此拒绝）。
 */
export function chunkScriptText(content: string): string[] {
  const units: string[] = []
  for (const paragraph of content.split(/\n[ \t]*\n+/)) {
    const trimmed = paragraph.trim()
    if (trimmed !== '') {
      units.push(...(trimmed.length <= SCRIPT_CHUNK_HARD_MAX ? [trimmed] : splitOversizedParagraph(trimmed)))
    }
  }
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    if (current === '') {
      current = unit
    } else if (current.length + PARAGRAPH_SEPARATOR.length + unit.length <= SCRIPT_CHUNK_HARD_MAX) {
      current += PARAGRAPH_SEPARATOR + unit
    } else {
      chunks.push(current)
      current = unit
    }
    if (current.length >= SCRIPT_CHUNK_TARGET) {
      chunks.push(current)
      current = ''
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** 超长段落的硬切分：优先句读边界（。！？；… 及 ". "），前 100 字符内找不到即硬切。 */
function splitOversizedParagraph(paragraph: string): string[] {
  const pieces: string[] = []
  let rest = paragraph
  while (rest.length > SCRIPT_CHUNK_HARD_MAX) {
    const window = rest.slice(0, SCRIPT_CHUNK_HARD_MAX)
    const boundary = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('!'),
      window.lastIndexOf('！'), window.lastIndexOf('?'), window.lastIndexOf('？'),
      window.lastIndexOf(';'), window.lastIndexOf('；'), window.lastIndexOf('\n'),
    )
    const cut = boundary >= 100 ? boundary + 1 : SCRIPT_CHUNK_HARD_MAX
    const piece = rest.slice(0, cut).trim()
    if (piece !== '') pieces.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? []
}

/**
 * 对齐推进判定（纯函数，提案 0014 §2 P1 启发式）：取 chunk 的区分性词元
 * （小写化、长度 ≥2 的 \p{L}\p{N} 词元，过滤在 chunk 内出现 ≥3 次的高频词），
 * 计算被 lastAssistantMes 覆盖的比例；≥0.35 判定对齐。区分性词元为空
 * （块太短或全是重复词）时永不推进——没有可对齐的信号。
 */
export function shouldAdvance(chunkText: string, lastAssistantMes: string): boolean {
  const counts = new Map<string, number>()
  for (const token of tokenize(chunkText)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const distinctive = [...counts.entries()]
    .filter(([, count]) => count < HIGH_FREQUENCY_THRESHOLD)
    .map(([token]) => token)
  if (distinctive.length === 0) return false
  const mesTokens = new Set(tokenize(lastAssistantMes))
  const covered = distinctive.filter((token) => mesTokens.has(token)).length
  return covered / distinctive.length >= SCRIPT_ADVANCE_COVERAGE
}

/**
 * 格式化为注入块：定位说明（参考不是约束，可偏离）+ 当前块全文 + 下一块前
 * 600 字符；总预算 ≤2400，超出截断当前块尾部并标注 truncated。越界下标返回
 * undefined（调用方跳过注入）。块是「参考不是跳章」：只有当前与下一块，没有
 * 更远的剧透。
 */
export function formatScriptBlock(chunks: readonly string[], chunkIndex: number): string | undefined {
  if (chunkIndex < 0 || chunkIndex >= chunks.length) return undefined
  const header = 'Script reference — the novel segment near the current plot position; the player may follow or deviate; this is reference, not a mandate.'
  const currentLabel = `Current segment ${chunkIndex + 1}/${chunks.length}:`
  const nextLabel = 'Next segment preview:'
  const next = chunks[chunkIndex + 1]?.slice(0, SCRIPT_NEXT_PREVIEW) ?? ''
  const head = `${header}\n\n${currentLabel}\n`
  const tail = next === '' ? '' : `\n\n${nextLabel}\n${next}`
  const truncationMarker = '\n[truncated]'
  const current = chunks[chunkIndex]!
  // 精确预算：bodyBudget 是扣除 head/tail 后当前块的可用长度；截断时连
  // truncated 标注一并计入，使总长恰好 ≤2400（下一块预览不被尾部硬切吃掉）。
  const bodyBudget = SCRIPT_BLOCK_BUDGET - head.length - tail.length
  const body = current.length <= bodyBudget
    ? current
    : `${current.slice(0, Math.max(0, bodyBudget - truncationMarker.length))}${truncationMarker}`
  return `${head}${body}${tail}`
}

/** 读取 chat_metadata.scriptProgress 的原始值，形状不合法（手改 jsonl 容错）返回 undefined。 */
export function normalizeScriptProgress(value: unknown): ScriptProgress | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { scriptName, chunkIndex, alignedAt } = value as Record<string, unknown>
  if (typeof scriptName !== 'string' || scriptName.trim() === '') return undefined
  if (!Number.isInteger(chunkIndex) || (chunkIndex as number) < 0) return undefined
  if (typeof alignedAt !== 'string' || alignedAt === '') return undefined
  return { scriptName, chunkIndex: chunkIndex as number, alignedAt }
}

/** 卡上绑定的剧本名（data.extensions.agentTavern.scriptId）；未绑定/形状非法 → undefined。 */
export function boundScriptOf(card: Pick<CharacterCardIR, 'data'> | undefined | null): string | undefined {
  const extensions = card?.data?.extensions
  if (typeof extensions !== 'object' || extensions === null) return undefined
  const agentTavern = extensions.agentTavern
  if (typeof agentTavern !== 'object' || agentTavern === null || Array.isArray(agentTavern)) return undefined
  const scriptId = (agentTavern as Record<string, unknown>).scriptId
  if (typeof scriptId !== 'string' || scriptId.trim() === '') return undefined
  return scriptId
}

/* ------------------------------ IO ------------------------------ */

/**
 * 导入剧本：内容分块后原子写 `<dir>/scripts/<name>/script.json`（重名覆盖，
 * 与 importCharacter 语义一致）。空内容（无任何非空段落）拒绝；format 缺省按
 * 名称后缀推断（.md → md，否则 txt）。dir 为 tavern root。
 */
export async function importScript(
  dir: string,
  name: string,
  content: string,
  format?: ScriptFormat,
): Promise<ScriptRecord> {
  const trimmedName = typeof name === 'string' ? name.trim() : ''
  if (trimmedName === '') throw new Error('script name is required and must be a non-empty string')
  if (typeof content !== 'string') throw new Error('script content must be a string')
  const resolvedFormat = format ?? (/\.md$/i.test(trimmedName) ? 'md' : 'txt')
  if (resolvedFormat !== 'txt' && resolvedFormat !== 'md') {
    throw new Error(`script format must be 'txt' or 'md' (got ${JSON.stringify(resolvedFormat)})`)
  }
  const chunks = chunkScriptText(content)
  if (chunks.length === 0) {
    throw new Error('script content is empty: no non-empty paragraphs to chunk')
  }
  const record: ScriptRecord = {
    name: trimmedName,
    source: { format: resolvedFormat, importedAt: new Date().toISOString() },
    chunks: chunks.map((text, index) => ({ index, text })),
  }
  const scriptDir = path.join(dir, 'scripts', safeScriptName(trimmedName))
  await fs.mkdir(scriptDir, { recursive: true })
  await writeAtomic(path.join(scriptDir, 'script.json'), jsonBytes(record))
  return record
}

/** 列出剧本库摘要（按名称排序）；缺 script.json 的目录是崩溃残留，跳过。 */
export async function listScripts(dir: string): Promise<ScriptSummary[]> {
  const root = path.join(dir, 'scripts')
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const summaries: ScriptSummary[] = []
  for (const entry of entries) {
    const record = await readScriptRecord(path.join(root, entry, 'script.json'))
    if (record === undefined) continue
    summaries.push({
      name: record.name,
      format: record.source.format,
      importedAt: record.source.importedAt,
      chunkCount: record.chunks.length,
      totalCharacters: record.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    })
  }
  return summaries.sort((left, right) => left.name.localeCompare(right.name))
}

/** 读取单个剧本（chunks 全量）；不存在返回 undefined，损坏文件抛错。 */
export async function getScript(dir: string, name: string): Promise<ScriptRecord | undefined> {
  return readScriptRecord(path.join(dir, 'scripts', safeScriptName(name), 'script.json'))
}

/**
 * 绑定/解绑写卡：设置或摘除 data.extensions.agentTavern.scriptId 后走
 * updateCharacter 落盘（保留原容器：PNG/CHARX 原样重编码）。解绑后 agentTavern
 * 变空则连键一并摘除，导出卡不携带空对象。返回写后的绑定值。
 */
export async function applyScriptBinding(
  store: Pick<import('./store.js').TavernStore, 'getCharacter' | 'updateCharacter'>,
  characterName: string,
  scriptName: string | undefined,
): Promise<string | undefined> {
  const file = await store.getCharacter(characterName)
  if (file === undefined) throw new Error(`character '${characterName}' not found`)
  const extensions: Record<string, unknown> = { ...file.card.data.extensions }
  const agentTavern = extensions.agentTavern
  const base = typeof agentTavern === 'object' && agentTavern !== null && !Array.isArray(agentTavern)
    ? { ...(agentTavern as Record<string, unknown>) }
    : {}
  if (scriptName === undefined) {
    delete base.scriptId
    if (Object.keys(base).length === 0) delete extensions.agentTavern
    else extensions.agentTavern = base
  } else {
    base.scriptId = scriptName
    extensions.agentTavern = base
  }
  await store.updateCharacter(characterName, {
    spec: file.card.spec,
    specVersion: file.card.specVersion,
    data: { ...file.card.data, extensions },
  })
  return scriptName
}

/* ------------------------------ 内部 ------------------------------ */

async function readScriptRecord(file: string): Promise<ScriptRecord | undefined> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(file)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<ScriptRecord> & { source?: Partial<ScriptSource> }
  if (typeof parsed.name !== 'string' || parsed.name === '') throw new Error(`corrupted script record: ${file}`)
  if (parsed.source === null || typeof parsed.source !== 'object'
    || (parsed.source.format !== 'txt' && parsed.source.format !== 'md')
    || typeof parsed.source.importedAt !== 'string') {
    throw new Error(`corrupted script record: ${file}`)
  }
  if (!Array.isArray(parsed.chunks)) throw new Error(`corrupted script record: ${file}`)
  return {
    name: parsed.name,
    source: { format: parsed.source.format, importedAt: parsed.source.importedAt },
    chunks: parsed.chunks.map((chunk, index) => ({
      index: typeof chunk?.index === 'number' ? chunk.index : index,
      text: typeof chunk?.text === 'string' ? chunk.text : '',
    })),
  }
}

function safeScriptName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '_unnamed'
}

function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  return fs.writeFile(tmp, bytes).then(() => fs.rename(tmp, file))
}

function jsonBytes(obj: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2), 'utf8'))
}
