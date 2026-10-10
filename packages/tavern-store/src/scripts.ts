/**
 * Script Play 剧本库（提案 0014 P1/P2）：导入 TXT/MD/EPUB 素材为「剧本」，按段落
 * 聚合成块，供人物卡一对一绑定后分段注入 ST 生成链路。
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
import { writeAtomicBytes } from './fs-atomic.js'
import { unzipSync, strFromU8 } from 'fflate'
import type { CharacterCardIR } from '@dsh-tavern/format'

export type ScriptFormat = 'txt' | 'md' | 'epub'

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
  /** 最近一次显式推进（tavern_script_advance）附带的备注，≤200 字符（P2）。 */
  lastNote?: string
}

/** 分块目标 ~1200 字符/块；硬上限 2000（超长段落按句读边界回切，找不到则硬切）。 */
export const SCRIPT_CHUNK_TARGET = 1200
export const SCRIPT_CHUNK_HARD_MAX = 2000

/** 注入块预算：定位说明 + 当前块全文 + 下一块前 600 字符，总长 ≤2400。 */
export const SCRIPT_BLOCK_BUDGET = 2400
export const SCRIPT_NEXT_PREVIEW = 600

/** 对齐覆盖率阈值：最近助手楼层覆盖当前块区分性词元的比例 ≥0.35 判定对齐。 */
export const SCRIPT_ADVANCE_COVERAGE = 0.35

/** 对齐判定窗口：最近 N 条助手楼层（P2 加固，之前只看最近 1 条）。 */
export const SCRIPT_ADVANCE_WINDOW = 3

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

/** chunk 的区分性词元：小写化、长度 ≥2 的 \p{L}\p{N} 词元，过滤出现 ≥3 次的高频词。 */
function distinctiveTokensOf(chunkText: string): string[] {
  const counts = new Map<string, number>()
  for (const token of tokenize(chunkText)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count < HIGH_FREQUENCY_THRESHOLD)
    .map(([token]) => token)
}

/**
 * 对齐推进判定（纯函数，提案 0014 §2）：取 chunk 的区分性词元，计算被助手
 * 楼层覆盖的比例；单个楼层覆盖 ≥0.35 即判定对齐（P2 加固：从「最近 1 条」
 * 扩展为「最近 3 条助手楼层任一覆盖」——一个片段的关键事件常分散在连续几
 * 轮回复里，只盯最新一条会漏判）。兼容单条重载：传 string 等价于 [string]；
 * 数组取末尾 ≤3 条（旧楼层超出窗口不参与，防止早已覆盖的内容反复触发）。
 * 区分性词元为空（块太短或全是重复词）时永不推进——没有可对齐的信号。
 */
export function shouldAdvance(chunkText: string, assistantMessages: string | readonly string[]): boolean {
  const distinctive = distinctiveTokensOf(chunkText)
  if (distinctive.length === 0) return false
  const window = (typeof assistantMessages === 'string'
    ? [assistantMessages]
    : Array.isArray(assistantMessages) ? [...assistantMessages] : [])
    .filter((mes): mes is string => typeof mes === 'string')
    .slice(-SCRIPT_ADVANCE_WINDOW)
  return window.some((mes) => {
    const mesTokens = new Set(tokenize(mes))
    const covered = distinctive.filter((token) => mesTokens.has(token)).length
    return covered / distinctive.length >= SCRIPT_ADVANCE_COVERAGE
  })
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
  const { scriptName, chunkIndex, alignedAt, lastNote } = value as Record<string, unknown>
  if (typeof scriptName !== 'string' || scriptName.trim() === '') return undefined
  if (!Number.isInteger(chunkIndex) || (chunkIndex as number) < 0) return undefined
  if (typeof alignedAt !== 'string' || alignedAt === '') return undefined
  const note = typeof lastNote === 'string' && lastNote.trim() !== '' ? lastNote.trim().slice(0, 200) : undefined
  return { scriptName, chunkIndex: chunkIndex as number, alignedAt, ...(note !== undefined ? { lastNote: note } : {}) }
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

/* ------------------------------ EPUB ------------------------------ */

/**
 * 解析 EPUB（OCF 容器）为纯文本（提案 0014 P2）：fflate 解压 zip →
 * META-INF/container.xml 找 OPF → spine 顺序取 XHTML 文档 → 每文档剥标签抽
 * 正文（`<p>`/`<br>`/块级标签转换行，h1-h6 保留为独立行，XML 处理指令/注释/
 * head/script/style 丢弃，基本 HTML 实体集 + 数字实体的解码在剥标签**之后**
 * 做，`&lt;p&gt;` 这类被转义的标签不会误伤）→ 章与章之间空行拼接。
 *
 * 裁剪（§4 同款边界）：不做图片/CSS/脚注语义，不做标题启发式——h1-h6 文本
 * 原样保留为独立行；manifest item 无 media-type 时按 .xhtml/.html/.htm 后缀
 * 回落；spine 缺失时按 manifest 声明序取 XHTML。非法输入（非 zip 魔数 PK、
 * 解压失败、缺 container.xml/rootfile/OPF）抛错，由导入侧转为 400。
 */
export function parseEpubText(buffer: Uint8Array): string {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('not a valid EPUB: missing zip magic (PK)')
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buffer)
  } catch (cause) {
    throw new Error(`not a valid EPUB: corrupted zip (${String(cause)})`)
  }
  const container = files['META-INF/container.xml']
  if (container === undefined) throw new Error('not a valid EPUB: missing META-INF/container.xml')
  const opfPath = /<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]+)"/i.exec(strFromU8(container))?.[1]
  if (opfPath === undefined || opfPath.trim() === '') {
    throw new Error('not a valid EPUB: container.xml declares no rootfile full-path')
  }
  const opfBytes = files[opfPath]
  if (opfBytes === undefined) throw new Error(`not a valid EPUB: package document '${opfPath}' not found in zip`)
  const opfText = strFromU8(opfBytes)

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const manifest = new Map<string, { href: string; isXhtml: boolean }>()
  for (const match of opfText.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0]
    const id = /(?:\b|xml:)id\s*=\s*"([^"]*)"/i.exec(tag)?.[1]
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(tag)?.[1]
    if (id === undefined || id === '' || href === undefined) continue
    const mediaType = /\bmedia-type\s*=\s*"([^"]*)"/i.exec(tag)?.[1]
    const isXhtml = mediaType === 'application/xhtml+xml' || mediaType === 'text/html'
      || (mediaType === undefined && /\.(xhtml|html|htm)$/i.test(href))
    if (isXhtml) manifest.set(id, { href, isXhtml: true })
  }

  // spine 只取 <spine> 段内 itemref 的 idref 顺序（opfText 全文兜底防标签跨行）；
  // 非 XHTML 的 itemref（罕见：图片页）跳过；spine 为空时按 manifest 声明序回落。
  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opfText)?.[1] ?? ''
  const idrefs = [...spineBlock.matchAll(/<itemref\b[^>]*>/gi)]
    .map((match) => /\bidref\s*=\s*"([^"]*)"/i.exec(match[0])?.[1])
    .filter((idref): idref is string => idref !== undefined && idref !== '')
  const orderedHrefs = (idrefs.length > 0 ? idrefs : [...manifest.keys()])
    .map((idref) => manifest.get(idref))
    .filter((item): item is { href: string; isXhtml: boolean } => item !== undefined)
    .map((item) => resolveZipPath(opfDir, item.href))

  const chapters: string[] = []
  for (const href of orderedHrefs) {
    const doc = files[href]
    if (doc === undefined) continue
    const lines = extractXhtmlLines(strFromU8(doc))
    if (lines.length > 0) chapters.push(lines.join(PARAGRAPH_SEPARATOR))
  }
  return chapters.join(PARAGRAPH_SEPARATOR)
}

/** 剥标签抽取 XHTML 正文行：块级开/闭标签与 <br> 转换行（h1-h6 因此保留为独立行），
 *  其余标签剥离，head/script/style/注释/PI 整段丢弃；实体最后解码。 */
function extractXhtmlLines(xhtml: string): string[] {
  return xhtml
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi, ' ')
    .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|aside|header|footer|nav|figure|figcaption|blockquote|li|ul|ol|dl|dd|dt|tr|table|tbody|thead|pre|h[1-6]|title)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeHtmlEntities(line.replace(/[ \t\u00a0]+/g, ' ')).trim())
    .filter((line) => line !== '')
}

/** 基本实体集解码：&lt; &gt; &quot; &#39; &apos; &nbsp; 与数字实体（十/十六进制）；
 *  &amp; 最后解，避免 `&amp;lt;` 被二次解码成 `<`。&nbsp; 归一为普通空格。 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/** OPF href 相对 OPF 目录解析为 zip 内路径：percent-decode + '.'/'..' 归一。 */
function resolveZipPath(opfDir: string, href: string): string {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // 保留原始 href：非法 percent 序列不致命，直接按字面找
  }
  const stack: string[] = []
  for (const part of [...opfDir.split('/'), ...decoded.split('/')]) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/* ------------------------------ IO ------------------------------ */

/**
 * 导入剧本：内容分块后原子写 `<dir>/scripts/<name>/script.json`（重名覆盖，
 * 与 importCharacter 语义一致）。空内容（无任何非空段落）拒绝；format 缺省按
 * 名称后缀推断（.md → md，否则 txt）。EPUB（P2）：传 Uint8Array/Buffer 字节
 * 且 format 为 'epub'（字节内容隐含 epub）——先经 parseEpubText 解出纯文本
 * 再走同一分块管线；字符串内容配 format 'epub' 是调用方错误（路由层应先
 * base64 解码）。dir 为 tavern root。
 */
export async function importScript(
  dir: string,
  name: string,
  content: string | Uint8Array,
  format?: ScriptFormat,
): Promise<ScriptRecord> {
  const trimmedName = typeof name === 'string' ? name.trim() : ''
  if (trimmedName === '') throw new Error('script name is required and must be a non-empty string')
  const isBinary = typeof content !== 'string'
  if (isBinary && !(content instanceof Uint8Array)) {
    throw new Error('script content must be a string or Uint8Array/Buffer')
  }
  if (isBinary && format !== undefined && format !== 'epub') {
    throw new Error(`binary content requires format 'epub' (got ${JSON.stringify(format)})`)
  }
  if (!isBinary && format === 'epub') {
    throw new Error("format 'epub' requires binary content (Uint8Array/Buffer)")
  }
  const resolvedFormat = isBinary
    ? 'epub'
    : format ?? (/\.md$/i.test(trimmedName) ? 'md' : 'txt')
  if (resolvedFormat !== 'txt' && resolvedFormat !== 'md' && resolvedFormat !== 'epub') {
    throw new Error(`script format must be one of 'txt', 'md' or 'epub' (got ${JSON.stringify(resolvedFormat)})`)
  }
  const text = isBinary ? parseEpubText(content) : content
  const chunks = chunkScriptText(text)
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
  await writeAtomicBytes(path.join(scriptDir, 'script.json'), jsonBytes(record))
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
    || (parsed.source.format !== 'txt' && parsed.source.format !== 'md' && parsed.source.format !== 'epub')
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

function jsonBytes(obj: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2), 'utf8'))
}
