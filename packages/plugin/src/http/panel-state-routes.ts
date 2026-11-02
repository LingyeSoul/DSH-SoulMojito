// Panel model-catalog and state routes lifted out of `handleApi`: the model
// list, one session's model selection, and the bulk state patch that drives the
// panel settings surface.

import type { TavernModelSelection, TavernStore } from '../../../tavern-store/src/index.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import type { PluginContext } from '../host-contract.js'
import { buildModelCatalog, refreshActivePrompt } from '../model-catalog.js'
import { compactionOverrideOf } from '../prompt-context.js'
import { activeCharacterPatch } from '../session/active-character.js'
import { assertAgentTavernAvailable } from '../session/binding.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asRecord } from './json-records.js'

export async function handleModelsRoute(
  ctx: PluginContext,
  res: HttpResponse,
): Promise<void> {
  return sendJson(res, 200, { ok: true, ...await buildModelCatalog(ctx) })
}

export async function handleModelSelectionRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  if (typeof body.sessionId !== 'string') throw new Error('expected { sessionId, selection }')
  const sessionId = body.sessionId
  let selection: TavernModelSelection | null = null
  const selectionBody = asRecord(body.selection)
  if (selectionBody !== undefined) {
    if (typeof selectionBody['provider'] !== 'string' || typeof selectionBody['model'] !== 'string') {
      throw new Error('selection must be { provider, model, reasoningEffort? }')
    }
    selection = {
      provider: selectionBody['provider'],
      model: selectionBody['model'],
      ...(typeof selectionBody['reasoningEffort'] === 'string' ? { reasoningEffort: selectionBody['reasoningEffort'] } : {}),
    }
  }
  const state = await db.updateState((current) => ({
    modelSelections: selection === null
      ? Object.fromEntries(Object.entries(current.modelSelections ?? {}).filter(([id]) => id !== sessionId))
      : { ...(current.modelSelections ?? {}), [sessionId]: selection },
  }))
  return sendJson(res, 200, { ok: true, state })
}

export async function handleStateUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
  // 例外（2026-10-23 识别修复）：切换角色时清掉上一张卡链接书残留的手动条目，
  // 否则换卡后面板仍把旧书显示成启用（旧版本自动写入的污染）。
  const switchingActiveCharacter = typeof body.activeCharacter === 'string' || body.activeCharacter === null
  const requestedActiveCharacter = typeof body.activeCharacter === 'string'
    ? (body.activeCharacter || undefined)
    : undefined
  let requestedActiveWorlds = Array.isArray(body.activeWorlds)
    ? body.activeWorlds.filter((x) => typeof x === 'string')
    : undefined
  if (switchingActiveCharacter && requestedActiveWorlds === undefined) {
    const current = await db.getState()
    const switched = await activeCharacterPatch(db, current, requestedActiveCharacter)
    requestedActiveWorlds = switched.activeWorlds
  }
  const requestedDefaultArchitecture: 'agent-tavern' | 'st' | undefined = body.defaultArchitecture === 'agent-tavern' || body.defaultArchitecture === 'st'
    ? body.defaultArchitecture
    : undefined
  const requestedDefaultContextMode: 'dsh-native' | 'agent-managed' | undefined = body.defaultContextMode === 'dsh-native' || body.defaultContextMode === 'agent-managed'
    ? body.defaultContextMode
    : undefined
  const patch = {
    ...(switchingActiveCharacter ? { activeCharacter: requestedActiveCharacter } : {}),
    ...(requestedActiveWorlds !== undefined ? { activeWorlds: requestedActiveWorlds } : {}),
    ...(Array.isArray(body.disabledAutoWorlds)
      ? { disabledAutoWorlds: body.disabledAutoWorlds.filter((x) => typeof x === 'string') }
      : {}),
    ...(typeof body.activePreset === 'string' || body.activePreset === null ? { activePreset: body.activePreset || undefined } : {}),
    ...(typeof body.activePersona === 'string' || body.activePersona === null ? { activePersona: body.activePersona || undefined } : {}),
    ...(typeof body.nativeAgentPersona === 'boolean' ? { nativeAgentPersona: body.nativeAgentPersona } : {}),
    // 标准 DSH Agent 会话的预设投影开关（native-preset.ts）：翻转即写穿投影
    // 缓存，下一次装配即时生效。
    ...(typeof body.nativeAgentPreset === 'boolean' ? { nativeAgentPreset: body.nativeAgentPreset } : {}),
    ...(requestedDefaultArchitecture !== undefined ? { defaultArchitecture: requestedDefaultArchitecture } : {}),
    ...(requestedDefaultContextMode !== undefined ? { defaultContextMode: requestedDefaultContextMode } : {}),
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
    || 'cardWorkbenchPresetEnabled' in patch || 'agentNovelPresetEnabled' in patch
    || 'nativeAgentPreset' in patch) await emitAgentPresetChanged()
  await refreshActivePrompt()
  return sendJson(res, 200, { ok: true, state })
}
