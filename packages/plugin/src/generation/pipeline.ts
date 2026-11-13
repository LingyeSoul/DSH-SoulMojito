import { RegexPlacement, parsePreset } from '../../../tavern-format/src/index.js'
import type { ChatLogIR, ChatMessage, CharacterCardIR, GroupIR, PresetIR, RegexScriptIR } from '../../../tavern-format/src/index.js'
import { activateWorldInfo, bookRef } from '../../../tavern-lore/src/index.js'
import type { ActivationResult, TimedEffectsState } from '../../../tavern-lore/src/index.js'
import { createMacroEngine } from '../../../tavern-macros/src/index.js'
import { assemblePrompt, buildGroupTurn, pickGroupMember } from '../../../tavern-pipeline/src/index.js'
import type { AssembleInput, DepthInjection, LlmMessage } from '../../../tavern-pipeline/src/index.js'
import { applyRegexScript, applyRegexScripts, runScript } from '../../../tavern-script/src/index.js'
import type { ScriptEnv } from '../../../tavern-script/src/index.js'
import { ChatRevisionConflictError, boundScriptOf, formatScriptBlock, getScript, isChatRevisionConflict, normalizeMemoryEmbedding, normalizeScriptProgress, shouldAdvance, worldInfoSettingsOf } from '../../../tavern-store/src/index.js'
import type { CharacterFile, ChatSnapshot, Persona, TavernState, TavernStore } from '../../../tavern-store/src/index.js'
import { defaultPreset } from '../agent-tavern/preset.js'
import { isGroupChat } from '../assets.js'
import { DATA_BANK_ST_BLOCK_CHARS, dataBankIdsOf, formatDataBankBlock, searchDataBank, selectVectorizedLoreEntries } from '../data-bank.js'
import { tavernDataRoot } from '../dsh-home.js'
import { generationHooks, type GenerationLlmRequestPayload, type GenerationMode } from '../generation-hooks.js'
import { formatGuidesBlock } from '../guides.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from '../http/io.js'
import { publicError } from '../http/public-error.js'
import type { HostAgentLike, PluginContext } from '../host-contract.js'
import { createMessage } from '../message.js'
import { beginStreamEpoch, emitChatSaved, emitStreamDelta } from '../mods/events.js'
import { applyMvuSettlementGuard, readChatVariables, recordMvuTurnReceipt, snapshotChatVariables } from '../mvu.js'
import { applyMvuSettlementRules, mergeMvuRuleNotes } from '../mvu-rules.js'
import { DEFAULT_USER, presetSamplerValue } from '../prompt-context.js'
import { recordPromptView } from '../prompt-viewer.js'
import { findQuickReplySet, quickReplyScript, quickReplySetsForAutomation } from '../quick-replies.js'
import { formatRewriteBlock, optionalFeedback } from '../rewrite.js'
import { templatesEnabledFlagValue, templatesEnvEnabled } from '../runtime.js'
import { assertStGenerationBinding } from '../session/binding.js'
import { checkpointChatFile } from '../session/store.js'
import { beginTavernSessionTurn, finishTavernSessionTrace, recordTavernSessionAssistant, startTavernSessionStep } from '../session/trace.js'
import { collectWorldInfoBooks } from '../tavern-assets.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { createGenerationTemplates, mergeTemplateLocalVars, type GenerationTemplates } from '../template.js'
import { stageChatVariables } from '../variable-gateway.js'

// ST generation has no client handle to the in-flight LLM stream. The composer
// can send `/stop` in a separate request while `/generate` is still running, so
// the controller is registered by chat and resolved by the slash command.
const activeStGeneration = new Map<string, AbortController>()

function stGenerationKey(character: string, chatId: string): string {
  return `${character}\u0000${chatId}`
}

export function abortStGeneration(character: string, chatId: string): boolean {
  const controller = activeStGeneration.get(stGenerationKey(character, chatId))
  if (controller === undefined) return false
  controller.abort()
  return true
}

export async function generate(ctx: PluginContext, req: HttpRequest, res: HttpResponse, db: TavernStore): Promise<void> {
  const body = await readJson(req)
  const state = await db.getState()
  assertStGenerationBinding(state, body.sessionId)
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  const userText = typeof body.message === 'string' ? body.message.trim() : ''
  // 生成动词白名单（契约 §2.1）：未知值明确报错，不静默回落 send。`trigger` 只是
  // STscript 内部相位（/trigger），不接受 HTTP 直传。
  const rawMode: unknown = body.mode === undefined ? 'send' : body.mode
  const allowedModes: readonly GenerationMode[] = ['send', 'regenerate', 'continue', 'impersonate']
  if (typeof rawMode !== 'string' || !allowedModes.some((allowed) => allowed === rawMode)) {
    throw new Error(`unsupported generation mode: ${typeof rawMode === 'string' ? rawMode : String(rawMode)}`)
  }
  // some() 谓词不窄化；此处 rawMode 已确认属于白名单。
  const mode = rawMode as GenerationMode
  // 带意见重写（提案 0011）：feedback 仅 regenerate 可携带；空串等价普通重掷。
  let feedback: string | undefined
  if (mode === 'regenerate') feedback = optionalFeedback(body.feedback)
  else if (body.feedback !== undefined) throw new Error('feedback is only allowed when mode is regenerate')
  if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
  if (mode === 'send' && userText === '') throw new Error('message is empty')
  if (typeof body.revision !== 'string') throw new Error('revision is required')
  const bindingGroup = body.group === true || await isGroupChat(db, characterName, chatId)
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  if (!snapshot) throw new Error('character or chat not found')
  if (body.revision !== snapshot.revision) {
    throw new ChatRevisionConflictError(body.revision, snapshot.revision)
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  const ac = new AbortController()
  req.on?.('aborted', () => ac.abort())
  res.on?.('close', () => { if (!res.writableEnded) ac.abort() })
  activeStGeneration.set(stGenerationKey(characterName, chatId), ac)
  const write = (event: Record<string, unknown>): void => { res.write(JSON.stringify(event) + '\n') }

  try {
    const result = await runGeneration(ctx, db, {
      state,
      characterName,
      chatId,
      snapshot,
      mode,
      userText,
      feedback,
      group: bindingGroup,
      triggerMember: typeof body.triggerMember === 'string' ? body.triggerMember : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
      write,
      signal: ac.signal,
      hostAgent: typeof body.sessionId === 'string' ? ctx.agents?.get?.(body.sessionId) ?? undefined : undefined,
    })
    write({ type: 'saved', chat: result.chat, revision: result.revision })
    res.end()
  } catch (error) {
    if (!res.writableEnded) {
      const message = error instanceof Error ? error.message : String(error)
      const code = isChatRevisionConflict(error) ? error.code : undefined
      write({ type: 'error', message, code })
      res.end()
    }
  } finally {
    const key = stGenerationKey(characterName, chatId)
    if (activeStGeneration.get(key) === ac) activeStGeneration.delete(key)
  }
}

/**
 * 试写预览（D-4 生成不入楼，决策 2026-10-11-preview-generation.md）：以当前聊天
 * 快照 + 临时拼接的 userText 走与 runGeneration 完全相同的装配路径（发言者
 * 解析 / preset / persona / 世界书 / 模板 / 宏 / 模型选择推导，见
 * resolveGenerationSpeaker + buildGenerationLlmRequest），同步收集一次 LLM 生成。
 *
 * 零副作用（逐项见决策文档与 preview-generation.spec.ts）：不 saveChat（装配期的
 * timedWorldInfo / scriptProgress / 模板变量写全部落在 structuredClone 的工作副本
 * 上）、无 MVU 结算/回执、无 swipe、不发 chat-saved / stream-delta、不记
 * prompt-viewer、不写宿主 session、五相位 hook 全部不跑（onDraft/onLlmRequest 不
 * 注入；user-input / post-output / post-save 在 runGeneration 体内，preview 不经
 * 过）。preview 是只读快照——与同一聊天的真实生成可并存，preview 自身也不限并发。
 *
 * 模型：取绑定该聊天的 ST 会话的会话级模型选择（sessionBindings 命中
 * character+chatId 且 architecture 'st'），未命中回落部署默认——与 composer
 * 未选模型时同款。
 */
export async function previewGeneration(ctx: PluginContext, req: HttpRequest, res: HttpResponse, db: TavernStore): Promise<void> {
  const body = await readJson(req)
  const state = await db.getState()
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  const userText = typeof body.userText === 'string' ? body.userText.trim() : ''
  if (!characterName || typeof chatId !== 'string') {
    return sendJson(res, 400, { ok: false, message: 'character and chatId are required' })
  }
  if (userText === '') return sendJson(res, 400, { ok: false, message: 'userText is empty' })
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  if (!snapshot) return sendJson(res, 404, { ok: false, message: 'character or chat not found' })
  const group = body.group === true || await isGroupChat(db, characterName, chatId)
  // 中止透传（与 generate 同款）：客户端断开即 abort，llm.stream 及时停。
  const ac = new AbortController()
  req.on?.('aborted', () => ac.abort())
  res.on?.('close', () => { if (!res.writableEnded) ac.abort() })

  // 工作副本：装配会写 timedWorldInfo / scriptProgress / 模板变量，全落在这份
  // 克隆上，永不 saveChat。
  const chat = structuredClone(snapshot.chat)
  const userName = state.activePersona ?? DEFAULT_USER
  const { speakerName, groupDef, nudge, turnMessages: initialTurnMessages } = await resolveGenerationSpeaker(db, state, {
    characterName,
    chat,
    mode: 'send',
    group,
  })
  const character = await db.getCharacter(speakerName)
  if (!character) throw new Error(`character '${speakerName}' not found`)
  // 临时用户楼层：USER_INPUT regex 是装配的一部分（确定性本地变换）照走；user-input
  // hook 是 mod 副作用面，跳过（与 runGeneration 的差异项，见决策文档）。
  const scripts = await collectSessionRegexScripts(db, state, characterName, chatId, character)
  const transformed = applyRegexScripts(userText, scripts, RegexPlacement.USER_INPUT, { expand: (t) => t })
  chat.messages.push({ name: userName, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: transformed })
  const turnMessages = group ? rebuildGroupTurn(groupDef, speakerName, userName, chat.messages) : initialTurnMessages

  // 会话级模型选择：绑定该聊天的 ST 会话（多会话绑同一聊天时取首个有选择的）。
  const boundSessions = Object.entries(state.sessionBindings ?? {})
    .filter(([, binding]) => binding?.architecture === 'st' && binding.character === characterName && binding.chatId === chatId)
    .map(([id]) => id)
  const sessionId = boundSessions.find((id) => state.modelSelections?.[id] !== undefined)

  try {
    const assembly = await buildGenerationLlmRequest(ctx, db, {
      state,
      speakerName,
      character,
      chatId,
      chat,
      turnMessages,
      nudge,
      group,
      ...(groupDef !== undefined ? { groupDef } : {}),
      phase: 'send',
      scripts,
      userName,
      ...(sessionId !== undefined ? { sessionId } : {}),
    })
    const request = assembly.request
    let text = ''
    let usage
    let finish
    for await (const chunk of ctx.llm.stream({
      provider: request.params.provider,
      model: request.params.model,
      messages: request.messages,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.params.reasoningEffort !== undefined ? { reasoningEffort: request.params.reasoningEffort } : {}),
      temperature: request.params.temperature,
      maxTokens: request.params.maxTokens,
      ...hostSamplingParams(request.params),
      signal: ac.signal,
    })) {
      if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure?.message ?? 'model stream failed')
        finish = chunk.reason.kind
      }
    }
    if (!res.writableEnded) {
      return sendJson(res, 200, {
        ok: true,
        text,
        provider: request.params.provider,
        model: request.params.model,
        ...(usage !== undefined ? { usage } : {}),
        ...(finish !== undefined ? { finish } : {}),
      })
    }
  } catch (error) {
    if (!res.writableEnded) {
      const failure = publicError(error, { operation: 'preview-generation', logger: ctx.logger })
      return sendJson(res, failure.status, {
        ok: false,
        message: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      })
    }
  }
}

export interface GenerationOptions {
  state: TavernState
  characterName: string
  chatId: string
  snapshot: ChatSnapshot
  /**
   * send=追加用户消息；regenerate=弹出旧回复重掷；trigger=按现状生成（STscript
   * /trigger）；continue=不增楼、续写末条 assistant 的 mes 与当前 swipe；
   * impersonate=以 {{user}} 身份生成一条 is_user 楼层（契约 §2.1）。
   */
  mode: GenerationMode
  userText: string
  /** regenerate 专用：带意见重写（提案 0011）；非 regenerate 不允许携带。 */
  feedback?: string
  group: boolean
  triggerMember?: string
  sessionId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  write: (event: Record<string, unknown>) => void
  signal: AbortSignal
  hostAgent?: HostAgentLike
}

/* ------------- 装配共享助手（runGeneration 与 D-4 试写预览 preview 共用） ------------- */

/**
 * 群聊发言者 / nudge 解析（原 runGeneration 首段提取；D-4 试写预览复用）。
 * 纯读取：不写任何聊天/状态文件。turn/nudge 基于调用方传入的当前 messages
 * （send 语义：本轮用户消息尚未 push）；调用方随后的 push/pop 自行重建回合视图
 * （rebuildGroupTurn）。
 */
export async function resolveGenerationSpeaker(
  db: TavernStore,
  state: TavernState,
  options: {
    characterName: string
    chat: ChatLogIR
    mode: GenerationMode
    group: boolean
    triggerMember?: string
  },
): Promise<{
  speakerName: string
  groupDef: GroupIR | undefined
  turnMessages: ChatMessage[]
  nudge: { role: 'user'; content: string } | undefined
}> {
  const { characterName, chat, mode, group, triggerMember } = options
  if (!group) {
    return { speakerName: characterName, groupDef: undefined, turnMessages: chat.messages, nudge: undefined }
  }
  const groupDef = await db.getGroup(characterName)
  if (!groupDef) throw new Error(`group '${characterName}' not found`)
  const chatGroup = asRecord(chat.header.chat_metadata?.group)
  const chatMembers = stringArray(chatGroup?.['members'])
  const members = chatMembers !== undefined && chatMembers.length > 0 ? chatMembers : groupDef.members
  const disabled = stringArray(chatGroup?.['disabledMembers']) ?? groupDef.disabledMembers
  const lastSpeaker = [...chat.messages].reverse().find((m) => !m.is_user && !m.is_system)?.name
  const talkativeness = new Map<string, number>()
  for (const member of members) {
    const file = await db.getCharacter(member)
    const extensions = asRecord(file?.card?.data?.extensions)
    const raw = extensions?.['talkativeness']
    talkativeness.set(member, typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0.5)
  }
  const speakerName = triggerMember
    ?? (mode === 'regenerate' || mode === 'continue'
      ? (lastSpeaker !== undefined && members.includes(lastSpeaker) ? lastSpeaker : undefined)
      : undefined)
    ?? pickGroupMember({
      strategy: groupDef.activationStrategy,
      members,
      disabled,
      talkativeness: (member) => talkativeness.get(member) ?? 0.5,
      lastSpeaker,
      allowSelfResponses: groupDef.allowSelfResponses,
    })
  if (!speakerName || !members.includes(speakerName)) throw new Error('no eligible group member to reply')
  const rawNudge = await presetSamplerValue(db, state, 'group_nudge_prompt')
  const turn = buildGroupTurn({
    speaker: speakerName,
    members,
    userName: state.activePersona ?? DEFAULT_USER,
    messages: chat.messages,
    ...(typeof rawNudge === 'string' && rawNudge.trim() !== '' ? { groupNudgePrompt: rawNudge } : {}),
  })
  return { speakerName, groupDef, turnMessages: turn.messages, nudge: turn.nudge }
}

/** send 落用户消息 / regenerate 弹出旧回复后，重建群聊回合视图（不带 nudge）。 */
export function rebuildGroupTurn(
  groupDef: GroupIR | undefined,
  speakerName: string,
  userName: string,
  messages: ChatMessage[],
): ChatMessage[] {
  return buildGroupTurn({
    speaker: speakerName,
    members: groupDef?.members ?? [speakerName],
    userName,
    messages,
  }).messages
}

export interface GenerationAssemblyOptions {
  state: TavernState
  speakerName: string
  character: CharacterFile
  chatId: string
  /** 工作副本（装配会写 timedWorldInfo / scriptProgress / 模板变量；调用方决定是否落盘）。 */
  chat: ChatLogIR
  turnMessages: ChatMessage[]
  nudge: { role: 'user'; content: string } | undefined
  group: boolean
  groupDef?: GroupIR
  /** 相位：lore 激活 trigger 与 hook 上下文的 mode。 */
  phase: GenerationMode
  scripts: RegexScriptIR[]
  userName: string
  feedback?: string
  sessionId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  /**
   * 世界书条目 automationId 命中的快速回复集合（契约 §2.6）是否在本轮装配中
   * 执行。runGeneration 传 true；试写预览不传——preview 承诺零副作用，脚本写
   * 变量/全局即副作用，因此不进 preview。
   */
  worldInfoAutomations?: boolean
  /** pre-assemble 相位 seam：runGeneration 注入 generationHooks.dispatch；试写预览不传（hook 全跳过）。 */
  onDraft?: (draft: AssembleInput) => AssembleInput | Promise<AssembleInput>
  /** pre-llm 相位 seam：同上。 */
  onLlmRequest?: (request: GenerationLlmRequestPayload) => GenerationLlmRequestPayload | Promise<GenerationLlmRequestPayload>
}

/**
 * 装配 + LLM 请求构造（原 runGeneration 中段提取；D-4 试写预览复用）。
 * preset/persona/世界书激活/模板/宏/persona 位置/示例块/@Depth 注入/群聊
 * nudge/assemblePrompt/模型选择推导（explicit ?? saved ?? fallback，与
 * candidates.ts 同语义）/剧本块/system 段提取（含 guides 与重写意见块）全部
 * 在内，出口是进 llm.stream 的最终请求。副作用边界：只写传入的 chat 工作副本
 * 与 tpl 内部状态，不 saveChat、不发事件、不记 prompt-viewer；pre-assemble /
 * pre-llm 两相位 hook 经 seam 由调用方决定（runGeneration 注入总线，试写预览
 * 不注入——mod 副作用不可控，v1 如实跳过）。
 */
export async function buildGenerationLlmRequest(
  ctx: PluginContext,
  db: TavernStore,
  options: GenerationAssemblyOptions,
): Promise<{
  request: GenerationLlmRequestPayload
  lore: ReturnType<typeof activateWorldInfo>
  tpl: GenerationTemplates | null
  macros: ReturnType<typeof createMacroEngine>
  templateGlobalsBefore: string | undefined
  /**
   * Template-owned copy of state.scriptGlobals (the template runtime writes it
   * in place); runGeneration compares it with `templateGlobalsBefore` and
   * persists the diff.
   */
  templateGlobals: Record<string, string | number | boolean> | undefined
  start: {
    provider: string
    model: string
    speaker: string
    lore: Array<{ uid: number; book: string; comment: string | undefined }>
    stats: { promptTokens: number; historyKept: number; historyDropped: number }
  }
}> {
  const { state, speakerName, character, chatId, chat, turnMessages, nudge, groupDef, scripts, userName } = options

  // ---- 预设 / persona / 世界书 ----
  const presetName = state.activePreset
  let presetObject = presetName ? await db.getPreset(presetName) : undefined
  if (!presetObject) presetObject = defaultPreset()
  const preset = parsePreset(presetObject)
  const persona = state.activePersona ? await db.getPersona(state.activePersona) : undefined

  const books = await collectWorldInfoBooks(db, state, speakerName, character, chatId)
  const dataRoot = tavernDataRoot()
  const embeddingConfig = normalizeMemoryEmbedding(state.memoryEmbedding)
  // 最近一条用户消息是查询源（ST 的向量检索口径）：世界书 vectorized 预检索与
  // 数据银行附件注入共用同一条 query。
  const latestUserText = [...turnMessages].reverse().find((message) => message.is_user === true)?.mes ?? ''
  // ---- vectorized 世界书预检索（Wave 2 §2.6）----
  // 引擎是同步的：这类条目只认 `vectorHits`，不参与关键词匹配。异步 embed 只能
  // 在调用方做——条目 id 必须与引擎的稳定 id 同构（`${bookLabel}.${uid}`），
  // 所以这里用 bookRef 生成同样的 label，而不是自己拼书名。
  const vectorizedEntries = books.flatMap((book, index) => {
    const label = bookRef(book, index).label
    return book.entries
      .filter((entry) => entry.vectorized === true && entry.constant !== true)
      .map((entry) => ({
        entryId: `${label}.${entry.uid}`,
        content: typeof entry.content === 'string' ? entry.content : '',
      }))
  })
  // undefined = 向量通道不可用（无配置/熔断/失败）：引擎给 vector-unavailable，
  // 不降级为关键词；Set = 检索跑通（可能为空）。
  const vectorHits = vectorizedEntries.length === 0 || embeddingConfig === undefined
    ? undefined
    : await selectVectorizedLoreEntries({
      root: dataRoot,
      config: embeddingConfig,
      query: latestUserText,
      entries: vectorizedEntries,
    }).catch(() => undefined)

  const lore = activateWorldInfo({
    books,
    chat: turnMessages.map((m) => ({ name: m.name, content: m.mes, isUser: m.is_user })),
    contextSize: Number(preset.sampler.openai_max_context ?? 4096),
    // 生成动词 → 世界书触发类型（ST GenerationTrigger）：continue/impersonate
    // 有独立触发位，条目 `triggers` 过滤依赖它；trigger 相位在 ST 里是静默扫描。
    trigger: options.phase === 'regenerate' ? 'regenerate'
      : options.phase === 'trigger' ? 'quiet'
      : options.phase === 'continue' ? 'continue'
      : options.phase === 'impersonate' ? 'impersonate'
      : 'normal',
    scanSources: {
      personaDescription: persona?.description,
      characterDescription: character.card.data.description,
      characterPersonality: character.card.data.personality,
      scenario: character.card.data.scenario,
      creatorNotes: character.card.data.creatorNotes,
    },
    // 世界书全局设置（契约 §2.8）：state 里可配，缺省值由 world-settings.ts 归一；
    // 引擎已实现 recursive/scanDepth/budget/minActivations/大小写/整词/组计分。
    settings: worldInfoSettingsOf(state),
    timedState: asTimedEffectsState(chat.header.chat_metadata?.timedWorldInfo),
    messageCount: turnMessages.length,
    ...(vectorHits === undefined ? {} : { vectorHits }),
  })
  chat.header.chat_metadata.timedWorldInfo = lore.timedState

  // ---- Prompt Template 预备（提案 0008）：激活分区 + InitialVariables + 运行时 ----
  // templatesEnabledFlag 承载 profile 的显式 opt-in；templatesEnvEnabled() 实时读 env 覆盖
  const templatesActive = templatesEnabledFlagValue() && templatesEnvEnabled()
  // The template runtime writes `global` variables in place. The state returned
  // by getState() is shared read-only, so templates get their own copy and the
  // before/after compare below runs on that copy (values are primitives, so a
  // shallow copy is enough).
  const templateGlobals: Record<string, string | number | boolean> | undefined = templatesActive
    ? { ...state.scriptGlobals }
    : undefined
  const templateGlobalsBefore = templateGlobals === undefined ? undefined : JSON.stringify(templateGlobals)
  const tpl: GenerationTemplates | null = templatesActive
    ? await createGenerationTemplates({
        chat, state: { ...state, scriptGlobals: templateGlobals! }, books, lore,
        card: character.card, preset,
        turnMessages,
        userName, characterName: speakerName, chatId,
      })
    : null

  // WI 内容进 prompt 前过 WORLD_INFO regex；模板开启时特殊条目已剔除、再过 EJS 渲染
  const wiDeps = { expand: (text: string): string => text }
  const loreBeforeBase = (tpl ? tpl.partition.normalBefore : lore.worldInfoBefore.entries)
    .map((e) => applyRegexScripts(e.content, scripts, RegexPlacement.WORLD_INFO, wiDeps))
  const loreAfterBase = (tpl ? tpl.partition.normalAfter : lore.worldInfoAfter.entries)
    .map((e) => applyRegexScripts(e.content, scripts, RegexPlacement.WORLD_INFO, wiDeps))
  const loreBefore = tpl ? await Promise.all(loreBeforeBase.map((t) => tpl.renderText(t, 'wi-before'))) : loreBeforeBase
  const loreAfter = tpl ? await Promise.all(loreAfterBase.map((t) => tpl.renderText(t, 'wi-after'))) : loreAfterBase

  const lastUser = [...turnMessages].reverse().find((m) => m.is_user)
  const lastChar = [...turnMessages].reverse().find((m) => !m.is_user && !m.is_system)
  const enabledMembers = groupDef
    ? groupDef.members.filter((member) => !groupDef.disabledMembers.includes(member))
    : undefined
  // 世界书 outlet（契约 §2.9）：{{outlet::Name}} 的数据源是激活结果按 outletName
  // 分组的文本（EntryGroup.text 已按 order 拼接）；没有激活条目时不传——宏保持
  // 未知原样，不伪造空串来源。
  const outletTexts: Record<string, string> = {}
  for (const [name, group] of Object.entries(lore.outlets)) outletTexts[name] = group.text
  // {{systemPrompt}}（契约 §2.9）：ST 里它来自独立的「系统提示词」预设；本仓库
  // 尚无该存储面，只有激活预设显式带 sysprompt 字符串时才传（有则传，无则保持
  // 引擎的未绑定语义）。
  const macroSystemPrompt = typeof preset.sampler['sysprompt'] === 'string' && preset.sampler['sysprompt'].trim() !== ''
    ? preset.sampler['sysprompt']
    : undefined
  const macros = createMacroEngine({
    char: character.card.data.nickname || character.card.data.name,
    user: userName,
    ...(enabledMembers ? { group: enabledMembers.join(', ') } : {}),
    persona: persona?.description,
    card: {
      description: character.card.data.description,
      personality: character.card.data.personality,
      scenario: character.card.data.scenario,
      mesExample: character.card.data.mesExample,
      systemPrompt: character.card.data.systemPrompt,
      postHistoryInstructions: character.card.data.postHistoryInstructions,
      creatorNotes: character.card.data.creatorNotes,
    },
    ...(Object.keys(outletTexts).length > 0 ? { outlets: outletTexts } : {}),
    ...(macroSystemPrompt !== undefined ? { systemPrompt: macroSystemPrompt } : {}),
    lastMessage: turnMessages[turnMessages.length - 1]?.mes,
    lastUserMessage: lastUser?.mes,
    lastCharMessage: lastChar?.mes,
    lastMessageId: turnMessages.length - 1,
    chatId,
    local: chatVariables(chat),
    global: state.scriptGlobals,
  })
  const expand = (text: string): string => macros.expand(text)
  const countTokens = (text: string): number => Math.ceil(text.length / 3.5)

  // 世界书 automationId（契约 §2.6）：激活条目命中的启用快速回复集合在装配阶段
  // 执行一次；变量写穿走同一个宏引擎（快照随本轮落盘），执行中的 id 记在模块
  // 级 Set 里防递归。仅真实生成执行，试写预览（worldInfoAutomations 不传）跳过。
  if (options.worldInfoAutomations === true) {
    await runWorldInfoAutomations({ ctx, db, state, lore, macros, characterName: speakerName, chatId })
  }

  // persona 位置：IN_PROMPT（默认）/AT_DEPTH/顶部AN/底部AN
  const personaInjections: DepthInjection[] = []
  let personaDescription = persona?.description
  if (persona) {
    const position = typeof persona.position === 'number' ? persona.position : 0
    if (position === 4) {
      personaInjections.push({ depth: persona.depth ?? 4, role: roleName(persona.role ?? 0), text: persona.description })
      personaDescription = undefined
    } else if (position === 2 || position === 3) {
      personaInjections.push({ depth: position === 2 ? 4 : 0, role: 'system', text: persona.description })
      personaDescription = undefined
    } else if (position === 9) {
      personaDescription = undefined
    }
  }
  if (tpl && personaDescription) personaDescription = await tpl.renderText(personaDescription, 'persona')

  // 聊天级 Author's Note / Summary（契约 §2.4）：数据在 JSONL header 的
  // chat_metadata.note_prompt / note_settings / summary；宏在此展开（ST
  // substituteParams 语义）。interval>0 时按楼层数取模跳过（ST 的
  // `chat.length % interval` 口径）；summary 是聊天级背景块，不受 interval 约束。
  const authorsNote = resolveAuthorsNote(chat, expand, turnMessages.length)

  // ---- promptOnly AI_OUTPUT：历史消息只影响 prompt 的变换 ----
  // 可见性（契约 §2.3）：is_hidden 楼层（顶层 is_hidden / extra.is_hidden 两种
  // 形态）不进生成历史；只过滤 prompt 视图，楼层本身与 lore 深度计数不变。
  const promptTurnMessages = turnMessages.filter((message) => !isHiddenMessage(message))
  const promptOnlyScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const historyRegexed = promptOnlyScripts.length > 0
    ? promptTurnMessages.map((m, index) => ({
        ...m,
        mes: applyRegexScripts(m.mes, promptOnlyScripts, RegexPlacement.AI_OUTPUT, {}, { depth: promptTurnMessages.length - 1 - index }),
      }))
    : promptTurnMessages
  // 模板开启时历史消息过 EJS（ST 默认语义：生成期处理消息中的 <% 块）
  const historyForPrompt = tpl
    ? await Promise.all(historyRegexed.map((m, index) =>
        tpl.renderText(m.mes, `history#${index}`).then((mes) => ({ ...m, mes }))))
    : historyRegexed

  const atDepthSource: Array<{ depth: number; role: number; text: string }> = tpl
    ? tpl.partition.normalAtDepth
    : lore.atDepth.map((g) => ({ depth: g.depth, role: g.role, text: g.text }))
  const anTopText = tpl && lore.topOfAuthorsNote.text ? await tpl.renderText(lore.topOfAuthorsNote.text, 'an-top') : lore.topOfAuthorsNote.text
  const anBottomText = tpl && lore.bottomOfAuthorsNote.text ? await tpl.renderText(lore.bottomOfAuthorsNote.text, 'an-bottom') : lore.bottomOfAuthorsNote.text
  const depthInjectionsRaw: DepthInjection[] = [
    ...atDepthSource.map((g) => ({ depth: g.depth, role: roleName(g.role), text: g.text })),
    ...(anTopText ? [{ depth: 4, role: 'system' as const, text: anTopText }] : []),
    ...(anBottomText ? [{ depth: 0, role: 'system' as const, text: anBottomText }] : []),
    // 聊天级 Author's Note 的 at_depth 形态（契约 §2.4）：depth 缺省 4、role 缺省
    // system；in_prompt 形态在下方 system 段注入。
    ...(authorsNote.atDepth !== undefined ? [authorsNote.atDepth] : []),
    ...personaInjections,
  ]
  const depthInjections = tpl
    ? await Promise.all(depthInjectionsRaw.map(async (inj) => ({ ...inj, text: await tpl.renderText(inj.text, 'depth-injection') })))
    : depthInjectionsRaw

  // ---- 群聊 nudge 进装配输入（提案 0002「追加为 user nudge」的接线）----
  // buildGroupTurn 算出的 nudge 在此消费：合成一条只进 prompt 的 user 楼层接在
  // 历史末尾（ST openai.js groupNudge 条目同位——insertAtEnd(chatHistory)、参与
  // 历史预算裁剪且作为最新楼层永不先于历史被裁、位于 post-history 条目之前）；
  // {{char}} 已在 buildGroupTurn 按发言者替换，其余宏在此展开（ST substituteParams
  // 语义）。合成楼层不落 chat.messages。本注入点即提案 0015 的 pre-assemble hook
  // 位：mod 在 draft（装配输入）中可见并可改写这条 nudge。
  const nudgeMessage: ChatMessage | undefined = nudge !== undefined
    ? { name: userName, is_user: true, is_system: false, send_date: '', mes: expand(nudge.content) }
    : undefined

  // pre-assemble 相位（提案 0015 §3.4）：装配输入 draft 的最后一站。mod 在
  // draft 中可见并可改写 nudge 合成楼层（该 hook 的第一个既有受益者）。经 seam
  // 注入（runGeneration 传 generationHooks.dispatch；试写预览不传 = 恒等跳过）。
  // draft 字段与 assemblePrompt 入参同形。
  const assembleDraft: AssembleInput = {
    card: tpl ? await tpl.preRenderCard(character.card) : character.card,
    preset: tpl ? await tpl.preRenderPreset(preset) : preset,
    personaDescription,
    messages: nudgeMessage ? [...historyForPrompt, nudgeMessage] : historyForPrompt,
    worldInfoBefore: loreBefore,
    worldInfoAfter: loreAfter,
    beforeExamples: tpl
      ? await Promise.all(tpl.partition.normalBeforeExamples.map((e, i) => tpl.renderText(e.content, `wi-em-before#${i}`)))
      : lore.beforeExamples.entries.map((e) => e.content),
    afterExamples: tpl
      ? await Promise.all(tpl.partition.normalAfterExamples.map((e, i) => tpl.renderText(e.content, `wi-em-after#${i}`)))
      : lore.afterExamples.entries.map((e) => e.content),
    depthInjections,
  }
  const hookedDraft = options.onDraft !== undefined
    ? await options.onDraft(assembleDraft)
    : assembleDraft

  const assembled = assemblePrompt(hookedDraft, { expand, countTokens })
  const fallback = ctx.agentDefaultModel.currentSelection()
  const saved = options.sessionId ? state.modelSelections?.[options.sessionId] : undefined
  const explicit = options.provider !== undefined && options.model !== undefined
    ? {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      }
    : undefined
  const choice = explicit ?? saved ?? fallback
  const provider = choice.provider
  const model = choice.model
  tpl?.setModel(model)
  const reasoningEffort = explicit?.reasoningEffort ?? saved?.reasoningEffort
    ?? (provider === fallback.provider && model === fallback.model ? fallback.reasoningEffort : undefined)

  // ---- 模板消息级注入（GENERATE → @INJECT，提案 0008）----
  // AFTER 条目位于 prompt 末尾：所有字段渲染完成后才预渲染（变量副作用次序）
  if (tpl) await tpl.prerenderGenerateAfter()

  // ---- 剧本游玩注入（提案 0014 P1）----
  // 卡绑定了剧本时：先做对齐推进判定——以「最近一条已定稿助手楼层」为准
  // （send 模式新用户消息已 push、regenerate 模式旧助手楼层已 pop，从
  // chat.messages 末尾向前找 is_user=false 且非 system 的楼层两者得到同一条），
  // 词法覆盖 ≥0.35 判定对齐 → chunkIndex+1（一次至多 +1，不跳块，末块不再
  // 推进）；进度惰性初始化 chunkIndex=0 后写回 chat_metadata.scriptProgress
  // （真实生成随本轮末尾的 saveChat 自然落盘；试写预览只写工作副本，随弃）。
  // 然后把当前块 + 下一块预览作为世界书式 system 条目 unshift 到消息头部——
  // 剧本块是参考不是约束（可偏离）。
  const boundScriptId = boundScriptOf(character.card)
  if (boundScriptId !== undefined) {
    const scriptRecord = await getScript(tavernDataRoot(), boundScriptId)
    if (scriptRecord !== undefined && scriptRecord.chunks.length > 0) {
      const prior = normalizeScriptProgress(chat.header.chat_metadata?.scriptProgress)
      let chunkIndex = prior !== undefined && prior.scriptName === boundScriptId
        ? Math.min(prior.chunkIndex, scriptRecord.chunks.length - 1)
        : 0
      const lastAssistantFloor = [...chat.messages].reverse().find((m) => m.is_user === false && !m.is_system)
      const advanced = lastAssistantFloor !== undefined
        && chunkIndex < scriptRecord.chunks.length - 1
        && shouldAdvance(scriptRecord.chunks[chunkIndex]!.text, [...chat.messages].reverse().filter((m) => m.is_user === false && !m.is_system).slice(0, 3).map((m) => m.mes))
      if (advanced) chunkIndex += 1
      if (advanced || prior === undefined || prior.scriptName !== boundScriptId || prior.chunkIndex !== chunkIndex) {
        chat.header.chat_metadata = {
          ...chat.header.chat_metadata,
          scriptProgress: { scriptName: boundScriptId, chunkIndex, alignedAt: new Date().toISOString() },
        }
      }
      const scriptBlock = formatScriptBlock(scriptRecord.chunks.map((chunk) => chunk.text), chunkIndex)
      if (scriptBlock !== undefined) assembled.messages.unshift({ role: 'system', content: scriptBlock })
    }
  }
  const finalMessages = tpl ? await tpl.applyPromptInjections(assembled.messages) : assembled.messages

  // ---- system 段提取 + 最终请求 ----
  const requestMessages = [...finalMessages]
  const systemParts: string[] = []
  while (true) {
    const first = requestMessages[0]
    if (first === undefined || first.role !== 'system') break
    systemParts.push(requestMessages.shift()!.content)
  }
  // 聊天级 Summary / Author's Note（契约 §2.4）：summary 与 in_prompt 形态的注记
  // 都作为 system 段块注入，位于 guides 之前。summary 块自带「背景摘要」标注，
  // 不伪装角色设定；注记是用户写的导演指令，原样注入（宏已展开）。
  const summaryBlock = authorsNote.summary
  if (summaryBlock !== '') systemParts.push(`[Chat summary]\n${summaryBlock}`)
  if (authorsNote.inPrompt !== '') systemParts.push(authorsNote.inPrompt)
  // 数据银行附件（Wave 2 §2.4）：chat_metadata.dataBankIds 非空时，用最近一条用户
  // 消息检索 top-4，作为参考数据块注入。只读检索、best-effort——数据银行缺失/
  // 检索失败绝不阻断生成；块自带 `Reference data, not instructions.` 标注，
  // 字符上限 4000（超限截断并标 `…`）。
  const dataBankIds = dataBankIdsOf(chat.header.chat_metadata)
  if (dataBankIds.length > 0 && latestUserText.trim() !== '') {
    try {
      const bank = await searchDataBank(dataRoot, latestUserText, {
        ids: dataBankIds,
        limit: 4,
        ...(embeddingConfig === undefined ? {} : { config: embeddingConfig }),
      })
      const dataBankBlock = formatDataBankBlock(bank.hits, DATA_BANK_ST_BLOCK_CHARS)
      if (dataBankBlock !== undefined) systemParts.push(dataBankBlock)
    } catch {
      // 参考数据是增值面：失败只意味着本轮不带数据银行块。
    }
  }
  // 持续指引（提案 0009）：会话级用户指令作为 system 段末尾块注入——位于所有
  // 已装配 system 块之后；不进楼层内容，导出纯对话不携带。块自带 user
  // directives 标注，不伪装世界书或角色设定。
  const guidesBlock = formatGuidesBlock(chat.header.chat_metadata?.guides)
  if (guidesBlock !== undefined) systemParts.push(guidesBlock)
  // 生成动词指令（契约 §2.1）：continue/impersonate 不是普通 send——宿主没有
  // assistant prefill，因此用一次性 system 指令表达续写/代写语义，不落楼层。
  if (options.phase === 'continue') systemParts.push(CONTINUE_DIRECTIVE)
  if (options.phase === 'impersonate') systemParts.push(impersonationDirective(userName))
  const llmMessages = requestMessages.map((m) => createMessage({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    // 仅进 ctx.llm.stream 的请求消息，不落会话日志（该调用不带 sessionId），
    // dsh-llm 对 source 不校验；v0 形状在此保留——装配作用域内没有会话对象
    // 可供格式探测。
    source: m.role === 'assistant' ? { kind: 'model', provider, model } : m.role === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-soulmojito' },
  }))
  // 带意见重写（提案 0011）：意见是一次性生成指引，作为 system 段末尾块
  // （guides 块之后）注入，不落任何楼层。
  const rewriteBlock = formatRewriteBlock(options.feedback)
  if (rewriteBlock) systemParts.push(rewriteBlock)
  // pre-llm 相位（提案 0015 §3.4）：进 llm.stream 的最终请求。经 seam 注入
  //（runGeneration 传 generationHooks.dispatch；试写预览不传 = 恒等跳过）。
  // system 保持「无内容则不带键」的条件展开语义（undefined 时不注入）。
  const llmRequest = {
    messages: llmMessages,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    params: {
      provider, model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      temperature: numberOr(preset.sampler.temperature, undefined),
      maxTokens: numberOr(preset.sampler.openai_max_tokens, undefined),
      // 预设采样全集（契约 §2.2）：直传键优先、兼容 openai_ 前缀；只写有值且
      // 类型正确的键，缺省不塞 undefined。宿主/provider 是否消费由 dsh-llm 的
      // 路由决定——插件只如实透传，不做静默降级。
      ...samplerParams(preset.sampler),
    },
  }
  const hookedLlmRequest = options.onLlmRequest !== undefined
    ? await options.onLlmRequest(llmRequest)
    : llmRequest
  return {
    request: hookedLlmRequest,
    lore,
    tpl,
    macros,
    templateGlobalsBefore,
    templateGlobals,
    // SSE 'start' 事件的载荷（runGeneration 消费；试写预览忽略）。provider/model
    // 是选择器结论（pre-hook）——hook 改写后的实参以 request.params 为准。
    start: {
      provider,
      model,
      speaker: speakerName,
      lore: lore.allActivated.map((e) => ({ uid: e.uid, book: e.book, comment: e.entry.comment })),
      stats: assembled.stats,
    },
  }
}

/**
 * 生成内核：send/regenerate 共用；群聊与文本补全在此分叉。
 * 结构：CAS 校验已在调用方完成（snapshot 即当前 revision）。
 */
export async function runGeneration(ctx: PluginContext, db: TavernStore, options: GenerationOptions) {
  const { state, characterName, chatId, snapshot, mode, group, write, signal } = options
  const chat = snapshot.chat
  // MVU 回执（提案 0012 P1）：深拷贝本轮结算前的变量基线，保存前 diff 出变更集落回执
  const mvuVariablesBefore = snapshotChatVariables(chat)
  let revision = snapshot.revision
  let hostTrace
  // {{user}} / 消息落库名：激活 persona 名称（ST name1 语义），未配置时回退默认
  const userName = state.activePersona ?? DEFAULT_USER

  try {

  // ---- 发言者与成员解析（共享助手 resolveGenerationSpeaker：D-4 试写预览
  // 复用同一套发言者/nudge 解析；两边的差异只在后续副作用）----
  const { speakerName, groupDef, nudge, turnMessages: initialTurnMessages } = await resolveGenerationSpeaker(db, state, {
    characterName,
    chat,
    mode,
    group,
    ...(options.triggerMember !== undefined ? { triggerMember: options.triggerMember } : {}),
  })
  let turnMessages = initialTurnMessages
  const character = await db.getCharacter(speakerName)
  if (!character) throw new Error(`character '${speakerName}' not found`)

  // ---- 发送模式：先落用户消息（regex USER_INPUT），regenerate 弹出旧回复 ----
  let regenerated
  let hostUserText = ''
  const scripts = await collectSessionRegexScripts(db, state, characterName, chatId, character)
  if (mode === 'send') {
    // user-input 相位（提案 0015 §3.4）：regex 之前——mod 看到的是用户敲入的原文。
    // 空总线恒等，行为不变。
    const hookedUserText = await generationHooks.dispatch('user-input', options.userText, { mode, character: speakerName, chatId, group })
    const transformed = applyRegexScripts(hookedUserText, scripts, RegexPlacement.USER_INPUT, { expand: (t) => t })
    hostUserText = transformed
    chat.messages.push({ name: userName, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: transformed })
    if (group) turnMessages = rebuildGroupTurn(groupDef, speakerName, userName, chat.messages)
    revision = await db.saveChat(characterName, chatId, chat, revision)
    // chat-saved（提案 0015 §3.3 P1 的 api.events）：用户消息落盘点。无监听时
    // 是已 resolved 的 promise，零开销。
    await emitChatSaved(characterName, chatId, revision, chat.messages.length)
  } else if (mode === 'regenerate' || mode === 'trigger') {
    // trigger 沿用既有语义：末条 assistant 视为重掷目标（弹楼 → 新增 swipe），
    // 本轮不动它——契约只新增 continue/impersonate，不改变 /trigger 观察行为。
    const last = chat.messages[chat.messages.length - 1]
    if (last?.is_user === false && !last.is_system) {
      regenerated = chat.messages.pop()
      if (group) turnMessages = rebuildGroupTurn(groupDef, speakerName, userName, chat.messages)
    }
  } else if (mode === 'continue') {
    // continue（契约 §2.1）：不新增用户楼，末条必须是 assistant——否则明确报错，
    // 不静默退化成 send 或空生成。
    const last = chat.messages[chat.messages.length - 1]
    if (last === undefined || last.is_user !== false || last.is_system === true) {
      throw new Error('cannot continue: the last message must be an assistant message')
    }
  }
  // impersonate / trigger：不增删楼层（前者生成一条 is_user 楼层，后者按现状生成）。

  hostTrace = beginTavernSessionTurn(options.hostAgent, hostUserText)

  // ---- 装配 + LLM 请求构造（共享助手 buildGenerationLlmRequest：D-4 试写
  // 预览复用同一套 preset/persona/世界书/模板/宏装配与模型选择推导）----
  // 五相位 hook 中 user-input 已在上文、post-output/post-save 在下文；装配区内的
  // pre-assemble / pre-llm 经 seam 闭包注入（试写预览不传 = 整段跳过）。'start'
  // 事件、prompt-viewer 记录与流代次仍由本函数在装配完成后处理。
  const assembly = await buildGenerationLlmRequest(ctx, db, {
    state,
    speakerName,
    character,
    chatId,
    chat,
    turnMessages,
    nudge,
    group,
    ...(groupDef !== undefined ? { groupDef } : {}),
    phase: mode,
    scripts,
    userName,
    ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    onDraft: (draft) => generationHooks.dispatch('pre-assemble', draft, { mode, character: speakerName, chatId, group }),
    onLlmRequest: (request) => generationHooks.dispatch('pre-llm', request, { mode, character: speakerName, chatId, group }),
    worldInfoAutomations: true,
  })
  const lore = assembly.lore
  const tpl = assembly.tpl
  const macros = assembly.macros
  const templateGlobalsBefore = assembly.templateGlobalsBefore
  const templateGlobals = assembly.templateGlobals
  const hookedLlmRequest = assembly.request
  const expand = (text: string): string => macros.expand(text)
  write({ type: 'start', ...assembly.start })
  // pre-llm 后的实参是落盘元数据的唯一权威：mod 改写 provider/model 时，
  // swipe_info[].extra / 消息 extra / 宿主会话轨迹不得与实际请求分叉
  // （P0 决策遗留的已知问题就此闭环，decisions/2026-10-10-mod-review-fixes.md）。
  const usedProvider = hookedLlmRequest.params.provider
  const usedModel = hookedLlmRequest.params.model
  // 提示词查看器（A-6）：记录点在 pre-llm hook 全部跑完之后、llm.stream 之前——
  // 看到即实发（mod 改写后的最终形状）。纯观察：记录失败（含 loreTrace 提取）
  // 被 prompt-viewer.ts 整体吞掉 + 宿主日志一行，绝不影响生成。lore 与本轮请求
  // 同轮对齐。
  recordPromptView({
    character: speakerName,
    chatId,
    mode,
    request: hookedLlmRequest,
    lore,
  }, ctx.logger)
  // stream-delta 代次（A-3）：本轮流式生成开始——mod 宿主据它做「每代次每 mod
  // 首错」的审计防洪（mods/events.ts）。
  let text = ''
  let reasoning = ''
  let hostUsage
  hostTrace = startTavernSessionStep(hostTrace)
  beginStreamEpoch()
  for await (const chunk of ctx.llm.stream({
    provider: hookedLlmRequest.params.provider,
    model: hookedLlmRequest.params.model,
    messages: hookedLlmRequest.messages,
    ...(hookedLlmRequest.system !== undefined ? { system: hookedLlmRequest.system } : {}),
    ...(hookedLlmRequest.params.reasoningEffort !== undefined ? { reasoningEffort: hookedLlmRequest.params.reasoningEffort } : {}),
    temperature: hookedLlmRequest.params.temperature,
    maxTokens: hookedLlmRequest.params.maxTokens,
    ...hostSamplingParams(hookedLlmRequest.params),
    signal,
  })) {
    // 逐 chunk 事件不落宿主会话：`assistant/chunk` 是 v0 词汇，v4 宿主加载期
    // 直接整会话拒载（SessionFormatUnsupportedError）；流式反馈走 SSE write，
    // 持久轨迹由终态 assistant/message 的 stream/settlement 承载。
    if (chunk.type === 'usage') hostUsage = chunk.usage
    if (chunk.type === 'text-delta') {
      text += chunk.text
      write({ type: 'delta', text: chunk.text })
      // stream-delta（A-3，JSR fully/incrementally 双通道的单事件形态）：纯观察
      // 面——fire-and-forget 不背压生成（慢 handler 不节流流式消费），投递在
      // events.ts 内串行保序；reasoning 增量不进事件（v1 只观察正文）。
      // finish(error/aborted) 抛出后循环退出，天然停发。
      emitStreamDelta({ mode, character: speakerName, chatId, text, delta: chunk.text })
    }
    else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; write({ type: 'reasoning', text: chunk.text }) }
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure?.message ?? 'model stream failed')
      write({ type: 'finish', reason: chunk.reason.kind })
    }
  }
  if (text.trim() === '') throw new Error('model returned no text')

  // post-output 相位（提案 0015 §3.4）：AI_OUTPUT regex 与模板输出渲染之前——
  // mod 看到的是模型原文。空总线恒等。
  const outputText = await generationHooks.dispatch('post-output', text, { mode, character: speakerName, chatId, group })

  // ---- AI_OUTPUT regex（非 promptOnly）→ 模板输出渲染（RENDER + setvar）→ 保存 ----
  const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
  let finalText = saveScripts.length > 0 ? applyRegexScripts(outputText, saveScripts, RegexPlacement.AI_OUTPUT, { expand }) : outputText
  if (tpl) finalText = await tpl.renderOutput(finalText)
  const finalReasoning = reasoning
    ? applyRegexScripts(reasoning, scripts, RegexPlacement.REASONING, { expand })
    : reasoning
  const now = new Date().toISOString()
  if (mode === 'continue') {
    // continue（契约 §2.1）：不新建楼层——生成文本追加到末条 assistant 的 mes，
    // 并同步当前 swipe（swipes[swipe_id]）。tokenCount 是整条楼层的估算值。
    const target = chat.messages[chat.messages.length - 1]!
    const merged = `${target.mes}${finalText}`
    const swipes = Array.isArray(target.swipes) && target.swipes.length > 0 ? [...target.swipes] : []
    const currentSwipe = typeof target.swipe_id === 'number' && Number.isInteger(target.swipe_id)
      && target.swipe_id >= 0 && target.swipe_id < swipes.length
      ? target.swipe_id
      : undefined
    if (currentSwipe !== undefined) {
      swipes[currentSwipe] = merged
    } else {
      swipes.push(merged)
      target.swipe_id = swipes.length - 1
    }
    target.mes = merged
    target.swipes = swipes
    target.extra = {
      ...(target.extra ?? {}),
      api: usedProvider, model: usedModel, reasoning: finalReasoning || undefined,
      tokenCount: estimateMessageTokens(merged),
    }
  } else if (mode === 'impersonate') {
    // impersonate（契约 §2.1）：以 {{user}} 身份落一条 is_user 楼层，不追加
    // assistant；swipe 容器与 assistant 楼层同形，便于后续重掷/切换。
    chat.messages.push({
      name: userName,
      is_user: true, is_system: false, send_date: now, mes: finalText,
      swipe_id: 0,
      swipes: [finalText],
      swipe_info: [{
        send_date: now,
        extra: { provider: usedProvider, model: usedModel, reasoning: finalReasoning || undefined },
      }],
      extra: {
        api: usedProvider, model: usedModel, reasoning: finalReasoning || undefined,
        tokenCount: estimateMessageTokens(finalText),
        activatedLore: lore.allActivated.map((e) => e.entryId),
        ...(tpl && tpl.warnings.length > 0 ? { templateWarnings: tpl.warnings } : {}),
      },
    })
  } else {
    const oldSwipes = regenerated
      ? (Array.isArray(regenerated.swipes) && regenerated.swipes.length > 0 ? regenerated.swipes : [regenerated.mes])
      : []
    const oldSwipeInfo = regenerated
      ? (Array.isArray(regenerated.swipe_info) ? regenerated.swipe_info : oldSwipes.map(() => ({})))
      : []
    chat.messages.push({
      ...(regenerated ?? {}),
      name: character.card.data.nickname || character.card.data.name,
      is_user: false, is_system: false, send_date: now, mes: finalText,
      swipe_id: oldSwipes.length,
      swipes: [...oldSwipes, finalText],
      swipe_info: [...oldSwipeInfo, { send_date: now, extra: { provider: usedProvider, model: usedModel, reasoning: finalReasoning || undefined, ...(options.feedback ? { feedback: options.feedback } : {}) } }],
      extra: {
        ...(regenerated?.extra ?? {}),
        api: usedProvider, model: usedModel, reasoning: finalReasoning || undefined,
        activatedLore: lore.allActivated.map((e) => e.entryId),
        tokenCount: estimateMessageTokens(finalText),
        ...(tpl && tpl.warnings.length > 0 ? { templateWarnings: tpl.warnings } : {}),
      },
    })
  }
  // 变量持久化：宏局部快照（原语）+ 模板写穿的 local/initial（chat_metadata live）合并；
  // 模板 global 写穿 state.scriptGlobals，有变化时落 state.json
  const varSnapshot = macros.snapshotVars().local
  if (tpl) {
    mergeTemplateLocalVars(chat, varSnapshot)
    if (templateGlobals !== undefined && JSON.stringify(templateGlobals) !== templateGlobalsBefore) {
      await db.updateState((current) => ({ scriptGlobals: { ...current.scriptGlobals, ...templateGlobals } }))
    }
  } else if (Object.keys(varSnapshot).length > 0) {
    chat.header.chat_metadata.variables = varSnapshot
  } else {
    delete chat.header.chat_metadata.variables
  }
  // MVU 结算回执（提案 0012 P1）+ $schema 写入守卫（C-1，2026-10-11）+ $rules
  // 条件规则（C-2，2026-10-11）：守卫 pass 在写穿完成后、规则 pass 在守卫后、
  // 回执 diff 之前——clamp 写回（回执 reason 标注 guard），reject 回滚到基线值并入
  // 回执 failures（可重试）；规则做二次计算（派生值/阈值触发/连锁修正），规则产出
  // 再过一次守卫，变更 reason 标 rule:<name>；无 schema/无 $rules 的卡恒等，行为
  // 不变。failures 先收 templateWarnings 再收守卫/规则失败项；无变量也无变更的局
  // 不写 mvu 键（与 guides 空置摘键约定一致）。
  const mvuGuard = applyMvuSettlementGuard(chat, character.card, mvuVariablesBefore)
  const mvuRules = await applyMvuSettlementRules(chat, character.card, mvuVariablesBefore)
  recordMvuTurnReceipt(chat, mvuVariablesBefore, {
    turnKey: String(chat.messages.length - 1),
    failures: [...(tpl?.warnings ?? []), ...mvuGuard.failures, ...mvuRules.failures],
    changeNotes: mergeMvuRuleNotes(mvuGuard.notes, mvuRules.notes),
  })
  // Gateway staging: validate/normalize the final tree without a second save.
  // The message, receipt and variable writes below stay one CAS commit.
  stageChatVariables(chat, readChatVariables(chat))
  revision = await db.saveChat(characterName, chatId, chat, revision)
  // chat-saved（提案 0015 §3.3 P1）：助手回复落盘点（与 post-save hook 相邻但
  // 语义不同——events 是观察面，hooks 是 P2 的变换面）。
  await emitChatSaved(characterName, chatId, revision, chat.messages.length)
  // post-save 相位（提案 0015 §3.4）：落盘后的只读观察，返回值丢弃；hook 失败/
  // 超时降级不改变任何已落盘状态。空总线恒等。
  await generationHooks.dispatch('post-save', { chat, revision, speaker: speakerName, finalText }, { mode, character: speakerName, chatId, group })
  hostTrace = recordTavernSessionAssistant(hostTrace, finalText, finalReasoning, usedProvider, usedModel, hostUsage)
  return { chat, revision, speaker: speakerName }
  } finally {
    finishTavernSessionTrace(hostTrace)
  }
}

/* --------------------------- STscript 执行 --------------------------- */

export function chatVariables(chat: ChatLogIR): Record<string, string | number | boolean> {
  const vars = chat.header.chat_metadata?.variables
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const result: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value
    }
    return result
  }
  return {}
}

export async function runTavernScript(ctx: PluginContext, req: HttpRequest, res: HttpResponse, db: TavernStore): Promise<void> {
  const body = await readJson(req)
  const state = await db.getState()
  assertStGenerationBinding(state, body.sessionId)
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  if (!snapshot) throw new Error('chat not found')
  const group = body.group === true || await isGroupChat(db, characterName, chatId)
  const chat = snapshot.chat
  let revision = snapshot.revision
  const character = await db.getCharacter(characterName)
  // /regex below reads the same session-aware list as generation.
  const scripts = await collectSessionRegexScripts(db, state, characterName, chatId, character)
  const scriptController = new AbortController()
  activeStGeneration.set(stGenerationKey(characterName, chatId), scriptController)

  const macros = createMacroEngine({
    char: character?.card.data.nickname || character?.card.data.name || characterName,
    user: state.activePersona ?? DEFAULT_USER,
    persona: state.activePersona ? (await db.getPersona(state.activePersona))?.description : undefined,
    lastMessage: chat.messages[chat.messages.length - 1]?.mes,
    lastUserMessage: [...chat.messages].reverse().find((m) => m.is_user)?.mes,
    lastCharMessage: [...chat.messages].reverse().find((m) => !m.is_user && !m.is_system)?.mes,
    lastMessageId: chat.messages.length - 1,
    chatId,
    local: chatVariables(chat),
    global: state.scriptGlobals,
  })

  // /rename 会把聊天文件换名：脚本执行期间的所有读/写都跟随 currentChatId（原
  // chatId 只用于 /stop 的 activeStGeneration 注册键）。
  let currentChatId = chatId
  const persist = async () => {
    stageChatVariables(chat, macros.snapshotVars().local)
    revision = await db.saveChat(characterName, currentChatId, chat, revision)
    await emitChatSaved(characterName, currentChatId, revision, chat.messages.length)
  }

  /** STscript 触发的生成（/trigger /regenerate /continue）：内核会保存并替换
   *  chat 对象，这里同步回本作用域，后续命令看到最新楼层与 revision。 */
  const generate = async (mode: 'trigger' | 'regenerate' | 'continue', member?: string): Promise<void> => {
    const latest = await db.getChatSnapshot(characterName, currentChatId)
    const result = await runGeneration(ctx, db, {
      state: await db.getState(),
      characterName,
      chatId: currentChatId,
      snapshot: latest ?? { chat, revision },
      mode,
      userText: '',
      group,
      ...(member !== undefined ? { triggerMember: member } : {}),
      write: () => {},
      signal: scriptController.signal,
    })
    chat.messages = result.chat.messages
    chat.header = result.chat.header
    revision = result.revision
  }

  // /run 的防递归栈：同名集合在执行中再次被 /run 时报错，而不是无限递归。
  const runningQuickReplies = new Set<string>()
  const scriptEnv: ScriptEnv = {
    expand: (text) => macros.expand(text),
    getVar: (name) => macros.getVar(name),
    setVar: (name, value) => { macros.setVar(name, value) },
    deleteVar: (name) => macros.deleteVar(name),
    getGlobalVar: (name) => macros.getGlobalVar(name),
    setGlobalVar: (name, value) => { macros.setGlobalVar(name, value) },
    deleteGlobalVar: (name) => macros.deleteGlobalVar(name),
    send: async (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return
      chat.messages.push({ name: state.activePersona ?? DEFAULT_USER, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: trimmed })
      await persist()
    },
    trigger: async (member) => { await generate('trigger', member) },
    regenerate: async () => { await generate('regenerate') },
    continue: async () => { await generate('continue') },
    swipe: async (delta) => {
      // ST /swipe：在末条楼层的候选间移动；只有一个候选时是无操作（不报错）。
      const message = chat.messages[chat.messages.length - 1]
      if (message === undefined) return
      const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes]
      if (swipes.length < 2) return
      const currentIndex = typeof message.swipe_id === 'number' ? message.swipe_id : 0
      const next = ((currentIndex + delta) % swipes.length + swipes.length) % swipes.length
      message.swipe_id = next
      message.mes = swipes[next] ?? message.mes
      await persist()
    },
    hide: async (from, to) => {
      const { start, end } = messageRange(chat.messages, from, to)
      for (const message of chat.messages.slice(start, end)) message.is_hidden = true
      await persist()
    },
    unhide: async (from, to) => {
      const { start, end } = messageRange(chat.messages, from, to)
      for (const message of chat.messages.slice(start, end)) {
        // 两种历史形态一起清（面板写回口径：顶层 + extra.is_hidden）。
        Reflect.deleteProperty(message, 'is_hidden')
        const extra = asRecord(message.extra)
        if (extra !== undefined) Reflect.deleteProperty(extra, 'is_hidden')
      }
      await persist()
    },
    move: async (from, to) => {
      const messages = chat.messages
      const start = from < 0 ? messages.length + from : from
      const rawTarget = to < 0 ? messages.length + to : to
      const target = Math.min(Math.max(rawTarget, 0), messages.length - 1)
      if (start < 0 || start >= messages.length) throw new Error(`/move: message index ${from} out of range`)
      const [message] = messages.splice(start, 1)
      if (message !== undefined) messages.splice(target, 0, message)
      await persist()
    },
    rename: async (name) => {
      // 聊天 id 即文件名：清掉路径/保留字符，空名明确报错而不是造出 `.jsonl`。
      const stem = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80)
      if (stem === '') throw new Error('/rename: name is empty')
      const nextChatId = `${stem}.jsonl`
      await db.renameChat(characterName, currentChatId, nextChatId, revision)
      currentChatId = nextChatId
      const renamed = await db.getChatSnapshot(characterName, currentChatId)
      if (renamed !== undefined) revision = renamed.revision
    },
    branch: async (messageId, name) => {
      const latest = await db.getChatSnapshot(characterName, currentChatId)
      const source = latest?.chat ?? chat
      await db.branchChat(characterName, currentChatId, messageId ?? source.messages.length - 1, latest?.revision, name)
    },
    checkpoint: async (messageId) => {
      // 契约 §2.5：与面板/HTTP 走同一份 chat-file 语义（命名、父链、CAS），
      // 不在生成内核里复制第二套（`#` 不在聊天 id 安全字符集内）。
      const latest = await db.getChatSnapshot(characterName, currentChatId)
      await checkpointChatFile(db, {
        character: characterName,
        chatId: currentChatId,
        revision: latest?.revision ?? revision,
        ...(messageId === undefined ? {} : { messageId }),
      })
    },
    listVars: () => Object.entries(macros.snapshotVars().local)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join('\n'),
    flushVars: () => {
      for (const name of Object.keys(macros.snapshotVars().local)) macros.deleteVar(name)
    },
    runQuickReply: async (name) => {
      // /run //qr <name>（契约 §2.6/§2.7）：名字匹配与 composer 按钮同一口径
      //（findQuickReplySet：去空白、大小写不敏感，停用集合仍可显式调用）。
      const set = findQuickReplySet(state, name)
      if (set === undefined) throw new Error(`quick reply set '${name}' is not found`)
      if (runningQuickReplies.has(set.id)) throw new Error(`/run recursion detected: '${name}'`)
      const script = quickReplyScript(set)
      if (script === undefined) return
      runningQuickReplies.add(set.id)
      try {
        await runScript(script, scriptEnv)
      } finally {
        runningQuickReplies.delete(set.id)
      }
    },
    stop: () => { abortStGeneration(characterName, chatId) },
    cut: async (from, to) => {
      const { start, end } = messageRange(chat.messages, from, to)
      chat.messages.splice(start, end - start)
      await persist()
    },
    echo: () => {},
    applyRegex: (scriptName, text) => {
      // ST runRegexCallback 语义：脚本名大小写不敏感；未找到/禁用原样返回输入、
      // 不中断脚本。差异（决策 2026-10-10-group-nudge-and-regex-slash）：仅
      // SLASH_COMMAND placement 位命中的脚本生效——placement=3 的唯一应用点。
      const script = scripts
        .find((candidate) => candidate.scriptName.toLowerCase() === scriptName.toLowerCase())
      if (!script) return text
      return applyRegexScript(text, script, RegexPlacement.SLASH_COMMAND, { expand: (t) => macros.expand(t) }) ?? text
    },
  }
  const result = await runScript(typeof body.script === 'string' ? body.script : '', scriptEnv).finally(() => {
    const key = stGenerationKey(characterName, chatId)
    if (activeStGeneration.get(key) === scriptController) activeStGeneration.delete(key)
  })

  // 全局变量持久化
  const globals = macros.snapshotVars().global
  await db.updateState(() => ({ scriptGlobals: globals }))
  const freshSnapshot = await db.getChatSnapshot(characterName, currentChatId)
  return sendJson(res, 200, {
    ok: true,
    output: result.output,
    chatChanged: result.chatChanged,
    chat: freshSnapshot?.chat ?? chat,
    revision: freshSnapshot?.revision ?? revision,
  })
}
function roleName(role: unknown): DepthInjection['role'] {
  return role === 1 ? 'user' : role === 2 ? 'assistant' : 'system'
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function asTimedEffectsState(value: unknown): TimedEffectsState | undefined {
  return asRecord(value) === undefined ? undefined : value as TimedEffectsState
}

/* ------------- 生成期助手（契约 §2.1/2.2/2.3/2.4/2.6） ------------- */

/**
 * continue 的 system 指令。宿主 `HostLlmRequest` 没有 assistant prefill 字段，
 * 因此续写语义靠一次性指令表达：不重复已写内容、不加说话人前缀、保持风格。
 * 指令只进 system 段，不落楼层。
 */
const CONTINUE_DIRECTIVE = '[Continue the last assistant message exactly where it stopped. Do not repeat text that is already written, do not restate the speaker name, and keep the same voice, tense and formatting.]'

function impersonationDirective(userName: string): string {
  return `[Write the next message as ${userName} (first person). Use the chat history and the persona description as style guidance, and do not write actions or dialogue for other characters.]`
}

/**
 * 消息级 token 估算（契约 §2.1）：与装配期的预算近似同一系数（len/3.5），
 * 只用于展示/参考；它不是 provider tokenizer，落盘值允许与计费口径有偏差。
 */
function estimateMessageTokens(text: string): number {
  return Math.round(text.length / 3.5)
}

/** 楼层是否被隐藏（契约 §2.3）：顶层 `is_hidden` 与 `extra.is_hidden` 两种形态。 */
function isHiddenMessage(message: ChatMessage): boolean {
  if (message.is_hidden === true) return true
  return asRecord(message.extra)?.['is_hidden'] === true
}

/** 闭区间 [from, to] → 半开切片 [start, end)；负索引从末尾计（/cut 同款）。 */
function messageRange(messages: ChatMessage[], from: number, to: number): { start: number; end: number } {
  const total = messages.length
  const start = Math.max(0, from < 0 ? total + from : from)
  const end = Math.min(total, (to < 0 ? total + to : to) + 1)
  if (start > end) throw new Error(`message range ${from}..${to} is empty`)
  return { start, end }
}

interface ResolvedAuthorsNote {
  /** in_prompt 形态的注记文本（空串 = 不注入）。 */
  inPrompt: string
  /** at_depth 形态的注记注入（undefined = 不注入）。 */
  atDepth: DepthInjection | undefined
  /** chat_metadata.summary 的 system 段块文本（空串 = 不注入）。 */
  summary: string
}

/**
 * 聊天级 Author's Note / Summary 解析（契约 §2.4）。interval>0 时按楼层数取模
 * 跳过（ST `chat.length % interval` 口径）；position 缺省 in_prompt，at_depth
 * 的 depth 缺省 4、role 缺省 system。文本在返回前完成宏展开。
 */
function resolveAuthorsNote(chat: ChatLogIR, expand: (text: string) => string, messageCount: number): ResolvedAuthorsNote {
  const metadata = chat.header.chat_metadata
  const rawPrompt = typeof metadata.note_prompt === 'string' ? metadata.note_prompt.trim() : ''
  const settings = asRecord(metadata.note_settings) ?? {}
  const rawInterval = settings['interval']
  const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.floor(rawInterval)
    : 0
  const applies = rawPrompt !== '' && (interval === 0 || messageCount % interval === 0)
  const rawDepth = settings['depth']
  const depth = typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth >= 0 ? Math.floor(rawDepth) : 4
  const rawRole = settings['role']
  const role: DepthInjection['role'] = rawRole === 'user' ? 'user' : rawRole === 'assistant' ? 'assistant' : 'system'
  const text = applies ? expand(rawPrompt) : ''
  const atDepth = text !== '' && settings['position'] === 'at_depth' ? { depth, role, text } : undefined
  const rawSummary = typeof metadata.summary === 'string' ? metadata.summary.trim() : ''
  return {
    inPrompt: text !== '' && atDepth === undefined ? text : '',
    atDepth,
    summary: rawSummary === '' ? '' : expand(rawSummary),
  }
}

/** 预设采样键：直传键优先，兼容 ST 的 `openai_` 前缀（如 openai_top_p）。 */
function samplerValue(sampler: Record<string, unknown>, key: string): unknown {
  const direct = sampler[key]
  return direct !== undefined ? direct : sampler[`openai_${key}`]
}

interface SamplerParams {
  top_p?: number
  top_k?: number
  frequency_penalty?: number
  presence_penalty?: number
  repetition_penalty?: number
  min_p?: number
  seed?: number
  stop?: string | string[]
  logit_bias?: Record<string, number>
}

/**
 * 预设采样参数 → 请求参数（契约 §2.2）。只写有值且类型正确的键；缺省不写，
 * 不塞 undefined。宿主/provider 是否消费由 dsh-llm 的路由决定——插件只如实
 * 透传，不做静默降级。
 */
function samplerParams(sampler: Record<string, unknown>): SamplerParams {
  const params: SamplerParams = {}
  const numericKeys = ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'seed'] as const
  for (const key of numericKeys) {
    const value = samplerValue(sampler, key)
    if (typeof value === 'number' && Number.isFinite(value)) params[key] = value
  }
  const stop = samplerValue(sampler, 'stop')
  if (typeof stop === 'string') {
    if (stop !== '') params.stop = stop
  } else if (Array.isArray(stop)) {
    const list = stop.filter((item): item is string => typeof item === 'string' && item !== '')
    if (list.length > 0 && list.length === stop.length) params.stop = list
  }
  const logitBias = asRecord(samplerValue(sampler, 'logit_bias'))
  if (logitBias !== undefined) {
    const entries = Object.entries(logitBias)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    if (entries.length > 0) params.logit_bias = Object.fromEntries(entries)
  }
  return params
}

/** 采样参数展开进宿主请求（与 params 同键；provider 消费与否由其路由决定）。 */
function hostSamplingParams(params: GenerationLlmRequestPayload['params']): Record<string, unknown> {
  const { top_p, top_k, frequency_penalty, presence_penalty, repetition_penalty, min_p, seed, stop, logit_bias } = params
  return {
    ...(top_p !== undefined ? { top_p } : {}),
    ...(top_k !== undefined ? { top_k } : {}),
    ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
    ...(presence_penalty !== undefined ? { presence_penalty } : {}),
    ...(repetition_penalty !== undefined ? { repetition_penalty } : {}),
    ...(min_p !== undefined ? { min_p } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(logit_bias !== undefined ? { logit_bias } : {}),
  }
}

/** 执行中的 world info automation（`character\0chatId\0id`）：防同轮递归。 */
const runningWorldInfoAutomations = new Set<string>()

/**
 * 世界书 automationId（契约 §2.6）：激活条目命中的启用快速回复集合，在 ST 装配
 * 阶段每条命令执行一次。环境只开放变量类命令与 echo——自动触发里再触发生成/改
 * 楼层会让生成不可预期（ST 同样限制自动化命令集）；不可用命令的错误记录到宿主
 * 日志后继续，不让卡脚本错误中断生成。变量写穿走本轮宏引擎，随本轮落盘。
 */
async function runWorldInfoAutomations(options: {
  ctx: PluginContext
  db: TavernStore
  state: TavernState
  lore: ActivationResult
  macros: ReturnType<typeof createMacroEngine>
  characterName: string
  chatId: string
}): Promise<void> {
  const { ctx, db, state, lore, macros, characterName, chatId } = options
  const automationIds = new Set<string>()
  for (const activated of lore.allActivated) {
    const automationId = typeof activated.entry.automationId === 'string' ? activated.entry.automationId.trim() : ''
    if (automationId !== '') automationIds.add(automationId)
  }
  if (automationIds.size === 0) return
  const globalsBefore = JSON.stringify(macros.snapshotVars().global)
  const env: ScriptEnv = {
    expand: (text) => macros.expand(text),
    getVar: (name) => macros.getVar(name),
    setVar: (name, value) => { macros.setVar(name, value) },
    deleteVar: (name) => macros.deleteVar(name),
    getGlobalVar: (name) => macros.getGlobalVar(name),
    setGlobalVar: (name, value) => { macros.setGlobalVar(name, value) },
    deleteGlobalVar: (name) => macros.deleteGlobalVar(name),
    echo: () => {},
  }
  for (const automationId of automationIds) {
    const key = `${characterName}\u0000${chatId}\u0000${automationId}`
    if (runningWorldInfoAutomations.has(key)) continue
    runningWorldInfoAutomations.add(key)
    try {
      for (const set of quickReplySetsForAutomation(state, automationId)) {
        for (const command of set.commands) {
          try {
            await runScript(command, env)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-soulmojito: world info automation '${automationId}' command failed: ${message}`)
          }
        }
      }
    } finally {
      runningWorldInfoAutomations.delete(key)
    }
  }
  const globals = macros.snapshotVars().global
  if (JSON.stringify(globals) !== globalsBefore) await db.updateState(() => ({ scriptGlobals: globals }))
}
