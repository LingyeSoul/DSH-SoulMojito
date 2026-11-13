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
 * - 选集与启用语义：与 ST 生成路径（tavern-pipeline）共享同一实现——
 *   resolvePromptOrder / entryEnabled 自 tavern-pipeline 导入（决策
 *   2026-10-09-dedup-refactor）。选集优先 ST global dummy 集 100001（`openai.js`:
 *   strategy 'global', dummyId 100001；社区预设的单聊全量栈带在这一组），其次旧
 *   dummy 100000，再回落首组；启用时 `prompt_order[].enabled` 布尔为权威
 *   （`PromptManager.getPromptCollection`: allowedTrigger = entry.enabled），仅当
 *   该组未给布尔值时回落 `prompt.enabled`。
 *   `system_prompt` 只是「全局/预设提示词」的分类标记，不参与启用判定——社区
 *   预设常把写作风格、思考链与格式约束条目标成 system_prompt:false 且启用，若当
 *   禁用会整组丢失。
 * - 采样：只投影 temperature。max_context / max_tokens 归宿主：请求容量由实际
 *   provider/model route 与 DSH pressure policy 决定（提案 0004 §8），而在工具
 *   循环里按 ST 响应长度硬切输出上限会截断 tool-call。
 * - marker（角色卡字段 / 世界书 / 示例对话 / 历史）不进固定 prompt：AgentTavern
 *   由工具、原生历史与可选预载承接（提案 0004 §5）。
 * - 角色条目按 `prompt.role` 分流，system 块只留 system 条目：user/assistant
 *   条目是 ST 的对话帧发言，放进 system 头会把发言说成系统规则。它们在会话激活
 *   （loop 未启动）时由 `agentPresetPreambleEntries` 预装载成真实消息帧；user
 *   条目另有 `agent/pre-step` 兜底通道（压缩后重注入 / 存量已启动会话），见
 *   agent-tavern/preset-user-block.ts 与决策
 *   2026-11-13-preset-user-role-injection。
 * - 分类与不投影清单（契约 2026-11-12 §2.9/§2.10）：导入不再拒绝 instruct /
 *   context / sysprompt / reasoning 预设后，激活到这些类型不会静默留空——
 *   `projectAgentPreset` 返回带原因的 refusals，agent.ts 按 agent/分类去重告警一次；
 *   只有 chat-completion 有内容投影（见下方分类注释）。
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

import { detectPresetKind, parsePreset, type CharacterCardIR, type PresetIR, type PresetPrompt } from '../../../tavern-format/src/index.js'
import { entryEnabled, GLOBAL_ORDER_DUMMY_ID, resolvePromptOrder } from '../../../tavern-pipeline/src/index.js'

export const AGENT_PRESET_BLOCK_HEADER = 'Chat completion preset (user-configured prompt stack; follow these instructions together with the kernel):'

/** user 型条目的块首行：这些条目是预设里标记为 user 角色的对话帧发言，不是
 *  用户此刻的新消息，也不该被当成系统规则。 */
export const AGENT_PRESET_USER_HEADER = 'Chat completion preset entries with the user role (instructions for the conversation frame from the preset, not a new chat message from the user):'

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
 *  渲染体但换语义框架（引用式 vs 跟随式），AgentTavern 默认沿用本文件头标注。
 *  只收 system 角色条目：user/assistant 条目是对话帧的发言，激活期由
 *  `agentPresetPreambleEntries` 预装载成真实消息（决策
 *  2026-11-13-preset-user-role-injection）。 */
export function renderAgentPresetBlock(preset: PresetIR, card?: CharacterCardIR, header: string = AGENT_PRESET_BLOCK_HEADER): string | undefined {
  const prompts = effectiveAgentPresetPrompts(preset, card).filter((prompt) => prompt.role === 'system')
  if (prompts.length === 0) return undefined
  return [header, ...prompts.map((prompt) => prompt.content)].join('\n\n')
}

/** 渲染 user 角色条目块：只取 `role === 'user'` 的条目，按 prompt_order 顺序
 *  用空行分段。无条目返回 undefined——调用方据此完全不注入，不制造空消息。
 *  这是 pre-step 兜底通道（压缩后重注入 / 存量已启动会话）的渲染体。 */
export function renderAgentPresetUserBlock(preset: PresetIR, card?: CharacterCardIR): string | undefined {
  const contents = effectiveAgentPresetPrompts(preset, card)
    .filter((prompt) => prompt.role === 'user')
    .map((prompt) => prompt.content)
  if (contents.length === 0) return undefined
  return [AGENT_PRESET_USER_HEADER, ...contents].join('\n\n')
}

/** 一条非 system 预设条目：激活期预装载成真实消息帧的原料。content 是原始文本
 *  （不加任何 header），贴近 ST 逐条发言的帧语义。 */
export interface AgentPresetPreambleEntry {
  role: 'user' | 'assistant'
  content: string
}

/** 按 prompt_order 顺序返回全部非 system 条目（user 与 assistant）。空数组 =
 *  本预设没有需要帧化的条目：调用方据此完全不写 preamble。 */
export function agentPresetPreambleEntries(preset: PresetIR, card?: CharacterCardIR): AgentPresetPreambleEntry[] {
  const entries: AgentPresetPreambleEntry[] = []
  for (const prompt of effectiveAgentPresetPrompts(preset, card)) {
    if (prompt.role === 'system') continue
    entries.push({ role: prompt.role, content: prompt.content })
  }
  return entries
}

/** 预设 temperature（唯一投影的采样参数，理由见文件头）。缺失/非法返回 undefined（透传宿主配置）。 */
export function presetTemperature(preset: PresetIR): number | undefined {
  const value = preset.sampler['temperature']
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/* ------------------ 预设分类与投影判定（契约 2026-11-12 §2.9/§2.10） ------------------ */

/**
 * 预设导入不再拒绝之后（§2.9），激活预设可能是 context / instruct / sysprompt /
 * reasoning / textgen-sampler 形态。AgentTavern 只消费能安全实现的 chat-completion
 * 投影，其余类型**明确报「不投影」**（refusals），不静默、不伪造：
 * - context（story_string）：ST 的 story string 装配归 tavern-pipeline；宿主
 *   AgentLoop 拥有消息装配，把 handlebars 模板当提示词注入等于凭空造指令。
 * - instruct（input/output 包装序列）：包装的是 ST 的消息帧，宿主消息帧不可改。
 * - reasoning / sysprompt：§2.9 明确「生成不消费」——导入合法、不参与生成；
 *   Agent 侧不伪造第二条消费路径。
 * - textgen-sampler：只有采样键、没有提示词内容（采样参数也不在本模块范围）。
 * - 未识别形态：格式层没认出，不能猜它的语义。
 */
export type AgentPresetProjectionKind =
  | 'chat-completion' | 'context' | 'instruct' | 'textgen-sampler' | 'sysprompt' | 'reasoning' | 'unknown'

export interface AgentPresetProjectionRefusal {
  /** 预设分类（`detectPresetKind` 的结果）。 */
  kind: AgentPresetProjectionKind
  /** 「为什么不投影」的说明（英文，只进诊断日志与测试断言）。 */
  reason: string
}

/** 一次激活预设投影的结果：可投影的部分 + 明确的不投影清单。 */
export interface AgentPresetProjection {
  /** 注入 system 头（order -75）的文本；undefined = 本预设没有 system 条目的
   *  可投影提示词。 */
  text?: string
  /** user 角色条目的注入文本（pre-step 兜底通道）；undefined = 预设没有 user
   *  角色条目。 */
  userText?: string
  /** 非 system 条目的帧化原料（激活期预装载成真实 user/assistant 消息，按
   *  prompt_order 顺序）；空数组 = 无需预装载。 */
  preamble: AgentPresetPreambleEntry[]
  /** 唯一投影的采样参数（见 presetTemperature）。 */
  temperature?: number
  /** 不投影的内容；空数组 = 全部可投影。 */
  refusals: AgentPresetProjectionRefusal[]
}

/** 不投影原因：按分类给固定结论（字符串判别宽于 `PresetKind` 联合——格式包新增
 *  sysprompt/reasoning 分类时本模块不必升级类型也能给出明确结论）。 */
function presetRefusalReason(kind: string): string {
  switch (kind) {
    case 'context':
      return 'context template: its story_string assembles the ST story string, but the host AgentLoop owns message assembly here; nothing is projected'
    case 'instruct':
      return 'instruct template: it wraps ST message framing, but the host AgentLoop owns message framing here; nothing is projected'
    case 'reasoning':
      return 'reasoning preset: import-only; generation does not consume reasoning presets (contract §2.9), so nothing is projected'
    case 'sysprompt':
      return 'system-prompt preset: import-only; generation does not consume system-prompt presets (contract §2.9), so nothing is projected'
    case 'textgen-sampler':
      return 'textgen sampler preset: sampling knobs only, no prompt content; sampling projection is outside this module, so nothing is projected'
    default:
      return 'preset format not recognized by the format layer; nothing is projected'
  }
}

/**
 * 激活预设 → AgentTavern 投影：chat-completion 走既有提示词栈 + temperature；
 * 其余类型返回带原因的 refusals（见上方分类说明）。解析损坏的 chat-completion
 * 预设同样拒绝并给出原因，而不是让懒装载把异常吞成「安静的空白」。
 */
export function projectAgentPreset(preset: Record<string, unknown>, card?: CharacterCardIR): AgentPresetProjection {
  const kind = detectPresetKind(preset) as string
  if (kind !== 'chat-completion') {
    return { preamble: [], refusals: [{ kind: kind as AgentPresetProjectionKind, reason: presetRefusalReason(kind) }] }
  }
  try {
    const ir = parsePreset(preset)
    const text = renderAgentPresetBlock(ir, card)
    const userText = renderAgentPresetUserBlock(ir, card)
    const preamble = agentPresetPreambleEntries(ir, card)
    const temperature = presetTemperature(ir)
    return {
      ...(text === undefined ? {} : { text }),
      ...(userText === undefined ? {} : { userText }),
      preamble,
      ...(temperature === undefined ? {} : { temperature }),
      refusals: [],
    }
  } catch (error) {
    return {
      preamble: [],
      refusals: [{
        kind: 'chat-completion',
        reason: `chat completion preset could not be parsed (${error instanceof Error ? error.message : String(error)}); nothing is projected`,
      }],
    }
  }
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

import { createGlobalListenerRegistry } from '../cross-bundle-events.js'

export type AgentPresetChangedListener = () => void | Promise<void>

// globalThis 锚定（同学科于 agent-novel/usage.ts）：emit 发生在 index.mjs /
// card-workbench.mjs，监听在 agent.mjs——分离 bundle 各持一份模块级 Set 会互不
// 可见，写穿必须共享同一注册表。key 逐字保留存量值。
const agentPresetChanged = createGlobalListenerRegistry<AgentPresetChangedListener>('dsh-soulmojito:agent-preset-changed-listeners')

/**
 * 注册预设变更回调（agent.ts 模块加载时调用：预设内容/激活选择/人设变化后
 * 重新装载各 AgentTavern 会话的投影缓存）。返回反注册函数。
 */
export function onAgentPresetChanged(listener: AgentPresetChangedListener): () => void {
  return agentPresetChanged.on(listener)
}

/**
 * 预设写路径（settings/state、preset 增删改、写卡工作台 preset_put、会话激活
 * 预热）成功后触发缓存刷新。best-effort：落库已成功，任何回调失败都不允许反过来
 * 把成功的写变成错误响应，所以逐个静默吞掉。
 */
export function emitAgentPresetChanged(): Promise<void> {
  return agentPresetChanged.emit()
}

/* ------------------------------ 内部 ------------------------------ */

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
