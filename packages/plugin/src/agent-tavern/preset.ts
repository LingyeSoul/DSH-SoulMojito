/**
 * ST 聊天补全预设 → AgentTavern 会话投影。
 *
 * 背景：AgentTavern 复用宿主 AgentLoop，预设的内容装配只服务 ST 架构（tavern-pipeline
 * 由 ST 生成路径独占，见提案 0004 §11），激活预设因此在 AgentTavern 会话里完全
 * 不生效。本模块把预设的内容侧语义投影进 AgentTavern：
 *
 * - 内容型提示词（非 marker）：按 prompt_order 顺序、启用语义过滤后合成一个
 *   systemPrompt section（order -75，kernel 之后）；main / jailbreak 沿用角色卡
 *   system_prompt / post_history_instructions 覆盖（空串回落、支持 {{original}}）。
 * - 选集：优先 ST global dummy 集 100001（`openai.js`: strategy 'global',
 *   dummyId 100001；社区预设的单聊全量栈带在这一组），其次旧 dummy 100000，再回落
 *   首组——与 tavern-pipeline 同一语义。
 * - 启用语义：`prompt_order[].enabled` 为权威（`PromptManager.getPromptCollection`:
 *   allowedTrigger = entry.enabled）；仅当该组未给布尔值时回落 `prompt.enabled`。
 *   `system_prompt` 只是「全局/预设提示词」的分类标记，不参与启用判定——社区
 *   预设常把写作风格、思考链与格式约束条目标成 system_prompt:false 且启用，若当
 *   禁用会整组丢失。
 * - 采样：只投影 temperature。max_context / max_tokens 归宿主：请求容量由实际
 *   provider/model route 与 DSH pressure policy 决定（提案 0004 §8），而在工具
 *   循环里按 ST 响应长度硬切输出上限会截断 tool-call。
 * - marker（角色卡字段 / 世界书 / 示例对话 / 历史）不进固定 prompt：AgentTavern
 *   由工具、原生历史与可选预载承接（提案 0004 §5）。
 *
 * 文本进宿主前必须过 prompt-safety.ts 的宏展开 + {{...}} 中性化：预设内容是
 * ST 宏（{{char}}/{{user}}、{{setvar}}/{{getvar}} 族）的高频来源，原文进 section
 * 会让宿主 interpolate 抛错；setvar/getvar 在同一块内按顺序结算（先定义后消费，
 * 与 ST 逐条 substituted 的顺序一致）。
 *
 * 变更失效走 globalThis 锚定的监听表（Symbol.for）：emit 发生在 index.mjs /
 * card-workbench.mjs，监听在 agent.mjs——分离 bundle 各持一份模块级 Set 会互不
 * 可见（同学科于 agent-novel/usage.ts 的跨 bundle 锚定）。本模块同时导出内置
 * 默认预设（index.ts 的 ST 生成路径与 AgentTavern 装载共用同一份）。
 */

import type { CharacterCardIR, PresetIR, PresetPrompt, PromptOrderSet } from '../../../tavern-format/src/index.js'

export const AGENT_PRESET_BLOCK_HEADER = 'Chat completion preset (user-configured prompt stack; follow these instructions together with the kernel):'

/** ST global prompt order 的 dummy id（openai.js: strategy 'global', dummyId 100001）。 */
const GLOBAL_ORDER_DUMMY_ID = 100001
/** 旧常量/群聊残留 dummy：仅作 100001 缺失时的回落。 */
const LEGACY_ORDER_DUMMY_ID = 100000

export interface EffectivePresetPrompt {
  identifier: string
  name: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 预设内容侧的有效提示词：按 prompt_order（优先 global dummy 100001，回落
 * 100000/首组）遍历，跳过 marker、未启用与（覆盖后）空内容的条目。无
 * prompt_order 时返回空数组——与 ST 装配一致：不在顺序表里的提示词不参与。
 */
export function effectiveAgentPresetPrompts(preset: PresetIR, card?: CharacterCardIR): EffectivePresetPrompt[] {
  const order = resolvePromptOrder(preset)
  const byId = new Map(preset.prompts.map((prompt) => [prompt.identifier, prompt]))
  const effective: EffectivePresetPrompt[] = []
  for (const slot of order) {
    const prompt = byId.get(slot.identifier)
    if (prompt === undefined || prompt.marker === true) continue
    if (!entryEnabled(slot, prompt)) continue
    const content = applyCardOverride(prompt.identifier, promptContent(prompt), card)
    const trimmed = content.trim()
    if (trimmed === '') continue
    effective.push({
      identifier: prompt.identifier,
      name: typeof prompt.name === 'string' ? prompt.name : prompt.identifier,
      role: promptRole(prompt),
      content: trimmed,
    })
  }
  return effective
}

/** 渲染注入块：首行固定标注 + 各提示词内容按 prompt_order 顺序分段。无有效条目返回 undefined。
 *  header 可覆写：写卡工作台/AgentNovel 的预设投影（preset-mount.ts）复用同一
 *  渲染体但换语义框架（引用式 vs 跟随式），AgentTavern 默认沿用本文件头标注。 */
export function renderAgentPresetBlock(preset: PresetIR, card?: CharacterCardIR, header: string = AGENT_PRESET_BLOCK_HEADER): string | undefined {
  const prompts = effectiveAgentPresetPrompts(preset, card)
  if (prompts.length === 0) return undefined
  return [header, ...prompts.map((prompt) => prompt.content)].join('\n\n')
}

/** 预设 temperature（唯一投影的采样参数，理由见文件头）。缺失/非法返回 undefined（透传宿主配置）。 */
export function presetTemperature(preset: PresetIR): number | undefined {
  const value = preset.sampler['temperature']
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 内置默认预设：未选择激活预设时的回落（与 ST 生成路径共用）。
 * 面板把空选择显示为「内置角色扮演预设」——AgentTavern 与 ST 走同一份语义。
 */
export function defaultPreset(): Record<string, unknown> {
  const prompts = [
    { name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional roleplay chat between {{char}} and {{user}}. Stay in character and never write dialogue or actions for {{user}}.", identifier: 'main' },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona', system_prompt: true, marker: true },
    { identifier: 'charDescription', name: 'Character Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Character Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'dialogueExamples', name: 'Dialogue Examples', system_prompt: true, marker: true },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' },
  ]
  return {
    temperature: 1, openai_max_context: 32768, openai_max_tokens: 800,
    wi_format: '{0}', scenario_format: '{{scenario}}', personality_format: '{{personality}}',
    prompts,
    prompt_order: [{ character_id: GLOBAL_ORDER_DUMMY_ID, order: prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })) }],
  }
}

/* -------------------- 预设变更失效（跨 bundle 写穿） -------------------- */

export type AgentPresetChangedListener = () => void | Promise<void>

const AGENT_PRESET_CHANGED_LISTENERS = Symbol.for('dsh-tavern:agent-preset-changed-listeners')

function agentPresetChangedListeners(): Set<AgentPresetChangedListener> {
  const holder = globalThis as Record<symbol, Set<AgentPresetChangedListener> | undefined>
  return (holder[AGENT_PRESET_CHANGED_LISTENERS] ??= new Set())
}

/**
 * 注册预设变更回调（agent.ts 模块加载时调用：预设内容/激活选择/人设变化后
 * 重新装载各 AgentTavern 会话的投影缓存）。返回反注册函数。
 */
export function onAgentPresetChanged(listener: AgentPresetChangedListener): () => void {
  const listeners = agentPresetChangedListeners()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 预设写路径（settings/state、preset 增删改、写卡工作台 preset_put、会话激活
 * 预热）成功后触发缓存刷新。best-effort：落库已成功，任何回调失败都不允许反过来
 * 把成功的写变成错误响应，所以逐个静默吞掉。
 */
export async function emitAgentPresetChanged(): Promise<void> {
  for (const listener of [...agentPresetChangedListeners()]) {
    try {
      await listener()
    } catch {
      // 写穿失败只意味着下一次装载沿用旧缓存；装载路径自身会再读一次。
    }
  }
}

/* ------------------------------ 内部 ------------------------------ */

function resolvePromptOrder(preset: PresetIR): Array<{ identifier: string; enabled?: unknown }> {
  const set: PromptOrderSet | undefined =
    preset.promptOrder.find((order) => Number(order.character_id) === GLOBAL_ORDER_DUMMY_ID)
    ?? preset.promptOrder.find((order) => Number(order.character_id) === LEGACY_ORDER_DUMMY_ID)
    ?? preset.promptOrder[0]
  return Array.isArray(set?.order) ? set.order : []
}

/** 启用语义（文件头）：顺序表 slot.enabled 为权威，仅缺布尔值时回落 prompt.enabled。 */
function entryEnabled(slot: { enabled?: unknown }, prompt: PresetPrompt): boolean {
  if (typeof slot.enabled === 'boolean') return slot.enabled
  const record = prompt as unknown as Record<string, unknown>
  return record['enabled'] !== false
}

function promptContent(prompt: PresetPrompt): string {
  const content = (prompt as unknown as Record<string, unknown>)['content']
  return typeof content === 'string' ? content : ''
}

function promptRole(prompt: PresetPrompt): EffectivePresetPrompt['role'] {
  const role = (prompt as unknown as Record<string, unknown>)['role']
  return role === 'user' || role === 'assistant' ? role : 'system'
}

/** 卡覆盖语义（与 tavern-pipeline 一致）：main ← 卡 system_prompt、jailbreak ← 卡 post_history_instructions；空串回落，{{original}} 引用预设原文。 */
function applyCardOverride(identifier: string, content: string, card?: CharacterCardIR): string {
  const override = identifier === 'main'
    ? card?.data.systemPrompt.trim()
    : identifier === 'jailbreak'
      ? card?.data.postHistoryInstructions.trim()
      : ''
  if (override === undefined || override === '') return content
  return override.replace(/\{\{original\}\}/gi, content)
}
