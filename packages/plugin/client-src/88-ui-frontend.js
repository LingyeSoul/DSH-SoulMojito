    // 酒馆美化前端（消息内完整 HTML/JS）在 AgentTavern 架构的展示面
    // （2026-10-20，用户需求）：native conversation 由宿主渲染，插件没有消息
    // 正文 slot，消息里的 HTML 只能以源码文本出现。这里把「本聊天最新一条带
    // 完整 HTML 的楼层」挂到 DSH 原生右侧栏 tab（MVU / 游戏对局同款注册）。
    // 只取最新一条而不是每楼都挂：美化前端通常是随回合重发的状态 HUD，侧栏
    // 常驻保留最新快照即可；旧楼层不重复执行脚本，也不给用户一堆并行 iframe。
    // iframe 纪律完整继承内联 FrontendFrame（sandbox 无 same-origin、CSP、
    // token 校验的高度回传），侧栏只是换了一个宿主容器。
    // 卡脚本自动运行（2026-10-21 第二次修订）：显式开启 cardScriptsAutoRun 后，
    // 本 tab 同时承载卡内全部启用脚本——脚本块注入**同一个**沙箱文档，卡脚本的
    // 悬浮面板/浮球 append 到 window.top.document.body 时直接落在美化前端里。
    // ST 架构仍在「卡脚本」tab 自动运行（消息内联，右栏没有第二份前端）。
    const FRONTEND_TAB_ID = 'dsh-soulmojito/frontend'
    const FRONTEND_TAB_KIND = 'tavern-frontend'
    // apply 的 ctx.inject 回调在宿主服务就绪时置真：标题栏入口据此决定是否渲染
    // （服务不在场的旧宿主没有可承载表面，死按钮比没有按钮更糟）。
    let sidebarRightServiceReady = false

    // 标题栏入口的可见性判据：apply 的 inject 回调标记优先，其次现场查服务
    // （热重载/晚挂载时 ctx.inject 回调可能尚未触发）。查不到就按不可用处理。
    function hasSidebarRightSurface() {
      if (sidebarRightServiceReady === true) return true
      try {
        return typeof PanelHost.context?.get?.('sidebarRight')?.openTab === 'function'
      } catch {
        return false
      }
    }

    function TavernFrontendSidebarTab({ sessionId }) {
      return h(TavernFrontendPanel, { sessionId, sidebar: true })
    }

    // 自动展开（2026-10-20 用户需求「自动展开 tab 做成设置开关」）：设置开启时，
    // 本聊天首次出现可展示的美化前端即打开右栏 tab。每 (sessionId, 楼层) 只自动
    // 展开一次——用户关掉后不再抢焦点。挂在标题栏（header actions）而不是 tab 体
    // 上：tab 没打开时 body 不挂载，watcher 自己拉起自己才有意义。
    // 判定用与面板同一条端点（frontend/latest），随会话绑定变化重扫；1s 节流 +
    // 页面不可见停发，与游戏自动展开同款纪律。设置关闭时零轮询。
    const FRONTEND_AUTO_OPEN_POLL_MS = 5000

    function useFrontendAutoOpen(sessionId, binding, architecture, enabled) {
      const autoOpenedRef = useRef(new Set())
      useEffect(() => {
        if (!enabled || !binding || architecture !== 'agent-tavern') return undefined
        const keyBase = `${sessionId}\u0000${binding.character}\u0000${binding.chatId}`
        let cancelled = false
        let inFlight = false
        const check = () => {
          if (cancelled || inFlight || document.visibilityState === 'hidden') return
          const sidebarRight = PanelHost.context?.get?.('sidebarRight')
          if (typeof sidebarRight?.openTab !== 'function') return
          inFlight = true
          const query = `?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}`
          void api(`frontend/latest${query}`)
            .then((result) => {
              if (cancelled || !result?.message) return
              const marker = `${keyBase}\u0000${result.message.index}`
              if (autoOpenedRef.current.has(marker)) return
              autoOpenedRef.current.add(marker)
              try { sidebarRight.openTab(FRONTEND_TAB_KIND) } catch {}
            })
            .catch(() => {})
            .finally(() => { inFlight = false })
        }
        check()
        const timer = setInterval(check, FRONTEND_AUTO_OPEN_POLL_MS)
        const onVisibility = () => { if (document.visibilityState === 'visible') check() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [enabled, sessionId, binding?.character, binding?.chatId, architecture])
    }

    // 卡脚本自动运行（2026-10-21 第二次修订）：设置显式开启后，卡脚本不再单独
    // 占一个空白 iframe，而是注入「美化前端」最新楼层的同一个沙箱文档——脚本
    // append 到 window.top.document.body 的悬浮面板直接叠在美化前端上。ST 仍在
    // 「卡脚本」tab 内运行（消息正文内联，右栏没有第二份前端）。
    const CARD_SCRIPTS_RESET_EVENT = 'dsh-soulmojito:card-scripts-reset'
    const CARD_SCRIPTS_FONT_AWESOME = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">'

    // `</script` 必须转义，否则脚本字符串里的闭合标签会提前截断 HTML 解析。
    // 每份脚本一个独立 module 块，共享同一文档的 window/document/全局变量。
    function frontendCardScriptBlocks(scripts) {
      return scripts.map((script) => {
        const content = String(script.content || '').replace(/<\/script/gi, () => '<\\/script')
        return `<script type="module">${content}</script>`
      }).join('')
    }

    // 有最新美化楼层时把脚本块插到 `</body>` 之前（与 buildFrontendDocument 的
    // 注入点同一套朴素规则）；没有美化楼层时给脚本一个 720px 画布，否则固定
    // 定位的悬浮球/面板没有可视高度。Font Awesome 只补一次，卡自己带就不重复。
    function frontendWithCardScripts(html, scripts) {
      const blocks = frontendCardScriptBlocks(scripts)
      const source = String(html || '').trim()
      const fontAwesome = /font-awesome/i.test(source) ? '' : CARD_SCRIPTS_FONT_AWESOME
      if (source === '') {
        return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width, initial-scale=1">'
          + `${fontAwesome}<style>html,body{margin:0;padding:0;background:transparent;min-height:100%;}</style>`
          + `</head><body><div style="height:720px"></div>${blocks}</body></html>`
      }
      // 必须用 replacer 函数：脚本源码里的 `$'` / `$&` 是合法 JS，但作为
      // String.replace 的字符串替换值会被当成替换模式，直接改写脚本并让
      // srcdoc 抛 "Invalid or unexpected token"（实测 GM 面板有 29 处 `$'`）。
      const withScripts = /<\/body\s*>/i.test(source)
        ? source.replace(/<\/body\s*>/i, () => `${blocks}</body>`)
        : `${source}${blocks}`
      if (fontAwesome === '') return withScripts
      return /<head(?:\s[^>]*)?>/i.test(withScripts)
        ? withScripts.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${fontAwesome}`)
        : `${fontAwesome}${withScripts}`
    }

    // 一个楼层可能同时带多个完整文档（这张卡就是行动栏 35KB + 状态总览 154KB）。
    // 自动运行的脚本必须落在玩家看的主前端，而不是第一个小框：取文档长度最大
    // 者，同长度取最后一个。只注入这一个文档，别的 iframe 不重复执行脚本。
    function frontendCardScriptHostIndex(documents) {
      let host = 0
      for (let index = 1; index < documents.length; index++) {
        if (String(documents[index] || '').length >= String(documents[host] || '').length) host = index
      }
      return host
    }

    function TavernFrontendPanel({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const architecture = bindingArchitecture(binding)
      const cardScriptsAutoRun = state.bootstrap.state.cardScriptsAutoRun === true
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      // 卡脚本 bundle 只在聊天/设置变化时取一次：脚本源码可能很大（GM 面板
      // 16 万字符），不能跟着 5s 前端轮询重取；运行中的脚本自己持有内存状态，
      // 不因美化楼层刷新而重启。
      const [scriptBundle, setScriptBundle] = useState(null)
      const [scriptError, setScriptError] = useState('')
      const [autoStopped, setAutoStopped] = useState(false)
      // Fullscreen fallback: a fixed overlay covering the viewport. The native
      // right sidebar keeps the panel mounted, but this node is portalled to
      // document.body so no ancestor overflow/transform can clip it.
      const [expanded, setExpanded] = useState(false)
      const [reloadNonce, setReloadNonce] = useState(0)
      const [refreshing, setRefreshing] = useState(false)
      const panelRef = useRef(null)
      const scriptRequestRef = useRef(0)
      const key = binding === undefined
        ? ''
        : `${sessionId}\u0000${binding.character}\u0000${binding.chatId}`
      const autoRunHosted = cardScriptsAutoRun && architecture === 'agent-tavern'
      const load = () => {
        if (!binding || architecture !== 'agent-tavern') return Promise.resolve()
        const query = `?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}`
        return api(`frontend/latest${query}`)
          .then((result) => {
            setSnapshot(result)
            setError('')
          })
          .catch((cause) => {
            // 404（聊天删除 / 绑定竞态）回落空态；瞬时错误保留上次快照。
            if (cause?.status === 404) {
              setSnapshot(null)
              return
            }
            setError(cause instanceof Error ? cause.message : String(cause))
          })
      }
      const loadRef = useRef(load)
      useEffect(() => { loadRef.current = load })
      // A manual refresh must remount the iframe: re-fetching the same HTML into
      // an identical srcDoc does not reload the browsing context, so cards keep
      // their old state and the button looked dead.
      const refresh = () => {
        if (refreshing) return
        setRefreshing(true)
        void loadRef.current().finally(() => {
          setReloadNonce((value) => value + 1)
          setRefreshing(false)
        })
      }
      // Expanding must not move the panel node: reparenting the iframe destroys
      // its browsing context and cards reload their data. Prefer the Fullscreen
      // API on the existing element; the CSS overlay is only the fallback.
      const toggleExpanded = () => {
        if (expanded) {
          if (document.fullscreenElement !== null && typeof document.exitFullscreen === 'function') {
            void document.exitFullscreen().catch(() => {})
          }
          setExpanded(false)
          return
        }
        const element = panelRef.current
        if (element !== null && typeof element.requestFullscreen === 'function') {
          try {
            void element.requestFullscreen().then(() => setExpanded(true), () => setExpanded(true))
            return
          } catch {}
        }
        setExpanded(true)
      }
      useEffect(() => {
        const onFullscreenChange = () => {
          if (document.fullscreenElement === null) setExpanded(false)
        }
        document.addEventListener('fullscreenchange', onFullscreenChange)
        return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
      }, [])
      useEffect(() => {
        if (!expanded) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (document.fullscreenElement !== null && typeof document.exitFullscreen === 'function') {
            void document.exitFullscreen().catch(() => {})
            return
          }
          setExpanded(false)
        }
        addEventListener('keydown', onKeyDown)
        return () => removeEventListener('keydown', onKeyDown)
      }, [expanded])
      useEffect(() => {
        // 切换聊天时先摘掉上一份快照：避免一个渲染帧里显示别的聊天的 HUD。
        setSnapshot(null)
        void loadRef.current()
      }, [binding?.character, binding?.chatId, architecture])
      // 原生会话的生成走宿主 AgentLoop，插件本地 chats/revisions 收不到信号
      // （与 MVU 侧栏同一条纪律）：可见期间 5s 重取，隐藏期间停发。
      useSessionPanelPoll(() => loadRef.current(), [binding?.character, binding?.chatId, architecture])
      // 自动运行的脚本列表：只在 AgentTavern + 设置显式开启时取。竞态取消保证
      // 切聊天后旧响应不会把上一场的脚本注入新聊天。
      useEffect(() => {
        if (binding === undefined || architecture !== 'agent-tavern' || !cardScriptsAutoRun) {
          scriptRequestRef.current += 1
          setScriptBundle(null)
          setScriptError('')
          setAutoStopped(false)
          return undefined
        }
        const request = scriptRequestRef.current + 1
        scriptRequestRef.current = request
        setScriptBundle(null)
        setScriptError('')
        setAutoStopped(false)
        const query = `?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}`
        void api(`card/scripts${query}`)
          .then((result) => {
            if (scriptRequestRef.current !== request) return
            setScriptBundle({ key, scripts: Array.isArray(result?.scripts) ? result.scripts : [] })
          })
          .catch((cause) => {
            if (scriptRequestRef.current !== request) return
            // 404 是角色被删/绑定竞态：按无脚本处理，美化前端本体仍可展示。
            setScriptBundle({ key, scripts: [] })
            if (cause?.status !== 404) {
              setScriptError(cause instanceof Error ? cause.message : String(cause))
            }
          })
        return () => { scriptRequestRef.current += 1 }
      }, [key, architecture, cardScriptsAutoRun, binding?.character, reloadNonce])
      // 卡脚本 tab 的「重置卡脚本」删除的是同一份会话副本：通知本 tab 立即停止
      // 自动运行，避免 iframe 继续跑已经被重置的旧源码。
      useEffect(() => {
        const onReset = () => setAutoStopped(true)
        addEventListener(CARD_SCRIPTS_RESET_EVENT, onReset)
        return () => removeEventListener(CARD_SCRIPTS_RESET_EVENT, onReset)
      }, [])
      if (!binding) {
        return h('div', { className: 'dt-frontend-side', 'data-dsh-soulmojito-surface': 'frontend-sidebar' },
          h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }), h('span', null, t('frontend.unbound'))))
      }
      // ST 架构已经在 TavernView 的消息里内联渲染，再挂一份会重复执行脚本；
      // 非酒馆会话（小说 / 写卡工作台）没有可读的聊天前端。
      if (architecture !== 'agent-tavern') {
        return h('div', { className: 'dt-frontend-side', 'data-dsh-soulmojito-surface': 'frontend-sidebar' },
          h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }),
            h('span', null, architecture === 'st' ? t('frontend.inlineOnly') : t('frontend.unbound'))))
      }
      const message = snapshot?.message
      const currentScripts = scriptBundle !== null && scriptBundle.key === key ? scriptBundle.scripts : []
      const scripts = autoRunHosted && !autoStopped ? currentScripts : []
      const autoRunning = scripts.length > 0
      const scriptsPending = autoRunHosted && scriptBundle === null
      // 只把卡脚本注入主前端（文档长度最大者）：最新楼层可能同时带行动栏小框
      // 和状态总览大框，注入第一个会把 GM 面板塞进小框。
      const scriptHostIndex = autoRunning && message !== undefined
        ? frontendCardScriptHostIndex(message.documents)
        : -1
      const frameKey = `${message?.index ?? 'none'}:${reloadNonce}:`
        + (autoRunning ? scripts.map((script) => `${script.id}:${script.content.length}`).join('|') : '')
      const frames = []
      if (message !== undefined) {
        message.documents.forEach((html, index) => {
          const composed = index === scriptHostIndex ? frontendWithCardScripts(html, scripts) : html
          frames.push(h('div', {
            key: `${message.index}-${index}-${reloadNonce}`,
            className: 'dt-frontend-side-frame',
          }, h(FrontendFrame, {
            html: composed,
            token: `tavern-frontend-${sessionId}-${message.index}-${index}`,
            messageId: message.index,
            hostSessionId: sessionId,
            binding: { character: binding.character, chatId: binding.chatId },
            refreshKey: frameKey,
          })))
        })
      } else if (autoRunning) {
        frames.push(h('div', {
          key: `card-scripts-${reloadNonce}`,
          className: 'dt-frontend-side-frame',
        }, h(FrontendFrame, {
          html: frontendWithCardScripts('', scripts),
          token: `tavern-frontend-${sessionId}-${binding.character}-${binding.chatId}-card-scripts`,
          messageId: -1,
          hostSessionId: sessionId,
          binding: { character: binding.character, chatId: binding.chatId },
          refreshKey: frameKey,
        })))
      }
      const panel = h('div', {
        ref: panelRef,
        className: `dt-frontend-side${expanded ? ' dt-frontend-side-expanded' : ''}`,
        'data-dsh-soulmojito-surface': 'frontend-sidebar',
        ...(expanded ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('frontend.title') } : {}),
      },
        h('div', { className: 'dt-frontend-side-head' },
          h('span', { className: 'dt-frontend-side-meta' },
            message
              ? t('frontend.floor', { index: message.index + 1 })
              : autoRunning ? t('frontend.cardScriptsOnly', { count: scripts.length }) : t('frontend.empty')),
          h('div', { className: 'dt-frontend-side-actions' },
            h('button', {
              type: 'button',
              className: 'dt-frontend-side-refresh',
              title: t(expanded ? 'frontend.collapse' : 'frontend.expand'),
              'aria-label': t(expanded ? 'frontend.collapse' : 'frontend.expand'),
              'aria-pressed': expanded ? 'true' : 'false',
              onClick: toggleExpanded,
            }, h(expanded ? IconCollapse16 : IconExpand16)),
            h('button', {
              type: 'button',
              className: 'dt-frontend-side-refresh',
              title: t('frontend.refresh'),
              'aria-label': t('frontend.refresh'),
              'data-busy': refreshing ? 'true' : 'false',
              disabled: refreshing,
              onClick: refresh,
            }, h(IconRefreshOutline16)))),
        error ? h('p', { className: 'dt-error' }, error) : null,
        scriptError ? h('p', { className: 'dt-error' }, t('frontend.cardScriptsError', { error: scriptError })) : null,
        autoRunning
          ? h('div', { className: 'dt-card-scripts-auto' },
            h('span', { className: 'dt-card-script-running' },
              t('frontend.cardScriptsAutoRunning', { count: scripts.length })),
            h('button', {
              type: 'button',
              className: 'dt-card-script-run dt-card-script-stop',
              onClick: () => setAutoStopped(true),
            }, t('frontend.stopCardScripts')))
          : null,
        autoRunHosted && autoStopped && currentScripts.length > 0
          ? h('p', { className: 'dt-hint' }, t('frontend.cardScriptsStopped'))
          : null,
        autoRunning ? h('p', { className: 'dt-card-scripts-warning', role: 'note' }, t('cardScripts.warning')) : null,
        scriptsPending
          ? h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }),
            h('span', null, t('cardScripts.loading')))
          : frames.length > 0
            ? h('div', { className: 'dt-frontend-side-frames' }, frames)
            : h('div', { className: 'dt-frontend-side-empty' },
              h(IconSparkle16, { size: 22 }),
              h('strong', null, t('frontend.emptyTitle')),
              h('p', { className: 'dt-hint' }, t('frontend.emptyHint'))))
      return panel
    }
