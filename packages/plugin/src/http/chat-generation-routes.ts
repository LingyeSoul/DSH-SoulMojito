// Chat persistence and generation entry points lifted out of `handleApi`.
// `chat/<id>` is the panel's revision-CAS read/write surface; `generate` and
// `script` start the generation pipeline and the card script runner.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { generate, runTavernScript } from '../generation/pipeline.js'
import type { PluginContext } from '../host-contract.js'
import { emitChatSaved } from '../mods/events.js'
import { displayTexts } from '../prompt-context.js'
import { normalizeChatId } from '../session/trace.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asChatLog } from './json-records.js'

export async function handleChatRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  const chatId = decodeURIComponent(route.slice('chat/'.length))
  const state = await db.getState()
  const character = url.searchParams.get('character') || state.activeCharacter
  if (!character) throw new Error('no active character')
  if (method === 'GET') {
    const snapshot = await db.getChatSnapshot(character, chatId)
    return snapshot
      ? sendJson(res, 200, { ok: true, chat: snapshot.chat, revision: snapshot.revision, displays: await displayTexts(db, state, character, chatId, snapshot.chat) })
      : sendJson(res, 404, { ok: false, message: 'chat not found' })
  }
  if (method === 'PUT') {
    const body = await readJson(req)
    const chat = asChatLog(body.chat)
    if (chat === undefined || typeof body.revision !== 'string') {
      throw new Error('expected { chat, revision }')
    }
    const revision = await db.saveChat(character, chatId, chat, body.revision)
    await emitChatSaved(character, chatId, revision, chat.messages.length)
    return sendJson(res, 200, { ok: true, chat, revision })
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
          ? { ...binding, character, chatId: nextChatId }
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
  // No later branch matches a `chat/` route, so the renderer's 404 is the same
  // one the old if-chain reached after falling out of the block.
  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

export async function handleGenerateRoute(
  ctx: PluginContext,
  req: HttpRequest,
  res: HttpResponse,
  db: TavernStore,
): Promise<void> {
  return generate(ctx, req, res, db)
}

export async function handleScriptRoute(
  ctx: PluginContext,
  req: HttpRequest,
  res: HttpResponse,
  db: TavernStore,
): Promise<void> {
  return runTavernScript(ctx, req, res, db)
}
