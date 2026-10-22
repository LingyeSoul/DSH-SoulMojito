import { detectPresetKind, parseRegexScripts } from '../../../tavern-format/src/index.js'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  deleteOriginalSnapshot,
  moveOriginalSnapshot,
  saveOriginalSnapshot,
  type TavernModelSelection,
} from '../../../tavern-store/src/index.js'
import { readSessionEvents, type HostSessionLog } from '../../../bind/src/index.js'
import { getIdbRecord, IDB_MAX_RECORD_BYTES, putIdbRecordFromFile } from '../../../tavern-frontend-storage/src/index.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { seedJsrMvuVariables } from '../agent-tavern/mvu-compat.js'
import { serveCharacterAvatar, sendAvatarFallback } from '../assets.js'
import { BUILD_INFO, TAVERN_COMMIT } from '../build-info.js'
import { collectCardScriptBundle } from '../card-scripts.js'
import { runCandidateGeneration } from '../candidates.js'
import { tavernDataRoot } from '../dsh-home.js'
import { latestFrontendMessage, stripFrontendDocuments } from '../frontend-documents.js'
import { handleGamesApi, isGamesRoute } from '../games/http.js'
import { handleHelperApi } from '../helper.js'
import { generate, previewGeneration, runTavernScript } from '../generation/pipeline.js'
import { buildModelCatalog, clampIdentitySummary, publicCard, publicGroup, refreshActivePrompt } from '../model-catalog.js'
import { emitAssetsSaved, emitChatSaved } from '../mods/events.js'
import { modsDisabledByEnv } from '../mods/host.js'
import { compactionOverrideOf, displayTextForMessage, displayTexts, parsePresetOrThrow } from '../prompt-context.js'
import { listPromptViews } from '../prompt-viewer.js'
import { optionalFeedback } from '../rewrite.js'
import { collectRegexScripts } from '../tavern-assets.js'
import {
  getAgentNovelCapabilities,
  getAgentTavernCapabilities,
  getAgentTavernCapabilitiesPromise,
  getAgentTavernProjectorPromise,
  getGamesServicePromise,
  memories,
  modHostProjection,
  store,
  tavernUpdate,
  variables,
} from '../runtime.js'
import {
  assertAgentTavernAvailable,
  assertStGenerationBinding,
  bindSession,
  requestedArchitecture,
  requestedContextMode,
  TavernArchitectureConflictError,
} from '../session/binding.js'
import { normalizeChatId } from '../session/trace.js'
import { prepareInternalWorkspace, prepareWorkbenchWorkspace } from '../workspace.js'
import { readJson, sendJson } from './io.js'
import { handleMemoryEmbedApi, handleMemoryMaintenanceApi } from './memory.js'
import { handleModsApi } from './mods.js'
import { handleNovelsApi } from './novel.js'
import { handleGuidesApi, handleMvuApi, handleScriptApi, handleWorkbenchApi } from './panel.js'
import { handleUpdateApi } from './update.js'

export const API = '/api/dsh-soulmojito'
export async function handleApi(ctx, req, res) {
  const url = new URL(req.url ?? API, 'http://localhost')
  const route = url.pathname.slice(API.length).replace(/^\//, '')
  const method = req.method ?? 'GET'

  // 自更新走独立处理器：它不依赖 Tavern store，且在 store 打不开时仍要能回答
  // 「有新版本吗」——升级本身正是修数据/兼容问题的入口。
  if (route === 'update' || route.startsWith('update/')) {
    return handleUpdateApi(ctx, req, res, url, route, method)
  }

  // 游戏桥路由（提案 0018 §4.1 http.ts）：同样不依赖 Tavern store（自带
  // games/ 目录与会话存储），结构化错误（409/400/404/503）在面内应答。
  if (isGamesRoute(route)) {
    return handleGamesApi({
      resolveService: () => getGamesServicePromise(),
      req,
      res,
      url,
      route,
      method,
    })
  }

  const db = await store()

  if (method === 'GET' && route === 'bootstrap') {
    await getAgentTavernCapabilitiesPromise()
    const internalWorkspace = await prepareInternalWorkspace()
    const workbenchWorkspace = await prepareWorkbenchWorkspace()
    // store 变更水位先于资产列表读取：客户端以它做轮询水位线，先取水位后读
    // 列表，最坏情况（读列表期间又有写入）只是下一轮多刷一次，不会漏刷新。
    const storeRevision = await db.storeRevision()
    // Regex 归属的存量迁移：旧 state 没有 regexScriptOwners 时扫描一次角色卡，
    // 让已物化的卡级脚本在面板/生成面都跟随角色卡；写盘后不再扫描。
    await db.ensureRegexScriptOwners()
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
    // 世界书条目数投影：面板列表不点开书也显示真实条目数（书本内容仍按浏览/
    // 编辑懒加载）。与 presetKinds 同款服务端轻量投影；单本损坏只缺数不断路，
    // bootstrap 不因坏书 500，点开该书仍走既有 fetch 错误路径。
    const worldEntryCounts = {}
    for (const name of await db.listWorlds()) {
      try {
        const book = await db.getWorld(name)
        if (book) worldEntryCounts[name] = book.entries.length
      } catch { /* 坏文件按缺数处理，保持 bootstrap 可用 */ }
    }
    return sendJson(res, 200, {
      ok: true,
      storeRevision,
      state,
      characters: await db.listCharacters(),
      worlds: await db.listWorlds(),
      worldEntryCounts,
      presets: await db.listPresets(),
      presetKinds,
      personas,
      groups,
      activeCard: active ? publicCard(active.card) : null,
      model: ctx.agentDefaultModel.currentSelection(),
      version: BUILD_INFO.version,
      commit: TAVERN_COMMIT,
      internalWorkspace,
      workbenchWorkspace,
      agentTavern: getAgentTavernCapabilities(),
      agentNovel: getAgentNovelCapabilities(),
      // 自更新快照：只读缓存结论，检查/安装分别走 update/check 与 update/install，
      // 保证 bootstrap 永远不因网络失败而变慢或报错。
      // Mod 轻量投影（提案 0015 §3.5，P1 真实化）：与 worldEntryCounts 同款服务端
    // 轻量投影，{id, name, version, author, description, capabilities, panel,
    // status, enabled, error, auditCount} 清单；宿主失败/无 Mod 时为空数组，
    // bootstrap 不因坏 Mod 500。旧客户端不读该键。
    mods: await modHostProjection(ctx),
    // env 硬关时客户端把管理面的开关锁死并展示原因（mods 投影另有 per-Mod 状态）。
    modsAvailable: !modsDisabledByEnv(),
    update: tavernUpdate(ctx).snapshot(),
    })
  }

  // 资产变更水位（写卡 Agent 等后台写入没有推送通道）：客户端页面可见期间
  // 轮询这个轻量端点，与 bootstrap 携带的 storeRevision 比对，变化即重取
  // bootstrap，刷新角色卡/世界书/预设等列表。
  if (method === 'GET' && route === 'store-revision') {
    return sendJson(res, 200, { ok: true, revision: await db.storeRevision() })
  }

  if (method === 'GET' && route.startsWith('avatar/')) {
    const name = decodeURIComponent(route.slice('avatar/'.length))
    const found = await db.getCharacter(name)
    if (found) {
      return serveCharacterAvatar(res, db, name, found)
    }
    // 群组：回落第一个启用成员的头像；成员都没有头像时给默认替代头像
    const group = await db.getGroup(name)
    if (group) {
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      for (const member of enabled.length > 0 ? enabled : group.members) {
        const memberFile = await db.getCharacter(member)
        if (memberFile) return serveCharacterAvatar(res, db, member, memberFile)
      }
      return sendAvatarFallback(res, name)
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
    const projector = await getAgentTavernProjectorPromise()
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
    const projector = await getAgentTavernProjectorPromise()
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
  if ((method === 'GET' || method === 'POST' || method === 'DELETE') && route.startsWith('guides/')) {
    return handleGuidesApi(req, res, route, method, db)
  }

  // ---- 剧本游玩（提案 0014 P1）----
  // 剧本库：TXT/MD 素材分块存 <tavern>/scripts/<name>/script.json；绑定在卡
  // data.extensions.agentTavern.scriptId（一对一）；进度在 chat_metadata.scriptProgress，
  // 由生成链路的对齐推进写。进度是展示不是跳章（§4）：没有写进度的路由。
  if ((method === 'GET' || method === 'POST') && (route === 'scripts' || route === 'script/import' || route === 'script/bind' || route === 'script/unbind' || route.startsWith('script/'))) {
    return handleScriptApi(req, res, route, method, db)
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
      Promise.all(scopes.map(({ scope, scopeId }) => variables().then((store) => store.listAll(scope, scopeId)))),
      memories().then((store) => store.search({ scope: 'global', includeDeleted: true, limit: 50 })),
      variables().then((store) => store.listAll('global', 'global')),
      getAgentTavernProjectorPromise(),
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

  // ---- Mod 管理面与子路由（提案 0015 §3.2/§3.3 P1）----
  // 管理面（GET mods / POST mods/state / enable|disable|reload）在任一层关闭时
  // 仍可用（否则用户无法再打开）；Mod 子路由（mods/<id>/<path>）在任一层关闭、
  // 未装载或无此路由时一律 404，与未知路由不可区分。
  if (route === 'mods' || route.startsWith('mods/')) {
    return handleModsApi(ctx, req, res, url, route, method)
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
    await emitAssetsSaved('character', nextName)
    if (nextName !== oldName) {
      // 原版快照按卡名寻址、跟卡走；不迁移则新名 restore 断链、旧名留幽灵快照。
      await moveOriginalSnapshot(tavernDataRoot(), oldName, nextName)
    }
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
    // 删原版快照（对齐 card_delete 工具面）：否则同名卡再导入时「首个胜出」
    // 保住陈旧快照，card_restore_original 会把旧卡写回新卡。
    await deleteOriginalSnapshot(tavernDataRoot(), name)
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
    // 世界书跟随角色卡是**会话级**行为（2026-10-22 用户需求）：绑定的世界书只在
    // 该角色卡的会话里由 collectWorldInfoBooks 自动并入；这里不再写 activeWorlds。
    // activeWorlds 只代表用户的手动选择，插件不替用户增删。
    const patch = {
      ...(typeof body.activeCharacter === 'string' || body.activeCharacter === null ? { activeCharacter: body.activeCharacter || undefined } : {}),
      ...(Array.isArray(body.activeWorlds)
        ? { activeWorlds: body.activeWorlds.filter((x) => typeof x === 'string') }
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
      // 美化前端右栏 tab 自动展开（2026-10-20 用户需求）：翻转即时生效——
      // 客户端 watcher 每次扫描都读 bootstrap.state，无需写穿。
      ...(typeof body.frontendAutoOpen === 'boolean'
        ? { frontendAutoOpen: body.frontendAutoOpen }
        : {}),
      // 卡脚本自动运行（2026-10-21 用户需求）：默认关闭；翻转即时生效——客户端
      // 自动展开 hook 与 tab 每次渲染都读 bootstrap.state，无缓存需写穿。
      ...(typeof body.cardScriptsAutoRun === 'boolean'
        ? { cardScriptsAutoRun: body.cardScriptsAutoRun }
        : {}),
      // 允许美化前端加载外部资源（2026-10-21 用户需求）：翻转即时生效——iframe
      // 每次构建 srcDoc 都从 bootstrap.state 读取，无需写穿缓存。
      ...(typeof body.frontendAllowExternalResources === 'boolean'
        ? { frontendAllowExternalResources: body.frontendAllowExternalResources }
        : {}),
      // 禁用游戏投降（2026-10-14 用户需求）：翻转即时生效——服务层在两个动作
      // 入口（人类棋盘 / Agent game_move）逐次读取判定，无缓存需写穿。
      ...(typeof body.gamesDisableResign === 'boolean'
        ? { gamesDisableResign: body.gamesDisableResign }
        : {}),
      // 写卡工作台/AgentNovel 的预设投影开关（preset-mount.ts）：翻转即写穿
      // 两个 bundle 的投影缓存，下一次装配即时生效。
      ...(typeof body.cardWorkbenchPresetEnabled === 'boolean'
        ? { cardWorkbenchPresetEnabled: body.cardWorkbenchPresetEnabled }
        : {}),
      ...(typeof body.agentNovelPresetEnabled === 'boolean'
        ? { agentNovelPresetEnabled: body.agentNovelPresetEnabled }
        : {}),
      ...(typeof body.worldFollowsCharacter === 'boolean'
        ? { worldFollowsCharacter: body.worldFollowsCharacter }
        : {}),
      ...(body.compaction !== undefined ? { compaction: compactionOverrideOf(body.compaction) } : {}),
    }
    const state = await db.patchState(patch)
    // 激活预设/persona 是 AgentTavern 预设投影的输入（agent-tavern/preset.ts）：
    // {{user}} 宏与预设选择变化后写穿各会话的投影缓存，下一次装配即时生效。
    // 两个投影开关同批写穿（preset-mount.ts 的监听在同一注册表里）。
    if ('activePreset' in patch || 'activePersona' in patch
      || 'cardWorkbenchPresetEnabled' in patch || 'agentNovelPresetEnabled' in patch) await emitAgentPresetChanged()
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
    await emitAssetsSaved('character', result.card.data.name)
    // 原版快照（提案 0013 P1）：导入成功后 best-effort 一次性保留原版；已存在
    // 不覆盖，失败只记警告不阻断导入——导入语义优先，快照是增值保障。
    try {
      await saveOriginalSnapshot(tavernDataRoot(), result.card.data.name, result.card)
    } catch (error) {
      console.warn(`dsh-soulmojito: original snapshot for '${result.card.data.name}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const current = await db.getState()
    if (!current.activeCharacter) {
      // 首个导入的角色成为活跃角色。绑定世界书不写 activeWorlds：它跟随角色卡
      // 的会话自动生效，手动激活列表保持用户自己的选择。
      await db.patchState({ activeCharacter: result.card.data.name })
    }
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, name: result.card.data.name, card: publicCard(result.card), world: result.importedWorld ?? null, importedRegex: result.importedRegex })
  }

  if (method === 'POST' && route === 'import/world') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || !body.data || typeof body.data !== 'object') throw new Error('expected { name, data }')
    const book = await db.importWorldFile(body.name, body.data)
    await emitAssetsSaved('world', book.name)
    return sendJson(res, 200, { ok: true, name: book.name, entries: book.entries.length })
  }

  if (method === 'POST' && route === 'import/preset') {
    const body = await readJson(req)
    if (typeof body.name !== 'string' || !body.data || typeof body.data !== 'object') throw new Error('expected { name, data }')
    parsePresetOrThrow(body.data)
    // 预设内嵌 extensions.regex_scripts（ST preset-scoped regex）随导入物化为
    // 全局脚本；非法脚本不阻断预设落盘，只在回执里如实给出导入条数。
    const result = await db.importPreset(body.name, body.data)
    await emitAssetsSaved('preset', body.name)
    // 同名的激活预设被覆盖时 AgentTavern 投影必须跟着变（写穿，best-effort）。
    await emitAgentPresetChanged()
    return sendJson(res, 200, { ok: true, name: body.name, kind: detectPresetKind(body.data), importedRegex: result.importedRegex })
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
    await emitAssetsSaved('preset', body.name)
    if (body.name !== oldName) await db.deletePreset(oldName)
    const state = await db.updateState((current) => ({
      activePreset: current.activePreset === oldName ? body.name : current.activePreset,
      ...(body.name !== oldName && current.regexScriptPresetOwners !== undefined
        ? {
            regexScriptPresetOwners: Object.fromEntries(Object.entries(current.regexScriptPresetOwners)
              .map(([id, owner]) => [id, owner === oldName ? body.name : owner])),
          }
        : {}),
    }))
    // 内容或名字变化都要写穿 AgentTavern 投影缓存（激活预设可能是这个）。
    await emitAgentPresetChanged()
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, name: body.name, kind: detectPresetKind(body.data), data: body.data, state })
  }

  if (method === 'POST' && route === 'import/persona') {
    const body = await readJson(req, 25 * 1024 * 1024)
    if (typeof body.pngBase64 === 'string' && typeof body.name === 'string') {
      const persona = await db.importPersonaPng(new Uint8Array(Buffer.from(body.pngBase64, 'base64')), body.name)
      await emitAssetsSaved('persona', persona.name)
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
      await emitAssetsSaved('persona', persona.name)
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
    await emitAssetsSaved('persona', body.name)
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
    if (avatar === undefined) {
      // persona 存在但没有头像 PNG（如 prompt 新建的 persona）：默认替代头像；
      // persona 本身不存在仍然 404，与 character 路由的语义对齐。
      const persona = await db.getPersona(name)
      if (persona) return sendAvatarFallback(res, name)
      return sendJson(res, 404, { ok: false, message: 'persona avatar not found' })
    }
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
    await emitAssetsSaved('group', body.name)
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
    await emitAssetsSaved('group', body.name)
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
    // 提案 0012/0013 P3：转 MVU 的卡（card_apply_mvu 写入的
    // extensions.agentTavern.initialVariables）给新聊天播种初始变量——深拷贝
    // 进 chat.header.chat_metadata.variables（与 0008 模板变量的 local 作用域
    // 同位，改聊天变量不回写卡）；缺省/非非空对象时不写键。
    const seedVariables = (() => {
      const holder = found.card.data.extensions.agentTavern
      if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) return undefined
      const initial = (holder as Record<string, unknown>).initialVariables
      if (typeof initial !== 'object' || initial === null || Array.isArray(initial)
        || Object.keys(initial).length === 0) return undefined
      return structuredClone(initial)
    })()
    // JSR MVU 卡（MagVarUpdate / <UpdateVariable> / StatusPlaceHolder）需要
    // `initialized_lorebooks` 与创角前 stat_data；Agent 模式没有酒馆助手脚本
    // 树替它播种，新聊天在创建时补上。已有 agentTavern.initialVariables 的卡
    // 保留自己的 stat_data，不覆盖。
    const variablesSeed = seedVariables ?? {}
    const mvuSeeded = seedJsrMvuVariables(found.card, variablesSeed)
    const greetings = [found.card.data.firstMes, ...found.card.data.alternateGreetings]
    // Greeting choice at chat creation: AgentTavern imports the first message
    // into the host session, so an alternate greeting can never be picked with
    // the ST swipe UI afterwards. The chosen index (default 0) becomes the
    // opening message and the initial swipe position.
    const greetingIndex = body.greetingIndex === undefined ? 0 : body.greetingIndex
    if (!Number.isSafeInteger(greetingIndex) || greetingIndex < 0 || greetingIndex >= greetings.length) {
      throw new Error(`greetingIndex must be an integer in [0, ${greetings.length - 1}]`)
    }
    const id = await db.createChat(character, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { character, createdAt: now, timedWorldInfo: {}, ...(seedVariables !== undefined || mvuSeeded ? { variables: variablesSeed } : {}) },
    }, [{
      name: found.card.data.nickname || found.card.data.name,
      is_user: false, is_system: false, send_date: now,
      mes: greetings[greetingIndex],
      swipe_id: greetingIndex,
      swipes: greetings,
      swipe_info: greetings.map(() => ({ send_date: now })),
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

  // 试写预览（D-4 生成不入楼，2026-10-11）：真实装配 + 单次 LLM 生成，但零副作用
  // ——不落楼、无 MVU 结算/回执、无 chat-saved/stream-delta 事件、五相位 hook 全部
  // 不跑、无 DSH session 镜像。卡片工作台排错/试写专用入口。
  if (method === 'POST' && route === 'preview') {
    return previewGeneration(ctx, req, res, db)
  }

  // MVU 结算重试（提案 0012 P1）：只对最后一条助手楼层重跑模板输出渲染的变量
  // 写穿部分（不重跑 AI_OUTPUT regex——非幂等），正文不动；CAS 冲突走既有通道。
  // MVU 状态（提案 0012 P1）：变量 + 回执快照；卡片约定字段
  // data.extensions.agentTavern.statusTemplate（0013 工作台产出）存在时附带
  // 模板化 renderedHtml（接线点）；渲染失败降级为不返回该字段，不 500。
  // 变量源按绑定架构取：AgentTavern 聊天的权威源是 chat 作用域 VariableStore
  // （variable_set/patch/delete 与 tavern_variable_settle 全族都写那里，从不写
  // chat_metadata.variables），扁平点分名覆盖回嵌套树后与 ST 共用同一份显示与
  // 模板语义；ST 绑定或未绑定的聊天不回读，避免架构切换后的残留值污染 ST 变量。
  if ((method === 'POST' && (route === 'mvu/retry' || route === 'mvu/receipts/undo')) || (method === 'GET' && route.startsWith('mvu/status/'))) {
    return handleMvuApi(req, res, route, method, db)
  }

  // ---- 工作台方案确认协议（提案 0013 P2；世界书面板化同构扩展）----
  // 写卡会话改名（对齐酒馆聊天的侧边栏改名能力）：title 写进 card-workbench
  // 绑定——它是侧边栏分组与复用判定的数据源，客户端改名成功后另经宿主
  // binding.session.rename 同步会话标题（best-effort）。只收 card-workbench
  // 绑定，空 title / 非 workbench 会话 fail-closed。错误码 TAVERN_WORKBENCH。
  // 方案 = card_plan_propose / world_plan_propose 落库的 pending 计划
  // （<tavern>/card-workbench/plans/，见 card-workbench/plans.ts，kind 判别）。
  // 面板拉列表看 diff、给决定；approve=true 经执行核（executeCardPlan /
  // executeWorldPlan）按方案写入并标记 applied（执行不在存储层），false 只改
  // 状态。错误码 TAVERN_WORKBENCH。
  if ((method === 'POST' && route === 'card-workbench/rename')
    || (method === 'GET' && route === 'card-workbench/plans')
    || (method === 'POST' && route.startsWith('card-workbench/plans/') && route.endsWith('/decision'))) {
    return handleWorkbenchApi(req, res, url, route, method, db)
  }

  // 记忆语义检索 embed 端点管理面（提案 0016）：GET/PUT 设置 + 连通性探针。
  if ((method === 'GET' || method === 'PUT') && route === 'memory/embed') {
    return handleMemoryEmbedApi(req, res, route, method, db)
  }
  if (method === 'POST' && route === 'memory/embed/test') {
    return handleMemoryEmbedApi(req, res, route, method, db)
  }

  if (method === 'POST' && route === 'memory/embed/local/install') {
    return handleMemoryEmbedApi(req, res, route, method, db)
  }

  // 本地模型量化精度识别（2026-10-13）：面板在 modelDir 输入后调用，返回目录里
  // 实际可加载的精度档位（含文件与大小）与 auto 推荐档，供下拉框选项。
  if (method === 'POST' && route === 'memory/embed/local/quantizations') {
    return handleMemoryEmbedApi(req, res, route, method, db)
  }

  // B-3 记忆维护 run（wait:false 风格）：POST 启动（同 scope 单飞 409），GET 轮询。
  if ((method === 'POST' || method === 'GET') && route === 'memory/maintenance') {
    return handleMemoryMaintenanceApi(ctx, req, res, url, route, method, db)
  }

  // 提示词查看器（A-6）：ST 生成循环实发请求的只读查询。可选过滤（character /
  // chatId 任一或组合），缺省全量按时间倒序；记录是进程内环形缓冲（每聊天 10
  // 条 / 总量 50，重启即失），无记录时空数组——不因缓冲为空 500。
  if (method === 'GET' && route === 'prompts') {
    const filterCharacter = url.searchParams.get('character')
    const filterChat = url.searchParams.get('chatId')
    return sendJson(res, 200, {
      ok: true,
      records: listPromptViews({
        ...(filterCharacter !== null ? { character: filterCharacter } : {}),
        ...(filterChat !== null ? { chatId: filterChat } : {}),
      }),
    })
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
    await emitAssetsSaved('world', book.name)
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
    // 删除激活预设会回落内置默认预设：AgentTavern 投影同样要写穿。
    await emitAgentPresetChanged()
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
    await db.ensureRegexScriptOwners()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  if (method === 'PUT' && route === 'regex') {
    await db.ensureRegexScriptOwners()
    const body = await readJson(req)
    const scripts = Array.isArray(body.scripts) ? parseRegexScripts(body.scripts) : undefined
    if (scripts === undefined) throw new Error('expected { scripts }')
    const state = await db.replaceRegexScripts(scripts)
    return sendJson(res, 200, {
      ok: true,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  if (method === 'POST' && route === 'import/regex') {
    await db.ensureRegexScriptOwners()
    const body = await readJson(req)
    if (!Array.isArray(body.data) && typeof body.data !== 'object') throw new Error('expected { data }')
    const imported = await db.importRegexScripts(body.data)
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      imported,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // 存量卡回填：导入时自动物化只覆盖此后导入的卡，旧卡需显式同步一次。
  if (method === 'POST' && route === 'regex/sync-cards') {
    await db.ensureRegexScriptOwners()
    const result = await db.backfillRegexScriptsFromCharacters()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      ...result,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // 存量预设回填：预设内嵌 regex 的导入期物化同样只覆盖此后导入的预设。
  if (method === 'POST' && route === 'regex/sync-presets') {
    await db.ensureRegexScriptOwners()
    const result = await db.backfillRegexScriptsFromPresets()
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      ...result,
      scripts: state.regexScripts,
      regexScriptOwners: state.regexScriptOwners ?? {},
      regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
    })
  }

  // 酒馆助手兼容面（2026-10-20）：美化前端 iframe 经 token 校验的 postMessage
  // RPC 转发到这里。沙箱不放宽（无 same-origin、CSP connect-src 'none'），
  // 能力在宿主侧代理；character/chatId 由客户端按自身会话绑定注入，iframe
  // 无法寻址别的聊天。
  if (method === 'POST' && route === 'helper') {
    return handleHelperApi(req, res, db)
  }

  // 卡脚本右栏（2026-10-21）：JSR 卡的常驻脚本树在
  // `data.extensions.tavern_helper.scripts`。插件仍不自动执行脚本树；这里只
  // 供「卡脚本」tab 列出启用的脚本，用户点「运行」后才在沙箱 iframe 里跑一份。
  // 带 chatId 时优先会话脚本树副本（GM 面板持久化的 Zod 源码）。
  if (method === 'GET' && route === 'card/scripts') {
    const character = url.searchParams.get('character')
    if (!character) throw new Error('character query is required')
    const chatId = url.searchParams.get('chatId')
    const file = await db.getCharacter(character)
    if (!file) return sendJson(res, 404, { ok: false, message: `character '${character}' not found` })
    const scriptTrees = chatId === null ? undefined : await db.getChatScripts(character, chatId)
    const { world, scripts } = collectCardScriptBundle(file.card, scriptTrees)
    return sendJson(res, 200, { ok: true, character, world, scripts })
  }

  // 虚拟 IndexedDB 的二进制数据面（2026-10-22）：控制面走 helper JSON，
  // 记录体走这里。只由宿主页（已绑定会话）调用；iframe 不能直接访问该路由。
  if (method === 'GET' && route === 'frontend/idb/get') {
    const character = url.searchParams.get('character')
    if (!character) throw new Error('character query is required')
    const record = await getIdbRecord(
      tavernDataRoot(),
      character,
      url.searchParams.get('db'),
      url.searchParams.get('store'),
      url.searchParams.get('key'),
    )
    // A miss is not an error: IndexedDB's get() fires onsuccess with result
    // undefined. A 404 here becomes an exception in the shim, which cards that
    // treat any IndexedDB failure as a corrupt cache surface to the user.
    if (record === undefined) {
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-length', String(record.size))
    res.setHeader('x-dsh-idb-meta', Buffer.from(JSON.stringify(record.meta), 'utf8').toString('base64url'))
    await pipeline(createReadStream(record.path), res)
    return
  }

  if (method === 'POST' && route === 'frontend/idb/put') {
    const character = url.searchParams.get('character')
    if (!character) throw new Error('character query is required')
    const dbName = url.searchParams.get('db')
    const storeName = url.searchParams.get('store')
    const key = url.searchParams.get('key')
    if (dbName === null || storeName === null || key === null) {
      throw new Error('db, store and key queries are required')
    }
    const declared = Number(req.headers?.['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > IDB_MAX_RECORD_BYTES) {
      req.destroy?.()
      throw new Error(`idb record is too large (${declared} > ${IDB_MAX_RECORD_BYTES} bytes)`)
    }
    const temporaryDir = await mkdtemp(join(tmpdir(), 'dsh-soulmojito-idb-'))
    const temporaryPath = join(temporaryDir, 'record.bin')
    try {
      await pipeline(req, createWriteStream(temporaryPath))
      const metaHeader = typeof req.headers?.['x-dsh-idb-meta'] === 'string' ? req.headers['x-dsh-idb-meta'] : ''
      let meta: Record<string, unknown> = {}
      if (metaHeader !== '') {
        try {
          const parsed = JSON.parse(Buffer.from(metaHeader, 'base64url').toString('utf8')) as unknown
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>
          else throw new Error('meta must be an object')
        } catch (error) {
          throw new Error(`x-dsh-idb-meta is not valid base64url JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const result = await putIdbRecordFromFile(tavernDataRoot(), character, dbName, storeName, key, temporaryPath, meta)
      return sendJson(res, 200, { ok: true, value: result })
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  }

  // 美化前端 localStorage 的初始播种（2026-10-22）：沙箱 iframe 的 localStorage
  // 是内存实现，FrontendFrame 在构建 srcdoc 之前先取本角色的持久表，同步注入
  // 到 shim；写入仍走 helper 的 storage.set。只读、按角色隔离。
  if (method === 'GET' && route === 'frontend/storage') {
    const character = url.searchParams.get('character')
    if (!character) throw new Error('character query is required')
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      storage: state.frontendStorage?.[character] ?? {},
    })
  }

  // 美化前端（AgentTavern 右栏展示面，2026-10-20）：native conversation 由宿主
  // 渲染，消息里的完整 HTML 没有插件正文 slot。右栏 tab 只取「最新一条带完整
  // HTML 的楼层」——面板按 5s 轮询，回传整份聊天在长聊天上会是 MB 级；这里在
  // 服务端完成抽取，只传文档本身。displayTexts 与内联 transcript 同一展示层
  // （markdownOnly regex 脚本），不另造一套文本。
  if (method === 'GET' && route === 'frontend/latest') {
    const state = await db.getState()
    const character = url.searchParams.get('character') || state.activeCharacter
    const chatId = url.searchParams.get('chatId')
    if (!character) throw new Error('no active character')
    if (!chatId) throw new Error('chatId query is required')
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    // 只从最新楼层向前渲染到第一条带完整文档的楼层：长篇聊天里对全部楼层
    // 重跑 markdownOnly 正则会把 5s 轮询变成 CPU 热点。
    const scripts = collectRegexScripts(state, await db.getCharacter(character))
    const message = latestFrontendMessage(snapshot.chat.messages, (entry, index) =>
      displayTextForMessage(scripts, entry, snapshot.chat.messages.length - 1 - index))
    return sendJson(res, 200, {
      ok: true,
      revision: snapshot.revision,
      messageCount: snapshot.chat.messages.length,
      ...(message === undefined ? {} : { message }),
    })
  }

  // One projected message's display text (AgentTavern native conversation
  // cannot render the plugin transcript). The projector stores the save-layer
  // text in the JSONL under extra.agentTavern.messageId; this lookup applies
  // markdownOnly scripts on top so the native assistant row matches the ST
  // display layer without transferring the whole chat.
  if (method === 'GET' && route === 'display') {
    const character = url.searchParams.get('character')
    const chatId = url.searchParams.get('chatId')
    const messageId = url.searchParams.get('messageId')
    if (!character || !chatId || !messageId) throw new Error('character, chatId and messageId are required')
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    const index = snapshot.chat.messages.findIndex((message) => {
      const extra = message.extra?.agentTavern
      return typeof extra === 'object' && extra !== null && (extra as Record<string, unknown>).messageId === messageId
    })
    if (index < 0) return sendJson(res, 200, { ok: true, text: null })
    const state = await db.getState()
    const card = await db.getCharacter(character)
    const scripts = collectRegexScripts(state, card)
    return sendJson(res, 200, {
      ok: true,
      text: stripFrontendDocuments(displayTextForMessage(scripts, snapshot.chat.messages[index]!, snapshot.chat.messages.length - 1 - index)),
    })
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
      await emitChatSaved(character, chatId, revision, body.chat.messages.length)
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
