/**
 * 游戏注册表（提案 0018 §4.1/§4.5，P0 + P2 导入路径 + P3 Mod 注册）。
 *
 * 三源合一：builtin（静态 import，随插件分发）/ imported（<data root>/
 * games/installed/<id>/ 目录装载，动态 import）/ mod（§4.5 第 3 源——Mod 经
 * `api.games.register` 在 setup 期注册，进程内引擎对象 + view HTML 字符串）。
 *
 * 纪律（镜像 mods host）：
 * - **坏游戏不断路**：清单读不出/校验失败/engines 不满足/引擎抛错/烟测不过 →
 *   以 status:'broken' + reason 入册，不抛异常不崩启动（mods blocked 语义）。
 *   **唯一例外是 Mod 注册**：与工具注册同为 fail-fast——duck 校验/烟测/view
 *   静态检查任一不过直接抛错（Mod setup 失败进错误位，不静默入 broken 册）。
 * - **目录白名单**：只扫 installed/ 直接子目录；清单 id 必须等于目录名。
 * - **ESM 实例缓存**：动态 import 的 URL 恒带 `?v=<mtimeMs>` 查询段——文件
 *   未变时命中同一模块实例，变了则拿到新实例（reload 防模块缓存的纪律，
 *   host.ts 的 `?t=` cache-bust 同学科；用 mtime 而非 Date.now 可避免无谓地
 *   重复实例化未变更的引擎）。
 * - **运行时以 engine.meta 为准**（提案 §6）：清单与 meta 冗余字段不一致时只
 *   记 warning 日志，注册表条目采用 meta 的值（单一事实来源纪律）。
 * - **同 id 遮蔽**（2026-10-14）：导入目录与内置同 id（内置五子棋 vs 导入参照包）
 *   时以磁盘上的导入副本为准并记 warning（见 scanInstalled 注释）——不引入内置
 *   保护特例，保持 get() 的「builtin/imported 优先于 mod」单一遮蔽规则。
 * - **mod 源独立成册**：mod 注册活在本进程内存（引擎对象不落盘），reload/
 *   scan 重扫只清 builtin+imported 册——Mod 注册不随 installed 目录重扫丢失；
 *   Mod 卸载（disable/目录消失/reload）经宿主 offRegistrations 反注册。
 */

import { promises as fs } from 'node:fs'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipArchive } from '../../../tavern-format/src/index.js'
import { satisfiesVersionRange } from '../mods/manifest.js'
import { gitClone, parseGitSource } from '../mods/install.js'
import { blackjack } from './builtin/blackjack.js'
import { chineseCheckers } from './builtin/chinese-checkers.js'
import { dungeonCrawl } from './builtin/dungeon-crawl.js'
import { gomoku } from './builtin/gomoku.js'
import { junqi } from './builtin/junqi.js'
import { memoryMatch } from './builtin/memory.js'
import { monopoly } from './builtin/monopoly.js'
import { ticTacToe } from './builtin/tic-tac-toe.js'
import { xiangqi } from './builtin/xiangqi.js'
import {
  checkGameEngine,
  checkGameManifest,
  smokeTestGameEngine,
  type GameEngine,
  type GameManifest,
  type GameSource,
} from './standard.js'

/** games/list 面板的轻量投影（HTTP GET games/list 的 games 数组项）。 */
export interface GameSummary {
  id: string
  name: string
  version: string
  source: GameSource
  players: { min: number; max: number; roles: string[] }
  turnBased: boolean
  actionVocabulary: string
  status: 'ok' | 'broken'
  /** status === 'broken' 时的原因（可读中文，面板直接展示）。 */
  reason?: string
}

/** 注册表内部条目：engine/viewHtml 仅在 status ok 时可用。 */
export interface GameEntry {
  source: GameSource
  manifest: GameManifest
  engine: GameEngine | null
  viewHtml: string | null
  status: 'ok' | 'broken'
  reason: string
  /** imported 源的游戏目录（install 落地路径）。 */
  directory?: string
}

export interface GameRegistryOptions {
  /** tavern 数据根（新装 `$DSH_HOME/soulmojito`，旧装 `$DSH_HOME/tavern`）。导入目录是 `<root>/games/installed/`。 */
  root: string
  /** 宿主版本（engines.dsh-soulmojito 范围校验的左值）。 */
  hostVersion: string
  logger?: { warn?: (message: string) => unknown }
}

/** git 安装实现注入面（测试镜像 mods/install.ts 的 cloneImpl 纪律）。 */
export type GameCloneImpl = (url: string, directory: string, ref: string | undefined, timeoutMs: number) => Promise<void>

/** zip 上传（面板导入口，2026-10-17）的条目数与体积上限：标准游戏包只含
 *  三个小文件，这里是防滥用线而不是目标值（错误文案面向游戏包作者）。 */
export const GAME_ZIP_MAX_ENTRIES = 64
export const GAME_ZIP_MAX_FILE_BYTES = 2 * 1024 * 1024
export const GAME_ZIP_MAX_TOTAL_BYTES = 4 * 1024 * 1024

export class GameRegistry {
  private readonly games = new Map<string, GameEntry>()
  /** mod 源独立成册（文件头纪律）：reload/scan 只清 games，mod 注册驻留本进程。 */
  private readonly modGames = new Map<string, GameEntry>()

  private constructor(private readonly options: GameRegistryOptions) {}

  static async open(options: GameRegistryOptions): Promise<GameRegistry> {
    const registry = new GameRegistry(options)
    await registry.scan()
    return registry
  }

  private get installedRoot(): string {
    return join(this.options.root, 'games', 'installed')
  }

  /** 注册表快照（按 id 稳定排序；三源合一——builtin/imported/mod）。 */
  summaries(): GameSummary[] {
    return [...this.games.values(), ...this.modGames.values()]
      .sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))
      .map((entry) => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        source: entry.source,
        players: entry.manifest.players,
        turnBased: entry.manifest.turnBased,
        actionVocabulary: entry.manifest.actionVocabulary,
        status: entry.status,
        ...(entry.status === 'broken' ? { reason: entry.reason } : {}),
      }))
  }

  get(id: string): GameEntry | undefined {
    // builtin/imported 优先于 mod：目录导入（installed/<id>/）与 Mod 注册撞 id 时
    // 以磁盘上可审计的导入副本为准（注册期反查双侧拒绝，正常路径撞不上）。
    return this.games.get(id) ?? this.modGames.get(id) ?? this.resolveLegacyId(id)
  }

  /** 改名兼容（2026-10-16 项目改名）：存量对局文件里持久化的 gameId 是旧命名
   * 空间 `dsh-tavern.<name>`——直接命中（仍在册的旧名条目，如用户装过的旧示例
   * 包目录）永远优先；落空时按命名空间重映射查新名，旧对局不断。 */
  private resolveLegacyId(id: string): GameEntry | undefined {
    const prefix = 'dsh-tavern.'
    if (!id.startsWith(prefix)) return undefined
    const mapped = `dsh-soulmojito.${id.slice(prefix.length)}`
    return this.games.get(mapped) ?? this.modGames.get(mapped)
  }

  /** 重扫（POST games/reload）：清空后重建——builtins 重跑烟测，导入目录重读。 */
  async reload(): Promise<GameSummary[]> {
    this.games.clear()
    await this.scan()
    return this.summaries()
  }

  /** 启动扫描：内置源 + imported 目录，坏游戏 broken 入册。 */
  async scan(): Promise<void> {
    this.loadBuiltins()
    await this.scanInstalled()
  }

  private loadBuiltins(): void {
    for (const builtin of [ticTacToe, gomoku, xiangqi, junqi, blackjack, memoryMatch, monopoly, dungeonCrawl, chineseCheckers]) {
      const smoke = smokeTestGameEngine(builtin.engine)
      if (!smoke.ok) {
        // 内置引擎烟测失败是编程错误：如实 broken 入册（仍不崩启动），测试会抓。
        this.games.set(builtin.manifest.id, {
          source: 'builtin', manifest: builtin.manifest, engine: null, viewHtml: null,
          status: 'broken', reason: `内置引擎烟测失败: ${smoke.reasons.join('; ')}`,
        })
        continue
      }
      this.games.set(builtin.manifest.id, {
        source: 'builtin', manifest: builtin.engine.meta, engine: builtin.engine,
        viewHtml: builtin.viewHtml, status: 'ok', reason: '',
      })
    }
  }

  private async scanInstalled(): Promise<void> {
    const entries = await fs.readdir(this.installedRoot, { withFileTypes: true }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [] as Dirent[]
      throw cause
    })
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    for (const directory of directories) {
      const entry = await this.loadInstalled(join(this.installedRoot, directory)).catch((cause: unknown) => {
        // 装载过程任何未预期异常都收敛为 broken 条目（坏世界书不 500 bootstrap 同教义）。
        const message = cause instanceof Error ? cause.message : String(cause)
        return { source: 'imported' as const, manifest: brokenFallbackManifest(directory), engine: null, viewHtml: null, status: 'broken' as const, reason: message, directory: join(this.installedRoot, directory) }
      })
      const shadowed = this.games.get(entry.manifest.id)
      if (shadowed?.source === 'builtin') {
        // 同 id 遮蔽（内置五子棋与导入参照包同 id，2026-10-14）：以磁盘上可审计
        // 的导入副本为准（与 get() 的 builtin/imported 优先于 mod 同一纪律）。
        // 不静默——来源目录与装载结果进日志；坏导入同样遮蔽（broken 条目可见，
        // 删目录即恢复内置），不引入内置保护特例。
        this.options.logger?.warn?.(
          `dsh-soulmojito: 导入游戏 '${entry.manifest.id}'（目录 ${directory}）与内置游戏同 id，以导入副本为准（status: ${entry.status}）`,
        )
      }
      this.games.set(entry.manifest.id, entry)
    }
  }

  /** 装载一个导入目录：清单校验 → engines 门控 → view 静态检查 → 动态 import → duck 校验 → 烟测。 */
  private async loadInstalled(directory: string): Promise<GameEntry> {
    const broken = (manifest: GameManifest, reason: string): GameEntry =>
      ({ source: 'imported', manifest, engine: null, viewHtml: null, status: 'broken', reason, directory })

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(join(directory, 'game.json'), 'utf8'))
    } catch (cause) {
      return broken(brokenFallbackManifest(directoryNameOf(directory)), `game.json 缺失或不可读: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const directoryName = directoryNameOf(directory)
    const check = checkGameManifest(raw, { directory: directoryName })
    if (!check.ok) return broken(brokenFallbackManifest(directoryName, raw), `清单校验失败: ${check.errors.join('; ')}`)

    // 改名兼容（2026-10-16）：旧键 engines['dsh-tavern'] 双读（存量示例/三方
    // 游戏包不改也能加载）；新写入恒用新键。
    const engineRange = check.manifest!.engines?.['dsh-soulmojito'] ?? check.manifest!.engines?.['dsh-tavern']
    if (engineRange !== undefined) {
      const verdict = satisfiesVersionRange(this.options.hostVersion, engineRange)
      if (!verdict.ok) return broken(check.manifest!, `版本不满足: ${verdict.reason}`)
    }

    // view.html 静态检查（§4.6：CSP 在服务期兜底，这里只提前给出可读报错）。
    let viewHtml: string
    try {
      viewHtml = await fs.readFile(join(directory, 'view.html'), 'utf8')
    } catch {
      return broken(check.manifest!, 'view.html 缺失（标准游戏包必须三件套齐全）')
    }
    const viewProblem = staticViewCheck(viewHtml)
    if (viewProblem !== undefined) return broken(check.manifest!, `view.html ${viewProblem}`)

    // 动态 import：URL 恒带 mtime 查询段（文件头纪律）。
    const enginePath = join(directory, 'engine.mjs')
    const stat = await fs.stat(enginePath).catch(() => undefined)
    if (stat?.isFile() !== true) return broken(check.manifest!, 'engine.mjs 缺失（标准游戏包必须三件套齐全）')
    let imported: unknown
    try {
      imported = await import(`${pathToFileURL(enginePath).href}?v=${stat!.mtimeMs}`)
    } catch (cause) {
      return broken(check.manifest!, `engine.mjs 导入失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const engineCheck = checkGameEngine((imported as { default?: unknown }).default)
    if (!engineCheck.ok) return broken(check.manifest!, `引擎校验失败: ${engineCheck.errors.join('; ')}`)

    // 清单/meta 冗余不一致：运行时以 meta 为准，只记 warning（提案 §6）。
    for (const key of ['id', 'name', 'version', 'players', 'turnBased', 'actionVocabulary'] as const) {
      if (JSON.stringify(check.manifest![key]) !== JSON.stringify(engineCheck.engine!.meta[key])) {
        this.options.logger?.warn?.(`dsh-soulmojito: game '${check.manifest!.id}' 清单与 engine.meta 的 ${key} 不一致，运行时以 meta 为准`)
      }
    }

    const smoke = smokeTestGameEngine(engineCheck.engine!)
    // 烟测失败以**清单**（=目录名）落 key：engine.meta 只在成功路径作为权威
    // （§6）——失败条目若按 meta 重键，会吞掉与其 meta 同名的其他游戏的槽位。
    if (!smoke.ok) return broken(check.manifest!, `烟测失败: ${smoke.reasons.join('; ')}`)
    return { source: 'imported', manifest: engineCheck.engine!.meta, engine: engineCheck.engine, viewHtml, status: 'ok', reason: '', directory }
  }

  /**
   * 从本地目录安装（POST games/install {path}）：校验源目录 → 拷入
   * installed/<id>/（排除 .git）→ 装载该目录 → 返回该游戏的 status 快照。
   * 已存在目录拒绝（force=true 先删后装）——镜像 mods/install.ts 落地纪律。
   */
  async installFromPath(sourcePath: string, force = false): Promise<GameSummary> {
    const source = resolve(sourcePath)
    if (!existsSync(source)) throw new Error(`游戏包目录不存在: ${sourcePath}`)
    const stat = await fs.stat(source)
    if (!stat.isDirectory()) throw new Error(`游戏包路径必须是目录: ${sourcePath}`)
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(join(source, 'game.json'), 'utf8'))
    } catch (cause) {
      throw new Error(`源目录缺少可读的 game.json: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const id = typeof (raw as Record<string, unknown>)?.['id'] === 'string' ? (raw as Record<string, unknown>)['id'] as string : ''
    const check = checkGameManifest(raw, { directory: id || undefined })
    if (!check.ok || !check.manifest) throw new Error(`游戏清单校验失败: ${check.errors.join('; ')}`)
    const target = join(this.installedRoot, check.manifest.id)
    await fs.mkdir(this.installedRoot, { recursive: true })
    if (existsSync(target)) {
      if (force !== true) throw new Error(`游戏 '${check.manifest.id}' 已安装（force=true 可覆盖）`)
      rmSync(target, { recursive: true, force: true })
    }
    cpSync(source, target, { recursive: true, filter: (src) => !src.endsWith('.git') })
    const entry = await this.loadInstalled(target)
    this.games.set(entry.manifest.id, entry)
    return this.summaries().find((summary) => summary.id === entry.manifest.id)!
  }

  /**
   * 从 git URL 安装（POST games/install {url}）：镜像 mods/install.ts 的 git
   * 流程——parseGitSource 复用（GitHub slug/完整 git URL/#ref 语法同一份），
   * `git clone --depth 1` 到临时目录，本地 game.json 定 id 后拷入 installed/。
   * 与 mods 的差异（如实）：无 raw 预读（游戏包无配额敏感的元数据预读需求），
   * 校验全部发生在本地克隆之后。cloneImpl 供测试注入。
   */
  async installFromGit(url: string, force = false, options: { timeoutMs?: number; cloneImpl?: GameCloneImpl } = {}): Promise<GameSummary> {
    const timeoutMs = options.timeoutMs ?? 60_000
    const source = parseGitSource(url)
    const workRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-gameinstall-'))
    try {
      const cloneDir = join(workRoot, 'clone')
      await (options.cloneImpl ?? gitClone)(source.cloneUrl, cloneDir, source.ref, timeoutMs)
      return await this.installFromPath(cloneDir, force)
    } finally {
      rmSync(workRoot, { recursive: true, force: true })
    }
  }

  /**
   * 从 zip 字节导入（面板导入口，`POST games/install {zipBase64}`，2026-10-17）：
   * base64 解码 → tavern-format 解包（fflate）→ 路径清洗（穿越/绝对路径拒绝，
   * 垃圾条目跳过，三道上限见 GAME_ZIP_*）→ 单层包装目录自动下潜 → 落临时目录 →
   * 复用 installFromPath 的全量校验与落地（installed/<id>/ + 装载 + 返回快照）。
   * 临时目录 finally 清理；任何校验失败抛可读错误（service 层统一转 400）。
   */
  async installFromZip(zipBase64: string, force = false): Promise<GameSummary> {
    const files = selectGamePackageFiles(unzipArchive(decodeZipBase64(zipBase64)))
    const workRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-gamezip-'))
    try {
      for (const [name, data] of files) {
        const target = join(workRoot, ...name.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, data)
      }
      return await this.installFromPath(workRoot, force)
    } finally {
      rmSync(workRoot, { recursive: true, force: true })
    }
  }

  /* ------------------------- Mod 源（提案 §4.5 第 3 源，P3） ------------------------- */

  /**
   * Mod 游戏注册（`api.games.register` 的接线终点）：engine 是进程内对象
   * （duck 校验 + 烟测 fail-fast——失败抛错 = Mod setup 失败，镜像工具注册），
   * view 是 HTML 字符串（Mod 无静态文件服务，维持内联纪律；过 §4.6 同款静态
   * 检查）。定义顶层冗余字段（id/name/version/players/turnBased/actionVocabulary）
   * 必须与 engine.meta 一致——运行时以 meta 为准（§6 双子段纪律的注册期收口）。
   */
  registerModGame(definition: unknown): GameSummary {
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
      throw new Error('game registration must be an object')
    }
    const record = definition as Record<string, unknown>

    const engineCheck = checkGameEngine(record.engine)
    if (!engineCheck.ok) throw new Error(`游戏引擎校验失败: ${engineCheck.errors.join('; ')}`)
    const engine = engineCheck.engine!

    // 双子段冗余对账（game.json 与 meta 的同款纪律，注册期逐字段强制相等）。
    const manifest = engine.meta
    const redundant: Array<[string, unknown]> = [
      ['id', record.id],
      ['name', record.name],
      ['version', record.version],
      ['players', record.players],
      ['turnBased', record.turnBased],
      ['actionVocabulary', record.actionVocabulary],
    ]
    for (const [key, value] of redundant) {
      if (JSON.stringify(value) !== JSON.stringify(manifest[key])) {
        throw new Error(`注册字段 ${key} 与 engine.meta.${key} 不一致（运行时以 meta 为准，两侧必须相等）`)
      }
    }

    const smoke = smokeTestGameEngine(engine)
    if (!smoke.ok) throw new Error(`引擎烟测失败: ${smoke.reasons.join('; ')}`)

    if (typeof record.view !== 'string' || record.view.trim() === '') {
      throw new Error('view 必须是非空 HTML 字符串（Mod 游戏视图走内联纪律，无静态文件服务）')
    }
    const viewProblem = staticViewCheck(record.view)
    if (viewProblem !== undefined) throw new Error(`view ${viewProblem}`)

    if (this.get(manifest.id) !== undefined) {
      throw new Error(`game '${manifest.id}' is already registered (builtin, imported or another mod holds this id)`)
    }

    this.modGames.set(manifest.id, {
      source: 'mod', manifest, engine, viewHtml: record.view, status: 'ok', reason: '',
    })
    return this.summaries().find((summary) => summary.id === manifest.id)!
  }

  /**
   * Mod 游戏反注册（Mod 卸载经宿主 offRegistrations 调用）。engine 传入时做
   * 身份对账：只摘除同一引擎实例的注册（reload 后旧实例的 off 触碰新实例是
   * no-op，镜像 onButton 的「反注册只撤销同一 handler」纪律）。builtin/imported
   * 源不受本方法影响。摘除后其活跃会话由 sessions 的孤儿判定（按 gameId 动态
   * 查注册表）自然接管——可查看不可落子。
   */
  unregisterModGame(id: string, engine?: GameEngine): boolean {
    const entry = this.modGames.get(id)
    if (entry === undefined) return false
    if (engine !== undefined && entry.engine !== engine) return false
    this.modGames.delete(id)
    return true
  }
}

/** broken 条目的兜底清单：目录名当 id，尽力保留可读字段（面板展示用）。 */
function brokenFallbackManifest(directory: string, raw?: unknown): GameManifest {
  const value = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : directory,
    name: typeof value.name === 'string' && value.name !== '' ? value.name : directory,
    version: typeof value.version === 'string' ? value.version : '',
    players: { min: 2, max: 2, roles: [] },
    turnBased: true,
    actionVocabulary: '',
  }
}

function directoryNameOf(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? directory
}

/** view.html 静态检查（§4.6）：无外链 script/样式与网络调用字样。 */
export function staticViewCheck(viewHtml: string): string | undefined {
  if (/src\s*=\s*["']https?:/i.test(viewHtml)) return '包含外链 script/资源（必须自包含）'
  if (/href\s*=\s*["']https?:/i.test(viewHtml)) return '包含外链样式/链接（必须自包含）'
  if (viewHtml.includes('fetch(')) return '包含 fetch 网络调用（connect-src \'none\' 纪律）'
  return undefined
}

/** zip 上传体解码（base64）：宽容空白；空体或明显非法字符给出可读错误。 */
function decodeZipBase64(zipBase64: string): Uint8Array {
  const normalized = zipBase64.replace(/\s+/g, '')
  if (normalized === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('zipBase64 不是有效的 base64（面板上传应发送游戏包 zip 的 base64 字节）')
  }
  return new Uint8Array(Buffer.from(normalized, 'base64'))
}

/**
 * zip 条目 → 游戏包文件集（安全与体积纪律，面板上传路径）：
 * - 反斜杠归一为正斜杠；目录条目（尾 `/`）与 `__MACOSX/`、`.DS_Store` 垃圾跳过
 *   （macOS 压缩产物的常见噪声，不该让导入失败）；
 * - 绝对路径（前导 `/` 或盘符）与含 `.` / `..` / 空段的路径一律拒绝（zip-slip
 *   防线）；条目数 / 单文件 / 总量三道上限（解包后校验——与 CHARX 的 unzipSync
 *   同信任级，防的是误用而非密码学级对抗）；
 * - 全部条目同属一个顶层目录且根无 game.json 时剥掉该层（「压缩文件夹」形态）；
 * - 最终必须存在 game.json（三件套其余两件由 loadInstalled 校验，缺失入 broken 册）。
 */
function selectGamePackageFiles(archive: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (const [rawName, data] of Object.entries(archive)) {
    const name = rawName.replaceAll('\\', '/')
    if (name.endsWith('/')) continue
    const segments = name.split('/')
    if (segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store') continue
    if (name === '' || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`zip 含非法路径 '${rawName}'（拒绝绝对路径与 .. 穿越）`)
    }
    if (files.size >= GAME_ZIP_MAX_ENTRIES) {
      throw new Error(`zip 条目数超过上限（${GAME_ZIP_MAX_ENTRIES}）`)
    }
    if (data.length > GAME_ZIP_MAX_FILE_BYTES) {
      throw new Error(`zip 内文件 '${name}' 超过 ${GAME_ZIP_MAX_FILE_BYTES} 字节上限`)
    }
    total += data.length
    if (total > GAME_ZIP_MAX_TOTAL_BYTES) {
      throw new Error(`zip 解包总量超过 ${GAME_ZIP_MAX_TOTAL_BYTES} 字节上限`)
    }
    files.set(name, data)
  }
  if (files.size === 0) throw new Error('zip 为空或不含任何文件')
  const unwrapped = unwrapSingleRootDirectory(files)
  if (!unwrapped.has('game.json')) {
    throw new Error('zip 内没有 game.json（请直接压缩包含 game.json / engine.mjs / view.html 的游戏包目录）')
  }
  return unwrapped
}

/** 单层包装目录下潜（「压缩文件夹」形态）：根无 game.json、全部条目同属一个
 *  顶层目录时剥掉该层；存在裸文件（如根级 README）时保持原样。 */
function unwrapSingleRootDirectory(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has('game.json')) return files
  const roots = new Set([...files.keys()].map((name) => name.split('/')[0]))
  if (roots.size !== 1) return files
  const root = [...roots][0]
  if (root === undefined || [...files.keys()].some((name) => !name.startsWith(`${root}/`))) return files
  const unwrapped = new Map<string, Uint8Array>()
  for (const [name, data] of files) unwrapped.set(name.slice(root.length + 1), data)
  return unwrapped
}
