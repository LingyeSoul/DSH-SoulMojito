    function formatWorkbenchTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
    }

    // 世界书方案字段值（string|number|boolean|null|string[]）的展示形态：
    // 数组按行 join，null 显式可见（可空字段有「跟随全局」语义），标量 String。
    function formatWorldPlanValue(value) {
      if (Array.isArray(value)) return value.join('\n')
      if (value === null) return 'null'
      if (value === undefined) return ''
      return String(value)
    }

    // 工作台方案卡片（提案 0013 P2；世界书面板化同构扩展）：pending 可批准/
    // 拒绝，已决定的显示状态；展开即 diff——卡方案逐字段，世界书方案按条目
    // 分组（#uid + 动作 + 逐字段 当前 → 改为，note 灰字）。
    function WorkbenchPlanCard({ plan, busy, open, onToggle, onDecide }) {
      const t = useTranslate()
      const isWorld = plan.kind === 'world'
      const changes = Array.isArray(plan.changes) ? plan.changes : []
      const entries = Array.isArray(plan.entries) ? plan.entries : []
      const meta = [isWorld
        ? t('workbench.worldMeta', { world: plan.world }) + (plan.op === 'create' ? ` · ${t('workbench.world.newBook')}` : '')
        : plan.character, plan.id]
      if (plan.appliedAt) meta.push(t('workbench.appliedAt', { time: formatWorkbenchTime(plan.appliedAt) }))
      else if (plan.decidedAt) meta.push(t('workbench.decidedAt', { time: formatWorkbenchTime(plan.decidedAt) }))
      else meta.push(formatWorkbenchTime(plan.createdAt))
      const renderFieldChange = (change, key) => h('div', { key, className: 'dt-workbench-change' },
        h('div', { className: 'dt-workbench-change-field' }, change.field),
        h('div', { className: 'dt-workbench-change-values' },
          change.currentValue !== undefined ? h('span', { className: 'dt-workbench-label' }, t('workbench.current')) : null,
          change.currentValue !== undefined
            ? h('pre', { className: 'dt-workbench-old' },
              // 数组值（tags/alternateGreetings/worldbook key 列表）按行 join 展示，避免压成一行
              Array.isArray(change.currentValue) ? change.currentValue.join('\n') : (change.currentValue || ''))
            : null,
          h('span', { className: 'dt-workbench-label' }, t('workbench.new')),
          h('pre', { className: 'dt-workbench-new' },
            Array.isArray(change.newValue) ? change.newValue.join('\n') : formatWorldPlanValue(change.newValue))),
        change.note ? h('p', { className: 'dt-workbench-note' }, change.note) : null)
      return h('div', { className: `dt-workbench-plan${plan.status === 'pending' ? '' : ' dt-workbench-done'}` },
        h('div', { className: 'dt-workbench-plan-head' },
          h('button', {
            type: 'button',
            className: 'dt-workbench-plan-title',
            onClick: onToggle,
            title: open ? t('workbench.hideDiff') : t('workbench.showDiff'),
          },
            h('span', { className: 'dt-workbench-caret' }, open ? '▾' : '▸'),
            h('span', null, plan.title || plan.id)),
          h('span', { className: `dt-workbench-status dt-workbench-status-${plan.status}` }, t(`workbench.status.${plan.status}`)),
          plan.status === 'pending'
            ? h('span', { className: 'dt-workbench-actions' },
                h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => onDecide(plan, true) }, t('workbench.approve')),
                h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => onDecide(plan, false) }, t('workbench.reject')))
            : null),
        h('div', { className: 'dt-workbench-meta' }, meta.join(' · ')),
        open ? h('div', { className: 'dt-workbench-diff' },
          isWorld
            ? entries.map((entry, index) => h('div', { key: index, className: 'dt-workbench-entry' },
              h('div', { className: 'dt-workbench-entry-head' },
                h('span', { className: 'dt-workbench-entry-uid' }, `#${entry.uid}`),
                h('span', { className: `dt-workbench-entry-action dt-workbench-entry-action-${entry.action}` }, t(`workbench.world.${entry.action}`))),
              entry.fields.map((change, fieldIndex) => renderFieldChange(change, fieldIndex)),
              entry.note ? h('p', { className: 'dt-workbench-note' }, entry.note) : null))
            : changes.map((change, index) => renderFieldChange(change, index))) : null)
    }

    // 试写预览（D-4 生成不入楼，决策 2026-10-11-preview-generation.md）：POST
    // preview——服务端以真实装配 + 单次 LLM 生成，但零副作用（不落楼/无 MVU 结算/
    // 五相位 hook 不跑/无事件）。客户端单请求同步等待（30-60s 量级，fetch 不设短
    // 超时），取消走 AbortController 断开 fetch（服务端透传 signal 给 llm.stream）。
    function WorkbenchPreviewBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [character, setCharacter] = useState('')
      const [chatId, setChatId] = useState('')
      const [userText, setUserText] = useState('')
      const [running, setRunning] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [cancelled, setCancelled] = useState(false)
      const abortRef = useRef(null)
      const chats = character ? (state.chatLists[character] || []) : []
      useEffect(() => {
        setChatId('')
        if (character) void loadChatList(character).catch(() => {})
      }, [character])
      const cancel = () => { abortRef.current?.abort() }
      const run = () => {
        if (running || !character || !chatId || userText.trim() === '') return
        setRunning(true)
        setError('')
        setResult(null)
        setCancelled(false)
        const controller = new AbortController()
        abortRef.current = controller
        void api('preview', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ character, chatId, userText }),
          signal: controller.signal,
        })
          .then((outcome) => { setResult(outcome); return outcome })
          .catch((cause) => {
            if (controller.signal.aborted) setCancelled(true)
            else setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => { setRunning(false); abortRef.current = null })
      }
      const usageLine = result
        ? (result.usage
          ? t('workbench.preview.usage', {
            provider: result.provider || '?',
            model: result.model || '?',
            input: result.usage.inputTokens ?? '?',
            output: result.usage.outputTokens ?? '?',
          })
          : t('workbench.preview.modelLine', { provider: result.provider || '?', model: result.model || '?' }))
        : ''
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('workbench.preview.title')),
        h('p', { className: 'dt-hint' }, t('workbench.preview.hint')),
        h('div', { className: 'dt-editor-actions' },
          h(SettingSelect, {
            label: t('settings.character'),
            value: character,
            options: state.bootstrap.characters || [],
            empty: t('workbench.preview.characterEmpty'),
            onChange: (value) => setCharacter(value || ''),
          }),
          h(SettingSelect, {
            label: t('workbench.preview.chat'),
            value: chatId,
            options: chats,
            empty: chats.length === 0 ? t('workbench.preview.chatEmpty') : t('workbench.preview.chatPick'),
            onChange: (value) => setChatId(value || ''),
          })),
        h(EditorField, {
          label: t('workbench.preview.userText'),
          value: userText,
          multiline: true,
          placeholder: t('workbench.preview.placeholder'),
          disabled: running,
          onChange: setUserText,
        }),
        h('div', { className: 'dt-imports' },
          h(Button, {
            size: 'sm',
            variant: 'primary',
            icon: h(IconSendOutline16),
            disabled: running || !character || !chatId || userText.trim() === '',
            onClick: run,
          }, running ? t('workbench.preview.running') : t('workbench.preview.run')),
          running ? h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconStopFill16),
            onClick: cancel,
          }, t('workbench.preview.cancel')) : null),
        result ? h(React.Fragment, null,
          h('p', { className: 'dt-hint' }, usageLine),
          h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0', fontSize: '13px' } }, result.text)) : null,
        cancelled ? h('p', { className: 'dt-hint' }, t('workbench.preview.cancelled')) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PanelWorkbench() {
      const t = useTranslate()
      const [plans, setPlans] = useState(null)
      const [error, setError] = useState('')
      const [busyId, setBusyId] = useState('')
      const [openId, setOpenId] = useState('')
      const reload = () => loadWorkbenchPlans('all')
        .then((result) => { setPlans(Array.isArray(result.plans) ? result.plans : []); setError(''); return result })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void reload() }, [])
      const decide = (plan, approve) => {
        if (busyId !== '') return
        setBusyId(plan.id)
        setError('')
        void decideWorkbenchPlan(plan.id, approve)
          .then(() => {
            // 批准会写入资产（角色卡/世界书/预设）：立即重取 bootstrap，角色卡
            // 分区与侧栏不必等下一次水位轮询就同步到新内容。
            if (approve === true) void refreshBootstrap().catch(() => {})
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyId(''))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('p', { className: 'dt-hint' }, t('workbench.hint')),
          h('div', { className: 'dt-imports' },
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('workbench.refresh')))),
        h('section', { className: 'dt-settings-band' },
          error ? h('p', { className: 'dt-error' }, error) : null,
          plans === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : plans.length === 0
              ? h('p', { className: 'dt-muted' }, t('workbench.empty'))
              : h('div', { className: 'dt-workbench-list' },
                plans.map((plan) => h(WorkbenchPlanCard, {
                  key: plan.id,
                  plan,
                  busy: busyId === plan.id,
                  open: openId === plan.id,
                  onToggle: () => setOpenId(openId === plan.id ? '' : plan.id),
                  onDecide: decide,
                })))),
        h(WorkbenchPreviewBand))
    }

    function PanelNovels({ ctx }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [novels, setNovels] = useState(null)
      const [error, setError] = useState('')
      const [selected, setSelected] = useState('')
      const [creating, setCreating] = useState(false)
      const [editing, setEditing] = useState(null)
      const capability = state.bootstrap.agentNovel || { available: false, missing: [], reasons: [] }
      const unavailableReason = capability.reasons?.length ? capability.reasons.join(' ')
        : capability.missing?.length ? capability.missing.join(', ') : ''
      const reload = () => fetchNovelList()
        .then((list) => { setNovels(list); setError(''); return list })
        .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return null })
      useEffect(() => { void reload() }, [])
      if (selected !== '') {
        return h(NovelDetail, {
          ctx,
          novelId: selected,
          onBack: () => setSelected(''),
          onChanged: () => { void reload() },
        })
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-imports' },
            h(Button, {
              size: 'sm',
              variant: 'primary',
              icon: h(IconPlusOutline16),
              disabled: capability.available !== true,
              title: capability.available !== true && unavailableReason !== ''
                ? t('novel.createUnavailable', { reason: unavailableReason })
                : undefined,
              onClick: () => setCreating(true),
            }, t('novel.create')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('novel.refresh'))),
          capability.available !== true
            ? h('p', { className: 'dt-hint' }, t('novel.createUnavailable', { reason: unavailableReason || '—' }))
            : null),
        h('section', { className: 'dt-settings-band' },
          novels === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : novels.length === 0
              ? h('p', { className: 'dt-muted' }, t('novel.empty'))
              : h('div', { className: 'dt-novel-list' }, novels.map((novel) => h(NovelCard, {
                key: novel.novelId,
                ctx,
                novel,
                t,
                onDetail: () => setSelected(novel.novelId),
                onEdit: () => setEditing(novel),
                onChanged: reload,
              }))),
          error ? h('p', { className: 'dt-error' }, error) : null),
        creating ? h(NovelCreateForm, {
          onClose: () => setCreating(false),
          onCreated: (created) => {
            setCreating(false)
            void reload().then((list) => {
              if (list !== null && created?.novelId) setSelected(created.novelId)
            })
          },
        }) : null,
        editing ? h(NovelEditForm, {
          novel: editing,
          onClose: () => setEditing(null),
          onSaved: () => { setEditing(null); void reload() },
        }) : null)
    }
