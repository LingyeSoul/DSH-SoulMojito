    function apply(ctx) {
      installStyle()
      PanelHost.context = ctx
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }), 'dsh-soulmojito: locale dictionaries')
      translate = ctx.locale.bind(LOCALE_NS)
      subscribeLocale = (listener) => ctx.locale.subscribe(listener)
      getLocaleRevision = () => ctx.locale.getSnapshot()
      void refreshBootstrap().catch(() => {})
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-soulmojito',
        order: 45,
        label: () => 'dsh-soulmojito',
        inject: () => ({}),
      }, TavernSettings))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'tavern',
        order: 20,
        label: () => translate('nav.title'),
        inject: () => ({}),
      }, TavernView))
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -20,
        select: selectTavernComposer,
        inject: () => ({}),
      }, TavernComposer))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'dsh-soulmojito',
        order: -5,
        inject: () => ({}),
      }, TavernHeaderAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-soulmojito-panel',
        order: 20,
        inject: () => ({}),
      }, PanelHost))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-soulmojito-panel',
        order: 20,
        inject: () => ({}),
      }, SidebarFooterAction))
      // DSH 原生右侧栏（宿主 ≥0.2.0-rc.2 的 ui-sidebar-right）：MVU 面板注册为
      // 页面型 tab（无 patterns、按 kind 打开），guide 入口让任意会话都能从右栏
      // 的「+」进入。sidebarRightTabs/sidebarRight 经 ctx.inject 动态等待——服务
      // 就绪时回调生效、离开时随 scope 整体卸载；刻意不进 exports.inject：旧宿
      // 主没有这两个服务，硬注入会让插件 apply 永久挂起，回退只剩标题栏弹层，
      // 行为与侧栏存在前一致。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
          sidebarRightServiceReady = true
          scope.effect(() => scope.sidebarRightTabs.register({
            id: MVU_TAB_ID,
            kind: MVU_TAB_KIND,
            priority: 'extension',
            title: () => translate('mvu.title'),
            guide: [{
              id: 'mvu',
              order: 40,
              title: () => translate('mvu.title'),
              description: () => translate('mvu.guide.description'),
              icon: IconDataOutline16,
            }],
          }), 'dsh-soulmojito: sidebar-right mvu tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: MVU_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, TavernMvuSidebarTab)), 'dsh-soulmojito: sidebar-right mvu tab body')
          // 对局面 tab（2026-10-14 修订）：与 MVU tab 同位——AgentTavern 的原生
          // 会话没有 TavernView 正文 slot，对局棋盘以右栏 tab 展示；对局开始时
          // 由 TavernHeaderAction 的 watcher 自动展开（openTab），也可从右栏
          // 「+」guide 手动进入。
          scope.effect(() => scope.sidebarRightTabs.register({
            id: GAMES_TAB_ID,
            kind: GAMES_TAB_KIND,
            priority: 'extension',
            title: () => translate('games.tabTitle'),
            guide: [{
              id: 'games',
              order: 41,
              title: () => translate('games.tabTitle'),
              description: () => translate('games.guide.description'),
              icon: IconGamepadOutline16,
            }],
          }), 'dsh-soulmojito: sidebar-right games tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: GAMES_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, TavernGamesSidebarTab)), 'dsh-soulmojito: sidebar-right games tab body')
          // 美化前端 tab（2026-10-20）：AgentTavern 会话的消息内 HTML 没有正文
          // slot，最新一条带完整 HTML 的楼层改由右栏承载（MVU/游戏同款姿势）。
          // ST 架构仍在消息里内联渲染，panel 对 ST 只给说明空态，不重复执行。
          scope.effect(() => scope.sidebarRightTabs.register({
            id: FRONTEND_TAB_ID,
            kind: FRONTEND_TAB_KIND,
            priority: 'extension',
            title: () => translate('frontend.title'),
            guide: [{
              id: 'frontend',
              order: 42,
              title: () => translate('frontend.title'),
              description: () => translate('frontend.guide.description'),
              icon: IconSparkle16,
            }],
          }), 'dsh-soulmojito: sidebar-right frontend tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: FRONTEND_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, TavernFrontendSidebarTab)), 'dsh-soulmojito: sidebar-right frontend tab body')
          // 卡脚本 tab（2026-10-21）：卡内 tavern_helper 脚本树不会自动执行，
          // 右栏只提供手动运行入口；正文列表与沙箱 iframe 见 88b 片段。
          scope.effect(() => scope.sidebarRightTabs.register({
            id: CARD_SCRIPTS_TAB_ID,
            kind: CARD_SCRIPTS_TAB_KIND,
            priority: 'extension',
            title: () => translate('cardScripts.title'),
            guide: [{
              id: 'card-scripts',
              order: 43,
              title: () => translate('cardScripts.title'),
              description: () => translate('cardScripts.guide.description'),
              icon: IconListPenOutline16,
            }],
          }), 'dsh-soulmojito: sidebar-right card scripts tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: CARD_SCRIPTS_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, TavernCardScriptsSidebarTab)), 'dsh-soulmojito: sidebar-right card scripts tab body')
        })
      }
    }
