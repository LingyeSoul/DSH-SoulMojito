/**
 * Mod 跨 bundle 注册表（提案 0015 §3.6，P2）：Mod 工具与 prompt section 的
 * 互见通道。
 *
 * 为什么必须锚 globalThis：六个 Node bundle 是 esbuild `packages:'bundle'` 的
 * 死产物，模块级状态跨 bundle 不互见（cross-bundle-events.ts / 宏 host-registry
 * 同学科）。Mod 宿主只活在 index bundle（apply 内装载），而工具/section 要在
 * agent bundle（agent.mjs，AgentTavern preset）与 novel bundle（novel.mjs）的
 * apply 里生效——注册动作（index bundle 写）与消费动作（agent bundle 读）必须
 * 经 `globalThis[Symbol.for('dsh-tavern:mod-registry')]` 互见。key 字符串是
 * bundle 间互见契约，不得变更。
 *
 * 变更通知走 `dsh-tavern:mods-changed-listeners`（createGlobalListenerRegistry，
 * 写穿语义与 guides/preset 总线一致）：写侧（mod 宿主）emit 后读侧（已 mount
 * 的 agent ctx）可以增量补注册——新会话必然可见（recompose 时吸收快照），
 * 既有会话经此通知尽力补齐（提案 §3.6 的既定承诺边界）。
 */

import { createGlobalListenerRegistry } from '../cross-bundle-events.js'

/** Mod 工具定义：形状对齐 agent.ts 的 tool() 工厂产物（§3.3）。 */
export interface ModToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (_args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: { agent?: { id?: string }; signal?: AbortSignal }) => Promise<unknown>
}

/** agent bundle 吸收用的快照项（含 mod 归因与排序键）。 */
export interface ModToolEntry {
  modId: string
  order: number
  sequence: number
  definition: ModToolDefinition
}

/** Mod prompt section（提案 §3.4：AgentTavern 侧 prompt 分区注册面）。 */
export interface ModSectionDefinition {
  name: string
  text: string
  order?: number
}

export interface ModSectionEntry {
  modId: string
  order: number
  sequence: number
  /** order 已由宿主钳制进 Mod 专属区间的最终定义。 */
  definition: Required<ModSectionDefinition>
}

/**
 * Mod section 的 order 钳制区间（提案 §3.4）：核心分区占用 -80..-64
 * （kernel -80 / preset -75 / facts -70 / guides -65 / script -64），Mod 只允许
 * -50..0——既不冲掉核心头（前缀缓存生命线），又给核心留出未来 -63..-51 的
 * 扩展带。常量必须打进 agent bundle（gate 静态断言）。
 */
export const MOD_SECTION_ORDER_MIN = -50
export const MOD_SECTION_ORDER_MAX = 0

/** order 钳制：非法/缺省取区间下界（紧随核心之后），越界收边。 */
export function clampModSectionOrder(order: unknown): number {
  const value = typeof order === 'number' && Number.isFinite(order) ? order : MOD_SECTION_ORDER_MIN
  return Math.max(MOD_SECTION_ORDER_MIN, Math.min(MOD_SECTION_ORDER_MAX, value))
}

/** Mod 工具名白名单：modId 前缀后允许的字符（与内置工具命名律同风格）。 */
export const MOD_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 内置工具保留名（查重面，提案 §3.3「与 60 个内置工具查重冲突即拒」）。
 * 三组 preset 的 createTools() 在各自 bundle apply 时经 claimHostToolNames 运行
 * 时认领；这里再静态种子一份（index bundle 独立进程内 mod 装载可能早于 agent
 * bundle mount——两层并集，静态份的漂移由 vitest 对账测试锁定）。
 */
const BUILTIN_TOOL_NAMES_SEED = new Set<string>([
  // agent-tavern（agent.ts createTools，18）
  'tavern_character_get', 'tavern_lore_search', 'tavern_scene_get', 'tavern_history_search',
  'memory_search', 'memory_read', 'memory_write', 'memory_update', 'memory_forget',
  'variable_get', 'variable_set', 'variable_patch', 'variable_delete', 'variable_list',
  'tavern_script_read', 'tavern_script_advance', 'tavern_deduce', 'tavern_variable_settle',
  // agent-novel（agent-novel/agent.ts createTools，22；memory_*/tavern_deduce 交集去重）
  'novel_status_read', 'novel_requirements_read', 'novel_outline_read', 'novel_outline_create',
  'novel_outline_revise', 'novel_requirement_block', 'novel_facts_read', 'novel_lore_search',
  'novel_character_read', 'novel_body_read', 'novel_body_search', 'novel_body_commit',
  'novel_chapter_complete', 'novel_unit_claim', 'novel_unit_release', 'novel_unit_supersede',
  'novel_writer_draft', 'novel_writer_delegate', 'novel_finish',
  // card-workbench（card-workbench/tools-*.ts，22）
  'card_get', 'card_put', 'card_create', 'card_delete', 'card_original_get', 'card_restore_original',
  'card_plan_propose', 'card_apply_mvu', 'chat_log_read',
  'world_get', 'world_put', 'world_create', 'world_delete', 'world_copy', 'world_rename',
  'world_bind', 'world_list', 'world_plan_propose',
  'preset_get', 'preset_put', 'material_list', 'material_read',
])

interface ModRegistryStore {
  tools: Map<string, ModToolEntry>
  sections: Map<string, ModSectionEntry>
  builtinNames: Set<string>
  nextSequence: number
}

const MOD_REGISTRY_KEY = 'dsh-tavern:mod-registry'
const registrySymbol = Symbol.for(MOD_REGISTRY_KEY)

function store(): ModRegistryStore {
  const holder = globalThis as Record<symbol, ModRegistryStore | undefined>
  return (holder[registrySymbol] ??= {
    tools: new Map(),
    sections: new Map(),
    builtinNames: new Set(BUILTIN_TOOL_NAMES_SEED),
    nextSequence: 1,
  })
}

const modsChangedListeners = createGlobalListenerRegistry<() => void>('dsh-tavern:mods-changed-listeners')

function notifyChanged(): void {
  // 写穿通知：读侧自行重读快照做差分。fire-and-forget（吞错在 registry 内）。
  void modsChangedListeners.emit()
}

/** 注册表 key：`${modId}\u0000${name}`——mod 域内查重 + 跨 mod 全局查重共用。 */
function toolKey(modId: string, name: string): string {
  return `${modId}\u0000${name}`
}

/**
 * 写侧：注册一个 Mod 工具（mod 宿主调用）。返回反注册函数。
 * 形状/前缀/查重校验在调用方（mods/host.ts 适配层）完成，这里只管互见与排序。
 */
export function registerModTool(modId: string, definition: ModToolDefinition, order: number): () => void {
  const shared = store()
  const sequence = shared.nextSequence++
  const key = toolKey(modId, definition.name)
  shared.tools.set(key, { modId, order, sequence, definition })
  notifyChanged()
  return () => {
    if (shared.tools.get(key)?.sequence === sequence) shared.tools.delete(key)
    notifyChanged()
  }
}

/** 写侧：注册一个 Mod prompt section（order 已钳制）。返回反注册函数。 */
export function registerModSection(modId: string, definition: Required<ModSectionDefinition>, order: number): () => void {
  const shared = store()
  const sequence = shared.nextSequence++
  const key = `${modId}\u0000${definition.name}`
  shared.sections.set(key, { modId, order, sequence, definition })
  notifyChanged()
  return () => {
    if (shared.sections.get(key)?.sequence === sequence) shared.sections.delete(key)
    notifyChanged()
  }
}

/** 读侧快照：全部 Mod 工具（order 升序，平局按注册先后；同 order 的 mod 间按
 *  modId 稳定排序由快照消费方排序兜底）。 */
export function modToolSnapshot(): ModToolEntry[] {
  return [...store().tools.values()]
    .sort((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map(({ modId, order, sequence, definition }) => ({ modId, order, sequence, definition }))
}

/** 读侧快照：全部 Mod section（order 升序，平局按注册先后）。 */
export function modSectionSnapshot(): ModSectionEntry[] {
  return [...store().sections.values()]
    .sort((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map(({ modId, order, sequence, definition }) => ({ modId, order, sequence, definition }))
}

/** 全局工具名占用表（mod 工具 + 内置认领）。注册查重用。 */
export function claimedToolNames(): Set<string> {
  const names = new Set(store().builtinNames)
  for (const entry of store().tools.values()) names.add(entry.definition.name)
  return names
}

/** 读侧：agent/novel bundle apply 时认领自己的内置工具名（运行时防漂移）。 */
export function claimHostToolNames(names: readonly string[]): void {
  for (const name of names) store().builtinNames.add(name)
}

/** 读侧订阅：注册表变更通知（agent bundle 增量补注册用）。返回反订阅。 */
export function onModsChanged(listener: () => void): () => void {
  return modsChangedListeners.on(listener)
}

/** 测试隔离用：清空跨 bundle 注册表（globalThis 状态在测试文件间共享）。 */
export function clearModRegistryForTest(): void {
  const shared = store()
  shared.tools.clear()
  shared.sections.clear()
  shared.builtinNames = new Set(BUILTIN_TOOL_NAMES_SEED)
  shared.nextSequence = 1
}
