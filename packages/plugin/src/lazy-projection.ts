/**
 * 按 agentId 的懒装载投影通道工厂（决策 2026-10-09-dedup-refactor）。
 *
 * agent-tavern 的 facts / guides / 剧本摘要 / 激活预设四条文本通道与
 * preset-mount 的闭包版此前各自复制同一骨架：Map 缓存 + started 集合 +
 * 装载票号（last-write-wins，防在途过期装载覆盖写穿新值）+ 空身份守卫 +
 * 「遍历 sessionBindings → 谓词过滤 → started 标记 → 逐个重载」的写穿/预热
 * 遍历。本工厂统一骨架；装载体（读什么、怎么渲染）与门控失败策略（裸 return
 * 留旧值 vs settle 空值）由注入的 load 决定——settle 内置票号检查，调用方
 * 无须自管。
 *
 * 与原实现一致的行为约束：
 * - 读取不阻塞装配：未装载过则触发一次异步装载（void），返回当前缓存值；
 * - 装载失败静默（A missing store must not prevent the host agent from starting）；
 * - 写穿/预热 best-effort：失败只意味着下一次装配沿用旧缓存；
 * - 冻结求值上下文（决策 2026-10-09-agent-preset-cache-stability）等通道特有
 *   状态留在调用方闭包，工厂不感知。
 */

import type { TavernSessionBinding, TavernState } from '../../tavern-store/src/index.js'

export interface LazyProjectionOptions<V> {
  /** 读取 state（含 sessionBindings）的通道；各宿主用自己的 store 懒单例。 */
  getState: () => Promise<TavernState>
  /** 装载一个 agent 的投影值。门控不过/资产缺失时可以不 settle（留旧值）或
   *  settle 空值，由通道语义决定；settle 自带票号检查，过期装载静默丢弃。 */
  load: (agentId: string, settle: (value: V) => void) => Promise<void>
}

export interface LazyProjection<V> {
  /** 懒读取：空身份返回 undefined；未装载过则触发一次异步装载；返回当前缓存值。 */
  valueOf(agentId: string | undefined): V | undefined
  /** 写穿遍历：对 sessionBindings 里满足谓词的绑定标记已装载并重载。
   *  best-effort，整体失败静默。 */
  refreshWhere(match: (binding: TavernSessionBinding) => boolean): Promise<void>
  /** 幂等预热：首次调用执行一遍 refreshWhere，之后 no-op（apply 可能被宿主重复调用）。 */
  preheatWhere(match: (binding: TavernSessionBinding) => boolean): Promise<void>
}

export function createLazyProjection<V>(options: LazyProjectionOptions<V>): LazyProjection<V> {
  const cache = new Map<string, V>()
  const started = new Set<string>()
  const tickets = new Map<string, number>()
  let preheatDone = false

  async function load(agentId: string): Promise<void> {
    const ticket = (tickets.get(agentId) ?? 0) + 1
    tickets.set(agentId, ticket)
    const settle = (value: V): void => {
      if (tickets.get(agentId) === ticket) cache.set(agentId, value)
    }
    try {
      await options.load(agentId, settle)
    } catch {
      // A missing store must not prevent the host agent from starting：装载失败
      // 静默，缓存留旧值；写穿/预热路径会再试。
    }
  }

  async function refreshWhere(match: (binding: TavernSessionBinding) => boolean): Promise<void> {
    try {
      const state = await options.getState()
      for (const [agentId, binding] of Object.entries(state.sessionBindings)) {
        if (!match(binding)) continue
        started.add(agentId)
        await load(agentId)
      }
    } catch {
      // best-effort 写穿：失败只意味着下一次装配沿用旧缓存。
    }
  }

  return {
    valueOf(agentId) {
      if (typeof agentId !== 'string' || agentId.trim() === '') return undefined
      if (!started.has(agentId)) {
        started.add(agentId)
        void load(agentId)
      }
      return cache.get(agentId)
    },
    refreshWhere,
    preheatWhere(match) {
      if (preheatDone) return Promise.resolve()
      preheatDone = true
      return refreshWhere(match)
    },
  }
}
