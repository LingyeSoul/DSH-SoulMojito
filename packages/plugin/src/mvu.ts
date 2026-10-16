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
 * - POST mvu/receipts/undo（B-6a）：撤销最新一条有效回执——每项变更恢复到
 *   before 值（见文件底部撤销执行核注释）；AgentTavern 绑定由路由改派
 *   undoMvuAgentSettlement 写 chat 作用域变量存储。
 * - GET mvu/status/<character>/<chatId>：变量 + 回执快照；当卡片约定字段
 *   `data.extensions.agentTavern.statusTemplate`（0013 工作台将来产出）是
 *   字符串时，用 `@dsh-soulmojito/template` 的 createTemplateRuntime 渲染并返回
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
  type VariableChange,
  type VariableStore,
} from '../../tavern-store/src/index.js'
import { collectWorldInfoBooks } from './tavern-assets.js'
import {
  getMvuTreePath,
  guardMvuWrite,
  mvuValuesEqual,
  readMvuSchema,
  stripMvuControl,
} from './mvu-guard.js'
import { applyMvuSettlementRules, mergeMvuRuleNotes } from './mvu-rules.js'

const DEFAULT_USER = 'User'
const INITIAL_VARIABLES_KEY = 'initial_variables'

/** 单条变量变更：name 是点路径（如 `mvu.favor`）；before/after 缺侧即增/删；reason 是 guard 调整说明（clamp/step，C-1）。 */
export interface MvuVariableChange {
  name: string
  before?: unknown
  after?: unknown
  reason?: string
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
  /** B-6a 回执撤销：撤销时刻（ISO）；存在即该回执已撤销，不再是「最新有效」。 */
  undoneAt?: string
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
  // 深比较统一走守卫模块的 mvuValuesEqual（C-1 起两处共用同一语义）
  return mvuValuesEqual(left, right)
}

/**
 * 变量树叶子级 diff：两侧都是普通对象、或一侧缺失另一侧是普通对象时按 key
 * 递归（新增/删除子树展开到叶子路径）；数组与原语整体比较（数组按下标逐项
 * diff 噪音大，回执按「值变了」呈现即可）。根 `$schema`（C-1）/`$rules`（C-2）
 * 子树是守卫/规则契约不是变量，两侧剥离后再 diff。结果按 name 排序。
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
  walk('', stripMvuControl(before), stripMvuControl(after))
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
            if (typeof change.reason === 'string') out.reason = change.reason
            return [out]
          })
        : [],
      failures: Array.isArray(failures) ? failures.filter((item): item is string => typeof item === 'string') : [],
      ...(typeof record.undoneAt === 'string' ? { undoneAt: record.undoneAt } : {}),
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
 * changeNotes（C-1）：守卫 clamp/step 调整说明按变更路径附到回执 reason。
 */
export function recordMvuTurnReceipt(
  chat: ChatLogIR,
  before: Record<string, unknown>,
  options: { turnKey: string; at?: string; failures?: string[]; changeNotes?: Record<string, string> },
): MvuReceipt | undefined {
  const after = readChatVariables(chat)
  const changes = diffVariables(before, after)
  for (const change of changes) {
    const note = options.changeNotes?.[change.name]
    if (note !== undefined) change.reason = note
  }
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

/* ---------------------- $schema 写入守卫（C-1，ST 路径） ---------------------- */

export interface MvuGuardPassResult {
  /** reject 失败项（`${path}: guard ${kind}: ${reason}`），并入回执 failures 可重试。 */
  failures: string[]
  /** clamp/step 调整说明，按变更路径附到回执 change.reason。 */
  notes: Record<string, string>
}

function setMvuTreePath(tree: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  const leaf = segments.pop()!
  let cursor: Record<string, unknown> = tree
  for (const segment of segments) {
    const next = cursor[segment]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[leaf] = value
}

/** 回滚一条被守卫拒绝的写：恢复基线值（新增键删除并修剪因此空掉的中间对象）。 */
function revertMvuTreePath(tree: Record<string, unknown>, path: string, before: Record<string, unknown>): void {
  const beforeValue = getMvuTreePath(before, path)
  if (beforeValue !== undefined) {
    setMvuTreePath(tree, path, beforeValue)
    return
  }
  const segments = path.split('.')
  const leaf = segments.pop()!
  const parent = getMvuTreePath(tree, segments.join('.'))
  if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
    delete (parent as Record<string, unknown>)[leaf]
  }
  // 修剪因回滚而空掉、且基线里本不存在的中间对象；被修剪的是最顶层段时
  // 宿主即树根本身（getMvuTreePath(tree, '') 不回根，需单独兜住——B-6a 撤销
  // 整树摘键依赖这一层；守卫回滚新增顶层键同理不再留 `{}` 残壳）
  while (segments.length > 0) {
    const pathSoFar = segments.join('.')
    const node = getMvuTreePath(tree, pathSoFar)
    if (node === null || typeof node !== 'object' || Array.isArray(node)) break
    if (Object.keys(node as Record<string, unknown>).length > 0) break
    if (getMvuTreePath(before, pathSoFar) !== undefined) break
    const popped = segments.pop()!
    const upper: unknown = segments.length > 0 ? getMvuTreePath(tree, segments.join('.')) : tree
    if (upper === null || typeof upper !== 'object' || Array.isArray(upper)) break
    delete (upper as Record<string, unknown>)[popped]
  }
}

/**
 * ST 侧结算守卫 pass（runGeneration 与 retryMvuSettlement 共用）：模板写穿完成、
 * 回执 diff 之前，对 `chat_metadata.variables` 做整树守卫——
 *
 * - schema 取自**基线**树根 `$schema`（卡 initialVariables / 世界书 InitialVariables
 *   回退，见 mvu-guard.ts readMvuSchema），杜绝本轮写穿自改守卫；
 * - diff 出叶子级变更逐路径 guardMvuWrite：clamp/step 调整值写回（进正常回执，
 *   reason 标注 guard），reject（type-mismatch / enum-violation / readonly /
 *   structure）把该路径回滚到基线值并记失败项（可重试）；
 * - 模板写穿改了根 `$schema` 本身 → 回滚 + readonly 失败项（守卫不可自改）；
 * - 无 schema（无 $schema 的卡）恒等返回，行为与 C-1 之前完全一致。
 */
export function applyMvuSettlementGuard(
  chat: ChatLogIR,
  card: CharacterCardIR | undefined,
  before: Record<string, unknown>,
): MvuGuardPassResult {
  const failures: string[] = []
  const notes: Record<string, string> = {}
  const metadata = chat.header.chat_metadata
  const variables = plainObject(metadata.variables)
  // schema 第一来源取基线树的 $schema（基线没有则回退卡/世界书声明，见 readMvuSchema）
  const schema = readMvuSchema(chat, card, before)
  if (schema === undefined || variables === undefined) return { failures, notes }

  const schemaBefore = plainObject(before.$schema)
  const schemaLive = plainObject(variables.$schema)
  if (!valuesEqual(schemaBefore, schemaLive)) {
    if (schemaBefore !== undefined) variables.$schema = deepClone(schemaBefore) as Record<string, unknown>
    else delete variables.$schema
    failures.push(`$schema: guard readonly: the schema subtree is card-declared and cannot be settled`)
  }

  for (const change of diffVariables(before, variables)) {
    const current = getMvuTreePath(before, change.name)
    const value = 'after' in change ? change.after : undefined
    const result = guardMvuWrite(schema, change.name, value, current)
    if (!result.ok) {
      revertMvuTreePath(variables, change.name, before)
      failures.push(`${change.name}: guard ${result.kind}: ${result.reason}`)
      continue
    }
    if (result.note !== undefined) notes[change.name] = result.note
    if (value !== undefined && !valuesEqual(result.value, value)) setMvuTreePath(variables, change.name, result.value)
  }
  // 基线为空且全部新增被回滚：保持「空树摘键」约定
  if (Object.keys(variables).length === 0 && Object.keys(before).length === 0) delete metadata.variables
  return { failures, notes }
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
  state: Pick<TavernState, 'activeWorlds' | 'activePersona' | 'scriptGlobals' | 'worldFollowsCharacter'>
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
 * （不 500）。根 `$schema`（C-1）/`$rules`（C-2）是契约不是变量，local/initial
 * 绑定前剥离，不进状态栏渲染。
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
      local: deepClone(stripMvuControl(plainObject(input.localVariables ?? readChatVariables(chat)) ?? {}) as JsonObject),
      global: { ...input.state.scriptGlobals },
      initial: deepClone(stripMvuControl(plainObject(chat.header.chat_metadata[INITIAL_VARIABLES_KEY]) ?? {}) as JsonObject),
    },
  )
  return await runtime.renderText(input.template, undefined, 'mvu-status')
}

/* ------------------------------ 结算重试 ------------------------------ */

export interface MvuRetryOptions {
  state: Pick<TavernState, 'activePersona' | 'activeWorlds' | 'scriptGlobals' | 'sessionBindings' | 'worldFollowsCharacter'>
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

  // $schema 写入守卫 pass（C-1，与 runGeneration 共用）：clamp 写回、reject 回滚，
  // 失败项并入回执 failures（重试仍不产生 'failed' 状态——既有约定，见上方注释）。
  const guard = applyMvuSettlementGuard(chat, character.card, before)
  // $rules 条件规则 pass（C-2，与 runGeneration 共用）：守卫后二次计算，规则产出
  // 再过一次守卫；失败/告警与规则 reason 同款并入回执（重试同样执行规则）。
  const rulesPass = await applyMvuSettlementRules(chat, character.card, before)
  const after = readChatVariables(chat)
  const changes = diffVariables(before, after)
  const notes = mergeMvuRuleNotes(guard.notes, rulesPass.notes)
  for (const change of changes) {
    if (notes[change.name] !== undefined) change.reason = notes[change.name]
  }
  const allFailures = [...failures, ...guard.failures, ...rulesPass.failures]
  const receipt: MvuReceipt = {
    at: new Date().toISOString(),
    turnKey: String(floorIndex),
    status: changes.length > 0 ? 'updated' : 'unchanged',
    changes,
    failures: allFailures,
  }
  appendMvuReceipt(chat, receipt)
  const revision = await db.saveChat(characterName, chatId, chat, snapshot.revision)
  return { receipt, revision, variables: stripMvuControl(after) as Record<string, unknown> }
}

/* --------------------- MVU 回执撤销（B-6a，2026-10-11） --------------------- */

/** 语义参考 LittleWhiteBox 的 keyed-changes undo 链（docs/exploration
 * 2026-10-11-jsr-lwb-reference.md §3.1/§4 B-6）：回执已存每项变更的前后值，
 * 撤销 = 把最新一条有效回执的每项变更恢复到 before 值。dsh 的 revision CAS
 * 是并发防护不是语义撤销——本节补的正是语义撤销层。v1 从严：只能撤销最新
 * 一条有效回执（newest-first 链），详见 decisions/2026-10-11-mvu-receipt-undo.md。 */

/** 单项恢复计划：value 缺省 = 该路径结算前不存在，撤销即删除。 */
export interface MvuUndoRestore {
  path: string
  value?: unknown
}

export type MvuUndoRefusalCode = 'NO_VALID_RECEIPT' | 'ALREADY_UNDONE' | 'INCOMPLETE_RECEIPT' | 'UNDO_REJECTED'

/** 撤销的语义性拒绝（HTTP 400 分类；并发冲突仍走 ChatRevisionConflictError）。 */
export class MvuUndoRefusalError extends Error {
  readonly undoCode: MvuUndoRefusalCode
  constructor(undoCode: MvuUndoRefusalCode, message: string) {
    super(message)
    this.name = 'MvuUndoRefusalError'
    this.undoCode = undoCode
  }
}

export interface MvuUndoTarget {
  index: number
  receipt: MvuReceipt
}

/**
 * 最新有效回执（newest-first 链头）：最后一个未标 undoneAt 的条目。撤销后它
 * 变为 undone，次新回执重新成为链头——撤销 N 轮 = 从最新往回逐次撤销，不会
 * 跳轮乱序恢复。
 */
export function latestValidMvuReceipt(receipts: MvuReceipt[]): MvuUndoTarget | undefined {
  for (let index = receipts.length - 1; index >= 0; index--) {
    if (receipts[index]!.undoneAt === undefined) return { index, receipt: receipts[index]! }
  }
  return undefined
}

function refuseUndo(target: MvuUndoTarget | undefined, receipts: MvuReceipt[]): MvuUndoTarget {
  if (target !== undefined) return target
  if (receipts.length > 0) {
    throw new MvuUndoRefusalError('ALREADY_UNDONE', `all ${receipts.length} settlement receipts in this chat have been undone; nothing valid is left to undo`)
  }
  throw new MvuUndoRefusalError('NO_VALID_RECEIPT', 'no MVU settlement receipt in this chat to undo')
}

/**
 * 从回执导出恢复计划（纯函数）：每项变更 → 恢复到 before 值（缺 before 的新增
 * 键 → 删除）。失败项从未落盘，天然不参与。数据完备性：change 既无 before 也无
 * after（老版本/手改数据），或 status 'updated' 却无变更记录 → 明确报「数据不
 * 完整」，不猜。
 */
export function planMvuUndoRestores(receipt: MvuReceipt): MvuUndoRestore[] {
  if (receipt.status === 'updated' && receipt.changes.length === 0) {
    throw new MvuUndoRefusalError('INCOMPLETE_RECEIPT', `receipt ${receipt.turnKey} claims status 'updated' but records no change data; the receipt data is incomplete and cannot be undone`)
  }
  const restores: MvuUndoRestore[] = []
  for (const change of receipt.changes) {
    if (!('before' in change) && !('after' in change)) {
      throw new MvuUndoRefusalError('INCOMPLETE_RECEIPT', `receipt change '${change.name}' records neither a before nor an after value; the receipt data is incomplete and cannot be undone`)
    }
    restores.push({ path: change.name, ...('before' in change ? { value: change.before } : {}) })
  }
  return restores
}

function formatRestoreValue(value: unknown): string {
  const text = (() => {
    try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
  })()
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/**
 * 撤销写入的守卫 pass（纯函数，与结算共用 guardMvuWrite 语义）：恢复值是历史
 * 合法值，过守卫应天然通过；万一被拒（schema 后来改了：类型/枚举/只读/结构）→
 * 整次撤销失败并如实报因，不动变量。守卫会调整值（clamp/step，同样是 schema
 * 漂移的信号）同样拒绝——撤销承诺精确恢复 before 值，不写任何「被调整过的
 * 恢复值」。$schema 路径无论有无 schema 恒拒（守卫契约不可经撤销写入）。
 */
export function screenMvuUndoRestores(
  schema: Record<string, unknown> | undefined,
  restores: MvuUndoRestore[],
  currentOf: (path: string) => unknown,
): void {
  const failures: string[] = []
  for (const restore of restores) {
    if (restore.path.split('.')[0] === '$schema') {
      failures.push(`$schema: guard readonly: the schema subtree is the declared guard contract and cannot be undone into`)
      continue
    }
    if (schema === undefined) continue
    const value = 'value' in restore ? restore.value : undefined
    const result = guardMvuWrite(schema, restore.path, value, currentOf(restore.path))
    if (!result.ok) {
      failures.push(`${restore.path}: guard ${result.kind}: ${result.reason}`)
      continue
    }
    if (!mvuValuesEqual(result.value, value)) {
      failures.push(`${restore.path}: guard would adjust the restored value ${formatRestoreValue(value)} to ${formatRestoreValue(result.value)} ($schema changed since the settlement); refusing to undo with anything other than the recorded before value`)
    }
  }
  if (failures.length > 0) throw new MvuUndoRefusalError('UNDO_REJECTED', failures.join('; '))
}

/**
 * 把恢复计划写进变量树（纯函数，mutates tree）：有 before 值的路径整值恢复
 * （深拷贝，不与回执数据共享引用），新增键删除并修剪因此空掉、且结算前本不
 * 存在的中间对象（复用守卫的 revertMvuTreePath 语义）。
 */
export function applyMvuUndoRestores(tree: Record<string, unknown>, restores: MvuUndoRestore[]): void {
  // 结算前伪树：全部 before 值按点分名还原，供删除路径判断中间对象是否本就存在
  const before = overlayScopedVariables({}, restores.flatMap((restore): Array<{ name: string; value: unknown }> =>
    'value' in restore ? [{ name: restore.path, value: deepClone(restore.value) }] : []))
  for (const restore of restores) revertMvuTreePath(tree, restore.path, before)
}

/** 把回执标为 undone（幂等防重由 latestValidMvuReceipt 保证——已 undone 的不再是链头）。 */
function markMvuReceiptUndone(chat: ChatLogIR, index: number, at?: string): MvuReceipt {
  const receipts = readMvuReceipts(chat)
  const marked: MvuReceipt = { ...receipts[index]!, undoneAt: at ?? new Date().toISOString() }
  const next = receipts.slice()
  next[index] = marked
  chat.header.chat_metadata.mvu = { receipts: next }
  return marked
}

export interface MvuUndoOptions {
  characterName: string
  chatId: string
  snapshot: ChatSnapshot
  at?: string
}

export interface MvuUndoResult {
  /** 标记 undoneAt 后的回执（写回聊天的那份）。 */
  receipt: MvuReceipt
  revision: string
  restores: MvuUndoRestore[]
}

/**
 * ST 侧撤销执行核（POST mvu/receipts/undo 的薄挂接）：恢复值写回
 * `chat_metadata.variables`，回执标 undoneAt，saveChat CAS 冲突抛
 * ChatRevisionConflictError（语义性拒绝抛 MvuUndoRefusalError）。chat-saved
 * 事件由路由侧发射（与 guides/retry 写路径同纪律）。
 */
export async function undoMvuStSettlement(
  db: Pick<TavernStore, 'getCharacter' | 'saveChat'>,
  options: MvuUndoOptions,
): Promise<MvuUndoResult> {
  const { characterName, chatId, snapshot } = options
  const chat = snapshot.chat
  const receipts = readMvuReceipts(chat)
  const target = refuseUndo(latestValidMvuReceipt(receipts), receipts)
  const restores = planMvuUndoRestores(target.receipt)
  const metadata = chat.header.chat_metadata
  const variables = plainObject(metadata.variables) ?? {}
  screenMvuUndoRestores(readMvuSchema(chat, (await db.getCharacter(characterName))?.card, variables), restores, (path) => getMvuTreePath(variables, path))
  applyMvuUndoRestores(variables, restores)
  // 空树摘键：与结算侧「无变量不写 mvu/variables 键」的导出约定一致
  if (Object.keys(variables).length === 0) delete metadata.variables
  else metadata.variables = variables
  const marked = markMvuReceiptUndone(chat, target.index, options.at)
  const revision = await db.saveChat(characterName, chatId, chat, snapshot.revision)
  return { receipt: marked, revision, restores }
}

/**
 * AgentTavern 侧撤销执行核：settle 把变量写进 chat 作用域 VariableStore（扁平
 * 点分名），撤销写回同一存储——有 before 值的路径恢复（flat 条目存在则 CAS 更
 * 新，不存在且播种树也已同值则免写），新增键删除。「当前值」与 settle 的 before
 * 同源（flat 既有值 ?? 聊天播种树）。回执与守卫的读写与 ST 共用同一纯函数核；
 * 回执标记仍落 chat_metadata.mvu.receipts + saveChat CAS。
 */
export async function undoMvuAgentSettlement(
  variables: Pick<VariableStore, 'get' | 'patch' | 'delete'>,
  db: Pick<TavernStore, 'getCharacter' | 'saveChat'>,
  options: MvuUndoOptions,
): Promise<MvuUndoResult> {
  const { characterName, chatId, snapshot } = options
  const chat = snapshot.chat
  const receipts = readMvuReceipts(chat)
  const target = refuseUndo(latestValidMvuReceipt(receipts), receipts)
  const restores = planMvuUndoRestores(target.receipt)
  const seedTree = readChatVariables(chat)
  const storeFailures: string[] = []
  const entries = new Map<string, Awaited<ReturnType<typeof variables.get>>>()
  for (const restore of restores) {
    try {
      entries.set(restore.path, await variables.get('chat', chatId, restore.path))
    } catch (error) {
      storeFailures.push(`${restore.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (storeFailures.length > 0) throw new MvuUndoRefusalError('UNDO_REJECTED', storeFailures.join('; '))
  screenMvuUndoRestores(
    readMvuSchema(chat, (await db.getCharacter(characterName))?.card),
    restores,
    (path) => {
      const entry = entries.get(path)
      return entry !== undefined ? entry.value : getMvuTreePath(seedTree, path)
    },
  )
  // 删除先行：任何一项 CAS 冲突都在写入恢复值之前抛出（patch 后续整体不执行）
  for (const restore of restores) {
    if ('value' in restore) continue
    const entry = entries.get(restore.path)
    if (entry !== undefined) await variables.delete('chat', chatId, restore.path, entry.revision)
  }
  // 恢复值单文件原子 patch（chat 作用域全量在一个 json）；有效值已同值的路径免写
  const updates: VariableChange[] = []
  for (const restore of restores) {
    if (!('value' in restore)) continue
    const entry = entries.get(restore.path)
    const current = entry !== undefined ? entry.value : getMvuTreePath(seedTree, restore.path)
    if (current !== undefined && mvuValuesEqual(current, restore.value)) continue
    updates.push({ name: restore.path, value: deepClone(restore.value) as VariableChange['value'], ...(entry !== undefined ? { expectedRevision: entry.revision } : {}) })
  }
  if (updates.length > 0) await variables.patch('chat', chatId, updates)
  const marked = markMvuReceiptUndone(chat, target.index, options.at)
  const revision = await db.saveChat(characterName, chatId, chat, snapshot.revision)
  return { receipt: marked, revision, restores }
}
