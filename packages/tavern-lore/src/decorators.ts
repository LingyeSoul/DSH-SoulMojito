/**
 * 内容 decorator 解析：`@@activate` / `@@dont_activate`（ST 已知 decorator 集）。
 * 语义对照 world-info.js `parseDecorators`：内容以 `@@` 开头时，逐行剥离前导 `@@` 行，
 * 仅已知 decorator 被识别（`@@@` 前缀行为：未被回退时整行丢弃；被回退后按已知性判定）。
 */

export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const

function isKnownDecorator(data: string): boolean {
  let probe = data
  if (probe.startsWith('@@@')) probe = probe.slice(1)
  return KNOWN_DECORATORS.some((known) => probe.startsWith(known))
}

/**
 * 解析内容前导 decorator 行，返回 [decorators, 剩余内容]。
 * （verified vs world-info.js parseDecorators：@@@ 行在未回退时直接丢弃；
 * 未知 @@ 行置回退态且不保留；首个非 @@ 行起原样保留）
 */
export function parseDecorators(content: string): [string[], string] {
  if (!content.startsWith('@@')) return [[], content]

  const lines = content.split('\n')
  const decorators: string[] = []
  let fallbacked = false
  // 全部行都是 @@ 行时保留原文（ST 初始 newContent = content 的行为）
  let newContent = content

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('@@')) {
      if (line.startsWith('@@@') && !fallbacked) continue
      if (isKnownDecorator(line)) {
        decorators.push(line.startsWith('@@@') ? line.slice(1) : line)
        fallbacked = false
      } else {
        fallbacked = true
      }
    } else {
      newContent = lines.slice(i).join('\n')
      break
    }
  }
  return [decorators, newContent]
}
