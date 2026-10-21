    // 剧本进度卡（提案 0014 P1）：卡绑定剧本时在聊天视图顶部展示进度。进度是
    // 展示不是跳章——只读渲染 chunkIndex+1/chunkCount 与当前片段预览（服务端
    // 已截到 ≤400 字符），没有任何改写进度的入口；解绑（404）后隐藏。
    function TavernScriptProgress({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const chat = binding ? state.chats[key] : null
      const revision = binding ? state.revisions[key] : undefined
      const messageCount = chat?.messages?.length ?? 0
      // 绑定/解绑不经过聊天 revision（写在卡上），靠剧本库写计数感知
      const scriptsRevision = state.scriptsRevision
      const [progress, setProgress] = useState(null)
      useEffect(() => {
        if (!binding) return undefined
        let cancelled = false
        // 404（卡未绑定剧本 / 聊天缺失）即隐藏本卡，绑定解绑对视图即时生效
        void loadScriptProgress(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setProgress(result) })
          .catch(() => { if (!cancelled) setProgress(null) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, revision, messageCount, scriptsRevision])
      // tavern_script_advance 是原生 AgentLoop 的 agent 工具：剧本推进同样
      // 不经过本地 revision，可见期间轮询补齐自动刷新
      useSessionPanelPoll(() => {
        if (!binding) return Promise.resolve()
        return loadScriptProgress(binding.character, binding.chatId)
          .then((result) => { setProgress(result) })
          .catch((cause) => {
            // 404（解绑 / 聊天缺失）即隐藏本卡；瞬时错误保留上次进度
            if (cause?.status === 404) setProgress(null)
          })
      }, [binding?.character, binding?.chatId])
      if (!binding || !progress) return null
      const total = Number(progress.chunkCount)
      if (!Number.isFinite(total) || total <= 0) return null
      const current = Math.min(Math.max(Number(progress.chunkIndex) || 0, 0), total - 1) + 1
      const percent = Math.round((current / total) * 100)
      return h('div', { className: 'dt-script-card', 'data-dsh-soulmojito-surface': 'script-progress' },
        h('div', { className: 'dt-script-card-head' },
          h('span', { className: 'dt-script-card-title' }, t('script.progressTitle')),
          h('span', { className: 'dt-script-card-pos' }, t('script.position', { current, total }))),
        h('div', { className: 'dt-script-bar' },
          h('div', { className: 'dt-script-bar-fill', style: { width: `${percent}%` } })),
        h('div', { className: 'dt-script-card-meta' },
          h('span', { className: 'dt-script-name', title: progress.scriptName }, progress.scriptName),
          progress.alignedAt ? h('span', null, t('script.alignedAt', { time: formatNovelTime(progress.alignedAt) })) : null),
        progress.currentPreview ? h('p', { className: 'dt-script-preview' }, progress.currentPreview) : null,
        h('p', { className: 'dt-script-hint' }, t('script.hint')))
    }

    function TavernComposer({ sessionId, useInput, inputActions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const input = useInput((value) => value)
      const run = state.runs[sessionId] || {}
      const [trigger, setTrigger] = useState('')
      const send = () => {
        const message = input.draft.trim()
        if (!binding || !message || run.busy) return
        if (message.startsWith('/')) {
          inputActions.setDraft('')
          void runTavernScriptCommand(sessionId, binding, message)
          return
        }
        inputActions.setDraft('')
        void generateFor(sessionId, binding, 'send', message, trigger ? { triggerMember: trigger } : {})
        setTrigger('')
      }
      const placeholder = binding
        ? `${binding.group === true ? '☰ ' : ''}${t('composer.writeTo', { name: binding.character })}`
        : t('composer.unavailable')
      return h('div', { className: 'dt-composer-wrap', 'data-dsh-soulmojito-surface': 'composer' },
        binding && bindingArchitecture(binding) === 'st' && binding.group !== true
          ? h(TavernCandidates, {
            sessionId,
            disabled: run.busy,
            onFill: (text) => inputActions.setDraft(text),
          })
          : null,
        h('div', { className: 'dt-composer' },
          binding?.group === true ? h(MemberPicker, { binding, disabled: run.busy, selected: trigger, onSelect: setTrigger }) : null,
          h('textarea', {
            value: input.draft,
            disabled: !binding || run.busy,
            placeholder,
            rows: 2,
            onChange: (event) => inputActions.setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dt-composer-row' },
            h('span', { className: run.error ? 'dt-error' : 'dt-muted' }, run.error || (run.status ? t(run.status) : (binding ? binding.character : ''))),
            h('div', { className: 'dt-composer-actions' },
              h(ModelSelect, { sessionId, locked: run.busy || !binding }),
              run.busy
                ? h('button', { type: 'button', className: 'dt-primary-icon', title: t('composer.stop'), onClick: () => stopGeneration(sessionId) }, h(IconStopFill16))
                : h('button', {
                  type: 'button',
                  className: 'dt-primary-icon',
                  title: input.draft.trim().startsWith('/') ? t('composer.script') : t('composer.send'),
                  disabled: !binding || !input.draft.trim(),
                  onClick: send,
                }, input.draft.trim().startsWith('/') ? h('span', { className: 'dt-script-glyph' }, '/') : h(IconSendOutline16))))))
    }

    function formatStatsTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return '0'
      const scaled = (amount) => amount >= 100 ? String(Math.round(amount)) : String(Math.round(amount * 10) / 10)
      if (n < 1e3) return String(Math.round(n))
      if (n < 1e6) return `${scaled(n / 1e3)}K`
      return `${scaled(n / 1e6)}M`
    }

    function formatStatsDuration(value) {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms < 0) return '0s'
      const seconds = ms / 1e3
      if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
      const whole = Math.round(seconds)
      return `${Math.floor(whole / 60)}m${whole % 60}s`
    }

    function formatStatsThroughput(value) {
      const tps = Math.max(0, Number(value) || 0)
      return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)
    }

    function buildTavernStatsLine(stats, usage, t) {
      const groups = []
      if (stats && Number(stats.steps) > 0) {
        groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
        const durations = []
        if (Number(stats.llmMs) > 0) durations.push(t('stats.llm', { duration: formatStatsDuration(stats.llmMs) }))
        if (Number(stats.toolMs) > 0) durations.push(t('stats.toolCall', { duration: formatStatsDuration(stats.toolMs) }))
        if (durations.length > 0) groups.push(durations.join(' · '))
        const speeds = []
        if (Number(stats.ttftSteps) > 0) speeds.push(t('stats.ttftAverage', { duration: formatStatsDuration(Number(stats.ttftMs) / Number(stats.ttftSteps)) }))
        if (Number(stats.decodeMs) > 0) speeds.push(t('stats.tokensPerSecond', { throughput: formatStatsThroughput(Number(stats.decodeTokens) / (Number(stats.decodeMs) / 1e3)) }))
        if (speeds.length > 0) groups.push(speeds.join(' · '))
      }
      if (usage && (Number(usage.uncachedInputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens) > 0 || Number(usage.outputTokens) > 0)) {
        const input = Number(usage.uncachedInputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens)
        if (input > 0) {
          const cacheHit = Math.round(Number(usage.cacheReadTokens) / input * 100)
          groups.push(t('stats.cacheHit', { percent: cacheHit }))
        }
        groups.push(t('stats.tokens', { input: formatStatsTokens(input), output: formatStatsTokens(usage.outputTokens) }))
      }
      return groups.join(' | ')
    }

    // The native agent-preset entry has no session filter prop. Resolve its
    // CSS-module class from the host marker, then hide only that sibling.
    const AGENT_PRESET_LABEL_STYLE = '@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetLabel.module.css'

    function nativeAgentPresetLabelClass() {
      const style = document.querySelector(`style[data-plugin-css="${AGENT_PRESET_LABEL_STYLE}"]`)
      return /\.([_a-zA-Z][\w-]*_label)\s*\{/.exec(style?.textContent || '')?.[1] || null
    }

    function nativeAgentPresetLabel(marker) {
      const parent = marker?.parentElement
      if (!parent) return null
      const siblings = [...parent.children]
      const markerIndex = siblings.indexOf(marker)
      if (markerIndex <= 0) return null
      const labelClass = nativeAgentPresetLabelClass()
      if (labelClass) {
        return siblings.slice(0, markerIndex).reverse()
          .find((element) => element.classList?.contains(labelClass)) || null
      }
      const previous = marker.previousElementSibling
      return previous?.tagName === 'SPAN'
        && [...(previous.classList || [])].some((name) => name.endsWith('_label'))
        && previous.querySelector?.('svg')
        ? previous
        : null
    }

    function hideNativeAgentPresetLabel(label) {
      if (!label || label.dataset?.dshSoulMojitoAgentPresetHidden !== undefined) return
      label.dataset.dshSoulMojitoAgentPresetHidden = ''
      label.dataset.dshSoulMojitoAgentPresetHiddenAria = label.getAttribute?.('aria-hidden') ?? ''
      label.dataset.dshSoulMojitoAgentPresetHiddenState = label.hidden ? 'hidden' : 'visible'
      label.setAttribute?.('aria-hidden', 'true')
      label.hidden = true
    }

    function restoreNativeAgentPresetLabel(label) {
      if (!label || label.dataset?.dshSoulMojitoAgentPresetHidden === undefined) return
      const aria = label.dataset.dshSoulMojitoAgentPresetHiddenAria || ''
      if (aria) label.setAttribute('aria-hidden', aria)
      else label.removeAttribute?.('aria-hidden')
      label.hidden = label.dataset.dshSoulMojitoAgentPresetHiddenState === 'hidden'
      delete label.dataset.dshSoulMojitoAgentPresetHidden
      delete label.dataset.dshSoulMojitoAgentPresetHiddenAria
      delete label.dataset.dshSoulMojitoAgentPresetHiddenState
    }

    function useNativeAgentPresetLabelFilter(active) {
      const markerRef = useRef(null)
      useLayoutEffect(() => {
        if (!active) return undefined
        const marked = new Set()
        let frame = 0
        const apply = () => {
          frame = 0
          const label = nativeAgentPresetLabel(markerRef.current)
          for (const previous of [...marked]) {
            if (previous === label) continue
            restoreNativeAgentPresetLabel(previous)
            marked.delete(previous)
          }
          if (!label) return
          hideNativeAgentPresetLabel(label)
          marked.add(label)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        const parent = markerRef.current?.parentElement
        const observer = parent && typeof MutationObserver !== 'undefined'
          ? new MutationObserver(schedule)
          : null
        observer?.observe(parent, { childList: true })
        return () => {
          observer?.disconnect()
          if (frame) cancelAnimationFrame(frame)
          for (const label of marked) restoreNativeAgentPresetLabel(label)
        }
      }, [active])
      return markerRef
    }

    function TavernHeaderAction({ sessionId, useSession, useProjection }) {
      const state = useTavernStore()
      const t = useTranslate()
      const usage = useProjection ? useProjection('tokenUsage') : undefined
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const architecture = bindingArchitecture(binding)
      const novelId = binding?.architecture === 'agent-novel' && typeof binding.novelId === 'string' ? binding.novelId : null
      const active = useSession((session) => architecture === 'agent-tavern' || isTavernSession(session) !== null || novelId !== null)
      const stats = useProjection ? useProjection('sessionStats') : undefined
      const run = state.runs[sessionId] || {}
      const markerRef = useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === 'st'))
      // Novel sessions surface the project status here; the server stays the
      // authority, so the buttons only present the latest known state.
      const [novelSummary, setNovelSummary] = useState(null)
      useEffect(() => {
        if (novelId === null) {
          setNovelSummary(null)
          return undefined
        }
        let cancelled = false
        const load = () => {
          void fetchNovelDetail(novelId)
            .then((next) => { if (!cancelled) setNovelSummary(next) })
            .catch(() => {})
        }
        load()
        const timer = setInterval(load, 10000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [novelId])
      // 带意见重写（提案 0011）：意见可空 = 直接重写；提交走既有 regenerate
      // 发送路径携带 feedback 字段。弹出层模式对齐 ModelSelect（绝对定位 +
      // 点外关闭），锚定 header 故向下展开。
      const [rewriteOpen, setRewriteOpen] = useState(false)
      const [rewriteDraft, setRewriteDraft] = useState('')
      const rewriteRef = useRef(null)
      useEffect(() => {
        if (!rewriteOpen) return undefined
        const closeOutside = (event) => {
          if (!rewriteRef.current?.contains(event.target)) setRewriteOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [rewriteOpen])
      // MVU 面板的标题栏挂载（AgentTavern 会话没有 TavernView）：宿主带原生
      // 右侧栏（≥0.2.0-rc.2）时优先把面板作为侧栏 tab 打开（openTab 会自动展
      // 开右栏）；旧宿主或 openTab 抛错（无在屏会话）时回退弹出层模式——绝对
      // 定位 + 点外关闭，锚定 header 向下展开，与带意见重写一致。
      const [mvuOpen, setMvuOpen] = useState(false)
      const mvuRef = useRef(null)
      useEffect(() => {
        if (!mvuOpen) return undefined
        const closeOutside = (event) => {
          if (!mvuRef.current?.contains(event.target)) setMvuOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [mvuOpen])
      const openMvuSurface = () => {
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab(MVU_TAB_KIND)
            return
          } catch {
            // 无在屏会话或 store 未铸：落回弹出层
          }
        }
        setMvuOpen(!mvuOpen)
      }
      // 游戏对局面入口（2026-10-14 二次修订，与 MVU 同位同款）：右栏可用时开
      // 「游戏对局」tab；旧宿主或 openTab 失败（无在屏会话）回落设置面板的
      // 游戏分区（那里有手动开局与导入入口）。
      const openGamesSurface = () => {
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab(GAMES_TAB_KIND)
            return
          } catch {
            // 落回设置面板
          }
        }
        openPanel('games')
      }
      // 美化前端入口（2026-10-20）：消息内 HTML 在 AgentTavern 架构只能由
      // 右栏承载——宿主没有可插进 native conversation 的正文 slot。旧宿主
      // 没有 sidebarRight 服务时按钮不渲染（没有可承载表面的死按钮更糟）。
      const hasSidebarRight = hasSidebarRightSurface()
      const openFrontendSurface = () => {
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (typeof sidebarRight?.openTab !== 'function') return
        try { sidebarRight.openTab(FRONTEND_TAB_KIND) } catch {}
      }
      // 自动展开走设置开关 frontendAutoOpen（2026-10-20 用户需求）：默认关闭，
      // 开启后本聊天首次出现美化前端才打开右栏 tab。
      useFrontendAutoOpen(sessionId, binding, architecture, state.bootstrap.state.frontendAutoOpen === true)
      // 卡脚本自动运行（2026-10-21 用户需求）：设置显式开启时进入本聊天自动
      // 展开「卡脚本」tab（每会话/角色/聊天只开一次）；tab 内再自动运行脚本。
      useCardScriptsAutoOpen(sessionId, binding, architecture, state.bootstrap.state.cardScriptsAutoRun === true)
      // 对局面自动展示（2026-10-14 修订）：AgentTavern 的对局棋盘住在右栏 games
      // tab（MVU tab 同位）；本 watcher 盯 games/revision 水位（stat-only 的便宜
      // 端点，1s 节奏、页面不可见停发），本聊天出现未终局对局即自动展开 tab——
      // 每个会话只自动展开一次，用户关掉后不抢焦点（TavernMvuStatus autoOpenedFor
      // 同款纪律）。挂载时已存在的活跃对局也展开一次（重开会话回到棋盘）。ST
      // 架构不参与：TavernView 内联对局面常驻可见。
      const autoOpenedGamesRef = useRef(new Set())
      useEffect(() => {
        if (!binding || architecture !== 'agent-tavern' || binding.group === true) return undefined
        let cancelled = false
        let revision = ''
        let bootstrapped = false
        const scan = () => {
          const query = `?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}`
          return api(`games/list${query}`)
            .then((list) => {
              if (cancelled) return
              const activeSessions = (Array.isArray(list.sessions) ? list.sessions : [])
                .filter((session) => session && !session.finished && !session.orphaned)
              const sidebarRight = PanelHost.context?.get?.('sidebarRight')
              if (typeof sidebarRight?.openTab !== 'function') return
              for (const session of activeSessions) {
                if (autoOpenedGamesRef.current.has(session.id)) continue
                autoOpenedGamesRef.current.add(session.id)
                try { sidebarRight.openTab(GAMES_TAB_KIND) } catch {}
                break
              }
            })
            .catch(() => {})
        }
        const check = () => {
          if (cancelled || document.visibilityState === 'hidden') return
          void api('games/revision')
            .then((result) => {
              if (cancelled || typeof result.revision !== 'string' || result.revision === '') return
              if (!bootstrapped) {
                bootstrapped = true
                revision = result.revision
                return scan()
              }
              if (result.revision === revision) return
              revision = result.revision
              return scan()
            })
            .catch(() => {})
        }
        const timer = setInterval(check, GAMES_REVISION_POLL_MS)
        const onVisibility = () => { if (document.visibilityState === 'visible') check() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [binding?.character, binding?.chatId, architecture, binding?.group])
      if (!active || !binding) return null
      if (novelId !== null) {
        const novel = novelSummary || { title: novelId, status: 'active' }
        const novelStatus = novelStatusId(novel)
        const runNovelHeader = (action) => {
          if (action === 'stop' && !window.confirm(t('novel.stopConfirm', { name: novel.title || novelId }))) return
          void runNovelAction(novelId, action)
            .catch(() => {})
            .finally(() => {
              void fetchNovelDetail(novelId).then((next) => setNovelSummary(next)).catch(() => {})
            })
        }
        return h('div', { className: 'dt-header-character dt-header-novel', 'data-dsh-soulmojito-surface': 'header' },
          h('div', { className: 'dt-header-character-copy' },
            h('span', { className: 'dt-header-character-name', title: novel.title || novelId }, novel.title || novelId),
            h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatus}` },
              novelStatusLabel(t, novel),
              novel.status === 'paused' && novel.pauseReason ? ` · ${novelPauseReasonLabel(t, novel.pauseReason)}` : '')),
          h('div', { className: 'dt-header-novel-actions' },
            novelStatus === 'active' ? h('button', { type: 'button', title: t('novel.pause'), onClick: () => runNovelHeader('pause') }, t('novel.pause')) : null,
            novelStatus === 'paused' ? h('button', { type: 'button', title: t('novel.resume'), onClick: () => runNovelHeader('resume') }, t('novel.resume')) : null,
            novelStatus === 'active' ? h('button', {
              type: 'button',
              title: t('novel.stop'),
              'aria-label': t('novel.stop'),
              onClick: () => runNovelHeader('stop'),
            }, h(IconStopFill16)) : null,
            h('button', {
              type: 'button',
              title: t('novel.openPanel'),
              'aria-label': t('novel.openPanel'),
              onClick: () => openPanel('novels'),
            }, h(IconListPenOutline16))))
      }
      const statsLine = architecture === 'st' ? buildTavernStatsLine(stats, usage, t) : ''
      const submitRewrite = () => {
        if (run.busy) return
        const feedback = rewriteDraft
        setRewriteOpen(false)
        void generateFor(sessionId, binding, 'regenerate', '', { feedback })
      }
      return h('div', { ref: markerRef, className: 'dt-header-character', 'data-dsh-soulmojito-surface': 'header' },
        h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
        h('div', { className: 'dt-header-character-copy' },
          h('span', { className: 'dt-header-character-name' }, binding.character),
          h('span', { className: `dt-architecture-badge dt-architecture-${architecture}` }, architectureLabel(architecture)),
          statsLine ? h('span', { className: 'dt-header-stats', title: statsLine }, statsLine) : null),
        h('div', { className: 'dt-header-actions' },
          architecture === 'st'
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                title: t('view.regenerate'),
                'aria-label': t('view.regenerate'),
                disabled: run.busy,
                onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
              }, h(IconRefreshOutline16)),
              h('span', { className: 'dt-rewrite', ref: rewriteRef },
                h('button', {
                  type: 'button',
                  title: t('view.rewrite'),
                  'aria-label': t('view.rewrite'),
                  'aria-expanded': rewriteOpen,
                  disabled: run.busy,
                  onClick: () => { setRewriteDraft(''); setRewriteOpen(!rewriteOpen) },
                }, h(IconEditOutline16)),
                rewriteOpen ? h('div', { className: 'dt-rewrite-pop' },
                  h('textarea', {
                    value: rewriteDraft,
                    placeholder: t('view.rewriteFeedbackPlaceholder'),
                    rows: 3,
                    autoFocus: true,
                    onChange: (event) => setRewriteDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                        event.preventDefault()
                        submitRewrite()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setRewriteOpen(false)
                      }
                    },
                  }),
                  h('div', { className: 'dt-rewrite-actions' },
                    h('button', { type: 'button', onClick: () => setRewriteOpen(false) }, t('message.cancel')),
                    h('button', { type: 'button', className: 'dt-rewrite-go', disabled: run.busy, onClick: submitRewrite }, t('view.rewriteSubmit')))) : null))
            : h(React.Fragment, null,
              h('button', {
                type: 'button',
                title: t('view.forkArchitecture', { architecture: architectureLabel('st') }),
                disabled: run.busy,
                onClick: () => void forkTavernArchitecture(PanelHost.context, sessionId, binding),
              }, h(IconAgentPresetOutline16)),
              // AgentTavern 的 native conversation 由宿主渲染，插件正文区没有
              // 可插入的 slot：MVU 面板入口挂标题栏——右侧栏可用时开侧栏 tab
              // （ST 走 TavernView 内联面板，两架构都能从右栏 guide 进入）
              h('span', { className: 'dt-mvu-slot', ref: mvuRef },
                h('button', {
                  type: 'button',
                  title: t('mvu.title'),
                  'aria-label': t('mvu.title'),
                  'aria-expanded': mvuOpen,
                  onClick: openMvuSurface,
                }, h(IconDataOutline16)),
                mvuOpen ? h('div', { className: 'dt-mvu-pop' }, h(TavernMvuStatus, { sessionId, embedded: true })) : null)),
              // 游戏入口与 MVU 相邻（AgentTavern 标题栏）；ST 走 TavernView 内联
              // 对局面，不占标题栏。图标是手柄（与面板分区、侧栏 tab guide 同款）。
              h('button', {
                type: 'button',
                title: t('games.tabTitle'),
                'aria-label': t('games.tabTitle'),
                onClick: openGamesSurface,
              }, h(IconGamepadOutline16)),
              hasSidebarRight ? h('button', {
                type: 'button',
                title: t('frontend.title'),
                'aria-label': t('frontend.title'),
                onClick: openFrontendSurface,
              }, h(IconSparkle16)) : null,
          h('button', {
            type: 'button',
            title: t('view.openGuides'),
            'aria-label': t('view.openGuides'),
            onClick: () => openPanel('guides'),
          }, h(IconListPenOutline16))))
    }
