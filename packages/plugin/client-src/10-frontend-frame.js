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

    function buildFrontendDocument(value, token, messageId) {
      // window.parent / window.top 在 sandbox（无 same-origin）里是跨域 WindowProxy，
      // 酒馆卡常见的 `window.parent.document` / `window.parent.Mvu` 会直接抛
      // DOMException。注入前统一改指向 shim 暴露的同页 facade；helper 自身与
      // 高度上报脚本在改写之后注入，仍用真实的 parent.postMessage。
      const compatible = String(value || '').trim()
        .replace(/\bwindow\.(?:parent|top)\b/g, 'window.__dshTavernHost')
        // sandbox（无 allow-same-origin）里 localStorage/sessionStorage 直接抛
        // SecurityError；卡表单的自动保存/签名读取没有 try/catch，必须先改到
        // shim 的内存实现，否则整个创角表单初始化中断。
        .replace(/\b(?:window\.)?localStorage\b/g, 'window.__dshTavernStorage')
        .replace(/\b(?:window\.)?sessionStorage\b/g, 'window.__dshTavernSessionStorage')
      const source = rewriteViewportUnits(compatible)
      const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeFrontendAttribute(FRONTEND_CSP)}">`
      const reset = '<style>html,body{margin:0!important;padding:0;max-width:100%;}*,*::before,*::after{box-sizing:border-box;}</style>'
      // 视口脚本进 head（先于 body 样式首帧解析，避免塌陷闪动），reporter 留 body 末
      const viewport = `<script>${frontendViewportScript()}</script>`
      // 酒馆助手兼容层（2026-10-20）：库脚本 + TavernHelper shim 进 head，前端
      // 首帧就能拿到 getVariables/getChatMessages 等同步面；快照由宿主随后投递。
      const helper = `${helperLibraryTags()}<script>${frontendHelperScript(token, messageId)}</script>`
      const reporter = `<script>${frontendHeightReporter(token)}</script>`
      if (/<html(?:\s[^>]*)?>/i.test(source)) {
        let documentText = source
        if (/<head(?:\s[^>]*)?>/i.test(documentText)) {
          documentText = documentText.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${csp}${reset}${viewport}${helper}`)
        } else {
          documentText = documentText.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${csp}${reset}${viewport}${helper}</head>`)
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
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}${reset}${viewport}${helper}${headContent}</head><body>${bodyContent}${reporter}</body></html>`
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

    // 宿主侧代理（2026-10-20）：iframe 内的 TavernHelper shim 发来的 op 一律
    // 追加本会话绑定后转 POST /helper。绑定来自面板/transcript 自己的
    // sessionBindings，iframe 无法自报身份——这是沙箱化 JSR 兼容面的信任边界。
    // 快照比对负责「宿主侧事件」：楼数增加→MESSAGE_RECEIVED，正文变化→
    // MESSAGE_EDITED，聊天切换→CHAT_CHANGED。只广播能真实观测到的信号，
    // 不凭空伪造酒馆事件。
    // 宿主 composer 写入（2026-10-20 卡兼容）：酒馆卡的表单/快速选项通过
    // `window.parent.document.querySelector('#send_textarea')` 写入并触发 input。
    // iframe 没有 same-origin，shim 把这条老路径映射到宿主页里真实可见的
    // textarea，用原生 value setter + input 事件让 React 受控组件收到变更。
    // 自动发送只在 `composer.send` 时尽力而为（回车键），失败则保留已填入文本。
    function hostComposerTextarea() {
      const candidates = [...document.querySelectorAll('textarea')]
        .filter((element) => {
          if (!(element instanceof HTMLTextAreaElement)) return false
          if (element.disabled || element.readOnly) return false
          if (element.closest('[data-dsh-soulmojito-surface]')) return false
          const rect = element.getBoundingClientRect()
          return rect.width > 160 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight
        })
      candidates.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      return candidates[candidates.length - 1] ?? null
    }

    function setHostTextareaValue(element, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter) setter.call(element, value)
      else element.value = value
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }

    async function fillHostComposer(text, submit) {
      const element = hostComposerTextarea()
      if (!element) throw new Error('no visible host composer textarea found')
      setHostTextareaValue(element, text)
      element.focus()
      if (!submit) return { submitted: false }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const form = element.closest('form')
      const submitButton = form?.querySelector('button[type="submit"]')
      if (submitButton instanceof HTMLElement) {
        submitButton.click()
        return { submitted: true }
      }
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }))
      return { submitted: true }
    }

    function useHelperBridge(frameRef, token, binding, refreshKey) {
      const bindingRef = useRef(binding)
      bindingRef.current = binding
      const previousRef = useRef(null)
      useEffect(() => {
        previousRef.current = null
      }, [token])
      useEffect(() => {
        const reply = (payload) => {
          try {
            frameRef.current?.contentWindow?.postMessage({ ...payload, token }, '*')
          } catch {}
        }
        const emitEvent = (event, args) => {
          reply({ type: HELPER_EVENT_MESSAGE, event, args: Array.isArray(args) ? args : [] })
        }
        const diff = (previous, next) => {
          if (!next) return
          if (previous === null) {
            emitEvent(HELPER_IFRAME_EVENTS.APP_READY, [])
            return
          }
          if (previous.chatId !== next.chatId) emitEvent(HELPER_TAVERN_EVENTS.CHAT_CHANGED, [next.chatId])
          const before = Array.isArray(previous.messages) ? previous.messages : []
          const after = Array.isArray(next.messages) ? next.messages : []
          const byId = new Map(before.map((message) => [message.message_id, message]))
          for (const message of after) {
            const old = byId.get(message.message_id)
            if (old === undefined) {
              emitEvent(message.role === 'user' ? HELPER_TAVERN_EVENTS.MESSAGE_SENT : HELPER_TAVERN_EVENTS.MESSAGE_RECEIVED, [message.message_id])
              continue
            }
            if (old.message !== message.message || old.name !== message.name) {
              emitEvent(HELPER_TAVERN_EVENTS.MESSAGE_EDITED, [message.message_id])
            }
          }
          const removed = before.filter((message) => !after.some((entry) => entry.message_id === message.message_id))
          if (removed.length > 0) emitEvent(HELPER_TAVERN_EVENTS.MESSAGE_DELETED, [removed[0].message_id])
        }
        const postSnapshot = () => {
          const current = bindingRef.current
          if (!current) return
          void api('helper', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ op: 'snapshot', character: current.character, chatId: current.chatId }),
          }).then((result) => {
            const snapshot = result.value
            reply({ type: HELPER_SNAPSHOT_MESSAGE, snapshot })
            diff(previousRef.current, snapshot)
            previousRef.current = snapshot
          }).catch(() => {})
        }
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== HELPER_MESSAGE || data.token !== token) return
          if (event.source !== frameRef.current?.contentWindow) return
          const current = bindingRef.current
          const fail = (message) => reply({ type: HELPER_RESULT_MESSAGE, id: data.id, ok: false, message })
          if (!current) {
            fail('this frontend is not bound to a Tavern chat')
            return
          }
          if (data.op === 'composer.fill' || data.op === 'composer.send') {
            const text = typeof data.payload?.text === 'string' ? data.payload.text : ''
            void fillHostComposer(text, data.op === 'composer.send')
              .then((value) => reply({ type: HELPER_RESULT_MESSAGE, id: data.id, ok: true, value }))
              .catch((cause) => fail(cause instanceof Error ? cause.message : String(cause)))
            return
          }
          void api('helper', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
              op: data.op,
              character: current.character,
              chatId: current.chatId,
              ...(data.payload && typeof data.payload === 'object' ? data.payload : {}),
            }),
          }).then((result) => {
            reply({ type: HELPER_RESULT_MESSAGE, id: data.id, ok: true, value: result.value })
            // 状态已变：重投快照（并据比对广播事件），让前端后续同步读取拿到新值。
            if (data.op === 'variables.replace' || String(data.op).startsWith('messages.') || data.op === 'slash') {
              postSnapshot()
            }
          }).catch((cause) => {
            fail(cause instanceof Error ? cause.message : String(cause))
          })
        }
        addEventListener('message', onMessage)
        emitEvent(HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED, [token])
        postSnapshot()
        return () => {
          removeEventListener('message', onMessage)
          emitEvent(HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_ENDED, [token])
        }
      }, [token, refreshKey])
      return undefined
    }

    function FrontendFrame({ html, token, binding, refreshKey, messageId }) {
      const frameRef = useRef(null)
      const [height, setHeight] = useState(120)
      const postViewport = useViewportBridge(frameRef)
      useHelperBridge(frameRef, token, binding, refreshKey)
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
        srcDoc: buildFrontendDocument(html, token, typeof messageId === 'number' ? messageId : -1),
        onLoad: postViewport,
        style: { height },
      })
    }
