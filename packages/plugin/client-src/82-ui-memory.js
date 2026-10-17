    // 记忆检索（提案 0016）：混合检索 embed 端点设置 + 脱敏运行状态 + 连通性
    // 探针。GET/PUT memory/embed 与 POST memory/embed/test；key 只经 env 名引用，
    // 状态接口（configured/envResolvable/lastError/lastSuccessAt/dims）永不回
    // 传 key 明文。
    // 记忆维护（B-3，LWB maintenance 的 dsh 化）：「记忆检索」分区内的维护行——
    // 角色/聊天选择 + 手动触发 + 上次运行状态/摘要 + 待维护范围提示。POST
    // memory/maintenance（wait:false 风格）拿 runId 后按 1.5s 轮询 GET 状态
    // （与自更新安装进度同款轮询策略，不引入 SSE）。
    function MemoryMaintenanceRow() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const characters = bootstrap.characters || []
      const [character, setCharacter] = useState(bootstrap.state.activeCharacter || characters[0] || '')
      const [chatId, setChatId] = useState('')
      const [chats, setChats] = useState([])
      const [view, setView] = useState(null)
      const [starting, setStarting] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        setChatId('')
        setView(null)
        if (!character) { setChats([]); return }
        void loadChatList(character).then(setChats).catch(() => setChats([]))
      }, [character])

      const refresh = () => api(`memory/maintenance?character=${encodeURIComponent(character)}&chatId=${encodeURIComponent(chatId)}`)
        .then((result) => { setView(result); return result })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      useEffect(() => { if (!character || !chatId) return; void refresh() }, [character, chatId])
      // 运行中 1.5s 轮询；依赖只用 status 字符串（view 对象每轮换新引用）。
      useEffect(() => {
        if (!character || !chatId || !view || view.status !== 'running') return
        const timer = setInterval(() => { void refresh() }, 1500)
        return () => clearInterval(timer)
      }, [character, chatId, view && view.status])

      const start = () => {
        setStarting(true); setError('')
        api('memory/maintenance', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ character, chatId }) })
          .then(() => refresh())
          .catch((cause) => {
            // 409 单飞：另一个 run 已在跑——立刻对齐状态而不是只报错。
            if (cause.status === 409) void refresh()
            setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => setStarting(false))
      }

      const running = view !== null && view.status === 'running'
      const summary = view && view.summary
      const statusLine = view === null ? ''
        : running ? t('settings.maintenanceRunning', { runId: (view.runId || '').slice(0, 8) })
          : view.status === 'error'
            ? t('settings.maintenanceError', { message: (summary && summary.error) || (view.finishedAt || '') })
            : view.finishedAt
              ? (summary && summary.completion
                ? t('settings.maintenanceDone', {
                  at: new Date(view.finishedAt).toLocaleString(),
                  outcome: (summary && summary.outcome) || 'completed',
                  base: summary.completion.baseFloor, head: summary.completion.headFloor,
                })
                : t('settings.maintenanceDoneNoCompletion', {
                  at: new Date(view.finishedAt).toLocaleString(),
                  outcome: (summary && summary.outcome) || 'completed',
                }))
              : ''
      return h('div', { className: 'dt-settings-band' },
        h('h3', null, t('settings.maintenanceTitle')),
        h('p', { className: 'dt-hint' }, t('settings.maintenanceHint')),
        h('div', { className: 'dt-editor-grid' },
          h(SettingSelect, {
            label: t('settings.character'),
            value: character,
            options: characters,
            empty: t('settings.characterEmpty'),
            onChange: (value) => setCharacter(value || ''),
          }),
          h(SettingSelect, {
            label: t('settings.maintenanceChat'),
            value: chatId,
            options: chats,
            empty: t('settings.maintenanceChatEmpty'),
            onChange: (value) => setChatId(value || ''),
          })),
        statusLine !== '' ? h('p', { className: 'dt-hint' }, statusLine) : null,
        !running && view !== null && !error
          ? h('p', { className: 'dt-hint' },
              view.pending && view.pending.floors > 0
                ? t('settings.maintenancePending', { floors: view.pending.floors })
                : t('settings.maintenanceNothingPending'))
          : null,
        summary && !running && (summary.editGroups > 0 || summary.failedGroups > 0 || (summary.retiredReceipts || 0) > 0)
          ? h('p', { className: 'dt-hint' }, t('settings.maintenanceSummary', {
              groups: summary.editGroups, merged: summary.merged, corrected: summary.corrected,
              created: summary.created, deleted: summary.deleted, failed: summary.failedGroups,
              retired: summary.retiredReceipts || 0, requests: summary.llmRequests ?? 0, budget: summary.budget ?? 0,
            }))
          : null,
        h('div', { className: 'dt-editor-actions' },
          h(Button, {
            size: 'sm', variant: 'outline',
            disabled: starting || running || !character || !chatId,
            onClick: start,
          }, starting ? t('settings.maintenanceStarting') : t('settings.maintenanceStart'))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function MemoryRetrievalBand() {
      const t = useTranslate()
      const [loaded, setLoaded] = useState(false)
      const [draft, setDraft] = useState({ provider: 'off', baseURL: '', apiKeyEnv: '', model: '', modelDir: '', pooling: '', precision: '', dims: '', batchSize: '', timeoutMs: '' })
      const [status, setStatus] = useState(null)
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [installing, setInstalling] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // 量化精度识别（2026-10-13）：modelDir 变化后向服务端查询目录里实际可加载
      // 的精度档位（防抖），供精度下拉框选项；null = 未检出/查询失败（下拉只留
      // 「自动」，报错面交给保存/测试按钮）。
      const [quant, setQuant] = useState(null)
      const refresh = () => api('memory/embed')
        .then((result) => {
          setStatus(result.status || null)
          setDraft((current) => ({
            ...current,
            provider: result.config?.provider === 'local' ? 'local' : result.config ? 'openai' : 'off',
            baseURL: result.config?.baseURL || '',
            apiKeyEnv: result.config?.apiKeyEnv || '',
            model: result.config?.model || '',
            modelDir: result.config?.modelDir || '',
            pooling: result.config?.pooling || '',
            precision: result.config?.provider === 'local' ? (result.config.precision ?? '') : '',
            dims: result.config?.dims === undefined ? '' : String(result.config.dims),
            batchSize: result.config?.batchSize === undefined ? '' : String(result.config.batchSize),
            timeoutMs: result.config?.timeoutMs === undefined ? '' : String(result.config.timeoutMs),
          }))
          setLoaded(true)
          return result
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      useEffect(() => { void refresh() }, [])
      // 精度识别的防抖拉取：仅本地 provider 且 modelDir 非空时查询；保存成功后
      // refresh 会把 modelDir 钉成绝对路径再次触发。
      useEffect(() => {
        if (draft.provider !== 'local' || draft.modelDir.trim() === '') { setQuant(null); return undefined }
        const timer = setTimeout(() => {
          api('memory/embed/local/quantizations', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ modelDir: draft.modelDir }) })
            .then((result) => setQuant({ list: result.quantizations || [], recommended: result.recommended || '' }))
            .catch(() => setQuant(null))
        }, 500)
        return () => clearTimeout(timer)
      }, [draft.provider, draft.modelDir])
      const setField = (name, value) => setDraft((current) => ({ ...current, [name]: value }))
      const optionalInt = (value) => {
        const trimmed = String(value ?? '').trim()
        if (trimmed === '') return undefined
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? parsed : Number.NaN
      }
      const save = () => {
        setSaving(true); setError(''); setNotice('')
        const body = draft.provider === 'local'
          ? {
              provider: 'local',
              modelDir: draft.modelDir,
              ...(draft.pooling !== '' ? { pooling: draft.pooling } : {}),
              ...(draft.precision !== '' ? { precision: draft.precision } : {}),
              ...(optionalInt(draft.dims) !== undefined ? { dims: optionalInt(draft.dims) } : {}),
              ...(optionalInt(draft.batchSize) !== undefined ? { batchSize: optionalInt(draft.batchSize) } : {}),
            }
          : draft.provider === 'off'
            // 模式切到「关闭」= 清除配置（混合检索整体回落纯词法）；旧「清除」
            // 按钮的语义收进模式下拉（2026-10-13）。
            ? { baseURL: '', apiKeyEnv: '', model: '' }
            : {
                baseURL: draft.baseURL,
                apiKeyEnv: draft.apiKeyEnv,
                model: draft.model,
                ...(optionalInt(draft.dims) !== undefined ? { dims: optionalInt(draft.dims) } : {}),
                ...(optionalInt(draft.batchSize) !== undefined ? { batchSize: optionalInt(draft.batchSize) } : {}),
                ...(optionalInt(draft.timeoutMs) !== undefined ? { timeoutMs: optionalInt(draft.timeoutMs) } : {}),
              }
        return api('memory/embed', { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(body) })
          .then((result) => refresh().then(() => result))
          .then((result) => {
            // 小白项自动补全回显（提案 0017）：PUT 对缺省 pooling/dims 按模型目录
            // 推断并回报来源，这里拼成一行提示让用户看到「已自动填了什么」。
            const filled = result && result.inferred
              ? Object.entries(result.inferred).map(([key, info]) => `${key}=${info.value} (${info.source})`).join(' · ')
              : ''
            setNotice(filled === '' ? t('panel.saved') : `${t('panel.saved')} · ${t('settings.memoryAutoFilled', { items: filled })}`)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const test = () => {
        setTesting(true); setError(''); setNotice('')
        return api('memory/embed/test', { method: 'POST', headers: jsonHeaders(), body: '{}' })
          .then((result) => {
            setNotice(t('settings.memoryTestOk', { dims: result.dims ?? '?', ms: result.latencyMs ?? '?', model: result.model || '?' }))
            return refresh()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setTesting(false))
      }
      const install = () => {
        setInstalling(true); setError(''); setNotice('')
        return api('memory/embed/local/install', { method: 'POST', headers: jsonHeaders(), body: '{}' })
          .then((result) => {
            setNotice(result.alreadyInstalled === true
              ? t('settings.memoryLocalInstallAlready')
              : t('settings.memoryLocalInstallOk'))
            return refresh()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setInstalling(false))
      }
      const isLocal = status !== null && status.provider === 'local'
      const statusBits = []
      if (status !== null) {
        if (!status.configured) statusBits.push(t('settings.memoryOff'))
        else if (isLocal) {
          if (status.runtimeInstalled === false) statusBits.push(t('settings.memoryLocalRuntimeMissing'))
        } else if (status.keyless) statusBits.push(t('settings.memoryKeyless'))
        else if (!status.envResolvable) statusBits.push(t('settings.memoryEnvMissing', { name: draft.apiKeyEnv }))
        if (status.breakerOpen) statusBits.push(t('settings.memoryBreaker', { until: status.breakerUntil ? new Date(status.breakerUntil).toLocaleTimeString() : '?' }))
        if (status.lastSuccessAt) statusBits.push(t('settings.memoryLastSuccess', { at: new Date(status.lastSuccessAt).toLocaleString(), dims: status.dims ?? '?', model: status.model || '?' }))
        if (status.lastError) statusBits.push(t('settings.memoryLastError', { error: status.lastError }))
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.memoryTitle')),
        h('p', { className: 'dt-hint' }, t('settings.memoryHint')),
        loaded ? h('div', { className: 'dt-editor-grid' },
          // 模式切换下拉（2026-10-13）：关闭 / 远程端点 / 本地 ONNX 三态；「关闭」
          // 吸收了原「清除配置」按钮的语义（保存即清除，检索回落纯词法）。
          h(SettingSelect, {
            label: t('settings.memoryProvider'),
            value: draft.provider,
            options: [
              { value: 'off', label: t('settings.memoryProviderOff') },
              { value: 'openai', label: t('settings.memoryProviderOpenAI') },
              { value: 'local', label: t('settings.memoryProviderLocal') },
            ],
            onChange: (value) => setField('provider', value === 'local' || value === 'openai' ? value : 'off'),
          }),
          draft.provider === 'local' ? h(EditorField, {
            label: t('settings.memoryModelDir'), value: draft.modelDir, onChange: (value) => setField('modelDir', value),
            className: 'dt-editor-wide', hint: t('settings.memoryModelDirHint'), placeholder: 'D:\\models\\bge-small-zh-v1.5',
          }) : null,
          draft.provider === 'local' ? h(SettingSelect, {
            label: t('settings.memoryPooling'),
            value: draft.pooling,
            options: [
              { value: 'cls', label: t('settings.memoryPoolingCls') },
              { value: 'mean', label: t('settings.memoryPoolingMean') },
            ],
            empty: t('settings.memoryPoolingDefault'),
            onChange: (value) => setField('pooling', value || ''),
          }) : null,
          // 量化精度下拉（2026-10-13）：选项按模型目录智能识别（onnx/ 下的
          // model*_*.onnx 档位 + 文件大小）；「自动」带出识别出的推荐档。目录
          // 未检出当前选中档时保留该选项并标注，防 select 值悬空。
          draft.provider === 'local' ? h(SettingSelect, {
            label: t('settings.memoryPrecision'),
            value: draft.precision,
            options: [
              { value: '', label: quant !== null && quant.recommended !== ''
                ? t('settings.memoryPrecisionAutoPick', { dtype: quant.recommended.toUpperCase() })
                : t('settings.memoryPrecisionAuto') },
              ...(quant?.list || []).map((entry) => ({
                value: entry.precision,
                label: `${entry.precision.toUpperCase()} · ${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
              })),
              ...(draft.precision !== '' && !(quant?.list || []).some((entry) => entry.precision === draft.precision)
                ? [{ value: draft.precision, label: `${draft.precision.toUpperCase()} · ${t('settings.memoryPrecisionNotDetected')}` }]
                : []),
            ],
            onChange: (value) => setField('precision', value || ''),
          }) : null,
          draft.provider === 'local' ? null : h(EditorField, { label: t('settings.memoryBaseURL'), value: draft.baseURL, onChange: (value) => setField('baseURL', value), className: 'dt-editor-wide', placeholder: 'https://api.example.com/v1' }),
          draft.provider === 'local' ? null : h(EditorField, { label: t('settings.memoryModel'), value: draft.model, onChange: (value) => setField('model', value), placeholder: 'text-embedding-3-small' }),
          draft.provider === 'local' ? null : h(EditorField, { label: t('settings.memoryApiKeyEnv'), value: draft.apiKeyEnv, onChange: (value) => setField('apiKeyEnv', value), hint: t('settings.memoryApiKeyEnvHint'), placeholder: 'MY_EMBED_API_KEY' }),
          h(EditorField, { label: t('settings.memoryDims'), value: draft.dims, type: 'number', min: 1, onChange: (value) => setField('dims', value) }),
          h(EditorField, { label: t('settings.memoryBatchSize'), value: draft.batchSize, type: 'number', min: 1, max: 64, onChange: (value) => setField('batchSize', value) }),
          draft.provider === 'local' ? null : h(EditorField, { label: t('settings.memoryTimeout'), value: draft.timeoutMs, type: 'number', min: 200, onChange: (value) => setField('timeoutMs', value) })) : null,
        statusBits.length > 0 ? h('p', { className: 'dt-hint' }, statusBits.join(' · ')) : null,
        h('div', { className: 'dt-editor-actions' },
          isLocal && status.runtimeInstalled === false
            ? h(Button, {
                size: 'sm', variant: 'outline', disabled: installing || saving, onClick: install,
              }, installing ? t('settings.memoryLocalInstalling') : t('settings.memoryLocalInstall'))
            : null,
          h(Button, { size: 'sm', variant: 'primary', disabled: saving, onClick: () => save(false) }, t('settings.memorySave')),
          h(Button, { size: 'sm', variant: 'outline', disabled: testing || (status !== null && !status.configured), onClick: test }, testing ? t('settings.memoryTesting') : t('settings.memoryTest'))),
        // 记忆维护（B-3）：同分区内的维护行（角色/聊天选择 + 手动触发 + 轮询状态）。
        h(MemoryMaintenanceRow),
        notice ? h('p', { className: 'dt-hint' }, notice) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }
