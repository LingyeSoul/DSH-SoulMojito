/**
 * 更新落地（把远端的 commit 装到当前 profile）。
 *
 * 三条路径按「与 DSH 插件体系的一致性」降序尝试，前一条不可用或失败才走下一条：
 *
 * 1. `cli` — 桌面版自带的 `dsh plugin --profile <p> add <spec>` 命令行
 *    （`DeepSeek Harness.exe --expose-internals <app.asar>/dsh/node_modules/
 *    @deepseek-ai/dsh-desktop-host/lib/cli.js`，与 `resources\runtime\cli\bin\dsh.cmd`
 *    同一条链路）。它直接跑 `pnpm add` 并改 profile 的 `package.json` /
 *    `pnpm-lock.yaml`：本机实测同一 git 依赖可以把 lockfile 的 commit 从
 *    8271f20 原地换成 992d321。桌面版 profile 的依赖就是 git spec，这是唯一
 *    「一次调用就能把 lockfile 指到新 commit」的路径。
 * 2. `plugin-manager` — 宿主 `@deepseek-ai/dsh-plugin-manager` 服务。它跑同一
 *    个 pnpm，但装完靠「manifest 前后 diff」定位目标包：**git 依赖的 manifest
 *    值永远是裸仓库 URL**（pnpm 归一化，commit 只记在 lockfile 里），所以对
 *    已安装的 git 依赖它会抛 `ambiguous-install` 并回滚。因此它排在 CLI 之后，
 *    只在 CLI 不可用（非桌面宿主）时使用——那时若 manifest 值确实变了
 *    （例如从 `link:` 换成 git 源）它就能正常工作。
 * 3. `checkout` — git clone 后把 `packages/plugin` 的发布产物覆盖进已安装目录。
 *    不需要宿主服务、不需要 pnpm；代价是 package.json/lockfile 仍指向旧
 *    commit，下次 pnpm 操作会回退，属于最后兜底（结果里会说明）。
 *
 * 三条路径装完都需要重启 DSH：包替换要新的 JS module generation，宿主
 * plugin-manager 自己的 `application: 'restart-required'` 就是这个语义。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  UNKNOWN_FIELD,
  isCommit,
  pluginInstallSpec,
  repositorySlug,
  shortCommit,
  type TavernLocalBuild,
} from './github.js'

export type TavernInstallStrategy = 'cli' | 'plugin-manager' | 'checkout'
export type TavernInstallApplication = 'applied' | 'restart-required' | 'cancelled' | 'failed' | 'unknown'

export interface TavernInstallOutcome {
  ok: boolean
  strategy: TavernInstallStrategy
  application: TavernInstallApplication
  message: string
  restartRequired: boolean
  /** 安装完成后从磁盘读到的版本/commit（读不到为 unknown）。 */
  installed: TavernLocalBuild
}

export interface TavernInstallRequest {
  ctx: any
  repository: string
  ref: string
  /** 目标 commit；未知时退回分支 ref。 */
  commit: string
  local: TavernLocalBuild
  /** 当前已安装插件目录（`import.meta.dirname`）。 */
  pluginDir: string
  log: (line: string) => void
  timeoutMs?: number
  /** 已由 watchPluginManager 捕获到的服务实例；缺省时在调用点重新解析。 */
  pluginManager?: any
}

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 插件包的发布文件（package.json 的 `files`）。checkout 兜底只覆盖这些。 */
const SHIPPED_FILES = ['index.mjs', 'agent.mjs', 'compaction.mjs', 'novel.mjs', 'cordis.patch.yml', 'README.md', 'package.json']
const SHIPPED_DIRS = ['client']

export async function installUpdate(request: TavernInstallRequest): Promise<TavernInstallOutcome> {
  let pluginManager: any = request.pluginManager ?? null
  return runInstallChain(request, [
    { name: 'cli', run: () => installViaCli(request) },
    {
      name: 'plugin-manager',
      run: () => {
        pluginManager ??= resolvePluginManager(request.ctx)
        return pluginManager === null || pluginManager === undefined
          ? Promise.resolve(null)
          : installViaPluginManager(request, pluginManager)
      },
    },
    { name: 'checkout', run: () => installViaCheckout(request) },
  ])
}

export interface TavernInstallStrategyEntry {
  name: TavernInstallStrategy
  /** 返回 null 表示这条路径在本宿主不可用，交给下一条。 */
  run: () => Promise<TavernInstallOutcome | null>
}

/**
 * 依次尝试落地路径：`null` = 不可用（换下一条），`ok: false` = 试过但失败
 * （也换下一条，最后一条的失败结果才是最终结果）。抽成独立函数是为了让
 * 「降级链」本身可测，不必真的跑 git/pnpm。
 */
export async function runInstallChain(
  request: TavernInstallRequest,
  entries: readonly TavernInstallStrategyEntry[],
): Promise<TavernInstallOutcome> {
  const attempts: string[] = []
  let last: TavernInstallOutcome | null = null
  for (const entry of entries) {
    const outcome = await entry.run()
    if (outcome === null) {
      attempts.push(`${entry.name}: unavailable`)
      continue
    }
    if (outcome.ok) return outcome
    attempts.push(`${entry.name}: ${outcome.message}`)
    last = outcome
  }
  if (last !== null) {
    request.log(`all package-manager paths failed (${attempts.join('; ')})`)
    return last
  }
  const failed: TavernInstallOutcome = {
    ok: false,
    strategy: entries.at(-1)?.name ?? 'checkout',
    application: 'failed',
    message: `no update path is available in this host (${attempts.join('; ')})`,
    restartRequired: false,
    installed: readInstalledStamp(request.pluginDir),
  }
  return failed
}

/**
 * 解析宿主的 pluginManager 服务。它不是本插件的静态依赖（写进 `inject` 会让
 * 没有该服务的宿主整插件不挂载），因此三个面都试一遍并逐个容错：
 * 动态 inject 的捕获（watchPluginManager）、ctx.get('pluginManager')、ctx.pluginManager。
 */
export function resolvePluginManager(ctx: any): any {
  for (const read of [
    () => ctx?.pluginManager,
    () => ctx?.get?.('pluginManager'),
  ]) {
    try {
      const service = read()
      if (service !== undefined && service !== null && typeof service.installBundle === 'function') return service
    } catch {
      // Cordis 对未声明 inject 的服务属性会抛错，继续试下一个面。
    }
  }
  return null
}

/**
 * 动态注入 pluginManager：服务在 apply 之后才挂载时，回调会在它就绪时触发。
 * 返回 disposer；宿主没有 `inject` 方法（老版本）时返回 noop。
 */
export function watchPluginManager(ctx: any, onReady: (service: any) => void): () => void {
  if (typeof ctx?.inject !== 'function') return () => {}
  try {
    const dispose = ctx.inject(['pluginManager'], (serviceCtx: any) => {
      try {
        if (serviceCtx?.pluginManager !== undefined) onReady(serviceCtx.pluginManager)
      } catch {
      }
    })
    return typeof dispose === 'function' ? dispose : () => {}
  } catch {
    return () => {}
  }
}

/**
 * 桌面版 CLI 入口：宿主进程的 argv[2] 是 runtime 目录
 * （`<app.asar>/dsh`，见 @deepseek-ai/dsh-desktop-host 的 main()），
 * 该目录下有 `@deepseek-ai/dsh-desktop-host/lib/cli.js` 时即可用
 * `DeepSeek Harness.exe --expose-internals <cli.js> plugin ...` 复刻
 * `dsh plugin` 命令行（`resources\runtime\cli\bin\dsh.cmd` 同款）。
 * 非桌面宿主返回 null，交给下一条路径。
 */
export function resolveDesktopCli(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): { command: string, args: string[], env: Record<string, string> } | null {
  const configured = process.env.DSH_TAVERN_DSH_CLI?.trim()
  if (configured !== undefined && configured !== '') {
    return { command: execPath, args: ['--expose-internals', configured], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const runtimeDir = typeof argv[2] === 'string' ? argv[2].trim() : ''
  if (runtimeDir === '') return null
  const cli = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (!exists(cli)) return null
  return { command: execPath, args: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export async function installViaCli(request: TavernInstallRequest): Promise<TavernInstallOutcome | null> {
  const cli = resolveDesktopCli()
  if (cli === null) return null
  const profile = process.env.DSH_PROFILE?.trim() || 'desktop'
  const spec = pluginInstallSpec(request.repository, request.ref, request.commit)
  const args = [...cli.args, 'plugin', '--profile', profile, 'add', spec]
  request.log(`dsh plugin --profile ${profile} add ${spec}`)
  try {
    const result = await runCapture(cli.command, args, {
      env: { ...cli.env },
      timeoutMs: request.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      onLine: request.log,
    })
    if (result.code !== 0) throw new Error(`exit ${result.code}`)
    return {
      ok: true,
      strategy: 'cli',
      application: 'restart-required',
      message: 'installed through `dsh plugin`; restart DSH to load the new module generation',
      restartRequired: true,
      installed: readInstalledStamp(request.pluginDir, spec),
    }
  } catch (error) {
    request.log(`dsh plugin failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function installViaPluginManager(
  request: TavernInstallRequest,
  pluginManager: any,
): Promise<TavernInstallOutcome | null> {
  const spec = pluginInstallSpec(request.repository, request.ref, request.commit)
  const requestId = `dsh-tavern-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  request.log(`plugin-manager: installBundle ${spec}`)
  const dispose = subscribeInstallEvents(request, requestId)
  try {
    const result = await pluginManager.installBundle(spec, { requestId, enabled: true })
    const application = normalizeApplication(result?.application, result)
    const failed = application === 'failed' || application === 'cancelled'
    const detail = failed ? describeFailure(result) : ''
    // git 依赖的 manifest 值永远是裸仓库 URL（commit 只记在 lockfile 里），
    // plugin-manager 的「diff 定位目标包」因此对已安装的 git 源必然歧义并回滚。
    const ambiguous = detail.includes('ambiguous-install')
    return {
      ok: !failed,
      strategy: 'plugin-manager',
      application,
      message: failed
        ? `plugin-manager install failed: ${detail || 'see the profile .plugin-manager logs'}${ambiguous ? ' (git dependency target is ambiguous: the manifest specifier never changes, so `dsh plugin` is the path that works)' : ''}`
        : application === 'restart-required'
          ? 'installed through the DSH plugin manager; restart DSH to load the new module generation'
          : 'installed through the DSH plugin manager',
      restartRequired: !failed && application === 'restart-required',
      installed: readInstalledStamp(request.pluginDir, spec),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    request.log(`plugin-manager: ${message}`)
    return {
      ok: false,
      strategy: 'plugin-manager',
      application: 'failed',
      message: `plugin-manager install threw: ${message}`,
      restartRequired: false,
      installed: readInstalledStamp(request.pluginDir, spec),
    }
  } finally {
    dispose()
  }
}

/**
 * `plugin-manager/install-log` 的 chunk 只在同一 requestId 下属于本次安装；
 * `install-state` 给出 installing/applying 阶段。事件订阅必须成对释放，
 * 否则重复点「更新」会串台。
 */
function subscribeInstallEvents(request: TavernInstallRequest, requestId: string): () => void {
  const handlers: Array<() => void> = []
  const on = (event: string, handler: (payload: any) => void) => {
    try {
      const dispose = request.ctx?.on?.(event, handler)
      if (typeof dispose === 'function') handlers.push(dispose)
    } catch {
    }
  }
  on('plugin-manager/install-log', (chunk) => {
    if (chunk?.requestId !== requestId) return
    const text = typeof chunk?.text === 'string' ? chunk.text.trimEnd() : ''
    if (text !== '') request.log(`pnpm ${chunk?.stream ?? 'out'}: ${text}`)
    if (typeof chunk?.exitCode === 'number') request.log(`pnpm exited with ${chunk.exitCode}`)
  })
  on('plugin-manager/install-state', (state) => {
    if (state?.requestId !== requestId) return
    const attempt = state?.attempt
    request.log(`plugin-manager: ${state?.phase ?? 'working'}${attempt?.registry === undefined ? '' : ` (${attempt.registry} ${attempt.index}/${attempt.total})`}`)
  })
  return () => {
    for (const dispose of handlers.splice(0)) {
      try {
        dispose()
      } catch {
      }
    }
  }
}

function normalizeApplication(application: unknown, result: any): TavernInstallApplication {
  if (application === 'applied' || application === 'restart-required' || application === 'cancelled' || application === 'failed') {
    return application
  }
  if (result?.error !== undefined) return 'failed'
  return 'unknown'
}

function describeFailure(result: any): string {
  const error = result?.error
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  const output = typeof result?.packageResult?.output === 'string' ? result.packageResult.output.trim() : ''
  return [code, message, output.split('\n').slice(-4).join(' ')].filter((item) => item !== '').join(' | ')
}

export async function installViaCheckout(request: TavernInstallRequest): Promise<TavernInstallOutcome> {
  const spec = pluginInstallSpec(request.repository, request.ref, request.commit)
  const repository = repositorySlug(request.repository)
  const profile = process.env.DSH_PROFILE?.trim() || 'desktop'
  const checkout = mkdtempSync(join(tmpdir(), 'dsh-tavern-checkout-'))
  try {
    request.log(`fallback: git clone --depth 1 https://github.com/${repository}.git`)
    await mustRun('git', ['clone', '--depth', '1', '--branch', request.ref, `https://github.com/${repository}.git`, checkout], request)
    if (isCommit(request.commit)) {
      const head = (await mustRun('git', ['-C', checkout, 'rev-parse', 'HEAD'], request)).trim()
      if (!head.startsWith(shortCommit(request.commit))) {
        request.log(`checkout ${shortCommit(request.commit)}`)
        await mustRun('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', request.commit], request)
        await mustRun('git', ['-C', checkout, 'checkout', '--quiet', request.commit], request)
      }
    }
    const source = join(checkout, 'packages', 'plugin')
    if (!existsSync(source)) throw new Error('packages/plugin is missing from the checkout')
    const copied = copyShippedFiles(source, request.pluginDir)
    request.log(`copied ${copied.length} shipped entries into ${request.pluginDir}`)
    return {
      ok: true,
      strategy: 'checkout',
      application: 'restart-required',
      message: 'files replaced from a fresh GitHub checkout; the profile lockfile still pins the previous commit, so run '
        + `\`dsh plugin --profile ${profile} add ${spec}\` to make it durable, then restart DSH`,
      restartRequired: true,
      installed: readInstalledStamp(request.pluginDir, spec),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    request.log(`checkout fallback failed: ${message}`)
    return {
      ok: false,
      strategy: 'checkout',
      application: 'failed',
      message: `update failed: ${message}. Manual fallback: dsh plugin --profile ${profile} add ${spec}`,
      restartRequired: false,
      installed: readInstalledStamp(request.pluginDir, spec),
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
}

async function mustRun(command: string, args: string[], request: TavernInstallRequest): Promise<string> {
  const result = await runCapture(command, args, {
    timeoutMs: request.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    onLine: request.log,
  })
  if (result.code !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} exited ${result.code}`)
  return result.output
}

/**
 * 覆盖已安装目录里的发布产物。pnpm 的 hoisted 布局里的文件可能是 store 的
 * 硬链接，直接 copyFile 会改写共享 inode，因此先删后拷。
 */
export function copyShippedFiles(sourceDir: string, targetDir: string): string[] {
  const copied: string[] = []
  for (const file of SHIPPED_FILES) {
    const from = join(sourceDir, file)
    if (!existsSync(from)) continue
    const to = join(targetDir, file)
    rmSync(to, { force: true })
    copyFileSync(from, to)
    copied.push(file)
  }
  for (const dir of SHIPPED_DIRS) {
    const from = join(sourceDir, dir)
    if (!existsSync(from)) continue
    for (const file of listFiles(from)) {
      const relative = file.slice(from.length + 1)
      const to = join(targetDir, dir, relative)
      mkdirSync(dirname(to), { recursive: true })
      rmSync(to, { force: true })
      writeFileSync(to, readFileSync(file))
      copied.push(`${dir}/${relative.replaceAll('\\', '/')}`)
    }
  }
  return copied
}

function listFiles(root: string): string[] {
  const found: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSyncSafe(current)) {
      const full = join(current, entry)
      const stat = statSyncSafe(full)
      if (stat === null) continue
      if (stat.isDirectory()) pending.push(full)
      else found.push(full)
    }
  }
  return found
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function statSyncSafe(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** 读已安装目录的版本/commit：version.json 优先（本仓库构建旁车），package.json / spec 兜底。 */
export function readInstalledStamp(pluginDir: string, spec = ''): TavernLocalBuild {
  let version = UNKNOWN_FIELD
  let commit = UNKNOWN_FIELD
  try {
    const generated = JSON.parse(readFileSync(join(pluginDir, 'version.json'), 'utf8'))
    if (typeof generated?.version === 'string' && generated.version.trim() !== '') version = generated.version.trim()
    if (isCommit(generated?.commit)) commit = shortCommit(generated.commit)
  } catch {
  }
  if (version === UNKNOWN_FIELD) {
    try {
      const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version.trim() !== '') version = manifest.version.trim()
    } catch {
    }
  }
  if (commit === UNKNOWN_FIELD) {
    const pinned = /#([0-9a-f]{7,40})(?:&|$)/.exec(spec)?.[1]
    if (isCommit(pinned)) commit = shortCommit(pinned)
  }
  return { version, commit }
}

interface RunOptions {
  env?: Record<string, string | undefined>
  timeoutMs?: number
  onLine?: (line: string) => void
}

interface RunResult {
  code: number
  output: string
}

/** 流式跑子进程：每行喂给 onLine（进度条），结束时返回退出码与完整输出。 */
function runCapture(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let output = ''
    const feed = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (options.onLine !== undefined) {
        for (const line of text.split('\n')) {
          if (line.trim() !== '') options.onLine(line.trim())
        }
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS}ms`))
    }, options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}
