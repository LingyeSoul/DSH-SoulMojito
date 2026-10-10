/**
 * Mod 扩展的 agent bundle 吸收器（提案 0015 §3.6，P2）。
 *
 * §3.6 宿主语义定案（决策 2026-10-10-mod-p2-capabilities，实验数据见该文档）：
 * preset 插件经 `ctx.agentPresets.recompose(agent.ctx, id)` 挂载，agent.ts 的
 * apply 拿到的是 **agent 会话域的 ctx**（模块注释「apply 可能被宿主重复调用」
 * 即每会话/每次 recompose 重新挂载），`ctx.tools.register` 是挂载域注册而非
 * host 全局注册。因此 mod 工具/section 必须经 agent bundle 自己的 ctx 落地：
 * - 若宿主实为全局注册表：经 agent ctx 注册与经任何 ctx 注册等价（同一服务）；
 * - 若宿主为挂载域：经 agent ctx 注册恰好落在正确的域。
 * 两条宿主语义下本路线都正确（并集安全）；反向路线（index bundle 的插件级
 * ctx 注册）在挂载域语义下会落空，被否决。
 *
 * 生命周期：apply（每次挂载）吸收当前注册表快照 + 订阅增量（mods-changed 写
 * 穿通知）；新会话必然可见（recompose 重新挂载重新吸收），既有会话经通知尽力
 * 补齐——与提案 §3.6「不承诺免 recompose 生效」的边界一致。卸载（effect
 * 清理）反注册本挂载的全部注册。
 */

import {
  clampModSectionOrder,
  modSectionSnapshot,
  modToolSnapshot,
  onModsChanged,
  claimHostToolNames,
  type ModToolDefinition,
  type ModToolEntry,
} from './cross-bundle.js'
import { hostPromptSafe } from '../prompt-safety.js'

interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (_args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

export interface ModAgentMountContext {
  tools?: { register?: (tool: ToolDefinitionLike) => unknown }
  systemPrompt?: {
    section?: (section: { name: string; order: number; text: string }) => unknown
  }
  effect?: (factory: () => unknown, label?: string) => unknown
}

/** 静态指纹：description/parameters/schema 变化才需要重注册；execute/render
 *  经包装在调用时活查注册表（mod reload 换行为不必重注册）。 */
function toolFingerprint(entry: Pick<ModToolEntry, 'modId' | 'definition'>): string {
  const { definition } = entry
  return JSON.stringify([entry.modId, definition.name, definition.description, definition.parameters, definition.output?.schema])
}

/**
 * 挂载 mod 扩展面（agent/novel bundle 的 apply 调用）。
 * - claimTools：本 bundle 的内置工具名（运行时认领进查重保留集，防静态种子漂移）。
 * - 返回清理函数（无 ctx.effect 的宿主/测试自行调用；有 effect 时自动挂接）。
 */
export function mountModExtensions(ctx: ModAgentMountContext, options: { claimTools: readonly string[] }): () => void {
  claimHostToolNames(options.claimTools)

  const registeredTools = new Map<string, { dispose: (() => void) | undefined; fingerprintNext: string }>()
  const registeredSections = new Map<string, { dispose: (() => void) | undefined; textNext: string; orderNext: number }>()

  const liveTool = (modId: string, name: string): ModToolDefinition | undefined =>
    modToolSnapshot().find((entry) => entry.modId === modId && entry.definition.name === name)?.definition

  const asDispose = (handle: unknown): (() => void) | undefined =>
    typeof handle === 'function' ? () => { try { (handle as () => void)() } catch { /* 宿主反注册失败不炸挂载 */ } } : undefined

  function syncTools(): void {
    const wanted = new Map<string, { modId: string; definition: ModToolDefinition; fingerprint: string }>()
    for (const entry of modToolSnapshot()) {
      // 快照可能含同名旧项被新项覆盖前的残余？注册表按 key 去重，直接按名字收。
      wanted.set(entry.definition.name, { modId: entry.modId, definition: entry.definition, fingerprint: toolFingerprint(entry) })
    }
    for (const [name, current] of [...registeredTools]) {
      const next = wanted.get(name)
      if (next === undefined || next.fingerprint !== current.fingerprintNext) {
        current.dispose?.()
        registeredTools.delete(name)
      }
    }
    for (const [name, next] of wanted) {
      if (registeredTools.has(name)) continue
      const wrapper: ToolDefinitionLike = {
        name,
        description: next.definition.description,
        parameters: next.definition.parameters,
        output: {
          schema: next.definition.output.schema,
          render: (args, value) => {
            const live = liveTool(next.modId, name)
            if (live === undefined) return [{ type: 'text', text: JSON.stringify(value) }]
            return live.output.render(args, value)
          },
        },
        execute: (args, exec) => {
          const live = liveTool(next.modId, name)
          if (live === undefined) {
            return Promise.reject(new Error(`mod tool '${name}' is no longer available (its mod was disabled or unloaded)`))
          }
          return live.execute(args, exec as { agent?: { id?: string }; signal?: AbortSignal })
        },
      }
      try {
        const handle = ctx.tools?.register?.(wrapper)
        registeredTools.set(name, { dispose: asDispose(handle), fingerprintNext: next.fingerprint })
      } catch {
        // 宿主拒绝该注册（如本挂载已失效）：跳过，下一次通知重试。
      }
    }
  }

  function syncSections(): void {
    const wanted = new Map<string, { name: string; order: number; text: string }>()
    for (const entry of modSectionSnapshot()) {
      const fullName = `dsh-tavern:mod:${entry.modId}:${entry.definition.name}`
      // 消费侧防御性钳制（写侧 host.ts 已钳制；纵深防御确保任何写入路径都
      // 冲不掉核心 -80..-64 头），文本过 hostPromptSafe：mod 文本与内核静态
      // 文本同款纪律——残留 {{...}} 会被宿主 interpolate 当变量渲染并抛错中止
      // 装配，先中性化（prompt-safety.ts）。
      wanted.set(fullName, { name: fullName, order: clampModSectionOrder(entry.definition.order), text: hostPromptSafe(entry.definition.text) })
    }
    for (const [fullName, current] of [...registeredSections]) {
      const next = wanted.get(fullName)
      if (next === undefined || next.text !== current.textNext || next.order !== current.orderNext) {
        current.dispose?.()
        registeredSections.delete(fullName)
      }
    }
    for (const [fullName, next] of wanted) {
      if (registeredSections.has(fullName)) continue
      try {
        const handle = ctx.systemPrompt?.section?.({ name: fullName, order: next.order, text: next.text })
        registeredSections.set(fullName, { dispose: asDispose(handle), textNext: next.text, orderNext: next.order })
      } catch {
        // 同上：跳过，等待下一次通知。
      }
    }
  }

  const sync = (): void => {
    syncTools()
    syncSections()
  }
  sync()
  const offListener = onModsChanged(sync)
  const dispose = () => {
    offListener()
    for (const [, current] of [...registeredTools]) current.dispose?.()
    registeredTools.clear()
    for (const [, current] of [...registeredSections]) current.dispose?.()
    registeredSections.clear()
  }
  if (ctx.effect) {
    try {
      ctx.effect(() => () => { dispose() }, 'dsh-tavern: mod extensions')
    } catch {
      // 宿主拒绝晚注册 effect：失去自动清理，注册面继续工作。
    }
  }
  return dispose
}
