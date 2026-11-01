/**
 * 失效会话绑定回收（决策 2026-11-02-stale-session-binding-reclaim）。
 *
 * `state.json` 里只有 `sessionBindings` 随使用单调增长：会话被用户删掉后没人
 * 回收它的绑定，记录永久留在文件里。本模块是自动回收的唯一入口，默认关闭，
 * 并且只在**两个独立信号同时否定**一条绑定时才动它：
 *
 * 1. 宿主不认识这个会话 —— `ctx.agents.list()`（宿主 `AgentRegistry.list`）与
 *    `ctx.sessions.list()`（宿主 `SessionStore.list`）两个活会话面都没有它；
 * 2. 存储层也没有这个会话工件 —— `ctx.get('sessionPersistence')` 的
 *    `list()`/`stat()`（宿主 `SessionPersistence.list/stat`，JSONL 后端的落盘
 *    位置是 `<sessions root>/<project>/<session-id>/session*.jsonl.zstd`）。
 *
 * 任一面缺失、条目不可读或调用抛错，本次一律不删：证明不了「不存在」就不当它
 * 失效（宁可少删，不可错删）。判据因此只依赖真实宿主契约，不看时间戳、不看
 * `state.json` 的写入时间。
 *
 * 读路径零改动：回收只在显式开启时跑一次，绝不挂在 `getState()` 上。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostAgentsService, HostLogger, HostSessionsService } from '../host-contract.js'

/** Cap on the ids carried by the prune audit log; the exact total stays in `removed`. */
const REMOVED_ID_SAMPLE_LIMIT = 20

/**
 * 开关取值（profile 行 config 的 `pruneStaleBindings`）。
 *
 * - `report`：只统计、只记结构化日志，一行都不写；配合 `'prune'` 构成「先干跑
 *   后落盘」的两个阶段，同一个配置项的一个显式值区分两者。
 * - `prune`：先算出同一份判据，再一次性删除。
 *
 * 缺省/任何其他值 = `off`：一条绑定都不看，`state.json` 一个字节都不动。
 */
export type SessionBindingReclaimMode = 'off' | 'report' | 'prune'

/** 开关解析结果；`supported` 为 false 表示配置值存在但不是合法模式。 */
export interface SessionBindingReclaimConfig {
  readonly mode: SessionBindingReclaimMode
  readonly supported: boolean
}

/**
 * 宿主存储面（`@deepseek-ai/dsh-session-persistence` 的 `SessionPersistence`
 * 子集）。`list` 给全量库存，`stat` 给单条复核：两个都在才敢判定「磁盘上没有」。
 */
export interface SessionPersistenceSeam {
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly unknown[]>
  stat(id: string, options?: { readonly signal?: AbortSignal }): Promise<unknown>
}

/** 一次回收运行的输入；每个字段都显式注入，测试据此钉住每条判据。 */
export interface SessionBindingReclaimInput {
  /** 已解析的模式；`off` 在调用前就应短路。 */
  readonly mode: SessionBindingReclaimMode
  /** 打开 state store（index bundle 传 `runtime.store`，测试传临时根）。 */
  readonly store: () => Promise<TavernStore>
  /** 宿主活 agent 面；缺失或没有 `list` 时整轮跳过。 */
  readonly agents?: HostAgentsService
  /** 宿主活会话面；同上。 */
  readonly sessions?: HostSessionsService
  /** 宿主存储面；缺失时整轮跳过（磁盘判据无法成立）。 */
  readonly persistence?: SessionPersistenceSeam | undefined
  readonly logger?: HostLogger
}

/** 一轮回收的判据分组计数。 */
export interface SessionBindingReclaimReport {
  readonly mode: 'report' | 'prune'
  /** 运行开始时表里的绑定条数。 */
  readonly scanned: number
  /** 因活 agent / 活会话命中而保留的条数。 */
  readonly keptLive: number
  /** 因存储层仍持有该会话而保留的条数。 */
  readonly keptStored: number
  /** 两个判据都否定（= 失效）的条数。 */
  readonly stale: number
  /** 实际删除的条数；`report` 模式恒为 0。 */
  readonly removed: number
  /** 运行结束时表里剩下的条数（`prune` 时取自写盘后 store 返回的真实表长）。 */
  readonly retained: number
}

/** 整轮跳过且一条不删的原因码（结构化日志字段，不拼字符串）。 */
export type SessionBindingReclaimSkipReason =
  /** `ctx.agents.list` 或 `ctx.sessions.list` 不可用：活会话面不完整。 */
  | 'host-live-signal'
  /** 宿主没有提供 sessionPersistence（或缺少 list/stat）。 */
  | 'session-storage-unavailable'
  /** 存储层条目里有读不出 id 的项：库存不完整，证明不了缺席。 */
  | 'session-storage-incomplete'
  /** 存储层 list/stat 抛错：判据不可信。 */
  | 'session-storage-error'

export type SessionBindingReclaimOutcome =
  | { readonly status: 'off' }
  | { readonly status: 'skipped'; readonly reason: SessionBindingReclaimSkipReason }
  | { readonly status: 'done'; readonly report: SessionBindingReclaimReport }

/** 宿主面上本模块用到的部分（`PluginContext` 结构性满足）。 */
export interface SessionBindingReclaimHost {
  readonly agents?: HostAgentsService
  readonly sessions?: HostSessionsService
  readonly logger?: HostLogger
  get?(name: string): unknown
}

/** index 侧注册参数：只有开关原值与 store 打开器，其余从 ctx 现场取。 */
export interface SessionBindingReclaimDeps {
  /** profile 行 config 的 `pruneStaleBindings` 原值（未校验）。 */
  readonly configured: unknown
  readonly store: () => Promise<TavernStore>
}

/** 解析开关：只有 `'report'` / `'prune'` 两个合法值，其余一律 `off`。 */
export function resolveSessionBindingReclaimConfig(configured: unknown): SessionBindingReclaimConfig {
  if (configured === undefined || configured === null) return { mode: 'off', supported: true }
  if (configured === 'report' || configured === 'prune') return { mode: configured, supported: true }
  return { mode: 'off', supported: false }
}

/**
 * 一轮回收：算判据 → 记结构化日志 → （`prune` 时）一次 `updateState` 删除。
 *
 * 只有 `prune` 模式会写盘；`report` 模式连 store 的写方法都不进。任一判据面
 * 不可用时只记日志并返回 `skipped`，不留任何写入。
 */
export async function reclaimStaleSessionBindings(
  input: SessionBindingReclaimInput,
): Promise<SessionBindingReclaimOutcome> {
  const log = logSink(input.logger)
  if (input.mode === 'off') return { status: 'off' }

  const live = liveSessionIds(input.agents, input.sessions)
  if (live === undefined) {
    log.warn('dsh-soulmojito session-bindings: reclaim skipped', { operation: 'reclaim-session-bindings', reason: 'host-live-signal', configuredMode: input.mode })
    return { status: 'skipped', reason: 'host-live-signal' }
  }
  const stored = await storedSessionIds(input.persistence)
  if (stored.status !== 'ok') {
    const reason = storedSkipReason(stored.status)
    log.warn('dsh-soulmojito session-bindings: reclaim skipped', {
      operation: 'reclaim-session-bindings',
      reason,
      configuredMode: input.mode,
      ...(stored.errorCode === undefined ? {} : { errorCode: stored.errorCode }),
    })
    return { status: 'skipped', reason }
  }

  const db = await input.store()
  const bindings = (await db.getState()).sessionBindings
  const sessionIds = Object.keys(bindings)
  let keptLive = 0
  let keptStored = 0
  // 失效集 = 活会话面、存储库存、单条复核三关全部否定。判定必须落在这里：
  // store 侧只删「它自己的快照 ∩ 本集合」，所以判定之后才写入的绑定不会被带走。
  // 候选逐条 `stat` 复核：`list()` 与写盘之间另一个进程可能刚好把会话落盘，
  // 这一遍是给并发留的窗口（它只会让某条从「候选」变回「保留」）。
  const remove = new Set<string>()
  try {
    for (const sessionId of sessionIds) {
      if (live.has(sessionId)) {
        keptLive += 1
      } else if (stored.ids.has(sessionId)) {
        keptStored += 1
      } else if (await persistedSessionExists(input.persistence, sessionId)) {
        keptStored += 1
      } else {
        remove.add(sessionId)
      }
    }
  } catch (error) {
    // 单条复核抛错 = 判据不可信：整轮放弃，已算出的候选一并作废。
    log.warn('dsh-soulmojito session-bindings: reclaim skipped', {
      operation: 'reclaim-session-bindings',
      reason: 'session-storage-error',
      configuredMode: input.mode,
      errorCode: errorCodeText(error),
    })
    return { status: 'skipped', reason: 'session-storage-error' }
  }

  const pruned = input.mode === 'prune' ? await db.pruneSessionBindings(remove) : undefined
  const removed = pruned === undefined ? [] : pruned.removed
  const report: SessionBindingReclaimReport = {
    mode: input.mode,
    scanned: sessionIds.length,
    keptLive,
    keptStored,
    stale: remove.size,
    removed: removed.length,
    // `retained` 只来自删除后的真实表长（store 返回），不能用「扫描数 − 删除数」
    // 反推：两者来自不同快照，并发写入会让差值失真（甚至为负）。
    retained: pruned === undefined ? sessionIds.length : pruned.retained,
  }
  log.info('dsh-soulmojito session-bindings: reclaim summary', {
    ...report,
    operation: 'reclaim-session-bindings',
    // 删除动作要能事后审计：`prune` 带被删 id（截断样本，总数看 `removed`）；
    // `report` 保持只计数。
    ...(pruned === undefined ? {} : { removedIdSample: removedIdSample(removed) }),
  })
  return { status: 'done', report }
}

/**
 * index 侧注册：解析开关，`report`/`prune` 时跑一次，`off` 时只做配置校验。
 *
 * 返回值用于测试与热重载（index.ts 侧按 `void` 调用）；任何失败都在内部收口成
 * 结构化 warn，绝不炸掉插件装载。
 */
export async function registerSessionBindingReclaim(
  ctx: SessionBindingReclaimHost,
  deps: SessionBindingReclaimDeps,
): Promise<void> {
  const log = logSink(ctx.logger)
  const resolved = resolveSessionBindingReclaimConfig(deps.configured)
  if (resolved.mode === 'off') {
    // 配置了值却不是合法模式：不静默吞掉（回收是删除路径，写错比不写更危险）。
    if (!resolved.supported) {
      log.warn('dsh-soulmojito session-bindings: unsupported pruneStaleBindings value; reclaim stays off', {
        operation: 'reclaim-session-bindings',
        reason: 'unsupported-config',
        configType: typeof deps.configured,
      })
    }
    return
  }
  try {
    await reclaimStaleSessionBindings({
      mode: resolved.mode,
      store: deps.store,
      agents: ctx.agents,
      sessions: ctx.sessions,
      persistence: persistenceSeam(ctx),
      logger: ctx.logger,
    })
  } catch (error) {
    log.warn('dsh-soulmojito session-bindings: reclaim failed', {
      operation: 'reclaim-session-bindings',
      configuredMode: resolved.mode,
      errorCode: errorCodeText(error),
    })
  }
}

/** 活会话面：两个 `list()` 都可用才算完整；缺一个就证明不了「宿主不认识」。 */
function liveSessionIds(
  agents: HostAgentsService | undefined,
  sessions: HostSessionsService | undefined,
): ReadonlySet<string> | undefined {
  if (typeof agents?.list !== 'function' || typeof sessions?.list !== 'function') return undefined
  const ids = new Set<string>()
  for (const agent of agents.list()) {
    // 宿主 Agent 的寻址键就是它承载的 session id（`AgentRegistry.get(id: SessionId)`）；
    // 两个成员都读、都算命中，任一条目全读不出来就判定面不完整（宁可少删）。
    const agentId = agent?.id
    const agentSessionId = agent?.session?.id
    let readable = false
    if (typeof agentId === 'string' && agentId !== '') {
      ids.add(agentId)
      readable = true
    }
    if (typeof agentSessionId === 'string' && agentSessionId !== '') {
      ids.add(agentSessionId)
      readable = true
    }
    if (!readable) return undefined
  }
  for (const session of sessions.list()) {
    const sessionId = (session as { id?: unknown } | null | undefined)?.id
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    ids.add(sessionId)
  }
  return ids
}

interface StoredInventory {
  readonly status: 'ok' | 'unavailable' | 'incomplete' | 'error'
  readonly ids: ReadonlySet<string>
  readonly errorCode?: string
}

/** 库存状态 → 跳过原因码（结构化日志字段共用同一套词）。 */
function storedSkipReason(status: 'unavailable' | 'incomplete' | 'error'): SessionBindingReclaimSkipReason {
  if (status === 'unavailable') return 'session-storage-unavailable'
  if (status === 'incomplete') return 'session-storage-incomplete'
  return 'session-storage-error'
}

/** 存储层库存：`list()` 给全量 id；任何一项读不出 id 都按「不完整」处理。 */
async function storedSessionIds(persistence: SessionPersistenceSeam | undefined): Promise<StoredInventory> {
  if (persistence === undefined) return { status: 'unavailable', ids: new Set() }
  let entries: readonly unknown[]
  try {
    entries = await persistence.list()
  } catch (error) {
    return { status: 'error', ids: new Set(), errorCode: errorCodeText(error) }
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    const sessionId = (entry as { header?: { id?: unknown } } | null | undefined)?.header?.id
    if (typeof sessionId !== 'string' || sessionId === '') return { status: 'incomplete', ids: new Set() }
    ids.add(sessionId)
  }
  return { status: 'ok', ids }
}

/** 单条复核：读不出来就抛给上层（整轮放弃，不猜「不存在」）。 */
async function persistedSessionExists(
  persistence: SessionPersistenceSeam | undefined,
  sessionId: string,
): Promise<boolean> {
  if (persistence === undefined) throw new Error('session persistence seam is missing')
  return await persistence.stat(sessionId) !== undefined
}

/** `ctx.get('sessionPersistence')` 的形状探测：list 与 stat 都在才返回句柄。 */
function persistenceSeam(ctx: SessionBindingReclaimHost): SessionPersistenceSeam | undefined {
  const candidate = ctx.get?.('sessionPersistence')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const seam = candidate as { list?: unknown; stat?: unknown }
  if (typeof seam.list !== 'function' || typeof seam.stat !== 'function') return undefined
  return candidate as SessionPersistenceSeam
}

/** 日志收口：日志失败绝不冒泡成回收失败。 */
function logSink(logger: HostLogger | undefined): {
  info: (message: string, fields: Record<string, unknown>) => void
  warn: (message: string, fields: Record<string, unknown>) => void
} {
  return {
    info: (message, fields) => {
      try {
        logger?.info?.(message, fields)
      } catch {
        // 上报路径自己坏掉时不能连累回收结果。
      }
    },
    warn: (message, fields) => {
      try {
        logger?.warn?.(message, fields)
      } catch {
        // 同上。
      }
    },
  }
}

/** 错误码文本（结构化日志字段；宿主错误多半只带 code）。 */
function errorCodeText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.name : String(error)
}

/**
 * 被删 id 的审计样本（前 `REMOVED_ID_SAMPLE_LIMIT` 条）。
 *
 * 上限只为不让一次大批量回收撑爆日志；`removed` 字段始终是精确总数。
 */
function removedIdSample(removed: readonly string[]): readonly string[] {
  return removed.slice(0, REMOVED_ID_SAMPLE_LIMIT)
}
