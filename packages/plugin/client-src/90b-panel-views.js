    // Read-only asset viewers (2026-11-01 user request): viewing a character
    // card, world book or preset opens the same dialog shell as editing, so a
    // read-only pane can never push the asset list around. Each viewer keeps a
    // single "Edit" action that hands the already-loaded asset to its editor.
    function AssetViewFooter({ onClose, onEdit }) {
      const t = useTranslate()
      return h('div', { className: 'dt-asset-actions' },
        h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('panel.closeDialog')),
        h(Button, { size: 'sm', variant: 'primary', icon: h(IconEditOutline16), onClick: onEdit }, t('panel.edit')))
    }

    function AssetViewField({ label, text }) {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') return null
      return h('section', { className: 'dt-asset-field' },
        h('h4', null, label),
        h('div', { className: 'dt-asset-copy' }, h(MarkdownText, { text: value })))
    }

    function loreKeys(entry) {
      const primary = Array.isArray(entry.key) ? entry.key : []
      const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : []
      return [...primary, ...secondary].filter((value) => value !== '').join(', ')
    }

    function CharacterCardView({ name, card, active, onClose, onEdit }) {
      const t = useTranslate()
      const data = card?.data || {}
      const displayName = String(data.name || name)
      const summary = typeof data.extensions?.agentTavern?.identitySummary === 'string'
        ? data.extensions.agentTavern.identitySummary
        : ''
      const tags = Array.isArray(data.tags)
        ? data.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        : []
      const greetings = Array.isArray(data.alternateGreetings)
        ? data.alternateGreetings.filter((greeting) => typeof greeting === 'string' && greeting.trim() !== '')
        : []
      return h(EditorDialog, {
        title: t('panel.characters.viewTitle', { name: displayName }),
        onClose,
        closeLabel: t('panel.closeDialog'),
        className: 'dt-asset-modal',
        footer: h(AssetViewFooter, { onClose, onEdit }),
      },
      !card
        ? h('p', { className: 'dt-muted' }, t('nav.loading'))
        : h('div', { className: 'dt-asset-view' },
          h('div', { className: 'dt-asset-head' },
            h('img', { src: `${API}/avatar/${encodeURIComponent(name)}`, alt: '' }),
            h('div', { className: 'dt-asset-head-copy' },
              h('div', { className: 'dt-asset-title-row' },
                h('strong', null, displayName),
                active ? h(Pill, { active: true }, t('panel.characters.active')) : null),
              data.nickname ? h('span', { className: 'dt-asset-meta' }, data.nickname) : null,
              data.creator ? h('span', { className: 'dt-asset-meta' }, t('panel.characters.creator', { name: data.creator })) : null,
              data.characterVersion
                ? h('span', { className: 'dt-asset-meta' }, t('panel.characters.version', { version: data.characterVersion }))
                : null)),
          tags.length > 0
            ? h('div', { className: 'dt-asset-tags' }, tags.map((tag) => h(Pill, { key: tag }, tag)))
            : null,
          h('p', { className: 'dt-hint' }, t('panel.characters.viewHint')),
          h(AssetViewField, { label: t('panel.characters.identitySummary'), text: summary }),
          h(AssetViewField, { label: t('panel.characters.description'), text: data.description }),
          h(AssetViewField, { label: t('panel.characters.personality'), text: data.personality }),
          h(AssetViewField, { label: t('panel.characters.scenario'), text: data.scenario }),
          h(AssetViewField, { label: t('panel.characters.firstMes'), text: data.firstMes }),
          h(AssetViewField, { label: t('panel.characters.mesExample'), text: data.mesExample }),
          h(AssetViewField, { label: t('panel.characters.systemPrompt'), text: data.systemPrompt }),
          h(AssetViewField, { label: t('panel.characters.postHistory'), text: data.postHistoryInstructions }),
          h(AssetViewField, { label: t('panel.characters.creatorNotes'), text: data.creatorNotes }),
          greetings.length > 0
            ? h('section', { className: 'dt-asset-field' },
              h('h4', null, t('panel.characters.alternateGreetingsLabel')),
              h('div', { className: 'dt-asset-list' }, greetings.map((greeting, index) => h('div', {
                key: `${index}:${greeting.slice(0, 24)}`,
                className: 'dt-asset-copy dt-asset-greeting',
              }, h(MarkdownText, { text: greeting })))))
            : null))
    }

    function WorldBookView({ name, book, onClose, onEdit }) {
      const t = useTranslate()
      const [filter, setFilter] = useState('')
      const entries = Array.isArray(book?.entries) ? book.entries : []
      const query = filter.trim().toLowerCase()
      const visibleEntries = query === ''
        ? entries
        : entries.filter((entry) => `${entry.comment}\n${entry.content}\n${loreKeys(entry)}`.toLowerCase().includes(query))
      return h(EditorDialog, {
        title: t('panel.worlds.viewTitle', { name }),
        onClose,
        closeLabel: t('panel.closeDialog'),
        className: 'dt-asset-modal',
        footer: h(AssetViewFooter, { onClose, onEdit }),
      },
      !book
        ? h('p', { className: 'dt-muted' }, t('nav.loading'))
        : h('div', { className: 'dt-asset-view' },
          h('p', { className: 'dt-hint' }, t('panel.worlds.viewHint')),
          h('div', { className: 'dt-asset-stat-row' },
            h('span', null, t('panel.worlds.entries', { count: entries.length }))),
          entries.length > 0
            ? h('div', { className: 'dt-filter-row' },
              h(Input, {
                icon: h(IconSearchOutline16),
                placeholder: t('panel.worlds.search'),
                'aria-label': t('panel.worlds.search'),
                value: filter,
                onChange: (event) => setFilter(event.target.value),
              }))
            : null,
          entries.length === 0
            ? h('p', { className: 'dt-muted' }, t('panel.worlds.empty'))
            : visibleEntries.length === 0
              ? h('p', { className: 'dt-muted' }, t('panel.worlds.noEntries'))
              : h('div', { className: 'dt-entry-list' }, visibleEntries.map((entry, index) => h('div', {
              key: entry.uid ?? index,
              className: `dt-entry ${entry.disable ? 'dt-entry-off' : ''}`,
            },
            h('div', { className: 'dt-entry-head' },
              h('div', { className: 'dt-asset-entry-title' },
                h('strong', null, entry.comment || `#${entry.uid ?? index + 1}`),
                entry.constant ? h(Pill, null, t('panel.worlds.constant')) : null,
                entry.disable ? h(Pill, null, t('panel.worlds.disabled')) : null),
              h('span', { className: 'dt-asset-entry-meta' },
                `${t('panel.worlds.order')} ${Number(entry.order) || 0} · ${t('panel.worlds.depth')} ${Number(entry.depth) || 0}`),
              h('span', { className: 'dt-entry-keys' }, t('panel.worlds.keys', { keys: loreKeys(entry) }))),
            h('div', { className: 'dt-entry-content' }, entry.content))))))
    }

    function PresetView({ name, kind, data, onClose, onEdit }) {
      const t = useTranslate()
      const chatPreset = kind === 'chat-completion' || Array.isArray(data?.prompts)
      const prompts = chatPreset && Array.isArray(data?.prompts) ? data.prompts : []
      const sampler = chatPreset
        ? Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order'))
        : (data || {})
      const samplerKeys = Object.keys(sampler)
      return h(EditorDialog, {
        title: t('panel.presets.viewTitle', { name }),
        onClose,
        closeLabel: t('panel.closeDialog'),
        className: 'dt-asset-modal',
        footer: h(AssetViewFooter, { onClose, onEdit }),
      },
      !data
        ? h('p', { className: 'dt-muted' }, t('nav.loading'))
        : h('div', { className: 'dt-asset-view' },
          h('div', { className: 'dt-asset-title-row' },
            h('strong', null, name),
            h(Pill, null, kind || 'preset')),
          h('p', { className: 'dt-hint' }, t('panel.presets.viewHint')),
          chatPreset
            ? h('section', { className: 'dt-asset-field' },
              h('h4', null, t('panel.presets.prompts')),
              prompts.length === 0
                ? h('p', { className: 'dt-muted' }, t('panel.presets.noPrompts'))
                : h('div', { className: 'dt-asset-list' }, prompts.map((prompt, index) => h('article', {
                  key: `${prompt.identifier || 'prompt'}-${index}`,
                  className: 'dt-asset-prompt',
                },
                h('div', { className: 'dt-asset-prompt-head' },
                  h('strong', null, prompt.name || prompt.identifier || `#${index + 1}`),
                  h('span', { className: 'dt-asset-prompt-id' }, prompt.identifier || ''),
                  h('span', { className: 'dt-asset-prompt-role' }, prompt.role || 'system'),
                  prompt.marker === true ? h(Pill, null, t('panel.presets.marker')) : null,
                  prompt.system_prompt === false ? h(Pill, null, t('panel.presets.disabled')) : null),
                typeof prompt.content === 'string' && prompt.content.trim() !== ''
                  ? h('div', { className: 'dt-asset-copy' }, h(MarkdownText, { text: prompt.content }))
                  : null))))
            : null,
          h('section', { className: 'dt-asset-field' },
            h('h4', null, t('panel.presets.sampler')),
            samplerKeys.length === 0
              ? h('p', { className: 'dt-muted' }, t('panel.presets.samplerEmpty'))
              : h('pre', { className: 'dt-asset-json' }, JSON.stringify(sampler, null, 2)))))
    }
