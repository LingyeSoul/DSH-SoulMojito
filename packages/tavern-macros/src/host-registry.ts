/**
 * 宿主全局宏注册表（提案 0015 P0：接线，恒空启用）。
 *
 * 宏引擎实例是短生命周期的——plugin 侧四个实例化点（runGeneration、
 * runTavernScript、tavernMacroExpand、prompt-safety 的 createHostPromptExpander）
 * 每次求值上下文变化都新建实例，第三方宏要跨实例存活就必须挂在引擎外的
 * 进程级注册表上。
 *
 * 注册表锚定 globalThis（Symbol.for，同学科于 plugin 的 cross-bundle-events.ts）：
 * 本包被 esbuild 打进多个 Node bundle（index.mjs / agent.mjs / compaction.mjs /
 * novel.mjs / card-workbench.mjs，packages:'bundle' 零 external），模块级状态在
 * 分离 bundle 间互不可见，mod 宿主（index bundle）注册的宏必须对 agent bundle
 * 内新建的引擎也可见。key 字符串是 bundle 间的互见契约，不得变更。
 *
 * P0 状态：注册表恒空，createMacroEngine 吸收空快照 = 零行为变化。P1 的
 * api.macros.register 落在 mod 宿主（index bundle），经本注册表对全部实例生效。
 */

import type { MacroFunction } from './types.js'

/** 注册表项：name/fn 对齐引擎 registerMacro 契约，order 供 P1 loadingOrder 决胜。 */
export interface HostMacroEntry {
  name: string
  fn: MacroFunction
  order: number
}

interface HostMacroRecord extends HostMacroEntry {
  /** 分配序号：order 相同时按注册先后稳定排序；也是反注册句柄的凭据。 */
  sequence: number
}

interface HostMacroStore {
  nextSequence: number
  entries: Map<number, HostMacroRecord>
}

const HOST_MACRO_REGISTRY_KEY = 'dsh-tavern:host-macros'
const registrySymbol = Symbol.for(HOST_MACRO_REGISTRY_KEY)

function store(): HostMacroStore {
  const holder = globalThis as Record<symbol, HostMacroStore | undefined>
  return (holder[registrySymbol] ??= { nextSequence: 1, entries: new Map() })
}

/**
 * 注册一个宿主全局宏，返回反注册函数。名字校验发生在引擎吸收时
 * （registerMacro 契约：空名/带大括号抛 TypeError），此处不重复——注册面
 * 与求值面分离，坏注册在引擎侧按逐项跳过降级，不炸任何实例。
 */
export function registerHostMacro(name: string, fn: MacroFunction, order = 100): () => void {
  const shared = store()
  const sequence = shared.nextSequence++
  shared.entries.set(sequence, { name, fn, order, sequence })
  return () => {
    shared.entries.delete(sequence)
  }
}

/**
 * 注册表快照（order 升序，order 相同按注册先后）。引擎实例化时吸收快照而非
 * 活引用：实例持有创建时刻的稳定视图，生成中途的新注册不影响本轮求值。
 */
export function hostMacroSnapshot(): HostMacroEntry[] {
  return [...store().entries.values()]
    .sort((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map(({ name, fn, order }) => ({ name, fn, order }))
}
