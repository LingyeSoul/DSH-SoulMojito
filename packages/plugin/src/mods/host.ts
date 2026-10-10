/**
 * Mod 宿主（提案 0015 §3.2 P1 加载器）：扫描 `<tavern>/mods/`、清单校验、三层
 * 开关裁决、装载 ESM 入口、审计与 HTTP 子路由分派。
 *
 * 纪律：
 * - **坏 Mod 不断路**：mod.json 读不出来/校验失败/engines 不满足/入口缺失 →
 *   记审计 + 状态错误位、跳过；宿主与其余 Mod 照常（坏世界书 JSON 不 500
 *   bootstrap 同教义）。
 * - **默认关**：state.json `modsEnabled`（全局）与 `mods.enabled.<id>`（逐 Mod）
 *   双默认 false，两层同开才装载；`DSH_TAVERN_DISABLE_MODS` 环境变量是第三层
 *   硬关（每次 refresh/分派实时读取，对齐 DSH_TAVERN_DISABLE_UPDATE_CHECK）。
 * - **目录白名单**：只扫 `<tavern>/mods/` 的直接子目录；mod id 必须等于目录名，
 *   HTTP 子路由的 id/path 过 manifest/http 两层白名单后才进文件系统或路由表。
 * - **适配层注入**（TemplateHost 模式）：mod 拿到的 api 是白名单对象，不透传
 *   cordis ctx。P1 面只有 logger/storage/assets/events/timers/http/onDispose；
 *   hooks/tools/macros/stscript/llm 是 P2，刻意缺席。
 * - **ESM 实例驻留是已知限制**：reload 用 `?t=` cache-bust 重新 import，模块级
 *   副作用无法回收——mod 的注册必须走 api.*（宿主持全量 disposer），文档义务。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onGuidesChanged } from '../guides.js'
import { generationHooks, type GenerationHookPhase } from '../generation-hooks.js'
import { builtinMacroNames } from '../../../tavern-macros/src/index.js'
import { hostMacroSnapshot, registerHostMacro } from '../../../tavern-macros/src/index.js'
import { registerStscriptCommand, stscriptCommandNames } from '../../../tavern-script/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { ModAuditLog, type ModAuditEvent } from './audit.js'
import { modEvents } from './events.js'
import {
  claimedToolNames,
  clampModSectionOrder,
  modToolSnapshot,
  MOD_TOOL_NAME_PATTERN,
  registerModSection,
  registerModTool,
  type ModToolDefinition,
} from './cross-bundle.js'
import { createModRouteTable, isValidModHttpPath, makeModReply, readModRequestBody, type ModHttpRequest, type ModReply, type ModRouteTable } from './http.js'
import { checkModManifest, satisfiesVersionRange, MOD_ID_PATTERN, type ModCapability, type ModManifest } from './manifest.js'
import { ModStorage } from './storage.js'
import { installModFromGit, type ModInstallResult } from './install.js'

/** `api.version`（提案 §3.7 的 modApiVersion 常量）。P1 = 1。 */
export const MOD_API_VERSION = 1

export type ModStatus = 'loaded' | 'disabled' | 'error'

export interface ModInfo {
  id: string
  name: string
  version: string
  author: string
  description: string
  capabilities: ModCapability[]
  loadingOrder: number
  panel: { title: string; icon?: string } | null
  status: ModStatus
  /** status === 'error' 时的原因（含 engines 不满足、清单校验失败、setup 抛错）。 */
  error: string
  /** 本进程内该 Mod 的审计事件计数（加载/跳过/http 失败/超配额等）。 */
  auditCount: number
  /** 注册面（启用确认弹层 §3.5）：已装载时是**实际注册**的名单；未装载时回落
   *  manifest 的 surfaces 声明（作者自查面，展示「声明」，loaded 展示「事实」）。 */
  surfaces: ModSurfacesView
}

export interface ModSurfacesView {
  hooks: string[]
  tools: string[]
  http: string[]
}

/** manifest 的 surfaces 声明（未装载 mod 的展示来源；作者自查，不是契约）。 */
function declaredSurfacesOf(manifest: ModManifest): ModSurfacesView {
  return {
    hooks: [...manifest.surfaces.hooks],
    tools: [...manifest.surfaces.tools],
    http: [...manifest.surfaces.http],
  }
}

export interface ModHostSnapshot {
  /** false = 环境变量硬关（DSH_TAVERN_DISABLE_MODS）。 */
  available: boolean
  reason: string
  globalEnabled: boolean
  mods: ModInfo[]
}

export interface ModHostContext {
  logger?: {
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
  effect?: (callback: () => (() => void) | void, label?: string) => unknown
  /** ctx.llm 代理面（提案 0015 §3.3 api.llm）：仅声明 `llm` 能力的 Mod 可见。 */
  llm?: {
    stream?: (request: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>
  }
}

export interface ModHostOptions {
  ctx?: ModHostContext
  /** tavern 数据根（`$DSH_HOME/tavern`）。Mod 目录是 `<root>/mods/`。 */
  root: string
  /** 宿主版本（engines.dsh-tavern 范围校验的左值）。 */
  hostVersion: string
  /** TavernStore 访问器（state.json 开关读写与资产快照）。 */
  dbProvider: () => Promise<TavernStore>
}

/** 第三层开关：DSH_TAVERN_DISABLE_MODS 非空（非 0/false）即硬关。 */
export function modsDisabledByEnv(): boolean {
  const disabled = process.env.DSH_TAVERN_DISABLE_MODS?.trim()
  return disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false'
}

interface DiscoveredMod {
  manifest: ModManifest
  directory: string
  entryPath: string
}

/** 清单不可用（读不出/校验失败）：尽量抢救展示字段，status 恒 error。 */
interface BrokenMod {
  message: string
  name?: string
  version?: string
  author?: string
  description?: string
  capabilities?: ModCapability[]
}

/** 清单合法但不可装载（engines 不满足 / 入口文件缺失）。 */
interface BlockedMod {
  manifest: ModManifest
  reason: string
}

interface LoadedMod {
  manifest: ModManifest
  directory: string
  routeTable: ModRouteTable
  /** onDispose 注册 + setup 返回的 dispose（追加序）；卸载按逆序执行。 */
  disposers: Array<() => void | Promise<void>>
  timers: Set<ReturnType<typeof setInterval>>
  offEvents: Array<() => void>
  /** P2 能力面（hooks/tools/macros/stscript/section）的反注册句柄；卸载统一执行。 */
  offRegistrations: Array<() => void>
  /** 本实例的实际注册面（启用确认/快照展示用；manifest 声明是另一来源）。 */
  surfaces: { hooks: Set<string>; tools: Set<string>; http: Set<string>; macros: Set<string>; sections: Set<string> }
  /** 本实例的私有存储：卸载末尾 flush 排空在飞写（验收打回的竞态修复点）。 */
  storage: ModStorage
}

interface ModEntryModule {
  setup?: (api: unknown) => Promise<(() => void | Promise<void>) | unknown> | (() => void | Promise<void>) | unknown
}

type HostLogger = NonNullable<ModHostContext['logger']>

export class ModHost {
  private readonly modsRoot: string
  private readonly audit: ModAuditLog
  private readonly logger: HostLogger | undefined
  private readonly discovered = new Map<string, DiscoveredMod>()
  private readonly broken = new Map<string, BrokenMod>()
  private readonly blocked = new Map<string, BlockedMod>()
  private readonly loaded = new Map<string, LoadedMod>()
  private readonly loadErrors = new Map<string, string>()
  private globalEnabled = false
  private refreshTail: Promise<void> = Promise.resolve()
  private offGuides: (() => void) | undefined
  private offHookDegrations: (() => void) | undefined

  private constructor(private readonly options: ModHostOptions) {
    this.modsRoot = join(options.root, 'mods')
    this.audit = new ModAuditLog(join(this.modsRoot, 'audit.jsonl'))
    this.logger = options.ctx?.logger
    this.audit.setLogger((message) => this.logger?.warn?.(message))
  }

  static async open(options: ModHostOptions): Promise<ModHost> {
    const host = new ModHost(options)
    await mkdir(host.modsRoot, { recursive: true })
    // guides-changed 既有总线（guides.ts，globalThis 注册表）桥接进 mod 事件面。
    host.offGuides = onGuidesChanged((character, chatId) => modEvents.emit('guides-changed', { character, chatId }))
    // P2（提案 0015 §3.4）：管线 hook 降级 → 审计线 + 面板计数。owner 归因由
    // api.hooks.on 注册时传入（mod id 字符串）；非 mod 注册方只记日志。
    host.offHookDegrations = generationHooks.onDegradation((degradation) => {
      const detail = `${degradation.phase} ${degradation.reason}${degradation.detail ? `: ${degradation.detail}` : ''}`
      host.logger?.warn?.(`dsh-tavern: generation hook degraded (${detail})`)
      if (typeof degradation.owner === 'string') {
        void host.audit.record(degradation.owner, 'hook-degradation', detail)
      }
    })
    // 宿主卸载时清掉所有 mod 定时器（ctx.effect 同构；拒绝 effect 的宿主只失去
    // 这一层兜底，disposeAll 仍然可用）。
    try {
      options.ctx?.effect?.(() => () => { host.clearAllTimers() }, 'dsh-tavern: mod timers')
    } catch {
      // 宿主拒绝晚注册的 effect：不影响装载。
    }
    await host.refresh()
    return host
  }

  /** 重新扫描 + 按三层开关对账（该装载的装载、该卸载的卸载）。串行化执行。 */
  refresh(): Promise<void> {
    const run = this.refreshTail.catch(() => {}).then(() => this.refreshInternal())
    this.refreshTail = run.then(() => {}, () => {})
    return run
  }

  async setGlobalEnabled(enabled: boolean): Promise<void> {
    const db = await this.options.dbProvider()
    await db.updateState(() => ({ modsEnabled: enabled === true }))
    await this.audit.record('*', enabled ? 'enable' : 'disable', 'global')
    await this.refresh()
  }

  async setModEnabled(id: string, enabled: boolean): Promise<void> {
    if (!MOD_ID_PATTERN.test(id)) throw new Error(`invalid mod id '${id}'`)
    const known = this.discovered.has(id) || this.broken.has(id) || this.blocked.has(id)
    if (!known) throw new Error(`mod '${id}' is not installed`)
    const db = await this.options.dbProvider()
    await db.updateState((state) => ({
      mods: {
        ...(state.mods ?? {}),
        enabled: { ...(state.mods?.enabled ?? {}), [id]: enabled === true },
      },
    }))
    await this.audit.record(id, enabled ? 'enable' : 'disable')
    await this.refresh()
  }

  /** 调旧 dispose 链（及 onDispose 合并队列）→ `?t=` cache-bust 重新 import。 */
  async reload(id: string): Promise<void> {
    if (!MOD_ID_PATTERN.test(id)) throw new Error(`invalid mod id '${id}'`)
    const disc = this.discovered.get(id)
    if (disc === undefined || !this.loaded.has(id)) throw new Error(`mod '${id}' is not loaded`)
    await this.unload(id, 'reload')
    const ok = await this.load(disc, true)
    if (!ok) throw new Error(`mod '${id}' failed to reload: ${this.loadErrors.get(id) ?? 'unknown error'}`)
  }

  /**
   * 从 git URL 安装（提案 0015 §4 P2）：GitHub 源降级链预读 + `git clone --depth 1`
   * + 本地清单校验 + 拷入 `mods/<id>/`；成功/失败都进审计线；落地后 refresh()
   * 让扫描吸收新目录（装上不等于启用——三层开关语义不变）。impl 供测试注入
   * （缺省真实 installModFromGit）。
   */
  async installFromGit(url: string, force: boolean, impl: typeof installModFromGit = installModFromGit): Promise<ModInstallResult> {
    try {
      const result = await impl({ url, root: this.options.root, force })
      await this.audit.record(result.modId, 'install', `${url}${result.replaced ? ' (replaced)' : ''}`)
      await this.refresh()
      return result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.logger?.warn?.(`dsh-tavern: mod install from '${url}' failed: ${message}`)
      await this.audit.record('*', 'install-error', message)
      throw cause
    }
  }

  snapshot(): ModHostSnapshot {
    const available = !modsDisabledByEnv()
    const mods: ModInfo[] = []
    for (const [id, info] of this.broken) {
      mods.push({
        id,
        name: info.name ?? id,
        version: info.version ?? '',
        author: info.author ?? '',
        description: info.description ?? '',
        capabilities: info.capabilities ?? [],
        loadingOrder: 100,
        panel: null,
        status: 'error',
        error: info.message,
        auditCount: this.audit.count(id),
        surfaces: { hooks: [], tools: [], http: [] },
      })
    }
    for (const [id, item] of this.blocked) {
      mods.push({ ...modInfoOf(item.manifest), status: 'error', error: item.reason, auditCount: this.audit.count(id), surfaces: declaredSurfacesOf(item.manifest) })
    }
    for (const [id, disc] of this.discovered) {
      const loadError = this.loadErrors.get(id)
      const loaded = this.loaded.get(id)
      mods.push({
        ...modInfoOf(disc.manifest),
        status: loadError !== undefined ? 'error' : loaded !== undefined ? 'loaded' : 'disabled',
        error: loadError ?? '',
        auditCount: this.audit.count(id),
        surfaces: loaded !== undefined ? liveSurfacesOf(loaded) : declaredSurfacesOf(disc.manifest),
      })
    }
    mods.sort((a, b) => a.loadingOrder - b.loadingOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { available, reason: available ? '' : 'DSH_TAVERN_DISABLE_MODS is set', globalEnabled: this.globalEnabled, mods }
  }

  /**
   * 分派 mod 子路由（`mods/<id>/<path>`）。返回 false = 不归我管（或任何一层
   * 开关关闭 / 未装载 / 无此路由）——调用方一律按 404 兜底，与未知路由不可区分。
   */
  async handleRoute(
    req: Parameters<typeof readModRequestBody>[0] & { method?: string },
    res: { statusCode: number; writableEnded: boolean; setHeader: (name: string, value: string) => void; end: (chunk?: string | Uint8Array) => void },
    method: string,
    url: URL,
    id: string,
    subpath: string,
  ): Promise<boolean> {
    if (modsDisabledByEnv() || !this.globalEnabled) return false
    if (!MOD_ID_PATTERN.test(id)) return false
    const record = this.loaded.get(id)
    if (record === undefined) return false
    if (!isValidModHttpPath(subpath)) return false
    const handler = record.routeTable.find(method, subpath)
    if (handler === undefined) return false
    const request: ModHttpRequest = {
      method,
      path: subpath,
      query: url.searchParams,
      json: () => readModRequestBody(req),
    }
    const reply = makeModReply(res)
    try {
      await handler(request, reply)
      if (!res.writableEnded) {
        throw new Error('mod handler did not send a response')
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await this.audit.record(id, 'http-error', message)
      this.logger?.warn?.(`dsh-tavern: [mod:${id}] http route ${method} ${subpath} failed: ${message}`)
      if (!res.writableEnded) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, message: `mod route failed: ${message}` }))
      }
    }
    return true
  }

  /** 宿主卸载：卸下全部已装载 Mod（逆序 disposer + 定时器 + 事件反注册）。 */
  async disposeAll(): Promise<void> {
    for (const id of [...this.loaded.keys()]) await this.unload(id, 'disable')
    this.offGuides?.()
    this.offGuides = undefined
    this.offHookDegrations?.()
    this.offHookDegrations = undefined
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async refreshInternal(): Promise<void> {
    if (modsDisabledByEnv()) {
      for (const id of [...this.loaded.keys()]) await this.unload(id, 'disable')
      this.discovered.clear()
      this.broken.clear()
      this.blocked.clear()
      this.loadErrors.clear()
      this.globalEnabled = false
      return
    }
    await this.scan()
    const state = await (await this.options.dbProvider()).getState()
    this.globalEnabled = state.modsEnabled === true
    const enabled = state.mods?.enabled ?? {}
    for (const [id, disc] of this.discovered) {
      const want = this.globalEnabled && enabled[id] === true
      if (want && !this.loaded.has(id)) await this.load(disc, false)
      else if (!want && this.loaded.has(id)) await this.unload(id, 'disable')
    }
    for (const id of [...this.loaded.keys()]) {
      if (!this.discovered.has(id)) await this.unload(id, 'remove')
    }
  }

  /** 扫描 mods/ 直接子目录：只读 mod.json、过校验，不执行任何 Mod 代码。 */
  private async scan(): Promise<void> {
    const entries = await fs.readdir(this.modsRoot, { withFileTypes: true }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [] as Dirent[]
      throw cause
    })
    const nextDiscovered = new Map<string, DiscoveredMod>()
    const nextBroken = new Map<string, BrokenMod>()
    const nextBlocked = new Map<string, BlockedMod>()
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    for (const directory of directories) {
      const id = directory
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(join(this.modsRoot, directory, 'mod.json'), 'utf8'))
      } catch (cause) {
        const message = `mod.json is missing or unreadable: ${cause instanceof Error ? cause.message : String(cause)}`
        nextBroken.set(id, { message, ...salvageManifestFields(undefined) })
        await this.audit.record(id, 'skip', message)
        continue
      }
      const check = checkModManifest(raw, { directory })
      if (!check.ok) {
        const message = check.errors.join('; ')
        nextBroken.set(id, { message, ...salvageManifestFields(raw) })
        await this.audit.record(id, 'skip', message)
        continue
      }
      const manifest = check.manifest
      const engineRange = manifest.engines?.dshTavern
      if (engineRange !== undefined) {
        const verdict = satisfiesVersionRange(this.options.hostVersion, engineRange)
        if (!verdict.ok) {
          nextBlocked.set(id, { manifest, reason: verdict.reason })
          await this.audit.record(id, 'skip', verdict.reason)
          continue
        }
      }
      const entryPath = resolve(this.modsRoot, directory, manifest.main)
      const containment = relative(resolve(this.modsRoot, directory), entryPath)
      if (containment === '' || containment.startsWith('..') || isAbsolute(containment)) {
        const message = `main entry '${manifest.main}' escapes the mod directory`
        nextBlocked.set(id, { manifest, reason: message })
        await this.audit.record(id, 'skip', message)
        continue
      }
      const entryStat = await fs.stat(entryPath).catch(() => undefined)
      if (entryStat?.isFile() !== true) {
        const message = `main entry '${manifest.main}' not found`
        nextBlocked.set(id, { manifest, reason: message })
        await this.audit.record(id, 'skip', message)
        continue
      }
      nextDiscovered.set(id, { manifest, directory: join(this.modsRoot, directory), entryPath })
    }
    this.discovered.clear()
    this.broken.clear()
    this.blocked.clear()
    for (const [id, disc] of nextDiscovered) this.discovered.set(id, disc)
    for (const [id, broken] of nextBroken) this.broken.set(id, broken)
    for (const [id, blocked] of nextBlocked) this.blocked.set(id, blocked)
    for (const id of [...this.loadErrors.keys()]) {
      if (!this.discovered.has(id)) this.loadErrors.delete(id)
    }
  }

  private async load(disc: DiscoveredMod, cacheBust: boolean): Promise<boolean> {
    const id = disc.manifest.id
    const record: LoadedMod = {
      manifest: disc.manifest,
      directory: disc.directory,
      routeTable: createModRouteTable(),
      disposers: [],
      timers: new Set(),
      offEvents: [],
      offRegistrations: [],
      surfaces: { hooks: new Set(), tools: new Set(), http: new Set(), macros: new Set(), sections: new Set() },
      storage: new ModStorage(join(disc.directory, 'data', 'state.json'), {
        onQuota: (message) => { void this.audit.record(id, 'storage-quota', message) },
      }),
    }
    try {
      await mkdir(join(disc.directory, 'data'), { recursive: true })
      // 复用 importHostPackage 的 URL 动态 import 模式；reload 用 ?t= timeStamp
      // cache-bust 拿新模块实例（ESM 实例驻留的已知限制见文件头）。
      const url = pathToFileURL(disc.entryPath).href + (cacheBust ? `?t=${Date.now()}` : '')
      const module = await import(url) as ModEntryModule
      if (typeof module?.setup !== 'function') {
        throw new Error('mod entry must export an async setup(api) function')
      }
      const returned = await module.setup(this.createApi(record))
      if (typeof returned === 'function') record.disposers.push(returned)
      this.loaded.set(id, record)
      this.loadErrors.delete(id)
      await this.audit.record(id, 'load')
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await this.runDisposers(id, record)
      this.loadErrors.set(id, message)
      this.logger?.warn?.(`dsh-tavern: mod '${id}' failed to ${cacheBust ? 'reload' : 'load'}: ${message}`)
      await this.audit.record(id, 'load-error', message)
      return false
    }
  }

  private async unload(id: string, event: ModAuditEvent): Promise<void> {
    const record = this.loaded.get(id)
    if (record === undefined) return
    this.loaded.delete(id)
    await this.runDisposers(id, record)
    await this.audit.record(id, event)
  }

  /** 逆序执行 disposer（后注册先清）、清定时器、反注册事件、反注册 P2 能力面、
   * 排空在飞存储写；单项失败只记审计。末尾的 flush 是 reload/teardown 竞态的
   * 修复点：unload 返回后该实例不再有任何在飞写，新实例装载与宿主外部的目录
   * 删除都安全。 */
  private async runDisposers(id: string, record: LoadedMod): Promise<void> {
    for (const dispose of [...record.disposers].reverse()) {
      try {
        await dispose()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.logger?.warn?.(`dsh-tavern: [mod:${id}] dispose failed: ${message}`)
        await this.audit.record(id, 'dispose-error', message)
      }
    }
    for (const timer of record.timers) clearInterval(timer)
    record.timers.clear()
    for (const off of record.offEvents.splice(0)) off()
    for (const off of record.offRegistrations.splice(0)) {
      try {
        off()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.logger?.warn?.(`dsh-tavern: [mod:${id}] capability unregister failed: ${message}`)
        await this.audit.record(id, 'dispose-error', message)
      }
    }
    await record.storage.flush()
  }

  private clearAllTimers(): void {
    for (const record of this.loaded.values()) {
      for (const timer of record.timers) clearInterval(timer)
      record.timers.clear()
    }
  }

  /** P1+P2 适配层（提案 §3.3）：白名单对象，不透传 cordis ctx。
   * P2 面：hooks（五相位总线）/tools（跨 bundle 注册表）/macros（宿主宏注册表）/
   * stscript（命令表）/llm（能力键强制）/prompt（AgentTavern section）。 */
  private createApi(record: LoadedMod): Record<string, unknown> {
    const id = record.manifest.id
    const logger = {
      info: (...args: unknown[]) => this.logger?.info?.(`dsh-tavern: [mod:${id}]`, ...args),
      warn: (...args: unknown[]) => this.logger?.warn?.(`dsh-tavern: [mod:${id}]`, ...args),
      error: (...args: unknown[]) => this.logger?.error?.(`dsh-tavern: [mod:${id}]`, ...args),
    }
    const storage = record.storage
    // 观察分支：mod 侧 `void api.storage.set(...)` 丢弃 promise 时，写失败也不
    // 变成进程级 unhandled rejection——宿主先记审计与日志，等待方仍拿到原拒绝。
    const observed = <T>(operation: Promise<T>, label: string, event: ModAuditEvent): Promise<T> => {
      operation.catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.logger?.warn?.(`dsh-tavern: [mod:${id}] ${label} failed: ${message}`)
        void this.audit.record(id, event, message)
      })
      return operation
    }
    // P2 能力面注册的统一收口：反注册句柄入 record.offRegistrations（卸载执行）。
    const tracked = (off: () => void): (() => void) => {
      record.offRegistrations.push(off)
      return off
    }
    const api: Record<string, unknown> = {
      version: MOD_API_VERSION,
      logger,
      storage: {
        get: (key: string) => observed(storage.get(key), 'storage get', 'storage-error'),
        set: (key: string, value: unknown) => observed(storage.set(key, value), 'storage set', 'storage-error'),
        delete: (key: string) => observed(storage.delete(key), 'storage delete', 'storage-error'),
      },
      assets: createModAssets(this.options.dbProvider),
      events: {
        on: (kind: string, handler: (payload: never) => unknown) => {
          if (!modEvents.isKind(kind)) throw new Error(`unknown mod event kind '${String(kind)}' (expected chat-saved | assets-saved | guides-changed)`)
          if (typeof handler !== 'function') throw new Error('mod event handler must be a function')
          const off = modEvents.on(kind, async (payload) => {
            try {
              await handler(payload)
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              this.logger?.warn?.(`dsh-tavern: [mod:${id}] ${kind} handler failed: ${message}`)
              await this.audit.record(id, 'event-error', message)
            }
          })
          record.offEvents.push(off)
          return off
        },
      },
      timers: {
        setInterval: (handler: () => void, ms: number) => {
          if (typeof handler !== 'function') throw new Error('timer handler must be a function')
          const interval = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 1
          const timer = setInterval(() => {
            // 同步抛错与异步拒绝都进审计：interval 回调里的 fire-and-forget
            // promise（如 `void api.storage.set(...)`）没有其他观察者。
            void (async () => {
              try {
                await handler()
              } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause)
                this.logger?.warn?.(`dsh-tavern: [mod:${id}] timer handler failed: ${message}`)
                void this.audit.record(id, 'timer-error', message)
              }
            })()
          }, interval)
          record.timers.add(timer)
          return timer
        },
        clearInterval: (timer: ReturnType<typeof setInterval>) => {
          clearInterval(timer)
          record.timers.delete(timer)
        },
      },
      http: {
        route: (method: string, path: string, handler: (req: ModHttpRequest, reply: ModReply) => unknown) => {
          const off = record.routeTable.register(method, path, handler)
          record.surfaces.http.add(`${String(method ?? '').toUpperCase()} ${String(path ?? '')}`)
          return tracked(off)
        },
      },
      hooks: {
        // 提案 §3.4 五相位：接 P0 总线；顺序按 loadingOrder；owner 归因让降级
        // 审计落到本 mod；失败/超时/忘 return 的降级不中断生成由总线保证。
        on: (phase: string, handler: (payload: never, context: never) => unknown) => {
          if (typeof phase !== 'string' || !GENERATION_HOOK_PHASES.has(phase as GenerationHookPhase)) {
            throw new Error(`unknown generation hook phase '${String(phase)}' (expected ${[...GENERATION_HOOK_PHASES].join(' | ')})`)
          }
          if (typeof handler !== 'function') throw new Error('generation hook handler must be a function')
          record.surfaces.hooks.add(phase)
          return tracked(generationHooks.register(phase as GenerationHookPhase, handler as never, record.manifest.loadingOrder, id))
        },
      },
      tools: {
        // 提案 §3.3：形状对齐 tool() 工厂；name 强制 <modId>_ 前缀；与内置及
        // 其他 mod 工具查重，冲突即拒（setup 期抛错 → 状态错误位，不静默）。
        register: (def: unknown) => {
          const definition = checkModToolDefinition(def, id)
          if (modToolSnapshot().some((entry) => entry.modId === id && entry.definition.name === definition.name)) {
            throw new Error(`tool '${definition.name}' is already registered by this mod`)
          }
          const claimed = claimedToolNames()
          if (claimed.has(definition.name)) {
            throw new Error(`tool name '${definition.name}' is already taken by a builtin tool or another mod`)
          }
          record.surfaces.tools.add(definition.name)
          return tracked(registerModTool(id, definition, record.manifest.loadingOrder))
        },
      },
      macros: {
        // 提案 §3.3/P0 决策注记：mod 宏进入 prompt-safety 冻结求值上下文的展开
        // 面——必须确定性（无随机/时间）。注册期静态筛查 best-effort；运行期
        // 抛错/非同步返回由包装降级保原文（引擎侧 catch 亦保原文，双保险）。
        register: (name: unknown, fn: unknown) => {
          const macroName = typeof name === 'string' ? name.trim() : ''
          if (macroName === '' || macroName.length > 64) throw new Error('macro name must be a non-empty string of at most 64 characters')
          if (macroName.includes('{{') || macroName.includes('}}') || /\s/.test(macroName)) {
            throw new Error('macro name must not include braces or whitespace')
          }
          if (typeof fn !== 'function') throw new Error('macro handler must be a function')
          const banned = screenMacroDeterminism(fn)
          if (banned !== undefined) {
            throw new Error(`macro handlers must be deterministic (no random or time sources); found '${banned}' in the handler source`)
          }
          const lowered = macroName.toLowerCase()
          if (builtinMacroNames().has(lowered)) {
            throw new Error(`macro name '${macroName}' collides with a builtin macro`)
          }
          for (const entry of hostMacroSnapshot()) {
            if (entry.name.toLowerCase() === lowered) throw new Error(`macro name '${macroName}' is already registered`)
          }
          let failureAudited = false
          const wrapped = (args: string[], engine: unknown) => {
            try {
              const result = (fn as (args: string[], engine: unknown) => unknown)(args, engine)
              if (typeof result === 'string' || result === null) return result
              if (typeof result === 'number' || typeof result === 'boolean') return String(result)
              return null // Promise/对象等非同步返回：保原文
            } catch (cause) {
              if (!failureAudited) {
                failureAudited = true
                const message = cause instanceof Error ? cause.message : String(cause)
                this.logger?.warn?.(`dsh-tavern: [mod:${id}] macro '${macroName}' failed: ${message}`)
                void this.audit.record(id, 'macro-error', `${macroName}: ${message}`)
              }
              return null
            }
          }
          record.surfaces.macros.add(macroName)
          return tracked(registerHostMacro(macroName, wrapped, record.manifest.loadingOrder))
        },
      },
      stscript: {
        // 提案 §3.3：命令名字符集校验（对齐内置命名律 [a-z0-9_]+）；禁覆盖内置
        // 命令（冲突即拒）；disposer 反注册。
        registerCommand: (name: unknown, spec: unknown) => {
          const commandName = typeof name === 'string' ? name.trim().toLowerCase() : ''
          if (!/^[a-z0-9_]+$/.test(commandName) || commandName.length > 40) {
            throw new Error(`stscript command name must match [a-z0-9_]+ (got '${String(name)}')`)
          }
          if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw new Error('stscript command spec must be an object')
          const handler = (spec as Record<string, unknown>)['run']
          if (typeof handler !== 'function') throw new Error('stscript command spec.run must be a function')
          if (stscriptCommandNames().includes(commandName)) {
            throw new Error(`stscript command '/${commandName}' is already registered (builtin command names cannot be overridden)`)
          }
          const aliases = (spec as Record<string, unknown>)['aliases']
          if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string' || !/^[a-z0-9_]+$/.test(alias)))) {
            throw new Error('stscript command aliases must be [a-z0-9_]+ strings')
          }
          const fullSpec = { ...(spec as Record<string, unknown>), name: commandName } as never
          const off = registerStscriptCommand(fullSpec)
          record.surfaces.macros.add(`/${commandName}`)
          return tracked(off)
        },
      },
      prompt: {
        // 提案 §3.4：AgentTavern 侧 prompt 分区。order 宿主钳制 -50..0（核心占
        // -80..-64）；ST 循环 hook 与此面的不对称是刻意的（文档标注）。
        section: (section: unknown) => {
          if (typeof section !== 'object' || section === null || Array.isArray(section)) throw new Error('prompt section must be an object')
          const { name, text, order } = section as Record<string, unknown>
          if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
            throw new Error(`prompt section name must match [A-Za-z0-9][A-Za-z0-9._-]* (got '${String(name)}')`)
          }
          if (typeof text !== 'string' || text === '') throw new Error('prompt section text must be a non-empty string')
          if (text.length > 65_536) throw new Error('prompt section text exceeds the 64KB limit')
          const clampedOrder = clampModSectionOrder(order)
          record.surfaces.sections.add(name)
          return tracked(registerModSection(id, { name, text, order: clampedOrder }, record.manifest.loadingOrder))
        },
      },
      onDispose: (fn: () => void | Promise<void>) => {
        if (typeof fn !== 'function') throw new Error('onDispose expects a function')
        record.disposers.push(fn)
      },
    }
    // 提案 §3.3 llm 能力键强制：manifest capabilities 不含 'llm' 时键不存在
    // （mod 访问得 undefined——知情同意的技术强制面，不是运行期检查）。
    if (record.manifest.capabilities.includes('llm')) {
      api.llm = createModLlmFace(this.options.ctx?.llm, id, this.audit, this.logger, observed)
    }
    return api
  }
}

function modInfoOf(manifest: ModManifest): Omit<ModInfo, 'status' | 'error' | 'auditCount' | 'surfaces'> {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    capabilities: manifest.capabilities,
    loadingOrder: manifest.loadingOrder,
    panel: manifest.panel ?? null,
  }
}

/** 五相位的运行期白名单（api.hooks.on 的契约面，key 字符串不得变更）。 */
const GENERATION_HOOK_PHASES = new Set<GenerationHookPhase>(['user-input', 'pre-assemble', 'pre-llm', 'post-output', 'post-save'])

/** 已装载 mod 的实际注册面（快照展示：事实优先于声明）。 */
function liveSurfacesOf(record: LoadedMod): ModSurfacesView {
  return {
    hooks: [...record.surfaces.hooks],
    tools: [...record.surfaces.tools],
    http: [...record.surfaces.http],
  }
}

/**
 * mod 工具定义校验（提案 §3.3）：形状对齐 agent.ts 的 tool() 工厂产物
 * （name/description/parameters/output/execute）；name 必须 `<modId>_` 前缀
 * 且过白名单字符集。非法形状在 setup 期抛错 → 状态错误位。
 */
function checkModToolDefinition(def: unknown, modId: string): ModToolDefinition {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) throw new Error('tool definition must be an object')
  const record = def as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || !MOD_TOOL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(`tool name must match [A-Za-z0-9][A-Za-z0-9._-]* and be at most 64 characters (got '${String(name)}')`)
  }
  const prefix = `${modId}_`
  if (!name.startsWith(prefix)) {
    throw new Error(`tool name must start with the mod id prefix '${prefix}' (got '${name}')`)
  }
  const description = record.description
  if (typeof description !== 'string' || description.trim() === '' || description.length > 4000) {
    throw new Error('tool description must be a non-empty string of at most 4000 characters')
  }
  if (typeof record.parameters !== 'object' || record.parameters === null || Array.isArray(record.parameters)) {
    throw new Error('tool parameters must be an object (JSON schema)')
  }
  const output = record.output
  if (typeof output !== 'object' || output === null || Array.isArray(output)
    || typeof (output as Record<string, unknown>)['schema'] !== 'object' || (output as Record<string, unknown>)['schema'] === null
    || typeof (output as Record<string, unknown>)['render'] !== 'function') {
    throw new Error('tool output must be { schema, render }')
  }
  if (typeof record.execute !== 'function') throw new Error('tool execute must be a function')
  return def as ModToolDefinition
}

/**
 * 宏确定性静态筛查（best-effort，提案 §3.4/P0 决策注记的文档义务落地）：
 * mod 宏进入 prompt-safety 冻结求值上下文，非确定宏会烧掉受保护 system 头的
 * 字节稳定承诺。筛 fn 源码里的常见随机/时间源；命名函数的闭包源不可见——
 * 这是声明式防线不是隔离，文档如实标注。
 */
const MACRO_NONDETERMINISM_PATTERN = /Math\.random|Date\.now|new\s+Date\b|performance\.now|hrtime|crypto\.|setTimeout|setInterval|process\.env/

export function screenMacroDeterminism(fn: (...args: never[]) => unknown): string | undefined {
  try {
    const match = MACRO_NONDETERMINISM_PATTERN.exec(fn.toString())
    return match === null ? undefined : match[0]
  } catch {
    return 'unserializable handler source'
  }
}

/**
 * api.llm 适配面（提案 §3.3，仅 capabilities 含 'llm' 时挂键）：
 * - stream：透传 ctx.llm.stream 的 async iterable，结束时审计（模型 + 用量）。
 * - request：stream 的收集出口（text/reasoning/usage/finish）——dsh-llm 的非流
 *   式面不承诺存在，自收集保证形状确定。失败原样抛给 mod；mod 丢弃 request
 *   promise 时观察分支兜底（审计 + 日志，不产生进程级 unhandled rejection）。
 */
function createModLlmFace(
  hostLlm: ModHostContext['llm'] | undefined,
  id: string,
  audit: ModAuditLog,
  logger: HostLogger | undefined,
  observed: <T>(operation: Promise<T>, label: string, event: ModAuditEvent) => Promise<T>,
): Record<string, unknown> {
  const requireStream = () => {
    const stream = hostLlm?.stream
    if (typeof stream !== 'function') throw new Error('the host LLM service is unavailable on this deployment')
    return stream
  }
  const auditCall = (request: Record<string, unknown>, usage: unknown, error?: unknown) => {
    const model = `${String(request?.provider ?? '')}/${String(request?.model ?? '')}`
    const tokens = usage !== undefined && typeof usage === 'object' && usage !== null
      ? ` tokens=${JSON.stringify(usage)}`
      : ''
    if (error !== undefined) {
      void audit.record(id, 'llm-error', `${model}${tokens ? ` ${tokens.trim()}` : ''}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void audit.record(id, 'llm-call', `${model}${tokens}`)
  }
  async function* streamChunks(request: Record<string, unknown>): AsyncIterable<Record<string, unknown>> {
    const chunks = requireStream()(request)
    let usage: unknown
    try {
      for await (const chunk of chunks) {
        if (chunk !== null && typeof chunk === 'object' && (chunk as Record<string, unknown>)['type'] === 'usage') usage = (chunk as Record<string, unknown>)['usage']
        yield chunk as Record<string, unknown>
      }
      auditCall(request, usage)
    } catch (cause) {
      auditCall(request, usage, cause)
      throw cause
    }
  }
  return {
    stream: (request: Record<string, unknown>) => {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('llm request must be an object')
      return streamChunks(request)
    },
    request: (request: Record<string, unknown>) => {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('llm request must be an object')
      const collected = (async () => {
        let text = ''
        let reasoning = ''
        let usage: unknown
        let finish: string | undefined
        for await (const chunk of streamChunks(request)) {
          if (chunk === null || typeof chunk !== 'object') continue
          const kind = chunk['type']
          if (kind === 'text-delta' && typeof chunk['text'] === 'string') text += chunk['text']
          else if (kind === 'reasoning-delta' && typeof chunk['text'] === 'string') reasoning += chunk['text']
          else if (kind === 'usage') usage = chunk['usage']
          else if (kind === 'finish') finish = typeof chunk['reason']?.['kind'] === 'string' ? chunk['reason']['kind'] : undefined
        }
        return { text, reasoning, usage, finish }
      })()
      // mod 丢弃 promise 时的观察分支：失败进审计线而不是进程级 unhandled
      // rejection；等待方（若有）仍拿到原拒绝。
      return observed(collected, 'llm request', 'llm-error')
    },
  }
}

/** 坏清单的展示字段抢救：mod.json 是对象但字段非法时尽量给出 name/version 等。 */
function salvageManifestFields(raw: unknown): Pick<BrokenMod, 'name' | 'version' | 'author' | 'description'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const pick = (key: string): string | undefined =>
    typeof record[key] === 'string' && (record[key] as string).trim() !== '' ? record[key] as string : undefined
  return {
    name: pick('name'),
    version: pick('version'),
    author: pick('author'),
    description: pick('description'),
  }
}

/** 只读资产快照面：全部走 TavernStore 读 API + structuredClone，无任何写路径。 */
function createModAssets(dbProvider: () => Promise<TavernStore>) {
  const requireString = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value === '') throw new Error(`${label} is required`)
    return value
  }
  return {
    listCharacters: async (): Promise<string[]> => structuredClone(await (await dbProvider()).listCharacters()),
    getCharacter: async (name: unknown) => {
      const found = await (await dbProvider()).getCharacter(requireString(name, 'character name'))
      return found === undefined
        ? null
        : structuredClone({ kind: found.kind, card: { spec: found.card.spec, specVersion: found.card.specVersion, data: found.card.data } })
    },
    listWorlds: async (): Promise<string[]> => structuredClone(await (await dbProvider()).listWorlds()),
    getWorld: async (name: unknown) => {
      const book = await (await dbProvider()).getWorld(requireString(name, 'world name'))
      return book === undefined ? null : structuredClone(book)
    },
    listPresets: async (): Promise<string[]> => structuredClone(await (await dbProvider()).listPresets()),
    getPreset: async (name: unknown) => {
      const preset = await (await dbProvider()).getPreset(requireString(name, 'preset name'))
      return preset === undefined ? null : structuredClone(preset)
    },
    listPersonas: async (): Promise<string[]> => structuredClone(await (await dbProvider()).listPersonas()),
    getPersona: async (name: unknown) => {
      const persona = await (await dbProvider()).getPersona(requireString(name, 'persona name'))
      return persona === undefined ? null : structuredClone(persona)
    },
    listGroups: async (): Promise<string[]> => structuredClone(await (await dbProvider()).listGroups()),
    getGroup: async (name: unknown) => {
      const group = await (await dbProvider()).getGroup(requireString(name, 'group name'))
      return group === undefined ? null : structuredClone(group)
    },
    listChats: async (character: unknown): Promise<string[]> =>
      structuredClone(await (await dbProvider()).listChats(requireString(character, 'character name'))),
    getChat: async (character: unknown, chatId: unknown) => {
      const chat = await (await dbProvider()).getChat(requireString(character, 'character name'), requireString(chatId, 'chat id'))
      return chat === undefined ? null : structuredClone(chat)
    },
  }
}
