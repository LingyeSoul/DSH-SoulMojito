import {
  ChatRevisionConflictError,
  VariableRevisionConflictError,
  applyScriptBinding,
  boundScriptOf,
  getScript,
  importScript,
  listScripts,
  normalizeScriptProgress,
  type TavernStore,
} from '../../../tavern-store/src/index.js'
import { executeCardPlan, executeWorldPlan } from '../card-workbench/agent.js'
import { decidePlan, getPlan, listPlans } from '../card-workbench/plans.js'
import { tavernDataRoot } from '../dsh-home.js'
import { addGuide, emitGuidesChanged, normalizeGuides, removeGuide } from '../guides.js'
import { emitChatSaved } from '../mods/events.js'
import {
  MvuUndoRefusalError,
  overlayChatScopedVariables,
  readChatVariables,
  readMvuReceipts,
  renderMvuStatusTemplate,
  retryMvuSettlement,
  statusTemplateOf,
  undoMvuAgentSettlement,
  undoMvuStSettlement,
} from '../mvu.js'
import { stripMvuControl } from '../mvu-guard.js'
import { templatesEnabled, templatesEnabledFlagValue, variables } from '../runtime.js'
import { assertStGenerationBinding } from '../session/binding.js'
import { readJson, sendJson } from './io.js'
import type { NovelApiRequest, NovelApiResponse } from './novel.js'

/** guides 路由的聊天快照读取：store 的 safeChatFileName 对空/畸形 chatId 抛
 * 'invalid chat id'（写卡工作台等会话的绑定 character/chatId 恒为空串，面板
 * 曾经以此打出空 id、收到裸 500）——HTTP 层统一按「聊天不存在」应答，不把
 * 内部文件名校验错误透传给客户端；其余异常照常上抛。 */
export async function readGuidesSnapshot(db: TavernStore, character: string, chatId: string) {
  try {
    return await db.getChatSnapshot(character, chatId)
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'invalid chat id') return undefined
    throw cause
  }
}
/* ---------------- 域路由提取（guides / script / mvu / card-workbench） ---------------- */

// 与 handleNovelsApi 同款同文件提取（决策 2026-10-09-dedup-refactor）：handleApi
// 只留级联分派，域分支整体搬进各自处理器。分派条件是原分支条件的并集；处理器
// 内部分支顺序与原级联一致（script/progress/ 先于通用 script/ 等顺序敏感点原样
// 保留），尾部 404 与级联兜底同文案——方法/段数不匹配的请求拿到与拆分前完全
// 相同的响应。路由字面量保持原样（gates 在 bundle 上逐字断言）。

export async function handleGuidesApi(
  req: NovelApiRequest,
  res: NovelApiResponse,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  if ((method === 'GET' || method === 'POST') && route.startsWith('guides/')) {
    const segments = route.slice('guides/'.length).split('/')
    if (segments.length !== 2) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const snapshot = await readGuidesSnapshot(db, character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    if (method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        guides: normalizeGuides(snapshot.chat.header.chat_metadata?.guides),
        revision: snapshot.revision,
      })
    }
    const body = await readJson(req)
    const added = addGuide(normalizeGuides(snapshot.chat.header.chat_metadata?.guides), body.text)
    if (!added.ok) return sendJson(res, 400, { ok: false, message: added.error, code: 'TAVERN_GUIDES' })
    const metadata = { ...snapshot.chat.header.chat_metadata, guides: added.guides }
    const revision = await db.saveChat(character, chatId, {
      ...snapshot.chat,
      header: { ...snapshot.chat.header, chat_metadata: metadata },
    }, snapshot.revision)
    await emitGuidesChanged(character, chatId)
    await emitChatSaved(character, chatId, revision, snapshot.chat.messages.length)
    return sendJson(res, 200, { ok: true, guide: added.guide, guides: added.guides, revision })
  }

  if (method === 'DELETE' && route.startsWith('guides/')) {
    const segments = route.slice('guides/'.length).split('/')
    if (segments.length !== 3) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const id = decodeURIComponent(segments[2])
    const snapshot = await readGuidesSnapshot(db, character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    const removed = removeGuide(normalizeGuides(snapshot.chat.header.chat_metadata?.guides), id)
    if (!removed.removed) return sendJson(res, 404, { ok: false, message: 'guide not found' })
    const metadata = { ...snapshot.chat.header.chat_metadata }
    // 清空即摘除键：与 chat_metadata.variables 的空置清理约定一致，导出不含空 guides。
    if (removed.guides.length > 0) metadata.guides = removed.guides
    else delete metadata.guides
    const revision = await db.saveChat(character, chatId, {
      ...snapshot.chat,
      header: { ...snapshot.chat.header, chat_metadata: metadata },
    }, snapshot.revision)
    await emitGuidesChanged(character, chatId)
    await emitChatSaved(character, chatId, revision, snapshot.chat.messages.length)
    return sendJson(res, 200, { ok: true, guides: removed.guides, revision })
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

export async function handleScriptApi(
  req: NovelApiRequest,
  res: NovelApiResponse,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  if (method === 'POST' && route === 'script/import') {
    const body = await readJson(req, 8 * 1024 * 1024)
    let imported
    try {
      // EPUB（提案 0014 P2）：content 为 base64 编码的 zip 字节，解码后走
      // importScript 的二进制分支（parseEpubText）；8MB 上限对 base64 文本照旧。
      imported = await importScript(
        tavernDataRoot(),
        body.name,
        body.format === 'epub'
          ? Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64')
          : body.content,
        body.format,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return sendJson(res, 400, { ok: false, message, code: 'TAVERN_SCRIPT' })
    }
    return sendJson(res, 200, {
      ok: true,
      script: {
        name: imported.name,
        source: imported.source,
        chunkCount: imported.chunks.length,
        chunks: imported.chunks,
      },
    })
  }

  if (method === 'GET' && route === 'scripts') {
    const scripts = await listScripts(tavernDataRoot())
    const bindings: Record<string, string> = {}
    for (const name of await db.listCharacters()) {
      const file = await db.getCharacter(name)
      const bound = file === undefined ? undefined : boundScriptOf(file.card)
      if (bound !== undefined) bindings[name] = bound
    }
    return sendJson(res, 200, { ok: true, scripts, bindings })
  }

  // progress 路由必须先于通用 script/<name> 匹配（同为 script/ 前缀）
  if (method === 'GET' && route.startsWith('script/progress/')) {
    const segments = route.slice('script/progress/'.length).split('/')
    if (segments.length !== 2) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const character = decodeURIComponent(segments[0])
    const chatId = decodeURIComponent(segments[1])
    const file = await db.getCharacter(character)
    if (!file) return sendJson(res, 404, { ok: false, message: 'character not found' })
    const scriptName = boundScriptOf(file.card)
    if (scriptName === undefined) return sendJson(res, 404, { ok: false, message: 'no script bound to this character' })
    const script = await getScript(tavernDataRoot(), scriptName)
    if (!script) return sendJson(res, 404, { ok: false, message: `script '${scriptName}' not found` })
    const snapshot = await db.getChatSnapshot(character, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    const progress = normalizeScriptProgress(snapshot.chat.header.chat_metadata?.scriptProgress)
    const active = progress !== undefined && progress.scriptName === scriptName ? progress : undefined
    const chunkIndex = active !== undefined ? Math.min(active.chunkIndex, script.chunks.length - 1) : 0
    return sendJson(res, 200, {
      ok: true,
      scriptName,
      chunkIndex,
      chunkCount: script.chunks.length,
      currentPreview: script.chunks[chunkIndex]?.text.slice(0, 400) ?? '',
      nextPreview: script.chunks[chunkIndex + 1]?.text.slice(0, 400) ?? '',
      alignedAt: active?.alignedAt ?? null,
    })
  }

  if (method === 'GET' && route.startsWith('script/')) {
    const name = decodeURIComponent(route.slice('script/'.length))
    if (name === '' || name.includes('/')) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
    const script = await getScript(tavernDataRoot(), name)
    if (!script) return sendJson(res, 404, { ok: false, message: `script '${name}' not found` })
    return sendJson(res, 200, { ok: true, script: { name: script.name, source: script.source, chunks: script.chunks } })
  }

  if (method === 'POST' && (route === 'script/bind' || route === 'script/unbind')) {
    const body = await readJson(req)
    const characterName = typeof body.character === 'string' ? body.character : ''
    if (characterName === '') throw new Error('character is required')
    const binding = route === 'script/bind' && typeof body.scriptName === 'string' ? body.scriptName.trim() : undefined
    if (route === 'script/bind' && (binding === undefined || binding === '')) {
      throw new Error('scriptName is required')
    }
    if (binding !== undefined) {
      const script = await getScript(tavernDataRoot(), binding)
      if (!script) return sendJson(res, 404, { ok: false, message: `script '${binding}' not found` })
    }
    try {
      await applyScriptBinding(db, characterName, binding)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('not found')) return sendJson(res, 404, { ok: false, message })
      throw error
    }
    return sendJson(res, 200, { ok: true, character: characterName, scriptName: binding ?? null })
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

export async function handleMvuApi(
  req: NovelApiRequest,
  res: NovelApiResponse,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  // MVU 结算重试（提案 0012 P1）：只对最后一条助手楼层重跑模板输出渲染的变量
  // 写穿部分（不重跑 AI_OUTPUT regex——非幂等），正文不动；CAS 冲突走既有通道。
  if (method === 'POST' && route === 'mvu/retry') {
    const body = await readJson(req)
    const state = await db.getState()
    assertStGenerationBinding(state, body.sessionId)
    const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
    const chatId = body.chatId
    if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
    if (typeof body.revision !== 'string') throw new Error('revision is required')
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (!snapshot) throw new Error('character or chat not found')
    const result = await retryMvuSettlement(db, {
      state,
      characterName,
      chatId,
      snapshot,
      revision: body.revision,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      templatesActive: templatesEnabledFlagValue() && templatesEnabled(),
    })
    return sendJson(res, 200, { ok: true, receipt: result.receipt, revision: result.revision, variables: result.variables })
  }

  // MVU 回执撤销（B-6a，2026-10-11）：只能撤销该聊天最新一条有效回执
  // （newest-first 链），把该轮每项变更恢复到回执记录的 before 值。变量源按
  // 绑定架构取（与 GET mvu/status 同判据）：AgentTavern 绑定写 chat 作用域
  // VariableStore，其余写 chat_metadata.variables——两个执行核共享 mvu.ts 的
  // 纯函数核。语义性拒绝（无回执/全已撤销/数据不完整/守卫拒绝）→ 400 分类
  // 报因；并发走聊天 revision CAS（与 retry 同款，body.revision 可选预检）。
  // 成功后发 chat-saved（floorCount 传当前楼数——撤销不动楼层）。
  if (method === 'POST' && route === 'mvu/receipts/undo') {
    const body = await readJson(req)
    const state = await db.getState()
    const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
    const chatId = body.chatId
    if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
    let snapshot: Awaited<ReturnType<typeof db.getChatSnapshot>>
    try {
      snapshot = await db.getChatSnapshot(characterName, chatId)
    } catch (cause) {
      // store 的 safeChatFileName 对空/畸形 chatId 抛 'invalid chat id'（与 guides
      // 路由同款）：HTTP 层统一按「聊天不存在」应答。
      if (cause instanceof Error && cause.message === 'invalid chat id') snapshot = undefined
      else throw cause
    }
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'character or chat not found' })
    if (typeof body.revision === 'string' && body.revision !== snapshot.revision) {
      throw new ChatRevisionConflictError(body.revision, snapshot.revision)
    }
    const agentTavernBound = Object.values(state.sessionBindings).some((binding) =>
      binding.architecture === 'agent-tavern' && binding.chatId === chatId && binding.character === characterName)
    const options = { characterName, chatId, snapshot, at: new Date().toISOString() }
    let result
    try {
      result = agentTavernBound
        ? await undoMvuAgentSettlement(await variables(), db, options)
        : await undoMvuStSettlement(db, options)
    } catch (error) {
      if (error instanceof MvuUndoRefusalError) {
        return sendJson(res, 400, { ok: false, message: error.message, code: `MVU_UNDO_${error.undoCode}` })
      }
      // chat 作用域变量的 CAS 冲突（AgentTavern 撤销路径）：并发写已在变量层
      // 被拦下，按既有 409 通道如实上抛，不部分落回执。
      if (error instanceof VariableRevisionConflictError) {
        return sendJson(res, 409, { ok: false, message: error.message, code: error.code })
      }
      throw error
    }
    await emitChatSaved(characterName, chatId, result.revision, snapshot.chat.messages.length)
    return sendJson(res, 200, {
      ok: true,
      undoneTurnKey: result.receipt.turnKey,
      restored: result.restores,
      receipt: result.receipt,
      revision: result.revision,
    })
  }

  // MVU 状态（提案 0012 P1）：变量 + 回执快照；卡片约定字段
  // data.extensions.agentTavern.statusTemplate（0013 工作台产出）存在时附带
  // 模板化 renderedHtml（接线点）；渲染失败降级为不返回该字段，不 500。
  // 变量源按绑定架构取：AgentTavern 聊天的权威源是 chat 作用域 VariableStore
  // （variable_set/patch/delete 与 tavern_variable_settle 全族都写那里，从不写
  // chat_metadata.variables），扁平点分名覆盖回嵌套树后与 ST 共用同一份显示与
  // 模板语义；ST 绑定或未绑定的聊天不回读，避免架构切换后的残留值污染 ST 变量。
  if (method === 'GET' && route.startsWith('mvu/status/')) {
    const rest = route.slice('mvu/status/'.length)
    const separator = rest.indexOf('/')
    if (separator === -1) throw new Error('expected route mvu/status/<character>/<chatId>')
    const characterName = decodeURIComponent(rest.slice(0, separator))
    const chatId = decodeURIComponent(rest.slice(separator + 1))
    const snapshot = await db.getChatSnapshot(characterName, chatId)
    if (!snapshot) return sendJson(res, 404, { ok: false, message: 'character or chat not found' })
    const chat = snapshot.chat
    const state = await db.getState()
    const receipts = readMvuReceipts(chat)
    const agentTavernBound = Object.values(state.sessionBindings).some((binding) =>
      binding.architecture === 'agent-tavern' && binding.chatId === chatId && binding.character === characterName)
    const scopedVariables = agentTavernBound ? await (await variables()).listAll('chat', chatId) : []
    // 显示树剥离根 $schema（C-1）/$rules（C-2）：守卫/规则契约不是变量，不进
    // 状态栏载荷/渲染。
    const displayVariables = stripMvuControl(scopedVariables.length > 0
      ? overlayChatScopedVariables(readChatVariables(chat), scopedVariables)
      : readChatVariables(chat))
    const character = await db.getCharacter(characterName)
    const statusTemplate = character ? statusTemplateOf(character.card) : undefined
    let renderedHtml: string | undefined
    if (statusTemplate !== undefined) {
      try {
        renderedHtml = await renderMvuStatusTemplate({
          db, state, characterName, character: character!, chat, chatId, template: statusTemplate,
          localVariables: displayVariables,
        })
      } catch {
        // 渲染失败降级：不返回 renderedHtml，状态接口本身不失败
      }
    }
    return sendJson(res, 200, {
      ok: true,
      // 回执本身也是可展示内容：只有失败回执（全项失败、无变量落盘）时面板仍需可见可读。
      available: Object.keys(displayVariables).length > 0 || receipts.length > 0,
      variables: displayVariables,
      receipts,
      ...(renderedHtml !== undefined ? { renderedHtml } : {}),
    })
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}
export async function handleWorkbenchApi(
  req: NovelApiRequest,
  res: NovelApiResponse,
  url: URL,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  // 写卡会话改名（对齐酒馆聊天的侧边栏改名能力）：title 写进 card-workbench
  // 绑定——它是侧边栏分组与复用判定的数据源，客户端改名成功后另经宿主
  // binding.session.rename 同步会话标题（best-effort）。只收 card-workbench
  // 绑定，空 title / 非 workbench 会话 fail-closed。错误码 TAVERN_WORKBENCH。
  if (method === 'POST' && route === 'card-workbench/rename') {
    const body = await readJson(req)
    if (typeof body.sessionId !== 'string' || typeof body.title !== 'string') {
      return sendJson(res, 400, { ok: false, message: 'expected { sessionId, title }', code: 'TAVERN_WORKBENCH' })
    }
    const title = body.title.trim().slice(0, 200)
    if (title === '') {
      return sendJson(res, 400, { ok: false, message: 'title must be a non-empty string', code: 'TAVERN_WORKBENCH' })
    }
    const binding = (await db.getState()).sessionBindings[body.sessionId]
    if (binding?.architecture !== 'card-workbench') {
      return sendJson(res, 404, { ok: false, message: `session '${body.sessionId}' is not a CardWorkbench session`, code: 'TAVERN_WORKBENCH' })
    }
    const state = await db.updateState((current) => ({
      sessionBindings: {
        ...current.sessionBindings,
        [body.sessionId]: { ...binding, title },
      },
    }))
    return sendJson(res, 200, { ok: true, state, binding: state.sessionBindings[body.sessionId] })
  }

  // 方案 = card_plan_propose / world_plan_propose 落库的 pending 计划
  // （<tavern>/card-workbench/plans/，见 card-workbench/plans.ts，kind 判别）。
  // 面板拉列表看 diff、给决定；approve=true 经执行核（executeCardPlan /
  // executeWorldPlan）按方案写入并标记 applied（执行不在存储层），false 只改
  // 状态。错误码 TAVERN_WORKBENCH。
  if (method === 'GET' && route === 'card-workbench/plans') {
    const statusParam = url.searchParams.get('status') ?? 'pending'
    if (statusParam !== 'pending' && statusParam !== 'approved' && statusParam !== 'rejected' && statusParam !== 'applied' && statusParam !== 'all') {
      return sendJson(res, 400, { ok: false, message: `unknown status filter '${statusParam}'`, code: 'TAVERN_WORKBENCH' })
    }
    const kindParam = url.searchParams.get('kind')
    if (kindParam !== null && kindParam !== 'card' && kindParam !== 'world') {
      return sendJson(res, 400, { ok: false, message: `unknown kind filter '${kindParam}'`, code: 'TAVERN_WORKBENCH' })
    }
    const character = url.searchParams.get('character') ?? undefined
    const plans = await listPlans(tavernDataRoot(), {
      ...(kindParam !== null ? { kind: kindParam } : {}),
      ...(character !== undefined && character !== '' ? { character } : {}),
      status: statusParam,
    })
    return sendJson(res, 200, { ok: true, plans })
  }

  if (method === 'POST' && route.startsWith('card-workbench/plans/') && route.endsWith('/decision')) {
    const planId = decodeURIComponent(route.slice('card-workbench/plans/'.length, route.length - '/decision'.length))
    const body = await readJson(req)
    if (typeof body.approve !== 'boolean') {
      return sendJson(res, 400, { ok: false, message: 'expected { approve: boolean }', code: 'TAVERN_WORKBENCH' })
    }
    const plan = await getPlan(tavernDataRoot(), planId)
    if (plan === undefined) return sendJson(res, 404, { ok: false, message: `plan '${planId}' not found`, code: 'TAVERN_WORKBENCH' })
    try {
      if (body.approve) {
        // 执行核：过期检测 → 白名单写入 → 标记 applied；失败不落 applied。
        if (plan.kind === 'world') {
          const executed = await executeWorldPlan(plan)
          return sendJson(res, 200, { ok: true, plan: executed.plan, applied: { world: executed.world, entryCount: executed.entryCount, nextUid: executed.nextUid, entries: executed.touched } })
        }
        const executed = await executeCardPlan(plan)
        return sendJson(res, 200, { ok: true, plan: executed.plan, applied: { character: executed.character, changes: executed.changes, fieldLengths: executed.fieldLengths } })
      }
      const decided = await decidePlan(tavernDataRoot(), planId, false)
      return sendJson(res, 200, { ok: true, plan: decided })
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error), code: 'TAVERN_WORKBENCH' })
    }
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}
