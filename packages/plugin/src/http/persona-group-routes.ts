// Persona and group routes lifted out of `handleApi`: persona import/update/
// delete plus its avatar, and the group list/create/update/delete surface.
// The write handlers emit the matching asset-saved events.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { sendAvatarFallback } from '../assets.js'
import { publicGroup } from '../model-catalog.js'
import { emitAssetsSaved } from '../mods/events.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

export async function handlePersonaImportRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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

export async function handlePersonaUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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

export async function handlePersonaDeleteRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const name = url.searchParams.get('name')
  if (!name) throw new Error('name query is required')
  const deleted = await db.deletePersona(name)
  const state = await db.updateState((current) => ({
    activePersona: current.activePersona === name ? undefined : current.activePersona,
  }))
  if (!deleted) return sendJson(res, 404, { ok: false, message: 'persona not found' })
  return sendJson(res, 200, { ok: true, state })
}

export async function handlePersonaAvatarRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
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

export async function handleGroupsListRoute(
  db: TavernStore,
  res: HttpResponse,
): Promise<void> {
  const groups = []
  for (const name of await db.listGroups()) {
    const group = await db.getGroup(name)
    if (group) groups.push(publicGroup(group))
  }
  return sendJson(res, 200, { ok: true, groups })
}

export async function handleGroupCreateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
  if (group === undefined) throw new Error(`group '${body.name}' was not saved`)
  return sendJson(res, 200, { ok: true, group: publicGroup(group) })
}

export async function handleGroupUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
  const savedGroup = await db.getGroup(body.name)
  if (savedGroup === undefined) throw new Error(`group '${body.name}' was not saved`)
  return sendJson(res, 200, { ok: true, group: publicGroup(savedGroup) })
}

export async function handleGroupDeleteRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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
