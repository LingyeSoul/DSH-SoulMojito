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

    // Group master switch: a group is "on" only when every script in it is on.
    // Mixed state renders the native indeterminate dash, so one glance tells the
    // user the section is partially enabled.
    function RegexGroupToggle({ label, checked, mixed, disabled, onChange }) {
      const ref = useRef(null)
      useEffect(() => {
        if (ref.current !== null) ref.current.indeterminate = mixed
      }, [mixed])
      return h('label', { className: 'dt-toggle dt-regex-group-toggle', title: label },
        h('input', {
          ref,
          type: 'checkbox',
          'aria-label': label,
          checked,
          disabled,
          onChange,
        }))
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

    function RegexBand({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [syncing, setSyncing] = useState('')
      const [editing, setEditing] = useState('')
      const [regexFilter, setRegexFilter] = useState('')
      // 分区折叠（2026-10-23 用户需求）：默认全部收起，只留段头一行；
      // 展开状态按分区键记忆，过滤或编辑中的分区强制展开（见 groupOpen）。
      const [expandedGroups, setExpandedGroups] = useState({})
      const scripts = state.bootstrap.state.regexScripts || []
      // 卡级/预设级脚本跟随各自来源（2026-10-22 用户需求）：只有归属当前角色卡、
      // 或所属预设正在激活的脚本在本会话生效；其余置灰并锁定开关，编辑面仍保留。
      const cardOwners = state.bootstrap.state.regexScriptOwners || {}
      const presetOwners = state.bootstrap.state.regexScriptPresetOwners || {}
      // 当前卡以当前宿主会话的 Tavern 绑定为准（切回旧会话不会重写全局指针）。
      const activeCharacter = useActiveTavernCharacter(useSessions)
      const activePreset = state.bootstrap.state.activePreset || ''
      // 角色卡名与文件名 stem 可能因非法字符被 safeFileName 改写（服务端同名规则），
      // 面板比较两边都归一化，避免「明明是本卡却判成别的卡」的识别失败。
      const sameCharacter = (owner) => owner !== undefined
        && (owner === activeCharacter || normalizeTavernName(owner) === normalizeTavernName(activeCharacter))
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
      // 按来源分区（2026-10-23 用户需求）：全局、每张角色卡、每个预设各成一段。
      // 分区按「全局 → 角色卡 → 预设」、组内名称排序，避免每次写盘后顺序漂移。
      const regexGroups = () => {
        const groups = new Map()
        for (const script of scripts) {
          const cardOwner = cardOwnerOf(script)
          const presetOwner = presetOwnerOf(script)
          const kind = cardOwner !== undefined ? 'character' : presetOwner !== undefined ? 'preset' : 'global'
          const name = cardOwner ?? presetOwner ?? ''
          const key = `${kind}:${name}`
          const group = groups.get(key) ?? { key, kind, name, scripts: [] }
          group.scripts.push(script)
          groups.set(key, group)
        }
        const rank = { global: 0, character: 1, preset: 2 }
        return [...groups.values()].sort((left, right) => rank[left.kind] - rank[right.kind] || left.name.localeCompare(right.name))
      }
      const groupLabel = (group) => group.kind === 'global'
        ? t('settings.regexGroupGlobal')
        : t(group.kind === 'character' ? 'settings.regexGroupCharacter' : 'settings.regexGroupPreset', { name: group.name })
      const groupActive = (group) => group.kind === 'character'
        ? sameCharacter(group.name)
        : group.kind === 'preset' && group.name === activePreset
      // 折叠只影响条目可见性，段头的启停/清空/条数始终按该来源的全部脚本。
      // 过滤时所有匹配分区直接展开：否则搜索结果藏在收起的分区里，用户会
      // 以为过滤没生效；编辑中的分区同样保持展开，避免草稿被折叠层藏住。
      const groupEditing = (group) => editing !== '' && group.scripts.some((script) => script.id === editing)
      const groupOpen = (group) => expandedGroups[group.key] === true || regexQuery !== '' || groupEditing(group)
      const groupFoldLocked = (group) => regexQuery !== '' || groupEditing(group)
      const toggleGroupOpen = (group) => setExpandedGroups((current) => ({ ...current, [group.key]: current[group.key] !== true }))
      const groupListId = (group) => `dt-regex-group-list-${encodeURIComponent(group.key)}`
      // 段头文字与徽标同属折叠按钮（静态态复用同一份内容），保证整行可点。
      const groupTitle = (group, open) => [
        h(IconChevronDownOutline14, { key: 'chevron', className: open ? 'dt-chevron-open' : '' }),
        h('span', { key: 'name', className: 'dt-regex-group-name', title: groupLabel(group) }, groupLabel(group)),
        groupActive(group) ? h('span', { key: 'active', className: 'dt-regex-group-active' }, t('settings.regexGroupActive')) : null,
        group.kind !== 'global' && !groupActive(group)
          ? h('span', { key: 'inactive', className: 'dt-regex-group-inactive' }, t('settings.regexGroupInactive'))
          : null,
        h('span', { key: 'count', className: 'dt-regex-group-count' }, t('settings.regexGroupCount', { count: group.scripts.length })),
      ]
      // 过滤只影响分段内可见条目，分区数字与「清空分区」始终指向该来源的全部
      // 脚本——否则过滤状态下删分区会留下看不见的残留。
      const visibleGroups = regexGroups()
        .map((group) => ({
          group,
          visible: group.scripts.filter((script) => regexQuery === ''
            || script.scriptName.toLowerCase().includes(regexQuery)
            || script.findRegex.toLowerCase().includes(regexQuery)),
        }))
        .filter((entry) => entry.visible.length > 0)
      const visibleCount = visibleGroups.reduce((sum, entry) => sum + entry.visible.length, 0)
      // 保存/转全局后展开目标分区：默认全收起时，刚保存的脚本若落回收起
      // 分区，用户会以为保存失败；新建脚本没有归属，落点是全局分区。
      const revealGroup = (key) => setExpandedGroups((current) => (current[key] === true ? current : { ...current, [key]: true }))
      const revealScript = (script) => {
        const group = regexGroups().find((entry) => entry.scripts.some((item) => item.id === script.id))
        revealGroup(group ? group.key : 'global:')
      }
      const run = (promise) => { setError(''); setNotice(''); void promise.catch((cause) => setError(cause.message)) }
      const saveScript = (script) => {
        const next = scripts.some((item) => item.id === script.id)
          ? scripts.map((item) => (item.id === script.id ? script : item))
          : [...scripts, script]
        return saveRegexScripts(next).then(() => {
          revealScript(script)
          setEditing('')
        })
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
          .then(() => {
            // 归属表由服务端剪掉，脚本改落全局分区；展开它，别让迁移结果消失。
            revealGroup('global:')
            setNotice(t('settings.regexReleased', { name: script.scriptName }))
          }))
      }
      // 清空分区（2026-10-23 用户需求）：一次移除该角色卡/预设/全局的全部脚本。
      // 服务端 replaceRegexScripts 会同步剪掉这些 id 的两张归属表，无需另行清理。
      const deleteGroup = (group) => {
        const scope = groupLabel(group)
        const count = group.scripts.length
        if (!window.confirm(t('settings.regexDeleteGroupConfirm', { scope, count }))) return
        const removed = new Set(group.scripts.map((script) => script.id))
        run(saveRegexScripts(scripts.filter((script) => !removed.has(script.id))).then(() => {
          setEditing((current) => (removed.has(current) ? '' : current))
          setNotice(t('settings.regexDeleteGroupDone', { scope, count: removed.size }))
        }))
      }
      // 分区一键启停（2026-10-23 用户需求）：与「清空分区」同口径，作用域是
      // 该来源的全部脚本（含被过滤隐藏的行）。全部启用时点击全停，其余状态
      // （全停/部分启用）点击全开——部分启用一键补齐，不用逐行找漏网的。
      const groupEnabledCount = (group) => group.scripts.filter((script) => !script.disabled).length
      const toggleGroup = (group) => {
        const total = group.scripts.length
        const nextDisabled = groupEnabledCount(group) === total
        const scope = groupLabel(group)
        const action = t(nextDisabled ? 'settings.regexGroupToggleOff' : 'settings.regexGroupToggleOn')
        const ids = new Set(group.scripts.map((script) => script.id))
        const next = scripts.map((script) => (ids.has(script.id) ? { ...script, disabled: nextDisabled } : script))
        run(saveRegexScripts(next).then(() => {
          const done = { scope, count: total, action }
          setNotice(t(groupActive(group) || group.kind === 'global'
            ? 'settings.regexGroupToggleDone'
            : 'settings.regexGroupToggleInactive', done))
        }))
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
      const scriptItem = (script) => h('div', { key: script.id, className: 'dt-regex-item' },
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
          : null)
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
        scripts.length === 0 && editing !== 'new' ? h('p', { className: 'dt-muted' }, t('settings.regexEmpty')) : visibleCount === 0
          ? h('p', { className: 'dt-muted' }, t('panel.filterEmpty'))
          // 分区头固定展示该来源的全部条数（不是过滤后的条数），「清空分区」
          // 也按全部删除；过滤只收窄组内可见行。
          : h('div', { className: 'dt-regex-groups' },
            visibleGroups.map(({ group, visible }) => {
              const enabled = groupEnabledCount(group)
              const total = group.scripts.length
              const open = groupOpen(group)
              const locked = groupFoldLocked(group)
              const scope = groupLabel(group)
              const listId = groupListId(group)
              return h('div', {
                key: group.key,
                className: 'dt-regex-group',
                role: 'group',
                'aria-label': scope,
              },
                h('div', { className: 'dt-regex-group-head' },
                  h(RegexGroupToggle, {
                    label: t(enabled === total ? 'settings.regexGroupDisableAll' : 'settings.regexGroupEnableAll', { scope, count: total }),
                    checked: total > 0 && enabled === total,
                    mixed: enabled > 0 && enabled < total,
                    disabled: editing !== '',
                    onChange: () => toggleGroup(group),
                  }),
                  // 过滤/编辑态用静态段头（不可折叠），避免点击后毫无变化的死控件。
                  locked
                    ? h('div', { className: 'dt-regex-group-fold dt-regex-group-fold-static' }, groupTitle(group, open))
                    : h('button', {
                        type: 'button',
                        className: 'dt-regex-group-fold',
                        'aria-expanded': open,
                        'aria-controls': listId,
                        title: t(open ? 'settings.regexGroupFold' : 'settings.regexGroupUnfold', { scope }),
                        onClick: () => toggleGroupOpen(group),
                      }, groupTitle(group, open)),
                  h('button', {
                    type: 'button',
                    className: 'dt-regex-group-delete',
                    title: t('settings.regexDeleteGroup', { scope, count: group.scripts.length }),
                    'aria-label': t('settings.regexDeleteGroup', { scope, count: group.scripts.length }),
                    disabled: editing !== '',
                    onClick: () => deleteGroup(group),
                  }, h(IconTrashOutline16), h('span', null, t('settings.regexDeleteGroupShort')))),
                open ? h('div', { id: listId, className: 'dt-regex-list' }, visible.map(scriptItem)) : null)
            })),
        notice ? h('p', { className: 'dt-muted' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }
