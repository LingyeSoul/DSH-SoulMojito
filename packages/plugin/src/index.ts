import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeCharxAsset, parsePreset, parseCharacterBook } from '../../tavern-format/src/index.js'
import { activateWorldInfo } from '../../tavern-lore/src/index.js'
import { createMacroEngine } from '../../tavern-macros/src/index.js'
import { assemblePrompt } from '../../tavern-pipeline/src/index.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'

export const name = 'dsh-tavern'
export const inject = ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands']

const API = '/api/dsh-tavern'
const DEFAULT_USER = 'User'
let storePromise
let activeAgentPrompt = ''

function store() {
  return (storePromise ??= TavernStore.open(dshHomePath('tavern')))
}

export function apply(ctx) {
  void refreshActivePrompt()
  ctx.systemPrompt.section({
    name: 'dsh-tavern:active-character',
    order: 25,
    text: () => activeAgentPrompt,
  })

  ctx.commands.register({
    name: 'tavern',
    description: 'activate a Tavern roleplay chat in this session',
    input: { hint: '<character> <chat-id>' },
    recordInput: false,
    handler: async ({ agent, rawInput }) => {
      const parsed = parseTavernCommand(rawInput)
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
      const previous = (await db.getState()).sessionBindings[agent.id]
      await bindSession(db, agent.id, parsed.character, parsed.chatId)
      await refreshActivePrompt()
      if (previous?.character !== parsed.character || previous.chatId !== parsed.chatId) {
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
          const code = error instanceof ChatRevisionConflictError ? error.code : undefined
          if (res.headersSent) {
            res.write(JSON.stringify({ type: 'error', message, code }) + '\n')
            res.end()
          } else {
            sendJson(res, error instanceof ChatRevisionConflictError ? 409 : 500, { ok: false, message, code })
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
    const state = await db.getState()
    const active = state.activeCharacter ? await db.getCharacter(state.activeCharacter) : undefined
    return sendJson(res, 200, {
      ok: true,
      state,
      characters: await db.listCharacters(),
      worlds: await db.listWorlds(),
      presets: await db.listPresets(),
      personas: await db.listPersonas(),
      activeCard: active ? publicCard(active.card) : null,
      model: ctx.agentDefaultModel.currentSelection(),
    })
  }

  if (method === 'GET' && route.startsWith('avatar/')) {
    const characterName = decodeURIComponent(route.slice('avatar/'.length))
    const found = await db.getCharacter(characterName)
    if (!found) return sendJson(res, 404, { ok: false, message: 'character avatar not found' })
    let bytes
    let contentType = 'image/png'
    if (found.kind === 'png') {
      bytes = await db.exportCharacter(characterName)
    } else if (found.kind === 'charx') {
      const container = await db.exportCharacter(characterName)
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
    return
  }

  if (method === 'POST' && route === 'state') {
    const body = await readJson(req)
    const state = await db.patchState({
      ...(typeof body.activeCharacter === 'string' || body.activeCharacter === null ? { activeCharacter: body.activeCharacter || undefined } : {}),
      ...(Array.isArray(body.activeWorlds) ? { activeWorlds: body.activeWorlds.filter((x) => typeof x === 'string') } : {}),
      ...(typeof body.activePreset === 'string' || body.activePreset === null ? { activePreset: body.activePreset || undefined } : {}),
      ...(typeof body.activePersona === 'string' || body.activePersona === null ? { activePersona: body.activePersona || undefined } : {}),
      ...(typeof body.nativeAgentPersona === 'boolean' ? { nativeAgentPersona: body.nativeAgentPersona } : {}),
    })
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
    if (!current.activeCharacter) await db.patchState({ activeCharacter: result.card.data.name })
    await refreshActivePrompt()
    return sendJson(res, 200, { ok: true, name: result.card.data.name, card: publicCard(result.card) })
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
    parsePreset(body.data) // fail early on malformed structure
    await db.putPreset(body.name, body.data)
    return sendJson(res, 200, { ok: true, name: body.name })
  }

  if (method === 'POST' && route === 'binding') {
    const body = await readJson(req)
    if (typeof body.sessionId !== 'string' || typeof body.character !== 'string' || typeof body.chatId !== 'string') {
      throw new Error('expected { sessionId, character, chatId }')
    }
    const chat = await db.getChat(body.character, body.chatId)
    if (!chat) throw new Error('chat not found')
    const state = await bindSession(db, body.sessionId, body.character, body.chatId)
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
    const character = typeof body.character === 'string' ? body.character : (await db.getState()).activeCharacter
    if (!character) throw new Error('no active character')
    const found = await db.getCharacter(character)
    if (!found) throw new Error(`character '${character}' not found`)
    const id = await db.createChat(character, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { character, createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [{
      name: found.card.data.nickname || found.card.data.name,
      is_user: false, is_system: false, send_date: new Date().toISOString(),
      mes: found.card.data.firstMes,
      swipe_id: 0,
      swipes: [found.card.data.firstMes, ...found.card.data.alternateGreetings],
      swipe_info: [{ send_date: new Date().toISOString() }, ...found.card.data.alternateGreetings.map(() => ({ send_date: new Date().toISOString() }))],
    }])
    const snapshot = await db.getChatSnapshot(character, id)
    return sendJson(res, 200, { ok: true, id, chat: snapshot?.chat, revision: snapshot?.revision })
  }

  if (route.startsWith('chat/')) {
    const chatId = decodeURIComponent(route.slice('chat/'.length))
    const character = url.searchParams.get('character') || (await db.getState()).activeCharacter
    if (!character) throw new Error('no active character')
    if (method === 'GET') {
      const snapshot = await db.getChatSnapshot(character, chatId)
      return snapshot
        ? sendJson(res, 200, { ok: true, chat: snapshot.chat, revision: snapshot.revision })
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
            ? { character, chatId: nextChatId }
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

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

async function generate(ctx, req, res, db) {
  const body = await readJson(req)
  const state = await db.getState()
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  const userText = typeof body.message === 'string' ? body.message.trim() : ''
  const mode = body.mode === 'regenerate' ? 'regenerate' : 'send'
  if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
  if (mode === 'send' && userText === '') throw new Error('message is empty')
  const character = await db.getCharacter(characterName)
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  const chat = snapshot?.chat
  if (!character || !chat || !snapshot) throw new Error('character or chat not found')
  if (typeof body.revision !== 'string') throw new Error('revision is required')
  if (body.revision !== snapshot.revision) {
    throw new ChatRevisionConflictError(body.revision, snapshot.revision)
  }

  let revision = snapshot.revision
  let regenerated
  if (mode === 'send') {
    chat.messages.push({ name: DEFAULT_USER, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: userText })
    revision = await db.saveChat(characterName, chatId, chat, revision)
  } else {
    const last = chat.messages[chat.messages.length - 1]
    if (last?.is_user === false && !last.is_system) regenerated = chat.messages.pop()
  }

  const presetName = typeof body.preset === 'string' ? body.preset : state.activePreset
  let presetObject = presetName ? await db.getPreset(presetName) : undefined
  if (!presetObject) presetObject = defaultPreset()
  const preset = parsePreset(presetObject)
  const persona = state.activePersona ? await db.getPersona(state.activePersona) : undefined

  const books = []
  for (const worldName of state.activeWorlds) {
    const world = await db.getWorld(worldName)
    if (world) books.push({ name: world.name, entries: world.entries })
  }
  if (character.card.data.characterBook) {
    const embedded = parseCharacterBook(character.card.data.characterBook)
    books.unshift({ name: `${characterName}:embedded`, entries: embedded.entries,
      scanDepth: character.card.data.characterBook.scan_depth,
      tokenBudget: character.card.data.characterBook.token_budget,
      recursiveScanning: character.card.data.characterBook.recursive_scanning })
  }

  const historyForLore = chat.messages.map((m) => ({ name: m.name, content: m.mes, isUser: m.is_user }))
  const timedState = chat.header.chat_metadata.timedWorldInfo
  const lore = activateWorldInfo({
    books, chat: historyForLore, contextSize: Number(preset.sampler.openai_max_context ?? 4096),
    trigger: mode === 'regenerate' ? 'regenerate' : 'normal',
    scanSources: {
      personaDescription: persona?.description,
      characterDescription: character.card.data.description,
      characterPersonality: character.card.data.personality,
      scenario: character.card.data.scenario,
      creatorNotes: character.card.data.creatorNotes,
    },
    settings: { recursive: true, scanDepth: 2, budgetPercent: 25 },
    timedState: timedState && typeof timedState === 'object' ? timedState : undefined,
    messageCount: chat.messages.length,
  })
  chat.header.chat_metadata.timedWorldInfo = lore.timedState

  const lastUser = [...chat.messages].reverse().find((m) => m.is_user)
  const lastChar = [...chat.messages].reverse().find((m) => !m.is_user && !m.is_system)
  const macros = createMacroEngine({
    char: character.card.data.nickname || character.card.data.name,
    user: DEFAULT_USER,
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
    lastMessage: chat.messages[chat.messages.length - 1]?.mes,
    lastUserMessage: lastUser?.mes,
    lastCharMessage: lastChar?.mes,
    lastMessageId: chat.messages.length - 1,
    chatId,
  })
  const assembled = assemblePrompt({
    card: character.card, preset, personaDescription: persona?.description,
    messages: chat.messages,
    worldInfoBefore: lore.worldInfoBefore.entries.map((e) => e.content),
    worldInfoAfter: lore.worldInfoAfter.entries.map((e) => e.content),
    beforeExamples: lore.beforeExamples.entries.map((e) => e.content),
    afterExamples: lore.afterExamples.entries.map((e) => e.content),
    depthInjections: [
      ...lore.atDepth.map((g) => ({ depth: g.depth, role: roleName(g.role), text: g.text })),
      ...(lore.topOfAuthorsNote.text ? [{ depth: 4, role: 'system', text: lore.topOfAuthorsNote.text }] : []),
      ...(lore.bottomOfAuthorsNote.text ? [{ depth: 0, role: 'system', text: lore.bottomOfAuthorsNote.text }] : []),
    ],
  }, { expand: (text) => macros.expand(text), countTokens: (text) => Math.ceil(text.length / 3.5) })

  const selection = ctx.agentDefaultModel.currentSelection()
  const provider = typeof body.provider === 'string' ? body.provider : selection.provider
  const model = typeof body.model === 'string' ? body.model : selection.model
  const requestMessages = [...assembled.messages]
  const systemParts = []
  while (requestMessages[0]?.role === 'system') systemParts.push(requestMessages.shift().content)
  const llmMessages = requestMessages.map((m) => createMessage({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    source: m.role === 'assistant' ? { kind: 'model', provider, model } : m.role === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-tavern' },
  }))

  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  const ac = new AbortController()
  req.on?.('aborted', () => ac.abort())
  res.on?.('close', () => { if (!res.writableEnded) ac.abort() })
  const write = (event) => res.write(JSON.stringify(event) + '\n')
  write({ type: 'start', provider, model, lore: lore.allActivated.map((e) => ({ uid: e.uid, book: e.book, comment: e.entry.comment })), stats: assembled.stats })
  let text = ''
  let reasoning = ''
  for await (const chunk of ctx.llm.stream({
    provider, model, messages: llmMessages,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    ...(provider === selection.provider && model === selection.model && selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    temperature: numberOr(preset.sampler.temperature, undefined),
    maxTokens: numberOr(preset.sampler.openai_max_tokens, undefined),
    signal: ac.signal,
  })) {
    if (chunk.type === 'text-delta') { text += chunk.text; write({ type: 'delta', text: chunk.text }) }
    else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; write({ type: 'reasoning', text: chunk.text }) }
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
      write({ type: 'finish', reason: chunk.reason.kind })
    }
  }
  if (text.trim() === '') throw new Error('model returned no text')
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
    is_user: false, is_system: false, send_date: now, mes: text,
    swipe_id: oldSwipes.length,
    swipes: [...oldSwipes, text],
    swipe_info: [...oldSwipeInfo, { send_date: now, extra: { provider, model, reasoning: reasoning || undefined } }],
    extra: { ...(regenerated?.extra ?? {}), api: provider, model, reasoning: reasoning || undefined, activatedLore: lore.allActivated.map((e) => e.entryId) },
  })
  revision = await db.saveChat(characterName, chatId, chat, revision)
  write({ type: 'saved', chat, revision })
  res.end()
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

async function bindSession(db, sessionId, character, chatId) {
  return db.updateState((state) => ({
    activeCharacter: character,
    sessionBindings: {
      ...state.sessionBindings,
      [sessionId]: { character, chatId },
    },
  }))
}

function normalizeChatId(name) {
  const stem = name.replace(/\.jsonl$/i, '').trim()
  if (stem === '') throw new Error('chat name is required')
  return `${stem}.jsonl`
}

function parseTavernCommand(rawInput) {
  const payload = rawInput.trim()
  if (payload === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (parsed.action === 'close') return { action: 'close' }
    if (typeof parsed.character !== 'string' || typeof parsed.chatId !== 'string') return null
    return { action: 'open', character: parsed.character, chatId: parsed.chatId }
  } catch {
    return null
  }
}

function dshHomePath(...segments) {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), ...segments)
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
