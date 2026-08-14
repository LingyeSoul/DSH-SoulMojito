/**
 * 键序无关的深比较（roundtrip 校验用）：对象键集合与值逐一比较，
 * 数组保序比较，NaN 视为相等，undefined 与缺失键视为等价。
 */

export function stableDeepEqual(a: unknown, b: unknown): boolean {
  return compare(a, b, new Map<unknown, unknown>())
}

function compare(a: unknown, b: unknown, seen: Map<unknown, unknown>): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (seen.get(a) === b) return true // 循环引用（同对已比较中）按相等处理
  seen.set(a, b)
  try {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (!compare(a[i], b[i], seen)) return false
      }
      return true
    }
    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>
    const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined)
    const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (aObj[key] === undefined) continue
      if (!(key in bObj) || !compare(aObj[key], bObj[key], seen)) return false
    }
    return true
  } finally {
    seen.delete(a)
  }
}
