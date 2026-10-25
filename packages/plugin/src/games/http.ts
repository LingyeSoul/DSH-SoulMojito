/**
 * 游戏桥 HTTP 面（提案 0018 §4.1 http.ts，P0；任务书 B 节的路由形状）。
 *
 * 全部挂现有 `/api/dsh-soulmojito` 前缀下，由 index.ts 的 handleApi 分派
 * （follow handleModsApi 的既有 dispatch 风格）。JSON 响应风格对齐 sendJson；
 * 请求体读取复用 mods/http.ts 的 readModRequestBody（与宿主 readJson 同语义）。
 *
 * 路由一览（P1 客户端对接面）：
 * - GET  games/list?character&chatId → {ok, games, sessions}
 * - GET  games/revision              → {ok, revision}
 * - POST games/start {gameId, character, chatId, humanRole?} → {ok, session, view}
 * - GET  games/state/:id             → {ok, session, view}
 * - POST games/action/:id {action}   → {ok, session, view}
 * - GET  games/:gid/view/:sid        → HTML（CSP + 桥脚本注入，见 view.ts）
 * - POST games/install {path|url|zipBase64} → {ok, game}
 * - POST games/reload                → {ok, games}
 *
 * 状态码纪律：非人类/非 Agent 回合与终局后落子 409；非法动作 400（引擎中文
 * 报错透传）；未知会话/游戏 404；孤儿会话（游戏已不在注册表）503；参数缺省
 * 400。其余未预期异常上抛给外层 prefix handler 兜 500（与 mods 面同款）。
 */

import { INTERNAL_ERROR_MESSAGE, publicErrorMessage } from '../http/public-error.js'
import { readModRequestBody } from '../mods/http.js'
import { GameBridgeError } from './sessions.js'
import type { GamesService } from './service.js'
import type { GameAction } from './standard.js'

/** games/install 请求体上限（zip 上传：base64 约放大 4/3；客户端预检 5MB zip）。 */
const GAMES_INSTALL_BODY_MAX_BYTES = 8 * 1024 * 1024

export interface GamesHttpRequest {
  method?: string
  on: (event: string, listener: (chunk?: unknown) => void) => unknown
  destroy?: () => void
}

export interface GamesHttpResponse {
  statusCode: number
  readonly writableEnded?: boolean
  setHeader: (name: string, value: string) => void
  end: (chunk?: string | Uint8Array) => void
}

export interface GamesHttpOptions {
  /** 服务解析器：undefined / rejected = 游戏运行时不可用（503）。 */
  resolveService: () => Promise<GamesService> | undefined
  req: GamesHttpRequest
  res: GamesHttpResponse
  url: URL
  /** 前缀去掉后的完整路由（如 'games/list'）。 */
  route: string
  method: string
}

/** 路由是否归游戏面管（index.ts 据此分派）。 */
export function isGamesRoute(route: string): boolean {
  return route === 'games' || route.startsWith('games/')
}

/** GameBridgeError → HTTP 状态码。 */
function statusOf(code: GameBridgeError['code']): number {
  if (code === 'not-found') return 404
  if (code === 'turn') return 409
  if (code === 'unavailable') return 503
  return 400
}

function sendJson(res: GamesHttpResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendHtml(res: GamesHttpResponse, document: string): void {
  if (res.writableEnded) return
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(document)
}

/** 错误出口：GameBridgeError 结构化应答；其余上抛（外层 500）。 */
function sendError(res: GamesHttpResponse, cause: unknown): void {
  if (cause instanceof GameBridgeError) {
    // Domain errors keep their status/code, but a third-party engine message
    // that happens to carry an absolute path rethrows so the outer handler
    // logs the original and answers with the shared internal body.
    const message = publicErrorMessage(cause)
    if (message === INTERNAL_ERROR_MESSAGE) throw cause
    sendJson(res, statusOf(cause.code), { ok: false, message, code: cause.code })
    return
  }
  throw cause
}

/** games 路由处理器（index.ts 接线，follow handleModsApi：应答或抛错，无返回值）。 */
export async function handleGamesApi(options: GamesHttpOptions): Promise<void> {
  const { req, res, url, route, method } = options
  const notFound = () => sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })

  const service = await Promise.resolve(options.resolveService()).catch((cause: unknown) => {
    throw new Error(`游戏运行时不可用: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  if (service === undefined) {
    sendJson(res, 503, { ok: false, message: '游戏运行时不可用（插件未装载游戏服务）', code: 'unavailable' })
    return
  }

  try {
    // ---- GET games/list?character&chatId：游戏 + 本聊天活跃会话 ----
    if (method === 'GET' && route === 'games/list') {
      const character = url.searchParams.get('character') ?? ''
      const chatId = url.searchParams.get('chatId') ?? ''
      // 双全才过滤（character+chatId 缺一即全量；空绑定参数同 mods 面板纪律不进过滤）。
      const filter = character !== '' && chatId !== '' ? { character, chatId } : {}
      const { games, sessions } = await service.list(filter)
      return sendJson(res, 200, { ok: true, games, sessions })
    }

    // ---- GET games/revision：轻量水位（面板 1s 轮询） ----
    if (method === 'GET' && route === 'games/revision') {
      return sendJson(res, 200, { ok: true, revision: await service.revision() })
    }

    // ---- POST games/start：开局并绑定聊天 ----
    if (method === 'POST' && route === 'games/start') {
      const body = await readModRequestBody(req)
      if (typeof body.gameId !== 'string' || body.gameId.trim() === '') throw new GameBridgeError('invalid', 'expected { gameId }')
      if (typeof body.character !== 'string' || body.character.trim() === ''
        || typeof body.chatId !== 'string' || body.chatId.trim() === '') {
        // 空绑定报错纪律与 mods 面板一致：会话必须挂真实聊天。
        throw new GameBridgeError('invalid', 'expected non-empty { character, chatId }')
      }
      const humanRole = typeof body.humanRole === 'string' && body.humanRole !== '' ? body.humanRole : undefined
      const { session, view } = await service.start({ gameId: body.gameId, character: body.character, chatId: body.chatId, humanRole })
      return sendJson(res, 200, { ok: true, session, view })
    }

    // ---- GET games/state/:id：快照 ----
    if (method === 'GET' && route.startsWith('games/state/')) {
      const sessionId = decodeURIComponent(route.slice('games/state/'.length))
      const { session, view } = await service.state(sessionId)
      return sendJson(res, 200, { ok: true, session, view })
    }

    // ---- POST games/action/:id：人类落子（actor=当前回合，owner 必须 human） ----
    if (method === 'POST' && route.startsWith('games/action/')) {
      const sessionId = decodeURIComponent(route.slice('games/action/'.length))
      const body = await readModRequestBody(req)
      const action = body.action
      if (action === null || typeof action !== 'object' || Array.isArray(action)) {
        throw new GameBridgeError('invalid', 'expected { action }')
      }
      const actionRecord = action as Record<string, unknown>
      const actionType = actionRecord['type']
      if (typeof actionType !== 'string' || actionType === '') {
        throw new GameBridgeError('invalid', 'action.type is required')
      }
      const gameAction: GameAction = { ...actionRecord, type: actionType }
      const { session, view } = await service.humanAction(sessionId, gameAction)
      return sendJson(res, 200, { ok: true, session, view })
    }

    // ---- GET games/:gid/view/:sid：视图服务（HTML） ----
    if (method === 'GET' && route.startsWith('games/') && route.includes('/view/')) {
      const segments = route.split('/')
      if (segments.length === 4 && segments[2] === 'view') {
        let gameId = segments[1]!
        let sessionId = segments[3]!
        try {
          gameId = decodeURIComponent(gameId)
          sessionId = decodeURIComponent(sessionId)
        } catch {
          return notFound()
        }
        const html = await service.view(gameId, sessionId)
        return sendHtml(res, html)
      }
      return notFound()
    }

    // ---- POST games/install {path}|{url}|{zipBase64}：导入 ----
    if (method === 'POST' && route === 'games/install') {
      // zip 上传走 base64 JSON 正文（与 import/character 的 pngBase64/charxBase64
      // 同款纪律）；8MB 上限给 base64 膨胀（约 4/3）与合理包体积留量，客户端
      // 另有 5MB 的文件预检。读取失败（超限/坏 JSON）是参数问题——转 400 可读
      // 报错，不落外层 500 兜底。
      let body: Record<string, unknown>
      try {
        body = await readModRequestBody(req, GAMES_INSTALL_BODY_MAX_BYTES)
      } catch (cause) {
        throw new GameBridgeError('invalid', `install 请求体读取失败（上限 ${GAMES_INSTALL_BODY_MAX_BYTES} 字节）: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      const source: { path?: string; url?: string; zipBase64?: string } = {}
      if (typeof body.path === 'string' && body.path.trim() !== '') source.path = body.path
      else if (typeof body.url === 'string' && body.url.trim() !== '') source.url = body.url
      else if (typeof body.zipBase64 === 'string' && body.zipBase64.trim() !== '') source.zipBase64 = body.zipBase64
      else throw new GameBridgeError('invalid', 'expected { path }（本地游戏包目录）、{ url }（git 源）或 { zipBase64 }（游戏包 zip）')
      const { game } = await service.install(source, body.force === true)
      return sendJson(res, 200, { ok: true, game })
    }

    // ---- POST games/reload：重扫 installed 目录 ----
    if (method === 'POST' && route === 'games/reload') {
      const { games } = await service.reload()
      return sendJson(res, 200, { ok: true, games })
    }

    return notFound()
  } catch (cause) {
    sendError(res, cause)
  }
}
