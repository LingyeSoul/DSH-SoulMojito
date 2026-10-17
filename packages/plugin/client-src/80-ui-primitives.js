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

    function PersonaBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const personas = state.bootstrap.personas || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      // The panel header already names the section; the band starts with the
      // action row so the content is not pushed down by a repeated title.
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-band-actions' },
          h(Button, {
            size: 'sm',
            variant: 'primary',
            icon: h(IconPlusOutline16),
            onClick: () => {
              const name = window.prompt(t('settings.personaNamePrompt'), '')
              if (name === null || name.trim() === '') return
              run(createPersona(name.trim(), ''))
            },
          }, t('settings.personaNew')),
          h(UploadButton, { kind: 'persona', label: t('settings.personaImport'), accept: '.png,image/png' })),
        personas.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.personaEmpty')) : h('div', { className: 'dt-persona-list' },
          personas.map((persona) => {
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
                  onClick: () => {
                    const next = window.prompt(t('settings.personaDescPrompt'), persona.description)
                    if (next === null) return
                    run(savePersona(persona.name, next))
                  },
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
