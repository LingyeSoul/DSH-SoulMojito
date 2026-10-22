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
      const [syncing, setSyncing] = useState('')
      const [editing, setEditing] = useState('')
      const [regexFilter, setRegexFilter] = useState('')
      const scripts = state.bootstrap.state.regexScripts || []
      // 卡级/预设级脚本跟随各自来源（2026-10-22 用户需求）：只有归属当前角色卡、
      // 或所属预设正在激活的脚本在本会话生效；其余置灰并锁定开关，编辑面仍保留。
      const cardOwners = state.bootstrap.state.regexScriptOwners || {}
      const presetOwners = state.bootstrap.state.regexScriptPresetOwners || {}
      const activeCharacter = state.bootstrap.state.activeCharacter || ''
      const activePreset = state.bootstrap.state.activePreset || ''
      // 角色卡名与文件名 stem 可能因非法字符被 safeFileName 改写（服务端同名规则），
      // 面板比较两边都归一化，避免「明明是本卡却判成别的卡」的识别失败。
      const normalizeName = (value) => String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120)
      const sameCharacter = (owner) => owner !== undefined
        && (owner === activeCharacter || normalizeName(owner) === normalizeName(activeCharacter))
      const cardOwnerOf = (script) => cardOwners[script.id]
      const presetOwnerOf = (script) => presetOwners[script.id]
      const autoInactive = (script) => {
        const cardOwner = cardOwnerOf(script)
        const presetOwner = presetOwnerOf(script)
        if (cardOwner === undefined && presetOwner === undefined) return false
        return !(sameCharacter(cardOwner) || (presetOwner !== undefined && presetOwner === activePreset))
      }
      // 名称/模式过滤（2026-10-21 分页 UX）：与角色/预设/剧本清单同款模式，
      // 模式串也参与匹配（正则要的就是按 pattern 找）。
      const regexQuery = regexFilter.trim().toLowerCase()
      const visibleScripts = regexQuery === ''
        ? scripts
        : scripts.filter((script) => script.scriptName.toLowerCase().includes(regexQuery) || script.findRegex.toLowerCase().includes(regexQuery))
      const run = (promise) => { setError(''); setNotice(''); void promise.catch((cause) => setError(cause.message)) }
      const saveScript = (script) => {
        const next = scripts.some((item) => item.id === script.id)
          ? scripts.map((item) => (item.id === script.id ? script : item))
          : [...scripts, script]
        return saveRegexScripts(next).then(() => setEditing(''))
      }
      // 归属别的来源时开关仍可切换，但当前会话不生效；给一条回执解释，避免
      // 用户以为点击没反应（2026-10-23 用户反馈）。
      const toggleScript = (script) => {
        const inactive = autoInactive(script)
        const owner = cardOwnerOf(script) ?? presetOwnerOf(script) ?? ''
        const noticeKey = cardOwnerOf(script) !== undefined
          ? 'settings.regexCardInactiveNotice'
          : 'settings.regexPresetInactiveNotice'
        const next = scripts.map((item) => (item.id === script.id ? { ...item, disabled: !item.disabled } : item))
        run(saveRegexScripts(next).then(() => {
          if (inactive) setNotice(t(noticeKey, { name: script.scriptName, owner }))
        }))
      }
      // 解除归属：换一个脚本 id 后旧归属会被服务端剪掉，脚本从此全局生效。
      const releaseOwnership = (script) => {
        const owner = cardOwnerOf(script) ?? presetOwnerOf(script) ?? ''
        if (!window.confirm(t('settings.regexReleaseConfirm', { name: script.scriptName, owner }))) return
        const id = `${script.id}-global-${Date.now().toString(36)}`
        run(saveRegexScripts(scripts.map((item) => item.id === script.id ? { ...item, id } : item))
          .then(() => setNotice(t('settings.regexReleased', { name: script.scriptName }))))
      }
      // 两个回填入口共用一份 busy 状态：同一时刻只允许一个扫描在跑，回执不交叉。
      const sync = (source, request, doneKey) => {
        setError('')
        setNotice('')
        setSyncing(source)
        void request()
          .then((result) => setNotice(t(doneKey, {
            scanned: result.scanned, imported: result.imported, skipped: result.skipped, invalid: result.invalid,
          })))
          .catch((cause) => setError(cause.message))
          .finally(() => setSyncing(''))
      }
      const syncFromCards = () => sync('cards', syncRegexScriptsFromCards, 'settings.regexSyncDone')
      const syncFromPresets = () => sync('presets', syncRegexScriptsFromPresets, 'settings.regexSyncPresetsDone')
      const closeEditor = () => setEditing('')
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-band-actions' },
          h(Button, { size: 'sm', variant: 'primary', icon: h(IconPlusOutline16), disabled: editing !== '', onClick: () => setEditing('new') }, t('settings.regexCreate')),
          h(UploadButton, { kind: 'regex', label: t('settings.importRegex'), accept: '.json,application/json' }),
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefreshOutline16), disabled: syncing !== '', onClick: syncFromCards }, syncing === 'cards' ? t('settings.importing') : t('settings.regexSyncCards')),
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefreshOutline16), disabled: syncing !== '', onClick: syncFromPresets }, syncing === 'presets' ? t('settings.importing') : t('settings.regexSyncPresets'))),
        editing === 'new'
          ? h('div', { key: 'new', className: 'dt-regex-editor-wrap' },
            h(RegexScriptEditor, { script: newRegexScript(), onSave: saveScript, onCancel: closeEditor }))
          : null,
        scripts.length > 0 && editing === '' ? h('div', { className: 'dt-filter-row' },
          h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.filterPlaceholder'), 'aria-label': t('panel.filterPlaceholder'), value: regexFilter, onChange: (event) => setRegexFilter(event.target.value) })) : null,
        scripts.length === 0 && editing !== 'new' ? h('p', { className: 'dt-muted' }, t('settings.regexEmpty')) : visibleScripts.length === 0
          ? h('p', { className: 'dt-muted' }, t('panel.filterEmpty'))
          : h('div', { className: 'dt-regex-list' },
            visibleScripts.map((script) => h('div', { key: script.id, className: 'dt-regex-item' },
            h('div', { className: `dt-regex-row ${script.disabled || autoInactive(script) ? 'dt-regex-off' : ''}` },
              // Checkbox keeps its own control surface; the script name is read
              // text next to it, so the row can put the pattern on a second line.
              // 归属别的角色卡/预设的脚本：置灰提示当前不生效，但仍允许切换——开关
// 写的是脚本自身的 disabled，等对应来源激活时生效；也在本行提供「转为全局」
// 解除归属，避免点击被禁用后毫无反应（2026-10-23 用户反馈）。
              h('label', {
                className: 'dt-toggle dt-regex-check',
                title: autoInactive(script) ? t('settings.regexAutoInactive') : t('settings.regexToggle', { name: script.scriptName }),
              },
                h('input', {
                  type: 'checkbox',
                  'aria-label': autoInactive(script) ? t('settings.regexAutoInactive') : t('settings.regexToggle', { name: script.scriptName }),
                  checked: !script.disabled,
                  disabled: editing === script.id,
                  onChange: () => toggleScript(script),
                })),
              h('div', { className: 'dt-regex-main' },
                h('div', { className: 'dt-regex-head' },
                  h('span', { className: 'dt-regex-name', title: script.scriptName }, script.scriptName),
                  cardOwnerOf(script) !== undefined
                    ? h('span', {
                        className: 'dt-regex-owner',
                        title: t(sameCharacter(cardOwnerOf(script)) ? 'settings.regexOwnerActive' : 'settings.regexOwnerInactive', { name: cardOwnerOf(script) }),
                      }, t('settings.regexOwner', { name: cardOwnerOf(script) }))
                    : null,
                  presetOwnerOf(script) !== undefined
                    ? h('span', {
                        className: 'dt-regex-owner',
                        title: t(presetOwnerOf(script) === activePreset ? 'settings.regexPresetOwnerActive' : 'settings.regexPresetOwnerInactive', { name: presetOwnerOf(script) }),
                      }, t('settings.regexPresetOwner', { name: presetOwnerOf(script) }))
                    : null,
                  h('span', { className: 'dt-regex-placements', title: t('settings.regexPlacements', { names: script.placement.map((p) => regexPlacementLabel(t, p)).join(', ') }) },
                    script.placement.map((p) => regexPlacementLabel(t, p)).join(' · '))),
                h('code', { className: 'dt-regex-pattern', title: script.findRegex }, script.findRegex)),
              h('div', { className: 'dt-regex-actions' },
                cardOwnerOf(script) !== undefined || presetOwnerOf(script) !== undefined
                  ? h('button', {
                      type: 'button',
                      className: 'dt-regex-release',
                      title: t('settings.regexRelease', { name: script.scriptName }),
                      'aria-label': t('settings.regexRelease', { name: script.scriptName }),
                      disabled: editing !== '',
                      onClick: () => releaseOwnership(script),
                    }, t('settings.regexReleaseShort'))
                  : null,
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
                  // 删除确认（2026-10-21 分页 UX）：原实现一键即删、无回滚面，
                  // 误点 trash 直接丢脚本——与角色/预设/世界书同款确认口径。
                  onClick: () => {
                    if (!window.confirm(t('settings.regexDeleteConfirm', { name: script.scriptName }))) return
                    run(saveRegexScripts(scripts.filter((item) => item.id !== script.id)))
                  },
                }, h(IconTrashOutline16)))),
            editing === script.id
              ? h('div', { className: 'dt-regex-editor-wrap' },
                h(RegexScriptEditor, { script, onSave: saveScript, onCancel: closeEditor }))
              : null))),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }
