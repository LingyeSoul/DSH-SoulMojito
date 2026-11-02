// Character mutation and export routes lifted out of `handleApi`: `PUT
// character/<name>`, `DELETE character?name=` and `GET export/character/<name>`.
// They stay separate from the read route in `domain-routes.ts` because a write
// touches snapshots, bindings, chats, groups and the active prompt.

import {
  deleteOriginalSnapshot,
  moveOriginalSnapshot,
  type TavernStore,
} from '../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { clampIdentitySummary, publicCard, refreshActivePrompt } from '../model-catalog.js'
import { emitAssetsSaved } from '../mods/events.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

export async function handleCharacterUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
): Promise<void> {
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

export async function handleCharacterDeleteRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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

export async function handleCharacterExportRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
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
