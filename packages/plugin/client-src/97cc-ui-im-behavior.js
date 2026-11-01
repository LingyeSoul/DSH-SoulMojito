// 「行为」页（决策 2026-10-31-weixin-send-queue）：微信出站间隔（500..60000ms，
    // 保存走 im/settings）+ 只读发送节奏投影（GET im 的 sendStatuses）。
    //
    // 状态行只显示服务端事实（allowedNow / nextSendAt / throttleUntil / queueDepth）；
    // 面板打开期间由既有 5s 轮询自己刷新，队列深度不会停在旧值上。
    const IM_SEND_INTERVAL_MIN_MS = 500
    const IM_SEND_INTERVAL_MAX_MS = 60000

    /** 设置里的间隔：缺省（null/undefined）回显为空，保存空串 = 清除回默认。 */
    function imSendIntervalValue(settings) {
      const raw = settings?.weixinSendIntervalMs
      return typeof raw === 'number' ? raw : null
    }

    /** 状态行的时间：解析不了的 ISO 给占位符，不显示 Invalid Date。 */
    function imStatusTime(at) {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    function ImBehaviorBand({ settings, statuses, accounts, accountOwners, accountSenders, busy, onSave, onError, onSetAccountOwner }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(null)
      if (settings === null) {
        return h('section', { className: 'dt-settings-band dt-im-behavior', 'data-im-behavior': 'band' },
          h('h3', null, t('im.behavior.title')),
          h('p', { className: 'dt-muted' }, t('nav.loading')))
      }
      const interval = imSendIntervalValue(settings)
      const value = draft !== null ? draft : (interval === null ? '' : String(interval))
      const persist = (payload) => {
        void onSave(payload).then((saved) => { if (saved) setDraft(null) })
      }
      const save = () => {
        const raw = String(value).trim()
        if (raw === '') {
          persist({ weixinSendIntervalMs: null })
          return
        }
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed < IM_SEND_INTERVAL_MIN_MS || parsed > IM_SEND_INTERVAL_MAX_MS) {
          onError(t('im.behavior.invalidInterval', { min: IM_SEND_INTERVAL_MIN_MS, max: IM_SEND_INTERVAL_MAX_MS }))
          return
        }
        persist({ weixinSendIntervalMs: parsed })
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band dt-im-behavior', 'data-im-behavior': 'band' },
          h('h3', null, t('im.behavior.title')),
          h('p', { className: 'dt-hint' }, t('im.behavior.hint')),
          h('div', { className: 'dt-im-behavior-form' },
            h('label', { className: 'dt-field' },
              h('span', { className: 'dt-label' }, t('im.behavior.interval')),
              h('input', {
                type: 'number',
                min: IM_SEND_INTERVAL_MIN_MS,
                max: IM_SEND_INTERVAL_MAX_MS,
                step: 100,
                value,
                'aria-label': t('im.behavior.interval'),
                disabled: busy === 'settings',
                onChange: (event) => setDraft(event.target.value),
              }),
              h('span', { className: 'dt-hint' }, t('im.behavior.intervalHint', { min: IM_SEND_INTERVAL_MIN_MS, max: IM_SEND_INTERVAL_MAX_MS }))),
            h(Button, {
              size: 'sm',
              variant: 'primary',
              disabled: busy === 'settings',
              onClick: save,
            }, t('im.behavior.save')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: busy === 'settings' || interval === null,
              onClick: () => persist({ weixinSendIntervalMs: null }),
            }, t('im.behavior.reset'))),
          h('h4', null, t('im.behavior.statusTitle')),
          statuses.length === 0
            ? h('p', { className: 'dt-muted' }, t('im.behavior.statusEmpty'))
            : h('div', { className: 'dt-im-behavior-status' }, statuses.map((row) => h('div', {
              key: `${row.channel}:${row.accountId}`,
              className: 'dt-im-behavior-row',
              'data-im-send-status': `${row.channel}:${row.accountId}`,
            },
            h('div', { className: 'dt-im-behavior-row-head' },
              h('strong', null, row.accountId),
              h('span', { className: 'dt-im-monospace' }, String(row.channel)),
              h(Pill, { active: row.allowedNow === true }, row.allowedNow === true ? t('im.behavior.allowedNow') : t('im.behavior.waiting'))),
            h('p', { className: 'dt-hint' },
              [
                row.nextSendAt === undefined ? null : t('im.behavior.nextSendAt', { at: imStatusTime(row.nextSendAt) }),
                row.throttleUntil === undefined ? null : t('im.behavior.throttleUntil', { at: imStatusTime(row.throttleUntil) }),
                t('im.behavior.queueDepth', { count: row.queueDepth ?? 0 }),
              ].filter((piece) => piece !== null).join(' · ')))))),
        h(ImAccountOwnerBand, {
          accounts: accounts ?? [],
          accountOwners: accountOwners ?? {},
          accountSenders: accountSenders ?? {},
          busy,
          onSetOwner: onSetAccountOwner,
        }))
    }

    /** 账号级主人键：与服务端 `imAccountKey` 同口径（`${channel}:${accountId}`）。 */
    function imAccountKeyOf(channel, accountId) {
      return `${channel}:${accountId}`
    }

    /** 全局主人展示名：昵称优先，空名回退哈希（与 per-peer 主人同口径）。 */
    function imAccountOwnerNameOf(owner, t) {
      if (owner === null || owner === undefined) return t('im.owner.globalNone')
      const name = typeof owner?.name === 'string' ? owner.name.trim() : ''
      return name !== '' ? name : String(owner?.id ?? '')
    }

    /** 账号选择器选项：该账号下所有 peer 的发言人聚合（已哈希、按时间倒序）。 */
    function imAccountOwnerOptionsOf(senders) {
      const options = []
      const seen = new Set()
      for (const entry of senders ?? []) {
        const id = typeof entry?.id === 'string' ? entry.id : ''
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
        options.push({ id, label: name !== '' ? name : id })
      }
      return options
    }

    /**
     * 「行为」页的全局主人区（决策 2026-11-01-im-global-owner-and-commands）：
     * 每个 QQ / OneBot 账号一块——当前全局主人 + 从账号发言人里选 + 清除；微信
     * 账号整块不渲染（渠道不使用主人）。下方是四个斜杠指令的只读帮助。
     */
    function ImAccountOwnerBand({ accounts, accountOwners, accountSenders, busy, onSetOwner }) {
      const t = useTranslate()
      const rows = (accounts ?? []).filter((account) => account.channel !== 'weixin')
      return h('section', { className: 'dt-settings-band dt-im-global-owner', 'data-im-global-owner': 'band' },
        h('h3', null, t('im.owner.globalTitle')),
        h('p', { className: 'dt-hint' }, t('im.owner.globalHint')),
        rows.length === 0
          ? h('p', { className: 'dt-muted' }, t('im.owner.globalEmpty'))
          : h('div', { className: 'dt-im-behavior-status' }, rows.map((account) => {
            const key = imAccountKeyOf(account.channel, account.accountId)
            const owner = accountOwners?.[key] ?? null
            const disabled = busy === `globalOwner:${key}`
            const options = imAccountOwnerOptionsOf(accountSenders?.[key])
            return h('div', { key, className: 'dt-im-behavior-row', 'data-im-global-owner': key },
              h('div', { className: 'dt-im-behavior-row-head' },
                h('strong', null, account.label || account.accountId),
                h('span', { className: 'dt-im-monospace' }, String(account.channel)),
                h(Pill, { active: owner !== null }, imAccountOwnerNameOf(owner, t))),
              options.length === 0 && owner === null
                ? null
                : h('div', { className: 'dt-im-peer-actions dt-im-owner' },
                  options.length === 0
                    ? null
                    : h('select', {
                      value: '',
                      disabled,
                      'aria-label': t('im.owner.globalPick'),
                      onChange: (event) => {
                        const value = String(event.target.value ?? '')
                        if (value === '') return
                        onSetOwner(key, value)
                      },
                    },
                      h('option', { value: '' }, t('im.owner.globalPick')),
                      options.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
                  owner !== null
                    ? h(Button, { size: 'sm', variant: 'ghost', disabled, onClick: () => onSetOwner(key, null) }, t('im.owner.globalClear'))
                    : null))
          })),
        h('h4', null, t('im.commands.title')),
        h('p', { className: 'dt-hint' }, t('im.commands.hint')),
        h('p', { className: 'dt-hint dt-im-monospace' }, t('im.commands.list')))
    }
