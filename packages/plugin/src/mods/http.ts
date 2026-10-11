/**
 * Mod HTTP 面（提案 0015 §3.3 P1 的 api.http.route）：路由挂在
 * `/api/dsh-tavern/mods/<id>/<path>` 下。
 *
 * - path 字符集白名单：`segment(/segment)*`，段为 `[A-Za-z0-9][A-Za-z0-9._-]*`
 *   且拒绝 `.`/`..`——路径穿越在注册与分发两侧都被拒。
 * - 两个出口：`reply.json(body, status?)` 与 `reply.html(doc, csp?)`。html 出口
 *   自动注入标准 CSP meta（对齐美化前端的 CSP 纪律：default-src 'none'、
 *   connect-src 'none'，脚本只允许内联；Mod 取数走服务端，不开放浏览器 fetch）
 *   + console reporter（A-2）+ 视口变量脚本与高度上报器（A-4，见
 *   renderModHtmlDocument）。mod 可传自定义 csp 策略串（属性转义后注入）。
 * - handler 抛错由分发方（host.ts）兜底成 500 JSON 错误体并记审计，不炸宿主。
 * - 请求体读取与宿主 readJson 同语义（2MB 上限），在适配请求对象上按需惰性读。
 */

export const MOD_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** 管理保留子段：`POST mods/<id>/enable|disable|reload` 是宿主管理路由，先于
 *  子路由分发被截获（index.ts handleModsApi）——这些组合注册了也永远不可达，
 *  fail-fast 拒绝（P1 决策的文档义务落到注册面；`GET ui` 不在此列：那是面板
 *  iframe 表面的约定路径，由 Mod 自行注册，见 mod-api.md §13）。
 *  A-1（2026-10-11）追加：`POST button` 与 `POST button/<name>` 是宿主按钮分发
 *  路由（`POST mods/<id>/button/<name>`，name 为 URL 解码后的按钮显示名），
 *  同样先于子路由分发被截获——整段保留，注册即抛。 */
const RESERVED_MOD_SUBROUTE_POST_PATHS = new Set(['enable', 'disable', 'reload'])

/** POST 保留段判定：精确管理名 + button 整段（`button` 与 `button/<name>` 前缀）。 */
export function isReservedModSubroutePostPath(path: string): boolean {
  return RESERVED_MOD_SUBROUTE_POST_PATHS.has(path) || path === 'button' || path.startsWith('button/')
}

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
      if (normalizedMethod === 'POST' && isReservedModSubroutePostPath(path)) {
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

/**
 * Console reporter（A-2，JSR §2.5 的错误呈现三件套之 iframe 侧）：注入所有
 * mod HTML 出口，把 mod UI 的 console 输出与全局错误经 token 对账的
 * postMessage 回投父页（`dsh-tavern:mod-log`）。约束：
 * - token 从 iframe URL 查询段自读（服务端不掌握挂载期 token），无 token 静默
 *   跳过（非 iframe 场景 / 直接 curl 该路由都不产生消息）；
 * - 单条文本截断 ~2KB（防刷爆父页缓冲）；args 序列化失败退 String()；
 * - 只 wrap 不改语义：原 console 方法照常调用（mod UI 在 iframe 控制台里仍
 *   可见自己的输出）。
 */
export const MOD_LOG_MESSAGE = 'dsh-tavern:mod-log'
const MOD_LOG_TEXT_LIMIT = 2048

export function modConsoleReporterScript(): string {
  return `(function () {
  var token = '';
  try { token = new URLSearchParams(location.search).get('token') || ''; } catch (_) { return; }
  if (token === '') return;
  var send = function (level, text) {
    try {
      parent.postMessage({ type: ${JSON.stringify(MOD_LOG_MESSAGE)}, token: token, level: level, text: String(text).slice(0, ${MOD_LOG_TEXT_LIMIT}) }, '*');
    } catch (_) {}
  };
  var format = function (args) {
    var parts = [];
    for (var index = 0; index < args.length; index += 1) {
      var value = args[index];
      if (typeof value === 'string') parts.push(value);
      else { try { parts.push(JSON.stringify(value)); } catch (_) { parts.push(String(value)); } }
    }
    return parts.join(' ');
  };
  ['log', 'warn', 'error'].forEach(function (level) {
    var original = typeof console[level] === 'function' ? console[level].bind(console) : function () {};
    console[level] = function () { original.apply(null, arguments); send(level, format(arguments)); };
  });
  addEventListener('error', function (event) {
    var at = event.filename ? ' @ ' + event.filename + ':' + event.lineno : '';
    send('error', (event.message || 'script error') + at);
  });
  addEventListener('unhandledrejection', function (event) {
    send('error', 'unhandled rejection: ' + format([event.reason]));
  });
})();`
}

/**
 * ── 视口正确性与高度上报（A-4，2026-10-11）──────────────────────────────
 * 与 client/main.js 同构同款（该文件是独立拼接的 client half，无法共享模块——
 * 与 FRONTEND_CSP / MOD_HTML_DEFAULT_CSP 的双份纪律一致）。
 *
 * 问题：面板 iframe 高度由内容 ResizeObserver 决定（宿主按上报高度调 iframe），
 * mod UI 写 height:100vh 时 vh = 当前 iframe 高度 = 上次内容高度 → 循环依赖，
 * 预期"可视区高度"的布局会塌。方案分两半：
 * 1. renderModHtmlDocument 注入前把 100 系列视口高度单位改写成
 *    var(--dt-viewport-height, 100vh)（rewriteViewportUnits）；
 * 2. 注入 modViewportScript 把宿主可视区高度挂到该变量——宿主（ModSurface）在
 *    load/resize 时经 `dsh-tavern:viewport` postMessage 投递 {height}（宿主→iframe
 *    单向下行，与 mod-response 同向，不新增鉴权面：iframe 只读数值挂 CSS 变量，
 *    不回传不取数，伪造消息最多扰动沙箱内自身布局，无 token 对账必要）。
 *
 * 改写边界（宁缺勿滥，漏掉的由 fallback 100vh 兜底=旧行为）：
 * - 只改 <style> 块与内联 style="…" 两形态；<script> 块整体屏蔽（JS 字符串/
 *   模板里的 style="…" 与 '100vh' 不是 CSS，正则无解析器，宁缺勿滥）；
 * - 只改 100vh/100dvh/100svh/100lvh（含大小写）；非 100 数值不改（需 calc 乘法
 *   形态，语义变更面大）；
 * - 注释与字符串字面量里的 100vh 原样保留（content:"100vh" 是显示文本）。
 */
export const MOD_VIEWPORT_MESSAGE = 'dsh-tavern:viewport'
const MOD_VIEWPORT_CSS_VAR = '--dt-viewport-height'
const VIEWPORT_UNIT_PATTERN = /(?<![-\w])100(?:d|s|l)?vh(?![\w-])/gi
const VIEWPORT_VAR_REFERENCE = `var(${MOD_VIEWPORT_CSS_VAR}, 100vh)`

/** 单段 CSS 文本内的改写：跳过块注释与单/双引号字符串字面量里的出现。 */
export function rewriteViewportUnitsInCssText(cssText: string): string {
  const special = /\/\*|["']/g
  let out = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = special.exec(cssText)) !== null) {
    out += cssText.slice(cursor, match.index).replace(VIEWPORT_UNIT_PATTERN, VIEWPORT_VAR_REFERENCE)
    const end = match[0] === '/*'
      ? cssText.indexOf('*/', match.index + 2)
      : cssText.indexOf(match[0], match.index + 1)
    cursor = end === -1 ? cssText.length : end + (match[0] === '/*' ? 2 : 1)
    out += cssText.slice(match.index, cursor)
    special.lastIndex = cursor
  }
  return out + cssText.slice(cursor).replace(VIEWPORT_UNIT_PATTERN, VIEWPORT_VAR_REFERENCE)
}

/** vh 改写入口：<style> 块与内联 style 属性两形态（边界见上方块注释）。 */
export function rewriteViewportUnits(document: string): string {
  // 先屏蔽 <script> 块：JS 字符串/模板里的 style="…" 不是 HTML 属性，改写会动到
  // JS 字面量；占位符不含引号与尖括号，不会被下面两条正则触碰。
  const scripts: string[] = []
  const shielded = String(document || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (whole) => {
    scripts.push(whole)
    return `\u0000dt-vh-script-${scripts.length - 1}\u0000`
  })
  const rewritten = shielded
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_whole, open: string, css: string, close: string) => `${open}${rewriteViewportUnitsInCssText(css)}${close}`)
    .replace(/(\bstyle\s*=\s*)(["'])([^"']*)\2/gi, (_whole, prefix: string, quote: string, css: string) => `${prefix}${quote}${rewriteViewportUnitsInCssText(css)}${quote}`)
  return rewritten.replace(/\u0000dt-vh-script-(\d+)\u0000/g, (_whole, index: string) => scripts[Number(index)])
}

/** 视口变量脚本：初始化用 iframe 自身 innerHeight（宿主 load 投递后即刻纠正）。 */
export function modViewportScript(): string {
  return `(function () {
  var root = document.documentElement;
  var apply = function (height) {
    if (typeof height !== 'number' || !isFinite(height) || height <= 0) return;
    try { root.style.setProperty(${JSON.stringify(MOD_VIEWPORT_CSS_VAR)}, height + 'px'); } catch (_) {}
  };
  apply(window.innerHeight);
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(MOD_VIEWPORT_MESSAGE)}) return;
    apply(data.height);
  });
})();`
}

/**
 * 高度上报器（A-4，client frontendHeightReporter 的服务端同款）：rAF 单帧合并 +
 * 高度去重 + 500ms 尾随重测兜底 + ResizeObserver 双观察（documentElement 与 body，
 * head 期 body 未建，DOMContentLoaded 再补挂）+ 保留 load/resize 触发。token 从
 * iframe URL 查询段自读（与 console reporter 同纪律），无 token 静默跳过——直接
 * curl 该路由不产生消息。mod UI 自带上报脚本（mood-tracker 样板）照旧兼容：同
 * token 同协议重复上报在宿主侧幂等（钳制后的 setHeight）。
 */
export function modHeightReporterScript(): string {
  return `(function () {
  var token = '';
  try { token = new URLSearchParams(location.search).get('token') || ''; } catch (_) { return; }
  if (token === '') return;
  var last = -1;
  var queued = false;
  var measure = function () {
    if (queued) return;
    queued = true;
    var flush = function () {
      queued = false;
      var root = document.documentElement;
      var body = document.body;
      var height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
      if (height <= 0 || height === last) return;
      last = height;
      try {
        parent.postMessage({ type: 'dsh-tavern:frontend-height', token: token, height: height }, '*');
      } catch (_) {}
      setTimeout(measure, 500);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush); else setTimeout(flush, 0);
  };
  var wire = function () {
    if (typeof ResizeObserver !== 'function') return;
    var observer = new ResizeObserver(measure);
    if (document.documentElement) observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  };
  wire();
  addEventListener('DOMContentLoaded', wire);
  addEventListener('load', measure);
  addEventListener('resize', measure);
  setTimeout(measure, 0);
})();`
}

/** 注入 CSP meta、console reporter、视口脚本与高度上报器（vh 改写先行）：有 <head>
 *  就插在最前，没有就补一个最小骨架。 */
export function renderModHtmlDocument(document: string, csp: string): string {
  const rewritten = rewriteViewportUnits(String(document ?? ''))
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`
  const scripts = `<script>${modConsoleReporterScript()}</script><script>${modViewportScript()}</script><script>${modHeightReporterScript()}</script>`
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(rewritten)
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length
    return `${rewritten.slice(0, at)}${meta}${scripts}${rewritten.slice(at)}`
  }
  if (/<html(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${meta}${scripts}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}${scripts}</head><body>${rewritten}</body></html>`
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
