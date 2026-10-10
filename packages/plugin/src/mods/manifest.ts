/**
 * Mod 清单（mod.json）校验与 engines semver 匹配（提案 0015 §3.2，P1）。
 *
 * 校验是**纯函数**（不触文件系统）：加载器先读 mod.json、过这里，形状合法才
 * 允许继续到入口 ESM 的动态 import——「加载前只读清单不执行代码」是知情同意
 * 的前提。文件级检查（入口存在、data 目录）在 host.ts 的装载路径里做。
 *
 * semver 匹配器自写小型实现：仓库零运行时依赖（esbuild/typescript 之外），
 * 引入 semver 包只为一个范围判断不值当。支持的语法见 satisfiesVersionRange
 * 文档；prerelease 后缀解析后忽略（宿主版本不带 prerelease，比较按 core 三段）。
 */

/** Mod id：单段 `[a-z0-9-]` 或以 `.` 连接的多段（反域名）。目录名必须与 id 相同。 */
export const MOD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
export const MOD_ID_MAX_LENGTH = 100

/** 知情同意标签（提案 §3.3）：声明面，不是强制隔离。 */
export const MOD_CAPABILITIES = ['llm', 'network', 'storage'] as const
export type ModCapability = (typeof MOD_CAPABILITIES)[number]

export interface ModPanelDeclaration {
  title: string
  icon?: string
}

/**
 * 注册面声明（提案 0015 §3.5，P2）：作者在 manifest 里自查将注册的 hooks/
 * tools/http 路由，启用确认弹层如实展示（知情同意面）。声明不是契约——已装载
 * mod 的快照展示**实际注册**的名单，声明只在未装载时兜底展示。
 */
export interface ModSurfacesDeclaration {
  hooks: string[]
  tools: string[]
  http: string[]
}

export interface ModManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  main: string
  engines?: { dshTavern?: string }
  loadingOrder: number
  capabilities: ModCapability[]
  panel?: ModPanelDeclaration
  surfaces: ModSurfacesDeclaration
}

export type ManifestCheck = { ok: true; manifest: ModManifest } | { ok: false; errors: string[] }

export interface ManifestCheckOptions {
  /** mod.json 所在目录名：清单 id 必须与之一致（路由寻址与去重的 WYSIWYG 前提）。 */
  directory: string
}

/** 校验未加工的 mod.json 解析结果。所有失败形态都进 errors（逐条可展示）。 */
export function checkModManifest(raw: unknown, options: ManifestCheckOptions): ManifestCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['mod.json must be a JSON object'] }
  }
  const record = raw as Record<string, unknown>
  const errors: string[] = []

  const id = record.id
  if (typeof id !== 'string' || id === '') errors.push('id is required')
  else if (id.length > MOD_ID_MAX_LENGTH) errors.push(`id must be at most ${MOD_ID_MAX_LENGTH} characters`)
  else if (!MOD_ID_PATTERN.test(id)) errors.push("id must be [a-z0-9-] labels or reverse-domain joined by '.'")
  else if (id !== options.directory) errors.push(`id '${id}' must match the directory name '${options.directory}'`)

  for (const field of ['name', 'version', 'author', 'description', 'main'] as const) {
    const value = record[field]
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${field} is required and must be a non-empty string`)
    else if (value.length > 2000) errors.push(`${field} must be at most 2000 characters`)
  }

  if (typeof record.main === 'string') {
    const mainError = checkMainPath(record.main)
    if (mainError !== undefined) errors.push(mainError)
  }

  if (record.engines !== undefined) {
    if (typeof record.engines !== 'object' || record.engines === null || Array.isArray(record.engines)) {
      errors.push('engines must be an object')
    } else {
      const range = (record.engines as Record<string, unknown>)['dsh-tavern']
      if (range !== undefined && (typeof range !== 'string' || range.trim() === '')) {
        errors.push("engines['dsh-tavern'] must be a non-empty semver range string")
      }
    }
  }

  if (record.loadingOrder !== undefined) {
    if (typeof record.loadingOrder !== 'number' || !Number.isFinite(record.loadingOrder)) {
      errors.push('loadingOrder must be a finite number')
    }
  }

  if (record.capabilities !== undefined) {
    if (!Array.isArray(record.capabilities)) {
      errors.push('capabilities must be an array')
    } else {
      const known = new Set<string>(MOD_CAPABILITIES)
      for (const capability of record.capabilities) {
        if (typeof capability !== 'string' || !known.has(capability)) {
          errors.push(`capabilities entries must be one of ${MOD_CAPABILITIES.join('|')}`)
          break
        }
      }
    }
  }

  if (record.panel !== undefined && record.panel !== null) {
    if (typeof record.panel !== 'object' || Array.isArray(record.panel)) {
      errors.push('panel must be an object')
    } else {
      const panel = record.panel as Record<string, unknown>
      if (typeof panel.title !== 'string' || panel.title.trim() === '') {
        errors.push('panel.title is required when panel is declared')
      }
      if (panel.icon !== undefined && (typeof panel.icon !== 'string' || panel.icon.trim() === '')) {
        errors.push('panel.icon must be a non-empty string')
      }
    }
  }

  if (record.surfaces !== undefined && record.surfaces !== null) {
    if (typeof record.surfaces !== 'object' || Array.isArray(record.surfaces)) {
      errors.push('surfaces must be an object')
    } else {
      const surfaces = record.surfaces as Record<string, unknown>
      for (const field of ['hooks', 'tools', 'http'] as const) {
        if (surfaces[field] === undefined) continue
        const value = surfaces[field]
        if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > 200)) {
          errors.push(`surfaces.${field} must be an array of non-empty strings (at most 32)`)
          break
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const engines = record.engines as Record<string, unknown> | undefined
  const engineRange = engines?.['dsh-tavern']
  const panel = record.panel as Record<string, unknown> | undefined
  const surfaces = record.surfaces as Record<string, unknown> | undefined
  const pickStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const manifest: ModManifest = {
    id: record.id as string,
    name: record.name as string,
    version: record.version as string,
    author: record.author as string,
    description: record.description as string,
    main: (record.main as string).trim(),
    ...(engineRange !== undefined ? { engines: { dshTavern: engineRange as string } } : {}),
    loadingOrder: typeof record.loadingOrder === 'number' ? record.loadingOrder : 100,
    capabilities: Array.isArray(record.capabilities)
      ? [...new Set(record.capabilities as ModCapability[])]
      : [],
    ...(panel !== undefined && typeof panel.title === 'string'
      ? { panel: { title: panel.title, ...(typeof panel.icon === 'string' ? { icon: panel.icon } : {}) } }
      : {}),
    surfaces: surfaces === undefined || surfaces === null
      ? { hooks: [], tools: [], http: [] }
      : { hooks: pickStrings(surfaces.hooks), tools: pickStrings(surfaces.tools), http: pickStrings(surfaces.http) },
  }
  return { ok: true, manifest }
}

/** main 字段：相对路径、不得越出 mod 目录（拒绝 `..`/绝对路径/反斜杠段）。 */
function checkMainPath(main: string): string | undefined {
  const text = main.trim()
  if (text === '') return 'main is required and must be a non-empty string'
  if (text !== main) return 'main must not have surrounding whitespace'
  // 反斜杠一律拒绝；POSIX 绝对路径在段检查里被空首段拒绝。
  if (text.includes('\\')) return 'main must use / path separators and stay inside the mod directory'
  const segments = text.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return 'main must be a relative path inside the mod directory (no .. or absolute paths)'
  }
  if (!/\.[a-z0-9]+$/i.test(text)) return 'main must point at an entry file (with extension)'
  return undefined
}

/* ------------------------------ semver 匹配 ------------------------------ */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

export function parseSemver(input: string): ParsedVersion | undefined {
  const text = input.trim()
  if (!/^\d+(?:\.\d+)?(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(text)) return undefined
  const core = text.split(/[-+]/, 1)[0] ?? ''
  const [major = '0', minor = '0', patch = '0'] = core.split('.')
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

export function compareSemver(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

export interface VersionRangeVerdict {
  ok: boolean
  /** 不满足/无法判定时的原因（面板与审计直接展示）。 */
  reason: string
}

/**
 * 判定 version 是否满足 range。语法：`||` 分隔的多选一；每个分支是空格分隔的
 * AND 比较器：`*`、`>=v`、`<=v`、`>v`、`<v`、`=v`/`v`（精确）、`^v`（leftmost
 * nonzero 起的次段上限，`^0.5.1` ⇒ `>=0.5.1 <0.6.0`）、`~v`（`~0.5.1` ⇒
 * `>=0.5.1 <0.6.0`；`~0.5` ⇒ `>=0.5.0 <0.6.0`）。缺段补 0。版本或范围不可
 * 解析 ⇒ fail-closed（不满足，带原因）。
 */
export function satisfiesVersionRange(version: string, range: string): VersionRangeVerdict {
  const parsedVersion = parseSemver(version)
  if (parsedVersion === undefined) {
    return { ok: false, reason: `host version '${version}' is not a parseable semver` }
  }
  const alternatives = range.split('||')
  const invalid: string[] = []
  let matched = false
  for (const alternative of alternatives) {
    const comparators = alternative.trim().split(/\s+/).filter((item) => item !== '' && item !== '*')
    if (alternative.trim() === '' ) continue
    if (alternative.trim() === '*' || comparators.every((item) => item === '*')) {
      matched = true
      continue
    }
    let satisfied = true
    for (const comparator of comparators) {
      const verdict = satisfiesComparator(parsedVersion, comparator)
      if (verdict === 'invalid') {
        invalid.push(comparator)
        satisfied = false
        break
      }
      if (!verdict) {
        satisfied = false
        break
      }
    }
    if (satisfied && invalid.length === 0) matched = true
  }
  if (invalid.length > 0) {
    return { ok: false, reason: `range '${range}' has an invalid comparator '${invalid[0]}'` }
  }
  return matched
    ? { ok: true, reason: '' }
    : { ok: false, reason: `requires dsh-tavern ${range} (host ${version})` }
}

function satisfiesComparator(version: ParsedVersion, comparator: string): boolean | 'invalid' {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
  if (match === null) return 'invalid'
  const operator = match[1] ?? '='
  const literal = match[2]!.trim()
  if (literal === '*') return true
  const parsed = parseSemver(literal)
  if (parsed === undefined) return 'invalid'
  const specified = countSpecifiedSegments(literal)
  switch (operator) {
    case '=': {
      // 精确匹配按补 0 后的核心段比较（`0.5` == `0.5.0`）。
      return compareSemver(version, parsed) === 0
    }
    case '>':
      return compareSemver(version, parsed) > 0
    case '<':
      return compareSemver(version, parsed) < 0
    case '>=':
      return compareSemver(version, parsed) >= 0
    case '<=':
      return compareSemver(version, parsed) <= 0
    case '^': {
      const upper = caretUpperBound(parsed)
      return compareSemver(version, parsed) >= 0 && compareSemver(version, upper) < 0
    }
    case '~': {
      const upper = specified >= 2
        ? { major: parsed.major, minor: parsed.minor + 1, patch: 0 }
        : { major: parsed.major + 1, minor: 0, patch: 0 }
      return compareSemver(version, parsed) >= 0 && compareSemver(version, upper) < 0
    }
    default:
      return 'invalid'
  }
}

function caretUpperBound(parsed: ParsedVersion): ParsedVersion {
  if (parsed.major > 0) return { major: parsed.major + 1, minor: 0, patch: 0 }
  if (parsed.minor > 0) return { major: 0, minor: parsed.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: parsed.patch + 1 }
}

function countSpecifiedSegments(literal: string): number {
  return (literal.split(/[-+]/, 1)[0] ?? '').split('.').filter((part) => part !== '').length
}
