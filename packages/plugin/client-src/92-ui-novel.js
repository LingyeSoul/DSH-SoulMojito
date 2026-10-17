    function novelStatusId(novel) {
      return novel?.status === 'paused' || novel?.status === 'completed' ? novel.status : 'active'
    }

    // translate() falls back to the key itself for unknown keys, so a missing
    // enum value degrades to the raw server string instead of a broken label.
    function translatedEnum(t, prefix, value) {
      const key = `${prefix}${value}`
      const label = t(key)
      return label === key ? String(value ?? '—') : label
    }

    function novelStatusLabel(t, novel) {
      return translatedEnum(t, 'novel.status.', novelStatusId(novel))
    }

    function novelPhaseLabel(t, phase) {
      return phase ? translatedEnum(t, 'novel.phase.', phase) : ''
    }

    function novelPauseReasonLabel(t, reason) {
      return reason ? translatedEnum(t, 'novel.pauseReason.', reason) : ''
    }

    function novelChapterStateLabel(t, state) {
      return state ? translatedEnum(t, 'novel.chapterState.', state) : '—'
    }

    function novelRequirementStatusLabel(t, status) {
      return translatedEnum(t, 'novel.req.status.', status)
    }

    function novelDetailText(value) {
      if (value === null || value === undefined || value === '') return ''
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }

    function formatNovelTime(value) {
      const parsed = Date.parse(value || '')
      return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : String(value || '—')
    }

    // 写手运行计数（0007 §7）：与 deduceRuns 同类的运行计数、无上限；detail 投影
    // 未暴露该字段时返回 null，面板隐藏而不显示编造的 0。多路径读取兼容
    // budget 投影（对齐 deduceRuns 的暴露位置）与 run 快照两种形态。
    function novelWriterRuns(novel) {
      const value = novel?.budget?.writerRuns ?? novel?.run?.writerRuns
      return Number.isFinite(value) ? value : null
    }

    // 用量采样（0007 §7 W0）：审计性质、非权威——客户端只如实展示实测字段，
    // 不做四分类等分析性投影。采样数组按写入顺序追加，末位即最近一条；
    // 仍以 recordedAt 兜底比较，防御乱序数据。
    function novelUsageSamples(novel) {
      const raw = novel?.usageSamples ?? novel?.run?.usageSamples ?? novel?.budget?.usageSamples
      if (!Array.isArray(raw)) return []
      return raw.filter((item) => item !== null && typeof item === 'object')
    }

    function novelLatestUsageSample(novel) {
      const samples = novelUsageSamples(novel)
      if (samples.length === 0) return null
      return samples.reduce((latest, item) => (
        Date.parse(item.recordedAt || '') > Date.parse(latest.recordedAt || '') ? item : latest
      ))
    }

    function novelToolBytesEntries(sample) {
      const raw = sample?.toolBytes
      if (raw === null || typeof raw !== 'object') return []
      return Object.entries(raw).filter(([, bytes]) => Number.isFinite(bytes))
    }

    function novelToolBytesTotal(sample) {
      return novelToolBytesEntries(sample).reduce((sum, [, bytes]) => sum + bytes, 0)
    }

    function formatNovelBytes(bytes) {
      const value = Number.isFinite(bytes) ? bytes : 0
      return `${(value / 1024).toFixed(1)} KB`
    }

    function novelCharactersText(t, novel) {
      const effective = Number(novel?.effectiveCharacters || 0).toLocaleString()
      if (novel?.targetCharacters === null || novel?.targetCharacters === undefined) {
        return t('novel.characters', { effective })
      }
      return t('novel.charactersTarget', { effective, target: Number(novel.targetCharacters).toLocaleString() })
    }

    function NovelModalFrame({ title, closeLabel, onClose, children, footer, className = '' }) {
      return h(Modal, {
        open: true,
        onClose,
        title,
        closeLabel,
        headless: true,
        className: `dt-novel-modal ${className}`.trim(),
      },
      h('div', { className: 'dt-novel-modal-head' },
        h('h2', null, title),
        h('button', {
          type: 'button',
          className: 'dt-panel-close',
          'aria-label': closeLabel,
          onClick: onClose,
        }, h(IconCloseOutline16))),
      h('div', { className: 'dt-novel-modal-body' }, children),
      footer ? h('div', { className: 'dt-novel-modal-foot' }, footer) : null)
    }

    function NovelChapters({ novel, chapterId, onSelect, t }) {
      const chapters = novel?.chapters || []
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.chaptersTitle')),
        chapters.length === 0
          ? h('p', { className: 'dt-muted' }, '—')
          : h('div', { className: 'dt-novel-toc' }, chapters.map((chapter) => h('button', {
            key: chapter.chapterId,
            type: 'button',
            className: `dt-novel-chapter ${chapterId === chapter.chapterId ? 'dt-novel-chapter-active' : ''}`,
            onClick: () => onSelect(chapter.chapterId),
          },
          h('span', { className: 'dt-novel-chapter-title', title: chapter.title || chapter.chapterId },
            `${chapter.order}. ${chapter.title || chapter.chapterId}`),
          h('span', { className: 'dt-novel-chapter-meta' },
            `${novelChapterStateLabel(t, chapter.state)} · ${Number(chapter.committedCharacters || 0).toLocaleString()}`)))))
    }

    function NovelOutlineSummaryBlock({ novel, t }) {
      const summary = novel?.outlineSummary
      if (!summary) return null
      const story = summary.story || {}
      const note = (label, value) => value
        ? h('p', { className: 'dt-novel-note' }, `${label}: ${value}`)
        : null
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, `${t('novel.outlineRevision')}: ${summary.outlineRevision ?? '—'}`),
        note(t('novel.storyPremise'), story.premise),
        note(t('novel.storyTheme'), story.theme),
        note(t('novel.storyEnding'), story.endingDirection),
        Array.isArray(summary.foreshadowing) && summary.foreshadowing.length > 0
          ? h('div', { className: 'dt-novel-fores' },
            h('h4', null, t('novel.foreshadowing')),
            summary.foreshadowing.map((item) => h('div', { key: item.id, className: 'dt-novel-fore' },
              h('span', null, item.description || item.id),
              h('span', { className: 'dt-novel-fore-meta' },
                `${item.status || '—'}${item.required === true ? ` · ${t('novel.foreshadowingRequired')}` : ''}`))))
          : null)
    }

    function NovelReaderBlock({ novel, chapterId, paragraphs, nextCursor, loading, error, onLoadMore, t }) {
      const chapter = (novel?.chapters || []).find((item) => item.chapterId === chapterId)
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.readerTitle')),
        chapter ? h('p', { className: 'dt-muted' },
          `${chapter.order}. ${chapter.title || chapter.chapterId} · ${novelChapterStateLabel(t, chapter.state)} · ${Number(chapter.committedCharacters || 0).toLocaleString()}`) : null,
        error ? h('p', { className: 'dt-error' }, error) : null,
        !error && paragraphs.length === 0 && !loading ? h('p', { className: 'dt-muted' }, t('novel.readerEmpty')) : null,
        h('div', { className: 'dt-novel-paragraphs' },
          paragraphs.map((paragraph) => h('p', {
            key: `${paragraph.commitId}:${paragraph.paragraphIndex}`,
            className: 'dt-novel-paragraph',
          }, paragraph.text)),
          loading ? h('p', { className: 'dt-muted' }, t('nav.loading')) : null,
          nextCursor !== null && !loading
            ? h('button', { type: 'button', className: 'dt-upload', onClick: onLoadMore }, t('novel.loadMore'))
            : null))
    }

    function NovelAuthorPanel({ novel, t, onOpenSession }) {
      const budget = novel?.budget || {}
      const target = novel?.targetCharacters ?? null
      const remaining = budget.remainingCharacters ?? null
      const requirements = Array.isArray(novel?.requirements) ? novel.requirements : []
      const config = novel?.config || {}
      const writerRuns = novelWriterRuns(novel)
      const usageSample = novelLatestUsageSample(novel)
      const usageTools = novelToolBytesEntries(usageSample)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.authorPanel')),
        h('p', { className: 'dt-hint' }, t('novel.authorHint')),
        h('button', { type: 'button', className: 'dt-upload', onClick: onOpenSession }, t('novel.authorOpenSession')),
        h('h4', null, t('novel.requirements')),
        requirements.length === 0
          ? h('p', { className: 'dt-muted' }, t('novel.requirementsEmpty'))
          : h('div', { className: 'dt-novel-reqs' }, requirements.map((item) => h('div', {
            key: item.requirementId,
            className: `dt-novel-req ${item.status === 'blocked' ? 'dt-novel-req-blocked' : ''}`,
          },
          h('div', { className: 'dt-novel-req-head' },
            h('span', { className: 'dt-novel-req-status' }, novelRequirementStatusLabel(t, item.status)),
            h('span', { className: 'dt-muted' }, `#${item.sequence ?? '—'}`)),
          h('p', { className: 'dt-novel-req-text' }, item.text || ''),
          item.effectiveLocation
            ? h('span', { className: 'dt-novel-req-meta' }, t('novel.req.effectiveAt', { location: novelDetailText(item.effectiveLocation) || '—' }))
            : null,
          item.blockedReason
            ? h('span', { className: 'dt-novel-req-meta dt-error' }, t('novel.req.blockedReason', { reason: novelDetailText(item.blockedReason) }))
            : null))),
        h('h4', null, t('novel.budgetTitle')),
        h('div', { className: 'dt-novel-kv' },
          h('span', null, target === null
            ? t('novel.lengthUnbounded')
            : t('novel.lengthTarget', { target: Number(target).toLocaleString() })),
          h('span', null, remaining === null
            ? t('novel.remainingUnbounded')
            : t('novel.remainingCharacters', { value: Number(remaining).toLocaleString() })),
          h('span', null, t('novel.runBudget', {
            used: budget.turnsRun ?? 0,
            max: budget.maxTurns ?? '—',
            deduce: budget.deduceRuns ?? 0,
            maxDeduce: budget.maxDeduceRuns ?? '—',
          })),
          writerRuns === null
            ? null
            : h('span', null, t('novel.runWriterRuns', { count: Number(writerRuns).toLocaleString() }))),
        h('h4', null, t('novel.usageSample.title')),
        usageSample === null
          ? h('p', { className: 'dt-muted' }, t('novel.usageSample.empty'))
          : h('div', { className: 'dt-novel-kv' },
            h('span', null, t('novel.usageSample.latest', {
              turn: usageSample.turn ?? '—',
              time: formatNovelTime(usageSample.recordedAt),
            })),
            h('span', null, t('novel.usageSample.toolBytesTotal', { size: formatNovelBytes(novelToolBytesTotal(usageSample)) })),
            usageTools.map(([tool, bytes]) => h('span', { key: tool },
              t('novel.usageSample.toolBytes', { tool, size: formatNovelBytes(bytes) }))),
            Number.isFinite(usageSample.writerOutputChars)
              ? h('span', null, t('novel.usageSample.writerOutput', { chars: Number(usageSample.writerOutputChars).toLocaleString() }))
              : null),
        h('p', { className: 'dt-hint' }, t('novel.usageSample.hint')),
        h('h4', null, t('novel.assets')),
        (config.characterNames?.length || 0) + (config.worldNames?.length || 0) > 0
          ? h('div', { className: 'dt-novel-kv' },
            config.characterNames?.length
              ? h('span', null, t('novel.assetsCharacters', { names: config.characterNames.join(', ') }))
              : null,
            config.worldNames?.length
              ? h('span', null, t('novel.assetsWorlds', { names: config.worldNames.join(', ') }))
              : null)
          : h('p', { className: 'dt-muted' }, t('novel.assetsNone')))
    }

    const NOVEL_BODY_PAGE_SIZE = 200

    function NovelDetail({ ctx, novelId, onBack, onChanged }) {
      const t = useTranslate()
      const [novel, setNovel] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [chapterId, setChapterId] = useState('')
      const [paragraphs, setParagraphs] = useState([])
      const [nextCursor, setNextCursor] = useState(null)
      const [bodyLoading, setBodyLoading] = useState(false)
      const [bodyError, setBodyError] = useState('')
      const [bodyNonce, setBodyNonce] = useState(0)
      const [outline, setOutline] = useState(null)
      const [outlineError, setOutlineError] = useState('')
      const [outlineOpen, setOutlineOpen] = useState(false)
      const [approveRevision, setApproveRevision] = useState('')
      const syncedRevisionRef = useRef(null)
      const loadDetail = () => fetchNovelDetail(novelId)
        .then((next) => {
          setNovel(next)
          setError('')
          const revision = next?.outlineSummary?.outlineRevision
          if (revision !== undefined && revision !== null && syncedRevisionRef.current !== revision) {
            syncedRevisionRef.current = revision
            setApproveRevision(String(revision))
          }
          return next
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void loadDetail() }, [novelId])
      useEffect(() => {
        if (!novel) return
        const chapters = novel.chapters || []
        if (chapters.length === 0) {
          if (chapterId !== '') setChapterId('')
          return
        }
        if (chapters.some((chapter) => chapter.chapterId === chapterId)) return
        const firstWithBody = chapters.find((chapter) => Number(chapter.committedCharacters) > 0)
        setChapterId((firstWithBody || chapters[0]).chapterId)
      }, [novel])
      useEffect(() => {
        if (!novel || chapterId === '') return
        let cancelled = false
        setBodyLoading(true)
        setBodyError('')
        setParagraphs([])
        setNextCursor(null)
        void fetchNovelBody(novelId, chapterId, null, NOVEL_BODY_PAGE_SIZE)
          .then((page) => {
            if (cancelled) return
            setParagraphs(page.paragraphs)
            setNextCursor(page.nextCursor)
          })
          .catch((cause) => { if (!cancelled) setBodyError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { if (!cancelled) setBodyLoading(false) })
        return () => { cancelled = true }
      }, [novelId, chapterId, bodyNonce])
      const loadMoreBody = () => {
        if (novel === null || chapterId === '' || bodyLoading || nextCursor === null) return
        setBodyLoading(true)
        void fetchNovelBody(novelId, chapterId, nextCursor, NOVEL_BODY_PAGE_SIZE)
          .then((page) => {
            setParagraphs((current) => [...current, ...page.paragraphs])
            setNextCursor(page.nextCursor)
          })
          .catch((cause) => setBodyError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBodyLoading(false))
      }
      const runAction = (action) => {
        if (busy) return
        setBusy(true)
        setError('')
        setNotice('')
        void Promise.resolve(action())
          .then(() => loadDetail())
          .then(() => { onChanged?.() })
          .catch((cause) => {
            if (isNovelConflict(cause)) setNotice(t('novel.conflict'))
            else setError(cause instanceof Error ? cause.message : String(cause))
            void loadDetail()
          })
          .finally(() => setBusy(false))
      }
      const approve = () => {
        const text = approveRevision.trim()
        const parsed = Number(text)
        if (text === '' || !Number.isFinite(parsed)) {
          setError(t('novel.form.invalidNumbers'))
          return
        }
        runAction(() => runNovelAction(novelId, 'approve-outline', { expectedOutlineRevision: parsed }))
      }
      const openOutline = () => {
        setOutlineOpen(true)
        setOutline(null)
        setOutlineError('')
        void fetchNovelOutline(novelId)
          .then((result) => setOutline(result))
          .catch((cause) => setOutlineError(cause instanceof Error ? cause.message : String(cause)))
      }
      if (novel === null) {
        return h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-editor-toolbar' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: onBack }, `← ${t('novel.back')}`)),
          error !== '' ? h('p', { className: 'dt-error' }, error) : h('p', { className: 'dt-muted' }, t('novel.loadingDetail')))
      }
      const awaitingApproval = novel.status === 'paused' && novel.pauseReason === 'awaiting-approval'
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-editor-toolbar' },
            h('div', { className: 'dt-editor-actions' },
              h(Button, { size: 'sm', variant: 'ghost', onClick: onBack }, `← ${t('novel.back')}`),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconRefreshOutline16),
                onClick: () => { setError(''); setNotice(''); void loadDetail().then(() => onChanged?.()) },
              }, t('novel.refresh')))),
          h('div', { className: 'dt-novel-head' },
            h('strong', { className: 'dt-novel-title-text', title: novel.title }, novel.title),
            h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatusId(novel)}` }, novelStatusLabel(t, novel)),
            novel.status === 'paused' && novel.pauseReason
              ? h('span', { className: 'dt-novel-reason' }, novelPauseReasonLabel(t, novel.pauseReason))
              : null,
            novel.phase ? h('span', { className: 'dt-muted' }, novelPhaseLabel(t, novel.phase)) : null),
          h('div', { className: 'dt-novel-meta' },
            h('span', null, t('novel.chapters', { completed: novel.chaptersCompleted ?? 0, total: novel.chaptersTotal ?? 0 })),
            h('span', null, novelCharactersText(t, novel)),
            novel.updatedAt ? h('span', null, t('novel.updatedAt', { time: formatNovelTime(novel.updatedAt) })) : null),
          novel.lastError ? h('p', { className: 'dt-error' }, t('novel.lastError', { message: novel.lastError })) : null,
          novel.pauseDetail ? h('p', { className: 'dt-hint' }, t('novel.pauseDetail', { detail: novelDetailText(novel.pauseDetail) })) : null,
          novel.resumeHint ? h('p', { className: 'dt-hint' }, t('novel.resumeHint', { hint: novelDetailText(novel.resumeHint) })) : null,
          h('div', { className: 'dt-novel-actions' },
            h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => runAction(() => openNovelSession(ctx, novel)) }, t('novel.open')),
            novel.status === 'active'
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'pause')) }, t('novel.pause'))
              : null,
            novel.status === 'paused'
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'resume')) }, t('novel.resume'))
              : null,
            novel.status === 'active' ? h(Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                if (window.confirm(t('novel.stopConfirm', { name: novel.title }))) runAction(() => runNovelAction(novelId, 'stop'))
              },
            }, t('novel.stop')) : null,
            awaitingApproval
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'update-outline')) }, t('novel.updateOutline'))
              : null,
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconDownloadOutline16),
              'aria-label': t('novel.exportMd'),
              title: t('novel.exportMd'),
              disabled: busy,
              onClick: () => runAction(() => downloadNovelExport(novelId, 'md', novel.title)),
            }),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconDownloadOutline16),
              'aria-label': t('novel.exportZip'),
              title: t('novel.exportZip'),
              disabled: busy,
              onClick: () => runAction(() => downloadNovelExport(novelId, 'zip', novel.title)),
            }),
            h(Button, { size: 'sm', variant: 'ghost', icon: h(IconListPenOutline16), onClick: openOutline }, t('novel.showOutline'))),
          awaitingApproval ? h('div', { className: 'dt-novel-approve' },
            h('span', { className: 'dt-label' }, t('novel.outlineRevision')),
            h('input', {
              value: approveRevision,
              'aria-label': t('novel.outlineRevision'),
              onChange: (event) => setApproveRevision(event.target.value),
            }),
            h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: approve }, t('novel.approveOutline')),
            h('span', { className: 'dt-muted' }, t('novel.approveHint', { revision: novel.outlineSummary?.outlineRevision ?? '—' }))) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          notice ? h('p', { className: 'dt-muted' }, notice) : null),
        h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-novel-detail' },
            h('div', { className: 'dt-novel-col' },
              h(NovelChapters, { novel, chapterId, onSelect: setChapterId, t }),
              h(NovelOutlineSummaryBlock, { novel, t })),
            h('div', { className: 'dt-novel-col' },
              h(NovelReaderBlock, {
                novel,
                chapterId,
                paragraphs,
                nextCursor,
                loading: bodyLoading,
                error: bodyError,
                onLoadMore: loadMoreBody,
                t,
              })),
            h('div', { className: 'dt-novel-col' },
              h(NovelAuthorPanel, { novel, t, onOpenSession: () => runAction(() => openNovelSession(ctx, novel)) })))),
        outlineOpen ? h(NovelModalFrame, {
          title: t('novel.outlineTitle'),
          closeLabel: t('panel.close'),
          onClose: () => setOutlineOpen(false),
        },
        outlineError !== ''
          ? h('p', { className: 'dt-error' }, outlineError)
          : outline === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h('pre', { className: 'dt-novel-outline-pre' }, JSON.stringify(outline, null, 2))) : null)
    }

    function NovelCard({ ctx, novel, t, onDetail, onEdit, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const run = (action) => {
        if (busy) return
        setError('')
        setBusy(true)
        void Promise.resolve(action())
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => {
            setBusy(false)
            void onChanged().catch(() => {})
          })
      }
      const awaitingApproval = novel.status === 'paused' && novel.pauseReason === 'awaiting-approval'
      return h('div', { className: 'dt-novel-card' },
        h('div', { className: 'dt-novel-head' },
          h('button', { type: 'button', className: 'dt-novel-title', title: novel.title, onClick: onDetail }, novel.title),
          h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatusId(novel)}` }, novelStatusLabel(t, novel)),
          novel.status === 'paused' && novel.pauseReason
            ? h('span', { className: 'dt-novel-reason', title: novelPauseReasonLabel(t, novel.pauseReason) }, novelPauseReasonLabel(t, novel.pauseReason))
            : null,
          novel.phase ? h('span', { className: 'dt-muted' }, novelPhaseLabel(t, novel.phase)) : null),
        h('div', { className: 'dt-novel-meta' },
          h('span', null, t('novel.chapters', { completed: novel.chaptersCompleted ?? 0, total: novel.chaptersTotal ?? 0 })),
          h('span', null, novelCharactersText(t, novel)),
          novel.updatedAt ? h('span', null, t('novel.updatedAt', { time: formatNovelTime(novel.updatedAt) })) : null),
        novel.lastError ? h('p', { className: 'dt-error' }, t('novel.lastError', { message: novel.lastError })) : null,
        h('div', { className: 'dt-novel-actions' },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run(() => openNovelSession(ctx, novel)) }, t('novel.open')),
          novel.status === 'active'
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'pause')) }, t('novel.pause'))
            : null,
          novel.status === 'paused'
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'resume')) }, t('novel.resume'))
            : null,
          novel.status === 'active' ? h(Button, {
            size: 'sm',
            variant: 'ghost',
            disabled: busy,
            onClick: () => {
              if (window.confirm(t('novel.stopConfirm', { name: novel.title }))) run(() => runNovelAction(novel.novelId, 'stop'))
            },
          }, t('novel.stop')) : null,
          awaitingApproval ? h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: busy,
            onClick: () => run(async () => {
              const detail = await fetchNovelDetail(novel.novelId)
              const revision = detail?.outlineSummary?.outlineRevision
              if (revision === undefined || revision === null) throw new Error(t('novel.loadingDetail'))
              await runNovelAction(novel.novelId, 'approve-outline', { expectedOutlineRevision: revision })
            }),
          }, t('novel.approveOutline')) : null,
          awaitingApproval
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'update-outline')) }, t('novel.updateOutline'))
            : null,
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconDownloadOutline16),
            'aria-label': t('novel.exportMd'),
            title: t('novel.exportMd'),
            disabled: busy,
            onClick: () => run(() => downloadNovelExport(novel.novelId, 'md', novel.title)),
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconDownloadOutline16),
            'aria-label': t('novel.exportZip'),
            title: t('novel.exportZip'),
            disabled: busy,
            onClick: () => run(() => downloadNovelExport(novel.novelId, 'zip', novel.title)),
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconEditOutline16),
            'aria-label': t('novel.editTitle'),
            title: t('novel.editTitle'),
            disabled: busy,
            onClick: onEdit,
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconTrashOutline16),
            'aria-label': t('novel.delete', { name: novel.title }),
            title: t('novel.delete', { name: novel.title }),
            disabled: busy,
            onClick: () => {
              if (window.confirm(t('novel.deleteConfirm', { name: novel.title }))) {
                run(() => deleteNovel(novel.novelId))
              }
            },
          })),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    const NOVEL_PERSPECTIVES = ['third-person', 'first-person', 'second-person', 'mixed']
    const NOVEL_PERSPECTIVE_LABEL_KEYS = {
      'third-person': 'novel.form.perspective.third',
      'first-person': 'novel.form.perspective.first',
      'second-person': 'novel.form.perspective.second',
      mixed: 'novel.form.perspective.mixed',
    }
    // 运行预算字段描述符：创建与编辑共用同一组输入（编辑面板可改预算以应对长章节）。
    // pick/put 承载表单平铺键与 budgets 嵌套结构（externalRetry）的互转——新增预算
    // 字段只改这一张表，换算/校验/比较/默认值全部自动跟进。
    const NOVEL_BUDGET_FIELDS = [
      { key: 'maxTurns', label: 'novel.form.maxTurns', preset: '200', pick: (b) => b?.maxTurns, put: (b, v) => ({ ...b, maxTurns: v }) },
      { key: 'maxDurationMs', label: 'novel.form.maxDurationMs', preset: '3600000', pick: (b) => b?.maxDurationMs, put: (b, v) => ({ ...b, maxDurationMs: v }) },
      { key: 'stallThresholdTurns', label: 'novel.form.stallThresholdTurns', preset: '6', pick: (b) => b?.stallThresholdTurns, put: (b, v) => ({ ...b, stallThresholdTurns: v }) },
      { key: 'consecutiveFailureLimit', label: 'novel.form.consecutiveFailureLimit', preset: '3', pick: (b) => b?.consecutiveFailureLimit, put: (b, v) => ({ ...b, consecutiveFailureLimit: v }) },
      { key: 'retryMaxAttempts', label: 'novel.form.retryMaxAttempts', preset: '3', pick: (b) => b?.externalRetry?.maxAttempts, put: (b, v) => ({ ...b, externalRetry: { ...b?.externalRetry, maxAttempts: v } }) },
      { key: 'retryBackoffMs', label: 'novel.form.retryBackoffMs', preset: '2000', pick: (b) => b?.externalRetry?.backoffMs, put: (b, v) => ({ ...b, externalRetry: { ...b?.externalRetry, backoffMs: v } }) },
      { key: 'maxDeduceRuns', label: 'novel.form.maxDeduceRuns', preset: '20', pick: (b) => b?.maxDeduceRuns, put: (b, v) => ({ ...b, maxDeduceRuns: v }) },
      // 可选预算字段：留空 = 省略该键（服务端回落到 0007 §5.3 内置默认 3）。
      // optional 标记让旧快照（无此字段）的编辑面板不因空值判无效，也不会
      // 把它从既有 budgets 中抹掉——清空输入即回归默认，与全量编辑语义自洽。
      { key: 'writerDispatchLimit', label: 'novel.form.writerDispatchLimit', preset: '3', optional: true, pick: (b) => b?.writerDispatchLimit, put: (b, v) => (v === null ? { ...b } : { ...b, writerDispatchLimit: v }) },
    ]
    // 产品预设值：提交时传完整配置（提案 §4.1），内部不依赖服务端默认参数；预算默认取自字段描述符。
    const NOVEL_FORM_PRESETS = {
      targetCharacters: '20000',
      toleranceRatio: '0.1',
      ...Object.fromEntries(NOVEL_BUDGET_FIELDS.map((field) => [field.key, field.preset])),
    }

    function novelBudgetsToForm(budgets) {
      return Object.fromEntries(NOVEL_BUDGET_FIELDS.map((field) => [field.key, String(field.pick(budgets) ?? '')]))
    }

    function novelFormToBudgets(form) {
      return NOVEL_BUDGET_FIELDS.reduce((budgets, field) => field.put(budgets, parseNovelPositiveInt(form[field.key])), {})
    }

    function novelBudgetsEqual(left, right) {
      return NOVEL_BUDGET_FIELDS.every((field) => field.pick(left) === field.pick(right))
    }

    /** 表单值与快照预算双方归一化（快照经 form 往返）后比较，判定是否需要下发。 */
    function novelBudgetsChanged(form, budgets) {
      return !novelBudgetsEqual(novelFormToBudgets(form), novelFormToBudgets(novelBudgetsToForm(budgets)))
    }

    function novelFormLanguage() {
      return translate('panel.title') === MESSAGES_ZH['panel.title'] ? 'zh' : 'en'
    }

    function parseNovelPositiveInt(raw) {
      const text = String(raw ?? '').trim()
      if (!/^\d+$/.test(text)) return null
      const value = Number(text)
      return Number.isInteger(value) && value >= 1 ? value : null
    }

    function NovelCheckGrid({ label, options, selected, onToggle, emptyLabel }) {
      return h('div', { className: 'dt-novel-form-wide' },
        h('span', { className: 'dt-label' }, label),
        options.length === 0
          ? h('span', { className: 'dt-muted' }, emptyLabel)
          : h('div', { className: 'dt-check-grid' }, options.map((name) => h('label', { key: name },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(name),
              onChange: (event) => onToggle(name, event.target.checked),
            }),
            h('span', null, name)))))
    }

    function NovelCreateForm({ onClose, onCreated }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [form, setForm] = useState(() => ({
        title: '',
        requirement: '',
        language: novelFormLanguage(),
        genre: '',
        narrativePerspective: 'third-person',
        styleNotes: '',
        lengthKind: 'unbounded',
        hardMaximumCharacters: '',
        maxChapters: '',
        approvalMode: 'automatic',
        writerMode: 'inline',
        characterNames: [],
        worldNames: [],
        ...NOVEL_FORM_PRESETS,
      }))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))
      const toggleAsset = (key, name, checked) => setForm((current) => ({
        ...current,
        [key]: checked ? [...current[key], name] : current[key].filter((item) => item !== name),
      }))
      const segmented = (labelKey, value, options) => h('div', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, t(labelKey)),
        h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t(labelKey) },
          options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: value === option.value ? 'dt-segmented-active' : '',
            'aria-pressed': value === option.value,
            onClick: () => set(option.key, option.value),
          }, t(option.label)))))
      const submit = () => {
        const titleValue = form.title.trim()
        const requirementValue = form.requirement.trim()
        if (!titleValue || !requirementValue) {
          setError(t('novel.form.missingRequired'))
          return
        }
        const target = form.lengthKind === 'target' ? parseNovelPositiveInt(form.targetCharacters) : null
        const tolerance = Number(String(form.toleranceRatio).trim())
        const hardText = String(form.hardMaximumCharacters).trim()
        const hardMaximum = hardText === '' ? null : parseNovelPositiveInt(hardText)
        const maxChaptersText = String(form.maxChapters).trim()
        const maxChapters = maxChaptersText === '' ? null : parseNovelPositiveInt(form.maxChapters)
        const budgets = novelFormToBudgets(form)
        const lengthValid = form.lengthKind !== 'target'
          || (target !== null
            && Number.isFinite(tolerance) && tolerance >= 0 && tolerance < 1
            && (hardText === '' || hardMaximum !== null)
            && (hardMaximum === null || hardMaximum >= target))
        const maxChaptersValid = maxChaptersText === '' || maxChapters !== null
        if (!lengthValid || !maxChaptersValid || NOVEL_BUDGET_FIELDS.some((field) => !field.optional && field.pick(budgets) === null)) {
          setError(t('novel.form.invalidNumbers'))
          return
        }
        const config = {
          title: titleValue,
          requirement: requirementValue,
          language: form.language === 'en' ? 'en' : 'zh',
          genre: form.genre.trim(),
          narrativePerspective: form.narrativePerspective,
          styleNotes: form.styleNotes.trim(),
          lengthBudget: form.lengthKind === 'target'
            ? { kind: 'target', targetCharacters: target, toleranceRatio: tolerance, hardMaximumCharacters: hardMaximum }
            : { kind: 'unbounded' },
          maxChapters,
          approvalMode: form.approvalMode === 'manual' ? 'manual' : 'automatic',
          writerMode: form.writerMode === 'subagent' ? 'subagent' : 'inline',
          characterNames: [...form.characterNames],
          worldNames: [...form.worldNames],
          budgets,
        }
        setBusy(true)
        setError('')
        void createNovel(config)
          .then((created) => onCreated(created))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }
      return h(NovelModalFrame, {
        title: t('novel.create'),
        closeLabel: t('panel.close'),
        onClose,
        footer: h(React.Fragment, null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: busy || !form.title.trim() || !form.requirement.trim(), onClick: submit },
            busy ? t('novel.creating') : t('novel.form.submit'))),
      },
      h('div', { className: 'dt-novel-form-grid' },
        h(EditorField, { label: t('novel.form.title'), value: form.title, onChange: (value) => set('title', value) }),
        h('label', { className: 'dt-editor-field' },
          h('span', { className: 'dt-label' }, t('novel.form.language')),
          h('select', {
            value: form.language,
            'aria-label': t('novel.form.language'),
            onChange: (event) => set('language', event.target.value),
          },
          h('option', { value: 'zh' }, t('novel.form.language.zh')),
          h('option', { value: 'en' }, t('novel.form.language.en')))),
        h(EditorField, { label: t('novel.form.genre'), value: form.genre, placeholder: t('novel.form.genrePlaceholder'), onChange: (value) => set('genre', value) }),
        h('label', { className: 'dt-editor-field' },
          h('span', { className: 'dt-label' }, t('novel.form.perspective')),
          h('select', {
            value: form.narrativePerspective,
            'aria-label': t('novel.form.perspective'),
            onChange: (event) => set('narrativePerspective', event.target.value),
          },
          NOVEL_PERSPECTIVES.map((value) => h('option', { key: value, value }, t(NOVEL_PERSPECTIVE_LABEL_KEYS[value]))))),
        h(EditorField, {
          label: t('novel.form.requirement'),
          value: form.requirement,
          onChange: (value) => set('requirement', value),
          multiline: true,
          className: 'dt-novel-form-wide',
          hint: t('novel.form.requirementHint'),
        }),
        h(EditorField, {
          label: t('novel.form.styleNotes'),
          value: form.styleNotes,
          onChange: (value) => set('styleNotes', value),
          multiline: true,
          className: 'dt-novel-form-wide',
        })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.length')),
        h('div', { className: 'dt-novel-form-grid' },
          segmented('novel.form.length', form.lengthKind, [
            { key: 'lengthKind', value: 'unbounded', label: 'novel.form.length.unbounded' },
            { key: 'lengthKind', value: 'target', label: 'novel.form.length.target' },
          ]),
          form.lengthKind === 'target' ? h(React.Fragment, null,
            h(EditorField, { label: t('novel.form.targetCharacters'), value: form.targetCharacters, type: 'number', min: 1, onChange: (value) => set('targetCharacters', value) }),
            h(EditorField, { label: t('novel.form.toleranceRatio'), value: form.toleranceRatio, type: 'number', min: 0, max: 0.99, step: 0.05, onChange: (value) => set('toleranceRatio', value) }),
            h(EditorField, { label: t('novel.form.hardMaximum'), value: form.hardMaximumCharacters, type: 'number', min: 1, onChange: (value) => set('hardMaximumCharacters', value) })) : null,
          h(EditorField, { label: t('novel.form.maxChapters'), value: form.maxChapters, type: 'number', min: 1, onChange: (value) => set('maxChapters', value) }),
          segmented('novel.form.approval', form.approvalMode, [
            { key: 'approvalMode', value: 'automatic', label: 'novel.form.approval.automatic' },
            { key: 'approvalMode', value: 'manual', label: 'novel.form.approval.manual' },
          ]),
          // 写作模式（0007 §8）：与大纲批准同一控件风格；说明只描述上下文有界，
          // 不做成本承诺（账单结论等 W3 实测数据）。预设 inline 直至默认切换。
          segmented('novel.form.writerMode', form.writerMode, [
            { key: 'writerMode', value: 'inline', label: 'novel.form.writerMode.inline' },
            { key: 'writerMode', value: 'subagent', label: 'novel.form.writerMode.subagent' },
          ]),
          h('span', { className: 'dt-hint dt-novel-form-wide' }, t('novel.form.writerMode.hint')))),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.characters')),
        h(NovelCheckGrid, {
          label: t('novel.form.characters'),
          options: state.bootstrap.characters,
          selected: form.characterNames,
          onToggle: (name, checked) => toggleAsset('characterNames', name, checked),
          emptyLabel: t('nav.noCharacters'),
        }),
        h(NovelCheckGrid, {
          label: t('novel.form.worlds'),
          options: state.bootstrap.worlds,
          selected: form.worldNames,
          onToggle: (name, checked) => toggleAsset('worldNames', name, checked),
          emptyLabel: t('settings.worldsEmpty'),
        })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.budgets')),
        h('div', { className: 'dt-novel-form-grid' },
          NOVEL_BUDGET_FIELDS.map((field) => h(EditorField, {
            key: field.key,
            label: t(field.label),
            value: form[field.key],
            type: 'number',
            min: 1,
            onChange: (value) => set(field.key, value),
          })))),
      error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function NovelEditForm({ novel, onClose, onSaved }) {
      const t = useTranslate()
      const [detail, setDetail] = useState(null)
      const [title, setTitle] = useState(novel.title || '')
      const [genre, setGenre] = useState('')
      const [budgets, setBudgets] = useState(null)
      const [writerMode, setWriterMode] = useState('inline')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const applyDetail = (next) => {
        setDetail(next)
        setTitle(typeof next?.title === 'string' ? next.title : novel.title || '')
        setGenre(typeof next?.config?.genre === 'string' ? next.config.genre : '')
        setBudgets(novelBudgetsToForm(next?.config?.budgets))
        setWriterMode(next?.config?.writerMode === 'subagent' ? 'subagent' : 'inline')
      }
      useEffect(() => {
        let cancelled = false
        void fetchNovelDetail(novel.novelId)
          .then((next) => { if (!cancelled) applyDetail(next) })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
        return () => { cancelled = true }
      }, [novel.novelId])
      const setBudgetField = (key, value) => setBudgets((current) => ({ ...current, [key]: value }))
      const save = () => {
        if (busy || detail === null || budgets === null) return
        const patch = {}
        const nextTitle = title.trim()
        const nextGenre = genre.trim()
        if (nextTitle !== '' && nextTitle !== detail.title) patch.title = nextTitle
        if (nextGenre !== (detail.config?.genre ?? '')) patch.genre = nextGenre
        const parsed = novelFormToBudgets(budgets)
        if (NOVEL_BUDGET_FIELDS.some((field) => !field.optional && field.pick(parsed) === null)) {
          setError(t('novel.edit.invalidBudgets'))
          return
        }
        // 预算在 noteTurn 中从快照实时读取（§13），改完下一轮即生效；
        // 未改动的预算不下发，避免无意义的 revision 递增。
        if (novelBudgetsChanged(budgets, detail.config?.budgets)) {
          patch.budgets = parsed
        }
        // 写作模式（0007 §8）：与预算同走既有 PATCH 通道，仅在值变化时下发；
        // 切换只影响下一单元（服务端语义），面板只如实展示与提交。
        const nextWriterMode = writerMode === 'subagent' ? 'subagent' : 'inline'
        const currentWriterMode = detail.config?.writerMode === 'subagent' ? 'subagent' : 'inline'
        if (nextWriterMode !== currentWriterMode) {
          patch.writerMode = nextWriterMode
        }
        if (Object.keys(patch).length === 0) {
          onSaved()
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        void patchNovel(novel.novelId, detail.revision, patch)
          .then(() => onSaved())
          .catch((cause) => {
            if (isNovelConflict(cause)) {
              // CAS 冲突：自动重取详情并提示（契约要求），保留弹窗让用户重试。
              setNotice(t('novel.conflict'))
              void fetchNovelDetail(novel.novelId)
                .then((next) => applyDetail(next))
                .catch(() => {})
            } else {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          })
          .finally(() => setBusy(false))
      }
      return h(NovelModalFrame, {
        title: t('novel.editTitle'),
        closeLabel: t('panel.close'),
        onClose,
        footer: h(React.Fragment, null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: busy || detail === null || title.trim() === '', onClick: save },
            busy ? t('settings.importing') : t('panel.save'))),
      },
      h('div', { className: 'dt-novel-form-grid' },
        h(EditorField, { label: t('novel.form.title'), value: title, onChange: setTitle }),
        h(EditorField, { label: t('novel.genre'), value: genre, onChange: setGenre })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.budgets')),
        h('div', { className: 'dt-novel-form-grid' },
          NOVEL_BUDGET_FIELDS.map((field) => h(EditorField, {
            key: field.key,
            label: t(field.label),
            value: budgets?.[field.key] ?? '',
            type: 'number',
            min: 1,
            disabled: budgets === null,
            onChange: (value) => setBudgetField(field.key, value),
          }))),
        h('p', { className: 'dt-hint' }, t('novel.edit.budgetsHint'))),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.writerMode')),
        h('div', { className: 'dt-novel-form-grid' },
          h('div', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('novel.form.writerMode')),
            h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('novel.form.writerMode') },
              [
                { value: 'inline', label: 'novel.form.writerMode.inline' },
                { value: 'subagent', label: 'novel.form.writerMode.subagent' },
              ].map((option) => h('button', {
                key: option.value,
                type: 'button',
                className: writerMode === option.value ? 'dt-segmented-active' : '',
                'aria-pressed': writerMode === option.value,
                disabled: detail === null,
                onClick: () => setWriterMode(option.value),
              }, t(option.label)))))),
        h('p', { className: 'dt-hint' }, t('novel.form.writerMode.hint')),
        h('p', { className: 'dt-hint' }, t('novel.edit.writerModeHint'))),
      error ? h('p', { className: 'dt-error' }, error) : null,
      notice ? h('p', { className: 'dt-muted' }, notice) : null)
    }
