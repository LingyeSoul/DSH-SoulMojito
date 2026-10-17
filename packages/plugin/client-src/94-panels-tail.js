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
            ? h('p', { className: 'dt-muted' }, t('mods.empty', { path: 'tavern/mods/' }))
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
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const stamp = state.bootstrap.version || state.bootstrap.commit
        ? `v${state.bootstrap.version || '?'}${state.bootstrap.commit ? ` (${state.bootstrap.commit})` : ''}`
        : ''
      // 分区经注册表解析：未知 section 回落到注册表首项（overview 必为首条
      // 注册），与三元链时代 `: h(PanelOverview)` 的兜底等价。
      const activeSection = panelSections.find((item) => item.id === section) ?? panelSections[0]
      const body = activeSection.component({ ctx, useSessions })
      return h('div', { className: 'dt-panel' },
        // 导航列分两段（2026-10-14 用户反馈：红框的 Tavern 标题区要钉住）：
        // 品牌块常驻不滚，只滚分区清单——分区数会随 Mod 面板注册增长，长到
        // 溢出时原来整列滚动会把「这是酒馆面板」的标题一起卷走。
        h('nav', { className: 'dt-panel-nav', 'aria-label': t('panel.nav') },
          h('div', { className: 'dt-panel-brand' },
            h(SoulMojitoLogo),
            h('div', { className: 'dt-panel-brand-copy' },
              h('strong', null, 'SoulMojito'),
              stamp ? h('span', null, stamp) : null)),
          h('div', { className: 'dt-panel-navlist' },
            panelSections.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: `dt-panel-navcell ${section === item.id ? 'dt-panel-navcell-active' : ''}`,
              'aria-current': section === item.id ? 'page' : undefined,
              onClick: () => update({ panelSection: item.id }),
            }, h(item.icon), h('span', null, item.label(t)))))),
        h('div', { className: 'dt-panel-main' },
          h('header', { className: 'dt-panel-header' },
            h('h2', null, activeSection.label(t)),
            h('button', {
              type: 'button',
              className: 'dt-panel-close',
              'aria-label': t('panel.close'),
              onClick: closePanel,
            }, h(IconCloseOutline16))),
          h('div', { className: 'dt-panel-body' }, body)))
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
      // AgentTavern stays hidden from the native session tree, but its native
      // conversation view must not be forced into the legacy Tavern tab.
      useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))
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
          className: 'dt-panel-modal',
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
