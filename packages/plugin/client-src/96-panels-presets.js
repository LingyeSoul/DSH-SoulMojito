    // 预设面板族（2026-10-21 从 90-panels-core.js 拆出）：PresetEditor 表单 +
    // PanelPresets 清单 + 空白模板常量。拆分原因：源文件预算（800 行）——
    // 面板注册表 + 角色/世界书族继续增长，预设族自成一体（编辑器 + 清单 +
    // 生效范围开关），是最干净的缝合线。声明跨片段共享（manifest 拼接进同一
    // ModuleLoader 工厂作用域），此处引用的 EditorField/ToggleField/cloneValue
    // 等函数声明提升可见，BLANK_PRESET 仅渲染期使用、无 TDZ 风险。

    // 手动新建的空白预设模板：空 prompts/prompt_order 即合法 chat-completion
    // 形态（detectPresetKind 按这两个数组判定），采样字段留空袋由编辑器维护。
    const BLANK_PRESET = { prompts: [], prompt_order: [] }

    /**
     * 生效的 prompt_order 组（与 tavern-pipeline/src/pipeline.ts 的
     * resolvePromptOrder 同口径）：优先 global dummy 100001，回落旧 dummy
     * 100000，再回落首组；返回下标，-1 表示没有可编辑的组。
     */
    function resolveOrderIndex(sets) {
      const list = Array.isArray(sets) ? sets : []
      for (const dummy of [100001, 100000]) {
        const index = list.findIndex((item) => Number(item?.character_id) === dummy)
        if (index >= 0) return index
      }
      return list.length > 0 ? 0 : -1
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
      const dirty = presetName !== name
        || advanced !== JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order')), null, 2)
        || JSON.stringify(draft.prompts) !== JSON.stringify((data || {}).prompts)
        // 顺序表（拖拽/启用）也是草稿的一部分：不加进来，改完顺序点保存会静默丢弃。
        || JSON.stringify(draft.prompt_order) !== JSON.stringify((data || {}).prompt_order)
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
      // prompt_order 编辑（契约 2026-11-12 §2.11）：顺序与启用语义由装配侧
      // 独占（`prompt_order[].order[].enabled`），这里的拖拽/开关直接改那一份。
      const resolvedOrder = (current) => {
        const sets = Array.isArray(current.prompt_order) ? current.prompt_order : []
        const index = resolveOrderIndex(sets)
        return { sets, index, order: index >= 0 ? (sets[index].order || []) : [] }
      }
      const moveOrderEntry = (from, to) => setDraft((current) => {
        const { sets, index, order } = resolvedOrder(current)
        if (index < 0 || from === to) return current
        if (from < 0 || from >= order.length || to < 0 || to >= order.length) return current
        const next = [...order]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return { ...current, prompt_order: sets.map((item, at) => at === index ? { ...item, order: next } : item) }
      })
      const setOrderEnabled = (identifier, enabled) => setDraft((current) => {
        const { sets, index } = resolvedOrder(current)
        if (index < 0) return current
        return {
          ...current,
          prompt_order: sets.map((item, at) => at !== index ? item : {
            ...item,
            order: (item.order || []).map((entry) => entry.identifier === identifier ? { ...entry, enabled } : entry),
          }),
        }
      })
      const [dragging, setDragging] = useState(-1)
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
      const title = name !== ''
        ? t('panel.presets.editTitle', { name })
        : t('panel.presets.creating')
      const toolbar = h('div', { className: 'dt-editor-toolbar' },
        h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
        h('div', { className: 'dt-editor-actions' },
          h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: saving || !presetName.trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save'))))
      return h(EditorDialog, { title, onClose: cancel, closeLabel: t('panel.close'), footer: toolbar },
        h('div', { className: 'dt-editor' },
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
              // `system_prompt` 只是「全局/预设提示词」的分类标记，不参与启用
              // 判定（tavern-pipeline 的 entryEnabled 只认顺序表 enabled）；旧标签
              // 写作「启用」会让人以为关掉它就不参与装配。
              h(ToggleField, { label: t('panel.presets.systemPromptFlag'), checked: prompt.system_prompt !== false, onChange: (value) => setPrompt(index, 'system_prompt', value) })))))) : null,
        // 顺序表：装配只读这一份（不在表里的提示词不参与），因此它是 prompt
        // manager 的主体；拖拽行 = 调换顺序，勾选框 = 该项是否参与装配。
        chatPreset
          ? h(React.Fragment, null,
            h('div', { className: 'dt-editor-section-title' },
              h('strong', null, t('panel.presets.promptOrder'))),
            h('p', { className: 'dt-hint' }, t('panel.presets.promptOrderHint')),
            resolvedOrder(draft).order.length === 0
              ? h('p', { className: 'dt-muted' }, t('panel.presets.promptOrderEmpty'))
              : h('div', { className: 'dt-editor-entries' }, resolvedOrder(draft).order.map((entry, index) => {
                const prompt = (draft.prompts || []).find((item) => item.identifier === entry.identifier)
                const label = prompt?.name || entry.identifier
                const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : prompt?.enabled !== false
                return h('div', {
                  key: `${entry.identifier}-${index}`,
                  className: `dt-editor-entry dt-prompt-order-row${dragging === index ? ' dt-prompt-order-dragging' : ''}`,
                  draggable: true,
                  onDragStart: () => setDragging(index),
                  onDragEnd: () => setDragging(-1),
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: (event) => {
                    event.preventDefault()
                    moveOrderEntry(dragging, index)
                    setDragging(-1)
                  },
                },
                h('div', { className: 'dt-editor-entry-head' },
                  h('strong', { title: entry.identifier }, `${index + 1}. ${label}`),
                  h('div', { className: 'dt-imports' },
                    h(Button, { size: 'sm', variant: 'ghost', disabled: index === 0, onClick: () => moveOrderEntry(index, index - 1) }, t('panel.presets.moveUp')),
                    h(Button, { size: 'sm', variant: 'ghost', disabled: index === resolvedOrder(draft).order.length - 1, onClick: () => moveOrderEntry(index, index + 1) }, t('panel.presets.moveDown')),
                    h(ToggleField, { label: t('panel.presets.enabled'), checked: enabled, onChange: (value) => setOrderEnabled(entry.identifier, value) }))))
              })))
          : null,
        h(EditorField, { label: t('panel.presets.sampler'), value: advanced, onChange: setAdvanced, multiline: true, className: 'dt-editor-wide dt-editor-json' }),
        error ? h('p', { className: 'dt-error' }, error) : null))
    }

    function PanelPresets() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [viewing, setViewing] = useState('')
      const [editing, setEditing] = useState('')
      const [creating, setCreating] = useState(false)
      const [presets, setPresets] = useState({})
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const kinds = state.bootstrap.presetKinds || {}
      const viewPreset = (name) => {
        setViewing(name)
        if (!(name in presets)) {
          setPresets((current) => ({ ...current, [name]: null }))
          void fetchPreset(name).then((data) => setPresets((current) => ({ ...current, [name]: data })))
            .catch((cause) => {
              setPresets((current) => {
                const next = { ...current }
                delete next[name]
                return next
              })
              setViewing('')
              setError(cause instanceof Error ? cause.message : String(cause))
            })
        }
      }
      const editPreset = (name) => {
        setViewing('')
        setEditing(name)
        if (!(name in presets)) {
          setPresets((current) => ({ ...current, [name]: null }))
          void fetchPreset(name).then((data) => setPresets((current) => ({ ...current, [name]: data })))
            .catch((cause) => {
              setPresets((current) => {
                const next = { ...current }
                delete next[name]
                return next
              })
              setEditing('')
              setError(cause instanceof Error ? cause.message : String(cause))
            })
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
      // 名称过滤（2026-10-21 分页 UX）：与角色/剧本/正则清单同款过滤模式。
      const [presetFilter, setPresetFilter] = useState('')
      const presetQuery = presetFilter.trim().toLowerCase()
      const presetNames = state.bootstrap.presets
      const visiblePresets = presetQuery === ''
        ? presetNames
        : presetNames.filter((name) => name.toLowerCase().includes(presetQuery))
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'preset', label: t('settings.importPreset'), accept: '.json,application/json' }),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => { setEditing(''); setViewing(''); setCreating(true) } }, `+ ${t('panel.presets.new')}`))),
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
          presetNames.length > 0 ? h('div', { className: 'dt-filter-row' },
            h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.filterPlaceholder'), 'aria-label': t('panel.filterPlaceholder'), value: presetFilter, onChange: (event) => setPresetFilter(event.target.value) })) : null,
          presetNames.length === 0 && !creating
            ? h('p', { className: 'dt-muted' }, t('panel.presets.empty'))
            : visiblePresets.length === 0
              ? h('p', { className: 'dt-muted' }, t('panel.filterEmpty'))
              : h('div', { className: 'dt-preset-list' }, visiblePresets.map((name) => h('div', { key: name, className: 'dt-preset-row' },
                h('strong', { className: 'dt-preset-name' }, name),
                h(Pill, null, kinds[name] || 'preset'),
                h(Button, { size: 'sm', variant: 'ghost', icon: h(IconBrowseOutline16), 'aria-haspopup': 'dialog', onClick: () => viewPreset(name) }, t('panel.view')),
                h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editPreset(name) }, t('panel.edit')),
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
                }))))),
        viewing !== ''
          ? h(PresetView, {
            name: viewing,
            kind: kinds[viewing],
            data: presets[viewing] ?? null,
            onClose: () => setViewing(''),
            onEdit: () => editPreset(viewing),
          })
          : null,
        editing !== '' && presets[editing]
          ? h(PresetEditor, { name: editing, kind: kinds[editing], data: presets[editing], onSave: (data, nextName) => save(editing, data, nextName), onCancel: () => setEditing('') })
          : editing !== ''
            ? h(EditorDialog, { title: t('panel.presets.editTitle', { name: editing }), onClose: () => setEditing(''), closeLabel: t('panel.close') },
              h('p', { className: 'dt-muted' }, t('nav.loading')))
            : null,
        creating
          ? h(PresetEditor, { name: '', kind: 'chat-completion', data: BLANK_PRESET, onSave: createPreset, onCancel: () => setCreating(false) })
          : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }
