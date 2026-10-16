/**
 * 宿主原生会话分叉的 AgentTavern 收养（decisions/2026-10-11-agent-tavern-host-fork）。
 *
 * DSH `sessions.fork(source, boundary?)` 的子会话继承包含切点的精确事件前缀：
 * 宿主侧身份（agent-preset/selected marker、原生 composer、锚定 cadence）天然
 * 延续，断的是插件侧状态——`sessionBindings[childId]` 不存在则 22 个域工具的
 * bindingFor 全部抛错、facts/guides/context 段空装配、投影器跳过。本模块在
 * `agent/created`（宿主串行事件，announce 先于 loop start 被 await）上把分叉
 * 子会话收养成完整 AgentTavern 会话：物化 fork 聊天（header 克隆 + 谱系标记 +
 * 回链）、拷贝 chat 作用域变量/记忆/向量、按父 contextMode 落绑定，随后由调用
 * 方 fire-and-forget 地 replay 投影回填楼层。
 *
 * 失败纪律：调用方（index.ts 的 agent/created 监听）必须整体 try/catch——串行
 * listener 的 rejection 会炸掉宿主 agent 创建。本函数自身对「非目标会话」静默
 * 返回 'skipped'，对可诊断的异常路径（父聊天缺失等）warn 一行后跳过，不抛出。
 */
import { hostSessionForkInfo, type HostSessionLog } from '../../../bind/src/index.js'
import type { ChatLogIR } from '../../../tavern-format/src/index.js'
import type { MemoryRecord, MemoryVectorEntry, TavernState, VariableSnapshot } from '../../../tavern-store/src/index.js'

export type ForkAdoptionOutcome = 'adopted' | 'skipped' | 'bound'

/** 收养所需的最小 store 面（真实 TavernStore 的结构子集，测试可替身）。 */
export interface ForkStoreLike {
  getState(): Promise<Pick<TavernState, 'sessionBindings'>>
  listChats(character: string): Promise<string[]>
  getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR; revision: string } | undefined>
  forkChat(character: string, parentChatId: string, fork: {
    sessionId: string
    parentSessionId: string
    bookmarkMessageId?: number
  }): Promise<{ chatId: string }>
}

export interface ForkVariablesLike {
  listAll(scope: 'chat', scopeId: string): Promise<VariableSnapshot[]>
  patch(scope: 'chat', scopeId: string, changes: ReadonlyArray<{ name: string; value: unknown }>): Promise<unknown>
}

export interface ForkMemoriesLike {
  list(scope: 'chat', scopeId: string): Promise<MemoryRecord[]>
  read(id: string, scope: 'chat', scopeId: string, includeDeleted?: boolean): Promise<MemoryRecord | undefined>
  put(input: {
    id?: string
    scope: 'chat'
    scopeId: string
    kind: MemoryRecord['kind']
    content: string
    tags?: string[]
    importance?: number
    confidence?: number
    source: MemoryRecord['source']
    expiresAt?: string
  }): Promise<unknown>
}

export interface ForkVectorsLike {
  list(scope?: 'chat', scopeId?: string): Promise<MemoryVectorEntry[]>
  put(entries: readonly MemoryVectorEntry[]): Promise<void>
}

export interface ForkAdoptionDependencies {
  store: ForkStoreLike
  /** index.ts 的 bindSession：继承 contextMode、世界书跟随与 activeCharacter 语义与正常激活一致。 */
  bind: (sessionId: string, character: string, chatId: string, contextMode: string) => Promise<unknown>
  variables: ForkVariablesLike
  memories?: ForkMemoriesLike
  vectors?: ForkVectorsLike
  logger?: { info?: (message: string) => unknown; warn?: (message: string) => unknown }
}

/** 同会话并发收养（agent/created 与重放等多触发面）的进程内串行化。 */
const forkAdoptionTails = new Map<string, Promise<ForkAdoptionOutcome>>()

/**
 * 收养一个宿主 fork 子会话。幂等：已绑定返回 'bound'；非 fork / subagent /
 * 非 AgentTavern 父会话返回 'skipped' 且不落任何状态。成功路径落齐聊天、
 * 作用域拷贝与绑定后返回 'adopted'——调用方再行 replay 与投影预热。
 */
export function adoptAgentTavernFork(
  session: (HostSessionLog & { id?: unknown }) | null | undefined,
  deps: ForkAdoptionDependencies,
): Promise<ForkAdoptionOutcome> {
  const sessionId = typeof session?.id === 'string' ? session.id : undefined
  if (sessionId === undefined || sessionId === '') return Promise.resolve('skipped')
  const previous = forkAdoptionTails.get(sessionId)
  if (previous) return previous
  const current = adoptOne(sessionId, session, deps).finally(() => {
    if (forkAdoptionTails.get(sessionId) === current) forkAdoptionTails.delete(sessionId)
  })
  forkAdoptionTails.set(sessionId, current)
  return current
}

async function adoptOne(
  sessionId: string,
  session: HostSessionLog & { id?: unknown },
  deps: ForkAdoptionDependencies,
): Promise<ForkAdoptionOutcome> {
  const info = hostSessionForkInfo(session)
  if (info === undefined) return 'skipped'

  const state = await deps.store.getState()
  if (state.sessionBindings[sessionId] !== undefined) return 'bound'

  const parent = state.sessionBindings[info.parentSession]
  if (parent === undefined || parent.architecture !== 'agent-tavern' || parent.group === true) {
    // ST/AgentNovel/CardWorkbench 的宿主 fork 与 subagent 一样不在收养面
    // （决策 §4）：一行 info 留诊断痕迹，行为与收养能力落地前一致。
    deps.logger?.info?.(`dsh-soulmojito: host session fork '${sessionId}' skipped (parent '${info.parentSession}' is not an AgentTavern binding)`)
    return 'skipped'
  }

  const character = parent.character
  const parentSnapshot = await deps.store.getChatSnapshot(character, parent.chatId)
  if (parentSnapshot === undefined) {
    deps.logger?.warn?.(`dsh-soulmojito: host session fork '${sessionId}' not adopted (parent chat '${character}/${parent.chatId}' is missing)`)
    return 'skipped'
  }

  // 崩溃恢复：收养半途中断（聊天已物化、绑定未落）会留下带谱系标记的孤儿
  // 聊天；按 agentTavernFork.sessionId 复用而不是再建一个。
  let chatId = await findExistingForkChat(deps.store, character, sessionId)
  if (chatId === undefined) {
    const boundarySeq = info.inheritedEventCount === undefined ? undefined : info.inheritedEventCount - 1
    chatId = (await deps.store.forkChat(character, parent.chatId, {
      sessionId,
      parentSessionId: info.parentSession,
      bookmarkMessageId: forkBookmarkMessageId(parentSnapshot.chat, info.parentSession, boundarySeq),
    })).chatId
  }

  await copyChatVariables(deps.variables, parent.chatId, chatId)
  await copyChatMemories(deps, parent.chatId, chatId)

  await deps.bind(sessionId, character, chatId, parent.contextMode)
  deps.logger?.info?.(`dsh-soulmojito: adopted host session fork '${sessionId}' from '${info.parentSession}' into chat '${character}/${chatId}'`)
  return 'adopted'
}

/** fork 命名后缀（与 branchChat 的 ` - branch N` 同款规则）；恢复扫描只看这些。 */
const FORK_CHAT_SUFFIX = / - fork \d+\.jsonl$/

async function findExistingForkChat(store: ForkStoreLike, character: string, sessionId: string): Promise<string | undefined> {
  let candidates: string[]
  try {
    candidates = (await store.listChats(character)).filter((chatId) => FORK_CHAT_SUFFIX.test(chatId))
  } catch {
    return undefined
  }
  for (const chatId of candidates) {
    const snapshot = await store.getChatSnapshot(character, chatId).catch(() => undefined)
    const fork = snapshot?.chat.header?.chat_metadata?.agentTavernFork as Record<string, unknown> | undefined
    if (fork?.sessionId === sessionId) return chatId
  }
  return undefined
}

/**
 * 回链楼层：父聊天中 eventSeq ≤ 分叉边界的最后一条投影消息下标。父会话在
 * fork 后继续推进时，回链必须指向切点而不是父聊天末尾；没有可辨认的投影
 * 消息时返回 undefined（forkChat 退化为末条——回链是展示性元数据）。
 */
function forkBookmarkMessageId(chat: ChatLogIR, parentSessionId: string, boundarySeq: number | undefined): number | undefined {
  const messages = chat.messages
  if (messages.length === 0) return undefined
  if (boundarySeq === undefined) return messages.length - 1
  let last = -1
  for (const [index, message] of messages.entries()) {
    const origin = message.extra?.agentTavern as Record<string, unknown> | undefined
    if (origin?.sessionId !== parentSessionId) continue
    const seq = origin.eventSeq
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && seq <= boundarySeq) last = index
  }
  return last === -1 ? undefined : last
}

/** chat 作用域变量拷贝：逐项 {name, value}（revision 在子作用域各自新生）。 */
async function copyChatVariables(variables: ForkVariablesLike, parentChatId: string, chatId: string): Promise<void> {
  const snapshots = await variables.listAll('chat', parentChatId)
  if (snapshots.length === 0) return
  await variables.patch('chat', chatId, snapshots.map((snapshot) => ({ name: snapshot.name, value: snapshot.value })))
}

/**
 * chat 作用域记忆 + 向量拷贝。source 保留父会话谱系（记忆的事实来源是它被
 * 写下时的会话，跨 fork 不改写——与 git blame 同理）；digest 是
 * [model, content] 的 SHA-256，内容未变则向量可原样迁移，零 embed HTTP。
 * 记录缺失（list 失败）只降级为无记忆继承，不阻断收养。
 */
async function copyChatMemories(deps: ForkAdoptionDependencies, parentChatId: string, chatId: string): Promise<void> {
  if (deps.memories === undefined) return
  let records: MemoryRecord[]
  try {
    records = await deps.memories.list('chat', parentChatId)
  } catch (error) {
    deps.logger?.warn?.(`dsh-soulmojito: fork memory copy skipped for '${chatId}' (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  for (const record of records) {
    // 幂等重跑（收养半途中断后恢复）：MemoryStore.put 对已存在的 id 无
    // expectedRevision 必抛冲突——已拷贝的记录直接跳过，未拷贝的继续。
    if (await deps.memories.read(record.id, 'chat', chatId, true) !== undefined) continue
    await deps.memories.put({
      id: record.id,
      scope: 'chat',
      scopeId: chatId,
      kind: record.kind,
      content: record.content,
      tags: record.tags,
      importance: record.importance,
      confidence: record.confidence,
      source: record.source,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    })
  }
  if (deps.vectors === undefined) return
  try {
    const entries = await deps.vectors.list('chat', parentChatId)
    if (entries.length > 0) {
      await deps.vectors.put(entries.map((entry) => ({ ...entry, scopeId: chatId })))
    }
  } catch (error) {
    deps.logger?.warn?.(`dsh-soulmojito: fork vector copy skipped for '${chatId}' (${error instanceof Error ? error.message : String(error)})`)
  }
}
