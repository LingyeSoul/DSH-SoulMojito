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
  UPDATE_PLUGIN_MANIFEST,
  commitsApiUrl,
  commitsAtomUrl,
  compareApiUrl,
  contentsApiUrl,
  isCommit,
  packageJsonUrl,
  parseAtomFeed,
  parseCommitResponse,
  parseCompareResponse,
  parseContentsJson,
  parsePackageVersion,
  shortCommit,
  type TavernRemoteBuild,
  type TavernUpdateCommit,
} from './github.js'
import { envCompat } from '../env-compat.js'

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
/** 5xx/网络抖动只重试一次：单发请求把一次 502 变成「版本号未知」并缓存 6h。 */
const HTTP_ATTEMPTS = 2
const HTTP_RETRY_DELAY_MS = 200

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
  const version = await readPackageVersion(options, latest.sha, true)
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
    readPackageVersion(options, ref, false),
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
  const version = await readPackageVersion(options, latest.sha, false)
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

/**
 * 读远端 package.json 的 version。两条只读路线互为兜底：
 * - `api`  → api.github.com/contents（带 token 可用，与 commits/compare 同源）；
 * - `raw`  → raw.githubusercontent.com（不吃配额，且 token 不会发过去）。
 * api 来源优先 api 路线（它已被证明可达）；raw-git/atom 来源优先 raw，但 raw
 * 偶发 502 时会重试一次再换 api 路线——api 只剩版本口可用时也能读到版本号。
 *
 * 版本读不到不影响 commit 判定（比较规则会退化为「版本相同 + 文件改动」），
 * 因此这里降级为 unknown 而不是把整个来源判死。
 */
async function readPackageVersion(
  options: FetchRemoteOptions,
  ref: string,
  preferApi: boolean,
): Promise<string> {
  const routes = preferApi ? ['api', 'raw'] as const : ['raw', 'api'] as const
  for (const route of routes) {
    try {
      const raw = await getJson(options, route === 'api'
        ? contentsApiUrl(options.repository, UPDATE_PLUGIN_MANIFEST, ref)
        : packageJsonUrl(options.repository, ref))
      const version = parsePackageVersion(route === 'api' ? parseContentsJson(raw) : raw)
      if (version !== UNKNOWN_FIELD) return version
    } catch {
    }
  }
  return UNKNOWN_FIELD
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
 * `DSH_SOULMOJITO_DISABLE_CURL=1` 可关掉 curl 兜底（不装 curl 的宿主、离线测试）。
 * 5xx / 429 / 连接抖动重试一次：单发请求把一次瞬时 502 变成「版本号未知」并
 * 缓存 6h，正是「GitHub v?」的来源。证书与 4xx 重试没有新信息，直接失败。
 * P2 起导出：mod git 安装的元数据预读复用同一降级链（提案 0015 §4）。
 */
export async function httpGet(options: FetchRemoteOptions, url: string, accept: string): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt += 1) {
    try {
      return await httpGetOnce(options, url, accept, timeoutMs)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= HTTP_ATTEMPTS || !isTransientHttpFailure(lastError)) break
      await delay(HTTP_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError ?? new Error(`GET ${url} failed without a captured error`)
}

async function httpGetOnce(
  options: FetchRemoteOptions,
  url: string,
  accept: string,
  timeoutMs: number,
): Promise<string> {
  const failures: string[] = []
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  if (typeof fetchImpl === 'function') {
    try {
      const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
      const response = await fetchImpl(url, {
        headers: {
          accept,
          'user-agent': 'dsh-soulmojito-update-check',
          // raw.githubusercontent.com 收到 authorization 会回 404（不是 401），
          // 于是带 token 的用户读不到 package.json，面板显示「GitHub v?」。
          ...(token !== '' && acceptsToken(url) ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      failures.push(`fetch: ${describeError(error)}`)
    }
  }
  const curlDisabled = (envCompat('DISABLE_CURL') ?? '').trim() !== ''
  if (!curlDisabled) {
    try {
      return await (options.curlImpl ?? curlGet)(url, accept, timeoutMs)
    } catch (error) {
      failures.push(`curl: ${describeError(error)}`)
    }
  }
  throw new Error(failures.join(' | '))
}

/** 只有 api.github.com 接受 Authorization；raw/codeload 收到它反而回 404。 */
function acceptsToken(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'api.github.com'
  } catch {
    return false
  }
}

/** 只重试瞬时失败；证书问题、401/403/404 再打一次也不会有新结果。 */
function isTransientHttpFailure(error: Error): boolean {
  const message = error.message
  if (/certificate|cert_|self.signed|unable to verify/i.test(message)) return false
  if (/HTTP\s*(?:5\d\d|429)/i.test(message)) return true
  return /ECONNRESET|EPIPE|EAI_AGAIN|socket hang up|network is unreachable/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 * 非零退出码，`--max-time` 与 fetch 的超时对齐。`DSH_SOULMOJITO_CURL` 可覆盖路径。
 */
export function curlGet(url: string, accept: string, timeoutMs: number, exec = execFile): Promise<string> {
  const command = envCompat('CURL')?.trim() || (process.platform === 'win32' ? 'curl.exe' : 'curl')
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)))
  return new Promise((resolve, reject) => {
    exec(command, [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--max-time', seconds,
      '-H', `accept: ${accept}`,
      '-H', 'user-agent: dsh-soulmojito-update-check',
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
