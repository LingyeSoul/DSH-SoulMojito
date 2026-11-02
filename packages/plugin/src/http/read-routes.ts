// Read-only panel bootstrap: the light state snapshot, the change watermark and
// the heavy state slices. The watermark is read before the asset lists in
// bootstrap on purpose (see the inline comment), and `state-slices` carries the
// data bootstrap deliberately leaves out.

import { detectPresetKind } from '../../../tavern-format/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { BUILD_INFO, TAVERN_COMMIT } from '../build-info.js'
import type { PluginContext } from '../host-contract.js'
import { publicCard, publicGroup } from '../model-catalog.js'
import { modsDisabledByEnv } from '../mods/host.js'
import {
  getAgentNovelCapabilities,
  getAgentTavernCapabilities,
  getAgentTavernCapabilitiesPromise,
  modHostProjection,
  tavernUpdate,
} from '../runtime.js'
import { prepareInternalWorkspace, prepareWorkbenchWorkspace } from '../workspace.js'
import { sendJson, type HttpResponse } from './io.js'
import { collectWorldEntryCounts } from './world-entry-counts.js'

export async function handleBootstrapApi(ctx: PluginContext, res: HttpResponse, db: TavernStore): Promise<void> {
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
  const presetKinds: Record<string, string> = {}
  for (const name of await db.listPresets()) {
    const preset = await db.getPreset(name)
    if (preset) presetKinds[name] = detectPresetKind(preset)
  }
  // 世界书条目数投影：面板列表不点开书也显示真实条目数（书本内容仍按浏览/
  // 编辑懒加载）。与 presetKinds 同款服务端轻量投影；单本损坏只缺数不断路，
  // bootstrap 不因坏书 500，点开该书仍走既有 fetch 错误路径。
  // 进程内缓存按（数据根, 书名）和文件 size/mtime 命中，刷新只重读改过的书。
  const worlds = await db.listWorlds()
  const worldEntryCounts = await collectWorldEntryCounts(db, db.rootPath)
  // Heavy state slices never ride bootstrap (measured 2026-11-02: a 2.2 MB
  // regex table was 71% of a 2.55 MB response, and the panel opened far more
  // often than the regex editor did). `frontendStorage` is not read from
  // bootstrap at all — the client fetches it per character through
  // `frontend/storage`. The client pulls the regex table from `state-slices`
  // when that section first mounts.
  const {
    regexScripts: _bootstrapRegexScripts,
    regexScriptOwners: _bootstrapRegexScriptOwners,
    regexScriptPresetOwners: _bootstrapRegexScriptPresetOwners,
    frontendStorage: _bootstrapFrontendStorage,
    ...lightState
  } = state
  return sendJson(res, 200, {
    ok: true,
    storeRevision,
    state: lightState,
    stateSlices: ['regexScripts'],
    characters: await db.listCharacters(),
    worlds,
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
export async function handleStoreRevisionApi(res: HttpResponse, db: TavernStore): Promise<void> {
  return sendJson(res, 200, { ok: true, revision: await db.storeRevision() })
}

// Heavy state slices the panel loads on demand (see the bootstrap comment):
// the regex table and its ownership maps. Kept separate so opening the panel
// does not parse a multi-megabyte script library nobody is looking at.
export async function handleStateSlicesApi(res: HttpResponse, db: TavernStore): Promise<void> {
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    regexScripts: state.regexScripts,
    ...(state.regexScriptOwners === undefined ? {} : { regexScriptOwners: state.regexScriptOwners }),
    ...(state.regexScriptPresetOwners === undefined ? {} : { regexScriptPresetOwners: state.regexScriptPresetOwners }),
  })
}
