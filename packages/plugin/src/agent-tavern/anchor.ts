/**
 * AgentTavern 锚定提醒：开场装载引导（抓手 3）+ 周期性锚定（抓手 2）。
 *
 * 长上下文中 system prompt 里的 KERNEL 职责会被剧情文本稀释，模型在若干轮后
 * 停止主动写记忆/查世界书（会话日志实证的衰减曲线）。29f49b5 起开场白与既有
 * 聊天历史会镜像进原生会话，模型把镜像剧情当作"本聊天已确立的事实"，开场
 * 完全跳过工具装载——开场引导在第一个真实用户轮把装载指令放到批次末尾
 * （注意力最高点），周期锚定则在其后的 turn 边界把职责拉回注意力。
 *
 * 缓存安全契约（不可破坏，见 README）：
 * 1. append-only：提醒只追加到当前 step 的 user batch 末尾，与用户下一条消息
 *    在 KV 前缀缓存语义下完全等价，不触碰任何已入缓存的前缀；
 * 2. write-once：消息写入 durable log 后永不改写/删除——"阅后即焚"式提醒会
 *    从改写点开始烧掉全部后续缓存；
 * 3. 轮数节流：周期锚定默认每 5 个 turn 的 step 1 注入一次，纯算术判定；
 *    开场引导一次性，其后由周期锚定接管。
 *
 * 投影安全：消息带 plugin source，projector 按 `source.kind !== 'user'` 过滤，
 * 不会写进 Tavern JSONL 剧情记录。
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { TavernStore } from '../../../tavern-store/src/index.js'
import { sessionEvents, type HostSessionLog } from '../../../bind/src/index.js'

/** 宿主会话形状经 host-session 兼容层读取（0.1.2 无 events 数组属性）。 */
type AnchorSessionLike = HostSessionLog & { id?: string }

export const ANCHOR_EVERY_TURNS_DEFAULT = 5

/** 与 KERNEL 职责逐条对应；内容稳定，不含易变计数器。 */
export const ANCHOR_TEXT = [
  '<tavern-anchor>',
  'Periodic maintenance reminder (system message, not story content — do not narrate, quote, or reference it):',
  'Before continuing, check your standing duties. If recent turns introduced significant story facts (new characters, places, promises, injuries, items, relationship or status changes) that are not yet recorded, persist them with memory_write or memory_update in chat scope. If the upcoming narration involves a proper noun not yet established in this chat, consult tavern_lore_search first. Recover unclear continuity from tavern_history_search or memory_search rather than inventing it. When nothing applies, simply continue the scene without mentioning this reminder.',
  '</tavern-anchor>',
].join('\n')

/**
 * 开场装载引导。29f49b5 起开场白/历史镜像进会话后，模型把镜像剧情当作
 * "本聊天已确立的事实"，KERNEL 的 established-in-this-chat 豁免条款反而
 * 抑制了开场查证——这里逐条给出装载清单，在第一个真实用户轮的批次末尾
 * （注意力最高点）一次性注入。内容稳定，不含易变计数器。
 */
export const OPENING_TEXT = [
  '<tavern-opening>',
  'Opening grounding brief (system message, not story content — do not narrate, quote, or reference it):',
  'The story above was imported from the Tavern save: the greeting and any past messages are stage history, not your own memory. The character card details and world-info entries behind this scene are not in your context, and no memories have been loaded yet.',
  'Before writing this reply, load the scene with the tools: tavern_character_get for the bound character card, tavern_lore_search for each proper noun this opening relies on (persons, places, factions, techniques, items), memory_search for established facts, and tavern_history_search when continuity is unclear. Then continue the scene naturally without mentioning this brief.',
  '</tavern-opening>',
].join('\n')

/** 提醒消息的 source.form；latestReminderTurn 按这一组做去重扫描。 */
const REMINDER_FORMS = new Set(['tavern-anchor', 'tavern-opening'])

/** 纯算术判定：仅在 turn 周期点的 step 1（用户消息进入的那一步）触发。 */
export function anchorDue(turn: unknown, step: unknown, everyTurns: number): boolean {
  if (everyTurns <= 0) return false
  return step === 1 && typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0 && turn % everyTurns === 0
}

/**
 * 注入判定：非空批次、本 turn 未注入过、step 1。开场轮（会话尚无真实用户
 * 消息）不受轮数节流——返回 'opening'；其后按周期返回 'periodic'。
 */
export function reminderDue(
  input: { turn: unknown; step: unknown; messages?: readonly unknown[] },
  everyTurns: number,
  latest: number,
  hasUserTurn: boolean,
): 'opening' | 'periodic' | undefined {
  if (input.step !== 1) return undefined
  if (!Array.isArray(input.messages) || input.messages.length === 0) return undefined
  const turn = input.turn
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn <= 0) return undefined
  if (latest >= turn) return undefined
  if (!hasUserTurn) return 'opening'
  return anchorDue(turn, input.step, everyTurns) ? 'periodic' : undefined
}

export function createAnchorMessage(turn: number): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'plugin'; plugin: 'dsh-tavern'; form: 'tavern-anchor'; turn: number }
} {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: ANCHOR_TEXT }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-anchor', turn },
  }
}

export function createOpeningMessage(turn: number): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'plugin'; plugin: 'dsh-tavern'; form: 'tavern-opening'; turn: number }
} {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: OPENING_TEXT }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'tavern-opening', turn },
  }
}

/**
 * 会话里是否出现过真实用户消息（source.kind === 'user'）。导入历史与提醒都带
 * plugin source，不计入。反向扫描：正常会话里最近一条真实用户消息就在末尾。
 */
export function hasRealUserTurn(events: readonly unknown[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: { source?: Record<string, unknown> } } | undefined
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind === 'user') return true
  }
  return false
}

/** 反向找该会话最近一次提醒（开场或周期）的 turn；无则 0。扫描在首个命中处停止。 */
export function latestReminderTurn(events: readonly unknown[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: { source?: Record<string, unknown> } } | undefined
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === 'plugin' && source.plugin === 'dsh-tavern'
      && typeof source.form === 'string' && REMINDER_FORMS.has(source.form)
      && typeof source.turn === 'number' && Number.isSafeInteger(source.turn)) {
      return source.turn
    }
  }
  return 0
}

/** 配置解析：未配置用默认；0 关闭；非法值退回默认（fail-soft，不阻塞插件加载）。 */
export function resolveAnchorEveryTurns(value: unknown): number {
  if (value === undefined) return ANCHOR_EVERY_TURNS_DEFAULT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return ANCHOR_EVERY_TURNS_DEFAULT
  return value
}

// 私有助手一律带 anchor 前缀：本模块与 index.ts 打进同一 bundle，顶层重名会
// 触发 esbuild 改名，破坏 internal-workspace gate 的源码 marker。
let anchorTavernStorePromise: Promise<TavernStore> | undefined

function anchorTavernStore(): Promise<TavernStore> {
  return (anchorTavernStorePromise ??= TavernStore.open(anchorDshHomePath('tavern')))
}

function anchorDshHomePath(...segments: string[]): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), ...segments)
}

/** 存储缺失或读取失败时按非 Tavern 会话处理，不注入。 */
async function isAgentTavernSession(sessionId: string): Promise<boolean> {
  try {
    const binding = (await (await anchorTavernStore()).getState()).sessionBindings[sessionId]
    return binding !== undefined && binding.architecture === 'agent-tavern' && binding.group !== true
  } catch {
    return false
  }
}

interface AnchorAgentLike {
  session?: AnchorSessionLike
}

interface AnchorDecisionLike {
  kind?: string
  messages?: unknown[]
}

/**
 * 注册 pre-step 锚定监听；镜像宿主 dsh-time-context 的 wrap 模式
 * （prepend 注册、先 await next() 再追加，保证提醒落在批次最末）。
 * 非 AgentTavern 会话、非注入点、拒绝/中止路径全部原样透传。
 */
export function registerAgentTavernAnchor(ctx: {
  on?: (event: string, listener: (payload: unknown, next: () => unknown) => unknown, options?: unknown) => unknown
}, options: { everyTurns?: unknown; isTavernSession?: (sessionId: string) => Promise<boolean> } = {}): void {
  const everyTurns = resolveAnchorEveryTurns(options.everyTurns)
  if (everyTurns <= 0) return
  const isTavernSession = options.isTavernSession ?? isAgentTavernSession
  ctx.on?.('agent/pre-step', async (payload: {
    agent?: AnchorAgentLike
    turn?: unknown
    step?: unknown
    signal?: { aborted?: boolean }
  }, next: () => Promise<AnchorDecisionLike>) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || payload.signal?.aborted) return decision
    const events = sessionEvents(payload.agent?.session)
    const kind = reminderDue(
      { turn: payload.turn, step: payload.step, messages: decision.messages },
      everyTurns,
      latestReminderTurn(events),
      hasRealUserTurn(events),
    )
    if (kind === undefined) return decision
    // 存储读取只发生在注入点，保持非注入 step 的零开销路径。
    const sessionId = payload.agent?.session?.id
    if (typeof sessionId !== 'string' || !(await isTavernSession(sessionId))) return decision
    const turn = payload.turn as number
    return {
      kind: 'enter',
      messages: [...decision.messages ?? [], kind === 'opening' ? createOpeningMessage(turn) : createAnchorMessage(turn)],
    }
  }, { prepend: true })
}
