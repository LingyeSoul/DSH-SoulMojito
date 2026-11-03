// World-book and preset asset routes lifted out of `handleApi`: world read/
// update/export/delete and the preset delete/export pair.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { emitAssetsSaved } from '../mods/events.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asRecord } from './json-records.js'

export async function handleWorldReadRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
  const name = decodeURIComponent(route.slice('world/'.length))
  const book = await db.getWorld(name)
  if (!book) return sendJson(res, 404, { ok: false, message: 'world not found' })
  return sendJson(res, 200, { ok: true, book })
}

export async function handleWorldUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
): Promise<void> {
  const oldName = decodeURIComponent(route.slice('world/'.length))
  const body = await readJson(req, 10 * 1024 * 1024)
  const data = asRecord(body.data)
  if (typeof body.name !== 'string' || body.name.trim() === '' || data === undefined) {
    throw new Error('expected { name, data }')
  }
  const name = body.name
  const book = await db.importWorldFile(name, data)
  await emitAssetsSaved('world', book.name)
  if (name !== oldName) {
    await db.deleteWorld(oldName)
    await db.updateState((current) => ({ activeWorlds: current.activeWorlds.map((item) => item === oldName ? name : item) }))
  }
  return sendJson(res, 200, { ok: true, name: book.name, book })
}

export async function handleWorldExportRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
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

export async function handleWorldDeleteRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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

export async function handlePresetDeleteRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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

export async function handlePresetExportRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
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
