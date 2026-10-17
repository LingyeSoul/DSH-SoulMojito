    // Mod 面板分区表面（A-1/A-2）：分区头按钮 chips + iframe + 日志折叠视图。
    function ModPanelSurface({ mod }) {
      const t = useTranslate()
      const [logRevision, setLogRevision] = useState(0)
      const [logOpen, setLogOpen] = useState(false)
      const entries = modLogBuffers.get(mod.id) || []
      // 日志在模块级缓冲（不经 store）：reporter 到达时经 onLog 即时推进计数
      // 重渲染；打开期间另有 1s 兜底节拍吸收跨组件写入，关闭时停发。
      useEffect(() => {
        if (!logOpen) return undefined
        const timer = setInterval(() => setLogRevision((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [logOpen])
      return h(React.Fragment, null,
        h(ModButtonRow, { mod, t }),
        h(ModSurface, { mod, onLog: (level, text) => { appendModLog(mod.id, level, text); setLogRevision((value) => value + 1) } }),
        h('div', { className: 'dt-mod-log' },
          h('button', {
            type: 'button',
            className: 'dt-mod-log-toggle',
            'aria-expanded': logOpen ? 'true' : 'false',
            onClick: () => setLogOpen(!logOpen),
          }, t('mods.modLog.toggle', { count: entries.length })),
          logOpen ? h('div', { className: 'dt-mod-log-body' },
            entries.length === 0
              ? h('p', { className: 'dt-muted' }, t('mods.modLog.empty'))
              : entries.slice().reverse().map((entry, index) => h('div', {
                key: `${entry.at}-${index}`,
                className: `dt-mod-log-line dt-mod-log-${entry.level}`,
              },
                h('span', { className: 'dt-mod-log-time' }, formatNovelTime(entry.at)),
                h('span', { className: 'dt-mod-log-level' }, entry.level),
                h('span', { className: 'dt-mod-log-text' }, entry.text)))) : null))
    }

    // 分区头/聊天视图共用的按钮行（A-1d）：点击 → POST 按钮分发路由，请求中
    // 禁用态，失败行内提示；成功后向挂载的 ModSurface 广播 button-click 事件。
    function ModButtonRow({ mod, t, character, chatId }) {
      const [pending, setPending] = useState('')
      const [error, setError] = useState('')
      const buttons = Array.isArray(mod.buttons) ? mod.buttons : []
      if (buttons.length === 0) return null
      const click = (name) => {
        const key = `${mod.id}\u0000${name}`
        if (pending !== '') return
        setPending(key)
        setError('')
        void fetch(`${API}/mods/${encodeURIComponent(mod.id)}/button/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(
            typeof character === 'string' && character !== '' && typeof chatId === 'string' && chatId !== ''
              ? { character, chatId }
              : {},
          ),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok === false) throw new Error(body.message || `HTTP ${response.status}`)
            broadcastModEvent('button-click', { mod: mod.id, name })
          })
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => setPending(''))
      }
      return h('div', { className: 'dt-mod-button-row' },
        h('span', { className: 'dt-mod-button-owner' }, mod.name),
        buttons.map((name) => h('button', {
          key: name,
          type: 'button',
          className: 'dt-mod-button',
          disabled: pending !== '',
          onClick: () => click(name),
        }, pending === `${mod.id}\u0000${name}` ? t('mods.buttonBusy') : name)),
        error ? h('span', { className: 'dt-mod-button-error' }, error) : null)
    }

    // ST 聊天视图的紧凑按钮行（A-1d）：聚合所有已装载 mod 的声明按钮，点击携带
    // 当前绑定的 { character, chatId } 作为按钮上下文；无声明按钮的 mod 不渲染，
    // 全空时整行不占位（TavernMvuStatus 同款纪律）。
    function TavernModButtons({ character, chatId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const mods = (state.bootstrap.mods || []).filter((mod) => mod && mod.status === 'loaded' && Array.isArray(mod.buttons) && mod.buttons.length > 0)
      if (mods.length === 0) return null
      return h('div', { className: 'dt-mod-button-strip', 'data-dsh-soulmojito-surface': 'mod-buttons' },
        mods.map((mod) => h(ModButtonRow, { key: mod.id, mod, t, character, chatId })))
    }

    function ModSurface({ mod, onLog }) {
      const frameRef = useRef(null)
      const [height, setHeight] = useState(140)
      const postViewport = useViewportBridge(frameRef)
      // 每 mount 一个随机 token：URL 查询段交给 mod UI（回投时对账）+ 事件源
      // 必须是该 frame 的 contentWindow，双对账缺一不受理。
      const [token] = useState(() => `dsh-soulmojito-mod-${mod.id}-${Math.random().toString(36).slice(2)}`)
      useEffect(() => {
        let disposed = false
        const post = (message) => {
          if (disposed) return
          try { frameRef.current?.contentWindow?.postMessage(message, '*') } catch {}
        }
        // mod-event 下行广播面：本 surface 挂载期间接收宿主事件（unmount 即整组退订）。
        const surface = { id: mod.id, token, frameRef }
        modEventSurfaces.add(surface)
        const onMessage = (event) => {
          if (event.source !== frameRef.current?.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.token !== token) return
          if (data.type === FRONTEND_HEIGHT_MESSAGE) {
            if (typeof data.height === 'number' && Number.isFinite(data.height)) {
              setHeight(Math.max(80, Math.min(Math.ceil(data.height), 1200)))
            }
            return
          }
          // mod-log 上行（A-2）：reply.html 注入的 console reporter 输出 → 环形缓冲。
          if (data.type === MOD_LOG_MESSAGE) {
            if (typeof data.text === 'string' && MOD_LOG_LEVELS.has(data.level)) {
              onLog?.(data.level, data.text)
            }
            return
          }
          if (data.type !== MOD_REQUEST_MESSAGE) return
          const request = data.req || {}
          const method = String(request.method || 'GET').toUpperCase()
          const path = String(request.path || '')
          if (!MOD_BRIDGE_METHODS.has(method) || !isValidModBridgePath(path)) {
            post({ type: MOD_RESPONSE_MESSAGE, token, id: data.id, ok: false, status: 0, error: 'invalid bridge request' })
            return
          }
          // 父页同源 fetch 代理（iframe 自身被 CSP 封网）：只到本 Mod 的子路由。
          void fetch(`${API}/mods/${encodeURIComponent(mod.id)}/${path}`, {
            method,
            headers: request.body === undefined ? undefined : { 'content-type': 'application/json' },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
          })
            .then(async (response) => {
              const text = await response.text()
              let body = text
              try { body = text === '' ? null : JSON.parse(text) } catch {}
              post({ type: MOD_RESPONSE_MESSAGE, token, id: data.id, ok: response.ok, status: response.status, body })
            })
            .catch((cause) => {
              post({ type: MOD_RESPONSE_MESSAGE, token, id: data.id, ok: false, status: 0, error: cause instanceof Error ? cause.message : String(cause) })
            })
        }
        addEventListener('message', onMessage)
        return () => {
          disposed = true
          modEventSurfaces.delete(surface)
          removeEventListener('message', onMessage)
        }
      }, [mod.id, token])
      return h('iframe', {
        ref: frameRef,
        className: 'dt-frontend-frame dt-mod-surface',
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        title: mod.name,
        src: `${API}/mods/${encodeURIComponent(mod.id)}/ui?token=${encodeURIComponent(token)}`,
        onLoad: postViewport,
        style: { height },
      })
    }

    // 启用 Mod 的声明分区追加进导航（§3.5）：bootstrap.mods 里 status==='loaded'
    // 且声明 panel 的 mod 各得一个 `mod:<id>` 分区（P0 的 registerPanelSection
    // 动态注册）。签名变化（增删/改标题）时整体重建；签名不变不动（避免每次
    // 轮询重挂 iframe）。当前分区被移除时回落注册表首项（TavernPanel 兜底）。
    let modPanelSignature = ''
    const modPanelOffs = []

    function syncModPanelSections(bootstrap) {
      const mods = Array.isArray(bootstrap?.mods)
        ? bootstrap.mods.filter((mod) => mod && mod.panel && mod.status === 'loaded')
        : []
      const signature = mods.map((mod) => `${mod.id}\u0000${mod.panel.title}\u0000${mod.panel.icon || ''}`).sort().join('\u0001')
      if (signature === modPanelSignature) return
      modPanelSignature = signature
      for (const off of modPanelOffs.splice(0)) off()
      for (const mod of mods) {
        const title = mod.panel.title
        modPanelOffs.push(registerPanelSection({
          id: `mod:${mod.id}`,
          icon: IconCordisPluginOutline14,
          // mod 自带文案（非宿主 i18n key）——P0 决策的 thunk 形状即为此预留。
          label: () => title,
          // 分区头按钮 chips + iframe 表面 + 日志折叠视图（A-1d/A-2）。
          component: () => h(ModPanelSurface, { mod }),
        }))
      }
    }
