    function AuditMemoryRow({ memory, t }) {
      const inactive = Boolean(memory.deletedAt || memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now())
      return h('article', { className: `dt-audit-row ${inactive ? 'dt-audit-row-inactive' : ''}` },
        h('div', { className: 'dt-audit-row-head' },
          h('strong', null, `${memory.scope} · ${memory.kind}`),
          h('span', null, memory.id)),
        h('p', null, memory.content),
        h('div', { className: 'dt-audit-meta' },
          h('span', null, t('panel.variables.auditSource', { source: memory.source?.kind || '-' })),
          h('span', null, t('panel.variables.auditRevision', { revision: memory.revision })),
          h('span', null, t('panel.variables.auditExpired', { value: memory.expiresAt || '-' })),
          h('span', null, t('panel.variables.auditDeleted', { value: memory.deletedAt || '-' }))))
    }

    function AuditVariableRow({ variable, t }) {
      return h('article', { className: 'dt-audit-row' },
        h('div', { className: 'dt-audit-row-head' },
          h('strong', null, `${variable.scope} · ${variable.name}`),
          h('span', null, t('panel.variables.auditRevision', { revision: variable.revision }))),
        h('pre', null, JSON.stringify(variable.value, null, 2)))
    }

    // 聊天局部变量的展示值：chat_metadata.variables 是任意 JSON 树（MVU 卡常为
    // 嵌套对象），直接 String() 会渲染成 [object Object]——对象/数组序列化为
    // 单行 JSON，完整文本挂 title 供悬停查看。
    function formatChatVariableValue(value) {
      if (value === null || typeof value !== 'object') return String(value)
      try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
    }

    function PanelVariables({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [audit, setAudit] = useState(null)
      const [auditLoading, setAuditLoading] = useState(false)
      const [auditError, setAuditError] = useState('')
      const [replayBusy, setReplayBusy] = useState(false)
      const [replayNonce, setReplayNonce] = useState(0)
      const [saved, setSaved] = useState(false)
      const currentSession = useSessions ? useCurrentSessionId(useSessions) : null
      const binding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const agentBinding = binding && bindingArchitecture(binding) === 'agent-tavern' ? binding : null
      const localChat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const localVars = localChat?.header?.chat_metadata?.variables
      useEffect(() => {
        void fetchGlobals()
          .then((globals) => setRows(Object.entries(globals).map(([key, value]) => ({ key, value: String(value) }))))
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setRows([]) })
      }, [])
      useEffect(() => {
        if (binding && !localChat) void loadChat(binding.character, binding.chatId).catch(() => {})
      }, [binding?.character, binding?.chatId])
      useEffect(() => {
        let cancelled = false
        setAudit(null)
        setAuditError('')
        if (!currentSession || !agentBinding) {
          setAuditLoading(false)
          return () => { cancelled = true }
        }
        setAuditLoading(true)
        void api(`agent-tavern/audit?sessionId=${encodeURIComponent(currentSession)}`)
          .then((result) => { if (!cancelled) setAudit(result) })
          .catch((cause) => { if (!cancelled) setAuditError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { if (!cancelled) setAuditLoading(false) })
        return () => { cancelled = true }
      }, [currentSession, agentBinding?.character, agentBinding?.chatId, agentBinding?.contextMode, replayNonce])
      const replayProjection = () => {
        if (!currentSession || replayBusy) return
        setReplayBusy(true)
        setAuditError('')
        void api('projection/replay', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionId: currentSession }),
        })
          .then(() => setReplayNonce((nonce) => nonce + 1))
          .catch((cause) => setAuditError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setReplayBusy(false))
      }
      const updateRow = (index, patch) => setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
      const save = () => {
        const globals = {}
        for (const row of rows) {
          const key = row.key.trim()
          if (key === '') continue
          const raw = row.value.trim()
          globals[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : row.value
        }
        setSaved(false)
        void saveGlobals(globals).then(() => setSaved(true)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.globals')),
          h('p', { className: 'dt-hint' }, t('panel.variables.globalsHint')),
          rows === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h(React.Fragment, null,
              rows.length === 0 ? h('p', { className: 'dt-muted' }, t('panel.variables.empty')) : null,
              h('div', { className: 'dt-kv-list' }, rows.map((row, index) => h('div', { key: index, className: 'dt-kv-row' },
                h(Input, { value: row.key, placeholder: t('panel.variables.key'), onChange: (event) => updateRow(index, { key: event.target.value }) }),
                h(Input, { value: row.value, placeholder: t('panel.variables.value'), onChange: (event) => updateRow(index, { value: event.target.value }) }),
                h(Button, {
                  size: 'sm',
                  variant: 'ghost',
                  icon: h(IconTrashOutline16),
                  'aria-label': t('panel.variables.remove', { key: row.key }),
                  title: t('panel.variables.remove', { key: row.key }),
                  onClick: () => setRows(rows.filter((_, rowIndex) => rowIndex !== index)),
                })))),
              h('div', { className: 'dt-imports' },
                h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: () => setRows([...rows, { key: '', value: '' }]) }, t('panel.variables.add')),
                h(Button, { size: 'sm', variant: 'primary', onClick: save }, t('panel.variables.save')),
                saved ? h('span', { className: 'dt-muted' }, t('panel.variables.saved')) : null))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.chatLocal')),
          !binding
            ? h('p', { className: 'dt-muted' }, t('panel.variables.chatLocalEmpty'))
            : localVars && Object.keys(localVars).length > 0
              ? h('div', { className: 'dt-kv-list' },
                Object.entries(localVars).map(([key, value]) => {
                  const text = formatChatVariableValue(value)
                  return h('div', { key, className: 'dt-kv-row dt-kv-readonly' },
                    h('span', { className: 'dt-kv-key' }, key),
                    h('span', { className: 'dt-kv-value', title: text }, text),
                    h('span'))
                }))
              : h('p', { className: 'dt-muted' }, t('panel.variables.empty'))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.agentAudit')),
          !agentBinding
            ? h('p', { className: 'dt-muted' }, t('panel.variables.agentAuditEmpty'))
            : auditLoading
              ? h('p', { className: 'dt-muted' }, t('panel.variables.auditLoading'))
              : audit
                ? h('div', { className: 'dt-audit' },
                  h('div', { className: 'dt-audit-summary' },
                    h('span', { className: 'dt-architecture-badge dt-architecture-agent-tavern' }, architectureLabel('agent-tavern')),
                    h('span', null, audit.contextMode === 'agent-managed' ? t('settings.contextManaged') : t('settings.contextNative')),
                    audit.projection ? h('span', null, t('panel.variables.projection', {
                      status: audit.projection.status,
                      cursor: audit.projection.lastCursor,
                    })) : null),
                  audit.projection?.error
                    ? h('p', { className: 'dt-error' }, t('panel.variables.auditProjectionError', { message: audit.projection.error }))
                    : null,
                  audit.projection?.status === 'pending'
                    ? h('div', { className: 'dt-imports' },
                      h(Button, {
                        size: 'sm',
                        variant: 'outline',
                        disabled: replayBusy,
                        onClick: replayProjection,
                      }, replayBusy ? t('panel.variables.replaying') : t('panel.variables.replayProjection')))
                    : null,
                  h('h4', null, t('panel.variables.memories')),
                  audit.memories?.length
                    ? h('div', { className: 'dt-audit-list' }, audit.memories.map((memory) => h(AuditMemoryRow, {
                      key: `${memory.scope}:${memory.id}`,
                      memory,
                      t,
                    })))
                    : h('p', { className: 'dt-muted' }, t('panel.variables.empty')),
                  h('h4', null, t('panel.variables.nativeVariables')),
                  audit.variables?.length
                    ? h('div', { className: 'dt-audit-list' }, audit.variables.map((variable) => h(AuditVariableRow, {
                      key: `${variable.scope}:${variable.name}`,
                      variable,
                      t,
                    })))
                    : h('p', { className: 'dt-muted' }, t('panel.variables.empty')))
                : null),
        auditError ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, auditError)) : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    // 持续指引面板（提案 0009）：跟随当前会话绑定的聊天（ST 与 AgentTavern
    // 都生效）。列出以 GET guides 为准（chat_metadata 里可能已有，也可能被
    // 其他端改过）；添加/删除成功后 revision 由服务端推进，客户端照 saveChat
    // 同款模式同步 revisions 并强刷聊天快照。
    function PanelGuides({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useSessions ? useCurrentSessionId(useSessions) : null
      const binding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      // 指引禁用面：写卡工作台会话不绑定聊天（binding.character/chatId 恒为空
      // 串），小说会话同款空绑定。直接禁用——不请求、不渲染输入，避免空 id 打
      // 到 guides 路由炸出 invalid chat id。
      const guidesDisabled = !!binding
        && (binding.architecture === 'card-workbench' || binding.character === '' || binding.chatId === '')
      const [guides, setGuides] = useState(null)
      const [draft, setDraft] = useState('')
      const [error, setError] = useState('')
      const [adding, setAdding] = useState(false)
      const [busyId, setBusyId] = useState('')
      useEffect(() => {
        let cancelled = false
        setGuides(null)
        setError('')
        if (!binding || guidesDisabled) return () => { cancelled = true }
        void loadGuides(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setGuides(Array.isArray(result.guides) ? result.guides : []) })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, guidesDisabled])
      const reloadGuides = () => {
        if (!binding || guidesDisabled) return Promise.resolve()
        return loadGuides(binding.character, binding.chatId)
          .then((result) => setGuides(Array.isArray(result.guides) ? result.guides : []))
          .catch(() => {})
      }
      const recoverConflict = (cause) => {
        // 写路径 409（CHAT_REVISION_CONFLICT）：聊天在服务端被并发推进，重取
        // guides + 强刷本地聊天快照后让用户重试。
        if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
          void reloadGuides()
          void loadChat(binding.character, binding.chatId, true).catch(() => {})
        }
      }
      const add = () => {
        const text = draft.trim()
        if (!binding || guidesDisabled || text === '' || adding) return
        setAdding(true)
        setError('')
        void addChatGuide(binding.character, binding.chatId, text)
          .then((result) => {
            setGuides(Array.isArray(result.guides) ? result.guides : [])
            setDraft('')
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            recoverConflict(cause)
          })
          .finally(() => setAdding(false))
      }
      const remove = (id) => {
        if (!binding || guidesDisabled || busyId !== '') return
        setBusyId(id)
        setError('')
        void removeChatGuide(binding.character, binding.chatId, id)
          .then((result) => setGuides(Array.isArray(result.guides) ? result.guides : []))
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            recoverConflict(cause)
          })
          .finally(() => setBusyId(''))
      }
      return h('section', { className: 'dt-settings-band' },
        h('p', { className: 'dt-hint' }, t('panel.guides.hint')),
        !binding
          ? h('p', { className: 'dt-muted' }, t('panel.variables.chatLocalEmpty'))
          : guidesDisabled
            ? h('p', { className: 'dt-muted' }, t('panel.guides.unavailable'))
            : guides === null
              ? h('p', { className: 'dt-muted' }, t('nav.loading'))
              : h(React.Fragment, null,
                guides.length === 0 ? h('p', { className: 'dt-muted' }, t('panel.guides.empty')) : null,
                h('div', { className: 'dt-guide-list' }, guides.map((guide) => h('div', { key: guide.id, className: 'dt-guide-row' },
                  h('span', { className: 'dt-guide-text' }, guide.text),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconTrashOutline16),
                    'aria-label': t('panel.guides.remove'),
                    title: t('panel.guides.remove'),
                    disabled: busyId !== '' || adding,
                    onClick: () => remove(guide.id),
                  })))),
              h('div', { className: 'dt-guide-add' },
                h('div', { className: 'dt-guide-add-field' },
                  h(Input, {
                    value: draft,
                    placeholder: t('panel.guides.placeholder'),
                    disabled: adding,
                    onChange: (event) => setDraft(event.target.value),
                  })),
                h(Button, {
                  size: 'sm',
                  variant: 'primary',
                  disabled: adding || draft.trim() === '',
                  onClick: add,
                }, adding ? t('panel.guides.adding') : t('panel.guides.add')))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 剧本库管理（提案 0014 P1）：管理面板资源区，与世界书/预设库同级。列表
    // 读 GET scripts（名称/分块数/绑定卡映射）；导入走 POST script/import
    // （文件读文本或粘贴，名字默认取文件名去后缀，format 按后缀推断）；绑定/
    // 解绑写在卡 extensions 上（POST script/bind / script/unbind），改完重取
    // 列表刷新绑定映射。
    function PanelScripts() {
      const state = useTavernStore()
      const t = useTranslate()
      const [library, setLibrary] = useState(null)
      const [error, setError] = useState('')
      const [importing, setImporting] = useState(false)
      const [pasteOpen, setPasteOpen] = useState(false)
      const [pasteName, setPasteName] = useState('')
      const [pasteContent, setPasteContent] = useState('')
      const [selection, setSelection] = useState({})
      const [busyKey, setBusyKey] = useState('')
      const characters = state.bootstrap.characters || []
      const reload = () => loadScriptsLibrary()
        .then((result) => { setLibrary(result); setError(''); return result })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void reload() }, [])
      const scripts = Array.isArray(library?.scripts) ? library.scripts : []
      // 名称过滤（2026-10-21 分页 UX）：剧本库随导入增长，同款过滤模式。
      const [scriptFilter, setScriptFilter] = useState('')
      const scriptQuery = scriptFilter.trim().toLowerCase()
      const visibleScripts = scriptQuery === ''
        ? scripts
        : scripts.filter((script) => script.name.toLowerCase().includes(scriptQuery))
      const bindings = library?.bindings && typeof library.bindings === 'object' && !Array.isArray(library.bindings) ? library.bindings : {}
      const importText = (name, content, format) => {
        const trimmed = name.trim()
        if (trimmed === '' || content.trim() === '' || importing) return Promise.resolve(false)
        setImporting(true)
        setError('')
        return importScriptAsset(trimmed, content, format)
          .then(() => {
            bumpScriptsRevision()
            void reload()
            return true
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            return false
          })
          .finally(() => setImporting(false))
      }
      const bind = (scriptName) => {
        const character = selection[scriptName]
        if (!character || busyKey !== '') return
        setBusyKey(scriptName)
        setError('')
        void bindCharacterScript(character, scriptName)
          .then(() => {
            setSelection((current) => ({ ...current, [scriptName]: '' }))
            bumpScriptsRevision()
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyKey(''))
      }
      const unbind = (character) => {
        if (busyKey !== '') return
        setBusyKey(character)
        setError('')
        void unbindCharacterScript(character)
          .then(() => {
            bumpScriptsRevision()
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyKey(''))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('p', { className: 'dt-hint' }, t('scripts.hint')),
          h('div', { className: 'dt-imports' },
            h('label', { className: 'dt-upload', title: t('settings.importTitle', { name: t('scripts.importFile') }) },
              importing ? t('scripts.importing') : t('scripts.importFile'),
              h('input', {
                type: 'file',
                accept: '.txt,.md,.markdown,.epub,text/plain,text/markdown,application/epub+zip',
                disabled: importing,
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  // EPUB 走二进制（提案 0014 P2）：FileReader 读 ArrayBuffer →
                  // base64，format 'epub'（服务端解码 zip 取 spine 正文）；TXT/MD
                  // 路径不变，仍读文本按后缀推断。
                  const epub = /\.epub$/i.test(file.name)
                  void readFile(file, epub)
                    .then((content) => importText(
                      fileStem(file.name),
                      epub ? bytesToBase64(new Uint8Array(content)) : content,
                      epub ? 'epub' : (/\.md(?:own)?$/i.test(file.name) ? 'md' : 'txt'),
                    ))
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                },
              })),
            h('button', {
              type: 'button',
              className: 'dt-upload',
              onClick: () => setPasteOpen(!pasteOpen),
            }, t('scripts.paste')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('scripts.refresh'))),
          pasteOpen ? h('div', { className: 'dt-script-paste' },
            h(EditorField, { label: t('scripts.pasteName'), value: pasteName, placeholder: 'my-script.md', onChange: setPasteName }),
            h('label', { className: 'dt-editor-field dt-editor-wide' },
              h('span', { className: 'dt-label' }, t('scripts.pasteContent')),
              h('textarea', {
                value: pasteContent,
                rows: 6,
                placeholder: t('scripts.pastePlaceholder'),
                onChange: (event) => setPasteContent(event.target.value),
              })),
            h('div', { className: 'dt-imports' },
              h(Button, {
                size: 'sm',
                variant: 'primary',
                disabled: importing || pasteName.trim() === '' || pasteContent.trim() === '',
                onClick: () => {
                  // 失败保留草稿（错误显示在下方），成功才清空并收起
                  void importText(pasteName, pasteContent, undefined).then((imported) => {
                    if (imported !== true) return
                    setPasteName('')
                    setPasteContent('')
                    setPasteOpen(false)
                  })
                },
              }, importing ? t('scripts.importing') : t('scripts.pasteImport')),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => setPasteOpen(false) }, t('panel.cancel')))) : null,
          characters.length === 0 ? h('p', { className: 'dt-hint' }, t('scripts.noCharacters')) : null),
        h('section', { className: 'dt-settings-band' },
          scripts.length > 0 ? h('div', { className: 'dt-filter-row' },
            h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.filterPlaceholder'), 'aria-label': t('panel.filterPlaceholder'), value: scriptFilter, onChange: (event) => setScriptFilter(event.target.value) })) : null,
          library === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : scripts.length === 0
              ? h('p', { className: 'dt-muted' }, t('scripts.empty'))
              : visibleScripts.length === 0
                ? h('p', { className: 'dt-muted' }, t('panel.filterEmpty'))
                : h('div', { className: 'dt-script-list' }, visibleScripts.map((script) => {
                const bound = Object.keys(bindings).filter((character) => bindings[character] === script.name)
                const draft = selection[script.name] || ''
                return h('div', { key: script.name, className: 'dt-script-row' },
                  h('div', { className: 'dt-script-row-head' },
                    h('strong', { className: 'dt-script-name' }, script.name),
                    h(Pill, null, script.format === 'epub' ? 'EPUB' : script.format === 'md' ? 'md' : 'txt'),
                    h('span', { className: 'dt-script-meta' }, t('scripts.chunks', { count: script.chunkCount })),
                    h('span', { className: 'dt-script-meta' }, t('scripts.characters', { count: script.totalCharacters })),
                    h('span', { className: 'dt-script-meta' }, t('scripts.importedAt', { time: formatNovelTime(script.importedAt) }))),
                  h('div', { className: 'dt-script-bind' },
                    h('select', {
                      value: draft,
                      disabled: busyKey !== '' || characters.length === 0,
                      'aria-label': t('scripts.bindTo'),
                      onChange: (event) => setSelection((current) => ({ ...current, [script.name]: event.target.value })),
                    },
                      h('option', { key: '', value: '' }, t('scripts.bindTo')),
                      characters.map((character) => h('option', { key: character, value: character }, character))),
                    h(Button, {
                      size: 'sm',
                      variant: 'outline',
                      disabled: busyKey !== '' || draft === '',
                      onClick: () => bind(script.name),
                    }, t('scripts.bind'))),
                  bound.length > 0 ? h('div', { className: 'dt-script-bound' },
                    bound.map((character) => h('span', { key: character, className: 'dt-script-bound-chip' },
                      h('span', null, character),
                      h('button', {
                        type: 'button',
                        title: t('scripts.unbind', { name: character }),
                        'aria-label': t('scripts.unbind', { name: character }),
                        disabled: busyKey !== '',
                        onClick: () => unbind(character),
                      }, '×')))) : null)
              })),
          error ? h('p', { className: 'dt-error' }, error) : null))
    }

    // ---- AgentNovel panel surface (proposal 0005 §14.3) ----
