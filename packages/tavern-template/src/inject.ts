/**
 * 特殊世界书条目：分类（标题标签 + 内容装饰器）与应用
 * （GENERATE/RENDER 内容注入、@INJECT 整消息插队、InitialVariables 变量树）。
 *
 * 语义对照 ST-Prompt-Template docs/features.md（clean-room，不复制源码）。
 */

import { isObjectLike, type JsonObject } from './paths.js'
import { parseYamlSubset } from './yaml.js'
import { evalExpressionSandboxed } from './runtime.js'

/** 消息视图（pipeline LlmMessage 的结构子集）。 */
export interface TemplateMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type RenderText = (text: string, extraEnv?: Record<string, unknown>) => Promise<string>

export type Warn = (message: string) => void

/* ------------------------------ 分类 ------------------------------ */

export type SpecialKind =
  | 'generate-before'
  | 'generate-after'
  | 'generate-idx-before'
  | 'generate-idx-after'
  | 'generate-regex'
  | 'render-before'
  | 'render-after'
  | 'inject'
  | 'initial'

export interface SpecialEntry {
  kind: SpecialKind
  /** generate-idx 的 0 基下标；generate-regex 的模式；inject 的原始参数串。 */
  arg?: string
  book: string
  uid: number
  comment: string
  /** 装饰器剥离后的内容。 */
  content: string
  order: number
  probability?: number
  useProbability?: boolean
  /** @@if 装饰器条件（求值 false 时条目跳过）。 */
  ifCondition?: string
  /** 宿主预渲染缓存（存在时跳过渲染，用于保证 prompt 顺序上的变量副作用次序）。 */
  renderedContent?: string
}

/** 标题（memo/comment）标签 → 特殊语义。 */
function classifyComment(comment: string): { kind: SpecialKind; arg?: string } | null {
  let m = /^\[GENERATE:BEFORE\]/.exec(comment)
  if (m) return { kind: 'generate-before' }
  m = /^\[GENERATE:AFTER\]/.exec(comment)
  if (m) return { kind: 'generate-after' }
  m = /^\[GENERATE:(-?\d+):(BEFORE|AFTER)\]/.exec(comment)
  if (m) return { kind: m[2] === 'BEFORE' ? 'generate-idx-before' : 'generate-idx-after', arg: m[1] }
  m = /^\[GENERATE:REGEX:(.*?)\]/.exec(comment)
  if (m && m[1] !== '') return { kind: 'generate-regex', arg: m[1] }
  m = /^\[RENDER:(BEFORE|AFTER)\]/.exec(comment)
  if (m) return { kind: m[1] === 'BEFORE' ? 'render-before' : 'render-after' }
  if (/^\[InitialVariables\]/.test(comment)) return { kind: 'initial' }
  m = /^@INJECT\b(.*)$/.exec(comment)
  if (m) return { kind: 'inject', arg: m[1]!.trim() }
  return null
}

const KNOWN_CONTENT_DECORATORS = new Set([
  '@@generate_before', '@@generate_after', '@@render_before', '@@render_after', '@@initial_variables',
])

export interface ClassifiedContent {
  special: { kind: SpecialKind; arg?: string } | null
  /** 装饰器剥离后的内容（@@if false 时 content 置空并由 excluded 标记）。 */
  content: string
  ifCondition?: string
  privateBlock: boolean
}

/**
 * 内容装饰器解析：首行起的 `@@` 行；已知模板装饰器生效，未知 `@@` 行丢弃
 * （对照 ST「未识别的 @@xxx 行被丢弃」），`@@@` 前缀整行按纯文本保留并停止解析。
 */
export function classifyContent(content: string): ClassifiedContent {
  const lines = content.split('\n')
  let special: { kind: SpecialKind; arg?: string } | null = null
  let ifCondition: string | undefined
  let privateBlock = false
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('@@')) break
    if (line.startsWith('@@@')) {
      // 转义行：去掉一个 @ 后按内容保留，装饰器区结束
      lines.splice(i, 1, line.slice(1))
      const result: ClassifiedContent = { special, content: lines.join('\n'), privateBlock }
      if (ifCondition !== undefined) result.ifCondition = ifCondition
      return result
    }
    const [name, ...rest] = line.split(/\s+/)
    const arg = rest.join(' ')
    switch (name) {
      case '@@generate_before': special ??= { kind: 'generate-before' }; break
      case '@@generate_after': special ??= { kind: 'generate-after' }; break
      case '@@render_before': special ??= { kind: 'render-before' }; break
      case '@@render_after': special ??= { kind: 'render-after' }; break
      case '@@initial_variables': special ??= { kind: 'initial' }; break
      case '@@private': privateBlock = true; break
      case '@@if':
        if (arg !== '') ifCondition ??= arg
        break
      default:
        break // 未知装饰器丢弃（@@activate/@@dont_activate 由 lore 引擎另行消费）
    }
  }
  const body = lines.slice(i).join('\n')
  const result: ClassifiedContent = { special, content: privateBlock ? `<% { %>${body}<% } %>` : body, privateBlock }
  if (ifCondition !== undefined) result.ifCondition = ifCondition
  return result
}

/** 分类单条条目（标题优先，内容装饰器兜底）；非特殊条目返回 null。 */
export function classifySpecialEntry(entry: {
  comment?: string
  content: string
}): { kind: SpecialKind; arg?: string; content: string; ifCondition?: string } | null {
  const fromComment = entry.comment !== undefined ? classifyComment(entry.comment.trim()) : null
  const classified = classifyContent(entry.content ?? '')
  const kind = fromComment?.kind ?? classified.special?.kind
  if (kind === undefined) return null
  const arg = fromComment?.arg ?? classified.special?.arg
  const result: { kind: SpecialKind; arg?: string; content: string; ifCondition?: string } = {
    kind,
    content: classified.content,
  }
  if (arg !== undefined) result.arg = arg
  if (classified.ifCondition !== undefined) result.ifCondition = classified.ifCondition
  return result
}

/* ------------------------------ GENERATE ------------------------------ */

/**
 * 对装配后的消息应用 [GENERATE:*] 注入：
 * BEFORE/AFTER 首尾拼接、{idx} 定位拼接、REGEX 逐匹配消息前缀注入
 * （暴露 matched_message / matched_message_index / matched_message_role）。
 * 同一消息上的多个注入按 order 升序出现（before 组在原文前，after 组在原文后）。
 */
export async function applyGenerateInjections(
  messages: TemplateMessage[],
  entries: SpecialEntry[],
  render: RenderText,
  env: Record<string, unknown>,
  evaluateCondition: (condition: string) => Promise<boolean>,
  warn: Warn,
): Promise<TemplateMessage[]> {
  const out = messages.map((m) => ({ ...m }))
  const beforeTexts = new Map<number, string[]>()
  const afterTexts = new Map<number, string[]>()
  const pushText = (map: Map<number, string[]>, idx: number, text: string): void => {
    const list = map.get(idx) ?? []
    list.push(text)
    map.set(idx, list)
  }

  const ordered = [...entries].sort((a, b) => a.order - b.order || a.uid - b.uid)
  for (const entry of ordered) {
    if (entry.useProbability && entry.probability !== undefined && Math.random() * 100 >= entry.probability) continue
    if (entry.kind === 'generate-before') {
      const text = await renderChecked(entry, render, env, evaluateCondition, warn)
      if (text !== null) pushText(beforeTexts, 0, text)
      continue
    }
    if (entry.kind === 'generate-after') {
      const text = await renderChecked(entry, render, env, evaluateCondition, warn)
      if (text !== null && out.length > 0) pushText(afterTexts, out.length - 1, text)
      else if (text !== null) pushText(beforeTexts, 0, text)
      continue
    }
    if (entry.kind === 'generate-idx-before' || entry.kind === 'generate-idx-after') {
      const idx = resolveIndex(Number(entry.arg ?? '0'), out.length)
      if (idx === null) {
        warn(`[GENERATE:${entry.arg}] index out of range (${entry.book}#${entry.uid})`)
        continue
      }
      const text = await renderChecked(entry, render, env, evaluateCondition, warn)
      if (text === null) continue
      pushText(entry.kind === 'generate-idx-before' ? beforeTexts : afterTexts, idx, text)
      continue
    }
    if (entry.kind === 'generate-regex') {
      let re: RegExp
      try {
        re = new RegExp(entry.arg ?? '', 'i')
      } catch (err) {
        warn(`[GENERATE:REGEX] invalid pattern /${entry.arg}/: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      for (let i = 0; i < out.length; i++) {
        if (!re.test(out[i]!.content)) continue
        const text = await render(entry.content, {
          ...env,
          matched_message: out[i]!.content,
          matched_message_index: i,
          matched_message_role: out[i]!.role,
        })
        pushText(beforeTexts, i, text)
      }
    }
  }

  for (let i = 0; i < out.length; i++) {
    const before = beforeTexts.get(i)
    const after = afterTexts.get(i)
    if (before === undefined && after === undefined) continue
    const parts = [...(before ?? []), out[i]!.content, ...(after ?? [])]
    out[i] = { ...out[i]!, content: parts.join('\n') }
  }
  return out
}

/** 条目渲染：@@if 条件短路 + 预渲染缓存直用 + 渲染失败告警并跳过（不中断生成）。 */
async function renderChecked(
  entry: SpecialEntry,
  render: RenderText,
  env: Record<string, unknown>,
  evaluateCondition: (condition: string) => Promise<boolean>,
  warn: Warn,
): Promise<string | null> {
  if (entry.ifCondition !== undefined && !(await evaluateCondition(entry.ifCondition))) return null
  if (entry.renderedContent !== undefined) return entry.renderedContent
  try {
    return await render(entry.content, { ...env, world_info: { uid: entry.uid, world: entry.book, comment: entry.comment, content: entry.content } })
  } catch (err) {
    warn(`template entry ${entry.book}#${entry.uid} ("${entry.comment}") render failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/* ------------------------------ @INJECT ------------------------------ */

interface InjectInstruction {
  type: 'pos' | 'target' | 'regex'
  role: 'user' | 'assistant' | 'system'
  pos?: number
  target?: string
  targetIndex?: number
  at?: 'before' | 'after'
  regex?: string
  order: number
  entry: SpecialEntry
}

/** 引号感知的 `k=v, k=v` 参数拆分（值可带单/双引号，引号内逗号不分割）。 */
function splitParams(params: string): Array<{ key: string; value: string }> {
  const chunks: string[] = []
  let buf = ''
  let quote: '"' | "'" | undefined
  for (const ch of params) {
    if (quote !== undefined) {
      buf += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === ',') {
      chunks.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  chunks.push(buf)
  const out: Array<{ key: string; value: string }> = []
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=')
    if (eq <= 0) continue
    const key = chunk.slice(0, eq).trim()
    const raw = chunk.slice(eq + 1).trim()
    const unquoted = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw
    out.push({ key, value: unquoted })
  }
  return out
}

/** 解析 `@INJECT` 参数串（对照文档语法：pos / target+index+at / regex+at / role / order）。 */
export function parseInjectParams(
  params: string,
  entry: { order: number },
): { instruction: Omit<InjectInstruction, 'entry'>; warning?: string } | null {
  const kv = new Map(splitParams(params).map((p) => [p.key, p.value]))
  const roleRaw = kv.get('role')
  const role: 'user' | 'assistant' | 'system' =
    roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' ? roleRaw : 'system'
  const base = { role, order: entry.order }

  const pos = kv.get('pos')
  if (pos !== undefined && /^-?\d+$/.test(pos)) return { instruction: { ...base, type: 'pos', pos: Number(pos) } }

  const target = kv.get('target')
  if (target !== undefined) {
    const index = kv.get('index')
    const at = kv.get('at')
    return {
      instruction: {
        ...base,
        type: 'target',
        target,
        targetIndex: index !== undefined && /^-?\d+$/.test(index) ? Number(index) : 1,
        at: at === 'after' ? 'after' : 'before',
      },
    }
  }

  const regex = kv.get('regex')
  if (regex !== undefined) {
    if (regex === '') return { instruction: { ...base, type: 'regex', regex: '' }, warning: '@INJECT empty regex pattern' }
    const at = kv.get('at')
    return { instruction: { ...base, type: 'regex', regex, at: at === 'after' ? 'after' : 'before' } }
  }
  return null
}

/**
 * 对装配后的消息应用 @INJECT 整消息插队（文档语义）：
 * pos 1 起算（0 = 开头，负数从尾）；target 按 role 第 N 条（负数从尾）± at；
 * regex 首个匹配消息 ± at。同位排序：位置从后往前插、order 升序出现、
 * pos > target > regex 类型优先；regex 批次在位置批次之后。
 */
export async function applyInjectEntries(
  messages: TemplateMessage[],
  entries: SpecialEntry[],
  render: RenderText,
  env: Record<string, unknown>,
  evaluateCondition: (condition: string) => Promise<boolean>,
  warn: Warn,
): Promise<TemplateMessage[]> {
  const out = messages.map((m) => ({ ...m }))
  const instructions: Array<{ instruction: InjectInstruction; content: string }> = []

  for (const entry of entries) {
    if (entry.useProbability && entry.probability !== undefined && Math.random() * 100 >= entry.probability) continue
    if (entry.arg === undefined || entry.arg === '') {
      warn(`@INJECT entry ${entry.book}#${entry.uid} ("${entry.comment}") has no parameters`)
      continue
    }
    const parsed = parseInjectParams(entry.arg, entry)
    if (!parsed) {
      warn(`@INJECT entry ${entry.book}#${entry.uid} ("${entry.comment}") has invalid parameters: "${entry.arg}"`)
      continue
    }
    if (entry.ifCondition !== undefined && !(await evaluateCondition(entry.ifCondition))) continue
    let content: string
    try {
      content = await render(entry.content, { ...env, world_info: { uid: entry.uid, world: entry.book, comment: entry.comment, content: entry.content } })
    } catch (err) {
      warn(`@INJECT entry ${entry.book}#${entry.uid} render failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (content.trim() === '') continue
    if (parsed.warning) warn(parsed.warning)
    instructions.push({ instruction: { ...parsed.instruction, entry }, content })
  }
  if (instructions.length === 0) return out

  // 角色序号索引（1 基，负数从尾）
  const roleIndex = (role: string, occurrence: number): number | null => {
    const indices = out.map((m, i) => (m.role === role ? i : -1)).filter((i) => i >= 0)
    const n = occurrence < 0 ? indices.length + occurrence + 1 : occurrence
    const idx = indices[n - 1]
    return idx === undefined ? null : idx
  }

  const positionBased: Array<{ insertAt: number; order: number; typeRank: number; content: string; role: InjectInstruction['role'] }> = []
  for (const { instruction, content } of instructions) {
    if (instruction.type === 'pos') {
      const pos = instruction.pos ?? 1
      const insertAt = pos === 0 ? 0 : pos > 0 ? pos - 1 : Math.max(0, out.length + pos)
      positionBased.push({ insertAt, order: instruction.order, typeRank: 0, content, role: instruction.role })
    } else if (instruction.type === 'target') {
      const idx = roleIndex(instruction.target ?? 'user', instruction.targetIndex ?? 1)
      if (idx === null) {
        warn(`@INJECT target=${instruction.target}[${instruction.targetIndex}] not found (${instruction.entry.book}#${instruction.entry.uid})`)
        continue
      }
      const insertAt = instruction.at === 'after' ? idx + 1 : idx
      positionBased.push({ insertAt, order: instruction.order, typeRank: 1, content, role: instruction.role })
    }
  }
  // 从后往前插；同位：order 降序 + typeRank 降序（pos 最后插 = 最前出现）
  positionBased.sort((a, b) =>
    b.insertAt - a.insertAt || b.order - a.order || b.typeRank - a.typeRank)
  for (const item of positionBased) {
    out.splice(Math.min(item.insertAt, out.length), 0, { role: item.role, content: item.content })
  }

  const regexBased = instructions
    .filter((x) => x.instruction.type === 'regex')
    .map((x) => ({ ...x, instruction: x.instruction as InjectInstruction & { type: 'regex'; regex: string; at: 'before' | 'after' } }))
  const regexQueue: Array<{ insertAt: number; order: number; content: string; role: InjectInstruction['role'] }> = []
  for (const { instruction, content } of regexBased) {
    let re: RegExp
    try {
      re = new RegExp(instruction.regex, 'i')
    } catch (err) {
      warn(`@INJECT invalid regex /${instruction.regex}/: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const matchIdx = out.findIndex((m) => re.test(m.content))
    if (matchIdx === -1) {
      warn(`@INJECT regex /${instruction.regex}/ matched no message (${instruction.entry.book}#${instruction.entry.uid})`)
      continue
    }
    regexQueue.push({
      insertAt: instruction.at === 'after' ? matchIdx + 1 : matchIdx,
      order: instruction.order,
      content,
      role: instruction.role,
    })
  }
  regexQueue.sort((a, b) => b.insertAt - a.insertAt || b.order - a.order)
  for (const item of regexQueue) {
    out.splice(Math.min(item.insertAt, out.length), 0, { role: item.role, content: item.content })
  }
  return out
}

/* ------------------------------ RENDER / InitialVariables ------------------------------ */

/** 对 LLM 输出应用 [RENDER:*] 前后缀（直接拼接，order 升序）。 */
export async function applyRenderInjections(
  text: string,
  entries: SpecialEntry[],
  render: RenderText,
  env: Record<string, unknown>,
  evaluateCondition: (condition: string) => Promise<boolean>,
  warn: Warn,
): Promise<string> {
  const ordered = [...entries].sort((a, b) => a.order - b.order || a.uid - b.uid)
  let prefix = ''
  let suffix = ''
  for (const entry of ordered) {
    if (entry.useProbability && entry.probability !== undefined && Math.random() * 100 >= entry.probability) continue
    if (entry.kind !== 'render-before' && entry.kind !== 'render-after') continue
    if (entry.ifCondition !== undefined && !(await evaluateCondition(entry.ifCondition))) continue
    try {
      const rendered = await render(entry.content, { ...env, world_info: { uid: entry.uid, world: entry.book, comment: entry.comment, content: entry.content } })
      if (entry.kind === 'render-before') prefix += rendered
      else suffix += rendered
    } catch (err) {
      warn(`[RENDER] entry ${entry.book}#${entry.uid} render failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return `${prefix}${text}${suffix}`
}

/** 解析 InitialVariables 内容（JSON 优先，YAML 子集兜底）；失败返回 null。 */
export function parseInitialVariables(content: string, warn: Warn): JsonObject | null {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    try {
      data = parseYamlSubset(content)
    } catch {
      warn('[InitialVariables] content is neither valid JSON nor supported YAML subset')
      return null
    }
  }
  if (!isObjectLike(data)) {
    warn('[InitialVariables] parsed content is not an object')
    return null
  }
  return data
}

function resolveIndex(idx: number, length: number): number | null {
  const resolved = idx < 0 ? length + idx : idx
  if (resolved < 0 || resolved >= length) return null
  return resolved
}
