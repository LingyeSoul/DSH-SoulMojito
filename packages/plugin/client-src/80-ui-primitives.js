    function SettingSelect({ label, value, options, empty, onChange }) {
      return h('label', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, label),
        h('select', { value: value || '', onChange: (event) => onChange(event.target.value || null) },
          ...(empty === undefined ? [] : [h('option', { key: '', value: '' }, empty)]),
          options.map((option) => typeof option === 'string'
            ? h('option', { key: option, value: option }, option)
            // {value,label} 形态：记忆检索 provider/pooling 这类「值稳定、文案要
            // 走 i18n」的下拉（字符串形态不受影响，既有调用面零改动）。
            : h('option', { key: option.value, value: option.value }, option.label))))
    }

    function UploadButton({ kind, label, accept }) {
      const t = useTranslate()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return h('label', { className: 'dt-upload', title: t('settings.importTitle', { name: label }) },
        busy ? t('settings.importing') : label,
        h('input', {
          type: 'file',
          accept,
          disabled: busy,
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            setBusy(true)
            setError('')
            void importAsset(kind, file).catch((cause) => setError(cause.message)).finally(() => setBusy(false))
          },
        }),
        error ? h('span', { className: 'dt-upload-error', title: error }, '!') : null)
    }

    // persona 注入位置（服务端 generation/pipeline.ts 的读取口径）：0=提示词内、
    // 4=对话内指定深度（配 depth/role）、2/3=Author's Note 顶/底、9=不注入。
    const PERSONA_POSITIONS = [
      { value: 0, key: 'settings.personaPositionInPrompt' },
      { value: 4, key: 'settings.personaPositionAtDepth' },
      { value: 2, key: 'settings.personaPositionTopAn' },
      { value: 3, key: 'settings.personaPositionBottomAn' },
      { value: 9, key: 'settings.personaPositionNone' },
    ]
    const PERSONA_ROLES = [
      { value: 0, key: 'settings.personaRoleSystem' },
      { value: 1, key: 'settings.personaRoleUser' },
      { value: 2, key: 'settings.personaRoleAssistant' },
    ]

    function PersonaEditor({ persona, existingNames, onSave, onCancel }) {
      const t = useTranslate()
      const editing = persona !== null
      const [name, setName] = useState(editing ? String(persona.name || '') : '')
      const [description, setDescription] = useState(editing ? String(persona.description || '') : '')
      const [position, setPosition] = useState(editing && typeof persona.position === 'number' ? persona.position : 0)
      const [depth, setDepth] = useState(editing && typeof persona.depth === 'number' ? persona.depth : 4)
      const [role, setRole] = useState(editing && typeof persona.role === 'number' ? persona.role : 0)
      // 头像只在用户选了文件时随保存一起提交（PNG base64，服务端校验魔数）。
      const [avatarPng, setAvatarPng] = useState('')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const baseline = editing
        ? {
            description: String(persona.description || ''),
            position: typeof persona.position === 'number' ? persona.position : 0,
            depth: typeof persona.depth === 'number' ? persona.depth : 4,
            role: typeof persona.role === 'number' ? persona.role : 0,
          }
        : null
      const dirty = editing
        ? description !== baseline.description || position !== baseline.position
          || depth !== baseline.depth || role !== baseline.role || avatarPng !== ''
        : name.trim() !== '' || description !== '' || avatarPng !== ''
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      const pickAvatar = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        if (file.type !== 'image/png') { setError(t('settings.personaAvatarPngOnly')); return }
        const reader = new FileReader()
        reader.onload = () => {
          const data = String(reader.result || '')
          const separator = data.indexOf(',')
          const base64 = separator >= 0 ? data.slice(separator + 1) : ''
          if (base64 === '') { setError(t('settings.personaAvatarPngOnly')); return }
          setError('')
          setAvatarPng(base64)
        }
        reader.onerror = () => setError(t('settings.personaAvatarPngOnly'))
        reader.readAsDataURL(file)
      }
      const save = () => {
        const trimmed = name.trim()
        if (trimmed === '') { setError(t('settings.personaNameRequired')); return }
        if (!editing && existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
          setError(t('settings.personaDuplicate', { name: trimmed }))
          return
        }
        setSaving(true)
        setError('')
        const payload = {
          name: editing ? persona.name : trimmed,
          description,
          position,
          depth,
          role,
          ...(avatarPng === '' ? {} : { pngBase64: avatarPng }),
        }
        void Promise.resolve(onSave(payload))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const title = editing
        ? t('settings.personaEditTitle', { name: persona.name })
        : t('settings.personaNew')
      const toolbar = h('div', { className: 'dt-editor-toolbar' },
        h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
        h('div', { className: 'dt-editor-actions' },
          h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: saving || name.trim() === '', onClick: save }, saving ? t('settings.importing') : t('panel.save'))))
      return h(EditorDialog, { title, onClose: cancel, closeLabel: t('panel.close'), footer: toolbar, className: 'dt-persona-editor' },
        h('div', { className: 'dt-editor' },
          h(EditorField, {
            label: t('settings.personaNamePrompt'),
            value: name,
            onChange: setName,
            disabled: editing,
            hint: editing ? t('settings.personaNameFixed') : undefined,
          }),
          h(EditorField, {
            label: t('settings.personaDescPrompt'),
            value: description,
            onChange: setDescription,
            multiline: true,
            className: 'dt-editor-wide',
          }),
          // 注入位置（契约 2026-11-12 §2.11）：位置/深度/角色此前只有数据面，
          // 面板改不了，等于 persona 永远落在「提示词内」。
          h('label', { className: 'dt-editor-field' },
            h('span', { className: 'dt-label' }, t('settings.personaPosition')),
            h('select', {
              value: position,
              onChange: (event) => setPosition(Number(event.target.value)),
            }, PERSONA_POSITIONS.map((option) => h('option', { key: option.value, value: option.value }, t(option.key))))),
          position === 4
            ? h(React.Fragment, null,
              h(EditorField, {
                label: t('settings.personaDepth'),
                value: depth,
                type: 'number',
                min: 0,
                onChange: (value) => setDepth(Math.max(0, Math.round(Number(value) || 0))),
              }),
              h('label', { className: 'dt-editor-field' },
                h('span', { className: 'dt-label' }, t('settings.personaRole')),
                h('select', {
                  value: role,
                  onChange: (event) => setRole(Number(event.target.value)),
                }, PERSONA_ROLES.map((option) => h('option', { key: option.value, value: option.value }, t(option.key))))))
            : null,
          h('div', { className: 'dt-editor-field' },
            h('span', { className: 'dt-label' }, t('settings.personaAvatar')),
            h('label', { className: 'dt-upload', title: t('settings.personaAvatarPick') },
              avatarPng !== '' ? t('settings.personaAvatarPending') : t('settings.personaAvatarPick'),
              h('input', { type: 'file', accept: 'image/png', onChange: pickAvatar })),
            h('span', { className: 'dt-hint' },
              editing && persona.hasAvatar === true ? t('settings.personaAvatarCurrent') : t('settings.personaAvatarHint'))),
          error ? h('p', { className: 'dt-error' }, error) : null))
    }

    // persona 完整写路径（契约 2026-11-12 §2.11）：create/save 两个 helper 只带
    // name+description，位置/深度/角色/头像写不进去。新建走 import/persona
    // （与面板导入同一条落库路径），需要头像时再补一次 PUT——导入会把描述重置成
    // PNG 内嵌卡文本，所以头像不能借导入顺带写。
    async function createPersonaRecord({ name, description, position, depth, role, pngBase64 }) {
      const result = await api('import/persona', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description, position, depth, role }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'persona', name })
      if (typeof pngBase64 === 'string' && pngBase64 !== '') {
        return savePersonaRecord({ name: result.persona?.name || name, description, position, depth, role, pngBase64 })
      }
      return result.persona
    }

    async function savePersonaRecord({ name, description, position, depth, role, pngBase64 }) {
      const result = await api('persona', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name,
          description,
          position,
          depth,
          role,
          ...(typeof pngBase64 === 'string' && pngBase64 !== '' ? { pngBase64 } : {}),
        }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'persona', name })
      return result.persona
    }

    function PersonaBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [personaFilter, setPersonaFilter] = useState('')
      const [editor, setEditor] = useState(null)
      const personas = state.bootstrap.personas || []
      // 名称/描述过滤（2026-10-21 分页 UX）：与角色/预设/剧本/正则清单同款模式。
      const personaQuery = personaFilter.trim().toLowerCase()
      const visiblePersonas = personaQuery === ''
        ? personas
        : personas.filter((persona) => persona.name.toLowerCase().includes(personaQuery)
          || String(persona.description || '').toLowerCase().includes(personaQuery))
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      // The panel header already names the section; the band starts with the
      // action row so the content is not pushed down by a repeated title.
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-band-actions' },
          h(Button, {
            size: 'sm',
            variant: 'primary',
            icon: h(IconPlusOutline16),
            onClick: () => setEditor({ persona: null }),
          }, t('settings.personaNew')),
          h(UploadButton, { kind: 'persona', label: t('settings.personaImport'), accept: '.png,image/png' })),
        personas.length > 0 ? h('div', { className: 'dt-filter-row' },
          h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.filterPlaceholder'), 'aria-label': t('panel.filterPlaceholder'), value: personaFilter, onChange: (event) => setPersonaFilter(event.target.value) })) : null,
        personas.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.personaEmpty')) : visiblePersonas.length === 0
          ? h('p', { className: 'dt-muted' }, t('panel.filterEmpty'))
          : h('div', { className: 'dt-persona-list' },
            visiblePersonas.map((persona) => {
            const description = String(persona.description || '').trim()
            return h('div', { key: persona.name, className: 'dt-persona-row' },
              h('img', {
                className: 'dt-persona-avatar',
                src: `${API}/persona-avatar/${encodeURIComponent(persona.name)}`,
                alt: '',
                onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
              }),
              h('div', { className: 'dt-persona-copy' },
                h('strong', null, persona.name),
                description === '' ? null : h('span', { title: description }, description.slice(0, 140))),
              h('div', { className: 'dt-persona-actions' },
                h('button', {
                  type: 'button',
                  title: t('settings.personaEdit', { name: persona.name }),
                  'aria-label': t('settings.personaEdit', { name: persona.name }),
                  onClick: () => setEditor({ persona }),
                }, h(IconEditOutline16)),
                h('button', {
                  type: 'button',
                  title: t('settings.personaDelete', { name: persona.name }),
                  'aria-label': t('settings.personaDelete', { name: persona.name }),
                  onClick: () => {
                    if (window.confirm(t('settings.personaDeleteConfirm', { name: persona.name }))) run(deletePersona(persona.name))
                  },
                }, h(IconTrashOutline16))))
          })),
        editor
          ? h(PersonaEditor, {
            persona: editor.persona,
            existingNames: personas.map((persona) => persona.name),
            onSave: (payload) => (editor.persona === null
              ? createPersonaRecord(payload)
              : savePersonaRecord(payload)).then(() => setEditor(null)),
            onCancel: () => setEditor(null),
          })
          : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function GroupBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [creating, setCreating] = useState(null)
      const [selected, setSelected] = useState([])
      const characters = state.bootstrap.characters
      const groups = state.bootstrap.groups || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            onClick: () => {
              const name = window.prompt(t('settings.groupNamePrompt'), '')
              if (name === null || name.trim() === '') return
              setCreating(name.trim())
              setSelected([])
            },
          }, t('settings.groupNew'))),
        creating !== null ? h('div', { className: 'dt-group-create' },
          h('strong', null, `${t('settings.groupPickMembers')} — ${creating}`),
          h('div', { className: 'dt-check-grid' }, characters.map((name) => h('label', { key: name },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(name),
              onChange: (event) => {
                setSelected(event.target.checked ? [...selected, name] : selected.filter((item) => item !== name))
              },
            }),
            h('span', null, name))),
          characters.length === 0 ? h('span', { className: 'dt-muted' }, t('nav.noCharacters')) : null),
          h('div', { className: 'dt-imports' },
            h('button', {
              type: 'button',
              className: 'dt-upload',
              disabled: selected.length === 0,
              onClick: () => {
                const name = creating
                setCreating(null)
                run(createGroup(name, selected, 1))
              },
            }, t('settings.groupCreate')),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => setCreating(null) }, t('settings.groupCancel')))) : null,
        groups.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.groupsEmpty')) : h('div', { className: 'dt-group-list' },
          groups.map((group) => h('div', { key: group.name, className: 'dt-group-manage' },
            h('div', { className: 'dt-group-title' },
              h('strong', null, `${group.name} (${group.members.length})`),
              h('span', null, t('settings.groupMembers')),
              h('select', {
                value: group.activationStrategy,
                'aria-label': t('settings.groupStrategy'),
                onChange: (event) => run(updateGroup({ name: group.name, activationStrategy: Number(event.target.value) })),
              },
              // 0 = MANUAL（契约 2026-11-12 §2.9）：导入时不再被改写成 1，
              // 面板必须能把它设回去。
              h('option', { value: 0 }, t('settings.groupManual')),
              h('option', { value: 1 }, t('settings.groupNatural')),
              h('option', { value: 2 }, t('settings.groupList'))),
              h('button', {
                type: 'button',
                title: t('settings.groupDelete', { name: group.name }),
                onClick: () => {
                  if (window.confirm(t('settings.groupDeleteConfirm', { name: group.name }))) run(deleteGroup(group.name))
                },
              }, h(IconTrashOutline16))),
            h('div', { className: 'dt-group-members' }, group.members.map((member) => {
              const disabled = group.disabledMembers.includes(member)
              return h('span', {
                key: member,
                className: `dt-member-chip ${disabled ? 'dt-member-chip-off' : ''}`,
                title: t('settings.groupToggleMember', { member }),
                onClick: () => run(updateGroup({
                  name: group.name,
                  disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                })),
              },
              h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
              h('span', null, member),
              h('button', {
                type: 'button',
                title: t('settings.groupToggleMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({
                    name: group.name,
                    disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                  }))
                },
              }, disabled ? '○' : '●'),
              h('button', {
                type: 'button',
                title: t('settings.groupRemoveMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({ name: group.name, members: group.members.filter((item) => item !== member) }))
                },
              }, '×'))
            }))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }


    /* ---------------- 快速回复 / 聊天注记 / 世界书设置（契约 2026-11-12） ---------------- */

    // 快速回复集合的编辑草稿：`commandsText` 是 textarea 的原文（逐行脚本），
    // 保存时按行切开——行内空白保留，纯空行由服务端丢弃。
    function quickReplyDraftOf(set) {
      return {
        id: typeof set?.id === 'string' ? set.id : '',
        name: typeof set?.name === 'string' ? set.name : '',
        enabled: set?.enabled === true,
        isGlobal: set?.isGlobal === true,
        automationId: typeof set?.automationId === 'string' ? set.automationId : '',
        commandsText: Array.isArray(set?.commands) ? set.commands.join('\n') : '',
      }
    }

    /**
     * 快速回复分区（契约 2026-11-12 §2.6）：集合 CRUD + composer 按钮行总开关。
     * 保存是全量替换（PUT quick-replies），草稿在本地维护、点保存才落盘；服务端
     * 拒绝重名/重 id，错误原样显示在这一段。
     */
    function QuickRepliesBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const remote = Array.isArray(state.bootstrap.state.quickReplies) ? state.bootstrap.state.quickReplies : []
      const remoteEnabled = state.bootstrap.state.quickRepliesEnabled !== false
      const [enabled, setEnabled] = useState(remoteEnabled)
      const [draft, setDraft] = useState(() => remote.map(quickReplyDraftOf))
      const [baseline, setBaseline] = useState(() => JSON.stringify({ enabled: remoteEnabled, sets: remote.map(quickReplyDraftOf) }))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const serialize = (sets) => sets.map((set) => ({
        ...(set.id === '' ? {} : { id: set.id }),
        name: String(set.name || '').trim(),
        enabled: set.enabled === true,
        isGlobal: set.isGlobal === true,
        ...(String(set.automationId || '').trim() === '' ? {} : { automationId: String(set.automationId).trim() }),
        commands: String(set.commandsText || '').split('\n'),
      }))
      const dirty = JSON.stringify({ enabled, sets: draft }) !== baseline
      const patchSet = (index, patch) => setDraft((current) => current.map((set, at) => at === index ? { ...set, ...patch } : set))
      const addSet = () => setDraft((current) => [...current, {
        id: '', name: t('panel.quickReplies.newName'), enabled: true, isGlobal: true, automationId: '', commandsText: '',
      }])
      const removeSet = (index) => setDraft((current) => current.filter((_, at) => at !== index))
      const reload = () => {
        const sets = (Array.isArray(state.bootstrap.state.quickReplies) ? state.bootstrap.state.quickReplies : []).map(quickReplyDraftOf)
        const nextEnabled = state.bootstrap.state.quickRepliesEnabled !== false
        setEnabled(nextEnabled)
        setDraft(sets)
        setBaseline(JSON.stringify({ enabled: nextEnabled, sets }))
        setError('')
        setNotice('')
      }
      const save = () => {
        setSaving(true)
        setError('')
        setNotice('')
        void api('quick-replies', {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ quickReplies: serialize(draft), quickRepliesEnabled: enabled }),
        })
          .then(async (result) => {
            const sets = (Array.isArray(result.quickReplies) ? result.quickReplies : []).map(quickReplyDraftOf)
            const nextEnabled = result.quickRepliesEnabled !== false
            setEnabled(nextEnabled)
            setDraft(sets)
            setBaseline(JSON.stringify({ enabled: nextEnabled, sets }))
            await refreshBootstrap()
            setNotice(t('panel.saved'))
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('panel.quickReplies.title')),
        h('p', { className: 'dt-hint' }, t('panel.quickReplies.hint')),
        // 执行面是 STscript：Agent 架构的生成走 AgentLoop，没有命令通道。按钮行
        // 在那里不渲染，原因写在这里（与 composer 同一句话）。
        h('p', { className: 'dt-hint' }, t('panel.quickReplies.archHint')),
        h('label', { className: 'dt-toggle' },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: (event) => setEnabled(event.target.checked),
          }),
          h('span', null, t('panel.quickReplies.masterToggle'))),
        h('div', { className: 'dt-band-actions' },
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), disabled: saving, onClick: addSet }, t('panel.quickReplies.add')),
          h(Button, { size: 'sm', variant: 'primary', disabled: saving || !dirty, onClick: save }, saving ? t('settings.importing') : t('panel.save')),
          h(Button, { size: 'sm', variant: 'ghost', disabled: saving || !dirty, onClick: reload }, t('panel.cancel'))),
        draft.length === 0
          ? h('p', { className: 'dt-muted' }, t('panel.quickReplies.empty'))
          : h('div', { className: 'dt-editor-entries' }, draft.map((set, index) => h('section', { key: `${set.id || set.name || 'new'}-${index}`, className: 'dt-editor-entry' },
            h('div', { className: 'dt-editor-entry-head' },
              h('strong', null, set.name || t('panel.quickReplies.newName')),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                'aria-label': t('panel.quickReplies.remove', { name: set.name }),
                title: t('panel.quickReplies.remove', { name: set.name }),
                disabled: saving,
                onClick: () => removeSet(index),
              })),
            h('div', { className: 'dt-editor-grid' },
              h(EditorField, { label: t('panel.quickReplies.name'), value: set.name, onChange: (value) => patchSet(index, { name: value }) }),
              h(EditorField, { label: t('panel.quickReplies.automationId'), value: set.automationId, onChange: (value) => patchSet(index, { automationId: value }), hint: t('panel.quickReplies.automationIdHint') }),
              h('div', { className: 'dt-editor-toggles dt-editor-wide' },
                h(ToggleField, { label: t('panel.quickReplies.enabled'), checked: set.enabled, onChange: (value) => patchSet(index, { enabled: value }) }),
                h(ToggleField, { label: t('panel.quickReplies.isGlobal'), checked: set.isGlobal, onChange: (value) => patchSet(index, { isGlobal: value }) })),
              h(EditorField, { label: t('panel.quickReplies.commands'), value: set.commandsText, onChange: (value) => patchSet(index, { commandsText: value }), multiline: true, className: 'dt-editor-wide dt-editor-json', hint: t('panel.quickReplies.commandsHint') }))))),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    /**
     * 聊天注记（契约 2026-11-12 §2.4）：Author's Note 与 Summary 写进当前聊天的
     * `chat_metadata`，走既有 `PUT chat` 的 revision CAS——生成侧只读这两项，本
     * 分区不改装配。字段形状与契约一致：`note_prompt`/`note_settings`/`summary`。
     */
    function ChatNotesBand({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionId = useCurrentSessionId(useSessions)
      const binding = sessionId ? state.bootstrap.state.sessionBindings?.[sessionId] : undefined
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const chat = binding ? state.chats[key] : null
      const revision = binding ? state.revisions[key] : undefined
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      useEffect(() => {
        if (!binding) return
        if (chat === null || chat === undefined) {
          void loadChat(binding.character, binding.chatId).catch(() => {})
        }
      }, [binding?.character, binding?.chatId, chat === null])
      const meta = chat?.header?.chat_metadata
      useEffect(() => {
        if (!chat) { setDraft(null); return }
        const settings = meta?.note_settings && typeof meta.note_settings === 'object' ? meta.note_settings : {}
        setDraft({
          notePrompt: typeof meta?.note_prompt === 'string' ? meta.note_prompt : '',
          summary: typeof meta?.summary === 'string' ? meta.summary : '',
          position: settings.position === 'at_depth' ? 'at_depth' : 'in_prompt',
          depth: typeof settings.depth === 'number' ? settings.depth : 4,
          role: settings.role === 'user' ? 'user' : settings.role === 'assistant' ? 'assistant' : 'system',
          interval: typeof settings.interval === 'number' ? settings.interval : 0,
        })
      }, [key, revision, chat === undefined])
      const setField = (patch) => setDraft((current) => ({ ...(current || {}), ...patch }))
      const save = () => {
        if (!binding || !chat || !draft) return
        setSaving(true)
        setError('')
        setNotice('')
        const nextMeta = { ...(meta || {}) }
        if (draft.notePrompt.trim() === '') {
          // 清空即删键：生成侧按「非空才注入」判定，留空串会让 state 里多出
          // 一个没有语义的键。
          delete nextMeta.note_prompt
          delete nextMeta.note_settings
        } else {
          nextMeta.note_prompt = draft.notePrompt
          nextMeta.note_settings = {
            position: draft.position,
            ...(draft.position === 'at_depth'
              ? { depth: Math.max(0, Math.round(Number(draft.depth) || 0)), role: draft.role }
              : {}),
            ...(Math.round(Number(draft.interval) || 0) > 0 ? { interval: Math.round(Number(draft.interval)) } : {}),
          }
        }
        if (draft.summary.trim() === '') delete nextMeta.summary
        else nextMeta.summary = draft.summary
        void saveChat(binding.character, binding.chatId, { ...chat, header: { ...chat.header, chat_metadata: nextMeta } })
          .then(() => setNotice(t('panel.saved')))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('panel.notes.title')),
        h('p', { className: 'dt-hint' }, t('panel.notes.hint')),
        !binding
          ? h('p', { className: 'dt-muted' }, t('panel.notes.noChat'))
          : !draft
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h(React.Fragment, null,
              h('p', { className: 'dt-hint' }, t('panel.notes.chatHint', { character: binding.character, chatId: binding.chatId })),
              h('div', { className: 'dt-editor-grid' },
                h(EditorField, {
                  label: t('panel.notes.authorNote'),
                  value: draft.notePrompt,
                  onChange: (value) => setField({ notePrompt: value }),
                  multiline: true,
                  className: 'dt-editor-wide',
                  hint: t('panel.notes.authorNoteHint'),
                }),
                h('label', { className: 'dt-editor-field' },
                  h('span', { className: 'dt-label' }, t('panel.notes.position')),
                  h('select', {
                    value: draft.position,
                    onChange: (event) => setField({ position: event.target.value === 'at_depth' ? 'at_depth' : 'in_prompt' }),
                  },
                  h('option', { value: 'in_prompt' }, t('panel.notes.positionInPrompt')),
                  h('option', { value: 'at_depth' }, t('panel.notes.positionAtDepth')))),
                draft.position === 'at_depth'
                  ? h(EditorField, {
                    label: t('panel.notes.depth'),
                    value: draft.depth,
                    type: 'number',
                    min: 0,
                    onChange: (value) => setField({ depth: Math.max(0, Math.round(Number(value) || 0)) }),
                  })
                  : null,
                draft.position === 'at_depth'
                  ? h('label', { className: 'dt-editor-field' },
                    h('span', { className: 'dt-label' }, t('panel.notes.role')),
                    h('select', {
                      value: draft.role,
                      onChange: (event) => setField({ role: event.target.value }),
                    },
                    h('option', { value: 'system' }, 'system'),
                    h('option', { value: 'user' }, 'user'),
                    h('option', { value: 'assistant' }, 'assistant')))
                  : null,
                h(EditorField, {
                  label: t('panel.notes.interval'),
                  value: draft.interval,
                  type: 'number',
                  min: 0,
                  onChange: (value) => setField({ interval: Math.max(0, Math.round(Number(value) || 0)) }),
                  hint: t('panel.notes.intervalHint'),
                }),
                h(EditorField, {
                  label: t('panel.notes.summary'),
                  value: draft.summary,
                  onChange: (value) => setField({ summary: value }),
                  multiline: true,
                  className: 'dt-editor-wide',
                  hint: t('panel.notes.summaryHint'),
                })),
              h('div', { className: 'dt-imports' },
                h(Button, { size: 'sm', variant: 'primary', disabled: saving, onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 世界书设置的数值字段定义（契约 2026-11-12 §2.8）。读取侧
    // tavern-store/src/world-settings.ts 已经合并默认并夹取，这里只负责输入面。
    const WORLD_INFO_NUMBER_FIELDS = [
      { key: 'scanDepth', label: 'panel.worlds.scanDepth', min: 0, max: 100 },
      { key: 'budgetPercent', label: 'panel.worlds.budgetPercent', min: 0, max: 100 },
      { key: 'budgetCap', label: 'panel.worlds.budgetCap', min: 0, max: 1000000 },
      { key: 'maxRecursionSteps', label: 'panel.worlds.maxRecursionSteps', min: 0, max: 100 },
      { key: 'minActivations', label: 'panel.worlds.minActivations', min: 0, max: 100 },
      { key: 'minActivationsDepthMax', label: 'panel.worlds.minActivationsDepthMax', min: 0, max: 1000 },
    ]
    const WORLD_INFO_TOGGLE_FIELDS = [
      { key: 'recursive', label: 'panel.worlds.recursive' },
      { key: 'caseSensitive', label: 'panel.worlds.caseSensitive' },
      { key: 'matchWholeWords', label: 'panel.worlds.matchWholeWords' },
      { key: 'useGroupScoring', label: 'panel.worlds.useGroupScoring' },
      { key: 'includeNames', label: 'panel.worlds.includeNames' },
    ]

    /**
     * 世界书全局设置表单（契约 2026-11-12 §2.8）：引擎实现了这些开关，但唯一
     * 调用点长期写死 recursive/scanDepth/budgetPercent——没有这张表单它们等于
     * 死代码。读 bootstrap 里已合并默认的 worldInfoSettings，保存走 PUT state
     * 的 worldInfoSettings 白名单（服务端用同一个 worldInfoSettingsOf 归一）。
     */
    function WorldInfoSettingsForm() {
      const state = useTavernStore()
      const t = useTranslate()
      const remote = state.bootstrap.state.worldInfoSettings || {}
      const remoteJson = JSON.stringify(remote)
      const [draft, setDraft] = useState(() => ({ ...remote }))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // 远端变化（保存回写、另一处修改）才重置草稿：typing 只动 draft。
      useEffect(() => { setDraft({ ...remote }) }, [remoteJson])
      const dirty = JSON.stringify(draft) !== remoteJson
      const setField = (patch) => setDraft((current) => ({ ...current, ...patch }))
      const save = () => {
        setSaving(true)
        setError('')
        setNotice('')
        void patchState({ worldInfoSettings: draft })
          .then(() => setNotice(t('panel.saved')))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const reset = () => { setDraft({ ...remote }); setError(''); setNotice('') }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('panel.worlds.settings')),
        h('p', { className: 'dt-hint' }, t('panel.worlds.settingsHint')),
        h('div', { className: 'dt-editor-grid' },
          WORLD_INFO_NUMBER_FIELDS.map((field) => h(EditorField, {
            key: field.key,
            label: t(field.label),
            value: draft[field.key] ?? 0,
            type: 'number',
            min: field.min,
            max: field.max,
            onChange: (value) => setField({ [field.key]: Math.max(field.min, Math.min(field.max, Math.round(Number(value) || 0))) }),
          })),
          h('div', { className: 'dt-editor-toggles dt-editor-wide' },
            WORLD_INFO_TOGGLE_FIELDS.map((field) => h(ToggleField, {
              key: field.key,
              label: t(field.label),
              checked: draft[field.key] === true,
              onChange: (value) => setField({ [field.key]: value }),
            })))),
        h('div', { className: 'dt-imports' },
          h(Button, { size: 'sm', variant: 'primary', disabled: saving || !dirty, onClick: save }, saving ? t('settings.importing') : t('panel.save')),
          h(Button, { size: 'sm', variant: 'ghost', disabled: saving || !dirty, onClick: reset }, t('panel.cancel'))),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 世界书条目高级字段（契约 2026-11-12 §2.11）：递归/置顶计时/组/角色/出口/
    // 自动化 id 此前只能改 advanced JSON。ST 用 null 表示「不设值、跟随全局」，
    // 所以数值输入清空必须写回 null 而不是 0。
    const WORLD_ENTRY_NUMBER_FIELDS = [
      { key: 'sticky', label: 'panel.worlds.sticky' },
      { key: 'cooldown', label: 'panel.worlds.cooldown' },
      { key: 'delay', label: 'panel.worlds.delay' },
      { key: 'delayUntilRecursion', label: 'panel.worlds.delayUntilRecursion' },
    ]
    const WORLD_ENTRY_TOGGLE_FIELDS = [
      { key: 'preventRecursion', label: 'panel.worlds.preventRecursion' },
      { key: 'excludeRecursion', label: 'panel.worlds.excludeRecursion' },
      { key: 'ignoreBudget', label: 'panel.worlds.ignoreBudget' },
      { key: 'useProbability', label: 'panel.worlds.useProbability' },
    ]
    const WORLD_ENTRY_ROLES = [
      { value: 0, key: 'settings.personaRoleSystem' },
      { value: 1, key: 'settings.personaRoleUser' },
      { value: 2, key: 'settings.personaRoleAssistant' },
    ]

    function WorldEntryAdvancedFields({ entry, onChange }) {
      const t = useTranslate()
      return h(React.Fragment, null,
        h('div', { className: 'dt-editor-toggles dt-editor-wide' },
          WORLD_ENTRY_TOGGLE_FIELDS.map((field) => h(ToggleField, {
            key: field.key,
            label: t(field.label),
            checked: entry[field.key] === true,
            onChange: (value) => onChange(field.key, value),
          }))),
        h(EditorField, { label: t('panel.worlds.group'), value: entry.group, onChange: (value) => onChange('group', value) }),
        h(EditorField, { label: t('panel.worlds.outletName'), value: entry.outletName, onChange: (value) => onChange('outletName', value) }),
        h(EditorField, {
          label: t('panel.worlds.automationId'),
          value: entry.automationId,
          onChange: (value) => onChange('automationId', value),
          hint: t('panel.worlds.automationIdHint'),
        }),
        h('label', { className: 'dt-editor-field' },
          h('span', { className: 'dt-label' }, t('panel.worlds.role')),
          h('select', {
            value: typeof entry.role === 'number' ? entry.role : 0,
            onChange: (event) => onChange('role', Number(event.target.value)),
          }, WORLD_ENTRY_ROLES.map((option) => h('option', { key: option.value, value: option.value }, t(option.key))))),
        WORLD_ENTRY_NUMBER_FIELDS.map((field) => h(EditorField, {
          key: field.key,
          label: t(field.label),
          value: entry[field.key] ?? '',
          type: 'number',
          min: 0,
          onChange: (value) => onChange(field.key, value.trim() === '' ? null : Number(value)),
        })))
    }
