// Session lifecycle routes lifted out of `handleApi`: session binding create/
// delete/prune, chat list/create and chat branching. They share the binding
// store surface and the chat snapshot helpers.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { refreshAgentPtcMode } from '../agent-ptc-mode.js'
import { seedJsrMvuVariables } from '../agent-tavern/mvu-compat.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import type { PluginContext } from '../host-contract.js'
import { invalidateImToolBindingCache } from '../im/agent-mount.js'
import { refreshActivePrompt } from '../model-catalog.js'
import {
  assertAgentTavernAvailable,
  bindSession,
  requestedArchitecture,
  requestedContextMode,
} from '../session/binding.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asRecord } from './json-records.js'

async function reconcileAgentPtcMode(ctx: PluginContext): Promise<void> {
  try {
    await refreshAgentPtcMode(ctx)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-soulmojito ptc: binding reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function handleBindingCreateRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
  // 绑定即离开标准会话面：清掉 agent/created 首轮预热可能装上的 native-preset
  // 投影；AgentTavern/ST 各自的预设通道随后按新绑定装载。
  await emitAgentPresetChanged()
  await reconcileAgentPtcMode(ctx)
  return sendJson(res, 200, { ok: true, state, binding: state.sessionBindings[body.sessionId] })
}

export async function handleBindingDeleteRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  if (typeof body.sessionId !== 'string') throw new Error('expected { sessionId }')
  const sessionId = body.sessionId
  const next = await db.updateState((state) => {
    const sessionBindings = { ...state.sessionBindings }
    delete sessionBindings[sessionId]
    return { sessionBindings }
  })
  // 解绑后会话回到标准面：重新装载 native-preset，不必等下一次预设事件。
  await emitAgentPresetChanged()
  await reconcileAgentPtcMode(ctx)
  return sendJson(res, 200, { ok: true, state: next })
}

export async function handleBindingsPruneRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
    // IM 绑定指向原生会话：会话被删掉后绑定就是死记录，和 sessionBindings 一起清。
    imPeers: Object.fromEntries(
      Object.entries(current.imPeers ?? {}).filter(([, binding]) => live.has(binding.sessionId)),
    ),
  }))
  invalidateImToolBindingCache()
  // 批量解绑同样可能把会话还原成标准面，清掉旧投影。
  await emitAgentPresetChanged()
  await reconcileAgentPtcMode(ctx)
  return sendJson(res, 200, { ok: true, state })
}

export async function handleChatsListRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const character = url.searchParams.get('character')
  if (!character) throw new Error('character query is required')
  return sendJson(res, 200, { ok: true, chats: await db.listChats(character) })
}

export async function handleChatCreateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
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
  const seedVariables: Record<string, unknown> | undefined = (() => {
    const holder = asRecord(found.card.data.extensions.agentTavern)
    const initial = asRecord(holder?.['initialVariables'])
    if (initial === undefined || Object.keys(initial).length === 0) return undefined
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
  if (typeof greetingIndex !== 'number' || !Number.isSafeInteger(greetingIndex) || greetingIndex < 0 || greetingIndex >= greetings.length) {
    throw new Error(`greetingIndex must be an integer in [0, ${greetings.length - 1}]`)
  }
  const id = await db.createChat(character, {
    user_name: 'unused', character_name: 'unused',
    chat_metadata: { character, createdAt: now, timedWorldInfo: {}, ...(seedVariables !== undefined || mvuSeeded ? { variables: variablesSeed } : {}) },
  }, [{
    name: found.card.data.nickname || found.card.data.name,
    is_user: false, is_system: false, send_date: now,
    mes: greetings[greetingIndex] ?? '',
    swipe_id: greetingIndex,
    swipes: greetings,
    swipe_info: greetings.map(() => ({ send_date: now })),
  }])
  const snapshot = await db.getChatSnapshot(character, id)
  return sendJson(res, 200, { ok: true, id, chat: snapshot?.chat, revision: snapshot?.revision })
}

export async function handleBranchRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  if (typeof body.character !== 'string' || typeof body.chatId !== 'string' || typeof body.messageId !== 'number') {
    throw new Error('expected { character, chatId, messageId, revision }')
  }
  if (typeof body.revision !== 'string') throw new Error('revision is required')
  const branchName = typeof body.name === 'string' ? body.name : undefined
  const originArchitecture = body.originArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st'
  const targetArchitecture = body.targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st'
  const result = await db.branchChat(body.character, body.chatId, body.messageId, body.revision, branchName, {
    agentTavernOrigin: {
      architecture: originArchitecture,
      targetArchitecture,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
    },
  })
  const snapshot = await db.getChatSnapshot(body.character, result.chatId)
  return sendJson(res, 200, { ok: true, id: result.chatId, chat: snapshot?.chat ?? result.chat, revision: snapshot?.revision })
}
