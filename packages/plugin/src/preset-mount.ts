/**
 * 激活预设投影的通用挂载（写卡工作台 / AgentNovel 共用，决策
 * 2026-10-09-workbench-novel-preset-projection）。
 *
 * AgentTavern 的投影（agent-tavern/agent.ts + preset.ts）无条件生效——RP 会话
 * 语义上就该带预设栈；工作台与小说是编辑/写作型 Agent，预设栈（尤其社区 RP
 * 预设的越狱与风格条目）无条件注入会劫持内核行为，因此：
 *
 * - 各自由 tavern-store 状态里的显式开关门控（默认关闭，面板「预设」分区
 *   提供开关），开关翻转经既有的 emitAgentPresetChanged 写穿缓存；
 * - 不投影 temperature（工作台要工具精度、小说有自己的模型选择，预设调温
 *   是 RP 会话独有的诉求——AgentTavern 路径保持不变）；
 * - 不做卡覆盖（main/jailbreak ← 卡字段的覆盖语义属于「扮演这张卡」的 RP
 *   会话；工作台编辑卡、小说不绑卡）；
 * - 未选择激活预设时不回落内置默认 RP 预设（AgentTavern 的回落是「无预设
 *   也要有个 RP 主提示」的语义，对编辑/写作 Agent 是噪音）——空选择即空投影。
 *
 * 渲染体复用 agent-tavern/preset.ts（选集 100001→100000→首组、启用语义、
 * marker 跳过），仅换首行框架：小说沿用「跟随」表述，工作台用「引用」表述
 * （供起草卡面/预设文本与排错时还原对局的提示词环境，不覆盖工作台内核）。
 *
 * 与 AgentTavern 同款 best-effort 异步装载（懒装载 + 票号 last-write-wins）
 * 与跨 bundle 写穿（emit 在 index.mjs/card-workbench.mjs 的写路径，监听经
 * Symbol.for 注册表——本模块被打进 novel.mjs / card-workbench.mjs 两个分离
 * bundle，各持一份闭包，注册表必须锚定 globalThis）。前缀缓存纪律（决策
 * 2026-10-09-agent-preset-cache-stability）同样同款：动态宏按绑定的冻结记录
 * （装载时刻时钟 + 种子 RNG）求值，写穿重渲染对相同输入字节稳定；消费方
 * apply() 调 preheat() 预热既有绑定，消除重启后首轮空串→整块出现的 system
 * 头突变。
 */

import { parsePreset } from '../../tavern-format/src/index.js'
import { TavernStore, type TavernSessionBinding, type TavernState } from '../../tavern-store/src/index.js'
import { onAgentPresetChanged, renderAgentPresetBlock } from './agent-tavern/preset.js'
import { dshHomePath } from './dsh-home.js'
import { createHostPromptExpander, hostPromptSafe, seededRandom } from './prompt-safety.js'

/** 与 agent-tavern/agent.ts 的 DEFAULT_USER 同值：{{user}} 未设置人设时的回落。 */
const DEFAULT_USER = 'User'
/**
 * {{char}} 无具体所指时的展开值（自由工作台未绑来源聊天、小说不绑卡）：
 * RP 预设高频出现 "{{char}} 的下一条回复" 一类语句，展开成空串会产出
 * "Write 's next reply" 这类残句；展开成占位语义保持语句完整。
 */
const CHAR_FALLBACK = 'the character'

export interface PresetMountOptions {
  /** 注册的 section 名（每个 bundle 唯一；order 固定 -75，kernel 之后）。 */
  sectionName: string
  /** 只为该 architecture 的会话绑定投影（其余绑定一律空串）。 */
  architecture: 'card-workbench' | 'agent-novel'
  /** tavern-store 状态里的启用开关键（false/缺省 = 不投影）。 */
  stateFlag: 'cardWorkbenchPresetEnabled' | 'agentNovelPresetEnabled'
  /** 注入块首行：小说用「跟随」框架，工作台用「引用」框架。 */
  header: string
  /** {{char}} 的展开来源：从绑定取具体卡名/角色名，取不到回落 CHAR_FALLBACK。 */
  charOf: (binding: TavernSessionBinding) => string
}

export interface PresetMount {
  /** 装配回调入参形态（宿主 assemble() 携带 { agent, scope, signal }）。 */
  section: { name: string; order: number; text: (assembly?: { agent?: { id?: string } }) => string }
  /** 直接取某 agent 的投影文本（测试用；未就绪/未启用/未绑定返回空串）。 */
  textOf: (agentId: string | undefined) => string
  /** apply() 期启动预热：装载该架构的全部既有绑定，消除插件重启后首轮空串→
   *  整块出现的 system 头突变（前缀缓存一次性作废）。幂等；失败由懒装载兜底。 */
  preheat: () => Promise<void>
}

let storePromise: Promise<TavernStore> | undefined

function store(): Promise<TavernStore> {
  return (storePromise ??= TavernStore.open(dshHomePath('tavern')))
}

/**
 * 建一个预设投影挂载。消费方在模块顶层调用一次（闭包缓存随 bundle 存活），
 * apply() 里展开 mount.section 注册并调用 mount.preheat()；写穿监听在工厂
 * 调用时注册。
 */
export function mountPresetProjection(options: PresetMountOptions): PresetMount {
  const projection = new Map<string, string>()
  const started = new Set<string>()
  /** 装载票号：与 AgentTavern 同款 last-write-wins，防在途过期装载覆盖新写入。 */
  const tickets = new Map<string, number>()
  /**
   * 缓存冻结记录（与 agent-tavern/agent.ts 的 presetFreeze 同一纪律，决策
   * 2026-10-09-agent-preset-cache-stability）：绑定首次装载捕获时钟与 RNG
   * 种子，写穿重载复用同一求值上下文——相同输入字节稳定，预设内 {{time}}/
   * {{random}} 不随重载换值烧掉 system 头前缀缓存。
   */
  const freeze = new Map<string, { frozenAt: number; seed: number }>()
  let preheatDone = false

  const textOf = (agentId: string | undefined): string => {
    if (typeof agentId !== 'string' || agentId.trim() === '') return ''
    if (!started.has(agentId)) {
      started.add(agentId)
      void load(agentId)
    }
    return projection.get(agentId) ?? ''
  }

  async function load(agentId: string): Promise<void> {
    const ticket = (tickets.get(agentId) ?? 0) + 1
    tickets.set(agentId, ticket)
    try {
      const db = await store()
      const state = await db.getState()
      const settle = (text: string) => {
        if (tickets.get(agentId) === ticket) projection.set(agentId, text)
      }
      const binding = state.sessionBindings[agentId]
      if (state[options.stateFlag] !== true || !binding || binding.architecture !== options.architecture) {
        settle('')
        return
      }
      // 空选择/激活预设缺失 = 空投影（不回落内置默认 RP 预设，见文件头）。
      if (typeof state.activePreset !== 'string' || state.activePreset === '') { settle(''); return }
      const raw = await db.getPreset(state.activePreset)
      if (raw === undefined) { settle(''); return }
      const block = renderAgentPresetBlock(parsePreset(raw), undefined, options.header)
      if (block === undefined) { settle(''); return }
      // 预设内容是 ST 宏（{{char}}/{{user}}）的高频来源：宏展开 + {{...}}
      // 中性化后才能进宿主 section（prompt-safety.ts，宿主 interpolate 会炸装配）。
      // 时钟/RNG 按冻结记录求值（见 freeze 注释）。
      const record = freeze.get(agentId) ?? { frozenAt: Date.now(), seed: (Math.random() * 0x1_0000_0000) >>> 0 }
      freeze.set(agentId, record)
      const expand = createHostPromptExpander(
        charNameOf(options, binding),
        state.activePersona ?? DEFAULT_USER,
        { now: () => new Date(record.frozenAt), rng: seededRandom(record.seed) },
      )
      settle(hostPromptSafe(block, expand))
    } catch {
      // store 缺失/预设损坏不得阻止宿主 agent 启动：保持空投影，下一次写穿重试。
    }
  }

  async function preheat(): Promise<void> {
    if (preheatDone) return
    preheatDone = true
    try {
      const state = await (await store()).getState()
      for (const [agentId, binding] of Object.entries(state.sessionBindings)) {
        if (binding.architecture !== options.architecture) continue
        started.add(agentId)
        await load(agentId)
      }
    } catch {
      // best-effort 预热：失败只意味着回到懒装载路径。
    }
  }

  onAgentPresetChanged(async () => {
    try {
      const state = await (await store()).getState()
      for (const [agentId, binding] of Object.entries(state.sessionBindings)) {
        if (binding.architecture !== options.architecture) continue
        started.add(agentId)
        await load(agentId)
      }
    } catch {
      // best-effort 写穿：失败只意味着下一次装配沿用旧缓存。
    }
  })

  return {
    section: { name: options.sectionName, order: -75, text: (assembly) => textOf(assembly?.agent?.id) },
    textOf,
    preheat,
  }
}

function charNameOf(options: PresetMountOptions, binding: TavernSessionBinding): string {
  const name = options.charOf(binding).trim()
  return name === '' ? CHAR_FALLBACK : name
}

/** 状态开关的类型收窄辅助（TavernState 的两个布尔键）。 */
export type PresetStateFlag = keyof Pick<TavernState, 'cardWorkbenchPresetEnabled' | 'agentNovelPresetEnabled'>
