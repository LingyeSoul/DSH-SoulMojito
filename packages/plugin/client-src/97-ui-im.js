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
    const IM_CHANNELS = ['qq', 'weixin', 'onebot']
    const IM_BINDING_MODES = ['manual', 'independent', 'shared']

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

    /** 聊天引用 → 下拉值；character 可能含分隔符，用 \u0000 拼键最稳。 */
    function imChatKey(character, chatId) {
      return `${character}\u0000${chatId}`
    }

    function imChatRefFromKey(key) {
      const text = String(key ?? '')
      const at = text.indexOf('\u0000')
      if (at <= 0 || at === text.length - 1) return null
      return { character: text.slice(0, at), chatId: text.slice(at + 1) }
    }

    /** 已有聊天清单（bootstrap.characters × 已加载的 chatLists）→ 下拉选项。 */
    function imChatOptions(characters, chatLists) {
      const options = []
      const seen = new Set()
      for (const character of characters) {
        for (const chatId of chatLists?.[character] ?? []) {
          const key = imChatKey(character, chatId)
          if (seen.has(key)) continue
          seen.add(key)
          options.push({ key, character, chatId, label: `${character} / ${chatId.replace(/\.jsonl$/i, '')}` })
        }
      }
      return options
    }

    /**
     * 把一条聊天引用补进选项：绑定表里的聊天可能还没被 chatLists 加载（或已从
     * 磁盘消失），下拉里必须仍能显示当前值，否则用户看到的是「未选择」。
     */
    function imWithChatOption(options, ref) {
      if (ref === null || typeof ref.character !== 'string' || typeof ref.chatId !== 'string') return options
      const key = imChatKey(ref.character, ref.chatId)
      if (options.some((option) => option.key === key)) return options
      return [{ key, character: ref.character, chatId: ref.chatId, label: `${ref.character} / ${ref.chatId.replace(/\.jsonl$/i, '')}` }, ...options]
    }

    /** 复制到剪贴板：没有 Clipboard API 时明确报错，不静默假装成功。 */
    function imCopyText(text) {
      const clipboard = navigator.clipboard
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
        return Promise.reject(new Error('the Clipboard API is unavailable in this context; select the text and copy it manually'))
      }
      return clipboard.writeText(text)
    }

    function PanelIm() {
      const state = useTavernStore()
      const t = useTranslate()
      const [view, setView] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [bind, setBind] = useState(null)
      const [verifyCode, setVerifyCode] = useState('')
      const [qrFailedFor, setQrFailedFor] = useState('')
      const [endpoint, setEndpoint] = useState('')
      const [allowDraft, setAllowDraft] = useState({ private: null, group: null })

      const characters = state.bootstrap.characters
      const characterKey = characters.join('\u0000')
      const channels = view?.channels ?? []
      const peers = view?.peers ?? []
      const settings = view?.settings ?? null
      const qqRuntime = view?.qqRuntime ?? null
      const available = view?.available === true
      const sharedSessions = imSharedSessionIds(peers)
      const chatOptions = imChatOptions(characters, state.chatLists)

      // 改绑/来源聊天下拉要用已有聊天清单：与总览同款一次性拉取（按角色缓存）。
      // 读不出来如实报错——下拉里少了聊天等于让用户以为「没有可绑的聊天」。
      useEffect(() => {
        for (const character of characters) {
          void loadChatList(character).catch((cause) => setError(imErrorMessage(cause)))
        }
      }, [characterKey])

      const reloadView = () => api('im')
        .then((result) => { setView(result); return result })
        .catch((cause) => { setError(imErrorMessage(cause)); return null })

      useEffect(() => { void reloadView() }, [])

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

      const rebindPeer = (peer, ref) => {
        const parts = imPeerParts(peer.key)
        if (parts === null) {
          setError(`cannot parse the peer key '${peer.key}'`)
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
            character: ref.character,
            chatId: ref.chatId,
          }),
        })
          .then(() => reloadView())
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

      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('im.hint.title')),
          h('p', { className: 'dt-hint' }, t('im.hint')),
          view === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : view.disabled === true
              ? h('p', { className: 'dt-error' }, t('im.disabled'))
              : view.available === false
                ? h('p', { className: 'dt-error' }, t('im.unavailable', { reasons: (view.reasons ?? []).join('; ') || '—' }))
                : null),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('im.channels')),
          h('div', { className: 'dt-im-cards' }, cards)),
        bindCard,
        h(ImOneBotBand, { endpoint, busy, disabled: !available, onCreate: createOneBot }),
        h(ImPeersBand, {
          peers,
          sharedSessions,
          chatOptions,
          busy,
          onRebind: rebindPeer,
          onUnbind: unbindPeer,
        }),
        h(ImLogBand, { disabled: !available, onError: setError }),
        h(ImSettingsBand, {
          settings,
          chatOptions,
          allowDraft,
          busy,
          onPatch: (patch) => { void saveSettings(patch) },
          onAllowDraft: (scope, value) => setAllowDraft((current) => ({ ...current, [scope]: value })),
          onAllowCommit: commitAllow,
        }),
        notice !== '' ? h('section', { className: 'dt-settings-band' }, h('p', { className: 'dt-im-notice' }, notice)) : null,
        error !== '' ? h('section', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
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
     * 二维码的图片来源：平台有时给内容串（要编码），有时直接给图片地址。
     * 图片地址优先透传，其余用服务端渲染好的 `qrSvg`；两者都没有就退回链接。
     */
    function imLooksLikeImageUrl(value) {
      if (value === '') return false
      return /^data:image\//i.test(value) || /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(value)
    }

    function imQrSrc(bind) {
      const url = typeof bind.url === 'string' ? bind.url : ''
      if (imLooksLikeImageUrl(url)) return url
      const qrSvg = typeof bind.qrSvg === 'string' ? bind.qrSvg : ''
      return qrSvg !== '' ? qrSvg : url
    }

    /** 扫码面板：二维码 / 微信验证码 / 失败原因 + 重试。单会话共用。 */
    function ImBindPanel({ bind, qrFailedFor, verifyCode, busy, onQrFailed, onVerifyCode, onSubmit, onRetry, onCancel }) {
      const t = useTranslate()
      const src = imQrSrc(bind)
      const url = typeof bind.url === 'string' ? bind.url : ''
      const phase = bind.phase
      return h('section', { className: 'dt-settings-band dt-im-bind', 'data-im-bind-phase': phase },
        h('h3', null, t('im.bindTitle', { channel: t(`im.channel.${bind.channel}`) })),
        phase === 'failed'
          ? h('p', { className: 'dt-error' }, t('im.bindFailed', { reason: bind.reason || '—' }))
          : null,
        phase === 'verify'
          ? h('div', { className: 'dt-im-verify' },
            h('label', { className: 'dt-field' },
              h('span', { className: 'dt-label' }, t('im.bindVerify')),
              h('input', {
                type: 'text',
                inputMode: 'numeric',
                value: verifyCode,
                'aria-label': t('im.bindVerify'),
                onChange: (event) => onVerifyCode(event.target.value),
              })),
            h(Button, {
              size: 'sm',
              variant: 'primary',
              disabled: imBindBusy(busy) || verifyCode.trim() === '',
              onClick: onSubmit,
            }, busy === 'verify' ? t('im.bindSubmitting') : t('im.bindVerifySubmit')),
            h('p', { className: 'dt-hint dt-hint-wide' }, bind.prompt || t('im.bindVerifyHint')))
          : null,
        phase === 'waiting' || phase === 'saving'
          ? h('div', { className: 'dt-im-qr' },
            src !== '' && qrFailedFor !== src
              ? h('img', { src, alt: t('im.bindQrAlt'), onError: () => onQrFailed(src) })
              : null,
            src === ''
              ? h('p', { className: 'dt-muted' }, t('im.bindQrPending'))
              : h('a', {
                className: 'dt-im-qr-link',
                // 备用链接指向平台给的内容地址：图挂了还能点开它，而不是打开一张 data URL。
                href: url !== '' ? url : src,
                target: '_blank',
                rel: 'noreferrer',
              }, t('im.bindQrLink')),
            phase === 'saving'
              ? h('p', { className: 'dt-hint' }, t('im.bindSaving'))
              : h('p', { className: 'dt-hint' }, t('im.bindWaiting')))
          : null,
        h('div', { className: 'dt-im-bind-actions' },
          phase === 'failed'
            ? h(Button, { size: 'sm', variant: 'outline', disabled: imBindBusy(busy), onClick: onRetry }, t('im.bindRetry'))
            : null,
          h(Button, { size: 'sm', variant: 'ghost', disabled: imBindBusy(busy), onClick: onCancel }, t('im.bindCancel'))))
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
      return h('section', { className: 'dt-settings-band' },
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

    /** 绑定表：peer → 角色/聊天，共享会话徽标，改绑与解绑。 */
    function ImPeersBand({ peers, sharedSessions, chatOptions, busy, onRebind, onUnbind }) {
      const t = useTranslate()
      if (peers.length === 0) {
        return h('section', { className: 'dt-settings-band' },
          h('h3', null, t('im.peers.title')),
          h('p', { className: 'dt-muted' }, t('im.peers.empty')),
          h('p', { className: 'dt-hint' }, t('im.peers.emptyHint')))
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('im.peers.title')),
        h('p', { className: 'dt-hint' }, t('im.peers.hint')),
        h('div', { className: 'dt-im-peers' }, peers.map((peer) => h(ImPeerRow, {
          key: peer.key,
          peer,
          shared: sharedSessions.has(peer.sessionId),
          chatOptions,
          disabled: imPeerBusy(busy),
          onRebind,
          onUnbind,
        }))))
    }

    function ImPeerRow({ peer, shared, chatOptions, disabled, onRebind, onUnbind }) {
      const t = useTranslate()
      const [choice, setChoice] = useState('')
      const options = imWithChatOption(chatOptions, { character: peer.character, chatId: peer.chatId })
      const target = imChatRefFromKey(choice)
      return h('div', { className: 'dt-im-peer', 'data-im-peer': peer.key },
        h('div', { className: 'dt-im-peer-head' },
          h('code', { className: 'dt-im-peer-key' }, peer.key),
          h(Pill, null, t(peer.scope === 'group' ? 'im.scope.group' : 'im.scope.private')),
          shared ? h(Pill, { active: true }, t('im.peers.shared')) : null),
        h('p', { className: 'dt-im-peer-chat' },
          t('im.peers.chat', { character: peer.character, chat: peer.chatId }),
          shared ? ` · ${t('im.peers.sharedHint')}` : ''),
        h('p', { className: 'dt-hint' }, t('im.peers.boundAt', { at: new Date(peer.createdAt).toLocaleString() })),
        h('div', { className: 'dt-im-peer-actions' },
          h('select', {
            value: choice,
            'aria-label': t('im.peers.rebind'),
            onChange: (event) => setChoice(event.target.value),
          },
          h('option', { value: '' }, t('im.peers.select')),
          options.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
          h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: disabled || target === null,
            onClick: () => { if (target !== null) onRebind(peer, target) },
          }, t('im.peers.rebind')),
          h(Button, { size: 'sm', variant: 'ghost', disabled, onClick: () => onUnbind(peer) }, t('im.peers.unbind'))))
    }

    /** 自动绑定与访问控制：模式三选一 + 来源/共享聊天 + 群 @ 开关 + 两份白名单。 */
    function ImSettingsBand({ settings, chatOptions, allowDraft, busy, onPatch, onAllowDraft, onAllowCommit }) {
      const t = useTranslate()
      if (settings === null) {
        return h('section', { className: 'dt-settings-band' },
          h('h3', null, t('im.settings.title')),
          h('p', { className: 'dt-muted' }, t('nav.loading')))
      }
      const sourceKey = settings.sourceChat === undefined ? '' : imChatKey(settings.sourceChat.character, settings.sourceChat.chatId)
      const sharedKey = settings.sharedChat === undefined ? '' : imChatKey(settings.sharedChat.character, settings.sharedChat.chatId)
      const sourceOptions = imWithChatOption(chatOptions, settings.sourceChat ?? null)
      const sharedOptions = imWithChatOption(chatOptions, settings.sharedChat ?? null)
      const missing = (settings.bindingMode === 'independent' && settings.sourceChat === undefined)
        || (settings.bindingMode === 'shared' && settings.sharedChat === undefined)
      const allowText = (scope) => {
        const draft = allowDraft[scope]
        if (draft !== null) return draft
        return (scope === 'private' ? settings.privateAllow : settings.groupAllow).join(', ')
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('im.settings.title')),
        h('p', { className: 'dt-hint' }, t('im.settings.hint')),
        h('div', { className: 'dt-im-settings' },
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('im.settings.bindingMode')),
            h('select', {
              value: settings.bindingMode,
              disabled: busy === 'settings',
              onChange: (event) => onPatch({ bindingMode: event.target.value }),
            }, IM_BINDING_MODES.map((mode) => h('option', { key: mode, value: mode }, t(`im.settings.mode.${mode}`))))),
          h('p', { className: 'dt-hint' }, t(`im.settings.mode.${settings.bindingMode}Hint`)),
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('im.settings.sourceChat')),
            h('select', {
              value: sourceKey,
              disabled: busy === 'settings',
              onChange: (event) => onPatch({ sourceChat: imChatRefFromKey(event.target.value) }),
            },
            h('option', { value: '' }, t('im.settings.sourceChatNone')),
            sourceOptions.map((option) => h('option', { key: option.key, value: option.key }, option.label)))),
          h('p', { className: 'dt-hint' }, t('im.settings.sourceChatHint')),
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('im.settings.sharedChat')),
            h('select', {
              value: sharedKey,
              disabled: busy === 'settings',
              onChange: (event) => onPatch({ sharedChat: imChatRefFromKey(event.target.value) }),
            },
            h('option', { value: '' }, t('im.settings.sharedChatNone')),
            sharedOptions.map((option) => h('option', { key: option.key, value: option.key }, option.label)))),
          h('p', { className: 'dt-hint' }, t('im.settings.sharedChatHint')),
          missing ? h('p', { className: 'dt-error' }, t('im.settings.incomplete')) : null,
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings.groupRequireMention === true,
              disabled: busy === 'settings',
              onChange: (event) => onPatch({ groupRequireMention: event.target.checked }),
            }),
            h('span', null, t('im.settings.groupRequireMention'))),
          h('p', { className: 'dt-hint' }, t('im.settings.groupRequireMentionHint')),
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
