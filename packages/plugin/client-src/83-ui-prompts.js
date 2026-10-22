    // 提示词查看器（A-6，2026-10-11）：ST 生成循环每轮**实发请求**（pre-llm
    // hook 改写之后的最终形状）与世界书激活轨迹的只读面板。Agent 模式
    // （mode='agent-tavern'，决策 2026-10-11-agent-prompt-viewer）记录**插件
    // 预注入面**：systemPrompt 片段（agent.sections 分面展示）+ 本步注入消息
    // + 实发调用参数——宿主拼装的历史/工具上下文不可见。数据来自服务端
    // prompt-viewer.ts 的进程内环形缓冲（每聊天最近 10 条 / 总量 50，重启即失）。
    // 纯只读展示：无编辑无重放（preset 纯化重放留 v2，见 A-6 决策文档）。
    const PROMPT_POSITION_LABELS = {
      0: 'Before char', 1: 'After char', 2: 'AN top', 3: 'AN bottom',
      4: '@Depth', 5: 'EM top', 6: 'EM bottom', 7: 'Outlet',
    }
    const PROMPT_MESSAGE_PREVIEW = 600

    function promptPositionLabel(entry) {
      const label = PROMPT_POSITION_LABELS[entry.position] || `#${entry.position}`
      return entry.position === 4 ? `${label} ${entry.depth}` : label
    }

    function promptParamsLine(params) {
      return Object.entries(params || {})
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' · ')
    }

    function PromptMessageView({ message, t }) {
      const [expanded, setExpanded] = useState(false)
      const long = message.content.length > PROMPT_MESSAGE_PREVIEW
      const shown = long && !expanded
        ? `${message.content.slice(0, PROMPT_MESSAGE_PREVIEW)}…`
        : message.content
      return h('div', { className: 'dt-prompt-message' },
        h('div', { className: 'dt-prompt-message-head' },
          h('span', { className: 'dt-label' }, message.role),
          long ? h('button', {
            type: 'button',
            className: 'dt-prompt-toggle',
            onClick: () => setExpanded(!expanded),
          }, expanded ? t('settings.promptsCollapse') : t('settings.promptsExpand')) : null),
        h('pre', { className: 'dt-prompt-pre' }, shown))
    }

    function PromptRecordView({ record, t }) {
      const lore = record.loreTrace
      // Agent mode records the plugin pre-injection face (sections + messages
      // injected this step), so long text reuses the same collapse affordance.
      const agent = record.agent
      const stepSuffix = agent && (agent.turn !== undefined || agent.step !== undefined)
        ? ` · T${agent.turn ?? '?'} / S${agent.step ?? '?'}`
        : ''
      return h('details', { className: 'dt-prompt-record' },
        h('summary', null,
          `${new Date(record.at).toLocaleString()} · ${record.character} · ${record.chatId} · ${record.mode}${stepSuffix} · ~${record.promptTokens} tok · ${record.messages.length} msg`),
        agent && agent.sections.length > 0
          ? h('div', null,
              h('p', { className: 'dt-label' }, t('settings.promptsAgentSections', { count: agent.sections.length })),
              agent.sections.map((section, index) => h(PromptMessageView, {
                key: index,
                message: { role: `${section.name} · ${section.order}`, content: section.text },
                t,
              })))
          : record.system !== undefined
            ? h('details', { className: 'dt-prompt-system' },
                h('summary', null, t('settings.promptsSystem')),
                h('pre', { className: 'dt-prompt-pre' }, record.system))
            : h('p', { className: 'dt-hint' }, t('settings.promptsNoSystem')),
        h('p', { className: 'dt-label' }, t(agent ? 'settings.promptsAgentMessages' : 'settings.promptsMessages', { count: record.messages.length })),
        record.messages.map((message, index) => h(PromptMessageView, { key: index, message, t })),
        !agent && (lore && lore.entries.length > 0
          ? h('div', { className: 'dt-prompt-lore' },
              h('p', { className: 'dt-label' }, t('settings.promptsLore', {
                count: lore.entries.length, rounds: lore.recursionRounds, used: lore.budgetUsed, limit: lore.budgetLimit })),
              h('table', null,
                h('thead', null, h('tr', null,
                  ['settings.promptsWorld', 'settings.promptsEntry', 'settings.promptsKeys', 'settings.promptsPosition', 'settings.promptsProbability'].map((key) =>
                    h('th', { key }, t(key))))),
                h('tbody', null, lore.entries.map((entry, index) => h('tr', { key: index },
                  h('td', null, entry.world),
                  h('td', null,
                    `${entry.name || `#${entry.uid}`}`,
                    entry.constant ? ' · 常驻' : '',
                    entry.viaRecursion ? ' · 递归' : '',
                    ` · ${entry.reason}`),
                  h('td', null, entry.matchedKeys.join(', ') || '—'),
                  h('td', null, promptPositionLabel(entry)),
                  h('td', null,
                    entry.probability === undefined ? '—' : `${entry.probability.roll !== undefined ? `${entry.probability.roll.toFixed(1)}/` : ''}${entry.probability.value}%`),
                )))))
            : h('p', { className: 'dt-hint' }, t('settings.promptsLoreEmpty'))),
        h('p', { className: 'dt-hint' }, `${t('settings.promptsParams')}: ${promptParamsLine(record.params) || '—'}`))
    }

    function PanelPrompts() {
      const t = useTranslate()
      const state = useTavernStore()
      const [records, setRecords] = useState([])
      const [loaded, setLoaded] = useState(false)
      const [character, setCharacter] = useState('')
      const [error, setError] = useState('')
      const characters = state.bootstrap.characters || []
      const refresh = () => api(`prompts${character ? `?character=${encodeURIComponent(character)}` : ''}`)
        .then((result) => { setRecords(result.records || []); setLoaded(true); return result })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      useEffect(() => { void refresh() }, [character])
      return h('section', { className: 'dt-settings-band' },
        h('div', { className: 'dt-prompts-intro' },
          h('h3', null, t('settings.promptsTitle')),
          h('p', { className: 'dt-prompts-desc' }, t('settings.promptsHint'))),
        h('div', { className: 'dt-prompts-toolbar' },
          h('label', { className: 'dt-prompts-filter' },
            h('span', null, t('settings.character')),
            h('select', {
              value: character,
              onChange: (event) => setCharacter(event.target.value || ''),
            },
            h('option', { value: '' }, t('settings.promptsAll')),
            characters.map((name) => h('option', { key: name, value: name }, name)))),
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconRefreshOutline16), onClick: () => { setError(''); void refresh() } }, t('settings.promptsRefresh'))),
        loaded && records.length === 0 && !error
          ? h('div', { className: 'dt-panel-empty' }, h('p', null, t('settings.promptsEmpty')))
          : null,
        records.length > 0
          ? h('div', { className: 'dt-prompt-records' }, records.map((record) => h(PromptRecordView, { key: record.seq, record, t })))
          : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function ActiveSetupBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const bootstrap = state.bootstrap
      const applyPatch = (patch) => {
        setError('')
        void patchState(patch).catch((cause) => setError(cause.message))
      }
      // 压缩总结模型（提案 0006 §4.3）：选项来自宿主模型目录，值用
      // provider\u0000model 组合以免跨 provider 的同名模型撞 key；空值回落
      // 部署配置（profile patch 的 curatorProvider/Model），再回落会话模型。
      useEffect(() => { if (snapshot.models.status === 'idle') void loadModels().catch(() => {}) }, [])
      const compaction = bootstrap.state.compaction
      const compactionValue = compaction?.curatorProvider && compaction?.curatorModel
        ? `${compaction.curatorProvider}\u0000${compaction.curatorModel}` : ''
      const compactionOptions = []
      for (const group of state.models.groups ?? []) {
        for (const model of group.models ?? []) {
          compactionOptions.push({
            value: `${group.id}\u0000${model.id}`,
            label: `${group.name ?? group.id} · ${model.name ?? model.id}`,
          })
        }
      }
      const changeCompaction = (next) => {
        if (next === '') { applyPatch({ compaction: null }); return }
        const separator = next.indexOf('\u0000')
        applyPatch({
          compaction: {
            curatorProvider: next.slice(0, separator),
            curatorModel: next.slice(separator + 1),
          },
        })
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.activeSetup')),
        h('div', { className: 'dt-settings-grid' },
          h(SettingSelect, {
            label: t('settings.character'),
            value: bootstrap.state.activeCharacter,
            options: bootstrap.characters,
            empty: t('settings.characterEmpty'),
            onChange: (value) => applyPatch({ activeCharacter: value }),
          }),
          h(SettingSelect, {
            label: t('settings.preset'),
            value: bootstrap.state.activePreset,
            options: bootstrap.presets,
            empty: t('settings.presetEmpty'),
            onChange: (value) => applyPatch({ activePreset: value }),
          }),
          h(SettingSelect, {
            label: t('settings.persona'),
            value: bootstrap.state.activePersona,
            options: bootstrap.personas.map((persona) => persona.name),
            empty: t('settings.personaEmpty'),
            onChange: (value) => applyPatch({ activePersona: value }),
          }),
          h('label', { className: 'dt-field', title: t('settings.compactionModelHint') },
            h('span', { className: 'dt-label' }, t('settings.compactionModel')),
            h('select', {
              value: compactionValue,
              onChange: (event) => changeCompaction(event.target.value),
            },
              h('option', { key: '', value: '' }, t('settings.compactionModelFollow')),
              compactionOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 行为设置（2026-10-21 用户需求「改进管理面板交互」）：此前散养在各处的行为
    // 开关全部收编进这一个 band，按行为对应关系分五组——会话（新聊天架构、
    // AgentTavern 上下文、AgentTavern 预载、原生会话人设）、世界书（跟随角色卡
    // 激活）、工具写入（global 作用域）、前端与卡脚本（自动展开、外部资源、自动
    // 运行）、游戏（禁用投降）。同一个 band 双挂在面板「行为设置」分区与原生设置
    // 页（ActiveSetupBand 的双挂点先例），设置页不丢任何此前可达的开关；服务端
    // 逐次读取这些键，全部即时生效。
    function BehaviorSettingsBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const [error, setError] = useState('')
      const applyPatch = (patch) => {
        setError('')
        void patchState(patch).catch((cause) => setError(cause.message))
      }
      const behaviorGroup = (titleKey, children) => h('div', { className: 'dt-behavior-group' },
        h('h4', null, t(titleKey)),
        ...children)
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('panel.section.behavior')),
        h('p', { className: 'dt-hint' }, t('settings.behaviorHint')),
        behaviorGroup('settings.behavior.session', [
          h('div', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('settings.defaultArchitecture')),
            h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('settings.defaultArchitecture') },
              h('button', {
                type: 'button',
                className: bootstrap.state.defaultArchitecture === 'agent-tavern' ? 'dt-segmented-active' : '',
                'aria-pressed': bootstrap.state.defaultArchitecture === 'agent-tavern',
                disabled: bootstrap.agentTavern?.native?.available !== true,
                onClick: () => applyPatch({ defaultArchitecture: 'agent-tavern' }),
              }, t('settings.architectureAgent')),
              h('button', {
                type: 'button',
                className: bootstrap.state.defaultArchitecture === 'st' ? 'dt-segmented-active' : '',
                'aria-pressed': bootstrap.state.defaultArchitecture === 'st',
                onClick: () => applyPatch({ defaultArchitecture: 'st' }),
              }, t('settings.architectureSt')))),
          h('p', { className: 'dt-hint' }, t('settings.architectureHint')),
          bootstrap.state.defaultArchitecture === 'agent-tavern'
            ? h(React.Fragment, null,
              h('div', { className: 'dt-field' },
                h('span', { className: 'dt-label' }, t('settings.contextMode')),
                h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('settings.contextMode') },
                  h('button', {
                    type: 'button',
                    className: bootstrap.state.defaultContextMode === 'dsh-native' ? 'dt-segmented-active' : '',
                    'aria-pressed': bootstrap.state.defaultContextMode === 'dsh-native',
                    onClick: () => applyPatch({ defaultContextMode: 'dsh-native' }),
                  }, t('settings.contextNative')),
                  h('button', {
                    type: 'button',
                    className: bootstrap.state.defaultContextMode === 'agent-managed' ? 'dt-segmented-active' : '',
                    'aria-pressed': bootstrap.state.defaultContextMode === 'agent-managed',
                    disabled: bootstrap.agentTavern?.managed?.available !== true,
                    onClick: () => applyPatch({ defaultContextMode: 'agent-managed' }),
                  }, t('settings.contextManaged'))),
                bootstrap.agentTavern?.managed?.available !== true
                  ? h('p', { className: 'dt-hint' }, t('settings.contextManagedUnavailable', {
                    reason: bootstrap.agentTavern?.managed?.reasons?.join(' ') || 'host capability check failed',
                  }))
                  : null))
            : null,
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.agentTavernPreloadAssets === true,
              onChange: (event) => applyPatch({ agentTavernPreloadAssets: event.target.checked }),
            }),
            h('span', null, t('settings.preloadAssets'))),
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.nativeAgentPersona === true,
              onChange: (event) => applyPatch({ nativeAgentPersona: event.target.checked }),
            }),
            h('span', null, t('settings.nativePersona'))),
        ]),
        behaviorGroup('settings.behavior.worldInfo', [
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.worldFollowsCharacter !== false,
              onChange: (event) => applyPatch({ worldFollowsCharacter: event.target.checked }),
            }),
            h('span', null, t('settings.worldFollowsCharacter'))),
        ]),
        behaviorGroup('settings.behavior.toolWrites', [
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.agentTavernAllowGlobalWrites === true,
              onChange: (event) => applyPatch({ agentTavernAllowGlobalWrites: event.target.checked }),
            }),
            h('span', null, t('settings.allowGlobalWrites'))),
        ]),
        behaviorGroup('settings.behavior.frontend', [
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.frontendAutoOpen === true,
              onChange: (event) => applyPatch({ frontendAutoOpen: event.target.checked }),
            }),
            h('span', null, t('settings.frontendAutoOpen'))),
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.frontendAllowExternalResources === true,
              onChange: (event) => applyPatch({ frontendAllowExternalResources: event.target.checked }),
            }),
            h('span', null, t('settings.frontendAllowExternalResources'))),
          h('p', { className: 'dt-hint dt-frontend-warning' }, t('settings.frontendAllowExternalResourcesHint')),
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.cardScriptsAutoRun === true,
              onChange: (event) => applyPatch({ cardScriptsAutoRun: event.target.checked }),
            }),
            h('span', null, t('settings.cardScriptsAutoRun'))),
          h('p', { className: 'dt-hint dt-frontend-warning' }, t('settings.cardScriptsAutoRunHint')),
        ]),
        behaviorGroup('settings.behavior.games', [
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.gamesDisableResign === true,
              onChange: (event) => applyPatch({ gamesDisableResign: event.target.checked }),
            }),
            h('span', null, t('settings.gamesDisableResign'))),
        ]),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 自更新卡片/徽标。数据来自宿主 /update 快照：bootstrap 里带的是磁盘缓存
    // 结论（首屏立刻可显示，不打网络），点「检查更新」才穿透 TTL 打 GitHub，
    // 「立即更新」交给宿主依次尝试 dsh plugin → plugin-manager → checkout。
    // 安装期间按 1.5s 轮询宿主快照，面板关掉再打开也能恢复当前阶段。
    function updateStatusText(t, current) {
      const status = current?.status
      if (status === 'update-available') return t('update.status.available', { version: current?.remote?.version || '?' })
      if (status === 'up-to-date') return t('update.status.upToDate')
      if (status === 'local-ahead') return t('update.status.localAhead')
      if (status === 'restart-required') return t('update.status.restartRequired')
      return t('update.status.unknown')
    }

    function updateStatusClass(current) {
      const status = current?.status
      if (status === 'update-available') return 'dt-update-badge-available'
      if (status === 'restart-required') return 'dt-update-badge-pending'
      if (status === 'up-to-date') return 'dt-update-badge-current'
      return 'dt-update-badge-unknown'
    }

    function updateNotes(current) {
      const commits = current?.remote?.commits
      if (!Array.isArray(commits)) return []
      return commits.slice(0, 5).map((commit) => (commit.message ? `${commit.short} ${commit.message}` : commit.short))
    }

    function useUpdateController() {
      const state = useTavernStore()
      const [current, setCurrent] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const snapshot = current || state.bootstrap.update || null
      const installing = snapshot?.install?.running === true

      useEffect(() => {
        let cancelled = false
        void loadUpdateSnapshot()
          .then((next) => { if (!cancelled && next) setCurrent(next) })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])

      // 安装是宿主侧的后台任务：这里只轮询快照直到 running 变 false。
      useEffect(() => {
        if (!installing) return undefined
        let cancelled = false
        const timer = setInterval(() => {
          void loadUpdateSnapshot()
            .then((next) => { if (!cancelled && next) setCurrent(next) })
            .catch(() => {})
        }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [installing])

      const check = () => {
        setBusy('check')
        setError('')
        return requestUpdateCheck()
          .then((next) => { if (next) setCurrent(next) })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(''))
      }

      const install = (t) => {
        if (!window.confirm(t('update.confirm', { version: snapshot?.remote?.version || '?' }))) return
        setBusy('install')
        setError('')
        void requestUpdateInstall(false)
          .then((next) => { if (next) setCurrent(next) })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(''))
      }

      return { snapshot, busy, error, installing, check, install }
    }

    // compact：设置页标题行（状态徽标 + 按钮）；完整版：管理面板「总览」分区。
    function UpdateBand({ compact }) {
      const t = useTranslate()
      const { snapshot, busy, error, installing, check, install } = useUpdateController()
      const local = snapshot?.local || {}
      const remoteBuild = snapshot?.remote || null
      const canInstall = snapshot?.status === 'update-available' && busy === '' && !installing
      const statusLabel = updateStatusText(t, snapshot)
      const checkButton = h(Button, {
        size: 'sm',
        variant: 'outline',
        icon: h(IconRefreshOutline16),
        disabled: busy !== '' || installing,
        onClick: check,
      }, busy === 'check' ? t('update.checking') : t('update.check'))
      const installButton = h(Button, {
        size: 'sm',
        variant: 'primary',
        icon: h(IconDownloadOutline16),
        disabled: !canInstall,
        onClick: () => install(t),
      }, busy === 'install' || installing ? t('update.installing') : t('update.now'))

      if (compact) {
        return h('div', { className: 'dt-settings-update' },
          h('span', { className: `dt-update-badge ${updateStatusClass(snapshot)}` }, statusLabel),
          checkButton,
          snapshot?.status === 'update-available' || installing ? installButton : null,
          error ? h('span', { className: 'dt-error' }, error) : null)
      }

      const notes = updateNotes(snapshot)
      const installState = snapshot?.install || {}
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('update.title')),
        h('div', { className: 'dt-update-row' },
          h('span', { className: `dt-update-badge ${updateStatusClass(snapshot)}` }, statusLabel),
          h('span', { className: 'dt-update-stamp' }, t('update.current', {
            version: local.version || '?',
            commit: local.commit && local.commit !== 'unknown' ? local.commit : '?',
          })),
          remoteBuild
            ? h('span', { className: 'dt-update-stamp' }, t('update.latest', {
              version: remoteBuild.version && remoteBuild.version !== 'unknown' ? remoteBuild.version : '?',
              commit: remoteBuild.commit ? String(remoteBuild.commit).slice(0, 7) : '?',
            }))
            : null),
        notes.length > 0 && snapshot?.status === 'update-available'
          ? h('div', { className: 'dt-update-notes' },
            h('span', { className: 'dt-update-notes-title' }, t('update.notes')),
            h('ul', null, notes.map((note, index) => h('li', { key: `${index}:${note}` }, note))))
          : null,
        h('div', { className: 'dt-update-actions' }, checkButton, installButton),
        installState.message
          ? h('p', { className: installState.phase === 'failed' ? 'dt-error' : 'dt-hint' }, installState.message)
          : null,
        installState.restartRequired
          ? h('p', { className: 'dt-hint' }, t('update.restartHint'))
          : null,
        Array.isArray(installState.log) && installState.log.length > 0
          ? h('pre', { className: 'dt-update-log' }, installState.log.slice(-6).join('\n'))
          : null,
        snapshot?.checkedAt ? h('p', { className: 'dt-hint' }, t('update.checkedAt', { at: new Date(snapshot.checkedAt).toLocaleString() })) : null,
        snapshot?.error ? h('p', { className: 'dt-hint' }, t('update.remoteError', { error: snapshot.error })) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }
