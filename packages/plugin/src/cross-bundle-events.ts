/**
 * 跨 bundle 全局监听器注册表工厂（决策 2026-10-09-dedup-refactor）。
 *
 * 写穿失效（guides 变更、预设变更）的 emit 与监听常驻不同 bundle（index.mjs /
 * card-workbench.mjs 发，agent.mjs 听）：分离 bundle 各持一份模块级 Set 互不可
 * 见，注册表必须锚定在 globalThis（Symbol.for，同学科于 agent-novel/usage.ts）。
 * guides.ts 与 agent-tavern/preset.ts 此前各自实现了同一形状（取表 / on 返回
 * 反注册 / emit 快照遍历逐个吞错），统一为本工厂。
 *
 * key 字符串必须逐字保留既有值——存量 bundle 已按该 key 注册到 globalThis，
 * 换 key 会静默丢失互见性（旧 bundle 的监听器再也收不到 emit）。
 */

export type GlobalListener = (...args: never[]) => unknown

export interface GlobalListenerRegistry<L extends GlobalListener> {
  /** 注册回调，返回反注册函数。 */
  on(listener: L): () => void
  /** 逐个触发回调。best-effort：单个回调失败只吞掉不中断，调用方自行保证重读语义。 */
  emit(...args: Parameters<L>): Promise<void>
}

export function createGlobalListenerRegistry<L extends GlobalListener>(key: string): GlobalListenerRegistry<L> {
  const symbol = Symbol.for(key)
  function listeners(): Set<L> {
    const holder = globalThis as Record<symbol, Set<L> | undefined>
    return (holder[symbol] ??= new Set())
  }
  return {
    on(listener) {
      const set = listeners()
      set.add(listener)
      return () => { set.delete(listener) }
    },
    async emit(...args) {
      // 快照遍历：触发过程中注册/反注册不改变本轮集合。
      for (const listener of [...listeners()]) {
        try {
          await listener(...args)
        } catch {
          // 写穿失败只意味着下一次装配沿用旧缓存；装载路径自身会再读一次。
        }
      }
    },
  }
}
