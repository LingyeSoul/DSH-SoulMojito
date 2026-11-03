// Panel management routes lifted out of `handleApi`: card-workbench plans and
// rename, memory embed settings/maintenance, and the read-only prompt viewer.
//
// ---- 工作台方案确认协议（提案 0013 P2；世界书面板化同构扩展）----
// 写卡会话改名：title 写进 card-workbench 绑定；只收 card-workbench 绑定，
// 空 title / 非 workbench 会话 fail-closed。错误码 TAVERN_WORKBENCH。
// 方案 = card_plan_propose / world_plan_propose 落库的 pending 计划；approve
// 经执行核写入并标记 applied，false 只改状态。
//
// 记忆语义检索 embed 端点管理面（提案 0016）：GET/PUT 设置 + 连通性探针。
// 本地模型量化精度识别（2026-10-13）：返回可加载精度档位与 auto 推荐档。
// B-3 记忆维护 run：POST 启动（同 scope 单飞 409），GET 轮询。
// 提示词查看器（A-6）：ST 生成循环实发请求的只读查询；记录是进程内环形缓冲
// （每聊天 10 条 / 总量 50，重启即失），无记录时空数组。

import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { PluginContext } from '../host-contract.js'
import { handleMemoryEmbedApi, handleMemoryMaintenanceApi } from './memory.js'
import { handleWorkbenchApi } from './panel.js'
import { listPromptViews } from '../prompt-viewer.js'
import { sendJson, type HttpRequest, type HttpResponse } from './io.js'

export async function handleWorkbenchRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  return handleWorkbenchApi(req, res, url, route, method, db)
}

export async function handleMemoryEmbedRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
  method: string,
): Promise<void> {
  return handleMemoryEmbedApi(req, res, route, method, db)
}

export async function handleMemoryMaintenanceRoute(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  return handleMemoryMaintenanceApi(ctx, req, res, url, route, method, db)
}

export async function handlePromptsRoute(
  res: HttpResponse,
  url: URL,
): Promise<void> {
  const filterCharacter = url.searchParams.get('character')
  const filterChat = url.searchParams.get('chatId')
  return sendJson(res, 200, {
    ok: true,
    records: listPromptViews({
      ...(filterCharacter !== null ? { character: filterCharacter } : {}),
      ...(filterChat !== null ? { chatId: filterChat } : {}),
    }),
  })
}
