/**
 * Mod HTTP 面（提案 0015 §3.3 P1 的 api.http.route）：路由挂在
 * `/api/dsh-tavern/mods/<id>/<path>` 下。
 *
 * - path 字符集白名单：`segment(/segment)*`，段为 `[A-Za-z0-9][A-Za-z0-9._-]*`
 *   且拒绝 `.`/`..`——路径穿越在注册与分发两侧都被拒。
 * - 两个出口：`reply.json(body, status?)` 与 `reply.html(doc, csp?)`。html 出口
 *   自动注入标准 CSP meta（对齐美化前端的 CSP 纪律：default-src 'none'、
 *   connect-src 'none'，脚本只允许内联；Mod 取数走服务端，不开放浏览器 fetch）。
 *   mod 可传自定义 csp 策略串（属性转义后注入）。
 * - handler 抛错由分发方（host.ts）兜底成 500 JSON 错误体并记审计，不炸宿主。
 * - 请求体读取与宿主 readJson 同语义（2MB 上限），在适配请求对象上按需惰性读。
 */

export const MOD_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** 管理保留子段：`POST mods/<id>/enable|disable|reload` 是宿主管理路由，先于
 *  子路由分发被截获（index.ts handleModsApi）——这些组合注册了也永远不可达，
 *  fail-fast 拒绝（P1 决策的文档义务落到注册面；`GET ui` 不在此列：那是面板
 *  iframe 表面的约定路径，由 Mod 自行注册，见 mod-api.md §13）。 */
const RESERVED_MOD_SUBROUTE_POST_PATHS = new Set(['enable', 'disable', 'reload'])

/** Mod html 出口的默认 CSP（client/main.js FRONTEND_CSP 的服务端同构纪律）。 */
export const MOD_HTML_DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export interface ModHttpRequest {
  method: string
  /** 注册时的相对 path（不含 mod id 前缀）。 */
  path: string
  query: URLSearchParams
  /** 读请求体 JSON（≤2MB；空体返回 {}）。 */
  json(): Promise<Record<string, unknown>>
}

export interface ModReply {
  /** JSON 出口（默认 200）。 */
  json(body: unknown, status?: number): void
  /** HTML 出口：自动注入 CSP meta；csp 可覆盖默认策略。 */
  html(document: string, csp?: string): void
}

export type ModRouteHandler = (req: ModHttpRequest, reply: ModReply) => void | Promise<void>

export interface ModRouteTable {
  register(method: string, path: string, handler: ModRouteHandler): () => void
  find(method: string, path: string): ModRouteHandler | undefined
  size(): number
}

interface RouteEntry {
  method: string
  path: string
  handler: ModRouteHandler
}

export function createModRouteTable(): ModRouteTable {
  const entries: RouteEntry[] = []
  return {
    register(method, path, handler) {
      const normalizedMethod = String(method ?? '').toUpperCase()
      if (!MOD_HTTP_METHODS.has(normalizedMethod)) {
        throw new Error(`unsupported mod route method '${String(method)}'`)
      }
      if (!isValidModHttpPath(path)) {
        throw new Error(`invalid mod route path '${String(path)}'`)
      }
      if (normalizedMethod === 'POST' && RESERVED_MOD_SUBROUTE_POST_PATHS.has(path)) {
        throw new Error(`mod route POST ${path} is reserved by host management routes`)
      }
      if (typeof handler !== 'function') throw new Error('mod route handler must be a function')
      if (entries.some((entry) => entry.method === normalizedMethod && entry.path === path)) {
        throw new Error(`mod route ${normalizedMethod} ${path} is already registered`)
      }
      entries.push({ method: normalizedMethod, path, handler })
      return () => {
        const index = entries.findIndex((entry) => entry.method === normalizedMethod && entry.path === path && entry.handler === handler)
        if (index >= 0) entries.splice(index, 1)
      }
    },
    find(method, path) {
      const normalizedMethod = String(method ?? '').toUpperCase()
      return entries.find((entry) => entry.method === normalizedMethod && entry.path === path)?.handler
    },
    size: () => entries.length,
  }
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** path 白名单：非空相对路径，段间 `/` 连接；拒绝 `.`/`..` 段与任何穿越形态。 */
export function isValidModHttpPath(path: unknown): boolean {
  if (typeof path !== 'string' || path === '') return false
  if (path.length > 200) return false
  if (path.includes('\\') || path.includes('%')) return false
  if (path.startsWith('/') || path.endsWith('/')) return false
  const segments = path.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment))) return false
  return true
}

export function makeModReply(res: {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: (chunk?: string | Uint8Array) => void
  writableEnded: boolean
}): ModReply {
  return {
    json(body, status = 200) {
      if (res.writableEnded) return
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    },
    html(document, csp) {
      if (res.writableEnded) return
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.end(renderModHtmlDocument(String(document ?? ''), csp ?? MOD_HTML_DEFAULT_CSP))
    },
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

/** 注入 CSP meta：有 <head> 就插在最前，没有就补一个最小骨架。 */
export function renderModHtmlDocument(document: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(document)
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length
    return `${document.slice(0, at)}${meta}${document.slice(at)}`
  }
  if (/<html(?:\s[^>]*)?>/i.test(document)) {
    return document.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${meta}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${document}</body></html>`
}

/** 与 index.ts 的 readJson 同语义的请求体读取（模块独立副本，避免循环 import）。 */
export function readModRequestBody(req: {
  on: (event: string, listener: (chunk?: unknown) => void) => unknown
  destroy?: () => void
}, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      bytes += (chunk as Buffer).length
      if (bytes > maxBytes) {
        reject(new Error(`request exceeds ${maxBytes} bytes`))
        req.destroy?.()
      } else {
        chunks.push(chunk as Buffer)
      }
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}
