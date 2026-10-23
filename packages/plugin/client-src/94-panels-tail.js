    // Mod 管理分区（提案 0015 §3.5 P1）：列表数据来自 bootstrap.mods 投影，
    // 全局开关读 bootstrap.state.modsEnabled；写操作走 /mods 管理路由并重取
    // bootstrap（patchState 同款动作-刷新闭环；state.json 不进 store-revision
    // 水位，自动轮询不覆盖这条路径）。
    function PanelMods() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [pending, setPending] = useState('')
      const [confirming, setConfirming] = useState(null)
      const [installUrl, setInstallUrl] = useState('')
      const [installForce, setInstallForce] = useState(false)
      const [installStatus, setInstallStatus] = useState('')
      const run = (id, promise) => {
        setPending(id)
        setError('')
        void promise.then(refreshBootstrap).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setPending(''))
      }
      const mods = state.bootstrap.mods || []
      const available = state.bootstrap.modsAvailable !== false
      const globalEnabled = state.bootstrap.state.modsEnabled === true
      const setGlobalEnabled = (enabled) => run('global', api('mods/state', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ globalEnabled: enabled === true }),
      }))
      const enableMod = (mod) => run(mod.id, api(`mods/${encodeURIComponent(mod.id)}/enable`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: '{}',
      }))
      const disableMod = (mod) => run(mod.id, api(`mods/${encodeURIComponent(mod.id)}/disable`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: '{}',
      }))
      const reloadMod = (mod) => run(mod.id, api(`mods/${encodeURIComponent(mod.id)}/reload`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: '{}',
      }))
      // git 安装（提案 0015 §4 P2）：GitHub URL / owner/repo，可选 #ref；进度与
      // 结果就地反馈（安装是长操作——clone 可能几十秒，按钮锁死防重复提交）。
      const installFromGit = () => {
        const url = installUrl.trim()
        if (url === '' || busy('install')) return
        setInstallStatus(t('mods.install.installing'))
        void api('mods/install', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ url, ...(installForce ? { force: true } : {}) }),
        })
          .then((result) => {
            setInstallStatus(t('mods.install.done', { id: result.installed?.modId ?? '' }))
            setInstallUrl('')
            return refreshBootstrap()
          })
          .catch((cause) => setInstallStatus(t('mods.install.failed', { error: cause instanceof Error ? cause.message : String(cause) })))
      }
      const busy = (id) => pending === id
      const surfaceRows = (mod) => [
        { label: t('mods.confirmHooks'), entries: mod.surfaces?.hooks || [] },
        { label: t('mods.confirmTools'), entries: mod.surfaces?.tools || [] },
        { label: t('mods.confirmHttp'), entries: mod.surfaces?.http || [] },
      ]
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          !available
            ? h('p', { className: 'dt-hint' }, t('mods.unavailable'))
            : h(React.Fragment, null,
              h('p', { className: 'dt-hint' }, t('mods.globalHint')),
              h('div', { className: 'dt-imports' },
                h('label', { className: 'dt-toggle' },
                  h('input', {
                    type: 'checkbox',
                    disabled: busy('global'),
                    checked: globalEnabled,
                    onChange: (event) => setGlobalEnabled(event.target.checked),
                  }),
                  h('span', null, t('mods.globalToggle')))))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('mods.install.title')),
          h('p', { className: 'dt-hint' }, t('mods.install.hint')),
          h('div', { className: 'dt-mod-install' },
            h('input', {
              type: 'text',
              value: installUrl,
              placeholder: t('mods.install.placeholder'),
              disabled: busy('install'),
              onChange: (event) => setInstallUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') installFromGit() },
            }),
            h(Button, { size: 'sm', variant: 'outline', disabled: busy('install') || installUrl.trim() === '', onClick: installFromGit },
              busy('install') ? t('mods.install.installing') : t('mods.install.button')),
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: installForce,
                onChange: (event) => setInstallForce(event.target.checked),
              }),
              h('span', null, t('mods.install.force')))),
          installStatus ? h('p', { className: 'dt-hint' }, installStatus) : null),
        h('section', { className: 'dt-settings-band' },
          mods.length === 0
            ? h('p', { className: 'dt-muted' }, t('mods.empty', { path: 'soulmojito/mods/' }))
            : h('div', { className: 'dt-mod-list' }, mods.map((mod) => h('article', { key: mod.id, className: 'dt-mod-row' },
              h('div', { className: 'dt-mod-row-head' },
                h('strong', null, mod.name),
                h('span', { className: 'dt-mod-meta' }, `v${mod.version} · ${mod.author}`),
                h(Pill, { active: mod.status === 'loaded' }, t(`mods.status.${mod.status}`))),
              h('p', { className: 'dt-mod-desc' }, mod.description),
              h('div', { className: 'dt-mod-cap' },
                h('span', { className: 'dt-mod-cap-label' }, t('mods.confirmCapabilities')),
                (mod.capabilities || []).length === 0
                  ? h('span', null, t('mods.capability.none'))
                  : mod.capabilities.map((capability) => h(Pill, { key: capability }, t(`mods.capability.${capability}`))),
                // 声明式按钮（A-1a）：能力 Pill 区披露按钮数（按钮渲染进宿主 UI）。
                (mod.buttons || []).length > 0
                  ? h(Pill, { key: 'buttons' }, t('mods.buttonsPill', { count: mod.buttons.length }))
                  : null),
              mod.error ? h('p', { className: 'dt-error' }, mod.error) : null,
              h('div', { className: 'dt-mod-actions' },
                h('span', { className: 'dt-mod-meta' }, t('mods.auditCount', { count: mod.auditCount ?? 0 })),
                mod.status === 'loaded'
                  ? h(React.Fragment, null,
                    mod.panel
                      ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => update({ panelSection: `mod:${mod.id}`, panelOpen: true }) }, t('mods.openPanel'))
                      : null,
                    h(Button, { size: 'sm', variant: 'outline', disabled: busy(mod.id), onClick: () => disableMod(mod) }, busy(mod.id) ? t('mods.busy') : t('mods.disable')),
                    h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefreshOutline16), disabled: busy(mod.id), onClick: () => reloadMod(mod) }, t('mods.reload')))
                  : mod.status === 'disabled'
                    ? h(Button, { size: 'sm', variant: 'outline', disabled: busy(mod.id) || !available, onClick: () => setConfirming(mod) }, busy(mod.id) ? t('mods.busy') : t('mods.enable'))
                    : null)))),
          error ? h('p', { className: 'dt-error' }, error) : null),
        confirming
          ? h(Modal, {
            open: true,
            onClose: () => setConfirming(null),
            title: t('mods.confirmTitle', { name: confirming.name }),
            closeLabel: t('panel.close'),
          },
            h('div', { className: 'dt-settings-band dt-mod-confirm' },
              h('p', { className: 'dt-hint' }, t('mods.confirmBody')),
              h('div', { className: 'dt-mod-cap' },
                h('span', { className: 'dt-mod-cap-label' }, t('mods.confirmCapabilities')),
                (confirming.capabilities || []).length === 0
                  ? h('span', null, t('mods.capability.none'))
                  : confirming.capabilities.map((capability) => h(Pill, { key: capability }, t(`mods.capability.${capability}`))),
                // 声明按钮（A-1a 知情同意面）：按钮渲染进宿主 UI（面板 chips + 聊天
                // 按钮行），点击会执行该 Mod 的 handler——数量与名单在此披露。
                (confirming.buttons || []).length > 0
                  ? h(Pill, { key: 'buttons' }, t('mods.buttonsPill', { count: confirming.buttons.length }))
                  : null),
              (confirming.buttons || []).length > 0 ? h('div', { className: 'dt-mod-cap' },
                h('span', { className: 'dt-mod-cap-label' }, t('mods.confirmButtons')),
                confirming.buttons.map((name, index) => h(Pill, { key: `${name}:${index}` }, name))) : null,
              // §3.5：确认弹层展示声明的 hooks/tools/http 注册面。disabled mod
              // 展示 manifest 声明（作者自查），loaded 展示实际注册名单。
              h('p', { className: 'dt-hint' }, t('mods.confirmSurfacesHint')),
              surfaceRows(confirming).map(({ label, entries }) => h('div', { key: label, className: 'dt-mod-cap' },
                h('span', { className: 'dt-mod-cap-label' }, label),
                entries.length === 0
                  ? h('span', null, t('mods.confirmSurfacesNone'))
                  : entries.map((entry, index) => h(Pill, { key: `${entry}:${index}` }, entry)))),
              h('div', { className: 'dt-imports' },
                h(Button, { variant: 'outline', onClick: () => setConfirming(null) }, t('panel.cancel')),
                h(Button, {
                  variant: 'primary',
                  onClick: () => {
                    const target = confirming
                    setConfirming(null)
                    enableMod(target)
                  },
                }, t('mods.enable')))))
          : null)
    }

    // 关于分区：纯静态信息面——头部品牌面是 logo 组件（与面板品牌块同源）加
    // 正式写法 DSH-SoulMojito（旧的小写 dsh-soulmojito 只是目录名习惯），版本
    // stamp 与面板品牌区同源（bootstrap.version/commit），官网/作者/源码仓库
    // 三行外链。无状态、无 API 调用。
    function PanelAbout() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const stamp = bootstrap.version || bootstrap.commit
        ? `v${bootstrap.version || '?'}${bootstrap.commit ? ` (${bootstrap.commit})` : ''}`
        : ''
      const links = [
        { key: 'website', href: 'https://tavern.lingyesoul.top', text: 'tavern.lingyesoul.top' },
        { key: 'author', href: 'https://space.bilibili.com/298721157', text: '泠夜Soul' },
        { key: 'repo', href: 'https://github.com/LingyeSoul/DSH-SoulMojito', text: 'github.com/LingyeSoul/DSH-SoulMojito' },
      ]
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-about-head' },
          h(SoulMojitoLogo, { size: 40 }),
          h('div', { className: 'dt-about-head-copy' },
            h('h3', null, 'DSH-SoulMojito'),
            stamp ? h('p', { className: 'dt-update-stamp' }, stamp) : null)),
        h('p', { className: 'dt-hint' }, t('panel.about.tagline')),
        h('div', { className: 'dt-about-links' },
          links.map((link) => h('div', { key: link.key, className: 'dt-about-row' },
            h('span', { className: 'dt-about-label' }, t(`panel.about.${link.key}`)),
            h('a', { href: link.href, target: '_blank', rel: 'noreferrer noopener' }, link.text)))))
    }

    function TavernPanel({ ctx, useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      // 分区跟随 store 的 panelSection（openPanel(section) 可在面板已打开时切换，
      // 例如小说会话头的“打开小说面板”入口）；导航点击同步写回 store。
      const section = state.panelSection || 'overview'
      const expanded = state.panelExpanded === true
      // 分区清单过滤（2026-10-21 导航重做）：组件内临时态——过滤词不跨面板打开
      // 保留（重开面板从完整清单开始，比记住上次的过滤词更符合「打开即全貌」）。
      const [filter, setFilter] = useState('')
      const navRef = useRef(null)
      const navlistRef = useRef(null)
      const bodyRef = useRef(null)
      // 分区滚动位置记忆：切走时记下 scrollTop、切回时还原——长清单（聊天/
      // 剧本/方案）来回切不再被打回顶部。组件实例随面板开关重建，记忆同样
      // 不跨打开保留。
      const scrollMemory = useRef({})
      const trackedSection = useRef(section)
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      useEffect(() => {
        const body = bodyRef.current
        if (body === null) return
        if (trackedSection.current !== section) {
          scrollMemory.current[trackedSection.current] = body.scrollTop
          trackedSection.current = section
        }
        body.scrollTop = scrollMemory.current[section] ?? 0
      }, [section])
      // Mobile section strip: reveal the active chip when the section changes
      // outside the strip (overview stat cards, session header entries). The
      // desktop nav is a fixed-width column, so the overflow guard is a no-op.
      useEffect(() => {
        if (!state.panelOpen) return
        const nav = navRef.current
        if (nav === null || nav.scrollWidth <= nav.clientWidth) return
        const chip = Array.from(nav.querySelectorAll('[data-dt-section]'))
          .find((button) => button.getAttribute('data-dt-section') === section)
        if (chip === undefined) return
        const navRect = nav.getBoundingClientRect()
        const chipRect = chip.getBoundingClientRect()
        const left = nav.scrollLeft + chipRect.left - navRect.left - (navRect.width - chipRect.width) / 2
        nav.scrollLeft = Math.max(0, left)
      }, [section, state.panelOpen])
      const stamp = state.bootstrap.version || state.bootstrap.commit
        ? `v${state.bootstrap.version || '?'}${state.bootstrap.commit ? ` (${state.bootstrap.commit})` : ''}`
        : ''
      // 分区经注册表解析：未知 section 回落到注册表首项（overview 必为首条
      // 注册），与三元链时代 `: h(PanelOverview)` 的兜底等价。
      const activeSection = panelSections.find((item) => item.id === section) ?? panelSections[0]
      const body = activeSection.component({ ctx, useSessions })
      // 过滤与分组：匹配按分区显示名（当前 locale）小写包含；组内保持注册顺序，
      // overview/about 无组——注册表里第一个带组分区之前的无组项置顶（overview），
      // 其余无组项（about 及未来新增）垫在组清单之后。
      const query = filter.trim().toLowerCase()
      const visibleSections = query === ''
        ? panelSections
        : panelSections.filter((item) => item.label(t).toLowerCase().includes(query))
      const firstGroupedIndex = panelSections.findIndex((item) => item.group !== undefined)
      const topIds = new Set(panelSections.slice(0, firstGroupedIndex === -1 ? panelSections.length : firstGroupedIndex).map((item) => item.id))
      const topUngrouped = visibleSections.filter((item) => topIds.has(item.id))
      const bottomUngrouped = visibleSections.filter((item) => item.group === undefined && !topIds.has(item.id))
      const groupedSections = panelSectionGroups
        .map((group) => ({ group, items: visibleSections.filter((item) => item.group === group.id) }))
        .filter((entry) => entry.items.length > 0)
      const visibleIds = visibleSections.map((item) => item.id)
      const sectionCell = (item) => h('button', {
        key: item.id,
        type: 'button',
        className: `dt-panel-navcell ${section === item.id ? 'dt-panel-navcell-active' : ''}`,
        'aria-current': section === item.id ? 'page' : undefined,
        'data-dt-section': item.id,
        onClick: () => update({ panelSection: item.id }),
      }, h(item.icon), h('span', { className: 'dt-panel-navcell-label' }, item.label(t)), h('span', { className: 'dt-panel-navcell-index', 'aria-hidden': 'true' }, String(panelSections.indexOf(item) + 1).padStart(2, '0')))
      // 键盘导航：↑↓ 在可见分区间移动激活（同步聚焦按钮，屏幕阅读器跟随），
      // Home/End 跳首尾；原生 Tab 序不受影响。
      const focusSectionButton = (id) => {
        const buttons = navlistRef.current?.querySelectorAll('[data-dt-section]') ?? []
        for (const button of buttons) {
          if (button.getAttribute('data-dt-section') === id) {
            button.focus()
            break
          }
        }
      }
      const activateSection = (id) => {
        update({ panelSection: id })
        requestAnimationFrame(() => focusSectionButton(id))
      }
      const handleNavKeyDown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        if (visibleIds.length === 0) return
        event.preventDefault()
        const index = visibleIds.indexOf(section)
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? visibleIds.length - 1
            : event.key === 'ArrowDown' ? Math.min(index + 1, visibleIds.length - 1)
              : Math.max(index - 1, 0)
        if (visibleIds[next] !== undefined && visibleIds[next] !== section) activateSection(visibleIds[next])
      }
      return h('div', { className: 'dt-panel' },
        // 导航列分三段（2026-10-21 导航重做）：品牌块与过滤框常驻不滚，只滚
        // 分组分区清单——分区数会随 Mod 面板注册增长，长到溢出时原来整列滚动
        // 会把「这是酒馆面板」的标题一起卷走（品牌钉住是 2026-10-14 反馈的
        // 既有契约，过滤框与其同段）。
        h('nav', { className: 'dt-panel-nav', 'aria-label': t('panel.nav'), ref: navRef },
          h('div', { className: 'dt-panel-brand' },
            h('span', { className: 'dt-panel-brand-mark' }, h(SoulMojitoLogo)),
            h('div', { className: 'dt-panel-brand-copy' },
              h('strong', null, 'SoulMojito'),
              stamp ? h('span', { className: 'dt-panel-brand-version' }, stamp) : null)),
          h('input', {
            type: 'search',
            className: 'dt-panel-search',
            value: filter,
            placeholder: t('panel.searchPlaceholder'),
            'aria-label': t('panel.searchPlaceholder'),
            onChange: (event) => setFilter(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape' && filter !== '') setFilter('') },
          }),
          h('div', { className: 'dt-panel-navlist', ref: navlistRef, onKeyDown: handleNavKeyDown },
            topUngrouped.map(sectionCell),
            groupedSections.map(({ group, items }) => h('div', { key: group.id, className: 'dt-panel-group' },
              h('div', { className: 'dt-panel-group-label' }, group.label(t)),
              items.map(sectionCell))),
            bottomUngrouped.map(sectionCell),
            visibleSections.length === 0
              ? h('p', { className: 'dt-panel-search-empty' }, t('panel.searchEmpty'))
              : null)),
        h('div', { className: 'dt-panel-main' },
          h('header', { className: 'dt-panel-header' },
            h('div', { className: 'dt-panel-heading' },
              h('span', { className: 'dt-panel-heading-index', 'aria-hidden': 'true' }, `${String(panelSections.indexOf(activeSection) + 1).padStart(2, '0')} / ${String(panelSections.length).padStart(2, '0')}`),
              h('h2', null, activeSection.label(t))),
            h('div', { className: 'dt-panel-header-actions' },
              h('button', {
                type: 'button',
                className: 'dt-panel-expand',
                'aria-label': expanded ? t('panel.collapse') : t('panel.expand'),
                title: expanded ? t('panel.collapse') : t('panel.expand'),
                onClick: () => update({ panelExpanded: !expanded }),
              }, h(expanded ? IconCollapse16 : IconExpand16)),
              h('button', {
                type: 'button',
                className: 'dt-panel-close',
                'aria-label': t('panel.close'),
                onClick: closePanel,
              }, h(IconCloseOutline16)))),
          h('div', { className: 'dt-panel-body', ref: bodyRef }, body)))
    }

    // shell.overlay 占用者：常驻挂载，四件事——隐藏原生树中的 Tavern 会话、
    // 侧边栏会话树注入（快速切换）、会话绑定清理、Tavern 管理面板。
    function PanelHost({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionIds = useSessions((value) => value.ids)
      const sessionPhase = useSessions((value) => value.phase)
      const currentSession = useCurrentSessionId(useSessions)
      const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})
      const currentBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const agentTavernActive = Boolean(currentBinding && bindingArchitecture(currentBinding) === 'agent-tavern')
      // AgentTavern stays hidden from the native session tree, but its native
      // conversation view must not be forced into the legacy Tavern tab.
      useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))
      // Regex display for the host-native assistant rows: register the
      // assistant-step override only while the active session is AgentTavern,
      // so ordinary DSH chats keep the host renderer untouched.
      useEffect(() => {
        if (!agentTavernActive) return undefined
        let dispose
        try {
          dispose = registerTavernAssistantNode(PanelHost.context)
        } catch (cause) {
          console.warn('[dsh-soulmojito] assistant display override unavailable:', cause)
          return undefined
        }
        return () => { if (typeof dispose === 'function') dispose() }
      }, [agentTavernActive])
      useNativeSessionTreeFilter(bindingIds, PanelHost.context, [state.bootstrap.internalWorkspace?.path, state.bootstrap.workbenchWorkspace?.path].filter(Boolean).join('\u0000'))
      const host = useSidebarHost()
      useEffect(() => {
        if (sessionPhase !== 'ready') return
        if (bindingIds.every((sessionId) => sessionIds.includes(sessionId))) return
        void api('bindings/prune', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionIds }),
        }).then((result) => update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })).catch(() => {})
      }, [sessionPhase, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      // 存量修复：旧版本激活的绑定会话在宿主侧仍是 blank（无 turn/start），会被
      // 原生「新建会话」的 blank 复用逻辑劫持。会话列表就绪后对宿主仍标记 blank
      // 的绑定会话统一修复（repairBinding 幂等、失败可重试；点击聊天/Tavern 视图
      // 挂载两个路径也会补触发）。
      useEffect(() => {
        if (sessionPhase !== 'ready' || state.loading) return
        const ctx = PanelHost.context
        const byId = ctx?.sessions?.list?.getSnapshot?.().byId
        if (!byId) return
        for (const [sessionId, binding] of Object.entries(snapshot.bootstrap.state.sessionBindings || {})) {
          if (byId[sessionId]?.blank !== true) continue
          void repairBinding(ctx, sessionId, binding)
        }
      }, [sessionPhase, state.loading, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      useEffect(() => {
        const toggle = () => update({ panelOpen: !snapshot.panelOpen })
        window.addEventListener('dsh-soulmojito:toggle-panel', toggle)
        return () => window.removeEventListener('dsh-soulmojito:toggle-panel', toggle)
      }, [])
      // 后台写入（写卡 Agent 等）没有推送通道：页面可见期间按 3s 轮询 store
      // 变更水位，水位一变就重取 bootstrap——角色卡/世界书/预设与侧栏自动吸收，
      // 不再需要手动刷新网页。refreshing 防抖避免慢请求期间重复触发。
      useEffect(() => {
        let disposed = false
        let refreshing = false
        const check = () => {
          if (disposed || refreshing || document.visibilityState === 'hidden') return
          refreshing = true
          void fetchStoreRevision()
            .then((revision) => {
              if (disposed || revision === '' || revision === snapshot.bootstrap.storeRevision) return undefined
              return refreshBootstrap()
            })
            .catch(() => {})
            .finally(() => { refreshing = false })
        }
        const timer = setInterval(check, STORE_REVISION_POLL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [])
      // 打开面板先无条件重取一次：不等下一拍水位轮询，打开即最新。
      useEffect(() => {
        if (!state.panelOpen) return
        void refreshBootstrap().catch(() => {})
      }, [state.panelOpen])
      return h(React.Fragment, null,
        host ? createPortal(h(TavernSidebar, { ctx: PanelHost.context, useSessions }), host) : null,
        h(Modal, {
          open: state.panelOpen,
          onClose: closePanel,
          title: t('panel.title'),
          closeLabel: t('panel.close'),
          headless: true,
          // 全屏态（2026-10-21 导航重做）：dt-panel-modal-full 吃满视口减 24px；
          // 与基础宽高的 min() 取法同源，窄屏天然回落。
          className: `dt-panel-modal${state.panelExpanded === true ? ' dt-panel-modal-full' : ''}`,
        }, h(TavernPanel, { ctx: PanelHost.context, useSessions })))
    }

    // 常驻侧栏 footer 主入口（与宿主 Settings 按钮同排）：点击打开 Tavern 管理面板。
    // 与原生 Settings trigger 同款：宽栏 34px 行，rail 36px 圆形图标钮。
    function SidebarFooterAction({ wide }) {
      const t = useTranslate()
      const button = h('button', {
        type: 'button',
        className: `dt-footer-action ${wide ? 'dt-footer-action-wide' : 'dt-footer-action-rail'}`,
        // Accessible name repeats the visible label: the wide variant shows the
        // brand text, and WCAG 2.5.3 (label in name) requires the name to
        // contain it -- otherwise voice control cannot match what is on screen.
        'aria-label': `${t('panel.open')} · SoulMojito`,
        title: t('panel.title'),
        onClick: () => openPanel(),
      }, h(SoulMojitoLogo, { size: wide ? 16 : 18 }), wide ? h('span', { className: 'dt-footer-label' }, 'SoulMojito') : null)
      return wide ? button : h(Tooltip, { label: t('panel.open'), side: 'right' }, button)
    }
