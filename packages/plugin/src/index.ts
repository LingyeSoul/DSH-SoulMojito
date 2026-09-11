import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
import { assemblePrompt, assembleTextCompletion, buildGroupTurn, pickGroupMember } from '../../tavern-pipeline/src/index.js'
import { applyRegexScripts, runScript } from '../../tavern-script/src/index.js'
import {
  ChatRevisionConflictError,
  MemoryStore,
  TavernStore,
  VariableStore,
  type TavernModelSelection,
} from '../../tavern-store/src/index.js'
import { describeHostShape, readSessionEvents, sessionEvents, type HostSessionLog } from '../../bind/src/index.js'
import {
  AGENT_TAVERN_PRESET_ID,
  bootstrapAgentTavernCapabilities,
  inspectAgentTavernCapabilities,
  type AgentTavernCapabilities,
} from './agent-tavern/capabilities.js'
import { createDshAgentTavernAdapter } from './agent-tavern/dsh-adapter.js'
import { registerAgentTavernAnchor } from './agent-tavern/anchor.js'
import { AgentTavernProjector, historyImportAppends, type SessionImportAppend } from './agent-tavern/projector.js'
import { buildAgentTavernPreloadSnapshot, collectRegexScripts, collectWorldInfoBooks } from './tavern-assets.js'

export const name = 'dsh-tavern'
export const inject = ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools']

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

export function apply(ctx, config: { anchorEveryTurns?: unknown } = {}) {
  registerAgentTavernAnchor(ctx, { everyTurns: config.anchorEveryTurns })
  const adapter = createDshAgentTavernAdapter(ctx)
  // 宿主形状一次性上报：rc.6 与 0.1.2+ 的绑定路径差异排查从这行日志读起。
  ctx.logger?.info?.(`dsh-tavern host shape: ${JSON.stringify(describeHostShape(ctx))}`)
  agentTavernCapabilitiesPromise = bootstrapAgentTavernCapabilities(adapter, {
    presetId: AGENT_TAVERN_PRESET_ID,
    ensurePreset: ensureBundledAgentTavernPreset,
  })
  void agentTavernCapabilitiesPromise.then((value) => { agentTavernCapabilities = value })
  agentTavernProjectorPromise = store().then((db) => AgentTavernProjector.open(dshHomePath('tavern'), db))
  ctx.on?.('session/event', (session, event) => {
    void agentTavernProjectorPromise!.then((projector) => projector.project(session, event))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection failed: ${error instanceof Error ? error.message : String(error)}`))
    // turn 作用域变量是单轮 scratch 状态，turn 结束即过期。
    if (event?.type === 'turn/end' && typeof session?.id === 'string') {
      void variables().then((store) => store.clear('turn', session.id)).catch(() => {})
    }
  })
  ctx.on?.('agent/created', ({ agent }) => {
    void agentTavernProjectorPromise!.then((projector) => projector.replay(agent.session))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection replay failed: ${error instanceof Error ? error.message : String(error)}`))
  })
  void refreshActivePrompt()
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
          source: {
            kind: 'plugin',
            plugin: 'dsh-tavern',
            form: 'notice',
            summary: 'Tavern closed',
            tavernState: 'closed',
          },
        }), { surfaceOp: 'append' })
        return { kind: 'success', text: 'Tavern closed' }
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
          return source?.plugin === 'dsh-tavern' && source.form !== 'context'
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
            : historyImportAppends(chat, agent.id, character ? collectRegexScripts(currentState, character) : [], tavernMacroExpand(currentState, parsed.character, character))
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
          source: {
            kind: 'plugin',
            plugin: 'dsh-tavern',
            form: 'context',
            summary: `AgentTavern preload: ${parsed.character}`,
          },
        }))
      }
      if (historyImport !== undefined) {
        try {
          for (const item of historyImport) {
            agent.session.append(item.type, item.data, item.surfaceOp === undefined ? undefined : { surfaceOp: item.surfaceOp })
          }
        } catch (error) {
          // 导入失败不阻断绑定；用户仍可直接对话，缺失的历史留在 JSONL 可重放。
          ctx.logger?.warn?.(`AgentTavern history import failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await refreshActivePrompt()
      if (parsed.architecture === 'st') occupyHostSession(agent)
      if (parsed.architecture === 'st' && (previous?.character !== parsed.character || previous.chatId !== parsed.chatId)) {
        agent.session.append('user/message', createMessage({
          role: 'user',
          content: [{ type: 'text', text: `Tavern roleplay chat for ${parsed.character}.` }],
          source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: `Tavern: ${parsed.character}` },
        }), { surfaceOp: 'append' })
      }
      return { kind: 'success', text: `Tavern: ${parsed.character}` }
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      try {
        await handleApi(ctx, req, res)
      } catch (error) {
        if (!res.writableEnded) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError
            ? error.code
            : undefined
          if (res.headersSent) {
            res.write(JSON.stringify({ type: 'error', message, code }) + '\n')
            res.end()
          } else {
            sendJson(res, error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError ? 409 : 500, { ok: false, message, code })
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
      ...(body.pipelineMode === 'chat' || body.pipelineMode === 'text' ? { pipelineMode: body.pipelineMode } : {}),
      ...(isTextCompletionConfig(body.textCompletion) ? { textCompletion: normalizeTextCompletion(body.textCompletion) } : {}),
      ...(body.textCompletion === null ? { textCompletion: undefined } : {}),
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
      textCompletion: current.textCompletion
        ? {
            ...current.textCompletion,
            ...(current.textCompletion.contextPreset === oldName ? { contextPreset: body.name } : {}),
            ...(current.textCompletion.instructPreset === oldName ? { instructPreset: body.name } : {}),
            ...(current.textCompletion.samplerPreset === oldName ? { samplerPreset: body.name } : {}),
          }
        : current.textCompletion,
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
    const state = await db.updateState((current) => {
      const tc = current.textCompletion
      const tcStale = tc !== undefined
        && (tc.contextPreset === name || tc.instructPreset === name || tc.samplerPreset === name)
      const textCompletion = tcStale
        ? {
            endpoint: tc.endpoint,
            ...(tc.apiKey ? { apiKey: tc.apiKey } : {}),
            streaming: tc.streaming !== false,
            ...(tc.contextPreset !== undefined && tc.contextPreset !== name ? { contextPreset: tc.contextPreset } : {}),
            ...(tc.instructPreset !== undefined && tc.instructPreset !== name ? { instructPreset: tc.instructPreset } : {}),
            ...(tc.samplerPreset !== undefined && tc.samplerPreset !== name ? { samplerPreset: tc.samplerPreset } : {}),
          }
        : current.textCompletion
      return {
        activePreset: current.activePreset === name ? undefined : current.activePreset,
        ...(tcStale ? { textCompletion } : {}),
      }
    })
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

  if (method === 'GET' && route === 'tc/check') {
    const state = await db.getState()
    const config = state.textCompletion
    if (!config || config.endpoint === '') throw new Error('text completion endpoint is not configured')
    const model = await koboldModelInfo(config)
    return sendJson(res, 200, { ok: true, model })
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

/* --------------------------- 生成内核（共享） --------------------------- */

async function generate(ctx, req, res, db) {
  const body = await readJson(req)
  const state = await db.getState()
  assertStGenerationBinding(state, body.sessionId)
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  const userText = typeof body.message === 'string' ? body.message.trim() : ''
  const mode = body.mode === 'regenerate' ? 'regenerate' : 'send'
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

  // WI 内容进 prompt 前过 WORLD_INFO regex
  const wiDeps = { expand: (text) => text }
  const loreBefore = lore.worldInfoBefore.entries.map((e) => applyRegexScripts(e.content, scripts, RegexPlacement.WORLD_INFO, wiDeps))
  const loreAfter = lore.worldInfoAfter.entries.map((e) => applyRegexScripts(e.content, scripts, RegexPlacement.WORLD_INFO, wiDeps))

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

  // ---- promptOnly AI_OUTPUT：历史消息只影响 prompt 的变换 ----
  const promptOnlyScripts = scripts.filter((script) => script.promptOnly && !script.markdownOnly)
  const historyForPrompt = promptOnlyScripts.length > 0
    ? turnMessages.map((m, index) => ({
        ...m,
        mes: applyRegexScripts(m.mes, promptOnlyScripts, RegexPlacement.AI_OUTPUT, {}, { depth: turnMessages.length - 1 - index }),
      }))
    : turnMessages

  const depthInjections = [
    ...lore.atDepth.map((g) => ({ depth: g.depth, role: roleName(g.role), text: g.text })),
    ...(lore.topOfAuthorsNote.text ? [{ depth: 4, role: 'system', text: lore.topOfAuthorsNote.text }] : []),
    ...(lore.bottomOfAuthorsNote.text ? [{ depth: 0, role: 'system', text: lore.bottomOfAuthorsNote.text }] : []),
    ...personaInjections,
  ]

  const isTextPipeline = state.pipelineMode === 'text' && state.textCompletion?.endpoint
  let provider = ''
  let model = ''
  let reasoningEffort: string | undefined
  let promptString = ''
  let assembled
  if (isTextPipeline) {
    const config = state.textCompletion
    const contextPreset = config.contextPreset ? await db.getPreset(config.contextPreset) : undefined
    const instructPreset = config.instructPreset ? await db.getPreset(config.instructPreset) : undefined
    const samplerPreset = config.samplerPreset ? await db.getPreset(config.samplerPreset) : undefined
    const context = contextPreset && detectPresetKind(contextPreset) === 'context'
      ? parseContextTemplate(contextPreset)
      : defaultContextTemplate()
    const instruct = instructPreset && detectPresetKind(instructPreset) === 'instruct'
      ? parseInstructTemplate(instructPreset)
      : undefined
    const tc = assembleTextCompletion({
      context,
      instruct,
      speakerName: character.card.data.nickname || character.card.data.name,
      userName,
      speakerFields: {
        description: character.card.data.description,
        personality: character.card.data.personality,
        scenario: character.card.data.scenario,
        systemPrompt: character.card.data.systemPrompt,
        postHistoryInstructions: character.card.data.postHistoryInstructions,
        mesExample: character.card.data.mesExample,
      },
      personaDescription,
      systemPrompt: character.card.data.systemPrompt.trim() !== ''
        ? character.card.data.systemPrompt
        : (preset.prompts.find((p) => p.identifier === 'main' && !p.marker)?.content ?? ''),
      worldInfoBefore: loreBefore,
      worldInfoAfter: loreAfter,
      messages: [...historyForPrompt, ...(nudge ? [{ name: userName, is_user: true, is_system: false, send_date: '', mes: nudge.content }] : [])],
      depthInjections,
      maxContextTokens: numberOr(samplerPreset?.['max_context_length'], numberOr(preset.sampler.openai_max_context, 4096)),
      maxResponseTokens: numberOr(samplerPreset?.['max_length'], numberOr(preset.sampler.openai_max_tokens, 400)),
    }, { expand, countTokens })
    promptString = tc.prompt
    provider = 'kobold'
    model = 'kobold'
    write({ type: 'start', provider, model, speaker: speakerName, lore: lore.allActivated.map((e) => ({ uid: e.uid, book: e.book, comment: e.entry.comment })), stats: tc.stats, warnings: tc.warnings })
  } else {
    assembled = assemblePrompt({
      card: character.card, preset, personaDescription,
      messages: historyForPrompt,
      worldInfoBefore: loreBefore,
      worldInfoAfter: loreAfter,
      beforeExamples: lore.beforeExamples.entries.map((e) => e.content),
      afterExamples: lore.afterExamples.entries.map((e) => e.content),
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
    provider = choice.provider
    model = choice.model
    reasoningEffort = explicit?.reasoningEffort ?? saved?.reasoningEffort
      ?? (provider === fallback.provider && model === fallback.model ? fallback.reasoningEffort : undefined)
    write({ type: 'start', provider, model, speaker: speakerName, lore: lore.allActivated.map((e) => ({ uid: e.uid, book: e.book, comment: e.entry.comment })), stats: assembled.stats })
  }

  // ---- 流式生成 ----
  let text = ''
  let reasoning = ''
  let hostUsage
  hostTrace = startTavernSessionStep(hostTrace)
  if (isTextPipeline) {
    const config = state.textCompletion
    const samplerPreset = config.samplerPreset ? await db.getPreset(config.samplerPreset) : undefined
    for await (const chunk of streamKobold(config, promptString, samplerPreset, signal)) {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        recordTavernSessionChunk(hostTrace, { type: chunk.type, index: 0, text: chunk.text })
      }
      if (chunk.type === 'text-delta') { text += chunk.text; write({ type: 'delta', text: chunk.text }) }
      else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; write({ type: 'reasoning', text: chunk.text }) }
    }
  } else {
    const requestMessages = [...assembled.messages]
    const systemParts = []
    while (requestMessages[0]?.role === 'system') systemParts.push(requestMessages.shift().content)
    const llmMessages = requestMessages.map((m) => createMessage({
      role: m.role,
      content: [{ type: 'text', text: m.content }],
      source: m.role === 'assistant' ? { kind: 'model', provider, model } : m.role === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-tavern' },
    }))
    for await (const chunk of ctx.llm.stream({
      provider, model, messages: llmMessages,
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      temperature: numberOr(preset.sampler.temperature, undefined),
      maxTokens: numberOr(preset.sampler.openai_max_tokens, undefined),
      signal,
    })) {
      recordTavernSessionChunk(hostTrace, chunk)
      if (chunk.type === 'usage') hostUsage = chunk.usage
      if (chunk.type === 'text-delta') { text += chunk.text; write({ type: 'delta', text: chunk.text }) }
      else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; write({ type: 'reasoning', text: chunk.text }) }
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
        write({ type: 'finish', reason: chunk.reason.kind })
      }
    }
  }
  if (text.trim() === '') throw new Error('model returned no text')

  // ---- AI_OUTPUT regex（非 promptOnly）+ 保存 ----
  const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
  const finalText = saveScripts.length > 0 ? applyRegexScripts(text, saveScripts, RegexPlacement.AI_OUTPUT, { expand }) : text
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
    swipe_info: [...oldSwipeInfo, { send_date: now, extra: { provider, model, reasoning: finalReasoning || undefined } }],
    extra: { ...(regenerated?.extra ?? {}), api: provider, model, reasoning: finalReasoning || undefined, activatedLore: lore.allActivated.map((e) => e.entryId) },
  })
  // STscript 局部变量持久化（宏展开期间的 {{setvar}} 等经引擎持有）
  const varSnapshot = macros.snapshotVars().local
  if (Object.keys(varSnapshot).length > 0) chat.header.chat_metadata.variables = varSnapshot
  else delete chat.header.chat_metadata.variables
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

/* --------------------------- Kobold 客户端 --------------------------- */

const KOBOLD_SAMPLER_KEYS = [
  'temperature', 'top_p', 'top_k', 'top_a', 'typical', 'min_p', 'tfs',
  'rep_pen', 'rep_pen_range', 'rep_pen_slope', 'presence_penalty', 'seed',
]

function koboldRequestBody(prompt: string, sampler: Record<string, unknown> | undefined, maxContext: number, maxLength: number) {
  const body = {
    prompt,
    max_context_length: maxContext,
    max_length: maxLength,
  }
  if (sampler !== undefined) {
    for (const key of KOBOLD_SAMPLER_KEYS) {
      const value = sampler[key]
      if (typeof value === 'number' && Number.isFinite(value)) body[key] = value
    }
  }
  return body
}

async function* streamKobold(config, prompt, samplerPreset, signal) {
  const sampler = samplerPreset ?? {}
  const maxContext = numberOr(sampler['max_context_length'], 4096)
  const maxLength = numberOr(sampler['max_length'], 400)
  const body = koboldRequestBody(prompt, sampler, maxContext, maxLength)
  const headers = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  }
  if (config.streaming !== false) {
    try {
      const response = await fetch(new URL('api/extra/generate/stream', ensureTrailingSlash(config.endpoint)), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
      if (response.ok && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const data = line.startsWith('data:') ? line.slice(5).trim() : ''
            if (data === '' || data === '[DONE]') continue
            try {
              const token = JSON.parse(data)
              if (typeof token === 'string' && token !== '') yield { type: 'text-delta', text: token }
            } catch {
              // 非 JSON 行忽略（KoboldCpp 事件注释行）
            }
          }
          if (part.done) break
        }
        return
      }
      // 非 2xx：落到单发回退（404/405 = 端点不存在）
    } catch (error) {
      if (signal.aborted) throw error
      // 网络错误继续尝试单发端点（可能是不同实现）
    }
  }
  const response = await fetch(new URL('api/v1/generate', ensureTrailingSlash(config.endpoint)), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`Kobold generate failed: HTTP ${response.status}`)
  const payload = await response.json()
  const text = payload?.results?.[0]?.text
  if (typeof text !== 'string') throw new Error('Kobold generate returned no text')
  yield { type: 'text-delta', text }
}

async function koboldModelInfo(config) {
  const response = await fetch(new URL('api/v1/model', ensureTrailingSlash(config.endpoint)), {
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`Kobold endpoint check failed: HTTP ${response.status}`)
  const payload = await response.json()
  const model = typeof payload?.result === 'string' ? payload.result : payload?.result?.model ?? payload?.model ?? 'kobold'
  return { name: model, version: payload?.result?.version ?? undefined }
}

function ensureTrailingSlash(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`
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

function isTextCompletionConfig(value) {
  return typeof value === 'object' && value !== null && typeof value.endpoint === 'string'
}

function normalizeTextCompletion(value) {
  return {
    endpoint: String(value.endpoint).trim(),
    ...(typeof value.apiKey === 'string' && value.apiKey !== '' ? { apiKey: value.apiKey } : {}),
    streaming: value.streaming !== false,
    ...(typeof value.contextPreset === 'string' && value.contextPreset !== '' ? { contextPreset: value.contextPreset } : {}),
    ...(typeof value.instructPreset === 'string' && value.instructPreset !== '' ? { instructPreset: value.instructPreset } : {}),
    ...(typeof value.samplerPreset === 'string' && value.samplerPreset !== '' ? { samplerPreset: value.samplerPreset } : {}),
  }
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

/** Install the shipped preset only into the user layer and never overwrite edits. */
async function ensureBundledAgentTavernPreset(): Promise<void> {
  const bundledRoots = [
    resolve(import.meta.dirname, 'agent-presets'),
    resolve(import.meta.dirname, '..', 'agent-presets'),
  ]
  const bundledRoot = bundledRoots.find((candidate) => {
    try {
      return readFileSync(resolve(candidate, AGENT_TAVERN_PRESET_ID, 'agent.cordis.yml'), 'utf8').trim() !== ''
    } catch {
      return false
    }
  })
  if (!bundledRoot) throw new Error('bundled AgentTavern preset is missing from the plugin package')

  const sourceRoot = resolve(bundledRoot, AGENT_TAVERN_PRESET_ID)
  const targetRoot = dshHomePath('.agent-presets', AGENT_TAVERN_PRESET_ID)
  await mkdir(targetRoot, { recursive: true })
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    const target = resolve(targetRoot, file)
    try {
      await writeFile(target, await readFile(resolve(sourceRoot, file)), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
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
 */
function occupyHostSession(agent) {
  try {
    if (sessionEvents(agent.session).some((event) => event.type === 'turn/start')) return
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } catch {
    // 宿主拒绝插件追加 turn 事件时仅失去防复用保护，不阻断激活本身。
  }
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
    return { session, turn, step: 1, stepOpen: false, turnOpen: true, logging: true, completed: false }
  } catch {
    if (started) {
      try {
        session.append('turn/end', {
          turn,
          reason: { kind: 'error', error: { message: 'Tavern session trace failed', code: 'TAVERN_TRACE' } },
        })
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

function recordTavernSessionChunk(trace, chunk) {
  if (!trace?.logging || !trace.stepOpen) return
  try {
    trace.session.append('assistant/chunk', { turn: trace.turn, step: trace.step, chunk })
  } catch {
    trace.logging = false
  }
}

function recordTavernSessionAssistant(trace, text, reasoning, provider, model, usage) {
  if (!trace?.logging || !trace.stepOpen) return trace
  try {
    const content = [{ type: 'text', text }]
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    trace.session.append('assistant/message', {
      turn: trace.turn,
      step: trace.step,
      message: createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider, model },
      }),
      ...(usage ? { usage } : {}),
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

function dshHomePath(...segments) {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), ...segments)
}

async function prepareInternalWorkspace() {
  const path = dshHomePath('tavern', 'workspace')
  await mkdir(path, { recursive: true })
  return { path, title: TAVERN_WORKSPACE_TITLE }
}

function readBuildInfo(): { version: string; commit: string } {
  let version = 'unknown'
  let commit = 'unknown'

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
    if (typeof generated?.commit === 'string') {
      commit = normalizeCommit(generated.commit) ?? 'unknown'
    }
  } catch {
  }

  return { version, commit }
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

function defaultContextTemplate() {
  return parseContextTemplate({
    story_string: [
      '{{#if system}}{{system}}',
      '{{/if}}{{#if wiBefore}}{{wiBefore}}',
      '{{/if}}{{#if description}}{{description}}',
      '{{/if}}{{#if personality}}{{personality}}',
      '{{/if}}{{#if scenario}}{{scenario}}',
      '{{/if}}{{#if wiAfter}}{{wiAfter}}',
      '{{/if}}{{#if persona}}{{persona}}{{/if}}',
    ].join(''),
  })
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
