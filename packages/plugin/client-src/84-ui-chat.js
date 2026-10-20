    function TavernSettings() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const stamp = bootstrap.version || bootstrap.commit
        ? `v${bootstrap.version || '?'}${bootstrap.commit ? ` (${bootstrap.commit})` : ''}`
        : ''
      // 重管理全部移入 Tavern 管理面板（sidebar footer 按钮 / 本页按钮打开）；
      // 设置页只保留快速切换与面板入口。
      return h('div', { className: 'dt-settings', 'data-dsh-soulmojito-settings': '' },
        h('div', { className: 'dt-settings-heading' },
          h('div', null,
            h('h2', null, 'DSH-SoulMojito'),
            h('p', null, t('settings.subtitle')),
            stamp ? h('p', { className: 'dt-settings-version' }, `${t('settings.version')} ${stamp}`) : null,
            h(UpdateBand, { compact: true })),
          h(Button, { variant: 'primary', size: 'sm', icon: h(SoulMojitoLogo), onClick: () => openPanel() }, t('panel.open'))),
        h(ActiveSetupBand),
        state.error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, state.error)) : null)
    }

    // 显示层宏替换（ST substituteParams 的常用子集）：只影响渲染，落库文本保持
    // 原样，切换 swipe / 编辑框读原始 mes 都不受影响。
    function expandDisplayMacros(text, user, char) {
      if (typeof text !== 'string' || !text.includes('{')) return text
      return text
        .replace(/\{\{user\}\}/gi, user)
        .replace(/\{\{char\}\}/gi, char)
        .replace(/\{\{bot\}\}/gi, char)
    }

    function MessageRow({ sessionId, character, chatId, chat, message, index, busy, display, persona }) {
      const t = useTranslate()
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(message.mes || '')
      const [error, setError] = useState('')
      const [branching, setBranching] = useState(false)
      // 思考块展开态：流式楼层默认展开（用户要看思考实时滚动），保存后重挂载
      // （key 含 'stream'/'saved' 分段）自然回落折叠。
      const [reasoningOpen, setReasoningOpen] = useState(message.streaming === true)
      useEffect(() => setDraft(message.mes || ''), [message.mes])
      const isUser = message.is_user === true
      const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes || '']
      const swipeIndex = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1)
      // 带意见重写（提案 0011）：swipe_info[].extra.feedback 记录该变体是按
      // 哪条意见重写的；标题悬停可见全文，正文中不出现意见文本。
      const swipeExtra = Array.isArray(message.swipe_info) ? message.swipe_info[swipeIndex] : null
      const swipeFeedback = swipeExtra && typeof swipeExtra === 'object'
        && typeof swipeExtra.extra?.feedback === 'string' && swipeExtra.extra.feedback !== ''
        ? swipeExtra.extra.feedback : ''
      // 思考块数据源：swipe 级 extra.reasoning（各候选各自的思考）优先，回落消息级
      // extra.reasoning（流式伪楼层与无 swipe_info 的旧保存）。都空则整块不渲染。
      const swipeReasoning = swipeExtra && typeof swipeExtra === 'object'
        && typeof swipeExtra.extra?.reasoning === 'string' ? swipeExtra.extra.reasoning : ''
      const reasoningText = swipeReasoning
        || (typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : '')
      const renderedText = expandDisplayMacros(
        display ?? message.mes ?? '',
        persona || 'User',
        !isUser && message.name ? message.name : character)
      // Do not execute a half-streamed document. Once persisted, complete HTML
      // documents are rendered in isolated frames while ordinary prose remains
      // text, matching Tavern Helper's frontend code-block behavior.
      const frontendDocuments = editing || message.streaming ? [] : extractFrontendDocuments(renderedText)
      const persist = async (nextMessage) => {
        setError('')
        const nextChat = { ...chat, messages: chat.messages.map((item, itemIndex) => itemIndex === index ? nextMessage : item) }
        try {
          await saveChat(character, chatId, nextChat)
          return true
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          setRun(sessionId, { error: message })
          return false
        }
      }
      const changeSwipe = (delta) => {
        const nextIndex = (swipeIndex + delta + swipes.length) % swipes.length
        void persist({ ...message, swipe_id: nextIndex, mes: swipes[nextIndex] })
      }
      const commit = async () => {
        const nextSwipes = swipes.map((value, itemIndex) => itemIndex === swipeIndex ? draft : value)
        if (await persist({ ...message, mes: draft, ...(message.swipes ? { swipes: nextSwipes } : {}) })) {
          setEditing(false)
        }
      }
      const branch = () => {
        setError('')
        setBranching(true)
        void branchTavernChat(PanelHost.context, character, chatId, index, sessionId, 'st')
          .catch((cause) => setError(cause.message))
          .finally(() => setBranching(false))
      }
      const branchAgent = () => {
        setError('')
        setBranching(true)
        void branchTavernChat(PanelHost.context, character, chatId, index, sessionId, 'agent-tavern')
          .catch((cause) => setError(cause.message))
          .finally(() => setBranching(false))
      }
      return h('article', { className: `dt-message ${isUser ? 'dt-message-user' : 'dt-message-character'}` },
        !isUser ? h('img', {
          className: 'dt-message-avatar',
          src: `${API}/avatar/${encodeURIComponent(message.name || character)}`,
          alt: '',
          onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
        }) : null,
        h('div', { className: 'dt-message-body' },
          h('div', { className: 'dt-message-name' }, message.name || (isUser ? t('message.user') : character)),
          reasoningText ? h('div', { className: 'dt-reasoning' },
            h('button', {
              type: 'button',
              className: `dt-reasoning-toggle${reasoningOpen ? ' dt-reasoning-open' : ''}`,
              title: t(message.streaming ? 'message.thinking' : 'message.thoughts'),
              onClick: () => setReasoningOpen(!reasoningOpen),
            }, h(IconChevronDownOutline14), t(message.streaming ? 'message.thinking' : 'message.thoughts')),
            reasoningOpen ? h('div', { className: 'dt-reasoning-body' }, reasoningText) : null) : null,
          editing
            ? h('textarea', { className: 'dt-message-edit', value: draft, disabled: busy, onChange: (event) => setDraft(event.target.value) })
            : frontendDocuments.length > 0
              ? h('div', { className: 'dt-message-frontend' }, frontendDocuments.map((html, frontendIndex) => h(FrontendFrame, {
                key: `${index}-${frontendIndex}`,
                html,
                token: `tavern-${sessionId}-${index}-${frontendIndex}`,
                binding: { character, chatId },
                refreshKey: `${index}-${(message.mes ?? '').length}`,
              })))
              : message.streaming && renderedText === ''
                ? null
                : h('div', { className: 'dt-message-copy' }, renderedText),
          h('div', { className: 'dt-message-actions' },
            swipes.length > 1 ? h(React.Fragment, null,
              h('button', { type: 'button', title: t('message.previousSwipe'), disabled: busy, onClick: () => changeSwipe(-1) }, h(IconChevronLeftOutline14)),
              h('span', null, `${swipeIndex + 1}/${swipes.length}`),
              h('button', { type: 'button', title: t('message.nextSwipe'), disabled: busy, onClick: () => changeSwipe(1) }, h(IconChevronRightOutline14))) : null,
            !isUser && swipeFeedback ? h('span', { className: 'dt-swipe-feedback', title: swipeFeedback }, t('view.rewritten')) : null,
            editing ? h(React.Fragment, null,
              h('button', { type: 'button', disabled: busy, onClick: () => void commit() }, t('message.save')),
              h('button', { type: 'button', onClick: () => { setDraft(message.mes || ''); setError(''); setEditing(false) } }, t('message.cancel')))
              : h(React.Fragment, null,
                h('button', { type: 'button', title: t('message.edit'), disabled: busy, onClick: () => setEditing(true) }, h(IconEditOutline16)),
                h('button', { type: 'button', className: 'dt-branch-btn', title: t('message.branch'), disabled: busy || branching, onClick: branch }, '⑂'),
                h('button', { type: 'button', title: t('view.forkArchitecture', { architecture: t('view.architectureAgent') }), disabled: busy || branching, onClick: branchAgent }, h(IconAgentPresetOutline16)))),
          branching ? h('span', { className: 'dt-message-error' }, t('message.branching')) : null,
          error ? h('span', { className: 'dt-message-error' }, error) : null))
    }

    function TavernView({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const run = state.runs[sessionId] || {}
      const endRef = useRef(null)
      useEffect(() => {
        if (binding) void repairBinding(PanelHost.context, sessionId, binding)
      }, [sessionId, binding?.character, binding?.chatId])
      useEffect(() => {
        if (binding) void loadChat(binding.character, binding.chatId).catch((cause) => setRun(sessionId, { error: cause.message }))
      }, [binding?.character, binding?.chatId, sessionId])
      useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [chat, run.streamText, run.streamReasoning])
      if (!binding) {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-soulmojito-surface': 'view' },
          h(IconUserOutline16, { size: 22 }),
          h('strong', null, t('view.unbound')))
      }
      // Novel sessions keep the native conversation surface; this legacy view
      // only points back at the novels panel (the tab itself stays hidden by
      // useNativeTavernTabFilter in PanelHost).
      if (binding.architecture === 'agent-novel') {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-soulmojito-surface': 'view' },
          h(IconListPenOutline16, { size: 22 }),
          h('strong', null, t('novel.viewNotice')),
          h('button', { type: 'button', className: 'dt-upload', onClick: () => openPanel('novels') }, t('novel.openPanel')))
      }
      if (!chat) return h('div', { className: 'dt-view dt-empty', 'data-dsh-soulmojito-surface': 'view' }, t('view.loading'))
      const messages = [...chat.messages]
      // 流式伪楼层：纯思考阶段（正文 delta 未到）也要挂出楼层让思考块可见，
      // reasoning 经 extra 通道走 MessageRow 与保存后消息同一渲染路径。
      if (run.streamText || run.streamReasoning) {
        messages.push({
          name: run.speaker || binding.character,
          is_user: false,
          mes: run.streamText,
          streaming: true,
          ...(run.streamReasoning ? { extra: { reasoning: run.streamReasoning } } : {}),
        })
      }
      const link = chat.header?.chat_metadata?.bookmark_link
      return h('div', { className: 'dt-view', 'data-dsh-soulmojito-surface': 'view' },
        link ? h('div', { className: 'dt-backlink' },
          h('button', {
            type: 'button',
            onClick: () => {
              void openTavernChat(PanelHost.context, link.character, link.chatId)
                .catch((cause) => setRun(sessionId, { error: cause.message }))
            },
          }, `↩ ${t('view.linkedFrom', { name: `${link.character} · ${(link.chatId || '').replace(/\.jsonl$/i, '')}` })}`)) : null,
        // MVU 状态与回执（0012）/ 剧本进度卡（0014）：available=false / 未绑定剧本
        // 时组件自身返回 null，不占位
        h(TavernMvuStatus, { sessionId }),
        // 对局面（2026-10-14 修订）：与 MVU 状态同位的自动展示——本聊天存在
        // 未终局对局即占位渲染棋盘，无对局返回 null 不占位。
        h(TavernGameBoard, { sessionId }),
        h(TavernScriptProgress, { sessionId }),
        // Mod 声明按钮行（A-1d）：无声明按钮时自身返回 null，不占位
        h(TavernModButtons, { character: binding.character, chatId: binding.chatId }),
        h('div', { className: 'dt-transcript' },
          messages.map((message, index) => h(MessageRow, {
            key: `${index}-${message.send_date || ''}-${message.streaming ? 'stream' : 'saved'}`,
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            chat,
            message,
            index,
            busy: run.busy || message.streaming,
            display: state.displays[chatKey(binding.character, binding.chatId)]?.[index],
            persona: state.bootstrap.state?.activePersona,
          })),
          h('div', { className: 'dt-transcript-end', ref: endRef })),
        run.error ? h('div', { className: 'dt-run-error' }, run.error) : null)
    }

    function findCurrentChoice(groups, selection) {
      if (!selection) return null
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === selection.provider && model.id === selection.model) return { group, model }
        }
      }
      return null
    }

    // ModelSelect mirrors the native composer model seat: a pill trigger in the
    // input row opening a two-level Model/Effort menu over the provider-grouped
    // directory. Selection persists per Tavern session; the fallback is the DSH
    // default model, and a current selection outside the advertised catalog
    // keeps the trigger on the "Select model" fallback without a stale row.
    function ModelSelect({ sessionId, locked }) {
      const state = useTavernStore()
      const t = useTranslate()
      const models = state.models
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [actionError, setActionError] = useState('')
      const [selecting, setSelecting] = useState(false)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const itemRefs = useRef([])
      const id = useId()
      const selection = sessionSelection(sessionId)
      const currentChoice = findCurrentChoice(models.groups, selection)
      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = selection?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined ? undefined
        : effectiveEffort === undefined ? t('model.default')
          : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
      useEffect(() => { if (snapshot.models.status === 'idle') void loadModels().catch(() => {}) }, [])
      useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])
      const close = (restoreFocus) => {
        setOpen(false)
        setPane('root')
        setActionError('')
        if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
      }
      const show = () => {
        setPane('root')
        setActionError('')
        setOpen(true)
        void loadModels(true).catch(() => {})
      }
      const moveFocus = (offset) => {
        const items = itemRefs.current.filter((item) => item !== null)
        if (items.length === 0) return
        const active = items.findIndex((item) => item === document.activeElement)
        items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          if (pane !== 'root') setPane('root')
          else close(true)
          return
        }
        if (!open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }
      const onBlur = (event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
        close(false)
      }
      const submit = (next) => {
        setSelecting(true)
        setActionError('')
        saveModelSelection(sessionId, next)
          .then(() => { setSelecting(false); close(true) }, (cause) => {
            setSelecting(false)
            setActionError(cause instanceof Error ? cause.message : String(cause))
          })
      }
      const choose = (provider, model, defaultEffort) => {
        if (selection?.provider === provider && selection?.model === model) {
          close(true)
          return
        }
        submit({
          provider,
          model,
          ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
        })
      }
      const chooseEffort = (effort) => {
        if (!selection) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        submit({
          provider: selection.provider,
          model: selection.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        })
      }
      const modelLabel = currentChoice?.model.name ?? t('model.select')
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      itemRefs.current = []
      let itemIndex = 0
      const itemRef = () => {
        const at = itemIndex++
        return (node) => { itemRefs.current[at] = node }
      }
      const retry = h('button', {
        type: 'button',
        className: 'dt-model-retry',
        onClick: () => { void loadModels(true).catch(() => {}) },
      }, t('model.retry'))
      const actionErrorRow = actionError
        ? h('div', { className: 'dt-model-error' }, h('span', null, actionError))
        : null
      const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'dt-model-trigger',
        'aria-label': t('model.select'),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        title: triggerLabel,
        disabled: locked,
        onClick: () => { if (open) close(false); else show() },
      },
      h('span', { className: 'dt-model-trigger-label' }, modelLabel),
      effortLabel !== undefined ? h('span', { className: 'dt-model-trigger-effort' }, effortLabel) : null,
      h(IconChevronDownOutline14, { className: `dt-model-chevron ${open ? 'dt-model-chevron-open' : ''}` }))
      const drillCell = (label, value, paneName) => h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitem',
        className: 'dt-model-cell',
        onClick: () => setPane(paneName),
      },
      h('span', { className: 'dt-model-cell-label' }, label),
      h('span', { className: 'dt-model-cell-value' }, value),
      h(IconChevronRightOutline14, { className: 'dt-model-cell-chevron' }))
      const rootPane = pane === 'root' ? h(React.Fragment, null,
        actionErrorRow,
        drillCell(t('model.model'), modelLabel, 'model'),
        reasoning !== undefined ? drillCell(t('model.effort'), effortLabel, 'effort') : null) : null
      const modelPane = pane === 'model' ? h(React.Fragment, null,
        models.status === 'loading' ? h('div', { className: 'dt-model-status' }, t('model.refreshing')) : null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        models.failures.map((failure) => h('div', { key: failure.id, className: 'dt-model-warning' },
          h('span', null, t('model.loadFailed', { name: failure.name, message: failure.message })),
          retry)),
        h('div', { className: 'dt-model-groups' },
          models.groups.map((group) => h('section', {
            key: group.id,
            role: 'group',
            'aria-labelledby': `${id}-${group.id}`,
            className: 'dt-model-group',
          },
          h('div', { className: 'dt-model-group-title', id: `${id}-${group.id}` }, group.name),
          group.models.map((model) => {
            const selected = selection?.provider === group.id && selection?.model === model.id
            return h('button', {
              ref: itemRef(),
              key: model.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected,
              className: 'dt-model-option',
              title: model.name,
              disabled: selecting,
              onClick: () => choose(group.id, model.id, model.reasoning?.defaultEffort),
            },
            h('span', { className: 'dt-model-option-copy' },
              h('span', { className: 'dt-model-name' }, model.name),
              model.description !== undefined ? h('span', { className: 'dt-model-description' }, model.description) : null),
            h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
          }))),
        models.status === 'ready' && models.groups.every((group) => group.models.length === 0)
          ? h('div', { className: 'dt-model-empty' }, t('model.noneAvailable'))
          : null)) : null
      const effortPane = pane === 'effort' ? h(React.Fragment, null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        reasoning === undefined
          ? h('div', { className: 'dt-model-empty' }, t('model.noEffort'))
          : h(React.Fragment, null,
            reasoning.defaultEffort === undefined ? h('button', {
              ref: itemRef(),
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': effectiveEffort === undefined,
              className: 'dt-model-option',
              disabled: selecting,
              onClick: () => chooseEffort(undefined),
            },
            h('span', { className: 'dt-model-option-copy' }, h('span', { className: 'dt-model-name' }, t('model.default'))),
            h('span', { className: 'dt-model-check' }, effectiveEffort === undefined ? h(IconCheckOutline16) : null)) : null,
            reasoning.efforts.map((effort) => {
              const selected = effectiveEffort === effort.id
              return h('button', {
                ref: itemRef(),
                key: effort.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected,
                className: 'dt-model-option',
                disabled: selecting,
                onClick: () => chooseEffort(effort.id),
              },
              h('span', { className: 'dt-model-option-copy' },
                h('span', { className: 'dt-model-name' }, effort.name),
                effort.description !== undefined ? h('span', { className: 'dt-model-description' }, effort.description) : null),
              h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
            }))) : null
      return h('div', { ref: rootRef, className: 'dt-model-select', onKeyDown, onBlur },
        trigger,
        open ? h('div', {
          id: `${id}-menu`,
          className: 'dt-model-menu',
          role: 'menu',
          'aria-label': t('model.menuLabel'),
        }, rootPane, modelPane, effortPane) : null)
    }

    function MemberPicker({ binding, disabled, selected, onSelect }) {
      const state = useTavernStore()
      const t = useTranslate()
      const group = (state.bootstrap.groups || []).find((item) => item.name === binding.character)
      if (!group) return null
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      return h('div', { className: 'dt-member-row' },
        enabled.map((member) => h('button', {
          key: member,
          type: 'button',
          className: `dt-member-chip ${selected === member ? 'dt-member-chip-active' : ''}`,
          title: t('composer.member', { name: member }),
          disabled,
          onClick: () => onSelect(selected === member ? '' : member),
        },
        h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
        h('span', null, member))))
    }

    // 行动候选（提案 0010）：与正文生成解耦的轻量请求。仅 ST 生成入口可见
    // （bindingArchitecture==='st'，与重掷按钮/Tavern 标签页的可见性判断同源；
    // 群聊无单角色卡，服务端 getCharacter 必然落空，同样不暴露）；若 POST
    // candidates 返回 TAVERN_ARCHITECTURE_CONFLICT 则兜底隐藏本面板。
    // 候选项点击只填入输入框（可改再发，绝不自动发送）；带意见重新生成携带
    // feedback；失败展示错误并保留旧候选（服务端失败不落聊天、revision 不动）。
    function TavernCandidates({ sessionId, disabled, onFill }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const stored = chat ? normalizeStoredCandidates(chat.header?.chat_metadata?.candidates) : null
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [feedback, setFeedback] = useState('')
      const [conflicted, setConflicted] = useState(false)
      // 每个聊天最多自动展开一次：加载时已有候选则直接展示（提案 0010 §3.2），
      // 用户手动收起后不再强制弹开；切换到无候选的聊天则回到折叠态。
      const autoOpenedFor = useRef('')
      useEffect(() => {
        if (!key) return
        if (autoOpenedFor.current === key) return
        if (stored !== null) {
          autoOpenedFor.current = key
          setOpen(true)
        } else {
          setOpen(false)
        }
      }, [key, stored?.generatedAt])
      const generate = (withFeedback) => {
        if (!binding || busy || disabled) return
        const text = withFeedback ? feedback.trim() : ''
        setBusy(true)
        setError('')
        void (async () => {
          try {
            // 候选写走 revision CAS，必须先确保本地拿得到当前 revision。
            await loadChat(binding.character, binding.chatId)
            await generateChatCandidates(sessionId, binding, text === '' ? undefined : text)
            if (withFeedback) setFeedback('')
            setOpen(true)
          } catch (cause) {
            if (cause?.code === 'TAVERN_ARCHITECTURE_CONFLICT') {
              setConflicted(true)
              return
            }
            setError(cause instanceof Error ? cause.message : String(cause))
            if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
              await loadChat(binding.character, binding.chatId, true).catch(() => {})
            }
          } finally {
            setBusy(false)
          }
        })()
      }
      if (!binding || binding.group === true || bindingArchitecture(binding) !== 'st' || conflicted) return null
      const blocked = busy || disabled === true
      return h('div', { className: 'dt-candidates', 'data-dsh-soulmojito-surface': 'candidates' },
        h('div', { className: 'dt-candidates-head' },
          h('button', {
            type: 'button',
            className: 'dt-candidates-toggle',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
            h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : undefined }),
            h('span', null, t('candidates.title')),
            stored ? h('span', { className: 'dt-candidates-count' }, String(stored.items.length)) : null),
          h('div', { className: 'dt-candidates-actions' },
            h('button', { type: 'button', disabled: blocked, onClick: () => generate(false) },
              busy ? t('candidates.generating') : t('candidates.generate')))),
        open ? h('div', { className: 'dt-candidates-body' },
          busy ? h('p', { className: 'dt-muted' }, t('candidates.generating')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          stored
            ? h(React.Fragment, null,
              stored.generatedAt ? h('p', { className: 'dt-candidates-meta' }, t('candidates.generatedAt', { time: formatNovelTime(stored.generatedAt) })) : null,
              stored.feedback ? h('p', { className: 'dt-candidates-meta' }, t('candidates.lastFeedback', { feedback: stored.feedback })) : null,
              h('div', { className: 'dt-candidate-list' }, stored.items.map((item, index) => h('button', {
                key: index,
                type: 'button',
                className: 'dt-candidate-item',
                title: t('candidates.fill'),
                onClick: () => onFill(item.text),
              },
                h('span', { className: `dt-candidate-kind dt-candidate-kind-${item.kind}` }, t(`candidates.kind.${item.kind}`)),
                h('span', { className: 'dt-candidate-text' }, item.text)))))
            : h('p', { className: 'dt-muted' }, t('candidates.empty')),
          h('div', { className: 'dt-candidates-feedback' },
            h('input', {
              value: feedback,
              placeholder: t('candidates.feedbackPlaceholder'),
              disabled: blocked,
              onChange: (event) => setFeedback(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  generate(true)
                }
              },
            }),
            h('button', { type: 'button', disabled: blocked, onClick: () => generate(true) }, t('candidates.regenerate')))) : null)
    }
