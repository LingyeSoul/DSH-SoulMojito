// Post-store domain routes lifted out of `handleApi`: avatar/character reads,
// projection status/replay, one-shot compaction, guides/scripts and the
// AgentTavern audit read. The body and novel/mod surfaces live in their own
// modules; `routes.ts` owns the evaluation order.

import { readSessionEvents, type HostSessionLog } from '../../../bind/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { sendAvatarFallback, serveCharacterAvatar } from '../assets.js'
import type { PluginContext } from '../host-contract.js'
import { publicCard } from '../model-catalog.js'
import { getAgentTavernProjectorPromise, memories, variables } from '../runtime.js'
import { TavernArchitectureConflictError } from '../session/binding.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

export async function handleAvatarRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
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

export async function handleCharacterReadRoute(
  db: TavernStore,
  res: HttpResponse,
  route: string,
): Promise<void> {
  const name = decodeURIComponent(route.slice('character/'.length))
  const found = await db.getCharacter(name)
  if (!found) return sendJson(res, 404, { ok: false, message: 'character not found' })
  return sendJson(res, 200, { ok: true, kind: found.kind, card: publicCard(found.card) })
}

export async function handleProjectionRoute(res: HttpResponse, url: URL): Promise<void> {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) throw new Error('sessionId query is required')
  const projector = await getAgentTavernProjectorPromise()
  if (!projector) throw new Error('AgentTavern projector is unavailable')
  return sendJson(res, 200, { ok: true, projection: await projector.status(sessionId) })
}

export async function handleProjectionReplayRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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
  if (!session || typeof session.id !== 'string' || readSessionEvents(session) === undefined) {
    throw new Error('AgentTavern session is not loaded in this host process; open the chat first and retry.')
  }
  const projector = await getAgentTavernProjectorPromise()
  if (!projector) throw new Error('AgentTavern projector is unavailable')
  await projector.replay({ ...session, id: session.id })
  return sendJson(res, 200, { ok: true, projection: await projector.status(sessionId) })
}

export async function handleCompactRoute(
  ctx: PluginContext,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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

export async function handleAuditRoute(
  db: TavernStore,
  res: HttpResponse,
  url: URL,
): Promise<void> {
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
