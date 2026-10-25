/**
 * 模板环境 API（对照 ST-Prompt-Template reference 文档的函数/常量清单，
 * 适配到 dsh-soulmojito 的资产面；裁剪项见提案 0008 §1）。
 */

import { deepClone, deepMerge, getPath, isObjectLike, setPath, unsetPath, type JsonObject } from './paths.js'
import type { TemplateVariableSystem } from './variables.js'

/** 世界书条目视图（getwi / world_info）。 */
export interface TemplateWorldEntry {
  uid: number
  book: string
  comment?: string
  content: string
  order?: number
  disable?: boolean
}

/** 角色卡字段视图（getchar / getCharData）。 */
export interface TemplateCardFields {
  name: string
  systemPrompt: string
  personality: string
  description: string
  scenario: string
  firstMes: string
  mesExample: string
  creatorNotes: string
  depthPrompt: string
  avatar?: string
  /** getCharData 返回的原始数据。 */
  data: JsonObject
}

export interface TemplateChatMessage {
  name?: string
  mes: string
  is_user: boolean
  is_system: boolean
}

/** 宿主适配面：模板包不直接接触 store，全部经此接口取数。 */
export interface TemplateHost {
  runType: string
  userName: string
  charName: string
  chatId: string
  characterId?: string
  model?: string
  charAvatar?: string
  userAvatar?: string
  messages: TemplateChatMessage[]
  lastUserMessageId: number
  lastCharMessageId: number
  /** 按书名（可空 = 全部活动书）+ 标题（精确串）或 uid 检索条目。 */
  findWorldEntries(title: string | number, book?: string): TemplateWorldEntry[]
  getCard(name?: string | number): TemplateCardFields | null
  findPresetPrompt(name: string): { name: string; content: string } | null
  /** 条目渲染递归防护下的再入渲染（由 runtime 装配注入）。 */
  renderNested(source: string, extraEnv: Record<string, unknown>): Promise<string>
  onWarning?: (message: string) => void
}

export interface TemplateEnvOptions {
  vars: TemplateVariableSystem
  host: TemplateHost
  defines?: Record<string, unknown>
  /** getwi 递归深度共享计数（同一次生成内跨渲染累计）。 */
  getwiDepth?: { current: number }
}

/** getchar 默认输出模板（对照 reference 文档 DEFAULT_CHAR_DEFINE 的字段面）。 */
export const DEFAULT_CHAR_DEFINE = [
  '<% if (name) { %>',
  '<<%- name %>>',
  '<% if (system_prompt) { %>System: <%- system_prompt %><% } %>',
  'name: <%- name %>',
  '<% if (personality) { %>personality: <%- personality %><% } %>',
  '<% if (description) { %>description: <%- description %><% } %>',
  '<% if (message_example) { %>',
  'example:',
  '<%- message_example %>',
  '<% } %>',
  '<% if (depth_prompt) { %>System: <%- depth_prompt %><% } %>',
  '</<%- name %>>',
  '<% } %>',
].join('\n')

const MAX_GETWI_DEPTH = 8

export function createTemplateEnv(options: TemplateEnvOptions): Record<string, unknown> {
  const { vars, host, defines } = options
  const depth = options.getwiDepth ?? { current: 0 }

  const scopedVar = (scope: 'local' | 'global' | 'message') => ({
    get: (key: string | null, opt?: unknown) => vars.getVar(key, { ...(optAsRecord(opt)), scope }),
    set: (key: string | null, value: unknown, opt?: unknown) => vars.setVar(key, value, { ...optAsRecord(opt), scope }),
    inc: (key: string, value = 1, opt?: unknown) => vars.incDecVar(key, value, { ...optAsRecord(opt), outscope: scope }, 1),
    dec: (key: string, value = 1, opt?: unknown) => vars.incDecVar(key, value, { ...optAsRecord(opt), outscope: scope }, -1),
    del: (key: string, index?: string | number, opt?: unknown) => vars.delVar(key, index, { ...optAsRecord(opt), scope }),
    ins: (key: string, value: unknown, index?: string | number, opt?: unknown) => vars.insVar(key, value, index, { ...optAsRecord(opt), scope }),
  })
  const local = scopedVar('local')
  const global = scopedVar('global')
  const message = scopedVar('message')

  async function getwi(lorebookOrTitle: string | number | Record<string, unknown>, titleOrData?: string | number | Record<string, unknown>, maybeData?: Record<string, unknown>): Promise<string> {
    let book: string | undefined
    let title: string | number | undefined
    let data: Record<string, unknown> = {}
    if (lorebookOrTitle !== null && typeof lorebookOrTitle === 'object') {
      // getwi(data)
      data = lorebookOrTitle
      title = titleOrData as string | number | undefined
    } else if (titleOrData !== null && typeof titleOrData === 'object') {
      // getwi(title, data)
      title = lorebookOrTitle as string | number
      data = titleOrData
    } else if (titleOrData !== undefined) {
      // getwi(lorebook, title[, data])
      book = requireString(lorebookOrTitle, 'getwi: lorebook')
      title = titleOrData
      if (maybeData !== null && typeof maybeData === 'object') data = maybeData
      else if (maybeData !== undefined) throw new TypeError('getwi: data must be an object')
    } else {
      // getwi(title)
      title = lorebookOrTitle as string | number
    }
    if (title !== undefined && typeof title !== 'string' && typeof title !== 'number') {
      throw new TypeError('getwi: title must be a string or number')
    }
    if (book !== undefined) requireString(book, 'getwi: lorebook')
    if (data === null || typeof data !== 'object') throw new TypeError('getwi: data must be an object')
    if (title === undefined || title === '') return ''
    if (depth.current >= MAX_GETWI_DEPTH) {
      host.onWarning?.(`getwi recursion depth exceeded (${MAX_GETWI_DEPTH}) at "${String(title)}"`)
      return ''
    }
    const entries = host.findWorldEntries(title, book)
    if (entries.length === 0) return ''
    const entry = entries[0]!
    depth.current++
    try {
      return await host.renderNested(entry.content, {
        world_info: worldInfoView(entry),
        getwi_book: entry.book,
        ...data,
      })
    } catch (err) {
      host.onWarning?.(`getwi render failed for ${entry.book}#${entry.uid}: ${errorMessage(err)}`)
      return entry.content
    } finally {
      depth.current--
    }
  }

  /**
   * getchar(name?, template?, data?)：渲染角色卡定义。
   * 首参为含 `<%` 的字符串时视为模板变体 getchar(template, data)（当前卡）。
   */
  async function getchar(nameOrTemplate?: string | number, templateArg?: string | Record<string, unknown>, dataArg?: Record<string, unknown>): Promise<string> {
    if (nameOrTemplate !== undefined && typeof nameOrTemplate !== 'string' && typeof nameOrTemplate !== 'number') {
      throw new TypeError('getchar: name must be a string or number')
    }
    if (templateArg !== undefined && typeof templateArg !== 'string') requireObject(templateArg, 'getchar: data')
    if (dataArg !== undefined) requireObject(dataArg, 'getchar: data')
    let name: string | number | undefined
    let template = DEFAULT_CHAR_DEFINE
    let data: Record<string, unknown> = {}
    if (typeof nameOrTemplate === 'string' && nameOrTemplate.includes('<%')) {
      template = nameOrTemplate
      if (templateArg !== undefined && typeof templateArg === 'object') data = templateArg
    } else {
      if (nameOrTemplate !== undefined) name = nameOrTemplate
      if (typeof templateArg === 'string') template = templateArg
      else if (templateArg !== undefined) data = templateArg
      if (dataArg !== undefined) data = dataArg
    }
    const card = host.getCard(name)
    if (!card) return ''
    const fields: Record<string, unknown> = {
      name: card.name,
      system_prompt: card.systemPrompt,
      personality: card.personality,
      description: card.description,
      scenario: card.scenario,
      first_message: card.firstMes,
      message_example: card.mesExample,
      creatorcomment: card.creatorNotes,
      depth_prompt: card.depthPrompt,
      ...data,
    }
    return await host.renderNested(template, fields)
  }

  async function getpreset(name: string, data: Record<string, unknown> = {}): Promise<string> {
    requireString(name, 'getpreset: name')
    requireObject(data, 'getpreset: data')
    const prompt = host.findPresetPrompt(name)
    if (!prompt) return ''
    return await host.renderNested(prompt.content, { preset_prompt_name: prompt.name, ...data })
  }

  function resolveMessageIdx(idx: number): number {
    const messages = host.messages
    return idx < 0 ? messages.length + idx : idx
  }

  function getChatMessage(idx: number, role?: 'user' | 'assistant' | 'system'): string {
    requireFiniteNumber(idx, 'getChatMessage: index')
    if (role !== undefined && !isRole(role)) throw new TypeError('getChatMessage: role must be user, assistant or system')
    const resolved = resolveMessageIdx(idx)
    const msg = host.messages[resolved]
    if (!msg) return ''
    if (role !== undefined && roleOf(msg) !== role) return ''
    return msg.mes
  }

  function getChatMessages(a: number, b?: number | 'user' | 'assistant' | 'system', c?: 'user' | 'assistant' | 'system'): string[] {
    requireFiniteNumber(a, 'getChatMessages: start')
    if (b !== undefined && typeof b !== 'number' && !isRole(b)) {
      throw new TypeError('getChatMessages: second argument must be an index or role')
    }
    if (c !== undefined && !isRole(c)) throw new TypeError('getChatMessages: role must be user, assistant or system')
    let start: number
    let end: number | undefined
    let role: 'user' | 'assistant' | 'system' | undefined
    if (b === undefined || isRole(b)) {
      start = -a
      role = b
    } else {
      start = a
      end = b
      role = c
    }
    const from = resolveMessageIdx(start)
    const to = end === undefined ? host.messages.length - 1 : resolveMessageIdx(end)
    const out: string[] = []
    for (let i = Math.max(0, from); i <= Math.min(to, host.messages.length - 1); i++) {
      const msg = host.messages[i]!
      if (msg.mes === '') continue
      if (role !== undefined && roleOf(msg) !== role) continue
      out.push(msg.mes)
    }
    return out
  }

  function matchChatMessages(
    pattern: string | RegExp | Array<string | RegExp>,
    options: { start?: number; end?: number | null; role?: 'user' | 'assistant' | 'system'; and?: boolean } = {},
  ): boolean {
    const isPattern = (value: unknown): value is string | RegExp => typeof value === 'string' || isRegExp(value)
    if (!isPattern(pattern)) {
      if (!Array.isArray(pattern) || !pattern.every(isPattern)) {
        throw new TypeError('matchChatMessages: pattern must be a string, RegExp or an array of them')
      }
    }
    if (options === null || typeof options !== 'object') throw new TypeError('matchChatMessages: options must be an object')
    if (options.start !== undefined) requireFiniteNumber(options.start, 'matchChatMessages: start')
    if (options.end !== undefined && options.end !== null) requireFiniteNumber(options.end, 'matchChatMessages: end')
    if (options.role !== undefined && !isRole(options.role)) {
      throw new TypeError('matchChatMessages: role must be user, assistant or system')
    }
    if (options.and !== undefined && typeof options.and !== 'boolean') {
      throw new TypeError('matchChatMessages: and must be a boolean')
    }
    const from = resolveMessageIdx(options.start ?? -2)
    const to = options.end === null || options.end === undefined ? host.messages.length - 1 : resolveMessageIdx(options.end)
    const role = options.role
    const texts: string[] = []
    for (let i = Math.max(0, from); i <= Math.min(to, host.messages.length - 1); i++) {
      const msg = host.messages[i]!
      if (role !== undefined && roleOf(msg) !== role) continue
      texts.push(msg.mes)
    }
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    if (patterns.length === 0) return false
    const testOne = (p: string | RegExp, text: string): boolean =>
      typeof p === 'string' ? text.includes(p) : p.test(text)
    if (!Array.isArray(pattern)) return texts.some((text) => testOne(pattern, text))
    const needAll = options.and === true
    return texts.some((text) =>
      needAll ? patterns.every((p) => testOne(p, text)) : patterns.some((p) => testOne(p, text)))
  }

  const env: Record<string, unknown> = {
    /* ---- 变量 API ---- */
    variables: vars.view(),
    getvar: (key: string | null, options?: unknown) => vars.getVar(key, options),
    setvar: (key: string | null, value: unknown, options?: unknown) => vars.setVar(key, value, options),
    incvar: (key: string, value = 1, options?: unknown) => vars.incDecVar(key, value, options, 1),
    decvar: (key: string, value = 1, options?: unknown) => vars.incDecVar(key, value, options, -1),
    delvar: (key: string, index?: string | number, options?: unknown) => vars.delVar(key, index, options),
    insvar: (key: string, value: unknown, index?: string | number, options?: unknown) => vars.insVar(key, value, index, options),
    getLocalVar: local.get, setLocalVar: local.set, incLocalVar: local.inc, decLocalVar: local.dec, delLocalVar: local.del, insertLocalVar: local.ins,
    getGlobalVar: global.get, setGlobalVar: global.set, incGlobalVar: global.inc, decGlobalVar: global.dec, delGlobalVar: global.del, insertGlobalVar: global.ins,
    getMessageVar: message.get, setMessageVar: message.set, incMessageVar: message.inc, decMessageVar: message.dec, delMessageVar: message.del, insertMessageVar: message.ins,
    patchVariables: (key: string | null, change: unknown[], options?: unknown) => {
      if (key !== null && typeof key !== 'string') throw new TypeError('patchVariables: key must be a string or null')
      requireArray(change, 'patchVariables: change')
      const current = (vars.getVar(key, { scope: 'local' }) ?? {}) as JsonObject
      const patched = applyJsonPatch(isObjectLike(current) ? deepClone(current) : {}, change)
      return vars.setVar(key, patched, options)
    },
    define: (name: string, value: unknown, merge = false) => {
      requireString(name, 'define: name')
      if (name === '__proto__') throw new TypeError('define: name cannot be __proto__')
      if (typeof merge !== 'boolean') throw new TypeError('define: merge must be a boolean')
      const registry = defines!
      if (merge && isObjectLike(registry[name]) && isObjectLike(value)) {
        deepMerge(registry[name] as JsonObject, value as JsonObject)
      } else {
        registry[name] = value
      }
    },

    /* ---- injectPrompt ---- */
    injectPrompt: (key: string, prompt: string, order = 100, sticky = 0, uid = '') => vars.injectPrompt(key, prompt, order, sticky, uid),
    getPromptsInjected: (key: string, postprocess?: Array<{ search: string | RegExp; replace: string }>) => vars.getPromptsInjected(key, postprocess),
    hasPromptsInjected: (key: string) => vars.hasPromptsInjected(key),

    /* ---- 资产读取 ---- */
    getwi,
    getWorldInfo: getwi,
    getchar,
    getChara: getchar,
    getpreset,
    getPresetPrompt: getpreset,
    getCharData: (name?: string | number) => {
      if (name !== undefined && typeof name !== 'string' && typeof name !== 'number') {
        throw new TypeError('getCharData: name must be a string or number')
      }
      const card = host.getCard(name)
      return card ? deepClone(card.data) : null
    },
    getChatMessage,
    getChatMessages,
    matchChatMessages,
    evalTemplate: async (content: string, data: Record<string, unknown> = {}) => {
      requireString(content, 'evalTemplate: content')
      requireObject(data, 'evalTemplate: data')
      return host.renderNested(content, data)
    },

    /* ---- JSON 工具 ---- */
    parseJSON,
    jsonPatch: (dest: JsonObject, change: unknown[]) => {
      requireObject(dest, 'jsonPatch: destination')
      requireArray(change, 'jsonPatch: change')
      return applyJsonPatch(deepClone(dest), change)
    },

    /* ---- 常量 ---- */
    runType: host.runType,
    userName: host.userName,
    charName: host.charName,
    chatId: host.chatId,
    ...(host.characterId !== undefined ? { characterId: host.characterId } : {}),
    groupId: null,
    groups: [],
    charAvatar: host.charAvatar ?? '',
    userAvatar: host.userAvatar ?? '',
    lastUserMessageId: host.lastUserMessageId,
    lastCharMessageId: host.lastCharMessageId,
    model: host.model ?? '',
    _: miniLodash,
  }

  for (const [name, value] of Object.entries(defines ?? {})) env[name] = value
  return env
}

function roleOf(msg: TemplateChatMessage): 'user' | 'assistant' | 'system' {
  if (msg.is_system) return 'system'
  return msg.is_user ? 'user' : 'assistant'
}

function worldInfoView(entry: TemplateWorldEntry): Record<string, unknown> {
  return {
    uid: entry.uid,
    world: entry.book,
    comment: entry.comment ?? '',
    content: entry.content,
    disable: entry.disable === true,
    ...(entry.order !== undefined ? { order: entry.order } : {}),
  }
}

function optAsRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`)
  return value
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function isRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp
}

function isRole(value: unknown): value is 'user' | 'assistant' | 'system' {
  return value === 'user' || value === 'assistant' || value === 'system'
}

/* ------------------------------ parseJSON ------------------------------ */

/** 宽容 JSON 解析：剥代码围栏、去尾逗号、智能引号归一后重试（对照 ST parseJSON 定位）。 */
export function parseJSON(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('parseJSON: text must be a string')
  try {
    return JSON.parse(text)
  } catch {
    // continue
  }
  let cleaned = text.trim()
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) cleaned = fence[1]!.trim()
  const firstObj = cleaned.search(/[[{]/)
  if (firstObj > 0) cleaned = cleaned.slice(firstObj)
  const lastObj = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (lastObj >= 0 && lastObj < cleaned.length - 1) cleaned = cleaned.slice(0, lastObj + 1)
  cleaned = cleaned
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 单引号字符串 → 双引号（保守：仅当不含双引号时）
    if (!cleaned.includes('"')) {
      try {
        return JSON.parse(cleaned.replace(/'([^']*)'/g, '"$1"'))
      } catch {
        // fallthrough
      }
    }
    throw new Error('parseJSON: not valid JSON even after cleanup')
  }
}

/* ------------------------------ jsonPatch ------------------------------ */

type PatchOp = { op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'; path: string; from?: string; value?: unknown }

/** JSON 语义的安全序列化：不调用 context 提供的 toJSON/函数，避免宿主回调。 */
function sanitizeForJson(value: unknown, stack: Set<object>): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type !== 'object') return undefined
  const object = value as object
  if (stack.has(object)) throw new TypeError('json conversion: circular structure')
  stack.add(object)
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const item = sanitizeForJson(value[i], stack)
        out.push(item === undefined ? null : item)
      }
      return out
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    if (value instanceof RegExp) return {}
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      const item = sanitizeForJson(record[key], stack)
      if (item === undefined) continue
      Object.defineProperty(out, key, {
        value: item,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    return out
  } finally {
    stack.delete(object)
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  const sanitized = sanitizeForJson(value, new Set())
  return sanitized === undefined ? undefined : JSON.stringify(sanitized)
}

function decodePointer(pointer: string): string[] {
  if (typeof pointer !== 'string') throw new TypeError('jsonPatch: path must be a string')
  if (pointer === '') throw new Error('jsonPatch: empty JSON pointer')
  if (!pointer.startsWith('/')) throw new Error(`jsonPatch: invalid JSON pointer "${pointer}"`)
  const segments = pointer.slice(1).split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (segments.includes('__proto__')) throw new TypeError('jsonPatch: JSON pointer cannot address __proto__')
  return segments
}

/** RFC 6902 子集：add/remove/replace/move/copy/test（数组 add 支持末位 `-` 与移位插入）。 */
export function applyJsonPatch(dest: JsonObject, change: unknown[]): JsonObject {
  const root = deepClone(dest)
  const wrap: JsonObject = { '': root }
  const walk = (segments: string[]): unknown => {
    let cur: unknown = wrap['']
    for (const seg of segments) {
      if (Array.isArray(cur)) cur = cur[Number(seg)]
      else if (isObjectLike(cur)) cur = cur[seg]
      else return undefined
    }
    return cur
  }
  const parentOf = (segments: string[]): JsonObject | unknown[] | undefined => {
    const parent = walk(segments)
    return isObjectLike(parent) || Array.isArray(parent) ? parent : undefined
  }

  for (const raw of change) {
    const op = raw as PatchOp
    if (op === null || typeof op !== 'object') throw new TypeError('jsonPatch: each change must be an object')
    if (typeof op.op !== 'string') throw new TypeError('jsonPatch: op must be a string')
    const segs = decodePointer(op.path)
    const parent = parentOf(segs.slice(0, -1))
    if (parent === undefined) throw new Error(`jsonPatch: parent path missing for "${op.path}"`)
    const key = segs[segs.length - 1]!

    if (op.op === 'add' || op.op === 'replace') {
      if (Array.isArray(parent) && op.op === 'add') {
        if (key === '-') parent.push(deepClone(op.value) as never)
        else {
          const idx = Number(key)
          if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`jsonPatch: bad array index "${key}"`)
          parent.splice(idx, 0, deepClone(op.value) as never)
        }
      } else {
        (parent as JsonObject)[key] = deepClone(op.value) as never
      }
      continue
    }
    if (op.op === 'remove') {
      if (Array.isArray(parent)) {
        const idx = Number(key)
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) parent.splice(idx, 1)
      } else {
        delete (parent as JsonObject)[key]
      }
      continue
    }
    if (op.op === 'move' || op.op === 'copy') {
      const fromSegs = decodePointer(op.from ?? '')
      const value = walk(fromSegs)
      if (value === undefined) throw new Error(`jsonPatch: from path missing "${op.from}"`)
      if (op.op === 'move') {
        const fromParent = parentOf(fromSegs.slice(0, -1))
        if (fromParent === undefined) throw new Error(`jsonPatch: from parent missing "${op.from}"`)
        const fromKey = fromSegs[fromSegs.length - 1]!
        if (Array.isArray(fromParent)) {
          const idx = Number(fromKey)
          if (Number.isInteger(idx) && idx >= 0 && idx < fromParent.length) fromParent.splice(idx, 1)
        } else {
          delete (fromParent as JsonObject)[fromKey]
        }
      }
      if (Array.isArray(parent)) {
        if (key === '-') parent.push(deepClone(value) as never)
        else parent.splice(Number(key), 0, deepClone(value) as never)
      } else {
        (parent as JsonObject)[key] = deepClone(value) as never
      }
      continue
    }
    if (op.op === 'test') {
      const actual = walk(segs)
      if (safeJsonStringify(actual) !== safeJsonStringify(op.value)) {
        throw new Error(`jsonPatch: test failed at "${op.path}"`)
      }
      continue
    }
    throw new Error(`jsonPatch: unknown op "${op.op}"`)
  }
  return wrap[''] as JsonObject
}

/* ------------------------------ 迷你 lodash ------------------------------ */

function collectionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value]
  if (isObjectLike(value)) return Object.values(value)
  if (value === null || value === undefined) return []
  return [value]
}

/** `_.get/set/merge` 等高频子集（模板生态大量使用 `_.`，完整 lodash 不进依赖）。 */
const miniLodash = {
  get: (obj: unknown, path: string, defaults?: unknown) => {
    const value = getPath(obj, path)
    return value === undefined ? defaults : value
  },
  set: (obj: JsonObject, path: string, value: unknown) => setPath(obj, path, value),
  has: (obj: unknown, path: string) => getPath(obj, path) !== undefined,
  merge: (dest: JsonObject, ...sources: JsonObject[]) => {
    requireObject(dest, '_.merge: destination')
    for (const src of sources) {
      requireObject(src, '_.merge: source')
      deepMerge(dest, src)
    }
    return dest
  },
  cloneDeep: deepClone,
  isArray: (v: unknown): v is unknown[] => Array.isArray(v),
  isObject: (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  isPlainObject: isObjectLike,
  isString: (v: unknown): v is string => typeof v === 'string',
  isNumber: (v: unknown): v is number => typeof v === 'number',
  isBoolean: (v: unknown): v is boolean => typeof v === 'boolean',
  isNull: (v: unknown): v is null => v === null,
  isUndefined: (v: unknown): v is undefined => v === undefined,
  isEmpty: (v: unknown) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isObjectLike(v) && Object.keys(v).length === 0),
  keys: (v: Record<string, unknown>) => Object.keys(v),
  values: (v: Record<string, unknown>) => Object.values(v),
  entries: (v: Record<string, unknown>) => Object.entries(v),
  first: (v: unknown[]) => v[0],
  last: (v: unknown[]) => v[v.length - 1],
  identity: <T>(v: T) => v,
  random: (lower?: number, upper?: number, floating?: boolean) => {
    if (lower !== undefined) requireFiniteNumber(lower, '_.random: lower')
    if (upper !== undefined) requireFiniteNumber(upper, '_.random: upper')
    if (floating !== undefined && typeof floating !== 'boolean') throw new TypeError('_.random: floating must be a boolean')
    if (lower === undefined) return Math.random()
    const min = upper === undefined ? 0 : lower
    const max = upper === undefined ? lower : upper
    if (floating === true || !Number.isInteger(min) || !Number.isInteger(max)) {
      return Math.random() * (max - min) + min
    }
    return Math.floor(Math.random() * (max - min + 1)) + min
  },
  // lodash.sample/sampleSize 同时接受数组与对象；卡内 EJS 用它们做主题池抽取。
  sample: (collection: unknown) => {
    const values = collectionValues(collection)
    return values.length === 0 ? undefined : values[Math.floor(Math.random() * values.length)]
  },
  sampleSize: (collection: unknown, size: number) => {
    requireFiniteNumber(size, '_.sampleSize: size')
    const values = collectionValues(collection)
    const count = Math.max(0, Math.min(Math.trunc(size), values.length))
    for (let index = values.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[values[index], values[swap]] = [values[swap]!, values[index]!]
    }
    return values.slice(0, count)
  },
  clamp: (value: number, lower: number, upper: number) => {
    requireFiniteNumber(value, '_.clamp: value')
    requireFiniteNumber(lower, '_.clamp: lower')
    requireFiniteNumber(upper, '_.clamp: upper')
    return Math.min(Math.max(value, lower), upper)
  },
  uniq: (values: unknown[]) => [...new Set(values)],
  isEqual: (left: unknown, right: unknown) => safeJsonStringify(left) === safeJsonStringify(right),
  unset: (obj: JsonObject, path: string) => {
    requireObject(obj, '_.unset: object')
    const existed = getPath(obj, path) !== undefined
    unsetPath(obj, path)
    return existed
  },
  toArray: (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v
    if (v === null || v === undefined) return []
    if (typeof v === 'string') return v.split('')
    if (isObjectLike(v)) return Object.values(v)
    return [v]
  },
}
