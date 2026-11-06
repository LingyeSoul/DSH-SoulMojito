/**
 * 标准 DSH Agent 会话的激活预设投影（2026-11-01 用户需求「在标准 DSH Agent
 * 会话中使用当前预设」）。
 *
 * 与 preset-mount.ts 的两条绑定通道（写卡工作台 / AgentNovel）互补：index
 * bundle 是 profile 级挂载，它注册的 systemPrompt section 对**所有**会话的装配
 * 可见，因此门控放在装载里——只有没有 Tavern 绑定的会话（标准 DSH Agent 会话）
 * 才投影。AgentTavern / 工作台 / 小说各有专属预设通道（agent-tavern/agent.ts、
 * preset-mount.ts），重复投影会把同一份预设栈叠两遍。
 *
 * 纪律与其它预设通道一致（决策 2026-10-09-workbench-novel-preset-projection、
 * 2026-10-09-agent-preset-cache-stability）：
 *
 * - `nativeAgentPreset` 开关门控（默认关闭，面板「行为设置」分区），翻转经既有
 *   emitAgentPresetChanged 写穿缓存；
 * - 懒装载 + 票号 last-write-wins（lazy-projection.ts）；标准会话没有绑定，
 *   refreshWhere 的绑定遍历看不到它们，写穿走 refreshAll（见下方监听）；
 * - 新会话首轮：mount.ts 的 agent/created 在宿主 loop start 前 await 单 agent
 *   预热（preheatOne），首次装配即可拿到投影；绑定变更路径写穿 refreshAll，
 *   防止会话创建后才绑定时沿用标准会话投影；
 * - 动态宏按 agent 的冻结记录（装载时刻时钟 + 种子 RNG）求值：预设块住在宿主
 *   受保护 system 头，字节一变其后全部历史的前缀缓存一并作废；
 * - 不投影 temperature：与工作台/小说同一条理由（标准会话要工具调用精度），
 *   预设调温是 RP 会话的诉求，仍由 AgentTavern 通道承载；
 * - 不做卡覆盖（标准会话没有卡）；未选择激活预设即空投影，不回落内置默认 RP
 *   预设（同工作台/小说：内置默认预设是「无预设也要有个 RP 主提示」的语义）。
 */

import { parsePreset } from '../../tavern-format/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { onAgentPresetChanged, renderAgentPresetBlock } from './agent-tavern/preset.js'
import type { HostPromptSection } from './host-contract.js'
import { createLazyProjection } from './lazy-projection.js'
import { CHAR_FALLBACK } from './preset-mount.js'
import { DEFAULT_USER } from './prompt-context.js'
import { createHostPromptExpander, hostPromptSafe, seededRandom } from './prompt-safety.js'
import { store } from './runtime.js'

export const NATIVE_PRESET_SECTION = 'dsh-soulmojito:native-preset'

/** 注入块首行：预设栈在这里是**生效中的**提示词，不是引用（对比工作台的引用式
 *  框架）；标准会话没有本插件内核，因此只与宿主自己的 Agent preset 并列。 */
const NATIVE_PRESET_HEADER = 'Active chat completion preset (user-configured prompt stack; follow these instructions together with the DSH agent preset):'

/**
 * 缓存冻结记录（与 agent-tavern/agent.ts 的 presetFreeze、preset-mount.ts 的
 * freeze 同一纪律）：装载时刻捕获时钟与 RNG 种子，写穿重载复用同一求值上下文
 * ——相同预设输入 ⇒ 相同字节。标准会话的投影内容与 agent 无关（只有绑定门控
 * 逐 agent 判定），因此一份模块级记录就够。
 */
const freeze = { frozenAt: Date.now(), seed: (Math.random() * 0x1_0000_0000) >>> 0 }

/**
 * 渲染记忆：标准会话的投影内容与 agent 无关，一次写穿里的 N 个 agent 共用同一
 * 份渲染结果——否则开关翻转会按「读盘 + 解析 + 宏展开」逐个 agent 重复一遍，
 * 面板开关要卡一会儿。
 */
let renderMemo: { key: string; text: string } | undefined
/** 写穿代数：预设文件内容变化时记忆键不变，靠代数让记忆失效。 */
let renderGeneration = 0

const projection = createLazyProjection<string>({
  getState: async () => (await store()).getState(),
  load: async (agentId, settle, snapshot) => {
    const db = await store()
    // 写穿遍历传 snapshot（一次写穿只读一次 state）；首装配走懒装载自行读。
    const state = snapshot ?? await db.getState()
    // 门控失败一律写空串（区别于 AgentTavern 通道的留旧值）：开关关掉、或会话
    // 后来被绑成 Tavern 会话时，section 必须立即消失，不能沿用旧投影。
    if (state.nativeAgentPreset !== true || state.sessionBindings[agentId] !== undefined) { settle(''); return }
    settle(await unboundBlock(db, state))
  },
})

/** 未绑定会话的投影文本（按输入组合记忆，见 renderMemo）。 */
async function unboundBlock(db: TavernStore, state: TavernState): Promise<string> {
  const key = [renderGeneration, state.activePreset ?? '', state.activeCharacter ?? '', state.activePersona ?? ''].join('\u0000')
  if (renderMemo?.key === key) return renderMemo.text
  const text = await renderUnboundBlock(db, state)
  renderMemo = { key, text }
  return text
}

async function renderUnboundBlock(db: TavernStore, state: TavernState): Promise<string> {
  // 空选择/激活预设缺失 = 空投影（不回落内置默认 RP 预设，见文件头）。
  if (typeof state.activePreset !== 'string' || state.activePreset === '') return ''
  const raw = await db.getPreset(state.activePreset)
  if (raw === undefined) return ''
  const block = renderAgentPresetBlock(parsePreset(raw), undefined, NATIVE_PRESET_HEADER)
  if (block === undefined) return ''
  // 预设内容是 ST 宏（{{char}}/{{user}}）的高频来源：宏展开 + {{...}} 中性化后
  // 才能进宿主 section（prompt-safety.ts，宿主 interpolate 会炸装配）。标准会话
  // 没有卡：{{char}} 取当前角色名（与 nativeAgentPersona 同一「当前配置」语义），
  // 未选角色时用占位语义避免 "Write 's next reply" 一类残句。
  const expand = createHostPromptExpander(
    state.activeCharacter || CHAR_FALLBACK,
    state.activePersona ?? DEFAULT_USER,
    { now: () => new Date(freeze.frozenAt), rng: seededRandom(freeze.seed) },
  )
  return hostPromptSafe(block, expand)
}

// 预设增删改 / 激活切换 / 开关翻转：写穿监听在模块加载时注册（index bundle 的
// apply 会 import 本模块）。标准会话不在 sessionBindings 里，绑定遍历看不到，
// 因此重载**已装载过**的全部 agent（refreshAll，一次写穿只读一次 state）；预设
// 文件内容可能变而记忆键不变，先推进代数让渲染记忆失效。
onAgentPresetChanged(() => {
  renderGeneration += 1
  return projection.refreshAll()
})

/** index bundle 的装配面：order -75，与其它预设投影同位（AgentTavern kernel 之后）。 */
export function nativeAgentPresetSection(): HostPromptSection {
  return {
    name: NATIVE_PRESET_SECTION,
    order: -75,
    text: (context) => projection.valueOf(agentIdOf(context)) ?? '',
  }
}

/** 装配上下文里的 agent 身份（宿主 assemble() 携带 { agent, scope, signal }）。 */
function agentIdOf(context: unknown): string | undefined {
  if (typeof context !== 'object' || context === null) return undefined
  const agent = (context as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 启动预热（apply() 调用）：插件重启后活着的标准会话在下一轮装配前先装载一次，
 * 消除「首轮空串 → 装载完成后整块出现」的 system 头突变（其前缀缓存一次性作废）。
 * fire-and-forget：装载失败由懒装载路径兜底。走 preheatAll（一次预热只读一次
 * state），不按 agent 逐个读盘。
 */
export function preheatNativeAgentPreset(agentIds: readonly string[]): Promise<void> {
  return projection.preheatAll(agentIds)
}

/**
 * 单个 agent 的首轮预热（agent/created 监听调用）：宿主在 loop start 前 await
 * 该事件，这里把新会话的投影先装载好，第一次装配就能拿到预设。与 apply 时的
 * `preheatAll` 分开，避免每建一个会话都把全部已装载 agent 重载一遍。
 */
export function preheatNativeAgentPresetOne(agentId: string): Promise<void> {
  return projection.preheatOne(agentId)
}
