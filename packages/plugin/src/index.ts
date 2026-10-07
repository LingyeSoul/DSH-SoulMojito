import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  RegexPlacement,
  decodeCharxAsset,
  detectPresetKind,
  parseContextTemplate,
  parseInstructTemplate,
  parsePreset,
  parseRegexScripts,
} from '../../tavern-format/src/index.js'
import { activateWorldInfo } from '../../tavern-lore/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { assemblePrompt, buildGroupTurn, pickGroupMember } from '../../tavern-pipeline/src/index.js'
import { applyRegexScripts, runScript } from '../../tavern-script/src/index.js'
import {
  ChatRevisionConflictError,
  MemoryStore,
  NovelCapabilityError,
  NovelConfigError,
  NovelDuplicateCommitError,
  NovelLengthLimitError,
  NovelNotFoundError,
  NovelOwnershipError,
  NovelPreconditionError,
  NovelRequirementConflictError,
  NovelRevisionConflictError,
  NovelStaleUnitError,
  NovelStorageCorruptionError,
  NovelStore,
  TavernStore,
  VariableStore,
  isValidNovelId,
  summarizeNovel,
  totalEffectiveCharacters,
  validateCreateConfig,
  type NovelCreateConfig,
  type NovelRunBudgets,
  type NovelSnapshot,
  type TavernModelSelection,
  type WriterMode,
} from '../../tavern-store/src/index.js'
import { describeHostShape, hostPluginMessageSource, hostSessionFormatVersion, readSessionEvents, sessionEvents, type HostSessionLog } from '../../bind/src/index.js'
import {
  AGENT_TAVERN_PRESET_ID,
  bootstrapAgentTavernCapabilities,
  inspectAgentTavernCapabilities,
  type AgentTavernCapabilities,
} from './agent-tavern/capabilities.js'
import { AGENT_NOVEL_PRESET_ID, inspectAgentNovelCapabilities, inspectWriterSubagentCapabilities, type AgentNovelCapabilities } from './agent-novel/capabilities.js'
import { NovelDriver, recoverNovels, type DriverAgentLike } from './agent-novel/driver.js'
import { unitTargetRange } from './agent-novel/outline.js'
import { NovelProjector } from './agent-novel/projector.js'
import { isNovelAuthorMessage, receiveAuthorMessage } from './agent-novel/requirements.js'
import { createDshAgentTavernAdapter } from './agent-tavern/dsh-adapter.js'
import { addGuide, emitGuidesChanged, formatGuidesBlock, normalizeGuides, removeGuide } from './guides.js'
import {
  readChatVariables,
  readMvuReceipts,
  recordMvuTurnReceipt,
  renderMvuStatusTemplate,
  retryMvuSettlement,
  snapshotChatVariables,
  statusTemplateOf,
} from './mvu.js'
import { registerAgentTavernAnchor } from './agent-tavern/anchor.js'
import { AgentTavernProjector, historyImportAppends, isTavernSessionMarker, lastImportedTurn, type SessionImportAppend } from './agent-tavern/projector.js'
import { subagentRuntimeOf, type DeductionExecAgent, type SubagentRuntimeLike } from './agent-tavern/deduce.js'
import { buildAgentTavernPreloadSnapshot, collectRegexScripts, collectWorldInfoBooks } from './tavern-assets.js'
import { createGenerationTemplates, mergeTemplateLocalVars, type GenerationTemplates } from './template.js'
import { runCandidateGeneration } from './candidates.js'
import {
  applyScriptBinding,
  boundScriptOf,
  formatScriptBlock,
  getScript,
  importScript,
  listScripts,
  normalizeScriptProgress,
  shouldAdvance,
} from '../../tavern-store/src/index.js'
import { formatRewriteBlock, optionalFeedback } from './rewrite.js'
import { saveOriginalSnapshot } from '../../tavern-store/src/index.js'
import { dshHomePath } from './dsh-home.js'
import { TavernUpdateService, updateChangelog } from './update/service.js'
// 卡片工作台方案确认协议（提案 0013 P2）：方案存储在 card-workbench/plans.ts，
// 执行核（写入 + applied 标记）在 card-workbench/agent.ts，路由块在 mvu/status 之后。
import { decideCardPlan, getCardPlan, listCardPlans } from './card-workbench/plans.js'
import { executeCardPlan } from './card-workbench/agent.js'

// 构建期 stamp：由 scripts/build-plugin.mjs 经 esbuild define 注入，用于在
// 没有 version.json / 没有 .git 的安装现场给出「跑的是哪个版本和 commit」。
declare const __TAVERN_VERSION__: string | undefined
declare const __TAVERN_COMMIT__: string | undefined

export const name = 'dsh-tavern'
export const inject = ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction']

const API = '/api/dsh-tavern'
const DEFAULT_USER = 'User'
const TAVERN_WORKSPACE_TITLE = 'Tavern (internal)'
const BUILD_INFO = readBuildInfo()
const TAVERN_COMMIT = resolveTavernCommit(BUILD_INFO.commit)
let storePromise
let memoryStorePromise: Promise<MemoryStore> | undefined
let variableStorePromise: Promise<VariableStore> | undefined
let activeAgentPrompt = ''
let agentTavernCapabilities: AgentTavernCapabilities = inspectAgentTavernCapabilities({})
let agentTavernCapabilitiesPromise: Promise<AgentTavernCapabilities> | undefined
let agentTavernProjectorPromise: Promise<AgentTavernProjector> | undefined
// AgentNovel mount state (proposal 0005 §4.2/§12): capabilities are inspected
// once at apply (§16); the store/projector/driver follow the storePromise
// memoization pattern so a single DSH home owns a single writer.
let agentNovelCapabilities: AgentNovelCapabilities = inspectAgentNovelCapabilities({})
let novelStorePromise: Promise<NovelStore> | undefined
let novelProjectorPromise: Promise<NovelProjector> | undefined
let novelDriverPromise: Promise<NovelDriver | undefined> | undefined
// 自更新服务（GitHub 版本发现 + 一键更新）：单进程单实例，apply 时启动自动轮询，
// HTTP 路由与 bootstrap 共用同一份快照。开关由 profile 配置/环境变量决定，
// 在这里记一次供路由与 bootstrap 复用。
let updateServiceInstance: TavernUpdateService | undefined
let updateChecksEnabledFlag = true
// Prompt Template（提案 0008）总开关：默认开启；profile 行 templateEnabled: false
// 或 DSH_TAVERN_DISABLE_TEMPLATES=1 关闭。无模板标签时链路直通，无额外开销。
let templatesEnabledFlag = true

class TavernArchitectureConflictError extends Error {
  readonly code = 'TAVERN_ARCHITECTURE_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'TavernArchitectureConflictError'
  }
}

function store() {
  return (storePromise ??= TavernStore.open(dshHomePath('tavern')))
}

function memories() {
  return (memoryStorePromise ??= MemoryStore.open(dshHomePath('tavern')))
}

function variables() {
  return (variableStorePromise ??= VariableStore.open(dshHomePath('tavern')))
}

function novelStore(): Promise<NovelStore> {
  return (novelStorePromise ??= NovelStore.open(dshHomePath('tavern')))
}

/**
 * 自更新服务：默认开启自动发现（延迟首查 + 6h 复查），profile 里给 dsh-tavern
 * 行写 `checkForUpdates: false` 或设 `DSH_TAVERN_DISABLE_UPDATE_CHECK=1` 可关闭。
 * 本地 stamp 取构建期注入的 version/commit（见 readBuildInfo）——git 安装没有
 * version.json 旁车文件，只有构建期 define 才能在安装现场说清「跑的是哪个 commit」。
 */
function tavernUpdate(ctx): TavernUpdateService {
  // HMR recompose 复用同一 module generation 重挂时，旧实例已被上一个 effect
  // 的 disposer 走到 dispose()——它的定时器与 pluginManager 监听都已拆除，
  // start() 会短路。这里检测已 dispose 就地重建，自动检查才不会静默死亡
  // （手动 check/install 路由拿的也是同一实例）。
  if (updateServiceInstance !== undefined && !updateServiceInstance.isDisposed) return updateServiceInstance
  updateServiceInstance = new TavernUpdateService({
    ctx,
    home: dshHomePath('tavern'),
    pluginDir: import.meta.dirname,
    local: { version: BUILD_INFO.version, commit: TAVERN_COMMIT },
    enabled: updateChecksEnabledFlag,
  })
  return updateServiceInstance
}

/**
 * 自动发现的开关：profile 的 dsh-tavern 行 `checkForUpdates: false`
 * 或环境变量 `DSH_TAVERN_DISABLE_UPDATE_CHECK` 非空即关闭。
 */
function updateChecksEnabled(config: { checkForUpdates?: unknown } = {}): boolean {
  if (config.checkForUpdates === false) return false
  const disabled = process.env.DSH_TAVERN_DISABLE_UPDATE_CHECK?.trim()
  return !(disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')
}

/**
 * Prompt Template 开关（提案 0008）：profile 的 dsh-tavern 行 `templateEnabled: false`
 * 或环境变量 `DSH_TAVERN_DISABLE_TEMPLATES` 非空即关闭。
 */
function templatesEnabled(config: { templateEnabled?: unknown } = {}): boolean {
  if (config.templateEnabled === false) return false
  const disabled = process.env.DSH_TAVERN_DISABLE_TEMPLATES?.trim()
  return !(disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')
}

export function apply(ctx, config: { anchorEveryTurns?: unknown, checkForUpdates?: unknown, templateEnabled?: unknown } = {}) {
  registerAgentTavernAnchor(ctx, { everyTurns: config.anchorEveryTurns })
  updateChecksEnabledFlag = updateChecksEnabled(config)
  templatesEnabledFlag = templatesEnabled(config)
  const adapter = createDshAgentTavernAdapter(ctx)
  // 宿主形状一次性上报：rc.6 与 0.1.2+ 的绑定路径差异排查从这行日志读起。
  ctx.logger?.info?.(`dsh-tavern host shape: ${JSON.stringify(describeHostShape(ctx))}`)
  agentTavernCapabilitiesPromise = bootstrapAgentTavernCapabilities(adapter, {
    presetId: AGENT_TAVERN_PRESET_ID,
    ensurePreset: () => ensureAgentPresetDeclared(ctx, AGENT_TAVERN_PRESET_ID),
  })
  void agentTavernCapabilitiesPromise.then((value) => { agentTavernCapabilities = value })
  agentTavernProjectorPromise = store().then((db) => AgentTavernProjector.open(dshHomePath('tavern'), db))
  // AgentNovel capability snapshot (proposal 0005 §16): read by the bootstrap
  // route and the novel-open command. Pure shape probing; the bundled preset
  // declaration (bundle cordis.patch.yml row) is asserted on demand via
  // ensureAgentPresetDeclared, not forced here.
  agentNovelCapabilities = inspectAgentNovelCapabilities(ctx)
  novelProjectorPromise = Promise.all([novelStore(), memories()])
    .then(([store, memory]) => NovelProjector.open(dshHomePath('tavern'), store, memory))
  novelDriverPromise = Promise.all([novelStore(), store(), novelProjectorPromise])
    .then(([novelDb, tavern, projector]) => {
      // The driver subscribes agent/created|disposed|status itself and owns
      // its gated degradation (§12.1); dispose rides the effect hook.
      const driver = NovelDriver.create(ctx, { store: novelDb, tavern, projector })
      try {
        // ctx.effect runs the callback now and calls its return value at
        // unload; returning the disposer keeps that contract intact.
        ctx.effect?.(() => () => { void driver.dispose() }, 'dsh-tavern:novel-driver-dispose')
      } catch {
        // A host that rejects a late effect registration only loses unload
        // disposal; scheduling itself is unaffected.
      }
      return driver
    })
    .catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-tavern: AgentNovel driver unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  ctx.on?.('session/event', (session, event) => {
    void agentTavernProjectorPromise!.then((projector) => projector.project(session, event))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection failed: ${error instanceof Error ? error.message : String(error)}`))
    // turn 作用域变量是单轮 scratch 状态，turn 结束即过期。
    if (event?.type === 'turn/end' && typeof session?.id === 'string') {
      void variables().then((store) => store.clear('turn', session.id)).catch(() => {})
    }
    // AgentNovel (proposal 0005 §9.1/§12.1): the receive barrier and the turn
    // accounting ride the SAME listener; no second session/event subscription.
    void handleNovelSessionEvent(ctx, session, event)
  })
  ctx.on?.('agent/created', ({ agent }) => {
    void agentTavernProjectorPromise!.then((projector) => projector.replay(agent.session))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection replay failed: ${error instanceof Error ? error.message : String(error)}`))
  })
  void refreshActivePrompt()
  // §12.3 restart recovery runs after apply returns; it never blocks mounting.
  void recoverMountedNovels(ctx)
  ctx.systemPrompt.section({
    name: 'dsh-tavern:active-character',
    order: 25,
    text: () => activeAgentPrompt,
  })

  ctx.commands.register({
    // Internal bridge for the client binding API. It is intentionally separate
    // from the public slash-command surface.
    name: 'dsh-tavern-session',
    description: 'internal dsh-tavern session bridge',
    input: { hint: '<character> <chat-id>' },
    recordInput: false,
    handler: async ({ agent, rawInput }) => {
      const parsed = parseTavernSessionCommand(rawInput)
      if (!parsed) return { kind: 'error', text: 'Invalid Tavern activation payload.' }
      const db = await store()
      if (parsed.action === 'close') {
        await db.updateState((state) => {
          const sessionBindings = { ...state.sessionBindings }
          delete sessionBindings[agent.id]
          return { sessionBindings }
        })
        agent.session.append('user/message', createMessage({
          role: 'user',
          content: [{ type: 'text', text: 'Tavern roleplay mode closed.' }],
          source: hostPluginMessageSource(agent.session, {
            form: 'notice',
            summary: 'Tavern closed',
          }),
        }), { surfaceOp: 'append' })
        return { kind: 'success', text: 'Tavern closed' }
      }
      if (parsed.action === 'novel-open') {
        return handleNovelOpenCommand(ctx, agent, parsed.novelId)
      }
      const chat = await db.getChat(parsed.character, parsed.chatId)
      if (!chat) return { kind: 'error', text: 'Tavern chat not found.' }
      const currentState = await db.getState()
      const previous = currentState.sessionBindings[agent.id]
      const initializeAgentTavern = parsed.architecture === 'agent-tavern'
        && (previous?.architecture !== 'agent-tavern' || previous.initializationPending === true)
      const shouldPreloadAssets = initializeAgentTavern
        && parsed.group !== true
        && currentState.agentTavernPreloadAssets === true
      let preloadSnapshot: string | undefined
      let historyImport: SessionImportAppend[] | undefined
      await assertAgentTavernAvailable(parsed.architecture, parsed.contextMode)
      if (parsed.architecture === 'agent-tavern') {
        // 客户端修复路径（视图挂载、blank 修复）会对已激活会话重发本命令；同绑定
        // 的重复激活必须幂等成功，否则开场白导入写入的 turn 会把修复变成用户可见
        // 的报错。已启动的会话只锁定换绑定目标（换角色/聊天或从 ST 转换会换预设）。
        const sameTavernBinding = previous?.architecture === 'agent-tavern'
          && previous.character === parsed.character
          && previous.chatId === parsed.chatId
        // 宿主 0.1.2 起事件日志经 host-session 兼容层读取（events →
        // snapshotEvents() → log）；同一激活流程内无追加，读一次即可。
        const activationEvents = sessionEvents(agent.session)
        const sessionStarted = activationEvents.some((event) => event.type === 'turn/start')
        const historyImported = activationEvents.some((event) => {
          if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
          const source = event.type === 'user/message'
            ? event.data?.source
            : event.data?.message?.source
          return isTavernSessionMarker(source)
        })
        if ((sessionStarted || historyImported) && !sameTavernBinding) {
          throw new TavernArchitectureConflictError('This host session already started; AgentTavern preset selection is locked.')
        }
        if (typeof ctx.agentPresets?.recompose !== 'function') {
          throw new TavernArchitectureConflictError('The host cannot recompose a blank session with the AgentTavern preset.')
        }
        const character = parsed.group !== true && (initializeAgentTavern || shouldPreloadAssets)
          ? await db.getCharacter(parsed.character)
          : undefined
        if (initializeAgentTavern && parsed.group !== true) {
          // 开场白与既有聊天记录必须先落到原生会话，用户才能在 DSH 会话里看到
          // 角色开口；带插件来源的导入事件由投影器跳过，不会重复写回 JSONL。
          // 历史文本应用 prompt 层正则与宏展开（{{char}}/{{user}}），模型上下文
          // 与 ST 管线一致。会话已有原生 turn 或导入消息（投影器重放先于
          // 激活完成）时历史已在场，跳过导入防重复。
          historyImport = sessionStarted || historyImported
            ? undefined
            : historyImportAppends(chat, agent.id, character ? collectRegexScripts(currentState, character) : [], tavernMacroExpand(currentState, parsed.character, character), agent.session)
        }
        if (shouldPreloadAssets) {
          if (typeof agent.inject !== 'function') {
            throw new TavernArchitectureConflictError('This host cannot preload AgentTavern session context.')
          }
          if (!character) throw new Error('Tavern character not found.')
          preloadSnapshot = await buildAgentTavernPreloadSnapshot(db, currentState, parsed.character, character, tavernMacroExpand(currentState, parsed.character, character))
        }
        // 幂等：重复激活不重复 recompose，也不叠加预设 marker。
        if (!activationEvents.some((event) => event.type === 'agent-preset/selected' && event.data?.agentPreset === AGENT_TAVERN_PRESET_ID)) {
          const preset = await ctx.agentPresets.recompose(agent.ctx, AGENT_TAVERN_PRESET_ID)
          agent.session.append('agent-preset/selected', { agentPreset: preset.id })
        }
      }
      await bindSession(
        db,
        agent.id,
        parsed.character,
        parsed.chatId,
        parsed.group === true,
        parsed.architecture,
        parsed.contextMode,
      )
      if (preloadSnapshot !== undefined) {
        agent.inject(createMessage({
          role: 'user',
          content: [{ type: 'text', text: preloadSnapshot }],
          source: hostPluginMessageSource(agent.session, {
            form: 'notice',
            summary: `AgentTavern preload: ${parsed.character}`,
          }),
        }))
      }
      if (historyImport !== undefined) {
        const importedTurn = lastImportedTurn(historyImport)
        if (importedTurn !== undefined && !canAdvanceHostTurnBase(agent)) {
          // 导入带真实 turn 边界；宿主 loop 的轮次基线不可推进时不能写入，
          // 否则 live loop 的首轮会重复导入轮号，v4 准入把整个会话判成损坏。
          // 代价是这次激活不留导入 marker，"已启动"锁定不建立——宁可在未知宿主上
          // 保留一个合法会话，也不要一个锁死却损坏的会话。
          ctx.logger?.warn?.('AgentTavern history import skipped: the host session exposes no advanceable turn base, so imported turn boundaries would desynchronise the live loop.')
        } else {
          let written
          try {
            for (const item of historyImport) {
              agent.session.append(item.type, item.data, item.surfaceOp === undefined ? undefined : { surfaceOp: item.surfaceOp })
            }
            written = importedTurn
          } catch (error) {
            // 导入失败不阻断绑定；用户仍可直接对话，缺失的历史留在 JSONL 可重放。
            // 半个导入必须兜底关闭已打开的 step/turn，否则损坏的是整个会话。
            written = closeImportBracket(agent, {
              kind: 'error',
              error: { message: 'AgentTavern history import failed', code: 'TAVERN_IMPORT' },
            })
            ctx.logger?.warn?.(`AgentTavern history import failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            if (written !== undefined) advanceHostTurnBase(agent, written)
          }
        }
      }
      await refreshActivePrompt()
      if (parsed.architecture === 'st') occupyHostSession(agent)
      if (parsed.architecture === 'st' && (previous?.character !== parsed.character || previous.chatId !== parsed.chatId)) {
        agent.session.append('user/message', createMessage({
          role: 'user',
          content: [{ type: 'text', text: `Tavern roleplay chat for ${parsed.character}.` }],
          source: hostPluginMessageSource(agent.session, { form: 'notice', summary: `Tavern: ${parsed.character}` }),
        }), { surfaceOp: 'append' })
      }
      return { kind: 'success', text: `Tavern: ${parsed.character}` }
    },
  })

  ctx.effect(() => tavernUpdate(ctx).start(), 'dsh-tavern: update auto-check')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      try {
        await handleApi(ctx, req, res)
      } catch (error) {
        if (!res.writableEnded) {
          // Novel domain errors map onto structured HTTP statuses (§13); the
          // original detail is logged server-side because corruption and
          // ownership messages carry internal paths and pids.
          const novelFailure = novelHttpFailure(error)
          if (novelFailure !== undefined) {
            ctx.logger?.warn?.(`dsh-tavern: novel route failed (${novelFailure.code}): ${error instanceof Error ? error.message : String(error)}`, { operation: 'novels-api', errorCode: novelFailure.code })
          }
          const message = novelFailure?.sanitized === true
            ? `Novel failure '${novelFailure.code}'; see the server log for details.`
            : error instanceof Error ? error.message : String(error)
          const code = error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError
            ? error.code
            : novelFailure?.code
          if (res.headersSent) {
            res.write(JSON.stringify({ type: 'error', message, code }) + '\n')
            res.end()
          } else {
            const status = error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError
              ? 409
              : novelFailure?.status ?? 500
            sendJson(res, status, { ok: false, message, code, ...(novelFailure?.extra ?? {}) })
          }
        }
      }
    },
  }), 'dsh-tavern: API')
}

async function handleApi(ctx, req, res) {
  const url = new URL(req.url ?? API, 'http://localhost')
  const route = url.pathname.slice(API.length).replace(/^\//, '')
  const method = req.method ?? 'GET'

  // 自更新走独立处理器：它不依赖 Tavern store，且在 store 打不开时仍要能回答
  // 「有新版本吗」——升级本身正是修数据/兼容问题的入口。
  if (route === 'update' || route.startsWith('update/')) {
    return handleUpdateApi(ctx, req, res, url, route, method)
  }

  const db = await store()

  if (method === 'GET' && route === 'bootstrap') {
    await agentTavernCapabilitiesPromise
    const internalWorkspace = await prepareInternalWorkspace()
    const state = await db.getState()
    const active = state.activeCharacter ? await db.getCharacter(state.activeCharacter) : undefined
    const groups = []
    for (const name of await db.listGroups()) {
      const group = await db.getGroup(name)
      if (group) groups.push(publicGroup(group))
    }
    const personas = []
    for (const name of await db.listPersonas()) {
      const persona = await db.getPersona(name)
      if (persona) personas.push(persona)
    }
    const presetKinds = {}
    for (const name of await db.listPresets()) {
      const preset = await db.getPreset(name)
      if (preset) presetKinds[name] = detectPresetKind(preset)
    }
    return sendJson(res, 200, {
      ok: true,
      state,
      characters: await db.listCharacters(),
      worlds: await db.listWorlds(),
      presets: await db.listPresets(),
      presetKinds,
      personas,
      groups,
      activeCard: active ? publicCard(active.card) : null,
      model: ctx.agentDefaultModel.currentSelection(),
      version: BUILD_INFO.version,
      commit: TAVERN_COMMIT,
      internalWorkspace,
      agentTavern: agentTavernCapabilities,
      agentNovel: agentNovelCapabilities,
      // 自更新快照：只读缓存结论，检查/安装分别走 update/check 与 update/install，
      // 保证 bootstrap 永远不因网络失败而变慢或报错。
      update: tavernUpdate(ctx).snapshot(),
    })
  }

  if (method === 'GET' && route.startsWith('avatar/')) {
    const name = decodeURIComponent(route.slice('avatar/'.length))
    const found = await db.getCharacter(name)
    if (found) {
      return serveCharacterAvatar(res, db, name, found)
    }
    // 群组：回落第一个启用成员的头像
    const group = await db.getGroup(name)
    if (group) {
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      for (const member of enabled.length > 0 ? enabled : group.members) {
        const memberFile = await db.getCharacter(member)
        if (memberFile) return serveCharacterAvatar(res, db, member, memberFile)
      }
    }
    return sendJson(res, 404, { ok: false, message: 'character avatar not found' })
  }

  if (method === 'GET' && route.startsWith('character/')) {
    const name = decodeURIComponent(route.slice('character/'.length))
    const found = await db.getCharacter(name)
    if (!found) return sendJson(res, 404, { ok: false, message: 'character not found' })
    return sendJson(res, 200, { ok: true, kind: found.kind, card: publicCard(found.card) })
  }

  if (method === 'GET' && route === 'projection') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) throw new Error('sessionId query is required')
    const projector = await agentTavernProjectorPromise
    if (!projector) throw new Error('AgentTavern projector is unavailable')
    return sendJson(res, 200, { ok: true, projection: await projector.status(sessionId) })
  }

  if (method === 'POST' && route === 'projection/replay') {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : url.searchParams.get('sessionId')
    if (!sessionId) throw new Error('sessionId is required')
    const state = await db.getState()
    const binding = state.sessionBindings[sessionId]
    if (!binding || binding.architecture !== 'agent-tavern' || binding.group === true) {
      throw new TavernArchitectureConflictError('Projection replay requires an AgentTavern single-character binding.')
    }
    const agent = ctx.agents?.get?.(sessionId) as { session?: HostSessionLog } | undefined
    const session = agent?.session
    if (!session || readSessionEvents(session) === undefined) {
      throw new Error('AgentTavern session is not loaded in this host process; open the chat first and retry.')
    }
    const projector = await agentTavernProjectorPromise
    if (!projector) throw new Error('AgentTavern projector is unavailable')
    await projector.replay(session as never)
    return sendJson(res, 200, { ok: true, projection: await projector.status(sessionId) })
  }

  if (method === 'POST' && route === 'compact') {
    // /compact 只在宿主 TUI 命令注册表，dsh web 的 HTTP 层不暴露；已超限
    // 会话（真实 usage 超窗）每个请求都溢出，宿主 pre-step 压力压缩与
    // agent/request-error 恢复都救不回，必须显式触发一次压缩。本端点在同
    // 进程内调 curator 的 compactNow，总结走剧情会话的 curatorProvider/Model。
    // 注意：Cordis 的 Context.get(name) 本身支持字符串服务名（cordis 4 的
    // reflect 声明），但插件未 inject 的服务经属性/get 读取会因门控抛错——
    // compaction 已在 inject 列表，这里用 ctx.compaction 属性通道最直接。
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : url.searchParams.get('sessionId')
    if (!sessionId) throw new Error('sessionId is required')
    const agent = ctx.agents?.get?.(sessionId) as { status?: unknown } | undefined
    if (!agent || agent.status !== 'idle') {
      throw new Error(`session ${sessionId} has no idle agent in this host process; pause the novel and retry.`)
    }
    const compaction = ctx.compaction as { compactNow?: (a: unknown, s: AbortSignal, id?: string) => Promise<unknown> } | undefined
    if (!compaction || typeof compaction.compactNow !== 'function') {
      throw new Error('compaction service is unavailable in this host process')
    }
    const result = await compaction.compactNow(agent, new AbortController().signal)
    return sendJson(res, 200, { ok: true, result: result ?? null })
  }

  // 持续指引（提案 0009）：guide 属于单局聊天，随 chat_metadata 持久化；
  // 读写走 getChatSnapshot + saveChat 的 revision CAS，与聊天写路径一致。
  // 路径段解码与 character/ 前缀路由同款 decodeURIComponent（角色名可含空格/中文）。
  if ((method === 'GET' || method === 'POST') && route.startsWith('guides/')) {
    const segments = route.slice('guides/'.length).split('/')
    if (segments.length !== 2) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    if (method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        guides: normalizeGuides(snapshot.chat.header.chat_metadata?.guides),
        revision: snapshot.revision,
      })
    }
    const body = await readJson(req)
    const added = addGuide(normalizeGuides(snapshot.chat.header.chat_metadata?.guides), body.text)
    if (!added.ok) return sendJson(res, 400, { ok: false, message: added.error, code: 'TAVERN_GUIDES' })
    const metadata = { ...snapshot.chat.header.chat_metadata, guides: added.guides }
    const revision = await db.saveChat(character, chatId, {
      ...snapshot.chat,
      header: { ...snapshot.chat.header, chat_metadata: metadata },
    }, snapshot.revision)
    await emitGuidesChanged(character, chatId)
    return sendJson(res, 200, { ok: true, guide: added.guide, guides: added.guides, revision })
  }

  if (method === 'DELETE' && route.startsWith('guides/')) {
    const segments = route.slice('guides/'.length).split('/')
    if (segments.length !== 3) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const id = decodeURIComponent(segments[2])
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    const removed = removeGuide(normalizeGuides(snapshot.chat.header.chat_metadata?.guides), id)
    if (!removed.removed) return sendJson(res, 404, { ok: false, message: 'guide not found' })
    const metadata = { ...snapshot.chat.header.chat_metadata }
    // 清空即摘除键：与 chat_metadata.variables 的空置清理约定一致，导出不含空 guides。
    if (removed.guides.length > 0) metadata.guides = removed.guides
    else delete metadata.guides
    const revision = await db.saveChat(character, chatId, {
      ...snapshot.chat,
      header: { ...snapshot.chat.header, chat_metadata: metadata },
    }, snapshot.revision)
    await emitGuidesChanged(character, chatId)
    return sendJson(res, 200, { ok: true, guides: removed.guides, revision })
  }

  // ---- 剧本游玩（提案 0014 P1）----
  // 剧本库：TXT/MD 素材分块存 <tavern>/scripts/<name>/script.json；绑定在卡
  // data.extensions.agentTavern.scriptId（一对一）；进度在 chat_metadata.scriptProgress，
  // 由生成链路的对齐推进写。进度是展示不是跳章（§4）：没有写进度的路由。
  if (method === 'POST' && route === 'script/import') {
    const body = await readJson(req, 8 * 1024 * 1024)
    let imported
    try {
      // EPUB（提案 0014 P2）：content 为 base64 编码的 zip 字节，解码后走
      // importScript 的二进制分支（parseEpubText）；8MB 上限对 base64 文本照旧。
      imported = await importScript(
        dshHomePath('tavern'),
        body.name,
        body.format === 'epub'
          ? Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64')
          : body.content,
        body.format,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return sendJson(res, 400, { ok: false, message, code: 'TAVERN_SCRIPT' })
    }
    return sendJson(res, 200, {
      ok: true,
      script: {
        name: imported.name,
        source: imported.source,
        chunkCount: imported.chunks.length,
        chunks: imported.chunks,
      },
    })
  }

  if (method === 'GET' && route === 'scripts') {
    const scripts = await listScripts(dshHomePath('tavern'))
    const bindings: Record<string, string> = {}
    for (const name of await db.listCharacters()) {
      const file = await db.getCharacter(name)
      const bound = file === undefined ? undefined : boundScriptOf(file.card)
      if (bound !== undefined) bindings[name] = bound
    }
    return sendJson(res, 200, { ok: true, scripts, bindings })
  }

  // progress 路由必须先于通用 script/<name> 匹配（同为 script/ 前缀）
  if (method === 'GET' && route.startsWith('script/progress/')) {
    const segments = route.slice('script/progress/'.length).split('/')
    if (segments.length !== 2) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const file = await db.getCharacter(character)
    if (!file) return sendJson(res, 404, { ok: false, message: 'character not found' })
    const scriptName = boundScriptOf(file.card)
    if (scriptName === undefined) return sendJson(res, 404, { ok: false, message: 'no script bound to this character' })
    const script = await getScript(dshHomePath('tavern'), scriptName)
    if (!script) return sendJson(res, 404, { ok: false, message: `script '${scriptName}' not found` })
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    const progress = normalizeScriptProgress(snapshot.chat.header.chat_metadata?.scriptProgress)
    const active = progress !== undefined && progress.scriptName === scriptName ? progress : undefined
    const chunkIndex = active !== undefined ? Math.min(active.chunkIndex, script.chunks.length - 1) : 0
    return sendJson(res, 200, {
      ok: true,
      scriptName,
      chunkIndex,
      chunkCount: script.chunks.length,
      currentPreview: script.chunks[chunkIndex]?.text.slice(0, 400) ?? '',
      nextPreview: script.chunks[chunkIndex + 1]?.text.slice(0, 400) ?? '',
      alignedAt: active?.alignedAt ?? null,
    })
  }

  if (method === 'GET' && route.startsWith('script/')) {
    const name = decodeURIComponent(route.slice('script/'.length))
    if (name === '' || name.includes('/')) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const script = await getScript(dshHomePath('tavern'), name)
    if (!script) return sendJson(res, 404, { ok: false, message: `script '${name}' not found` })
    return sendJson(res, 200, { ok: true, script: { name: script.name, source: script.source, chunks: script.chunks } })
  }

  if (method === 'POST' && (route === 'script/bind' || route === 'script/unbind')) {
    const body = await readJson(req)
    const characterName = typeof body.character === 'string' ? body.character : ''
    if (characterName === '') throw new Error('character is required')
    const binding = route === 'script/bind' && typeof body.scriptName === 'string' ? body.scriptName.trim() : undefined
    if (route === 'script/bind' && (binding === undefined || binding === '')) {
      throw new Error('scriptName is required')
    }
    if (binding !== undefined) {
      const script = await getScript(dshHomePath('tavern'), binding)
      if (!script) return sendJson(res, 404, { ok: false, message: `script '${binding}' not found` })
    }
    try {
      await applyScriptBinding(db, characterName, binding)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('not found')) return sendJson(res, 404, { ok: false, message })
      throw error
    }
    return sendJson(res, 200, { ok: true, character: characterName, scriptName: binding ?? null })
  }

  if (method === 'GET' && route === 'agent-tavern/audit') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) throw new Error('sessionId query is required')
    const state = await db.getState()
    const binding = state.sessionBindings[sessionId]
    if (!binding || binding.architecture !== 'agent-tavern' || binding.group === true) {
      throw new TavernArchitectureConflictError('AgentTavern audit requires a native single-character binding.')
    }
    const scopes = [
      { scope: 'chat' as const, scopeId: binding.chatId },
      { scope: 'character' as const, scopeId: binding.character },
      { scope: 'agent' as const, scopeId: sessionId },
    ]
    const [memoryGroups, variableGroups, globalMemories, globalVariables, projector] = await Promise.all([
      Promise.all(scopes.map(({ scope, scopeId }) => memories().then((store) => store.search({
        scope, scopeId, includeDeleted: true, limit: 50,
      })))),
      Promise.all(scopes.map(({ scope, scopeId }) => variables().then((store) => store.list(scope, scopeId, '', 100)))),
      memories().then((store) => store.search({ scope: 'global', includeDeleted: true, limit: 50 })),
      variables().then((store) => store.list('global', 'global', '', 100)),
      agentTavernProjectorPromise,
    ])
    return sendJson(res, 200, {
      ok: true,
      architecture: binding.architecture,
      contextMode: binding.contextMode,
      projection: projector ? await projector.status(sessionId) : null,
      memories: [...memoryGroups.flat().map((hit) => hit.record), ...globalMemories.map((hit) => hit.record)],
      variables: [...variableGroups.flat(), ...globalVariables],
    })
  }

  if (route === 'novels' || route.startsWith('novels/')) {
    return handleNovelsApi(ctx, req, res, url, route, method)
  }

  if (method === 'PUT' && route.startsWith('character/')) {
    const oldName = decodeURIComponent(route.slice('character/'.length))
    const body = await readJson(req, 25 * 1024 * 1024)
    if (!body.card || typeof body.card !== 'object' || Array.isArray(body.card)) {
      throw new Error('expected { card }')
    }
    clampIdentitySummary(body.card)
    const saved = await db.updateCharacter(oldName, body.card)
    const nextName = saved.card.data.name
    const state = await db.updateState((current) => {
      const activeCharacter = current.activeCharacter === oldName ? nextName : current.activeCharacter
      const sessionBindings = Object.fromEntries(Object.entries(current.sessionBindings).map(([sessionId, binding]) => [
        sessionId,
        binding.character === oldName && binding.group !== true ? { ...binding, character: nextName } : binding,
      ]))
      const prefix = `${oldName}\u0000`
      const chats = nextName === oldName
        ? current.chats
        : Object.fromEntries(Object.entries(current.chats).map(([key, value]) => [
            key.startsWith(prefix) ? `${nextName}\u0000${key.slice(prefix.length)}` : key,
            value,
          ]))
      return { activeCharacter, sessionBindings, chats }
    })
    if (nextName !== oldName) {
      for (const groupName of await db.listGroups()) {
        const group = await db.getGroup(groupName)
        if (group?.members.includes(oldName)) {
          await db.putGroup({
            ...group,
            members: group.members.map((member) => member === oldName ? nextName : member),
            disabledMembers: group.disabledMembers.map((member) => member === oldName ? nextName : member),
          })
        }
      }
    }
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, kind: saved.kind, card: publicCard(saved.card), state })
  }

  if (method === 'DELETE' && route === 'character') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const found = await db.getCharacter(name)
    if (!found) return sendJson(res, 404, { ok: false, message: 'character not found' })
    await db.deleteCharacter(name)
    for (const groupName of await db.listGroups()) {
      const group = await db.getGroup(groupName)
      if (group?.members.includes(name)) {
        await db.putGroup({
          ...group,
          members: group.members.filter((member) => member !== name),
          disabledMembers: group.disabledMembers.filter((member) => member !== name),
        })
      }
    }
    // 群组绑定按组名寻址，与同名角色互不影响；这里只清 solo 绑定。
    const state = await db.updateState((current) => ({
      activeCharacter: current.activeCharacter === name ? undefined : current.activeCharacter,
      sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings)
        .filter(([, binding]) => !(binding.character === name && binding.group !== true))),
    }))
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'GET' && route.startsWith('export/character/')) {
    const name = decodeURIComponent(route.slice('export/character/'.length))
    const found = await db.getCharacter(name)
    if (!found) return sendJson(res, 404, { ok: false, message: 'character not found' })
    const bytes = await db.exportCharacter(name)
    const media = found.kind === 'charx' ? 'application/zip' : found.kind === 'json' ? 'application/json' : 'image/png'
    res.statusCode = 200
    res.setHeader('content-type', media)
    const ext = found.kind === 'charx' ? 'charx' : found.kind === 'json' ? 'json' : 'png'
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(`${name}.${ext}`)}"`)
    res.end(Buffer.from(bytes))
    return
  }

  if (method === 'GET' && route === 'models') {
    return sendJson(res, 200, { ok: true, ...await buildModelCatalog(ctx) })
  }

  if (method === 'POST' && route === 'model') {
    const body = await readJson(req)
    if (typeof body.sessionId !== 'string') throw new Error('expected { sessionId, selection }')
    let selection: TavernModelSelection | null = null
    if (body.selection !== null && body.selection !== undefined) {
      if (typeof body.selection?.provider !== 'string' || typeof body.selection?.model !== 'string') {
        throw new Error('selection must be { provider, model, reasoningEffort? }')
      }
      selection = {
        provider: body.selection.provider,
        model: body.selection.model,
        ...(typeof body.selection.reasoningEffort === 'string' ? { reasoningEffort: body.selection.reasoningEffort } : {}),
      }
    }
    const state = await db.updateState((current) => ({
      modelSelections: selection === null
        ? Object.fromEntries(Object.entries(current.modelSelections ?? {}).filter(([id]) => id !== body.sessionId))
        : { ...(current.modelSelections ?? {}), [body.sessionId]: selection },
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'POST' && route === 'state') {
    const body = await readJson(req)
    if (body.defaultContextMode === 'agent-managed') {
      await assertAgentTavernAvailable('agent-tavern', 'agent-managed')
    } else if (body.defaultArchitecture === 'agent-tavern') {
      const current = await db.getState()
      await assertAgentTavernAvailable(
        'agent-tavern',
        body.defaultContextMode === 'dsh-native' ? 'dsh-native' : current.defaultContextMode,
      )
    }
    // 使用角色时自动激活其绑定的世界书：并入本次 activeWorlds（用户同请求显式给的列表优先保留）
    const activateWorlds = typeof body.activeCharacter === 'string' && body.activeCharacter !== ''
      ? await characterLinkedWorlds(db, body.activeCharacter)
      : []
    const patch = {
      ...(typeof body.activeCharacter === 'string' || body.activeCharacter === null ? { activeCharacter: body.activeCharacter || undefined } : {}),
      ...(Array.isArray(body.activeWorlds) || activateWorlds.length > 0
        ? {
            activeWorlds: [...new Set([
              ...(Array.isArray(body.activeWorlds) ? body.activeWorlds.filter((x) => typeof x === 'string') : (await db.getState()).activeWorlds),
              ...activateWorlds,
            ])],
          }
        : {}),
      ...(typeof body.activePreset === 'string' || body.activePreset === null ? { activePreset: body.activePreset || undefined } : {}),
      ...(typeof body.activePersona === 'string' || body.activePersona === null ? { activePersona: body.activePersona || undefined } : {}),
      ...(typeof body.nativeAgentPersona === 'boolean' ? { nativeAgentPersona: body.nativeAgentPersona } : {}),
      ...(body.defaultArchitecture === 'agent-tavern' || body.defaultArchitecture === 'st'
        ? { defaultArchitecture: body.defaultArchitecture }
        : {}),
      ...(body.defaultContextMode === 'dsh-native' || body.defaultContextMode === 'agent-managed'
        ? { defaultContextMode: body.defaultContextMode }
        : {}),
      ...(typeof body.agentTavernPreloadAssets === 'boolean'
        ? { agentTavernPreloadAssets: body.agentTavernPreloadAssets }
        : {}),
      ...(typeof body.agentTavernAllowGlobalWrites === 'boolean'
        ? { agentTavernAllowGlobalWrites: body.agentTavernAllowGlobalWrites }
        : {}),
      ...(body.compaction !== undefined ? { compaction: compactionOverrideOf(body.compaction) } : {}),
    }
    const state = await db.patchState(patch)
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'POST' && route === 'import/character') {
    const body = await readJson(req, 25 * 1024 * 1024)
    let source
    if (typeof body.pngBase64 === 'string') source = new Uint8Array(Buffer.from(body.pngBase64, 'base64'))
    else if (typeof body.charxBase64 === 'string') source = new Uint8Array(Buffer.from(body.charxBase64, 'base64'))
    else if (body.card && typeof body.card === 'object') source = body.card
    else throw new Error('expected { pngBase64 }, { charxBase64 } or { card }')
    const result = await db.importCharacter(source)
    // 原版快照（提案 0013 P1）：导入成功后 best-effort 一次性保留原版；已存在
    // 不覆盖，失败只记警告不阻断导入——导入语义优先，快照是增值保障。
    try {
      await saveOriginalSnapshot(dshHomePath('tavern'), result.card.data.name, result.card)
    } catch (error) {
      console.warn(`dsh-tavern: original snapshot for '${result.card.data.name}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const current = await db.getState()
    if (!current.activeCharacter) {
      // 首个导入的角色成为活跃角色，并自动激活其绑定的世界书
      const linked = await characterLinkedWorlds(db, result.card.data.name)
      await db.patchState({
        activeCharacter: result.card.data.name,
        ...(linked.length > 0 ? { activeWorlds: [...new Set([...current.activeWorlds, ...linked])] } : {}),
      })
    }
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, name: result.card.data.name, card: publicCard(result.card), world: result.importedWorld ?? null, importedRegex: result.importedRegex })
  }

  if (method === 'POST' && route === 'import/world') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || !body.data || typeof body.data !== 'object') throw new Error('expected { name, data }')
    const book = await db.importWorldFile(body.name, body.data)
    return sendJson(res, 200, { ok: true, name: book.name, entries: book.entries.length })
  }

  if (method === 'POST' && route === 'import/preset') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || !body.data || typeof body.data !== 'object') throw new Error('expected { name, data }')
    parsePresetOrThrow(body.data)
    await db.putPreset(body.name, body.data)
    return sendJson(res, 200, { ok: true, name: body.name, kind: detectPresetKind(body.data) })
  }

  if (method === 'GET' && route.startsWith('preset/')) {
    const name = decodeURIComponent(route.slice('preset/'.length))
    const data = await db.getPreset(name)
    if (!data) return sendJson(res, 404, { ok: false, message: 'preset not found' })
    return sendJson(res, 200, { ok: true, name, kind: detectPresetKind(data), data })
  }

  if (method === 'PUT' && route.startsWith('preset/')) {
    const oldName = decodeURIComponent(route.slice('preset/'.length))
    const body = await readJson(req, 10 * 1024 * 1024)
    if (typeof body.name !== 'string' || body.name.trim() === '' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      throw new Error('expected { name, data }')
    }
    parsePresetOrThrow(body.data)
    await db.putPreset(body.name, body.data)
    if (body.name !== oldName) await db.deletePreset(oldName)
    const state = await db.updateState((current) => ({
      activePreset: current.activePreset === oldName ? body.name : current.activePreset,
    }))
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, name: body.name, kind: detectPresetKind(body.data), data: body.data, state })
  }

  if (method === 'POST' && route === 'import/persona') {
    const body = await readJson(req, 25 * 1024 * 1024)
    if (typeof body.pngBase64 === 'string' && typeof body.name === 'string') {
      const persona = await db.importPersonaPng(new Uint8Array(Buffer.from(body.pngBase64, 'base64')), body.name)
      return sendJson(res, 200, { ok: true, persona })
    }
    if (typeof body.name === 'string') {
      const persona = {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : '',
        ...(typeof body.position === 'number' ? { position: body.position } : {}),
        ...(typeof body.depth === 'number' ? { depth: body.depth } : {}),
        ...(typeof body.role === 'number' ? { role: body.role } : {}),
        ...(body.hasAvatar === true ? { hasAvatar: true } : {}),
      }
      await db.putPersona(persona)
      return sendJson(res, 200, { ok: true, persona })
    }
    throw new Error('expected { pngBase64, name } or { name, description }')
  }

  if (method === 'PUT' && route === 'persona') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || typeof body.description !== 'string') throw new Error('expected { name, description }')
    const existing = await db.getPersona(body.name)
    if (!existing) throw new Error(`persona '${body.name}' not found`)
    const persona = {
      ...existing,
      description: body.description,
      ...(typeof body.position === 'number' ? { position: body.position } : {}),
      ...(typeof body.depth === 'number' ? { depth: body.depth } : {}),
      ...(typeof body.role === 'number' ? { role: body.role } : {}),
    }
    await db.putPersona(persona)
    return sendJson(res, 200, { ok: true, persona })
  }

  if (method === 'DELETE' && route === 'persona') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const deleted = await db.deletePersona(name)
    const state = await db.updateState((current) => ({
      activePersona: current.activePersona === name ? undefined : current.activePersona,
    }))
    if (!deleted) return sendJson(res, 404, { ok: false, message: 'persona not found' })
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'GET' && route.startsWith('persona-avatar/')) {
    const name = decodeURIComponent(route.slice('persona-avatar/'.length))
    const avatar = await db.getPersonaAvatar(name)
    if (avatar === undefined) return sendJson(res, 404, { ok: false, message: 'persona avatar not found' })
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'private, max-age=300')
    res.end(Buffer.from(avatar))
    return
  }

  if (method === 'GET' && route === 'groups') {
    const groups = []
    for (const name of await db.listGroups()) {
      const group = await db.getGroup(name)
      if (group) groups.push(publicGroup(group))
    }
    return sendJson(res, 200, { ok: true, groups })
  }

  if (method === 'POST' && route === 'groups') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || !Array.isArray(body.members)) throw new Error('expected { name, members }')
    for (const member of body.members) {
      if (typeof member !== 'string' || !(await db.getCharacter(member))) {
        throw new Error(`group member '${String(member)}' is not an imported character`)
      }
    }
    await db.putGroup({
      id: `group-${body.name}`,
      name: body.name,
      members: body.members,
      allowSelfResponses: body.allowSelfResponses === true,
      activationStrategy: body.activationStrategy === 2 ? 2 : 1,
      disabledMembers: Array.isArray(body.disabledMembers) ? body.disabledMembers.filter((x) => typeof x === 'string') : [],
      chatId: '',
      chats: [],
      autoModeDelay: 3,
    })
    const group = await db.getGroup(body.name)
    return sendJson(res, 200, { ok: true, group: publicGroup(group) })
  }

  if (method === 'PUT' && route === 'group') {
    const body = await readJson(req)
    if (typeof body.name !== 'string') throw new Error('expected { name, ... }')
    const group = await db.getGroup(body.name)
    if (!group) throw new Error(`group '${body.name}' not found`)
    const members = Array.isArray(body.members) ? body.members.filter((x) => typeof x === 'string') : group.members
    for (const member of members) {
      if (!(await db.getCharacter(member))) throw new Error(`group member '${member}' is not an imported character`)
    }
    await db.putGroup({
      ...group,
      members,
      ...(Array.isArray(body.disabledMembers) ? { disabledMembers: body.disabledMembers.filter((x) => typeof x === 'string' && members.includes(x)) } : {}),
      ...(typeof body.activationStrategy === 'number' ? { activationStrategy: body.activationStrategy === 2 ? 2 : 1 } : {}),
      ...(typeof body.allowSelfResponses === 'boolean' ? { allowSelfResponses: body.allowSelfResponses } : {}),
    })
    return sendJson(res, 200, { ok: true, group: publicGroup(await db.getGroup(body.name)) })
  }

  if (method === 'DELETE' && route === 'group') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const group = await db.getGroup(name)
    if (!group) return sendJson(res, 404, { ok: false, message: 'group not found' })
    await db.deleteGroup(name)
    const state = await db.updateState((current) => ({
      sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings)
        .filter(([, binding]) => !(binding.character === name && binding.group === true))),
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'POST' && route === 'binding') {
    const body = await readJson(req)
    if (typeof body.sessionId !== 'string' || typeof body.character !== 'string' || typeof body.chatId !== 'string') {
      throw new Error('expected { sessionId, character, chatId }')
    }
    const chat = await db.getChat(body.character, body.chatId)
    if (!chat) throw new Error('chat not found')
    const group = body.group === true
    const architecture = group ? 'st' : requestedArchitecture(body.architecture)
    const contextMode = requestedContextMode(body.contextMode)
    await assertAgentTavernAvailable(architecture, contextMode)
    const state = await bindSession(db, body.sessionId, body.character, body.chatId, group, architecture, contextMode, true)
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, state, binding: state.sessionBindings[body.sessionId] })
  }

  if (method === 'DELETE' && route === 'binding') {
    const body = await readJson(req)
    if (typeof body.sessionId !== 'string') throw new Error('expected { sessionId }')
    const next = await db.updateState((state) => {
      const sessionBindings = { ...state.sessionBindings }
      delete sessionBindings[body.sessionId]
      return { sessionBindings }
    })
    return sendJson(res, 200, { ok: true, state: next })
  }

  if (method === 'POST' && route === 'bindings/prune') {
    const body = await readJson(req)
    if (!Array.isArray(body.sessionIds) || body.sessionIds.some((value) => typeof value !== 'string')) {
      throw new Error('expected { sessionIds }')
    }
    const live = new Set(body.sessionIds)
    const state = await db.updateState((current) => ({
      sessionBindings: Object.fromEntries(
        Object.entries(current.sessionBindings).filter(([sessionId]) => live.has(sessionId)),
      ),
      modelSelections: Object.fromEntries(
        Object.entries(current.modelSelections ?? {}).filter(([sessionId]) => live.has(sessionId)),
      ),
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'GET' && route === 'chats') {
    const character = url.searchParams.get('character')
    if (!character) throw new Error('character query is required')
    return sendJson(res, 200, { ok: true, chats: await db.listChats(character) })
  }

  if (method === 'POST' && route === 'chats') {
    const body = await readJson(req)
    const now = new Date().toISOString()
    if (typeof body.group === 'string') {
      const group = await db.getGroup(body.group)
      if (!group) throw new Error(`group '${body.group}' not found`)
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      const greetings = []
      for (const member of enabled) {
        const file = await db.getCharacter(member)
        const only = Array.isArray(file?.card.data.groupOnlyGreetings) ? file.card.data.groupOnlyGreetings : []
        const text = only[0]
        if (typeof text === 'string' && text.trim() !== '') {
          greetings.push({ name: member, is_user: false, is_system: false, send_date: now, mes: text })
        }
      }
      const id = await db.createChat(body.group, {
        user_name: 'unused', character_name: 'unused',
        chat_metadata: {
          group: { members: group.members, disabledMembers: group.disabledMembers },
          createdAt: now, timedWorldInfo: {},
        },
      }, greetings)
      const snapshot = await db.getChatSnapshot(body.group, id)
      return sendJson(res, 200, { ok: true, id, group: body.group, chat: snapshot?.chat, revision: snapshot?.revision })
    }
    const character = typeof body.character === 'string' ? body.character : (await db.getState()).activeCharacter
    if (!character) throw new Error('no active character')
    const found = await db.getCharacter(character)
    if (!found) throw new Error(`character '${character}' not found`)
    const id = await db.createChat(character, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { character, createdAt: now, timedWorldInfo: {} },
    }, [{
      name: found.card.data.nickname || found.card.data.name,
      is_user: false, is_system: false, send_date: now,
      mes: found.card.data.firstMes,
      swipe_id: 0,
      swipes: [found.card.data.firstMes, ...found.card.data.alternateGreetings],
      swipe_info: [{ send_date: now }, ...found.card.data.alternateGreetings.map(() => ({ send_date: now }))],
    }])
    const snapshot = await db.getChatSnapshot(character, id)
    return sendJson(res, 200, { ok: true, id, chat: snapshot?.chat, revision: snapshot?.revision })
  }

  if (method === 'POST' && route === 'branch') {
    const body = await readJson(req)
    if (typeof body.character !== 'string' || typeof body.chatId !== 'string' || typeof body.messageId !== 'number') {
      throw new Error('expected { character, chatId, messageId, revision }')
    }
    if (typeof body.revision !== 'string') throw new Error('revision is required')
    const originArchitecture = body.originArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st'
    const targetArchitecture = body.targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st'
    const result = await db.branchChat(body.character, body.chatId, body.messageId, body.revision, body.name, {
      agentTavernOrigin: {
        architecture: originArchitecture,
        targetArchitecture,
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      },
    })
    const snapshot = await db.getChatSnapshot(body.character, result.chatId)
    return sendJson(res, 200, { ok: true, id: result.chatId, chat: snapshot?.chat ?? result.chat, revision: snapshot?.revision })
  }

  // 行动候选（提案 0010）：独立轻量请求，与正文生成解耦；失败不落聊天。
  if (method === 'POST' && route === 'candidates') {
    const body = await readJson(req)
    const state = await db.getState()
    assertStGenerationBinding(state, body.sessionId)
    const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
    const chatId = body.chatId
    if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
    if (typeof body.revision !== 'string') throw new Error('revision is required')
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (!snapshot) throw new Error('character or chat not found')
    const feedback = optionalFeedback(body.feedback)
    const result = await runCandidateGeneration(ctx, db, {
      state,
      characterName,
      chatId,
      snapshot,
      feedback,
      revision: body.revision,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
    })
    return sendJson(res, 200, { ok: true, items: result.items, generatedAt: result.generatedAt, revision: result.revision })
  }

  // MVU 结算重试（提案 0012 P1）：只对最后一条助手楼层重跑模板输出渲染的变量
  // 写穿部分（不重跑 AI_OUTPUT regex——非幂等），正文不动；CAS 冲突走既有通道。
  if (method === 'POST' && route === 'mvu/retry') {
    const body = await readJson(req)
    const state = await db.getState()
    assertStGenerationBinding(state, body.sessionId)
    const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
    const chatId = body.chatId
    if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
    if (typeof body.revision !== 'string') throw new Error('revision is required')
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (!snapshot) throw new Error('character or chat not found')
    const result = await retryMvuSettlement(db, {
      state,
      characterName,
      chatId,
      snapshot,
      revision: body.revision,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      templatesActive: templatesEnabledFlag && templatesEnabled(),
    })
    return sendJson(res, 200, { ok: true, receipt: result.receipt, revision: result.revision, variables: result.variables })
  }

  // MVU 状态（提案 0012 P1）：变量 + 回执快照；卡片约定字段
  // data.extensions.agentTavern.statusTemplate（0013 工作台产出）存在时附带
  // 模板化 renderedHtml（接线点）；渲染失败降级为不返回该字段，不 500。
  if (method === 'GET' && route.startsWith('mvu/status/')) {
    const rest = route.slice('mvu/status/'.length)
    const separator = rest.indexOf('/')
    if (separator === -1) throw new Error('expected route mvu/status/<character>/<chatId>')
    const characterName = decodeURIComponent(rest.slice(0, separator))
    const chatId = decodeURIComponent(rest.slice(separator + 1))
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'character or chat not found' })
    const chat = snapshot.chat
    const variables = readChatVariables(chat)
    const receipts = readMvuReceipts(chat)
    const character = await db.getCharacter(characterName)
    const statusTemplate = character ? statusTemplateOf(character.card) : undefined
    let renderedHtml: string | undefined
    if (statusTemplate !== undefined) {
      const state = await db.getState()
      try {
        renderedHtml = await renderMvuStatusTemplate({
          db, state, characterName, character: character!, chat, chatId, template: statusTemplate,
        })
      } catch {
        // 渲染失败降级：不返回 renderedHtml，状态接口本身不失败
      }
    }
    return sendJson(res, 200, {
      ok: true,
      available: Object.keys(variables).length > 0,
      variables,
      receipts,
      ...(renderedHtml !== undefined ? { renderedHtml } : {}),
    })
  }

  // ---- 卡片工作台方案确认协议（提案 0013 P2）----
  // 方案 = card_plan_propose 落库的 pending 计划（<tavern>/card-workbench/plans/，
  // 见 card-workbench/plans.ts）。面板拉列表看 diff、给决定；approve=true 经
  // card-workbench/agent.ts 的执行核（executeCardPlan）按方案逐字段写入工作版
  // 并标记 applied（执行不在存储层），false 只改状态。错误码 TAVERN_WORKBENCH。
  if (method === 'GET' && route === 'card-workbench/plans') {
    const statusParam = url.searchParams.get('status') ?? 'pending'
    if (statusParam !== 'pending' && statusParam !== 'approved' && statusParam !== 'rejected' && statusParam !== 'applied' && statusParam !== 'all') {
      return sendJson(res, 400, { ok: false, message: `unknown status filter '${statusParam}'`, code: 'TAVERN_WORKBENCH' })
    }
    const character = url.searchParams.get('character') ?? undefined
    const plans = await listCardPlans(dshHomePath('tavern'), {
      ...(character !== undefined && character !== '' ? { character } : {}),
      status: statusParam,
    })
    return sendJson(res, 200, { ok: true, plans })
  }

  if (method === 'POST' && route.startsWith('card-workbench/plans/') && route.endsWith('/decision')) {
    const planId = decodeURIComponent(route.slice('card-workbench/plans/'.length, route.length - '/decision'.length))
    const body = await readJson(req)
    if (typeof body.approve !== 'boolean') {
      return sendJson(res, 400, { ok: false, message: 'expected { approve: boolean }', code: 'TAVERN_WORKBENCH' })
    }
    const plan = await getCardPlan(dshHomePath('tavern'), planId)
    if (plan === undefined) return sendJson(res, 404, { ok: false, message: `plan '${planId}' not found`, code: 'TAVERN_WORKBENCH' })
    try {
      if (body.approve) {
        // 执行核：过期检测 → 白名单写入工作版 → 标记 applied；失败不落 applied。
        const executed = await executeCardPlan(plan)
        return sendJson(res, 200, { ok: true, plan: executed.plan, applied: { character: executed.character, changes: executed.changes, fieldLengths: executed.fieldLengths } })
      }
      const decided = await decideCardPlan(dshHomePath('tavern'), planId, false)
      return sendJson(res, 200, { ok: true, plan: decided })
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error), code: 'TAVERN_WORKBENCH' })
    }
  }

  if (method === 'GET' && route.startsWith('world/')) {
    const name = decodeURIComponent(route.slice('world/'.length))
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    return sendJson(res, 200, { ok: true, book })
  }

  if (method === 'PUT' && route.startsWith('world/')) {
    const oldName = decodeURIComponent(route.slice('world/'.length))
    const body = await readJson(req, 10 * 1024 * 1024)
    if (typeof body.name !== 'string' || body.name.trim() === '' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      throw new Error('expected { name, data }')
    }
    const book = await db.importWorldFile(body.name, body.data)
    if (body.name !== oldName) {
      await db.deleteWorld(oldName)
      await db.updateState((current) => ({ activeWorlds: current.activeWorlds.map((name) => name === oldName ? body.name : name) }))
    }
    return sendJson(res, 200, { ok: true, name: book.name, book })
  }

  if (method === 'GET' && route.startsWith('export/world/')) {
    const name = decodeURIComponent(route.slice('export/world/'.length))
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    const bytes = await db.exportWorld(name)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(`${name}.json`)}"`)
    res.end(Buffer.from(bytes))
    return
  }

  if (method === 'DELETE' && route === 'world') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const book = await db.getWorld(name)
    if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
    await db.deleteWorld(name)
    const state = await db.updateState((current) => ({
      activeWorlds: current.activeWorlds.filter((world) => world !== name),
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'DELETE' && route === 'preset') {
    const name = url.searchParams.get('name')
    if (!name) throw new Error('name query is required')
    const preset = await db.getPreset(name)
    if (!preset) return sendJson(res, 404, { ok: false, message: 'preset not found' })
    await db.deletePreset(name)
    const state = await db.updateState((current) => ({
      activePreset: current.activePreset === name ? undefined : current.activePreset,
    }))
    return sendJson(res, 200, { ok: true, state })
  }

  if (method === 'GET' && route.startsWith('export/preset/')) {
    const name = decodeURIComponent(route.slice('export/preset/'.length))
    const preset = await db.getPreset(name)
    if (!preset) return sendJson(res, 404, { ok: false, message: 'preset not found' })
    const bytes = await db.exportPreset(name)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(`${name}.json`)}"`)
    res.end(Buffer.from(bytes))
    return
  }

  if (method === 'GET' && route === 'variables') {
    const state = await db.getState()
    return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
  }

  if (method === 'PUT' && route === 'variables') {
    const body = await readJson(req)
    if (body.globals === null || typeof body.globals !== 'object' || Array.isArray(body.globals)) {
      throw new Error('expected { globals }')
    }
    const globals: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(body.globals)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`global '${key}' must be a string, number or boolean`)
      }
      globals[key] = value
    }
    const state = await db.updateState(() => ({ scriptGlobals: globals }))
    return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
  }

  if (method === 'GET' && route === 'regex') {
    const state = await db.getState()
    return sendJson(res, 200, { ok: true, scripts: state.regexScripts })
  }

  if (method === 'PUT' && route === 'regex') {
    const body = await readJson(req)
    const scripts = Array.isArray(body.scripts) ? parseRegexScripts(body.scripts) : undefined
    if (scripts === undefined) throw new Error('expected { scripts }')
    const state = await db.patchState({ regexScripts: scripts })
    return sendJson(res, 200, { ok: true, scripts: state.regexScripts })
  }

  if (method === 'POST' && route === 'import/regex') {
    const body = await readJson(req)
    if (!Array.isArray(body.data) && typeof body.data !== 'object') throw new Error('expected { data }')
    const imported = await db.importRegexScripts(body.data)
    const state = await db.getState()
    return sendJson(res, 200, { ok: true, imported, scripts: state.regexScripts })
  }

  if (route.startsWith('chat/')) {
    const chatId = decodeURIComponent(route.slice('chat/'.length))
    const state = await db.getState()
    const character = url.searchParams.get('character') || state.activeCharacter
    if (!character) throw new Error('no active character')
    if (method === 'GET') {
      const snapshot = await db.getChatSnapshot(character, chatId)
      return snapshot
        ? sendJson(res, 200, { ok: true, chat: snapshot.chat, revision: snapshot.revision, displays: await displayTexts(db, state, character, snapshot.chat) })
        : sendJson(res, 404, { ok: false, message: 'chat not found' })
    }
    if (method === 'PUT') {
      const body = await readJson(req)
      if (!body.chat || !Array.isArray(body.chat.messages) || typeof body.revision !== 'string') {
        throw new Error('expected { chat, revision }')
      }
      const revision = await db.saveChat(character, chatId, body.chat, body.revision)
      return sendJson(res, 200, { ok: true, chat: body.chat, revision })
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (typeof body.name !== 'string' || typeof body.revision !== 'string') {
        throw new Error('expected { name, revision }')
      }
      const nextChatId = normalizeChatId(body.name)
      await db.renameChat(character, chatId, nextChatId, body.revision)
      const state = await db.updateState((current) => ({
        sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings).map(([sessionId, binding]) => [
          sessionId,
          binding.character === character && binding.chatId === chatId
            ? { character, chatId: nextChatId, ...(binding.group ? { group: true } : {}) }
            : binding,
        ])),
      }))
      const snapshot = await db.getChatSnapshot(character, nextChatId)
      return sendJson(res, 200, {
        ok: true,
        id: nextChatId,
        chat: snapshot?.chat,
        revision: snapshot?.revision,
        state,
      })
    }
    if (method === 'DELETE') {
      const body = await readJson(req)
      if (typeof body.revision !== 'string') throw new Error('expected { revision }')
      const deleted = await db.deleteChat(character, chatId, body.revision)
      if (deleted) {
        await db.updateState((current) => ({
          sessionBindings: Object.fromEntries(
            Object.entries(current.sessionBindings)
              .filter(([, binding]) => binding.character !== character || binding.chatId !== chatId),
          ),
        }))
      }
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { ok: false, message: 'chat not found' })
    }
  }

  if (method === 'POST' && route === 'generate') {
    return generate(ctx, req, res, db)
  }

  if (method === 'POST' && route === 'script') {
    return runTavernScript(ctx, req, res, db)
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

/* --------------------------- AgentNovel HTTP API --------------------------- */

/**
 * Literal subpath markers of the novels route tree. They double as the
 * server-contract gate markers: parameterized routes are prefix-matched, so
 * these constants are the only stable place the subpath literals appear in
 * the bundle (see packages/plugin/scripts/gates/run.mjs).
 */
const NOVEL_SUBPATHS = ['novels/outline', 'novels/body', 'novels/export', 'novels/pause', 'novels/resume', 'novels/stop', 'novels/update-outline', 'novels/approve-outline'] as const
type NovelSubpath = (typeof NOVEL_SUBPATHS)[number]

interface NovelApiRequest {
  method?: string
  url?: string
  on?: (event: string, listener: (chunk?: unknown) => void) => unknown
  destroy?: () => void
}

interface NovelApiResponse {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: (chunk?: string | Uint8Array) => void
}

interface NovelHttpFailure {
  status: number
  code: string
  /** §13/§15: corruption and ownership detail stays in the server log only. */
  sanitized: boolean
  extra?: Record<string, unknown>
}

/** Maps novel domain errors onto structured HTTP failures (proposal 0005 §13). */
function novelHttpFailure(error: unknown): NovelHttpFailure | undefined {
  if (error instanceof NovelRevisionConflictError) {
    return { status: 409, code: error.code, sanitized: false, extra: { actualRevision: error.actualRevision } }
  }
  if (error instanceof NovelDuplicateCommitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelStaleUnitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelRequirementConflictError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelLengthLimitError) return { status: 409, code: error.code, sanitized: false }
  if (error instanceof NovelPreconditionError) {
    return {
      status: 409,
      code: error.code,
      sanitized: false,
      extra: { rule: error.rule, ...(error.violations.length > 0 ? { violations: [...error.violations] } : {}) },
    }
  }
  if (error instanceof NovelNotFoundError) return { status: 404, code: error.code, sanitized: false }
  if (error instanceof NovelConfigError) {
    return {
      status: 400,
      code: error.code,
      sanitized: false,
      ...(error.errors.length > 0 ? { extra: { violations: error.errors.map((item) => ({ field: item.field, message: item.message })) } } : {}),
    }
  }
  if (error instanceof NovelCapabilityError) return { status: 503, code: error.code, sanitized: false }
  if (error instanceof NovelStorageCorruptionError) return { status: 500, code: error.code, sanitized: true }
  if (error instanceof NovelOwnershipError) return { status: 500, code: error.code, sanitized: true }
  return undefined
}

/** Splits 'novels/<id>[/<subpath>]' against the known marker table. */
function parseNovelRoute(route: string): { novelId: string; subpath: NovelSubpath | null } | null {
  if (!route.startsWith('novels/')) return null
  const [idSegment, ...rest] = route.slice('novels/'.length).split('/')
  if (idSegment === undefined) return null
  const tail = rest.join('/')
  return {
    novelId: decodeURIComponent(idSegment),
    subpath: tail === '' ? null : NOVEL_SUBPATHS.find((marker) => marker === `novels/${tail}`) ?? null,
  }
}

async function requireNovel(db: NovelStore, novelId: string): Promise<NovelSnapshot> {
  if (!isValidNovelId(novelId)) throw new NovelNotFoundError({ novelId })
  const snapshot = await db.getNovel(novelId)
  if (snapshot === undefined) throw new NovelNotFoundError({ novelId })
  return snapshot
}

/** Detail projection for GET novels/:id (client contract, proposal 0005 §14.3). */
function novelDetail(snapshot: NovelSnapshot) {
  const summary = summarizeNovel(snapshot)
  const outline = snapshot.outline
  const completed = new Set(snapshot.completedChapters.map((entry) => entry.chapterId))
  const chapters = [...(outline?.chapters ?? [])]
    .sort((left, right) => left.order - right.order)
    .map((chapter) => {
      const chapterCommits = snapshot.commits.filter((commit) => commit.chapterId === chapter.chapterId)
      return {
        chapterId: chapter.chapterId,
        order: chapter.order,
        title: chapter.title,
        state: completed.has(chapter.chapterId)
          ? 'completed' as const
          : chapterCommits.length > 0 ? 'writing' as const : 'planned' as const,
        committedCharacters: totalEffectiveCharacters(chapterCommits),
      }
    })
  const budget = snapshot.config.lengthBudget
  return {
    novelId: summary.novelId,
    title: summary.title,
    status: summary.status,
    phase: summary.phase,
    pauseReason: summary.pauseReason,
    chaptersCompleted: summary.chaptersCompleted,
    chaptersTotal: summary.chaptersTotal,
    effectiveCharacters: summary.effectiveCharacters,
    targetCharacters: summary.targetCharacters,
    updatedAt: summary.updatedAt,
    lastError: summary.lastError,
    revision: snapshot.revision,
    config: snapshot.config,
    pauseDetail: snapshot.run.pauseDetail,
    resumeHint: snapshot.run.resumeHint,
    requirements: snapshot.requirements.map((record) => ({
      requirementId: record.requirementId,
      sequence: record.sequence,
      text: record.text,
      status: record.status,
      effectiveLocation: record.effectiveLocation,
      blockedReason: record.blockedReason,
    })),
    chapters,
    outlineSummary: outline === null ? null : {
      outlineRevision: outline.outlineRevision,
      story: { premise: outline.story.premise, theme: outline.story.theme, endingDirection: outline.story.endingDirection },
      chapterTitles: outline.chapters.map((chapter) => ({ chapterId: chapter.chapterId, title: chapter.title })),
      foreshadowing: outline.foreshadowing.map((item) => ({ id: item.id, description: item.description, status: item.status, required: item.required })),
    },
    budget: {
      turnsRun: snapshot.run.turnsRun,
      maxTurns: snapshot.config.budgets.maxTurns,
      deduceRuns: snapshot.run.deduceRuns,
      maxDeduceRuns: snapshot.config.budgets.maxDeduceRuns,
      // 0007 §7: writerRuns rides the deduceRuns convention (uncapped counter
      // beside the budget edges); usageSamples is the W0 audit ring. Both
      // coalesce so legacy snapshots lacking the fields still project a
      // constant shape — the store applies the same amnesty on write.
      writerRuns: snapshot.run.writerRuns ?? 0,
      usageSamples: snapshot.run.usageSamples ?? [],
      remainingCharacters: budget.kind === 'target'
        ? Math.max(0, unitTargetRange(snapshot.config, summary.effectiveCharacters).max)
        : null,
    },
  }
}

/**
 * Best-effort discovery of a subagent runtime for the writer probes (0007 §9).
 * Preferred channel: a live agent bound to an agent-novel session — the exact
 * channel novel_writer_delegate itself uses at runtime (exec.agent →
 * subagentRuntimeOf), so a pass proves the path W2 actually runs on. Fallback:
 * the plugin context's own service lookup. Both degrade silently to undefined
 * (gated services throw or return nothing); callers treat a missing runtime as
 * a failed probe, never as an implicit inline downgrade.
 */
async function discoverWriterProbeRuntime(ctx: unknown): Promise<{ runtime: SubagentRuntimeLike; parent: unknown; channel: 'bound-agent' | 'plugin-context' } | undefined> {
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    for (const [sessionId, binding] of Object.entries(state.sessionBindings)) {
      if (binding.architecture !== 'agent-novel') continue
      let agent: unknown
      try {
        agent = (ctx as { agents?: { get?: (id: string) => unknown } }).agents?.get?.(sessionId)
      } catch {
        continue // gated service access on an inactive fiber
      }
      const runtime = subagentRuntimeOf(agent as DeductionExecAgent | undefined)
      if (runtime !== undefined) return { runtime, parent: agent, channel: 'bound-agent' }
    }
  } catch {
    // A failed state read falls through to the context channel below.
  }
  const runtime = subagentRuntimeOf({ ctx } as DeductionExecAgent)
  return runtime === undefined ? undefined : { runtime, parent: ctx, channel: 'plugin-context' }
}

async function handleNovelsApi(
  ctx: { agents?: unknown; agentPresets?: unknown; systemPrompt?: unknown; tools?: unknown; on?: unknown },
  req: NovelApiRequest,
  res: NovelApiResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  const novels = await novelStore()

  if (method === 'GET' && route === 'novels') {
    return sendJson(res, 200, { ok: true, novels: await novels.listNovels() })
  }

  if (method === 'POST' && route === 'novels') {
    const body = await readJson(req) as Record<string, unknown>
    // §16 fail-closed: capability reasons outrank config validation, so a
    // degraded host reports why instead of a stream of field errors.
    const capabilities = inspectAgentNovelCapabilities(ctx)
    if (!capabilities.available) {
      return sendJson(res, 503, {
        ok: false,
        message: `AgentNovel is unavailable on this host: ${capabilities.reasons.join(' ')}`,
        code: 'NOVEL_CAPABILITY',
        reasons: [...capabilities.reasons],
      })
    }
    const config = body as unknown as NovelCreateConfig
    const violations = validateCreateConfig(config)
    if (violations.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        message: 'invalid novel config',
        code: 'NOVEL_CONFIG',
        violations: violations.map((item) => ({ field: item.field, message: item.message })),
      })
    }
    // 0007 §8/§9 fail-closed creation gate: writerMode=subagent (W2) requires
    // the P1 host contract probe to pass; a failed probe (or an unresolvable
    // subagent runtime) blocks the creation with the evidence instead of
    // silently degrading to inline. The probe spawns two one-shot subagents —
    // only reachable from this explicit request surface, never at startup.
    if (config.writerMode === 'subagent') {
      const channel = await discoverWriterProbeRuntime(ctx)
      const probe = await inspectWriterSubagentCapabilities(channel)
      if (!probe.spawnOk || probe.p1.status === 'fail') {
        return sendJson(res, 400, {
          ok: false,
          message: `writer subagent mode is unavailable on this host (${probe.p1.detail}); create the novel with writerMode 'inline' instead (0007 §9)`,
          code: 'NOVEL_WRITER_PROBE',
          probe,
        })
      }
    }
    const created = await novels.createNovel(await store(), config)
    const snapshot = await novels.getNovel(created.novelId)
    const summary = snapshot === undefined ? undefined : summarizeNovel(snapshot)
    return sendJson(res, 200, {
      ok: true,
      novel: {
        novelId: created.novelId,
        title: config.title,
        status: summary?.status ?? (config.approvalMode === 'manual' ? 'paused' : 'active'),
        phase: summary?.phase ?? 'outlining',
        revision: created.revision,
      },
    })
  }

  if (method === 'GET' && route === 'novels/writer-probe') {
    // Debug surface for the writer-subagent probes (0007 §9): panels and CLI
    // can trigger the report without attempting a subagent-mode creation. The
    // literal must be matched before parseNovelRoute, which would otherwise
    // read 'writer-probe' as a novel id.
    const channel = await discoverWriterProbeRuntime(ctx)
    const probe = await inspectWriterSubagentCapabilities(channel)
    return sendJson(res, 200, { ok: true, probe, channel: channel?.channel ?? 'none' })
  }

  const parts = parseNovelRoute(route)
  if (parts === null) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
  const { novelId, subpath } = parts

  if (method === 'GET' && subpath === null) {
    const snapshot = await requireNovel(novels, novelId)
    return sendJson(res, 200, { ok: true, novel: novelDetail(snapshot) })
  }

  if (method === 'PATCH' && subpath === null) {
    const body = await readJson(req) as Record<string, unknown>
    if (typeof body.expectedRevision !== 'string' || typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
      throw new Error('expected { expectedRevision, patch }')
    }
    // patchNovelMeta validates the writerMode enum (0007 §8 Task A); the mode
    // switch only affects the next scheduled unit.
    const result = await novels.patchNovelMeta(novelId, {
      expectedRevision: body.expectedRevision,
      patch: body.patch as { title?: string; genre?: string; budgets?: NovelRunBudgets; writerMode?: WriterMode },
      cause: typeof body.cause === 'string' && body.cause.trim() !== '' ? body.cause : 'panel-edit',
    })
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }

  if (method === 'DELETE' && subpath === null) {
    // Deletion discipline (proposal 0005 §13/§4.2): revoke scheduling first
    // (tolerated on completed/missing novels), drop every session binding
    // that points at the project, then remove the project itself. Missing
    // novels stay a success so client retries are idempotent.
    await novels.pause(novelId, { reason: 'user-request', detail: 'deletion requested from the novels panel' }).catch(() => {})
    const db: TavernStore = await store()
    await db.updateState((current) => ({
      sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings)
        .filter(([, binding]) => !(binding.architecture === 'agent-novel' && binding.novelId === novelId))),
    }))
    await novels.deleteNovel(novelId)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && subpath === 'novels/pause') {
    const result = await novels.pause(novelId, {
      reason: 'user-request',
      detail: 'paused from the novels panel',
      resumeHint: 'resume explicitly to authorize further work (proposal 0005 §13)',
    })
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/resume') {
    const result = await novels.resume(novelId)
    // Resuming flips the run active with no session event in flight; the
    // driver must be poked or an idle bound agent never gets scheduled (§12.1).
    ;(await novelDriverPromise)?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/stop') {
    const result = await novels.stop(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/update-outline') {
    const result = await novels.requestRevision(novelId)
    // The authorized planning pass needs the driver poked like resume: no
    // session edge fires while the bound agent sits idle (§4.3/§12.1).
    ;(await novelDriverPromise)?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }
  if (method === 'POST' && subpath === 'novels/approve-outline') {
    const body = await readJson(req).catch(() => undefined) as Record<string, unknown> | undefined
    const fromQuery = url.searchParams.get('expectedOutlineRevision')
    const expected = typeof body?.expectedOutlineRevision === 'string' && body.expectedOutlineRevision.trim() !== ''
      ? body.expectedOutlineRevision
      : fromQuery
    if (expected === null || expected === undefined || expected.trim() === '') throw new Error('expected { expectedOutlineRevision }')
    const result = await novels.approveOutline(novelId, { expectedOutlineRevision: expected })
    // Post-approval continuation previously claimed to ride "the driver's
    // existing edges" — but an idle agent emits none, so the driver is poked
    // here explicitly (proposal 0005 §4.3/§12.1).
    ;(await novelDriverPromise)?.kick(novelId)
    return sendJson(res, 200, { ok: true, revision: result.revision })
  }

  if (method === 'GET' && subpath === 'novels/outline') {
    const snapshot = await requireNovel(novels, novelId)
    return sendJson(res, 200, { ok: true, outline: snapshot.outline })
  }

  if (method === 'GET' && subpath === 'novels/body') {
    const chapterId = url.searchParams.get('chapterId')
    const cursor = url.searchParams.get('cursor')
    const limitRaw = url.searchParams.get('limit')
    const page = await novels.readBody(novelId, {
      ...(chapterId !== null && chapterId !== '' ? { chapterId } : {}),
      ...(cursor !== null && cursor !== '' ? { cursor } : {}),
      ...(limitRaw !== null && limitRaw !== '' ? { limit: Number(limitRaw) } : {}),
    })
    // nextCursor is null when the page is exhausted; the client treats both
    // states, null is the chosen representation.
    return sendJson(res, 200, { ok: true, paragraphs: [...page.paragraphs], nextCursor: page.nextCursor })
  }

  if (method === 'GET' && subpath === 'novels/export') {
    const projector = await novelProjectorPromise
    if (projector === undefined) throw new Error('AgentNovel projector is unavailable')
    const format = url.searchParams.get('format') === 'zip' ? 'zip' as const : 'md' as const
    const exported = await projector.exportNovel(novelId, format)
    res.statusCode = 200
    res.setHeader('content-type', exported.contentType)
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(exported.filename)}"`)
    res.end(Buffer.from(exported.bytes))
    return
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

/* ------------------------- AgentNovel lifecycle ------------------------- */

interface NovelPluginContext {
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void }
}

function errorCodeText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.name : String(error)
}

/**
 * §12.3 restart recovery: re-arm active novels and catch the memory index up
 * for every bound project. Runs once per apply, never blocks mounting.
 */
async function recoverMountedNovels(ctx: NovelPluginContext): Promise<void> {
  const driver = await novelDriverPromise
  if (driver === undefined) return
  await recoverNovels(driver)
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    for (const binding of Object.values(state.sessionBindings)) {
      if (binding.architecture !== 'agent-novel') continue
      await indexPendingCommits(ctx, binding.novelId)
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-tavern: AgentNovel recovery indexing failed', { operation: 'recover', errorCode: errorCodeText(error) })
  }
}

/**
 * Session/event entry for bound novel sessions (proposal 0005 §9.1/§12.1):
 * real user messages persist through the receive barrier BEFORE they can
 * unblock the next unit claim, and turn/end edges feed driver accounting.
 * Failures are logged with structured fields and never break the event stream.
 */
async function handleNovelSessionEvent(ctx: NovelPluginContext, session: unknown, event: unknown): Promise<void> {
  const sessionId = (session as { id?: unknown } | null | undefined)?.id
  if (typeof sessionId !== 'string') return
  let novelId: string
  try {
    const db: TavernStore = await store()
    const state = await db.getState()
    const binding = state.sessionBindings[sessionId]
    if (binding === undefined || binding.architecture !== 'agent-novel') return
    novelId = binding.novelId
  } catch (error) {
    ctx.logger?.warn?.('dsh-tavern: AgentNovel binding read failed', { sessionId, operation: 'novel-event', errorCode: errorCodeText(error) })
    return
  }
  const record = event as { type?: unknown } | null | undefined
  try {
    if (record?.type === 'turn/end') {
      const driver = await novelDriverPromise
      if (driver !== undefined) await driver.handleSessionEvent({ id: sessionId }, event as { type?: string; data?: unknown })
      await indexPendingCommits(ctx, novelId)
      return
    }
    if (isNovelAuthorMessage(event as { type?: string; data?: unknown })) {
      const outcome = await receiveAuthorMessage(await novelStore(), novelId, sessionId, event)
      if (!outcome.accepted && !outcome.duplicate) {
        ctx.logger?.warn?.('dsh-tavern: AgentNovel receive barrier rejected a message', {
          novelId,
          sessionId,
          operation: 'receive-requirement',
          reason: outcome.reason ?? 'unknown',
        })
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-tavern: AgentNovel session event handling failed', { novelId, sessionId, operation: 'novel-event', errorCode: errorCodeText(error) })
  }
}

/**
 * Commit-driven memory index catch-up (proposal 0005 §8.2): the projector
 * writes a commit's scene summary record LAST, so the absence of that stable
 * id marks the commit as unindexed. Idempotent; called from turn/end edges
 * and restart recovery without touching the store commit path.
 */
async function indexPendingCommits(ctx: NovelPluginContext, novelId: string): Promise<void> {
  const [novels, memory, projector] = await Promise.all([novelStore(), memories(), novelProjectorPromise])
  if (projector === undefined) return
  const snapshot = await novels.getNovel(novelId)
  if (snapshot === undefined) return
  const scopeId = `novel:${novelId}`
  for (const commit of snapshot.commits) {
    const summaryId = `novel-${novelId}-${commit.commitId}-${commit.canonChanges.length}`
    const indexed = await memory.read(summaryId, 'chat', scopeId, true).catch(() => undefined)
    if (indexed !== undefined) continue
    try {
      await projector.indexCommit(novelId, commit.commitId)
    } catch (error) {
      ctx.logger?.warn?.('dsh-tavern: AgentNovel memory index write failed', { novelId, commitId: commit.commitId, operation: 'index-commit', errorCode: errorCodeText(error) })
    }
  }
}

interface NovelCommandAgent {
  id: string
  ctx: unknown
  session: HostSessionLog & { append: (type: string, data: unknown, opts?: unknown) => void }
}

/** Structural check against DriverAgentLike; degrades silently otherwise. */
function driverCompatibleAgent(agent: unknown): agent is DriverAgentLike {
  if (typeof agent !== 'object' || agent === null) return false
  const candidate = agent as { id?: unknown; session?: unknown; status?: unknown; followup?: unknown; whenIdle?: unknown }
  return typeof candidate.id === 'string'
    && typeof candidate.session === 'object' && candidate.session !== null && typeof (candidate.session as { id?: unknown }).id === 'string'
    && (candidate.status === 'idle' || candidate.status === 'running')
    && typeof candidate.followup === 'function'
    && typeof candidate.whenIdle === 'function'
}

/**
 * Internal novel-open command handler (proposal 0005 §4.2): existence gate,
 * fail-closed capability gate (§16), architecture conflict guard, serialized
 * binding write, idempotent preset marker + recompose, then the driver kick.
 * No placeholder turn events are ever appended: the kickoff guarantee is the
 * agent liveness carried by handleNovelOpen (§12.1), which keeps real turn
 * numbering intact for client replay.
 */
async function handleNovelOpenCommand(
  ctx: NovelPluginContext & { agentPresets?: { recompose?: (agentCtx: unknown, presetId: string) => Promise<{ id: string }> } },
  agent: NovelCommandAgent,
  novelId: string,
): Promise<{ kind: string; text: string }> {
  const db: TavernStore = await store()
  const novels = await novelStore()
  if ((await novels.getNovel(novelId)) === undefined) {
    return { kind: 'error', text: `Novel '${novelId}' not found.` }
  }
  // §16 fail-closed: refuse with the concrete reasons, never degrade to chat.
  if (!agentNovelCapabilities.available) {
    return { kind: 'error', text: `AgentNovel is unavailable on this host: ${agentNovelCapabilities.reasons.join(' ')}` }
  }
  await ensureAgentPresetDeclared(ctx, AGENT_NOVEL_PRESET_ID)
  const currentState = await db.getState()
  const previous = currentState.sessionBindings[agent.id]
  const activationEvents = sessionEvents(agent.session)
  // Same guard family as the AgentTavern lock: a session that already began
  // real turns (or imported history) cannot be re-bound in place (§4.2).
  const sessionStarted = activationEvents.some((event) => event.type === 'turn/start')
    || activationEvents.some((event) => {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
      const source = event.type === 'user/message' ? event.data?.source : event.data?.message?.source
      return isTavernSessionMarker(source)
    })
  const sameNovelBinding = previous?.architecture === 'agent-novel' && previous.novelId === novelId
  if (!sameNovelBinding && sessionStarted) {
    throw new TavernArchitectureConflictError('This host session already started; rebinding it to an AgentNovel project is locked (proposal 0005 §4.2).')
  }
  if (typeof ctx.agentPresets?.recompose !== 'function') {
    throw new TavernArchitectureConflictError('The host cannot recompose a blank session with the AgentNovel preset.')
  }
  await bindNovelSession(db, agent.id, novelId)
  // Idempotent marker: a repeated novel-open on the same binding neither
  // stacks markers nor recomposes twice.
  if (!activationEvents.some((event) => event.type === 'agent-preset/selected' && event.data?.agentPreset === AGENT_NOVEL_PRESET_ID)) {
    const preset = await ctx.agentPresets.recompose(agent.ctx, AGENT_NOVEL_PRESET_ID)
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  }
  const driver = await novelDriverPromise
  if (driver !== undefined && driverCompatibleAgent(agent)) {
    // driverCompatibleAgent validated the driver surface at runtime; the cast
    // only satisfies the structural gap between the two local host shapes.
    await driver.handleNovelOpen(agent as unknown as DriverAgentLike, novelId)
  }
  return { kind: 'success', text: `Novel: ${novelId}` }
}

/** AgentNovel session binding write (proposal 0005 §4.2). */
async function bindNovelSession(db: TavernStore, sessionId: string, novelId: string) {
  return db.updateState((state) => ({
    sessionBindings: {
      ...state.sessionBindings,
      [sessionId]: { architecture: 'agent-novel', novelId, character: '', chatId: '' },
    },
  }))
}

/**
 * 断言本 bundle 声明的 preset 已在宿主 preset registry 注册。DSH 0.2.0-rc.2
 * 起 preset 不再通过 ~/.dsh/.agent-presets 目录扫描投递（registry "neither
 * scans directories nor accepts preset paths"），而是 profile 里的
 * @deepseek-ai/dsh-agent-preset 声明行——本包 cordis.patch.yml 的
 * preset-agent-tavern / preset-agent-novel insert。失败即能力闸门关闭并给出
 * 重装指引，而不是静默落到无 preset 扫描的空集。
 */
async function ensureAgentPresetDeclared(
  ctx: { agentPresets?: { compositionInventory?: () => Promise<Array<{ id?: unknown }>> } },
  presetId: string,
): Promise<void> {
  const inventory = typeof ctx.agentPresets?.compositionInventory === 'function'
    ? await ctx.agentPresets.compositionInventory()
    : undefined
  if (!Array.isArray(inventory) || !inventory.some((entry) => entry?.id === presetId)) {
    throw new Error(
      `preset '${presetId}' is not declared on this host; reinstall the dsh-tavern bundle so its cordis.patch.yml preset rows mount (DSH 0.2.0-rc.2+ preset delivery)`,
    )
  }
}

/* --------------------------- 生成内核（共享） --------------------------- */

async function generate(ctx, req, res, db) {
  const body = await readJson(req)
  const state = await db.getState()
  assertStGenerationBinding(state, body.sessionId)
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  const userText = typeof body.message === 'string' ? body.message.trim() : ''
  const mode = body.mode === 'regenerate' ? 'regenerate' : 'send'
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
  const write = (event) => res.write(JSON.stringify(event) + '\n')

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
      hostAgent: typeof body.sessionId === 'string' ? ctx.agents?.get?.(body.sessionId) : undefined,
    })
    write({ type: 'saved', chat: result.chat, revision: result.revision })
    res.end()
  } catch (error) {
    if (!res.writableEnded) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ChatRevisionConflictError ? error.code : undefined
      write({ type: 'error', message, code })
      res.end()
    }
  }
}

interface GenerationOptions {
  state
  characterName: string
  chatId: string
  snapshot
  /** send=追加用户消息；regenerate=弹出旧回复重掷；trigger=按现状生成（STscript /trigger） */
  mode: 'send' | 'regenerate' | 'trigger'
  userText: string
  /** regenerate 专用：带意见重写（提案 0011）；非 regenerate 不允许携带。 */
  feedback?: string
  group: boolean
  triggerMember?: string
  sessionId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  write: (event: unknown) => void
  signal: AbortSignal
  hostAgent?: unknown
}

/**
 * 生成内核：send/regenerate 共用；群聊与文本补全在此分叉。
 * 结构：CAS 校验已在调用方完成（snapshot 即当前 revision）。
 */
async function runGeneration(ctx, db, options: GenerationOptions) {
  const { state, characterName, chatId, snapshot, mode, group, write, signal } = options
  const chat = snapshot.chat
  // MVU 回执（提案 0012 P1）：深拷贝本轮结算前的变量基线，保存前 diff 出变更集落回执
  const mvuVariablesBefore = snapshotChatVariables(chat)
  let revision = snapshot.revision
  let hostTrace
  // {{user}} / 消息落库名：激活 persona 名称（ST name1 语义），未配置时回退默认
  const userName = state.activePersona ?? DEFAULT_USER

  try {

  // ---- 发言者与成员解析 ----
  let speakerName = characterName
  let groupDef = undefined
  let turnMessages = chat.messages
  let nudge = undefined
  if (group) {
    groupDef = await db.getGroup(characterName)
    if (!groupDef) throw new Error(`group '${characterName}' not found`)
    const chatGroupMeta = chat.header.chat_metadata?.group
    const members = Array.isArray(chatGroupMeta?.members) && chatGroupMeta.members.length > 0
      ? chatGroupMeta.members.filter((x) => typeof x === 'string')
      : groupDef.members
    const disabled = Array.isArray(chatGroupMeta?.disabledMembers)
      ? chatGroupMeta.disabledMembers.filter((x) => typeof x === 'string')
      : groupDef.disabledMembers
    const lastSpeaker = [...chat.messages].reverse().find((m) => !m.is_user && !m.is_system)?.name
    const talkativeness = new Map()
    for (const member of members) {
      const file = await db.getCharacter(member)
      const raw = file?.card?.data?.extensions?.talkativeness
      talkativeness.set(member, typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0.5)
    }
    speakerName = options.triggerMember
      ?? (mode === 'regenerate'
        ? (members.includes(lastSpeaker) ? lastSpeaker : undefined)
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
      userName,
      messages: chat.messages,
      ...(typeof rawNudge === 'string' && rawNudge.trim() !== '' ? { groupNudgePrompt: rawNudge } : {}),
    })
    turnMessages = turn.messages
    nudge = turn.nudge
  }
  const character = await db.getCharacter(speakerName)
  if (!character) throw new Error(`character '${speakerName}' not found`)

  // ---- 发送模式：先落用户消息（regex USER_INPUT），regenerate 弹出旧回复 ----
  let regenerated
  let hostUserText = ''
  const scripts = collectRegexScripts(state, character)
  if (mode === 'send') {
    const transformed = applyRegexScripts(options.userText, scripts, RegexPlacement.USER_INPUT, { expand: (t) => t })
    hostUserText = transformed
    chat.messages.push({ name: userName, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: transformed })
    if (group) {
      const turn = buildGroupTurn({
        speaker: speakerName,
        members: groupDef?.members ?? [speakerName],
        userName,
        messages: chat.messages,
      })
      turnMessages = turn.messages
    }
    revision = await db.saveChat(characterName, chatId, chat, revision)
  } else {
    const last = chat.messages[chat.messages.length - 1]
    if (last?.is_user === false && !last.is_system) {
      regenerated = chat.messages.pop()
      if (group) {
        const turn = buildGroupTurn({
          speaker: speakerName,
          members: groupDef?.members ?? [speakerName],
          userName,
          messages: chat.messages,
        })
        turnMessages = turn.messages
      }
    }
  }

  hostTrace = beginTavernSessionTurn(options.hostAgent, hostUserText)

  // ---- 预设 / persona / 世界书 ----
  const presetName = state.activePreset
  let presetObject = presetName ? await db.getPreset(presetName) : undefined
  if (!presetObject) presetObject = defaultPreset()
  const preset = parsePreset(presetObject)
  const persona = state.activePersona ? await db.getPersona(state.activePersona) : undefined

  const books = await collectWorldInfoBooks(db, state, speakerName, character)

  const lore = activateWorldInfo({
    books,
    chat: turnMessages.map((m) => ({ name: m.name, content: m.mes, isUser: m.is_user })),
    contextSize: Number(preset.sampler.openai_max_context ?? 4096),
    trigger: mode === 'regenerate' ? 'regenerate' : mode === 'trigger' ? 'quiet' : 'normal',
    scanSources: {
      personaDescription: persona?.description,
      characterDescription: character.card.data.description,
      characterPersonality: character.card.data.personality,
      scenario: character.card.data.scenario,
      creatorNotes: character.card.data.creatorNotes,
    },
    settings: { recursive: true, scanDepth: 2, budgetPercent: 25 },
    timedState: typeof chat.header.chat_metadata?.timedWorldInfo === 'object' && chat.header.chat_metadata.timedWorldInfo
      ? chat.header.chat_metadata.timedWorldInfo
      : undefined,
    messageCount: turnMessages.length,
  })
  chat.header.chat_metadata.timedWorldInfo = lore.timedState

  // ---- Prompt Template 预备（提案 0008）：激活分区 + InitialVariables + 运行时 ----
  // templatesEnabledFlag 承载 profile 配置决策；templatesEnabled() 实时读 env 覆盖
  const templatesActive = templatesEnabledFlag && templatesEnabled()
  const templateGlobalsBefore = templatesActive ? JSON.stringify(state.scriptGlobals) : undefined
  const tpl: GenerationTemplates | null = templatesActive
    ? await createGenerationTemplates({
        chat, state, books, lore,
        card: character.card, preset,
        turnMessages,
        userName, characterName: speakerName, chatId,
      })
    : null

  // WI 内容进 prompt 前过 WORLD_INFO regex；模板开启时特殊条目已剔除、再过 EJS 渲染
  const wiDeps = { expand: (text) => text }
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
    lastMessage: turnMessages[turnMessages.length - 1]?.mes,
    lastUserMessage: lastUser?.mes,
    lastCharMessage: lastChar?.mes,
    lastMessageId: turnMessages.length - 1,
    chatId,
    local: chatVariables(chat),
    global: state.scriptGlobals,
  })
  const expand = (text) => macros.expand(text)
  const countTokens = (text) => Math.ceil(text.length / 3.5)

  // persona 位置：IN_PROMPT（默认）/AT_DEPTH/顶部AN/底部AN
  const personaInjections = []
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

  // ---- promptOnly AI_OUTPUT：历史消息只影响 prompt 的变换 ----
  const promptOnlyScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const historyRegexed = promptOnlyScripts.length > 0
    ? turnMessages.map((m, index) => ({
        ...m,
        mes: applyRegexScripts(m.mes, promptOnlyScripts, RegexPlacement.AI_OUTPUT, {}, { depth: turnMessages.length - 1 - index }),
      }))
    : turnMessages
  // 模板开启时历史消息过 EJS（ST 默认语义：生成期处理消息中的 <% 块）
  const historyForPrompt = tpl
    ? await Promise.all(historyRegexed.map((m, index) =>
        tpl.renderText(m.mes, `history#${index}`).then((mes) => ({ ...m, mes }))))
    : historyRegexed

  const atDepthSource = tpl ? tpl.partition.normalAtDepth : lore.atDepth.map((g) => ({ depth: g.depth, role: g.role, text: g.text }))
  const anTopText = tpl && lore.topOfAuthorsNote.text ? await tpl.renderText(lore.topOfAuthorsNote.text, 'an-top') : lore.topOfAuthorsNote.text
  const anBottomText = tpl && lore.bottomOfAuthorsNote.text ? await tpl.renderText(lore.bottomOfAuthorsNote.text, 'an-bottom') : lore.bottomOfAuthorsNote.text
  const depthInjectionsRaw = [
    ...atDepthSource.map((g) => ({ depth: g.depth, role: roleName(g.role), text: g.text })),
    ...(anTopText ? [{ depth: 4, role: 'system', text: anTopText }] : []),
    ...(anBottomText ? [{ depth: 0, role: 'system', text: anBottomText }] : []),
    ...personaInjections,
  ]
  const depthInjections = tpl
    ? await Promise.all(depthInjectionsRaw.map(async (inj) => ({ ...inj, text: await tpl.renderText(inj.text, 'depth-injection') })))
    : depthInjectionsRaw

  const assembled = assemblePrompt({
    card: tpl ? await tpl.preRenderCard(character.card) : character.card,
    preset: tpl ? await tpl.preRenderPreset(preset) : preset,
    personaDescription,
    messages: historyForPrompt,
    worldInfoBefore: loreBefore,
    worldInfoAfter: loreAfter,
    beforeExamples: tpl
      ? await Promise.all(tpl.partition.normalBeforeExamples.map((e, i) => tpl.renderText(e.content, `wi-em-before#${i}`)))
      : lore.beforeExamples.entries.map((e) => e.content),
    afterExamples: tpl
      ? await Promise.all(tpl.partition.normalAfterExamples.map((e, i) => tpl.renderText(e.content, `wi-em-after#${i}`)))
      : lore.afterExamples.entries.map((e) => e.content),
    depthInjections,
  }, { expand, countTokens })
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
  write({ type: 'start', provider, model, speaker: speakerName, lore: lore.allActivated.map((e) => ({ uid: e.uid, book: e.book, comment: e.entry.comment })), stats: assembled.stats })

  // ---- 模板消息级注入（GENERATE → @INJECT，提案 0008）----
  // AFTER 条目位于 prompt 末尾：所有字段渲染完成后才预渲染（变量副作用次序）
  if (tpl) await tpl.prerenderGenerateAfter()

  // ---- 剧本游玩注入（提案 0014 P1）----
  // 卡绑定了剧本时：先做对齐推进判定——以「最近一条已定稿助手楼层」为准
  // （send 模式新用户消息已 push、regenerate 模式旧助手楼层已 pop，从
  // chat.messages 末尾向前找 is_user=false 且非 system 的楼层两者得到同一条），
  // 词法覆盖 ≥0.35 判定对齐 → chunkIndex+1（一次至多 +1，不跳块，末块不再
  // 推进）；进度惰性初始化 chunkIndex=0 后写回 chat_metadata.scriptProgress
  // （随本轮末尾的 saveChat 自然落盘）。然后把当前块 + 下一块预览作为世界书
  // 式 system 条目 unshift 到消息头部——剧本块是参考不是约束（可偏离）。
  const boundScriptId = boundScriptOf(character.card)
  if (boundScriptId !== undefined) {
    const scriptRecord = await getScript(dshHomePath('tavern'), boundScriptId)
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

  // ---- 流式生成 ----
  let text = ''
  let reasoning = ''
  let hostUsage
  hostTrace = startTavernSessionStep(hostTrace)
  const requestMessages = [...finalMessages]
  const systemParts = []
  while (requestMessages[0]?.role === 'system') systemParts.push(requestMessages.shift().content)
  // 持续指引（提案 0009）：会话级用户指令作为 system 段末尾块注入——位于所有
  // 已装配 system 块之后；不进楼层内容，导出纯对话不携带。块自带 user
  // directives 标注，不伪装世界书或角色设定。
  const guidesBlock = formatGuidesBlock(chat.header.chat_metadata?.guides)
  if (guidesBlock !== undefined) systemParts.push(guidesBlock)
  const llmMessages = requestMessages.map((m) => createMessage({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    // 仅进 ctx.llm.stream 的请求消息，不落会话日志（该调用不带 sessionId），
    // dsh-llm 对 source 不校验；v0 形状在此保留——runGeneration 作用域内没有
    // 会话对象可供格式探测。
    source: m.role === 'assistant' ? { kind: 'model', provider, model } : m.role === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-tavern' },
  }))
  // 带意见重写（提案 0011）：意见是一次性生成指引，作为 system 段末尾块
  // （guides 块之后）注入，不落任何楼层。
  const rewriteBlock = formatRewriteBlock(options.feedback)
  if (rewriteBlock) systemParts.push(rewriteBlock)
  for await (const chunk of ctx.llm.stream({
    provider, model, messages: llmMessages,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    temperature: numberOr(preset.sampler.temperature, undefined),
    maxTokens: numberOr(preset.sampler.openai_max_tokens, undefined),
    signal,
  })) {
    // 逐 chunk 事件不落宿主会话：`assistant/chunk` 是 v0 词汇，v4 宿主加载期
    // 直接整会话拒载（SessionFormatUnsupportedError）；流式反馈走 SSE write，
    // 持久轨迹由终态 assistant/message 的 stream/settlement 承载。
    if (chunk.type === 'usage') hostUsage = chunk.usage
    if (chunk.type === 'text-delta') { text += chunk.text; write({ type: 'delta', text: chunk.text }) }
    else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; write({ type: 'reasoning', text: chunk.text }) }
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
      write({ type: 'finish', reason: chunk.reason.kind })
    }
  }
  if (text.trim() === '') throw new Error('model returned no text')

  // ---- AI_OUTPUT regex（非 promptOnly）→ 模板输出渲染（RENDER + setvar）→ 保存 ----
  const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
  let finalText = saveScripts.length > 0 ? applyRegexScripts(text, saveScripts, RegexPlacement.AI_OUTPUT, { expand }) : text
  if (tpl) finalText = await tpl.renderOutput(finalText)
  const finalReasoning = reasoning
    ? applyRegexScripts(reasoning, scripts, RegexPlacement.REASONING, { expand })
    : reasoning
  const now = new Date().toISOString()
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
    swipe_info: [...oldSwipeInfo, { send_date: now, extra: { provider, model, reasoning: finalReasoning || undefined, ...(options.feedback ? { feedback: options.feedback } : {}) } }],
    extra: {
      ...(regenerated?.extra ?? {}),
      api: provider, model, reasoning: finalReasoning || undefined,
      activatedLore: lore.allActivated.map((e) => e.entryId),
      ...(tpl && tpl.warnings.length > 0 ? { templateWarnings: tpl.warnings } : {}),
    },
  })
  // 变量持久化：宏局部快照（原语）+ 模板写穿的 local/initial（chat_metadata live）合并；
  // 模板 global 写穿 state.scriptGlobals，有变化时落 state.json
  const varSnapshot = macros.snapshotVars().local
  if (tpl) {
    mergeTemplateLocalVars(chat, varSnapshot)
    if (JSON.stringify(state.scriptGlobals) !== templateGlobalsBefore) {
      await db.updateState((current) => ({ scriptGlobals: { ...current.scriptGlobals, ...state.scriptGlobals } }))
    }
  } else if (Object.keys(varSnapshot).length > 0) {
    chat.header.chat_metadata.variables = varSnapshot
  } else {
    delete chat.header.chat_metadata.variables
  }
  // MVU 结算回执（提案 0012 P1）：diff 变量写穿前后（before 取自生成开始的基线），
  // 把结算结果落成可见、可重试的回执（环形 20 条）；无变量也无变更的局不写 mvu 键
  // （与 guides 空置摘键约定一致）。failures 收集本轮 templateWarnings。
  recordMvuTurnReceipt(chat, mvuVariablesBefore, {
    turnKey: String(chat.messages.length - 1),
    failures: tpl?.warnings ?? [],
  })
  revision = await db.saveChat(characterName, chatId, chat, revision)
  hostTrace = recordTavernSessionAssistant(hostTrace, finalText, finalReasoning, provider, model, hostUsage)
  return { chat, revision, speaker: speakerName }
  } finally {
    finishTavernSessionTrace(hostTrace)
  }
}

/* --------------------------- STscript 执行 --------------------------- */

function chatVariables(chat): Record<string, string | number | boolean> {
  const vars = chat?.header?.chat_metadata?.variables
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    return Object.fromEntries(Object.entries(vars).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
  }
  return {}
}

async function runTavernScript(ctx, req, res, db) {
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

  const persist = async () => {
    const vars = macros.snapshotVars().local
    if (Object.keys(vars).length > 0) chat.header.chat_metadata.variables = vars
    else delete chat.header.chat_metadata.variables
    revision = await db.saveChat(characterName, chatId, chat, revision)
  }

  const triggerGeneration = async (member) => {
    const fresh = await db.getChatSnapshot(characterName, chatId)
    const result = await runGeneration(ctx, db, {
      state: await db.getState(),
      characterName,
      chatId,
      snapshot: fresh ?? { chat, revision },
      mode: 'trigger',
      userText: '',
      group,
      triggerMember: member,
      write: () => {},
      signal: new AbortController().signal,
    })
    // 内核会保存并替换 chat 对象；同步回本作用域
    chat.messages = result.chat.messages
    chat.header = result.chat.header
    revision = result.revision
  }

  const result = await runScript(typeof body.script === 'string' ? body.script : '', {
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
    trigger: async (member) => { await triggerGeneration(member) },
    regenerate: async () => {
      const fresh = await db.getChatSnapshot(characterName, chatId)
      const regen = await runGeneration(ctx, db, {
        state: await db.getState(),
        characterName,
        chatId,
        snapshot: fresh ?? { chat, revision },
        mode: 'regenerate',
        userText: '',
        group,
        write: () => {},
        signal: new AbortController().signal,
      })
      chat.messages = regen.chat.messages
      chat.header = regen.chat.header
      revision = regen.revision
    },
    stop: () => {},
    cut: async (from, to) => {
      const total = chat.messages.length
      const start = from < 0 ? total + from : from
      const end = (to < 0 ? total + to : to) + 1
      chat.messages.splice(Math.max(0, start), Math.max(0, end - Math.max(0, start)))
      await persist()
    },
    echo: () => {},
  })

  // 全局变量持久化
  const globals = macros.snapshotVars().global
  await db.updateState(() => ({ scriptGlobals: globals }))
  const freshSnapshot = await db.getChatSnapshot(characterName, chatId)
  return sendJson(res, 200, {
    ok: true,
    output: result.output,
    chatChanged: result.chatChanged,
    chat: freshSnapshot?.chat ?? chat,
    revision: freshSnapshot?.revision ?? revision,
  })
}

/* ------------------------------ 辅助 ------------------------------ */

async function serveCharacterAvatar(res, db, name, found) {
  let bytes
  let contentType = 'image/png'
  if (found.kind === 'png') {
    bytes = await db.exportCharacter(name)
  } else if (found.kind === 'charx') {
    const container = await db.exportCharacter(name)
    const asset = found.card.data.assets?.find((item) => item.type === 'icon' && item.uri.startsWith('embeded://'))
      ?? found.card.data.assets?.find((item) => item.uri.startsWith('embeded://') && item.ext === 'png')
    if (!asset) return sendJson(res, 404, { ok: false, message: 'character avatar not found' })
    bytes = decodeCharxAsset(container, asset.uri.slice('embeded://'.length))
    contentType = imageContentType(asset.ext)
  } else {
    return sendJson(res, 404, { ok: false, message: 'character avatar not found' })
  }
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'private, max-age=300')
  res.end(Buffer.from(bytes))
}

async function isGroupChat(db, characterName, chatId) {
  const chat = await db.getChat(characterName, chatId)
  return chat?.header?.chat_metadata?.group !== undefined
}

/**
 * AgentTavern 导入/预加载的宏展开：{{char}}=角色名，{{user}}=激活 persona 名。
 * 与 ST substituteParams 对齐；未知宏保持原样。
 */
function tavernMacroExpand(state, characterName, character) {
  const macros = createMacroEngine({
    char: character?.card.data.nickname || character?.card.data.name || characterName,
    user: state.activePersona ?? DEFAULT_USER,
  })
  return (text) => macros.expand(text)
}

/**
 * 角色卡 extensions.world 绑定且已存在的世界书名（自动激活目标）。
 * 世界书文件不存在（外部引用未导入）时返回空，不产生悬空激活。
 */
async function characterLinkedWorlds(db, characterName) {
  const found = await db.getCharacter(characterName)
  const world = found?.card.data.extensions['world']
  if (typeof world !== 'string' || world.trim() === '') return []
  const book = await db.getWorld(world.trim())
  return book ? [book.name] : []
}

/**
 * markdownOnly AI_OUTPUT 脚本的展示层文本（ST 语义：仅改显示，不进 prompt、不落盘）。
 * 返回与 messages 平行的数组；无脚本时返回 undefined。
 */
async function displayTexts(db, state, characterName, chat) {
  const character = await db.getCharacter(characterName)
  const scripts = collectRegexScripts(state, character)
    .filter((script) => script.markdownOnly && !script.disabled)
  if (scripts.length === 0) return undefined
  return chat.messages.map((message, index) =>
    applyRegexScripts(message.mes ?? '', scripts, RegexPlacement.AI_OUTPUT, { expand: (t) => t }, { depth: chat.messages.length - 1 - index }))
}

async function presetSamplerValue(db, state, key) {
  const presetName = state.activePreset
  if (!presetName) return undefined
  const preset = await db.getPreset(presetName)
  return preset?.[key]
}

function parsePresetOrThrow(data) {
  const kind = detectPresetKind(data)
  if (kind === 'chat-completion') {
    parsePreset(data)
    return
  }
  if (kind === 'context') {
    parseContextTemplate(data)
    return
  }
  if (kind === 'instruct') {
    parseInstructTemplate(data)
    return
  }
  if (kind === 'textgen-sampler') return
  throw new Error('preset format not recognized (expected chat completion prompts, context, instruct, or textgen sampler)')
}

/** 压缩总结模型覆盖（提案 0006 §4.3）：成对非空 provider/model 才生效，
 * null/空串/半空一律清除为 undefined（回落部署配置与会话路由）。 */
function compactionOverrideOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = typeof value.curatorProvider === 'string' ? value.curatorProvider.trim() : ''
  const model = typeof value.curatorModel === 'string' ? value.curatorModel.trim() : ''
  return provider !== '' && model !== ''
    ? { curatorProvider: provider, curatorModel: model }
    : undefined
}

function publicGroup(group) {
  return {
    name: group.name,
    members: group.members,
    disabledMembers: group.disabledMembers,
    activationStrategy: group.activationStrategy,
    allowSelfResponses: group.allowSelfResponses,
    autoModeDelay: group.autoModeDelay,
    chatCount: group.chats.length,
  }
}

async function buildModelCatalog(ctx) {
  const catalog = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning = resolved.reasoning === undefined ? undefined : {
          efforts: resolved.reasoning.efforts.map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort }),
        }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }
      }))
      return { kind: 'group', group: { id: provider.id, name: provider.name, models: entries } }
    } catch (error) {
      return { kind: 'failure', failure: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) } }
    }
  }))
  return {
    groups: catalog.flatMap((item) => item.kind === 'group' ? [item.group] : []).filter((group) => group.models.length > 0),
    failures: catalog.flatMap((item) => item.kind === 'failure' ? [item.failure] : []),
  }
}

async function refreshActivePrompt() {
  try {
    const db = await store()
    const state = await db.getState()
    if (!state.nativeAgentPersona || !state.activeCharacter) { activeAgentPrompt = ''; return }
    const found = await db.getCharacter(state.activeCharacter)
    if (!found) { activeAgentPrompt = ''; return }
    const d = found.card.data
    activeAgentPrompt = [
      `Active roleplay character: ${d.nickname || d.name}`,
      d.description,
      d.personality ? `Personality: ${d.personality}` : '',
      d.scenario ? `Scenario: ${d.scenario}` : '',
    ].filter(Boolean).join('\n\n')
  } catch {
    activeAgentPrompt = ''
  }
}

async function bindSession(
  db,
  sessionId,
  character,
  chatId,
  group = false,
  architecture = 'st',
  contextMode = 'dsh-native',
  initializationPending = false,
) {
  // 使用角色（会话绑定）时自动激活其绑定的世界书；群聊无单一角色，不并入
  const linkedWorlds = group ? [] : await characterLinkedWorlds(db, character)
  return db.updateState((state) => {
    const existing = state.sessionBindings[sessionId]
    const sameAgentBinding = existing?.architecture === 'agent-tavern'
      && existing.character === character
      && existing.chatId === chatId
    const pending = initializationPending
      && (existing?.initializationPending === true || !sameAgentBinding)
    const binding = architecture === 'agent-tavern' && !group
      ? {
          architecture: 'agent-tavern', contextMode, character, chatId,
          ...(pending ? { initializationPending: true } : {}),
        }
      : { architecture: 'st', character, chatId, ...(group ? { group: true } : {}) }
    return {
      activeCharacter: group ? state.activeCharacter : character,
      ...(group || linkedWorlds.length === 0
        ? {}
        : { activeWorlds: [...new Set([...state.activeWorlds, ...linkedWorlds])] }),
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: binding,
      },
    }
  })
}

async function assertAgentTavernAvailable(architecture, contextMode) {
  if (architecture !== 'agent-tavern') return
  const capabilities = await agentTavernCapabilitiesPromise ?? agentTavernCapabilities
  const status = contextMode === 'agent-managed' ? capabilities.managed : capabilities.native
  if (!status.available) {
    throw new TavernArchitectureConflictError(`AgentTavern ${contextMode} is unavailable: ${status.reasons.join(' ')}`)
  }
}

function requestedArchitecture(value) {
  if (value === undefined || value === 'st') return 'st'
  if (value === 'agent-tavern') return value
  throw new Error(`unsupported Tavern architecture '${String(value)}'`)
}

function requestedContextMode(value) {
  if (value === undefined || value === 'dsh-native') return 'dsh-native'
  if (value === 'agent-managed') return value
  throw new Error(`unsupported AgentTavern context mode '${String(value)}'`)
}

function assertStGenerationBinding(state, sessionId) {
  if (typeof sessionId !== 'string') return
  const binding = state.sessionBindings[sessionId]
  if (binding?.architecture === 'agent-tavern') {
    throw new TavernArchitectureConflictError('AgentTavern sessions use the DSH native AgentLoop; the ST generation endpoint is unavailable.')
  }
}

/**
 * 宿主把「日志中从未出现 turn/start」的会话视为可复用的 blank 草稿：原生「新建
 * 会话」（workspaces.startSession → connectWorkspace）会直接复用它并切换过去。
 * Tavern 会话的激活 marker 与聊天生成都不经过宿主 agent loop，永远不产生宿主
 * turn——不摘除的话每个绑定的 Tavern 会话都会劫持原生新建会话。这里追加一对
 * 无 step 的空转 turn（reason=completed 与 agent-loop 对零消息 turn 的关闭方式
 * 一致）把会话标记为已占用；agent-loop 的真实 turn 号取 findLast(turn/start)+1，
 * 编号保持连续。幂等：仅在会话还没有任何 turn/start 时写入。
 *
 * ⚠️ 写占位 turn 之后必须推进 live loop 的轮次基线（advanceHostTurnBase）：宿主
 * 在构造 AgentLoop 时快照 `turnBoundary.lastTurn`（AgentLoop.phase.lastTurn），而
 * 会话/Agent 由宿主在本函数写入之前创建，快照仍是 0——不推进的话 live loop 的首轮
 * 会再写一次 `turn/start { turn: 1 }`，v4 关系准入（turn/start 必须等于 nextTurn）
 * 直接判会话损坏。基线不可推进（宿主换代）时宁可不占位，也不写坏会话。
 */
function occupyHostSession(agent) {
  try {
    if (sessionEvents(agent.session).some((event) => event.type === 'turn/start')) return
    if (!canAdvanceHostTurnBase(agent)) return
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    advanceHostTurnBase(agent, 1)
  } catch {
    // 宿主拒绝插件追加 turn 事件时仅失去防复用保护，不阻断激活本身。
  }
}

/**
 * live loop 的轮次基线位于 `AgentLoop.phase.lastTurn`：构造函数从
 * `turnBoundary.lastTurn` 快照一次，此后只在每个 turn 结束时更新。插件写入 turn
 * 边界后必须把基线推到最后一个已写入的 turn，否则 loop 会重复轮号（v4 准入拒绝
 * `turn/start does not open the expected turn`，会话从此不可读）。
 *
 * 该字段不是宿主的公开 seam，因此只在确认「存在、idle、可写」时使用；探测失败时
 * 调用方必须放弃写入 turn 边界（见 canAdvanceHostTurnBase）。
 */
function loopPhase(agent) {
  const phase = agent?.phase
  return typeof phase === 'object' && phase !== null ? phase : undefined
}

/** 探测 live loop 的轮次基线是否可推进：phase 存在、idle、且字段可写。 */
function canAdvanceHostTurnBase(agent) {
  const phase = loopPhase(agent)
  if (phase === undefined || phase.kind !== 'idle') return false
  if (!Number.isSafeInteger(phase.lastTurn)) return false
  // 回写同值：冻结对象 / 只读 getter 会让写入静默失败，这里提前发现。
  const before = phase.lastTurn
  try {
    phase.lastTurn = before
  } catch {
    return false
  }
  return phase.lastTurn === before
}

/** 把 live loop 的轮次基线推进到 turn（只增不减）。返回是否生效。 */
function advanceHostTurnBase(agent, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) return false
  const phase = loopPhase(agent)
  if (phase === undefined || phase.kind !== 'idle') return false
  if (Number.isSafeInteger(phase.lastTurn) && phase.lastTurn >= turn) return true
  try {
    phase.lastTurn = turn
  } catch {
    return false
  }
  return phase.lastTurn === turn
}

/** 会话日志里已写入的最大 turn/start 轮号；没有 turn 边界时返回 undefined。 */
function lastLoggedTurn(agent) {
  let last
  for (const event of sessionEvents(agent.session)) {
    if (event.type !== 'turn/start') continue
    const value = event.data?.turn
    if (Number.isSafeInteger(value) && (last === undefined || value > last)) last = value
  }
  return last
}

/**
 * 导入中断时兜底关闭仍然打开的 step/turn：无法确认宿主状态时以日志为准，
 * 否则半个导入会留下未关闭的 turn，live loop 的下一个 turn/start 会被准入拒绝。
 * 返回日志里已写入的最大轮号（供调用方推进基线）。
 */
function closeImportBracket(agent, reason) {
  let openTurn
  let openStep
  for (const event of sessionEvents(agent.session)) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      openTurn = event.data.turn
      openStep = undefined
      continue
    }
    if (event.type === 'turn/end') { openTurn = undefined; openStep = undefined; continue }
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) {
      openStep = { turn: event.data.turn, step: event.data.step }
      continue
    }
    if (event.type === 'step/end') openStep = undefined
  }
  if (openStep !== undefined) {
    try {
      agent.session.append('step/end', { turn: openStep.turn, step: openStep.step })
    } catch {
      // 兜底关闭失败不再递归处理。
    }
  }
  if (openTurn !== undefined) {
    try {
      agent.session.append('turn/end', { turn: openTurn, reason })
    } catch {
      // 同上。
    }
  }
  return lastLoggedTurn(agent)
}

// Tavern generation runs outside the native agent loop. Mirror its durable
// boundaries into the host session so native projections (stats/token usage)
// observe the same work as the injected Tavern surface.
function beginTavernSessionTurn(agent, userText) {
  const session = agent?.session
  if (!session?.append || readSessionEvents(session) === undefined) return null
  const logEvents = sessionEvents(session)
  let openTurn = false
  for (const event of logEvents) {
    if (event.type === 'turn/start') openTurn = true
    else if (event.type === 'turn/end') openTurn = false
  }
  if (openTurn) return null
  const turn = Math.max(0, ...logEvents
    .filter((event) => event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn))
    .map((event) => event.data.turn)) + 1
  let started = false
  try {
    session.append('turn/start', { turn })
    started = true
    if (userText.trim() !== '') {
      session.append('user/message', createMessage({
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    // agent 随 trace 走：ST 的 turn 闭合时要用它推进 live loop 轮次基线。
    return { session, turn, step: 1, stepOpen: false, turnOpen: true, logging: true, completed: false, agent }
  } catch {
    if (started) {
      try {
        session.append('turn/end', {
          turn,
          reason: { kind: 'error', error: { message: 'Tavern session trace failed', code: 'TAVERN_TRACE' } },
        })
        advanceHostTurnBase(agent, turn)
      } catch {
      }
    }
    return null
  }
}

function startTavernSessionStep(trace) {
  if (!trace?.logging) return trace
  try {
    trace.session.append('step/start', { turn: trace.turn, step: trace.step })
    trace.stepOpen = true
  } catch {
    trace.logging = false
  }
  return trace
}

function recordTavernSessionAssistant(trace, text, reasoning, provider, model, usage) {
  if (!trace?.logging || !trace.stepOpen) return trace
  try {
    const content = [{ type: 'text', text }]
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    const version = hostSessionFormatVersion(trace.session)
    trace.session.append('assistant/message', {
      turn: trace.turn,
      step: trace.step,
      message: createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider, model },
      }),
      ...(usage ? { usage } : {}),
      // v4 加载边界强制 settlement 形状（seed 校验无条件要求 data.stream 为数组，
      // 有 usage 也不豁免），缺失时 append 照常成功但会话重启即拒载；token-meter
      // 的 usageOf() 同样要求 usage/stream 至少一个，空流可保投影物化。v0-v3
      // 格式无此成员，多写反而毒化老宿主工件，故按版本分支。
      ...(version !== undefined && version >= 4 ? { stream: [] } : {}),
    }, { surfaceOp: 'append' })
    trace.completed = true
  } catch {
    trace.logging = false
  }
  return trace
}

function finishTavernSessionTrace(trace) {
  if (!trace?.turnOpen) return
  if (trace.stepOpen) {
    try {
      trace.session.append('step/end', { turn: trace.turn, step: trace.step })
    } catch {
      // step/end 落不下去意味着 open step 仍留在日志里，其后任何 turn/end 都
      // 会被 v4 关系校验拒绝（"turn/end does not match the open turn with no
      // open step"）；「未关闭的尾巴」本身合法——宁可留下未关闭的 turn，也
      // 不追加注定拒载的事件。立即终止 trace。
      trace.stepOpen = false
      trace.turnOpen = false
      return
    }
    trace.stepOpen = false
  }
  try {
    trace.session.append('turn/end', {
      turn: trace.turn,
      reason: trace.completed
        ? { kind: 'completed' }
        : { kind: 'error', error: { message: 'Tavern generation failed', code: 'TAVERN_GENERATION' } },
    })
    // ST trace 的 turn 已闭合：推进 live loop 轮次基线。宿主 AgentLoop 的
    // phase.lastTurn 只在构造时快照、不重扫磁盘——ST 与原生 loop 混用的会话里
    // 不推进则 live 首轮会重复本轮号，v4 关系准入直接判会话损坏。
    if (trace.agent !== undefined) advanceHostTurnBase(trace.agent, trace.turn)
  } catch {
  }
  trace.turnOpen = false
}

function normalizeChatId(name) {
  const stem = name.replace(/\.jsonl$/i, '').trim()
  if (stem === '') throw new Error('chat name is required')
  return `${stem}.jsonl`
}

function parseTavernSessionCommand(rawInput) {
  const payload = rawInput.trim()
  if (payload === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (parsed.action === 'close') return { action: 'close' }
    // AgentNovel bridge (proposal 0005 §4.2): management commands ride the
    // existing internal bridge and are never registered as author directives.
    if (parsed.action === 'novel-open') {
      return typeof parsed.novelId === 'string' && parsed.novelId.trim() !== ''
        ? { action: 'novel-open', novelId: parsed.novelId }
        : null
    }
    if (typeof parsed.character !== 'string' || typeof parsed.chatId !== 'string') return null
    const group = parsed.group === true
    const architecture = group ? 'st' : requestedArchitecture(parsed.architecture)
    return {
      action: 'open',
      character: parsed.character,
      chatId: parsed.chatId,
      group,
      architecture,
      contextMode: requestedContextMode(parsed.contextMode),
    }
  } catch {
    return null
  }
}

async function prepareInternalWorkspace() {
  const path = dshHomePath('tavern', 'workspace')
  await mkdir(path, { recursive: true })
  return { path, title: TAVERN_WORKSPACE_TITLE }
}

function readBuildInfo(): { version: string; commit: string } {
  let version = 'unknown'
  let commit = 'unknown'

  // 构建期 stamp（esbuild define）：git 安装现场没有 version.json 旁车文件
  // （仓库 .gitignore 排除它），install 目录也不是 Git 检出，只有打进 bundle
  // 的字面量能说清「这个包是哪个 commit 构建的」。自更新要靠它做比较。
  const stamped = buildTimeStamp()
  if (stamped.commit !== '') commit = stamped.commit

  for (const packagePath of [
    resolve(import.meta.dirname, 'package.json'),
    resolve(import.meta.dirname, '..', 'package.json'),
  ]) {
    try {
      const packageData = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (typeof packageData?.version === 'string' && packageData.version.trim() !== '') {
        version = packageData.version.trim()
        break
      }
    } catch {
    }
  }

  try {
    const generated = JSON.parse(readFileSync(resolve(import.meta.dirname, 'version.json'), 'utf8'))
    if (typeof generated?.version === 'string' && generated.version.trim() !== '') {
      version = generated.version.trim()
    }
    if (commit === 'unknown' && typeof generated?.commit === 'string') {
      commit = normalizeCommit(generated.commit) ?? 'unknown'
    }
  } catch {
  }

  return { version, commit }
}

/**
 * 读构建期注入的 `__TAVERN_VERSION__` / `__TAVERN_COMMIT__`。未定义时
 * （vitest、未走 build-plugin.mjs 的运行）返回空串，`typeof` 对未声明标识符
 * 安全，不会抛 ReferenceError。
 */
function buildTimeStamp(): { version: string; commit: string } {
  const version = typeof __TAVERN_VERSION__ === 'string' ? __TAVERN_VERSION__.trim() : ''
  const commit = typeof __TAVERN_COMMIT__ === 'string' ? normalizeCommit(__TAVERN_COMMIT__) : undefined
  return { version, commit: commit ?? '' }
}

function resolveTavernCommit(buildFallback: string): string {
  const fallback = normalizeCommit(process.env.DSH_TAVERN_COMMIT ?? buildFallback) ?? 'unknown'
  const repositoryRoot = resolve(import.meta.dirname, '..', '..')
  const packagePath = relative(repositoryRoot, import.meta.dirname).replaceAll('\\', '/')
  if (packagePath !== 'packages/plugin') return fallback

  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
    windowsHide: true,
  }).trim()

  try {
    // Avoid reporting the host application's commit when this package lives in
    // node_modules under an unrelated Git checkout.
    const gitRoot = resolve(git(['rev-parse', '--show-toplevel']))
    if (relative(repositoryRoot, gitRoot) !== '') return fallback
    return normalizeCommit(git(['rev-parse', '--short=7', 'HEAD'])) ?? fallback
  } catch {
    return fallback
  }
}

function normalizeCommit(value: string): string | undefined {
  const commit = value.trim()
  return /^[0-9a-f]{7,40}$/i.test(commit)
    ? commit.slice(0, 7).toLowerCase()
    : undefined
}

function createMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: crypto.randomUUID() }))
}

function deepFreeze(value) {
  const seen = new WeakSet()
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    Object.freeze(current)
    pending.push(...Object.values(current))
  }
  return value
}

function publicCard(card) {
  return { spec: card.spec, specVersion: card.specVersion, data: card.data }
}

/** 角色短身份摘要存在 data.extensions.agentTavern 下；服务端钳制长度，非字符串直接拒绝。 */
function clampIdentitySummary(card) {
  const extensions = card?.data?.extensions
  const agentTavern = extensions?.agentTavern
  if (!agentTavern || typeof agentTavern !== 'object' || Array.isArray(agentTavern)) return
  const summary = agentTavern.identitySummary
  if (summary === undefined || summary === null || summary === '') {
    delete agentTavern.identitySummary
    return
  }
  if (typeof summary !== 'string') throw new Error('identitySummary must be a string')
  agentTavern.identitySummary = summary.slice(0, 2000)
}

function imageContentType(ext) {
  const normalized = String(ext || '').toLowerCase()
  return normalized === 'jpg' || normalized === 'jpeg'
    ? 'image/jpeg'
    : normalized === 'webp'
      ? 'image/webp'
      : normalized === 'gif'
        ? 'image/gif'
        : 'image/png'
}

function roleName(role) {
  return role === 1 ? 'user' : role === 2 ? 'assistant' : 'system'
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function defaultPreset() {
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
    prompt_order: [{ character_id: 100000, order: prompts.map((p) => ({ identifier: p.identifier, enabled: true })) }],
  }
}

/**
 * `/api/dsh-tavern/update` 路由族：
 * - `GET  update`         → 缓存快照（`?refresh=1` 穿透 TTL 重新检查）；
 * - `POST update/check`   → 强制检查远端；
 * - `POST update/install` → 开始安装。默认等安装结束再回；`{ wait: false }`
 *   立刻返回，客户端轮询 `GET update` 读进度（安装本身跑在本进程里，不会因
 *   浏览器断开而中断）。
 */
async function handleUpdateApi(ctx, req, res, url, route, method) {
  const service = tavernUpdate(ctx)
  if (method === 'GET' && route === 'update') {
    const refresh = url.searchParams.get('refresh')
    const fresh = refresh === '1' || refresh === 'true'
    const snapshot = fresh ? await service.check({ force: true }) : service.snapshot()
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  if (method === 'POST' && route === 'update/check') {
    const snapshot = await service.check({ force: true })
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  if (method === 'POST' && route === 'update/install') {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const force = body.force === true
    if (body.wait === false) {
      void service.install({ force }).catch(() => {})
      const snapshot = service.snapshot()
      return sendJson(res, 200, { ok: true, started: true, update: snapshot, changelog: updateChangelog(snapshot) })
    }
    const snapshot = await service.install({ force })
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJson(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) { reject(new Error(`request exceeds ${maxBytes} bytes`)); req.destroy?.() }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}
