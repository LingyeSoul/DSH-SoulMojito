/**
 * JSR / MagVarUpdate 变量协议兼容（2026-10-20）：
 * 导入卡把变量状态放在 `<UpdateVariable><JSONPatch>…` 里，由酒馆助手脚本
 * 解析并写回 `stat_data`。AgentTavern 不执行宿主的脚本树，因此在投影楼层时
 * 由服务端做同一件事：
 *
 * - 解析 `<UpdateVariable>` / `<JSONPatch>`（容忍注释、尾逗号、Markdown 围栏）；
 * - 宽松 JSON Patch：`replace` / `insert` / `add` 自动补中间对象，`delta` 做
 *   数值增减（`当前/最大` 条自动 clamp），`remove` 缺失即幂等；
 * - 变量树写回 `chat_metadata.variables.stat_data`（世界书 EJS 的 local 作用域）；
 * - 卡内有 `StatusPlaceHolderImpl` 正则时补占位符，让展示层状态栏重新挂载。
 *
 * 这不是通用 Zod 运行时：schema 的派生/钳制语义仍由卡内脚本负责；我们只保证
 * Agent 模式下的变量闭环与前端可读性。
 */

import type { CharacterCardIR, ChatLogIR, ChatMessage } from '../../../tavern-format/src/index.js'
import { parseJSON } from '../../../tavern-template/src/index.js'

export type MvuJsonObject = Record<string, unknown>

export const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>'

export interface MvuApplyResult {
  text: string
  found: boolean
  applied: number
  failures: string[]
  statData?: MvuJsonObject
}

interface ParsedUpdateBlock {
  ops?: unknown[]
  error?: string
}

interface PatchFailure {
  applied: number
  failures: string[]
}

const UPDATE_BLOCK = /<UpdateVariable(?:Variable)?\b[^>]*>([\s\S]*?)<\/UpdateVariable(?:Variable)?\s*>/i
const JSON_PATCH_BLOCK = /<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch\s*>/i

function plainObject(value: unknown): MvuJsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as MvuJsonObject
}

/** 卡内脚本是否声明了 MagVarUpdate / MVU Zod schema。 */
export function cardUsesJsrMvu(card: CharacterCardIR): boolean {
  const helper = plainObject(card.data.extensions['tavern_helper'])
  const scripts = Array.isArray(helper?.['scripts']) ? helper['scripts'] : []
  for (const script of scripts) {
    const content = typeof (script as MvuJsonObject)?.content === 'string' ? String((script as MvuJsonObject).content) : ''
    if (/MagVarUpdate|registerMvuSchema|mvu_zod/i.test(content)) return true
  }
  const regexScripts = card.data.extensions['regex_scripts']
  if (Array.isArray(regexScripts)) {
    for (const script of regexScripts) {
      const entry = plainObject(script)
      const source = `${String(entry?.['findRegex'] ?? '')}\n${String(entry?.['replaceString'] ?? '')}`
      if (source.includes('StatusPlaceHolderImpl') || /<UpdateVariable/i.test(source)) return true
    }
  }
  const entries = card.data.characterBook?.entries ?? []
  return entries.some((entry) => typeof entry.content === 'string'
    && (/<UpdateVariable/i.test(entry.content) || /getvar\(['"]stat_data['"]\)/.test(entry.content)))
}

/** 展示层是否有 `<StatusPlaceHolderImpl/>` 的状态栏占位管线。 */
export function cardUsesStatusPlaceholder(card: CharacterCardIR): boolean {
  const regexScripts = card.data.extensions['regex_scripts']
  if (!Array.isArray(regexScripts)) return false
  return regexScripts.some((script) => {
    const entry = plainObject(script)
    return `${String(entry?.['findRegex'] ?? '')}\n${String(entry?.['replaceString'] ?? '')}`.includes('StatusPlaceHolderImpl')
  })
}

/** 保证 `chat_metadata.variables` 存在并返回活引用。 */
export function ensureChatVariables(chat: ChatLogIR): MvuJsonObject {
  const metadata = chat.header.chat_metadata
  const existing = plainObject(metadata.variables)
  if (existing !== undefined) return existing
  const created: MvuJsonObject = {}
  metadata.variables = created
  return created
}

/** MVU 卡的初始变量：`initialized_lorebooks` 标记 + 创角前的 `stat_data` 骨架。 */
export function seedJsrMvuVariables(card: CharacterCardIR, variables: MvuJsonObject): boolean {
  if (!cardUsesJsrMvu(card)) return false
  let changed = false
  if (!Object.prototype.hasOwnProperty.call(variables, 'initialized_lorebooks')) {
    variables['initialized_lorebooks'] = true
    changed = true
  }
  const stat = plainObject(variables['stat_data'])
  if (stat === undefined) {
    variables['stat_data'] = { 系统状态: { 主角创建完毕: false } }
    changed = true
  } else if (Object.keys(stat).length === 0) {
    stat['系统状态'] = { 主角创建完毕: false }
    variables['stat_data'] = stat
    changed = true
  }
  return changed
}

/** 当前楼层变量树里的 `stat_data`（没有则 undefined）。 */
export function readStatData(chat: ChatLogIR): MvuJsonObject | undefined {
  return plainObject(plainObject(chat.header.chat_metadata.variables)?.['stat_data'])
}

/**
 * 把一条助手楼层的 `<UpdateVariable>` 应用到聊天变量树。
 * 调用方负责 saveChat；文本只在卡内声明了占位符管线时追加占位符。
 */
export function applyUpdateVariableToChat(card: CharacterCardIR, chat: ChatLogIR, text: string): MvuApplyResult {
  if (!cardUsesJsrMvu(card)) return { text, found: false, applied: 0, failures: [] }
  const variables = ensureChatVariables(chat)
  seedJsrMvuVariables(card, variables)
  const block = parseUpdateBlock(text)
  const failures: string[] = []
  let applied = 0
  let stat = plainObject(variables['stat_data']) ?? {}
  const previousStat = structuredClone(stat)
  if (block !== undefined) {
    variables['previous_stat_data'] = previousStat
    if (block.error !== undefined) {
      failures.push(block.error)
    } else if (block.ops !== undefined) {
      const result = applyLenientPatch(stat, block.ops)
      stat = result.value
      applied = result.applied
      failures.push(...result.failures)
    }
  }
  variables['stat_data'] = stat
  variables['initialized_lorebooks'] = true
  let nextText = text
  if (cardUsesStatusPlaceholder(card) && !nextText.includes(STATUS_PLACEHOLDER)) {
    nextText = `${nextText.replace(/\s+$/, '')}\n${STATUS_PLACEHOLDER}`
  }
  return {
    text: nextText,
    found: block !== undefined,
    applied,
    failures,
    statData: stat,
  }
}

/** 楼层投影用：把最新 stat_data 挂到消息变量，供前端 `getChatMessages().data` 读取。 */
export function messageStatVariables(chat: ChatLogIR, message: ChatMessage): ChatMessage {
  const stat = readStatData(chat)
  if (stat === undefined) return message
  return {
    ...message,
    variables: {
      ...(plainObject(message.variables) ?? {}),
      stat_data: structuredClone(stat),
    },
  }
}

/* ------------------------------- 解析 ------------------------------- */

function parseUpdateBlock(text: string): ParsedUpdateBlock | undefined {
  const block = UPDATE_BLOCK.exec(text)
  if (block === null) return undefined
  const patch = JSON_PATCH_BLOCK.exec(block[1] ?? '')
  if (patch === null) return { error: 'UpdateVariable block has no JSONPatch body' }
  try {
    const cleaned = stripJsonComments(patch[1] ?? '')
    const parsed = parseJSON(cleaned)
    if (!Array.isArray(parsed)) return { error: 'JSONPatch body is not an array' }
    return { ops: parsed }
  } catch (cause) {
    return { error: `JSONPatch parse failed: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

/** 移除非字符串内的 // 与 /* *\/ 注释；LLM 常在 JSON 数组里写注释。 */
function stripJsonComments(source: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]!
    const next = source[index + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    out += ch
  }
  return out
}

/* ------------------------------ JSON Patch ------------------------------ */

interface PatchOp {
  op?: unknown
  path?: unknown
  from?: unknown
  value?: unknown
}

function decodePointer(pointer: unknown): string[] | undefined {
  if (typeof pointer !== 'string') return undefined
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return undefined
  return pointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function readPath(root: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = root
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      cursor = cursor[index]
    } else if (cursor !== null && typeof cursor === 'object') {
      cursor = (cursor as MvuJsonObject)[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

/** 数字字段上的字符串值（Zod `z.coerce.number()` 的常见输出）按数字落库。 */
function coercePatchValue(next: unknown, current: unknown): unknown {
  if (typeof next !== 'string' || next.trim() === '') return next
  if (typeof current !== 'number') return next
  const numeric = Number(next)
  return Number.isFinite(numeric) ? numeric : next
}

function resolveParent(root: MvuJsonObject, segments: readonly string[]): { parent: MvuJsonObject | unknown[]; key: string } | undefined {
  if (segments.length === 0) return undefined
  let cursor: MvuJsonObject | unknown[] = root
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!
    if (Array.isArray(cursor)) {
      const arrayIndex = Number(segment)
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) return undefined
      const existing = cursor[arrayIndex]
      if (existing === null || typeof existing !== 'object') return undefined
      cursor = existing as MvuJsonObject | unknown[]
    } else {
      const existing = cursor[segment]
      if (existing === null || typeof existing !== 'object') return undefined
      cursor = existing as MvuJsonObject | unknown[]
    }
  }
  return { parent: cursor, key: segments[segments.length - 1]! }
}

function ensureParent(root: MvuJsonObject, segments: readonly string[]): { parent: MvuJsonObject | unknown[]; key: string } | undefined {  if (segments.length === 0) return undefined
  let cursor: MvuJsonObject | unknown[] = root
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!
    const next = segments[index + 1]!
    const wantsArray = next === '-' || /^\d+$/.test(next)
    if (Array.isArray(cursor)) {
      const arrayIndex = Number(segment)
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) return undefined
      const existing = cursor[arrayIndex]
      if (existing === null || typeof existing !== 'object') cursor[arrayIndex] = wantsArray ? [] : {}
      cursor = cursor[arrayIndex] as MvuJsonObject | unknown[]
    } else {
      const existing = cursor[segment]
      if (existing === null || typeof existing !== 'object') cursor[segment] = wantsArray ? [] : {}
      cursor = cursor[segment] as MvuJsonObject | unknown[]
    }
  }
  return { parent: cursor, key: segments[segments.length - 1]! }
}

function applyLenientPatch(root: MvuJsonObject, ops: readonly unknown[]): PatchFailure & { value: MvuJsonObject } {
  let value = structuredClone(root)
  let applied = 0
  const failures: string[] = []
  for (const raw of ops) {
    const op = plainObject(raw) as PatchOp | undefined
    if (op === undefined || typeof op.op !== 'string') {
      failures.push('patch entry is not an object with an op')
      continue
    }
    if (op.op === 'test') {
      const segments = decodePointer(op.path)
      if (segments === undefined) {
        failures.push(`test: invalid path ${String(op.path)}`)
        continue
      }
      if (JSON.stringify(readPath(value, segments)) !== JSON.stringify(op.value)) {
        failures.push(`test failed at ${String(op.path)}`)
        continue
      }
      applied += 1
      continue
    }
    if (op.op === 'remove') {
      const segments = decodePointer(op.path)
      if (segments === undefined) {
        failures.push(`remove: invalid path ${String(op.path)}`)
        continue
      }
      const target = resolveParent(value, segments)
      if (target === undefined) {
        // 卡内事件清理常对不存在的键重复 remove；幂等成功，不制造失败项。
        applied += 1
        continue
      }
      if (Array.isArray(target.parent)) {
        const index = Number(target.key)
        if (Number.isInteger(index) && index >= 0 && index < target.parent.length) target.parent.splice(index, 1)
      } else {
        delete target.parent[target.key]
      }
      applied += 1
      continue
    }
    if (op.op === 'replace' || op.op === 'insert' || op.op === 'add') {
      const segments = decodePointer(op.path)
      if (segments === undefined) {
        failures.push(`${op.op}: invalid path ${String(op.path)}`)
        continue
      }
      if (segments.length === 0) {
        const replacement = plainObject(op.value)
        if (replacement === undefined) {
          failures.push(`${op.op}: root replacement must be an object`)
          continue
        }
        value = replacement
        applied += 1
        continue
      }
      const target = ensureParent(value, segments)
      if (target === undefined) {
        failures.push(`${op.op}: cannot resolve parent of ${String(op.path)}`)
        continue
      }
      const currentValue = readPath(value, segments)
      const nextValue = coercePatchValue(op.value, currentValue)
      if (Array.isArray(target.parent)) {
        if (target.key === '-') {
          target.parent.push(structuredClone(nextValue))
        } else {
          const index = Number(target.key)
          if (!Number.isInteger(index) || index < 0) {
            failures.push(`${op.op}: invalid array index ${target.key}`)
            continue
          }
          if (op.op === 'replace') target.parent[index] = structuredClone(nextValue)
          else target.parent.splice(index, 0, structuredClone(nextValue))
        }
      } else {
        target.parent[target.key] = structuredClone(nextValue)
      }
      applied += 1
      continue
    }
    if (op.op === 'delta') {
      const segments = decodePointer(op.path)
      if (segments === undefined) {
        failures.push(`delta: invalid path ${String(op.path)}`)
        continue
      }
      const deltaValue = typeof op.value === 'number'
        ? op.value
        : typeof op.value === 'string' && op.value.trim() !== '' && Number.isFinite(Number(op.value))
          ? Number(op.value)
          : undefined
      if (deltaValue === undefined) {
        failures.push(`delta: value at ${String(op.path)} must be a finite number`)
        continue
      }      const current = readPath(value, segments)
      const numericCurrent = typeof current === 'number'
        ? current
        : typeof current === 'string' && current.trim() !== '' && Number.isFinite(Number(current))
          ? Number(current)
          : current
      if (numericCurrent !== undefined && typeof numericCurrent !== 'number') {
        failures.push(`delta: current value at ${String(op.path)} is not a number`)
        continue
      }
      let next = (numericCurrent ?? 0) + deltaValue
      const parent = segments.length > 1 ? readPath(value, segments.slice(0, -1)) : undefined
      if (segments[segments.length - 1] === '当前' && parent !== null && typeof parent === 'object') {
        const max = (parent as MvuJsonObject)['最大']
        if (typeof max === 'number' && Number.isFinite(max)) next = Math.min(Math.max(next, 0), max)
      }
      const target = ensureParent(value, segments)
      if (target === undefined) {
        failures.push(`delta: cannot resolve parent of ${String(op.path)}`)
        continue
      }
      if (Array.isArray(target.parent)) {
        const index = Number(target.key)
        if (!Number.isInteger(index) || index < 0) {
          failures.push(`delta: invalid array index ${target.key}`)
          continue
        }
        target.parent[index] = next
      } else {
        target.parent[target.key] = next
      }
      applied += 1
      continue
    }
    if (op.op === 'copy' || op.op === 'move') {
      const from = decodePointer(op.from)
      const to = decodePointer(op.path)
      if (from === undefined || to === undefined) {
        failures.push(`${op.op}: invalid from/path`)
        continue
      }
      const sourceValue = readPath(value, from)
      if (sourceValue === undefined) {
        failures.push(`${op.op}: source missing ${String(op.from)}`)
        continue
      }
      if (op.op === 'move') {
        const fromTarget = resolveParent(value, from)
        if (fromTarget !== undefined) {
          if (Array.isArray(fromTarget.parent)) {
            const index = Number(fromTarget.key)
            if (Number.isInteger(index) && index >= 0 && index < fromTarget.parent.length) fromTarget.parent.splice(index, 1)
          } else {
            delete fromTarget.parent[fromTarget.key]
          }
        }
      }
      const target = ensureParent(value, to)
      if (target === undefined) {
        failures.push(`${op.op}: cannot resolve parent of ${String(op.path)}`)
        continue
      }
      if (Array.isArray(target.parent)) {
        if (target.key === '-') target.parent.push(structuredClone(sourceValue))
        else target.parent.splice(Number(target.key), 0, structuredClone(sourceValue))
      } else {
        target.parent[target.key] = structuredClone(sourceValue)
      }
      applied += 1
      continue
    }
    failures.push(`unsupported op ${op.op}`)
  }
  return { value, applied, failures }
}
