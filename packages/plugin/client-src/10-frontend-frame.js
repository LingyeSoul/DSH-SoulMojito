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
    const FRONTEND_BACKGROUND_CSS_VAR = '--dt-host-background'
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

    // Default canvas background (2026-10-21 user request): when a card sets no
    // background, the iframe canvas must be filled with the DSH native background
    // color instead of the browser's default white (a white ring in dark mode).
    // Transparent srcdoc/sandbox iframes are not reliable across host webviews
    // (the same document can still paint white), so this does not rely on
    // transparency: the host resolves --dsw-alias-bg-base to a concrete color,
    // injects it with the srcdoc, and updates --dt-host-background on html via
    // postMessage on theme changes. The card's own html/body background still
    // wins by cascade because the reset rule comes first.
    function normalizeFrontendBackground(value) {
      const color = String(value || '').trim()
      // Accept only browser-serialized color forms; reject characters that could
      // escape the declaration.
      if (!/^[\w#().,%\s/+-]+$/.test(color)) return ''
      if (/^(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)$/i.test(color)) return color
      if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
      if (/^[a-z]+$/i.test(color)) return color
      return ''
    }

    function isUsableFrontendBackground(color) {
      return color !== '' && color !== 'transparent' && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/i.test(color)
    }

    function frontendHostBackgroundColor() {
      try {
        const body = document.body
        if (body) {
          const style = getComputedStyle(body)
          // Custom properties inherit and resolve var() substitution (Chrome
          // returns the final color for --alias:var(--x)); read the DSH theme
          // alias first, then body's computed background. No probe node, so a
          // render-time call cannot trigger host DOM observers.
          const alias = normalizeFrontendBackground(style.getPropertyValue('--dsw-alias-bg-base'))
          if (isUsableFrontendBackground(alias)) return alias
          const background = normalizeFrontendBackground(style.backgroundColor)
          if (isUsableFrontendBackground(background)) return background
        }
      } catch {}
      const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        || (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
      return dark ? '#151517' : '#ffffff'
    }

    function frontendThemeScript() {
      return `(function () {
  var root = document.documentElement;
  var apply = function (color) {
    if (typeof color !== 'string' || color === '') return;
    try { root.style.setProperty(${JSON.stringify(FRONTEND_BACKGROUND_CSS_VAR)}, color); } catch (_) {}
  };
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(FRONTEND_THEME_MESSAGE)}) return;
    apply(data.background);
  });
})();`
    }

    // Host-to-iframe theme color delivery: same direction as the viewport
    // message, no token (it can only change the sandbox's own canvas). It also
    // watches the body/html theme attributes and prefers-color-scheme so a
    // system-following theme updates without rebuilding the srcdoc.
    function useThemeBridge(frameRef) {
      const post = useCallback(() => {
        try {
          frameRef.current?.contentWindow?.postMessage({
            type: FRONTEND_THEME_MESSAGE,
            background: frontendHostBackgroundColor(),
          }, '*')
        } catch {}
      }, [])
      useEffect(() => {
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(post) : null
        if (observer) {
          const filter = { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'style'] }
          if (document.body) observer.observe(document.body, filter)
          observer.observe(document.documentElement, filter)
        }
        const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
        media?.addEventListener?.('change', post)
        return () => {
          observer?.disconnect()
          media?.removeEventListener?.('change', post)
        }
      }, [post])
      return post
    }

    function buildFrontendDocument(value, token, messageId, allowExternalResources, hostBackground) {
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
      const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeFrontendAttribute(frontendContentSecurityPolicy(allowExternalResources))}">`
      const hostColor = normalizeFrontendBackground(hostBackground) || frontendHostBackgroundColor()
      // Default canvas: the concrete DSH native background (not transparent).
      // Transparent iframes are inconsistent across webviews, so paint over the
      // white explicitly. html uses a variable updated by frontendThemeScript on
      // theme changes; body stays transparent so the card keeps its own canvas.
      // The card's html/body background still wins because the reset comes first.
      const reset = `<style>:root{--dt-host-background:${hostColor};}html{background:var(--dt-host-background)}body{margin:0!important;padding:0;max-width:100%;background:transparent;}*,*::before,*::after{box-sizing:border-box;}</style>`
      // 视口脚本进 head（先于 body 样式首帧解析，避免塌陷闪动），reporter 留 body 末
      const viewport = `<script>${frontendViewportScript()}</script>`
      const theme = `<script>${frontendThemeScript()}</script>`
      // 酒馆助手兼容层（2026-10-20）：库脚本 + TavernHelper shim 进 head，前端
      // 首帧就能拿到 getVariables/getChatMessages 等同步面；快照由宿主随后投递。
      const helper = `${helperLibraryTags()}<script>${frontendHelperScript(token, messageId)}</script>`
      const reporter = `<script>${frontendHeightReporter(token)}</script>`
      if (/<html(?:\s[^>]*)?>/i.test(source)) {
        let documentText = source
        if (/<head(?:\s[^>]*)?>/i.test(documentText)) {
          documentText = documentText.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${csp}${reset}${viewport}${theme}${helper}`)
        } else {
          documentText = documentText.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${csp}${reset}${viewport}${theme}${helper}</head>`)
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
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}${reset}${viewport}${theme}${helper}${headContent}</head><body>${bodyContent}${reporter}</body></html>`
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
    // 宿主 composer 写入（2026-10-20 卡兼容；2026-10-21 二次修订）：酒馆卡的表单/
    // 快速选项通过 `window.parent.document.querySelector('#send_textarea')` 写入并
    // 触发 input。iframe 没有 same-origin，shim 把这条老路径映射到宿主的真实输入面。
    //
    // 两种宿主输入面：
    // - ST 架构用插件自己的 textarea（`[data-dsh-soulmojito-surface="composer"]`）；
    // - AgentTavern 的原生输入框是 Lexical contenteditable（`[data-composer-input]`），
    //   没有 textarea。自动发送不再模拟键盘，直接走宿主 conversation service，
    //   与插件插入消息同一条通道（用户 2026-10-21 要求）。
    function hostComposerInput() {
      const pluginComposer = document.querySelector('[data-dsh-soulmojito-surface="composer"] textarea')
      if (pluginComposer instanceof HTMLTextAreaElement
        && !pluginComposer.disabled && !pluginComposer.readOnly && isVisibleElement(pluginComposer)) {
        return pluginComposer
      }
      const candidates = [...document.querySelectorAll('textarea')]
        .filter((element) => {
          if (!(element instanceof HTMLTextAreaElement)) return false
          if (element.disabled || element.readOnly) return false
          if (element.closest('[data-dsh-soulmojito-surface]')) return false
          const rect = element.getBoundingClientRect()
          return rect.width > 160 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight
        })
      candidates.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      if (candidates.length > 0) return candidates[candidates.length - 1]
      const editable = [...document.querySelectorAll('[data-composer-input][contenteditable="true"]')]
        .find((element) => isVisibleElement(element))
      return editable instanceof HTMLElement ? editable : null
    }

    function isVisibleElement(element) {
      if (!(element instanceof HTMLElement) || element.hidden) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    }

    function setHostTextareaValue(element, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter) setter.call(element, value)
      else element.value = value
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // Lexical 只在可信输入事件里同步编辑模型；execCommand 会触发 beforeinput/
    // input，比直接改 textContent 更接近真键盘输入。
    function setHostEditableValue(element, value) {
      element.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
      if (!document.execCommand('insertText', false, value)) {
        throw new Error('host composer rejected text insertion')
      }
    }

    function clearHostComposer(element) {
      if (element instanceof HTMLTextAreaElement) {
        setHostTextareaValue(element, '')
        return
      }
      element.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
      document.execCommand('delete')
    }

    function submitHostComposer(element) {
      const form = element.closest('form')
      const submitButton = form?.querySelector('button[type="submit"]')
      if (submitButton instanceof HTMLElement && !submitButton.disabled) {
        submitButton.click()
        return
      }
      const surface = element.closest('[data-dsh-soulmojito-surface="composer"]')
      const sendButton = surface?.querySelector('button.dt-primary-icon:not(:disabled)')
      if (sendButton instanceof HTMLElement) {
        sendButton.click()
        return
      }
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }))
    }

    // AgentTavern 的原生发送面：`ctx.sessions.scope(id).get('conversation')` 返回
    // 按会话作用域跟踪的 Conversation 服务（cordis traceable proxy 会把 service.ctx
    // 切到调用方 scope）。`send(text)` 走宿主 prompt admission，等价于原生 composer
    // 回车，但不依赖编辑器 DOM。
    function hostConversation(hostSessionId) {
      if (typeof hostSessionId !== 'string' || hostSessionId === '') return undefined
      try {
        const sessions = PanelHost.context?.get?.('sessions')
        const scoped = sessions?.scope?.(hostSessionId)
        const conversation = scoped?.get?.('conversation')
        return conversation && typeof conversation.send === 'function' ? conversation : undefined
      } catch {
        return undefined
      }
    }

    function fillComposerElement(element, value) {
      if (element instanceof HTMLTextAreaElement) setHostTextareaValue(element, value)
      else setHostEditableValue(element, value)
    }

    // 判断当前草稿是否就是本次要发送的文本（空白无关 + 前缀指纹）。用于清掉
    // 旧失败尝试或作用域晚 materialize 时残留在原生输入框里的同一份 YAML；
    // 不碰用户自己的无关草稿。
    function composerHolds(element, text) {
      const current = (element instanceof HTMLTextAreaElement
        ? element.value
        : (element.innerText ?? element.textContent ?? '')).replace(/\s+/g, '')
      const expected = text.replace(/\s+/g, '')
      const head = expected.slice(0, 64)
      return head !== '' && current.includes(head)
    }

    async function fillHostComposer(text, submit, hostSessionId, draft) {
      const conversation = hostConversation(hostSessionId)
      // AgentTavern 直投模式（用户 2026-10-21）：不碰原生编辑器——composer.fill
      // 只确认"发送将由随后的 composer.send 一次完成"，草稿不会出现在输入框里。
      // 这与游戏桥自动续弈同一条插件直投语义，也避免 Lexical 草稿清理残留。
      if (conversation !== undefined) {
        if (submit) {
          await conversation.send(text)
          // 旧尝试/晚 materialize 的残留：只清内容仍是本次文本的草稿。
          const target = draft.text === text
            ? (draft.element?.isConnected ? draft.element : hostComposerInput())
            : hostComposerInput()
          if (target !== null && composerHolds(target, text)) clearHostComposer(target)
          draft.element = null
          draft.text = ''
          return { submitted: true, via: 'conversation' }
        }
        return { submitted: false, deferred: true }
      }
      const element = hostComposerInput()
      if (element === null) throw new Error('no visible host composer found')
      fillComposerElement(element, text)
      element.focus()
      if (!submit) {
        draft.element = element
        draft.text = text
        return { submitted: false }
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      submitHostComposer(element)
      // 合成提交可能绕过原生 draft 清理（Lexical 的受控草稿在 click/Enter
      // 之后仍可能保留），显式清一次。
      clearHostComposer(element)
      draft.element = null
      draft.text = ''
      return { submitted: true }
    }

    // 卡前端的 `window.frameElement.style`（2026-10-21）：ST 同源 iframe 里卡可以
    // 直接改自己的 iframe（隐藏战术栏 / 按内容设高）；沙箱里只拿到 shim，转成
    // `frame.prefs` 后由宿主落到真实元素。height 用 !important，避免被
    // FrontendFrame 的高度状态覆盖；侧栏里 iframe 是独子时连外框一起收起，
    // 不留空白卡片。
    function applyFramePrefs(frame, prefs) {
      const wrapper = frame.parentElement && frame.parentElement.children.length === 1
        ? frame.parentElement
        : null
      if (prefs.hidden === true) {
        frame.style.setProperty('display', 'none', 'important')
        if (wrapper) wrapper.style.setProperty('display', 'none', 'important')
        return
      }
      frame.style.removeProperty('display')
      if (wrapper) wrapper.style.removeProperty('display')
      if (typeof prefs.height === 'number' && Number.isFinite(prefs.height) && prefs.height > 0) {
        frame.style.setProperty('height', `${Math.min(Math.max(Math.ceil(prefs.height), 1), 1200)}px`, 'important')
      } else {
        frame.style.removeProperty('height')
      }
    }

    function useHelperBridge(frameRef, token, binding, refreshKey, hostSessionId) {
      const bindingRef = useRef(binding)
      bindingRef.current = binding
      const previousRef = useRef(null)
      const composerDraftRef = useRef({ element: null, text: '' })
      const composerChainRef = useRef(Promise.resolve())
      useEffect(() => {
        previousRef.current = null
        composerDraftRef.current = { element: null, text: '' }
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
        // composer.fill 与 composer.send 由卡前端成对调用（同一 tick）。串行化
        // 保证直投模式 send 在 fill 的确认之后、DOM 降级路径 fill 先落地；链与
        // 草稿记录都放在 hook ref 上，副作用重跑（轮询刷新）不丢顺序。
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
            composerChainRef.current = composerChainRef.current
              .catch(() => {})
              .then(() => fillHostComposer(text, data.op === 'composer.send', hostSessionId, composerDraftRef.current))
              .then((value) => reply({ type: HELPER_RESULT_MESSAGE, id: data.id, ok: true, value }))
              .catch((cause) => fail(cause instanceof Error ? cause.message : String(cause)))
            return
          }
          if (data.op === 'frame.prefs') {
            const frame = frameRef.current
            if (frame) {
              applyFramePrefs(frame, data.payload && typeof data.payload === 'object' ? data.payload : {})
            }
            reply({ type: HELPER_RESULT_MESSAGE, id: data.id, ok: true, value: { applied: frame !== null } })
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
        // iframe 每次加载完成后再推一次：srcdoc 的 CDN 外链会推迟 shim 的执行，
        // 挂载时那一次推送可能早于 shim 的监听器而丢失（2026-10-21 状态栏空态）。
        const frame = frameRef.current
        const onFrameLoad = () => postSnapshot()
        frame?.addEventListener('load', onFrameLoad)
        emitEvent(HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED, [token])
        postSnapshot()
        return () => {
          frame?.removeEventListener('load', onFrameLoad)
          removeEventListener('message', onMessage)
          emitEvent(HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_ENDED, [token])
        }
      }, [token, refreshKey, hostSessionId])
      return undefined
    }

    // 外部资源开关（2026-10-21）只订阅一个布尔：FrontendFrame 在消息列表、
    // MVU 侧栏、右栏多处挂载，订整份 store 会让每次轮询刷新都重算 srcDoc。
    function useFrontendAllowExternalResources() {
      const read = () => snapshot.bootstrap.state.frontendAllowExternalResources === true
      return useSyncExternalStore(subscribe, read, read)
    }

    function FrontendFrame({ html, token, binding, refreshKey, messageId, hostSessionId }) {
      const frameRef = useRef(null)
      // Initial canvas color: resolve the DSH native background once on first
      // render; later theme flips go through postMessage, so the srcdoc is not
      // rebuilt (a rebuild would lose card state).
      const initialBackgroundRef = useRef(null)
      if (initialBackgroundRef.current === null) initialBackgroundRef.current = frontendHostBackgroundColor()
      const allowExternalResources = useFrontendAllowExternalResources()
      const [height, setHeight] = useState(120)
      const postViewport = useViewportBridge(frameRef)
      const postTheme = useThemeBridge(frameRef)
      useHelperBridge(frameRef, token, binding, refreshKey, hostSessionId)
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
        // 卡前端用 prompt/confirm 做方案命名/删除确认（ST 同款交互）；没有
        // allow-modals 时 Chromium 直接忽略并返回 null，按钮看起来"没反应"。
        sandbox: 'allow-scripts allow-modals',
        referrerPolicy: 'no-referrer',
        title: 'Tavern frontend',
        srcDoc: buildFrontendDocument(html, token, typeof messageId === 'number' ? messageId : -1, allowExternalResources, initialBackgroundRef.current),
        onLoad: () => { postViewport(); postTheme() },
        style: { height },
      })
    }
