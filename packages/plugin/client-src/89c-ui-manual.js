// Management-panel user manual (2026-11-18). All prose lives in the zh/en
    // locale tables; this fragment only carries section targets and i18n key
    // references so the manual follows host locale switches like every other
    // panel section. Content is data-driven to keep the component readable.
    function IconHelpOutline16({ size, className }) {
      const dimension = size ?? 16
      return h('svg', {
        width: dimension,
        height: dimension,
        className,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor' }),
      h('circle', { cx: 8, cy: 8, r: 2.1, stroke: 'currentColor' }),
      h('path', { d: 'M8 2v3.9M8 10.1V14M2 8h3.9M10.1 8H14', stroke: 'currentColor' }))
    }

    const MANUAL_TOC = [
      { id: 'start', target: 'dt-manual-start', label: 'manual.toc.start' },
      { id: 'terms', target: 'dt-manual-terms', label: 'manual.toc.terms' },
      { id: 'diff', target: 'dt-manual-diff', label: 'manual.toc.diff' },
      { id: 'features', target: 'dt-manual-features', label: 'manual.toc.features' },
      { id: 'limits', target: 'dt-manual-limits', label: 'manual.toc.limits' },
    ]

    const MANUAL_FACTS = [
      'manual.fact.assets',
      'manual.fact.architectures',
      'manual.fact.models',
    ]

    const MANUAL_STEPS = [
      { id: 'import', title: 'manual.start.import.title', body: 'manual.start.import.body', sections: ['characters'] },
      { id: 'architecture', title: 'manual.start.architecture.title', body: 'manual.start.architecture.body', sections: ['behavior', 'chats'] },
      { id: 'chat', title: 'manual.start.chat.title', body: 'manual.start.chat.body', sections: ['chats'] },
      { id: 'talk', title: 'manual.start.talk.title', body: 'manual.start.talk.body', sections: [] },
      { id: 'extend', title: 'manual.start.extend.title', body: 'manual.start.extend.body', sections: ['guides', 'notes', 'variables'] },
    ]

    const MANUAL_TERMS = [
      { id: 'dsh', name: 'manual.term.dsh.name', body: 'manual.term.dsh.body' },
      { id: 'st', name: 'manual.term.st.name', body: 'manual.term.st.body' },
      { id: 'agent', name: 'manual.term.agent.name', body: 'manual.term.agent.body' },
      { id: 'assets', name: 'manual.term.assets.name', body: 'manual.term.assets.body' },
    ]

    const MANUAL_ARCH_HEADERS = [
      'manual.arch.col.name',
      'manual.arch.col.loop',
      'manual.arch.col.fit',
      'manual.arch.col.limit',
    ]

    const MANUAL_ARCH_ROWS = [
      { id: 'agent', cells: ['manual.arch.agent.name', 'manual.arch.agent.loop', 'manual.arch.agent.fit', 'manual.arch.agent.limit'] },
      { id: 'st', cells: ['manual.arch.st.name', 'manual.arch.st.loop', 'manual.arch.st.fit', 'manual.arch.st.limit'] },
      { id: 'novel', cells: ['manual.arch.novel.name', 'manual.arch.novel.loop', 'manual.arch.novel.fit', 'manual.arch.novel.limit'] },
    ]

    const MANUAL_DIFF_HEADERS = [
      'manual.diff.col.topic',
      'manual.diff.col.st',
      'manual.diff.col.soul',
    ]

    const MANUAL_DIFF_ROWS = [
      { id: 'diff-runtime', cells: ['manual.diff.runtime.topic', 'manual.diff.runtime.st', 'manual.diff.runtime.soul'] },
      { id: 'diff-models', cells: ['manual.diff.models.topic', 'manual.diff.models.st', 'manual.diff.models.soul'] },
      { id: 'diff-loop', cells: ['manual.diff.loop.topic', 'manual.diff.loop.st', 'manual.diff.loop.soul'] },
      { id: 'diff-context', cells: ['manual.diff.context.topic', 'manual.diff.context.st', 'manual.diff.context.soul'] },
      { id: 'diff-surface', cells: ['manual.diff.surface.topic', 'manual.diff.surface.st', 'manual.diff.surface.soul'] },
      { id: 'diff-groups', cells: ['manual.diff.groups.topic', 'manual.diff.groups.st', 'manual.diff.groups.soul'] },
      { id: 'diff-extensions', cells: ['manual.diff.extensions.topic', 'manual.diff.extensions.st', 'manual.diff.extensions.soul'] },
      { id: 'diff-data', cells: ['manual.diff.data.topic', 'manual.diff.data.st', 'manual.diff.data.soul'] },
      { id: 'diff-scripts', cells: ['manual.diff.scripts.topic', 'manual.diff.scripts.st', 'manual.diff.scripts.soul'] },
    ]

    const MANUAL_FEATURE_GROUPS = [
      {
        id: 'assets',
        title: 'manual.features.group.assets',
        items: [
          { id: 'feature-characters', name: 'manual.feature.characters.name', body: 'manual.feature.characters.body', section: 'characters' },
          { id: 'feature-worlds', name: 'manual.feature.worlds.name', body: 'manual.feature.worlds.body', section: 'worlds' },
          { id: 'feature-presets', name: 'manual.feature.presets.name', body: 'manual.feature.presets.body', section: 'presets' },
          { id: 'feature-personasGroups', name: 'manual.feature.personasGroups.name', body: 'manual.feature.personasGroups.body', section: 'personas' },
          { id: 'feature-regexQuickReplies', name: 'manual.feature.regexQuickReplies.name', body: 'manual.feature.regexQuickReplies.body', section: 'regex' },
          { id: 'feature-scriptsNovels', name: 'manual.feature.scriptsNovels.name', body: 'manual.feature.scriptsNovels.body', section: 'scripts' },
          { id: 'feature-dataBank', name: 'manual.feature.dataBank.name', body: 'manual.feature.dataBank.body', section: 'dataBank' },
        ],
      },
      {
        id: 'sessions',
        title: 'manual.features.group.sessions',
        items: [
          { id: 'feature-chats', name: 'manual.feature.chats.name', body: 'manual.feature.chats.body', section: 'chats' },
          { id: 'feature-notes', name: 'manual.feature.notes.name', body: 'manual.feature.notes.body', section: 'notes' },
          { id: 'feature-guides', name: 'manual.feature.guides.name', body: 'manual.feature.guides.body', section: 'guides' },
          { id: 'feature-variables', name: 'manual.feature.variables.name', body: 'manual.feature.variables.body', section: 'variables' },
          { id: 'feature-games', name: 'manual.feature.games.name', body: 'manual.feature.games.body', section: 'games' },
          { id: 'feature-prompts', name: 'manual.feature.prompts.name', body: 'manual.feature.prompts.body', section: 'prompts' },
        ],
      },
      {
        id: 'system',
        title: 'manual.features.group.system',
        items: [
          { id: 'feature-behavior', name: 'manual.feature.behavior.name', body: 'manual.feature.behavior.body', section: 'behavior' },
          { id: 'feature-memory', name: 'manual.feature.memory.name', body: 'manual.feature.memory.body', section: 'memory' },
          { id: 'feature-workbench', name: 'manual.feature.workbench.name', body: 'manual.feature.workbench.body', section: 'workbench' },
          { id: 'feature-im', name: 'manual.feature.im.name', body: 'manual.feature.im.body', section: 'im' },
          { id: 'feature-mods', name: 'manual.feature.mods.name', body: 'manual.feature.mods.body', section: 'mods' },
          { id: 'feature-backup', name: 'manual.feature.backup.name', body: 'manual.feature.backup.body', section: 'backup' },
        ],
      },
    ]

    const MANUAL_LIMITS = [
      { id: 'limit-managed', title: 'manual.limit.managed.title', body: 'manual.limit.managed.body' },
      { id: 'limit-groups', title: 'manual.limit.groups.title', body: 'manual.limit.groups.body' },
      { id: 'limit-stscript', title: 'manual.limit.stscript.title', body: 'manual.limit.stscript.body' },
      { id: 'limit-template', title: 'manual.limit.template.title', body: 'manual.limit.template.body' },
      { id: 'limit-mods', title: 'manual.limit.mods.title', body: 'manual.limit.mods.body' },
      { id: 'limit-imNative', title: 'manual.limit.imNative.title', body: 'manual.limit.imNative.body' },
      { id: 'limit-prompts', title: 'manual.limit.prompts.title', body: 'manual.limit.prompts.body' },
      { id: 'limit-update', title: 'manual.limit.update.title', body: 'manual.limit.update.body' },
    ]

    const MANUAL_FAQ = [
      { id: 'models', question: 'manual.faq.models.question', answer: 'manual.faq.models.answer' },
      { id: 'extensions', question: 'manual.faq.extensions.question', answer: 'manual.faq.extensions.answer' },
      { id: 'architecture', question: 'manual.faq.architecture.question', answer: 'manual.faq.architecture.answer' },
      { id: 'rollback', question: 'manual.faq.rollback.question', answer: 'manual.faq.rollback.answer' },
      { id: 'language', question: 'manual.faq.language.question', answer: 'manual.faq.language.answer' },
    ]

    function ManualSectionTable({ headers, rows }) {
      const t = useTranslate()
      return h('div', { className: 'dt-manual-table-wrap' },
        h('table', { className: 'dt-manual-table' },
          h('thead', null,
            h('tr', null, headers.map((key) => h('th', { key, scope: 'col' }, t(key))))),
          h('tbody', null, rows.map((row) => h('tr', { key: row.id },
            row.cells.map((key, index) => index === 0
              ? h('th', { key, scope: 'row' }, t(key))
              : h('td', { key }, t(key))))))))
    }

    function ManualOpenButton({ section }) {
      const t = useTranslate()
      const target = panelSections.find((item) => item.id === section)
      const label = target === undefined ? section : target.label(t)
      return h('button', {
        type: 'button',
        className: 'dt-manual-open',
        onClick: () => update({ panelSection: section }),
      }, t('manual.openSection', { section: label }))
    }

    function PanelManual() {
      const t = useTranslate()
      const state = useTavernStore()
      const version = state.bootstrap.version ? `v${state.bootstrap.version}` : 'unknown'
      const jumpTo = (target) => {
        const node = document.getElementById(target)
        if (node !== null) node.scrollIntoView({ block: 'start' })
      }
      return h('div', { className: 'dt-manual' },
        h('section', { className: 'dt-settings-band dt-manual-hero' },
          h('div', { className: 'dt-manual-hero-head' },
            h('div', { className: 'dt-manual-hero-copy' },
              h('h3', null, t('manual.title')),
              h('p', { className: 'dt-manual-tagline' }, t('manual.tagline')))),
          h('p', { className: 'dt-hint' }, t('manual.intro')),
          h('ul', { className: 'dt-manual-facts' },
            MANUAL_FACTS.map((key) => h('li', { key }, t(key))))),
        h('nav', { className: 'dt-manual-toc', 'aria-label': t('manual.toc.label') },
          MANUAL_TOC.map((item) => h('button', {
            key: item.id,
            type: 'button',
            onClick: () => jumpTo(item.target),
          }, t(item.label)))),
        h('section', { id: 'dt-manual-start', className: 'dt-settings-band' },
          h('h3', null, t('manual.start.title')),
          h('p', { className: 'dt-hint' }, t('manual.start.hint')),
          h('ol', { className: 'dt-manual-steps' },
            MANUAL_STEPS.map((step, index) => h('li', { key: step.id },
              h('span', { className: 'dt-manual-step-num', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')),
              h('div', { className: 'dt-manual-step-copy' },
                h('strong', null, t(step.title)),
                h('p', { className: 'dt-hint' }, t(step.body)),
                step.sections.length > 0
                  ? h('div', { className: 'dt-manual-actions' },
                    step.sections.map((section) => h(ManualOpenButton, { key: section, section })))
                  : null))))),
        h('section', { id: 'dt-manual-terms', className: 'dt-settings-band' },
          h('h3', null, t('manual.terms.title')),
          h('p', { className: 'dt-hint' }, t('manual.terms.hint')),
          h('dl', { className: 'dt-manual-terms' },
            MANUAL_TERMS.map((term) => h('div', { key: term.id, className: 'dt-manual-term' },
              h('dt', null, t(term.name)),
              h('dd', null, t(term.body))))),
          h('h4', { className: 'dt-manual-subhead' }, t('manual.arch.title')),
          h('p', { className: 'dt-hint' }, t('manual.arch.hint')),
          h(ManualSectionTable, { headers: MANUAL_ARCH_HEADERS, rows: MANUAL_ARCH_ROWS })),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('manual.data.title')),
          h('p', { className: 'dt-manual-body' }, t('manual.data.storage')),
          h('p', { className: 'dt-manual-body' }, t('manual.data.migration'))),
        h('section', { id: 'dt-manual-diff', className: 'dt-settings-band' },
          h('h3', null, t('manual.diff.title')),
          h('p', { className: 'dt-hint' }, t('manual.diff.hint')),
          h(ManualSectionTable, { headers: MANUAL_DIFF_HEADERS, rows: MANUAL_DIFF_ROWS })),
        h('section', { id: 'dt-manual-features', className: 'dt-settings-band' },
          h('h3', null, t('manual.features.title')),
          h('p', { className: 'dt-hint' }, t('manual.features.hint')),
          h('div', { className: 'dt-manual-feature-groups' },
            MANUAL_FEATURE_GROUPS.map((group) => h('div', { key: group.id, className: 'dt-manual-feature-group' },
              h('h4', null, t(group.title)),
              h('div', { className: 'dt-manual-feature-grid' },
                group.items.map((item) => h('article', { key: item.id, className: 'dt-manual-feature' },
                  h('h5', null, t(item.name)),
                  h('p', null, t(item.body)),
                  h(ManualOpenButton, { section: item.section })))))))),
        h('section', { id: 'dt-manual-limits', className: 'dt-settings-band' },
          h('h3', null, t('manual.limits.title')),
          h('ul', { className: 'dt-manual-limits' },
            MANUAL_LIMITS.map((limit) => h('li', { key: limit.id },
              h('strong', null, t(limit.title)),
              h('p', null, t(limit.body))))),
          h('h4', { className: 'dt-manual-subhead' }, t('manual.faq.title')),
          h('div', { className: 'dt-manual-faq-list' },
            MANUAL_FAQ.map((item) => h('details', { key: item.id, className: 'dt-manual-faq' },
              h('summary', null, t(item.question)),
              h('p', null, t(item.answer)))))),
        h('p', { className: 'dt-manual-footer' }, t('manual.footer', { version })))
    }