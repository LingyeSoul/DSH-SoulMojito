    // 「IM 运行日志」带（提案 0024 §6.4）：服务端 500 条环形缓冲在面板上的只读视图。
    //
    // 挂载时拉一次快照（服务端默认 200 条），之后每 3s 用 `after=<nextSeq>` 拉增量：
    // 服务端 seq 单调递增，客户端只做「按 seq 去重 + 上限裁剪」。轮询失败只报一次并
    // 停表——宿主没挂 IM 运行时时每 3s 抛同一句 503，重试风暴只会把错误刷成噪音。
    // 级别过滤是纯客户端的：服务端只按 seq 增量给，切到 debug 时历史里已有的行仍在。
    const IM_LOG_POLL_MS = 3000
    const IM_LOG_CAP = 300
    const IM_LOG_LEVELS = ['all', 'debug', 'info', 'warn', 'error']
    /** 过滤按「至少这个级别」解释：选 info 时 warn/error 照样显示。 */
    const IM_LOG_RANKS = { debug: 0, info: 1, warn: 2, error: 3 }
    /** 徽标色调只借用既有 state token；debug 没有对应状态色，保持中性。 */
    const IM_LOG_TONES = { info: 'info', warn: 'warning', error: 'error' }

    /**
     * 增量合并：按 seq 去重、保持到达顺序、只留最近 `cap` 条（丢最旧的）。
     * 纯函数——返回新数组，绝不改入参（调用方靠引用变化触发重渲染）。
     */
    function imMergeLogEntries(existing, incoming, cap) {
      const merged = []
      const seen = new Set()
      for (const entry of [...existing, ...incoming]) {
        const seq = Number(entry?.seq)
        if (!Number.isFinite(seq) || seen.has(seq)) continue
        seen.add(seq)
        merged.push(entry)
      }
      return merged.length > cap ? merged.slice(merged.length - cap) : merged
    }

    /** 级别过滤：`all` 全给，其余按最低级别过滤；未知级别不隐藏任何行。 */
    function imLogFilter(entries, level) {
      if (level === 'all') return entries
      const min = IM_LOG_RANKS[level]
      if (min === undefined) return entries
      return entries.filter((entry) => (IM_LOG_RANKS[entry.level] ?? -1) >= min)
    }

    /** 本地时间 HH:MM:SS；解析不了的 ISO 串给占位符，不显示 NaN。 */
    function imLogTime(at) {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** 下一个游标：服务端 nextSeq 不可信时退回旧值，绝不把 after 写成 NaN。 */
    function imLogNextSeq(result, fallback) {
      const next = Number(result?.nextSeq)
      return Number.isFinite(next) && next >= 0 ? next : fallback
    }

    /** 日志行：本地时间 + 级别徽标 + 正文。过滤已由 ImLogBand 做完，这里只排版。 */
    function ImLogRows({ entries }) {
      return h('div', { className: 'dt-im-log-list', 'data-im-log-count': entries.length },
        entries.map((entry) => {
          const tone = IM_LOG_TONES[entry.level]
          return h('div', {
            key: `log:${entry.seq}`,
            className: `dt-im-log-row dt-im-log-row-${entry.level}`,
            'data-im-log-level': entry.level,
          },
          h('span', { className: 'dt-im-log-time' }, imLogTime(entry.at)),
          h('span', {
            className: `dt-im-log-badge dt-im-log-badge-${entry.level}`,
            ...(tone === undefined ? {} : { 'data-tone': tone }),
          }, entry.level),
          h('span', { className: 'dt-im-log-text' }, entry.text))
        }))
    }

    /**
     * 日志带本体：快照 + 3s 增量轮询 + 级别过滤 + 手动刷新/清空视图。
     * `disabled` 是宿主侧不可用（不是错误，别拿一次 503 当故障横幅）；轮询出错走
     * `onError` 交给面板统一的错误行，并把 stopped 置位——只有用户点「刷新」才重启。
     */
    function ImLogBand({ disabled, onError }) {
      const t = useTranslate()
      const [entries, setEntries] = useState([])
      const [level, setLevel] = useState('all')
      const [stopped, setStopped] = useState(false)
      const [revision, setRevision] = useState(0)
      // 游标放 ref：轮询定时器读它，但它的变化不能重建 effect（否则每次增量都重置计时）。
      const nextSeqRef = useRef(0)

      useEffect(() => {
        if (disabled || stopped) return undefined
        let cancelled = false
        let timer = null
        const append = (result) => {
          nextSeqRef.current = imLogNextSeq(result, nextSeqRef.current)
          const incoming = Array.isArray(result.entries) ? result.entries : []
          setEntries((current) => imMergeLogEntries(current, incoming, IM_LOG_CAP))
        }
        const fail = (cause) => {
          if (cancelled) return
          setStopped(true)
          onError(imErrorMessage(cause))
        }
        const poll = () => {
          void api(`im/logs?after=${nextSeqRef.current}`)
            .then((result) => { if (!cancelled) append(result) })
            .catch(fail)
        }
        void api('im/logs')
          .then((result) => {
            if (cancelled) return
            nextSeqRef.current = imLogNextSeq(result, 0)
            setEntries(imMergeLogEntries([], Array.isArray(result.entries) ? result.entries : [], IM_LOG_CAP))
            timer = setInterval(poll, IM_LOG_POLL_MS)
          })
          .catch(fail)
        return () => {
          cancelled = true
          if (timer !== null) clearInterval(timer)
        }
      }, [disabled, stopped, revision])

      // 手动刷新＝重新拉快照并重启轮询：用户显式动作，不是自动重试。
      const refresh = () => {
        setStopped(false)
        setRevision((current) => current + 1)
      }
      const visible = imLogFilter(entries, level)
      return h('section', { className: 'dt-settings-band dt-im-log' },
        h('h3', null, t('im.log.title')),
        h('div', { className: 'dt-im-log-toolbar' },
          h('div', { className: 'dt-im-log-levels' },
            h('span', { className: 'dt-label' }, t('im.log.level')),
            h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('im.log.level') },
              IM_LOG_LEVELS.map((name) => h('button', {
                key: name,
                type: 'button',
                className: level === name ? 'dt-segmented-active' : '',
                'aria-pressed': level === name,
                onClick: () => setLevel(name),
              }, name === 'all' ? t('im.log.levelAll') : name)))),
          h('div', { className: 'dt-im-log-actions' },
            h(Button, { size: 'sm', variant: 'outline', disabled, onClick: refresh }, t('im.log.refresh')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: entries.length === 0,
              onClick: () => setEntries([]),
            }, t('im.log.clear')))),
        visible.length === 0
          ? h('p', { className: 'dt-muted' }, t('im.log.empty'))
          : h(ImLogRows, { entries: visible }))
    }
