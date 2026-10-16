/**
 * 游戏服务的跨 bundle 句柄（提案 0018 §4.1，镜像 src/mods/cross-bundle.ts 纪律）。
 *
 * 为什么必须锚 globalThis：游戏运行时（registry + sessions）只活在 index bundle
 * （apply 内打开），而 game_* 工具活在 agent bundle（agent.mjs，独立 esbuild
 * 产物，无共享模块态）。注册动作（index bundle 写）与消费动作（agent bundle
 * 每次工具调用读）必须经 `globalThis[Symbol.for('dsh-soulmojito:games-service')]`
 * 互见。key 字符串是 bundle 间互见契约，不得变更。
 *
 * 本模块刻意只依赖 cross-bundle-events（无 fs/引擎图）：agent bundle 内联这份
 * 小 seam 时不会拖进整个游戏运行时——句柄解析失败时工具返回明确错误
 * 「游戏运行时不可用」。
 *
 * 变更通知走 `dsh-soulmojito:games-changed-listeners`（createGlobalListenerRegistry，
 * guides/preset/mods 同款写穿语义）：index bundle 的落子/安装/重扫 emit 后，
 * agent bundle 已挂载的懒提示段（order -63）增量重载。
 */

import { createGlobalListenerRegistry } from '../cross-bundle-events.js'
import type { GamesService } from './service.js'

/** bundle 间互见契约 key（不得变更）。 */
export const GAMES_SERVICE_KEY = 'dsh-soulmojito:games-service'

const serviceSymbol = Symbol.for(GAMES_SERVICE_KEY)

interface ServiceHolder {
  service: GamesService
  token: number
}

let nextToken = 1

/**
 * 写侧：发布服务句柄（index bundle 的 openGamesService 调用）。返回撤销函数
 * ——仅当仍是当前发布时才摘除（sequence 守卫，镜像 registerModTool 纪律）。
 */
export function publishGamesService(service: GamesService): () => void {
  const holder = globalThis as Record<symbol, ServiceHolder | undefined>
  const token = nextToken++
  holder[serviceSymbol] = { service, token }
  return () => {
    if (holder[serviceSymbol]?.token === token) delete holder[serviceSymbol]
  }
}

/** 读侧：逐调用解析服务句柄；缺失（index bundle 未装载游戏运行时）返回 undefined。 */
export function resolveGamesService(): GamesService | undefined {
  const holder = globalThis as Record<symbol, ServiceHolder | undefined>
  return holder[serviceSymbol]?.service
}

/** 测试隔离用：强制摘除当前句柄（globalThis 状态在测试文件间共享）。 */
export function clearGamesServiceForTest(): void {
  delete (globalThis as Record<symbol, ServiceHolder | undefined>)[serviceSymbol]
}

const gamesChangedListeners = createGlobalListenerRegistry<() => void>('dsh-soulmojito:games-changed-listeners')

/** 读侧订阅：任何游戏变更（落子/开局/安装/重扫）后的写穿通知。返回反订阅。 */
export function onGamesChanged(listener: () => void): () => void {
  return gamesChangedListeners.on(listener)
}

/** 写侧触发（fire-and-forget，吞错在注册表内）。 */
export function emitGamesChanged(): void {
  void gamesChangedListeners.emit()
}

/** 等待登记表（会话 id → 挂起中的 game_wait 计数）。bundle 间互见契约 key。 */
export const GAMES_WAITERS_KEY = 'dsh-soulmojito:games-waiters'

type GamesWaiterRegistry = Map<string, Set<symbol>>

function waiterRegistry(): GamesWaiterRegistry {
  const holder = globalThis as Record<symbol, GamesWaiterRegistry | undefined>
  const key = Symbol.for(GAMES_WAITERS_KEY)
  let registry = holder[key]
  if (registry === undefined) {
    registry = new Map()
    holder[key] = registry
  }
  return registry
}

/**
 * 写侧（agent bundle 的 game_wait）：登记「本会话有人正在等人类落子」，返回
 * 注销器（工具返回/中止/抛错时释放）。2026-10-14 自动续弈修订：index bundle
 * 的人类落子入口据此判定——有等待者时该手已由工具内唤醒覆盖，**绝不再**
 * followup 唤起（否则等待中的回合结束后会多出一个陈旧通知回合）。
 */
export function beginGameWait(sessionId: string): () => void {
  const registry = waiterRegistry()
  const token = Symbol('dsh-soulmojito:game-wait')
  const tokens = registry.get(sessionId) ?? new Set<symbol>()
  tokens.add(token)
  registry.set(sessionId, tokens)
  return () => {
    const current = registry.get(sessionId)
    if (current === undefined) return
    current.delete(token)
    if (current.size === 0) registry.delete(sessionId)
  }
}

/** 读侧（index bundle 的人类落子入口）：挂起中的等待者数量。 */
export function gameWaiters(sessionId: string): number {
  return waiterRegistry().get(sessionId)?.size ?? 0
}

/** 测试隔离用：清空登记表（globalThis 状态在测试文件间共享）。 */
export function clearGameWaitersForTest(): void {
  delete (globalThis as Record<symbol, GamesWaiterRegistry | undefined>)[Symbol.for(GAMES_WAITERS_KEY)]
}
