    function nativeTavernTabs() {
      const titles = [MESSAGES_EN['nav.title'], MESSAGES_ZH['nav.title']]
      return [...document.querySelectorAll('[role="tab"]')]
        .filter((item) => titles.includes(item.textContent?.trim() || ''))
    }

    function restoreNativeTavernTabs() {
      for (const tab of nativeTavernTabs()) {
        if (tab.dataset?.dshSoulMojitoTabHidden === undefined) continue
        const aria = tab.dataset.dshSoulMojitoTabHiddenAria || ''
        if (aria) tab.setAttribute('aria-hidden', aria)
        else tab.removeAttribute?.('aria-hidden')
        tab.hidden = tab.dataset.dshSoulMojitoTabHiddenState === 'hidden'
        delete tab.dataset.dshSoulMojitoTabHidden
        delete tab.dataset.dshSoulMojitoTabHiddenAria
        delete tab.dataset.dshSoulMojitoTabHiddenState
      }
    }

    function filterNativeTavernTab(show) {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const tavernTabs = nativeTavernTabs()
      if (show) {
        restoreNativeTavernTabs()
        return
      }
      for (const tab of tavernTabs) {
        if (tab.getAttribute('aria-selected') === 'true') {
          const fallback = tabs.find((item) => item !== tab && !nativeTavernTabs().includes(item))
          if (fallback instanceof HTMLElement) fallback.click()
        }
        if (tab.dataset?.dshSoulMojitoTabHidden !== undefined) continue
        tab.dataset.dshSoulMojitoTabHidden = ''
        tab.dataset.dshSoulMojitoTabHiddenAria = tab.getAttribute?.('aria-hidden') ?? ''
        tab.dataset.dshSoulMojitoTabHiddenState = tab.hidden ? 'hidden' : 'visible'
        tab.setAttribute?.('aria-hidden', 'true')
        tab.hidden = true
      }
    }

    function useNativeTavernTabFilter(show) {
      useEffect(() => {
        let frame = 0
        const apply = () => {
          frame = 0
          filterNativeTavernTab(show)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-hidden'] })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          restoreNativeTavernTabs()
        }
      }, [show])
    }

    // 侧边栏会话树的 DOM 注入：宿主未提供会话列表扩展 slot，按几何特征定位
    // DSH 会话树并在其上方插入宿主 div（与面板聊天分区共存：这里管快速切换）。
    function visibleSidebarTree() {
      const candidates = [...document.querySelectorAll('[role="tree"]')]
      const found = candidates.find((tree) => {
        if (tree.closest('[data-dsh-soulmojito-sidebar-host]')) return false
        const rect = tree.getBoundingClientRect()
        if (tree.dataset?.dshSoulMojitoNativeTree !== undefined) {
          return rect.width > 0 && rect.left < Math.min(420, window.innerWidth * 0.4)
        }
        return rect.width > 40 && rect.height > 20 && rect.left < Math.min(420, window.innerWidth * 0.4)
      }) || null
      if (found) found.dataset.dshSoulMojitoNativeTree = ''
      return found
    }

    // Tavern sessions remain real DSH sessions so the native conversation
    // surface can render them, but they are owned by the Tavern navigator. The
    // host has no session-tree slot, so hide only bound rows at the DOM edge.
    // This adapter is deliberately reversible: unbinding a chat restores the
    // row, while ordinary DSH sessions are never marked.
    function nativeSessionReference(value, sessionIds) {
      if (value === null || value === undefined) return false
      let text = String(value)
      try { text = decodeURIComponent(text) } catch {}
      if (sessionIds.has(text)) return true
      const parts = text.split(/[\\/?#=:]+/).filter(Boolean)
      return parts.some((part) => sessionIds.has(part))
    }

    function nativeTreeRow(node, tree) {
      let current = node
      while (current && current !== tree) {
        const role = current.getAttribute?.('role')
        if (role === 'treeitem' || role === 'option' || current.tagName === 'LI') return current
        current = current.parentElement
      }
      return node === tree ? null : node
    }

    function normalizeWorkspacePath(value) {
      if (typeof value !== 'string') return ''
      let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (/^[a-z]:\//i.test(path)) path = path.toLowerCase()
      return path
    }

    // 插件内部工作区（Tavern / Tavern Workbench）都要整组隐藏：会话由自绘
    // 侧边栏导航，原生树只留普通用户工作区。身份依据是路径；显示名只在
    // 全局唯一时作回退（决策 2026-08-17）。
    function pluginWorkspaceSnapshots(ctx) {
      const items = ctx?.workspaces?.list?.getSnapshot?.().items || []
      const snapshots = []
      for (const config of [snapshot.bootstrap.internalWorkspace, snapshot.bootstrap.workbenchWorkspace]) {
        const expectedPath = normalizeWorkspacePath(config?.path)
        if (!expectedPath) continue
        const workspace = items.find((item) => normalizeWorkspacePath(item?.path) === expectedPath)
        if (!workspace?.workspaceId) continue
        const titleFallback = typeof workspace.title === 'string'
          && items.filter((item) => item?.title === workspace.title).length === 1
          ? workspace.title
          : ''
        snapshots.push({ workspace, titleFallback })
      }
      return snapshots
    }

    function nativeWorkspaceReference(value, workspace) {
      if (value === null || value === undefined) return false
      let text = String(value)
      try { text = decodeURIComponent(text) } catch {}
      if (text === workspace.workspaceId) return true
      if (normalizeWorkspacePath(text) === normalizeWorkspacePath(workspace.path)) return true
      return text.split(/[\\/?#=:]+/).filter(Boolean).some((part) => part === workspace.workspaceId)
    }

    function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback) {
      const values = []
      const collect = (element) => {
        if (!element?.getAttributeNames) return
        for (const name of element.getAttributeNames()) {
          if (name === 'id' || name === 'href' || name === 'data-key' || name === 'data-id'
            || name === 'data-item-id' || name === 'data-value' || name === 'data-path'
            || name === 'data-workspace' || name === 'data-workspace-id'
            || name.includes('workspace')) {
            values.push(element.getAttribute(name))
          }
        }
      }
      collect(node)
      for (const child of node.querySelectorAll?.('*') || []) collect(child)
      if (values.some((value) => nativeWorkspaceReference(value, workspace))) return true
      // rc.6 does not expose workspace identity in the DOM. A title fallback is
      // safe only when that title belongs to exactly one registered workspace.
      const text = node.textContent?.replace(/\s+/g, ' ').trim()
      return Boolean(titleFallback && text === titleFallback)
    }

    function nativeTreeWorkspaceGroup(row, tree) {
      let current = row
      while (current?.parentElement && current.parentElement !== tree) current = current.parentElement
      return current?.parentElement === tree ? current : row
    }

    function nativeTreeNodeMatches(node, sessionIds, labels) {
      const values = []
      const collect = (element) => {
        if (!element?.getAttributeNames) return
        for (const name of element.getAttributeNames()) {
          if (name === 'id' || name === 'href' || name === 'title' || name === 'aria-label'
            || name === 'aria-controls' || name === 'data-key' || name === 'data-id'
            || name === 'data-item-id' || name === 'data-value' || name === 'data-session'
            || name === 'data-session-id'
            || name.includes('session')) {
            values.push(element.getAttribute(name))
          }
        }
      }
      collect(node)
      for (const child of node.querySelectorAll?.('*') || []) {
        const nestedRow = child.closest?.('[role="treeitem"], [role="option"], li')
        if (nestedRow && nestedRow !== node) continue
        collect(child)
      }
      if (values.some((value) => nativeSessionReference(value, sessionIds))) return true
      // Older host builds expose no session id in the DOM. Their tree row text
      // is the renamed session label, which is safe to use only as a fallback.
      if ((node.querySelectorAll?.('[role="treeitem"], [role="option"], li') || []).length > 0) return false
      const text = node.textContent?.replace(/\s+/g, ' ').trim()
      return Boolean(text && [...labels].some((label) => text === label || text.startsWith(`${label} `)))
    }

    function markNativeTreeRow(row, kind = 'session') {
      if (!row || row.dataset?.dshSoulMojitoNativeHidden !== undefined) return
      row.dataset.dshSoulMojitoNativeHidden = ''
      row.dataset.dshSoulMojitoNativeHiddenKind = kind
      row.dataset.dshSoulMojitoNativeHiddenAria = row.getAttribute?.('aria-hidden') ?? ''
      row.dataset.dshSoulMojitoNativeHiddenState = row.hidden ? 'hidden' : 'visible'
      row.setAttribute?.('aria-hidden', 'true')
      row.hidden = true
    }

    function unmarkNativeTreeRows(tree) {
      for (const row of tree.querySelectorAll?.('[data-dsh-soulmojito-native-hidden]') || []) {
        const aria = row.dataset?.dshSoulMojitoNativeHiddenAria || ''
        const state = row.dataset?.dshSoulMojitoNativeHiddenState
        if (aria) row.setAttribute('aria-hidden', aria)
        else row.removeAttribute?.('aria-hidden')
        row.hidden = state === 'hidden'
        delete row.dataset.dshSoulMojitoNativeHidden
        delete row.dataset.dshSoulMojitoNativeHiddenKind
        delete row.dataset.dshSoulMojitoNativeHiddenAria
        delete row.dataset.dshSoulMojitoNativeHiddenState
      }
    }

    function filterNativeSessionTree(tree, bindings, ctx) {
      if (!tree) return
      const sessionIds = new Set(Object.keys(bindings || {}))
      unmarkNativeTreeRows(tree)
      for (const internal of pluginWorkspaceSnapshots(ctx)) {
        const headers = [...tree.querySelectorAll?.('[role="treeitem"][aria-expanded]') || []]
        for (const header of headers) {
          if (!nativeTreeNodeMatchesWorkspace(header, internal.workspace, internal.titleFallback)) continue
          markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')
        }
      }
      if (sessionIds.size === 0) return
      const labels = new Set(Object.entries(bindings)
        .filter(([, binding]) => typeof binding?.character === 'string' && typeof binding?.chatId === 'string')
        .map(([, binding]) => sessionLabel(binding.character, binding.chatId, binding.group === true, bindingArchitecture(binding))))
      const candidates = [...tree.querySelectorAll?.('[role="treeitem"], [role="option"], li, [data-session-id], [data-session], [data-item-id]') || []]
      const rows = new Set()
      for (const candidate of candidates) {
        const row = nativeTreeRow(candidate, tree)
        if (row && nativeTreeNodeMatches(row, sessionIds, labels)) rows.add(row)
      }
      for (const row of rows) {
        if (row.parentElement?.closest?.('[data-dsh-soulmojito-native-hidden]')) continue
        markNativeTreeRow(row)
      }
    }

    function useNativeSessionTreeFilter(bindingIds, ctx, internalWorkspacePaths) {
      const bindingKey = bindingIds.join('\u0000')
      useEffect(() => {
        let frame = 0
        let observer
        const apply = () => {
          frame = 0
          filterNativeSessionTree(visibleSidebarTree(), snapshot.bootstrap.state.sessionBindings, ctx)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        if (typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['id', 'href', 'title', 'aria-label', 'aria-controls', 'data-key', 'data-id', 'data-item-id', 'data-value', 'data-path', 'data-workspace', 'data-workspace-id', 'data-session', 'data-session-id'],
          })
        }
        window.addEventListener('resize', schedule)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          const tree = visibleSidebarTree()
          if (tree) unmarkNativeTreeRows(tree)
        }
      }, [bindingKey, ctx, internalWorkspacePaths])
    }

    function useSidebarHost() {
      const [host, setHost] = useState(null)
      useEffect(() => {
        let frame = 0
        let current = null
        const attach = () => {
          frame = 0
          const tree = visibleSidebarTree()
          if (!tree?.parentElement) {
            if (current?.isConnected) current.remove()
            current = null
            setHost(null)
            return
          }
          if (!current || !current.isConnected || current.parentElement !== tree.parentElement) {
            current?.remove()
            current = document.createElement('div')
            current.dataset.dshSoulMojitoSidebarHost = ''
            tree.parentElement.insertBefore(current, tree)
            setHost(current)
          }
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(attach)
        }
        attach()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          current?.remove()
        }
      }, [])
      return host
    }

    function ChatList({ ctx, character, currentSession, group = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const chats = state.chatLists[character]
      const [error, setError] = useState('')
      const [busyChat, setBusyChat] = useState('')
      useEffect(() => { void loadChatList(character).catch((cause) => setError(sidebarErrorDetail(cause))) }, [character])
      const activeBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const open = (chatId) => {
        setError('')
        void openTavernChat(ctx, character, chatId, group).catch((cause) => {
          update({ navigationStatus: '' })
          setError(sidebarErrorDetail(cause))
        })
      }
      const runAction = (chatId, action) => {
        setError('')
        setBusyChat(chatId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusyChat(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        chats?.map((chatId) => {
          const labels = chatArchitectureLabels(character, chatId, group)
          return h('div', {
            key: chatId,
            className: `dt-sidebar-chat-row ${activeBinding?.character === character && activeBinding.chatId === chatId ? 'dt-sidebar-chat-active' : ''}`,
          },
          h('button', {
            type: 'button',
            className: 'dt-sidebar-chat-open',
            title: chatId,
            disabled: busyChat === chatId,
            onClick: () => open(chatId),
          }, h('span', null, / - branch \d+$/.test(chatId.replace(/\.jsonl$/i, '')) ? '⑂ ' : '', chatId.replace(/\.jsonl$/i, '')),
          h('span', { className: 'dt-chat-architecture' }, labels.join(' / '))),
          h('button', {
            type: 'button',
            title: t('nav.workbenchChat'),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => openWorkbenchSession(ctx, { character, chatId })),
          }, h(IconSparkle16)),
          h('button', {
            type: 'button',
            title: t('nav.rename', { name: chatId.replace(/\.jsonl$/i, '') }),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => renameTavernChat(ctx, character, chatId)),
          }, h(IconEditOutline16)),
          h('button', {
            type: 'button',
            title: t('nav.delete', { name: chatId.replace(/\.jsonl$/i, '') }),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => deleteTavernChat(ctx, character, chatId)),
          }, h(IconTrashOutline16)))
        }),
        !chats ? h('span', { className: 'dt-sidebar-status' }, t('nav.loading')) : null,
        chats?.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noChats')) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    // 写卡工作台会话列表（侧边栏分组）：每个来源聊天一个工作会话，自由工作台
    // 也在此列出；点击切回主视图，与 TavernSidebar 其余分组共用 dt-sidebar-* 样式。
    // 改名/删除对齐 ChatList 的行内按钮（提案 0013 之后的能力补齐）：标签优先
    // 级 title（用户显式改名）> createdCard（出卡改名）> 来源聊天 > 自由序号。
    function WorkbenchList({ ctx, useSessions, currentSession }) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionIds = useSessions((value) => value.ids)
      const [error, setError] = useState('')
      const [busySession, setBusySession] = useState('')
      const entries = Object.entries(state.bootstrap.state.sessionBindings || {})
        .filter(([sessionId, binding]) => binding?.architecture === 'card-workbench' && sessionIds.includes(sessionId))
      // 多自由工作台并存时同名条目按枚举序号区分（第 2 个起带号，与创建时
      // 宿主标题的计数序号同族；删会话后序号重排仅为显示层变化）。
      const freeTotal = entries.filter(([, binding]) => !binding.sourceCharacter && !binding.sourceChatId).length
      let freeOrdinal = 0
      const labels = entries.map(([, binding]) => {
        // 用户显式改的名压过一切派生标签（服务端出卡改名同样让位）。
        if (binding.title) return binding.title
        // 出卡后会话改名为卡名（提案 0013 补充）：createdCard 优先于来源
        // 聊天/自由工作台标签，与服务端 sessionTitle.rename 固定的宿主标题一致。
        if (binding.createdCard) return binding.createdCard
        if (binding.sourceCharacter) return `${binding.sourceCharacter} · ${String(binding.sourceChatId).replace(/\.jsonl$/i, '')}`
        freeOrdinal += 1
        return freeTotal > 1 && freeOrdinal > 1 ? `${t('nav.workbenchFree')} ${freeOrdinal}` : t('nav.workbenchFree')
      })
      const runAction = (sessionId, action) => {
        setError('')
        setBusySession(sessionId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusySession(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        entries.map(([sessionId, binding], index) => {
          const label = labels[index]
          return h('div', {
            key: sessionId,
            className: `dt-sidebar-chat-row ${currentSession === sessionId ? 'dt-sidebar-chat-active' : ''}`,
          },
          h('button', {
            type: 'button',
            className: 'dt-sidebar-chat-open',
            title: label,
            disabled: busySession === sessionId,
            onClick: () => openWorkbenchSessionView(ctx, sessionId),
          }, h('span', null, '✎ ', label)),
          h('button', {
            type: 'button',
            title: t('nav.rename', { name: label }),
            disabled: busySession === sessionId,
            onClick: () => runAction(sessionId, () => renameWorkbenchSession(ctx, sessionId, label)),
          }, h(IconEditOutline16)),
          h('button', {
            type: 'button',
            title: t('nav.delete', { name: label }),
            disabled: busySession === sessionId,
            onClick: () => {
              if (window.confirm(t('workbench.deleteConfirm', { name: label }))) {
                runAction(sessionId, () => deleteWorkbenchSession(ctx, sessionId))
              }
            },
          }, h(IconTrashOutline16)))
        }),
        entries.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noWorkbench')) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    // Greeting choice for a newly created chat. AgentTavern imports the opening
    // message into the host session, where the ST swipe UI never reaches, so the
    // alternate greetings must be picked before activation.
    function TavernGreetingPicker({ picker, t, onPick, onClose }) {
      return h(Modal, {
        open: true,
        onClose,
        title: t('nav.greetingTitle'),
        closeLabel: t('nav.close'),
        className: 'dt-greeting-modal',
      },
      h('p', { className: 'dt-greeting-hint' }, t('nav.greetingHint')),
      h('div', { className: 'dt-greeting-list' },
        picker.options.map((option) => h('button', {
          key: option.index,
          type: 'button',
          className: 'dt-greeting-option',
          onClick: () => onPick(option.index),
        },
        h('span', { className: 'dt-greeting-label' }, option.index === 0
          ? t('nav.greetingFirst')
          : t('nav.greetingAlternate', { index: option.index })),
        h('span', { className: 'dt-greeting-preview' }, option.text === ''
          ? t('nav.greetingEmpty')
          : option.text.length > 260 ? `${option.text.slice(0, 259)}…` : option.text)))))
    }

    function TavernSidebar({ ctx, useSessions, floating, onClose }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useCurrentSessionId(useSessions)
      const [expanded, setExpanded] = useState(state.bootstrap.state.activeCharacter || state.bootstrap.characters[0] || '')
      const [expandedGroup, setExpandedGroup] = useState('')
      const [greetingPicker, setGreetingPicker] = useState(null)
      const [error, setError] = useState('')
      const startCharacterChat = (character) => {
        setError('')
        void fetchCharacterCard(character).then((card) => {
          const first = typeof card?.data?.firstMes === 'string' ? card.data.firstMes : ''
          const alternates = Array.isArray(card?.data?.alternateGreetings)
            ? card.data.alternateGreetings.filter((text) => typeof text === 'string')
            : []
          const all = [{ text: first, index: 0 }, ...alternates.map((text, index) => ({ text, index: index + 1 }))]
          const options = all.length > 1 ? all.filter((option) => option.text.trim() !== '') : all
          if (options.length === 0) options.push({ text: first, index: 0 })
          if (options.length === 1) {
            return createTavernChat(ctx, character, false, undefined, options[0].index)
          }
          setGreetingPicker({ character, options })
          return undefined
        }).catch((cause) => {
          update({ navigationStatus: '' })
          setError(sidebarErrorDetail(cause))
        })
      }
      const groups = state.bootstrap.groups || []
      // 分区折叠（酒馆 / 写卡工作台）：标题本身是折叠钮，chevron 与
      // dt-character-toggle 同款旋转惯例；折叠只藏内容，标题行常驻。
      // 两分区内容各自进 .dt-sidebar-scroll 滚动容器（2026-10-16 用户反馈：
      // 角色卡/会话过多时整块侧栏把宿主会话工作区挤到看不见）——固定高度上限
      // （min(320px,32vh)）+ overflow-y:auto，宿主会话树永远留得住可视区。
      const tavernOpen = !state.sidebarCollapsed.tavern
      const workbenchOpen = !state.sidebarCollapsed.workbench
      const toggleSidebarSection = (section) => {
        update({ sidebarCollapsed: { ...state.sidebarCollapsed, [section]: !state.sidebarCollapsed[section] } })
      }
      const headingToggle = (open, label, icon, section) => h('button', {
        type: 'button',
        className: 'dt-sidebar-heading-toggle',
        'aria-expanded': open,
        onClick: () => toggleSidebarSection(section),
      },
      h('span', { className: 'dt-sidebar-chevron' }, h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' })),
      h('span', { className: 'dt-sidebar-heading-label' }, icon, h('strong', null, label)))
      return h('section', { className: `dt-sidebar ${floating ? 'dt-sidebar-floating' : ''}`, 'aria-label': t('nav.chats') },
        h('div', { className: 'dt-sidebar-heading' },
          headingToggle(tavernOpen, t('nav.title'), h(IconUserOutline16), 'tavern'),
          floating ? h('button', { type: 'button', title: t('nav.close'), onClick: onClose }, '×') : null),
        tavernOpen ? h('div', { className: 'dt-sidebar-scroll dt-sidebar-tavern' },
          state.bootstrap.characters.map((character) => {
            const open = expanded === character
            return h('div', { key: character, className: 'dt-character-group' },
              h('div', { className: 'dt-character-row' },
                h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpanded(open ? '' : character) },
                  h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                  h('img', { src: `${API}/avatar/${encodeURIComponent(character)}`, alt: '' }),
                  h('span', null, character)),
                h('button', {
                  type: 'button',
                  title: t('nav.newChat', { name: character }),
                  onClick: () => startCharacterChat(character),
                }, h(IconPlusOutline16))),
              open ? h(ChatList, { ctx, character, currentSession }) : null)
          }),
          state.bootstrap.characters.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noCharacters')) : null,
          groups.length > 0 ? h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },
            h('span', null, '☰ ', h('strong', null, t('nav.groups')))) : null,
          groups.map((group) => {
            const open = expandedGroup === group.name
            return h('div', { key: group.name, className: 'dt-character-group' },
              h('div', { className: 'dt-character-row' },
                h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpandedGroup(open ? '' : group.name) },
                  h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                  h('img', { src: `${API}/avatar/${encodeURIComponent(group.name)}`, alt: '' }),
                  h('span', null, `☰ ${group.name}`)),
                h('button', {
                  type: 'button',
                  title: t('nav.newGroupChat', { name: group.name }),
                  onClick: () => {
                    setError('')
                    void createTavernChat(ctx, group.name, true).catch((cause) => {
                      update({ navigationStatus: '' })
                      setError(sidebarErrorDetail(cause))
                    })
                  },
                }, h(IconPlusOutline16))),
              open ? h(ChatList, { ctx, character: group.name, currentSession, group: true }) : null)
          })) : null,
        h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },
          headingToggle(workbenchOpen, t('nav.workbench'), '✎ ', 'workbench'),
          h('button', {
            type: 'button',
            title: t('nav.workbenchNew'),
            onClick: () => {
              setError('')
              void openWorkbenchSession(ctx, null, { fresh: true }).catch((cause) => {
                update({ navigationStatus: '' })
                setError(sidebarErrorDetail(cause))
              })
            },
          }, h(IconPlusOutline16))),
        workbenchOpen ? h('div', { className: 'dt-sidebar-scroll dt-sidebar-workbench' },
          h(WorkbenchList, { ctx, useSessions, currentSession })) : null,
        state.navigationStatus ? h('span', { className: 'dt-sidebar-status' }, state.navigationStatus) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null,
        greetingPicker ? h(TavernGreetingPicker, {
          picker: greetingPicker,
          t,
          onClose: () => setGreetingPicker(null),
          onPick: (index) => {
            const picker = greetingPicker
            setGreetingPicker(null)
            setError('')
            void createTavernChat(ctx, picker.character, false, undefined, index).catch((cause) => {
              update({ navigationStatus: '' })
              setError(sidebarErrorDetail(cause))
            })
          },
        }) : null)
    }
