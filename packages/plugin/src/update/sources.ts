/**
 * 远端构建的抓取层。三个来源按可用性降级，任一成功即返回：
 *
 * 1. `api`      — api.github.com `/commits/{ref}` + `/compare/...` + raw package.json。
 *                 信息最全（changelog、被改动文件），但有 60/h 的匿名配额，
 *                 且部分网络策略会拦截。
 * 2. `raw-git`  — raw.githubusercontent.com 读 version + `git ls-remote` 取 commit。
 *                 不吃 API 配额，依赖本机 git（桌面版 profile 的安装本来就要 git）。
 * 3. `atom`     — github.com 的 commits atom feed，只有 commit 元数据。
 *
 * 每个 HTTP 请求都先走 `fetch`，失败再走 `curl`：企业 TLS 中间人场景下 node 的
 * CA bundle 不认本机根证书（`unable to verify the first certificate`），而
 * curl/git 用系统证书库。curl 不可用时只影响 HTTP 来源，`raw-git` 里的
 * `git ls-remote` 仍然能给出版本之外的 commit 判定。
 *
 * 任一来源失败都不抛错到调用方：service 把失败折进快照的 `error` 字段，
 * 保证「检查更新」永远不会让插件启动或页面渲染失败。
 */
import { execFile } from 'node:child_process'
import {
  UNKNOWN_FIELD,
  commitsApiUrl,
  commitsAtomUrl,
  compareApiUrl,
  isCommit,
  packageJsonUrl,
  parseAtomFeed,
  parseCommitResponse,
  parseCompareResponse,
  parsePackageVersion,
  shortCommit,
  type TavernRemoteBuild,
  type TavernUpdateCommit,
} from './github.js'

export interface FetchLike {
  (url: string, init?: Record<string, unknown>): Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    text: () => Promise<string>
  }>
}

export interface FetchRemoteOptions {
  repository: string
  ref: string
  /** 本地 commit；有值时才能用 compare 判定「同版本但插件文件有改动」。 */
  localCommit?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  token?: string
  maxCommits?: number
  now?: () => Date
  /** raw-git 来源解析远端 commit 的实现；测试注入替身，避免真的跑 git。 */
  resolveCommitImpl?: (repository: string, ref: string, timeoutMs: number) => Promise<string>
  /** fetch 失败后的 HTTP 兜底；测试注入替身，避免真跑 curl。 */
  curlImpl?: (url: string, accept: string, timeoutMs: number) => Promise<string>
}

export interface FetchRemoteResult {
  build: TavernRemoteBuild | null
  error: string
}

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_COMMITS = 12

export async function fetchRemoteBuild(options: FetchRemoteOptions): Promise<FetchRemoteResult> {
  const failures: string[] = []
  for (const source of ['api', 'raw-git', 'atom'] as const) {
    try {
      const build = source === 'api'
        ? await fetchFromApi(options)
        : source === 'raw-git' ? await fetchFromRawAndGit(options) : await fetchFromAtom(options)
      if (build !== null) return { build, error: '' }
      failures.push(`${source}: no commit found`)
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { build: null, error: failures.join('; ') }
}

async function fetchFromApi(options: FetchRemoteOptions): Promise<TavernRemoteBuild | null> {
  const { repository, ref, localCommit = UNKNOWN_FIELD } = options
  const now = options.now ?? (() => new Date())
  const latest = parseCommitResponse(await getJson(options, commitsApiUrl(repository, ref)))
  if (latest === null) return null
  let version = UNKNOWN_FIELD
  try {
    version = parsePackageVersion(await getJson(options, packageJsonUrl(repository, latest.sha)))
  } catch {
    // version 读不到不影响 commit 判定；比较规则会退化为「版本相同 + 文件改动」。
  }
  let commits: TavernUpdateCommit[] = [latest]
  let changedPluginFiles: string[] = []
  let filesKnown = false
  if (isCommit(localCommit) && !latest.sha.startsWith(localCommit.trim().slice(0, 7))) {
    try {
      const compared = parseCompareResponse(await getJson(options, compareApiUrl(repository, localCommit, latest.sha)))
      if (compared.commits.length > 0) commits = compared.commits
      changedPluginFiles = compared.files
      filesKnown = compared.filesKnown
    } catch {
      // compare 失败（例如本地 commit 不在远端历史里）时退化为「只看最新 commit」。
    }
  } else if (isCommit(localCommit)) {
    // commit 相同：没有可比区间，文件清单视为「已知无改动」。
    filesKnown = true
  }
  return {
    ref,
    version,
    commit: latest.sha,
    source: 'api',
    commits: commits.slice(0, options.maxCommits ?? DEFAULT_MAX_COMMITS),
    changedPluginFiles,
    filesKnown,
    checkedAt: now().toISOString(),
  }
}

async function fetchFromRawAndGit(options: FetchRemoteOptions): Promise<TavernRemoteBuild | null> {
  const { repository, ref } = options
  const now = options.now ?? (() => new Date())
  const [version, commit] = await Promise.all([
    getJson(options, packageJsonUrl(repository, ref)).then(parsePackageVersion).catch(() => UNKNOWN_FIELD),
    (options.resolveCommitImpl ?? resolveRemoteCommit)(repository, ref, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ])
  if (!isCommit(commit)) return null
  return {
    ref,
    version,
    commit: commit.toLowerCase(),
    source: 'raw-git',
    commits: [{
      sha: commit.toLowerCase(),
      short: shortCommit(commit),
      message: '',
      date: '',
      url: `https://github.com/${repository.replace(/\.git$/i, '')}/commit/${commit.toLowerCase()}`,
    }],
    changedPluginFiles: [],
    filesKnown: false,
    checkedAt: now().toISOString(),
  }
}

async function fetchFromAtom(options: FetchRemoteOptions): Promise<TavernRemoteBuild | null> {
  const { repository, ref } = options
  const now = options.now ?? (() => new Date())
  const xml = await getText(options, commitsAtomUrl(repository, ref), 'application/atom+xml, text/xml, */*')
  const commits = parseAtomFeed(xml)
  const latest = commits[0]
  if (latest === undefined) return null
  let version = UNKNOWN_FIELD
  try {
    version = parsePackageVersion(await getJson(options, packageJsonUrl(repository, latest.sha)))
  } catch {
  }
  return {
    ref,
    version,
    commit: latest.sha,
    source: 'atom',
    commits: commits.slice(0, options.maxCommits ?? DEFAULT_MAX_COMMITS),
    changedPluginFiles: [],
    filesKnown: false,
    checkedAt: now().toISOString(),
  }
}

/** `git ls-remote` 是 raw 来源取 commit 的唯一手段；超时/缺失一律返回空串。 */
export function resolveRemoteCommit(repository: string, ref: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const url = /^https?:|^git@/i.test(repository) ? repository : `https://github.com/${repository.replace(/^\//, '')}.git`
    execFile('git', ['ls-remote', url, `refs/heads/${ref}`, ref], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error) {
        resolve('')
        return
      }
      const first = String(stdout ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
      resolve(first.split(/\s+/)[0] ?? '')
    })
  })
}

async function getJson(options: FetchRemoteOptions, url: string): Promise<unknown> {
  return JSON.parse(await getText(options, url, 'application/vnd.github+json'))
}

async function getText(options: FetchRemoteOptions, url: string, accept: string): Promise<string> {
  return httpGet(options, url, accept)
}

/**
 * fetch → curl 的两级抓取。两级都失败时把两边的原因一起抛出去，便于在快照的
 * `error` 里分辨「网络不通」「证书不受信」「HTTP 4xx」。
 * `DSH_TAVERN_DISABLE_CURL=1` 可关掉 curl 兜底（不装 curl 的宿主、离线测试）。
 * P2 起导出：mod git 安装的元数据预读复用同一降级链（提案 0015 §4）。
 */
export async function httpGet(options: FetchRemoteOptions, url: string, accept: string): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const failures: string[] = []
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  if (typeof fetchImpl === 'function') {
    try {
      const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
      const response = await fetchImpl(url, {
        headers: {
          accept,
          'user-agent': 'dsh-tavern-update-check',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      failures.push(`fetch: ${describeError(error)}`)
    }
  }
  const curlDisabled = (process.env.DSH_TAVERN_DISABLE_CURL ?? '').trim() !== ''
  if (!curlDisabled) {
    try {
      return await (options.curlImpl ?? curlGet)(url, accept, timeoutMs)
    } catch (error) {
      failures.push(`curl: ${describeError(error)}`)
    }
  }
  throw new Error(failures.join(' | '))
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
    return detail === '' ? error.message : `${error.message} (${detail})`
  }
  return String(error)
}

/**
 * 用系统 curl 抓取：Windows 自带 `curl.exe`（Schannel，走 Windows 根证书库，
 * 能过企业 TLS 中间人），其他平台用 `curl`。`--fail` 让 HTTP 4xx/5xx 变成
 * 非零退出码，`--max-time` 与 fetch 的超时对齐。`DSH_TAVERN_CURL` 可覆盖路径。
 */
export function curlGet(url: string, accept: string, timeoutMs: number, exec = execFile): Promise<string> {
  const command = process.env.DSH_TAVERN_CURL?.trim() || (process.platform === 'win32' ? 'curl.exe' : 'curl')
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)))
  return new Promise((resolve, reject) => {
    exec(command, [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--max-time', seconds,
      '-H', `accept: ${accept}`,
      '-H', 'user-agent: dsh-tavern-update-check',
      url,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs + 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        const detail = String(stdout ?? '').trim()
        reject(new Error(detail === '' ? error.message : `${error.message}: ${detail}`))
        return
      }
      resolve(String(stdout ?? ''))
    })
  })
}
