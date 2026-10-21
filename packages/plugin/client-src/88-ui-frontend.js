    // 酒馆美化前端（消息内完整 HTML/JS）在 AgentTavern 架构的展示面
    // （2026-10-20，用户需求）：native conversation 由宿主渲染，插件没有消息
    // 正文 slot，消息里的 HTML 只能以源码文本出现。这里把「本聊天最新一条带
    // 完整 HTML 的楼层」挂到 DSH 原生右侧栏 tab（MVU / 游戏对局同款注册）。
    // 只取最新一条而不是每楼都挂：美化前端通常是随回合重发的状态 HUD，侧栏
    // 常驻保留最新快照即可；旧楼层不重复执行脚本，也不给用户一堆并行 iframe。
    // iframe 纪律完整继承内联 FrontendFrame（sandbox 无 same-origin、CSP、
    // token 校验的高度回传），侧栏只是换了一个宿主容器。
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

    function TavernFrontendPanel({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const architecture = bindingArchitecture(binding)
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
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
      useEffect(() => {
        // 切换聊天时先摘掉上一份快照：避免一个渲染帧里显示别的聊天的 HUD。
        setSnapshot(null)
        void loadRef.current()
      }, [binding?.character, binding?.chatId, architecture])
      // 原生会话的生成走宿主 AgentLoop，插件本地 chats/revisions 收不到信号
      // （与 MVU 侧栏同一条纪律）：可见期间 5s 重取，隐藏期间停发。
      useSessionPanelPoll(() => loadRef.current(), [binding?.character, binding?.chatId, architecture])
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
      return h('div', { className: 'dt-frontend-side', 'data-dsh-soulmojito-surface': 'frontend-sidebar' },
        h('div', { className: 'dt-frontend-side-head' },
          h('span', { className: 'dt-frontend-side-meta' },
            message ? t('frontend.floor', { index: message.index + 1 }) : t('frontend.empty')),
          h('button', {
            type: 'button',
            className: 'dt-frontend-side-refresh',
            title: t('frontend.refresh'),
            'aria-label': t('frontend.refresh'),
            onClick: () => void loadRef.current(),
          }, h(IconRefreshOutline16))),
        error ? h('p', { className: 'dt-error' }, error) : null,
        message
          ? h('div', { className: 'dt-frontend-side-frames' }, message.documents.map((html, index) => h('div', {
            key: `${message.index}-${index}`,
            className: 'dt-frontend-side-frame',
          }, h(FrontendFrame, {
            html,
            token: `tavern-frontend-${sessionId}-${message.index}-${index}`,
            messageId: message.index,
            hostSessionId: sessionId,
            binding: { character: binding.character, chatId: binding.chatId },
            refreshKey: `${snapshot?.revision ?? ''}:${message.index}`,
          }))))
          : h('div', { className: 'dt-frontend-side-empty' },
            h(IconSparkle16, { size: 22 }),
            h('strong', null, t('frontend.emptyTitle')),
            h('p', { className: 'dt-hint' }, t('frontend.emptyHint'))))
    }
