    const REGEX_PLACEMENTS = [
      { value: 1, labelKey: 'settings.regexPlacementInput' },
      { value: 2, labelKey: 'settings.regexPlacementOutput' },
      { value: 3, labelKey: 'settings.regexPlacementCommand' },
      { value: 5, labelKey: 'settings.regexPlacementWorldInfo' },
      { value: 6, labelKey: 'settings.regexPlacementReasoning' },
    ]

    function regexPlacementLabel(t, value) {
      const option = REGEX_PLACEMENTS.find((item) => item.value === value)
      return option ? t(option.labelKey) : String(value)
    }

    function newRegexScript() {
      return {
        id: `regex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        scriptName: '', findRegex: '', replaceString: '', trimStrings: [],
        placement: [2], disabled: false, markdownOnly: false, promptOnly: false,
        runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null,
      }
    }

    function RegexScriptEditor({ script, onSave, onCancel }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(script))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const dirty = JSON.stringify(draft) !== JSON.stringify(script)
      const setField = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
      const setDepth = (key, value) => {
        const parsed = value.trim() === '' ? null : Number(value)
        setField(key, parsed !== null && Number.isFinite(parsed) ? parsed : null)
      }
      // placement 至少保留一项：ST 语义下无 placement 的脚本不会在任何层生效，
      // 最后一项禁止取消（服务端 parseRegexScripts 也会把空集回落为 AI_OUTPUT）。
      const togglePlacement = (value, checked) => setDraft((current) => {
        const placement = checked
          ? (current.placement.includes(value) ? current.placement : [...current.placement, value])
          : current.placement.filter((item) => item !== value)
        return placement.length > 0 ? { ...current, placement } : current
      })
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      const save = () => {
        const scriptName = String(draft.scriptName || '').trim()
        if (scriptName === '') { setError(t('settings.regexNameRequired')); return }
        if (draft.findRegex.trim() === '') { setError(t('settings.regexFindRequired')); return }
        try { new RegExp(draft.findRegex) } catch (cause) {
          setError(t('settings.regexBadPattern', { message: cause instanceof Error ? cause.message : String(cause) }))
          return
        }
        setSaving(true)
        setError('')
        void Promise.resolve(onSave({
          ...draft,
          scriptName,
          trimStrings: (draft.trimStrings || []).map((item) => item.trim()).filter(Boolean),
        }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving, onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('div', { className: 'dt-editor-grid' },
          h(EditorField, { label: t('settings.regexName'), value: draft.scriptName, onChange: (value) => setField('scriptName', value) }),
          h('div', { className: 'dt-editor-field' },
            h('span', { className: 'dt-label' }, t('settings.regexPlacement')),
            h('div', { className: 'dt-editor-toggles' },
              REGEX_PLACEMENTS.map(({ value, labelKey }) => h(ToggleField, {
                key: value,
                label: t(labelKey),
                checked: draft.placement.includes(value),
                onChange: (checked) => togglePlacement(value, checked),
              })))),
          h(EditorField, { label: t('settings.regexFind'), value: draft.findRegex, onChange: (value) => setField('findRegex', value), multiline: true, className: 'dt-editor-wide dt-editor-json', hint: t('settings.regexFindHint') }),
          h(EditorField, { label: t('settings.regexReplace'), value: draft.replaceString, onChange: (value) => setField('replaceString', value), multiline: true, className: 'dt-editor-wide dt-editor-json', hint: t('settings.regexReplaceHint') }),
          h(EditorField, { label: t('settings.regexTrim'), value: (draft.trimStrings || []).join('\n'), onChange: (value) => setField('trimStrings', value.split('\n')), multiline: true, className: 'dt-editor-wide', hint: t('settings.regexTrimHint') }),
          h(EditorField, { label: t('settings.regexMinDepth'), value: draft.minDepth === null ? '' : String(draft.minDepth), type: 'number', min: 0, onChange: (value) => setDepth('minDepth', value), hint: t('settings.regexDepthHint') }),
          h(EditorField, { label: t('settings.regexMaxDepth'), value: draft.maxDepth === null ? '' : String(draft.maxDepth), type: 'number', min: 0, onChange: (value) => setDepth('maxDepth', value), hint: t('settings.regexDepthHint') }),
          h('div', { className: 'dt-editor-toggles dt-editor-wide' },
            h(ToggleField, { label: t('settings.regexMarkdownOnly'), checked: draft.markdownOnly === true, onChange: (value) => setField('markdownOnly', value) }),
            h(ToggleField, { label: t('settings.regexPromptOnly'), checked: draft.promptOnly === true, onChange: (value) => setField('promptOnly', value) }),
            h(ToggleField, { label: t('settings.regexRunOnEdit'), checked: draft.runOnEdit === true, onChange: (value) => setField('runOnEdit', value) }),
            h(ToggleField, { label: t('settings.regexSubstitute'), checked: draft.substituteRegex === true, onChange: (value) => setField('substituteRegex', value) }))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function RegexBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [syncing, setSyncing] = useState(false)
      const [editing, setEditing] = useState('')
      const scripts = state.bootstrap.state.regexScripts || []
      const run = (promise) => { setError(''); setNotice(''); void promise.catch((cause) => setError(cause.message)) }
      const saveScript = (script) => {
        const next = scripts.some((item) => item.id === script.id)
          ? scripts.map((item) => (item.id === script.id ? script : item))
          : [...scripts, script]
        return saveRegexScripts(next).then(() => setEditing(''))
      }
      const syncFromCards = () => {
        setError('')
        setNotice('')
        setSyncing(true)
        void syncRegexScriptsFromCards()
          .then((result) => setNotice(t('settings.regexSyncDone', {
            scanned: result.scanned, imported: result.imported, skipped: result.skipped, invalid: result.invalid,
          })))
          .catch((cause) => setError(cause.message))
          .finally(() => setSyncing(false))
      }
      const closeEditor = () => setEditing('')
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-band-actions' },
          h(Button, { size: 'sm', variant: 'primary', icon: h(IconPlusOutline16), disabled: editing !== '', onClick: () => setEditing('new') }, t('settings.regexCreate')),
          h(UploadButton, { kind: 'regex', label: t('settings.importRegex'), accept: '.json,application/json' }),
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefreshOutline16), disabled: syncing, onClick: syncFromCards }, syncing ? t('settings.importing') : t('settings.regexSyncCards'))),
        editing === 'new'
          ? h('div', { key: 'new', className: 'dt-regex-editor-wrap' },
            h(RegexScriptEditor, { script: newRegexScript(), onSave: saveScript, onCancel: closeEditor }))
          : null,
        scripts.length === 0 && editing !== 'new' ? h('p', { className: 'dt-muted' }, t('settings.regexEmpty')) : h('div', { className: 'dt-regex-list' },
          scripts.map((script) => h('div', { key: script.id, className: 'dt-regex-item' },
            h('div', { className: `dt-regex-row ${script.disabled ? 'dt-regex-off' : ''}` },
              // Checkbox keeps its own control surface; the script name is read
              // text next to it, so the row can put the pattern on a second line.
              h('label', { className: 'dt-toggle dt-regex-check', title: t('settings.regexToggle', { name: script.scriptName }) },
                h('input', {
                  type: 'checkbox',
                  'aria-label': t('settings.regexToggle', { name: script.scriptName }),
                  checked: !script.disabled,
                  disabled: editing === script.id,
                  onChange: () => run(saveRegexScripts(scripts.map((item) => item.id === script.id ? { ...item, disabled: !item.disabled } : item))),
                })),
              h('div', { className: 'dt-regex-main' },
                h('div', { className: 'dt-regex-head' },
                  h('span', { className: 'dt-regex-name', title: script.scriptName }, script.scriptName),
                  h('span', { className: 'dt-regex-placements', title: t('settings.regexPlacements', { names: script.placement.map((p) => regexPlacementLabel(t, p)).join(', ') }) },
                    script.placement.map((p) => regexPlacementLabel(t, p)).join(' · '))),
                h('code', { className: 'dt-regex-pattern', title: script.findRegex }, script.findRegex)),
              h('div', { className: 'dt-regex-actions' },
                h('button', {
                  type: 'button',
                  title: t('settings.regexEdit', { name: script.scriptName }),
                  'aria-label': t('settings.regexEdit', { name: script.scriptName }),
                  disabled: editing !== '' && editing !== script.id,
                  onClick: () => setEditing(editing === script.id ? '' : script.id),
                }, h(IconEditOutline16)),
                h('button', {
                  type: 'button',
                  title: t('settings.regexDelete', { name: script.scriptName }),
                  'aria-label': t('settings.regexDelete', { name: script.scriptName }),
                  disabled: editing === script.id,
                  onClick: () => run(saveRegexScripts(scripts.filter((item) => item.id !== script.id))),
                }, h(IconTrashOutline16)))),
            editing === script.id
              ? h('div', { className: 'dt-regex-editor-wrap' },
                h(RegexScriptEditor, { script, onSave: saveScript, onCancel: closeEditor }))
              : null))),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }
