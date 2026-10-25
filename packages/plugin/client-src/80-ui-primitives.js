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

    function PersonaEditor({ persona, existingNames, onSave, onCancel }) {
      const t = useTranslate()
      const editing = persona !== null
      const [name, setName] = useState(editing ? String(persona.name || '') : '')
      const [description, setDescription] = useState(editing ? String(persona.description || '') : '')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const baselineDescription = editing ? String(persona.description || '') : ''
      const dirty = editing
        ? description !== baselineDescription
        : name.trim() !== '' || description !== ''
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      const save = () => {
        const trimmed = name.trim()
        if (trimmed === '') { setError(t('settings.personaNameRequired')); return }
        if (!editing && existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
          setError(t('settings.personaDuplicate', { name: trimmed }))
          return
        }
        setSaving(true)
        setError('')
        void Promise.resolve(onSave(editing ? { name: persona.name, description } : { name: trimmed, description }))
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
          error ? h('p', { className: 'dt-error' }, error) : null))
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
            onSave: ({ name: nextName, description }) => (editor.persona === null
              ? createPersona(nextName, description)
              : savePersona(editor.persona.name, description)).then(() => setEditor(null)),
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
