import type { ModHost } from '../mods/host.js'
import { modHost } from '../runtime.js'
import type { PluginContext } from '../host-contract.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { publicError } from './public-error.js'

/**
 * `/api/dsh-soulmojito/mods` 路由族（提案 0015 §3.2/§3.3 P1）：
 * - `GET  mods`                → 管理快照（清单/状态/错误位/审计计数 + 两层开关）；
 * - `POST mods/state`          → `{ globalEnabled }` 全局开关（三层第二层）；
 * - `POST mods/<id>/enable`    → 逐 Mod 开关（第三层；启用即装载——两层同开才装）；
 * - `POST mods/<id>/disable`   → 卸载（dispose 链 + 定时器/事件/路由清理）；
 * - `POST mods/<id>/reload`    → 调旧 dispose → `?t=` cache-bust 重新 import；
 * - `ANY  mods/<id>/<path>`    → Mod http 子路由（api.http.route 注册表）。
 *
 * 子路由在 env 硬关 / 全局关 / 逐 Mod 关 / 未装载 / 无此路由时统一按未知路由
 * 404（不泄露 Mod 是否存在）。管理面在宿主初始化失败时 GET 回空快照、写路径
 * 上抛（bootstrap 不 500 的教义只覆盖读面）。
 */
export async function handleModsApi(
  ctx: PluginContext,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  const notFound = () => sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
  const segments = route === 'mods' ? [] : route.slice('mods/'.length).split('/')
  const modId = segments[0] ?? ''
  const subpath = segments.length > 1 ? segments.slice(1).join('/') : ''

  let host: ModHost | undefined
  try {
    host = await modHost()
  } catch (cause) {
    ctx.logger?.warn?.(`dsh-soulmojito: mod host unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    if (method === 'GET' && route === 'mods') {
      return sendJson(res, 200, { ok: true, available: false, reason: 'mod host unavailable', globalEnabled: false, mods: [] })
    }
    // 子路由按不可用走 404；管理面写路径如实 500。
    const isManagementWrite = route === 'mods/state'
      || (segments.length === 2 && (subpath === 'enable' || subpath === 'disable' || subpath === 'reload'))
    if (!isManagementWrite) return notFound()
    throw new Error('mod host unavailable')
  }

  if (method === 'GET' && route === 'mods') {
    return sendJson(res, 200, { ok: true, ...host.snapshot() })
  }
  // git 安装（提案 0015 §4 P2）：GitHub 源降级链预读 + git clone。管理路由，
  // 任一层开关关闭时仍可用（与 mods/state 同理）。目录名 `install` 因此成为
  // 管理保留段（mods/install 永远是安装路由，不是名为 install 的 mod 的路由）。
  if (method === 'POST' && route === 'mods/install') {
    const body = await readJson(req)
    if (typeof body.url !== 'string' || body.url.trim() === '') throw new Error('expected { url }')
    const result = await host.installFromGit(body.url, body.force === true)
    return sendJson(res, 200, { ok: true, ...host.snapshot(), installed: result })
  }
  if (method === 'POST' && route === 'mods/state') {
    const body = await readJson(req)
    if (typeof body.globalEnabled !== 'boolean') throw new Error('expected { globalEnabled }')
    await host.setGlobalEnabled(body.globalEnabled)
    return sendJson(res, 200, { ok: true, ...host.snapshot() })
  }
  if (method === 'POST' && segments.length === 2 && (subpath === 'enable' || subpath === 'disable')) {
    await host.setModEnabled(decodeURIComponent(modId), subpath === 'enable')
    return sendJson(res, 200, { ok: true, ...host.snapshot() })
  }
  if (method === 'POST' && segments.length === 2 && subpath === 'reload') {
    await host.reload(decodeURIComponent(modId))
    return sendJson(res, 200, { ok: true, ...host.snapshot() })
  }
  // 声明式按钮分发（A-1，2026-10-11）：`POST mods/<id>/button/<name>`。name 经
  // URL 解码后匹配 manifest 声明的按钮（manifest 校验同款规则）；未装载 / 未知
  // 按钮 / 任一层开关关闭 → 404 与未知路由不可区分（§6 纪律）。请求体可选携带
  // { character, chatId }（点击时可得的聊天归因，客户端有绑定才带）。
  if (method === 'POST' && segments.length === 3 && segments[1] === 'button') {
    let id = modId
    let name = segments[2] ?? ''
    try {
      id = decodeURIComponent(modId)
      name = decodeURIComponent(segments[2] ?? '')
    } catch {
      return notFound()
    }
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const context: { character?: string; chatId?: string } = {}
    if (typeof body.character === 'string' && body.character !== '') context.character = body.character
    if (typeof body.chatId === 'string' && body.chatId !== '') context.chatId = body.chatId
    try {
      const outcome = await host.dispatchButton(id, name, context)
      if (outcome === 'not-found') return notFound()
      return sendJson(res, 200, { ok: true, handled: outcome === 'handled' })
    } catch (cause) {
      // handler 抛错：button-error 审计已在 dispatchButton 落账，这里只兜 500。
      // Third-party messages stay readable when safe; paths/filesystem details
      // collapse to the shared internal body and are logged through ctx.
      const failure = publicError(cause, { operation: 'mod-button-dispatch', logger: ctx.logger })
      return sendJson(res, failure.status, {
        ok: false,
        message: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      })
    }
  }
  if (segments.length >= 1 && modId !== '') {
    // 子路由：decodeURIComponent 与既有资产路由同款（mod id 是 URL 段）；解码
    // 失败或白名单不过都按 404 走，不进文件系统。
    let id = modId
    let path = subpath
    try {
      id = decodeURIComponent(modId)
      path = subpath === '' ? '' : decodeURIComponent(subpath)
    } catch {
      return notFound()
    }
    const handled = await host.handleRoute(req, res, method, url, id, path)
    if (handled) return
    return notFound()
  }
  return notFound()
}
