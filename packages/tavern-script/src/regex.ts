/**
 * ST regex 扩展脚本执行器（clean-room，语义对照可观察行为）。
 *
 * - findRegex 支持裸正则串（按 `g` 编译）与 `/pattern/flags` 字面量；
 * - substituteRegex：findRegex/replaceString 先过宏（deps.expand）再编译/替换；
 * - trimStrings：结果中逐个删除全部出现；
 * - placement 过滤（USER_INPUT/AI_OUTPUT/SLASH_COMMAND/WORLD_INFO/REASONING）；
 * - minDepth/maxDepth：仅当提供消息深度时过滤（AI_OUTPUT 按消息应用）。
 */

import { parseRegexFromString } from '@dsh-soulmojito/lore'
import { hasPlacement, type RegexScriptIR } from '@dsh-soulmojito/format'
import { inspectRegexSafety, MAX_SCRIPT_REGEX_PATTERN_LENGTH } from './regex-safety.js'

export {
  inspectRegexSafety,
  MAX_SCRIPT_REGEX_PATTERN_LENGTH,
  type RegexSafetyReason,
  type RegexSafetyVerdict,
} from './regex-safety.js'

/**
 * Hard limit for one script application, measured in UTF-16 code units.
 * 100k characters is generous for a chat message while keeping worst-case
 * backtracking work bounded.
 */
export const MAX_SCRIPT_REGEX_INPUT_LENGTH = 100_000

export type RegexScriptWarningCode = 'invalid-regex' | 'unsafe-regex' | 'input-too-long'

export interface RegexScriptWarning {
  readonly code: RegexScriptWarningCode
  readonly scriptName: string
  readonly detail: string
}

export interface RegexApplyDeps {
  /** substituteRegex 脚本的宏展开通道。 */
  expand?: (text: string) => string
  /**
   * Observability for skipped scripts. Called synchronously when a script is
   * skipped because its regex is invalid, fails the safety gate, or the input
   * exceeds MAX_SCRIPT_REGEX_INPUT_LENGTH. Exceptions from the callback
   * propagate to the caller.
   */
  onWarning?: (warning: RegexScriptWarning) => void
}

export interface RegexDepthOptions {
  /** 消息深度（0 = 最新一条）；null = 不做深度过滤 */
  depth?: number | null
}

/**
 * 编译脚本正则；不合法或未通过 ReDoS 安全门返回 null（脚本跳过，ST 容错行为）。
 * A skipped script is never treated as a successful replacement.
 */
export function compileScriptRegex(script: RegexScriptIR, deps: RegexApplyDeps = {}): RegExp | null {
  const raw = script.substituteRegex && deps.expand ? deps.expand(script.findRegex) : script.findRegex
  if (raw.length > MAX_SCRIPT_REGEX_PATTERN_LENGTH) {
    deps.onWarning?.({
      code: 'unsafe-regex',
      scriptName: script.scriptName,
      detail: `pattern-too-long: pattern length ${raw.length} exceeds ${MAX_SCRIPT_REGEX_PATTERN_LENGTH}`,
    })
    return null
  }
  let regex: RegExp
  try {
    const literal = parseRegexFromString(raw)
    regex = literal !== null
      ? new RegExp(literal.source, literal.flags.includes('g') ? literal.flags : `${literal.flags}g`)
      : new RegExp(raw, 'g')
  } catch {
    deps.onWarning?.({
      code: 'invalid-regex',
      scriptName: script.scriptName,
      detail: 'pattern could not be compiled',
    })
    return null
  }
  const verdict = inspectRegexSafety(regex.source, regex.flags)
  if (!verdict.safe) {
    deps.onWarning?.({
      code: 'unsafe-regex',
      scriptName: script.scriptName,
      detail: `${verdict.reason}: ${verdict.detail}`,
    })
    return null
  }
  return regex
}

/**
 * ST 替换语义（engine.js `runRegexScript`）：替换走函数回调，`$&`、`$'`、
 * `` $` ``、`$$` 保持字面量；只有 `{{match}}`、`$1..$n`、`$<name>` 展开，且
 * 捕获组先过 trimStrings。
 *
 * 卡内美化脚本把整份 HTML/JS 塞进 replaceString。JS 里 `'$__META_EXTENSIBLE__$'`
 * 的尾部 `$'` 在字符串替换里会被解释为“匹配点之后的整段原文”，把消息尾巴
 * 插进 `<script>` 的单引号字符串（换行即语法错误，整个前端脚本不执行）。
 */
function expandReplacement(
  template: string,
  match: string,
  captures: Array<string | undefined>,
  named: Record<string, string | undefined> | undefined,
  trimStrings: string[],
): string {
  const trim = (value: string): string => {
    let next = value
    for (const token of trimStrings) {
      if (token !== '') next = next.split(token).join('')
    }
    return next
  }
  return template
    .replace(/{{match}}/gi, '$0')
    .replace(/\$(\d+)|\$<([^>]+)>/g, (_token, digits: string | undefined, group: string | undefined) => {
      if (digits !== undefined) {
        const index = Number(digits)
        const value = index === 0 ? match : captures[index - 1]
        return value === undefined ? '' : trim(value)
      }
      const value = named?.[group ?? '']
      return value === undefined ? '' : trim(value)
    })
}

/**
 * 按位应用一个脚本；返回 null 表示脚本被跳过（禁用/placement/深度不符/正则不合法/
 * ReDoS 安全门拒绝/输入超过 MAX_SCRIPT_REGEX_INPUT_LENGTH）。
 * A skipped script must leave the caller's text unchanged, never report a
 * successful replacement.
 */
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
  if (text.length > MAX_SCRIPT_REGEX_INPUT_LENGTH) {
    deps.onWarning?.({
      code: 'input-too-long',
      scriptName: script.scriptName,
      detail: `input length ${text.length} exceeds ${MAX_SCRIPT_REGEX_INPUT_LENGTH}`,
    })
    return null
  }
  const replacement = script.substituteRegex && deps.expand
    ? deps.expand(script.replaceString)
    : script.replaceString
  // 函数替换让 `$` 序列保持字面量；展开规则见 expandReplacement。
  let result = text.replace(regex, (match: string, ...rest: unknown[]) => {
    const tail = rest[rest.length - 1]
    const named = typeof tail === 'object' && tail !== null && !Array.isArray(tail)
      ? tail as Record<string, string | undefined>
      : undefined
    const captures = rest.slice(0, Math.max(0, rest.length - (named === undefined ? 2 : 3))) as Array<string | undefined>
    return expandReplacement(replacement, match, captures, named, script.trimStrings)
  })
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
