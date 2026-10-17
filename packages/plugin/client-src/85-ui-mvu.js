    // MVU 状态与回执（提案 0012 P1）：ST 聊天挂在 TavernView 顶部的常驻面板，
    // AgentTavern 会话改由标题栏按钮弹出同一面板（embedded 变体）——原生
    // conversation 是宿主表面，插件没有可插入正文区的 slot，标题栏是两架构共有
    // 的插件挂载点。宿主带原生右侧栏（ui-sidebar-right，≥0.2.0-rc.2）时同一
    // 面板还注册为页面型 tab（sidebar 变体）：面板成为会话右栏的一页而不是
    // 弹层，标题栏按钮优先打开侧栏 tab，旧宿主回退弹层。
    // available=false（本局无变量也无回执）时内联整块隐藏；sidebar/embedded 是
    // 用户主动打开的表面，保留空态提示。renderedHtml 存在（卡带 statusTemplate）
    // 时用 FrontendFrame 同款沙箱渲染，否则退回变量键值表（嵌套对象折叠成
    // 路径.值；sidebar 变体按顶层段分组展示）。
    // 重试按钮只对 ST 绑定暴露——POST mvu/retry 重跑的是 ST 生成链路的模板
    // 输出渲染（AgentTavern 会话服务端 409 TAVERN_ARCHITECTURE_CONFLICT）；群聊
    // 走 ST 链路，服务端按楼层发言人回落支持重试（src/mvu.ts），同样暴露。
    // 撤销按钮（B-6a）对两架构开放：撤销的是回执记录的变量变更（服务端按绑定
    // 架构改派执行核），与重跑渲染无关；已撤销回执灰显 + undone 徽标。
    function flattenMvuVariables(value, prefix = '') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
      const rows = []
      for (const [name, entry] of Object.entries(value)) {
        const path = prefix === '' ? name : `${prefix}.${name}`
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          rows.push(...flattenMvuVariables(entry, path))
        } else {
          rows.push([path, entry])
        }
      }
      return rows
    }

    // sidebar 变体的变量分组：顶层段做组名，剩余路径做组内行键（无剩余路径时
    // 行键退化为 '·' 占位，值即组值本身——单层变量树不因分组丢行）。
    function groupMvuVariables(rows) {
      const groups = []
      const byName = new Map()
      for (const [path, value] of rows) {
        const separator = path.indexOf('.')
        const name = separator === -1 ? path : path.slice(0, separator)
        const rest = separator === -1 ? '·' : path.slice(separator + 1)
        if (!byName.has(name)) {
          byName.set(name, { name, rows: [] })
          groups.push(byName.get(name))
        }
        byName.get(name).rows.push([rest, value])
      }
      return groups
    }

    function formatMvuValue(value, limit = 96) {
      const text = typeof value === 'string' ? value : (() => {
        try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
      })()
      return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
    }

    // 原生会话（AgentTavern / 原生 conversation）的生成走宿主 AgentLoop：楼层
    // 投影、MVU 结算、tavern_script_advance 全在服务端落库，插件本地
    // chats/revisions 收不到任何信号（saved SSE 只在 ST 链路发）；后台写路径同
    // 样没有推送通道。MVU 面板 / 剧本进度卡这类「服务端权威」的会话面板因此补
    // 一条可见性门控的低频轮询（对齐 bootstrap 水位 3s / novel 10s 轮询的既有
    // 模式）：页面可见期间每 5s 重取，回前台立即补一拍，隐藏期间停发。load 经
    // latest ref 恒取最新闭包，父级重渲染不重置定时器；错误语义由 load 自理
    // （瞬时错误保留上次快照，404 才回落空态）。
    const SESSION_PANEL_POLL_MS = 5000

    function useSessionPanelPoll(load, deps) {
      const latest = useRef(load)
      useEffect(() => { latest.current = load })
      useEffect(() => {
        let cancelled = false
        let inFlight = false
        const tick = () => {
          if (cancelled || inFlight || document.visibilityState === 'hidden') return
          inFlight = true
          void Promise.resolve(latest.current())
            .catch(() => {})
            .finally(() => { inFlight = false })
        }
        const timer = setInterval(tick, SESSION_PANEL_POLL_MS)
        const onVisibility = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, deps)
    }

    function TavernMvuStatus({ sessionId, embedded = false, sidebar = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const chat = binding ? state.chats[key] : null
      // revision / 楼层计数变化（生成、重试、写路径）后重取状态快照
      const revision = binding ? state.revisions[key] : undefined
      const messageCount = chat?.messages?.length ?? 0
      const frameToken = useId()
      const [status, setStatus] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [expandedReceipt, setExpandedReceipt] = useState('')
      const [showAllReceipts, setShowAllReceipts] = useState(false)
      const autoOpenedFor = useRef('')
      const reload = () => {
        if (!binding) return Promise.resolve(null)
        return loadMvuStatus(binding.character, binding.chatId).catch(() => null)
      }
      useEffect(() => {
        if (!binding) return undefined
        let cancelled = false
        // 读取失败（含 404 聊天竞态）静默隐藏本面板，不打扰正文流
        void loadMvuStatus(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setStatus(result) })
          .catch(() => { if (!cancelled) setStatus(null) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, revision, messageCount])
      // 原生会话 / 后台写路径不经过本地 revision：可见期间轮询补齐自动刷新
      useSessionPanelPoll(() => {
        if (!binding) return Promise.resolve()
        return loadMvuStatus(binding.character, binding.chatId)
          .then((result) => { setStatus(result) })
          .catch((cause) => {
            // 404（聊天删除 / 竞态）才回落空态；瞬时错误保留上次快照不打扰
            if (cause?.status === 404) setStatus(null)
          })
      }, [binding?.character, binding?.chatId])
      // 每个聊天最多自动展开一次（对齐 TavernCandidates）；用户手动收起后不再弹开。
      // sidebar 变体没有折叠头（tab chip 就是容器），不参与自动展开。
      useEffect(() => {
        if (sidebar || !key || status?.available !== true) return
        if (autoOpenedFor.current === key) return
        autoOpenedFor.current = key
        setOpen(true)
      }, [key, status?.available])
      const receipts = Array.isArray(status?.receipts) ? status.receipts : []
      const latest = receipts[receipts.length - 1]
      // 最新有效回执（newest-first 链头）：最后一个未标 undoneAt 的条目——撤销
      // 服务端按同一判据选目标（B-6a）；全已撤销 / 无回执时按钮隐藏。
      const latestValid = (() => {
        for (let index = receipts.length - 1; index >= 0; index--) {
          if (!receipts[index].undoneAt) return receipts[index]
        }
        return undefined
      })()
      const canRetry = Boolean(binding)
        && bindingArchitecture(binding) === 'st'
        && latest !== undefined
        && (latest.status === 'failed' || (Array.isArray(latest.failures) && latest.failures.length > 0))
      // 撤销对两架构开放（AgentTavern settle 回执同样可撤销）。
      const canUndo = Boolean(binding) && latestValid !== undefined
      const retry = () => {
        if (!binding || busy) return
        setBusy(true)
        setError('')
        void (async () => {
          try {
            // 写走 revision CAS，必须先确保本地拿得到当前 revision
            await loadChat(binding.character, binding.chatId)
            const result = await retryMvuSettlement(sessionId, binding)
            const next = await reload()
            if (next) setStatus(next)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
              await loadChat(binding.character, binding.chatId, true).catch(() => {})
              const next = await reload()
              if (next) setStatus(next)
            }
          } finally {
            setBusy(false)
          }
        })()
      }
      const undo = () => {
        if (!binding || busy) return
        setBusy(true)
        setError('')
        void (async () => {
          try {
            await loadChat(binding.character, binding.chatId)
            await undoMvuSettlement(binding)
            const next = await reload()
            if (next) setStatus(next)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
              await loadChat(binding.character, binding.chatId, true).catch(() => {})
              const next = await reload()
              if (next) setStatus(next)
            }
          } finally {
            setBusy(false)
          }
        })()
      }
      // 回执卡片与「展开全部」钮在三个变体（内联 / 弹层 / 侧栏）间共享，收进
      // 组件内闭包：状态（expandedReceipt / showAllReceipts）挂在同一实例上。
      const receiptCard = (receipt, index) => {
        const rowKey = `${index}-${receipt.turnKey}-${receipt.at}`
        const changes = Array.isArray(receipt.changes) ? receipt.changes : []
        const failures = Array.isArray(receipt.failures) ? receipt.failures : []
        const expanded = expandedReceipt === rowKey
        const shownChanges = expanded ? changes : changes.slice(0, 3)
        // 已撤销回执（B-6a）：灰显 + undone 徽标，与状态徽标并排呈现。
        const undone = typeof receipt.undoneAt === 'string' && receipt.undoneAt !== ''
        return h('div', { key: rowKey, className: undone ? 'dt-mvu-receipt dt-mvu-receipt-undone' : 'dt-mvu-receipt' },
          h('div', { className: 'dt-mvu-receipt-head' },
            h('span', { className: `dt-mvu-badge dt-mvu-badge-${receipt.status}` }, t(`mvu.status.${receipt.status}`)),
            undone ? h('span', { className: 'dt-mvu-badge dt-mvu-badge-undone' }, t('mvu.status.undone')) : null,
            h('span', { className: 'dt-mvu-meta' }, `${t('mvu.turn', { turn: receipt.turnKey })} · ${formatNovelTime(receipt.at)}`)),
          shownChanges.map((change) => h('div', { key: change.name, className: 'dt-mvu-change' },
            t('mvu.change', {
              name: change.name,
              before: 'before' in change ? formatMvuValue(change.before) : '∅',
              after: 'after' in change ? formatMvuValue(change.after) : '∅',
            }))),
          changes.length > 3 ? h('button', {
            type: 'button',
            className: 'dt-mvu-more',
            onClick: () => setExpandedReceipt(expanded ? '' : rowKey),
          }, t('mvu.more', { count: changes.length - 3 })) : null,
          failures.length > 0 ? h('div', { className: 'dt-mvu-failures' },
            h('span', { className: 'dt-mvu-failures-title' }, t('mvu.failures')),
            failures.map((failure, failureIndex) => h('div', { key: failureIndex, className: 'dt-mvu-failure' }, failure))) : null)
      }
      const visibleReceipts = (showAllReceipts ? receipts : receipts.slice(-5)).slice().reverse()
      const hiddenReceipts = Math.max(0, receipts.length - 5)
      const receiptsMoreToggle = hiddenReceipts > 0 ? h('button', {
        type: 'button',
        className: 'dt-mvu-more',
        onClick: () => setShowAllReceipts(!showAllReceipts),
      }, showAllReceipts ? t('mvu.less') : t('mvu.more', { count: hiddenReceipts })) : null
      // sidebar 变体（DSH 原生右侧栏页面型 tab）：无折叠头（tab chip 就是容器），
      // 内容自滚动；按「模板状态栏 → 变量分组 → 结算回执」三段纵向排布，面板
      // 取会话底色不加卡片底（宿主右栏设计约定：它是页面的一列，不是浮层卡片）。
      if (sidebar) {
        if (!binding || !status || status.available !== true) {
          return h('div', { className: 'dt-mvu-side', 'data-dsh-soulmojito-surface': 'mvu-sidebar' },
            h('div', { className: 'dt-mvu-side-empty' }, h(IconDataOutline16), h('span', null, t('mvu.unavailable'))))
        }
        const variables = flattenMvuVariables(status.variables)
        const groups = groupMvuVariables(variables)
        return h('div', { className: 'dt-mvu-side', 'data-dsh-soulmojito-surface': 'mvu-sidebar' },
          h('div', { className: 'dt-mvu-side-head' },
            h('span', { className: 'dt-mvu-summary' }, t('mvu.summary', { variables: variables.length, receipts: receipts.length })),
            h('div', { className: 'dt-mvu-side-actions' },
              canUndo ? h('button', {
                type: 'button',
                className: 'dt-mvu-side-retry',
                disabled: busy,
                onClick: undo,
              }, busy ? t('mvu.undoing') : t('mvu.undo')) : null,
              canRetry ? h('button', {
                type: 'button',
                className: 'dt-mvu-side-retry',
                disabled: busy,
                onClick: retry,
              }, busy ? t('mvu.retrying') : t('mvu.retry')) : null)),
          busy ? h('p', { className: 'dt-muted' }, t('mvu.retrying')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          status.renderedHtml
            ? h('div', { className: 'dt-mvu-rendered' }, h(FrontendFrame, { html: status.renderedHtml, token: frameToken }))
            : null,
          variables.length > 0
            ? h('section', { className: 'dt-mvu-side-section' },
              h('h3', { className: 'dt-mvu-side-h' },
                h('span', null, t('mvu.variables')),
                h('span', { className: 'dt-mvu-side-count' }, String(variables.length))),
              h('div', { className: 'dt-mvu-groups' }, groups.map((group) => h('div', { key: group.name, className: 'dt-mvu-group' },
                h('div', { className: 'dt-mvu-group-h' },
                  h('span', { className: 'dt-mvu-group-name' }, group.name),
                  h('span', { className: 'dt-mvu-group-count' }, String(group.rows.length))),
                h('div', { className: 'dt-mvu-group-body' }, group.rows.map(([path, value]) => h('div', { key: path, className: 'dt-mvu-var-row' },
                  h('span', { className: 'dt-mvu-var-path', title: path === '·' ? group.name : `${group.name}.${path}` }, path),
                  h('span', { className: 'dt-mvu-var-value', title: formatMvuValue(value, 480) }, formatMvuValue(value, 240)))))))))
            : null,
          h('section', { className: 'dt-mvu-side-section' },
            h('h3', { className: 'dt-mvu-side-h' },
              h('span', null, t('mvu.receipts')),
              receipts.length > 0 ? h('span', { className: 'dt-mvu-side-count' }, String(receipts.length)) : null),
            receipts.length === 0
              ? h('p', { className: 'dt-muted' }, t('mvu.receiptsEmpty'))
              : h('div', { className: 'dt-mvu-receipts' },
                visibleReceipts.map((receipt, index) => receiptCard(receipt, index)),
                receiptsMoreToggle)))
      }
      // 内嵌（标题栏弹出）时无内容也给出提示：用户是主动点开的，空面板比提示更困惑
      if (!binding || !status || status.available !== true) {
        return embedded ? h('p', { className: 'dt-muted' }, t('mvu.unavailable')) : null
      }
      const variables = flattenMvuVariables(status.variables)
      return h('div', { className: 'dt-mvu', 'data-dsh-soulmojito-surface': 'mvu' },
        h('div', { className: 'dt-mvu-head' },
          h('button', {
            type: 'button',
            className: 'dt-mvu-toggle',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
            h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : undefined }),
            h('span', null, t('mvu.title')),
            receipts.length > 0 ? h('span', { className: 'dt-mvu-count' }, String(receipts.length)) : null),
          (canUndo || canRetry) ? h('div', { className: 'dt-mvu-actions' },
            canUndo ? h('button', { type: 'button', disabled: busy, onClick: undo }, busy ? t('mvu.undoing') : t('mvu.undo')) : null,
            canRetry ? h('button', { type: 'button', disabled: busy, onClick: retry }, busy ? t('mvu.retrying') : t('mvu.retry')) : null) : null),
        open ? h('div', { className: 'dt-mvu-body' },
          busy ? h('p', { className: 'dt-muted' }, t('mvu.retrying')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          status.renderedHtml
            ? h('div', { className: 'dt-mvu-rendered' }, h(FrontendFrame, { html: status.renderedHtml, token: frameToken }))
            : variables.length > 0
              ? h(React.Fragment, null,
                h('div', { className: 'dt-mvu-section-title' }, t('mvu.variables')),
                h('div', { className: 'dt-mvu-vars' }, variables.map(([path, value]) => h('div', { key: path, className: 'dt-mvu-var' },
                  h('span', { className: 'dt-mvu-var-path' }, path),
                  h('span', { className: 'dt-mvu-var-value' }, formatMvuValue(value))))))
              : null,
          h('div', { className: 'dt-mvu-section-title' }, t('mvu.receipts')),
          receipts.length === 0
            ? h('p', { className: 'dt-muted' }, t('mvu.receiptsEmpty'))
            : h('div', { className: 'dt-mvu-receipts' },
              visibleReceipts.map((receipt, index) => receiptCard(receipt, index)),
              receiptsMoreToggle)) : null)
    }

    // MVU 面板在 DSH 原生右侧栏的 tab 标识：id 是本实现在 tab 系统里的身份
    // （也是 body/title 在 keyed slot 下的派发键），kind 是 openTab 的页面名。
    const MVU_TAB_ID = 'dsh-soulmojito/mvu'
    const MVU_TAB_KIND = 'tavern-mvu'

    // MVU 面板的 DSH 原生右侧栏 body（sidebar.right.pane.tab keyed slot，按
    // MVU_TAB_ID 派发到本组件）：会话作用域，sessionId 由 keyed 注入回调显式
    // 传入（与官方 browser/terminal 提供者同款姿势，不依赖标准 kit 的投递细
    // 节），渲染 TavernMvuStatus 的 sidebar 变体。tab 的 chip 标题、关闭、分栏
    // 都由宿主右栏 kit 拥有，本组件只管内容。
    function TavernMvuSidebarTab({ sessionId }) {
      return h(TavernMvuStatus, { sessionId, sidebar: true })
    }

    // 对局面的 DSH 原生右侧栏 tab（2026-10-14 修订，MVU tab 同款姿势）：id 是
    // keyed slot 的派发键，kind 是 openTab 的页面名。body 渲染 TavernGameBoard
    // ——tab chip 标题、关闭、分栏由宿主右栏 kit 拥有，本组件只管内容。
    const GAMES_TAB_ID = 'dsh-soulmojito/games'
    const GAMES_TAB_KIND = 'tavern-games'

    function TavernGamesSidebarTab({ sessionId }) {
      return h(TavernGameBoard, { sessionId, sidebar: true })
    }
