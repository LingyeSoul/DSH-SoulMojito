/**
 * 变量路径读写与深合并（clean-room，lodash `_.get/_.set/_.merge` 的语义子集）。
 *
 * 路径语法：`a.b.c` / `a[0].b`（方括号仅支持数字下标）。非法段视为不存在。
 * 深合并语义对照 ST-Prompt-Template（其内部用 `_.merge` + `mergeWith` 数组替换）：
 * 对象递归合并，数组与其他类型整体替换。
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type PrimitiveValue = string | number | boolean

/** 解析路径为段列表；空路径返回 []。 */
export function parsePath(path: string): string[] {
  if (path === '') return []
  const segments: string[] = []
  let buf = ''
  let i = 0
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      if (buf !== '') segments.push(buf)
      buf = ''
      i++
    } else if (ch === '[') {
      const close = path.indexOf(']', i)
      if (close === -1) return []
      if (buf !== '') segments.push(buf)
      const inner = path.slice(i + 1, close).trim()
      if (!/^-?\d+$/.test(inner)) return []
      segments.push(inner)
      buf = ''
      i = close + 1
      // `]` 后只允许 `.`、`[` 或结尾
      if (path[i] === '.') i++
    } else {
      buf += ch
      i++
    }
  }
  if (buf !== '') segments.push(buf)
  return segments
}

export function isObjectLike(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as T
  if (isObjectLike(value)) {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item)
    return out as T
  }
  return value
}

/** 读取路径值；不存在返回 undefined（调用方负责 defaults）。 */
export function getPath(root: unknown, path: string): unknown {
  const segments = parsePath(path)
  let cur: unknown = root
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx < 0 ? cur.length + idx : idx]
    } else if (isObjectLike(cur)) {
      cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined
    } else {
      return undefined
    }
  }
  return cur
}

/** 写入路径值（创建中间对象；数组下标越界时扩展数组）。返回写入后的 root。 */
export function setPath(root: JsonObject, path: string, value: unknown): JsonObject {
  const segments = parsePath(path)
  if (segments.length === 0) return root
  const last = segments[segments.length - 1]!
  let cur: JsonObject = root
  for (const seg of segments.slice(0, -1)) {
    const existing = cur[seg]
    if (isObjectLike(existing)) {
      cur = existing
    } else if (Array.isArray(existing)) {
      // 数组中间段：包装为对象会破坏形状，这里跟随 ST 行为（_.set 会建对象键）
      const wrapper: JsonObject = {}
      cur[seg] = wrapper
      cur = wrapper
    } else {
      const next: JsonObject = {}
      cur[seg] = next
      cur = next
    }
  }
  if (/^-?\d+$/.test(last) && Array.isArray(cur[last])) {
    const arr = cur[last] as JsonValue[]
    const idx = Number(last) < 0 ? arr.length + Number(last) : Number(last)
    arr[idx < 0 ? 0 : idx] = value as JsonValue
  } else {
    cur[last] = value as JsonValue
  }
  return root
}

/**
 * 删除变量：无 index 删除整个键；对象删属性、数组删元素（塌缩）、字符串删子串。
 * index 不存在时静默无操作（对照 ST delvar 语义）。
 */
export function unsetPath(root: JsonObject, path: string, index?: string | number): void {
  if (index !== undefined) {
    const target = getPath(root, path)
    if (Array.isArray(target)) {
      const idx = typeof index === 'number' ? index : Number(index)
      if (Number.isInteger(idx) && idx >= 0 && idx < target.length) target.splice(idx, 1)
    } else if (typeof target === 'string') {
      const idx = typeof index === 'number' ? index : Number(index)
      if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
        setPath(root, path, target.slice(0, idx) + target.slice(idx + 1))
      }
    } else if (isObjectLike(target)) {
      delete target[String(index)]
    }
    return
  }
  const segments = parsePath(path)
  if (segments.length === 0) return
  const last = segments[segments.length - 1]!
  let cur: unknown = root
  for (const seg of segments.slice(0, -1)) {
    cur = getPath(cur, seg)
    if (cur === null || cur === undefined) return
  }
  if (isObjectLike(cur) || Array.isArray(cur)) delete (cur as JsonObject)[last]
}

/**
 * 插入变量：对象按 index 为键赋值；数组在 index 处插入（缺省尾部）；
 * 字符串在 index 处插入（缺省尾部）。其他类型静默无操作（对照 ST insvar）。
 */
export function insertAtPath(root: JsonObject, path: string, value: unknown, index?: string | number): void {
  const target = getPath(root, path)
  if (Array.isArray(target)) {
    const idx = index === undefined ? target.length : Number(index)
    if (Number.isInteger(idx) && idx >= 0 && idx <= target.length) target.splice(idx, 0, value as JsonValue)
  } else if (typeof target === 'string') {
    const idx = index === undefined ? target.length : Number(index)
    if (Number.isInteger(idx) && idx >= 0 && idx <= target.length) {
      setPath(root, path, target.slice(0, idx) + String(value) + target.slice(idx))
    }
  } else if (isObjectLike(target)) {
    target[index === undefined ? String(target.length) : String(index)] = value as JsonValue
  }
}

/** 深合并：对象递归，数组与其他类型用 source 替换；source undefined 的键跳过。 */
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const dst = target[key]
    if (isObjectLike(dst) && isObjectLike(value)) {
      deepMerge(dst, value)
    } else {
      target[key] = deepClone(value)
    }
  }
  return target
}

export function isEmptyObject(value: unknown): boolean {
  return isObjectLike(value) && Object.keys(value).length === 0
}
