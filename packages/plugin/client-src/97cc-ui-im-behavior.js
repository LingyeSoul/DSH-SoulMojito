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

    function ImBehaviorBand({ settings, statuses, busy, onSave, onError }) {
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
      return h('section', { className: 'dt-settings-band dt-im-behavior', 'data-im-behavior': 'band' },
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
            ].filter((piece) => piece !== null).join(' · '))))))
    }
