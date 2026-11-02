// Asset import and preset write routes lifted out of `handleApi`: character,
// world and preset import, plus the preset read/update pair. Each write owns
// its asset-saved event and the matching active-state follow-up.

import { detectPresetKind } from '../../../tavern-format/src/index.js'
import { saveOriginalSnapshot, type TavernStore } from '../../../tavern-store/src/index.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { tavernDataRoot } from '../dsh-home.js'
import { publicCard, refreshActivePrompt } from '../model-catalog.js'
import { emitAssetsSaved } from '../mods/events.js'
import { parsePresetOrThrow } from '../prompt-context.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asRecord } from './json-records.js'

export async function handleCharacterImportRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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

export async function handleWorldImportRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  const data = asRecord(body.data)
  if (typeof body.name !== 'string' || data === undefined) throw new Error('expected { name, data }')
  const book = await db.importWorldFile(body.name, data)
  await emitAssetsSaved('world', book.name)
  return sendJson(res, 200, { ok: true, name: book.name, entries: book.entries.length })
}

export async function handlePresetImportRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  const data = asRecord(body.data)
  if (typeof body.name !== 'string' || data === undefined) throw new Error('expected { name, data }')
  parsePresetOrThrow(data)
  // 预设内嵌 extensions.regex_scripts（ST preset-scoped regex）随导入物化为
  // 全局脚本；非法脚本不阻断预设落盘，只在回执里如实给出导入条数。
  const result = await db.importPreset(body.name, data)
  await emitAssetsSaved('preset', body.name)
  // 同名的激活预设被覆盖时 AgentTavern 投影必须跟着变（写穿，best-effort）。
  await emitAgentPresetChanged()
  return sendJson(res, 200, { ok: true, name: body.name, kind: detectPresetKind(data), importedRegex: result.importedRegex })
}

export async function handlePresetReadRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
  const name = decodeURIComponent(route.slice('preset/'.length))
  const data = await db.getPreset(name)
  if (!data) return sendJson(res, 404, { ok: false, message: 'preset not found' })
  return sendJson(res, 200, { ok: true, name, kind: detectPresetKind(data), data })
}

export async function handlePresetUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
): Promise<void> {
  const oldName = decodeURIComponent(route.slice('preset/'.length))
  const body = await readJson(req, 10 * 1024 * 1024)
  const data = asRecord(body.data)
  if (typeof body.name !== 'string' || body.name.trim() === '' || data === undefined) {
    throw new Error('expected { name, data }')
  }
  const name = body.name
  parsePresetOrThrow(data)
  await db.putPreset(name, data)
  await emitAssetsSaved('preset', name)
  if (name !== oldName) await db.deletePreset(oldName)
  const state = await db.updateState((current) => ({
    activePreset: current.activePreset === oldName ? name : current.activePreset,
    ...(name !== oldName && current.regexScriptPresetOwners !== undefined
      ? {
          regexScriptPresetOwners: Object.fromEntries(Object.entries(current.regexScriptPresetOwners)
            .map(([id, owner]) => [id, owner === oldName ? name : owner])),
        }
      : {}),
  }))
  // 内容或名字变化都要写穿 AgentTavern 投影缓存（激活预设可能是这个）。
  await emitAgentPresetChanged()
  await refreshActivePrompt()
  return sendJson(res, 200, { ok: true, name, kind: detectPresetKind(data), data, state })
}
