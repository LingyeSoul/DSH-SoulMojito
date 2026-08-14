/** 正则键解析，语义对照 ST world-info.js `parseRegexFromString` / `escapeRegex`。 */

/** 转义正则元字符（ST utils.js escapeRegex 同义）。 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `/pattern/flags` 字符串 → RegExp；不合法返回 null（视为普通子串键）。
 * 规则：首尾 `/` 分隔，flags 限 [gimsuy]；模式内未转义的 `/` 判非法；
 * `\/` 还原为 `/`；语法错误返回 null。
 * （verified vs world-info.js parseRegexFromString）
 */
export function parseRegexFromString(input: string): RegExp | null {
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
  if (!match) return null
  const pattern = match[1] ?? ''
  const flags = match[2] ?? ''
  if (/(^|[^\\])\//.test(pattern)) return null
  try {
    return new RegExp(pattern.replace(/\\\//g, '/'), flags)
  } catch {
    return null
  }
}
