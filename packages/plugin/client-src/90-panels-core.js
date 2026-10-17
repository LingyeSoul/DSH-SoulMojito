    // 面板分区注册表（提案 0015 §3.5 P0）：{id, icon, label, component}。
    // label 是 locale thunk（渲染点传入当前 t，宿主 locale 切换跟随——MVU 侧栏
    // tab 的 title thunk 先例）；component 收 {ctx, useSessions} 统一面板宿主
    // 参数，各分区自取所需。registerPanelSection 追加在尾部：内置 13 分区的
    // 顺序即注册顺序，行为与常量 + 三元链时代零变化；P1 的 Mod 面板分区
    // （声明式清单 + 通用 ModSurface 渲染器）以同一入口追加。
    const panelSections = []

    function registerPanelSection(definition) {
      panelSections.push(definition)
      return () => {
        const index = panelSections.indexOf(definition)
        if (index >= 0) panelSections.splice(index, 1)
      }
    }

    for (const definition of [
      { id: 'overview', icon: IconSparkle16, label: (t) => t('panel.section.overview'), component: () => h(PanelOverview) },
      { id: 'characters', icon: IconUserOutline16, label: (t) => t('panel.section.characters'), component: (host) => h(PanelCharacters, { ctx: host.ctx }) },
      { id: 'chats', icon: IconQueueOutline14, label: (t) => t('panel.section.chats'), component: (host) => h(TavernSidebar, { ctx: host.ctx, useSessions: host.useSessions }) },
      { id: 'guides', icon: IconListPenOutline16, label: (t) => t('panel.section.guides'), component: (host) => h(PanelGuides, { useSessions: host.useSessions }) },
      { id: 'novels', icon: IconListPenOutline16, label: (t) => t('panel.section.novels'), component: (host) => h(PanelNovels, { ctx: host.ctx }) },
      { id: 'groups', icon: IconPersonalizationOutline16, label: (t) => t('panel.section.groups'), component: () => h(GroupBand) },
      { id: 'personas', icon: IconDataOutline16, label: (t) => t('panel.section.personas'), component: () => h(PersonaBand) },
      { id: 'worlds', icon: IconBrowseOutline16, label: (t) => t('panel.section.worlds'), component: () => h(PanelWorlds) },
      { id: 'presets', icon: IconAgentPresetOutline16, label: (t) => t('panel.section.presets'), component: () => h(PanelPresets) },
      { id: 'scripts', icon: IconListPenOutline16, label: (t) => t('panel.section.scripts'), component: () => h(PanelScripts) },
      { id: 'regex', icon: IconListPenOutline16, label: (t) => t('panel.section.regex'), component: () => h(RegexBand) },
      { id: 'variables', icon: IconCordisPluginOutline14, label: (t) => t('panel.section.variables'), component: (host) => h(PanelVariables, { useSessions: host.useSessions }) },
      { id: 'workbench', icon: IconListPenOutline16, label: (t) => t('panel.section.workbench'), component: () => h(PanelWorkbench) },
      // 第 14 个分区「游戏」（提案 0018 §4.3，P1）：清单 + 开局 + 本聊天对局面
      // （GameSurface 持久 iframe；games/revision 1s 轮询仅在存在未终局会话时
      // 进行，页面不可见停发）。图标是手柄（2026-10-14），与总览的 sparkle 区分。
      { id: 'games', icon: IconGamepadOutline16, label: (t) => t('panel.section.games'), component: (host) => h(GamesPanel, { useSessions: host.useSessions }) },
      // 第 15 个分区「Mod」（提案 0015 §3.5 P1）：列表 + 两层开关 + 重载 + 启用
      // 确认弹层（如实展示 capabilities，知情同意）。
      { id: 'mods', icon: IconCordisPluginOutline14, label: (t) => t('panel.section.mods'), component: () => h(PanelMods) },
      // 第 16 个分区「记忆检索」（提案 0016）：混合检索 embed 端点设置 + 探针。
      { id: 'memory', icon: IconDataOutline16, label: (t) => t('panel.section.memory'), component: () => h(MemoryRetrievalBand) },
      // 第 17 个分区「提示词」（A-6，2026-10-11）：ST 循环实发请求 + 世界书激活
      // 追踪的只读查看器（服务端 prompt-viewer.ts 环形缓冲）。
      { id: 'prompts', icon: IconSearchOutline16, label: (t) => t('panel.section.prompts'), component: () => h(PanelPrompts) },
      // 第 18 个分区「关于」（2026-10-12）：插件版本 stamp + 官网/作者/源码
      // 仓库外链，纯静态信息面。
      { id: 'about', icon: IconBrowseOutline16, label: (t) => t('panel.section.about'), component: () => h(PanelAbout) },
    ]) {
      registerPanelSection(definition)
    }

    function PanelOverview() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const characterKey = bootstrap.characters.join('\u0000')
      const groupKey = (bootstrap.groups || []).map((group) => group.name).join('\u0000')
      useEffect(() => {
        for (const character of bootstrap.characters) void loadChatList(character).catch(() => {})
        for (const group of bootstrap.groups || []) void loadChatList(group.name).catch(() => {})
      }, [characterKey, groupKey])
      const chatsTotal = Object.keys(state.chatLists)
        .reduce((sum, character) => sum + (state.chatLists[character]?.length || 0), 0)
      return h(React.Fragment, null,
        h(ActiveSetupBand),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.title')),
          h('p', { className: 'dt-hint' }, t('panel.overview.counts', {
            characters: bootstrap.characters.length,
            chats: chatsTotal,
            worlds: bootstrap.worlds.length,
            presets: bootstrap.presets.length,
            personas: bootstrap.personas.length,
            groups: (bootstrap.groups || []).length,
          }))),
        h(UpdateBand, { compact: false }),
        state.error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, state.error)) : null)
    }

    function cloneValue(value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value))
    }

    function EditorField({ label, value, onChange, multiline = false, type = 'text', min, max, step, className = '', hint, placeholder, disabled }) {
      const props = {
        value: value ?? '',
        type,
        min,
        max,
        step,
        placeholder,
        onChange: (event) => onChange(event.target.value),
        ...(disabled === true ? { disabled: true } : {}),
      }
      return h('label', { className: `dt-editor-field ${className}` },
        h('span', { className: 'dt-label' }, label),
        multiline ? h('textarea', { ...props, type: undefined }) : h('input', props),
        hint ? h('span', { className: 'dt-hint' }, hint) : null)
    }

    function CardEditor({ card, name, onSave, onCancel, hint }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(card))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [advanced, setAdvanced] = useState(() => JSON.stringify({ extensions: card?.data?.extensions || {}, characterBook: card?.data?.characterBook, assets: card?.data?.assets, source: card?.data?.source, groupOnlyGreetings: card?.data?.groupOnlyGreetings, creatorNotesMultilingual: card?.data?.creatorNotesMultilingual, characterVersion: card?.data?.characterVersion, creationDate: card?.data?.creationDate, modificationDate: card?.data?.modificationDate }, null, 2))
      const data = draft?.data || {}
      const advancedBaseline = JSON.stringify({ extensions: card?.data?.extensions || {}, characterBook: card?.data?.characterBook, assets: card?.data?.assets, source: card?.data?.source, groupOnlyGreetings: card?.data?.groupOnlyGreetings, creatorNotesMultilingual: card?.data?.creatorNotesMultilingual, characterVersion: card?.data?.characterVersion, creationDate: card?.data?.creationDate, modificationDate: card?.data?.modificationDate }, null, 2)
      const dirty = JSON.stringify(draft) !== JSON.stringify(card) || advanced !== advancedBaseline
      useEffect(() => {
        if (draft === null && card) {
          setDraft(cloneValue(card))
          setAdvanced(JSON.stringify({ extensions: card.data?.extensions || {}, characterBook: card.data?.characterBook, assets: card.data?.assets, source: card.data?.source, groupOnlyGreetings: card.data?.groupOnlyGreetings, creatorNotesMultilingual: card.data?.creatorNotesMultilingual, characterVersion: card.data?.characterVersion, creationDate: card.data?.creationDate, modificationDate: card.data?.modificationDate }, null, 2))
        }
      }, [card])
      useEffect(() => {
        if (!dirty) return undefined
        const handleBeforeUnload = (event) => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', handleBeforeUnload)
        return () => window.removeEventListener('beforeunload', handleBeforeUnload)
      }, [dirty])
      const setData = (key, value) => setDraft((current) => ({ ...current, data: { ...(current.data || {}), [key]: value } }))
      const identitySummary = typeof data.extensions?.agentTavern?.identitySummary === 'string'
        ? data.extensions.agentTavern.identitySummary
        : ''
      const setIdentitySummary = (value) => setDraft((current) => ({
        ...current,
        data: {
          ...(current.data || {}),
          extensions: {
            ...(current.data?.extensions || {}),
            agentTavern: { ...((current.data?.extensions || {}).agentTavern || {}), identitySummary: value },
          },
        },
      }))
      const cancel = () => {
        if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel()
      }
      const save = () => {
        let extra
        try { extra = advanced.trim() === '' ? {} : JSON.parse(advanced) } catch { setError('Advanced card data must be valid JSON.'); return }
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) { setError('Advanced card data must be a JSON object.'); return }
        // 专用编辑字段对 identitySummary 有更高优先级；留空且原卡也没有时不动
        // extensions，避免给无关卡片塞进空命名空间。
        const nextData = { ...data, ...extra, name: String(data.name || '').trim() }
        const originalSummary = typeof card?.data?.extensions?.agentTavern?.identitySummary === 'string'
          ? card.data.extensions.agentTavern.identitySummary
          : ''
        if (identitySummary !== '' || originalSummary !== '') {
          nextData.extensions = { ...(nextData.extensions || {}) }
          const agentExtensions = { ...((nextData.extensions || {}).agentTavern || {}) }
          if (identitySummary !== '') agentExtensions.identitySummary = identitySummary
          else delete agentExtensions.identitySummary
          if (Object.keys(agentExtensions).length > 0) nextData.extensions.agentTavern = agentExtensions
          else delete nextData.extensions.agentTavern
        }
        setSaving(true)
        setError('')
        void Promise.resolve(onSave({ ...draft, data: nextData }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      if (!draft) return h('p', { className: 'dt-muted' }, t('nav.loading'))
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !String(data.name || '').trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('p', { className: 'dt-hint' }, hint || t('panel.characters.editHint')),
        h('div', { className: 'dt-editor-grid' },
          h(EditorField, { label: t('panel.rename'), value: data.name, onChange: (value) => setData('name', value) }),
          h(EditorField, { label: t('panel.characters.nickname'), value: data.nickname, onChange: (value) => setData('nickname', value) }),
          h(EditorField, { label: t('panel.characters.creator'), value: data.creator, onChange: (value) => setData('creator', value) }),
          h(EditorField, { label: t('panel.characters.tags'), value: commaList(data.tags), onChange: (value) => setData('tags', parseCommaList(value)) }),
          h(EditorField, { label: t('panel.characters.identitySummary'), value: identitySummary, onChange: setIdentitySummary, multiline: true, className: 'dt-editor-wide', hint: t('panel.characters.identitySummaryHint') }),
          h(EditorField, { label: t('panel.characters.description'), value: data.description, onChange: (value) => setData('description', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.personality'), value: data.personality, onChange: (value) => setData('personality', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.scenario'), value: data.scenario, onChange: (value) => setData('scenario', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.firstMes'), value: data.firstMes, onChange: (value) => setData('firstMes', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.mesExample'), value: data.mesExample, onChange: (value) => setData('mesExample', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.alternateGreetings'), value: (data.alternateGreetings || []).join('\n'), onChange: (value) => setData('alternateGreetings', value.split('\n').map((item) => item.trim()).filter(Boolean)), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.systemPrompt'), value: data.systemPrompt, onChange: (value) => setData('systemPrompt', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.postHistory'), value: data.postHistoryInstructions, onChange: (value) => setData('postHistoryInstructions', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.creatorNotes'), value: data.creatorNotes, onChange: (value) => setData('creatorNotes', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.advancedJson'), value: advanced, onChange: setAdvanced, multiline: true, className: 'dt-editor-wide dt-editor-json' })),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function CharacterCardFields({ card }) {
      const t = useTranslate()
      const [expanded, setExpanded] = useState({})
      if (!card) return h('div', { className: 'dt-card-fields' }, h('span', { className: 'dt-muted' }, t('nav.loading')))
      const data = card.data || {}
      const field = (key, label) => {
        const text = typeof data[key] === 'string' ? data[key].trim() : ''
        if (text === '') return null
        return h('div', { key, className: 'dt-card-field' },
          h('button', {
            type: 'button',
            className: 'dt-card-field-head',
            'aria-expanded': expanded[key] === true,
            onClick: () => setExpanded({ ...expanded, [key]: !expanded[key] }),
          },
          h('span', null, label),
          h(IconChevronDownOutline14, { className: expanded[key] ? 'dt-chevron-open' : '' })),
          expanded[key] ? h('div', { className: 'dt-card-copy' }, h(MarkdownText, { text })) : null)
      }
      return h('div', { className: 'dt-card-fields' },
        field('description', t('panel.characters.description')),
        field('personality', t('panel.characters.personality')),
        field('scenario', t('panel.characters.scenario')),
         field('firstMes', t('panel.characters.firstMes')),
         field('mesExample', t('panel.characters.mesExample')),
         field('creatorNotes', t('panel.characters.creatorNotes')))
    }

    // 手动新建的空白卡模板（提案 0013）：字段口径对齐 card_create 工具——
    // spec_version 蛇形是 decode 端（tavern-format card.ts）的读取口径。
    const BLANK_CHARACTER_CARD = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '',
        nickname: '',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        tags: [],
        creator: '',
        characterVersion: '',
        extensions: {},
      },
    }

    // 手动新建的空白世界书模板：条目缺省值由 WorldBookEditor 的 addEntry 按
    // normalizeEntry 口径补全（与 worldbook.ts 落库归一一致）。
    const BLANK_WORLD_BOOK = { name: '', entries: [] }

    // 手动新建的空白预设模板：空 prompts/prompt_order 即合法 chat-completion
    // 形态（detectPresetKind 按这两个数组判定），采样字段留空袋由编辑器维护。
    const BLANK_PRESET = { prompts: [], prompt_order: [] }

    function PanelCharacters({ ctx }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [viewing, setViewing] = useState('')
      const [editing, setEditing] = useState('')
      const [creating, setCreating] = useState(false)
      const [guideOpen, setGuideOpen] = useState(false)
      const [launching, setLaunching] = useState(false)
      const [cards, setCards] = useState({})
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const viewCard = (name) => {
        if (editing === name) return
        if (viewing === name) { setViewing(''); return }
        setViewing(name)
        if (!(name in cards)) {
          setCards((current) => ({ ...current, [name]: null }))
          void fetchCharacterCard(name)
            .then((card) => setCards((current) => ({ ...current, [name]: card })))
            .catch((cause) => {
              setCards((current) => {
                const next = { ...current }
                delete next[name]
                return next
              })
              setViewing('')
              setError(t('panel.characters.loadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
        }
      }
      const editCard = (name) => {
        if (editing === name) { setEditing(''); return }
        setEditing(name)
        setViewing(name)
        if (!(name in cards)) {
          setCards((current) => ({ ...current, [name]: null }))
          void fetchCharacterCard(name).then((card) => setCards((current) => ({ ...current, [name]: card })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, card) => saveCharacterCard(name, card).then((saved) => {
        const nextName = saved?.data?.name || name
        setCards((current) => {
          const next = { ...current, [nextName]: saved }
          if (nextName !== name) delete next[name]
          return next
        })
        setEditing('')
        setViewing(nextName)
      })
      // 手动新建走与 card_create 工具同一条 import/character 落库路径；导入语义
      // 是重名覆盖，面板侧先拦同名（含大小写不敏感——落盘 stem 在部分文件系统
      // 上不区分大小写），避免一键静默覆盖既有角色。
      const createCharacter = (card) => {
        const name = String(card?.data?.name || '').trim()
        if (name === '') return Promise.reject(new Error(t('panel.rename')))
        const normalized = name.toLowerCase()
        if (state.bootstrap.characters.some((existing) => existing.toLowerCase() === normalized)) {
          return Promise.reject(new Error(t('panel.characters.duplicate', { name })))
        }
        return api('import/character', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ card }),
        })
          .then(async (result) => {
            await refreshBootstrap()
            setCards((current) => ({ ...current, [result.name]: result.card }))
            setCreating(false)
            setViewing(result.name)
            return result.card
          })
          .catch((cause) => {
            throw new Error(t('panel.characters.createFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
      }
      const launchWorkbench = () => {
        if (launching) return
        setLaunching(true)
        setError('')
        // 向导语义是「新建角色卡」：每次拉起都是新的写卡会话，不复用既有绑定。
        void openWorkbenchSession(ctx, null, { fresh: true })
          .then(() => setGuideOpen(false))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setLaunching(false))
      }
      const characters = state.bootstrap.characters
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'character', label: t('settings.importCharacter'), accept: '.png,.charx,.json,application/json,image/png,application/zip' }),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => setGuideOpen(true) }, `+ ${t('panel.characters.new')}`))),
        h('section', { className: 'dt-settings-band' },
          characters.length === 0 && !creating
            ? h('p', { className: 'dt-muted' }, t('panel.characters.empty'))
            : h('div', { className: 'dt-card-grid' },
              creating
                ? h('div', { className: 'dt-card dt-card-editing' },
                  h('div', { className: 'dt-card-head' },
                    h('div', { className: 'dt-card-title' },
                      h('strong', null, t('panel.characters.creating')))),
                  h(CardEditor, { card: BLANK_CHARACTER_CARD, name: '', hint: t('panel.characters.createEditorHint'), onSave: createCharacter, onCancel: () => setCreating(false) }))
                : null,
              characters.map((name) => {
              const active = state.bootstrap.state.activeCharacter === name
              const card = cards[name]
              return h('div', { key: name, className: `dt-card ${editing === name ? 'dt-card-editing' : ''}` },
                h('div', { className: 'dt-card-head' },
                  h('img', { src: `${API}/avatar/${encodeURIComponent(name)}`, alt: '' }),
                  h('div', { className: 'dt-card-title' },
                    h('strong', null, name),
                    card?.data?.creator ? h('span', null, t('panel.characters.creator', { name: card.data.creator })) : null)),
                h('div', { className: 'dt-card-actions' },
                  active
                    ? h(Pill, { active: true }, t('panel.characters.active'))
                    : h(Button, { size: 'sm', variant: 'outline', onClick: () => run(patchState({ activeCharacter: name })) }, t('panel.characters.setActive')),
                  h(Button, { size: 'sm', variant: 'ghost', onClick: () => viewCard(name) }, t(viewing === name ? 'panel.characters.hideCard' : 'panel.characters.viewCard')),
                  h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editCard(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconDownloadOutline16),
                    'aria-label': t('panel.characters.export', { name }),
                    title: t('panel.characters.export', { name }),
                    onClick: () => downloadAsset(`export/character/${encodeURIComponent(name)}`, `${name}.png`),
                  }),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconTrashOutline16),
                    'aria-label': t('panel.characters.delete', { name }),
                    title: t('panel.characters.delete', { name }),
                    onClick: () => {
                      if (window.confirm(t('panel.characters.deleteConfirm', { name }))) run(deleteCharacterAsset(name))
                    },
                  })),
                editing === name
                  ? h(CardEditor, { card, name, onSave: (next) => save(name, next), onCancel: () => setEditing('') })
                  : viewing === name ? h(CharacterCardFields, { card }) : null)
            }))),
        guideOpen
          ? h(NovelModalFrame, {
            title: t('panel.characters.createTitle'),
            closeLabel: t('panel.close'),
            onClose: () => setGuideOpen(false),
          },
          h('p', { className: 'dt-hint' }, t('panel.characters.createHint')),
          h('div', { className: 'dt-create-choices' },
            h('div', { className: 'dt-create-choice' },
              h('div', { className: 'dt-create-choice-copy' },
                h('h3', null, t('panel.characters.createAgentTitle')),
                h('p', { className: 'dt-hint' }, t('panel.characters.createAgentHint'))),
              h(Button, { size: 'sm', variant: 'primary', icon: h(IconSparkle16), disabled: launching, onClick: launchWorkbench }, launching ? t('workbench.opening') : t('panel.characters.createAgentLaunch'))),
            h('div', { className: 'dt-create-choice' },
              h('div', { className: 'dt-create-choice-copy' },
                h('h3', null, t('panel.characters.createManualTitle')),
                h('p', { className: 'dt-hint' }, t('panel.characters.createManualHint'))),
              h(Button, { size: 'sm', variant: 'outline', icon: h(IconEditOutline16), onClick: () => { setGuideOpen(false); setCreating(true) } }, t('panel.characters.createManualStart')))),
          error ? h('p', { className: 'dt-error' }, error) : null)
          : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    function loreKeys(entry) {
      const primary = Array.isArray(entry.key) ? entry.key : []
      const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : []
      return [...primary, ...secondary].filter((value) => value !== '').join(', ')
    }

    function ToggleField({ label, checked, onChange }) {
      return h('label', { className: 'dt-editor-toggle' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, label))
    }

    function WorldBookEditor({ book, onSave, onCancel }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(book))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const dirty = JSON.stringify(draft) !== JSON.stringify(book)
      const entries = draft?.entries || []
      const setBook = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
      const setEntry = (uid, key, value) => setDraft((current) => ({ ...current, entries: (current.entries || []).map((entry) => entry.uid === uid ? { ...entry, [key]: value } : entry) }))
      const addEntry = () => {
        const uid = entries.reduce((max, entry) => Math.max(max, Number(entry.uid) || 0), -1) + 1
        setDraft((current) => ({ ...current, entries: [...(current.entries || []), { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [], matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false }] }))
      }
      const removeEntry = (uid) => setDraft((current) => ({ ...current, entries: (current.entries || []).filter((entry) => entry.uid !== uid) }))
      const save = () => {
        setSaving(true)
        setError('')
        void Promise.resolve(onSave({ ...draft, name: String(draft.name || '').trim(), entries: entries.map((entry) => ({ ...entry, order: Number(entry.order) || 0, depth: Number(entry.depth) || 0 })) }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      if (!draft) return h('p', { className: 'dt-muted' }, t('nav.loading'))
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !String(draft.name || '').trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('div', { className: 'dt-editor-grid' },
          h(EditorField, { label: t('panel.worlds.name'), value: draft.name, onChange: (value) => setBook('name', value) })),
        h('div', { className: 'dt-editor-section-title' },
          h('strong', null, t('panel.worlds.entry')),
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: addEntry }, t('panel.worlds.addEntry'))),
        h('div', { className: 'dt-editor-entries' }, entries.map((entry, index) => h('section', { key: entry.uid ?? index, className: 'dt-editor-entry' },
          h('div', { className: 'dt-editor-entry-head' },
            h('strong', null, entry.comment || `#${index + 1}`),
            h(Button, { size: 'sm', variant: 'ghost', icon: h(IconTrashOutline16), 'aria-label': t('panel.remove'), title: t('panel.remove'), onClick: () => removeEntry(entry.uid) })),
          h('div', { className: 'dt-editor-grid' },
            h(EditorField, { label: t('panel.worlds.comment'), value: entry.comment, onChange: (value) => setEntry(entry.uid, 'comment', value) }),
            h(EditorField, { label: t('panel.worlds.keysPrimary'), value: commaList(entry.key), onChange: (value) => setEntry(entry.uid, 'key', parseCommaList(value)) }),
            h(EditorField, { label: t('panel.worlds.keysSecondary'), value: commaList(entry.keysecondary), onChange: (value) => setEntry(entry.uid, 'keysecondary', parseCommaList(value)) }),
            h(EditorField, { label: t('panel.worlds.order'), value: entry.order, type: 'number', onChange: (value) => setEntry(entry.uid, 'order', value) }),
            h(EditorField, { label: t('panel.worlds.depth'), value: entry.depth, type: 'number', min: 0, onChange: (value) => setEntry(entry.uid, 'depth', value) }),
            h(EditorField, { label: 'Probability', value: entry.probability, type: 'number', min: 0, max: 100, onChange: (value) => setEntry(entry.uid, 'probability', value) }),
            h(EditorField, { label: t('panel.worlds.content'), value: entry.content, onChange: (value) => setEntry(entry.uid, 'content', value), multiline: true, className: 'dt-editor-wide' }),
            h('div', { className: 'dt-editor-toggles dt-editor-wide' },
              h(ToggleField, { label: t('panel.worlds.enabled'), checked: !entry.disable, onChange: (value) => setEntry(entry.uid, 'disable', !value) }),
              h(ToggleField, { label: t('panel.worlds.constant'), checked: entry.constant, onChange: (value) => setEntry(entry.uid, 'constant', value) }),
              h(ToggleField, { label: t('panel.worlds.selective'), checked: entry.selective, onChange: (value) => setEntry(entry.uid, 'selective', value) })))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PanelWorlds() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [browse, setBrowse] = useState('')
      const [editing, setEditing] = useState('')
      const [creating, setCreating] = useState(false)
      const [books, setBooks] = useState({})
      const [filter, setFilter] = useState('')
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const toggleBrowse = (name) => {
        if (browse === name) { setBrowse(''); return }
        setBrowse(name)
        if (!(name in books)) {
          setBooks((current) => ({ ...current, [name]: null }))
          void fetchWorldBook(name)
            .then((book) => setBooks((current) => ({ ...current, [name]: book })))
            .catch((cause) => {
              setBrowse('')
              setError(cause instanceof Error ? cause.message : String(cause))
            })
        }
      }
      const editBook = (name) => {
        setEditing(editing === name ? '' : name)
        setBrowse(name)
        if (!(name in books)) {
          setBooks((current) => ({ ...current, [name]: null }))
          void fetchWorldBook(name).then((book) => setBooks((current) => ({ ...current, [name]: book })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, book) => saveWorldBook(name, book).then((saved) => {
        const next = saved?.name || name
        setBooks((current) => {
          const result = { ...current, [next]: saved }
          if (next !== name) delete result[name]
          return result
        })
        setBrowse(next)
        setEditing('')
      })
      // 手动新建走与编辑同一条 PUT world 路径（oldName === 新名，importWorldFile
      // 落盘即建书）；重名覆盖语义与导入一致，面板侧先拦同名（大小写不敏感，
      // 落盘 stem 在部分文件系统上不区分大小写），避免一键静默覆盖既有书。
      const createWorld = (book) => {
        const name = String(book?.name || '').trim()
        if (name === '') return Promise.reject(new Error(t('panel.rename')))
        const normalized = name.toLowerCase()
        if (state.bootstrap.worlds.some((existing) => existing.toLowerCase() === normalized)) {
          return Promise.reject(new Error(t('panel.worlds.duplicate', { name })))
        }
        return saveWorldBook(name, book)
          .then((saved) => {
            setBooks((current) => ({ ...current, [name]: saved }))
            setCreating(false)
            setBrowse(name)
            return saved
          })
          .catch((cause) => {
            throw new Error(t('panel.worlds.createFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
      }
      const worlds = state.bootstrap.worlds
      const book = browse !== '' ? books[browse] : undefined
      const entries = book?.entries
        ? book.entries.filter((entry) => filter === '' || `${entry.comment}\n${entry.content}\n${loreKeys(entry)}`.toLowerCase().includes(filter.toLowerCase()))
        : []
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'world', label: t('settings.importWorld'), accept: '.json,application/json' }),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => { setEditing(''); setBrowse(''); setCreating(true) } }, `+ ${t('panel.worlds.new')}`))),
        h('section', { className: 'dt-settings-band' },
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: state.bootstrap.state.worldFollowsCharacter !== false,
              onChange: (event) => run(patchState({ worldFollowsCharacter: event.target.checked })),
            }),
            h('span', null, t('settings.worldFollowsCharacter'))),
          worlds.length === 0 && !creating
            ? h('p', { className: 'dt-muted' }, t('settings.worldsEmpty'))
            : h('div', { className: 'dt-world-list' }, worlds.map((name) => h('div', { key: name, className: 'dt-world-row' },
              h('label', { className: 'dt-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: state.bootstrap.state.activeWorlds.includes(name),
                  onChange: (event) => {
                    const next = new Set(state.bootstrap.state.activeWorlds)
                    if (event.target.checked) next.add(name)
                    else next.delete(name)
                    run(patchState({ activeWorlds: [...next] }))
                  },
                }),
                h('span', null, name)),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => toggleBrowse(name) },
                browse === name ? t('panel.characters.hideCard') : t('panel.worlds.entries', { count: books[name]?.entries?.length ?? state.bootstrap.worldEntryCounts?.[name] ?? 0 })),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editBook(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconDownloadOutline16), 'aria-label': t('panel.exportJson'), title: t('panel.exportJson'), onClick: () => downloadAsset(`export/world/${encodeURIComponent(name)}`, `${name}.json`) }),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                'aria-label': t('panel.worlds.delete', { name }),
                title: t('panel.worlds.delete', { name }),
                onClick: () => {
                  if (window.confirm(t('panel.worlds.deleteConfirm', { name }))) run(deleteWorldBook(name))
                },
              }))))),
         browse !== '' ? h('section', { className: 'dt-settings-band' },
           h('h3', null, browse),
           editing === browse && book
             ? h(WorldBookEditor, { book, onSave: (next) => save(browse, next), onCancel: () => setEditing('') })
             : h(React.Fragment, null,
               h('div', { className: 'dt-imports' },
                 h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.worlds.search'), value: filter, onChange: (event) => setFilter(event.target.value) })),
               !book
                 ? h('p', { className: 'dt-muted' }, t('nav.loading'))
                 : entries.length === 0
                   ? h('p', { className: 'dt-muted' }, t('panel.worlds.noEntries'))
                   : h('div', { className: 'dt-entry-list' }, entries.map((entry, index) => h('div', { key: entry.uid ?? index, className: `dt-entry ${entry.disable ? 'dt-entry-off' : ''}` },
                     h('div', { className: 'dt-entry-head' },
                       h('strong', null, entry.comment || `#${entry.uid ?? index + 1}`),
                       h('span', { className: 'dt-entry-keys' }, t('panel.worlds.keys', { keys: loreKeys(entry) }))),
                     h('div', { className: 'dt-entry-content' }, entry.content)))))) : null,
         creating
           ? h('section', { className: 'dt-settings-band' },
               h('h3', null, t('panel.worlds.creating')),
               h('p', { className: 'dt-hint' }, t('panel.worlds.createEditorHint')),
               h(WorldBookEditor, { book: BLANK_WORLD_BOOK, onSave: createWorld, onCancel: () => setCreating(false) }))
           : null,
         error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    function PresetEditor({ name, data, kind, onSave, onCancel }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(data) || {})
      const [presetName, setPresetName] = useState(name)
      const [advanced, setAdvanced] = useState(() => JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order')), null, 2))
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const prompts = draft.prompts || []
      const chatPreset = kind === 'chat-completion' || Array.isArray(data?.prompts)
      const dirty = presetName !== name || advanced !== JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order')), null, 2) || JSON.stringify(draft.prompts) !== JSON.stringify((data || {}).prompts)
      const setPrompt = (index, key, value) => setDraft((current) => {
        const previous = current.prompts?.[index]
        const next = { ...current, prompts: (current.prompts || []).map((prompt, promptIndex) => promptIndex === index ? { ...prompt, [key]: value } : prompt) }
        if (key === 'identifier' && previous?.identifier !== value) {
          next.prompt_order = (current.prompt_order || []).map((item) => ({ ...item, order: (item.order || []).map((entry) => entry.identifier === previous?.identifier ? { ...entry, identifier: value } : entry) }))
        }
        return next
      })
      const addPrompt = () => {
        const identifier = `customPrompt${prompts.length + 1}`
        const prompt = { name: 'New prompt', identifier, role: 'system', content: '', system_prompt: true }
        setDraft((current) => {
          const order = Array.isArray(current.prompt_order) && current.prompt_order.length > 0 ? current.prompt_order.map((item) => ({ ...item, order: [...(item.order || []), { identifier, enabled: true }] })) : [{ character_id: 100000, order: [{ identifier, enabled: true }] }]
          return { ...current, prompts: [...(current.prompts || []), prompt], prompt_order: order }
        })
      }
      const removePrompt = (index) => {
        const identifier = prompts[index]?.identifier
        setDraft((current) => ({
          ...current,
          prompts: (current.prompts || []).filter((_, promptIndex) => promptIndex !== index),
          prompt_order: (current.prompt_order || []).map((item) => ({ ...item, order: (item.order || []).filter((entry) => entry.identifier !== identifier) })),
        }))
      }
      const save = () => {
        let sampler
        try { sampler = advanced.trim() === '' ? {} : JSON.parse(advanced) } catch { setError(t('panel.presets.invalidJson')); return }
        if (!sampler || typeof sampler !== 'object' || Array.isArray(sampler)) { setError(t('panel.presets.invalidJson')); return }
        if (chatPreset && prompts.some((prompt) => !String(prompt.identifier || '').trim() || prompts.filter((candidate) => candidate.identifier === prompt.identifier).length > 1)) {
          setError(t('panel.presets.identifierInvalid'))
          return
        }
        setSaving(true)
        setError('')
        const nextData = chatPreset ? { ...sampler, prompts: draft.prompts || [], prompt_order: draft.prompt_order || [] } : sampler
        void Promise.resolve(onSave(nextData, presetName.trim() || name))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !presetName.trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('p', { className: 'dt-hint' }, t('panel.presets.editHint')),
        h('div', { className: 'dt-editor-grid' }, h(EditorField, { label: t('panel.rename'), value: presetName, onChange: setPresetName })),
        chatPreset ? h('div', { className: 'dt-editor-section-title' },
          h('strong', null, t('panel.presets.prompts')),
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: addPrompt }, t('panel.presets.addPrompt'))) : null,
        chatPreset ? h('div', { className: 'dt-editor-entries' }, prompts.map((prompt, index) => h('section', { key: `${prompt.identifier || 'prompt'}-${index}`, className: 'dt-editor-entry' },
          h('div', { className: 'dt-editor-entry-head' }, h('strong', null, prompt.name || prompt.identifier || `#${index + 1}`), h(Button, { size: 'sm', variant: 'ghost', icon: h(IconTrashOutline16), 'aria-label': t('panel.presets.removePrompt'), title: t('panel.presets.removePrompt'), onClick: () => removePrompt(index) })),
          h('div', { className: 'dt-editor-grid' },
            h(EditorField, { label: t('panel.presets.promptName'), value: prompt.name, onChange: (value) => setPrompt(index, 'name', value) }),
            h(EditorField, { label: t('panel.presets.identifier'), value: prompt.identifier, onChange: (value) => setPrompt(index, 'identifier', value) }),
            h('label', { className: 'dt-editor-field' }, h('span', { className: 'dt-label' }, t('panel.presets.role')), h('select', { value: prompt.role || 'system', onChange: (event) => setPrompt(index, 'role', event.target.value) }, h('option', { value: 'system' }, 'system'), h('option', { value: 'user' }, 'user'), h('option', { value: 'assistant' }, 'assistant'))),
            h(EditorField, { label: t('panel.presets.content'), value: prompt.content, onChange: (value) => setPrompt(index, 'content', value), multiline: true, className: 'dt-editor-wide' }),
            h('div', { className: 'dt-editor-toggles dt-editor-wide' },
              h(ToggleField, { label: t('panel.presets.marker'), checked: prompt.marker === true, onChange: (value) => setPrompt(index, 'marker', value) }),
              h(ToggleField, { label: t('panel.presets.enabled'), checked: prompt.system_prompt !== false, onChange: (value) => setPrompt(index, 'system_prompt', value) })))))) : null,
        h(EditorField, { label: t('panel.presets.sampler'), value: advanced, onChange: setAdvanced, multiline: true, className: 'dt-editor-wide dt-editor-json' }),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PanelPresets() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [editing, setEditing] = useState('')
      const [creating, setCreating] = useState(false)
      const [presets, setPresets] = useState({})
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const kinds = state.bootstrap.presetKinds || {}
      const editPreset = (name) => {
        setEditing(editing === name ? '' : name)
        if (!(name in presets)) {
          setPresets((current) => ({ ...current, [name]: null }))
          void fetchPreset(name).then((data) => setPresets((current) => ({ ...current, [name]: data })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, data, nextName) => savePreset(name, data, nextName).then((saved) => {
        const target = nextName || name
        setPresets((current) => {
          const next = { ...current, [target]: saved }
          if (target !== name) delete next[name]
          return next
        })
        setEditing('')
      })
      // 手动新建走与编辑同一条 PUT preset 路径（oldName === 新名，putPreset 落盘
      // 即建预设）；重名覆盖语义与导入一致，面板侧先拦同名（大小写不敏感）。
      // detectPresetKind 要求 prompts 与 prompt_order 同时为数组才认定为
      // chat-completion，空白模板两者都带上。
      const createPreset = (data, name) => {
        const target = String(name || '').trim()
        if (target === '') return Promise.reject(new Error(t('panel.rename')))
        const normalized = target.toLowerCase()
        if (state.bootstrap.presets.some((existing) => existing.toLowerCase() === normalized)) {
          return Promise.reject(new Error(t('panel.presets.duplicate', { name: target })))
        }
        return savePreset(target, data, target)
          .then((saved) => {
            setPresets((current) => ({ ...current, [target]: saved }))
            setCreating(false)
            setEditing(target)
            return saved
          })
          .catch((cause) => {
            throw new Error(t('panel.presets.createFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'preset', label: t('settings.importPreset'), accept: '.json,application/json' }),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => { setEditing(''); setCreating(true) } }, `+ ${t('panel.presets.new')}`))),
        // 预设生效范围（preset-mount.ts）：AgentTavern 恒投影；工作台/小说按
        // 这两个开关接入（默认关），翻转经 state 路由写穿投影缓存。
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.presets.scope')),
          h('p', { className: 'dt-hint' }, t('panel.presets.scopeHint')),
          h('div', { className: 'dt-imports' },
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: state.bootstrap.state.cardWorkbenchPresetEnabled === true,
                onChange: (event) => run(patchState({ cardWorkbenchPresetEnabled: event.target.checked })),
              }),
              h('span', null, t('panel.presets.workbenchToggle'))),
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: state.bootstrap.state.agentNovelPresetEnabled === true,
                onChange: (event) => run(patchState({ agentNovelPresetEnabled: event.target.checked })),
              }),
              h('span', null, t('panel.presets.novelToggle'))))),
        h('section', { className: 'dt-settings-band' },
          state.bootstrap.presets.length === 0 && !creating
            ? h('p', { className: 'dt-muted' }, t('panel.presets.empty'))
            : h('div', { className: 'dt-preset-list' }, state.bootstrap.presets.map((name) => h('div', { key: name, className: 'dt-preset-row' },
              h('strong', { className: 'dt-preset-name' }, name),
              h(Pill, null, kinds[name] || 'preset'),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editPreset(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconDownloadOutline16), 'aria-label': t('panel.exportJson'), title: t('panel.exportJson'), onClick: () => downloadAsset(`export/preset/${encodeURIComponent(name)}`, `${name}.json`) }),
              state.bootstrap.state.activePreset === name
                ? h(Pill, { active: true }, t('panel.characters.active'))
                : h(Button, { size: 'sm', variant: 'outline', onClick: () => run(patchState({ activePreset: name })) }, t('panel.presets.setActive')),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                'aria-label': t('panel.presets.delete', { name }),
                title: t('panel.presets.delete', { name }),
                onClick: () => {
                  if (window.confirm(t('panel.presets.deleteConfirm', { name }))) run(deletePresetAsset(name))
                },
              }),
            editing === name ? h('div', { className: 'dt-preset-editor-wrap' }, presets[name] ? h(PresetEditor, { name, kind: kinds[name], data: presets[name], onSave: (data, nextName) => save(name, data, nextName), onCancel: () => setEditing('') }) : h('p', { className: 'dt-muted' }, t('nav.loading'))) : null)))),
        creating
          ? h('section', { className: 'dt-settings-band' },
              h('h3', null, t('panel.presets.creating')),
              h('p', { className: 'dt-hint' }, t('panel.presets.createEditorHint')),
              h(PresetEditor, { name: '', kind: 'chat-completion', data: BLANK_PRESET, onSave: createPreset, onCancel: () => setCreating(false) }))
          : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }
