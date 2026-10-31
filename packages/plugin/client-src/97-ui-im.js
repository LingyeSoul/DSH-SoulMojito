    // 面板「聊天渠道」分区（提案 0024 §6.1 / §6.3，M5）：IM 三条通道的账号清单、
    // 扫码绑定、peer 绑定表与自动绑定设置。
    //
    // 只读投影全部来自 `GET im`（settings/peers/channels/qqRuntime/available/reasons），
    // 写操作全部走管理路由；任何失败都把服务端 message 原样抛到面上——静默吞掉
    // 写失败等于让面板显示一个不存在的状态。
    //
    // 扫码是单会话的：服务端 `qrBindStatus` 只保留一条活动扫描（activeQrBind），
    // 所以二维码区在卡片下方独立成带，而不是每张卡各挂一个弹窗。

    /** 扫码相位轮询间隔（提案 0024 §6.3「每 1.5s 轮询 im/bind/status」）。 */
    const IM_BIND_POLL_MS = 1500
    /** 面板数据刷新间隔：未绑定对端与通道状态在面板打开时要能自己出现。 */
    const IM_VIEW_POLL_MS = 5000
    const IM_CHANNELS = ['qq', 'weixin', 'onebot']
    const IM_TABS = ['channels', 'bindings', 'behavior', 'logs']
    /** 错误一律取 Error.message：api() 已经把服务端 message 塞进去了。 */
    function imErrorMessage(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    /**
     * 状态灯语义（§6.1）：扫码中优先于账号状态——用户正对着二维码时把卡片显示
     * 成「在线」是谎报。error/paused 优先于 online：同一通道多个账号时，坏掉
     * 的那个必须先被看见。没有账号是 unconfigured，有账号但通道没连上是 idle
     * （宿主重启后账号还在、连接还没接回来的常态）。
     */
    function imChannelTone(accounts, scanning) {
      if (scanning === true) return 'scanning'
      if (accounts.length === 0) return 'unconfigured'
      if (accounts.some((row) => row.status?.state === 'error')) return 'error'
      if (accounts.some((row) => row.status?.state === 'paused')) return 'paused'
      if (accounts.some((row) => row.status?.state === 'online')) return 'online'
      if (accounts.some((row) => row.status?.state === 'starting')) return 'starting'
      return 'idle'
    }

    /** 状态灯旁边的一行原因：error 取 message，paused 取 reason，其余留空。 */
    function imChannelReason(accounts) {
      // 与 imChannelTone 的优先级保持一致：灯是 error 时不能配一条 paused 的文案。
      for (const row of accounts) {
        if (row.status?.state === 'error' && typeof row.status.message === 'string') return row.status.message
      }
      for (const row of accounts) {
        if (row.status?.state === 'paused' && typeof row.status.reason === 'string') return row.status.reason
      }
      return ''
    }

    /** peerKey → 分段（服务端 `imPeerKeyParts` 的客户端镜像，仅供展示）。 */
    function imPeerParts(key) {
      const parts = String(key ?? '').split(':')
      if (parts.length < 4) return null
      const [channel, accountId, scope, ...rest] = parts
      if (channel === '' || accountId === '' || scope === '') return null
      return { channel, accountId, scope, peerId: rest.join(':') }
    }

    /**
     * 「共享会话」判定：同一个 sessionId 出现在多条绑定里，就是多个 peer 共用
     * 一段上下文（§3.3.1 的代价）。返回 Set，按 sessionId 判定。
     */
    function imSharedSessionIds(peers) {
      const counts = new Map()
      for (const peer of peers) {
        const sessionId = String(peer?.sessionId ?? '')
        if (sessionId === '') continue
        counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
      }
      const shared = new Set()
      for (const [sessionId, count] of counts) {
        if (count > 1) shared.add(sessionId)
      }
      return shared
    }

    /** 白名单文本域 → id 列表：逗号/换行分隔、去空、去重，保持输入顺序。 */
    function imIdList(text) {
      const seen = new Set()
      const ids = []
      for (const piece of String(text ?? '').split(/[,\n]/)) {
        const value = piece.trim()
        if (value === '' || seen.has(value)) continue
        seen.add(value)
        ids.push(value)
      }
      return ids
    }

    /**
     * 动作级忙碌判定（提案 0024 §6.4）：每组动作只锁自己，扫码在跑不该顺手禁用
     * 安装按钮。绑定组是 `bind:<channel>` + 验证码的 `verify`——验证码与扫码共用
     * 一条绑定会话，必须互斥。
     */
    function imBindBusy(busy) {
      return busy.startsWith('bind:') || busy === 'verify'
    }

    /** 绑定表行的忙碌判定：改绑/解绑共用 `peer:<key>`，一条在跑就锁住整列。 */
    function imPeerBusy(busy) {
      return busy.startsWith('peer:')
    }

    /** 绑定目标标签：优先用户给会话起的标题，其次 Tavern 绑定，最后短 id。 */
    function imSessionLabeler(bindings, sessionsById) {
      return (sessionId) => {
        const id = String(sessionId ?? '')
        if (id === '') return ''
        const binding = bindings?.[id]
        if (typeof binding?.title === 'string' && binding.title.trim() !== '') return binding.title.trim()
        if (typeof binding?.character === 'string' && binding.character !== '') {
          const chat = String(binding.chatId ?? '').replace(/\.jsonl$/i, '')
          return chat === '' ? binding.character : `${binding.character} · ${chat}`
        }
        const session = sessionsById?.[id]
        for (const candidate of [session?.title, session?.header?.title]) {
          if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
        }
        return id.length > 12 ? `${id.slice(0, 8)}…` : id
      }
    }

    /** 复制到剪贴板：没有 Clipboard API 时明确报错，不静默假装成功。 */
    function imCopyText(text) {
      const clipboard = navigator.clipboard
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
        return Promise.reject(new Error('the Clipboard API is unavailable in this context; select the text and copy it manually'))
      }
      return clipboard.writeText(text)
    }

    function ImTabs({ active, onChange }) {
      const t = useTranslate()
      return h('div', { className: 'dt-im-tabs', role: 'tablist', 'aria-label': t('im.tabs.label') },
        IM_TABS.map((tab) => h('button', {
          key: tab, id: `dt-im-tab-${tab}`, type: 'button',
          className: active === tab ? 'dt-im-tab-active' : '', role: 'tab',
          'aria-selected': active === tab, 'aria-controls': `dt-im-panel-${tab}`,
          'data-im-tab': tab, onClick: () => onChange(tab),
        }, t(`im.tabs.${tab}`))))
    }

    function PanelIm({ useSessions } = {}) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useCurrentSessionId(useSessions)
      const sessionsById = useSessions((value) => value.byId)
      const [view, setView] = useState(null)
      const [activeTab, setActiveTab] = useState('channels')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [bind, setBind] = useState(null)
      const [verifyCode, setVerifyCode] = useState('')
      const [qrFailedFor, setQrFailedFor] = useState('')
      const [endpoint, setEndpoint] = useState('')
      const [allowDraft, setAllowDraft] = useState({ private: null, group: null })
      /** 只接受最新一次 GET 的结果：绑定 POST 与 5s 轮询交错时旧响应不能覆盖新状态。 */
      const viewSeq = useRef(0)
      /** 后台轮询单飞：上一次 GET 还没回来时不再叠一个。 */
      const viewInFlight = useRef(false)

      const channels = view?.channels ?? []
      const peers = view?.peers ?? []
      const pendingPeers = view?.pendingPeers ?? []
      const settings = view?.settings ?? null
      const qqRuntime = view?.qqRuntime ?? null
      const available = view?.available === true
      const sharedSessions = imSharedSessionIds(peers)
      const sessionLabel = imSessionLabeler(state.bootstrap.state.sessionBindings, sessionsById)

      const loadView = (quiet) => {
        if (quiet && viewInFlight.current) return Promise.resolve(null)
        const seq = viewSeq.current + 1
        viewSeq.current = seq
        viewInFlight.current = true
        return api('im')
          .then((result) => {
            if (seq === viewSeq.current) setView(result)
            return result
          })
          .catch((cause) => {
            // 后台轮询失败不占用错误条：用户没发起的请求不该留下永久红字。
            if (!quiet && seq === viewSeq.current) setError(imErrorMessage(cause))
            return null
          })
          .finally(() => {
            if (seq === viewSeq.current) viewInFlight.current = false
          })
      }
      const reloadView = () => loadView(false)

      useEffect(() => { void reloadView() }, [])
      // 面板打开期间定时刷新：对端发来消息后会出现在「未绑定对端」，用户不必
      // 关掉再打开面板才知道有新的待绑定对话。页面隐藏时不打请求。
      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadView(true)
        }, IM_VIEW_POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const applyBindStatus = (status) => {
        if (status.phase === 'idle') {
          setBind(null)
          setVerifyCode('')
          setQrFailedFor('')
          setNotice(t('im.bindDone'))
          void reloadView()
          return
        }
        setBind((current) => current === null ? current : { ...current, ...status })
      }

      // 相位轮询：只在等待/验证码/落库三个活动相位里跑，idle/failed 立刻停表。
      const bindChannel = bind?.channel ?? ''
      const bindRunning = bind !== null
        && (bind.phase === 'waiting' || bind.phase === 'verify' || bind.phase === 'saving')
      useEffect(() => {
        if (!bindRunning) return undefined
        let stopped = false
        const timer = setInterval(() => {
          void api('im/bind/status')
            .then((status) => { if (!stopped) applyBindStatus(status) })
            .catch((cause) => { if (!stopped) setError(imErrorMessage(cause)) })
        }, IM_BIND_POLL_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [bindRunning, bindChannel])

      /**
       * 只清自己那把锁：两个动作并行时（例如安装 + 扫码），先结束的那个不能替
       * 后一个解锁，否则按钮会在轮询仍在跑时重新可点。
       */
      const releaseBusy = (key) => setBusy((current) => (current === key ? '' : current))

      const startBind = (channel) => {
        setError('')
        setNotice('')
        setBusy(`bind:${channel}`)
        void api('im/bind/start', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ channel }),
        })
          .then((status) => {
            setQrFailedFor('')
            setVerifyCode('')
            setBind({ channel, ...status })
          })
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy(`bind:${channel}`))
      }

      const submitVerify = () => {
        const code = verifyCode.trim()
        if (code === '') return
        setError('')
        setBusy('verify')
        void api('im/bind/verify', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ code }),
        })
          .then((status) => {
            // 服务端收下验证码后继续轮询；清空输入框，判断错误时提示会换成
            // 「验证码不正确」，用户直接重输而不是拿旧值再提交一遍。
            setVerifyCode('')
            applyBindStatus(status)
          })
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy('verify'))
      }

      const cancelBind = () => {
        setError('')
        setBusy('bind:cancel')
        void api('im/bind/cancel', { method: 'POST', headers: jsonHeaders(), body: '{}' })
          .then(() => {
            setBind(null)
            setVerifyCode('')
            setQrFailedFor('')
            setNotice('')
          })
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy('bind:cancel'))
      }

      const createOneBot = (accountId, token) => {
        setError('')
        setNotice('')
        setBusy('account:onebot')
        return api('im/accounts', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ channel: 'onebot', accountId, secret: { token } }),
        })
          .then(async () => {
            await reloadView()
            setEndpoint(accountId)
            setNotice(t('im.onebot.created'))
            return true
          })
          .catch((cause) => {
            setError(imErrorMessage(cause))
            return false
          })
          .finally(() => releaseBusy('account:onebot'))
      }

      const removeAccount = (channel, accountId) => {
        if (!window.confirm(t('im.accountRemoveConfirm', { id: accountId }))) return
        setError('')
        setNotice('')
        setBusy(`remove:${channel}:${accountId}`)
        void api(`im/accounts?channel=${encodeURIComponent(channel)}&accountId=${encodeURIComponent(accountId)}`, { method: 'DELETE' })
          .then(() => reloadView())
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy(`remove:${channel}:${accountId}`))
      }

      // 腾讯包一键安装：面板永不展示 shell 命令，按钮就是唯一入口。409 是「已有
      // 一次安装在进行」（并发点击/另一个标签页），400 带服务端的失败原文——两条都
      // 必须原样落到面上，吞掉就等于让用户对着一个没反应的按钮发呆。
      const installQqRuntime = () => {
        setError('')
        setNotice('')
        setBusy('install:qq')
        void api('im/qq/install', { method: 'POST', headers: jsonHeaders(), body: '{}' })
          .then((result) => {
            setNotice(result.alreadyInstalled === true ? t('im.qqInstallAlready') : t('im.qqInstallDone'))
            return reloadView()
          })
          .catch((cause) => {
            if (cause?.status === 409) {
              setError(t('im.qqInstallBusy'))
              return
            }
            setError(t('im.qqInstallFailed', { reason: imErrorMessage(cause) }))
          })
          .finally(() => releaseBusy('install:qq'))
      }

      const saveSettings = (patch) => {
        setError('')
        setNotice('')
        setBusy('settings')
        return api('im/settings', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ settings: patch }),
        })
          .then((result) => {
            setView((current) => current === null ? current : { ...current, settings: result.settings })
            setNotice(t('im.settings.saved'))
            return true
          })
          .catch((cause) => {
            setError(imErrorMessage(cause))
            return false
          })
          .finally(() => releaseBusy('settings'))
      }

      const commitAllow = (scope) => {
        const draft = allowDraft[scope]
        if (draft === null || settings === null) return
        const field = scope === 'private' ? 'privateAllow' : 'groupAllow'
        const current = settings[field] ?? []
        const next = imIdList(draft)
        if (current.join('\u0000') === next.join('\u0000')) {
          setAllowDraft((draftState) => ({ ...draftState, [scope]: null }))
          return
        }
        // 保存失败时保留草稿：用户还得能用自己输入的那份重试，不能被服务端旧值顶掉。
        void saveSettings({ [field]: next }).then((saved) => {
          if (saved !== true) return
          setAllowDraft((draftState) => ({ ...draftState, [scope]: null }))
        })
      }

      const bindPeerToSession = (peer, sessionId) => {
        const parts = imPeerParts(peer.key)
        if (parts === null) {
          setError(`cannot parse the peer key '${peer.key}'`)
          return
        }
        const target = String(sessionId ?? '').trim()
        if (target === '') {
          setError(t('im.peers.noCurrentSession'))
          return
        }
        setError('')
        setNotice('')
        setBusy(`peer:${peer.key}`)
        void api('im/peers', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            channel: parts.channel,
            accountId: parts.accountId,
            scope: peer.scope,
            peerId: parts.peerId,
            sessionId: target,
          }),
        })
          .then((result) => {
            const preset = result?.presetSwitch
            if (preset?.applied === true) {
              setNotice(t('im.peers.presetApplied'))
            } else if (preset !== undefined) {
              const reason = String(preset.reason ?? '')
              // 会话未打开/正在跑：绑定已成功，等宿主补切；其它原因如实报错。
              if (/running|not open/i.test(reason)) setNotice(t('im.peers.presetPending'))
              else setError(t('im.peers.presetFailed', { reason }))
            }
            return reloadView()
          })
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy(`peer:${peer.key}`))
      }

      const unbindPeer = (peer) => {
        if (!window.confirm(t('im.peers.unbindConfirm', { peer: peer.key }))) return
        setError('')
        setNotice('')
        setBusy(`peer:${peer.key}`)
        void api(`im/peers?key=${encodeURIComponent(peer.key)}`, { method: 'DELETE' })
          .then(() => reloadView())
          .catch((cause) => setError(imErrorMessage(cause)))
          .finally(() => releaseBusy(`peer:${peer.key}`))
      }

      const scanningChannel = bind !== null && bind.phase !== 'failed' ? bind.channel : ''
      const cards = IM_CHANNELS.map((channel) => h(ImChannelCard, {
        key: channel,
        channel,
        accounts: channels.filter((row) => row.channel === channel),
        scanning: scanningChannel === channel,
        runtimeMissing: channel === 'qq' && qqRuntime !== null && qqRuntime.installed === false,
        disabled: !available,
        busy,
        onBind: () => startBind(channel),
        onInstall: installQqRuntime,
        onRemove: (accountId) => removeAccount(channel, accountId),
      }))

      const bindCard = bind !== null
        ? h(ImBindPanel, {
          bind,
          qrFailedFor,
          verifyCode,
          busy,
          onQrFailed: setQrFailedFor,
          onVerifyCode: setVerifyCode,
          onSubmit: submitVerify,
          onRetry: () => startBind(bind.channel),
          onCancel: cancelBind,
        })
        : null

      let tabContent
      if (activeTab === 'bindings') {
        tabContent = h(React.Fragment, null,
          h(ImPeersBand, {
            peers, pendingPeers, sharedSessions, currentSession, sessionLabel, busy,
            onRebind: bindPeerToSession, onBindPending: bindPeerToSession, onUnbind: unbindPeer,
          }),
          h(ImSettingsBand, {
            settings, allowDraft, busy, onAllowCommit: commitAllow,
            onPatch: (patch) => { void saveSettings(patch) },
            onAllowDraft: (scope, value) => setAllowDraft((current) => ({ ...current, [scope]: value })),
          }))
      } else if (activeTab === 'behavior') {
        tabContent = h(ImBehaviorBand, { settings, statuses: view?.sendStatuses ?? [], busy, onSave: saveSettings, onError: setError })
      } else if (activeTab === 'logs') {
        tabContent = h(ImLogBand, { disabled: !available, onError: setError })
      } else {
        tabContent = h(React.Fragment, null,
          h('section', { className: 'dt-settings-band dt-im-channels' },
            h('h3', null, t('im.channels')),
            h('div', { className: 'dt-im-cards' }, cards)),
          bindCard,
          h(ImOneBotBand, { endpoint, busy, disabled: !available, onCreate: createOneBot }))
      }

      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band dt-im-intro' },
          h('h3', null, t('im.hint.title')),
          h('p', { className: 'dt-hint' }, t('im.hint')),
          view === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : view.disabled === true
              ? h('p', { className: 'dt-error' }, t('im.disabled'))
              : view.available === false
                ? h('p', { className: 'dt-error' }, t('im.unavailable', { reasons: (view.reasons ?? []).join('; ') || '—' }))
                : null),
        h(ImTabs, { active: activeTab, onChange: setActiveTab }),
        h('div', {
          id: `dt-im-panel-${activeTab}`, className: 'dt-im-tabpanel', role: 'tabpanel',
          'aria-labelledby': `dt-im-tab-${activeTab}`, 'data-im-tab-panel': activeTab,
        },
        notice !== '' ? h('section', { className: 'dt-settings-band dt-im-feedback', role: 'status' }, h('p', { className: 'dt-im-notice' }, notice)) : null,
        error !== '' ? h('section', { className: 'dt-settings-band dt-im-feedback', role: 'alert' }, h('p', { className: 'dt-error' }, error)) : null,
        tabContent))
    }

    /** 一张通道卡片：状态灯 + 一行原因 + 账号清单 + 通道动作。 */
    function ImChannelCard({ channel, accounts, scanning, runtimeMissing, disabled, busy, onBind, onInstall, onRemove }) {
      const t = useTranslate()
      const tone = imChannelTone(accounts, scanning)
      const reason = imChannelReason(accounts)
      const bindLabel = channel === 'qq' ? t('im.bindStartQq') : t('im.bindStartWeixin')
      return h('div', { className: `dt-im-card dt-im-card-${tone}`, 'data-im-channel': channel, 'data-im-tone': tone },
        h('div', { className: 'dt-im-card-head' },
          h('span', { className: `dt-im-light dt-im-light-${tone}`, 'aria-hidden': 'true' }),
          h('div', { className: 'dt-im-card-title' },
            h('strong', null, t(`im.channel.${channel}`)),
            h('span', null, t(`im.state.${tone}`)))),
        reason !== '' ? h('p', { className: 'dt-im-card-reason' }, reason) : null,
        accounts.length === 0
          ? h('p', { className: 'dt-muted' }, t('im.accountsEmpty'))
          : h('div', { className: 'dt-im-accounts' }, accounts.map((row) => h('div', { key: `${row.channel}:${row.accountId}`, className: 'dt-im-account' },
            h('div', { className: 'dt-im-account-copy' },
              h('strong', null, row.label || row.accountId),
              h('span', { className: 'dt-im-monospace' }, row.accountId),
              h('span', null, `${t(`im.state.${row.status?.state ?? 'idle'}`)} · ${t('im.accountPeers', { count: row.peers ?? 0 })}`)),
            h('div', { className: 'dt-im-account-actions' },
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                disabled: disabled || busy === `remove:${channel}:${row.accountId}`,
                'aria-label': t('im.accountRemove', { id: row.accountId }),
                title: t('im.accountRemove', { id: row.accountId }),
                onClick: () => onRemove(row.accountId),
              }))))),
        channel === 'onebot'
          ? h('p', { className: 'dt-hint' }, t('im.onebotCardHint'))
          : h('div', { className: 'dt-im-card-actions' },
            h(Button, {
              size: 'sm',
              variant: 'outline',
              disabled: disabled || runtimeMissing || imBindBusy(busy),
              onClick: onBind,
            }, bindLabel)),
        runtimeMissing
          ? h('div', { className: 'dt-im-install' },
            h('p', { className: 'dt-hint' }, t('im.qqRuntimeMissing')),
            h(Button, {
              size: 'sm',
              variant: 'primary',
              disabled: disabled || busy === 'install:qq',
              onClick: onInstall,
            }, busy === 'install:qq' ? t('im.log.installing') : t('im.qqInstall')))
          : null)
    }

    /**
     * OneBot 11 端点：账号 id + token → 反向 WS 地址与填写指引。地址是固定
     * 路由（服务端按 token 认账号），所以建完一个账号就能照着填。
     */
    function ImOneBotBand({ endpoint, busy, disabled, onCreate }) {
      const t = useTranslate()
      const [accountId, setAccountId] = useState('')
      const [token, setToken] = useState('')
      const [copied, setCopied] = useState(false)
      const [copyError, setCopyError] = useState('')
      const wsUrl = `${location.origin}${API}/im/onebot/ws`
      const submit = () => {
        const id = accountId.trim()
        const secret = token.trim()
        if (id === '' || secret === '') return
        void onCreate(id, secret).then((saved) => {
          if (saved) {
            setAccountId('')
            setToken('')
            setCopied(false)
          }
        })
      }
      const copy = () => {
        setCopyError('')
        void imCopyText(wsUrl)
          .then(() => setCopied(true))
          .catch((cause) => setCopyError(imErrorMessage(cause)))
      }
      return h('section', { className: 'dt-settings-band dt-im-onebot' },
        h('h3', null, t('im.onebot.title')),
        h('p', { className: 'dt-hint' }, t('im.onebot.hint')),
        h('div', { className: 'dt-im-form' },
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('im.onebot.accountId')),
            h('input', {
              type: 'text',
              value: accountId,
              'aria-label': t('im.onebot.accountId'),
              onChange: (event) => setAccountId(event.target.value),
            })),
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('im.onebot.token')),
            h('input', {
              type: 'password',
              value: token,
              'aria-label': t('im.onebot.token'),
              onChange: (event) => setToken(event.target.value),
            })),
          h(Button, {
            size: 'sm',
            variant: 'primary',
            disabled: disabled || busy === 'account:onebot' || accountId.trim() === '' || token.trim() === '',
            onClick: submit,
          }, busy === 'account:onebot' ? t('im.onebot.creating') : t('im.onebot.create'))),
        endpoint === ''
          ? null
          : h('div', { className: 'dt-im-endpoint' },
            h('p', { className: 'dt-label' }, t('im.onebot.ws')),
            h('div', { className: 'dt-im-url' },
              h('code', { className: 'dt-im-monospace dt-im-ws' }, wsUrl),
              h(Button, { size: 'sm', variant: 'ghost', disabled: copied, onClick: copy }, copied ? t('im.copied') : t('im.copy'))),
            h('p', { className: 'dt-hint' }, t('im.onebot.wsHint', { account: endpoint })),
            h('p', { className: 'dt-hint' }, t('im.onebot.upstream')),
            copyError !== '' ? h('p', { className: 'dt-error' }, copyError) : null))
    }

    /** 绑定表 + 未绑定待办：对端 → 原生会话；未绑定的显示在最上面。 */
    function ImPeersBand({ peers, pendingPeers, sharedSessions, currentSession, sessionLabel, busy, onRebind, onBindPending, onUnbind }) {
      const t = useTranslate()
      const current = typeof currentSession === 'string' ? currentSession : ''
      const empty = peers.length === 0 && pendingPeers.length === 0
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('im.peers.title')),
        h('p', { className: 'dt-hint' }, t('im.peers.hint')),
        pendingPeers.length > 0
          ? h('div', { className: 'dt-im-pending' },
            h('h4', null, t('im.pending.title')),
            h('p', { className: 'dt-hint' }, current === '' ? t('im.peers.noCurrentSession') : t('im.pending.hint')),
            pendingPeers.map((peer) => h('div', { key: peer.key, className: 'dt-im-pending-row', 'data-im-pending': peer.key },
              h('div', { className: 'dt-im-pending-copy' },
                h('code', { className: 'dt-im-peer-key' }, peer.alias),
                h('span', null, `${t(`im.channel.${peer.channel}`)} · ${t(peer.scope === 'group' ? 'im.scope.group' : 'im.scope.private')}${peer.senderName === undefined ? '' : ` · ${peer.senderName}`}`),
                h('span', { className: 'dt-hint' }, t('im.pending.lastAt', { at: new Date(peer.lastAt).toLocaleString() }))),
              h(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: imPeerBusy(busy) || current === '',
                onClick: () => onBindPending(peer, current),
              }, t('im.pending.bind')))))
          : null,
        empty
          ? h('div', null,
            h('p', { className: 'dt-muted' }, t('im.peers.empty')),
            h('p', { className: 'dt-hint' }, t('im.peers.emptyHint')))
          : h('div', { className: 'dt-im-peers' }, peers.map((peer) => h(ImPeerRow, {
            key: peer.key,
            peer,
            shared: sharedSessions.has(peer.sessionId),
            currentSession: current,
            sessionLabel,
            disabled: imPeerBusy(busy),
            onRebind,
            onUnbind,
          }))))
    }

    function ImPeerRow({ peer, shared, currentSession, sessionLabel, disabled, onRebind, onUnbind }) {
      const t = useTranslate()
      const same = currentSession !== '' && peer.sessionId === currentSession
      return h('div', { className: 'dt-im-peer', 'data-im-peer': peer.key },
        h('div', { className: 'dt-im-peer-main' },
          h('div', { className: 'dt-im-peer-head' },
            h('code', { className: 'dt-im-peer-key' }, peer.key),
            h(Pill, null, t(peer.scope === 'group' ? 'im.scope.group' : 'im.scope.private')),
            shared ? h(Pill, { active: true }, t('im.peers.shared')) : null),
          h('p', { className: 'dt-im-peer-chat' },
            t('im.peers.session', { session: sessionLabel(peer.sessionId) }),
            shared ? ` · ${t('im.peers.sharedHint')}` : ''),
          peer.live === false ? h('p', { className: 'dt-hint dt-im-peer-closed' }, t('im.peers.closed')) : null,
          h('p', { className: 'dt-hint' }, t('im.peers.boundAt', { at: new Date(peer.createdAt).toLocaleString() }))),
        h('div', { className: 'dt-im-peer-actions' },
          h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: disabled || same || currentSession === '',
            onClick: () => onRebind(peer, currentSession),
          }, t('im.peers.rebindCurrent')),
          h(Button, { size: 'sm', variant: 'ghost', disabled, onClick: () => onUnbind(peer) }, t('im.peers.unbind'))))
    }

    /** 访问控制：群 @ 开关 + 两份白名单。绑定改为手动绑原生会话，不再有自动模式。 */
    function ImSettingsBand({ settings, allowDraft, busy, onPatch, onAllowDraft, onAllowCommit }) {
      const t = useTranslate()
      if (settings === null) {
        return h('section', { className: 'dt-settings-band' },
          h('h3', null, t('im.settings.title')),
          h('p', { className: 'dt-muted' }, t('nav.loading')))
      }
      const allowText = (scope) => {
        const draft = allowDraft[scope]
        if (draft !== null) return draft
        return (scope === 'private' ? settings.privateAllow : settings.groupAllow).join(', ')
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('im.settings.title')),
        h('p', { className: 'dt-hint' }, t('im.settings.hint')),
        h('div', { className: 'dt-im-settings' },
          h('div', { className: 'dt-im-mention' },
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: settings.groupRequireMention === true,
                disabled: busy === 'settings',
                onChange: (event) => onPatch({ groupRequireMention: event.target.checked }),
              }),
              h('span', null, t('im.settings.groupRequireMention'))),
            h('p', { className: 'dt-hint' }, t('im.settings.groupRequireMentionHint'))),
          h('div', { className: 'dt-im-allow' },
            h('label', { className: 'dt-field' },
              h('span', { className: 'dt-label' }, t('im.settings.privateAllow')),
              h('textarea', {
                value: allowText('private'),
                'aria-label': t('im.settings.privateAllow'),
                onChange: (event) => onAllowDraft('private', event.target.value),
                onBlur: () => onAllowCommit('private'),
              }),
              h('span', { className: 'dt-hint' }, t('im.settings.allowHint'))),
            h('label', { className: 'dt-field' },
              h('span', { className: 'dt-label' }, t('im.settings.groupAllow')),
              h('textarea', {
                value: allowText('group'),
                'aria-label': t('im.settings.groupAllow'),
                onChange: (event) => onAllowDraft('group', event.target.value),
                onBlur: () => onAllowCommit('group'),
              }),
              h('span', { className: 'dt-hint' }, t('im.settings.allowHint'))))))
    }
