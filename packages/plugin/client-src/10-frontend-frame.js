    // ── 视口正确性（A-4，2026-10-11）──────────────────────────────────────
    // 问题：iframe 高度由内容 ResizeObserver 决定（宿主按上报高度调 iframe），内容
    // 里写 height:100vh 时 vh = 当前 iframe 高度 = 上次内容高度 → 循环依赖，前端
    // 作者预期"可视区高度"的布局会塌。方案：注入前把 100 系列视口高度单位改写成
    // var(--dt-viewport-height, 100vh)，由注入脚本把宿主可视区高度挂到该变量（见
    // frontendViewportScript），宿主 load/resize 时投递更新（见 useViewportBridge）。
    // 改写边界（宁缺勿滥，漏掉的由 fallback 100vh 兜底=旧行为）：
    // - 只改 <style> 块与内联 style="…" 两形态；<script> 块整体屏蔽（JS 字符串/
    //   模板里的 style="…" 与 '100vh' 不是 CSS，正则无解析器，宁缺勿滥）；
    // - 只改 100vh/100dvh/100svh/100lvh（含大小写）；非 100 数值（50vh/33.3vh）不改
    //   ——改写它们需 calc(var(...) * 0.5) 乘法形态，语义变更面大；
    // - 注释与字符串字面量里的 100vh 原样保留（content:"100vh" 是显示文本）。
    // 服务端 mod HTML 出口（src/mods/http.ts renderModHtmlDocument）同构同款。
    const VIEWPORT_MESSAGE = 'dsh-soulmojito:viewport'
    const VIEWPORT_CSS_VAR = '--dt-viewport-height'
    const VIEWPORT_UNIT_PATTERN = /(?<![-\w])100(?:d|s|l)?vh(?![\w-])/gi
    const VIEWPORT_VAR_REFERENCE = `var(${VIEWPORT_CSS_VAR}, 100vh)`

    function rewriteViewportUnitsInCssText(cssText) {
      // 跳过 /* … */ 注释与 "…"/'…' 字符串字面量，只改写普通区段
      const special = /\/\*|["']/g
      let out = ''
      let cursor = 0
      let match
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

    function rewriteViewportUnits(value) {
      // 先屏蔽 <script> 块：JS 字符串/模板里的 style="…" 不是 HTML 属性，改写会动
      // 到 JS 字面量；占位符不含引号与尖括号，不会被下面两条正则触碰。
      const scripts = []
      const shielded = String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (whole) => {
        scripts.push(whole)
        return `\u0000dt-vh-script-${scripts.length - 1}\u0000`
      })
      const rewritten = shielded
        .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (whole, open, css, close) => `${open}${rewriteViewportUnitsInCssText(css)}${close}`)
        .replace(/(\bstyle\s*=\s*)(["'])([^"']*)\2/gi, (whole, prefix, quote, css) => `${prefix}${quote}${rewriteViewportUnitsInCssText(css)}${quote}`)
      return rewritten.replace(/\u0000dt-vh-script-(\d+)\u0000/g, (whole, index) => scripts[Number(index)])
    }

    function isFrontendDocument(value) {
      const text = String(value || '')
      return /<!doctype\s+html\b/i.test(text)
        || (/<html(?:\s[^>]*)?>/i.test(text) && /<(?:head|body)(?:\s[^>]*)?>/i.test(text))
        || /<(?:head|body)(?:\s[^>]*)?>/i.test(text)
    }

    function extractFrontendDocuments(value) {
      const text = String(value || '')
      const documents = []
      const fenced = /```[^\n]*\n([\s\S]*?)```/gi
      let match
      while ((match = fenced.exec(text)) !== null) {
        const candidate = match[1].trim()
        if (isFrontendDocument(candidate)) documents.push(candidate)
      }
      if (documents.length > 0) return documents
      const raw = text.trim()
      return isFrontendDocument(raw) ? [raw] : []
    }

    // 高度上报（A-4 升级，JSR §2.1 adjust_iframe_height 的语义复刻）：
    // - rAF 单帧合并：同一帧内 ResizeObserver 连发只测一次发一次；
    // - 高度去重：数值未变化零消息（宿主 setHeight 幂等，但少发少渲染）；
    // - 500ms 尾随重测兜底：字体晚到/图片解码/沙箱里观察器偶发漏报的收尾——
    //   只在有变化发过消息后排一次，未变化不发消息，无周期轮询；
    // - ResizeObserver 同时观察 documentElement 与 body（html 定高时 body 仍可感知）
    //   ——本脚本注入在 body 末尾，两节点都在场；保留 load/resize 触发。
    // 服务端 mod HTML 出口（http.ts modHeightReporterScript）同构同款（token 自读）。
    function frontendHeightReporter(token) {
      const serializedToken = JSON.stringify(token)
      return `(function () {
  var token = ${serializedToken};
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
        parent.postMessage({ type: ${JSON.stringify(FRONTEND_HEIGHT_MESSAGE)}, token: token, height: height }, '*');
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

    // 视口变量脚本（A-4）：把 --dt-viewport-height 挂到 documentElement，供改写后的
    // var(--dt-viewport-height, 100vh) 消费。初始化用 iframe 自身 innerHeight（此刻
    // = iframe 当前高度，仍是坏值，但优于未定义；宿主 load 时投递真实可视区高度即刻
    // 纠正）。消息方向宿主→iframe 单向下行：iframe 只读数值挂 CSS 变量，不回传不
    // 取数——伪造消息最多扰动沙箱内自身布局，无 token 对账必要（决策记录
    // decisions/2026-10-11-iframe-viewport.md 的安全判断）。
    function frontendViewportScript() {
      return `(function () {
  var root = document.documentElement;
  var apply = function (height) {
    if (typeof height !== 'number' || !isFinite(height) || height <= 0) return;
    try { root.style.setProperty(${JSON.stringify(VIEWPORT_CSS_VAR)}, height + 'px'); } catch (_) {}
  };
  apply(window.innerHeight);
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(VIEWPORT_MESSAGE)}) return;
    apply(data.height);
  });
})();`
    }

    function buildFrontendDocument(value, token) {
      const source = rewriteViewportUnits(String(value || '').trim())
      const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeFrontendAttribute(FRONTEND_CSP)}">`
      const reset = '<style>html,body{margin:0!important;padding:0;max-width:100%;}*,*::before,*::after{box-sizing:border-box;}</style>'
      // 视口脚本进 head（先于 body 样式首帧解析，避免塌陷闪动），reporter 留 body 末
      const viewport = `<script>${frontendViewportScript()}</script>`
      const reporter = `<script>${frontendHeightReporter(token)}</script>`
      if (/<html(?:\s[^>]*)?>/i.test(source)) {
        let documentText = source
        if (/<head(?:\s[^>]*)?>/i.test(documentText)) {
          documentText = documentText.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${csp}${reset}${viewport}`)
        } else {
          documentText = documentText.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${csp}${reset}${viewport}</head>`)
        }
        if (/<\/body\s*>/i.test(documentText)) {
          return documentText.replace(/<\/body\s*>/i, `${reporter}</body>`)
        }
        if (/<\/html\s*>/i.test(documentText)) {
          return documentText.replace(/<\/html\s*>/i, `${reporter}</html>`)
        }
        return `${documentText}${reporter}`
      }
      const headMatch = /<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/i.exec(source)
      const bodyMatch = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body\s*>/i.exec(source)
      const headContent = headMatch ? headMatch[1] : ''
      const bodyContent = bodyMatch ? bodyMatch[1] : source
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}${reset}${viewport}${headContent}</head><body>${bodyContent}${reporter}</body></html>`
    }

    // 宿主→iframe 视口投递（A-4）：iframe 的 --dt-viewport-height 需要"真实可视区
    // 高度"（宿主 window.innerHeight）。load 时投递（注入脚本在 head 解析期同步执行，
    // load 事件时监听器必已就绪），window resize 跟随。与 mod-response 同向（宿主→
    // iframe），不新增鉴权面。
    function useViewportBridge(frameRef) {
      const post = useCallback(() => {
        const height = window.innerHeight
        if (typeof height !== 'number' || !Number.isFinite(height)) return
        try { frameRef.current?.contentWindow?.postMessage({ type: VIEWPORT_MESSAGE, height }, '*') } catch {}
      }, [])
      useEffect(() => {
        addEventListener('resize', post)
        return () => removeEventListener('resize', post)
      }, [post])
      return post
    }

    function FrontendFrame({ html, token }) {
      const frameRef = useRef(null)
      const [height, setHeight] = useState(120)
      const postViewport = useViewportBridge(frameRef)
      useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== FRONTEND_HEIGHT_MESSAGE || data.token !== token) return
          if (event.source !== frameRef.current?.contentWindow) return
          if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
          setHeight(Math.max(80, Math.min(Math.ceil(data.height), 1200)))
        }
        addEventListener('message', onMessage)
        return () => removeEventListener('message', onMessage)
      }, [token])
      return h('iframe', {
        ref: frameRef,
        className: 'dt-frontend-frame',
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        title: 'Tavern frontend',
        srcDoc: buildFrontendDocument(html, token),
        onLoad: postViewport,
        style: { height },
      })
    }
