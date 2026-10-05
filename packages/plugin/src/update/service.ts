/**
 * 插件自更新服务：把「从 GitHub 发现新版本」和「一键更新」收敛成一份可被
 * bootstrap / HTTP 路由 / 客户端轮询共用的快照。
 *
 * 设计要点：
 * - 自动发现默认开启（延迟首查 + 周期复查），但所有网络失败都只写进快照的
 *   `error`，绝不影响插件挂载与页面渲染；TTL 内复用磁盘缓存，避免每次启动
 *   都打 GitHub。
 * - 缓存落在 `$DSH_HOME/tavern/update-state.json`，与 Tavern 数据同根，随
 *   profile 走；写入失败静默降级为内存态。
 * - 安装只允许一个在飞任务，进度以环形日志暴露给轮询端点。
 * - 包替换必须重启进程（宿主 plugin-manager 的既有语义），因此安装成功后
 *   状态进入 `restart-required`，在本地构建 stamp 追上已安装 commit 之前
 *   不再重复提示更新。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  UNKNOWN_FIELD,
  UPDATE_REF,
  UPDATE_REPOSITORY,
  compareBuilds,
  pluginInstallSpec,
  shortCommit,
  type TavernLocalBuild,
  type TavernRemoteBuild,
  type TavernUpdateStatus,
} from './github.js'
import { fetchRemoteBuild, type FetchLike } from './sources.js'
import {
  installUpdate,
  watchPluginManager,
  type TavernInstallOutcome,
  type TavernInstallRequest,
  type TavernInstallStrategy,
} from './apply.js'

export const UPDATE_CACHE_FILE = 'update-state.json'
export const UPDATE_CACHE_SCHEMA = 1
/** 自动检查的 TTL：6h。手动「检查更新」始终穿透。 */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000
/** 启动后延迟首查，避免和宿主启动、首次渲染抢网络。 */
export const UPDATE_FIRST_CHECK_DELAY_MS = 12 * 1000
const INSTALL_LOG_LIMIT = 60

/** `restart-required` 是安装成功但本地仍是旧 module generation 的过渡态。 */
export type TavernUpdateReportStatus = TavernUpdateStatus | 'restart-required'

export interface TavernUpdateInstallState {
  running: boolean
  phase: 'idle' | 'installing' | 'done' | 'failed'
  strategy: TavernInstallStrategy | null
  startedAt: string | null
  finishedAt: string | null
  message: string
  restartRequired: boolean
  installed: TavernLocalBuild | null
  log: string[]
}

export interface TavernUpdateSnapshot {
  schemaVersion: number
  status: TavernUpdateReportStatus
  reason: string
  checkedAt: string | null
  nextCheckAt: string | null
  error: string
  source: string
  repository: string
  ref: string
  local: TavernLocalBuild
  remote: TavernRemoteBuild | null
  /** 客户端可直接照抄的安装 spec（`github:owner/repo#sha&path:/packages/plugin`）。 */
  spec: string
  install: TavernUpdateInstallState
}

export interface TavernUpdateServiceOptions {
  ctx?: any
  /** 缓存目录（`$DSH_HOME/tavern`）。 */
  home: string
  /** 已安装插件目录（host bundle 的 `import.meta.dirname`）。 */
  pluginDir: string
  local: TavernLocalBuild
  repository?: string
  ref?: string
  fetchImpl?: FetchLike
  now?: () => Date
  checkTtlMs?: number
  firstCheckDelayMs?: number
  timeoutMs?: number
  /** 关掉后完全不做网络访问（profile 配置或环境变量）。 */
  enabled?: boolean
  /** 落地实现；默认 cli → plugin-manager → checkout（测试注入替身，避免真跑 git/pnpm）。 */
  installerImpl?: (request: TavernInstallRequest) => Promise<TavernInstallOutcome>
  /** raw-git 来源解析远端 commit 的实现；测试注入替身，避免真跑 git ls-remote。 */
  resolveCommitImpl?: (repository: string, ref: string, timeoutMs: number) => Promise<string>
  /** fetch 失败后的 HTTP 兜底实现；测试注入替身，避免真跑 curl。 */
  curlImpl?: (url: string, accept: string, timeoutMs: number) => Promise<string>
  onDiscover?: (snapshot: TavernUpdateSnapshot) => void
}

export class TavernUpdateService {
  private readonly options: TavernUpdateServiceOptions
  private remote: TavernRemoteBuild | null = null
  private status: TavernUpdateReportStatus = 'unknown'
  private reason = ''
  private checkedAt: string | null = null
  private error = ''
  private source = 'none'
  private installState: TavernUpdateInstallState = emptyInstallState()
  private pendingRestart: TavernLocalBuild | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private started = false
  private pluginManager: any = null
  private disposePluginManagerWatch: (() => void) | undefined

  constructor(options: TavernUpdateServiceOptions) {
    this.options = options
    this.loadCache()
  }

  /** 已 dispose 的实例定时器与监听都已拆除；持有方据此决定重建（HMR 重挂）。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  get repository(): string {
    return this.options.repository ?? UPDATE_REPOSITORY
  }

  get ref(): string {
    return this.options.ref ?? UPDATE_REF
  }

  get local(): TavernLocalBuild {
    return this.options.local
  }

  snapshot(): TavernUpdateSnapshot {
    return {
      schemaVersion: UPDATE_CACHE_SCHEMA,
      status: this.status,
      reason: this.reason,
      checkedAt: this.checkedAt,
      nextCheckAt: this.checkedAt === null ? null : new Date(Date.parse(this.checkedAt) + this.ttl()).toISOString(),
      error: this.error,
      source: this.source,
      repository: this.repository,
      ref: this.ref,
      local: this.local,
      remote: this.remote,
      spec: pluginInstallSpec(this.repository, this.ref, this.remote?.commit),
      install: { ...this.installState, log: [...this.installState.log] },
    }
  }

  /**
   * 检查一次。`force` 穿透 TTL；`restart-required` 过渡态下不复查（远端已经
   * 装到磁盘，运行中的构建要等重启才会变），只在本地 stamp 追上安装结果时
   * 解除该状态。任何失败都只写快照，不抛错。
   */
  async check(input: { force?: boolean } = {}): Promise<TavernUpdateSnapshot> {
    if (this.options.enabled === false) {
      this.status = 'unknown'
      this.reason = 'update checks are disabled'
      return this.snapshot()
    }
    if (this.pendingRestart !== null) {
      if (sameCommit(this.local.commit, this.pendingRestart.commit)) {
        // 重启后本地构建已追上安装结果：回到常规判定。
        this.pendingRestart = null
      } else {
        this.status = 'restart-required'
        this.reason = `installed ${this.pendingRestart.version} (${this.pendingRestart.commit}); restart DSH to load it`
        return this.snapshot()
      }
    }
    if (input.force !== true && this.checkedAt !== null && Date.now() - Date.parse(this.checkedAt) < this.ttl()) {
      return this.snapshot()
    }
    const result = await fetchRemoteBuild({
      repository: this.repository,
      ref: this.ref,
      localCommit: this.local.commit,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.resolveCommitImpl === undefined ? {} : { resolveCommitImpl: this.options.resolveCommitImpl }),
      ...(this.options.curlImpl === undefined ? {} : { curlImpl: this.options.curlImpl }),
    })
    this.error = result.error
    if (result.build === null) {
      this.status = 'unknown'
      this.reason = 'remote build could not be read'
      this.source = 'none'
    } else {
      this.remote = result.build
      this.source = result.build.source
      const comparison = compareBuilds({ local: this.local, remote: result.build })
      const filesUnavailable = result.build.source !== 'api' && result.build.changedPluginFiles.length === 0
      this.status = comparison.status
      this.reason = comparison.status === 'up-to-date' && filesUnavailable
        && !result.build.commit.startsWith(shortCommit(this.local.commit))
        ? `${comparison.reason}; changed files unknown on source '${result.build.source}'`
        : comparison.reason
    }
    this.checkedAt = this.nowIso()
    this.persistCache()
    this.options.onDiscover?.(this.snapshot())
    return this.snapshot()
  }

  /**
   * 一键更新。默认只在发现新版本时执行；`force` 允许把当前 ref 重装一遍
   * （例如本地构建 stamp 损坏时手工修复）。
   */
  async install(input: { force?: boolean } = {}): Promise<TavernUpdateSnapshot> {
    if (this.installState.running) return this.snapshot()
    if (this.pendingRestart !== null) {
      this.installState = {
        ...emptyInstallState(),
        phase: 'done',
        message: 'already installed; restart DSH to load it',
        restartRequired: true,
        installed: this.pendingRestart,
      }
      return this.snapshot()
    }
    if (this.status !== 'update-available' && input.force !== true) {
      this.installState = { ...emptyInstallState(), message: `no update available (status: ${this.status})` }
      return this.snapshot()
    }
    const target = this.remote
    this.installState = {
      running: true,
      phase: 'installing',
      strategy: null,
      startedAt: this.nowIso(),
      finishedAt: null,
      message: '',
      restartRequired: false,
      installed: null,
      log: [],
    }
    try {
      const outcome = await (this.options.installerImpl ?? installUpdate)({
        ctx: this.options.ctx ?? {},
        repository: this.repository,
        ref: target?.ref ?? this.ref,
        commit: target?.commit ?? '',
        local: this.local,
        pluginDir: this.options.pluginDir,
        log: (line) => this.appendLog(line),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        ...(this.pluginManager === null ? {} : { pluginManager: this.pluginManager }),
      })
      this.applyOutcome(outcome)
    } catch (error) {
      this.installState = {
        ...this.installState,
        running: false,
        phase: 'failed',
        finishedAt: this.nowIso(),
        message: error instanceof Error ? error.message : String(error),
      }
    }
    this.persistCache()
    return this.snapshot()
  }

  /**
   * 启动自动发现：延迟首查（避免和宿主启动抢资源）+ 周期复查。返回 disposer，
   * 交给 `ctx.effect` 管理生命周期。
   */
  start(): () => void {
    if (this.options.enabled === false || this.disposed) return () => {}
    // 同一实例重复 start 会叠加第二条定时器链（apply 被宿主重复触发时）；
    // 已启动的实例直接复用，disposer 语义保持幂等。
    if (this.started) return () => this.dispose()
    this.started = true
    this.disposePluginManagerWatch = watchPluginManager(this.options.ctx, (service) => {
      this.pluginManager = service
    })
    const schedule = (delayMs: number) => {
      this.timer = setTimeout(() => {
        void this.check().catch(() => {}).finally(() => {
          if (!this.disposed) schedule(this.ttl())
        })
      }, delayMs)
      this.timer?.unref?.()
    }
    schedule(this.options.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS)
    return () => this.dispose()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.disposePluginManagerWatch?.()
    this.disposePluginManagerWatch = undefined
  }

  private ttl(): number {
    return this.options.checkTtlMs ?? UPDATE_CHECK_TTL_MS
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  private appendLog(line: string): void {
    const stamped = `${this.nowIso().slice(11, 19)} ${line}`
    this.installState.log = [...this.installState.log, stamped].slice(-INSTALL_LOG_LIMIT)
    try {
      this.options.ctx?.logger?.info?.(`dsh-tavern update: ${line}`)
    } catch {
    }
  }

  private applyOutcome(outcome: TavernInstallOutcome): void {
    this.installState = {
      ...this.installState,
      running: false,
      phase: outcome.ok ? 'done' : 'failed',
      strategy: outcome.strategy,
      finishedAt: this.nowIso(),
      message: outcome.message,
      restartRequired: outcome.restartRequired,
      installed: outcome.installed,
    }
    if (!outcome.ok) return
    this.checkedAt = this.nowIso()
    // 包替换必须重启进程才加载新 module generation（宿主 plugin-manager 既有
    // 语义）：即使宿主在 HMR 下回报 application:'applied'，运行中的内存 stamp
    // 仍是旧的。只要磁盘安装结果还没被本地构建追上（commit 不同），一律进入
    // 过渡态——否则 status 落回 up-to-date，下一个 TTL 周期又会对同一版本报
    // update-available（徽标回弹）。
    if (outcome.restartRequired || !sameCommit(this.local.commit, outcome.installed.commit)) {
      this.pendingRestart = outcome.installed
      this.status = 'restart-required'
      this.reason = `installed ${outcome.installed.version} (${outcome.installed.commit}) via ${outcome.strategy}; restart DSH to load it`
    } else {
      this.pendingRestart = null
      this.status = 'up-to-date'
      this.reason = `installed ${outcome.installed.version} (${outcome.installed.commit}) via ${outcome.strategy}`
    }
  }

  private cachePath(): string {
    return join(this.options.home, UPDATE_CACHE_FILE)
  }

  private loadCache(): void {
    try {
      const cached = JSON.parse(readFileSync(this.cachePath(), 'utf8'))
      if (cached?.schemaVersion !== UPDATE_CACHE_SCHEMA) return
      if (typeof cached.status === 'string') this.status = cached.status
      if (typeof cached.reason === 'string') this.reason = cached.reason
      if (typeof cached.checkedAt === 'string') this.checkedAt = cached.checkedAt
      if (typeof cached.source === 'string') this.source = cached.source
      if (cached.remote !== null && typeof cached.remote === 'object') this.remote = cached.remote as TavernRemoteBuild
      if (cached.pendingRestart !== null && typeof cached.pendingRestart === 'object'
        && typeof cached.pendingRestart?.version === 'string') {
        this.pendingRestart = {
          version: cached.pendingRestart.version,
          commit: isCommitText(cached.pendingRestart.commit) ? shortCommit(cached.pendingRestart.commit) : UNKNOWN_FIELD,
        }
      }
      // 缓存只用于「首屏立刻有徽标」：本地 stamp 变了（刚升级/刚重启）时旧结论作废。
      if (cached.local !== undefined && !sameLocal(cached.local, this.local)) {
        this.remote = null
        this.checkedAt = null
        this.status = 'unknown'
        this.reason = 'local build changed since the cached check'
      }
    } catch {
    }
  }

  private persistCache(): void {
    try {
      const path = this.cachePath()
      mkdirSync(dirname(path), { recursive: true })
      const payload = {
        schemaVersion: UPDATE_CACHE_SCHEMA,
        status: this.status,
        reason: this.reason,
        checkedAt: this.checkedAt,
        source: this.source,
        local: this.local,
        remote: this.remote,
        pendingRestart: this.pendingRestart,
      }
      const temp = `${path}.tmp`
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    } catch {
    }
  }
}

function emptyInstallState(): TavernUpdateInstallState {
  return {
    running: false,
    phase: 'idle',
    strategy: null,
    startedAt: null,
    finishedAt: null,
    message: '',
    restartRequired: false,
    installed: null,
    log: [],
  }
}

function sameLocal(left: any, right: TavernLocalBuild): boolean {
  return typeof left?.version === 'string' && typeof left?.commit === 'string'
    && left.version === right.version && left.commit === right.commit
}

function isCommitText(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())
}

/** 本地 stamp 与安装结果是不同精度的 sha（7 vs 40），比较时统一取前 7 位。 */
function sameCommit(left: unknown, right: unknown): boolean {
  if (!isCommitText(left) || !isCommitText(right)) return false
  return shortCommit(left) === shortCommit(right)
}

/** 快照里给客户端看的、经过裁剪的 changelog（最多 `limit` 条 commit 标题行）。 */
export function updateChangelog(snapshot: TavernUpdateSnapshot, limit = 8): string[] {
  const commits = snapshot.remote?.commits ?? []
  return commits.slice(0, limit).map((commit) => (commit.message === '' ? commit.short : `${commit.short} ${commit.message}`))
}
