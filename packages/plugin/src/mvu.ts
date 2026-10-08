/**
 * MVU 变量结算回执（提案 0012 P1）。
 *
 * P1 语义：变量更新本身由提案 0008 的模板输出渲染写穿完成（`<% setvar %>` 等
 * 直接落 `chat_metadata.variables`）——本模块不另造结算引擎，做的是「把结算
 * 结果变成可见、可重试的回执」：
 *
 * - 回执：生成开始时深拷贝 `chat_metadata.variables` 作为基线（before），保存
 *   前 diff 出变更集（after），以 `{ at, turnKey, status, changes, failures }`
 *   落入 `chat.header.chat_metadata.mvu.receipts`，环形保留最近 20 条。
 *   failures 收集本轮 templateWarnings（楼层 extra.templateWarnings 同源）。
 *   无变量也无变更的局不写 mvu 键（与 guides 空置摘键约定一致）。
 * - POST mvu/retry：对最后一条助手楼层重跑模板输出渲染的**变量写穿部分**
 *   （见 retryMvuSettlement 注释）；CAS 冲突走 ChatRevisionConflictError
 *   既有通道。
 * - GET mvu/status/<character>/<chatId>：变量 + 回执快照；当卡片约定字段
 *   `data.extensions.agentTavern.statusTemplate`（0013 工作台将来产出）是
 *   字符串时，用 `@dsh-tavern/template` 的 createTemplateRuntime 渲染并返回
 *   renderedHtml——这是 P1 的接线点；模板化 MVU display 语义不在 P1 范围。
 */

import {
  createTemplateRuntime,
  deepClone,
  type JsonObject,
  type TemplateHost,
  type TemplateRuntime,
} from '../../tavern-template/src/index.js'
import type { CharacterCardIR, ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import type { Lorebook } from '../../tavern-lore/src/index.js'
import {
  ChatRevisionConflictError,
  type ChatSnapshot,
  type TavernState,
  type TavernStore,
} from '../../tavern-store/src/index.js'
import { collectWorldInfoBooks } from './tavern-assets.js'

const DEFAULT_USER = 'User'
const INITIAL_VARIABLES_KEY = 'initial_variables'

/** 单条变量变更：name 是点路径（如 `mvu.favor`）；before/after 缺侧即增/删。 */
export interface MvuVariableChange {
  name: string
  before?: unknown
  after?: unknown
}

/**
 * - updated：本轮有变量写穿（changes 非空）且无失败；
 * - unchanged：有变量基线但本轮无变更；
 * - failed：本轮渲染告警（failures 非空，结算可经 POST mvu/retry 重试）。
 */
export type MvuReceiptStatus = 'updated' | 'unchanged' | 'failed'

/** 单局结算回执；turnKey 是助手楼层的 messages 下标（字符串），重试同一楼层时相同。 */
export interface MvuReceipt {
  at: string
  turnKey: string
  status: MvuReceiptStatus
  changes: MvuVariableChange[]
  failures: string[]
}

/** 环形保留条数（提案 0012 P1）。 */
export const MVU_RECEIPTS_LIMIT = 20

/* ---------------------------- 变量读取与 diff ---------------------------- */

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 读 `chat_metadata.variables` 的活引用（缺省/形状不合返回新空对象，不写回）。 */
export function readChatVariables(chat: ChatLogIR): Record<string, unknown> {
  return plainObject(chat?.header?.chat_metadata?.variables) ?? {}
}

/** 生成开始的基线快照：深拷贝，后续渲染写穿不影响 before。 */
export function snapshotChatVariables(chat: ChatLogIR): Record<string, unknown> {
  return deepClone(readChatVariables(chat)) as Record<string, unknown>
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  const leftObject = plainObject(left)
  const rightObject = plainObject(right)
  if (leftObject !== undefined && rightObject !== undefined) {
    for (const key of new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])) {
      if (!valuesEqual(leftObject[key], rightObject[key])) return false
    }
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]))
  }
  return false
}

/**
 * 变量树叶子级 diff：两侧都是普通对象、或一侧缺失另一侧是普通对象时按 key
 * 递归（新增/删除子树展开到叶子路径）；数组与原语整体比较（数组按下标逐项
 * diff 噪音大，回执按「值变了」呈现即可）。结果按 name 排序。
 */
export function diffVariables(before: Record<string, unknown>, after: Record<string, unknown>): MvuVariableChange[] {
  const changes: MvuVariableChange[] = []
  const walk = (path: string, left: unknown, right: unknown): void => {
    const leftObject = plainObject(left)
    const rightObject = plainObject(right)
    const recursible = (leftObject !== undefined && rightObject !== undefined)
      || (left === undefined && rightObject !== undefined)
      || (right === undefined && leftObject !== undefined)
    if (recursible) {
      const leftNext = leftObject ?? {}
      const rightNext = rightObject ?? {}
      for (const key of new Set([...Object.keys(leftNext), ...Object.keys(rightNext)])) {
        walk(path === '' ? key : `${path}.${key}`, leftNext[key], rightNext[key])
      }
      return
    }
    if (!valuesEqual(left, right)) {
      const change: MvuVariableChange = { name: path, ...(left !== undefined ? { before: left } : {}) }
      if (right !== undefined) change.after = right
      changes.push(change)
    }
  }
  walk('', before, after)
  return changes.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 把作用域变量覆盖回嵌套树（AgentTavern 的 chat 作用域变量是扁平点分名，
 * 如 `mvu.favor`；而宏/模板与扁平化面板都按嵌套树 `getvar('mvu.favor')` 语义
 * 访问）。同名路径整段覆盖；中间层不是普通对象时替换为对象（点分名与既有
 * 树形状冲突时以作用域值为准）。base 不被修改。
 */
export function overlayScopedVariables(
  base: Record<string, unknown>,
  entries: ReadonlyArray<{ name: string; value: unknown }>,
): Record<string, unknown> {
  const tree = deepClone(base) as Record<string, unknown>
  for (const entry of entries) {
    const segments = entry.name.split('.')
    const leaf = segments.pop()!
    let cursor = tree
    for (const segment of segments) {
      const next = cursor[segment]
      if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {}
      cursor = cursor[segment] as Record<string, unknown>
    }
    cursor[leaf] = entry.value
  }
  return tree
}

/* ------------------------------ 回执读写 ------------------------------ */

/** 读 `chat_metadata.mvu.receipts`；形状不合法的条目跳过（手改 jsonl 的容错）。 */
export function readMvuReceipts(chat: ChatLogIR): MvuReceipt[] {
  const raw = plainObject(chat?.header?.chat_metadata?.mvu)?.receipts
  if (!Array.isArray(raw)) return []
  const receipts: MvuReceipt[] = []
  for (const entry of raw) {
    const record = plainObject(entry)
    if (record === undefined) continue
    const { at, turnKey, status, changes, failures } = record
    if (typeof at !== 'string' || typeof turnKey !== 'string') continue
    if (status !== 'updated' && status !== 'unchanged' && status !== 'failed') continue
    receipts.push({
      at,
      turnKey,
      status,
      changes: Array.isArray(changes)
        ? changes.flatMap((item): MvuVariableChange[] => {
            const change = plainObject(item)
            if (change === undefined || typeof change.name !== 'string') return []
            const out: MvuVariableChange = { name: change.name }
            if ('before' in change) out.before = change.before
            if ('after' in change) out.after = change.after
            return [out]
          })
        : [],
      failures: Array.isArray(failures) ? failures.filter((item): item is string => typeof item === 'string') : [],
    })
  }
  return receipts
}

/** 追加回执（环形保留最近 20 条），写 `chat_metadata.mvu`（调用方负责 saveChat）。 */
export function appendMvuReceipt(chat: ChatLogIR, receipt: MvuReceipt): void {
  const metadata = chat.header.chat_metadata
  const receipts = [...readMvuReceipts(chat), receipt].slice(-MVU_RECEIPTS_LIMIT)
  metadata.mvu = { receipts }
}

/**
 * 生成链路的回执落点（runGeneration 保存助手楼层前调用）：
 * diff before（生成开始的深拷贝基线）与 after（当前 chat_metadata.variables，
 * 已含模板输出渲染与宏的写穿结果），追加一条回执。
 * 无变量（前后皆空树）、无变更且无失败的局不写 mvu 键——与 guides 空置摘键
 * 约定一致；已有的历史回执保持不动。
 */
export function recordMvuTurnReceipt(
  chat: ChatLogIR,
  before: Record<string, unknown>,
  options: { turnKey: string; at?: string; failures?: string[] },
): MvuReceipt | undefined {
  const after = readChatVariables(chat)
  const changes = diffVariables(before, after)
  const failures = options.failures ?? []
  if (changes.length === 0 && failures.length === 0
    && Object.keys(before).length === 0 && Object.keys(after).length === 0) {
    return undefined
  }
  const status: MvuReceiptStatus = failures.length > 0 ? 'failed' : changes.length > 0 ? 'updated' : 'unchanged'
  const receipt: MvuReceipt = {
    at: options.at ?? new Date().toISOString(),
    turnKey: options.turnKey,
    status,
    changes,
    failures,
  }
  appendMvuReceipt(chat, receipt)
  return receipt
}

/* --------------------------- 模板运行时（共享） --------------------------- */

interface MvuRuntimeInput {
  state: Pick<TavernState, 'activePersona'>
  characterName: string
  character: { card: CharacterCardIR }
  chat: ChatLogIR
  chatId?: string
  books: Lorebook[]
  /** 渲染告警出口（重试路径收集进回执 failures）。 */
  onWarning?: (message: string) => void
}

/**
 * 结算用最小模板运行时（同步、纯构造）：runType='render'，stores 由调用方
 * 决定绑活引用还是拷贝（重试绑活引用写穿，状态栏渲染绑拷贝只读）。
 * 与 createGenerationTemplates 的完整运行时相比，这里不做 lore 激活/预设/
 * GENERATE 分区：结算重跑只需要输出渲染的变量 API 面（setvar/getvar/…）。
 */
function createMvuRuntime(input: MvuRuntimeInput, stores: Parameters<typeof createTemplateRuntime>[0]['stores']): TemplateRuntime {
  const { characterName, character, chat, books } = input
  const card = character.card
  const cardName = card.data.nickname || card.data.name || characterName
  const lastUserMessageId = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].is_user) return i
    return -1
  })()
  const lastCharMessageId = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (!chat.messages[i].is_user && !chat.messages[i].is_system) return i
    }
    return -1
  })()
  const host: TemplateHost = {
    runType: 'render',
    userName: input.state.activePersona ?? DEFAULT_USER,
    charName: cardName,
    chatId: input.chatId ?? '',
    characterId: characterName,
    messages: chat.messages.map((message: ChatMessage) => ({
      name: message.name,
      mes: message.mes,
      is_user: message.is_user,
      is_system: message.is_system,
    })),
    lastUserMessageId,
    lastCharMessageId,
    findWorldEntries: (title, book) => {
      const out: Array<{ uid: number; book: string; comment?: string; content: string; order?: number; disable?: boolean }> = []
      for (const lorebook of books) {
        if (book !== undefined && lorebook.name !== book) continue
        for (const entry of lorebook.entries) {
          const comment = entry.comment ?? ''
          const matched = typeof title === 'number' ? entry.uid === title : comment === title
          if (!matched) continue
          out.push({
            uid: entry.uid,
            book: lorebook.name ?? '',
            comment,
            content: entry.content ?? '',
            ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
            disable: entry.disable === true,
          })
        }
      }
      return out
    },
    getCard: (name) => {
      if (name !== undefined && name !== characterName && name !== cardName) return null
      return {
        name: cardName,
        systemPrompt: card.data.systemPrompt,
        personality: card.data.personality,
        description: card.data.description,
        scenario: card.data.scenario,
        firstMes: card.data.firstMes,
        mesExample: card.data.mesExample,
        creatorNotes: card.data.creatorNotes,
        depthPrompt: '',
        data: card.data as unknown as Record<string, unknown>,
      }
    },
    findPresetPrompt: () => null,
    renderNested: async () => '',
  }
  const runtime = createTemplateRuntime({ host, stores, ...(input.onWarning !== undefined ? { onWarning: input.onWarning } : {}) })
  host.renderNested = (source, extra) => runtime.renderText(source, extra)
  return runtime
}

/* ------------------------------ 状态栏渲染 ------------------------------ */

/** 卡片约定字段（0013 工作台产出）：`data.extensions.agentTavern.statusTemplate`。 */
export function statusTemplateOf(card: CharacterCardIR): string | undefined {
  const agentTavern = plainObject(card?.data?.extensions?.['agentTavern'])
  const template = agentTavern?.statusTemplate
  return typeof template === 'string' && template.trim() !== '' ? template : undefined
}

export interface MvuStatusRenderInput {
  db: Pick<TavernStore, 'getWorld'>
  state: Pick<TavernState, 'activeWorlds' | 'activePersona' | 'scriptGlobals'>
  characterName: string
  character: { card: CharacterCardIR }
  chat: ChatLogIR
  chatId: string
  template: string
  /** 显示用变量树覆盖（路由已把 AgentTavern 作用域变量并入时传入）；缺省读 chat_metadata.variables。 */
  localVariables?: Record<string, unknown>
}

/**
 * 状态栏模板渲染（P1 接线点）：只读快照渲染——local/global/initial 都绑拷贝，
 * 模板内的 setvar 不会写穿聊天。渲染失败抛错，由路由降级为不返回 renderedHtml
 * （不 500）。
 */
export async function renderMvuStatusTemplate(input: MvuStatusRenderInput): Promise<string> {
  const chat = input.chat
  const books = await collectWorldInfoBooks(input.db, input.state, input.characterName, input.character)
  const runtime = createMvuRuntime(
    {
      state: input.state,
      characterName: input.characterName,
      character: input.character,
      chat,
      chatId: input.chatId,
      books,
    },
    {
      local: deepClone((input.localVariables ?? readChatVariables(chat)) as JsonObject),
      global: { ...input.state.scriptGlobals },
      initial: deepClone(plainObject(chat.header.chat_metadata[INITIAL_VARIABLES_KEY]) ?? {}) as JsonObject,
    },
  )
  return await runtime.renderText(input.template, undefined, 'mvu-status')
}

/* ------------------------------ 结算重试 ------------------------------ */

export interface MvuRetryOptions {
  state: Pick<TavernState, 'activePersona' | 'activeWorlds' | 'scriptGlobals' | 'sessionBindings'>
  characterName: string
  chatId: string
  snapshot: ChatSnapshot
  /** CAS 期望 revision（与 generate/candidates 同语义）。 */
  revision: string
  sessionId?: string
  /** 与 runGeneration 同推导的模板开关（templatesEnabledFlag && templatesEnabled()）。 */
  templatesActive: boolean
}

export interface MvuRetryResult {
  receipt: MvuReceipt
  revision: string
  variables: Record<string, unknown>
}

/**
 * 结算重试（POST mvu/retry 执行核）：对最后一条助手楼层重跑模板输出渲染的
 * **变量写穿部分**（提取 setvar/incvar 类写穿，渲染结果文本丢弃——正文不动）。
 *
 * 注意：刻意**不重跑 AI_OUTPUT regex**——该变换非幂等，且楼层文本在首次保存时
 * 已被变换过一次，重跑会把正文再变换一遍。正常成功的楼层其模板标签已被消费，
 * 重试渲染是直通（无写穿，回执 unchanged）；保留标签的是渲染失败降级的楼层
 * （renderText 失败保原文），重试在变量面变化后可能补结算成功。
 *
 * 变量更新 + 追加回执（status 'updated' / 'unchanged'，重试不产生 'failed'——
 * 新失败项继续进 failures 可再试）后 saveChat；CAS 冲突抛 ChatRevisionConflictError。
 */
export async function retryMvuSettlement(
  db: Pick<TavernStore, 'getWorld' | 'getCharacter' | 'saveChat' | 'updateState'>,
  options: MvuRetryOptions,
): Promise<MvuRetryResult> {
  const { state, characterName, chatId, snapshot } = options
  if (typeof options.sessionId === 'string' && state.sessionBindings?.[options.sessionId]?.architecture === 'agent-tavern') {
    throw new Error('AgentTavern sessions use the DSH native AgentLoop; MVU settlement retry is unavailable.')
  }
  if (!options.templatesActive) {
    throw new Error('MVU retry requires the prompt template runtime (templates are disabled)')
  }
  if (options.revision !== snapshot.revision) {
    throw new ChatRevisionConflictError(options.revision, snapshot.revision)
  }
  const chat = snapshot.chat
  const metadata = chat.header.chat_metadata
  const before = snapshotChatVariables(chat)

  let floorIndex = -1
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i]
    if (!message.is_user && !message.is_system) { floorIndex = i; break }
  }
  if (floorIndex === -1) throw new Error('no assistant floor to settle')
  const floor = chat.messages[floorIndex]

  // 群聊楼层名义上是成员：characterName 是组名时按楼层发言人回落
  const character = (await db.getCharacter(characterName)) ?? (await db.getCharacter(floor.name))
  if (!character) throw new Error(`character '${characterName}' not found`)

  const failures: string[] = []
  // local 绑活引用：setvar 写穿直接落 chat_metadata.variables；空树保持摘键
  const localVars = plainObject(metadata.variables) ?? {}
  metadata.variables = localVars
  const globalsBefore = JSON.stringify(state.scriptGlobals)

  const books = await collectWorldInfoBooks(db, state, characterName, character)
  const runtime = createMvuRuntime(
    { state, characterName, character, chat, chatId, books, onWarning: (message) => { failures.push(message) } },
    {
      // initial 绑活引用（存在时）；无 initial 树时绑临时对象，initial 作用域写穿
      // 不持久化——initial 本就由每次生成的 InitialVariables 重算，非用户状态
      local: localVars as JsonObject,
      global: state.scriptGlobals,
      initial: (plainObject(metadata[INITIAL_VARIABLES_KEY]) ?? {}) as JsonObject,
    },
  )
  try {
    // 只取变量副作用；渲染文本丢弃（正文楼层不动）
    await runtime.renderText(floor.mes, undefined, 'mvu-retry')
  } catch (err) {
    failures.push(`mvu retry render failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (Object.keys(localVars).length === 0) delete metadata.variables
  // global 写穿与 runGeneration 同款：有变化才落 state
  if (JSON.stringify(state.scriptGlobals) !== globalsBefore) {
    await db.updateState((current) => ({ scriptGlobals: { ...current.scriptGlobals, ...state.scriptGlobals } }))
  }

  const after = readChatVariables(chat)
  const changes = diffVariables(before, after)
  const receipt: MvuReceipt = {
    at: new Date().toISOString(),
    turnKey: String(floorIndex),
    status: changes.length > 0 ? 'updated' : 'unchanged',
    changes,
    failures,
  }
  appendMvuReceipt(chat, receipt)
  const revision = await db.saveChat(characterName, chatId, chat, snapshot.revision)
  return { receipt, revision, variables: after }
}
