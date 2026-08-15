/**
 * ST regex 扩展脚本执行器（clean-room，语义对照可观察行为）。
 *
 * - findRegex 支持裸正则串（按 `g` 编译）与 `/pattern/flags` 字面量；
 * - substituteRegex：findRegex/replaceString 先过宏（deps.expand）再编译/替换；
 * - trimStrings：结果中逐个删除全部出现；
 * - placement 过滤（USER_INPUT/AI_OUTPUT/SLASH_COMMAND/WORLD_INFO/REASONING）；
 * - minDepth/maxDepth：仅当提供消息深度时过滤（AI_OUTPUT 按消息应用）。
 */

import { parseRegexFromString } from '@dsh-tavern/lore'
import { hasPlacement, type RegexScriptIR } from '@dsh-tavern/format'

export interface RegexApplyDeps {
  /** substituteRegex 脚本的宏展开通道。 */
  expand?: (text: string) => string
}

export interface RegexDepthOptions {
  /** 消息深度（0 = 最新一条）；null = 不做深度过滤 */
  depth?: number | null
}

/** 编译脚本正则；不合法返回 null（脚本跳过，ST 容错行为）。 */
export function compileScriptRegex(script: RegexScriptIR, deps: RegexApplyDeps = {}): RegExp | null {
  const raw = script.substituteRegex && deps.expand ? deps.expand(script.findRegex) : script.findRegex
  try {
    const literal = parseRegexFromString(raw)
    if (literal !== null) return new RegExp(literal.source, literal.flags.includes('g') ? literal.flags : `${literal.flags}g`)
    return new RegExp(raw, 'g')
  } catch {
    return null
  }
}

/** 按位应用一个脚本；返回 null 表示脚本被跳过（禁用/placement/深度不符/正则不合法）。 */
export function applyRegexScript(
  text: string,
  script: RegexScriptIR,
  placement: number,
  deps: RegexApplyDeps = {},
  depth: RegexDepthOptions = {},
): string | null {
  if (script.disabled || !hasPlacement(script, placement)) return null
  if (depth.depth !== undefined && depth.depth !== null) {
    if (script.minDepth !== null && depth.depth < script.minDepth) return null
    if (script.maxDepth !== null && depth.depth > script.maxDepth) return null
  }
  const regex = compileScriptRegex(script, deps)
  if (regex === null) return null
  const replacement = script.substituteRegex && deps.expand
    ? deps.expand(script.replaceString)
    : script.replaceString
  let result = text.replace(regex, replacement)
  for (const trim of script.trimStrings) {
    if (trim !== '') result = result.split(trim).join('')
  }
  return result
}

/** 按序应用一组脚本（后一个吃前一个的输出）。 */
export function applyRegexScripts(
  text: string,
  scripts: RegexScriptIR[],
  placement: number,
  deps: RegexApplyDeps = {},
  depth: RegexDepthOptions = {},
): string {
  let current = text
  for (const script of scripts) {
    const next = applyRegexScript(current, script, placement, deps, depth)
    if (next !== null) current = next
  }
  return current
}

/**
 * 对一段多行文本按行深度应用 AI_OUTPUT 脚本（行 0 = 最深/最新）。
 * depth 覆盖整段时退化为 applyRegexScripts。
 */
export function applyRegexScriptsToLines(
  lines: string[],
  scripts: RegexScriptIR[],
  placement: number,
  deps: RegexApplyDeps = {},
  depthOf: (lineIndex: number) => number | null = () => null,
): string[] {
  return lines.map((line, index) =>
    applyRegexScripts(line, scripts, placement, deps, { depth: depthOf(index) }))
}
