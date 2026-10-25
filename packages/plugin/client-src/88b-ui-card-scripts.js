    // 卡脚本右栏（2026-10-21，用户需求）：JSR 卡的常驻脚本树
    // `data.extensions.tavern_helper.scripts` 不随消息重发。默认**不自动执行**：
    // 列出启用的脚本，用户点「运行」后才把单份脚本包成完整 HTML 文档交给现有
    // 沙箱 FrontendFrame（allow-scripts、无 same-origin、CSP 不变）。
    // 设置 `cardScriptsAutoRun` 显式开启后：AgentTavern 的自动运行由「美化前端」
    // tab 承载（脚本与最新楼层 HTML 同一个 iframe，见 88 片段）；ST 架构没有
    // 右栏前端的第二份展示面，仍在**本 tab** 自动运行全部启用脚本（同一 iframe、
    // 共享 DOM/全局）。本 tab 在 AgentTavern 下只保留列表、重置与手动入口。
    const CARD_SCRIPTS_TAB_ID = 'dsh-soulmojito/card-scripts'
    const CARD_SCRIPTS_TAB_KIND = 'tavern-card-scripts'

    function TavernCardScriptsSidebarTab({ sessionId }) {
      return h(TavernCardScriptsPanel, { sessionId })
    }

    // 自动展开（2026-10-21 用户需求，第二次修订）：设置显式开启时，进入/切入
    // 一个酒馆聊天直接打开承载自动运行的 tab——AgentTavern 是「美化前端」，ST 是
    // 「卡脚本」。每个 (sessionId, character, chatId) 只自动打开一次：用户手动
    // 关掉后，后续挂载/绑定变化不再抢焦点。宿主没有 sidebarRight 服务或 openTab
    // 不可用时静默跳过，不渲染死按钮。
    function useCardScriptsAutoOpen(sessionId, binding, architecture, enabled) {
      const openedRef = useRef(new Set())
      // Turning the setting off and on again is the user's explicit request to
      // retry auto-open for this chat even if the tab was closed earlier.
      const wasEnabledRef = useRef(false)
      useEffect(() => {
        if (enabled && !wasEnabledRef.current) openedRef.current.clear()
        wasEnabledRef.current = enabled
      }, [enabled])
      useEffect(() => {
        if (!enabled || binding === undefined || binding.group === true) return undefined
        if (architecture !== 'agent-tavern' && architecture !== 'st') return undefined
        const targetKind = architecture === 'agent-tavern' ? FRONTEND_TAB_KIND : CARD_SCRIPTS_TAB_KIND
        const key = `${sessionId}\u0000${binding.character}\u0000${binding.chatId}`
        if (openedRef.current.has(key)) return undefined
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (typeof sidebarRight?.openTab !== 'function') return undefined
        // A global setting must not open an empty tab for every unscripted card:
        // probe the chat's effective list once, then open only when it has scripts.
        let cancelled = false
        const query = `?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}`
        void api(`card/scripts${query}`)
          .then((result) => {
            if (cancelled) return
            const scripts = Array.isArray(result?.scripts) ? result.scripts : []
            openedRef.current.add(key)
            if (scripts.length === 0) return
            try { sidebarRight.openTab(targetKind) } catch {}
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [enabled, sessionId, binding?.character, binding?.chatId, binding?.group, architecture])
    }

    // 卡脚本是裸 JS（JSR 的脚本容器负责窗口环境）；这里包一层最小文档，让
    // window/globalThis、CSS 与 Font Awesome 与消息前端同构。`</script` 必须
    // 转义，否则脚本字符串里的闭合标签会提前截断 HTML 解析。
    function cardScriptDocument(script) {
      const content = String(script.content || '').replaceAll('</script', '<\\/script')
      return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">'
        + '<style>html,body{margin:0;padding:0;background:transparent;min-height:100%;}</style>'
        + '</head><body><div style="height:720px"></div>'
        + `<script type="module">${content}</script></body></html>`
    }

    // 自动运行：全部启用脚本按脚本树顺序注入**同一个**沙箱 iframe，每份一个
    // 独立 module 块（共享 window/document/全局——不是 JSR 的隔离容器）。
    function cardScriptTreeDocument(scripts) {
      const blocks = scripts.map((script) => {
        const content = String(script.content || '').replaceAll('</script', '<\\/script')
        return `<script type="module">${content}</script>`
      }).join('')
      return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">'
        + '<style>html,body{margin:0;padding:0;background:transparent;min-height:100%;}</style>'
        + '</head><body><div style="height:720px"></div>' + blocks + '</body></html>'
    }

    // refreshKey 由聊天 key + 脚本身份/内容长度构成：bundle 重取但内容未变时不
    // 重载 iframe；切换聊天/角色时（key 变化）强制换新 iframe，不复用旧聊天的
    // 脚本运行环境。
    function cardScriptTreeRefreshKey(chatKey, scripts) {
      return `${chatKey}:${scripts.map((script) => `${script.id}:${script.content.length}`).join('|')}`
    }

    function TavernCardScriptsPanel({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const architecture = bindingArchitecture(binding)
      const supported = binding !== undefined && (architecture === 'agent-tavern' || architecture === 'st')
      const [bundle, setBundle] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [runningId, setRunningId] = useState(null)
      const [resetting, setResetting] = useState(false)
      const [resetDone, setResetDone] = useState(false)
      const [resettingScripts, setResettingScripts] = useState(false)
      const [scriptsResetDone, setScriptsResetDone] = useState(false)
      const autoRunSetting = state.bootstrap.state.cardScriptsAutoRun === true
      // AgentTavern 的自动运行住在「美化前端」tab（脚本与最新楼层 HTML 同一个
      // iframe）；本 tab 只对 ST 自动运行——ST 的消息正文内联，右栏没有第二份
      // 前端承载脚本。
      const autoRunHostedInFrontend = autoRunSetting && architecture === 'agent-tavern'
      const autoRunEnabled = autoRunSetting && architecture === 'st'
      const [autoRunning, setAutoRunning] = useState(false)
      const [autoStopped, setAutoStopped] = useState(false)
      // Script-container buttons: each container iframe reports its own list; the
      // panel renders a bar and re-dispatches clicks to that iframe.
      const [scriptButtons, setScriptButtons] = useState({})
      const handleScriptButtons = useCallback((scriptId, list) => {
        setScriptButtons((current) => {
          const previous = current[scriptId] || []
          const same = previous.length === list.length && previous.every((item, index) =>
            item.event === list[index].event && item.name === list[index].name && item.visible === list[index].visible)
          if (same) return current
          return { ...current, [scriptId]: list }
        })
      }, [])
      const dispatchScriptButton = (entry) => {
        const surface = document.querySelector('.dt-card-scripts')
        const frames = surface ? surface.querySelectorAll('iframe[data-token]') : []
        for (const frame of frames) {
          const token = frame.getAttribute('data-token')
          if (token === null) continue
          try {
            frame.contentWindow?.postMessage({ type: HELPER_EVENT_MESSAGE, token, event: entry.event, args: [] }, '*')
          } catch {}
        }
      }
      // 用户手动「停止自动运行」后，bundle 重取/重渲染不得立刻重新启动；切换
      // 聊天/角色或重新打开 tab（组件重挂载）时重置。
      const autoRunStoppedRef = useRef(false)
      const autoRunEnabledRef = useRef(false)
      // 竞态取消：切换角色/聊天后旧请求的响应直接丢弃，不覆盖新列表。
      const requestRef = useRef(0)
      const helperSlotRef = useRef(null)
      const key = binding === undefined
        ? ''
        : `${sessionId}\u0000${binding.character}\u0000${binding.chatId}\u0000${architecture}`
      // Card-scripts resets proxy through the same host helper binding as the
      // FrontendFrame bridge. The slot is tied to this panel's session binding
      // and retries once after a 401 (expired token / plugin restart).
      useEffect(() => {
        const character = binding?.character
        const chatId = binding?.chatId
        helperSlotRef.current = null
        if (typeof character !== 'string' || character === '' || typeof chatId !== 'string' || chatId === '') {
          return undefined
        }
        const slot = acquireHelperToken({ character, chatId })
        helperSlotRef.current = slot
        return () => {
          helperSlotRef.current = null
          slot.release()
        }
      }, [binding?.character, binding?.chatId])
      // bundle 绑定所属聊天 key：切换聊天后的第一帧不会把上一场聊天的脚本当成
      // 当前聊天运行（list/auto-run 都只看 currentBundle）。
      const currentBundle = bundle !== null && bundle.key === key ? bundle : null

      const load = useCallback(() => {
        if (!supported) return Promise.resolve()
        const request = requestRef.current + 1
        requestRef.current = request
        setLoading(true)
        return api(`card/scripts?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}&includeDisabled=1`)
          .then((result) => {
            if (requestRef.current !== request) return
            setBundle({
              key,
              scripts: Array.isArray(result.scripts) ? result.scripts : [],
              world: typeof result.world === 'string' ? result.world : null,
            })
            setError('')
          })
          .catch((cause) => {
            if (requestRef.current !== request) return
            // 404 是角色被删/绑定竞态：给空态，不把整块面板变成错误页。
            if (cause?.status === 404) {
              setBundle({ key, scripts: [], world: null })
              return
            }
            setBundle(null)
            setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (requestRef.current === request) setLoading(false)
          })
      }, [key, supported, binding?.character])

      const loadRef = useRef(load)
      useEffect(() => { loadRef.current = load })

      useEffect(() => {
        // 切换聊天/角色：停止当前脚本并清空列表，避免把上一场聊天的 DOM 留在
        // 新会话里（脚本自己也有聊天身份，但宿主不该替它猜）。
        setRunningId(null)
        setBundle(null)
        setError('')
        setScriptButtons({})
        setResetDone(false)
        setScriptsResetDone(false)
        autoRunStoppedRef.current = false
        setAutoRunning(false)
        setAutoStopped(false)
        requestRef.current += 1
        void loadRef.current()
        return () => { requestRef.current += 1 }
      }, [key])

      // 设置从关到开时清除「手动停止」标记：重新打开开关即恢复自动运行。
      useEffect(() => {
        if (autoRunEnabled && !autoRunEnabledRef.current) {
          autoRunStoppedRef.current = false
          setAutoStopped(false)
        }
        autoRunEnabledRef.current = autoRunEnabled
      }, [autoRunEnabled])

      // AgentTavern 的自动运行改由「美化前端」承载后，本 tab 不再保留手动脚本
      // iframe：同一时间只允许一个自动运行宿主，避免两份 iframe 各跑一份卡脚本。
      useEffect(() => {
        if (!autoRunHostedInFrontend) return
        setRunningId(null)
        setAutoRunning(false)
        setAutoStopped(false)
      }, [autoRunHostedInFrontend])

      // bundle 就绪且开关开启即启动；开关关闭/无脚本/用户已停止时回到手动模式。
      useEffect(() => {
        if (!supported || !autoRunEnabled) {
          setAutoRunning(false)
          setAutoStopped(false)
          return
        }
        if (autoRunStoppedRef.current) {
          setAutoRunning(false)
          return
        }
        if (currentBundle === null || currentBundle.scripts.filter((script) => script.enabled !== false).length === 0) {
          setAutoRunning(false)
          return
        }
        setRunningId(null)
        setAutoRunning(true)
      }, [autoRunEnabled, currentBundle, supported])

      const stopAutoRun = () => {
        autoRunStoppedRef.current = true
        setAutoRunning(false)
        setAutoStopped(true)
        setRunningId(null)
      }

      const openAutoRunHost = () => {
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (typeof sidebarRight?.openTab !== 'function') return
        try { sidebarRight.openTab(FRONTEND_TAB_KIND) } catch {}
      }

      const resetWorldbook = () => {
        if (!supported || currentBundle === null || currentBundle.world === null) return
        if (typeof window.confirm === 'function' && !window.confirm(t('cardScripts.resetConfirm'))) return
        const slot = helperSlotRef.current
        if (slot === null) {
          setError('helper binding is not ready for this session')
          return
        }
        setResetting(true)
        setResetDone(false)
        void slot.request('helper', {
          op: 'lorebook.reset',
          name: currentBundle.world,
        }).then(() => {
          setResetDone(true)
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
        }).finally(() => {
          setResetting(false)
        })
      }

      const resetScripts = () => {
        if (!supported) return
        if (typeof window.confirm === 'function' && !window.confirm(t('cardScripts.resetScriptsConfirm'))) return
        const slot = helperSlotRef.current
        if (slot === null) {
          setError('helper binding is not ready for this session')
          return
        }
        setResettingScripts(true)
        setScriptsResetDone(false)
        setResetDone(false)
        void slot.request('helper', {
          op: 'scripts.reset',
        }).then(() => {
          // 副本没了：停止自动运行与手动脚本，列表回卡原版。AgentTavern 的自动
          // 运行宿主在「美化前端」另一个 React 树里，用窗口事件同步停止它。
          autoRunStoppedRef.current = true
          setAutoRunning(false)
          setAutoStopped(false)
          setRunningId(null)
          setScriptsResetDone(true)
          try { window.dispatchEvent(new Event(CARD_SCRIPTS_RESET_EVENT)) } catch {}
          void loadRef.current()
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
        }).finally(() => {
          setResettingScripts(false)
        })
      }

      const buttonList = Object.values(scriptButtons)
        .flat()
        .filter((entry) => entry && entry.visible !== false && typeof entry.event === 'string')
      // One sandbox per script: JSR isolates script containers, and a shared
      // window lets two scripts clobber each other's globals. Each frame gets its
      // own identity so getScriptId/getScriptInfo observe the node.
      const renderScriptFrame = (script) => h('div', { className: 'dt-frontend-side-frame', key: `script-${script.id}` },
        h(FrontendFrame, {
          html: cardScriptDocument(script),
          token: `card-script-${sessionId}-${script.id}`,
          messageId: -1,
          binding: { character: binding.character, chatId: binding.chatId },
          hostSessionId: sessionId,
          refreshKey: `${script.id}:${script.content.length}`,
          identity: { scriptId: script.id, scriptName: script.name, scriptInfo: script.info },
          onScriptButtons: handleScriptButtons,
        }))

      if (!supported) {
        return h('div', { className: 'dt-frontend-side', 'data-dsh-soulmojito-surface': 'card-scripts-sidebar' },
          h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }),
            h('span', null, t('cardScripts.unbound'))))
      }

      const scripts = currentBundle === null ? [] : currentBundle.scripts
      const runnable = scripts.filter((script) => script.enabled !== false)
      const running = scripts.find((script) => script.id === runningId)
      return h('div', { className: 'dt-frontend-side dt-card-scripts', 'data-dsh-soulmojito-surface': 'card-scripts-sidebar' },
        h('p', { className: 'dt-card-scripts-warning', role: 'note' }, t('cardScripts.warning')),
        autoRunHostedInFrontend
          ? h('div', { className: 'dt-card-scripts-auto' },
            h('span', null, t('cardScripts.autoHostedInFrontend')),
            hasSidebarRightSurface()
              ? h('button', {
                type: 'button',
                className: 'dt-card-script-run',
                onClick: openAutoRunHost,
              }, t('cardScripts.openFrontend'))
              : null)
          : null,
        h('div', { className: 'dt-frontend-side-head' },
          h('span', { className: 'dt-frontend-side-meta' },
            t('cardScripts.count', { count: runnable.length })),
          h('button', {
            type: 'button',
            className: 'dt-frontend-side-refresh',
            title: t('cardScripts.refresh'),
            'aria-label': t('cardScripts.refresh'),
            onClick: () => { void loadRef.current() },
          }, h(IconRefreshOutline16))),
        error !== '' ? h('p', { className: 'dt-error' }, t('cardScripts.loadFailed', { error })) : null,
        autoRunning
          ? h('div', { className: 'dt-card-scripts-auto' },
            h('span', { className: 'dt-card-script-running' },
              t('cardScripts.autoRunning', { count: scripts.length })),
            h('button', {
              type: 'button',
              className: 'dt-card-script-run dt-card-script-stop',
              onClick: stopAutoRun,
            }, t('cardScripts.stopAutoRun')))
          : null,
        autoStopped && !autoRunning ? h('p', { className: 'dt-hint' }, t('cardScripts.autoRunStopped')) : null,
        loading && currentBundle === null
          ? h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }),
            h('span', null, t('cardScripts.loading')))
          : null,
        !loading && currentBundle !== null && scripts.length === 0
          ? h('div', { className: 'dt-frontend-side-empty' }, h(IconSparkle16, { size: 22 }),
            h('span', null, t('cardScripts.empty')))
          : null,
        scripts.length > 0
          ? h('div', { className: 'dt-card-scripts-list' }, scripts.map((script) => h('div', {
            key: script.id,
            className: 'dt-card-script',
          },
          h('div', { className: 'dt-card-script-head' },
            h('strong', null, script.name),
            autoRunHostedInFrontend && script.enabled !== false
              ? h('span', { className: 'dt-card-script-running' }, t('cardScripts.sharedHost'))
              : !autoRunning && runningId === script.id
                ? h('span', { className: 'dt-card-script-running' }, t('cardScripts.running'))
                : null,
            h('span', { className: 'dt-card-script-meta' },
              t('cardScripts.charCount', { count: script.content.length }))),
          script.info !== '' ? h('p', { className: 'dt-hint' }, script.info) : null,
          script.enabled === false ? h('p', { className: 'dt-hint' }, t('cardScripts.disabled')) : null,
          h('button', {
            type: 'button',
            className: runningId === script.id ? 'dt-card-script-run dt-card-script-stop' : 'dt-card-script-run',
            disabled: autoRunning || autoRunHostedInFrontend || script.enabled === false,
            onClick: () => {
              setResetDone(false)
              setAutoStopped(false)
              setRunningId(runningId === script.id ? null : script.id)
            },
          }, runningId === script.id ? t('cardScripts.stop') : t('cardScripts.run')))))
          : null,
        autoRunning && runnable.length > 0
          ? h('div', { className: 'dt-frontend-side-frames' }, runnable.map(renderScriptFrame))
          : running !== undefined
            ? h('div', { className: 'dt-frontend-side-frames' }, renderScriptFrame(running))
            : autoRunHostedInFrontend
              ? null
              : h('p', { className: 'dt-hint' }, t('cardScripts.idle')),
        buttonList.length > 0
          ? h('div', { className: 'dt-card-script-buttons', role: 'toolbar' },
            buttonList.map((entry) => h('button', {
              key: entry.event,
              type: 'button',
              className: 'dt-card-script-run dt-card-script-button',
              onClick: () => dispatchScriptButton(entry),
            }, entry.name)))
          : null,
        resetDone ? h('p', { className: 'dt-card-scripts-notice', role: 'status' }, t('cardScripts.resetDone')) : null,
        scriptsResetDone ? h('p', { className: 'dt-card-scripts-notice', role: 'status' }, t('cardScripts.resetScriptsDone')) : null,
        currentBundle !== null && (currentBundle.world !== null || scripts.length > 0)
          ? h('div', { className: 'dt-card-scripts-resets' },
            currentBundle.world !== null
              ? h('div', { className: 'dt-card-scripts-world' },
                h('span', { className: 'dt-frontend-side-meta' },
                  t('cardScripts.world', { name: currentBundle.world })),
                h('button', {
                  type: 'button',
                  className: 'dt-card-script-reset',
                  disabled: resetting,
                  onClick: resetWorldbook,
                }, t('cardScripts.resetWorldbook')))
              : null,
            h('div', { className: 'dt-card-scripts-world' },
              h('span', { className: 'dt-frontend-side-meta' }, t('cardScripts.scriptsLabel')),
              h('button', {
                type: 'button',
                className: 'dt-card-script-reset',
                disabled: resettingScripts,
                onClick: resetScripts,
              }, t('cardScripts.resetScripts'))))
          : null)
    }
