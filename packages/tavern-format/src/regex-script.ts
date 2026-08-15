/**
 * ST regex 扩展脚本（find & replace）：全局（设置导出的数组）与卡级
 * （data.extensions.regex_scripts）共用同一形态。
 *
 * 字段语义对照 ST extensions/regex 的导出形态：
 * - placement 位集合（ST 原值）：USER_INPUT=1 | AI_OUTPUT=2 | SLASH_COMMAND=3 |
 *   WORLD_INFO=5 | REASONING=6；缺省视为 [AI_OUTPUT]。
 * - promptOnly/markdownOnly：markdownOnly=仅展示层（不进 prompt），promptOnly=仅
 *   prompt 层（不改保存文本）；两者同 true 视为 both。
 * - substituteRegex：findRegex/replaceString 先过宏再编译。
 */

export const RegexPlacement = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const

export interface RegexScriptIR {
  id: string
  scriptName: string
  findRegex: string
  replaceString: string
  trimStrings: string[]
  /** placement 位集合（去重后的 ST 原值数组） */
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  substituteRegex: boolean
  minDepth: number | null
  maxDepth: number | null
  /** 未知字段透传袋 */
  extra?: Record<string, unknown>
}

export class RegexScriptFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexScriptFormatError'
  }
}

const KNOWN_FIELDS = new Set([
  'id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement',
  'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex',
  'minDepth', 'maxDepth',
])

const PLACEMENT_VALUES = new Set([1, 2, 3, 5, 6])

/**
 * 解析 ST regex 导出：接受脚本数组、`{scripts:[]}`（旧导出）或 `{regex_scripts:[]}`
 * （卡内嵌形态）。单脚本对象也可（容忍手工导入）。
 */
export function parseRegexScripts(input: unknown): RegexScriptIR[] {
  let list: unknown[]
  if (Array.isArray(input)) list = input
  else if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    if (Array.isArray(obj['scripts'])) list = obj['scripts']
    else if (Array.isArray(obj['regex_scripts'])) list = obj['regex_scripts']
    else list = [input]
  } else {
    throw new RegexScriptFormatError('regex scripts input must be an array or object')
  }
  return list.map((item, index) => parseRegexScript(item, index))
}

export function parseRegexScript(raw: unknown, index = 0): RegexScriptIR {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegexScriptFormatError(`regex script ${index} is not an object`)
  }
  const obj = raw as Record<string, unknown>
  const findRegex = str(obj['findRegex'])
  if (findRegex === '') throw new RegexScriptFormatError(`regex script ${index} has empty findRegex`)
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_FIELDS.has(k)) extra[k] = v
  }
  const placement = (Array.isArray(obj['placement']) ? obj['placement'] : [obj['placement']])
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0))
    .filter((value) => PLACEMENT_VALUES.has(value))
  return {
    id: str(obj['id']) || `regex-${index}-${str(obj['scriptName']) || 'script'}`,
    scriptName: str(obj['scriptName']) || str(obj['script_name']) || `Script ${index + 1}`,
    findRegex,
    replaceString: str(obj['replaceString']),
    trimStrings: Array.isArray(obj['trimStrings'])
      ? obj['trimStrings'].filter((value): value is string => typeof value === 'string')
      : [],
    placement: placement.length > 0 ? [...new Set(placement)] : [RegexPlacement.AI_OUTPUT],
    disabled: bool(obj['disabled'], false),
    markdownOnly: bool(obj['markdownOnly'], false),
    promptOnly: bool(obj['promptOnly'], false),
    runOnEdit: bool(obj['runOnEdit'], false),
    substituteRegex: bool(obj['substituteRegex'], false),
    minDepth: numOrNull(obj['minDepth']),
    maxDepth: numOrNull(obj['maxDepth']),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

/** 序列化为 ST 全局导出数组条目形态。 */
export function serializeRegexScript(ir: RegexScriptIR): Record<string, unknown> {
  return {
    ...(ir.extra ?? {}),
    id: ir.id,
    scriptName: ir.scriptName,
    findRegex: ir.findRegex,
    replaceString: ir.replaceString,
    trimStrings: [...ir.trimStrings],
    placement: [...ir.placement],
    disabled: ir.disabled,
    markdownOnly: ir.markdownOnly,
    promptOnly: ir.promptOnly,
    runOnEdit: ir.runOnEdit,
    substituteRegex: ir.substituteRegex,
    ...(ir.minDepth === null ? {} : { minDepth: ir.minDepth }),
    ...(ir.maxDepth === null ? {} : { maxDepth: ir.maxDepth }),
  }
}

/** placement 位集合判断。 */
export function hasPlacement(script: RegexScriptIR, placement: number): boolean {
  return script.placement.includes(placement)
}

/* ------------------------------ 内部 ------------------------------ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
