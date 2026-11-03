// Generation and MVU routes lifted out of `handleApi`: action candidates, the
// zero-side-effect preview, and the MVU retry/undo/status surface.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { runCandidateGeneration } from '../candidates.js'
import { previewGeneration } from '../generation/pipeline.js'
import type { PluginContext } from '../host-contract.js'
import { handleMvuApi } from './panel.js'
import { optionalFeedback } from '../rewrite.js'
import { assertStGenerationBinding } from '../session/binding.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

// 行动候选（提案 0010）：独立轻量请求，与正文生成解耦；失败不落聊天。
export async function handleCandidatesRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  const state = await db.getState()
  assertStGenerationBinding(state, body.sessionId)
  const characterName = typeof body.character === 'string' ? body.character : state.activeCharacter
  const chatId = body.chatId
  if (!characterName || typeof chatId !== 'string') throw new Error('character and chatId are required')
  if (typeof body.revision !== 'string') throw new Error('revision is required')
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  if (!snapshot) throw new Error('character or chat not found')
  const feedback = optionalFeedback(body.feedback)
  const result = await runCandidateGeneration(ctx, db, {
    state,
    characterName,
    chatId,
    snapshot,
    feedback,
    revision: body.revision,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
  })
  return sendJson(res, 200, { ok: true, items: result.items, generatedAt: result.generatedAt, revision: result.revision })
}

// 试写预览（D-4 生成不入楼，2026-10-11）：真实装配 + 单次 LLM 生成，但零副作用
// ——不落楼、无 MVU 结算/回执、无 chat-saved/stream-delta 事件、五相位 hook 全部
// 不跑、无 DSH session 镜像。卡片工作台排错/试写专用入口。
export async function handlePreviewRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  return previewGeneration(ctx, req, res, db)
}

// MVU 结算重试（提案 0012 P1）：只对最后一条助手楼层重跑模板输出渲染的变量
// 写穿部分（不重跑 AI_OUTPUT regex——非幂等），正文不动；CAS 冲突走既有通道。
// MVU 状态（提案 0012 P1）：变量 + 回执快照；卡片约定字段
// data.extensions.agentTavern.statusTemplate（0013 工作台产出）存在时附带
// 模板化 renderedHtml（接线点）；渲染失败降级为不返回该字段，不 500。
// 变量源按绑定架构取：AgentTavern 聊天的权威源是 chat 作用域 VariableStore
// （variable_set/patch/delete 与 tavern_variable_settle 全族都写那里，从不写
// chat_metadata.variables），扁平点分名覆盖回嵌套树后与 ST 共用同一份显示与
// 模板语义；ST 绑定或未绑定的聊天不回读，避免架构切换后的残留值污染 ST 变量。
export async function handleMvuRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
  method: string,
): Promise<void> {
  return handleMvuApi(req, res, route, method, db)
}
