/**
 * GitHub 版本发现的纯逻辑层：URL 构造、响应解析、本地与远端构建的比较。
 *
 * 为什么不用 GitHub Releases：LingyeSoul/dsh-tavern 不发 release、不打 tag，
 * 桌面版 profile 的依赖是 git spec（`git+https://github.com/LingyeSoul/dsh-tavern.git`，
 * lockfile 把它解析成 `<commit>&path:/packages/plugin`）。所以「新版本」只能以
 * main 分支最新 commit + `packages/plugin/package.json` 的 version 为准。
 *
 * 本文件不做 IO：网络与文件读写留在 service.ts / apply.ts，便于单测覆盖
 * 比较规则、压缩字段和降级来源。
 */

export const UPDATE_REPOSITORY = 'LingyeSoul/dsh-tavern'
export const UPDATE_REF = 'main'
/** 插件包在 monorepo 中的子目录（pnpm git spec 的 `path:` 段）。 */
export const UPDATE_PLUGIN_PATH = '/packages/plugin'
/** 构建 stamp 缺失时的兜底：只有版本号可比，commit 不明。 */
export const UNKNOWN_FIELD = 'unknown'

export type TavernUpdateStatus = 'unknown' | 'up-to-date' | 'update-available' | 'local-ahead'
export type TavernUpdateSource = 'api' | 'raw-git' | 'atom' | 'cache'

export interface TavernUpdateCommit {
  sha: string
  short: string
  message: string
  date: string
  url: string
}

export interface TavernRemoteBuild {
  ref: string
  version: string
  commit: string
  source: TavernUpdateSource
  commits: TavernUpdateCommit[]
  /** 本地 commit..远端 commit 之间被改动的插件文件（无法判定时为空数组）。 */
  changedPluginFiles: string[]
  /** changedPluginFiles 是否来自可信来源（api 的 compare）；false 表示「未知」而非「无改动」。 */
  filesKnown: boolean
  checkedAt: string
}

export interface TavernUpdateComparison {
  status: TavernUpdateStatus
  reason: string
}

export interface TavernLocalBuild {
  version: string
  commit: string
}

export function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())
}

export function shortCommit(value: unknown): string {
  return isCommit(value) ? value.trim().slice(0, 7).toLowerCase() : UNKNOWN_FIELD
}

export function repositorySlug(repository: string): string {
  return repository.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
}

export function commitsApiUrl(repository: string, ref: string): string {
  return `https://api.github.com/repos/${repositorySlug(repository)}/commits/${encodeURIComponent(ref)}`
}

export function compareApiUrl(repository: string, base: string, head: string): string {
  return `https://api.github.com/repos/${repositorySlug(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
}

/** raw.githubusercontent 不消耗 API 配额，用于只读一个 version 字段。 */
export function packageJsonUrl(repository: string, ref: string): string {
  return `https://raw.githubusercontent.com/${repositorySlug(repository)}/${encodeURIComponent(ref)}/packages/plugin/package.json`
}

export function commitsAtomUrl(repository: string, ref: string): string {
  return `https://github.com/${repositorySlug(repository)}/commits/${encodeURIComponent(ref)}.atom`
}

export function commitWebUrl(repository: string, sha: string): string {
  return `https://github.com/${repositorySlug(repository)}/commit/${sha}`
}

/**
 * 语义化版本比较，非法/缺失一律当作 0.0.0（远端读到坏版本号时不应把更新
 * 误判成可用）。只处理数字点分与常见的 `-rc.N` 预发布后缀。
 */
export function compareTavernVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const a = parsedLeft.numbers[index] ?? 0
    const b = parsedRight.numbers[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  if (parsedLeft.prerelease === parsedRight.prerelease) return 0
  if (parsedLeft.prerelease === '') return 1
  if (parsedRight.prerelease === '') return -1
  return parsedLeft.prerelease < parsedRight.prerelease ? -1 : 1
}

function parseVersion(value: unknown): { numbers: number[], prerelease: string } {
  const text = typeof value === 'string' ? value.trim().replace(/^v/i, '') : ''
  const [core = '', prerelease = ''] = text.split('-', 2)
  const numbers = core.split('.').slice(0, 3).map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  return { numbers, prerelease }
}

/** 改动路径里是否包含插件包本体（决定同版本号但新 commit 时算不算可更新）。 */
export function pluginFilesIn(files: readonly string[]): string[] {
  return files.filter((file) => {
    const normalized = String(file).replace(/^\/+/, '')
    return normalized === 'packages/plugin' || normalized.startsWith('packages/plugin/')
  })
}

/**
 * 本地构建 vs 远端构建的判定规则：
 * 1. commit 相同 → 已是最新；
 * 2. 两边版本号都可读时按语义化版本比：远端更高 → 可更新；更低 → 本地领先；
 * 3. 版本号相同但 commit 不同：
 *    - 改动清单可信（api 的 compare）且不含 `packages/plugin/` → 已是最新（文档
 *      或 CI 提交不该把每个用户拖进一次无意义的 pnpm 安装）；
 *    - 改动清单不可信（api.github.com 被限流/拦截，只剩 raw + git ls-remote）
 *      → 判为可更新：这个仓库的版本号不随每次提交变，把「读不到改动」当成
 *      「没有改动」会让被墙或被限流的用户永远收不到新版本；
 * 4. 远端版本号读不到时同样退到 commit 判定（分支最新 commit 与本地不同即可更新）；
 * 5. 两边都无法比较时返回 unknown，不谎报最新。
 */
export function compareBuilds(input: {
  local: TavernLocalBuild
  remote: Pick<TavernRemoteBuild, 'version' | 'commit' | 'changedPluginFiles'> & { filesKnown?: boolean }
}): TavernUpdateComparison {
  const localCommit = isCommit(input.local.commit) ? input.local.commit.trim().toLowerCase().slice(0, 7) : UNKNOWN_FIELD
  const remoteCommit = isCommit(input.remote.commit) ? input.remote.commit.trim().toLowerCase() : UNKNOWN_FIELD
  if (localCommit !== UNKNOWN_FIELD && remoteCommit !== UNKNOWN_FIELD && remoteCommit.startsWith(localCommit)) {
    return { status: 'up-to-date', reason: `already at ${remoteCommit.slice(0, 7)}` }
  }
  const remoteVersionKnown = isKnownVersion(input.remote.version)
  const localVersionKnown = isKnownVersion(input.local.version)
  if (remoteVersionKnown && localVersionKnown) {
    const order = compareTavernVersions(input.remote.version, input.local.version)
    if (order > 0) return { status: 'update-available', reason: `version ${input.remote.version} > ${input.local.version}` }
    if (order < 0) return { status: 'local-ahead', reason: `local version ${input.local.version} > ${input.remote.version}` }
    const filesKnown = input.remote.filesKnown ?? input.remote.changedPluginFiles.length > 0
    if (filesKnown) {
      if (pluginFilesIn(input.remote.changedPluginFiles).length > 0) {
        return { status: 'update-available', reason: `plugin files changed at ${remoteCommit.slice(0, 7)}` }
      }
      return { status: 'up-to-date', reason: `same version ${input.local.version} and no plugin file changed` }
    }
    if (localCommit !== UNKNOWN_FIELD && remoteCommit !== UNKNOWN_FIELD) {
      return {
        status: 'update-available',
        reason: `remote commit ${remoteCommit.slice(0, 7)} differs from ${localCommit}; changed files are unavailable on this source`,
      }
    }
    return { status: 'up-to-date', reason: `same version ${input.local.version}` }
  }
  if (localCommit !== UNKNOWN_FIELD && remoteCommit !== UNKNOWN_FIELD) {
    return {
      status: 'update-available',
      reason: `remote commit ${remoteCommit.slice(0, 7)} differs from ${localCommit} (remote version unavailable)`,
    }
  }
  return {
    status: 'unknown',
    reason: remoteVersionKnown || localVersionKnown
      ? 'the local build has no commit stamp, so only the version could be compared'
      : 'neither the remote version nor a comparable commit could be read',
  }
}

export function isKnownVersion(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== UNKNOWN_FIELD
}

function commitFromApi(value: unknown): TavernUpdateCommit | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, any>
  const sha = typeof record.sha === 'string' ? record.sha : ''
  if (!isCommit(sha)) return null
  const commit = record.commit ?? {}
  return {
    sha,
    short: sha.slice(0, 7),
    message: firstLine(commit.message),
    date: typeof commit.author?.date === 'string' ? commit.author.date : (typeof commit.committer?.date === 'string' ? commit.committer.date : ''),
    url: typeof record.html_url === 'string' ? record.html_url : commitWebUrl(UPDATE_REPOSITORY, sha),
  }
}

/** GitHub REST `/commits/{ref}` 响应。 */
export function parseCommitResponse(value: unknown): TavernUpdateCommit | null {
  return commitFromApi(value)
}

/** GitHub REST `/compare/{base}...{head}` 响应：commits 倒序（最新在前）+ files。 */
export function parseCompareResponse(value: unknown): { commits: TavernUpdateCommit[], files: string[], filesKnown: boolean } {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, any>
  const filesKnown = Array.isArray(record.files)
  const commits = Array.isArray(record.commits)
    ? record.commits.map(commitFromApi).filter((item): item is TavernUpdateCommit => item !== null)
    : []
  const files = filesKnown
    ? record.files.map((file: any) => (typeof file?.filename === 'string' ? file.filename : '')).filter(Boolean)
    : []
  return { commits: commits.reverse(), files, filesKnown }
}

export function parsePackageVersion(value: unknown): string {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return typeof record.version === 'string' && record.version.trim() !== '' ? record.version.trim() : UNKNOWN_FIELD
}

/**
 * `https://github.com/<repo>/commits/<ref>.atom` 的最小解析器：只取 entry 的
 * id（tag:…/commit/<sha>）、title、updated。api.github.com 被网络策略拦截时
 * 这是唯一还能拿到 commit 的公开入口。
 */
export function parseAtomFeed(xml: string): TavernUpdateCommit[] {
  const entries = String(xml ?? '').split(/<entry>/i).slice(1)
  const commits: TavernUpdateCommit[] = []
  for (const entry of entries) {
    const sha = /<id>[^<]*?(?:commit\/|\/commit\/)([0-9a-f]{7,40})<\/id>/i.exec(entry)?.[1]
      ?? /commit\/([0-9a-f]{7,40})/i.exec(entry)?.[1]
    if (!isCommit(sha)) continue
    commits.push({
      sha,
      short: sha.slice(0, 7),
      message: decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(entry)?.[1] ?? ''),
      date: /<updated>([^<]*)<\/updated>/i.exec(entry)?.[1] ?? '',
      url: commitWebUrl(UPDATE_REPOSITORY, sha),
    })
  }
  return commits
}

export function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstLine(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  return text.split('\n')[0]?.trim() ?? ''
}

/** pnpm git spec：`github:owner/repo#<ref>&path:/packages/plugin`。 */
export function pluginInstallSpec(repository: string, ref: string, commit?: string): string {
  const target = isCommit(commit) ? commit!.trim() : ref
  return `github:${repositorySlug(repository)}#${target}&path:${UPDATE_PLUGIN_PATH}`
}
