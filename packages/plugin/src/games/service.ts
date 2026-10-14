/**
 * 游戏桥服务组装（提案 0018 §4.1，P0）：registry + sessions 合成一个服务句柄，
 * 经 globalThis 发布（见 handle.ts 的跨 bundle 纪律）。index bundle 的 apply
 * 打开本服务；agent bundle 的 game_* 工具逐调用解析句柄。
 *
 * 组装层职责：变更写穿通知（emitGamesChanged）、视图文档组装（view.ts）、
 * P3 的 Mod 游戏注册面（api.games.register 的接线段——mods host 与本服务同在
 * index bundle，经既有 globalThis 句柄直调，不需要新跨 bundle 面）。
 */

import { emitGamesChanged, publishGamesService } from './handle.js'
import { GameRegistry, type GameCloneImpl, type GameSummary } from './registry.js'
import { GameBridgeError, GameSessionStore, type GameActionResult, type GameSessionSummary, type GameViewPayload } from './sessions.js'
import type { GameAction, GameEngine, GameManifest } from './standard.js'
import { renderGameViewDocument } from './view.js'

export interface GamesServiceOptions {
  /** tavern 数据根（`$DSH_HOME/tavern`）。 */
  root: string
  /** 宿主版本（engines.dsh-tavern 门控左值）。 */
  hostVersion: string
  logger?: { warn?: (message: string) => unknown }
  /** git 安装注入面（测试用：cloneImpl 替身 + 超时）。 */
  gameInstall?: { timeoutMs?: number; cloneImpl?: GameCloneImpl }
}

export interface GamesService {
  /** 游戏清单 + 会话列表（character+chatId 双全时按聊天过滤会话）。 */
  list(params: { character?: string; chatId?: string }): Promise<{ games: GameSummary[]; sessions: GameSessionSummary[] }>
  /** 会话目录 revision（1s 轮询水位，只 stat 不读内容）。 */
  revision(): Promise<string>
  start(params: { gameId: string; character: string; chatId: string; humanRole?: string }): Promise<{ session: GameSessionSummary; view: GameViewPayload }>
  state(sessionId: string): Promise<{ session: GameSessionSummary; view: GameViewPayload }>
  /** 人类落子（HTTP 面）：当前回合 owner 必须 human。 */
  humanAction(sessionId: string, action: GameAction): Promise<GameActionResult>
  /** Agent 落子（工具面）：当前回合 owner 必须 agent。 */
  agentMove(sessionId: string, action: GameAction): Promise<GameActionResult>
  /** 工具 game_start 的角色推演用（运行时以 engine.meta 为准的清单）。 */
  manifestOf(gameId: string): Promise<GameManifest>
  /** 本聊天最近活跃会话 id（game_state/game_move 缺省寻址）。 */
  latestActive(character: string, chatId: string): Promise<string | undefined>
  /** 视图文档（CSP + 桥脚本注入后的完整 HTML）。 */
  view(gameId: string, sessionId: string): Promise<string>
  /** 导入：{path} 本地目录或 {url} git 源（镜像 mods/install.ts）。 */
  install(source: { path?: string; url?: string }, force?: boolean): Promise<{ game: GameSummary }>
  /** 重扫 installed 目录（mtime 防模块缓存，见 registry.ts 文件头）。 */
  reload(): Promise<{ games: GameSummary[] }>
  /** P3（提案 §4.5 第 3 源）：Mod 游戏注册——引擎 duck 校验 + 烟测 fail-fast，
   *  重复 id 抛错；注册后写穿通知（agent 懒段与前端既有刷新路径）。 */
  registerModGame(definition: unknown): { game: GameSummary }
  /** P3：Mod 游戏反注册（Mod 卸载自动调用）；摘除后其会话孤儿化（动态查表）。 */
  unregisterModGame(id: string, engine?: unknown): boolean
  /** 摘除 globalThis 句柄（插件卸载）。 */
  dispose(): void
}

/**
 * 打开游戏服务：扫描注册表（内置 + installed 目录，坏游戏 broken 入册不抛）
 * → 打开会话存储 → 组装并发布 globalThis 句柄。失败（如 root 不可写）原样
 * 上抛，由调用方（index.ts）记日志降级——工具面在句柄缺失时报
 * 「游戏运行时不可用」。
 */
export async function openGamesService(options: GamesServiceOptions): Promise<GamesService> {
  const registry = await GameRegistry.open({ root: options.root, hostVersion: options.hostVersion, logger: options.logger })
  const sessions = await GameSessionStore.open({ root: options.root, registry: () => registry })

  const service: GamesService = {
    async list(params) {
      const games = registry.summaries()
      const sessionList = await sessions.list(params)
      return { games, sessions: sessionList }
    },
    revision: () => sessions.revision(),
    async start(params) {
      const outcome = await sessions.start(params)
      emitGamesChanged()
      return outcome
    },
    state: (sessionId) => sessions.get(sessionId),
    async humanAction(sessionId, action) {
      // 人类落子经 HTTP（index bundle）发生——写穿通知让 agent bundle 的懒提示
      // 段（order -63）刷新「轮到谁」。
      const outcome = await sessions.humanAction(sessionId, action)
      emitGamesChanged()
      return outcome
    },
    async agentMove(sessionId, action) {
      const outcome = await sessions.agentMove(sessionId, action)
      emitGamesChanged()
      return outcome
    },
    async manifestOf(gameId) {
      const entry = registry.get(gameId)
      if (entry === undefined) throw new GameBridgeError('not-found', `游戏 '${gameId}' 不在注册表`)
      if (entry.status !== 'ok') throw new GameBridgeError('unavailable', `游戏 '${gameId}' 不可用: ${entry.reason}`)
      return entry.manifest
    },
    latestActive: (character, chatId) => sessions.latestActive(character, chatId),
    async view(gameId, sessionId) {
      const entry = registry.get(gameId)
      if (entry === undefined) throw new GameBridgeError('not-found', `游戏 '${gameId}' 不在注册表`)
      if (entry.status !== 'ok' || entry.viewHtml === null) {
        throw new GameBridgeError('unavailable', `游戏 '${gameId}' 不可用: ${entry.reason}`)
      }
      const { session } = await sessions.get(sessionId)
      if (session.gameId !== entry.manifest.id) {
        throw new GameBridgeError('not-found', `会话 '${sessionId}' 不属于游戏 '${gameId}'`)
      }
      return renderGameViewDocument(entry.viewHtml)
    },
    async install(source, force = false) {
      if (typeof source.path === 'string' && source.path.trim() !== '') {
        const game = await registry.installFromPath(source.path, force)
        emitGamesChanged()
        return { game }
      }
      if (typeof source.url === 'string' && source.url.trim() !== '') {
        const game = await registry.installFromGit(source.url, force, options.gameInstall ?? {})
        emitGamesChanged()
        return { game }
      }
      throw new GameBridgeError('invalid', 'expected { path } or { url }')
    },
    async reload() {
      const games = await registry.reload()
      emitGamesChanged()
      return { games }
    },
    registerModGame(definition: unknown) {
      // P3（提案 §4.5 第 3 源）：registry 做引擎/烟测/冗余字段校验（fail-fast，
      // 抛错 = Mod setup 失败）；注册成功后写穿通知——agent bundle 的懒提示段
      // （order -63）经 onGamesChanged 刷新。前端侧按既有边界刷新（revision 只
      // stat sessions 目录，游戏清单要等面板重开/绑定变化/下次水位变化，见
      // 决策 2026-10-13）。
      const game = registry.registerModGame(definition)
      emitGamesChanged()
      return { game }
    },
    unregisterModGame(id: string, engine?: unknown) {
      const removed = registry.unregisterModGame(id, engine as GameEngine | undefined)
      if (removed) emitGamesChanged()
      return removed
    },
    dispose() {
      unpublish()
    },
  }

  const unpublish = publishGamesService(service)
  return service
}
