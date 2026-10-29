    // AgentTavern body operations (proposal 0021 §7): cached GET lookups and
    // the assistant-actions entry for edit / regenerate / candidate switching.
    // The server owns the ledger; this layer only asks per message and drops
    // its cache after a successful mutation so the anchor row refetches.
    const BODY_CACHE_LIMIT = 400
    const bodyCache = new Map()
    const bodyInflight = new Map()
    const bodyLocalRevisions = new Map()
    const bodyCacheListeners = new Set()
    let bodyCacheVersion = 0
    // One body group spans several native messages (one per candidate). A
    // selection change flips `hidden` on at least two of them, so cache
    // invalidation is group-scoped, never single-message scoped.
    let bodyMutationEpoch = 0

    function tavernBodyLocalKey(sessionId, messageId) {
      return `${sessionId}\u0000${messageId}`
    }

    function tavernBodyLocalRevision(sessionId, messageId) {
      return bodyLocalRevisions.get(tavernBodyLocalKey(sessionId, messageId)) || 0
    }

    function tavernBodyCacheKey(sessionId, messageId, revision) {
      return `${revision}\u0000${tavernBodyLocalRevision(sessionId, messageId)}\u0000${sessionId}\u0000${messageId}`
    }

    function tavernBodyCacheSnapshot() {
      return bodyCacheVersion
    }

    function subscribeTavernBodyCache(listener) {
      bodyCacheListeners.add(listener)
      return () => { bodyCacheListeners.delete(listener) }
    }

    function cacheTavernBody(key, body) {
      if (!bodyCache.has(key) && bodyCache.size >= BODY_CACHE_LIMIT) {
        const first = bodyCache.keys().next().value
        if (first !== undefined) bodyCache.delete(first)
      }
      bodyCache.set(key, body)
    }

    // A successful mutation must not be masked by a response that left the
    // server before it. Bump a per-message local revision, drop every cached
    // entry for that message and notify every mounted body hook.
    function bumpTavernBodyRevision(sessionId, messageId) {
      if (typeof sessionId !== 'string' || typeof messageId !== 'string') return
      const localKey = tavernBodyLocalKey(sessionId, messageId)
      bodyLocalRevisions.set(localKey, (bodyLocalRevisions.get(localKey) || 0) + 1)
      const suffix = `\u0000${sessionId}\u0000${messageId}`
      for (const key of [...bodyCache.keys()]) {
        if (key.endsWith(suffix)) bodyCache.delete(key)
      }
      bodyCacheVersion += 1
      for (const listener of bodyCacheListeners) listener()
    }

    // Invalidate every cached row of one body group. Switching candidates makes
    // the old anchor hidden and the new anchor visible; invalidating only the
    // clicked message left the other row's stale `hidden`/`text` in place, so
    // the chat could show no body at all until an unrelated refetch.
    function invalidateTavernBodyGroupCache(sessionId, groupId) {
      if (typeof sessionId !== 'string' || typeof groupId !== 'string' || groupId === '') return
      bodyMutationEpoch += 1
      const suffix = `\u0000${sessionId}\u0000`
      for (const [key, body] of [...bodyCache]) {
        if (!key.includes(suffix)) continue
        if (body && typeof body === 'object' && body.groupId === groupId) bodyCache.delete(key)
      }
      // An in-flight lookup that started before the mutation must not be reused
      // by the new effect run: its promise still describes the old group shape.
      for (const key of [...bodyInflight.keys()]) {
        if (key.includes(suffix)) bodyInflight.delete(key)
      }
      bodyCacheVersion += 1
      for (const listener of bodyCacheListeners) listener()
    }

    function bumpTavernBodyGroup(sessionId, groupId) {
      resetTavernBodyProjectionRefresh(sessionId, groupId)
      invalidateTavernBodyGroupCache(sessionId, groupId)
    }

    // A mutation's JSONL projection runs after the HTTP response. When the floor
    // is still behind, the response carries `projectionPending` and the ledger
    // text; refetch on a short bounded backoff so the display-layer text lands
    // without waiting for an unrelated reload. Retry state is per body group and
    // resets on the next user mutation; a non-pending row must not cancel the
    // pending anchor row's chain.
    const BODY_PROJECTION_REFRESH_DELAYS_MS = [150, 400, 900]
    const bodyProjectionRefreshes = new Map()

    function tavernBodyProjectionKey(sessionId, groupId) {
      return `${sessionId}\u0000${groupId}`
    }

    function resetTavernBodyProjectionRefresh(sessionId, groupId) {
      if (typeof sessionId !== 'string' || typeof groupId !== 'string' || groupId === '') return
      const key = tavernBodyProjectionKey(sessionId, groupId)
      const current = bodyProjectionRefreshes.get(key)
      if (current !== undefined && current.timer !== undefined) clearTimeout(current.timer)
      bodyProjectionRefreshes.delete(key)
    }

    function scheduleTavernBodyProjectionRefresh(sessionId, groupId) {
      if (typeof sessionId !== 'string' || typeof groupId !== 'string' || groupId === '') return
      const key = tavernBodyProjectionKey(sessionId, groupId)
      const current = bodyProjectionRefreshes.get(key)
      if (current !== undefined && current.timer !== undefined) return
      const attempt = current === undefined ? 0 : current.attempt
      if (attempt >= BODY_PROJECTION_REFRESH_DELAYS_MS.length) return
      const timer = setTimeout(() => {
        bodyProjectionRefreshes.set(key, { attempt: attempt + 1, timer: undefined })
        // The next attempt only runs if the refetch still reports pending.
        invalidateTavernBodyGroupCache(sessionId, groupId)
      }, BODY_PROJECTION_REFRESH_DELAYS_MS[attempt])
      bodyProjectionRefreshes.set(key, { attempt, timer })
    }

    function loadTavernBody(sessionId, messageId, revision) {
      const localRevision = tavernBodyLocalRevision(sessionId, messageId)
      const mutationEpoch = bodyMutationEpoch
      const key = tavernBodyCacheKey(sessionId, messageId, revision)
      if (bodyCache.has(key)) return Promise.resolve(bodyCache.get(key))
      if (bodyInflight.has(key)) return bodyInflight.get(key)
      const pending = api(`body?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`)
        .then((result) => {
          // A response that started before a body mutation may describe the old
          // group shape; never let it repopulate the cache after invalidation.
          if (mutationEpoch === bodyMutationEpoch
            && tavernBodyLocalRevision(sessionId, messageId) === localRevision) cacheTavernBody(key, result)
          return result
        })
        .finally(() => {
          // An invalidation may have replaced this entry with a newer request.
          if (bodyInflight.get(key) === pending) bodyInflight.delete(key)
        })
      bodyInflight.set(key, pending)
      return pending
    }

    function useTavernBody(sessionId, messageId) {
      const state = useTavernStore()
      const revision = state.bootstrap.storeRevision || ''
      const cacheVersion = useSyncExternalStore(subscribeTavernBodyCache, tavernBodyCacheSnapshot, tavernBodyCacheSnapshot)
      const [result, setResult] = useState({ body: undefined, error: '', loading: false })
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || typeof messageId !== 'string' || messageId === '') {
          setResult({ body: undefined, error: '', loading: false })
          return undefined
        }
        let cancelled = false
        setResult((current) => ({ body: current.body, error: '', loading: true }))
        void loadTavernBody(sessionId, messageId, revision)
          .then((body) => {
            if (cancelled) return
            setResult({ body, error: '', loading: false })
            // Only the current anchor may drive the retry chain: hidden rows can
            // legitimately see a stale floor while the anchor already moved.
            if (body && body.projectionPending === true && body.anchorMessageId === messageId
              && typeof body.groupId === 'string') {
              scheduleTavernBodyProjectionRefresh(sessionId, body.groupId)
            }
          })
          .catch((cause) => {
            if (cancelled) return
            setResult((current) => ({
              body: current.body,
              error: cause instanceof Error ? cause.message : String(cause),
              loading: false,
            }))
          })
        return () => { cancelled = true }
      }, [sessionId, messageId, revision, cacheVersion])
      return result
    }

    function tavernBodyReasonText(t, reason) {
      if (reason === 'session-busy') return t('body.busy')
      if (reason === 'body-compacted') return t('body.compacted')
      if (reason === 'not-last-round') return t('body.notLast')
      return typeof reason === 'string' ? reason : ''
    }

    function tavernBodyErrorText(t, cause) {
      const code = cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : ''
      if (code === 'session-busy') return t('body.busy')
      if (code === 'body-compacted') return t('body.compacted')
      if (code === 'not-last-round') return t('body.notLast')
      if (code === 'invalid-body-text') return t('body.invalid')
      if (code === 'projection-pending') return t('body.projectionPending')
      const message = cause instanceof Error ? cause.message : String(cause)
      return t('body.failed', { message })
    }

    // A body mutation's preflight refuses with projection-pending until the
    // JSONL projection has merged the candidate the request itself just
    // appended (proposal 0023 §4.1). Every mutation is idempotent, so the same
    // request is retried on a short backoff instead of surfacing a transient
    // "retry after the body projection catches up" as a failure.
    const BODY_PROJECTION_RETRY_DELAYS_MS = [200, 500, 1000]

    function withBodyProjectionRetry(request) {
      let attempt = 0
      const run = () => request().catch((cause) => {
        const code = cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : ''
        const delay = code === 'projection-pending' ? BODY_PROJECTION_RETRY_DELAYS_MS[attempt] : undefined
        if (delay === undefined) throw cause
        attempt += 1
        return new Promise((resolve) => setTimeout(resolve, delay)).then(run)
      })
      return run()
    }

    function TavernBodyActions(props) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionId = typeof props.tavernSessionId === 'string' ? props.tavernSessionId : props.sessionId
      const messageId = typeof props.messageId === 'string' ? props.messageId : undefined
      const binding = typeof sessionId === 'string' ? state.bootstrap.state.sessionBindings?.[sessionId] : undefined
      const bodyResult = useTavernBody(sessionId, messageId)
      const [editorOpen, setEditorOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [feedbackOpen, setFeedbackOpen] = useState(false)
      const [feedback, setFeedback] = useState('')
      const [pending, setPending] = useState('')
      const [watching, setWatching] = useState(null)
      const [error, setError] = useState('')
      const body = bodyResult.body

      // Regeneration returns 202 before the turn settles. Keep polling the
      // per-message body until a candidate is added or the wait expires, so
      // the action row does not unlock while the model is still writing.
      useEffect(() => {
        if (watching === null) return undefined
        const timer = setInterval(() => {
          if (Date.now() >= watching.deadline) {
            setWatching(null)
            return
          }
          bumpTavernBodyRevision(sessionId, messageId)
          if (typeof watching.watchGroupId === 'string') bumpTavernBodyGroup(sessionId, watching.watchGroupId)
        }, 1500)
        return () => clearInterval(timer)
      }, [watching, sessionId, messageId])

      useEffect(() => {
        if (watching === null || body === undefined) return
        if (body.count !== watching.count || body.selectedIndex !== watching.selectedIndex) setWatching(null)
      }, [watching, body?.count, body?.selectedIndex])

      const agentTavern = binding !== undefined && binding.architecture === 'agent-tavern' && binding.group !== true
      if (!agentTavern || typeof sessionId !== 'string' || typeof messageId !== 'string' || body === undefined || body.hidden === true) return null

      const count = typeof body.count === 'number' && Number.isInteger(body.count) && body.count > 0 ? body.count : 0
      const selectedIndex = typeof body.selectedIndex === 'number' && Number.isInteger(body.selectedIndex) ? body.selectedIndex : 0
      const canEdit = body.canEdit === true
      const canRegenerate = body.canRegenerate === true
      const canSelect = body.canSelect === true
      const busy = pending !== '' || watching !== null || bodyResult.loading
      const expectedIndex = selectedIndex
      const expectedAnchorId = typeof body.anchorMessageId === 'string' ? body.anchorMessageId : messageId
      const selectedLabel = count > 0 ? `${Math.min(selectedIndex + 1, count)}/${count}` : '0/0'
      const swipeLabel = t('body.swipe', { index: selectedIndex + 1, count })
      const reasonText = tavernBodyReasonText(t, body.reason)

      const runBodyAction = (kind, request, onDone) => {
        if (busy) return
        setPending(kind)
        setError('')
        void withBodyProjectionRetry(request)
          .then((result) => {
            if (result && typeof result.revision === 'string') {
              syncChatRevision(binding.character, binding.chatId, result.revision)
            }
            bumpTavernBodyRevision(sessionId, messageId)
            if (typeof body.groupId === 'string') bumpTavernBodyGroup(sessionId, body.groupId)
            if (onDone) onDone(result)
          })
          .catch((cause) => setError(tavernBodyErrorText(t, cause)))
          .finally(() => setPending(''))
      }

      const closeEditor = () => { if (pending !== 'edit') setEditorOpen(false) }
      const openEditor = () => {
        setDraft(typeof body.text === 'string' ? body.text : '')
        setError('')
        setEditorOpen(true)
      }
      const saveEdit = () => {
        if (draft.trim() === '') { setError(t('body.empty')); return }
        if (busy) return
        runBodyAction('edit', () => api('body', {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            messageId,
            groupId: body.groupId,
            index: expectedIndex,
            text: draft,
            expectedAnchorId,
            expectedIndex,
          }),
        }), () => setEditorOpen(false))
      }

      const closeRegenerate = () => { if (pending !== 'regenerate') setFeedbackOpen(false) }
      const openRegenerate = () => {
        setFeedback('')
        setError('')
        setFeedbackOpen(true)
      }
      const submitRegenerate = () => {
        if (busy) return
        const trimmed = feedback.trim()
        runBodyAction('regenerate', () => api('body/regenerate', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            messageId,
            groupId: body.groupId,
            ...(trimmed === '' ? {} : { feedback: trimmed }),
            expectedAnchorId,
            expectedIndex,
          }),
        }), () => {
          setFeedbackOpen(false)
          setWatching({ count, selectedIndex, watchGroupId: body.groupId, deadline: Date.now() + 90000 })
        })
      }

      const selectCandidate = (index) => {
        if (!canSelect || busy || index < 0 || index >= count || index === selectedIndex) return
        runBodyAction('select', () => api('body/select', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            messageId,
            groupId: body.groupId,
            index,
            expectedAnchorId,
            expectedIndex,
          }),
        }))
      }

      const editFooter = h('div', { className: 'dt-editor-actions' },
        h(Button, { size: 'sm', variant: 'ghost', type: 'button', disabled: pending === 'edit', onClick: closeEditor }, t('panel.cancel')),
        h(Button, { size: 'sm', variant: 'primary', type: 'button', disabled: busy, onClick: saveEdit },
          pending === 'edit' ? t('body.saving') : t('panel.save')))
      const regenerateFooter = h('div', { className: 'dt-editor-actions' },
        h(Button, { size: 'sm', variant: 'ghost', type: 'button', disabled: pending === 'regenerate', onClick: closeRegenerate }, t('panel.cancel')),
        h(Button, { size: 'sm', variant: 'primary', type: 'button', disabled: busy, onClick: submitRegenerate },
          pending === 'regenerate' ? t('body.generating') : t('body.regenerate')))

      return h(React.Fragment, null,
        h('span', { className: 'dt-body-actions', 'data-testid': 'tavern-body-actions' },
          canEdit ? h(Button, {
            size: 'sm',
            variant: 'ghost',
            type: 'button',
            icon: h(IconEditOutline16),
            disabled: busy,
            'data-testid': 'tavern-body-edit',
            onClick: openEditor,
          }, t('body.edit')) : null,
          canRegenerate ? h(Button, {
            size: 'sm',
            variant: 'ghost',
            type: 'button',
            icon: h(IconRefreshOutline16),
            disabled: busy,
            'data-testid': 'tavern-body-regenerate',
            onClick: openRegenerate,
          }, t('body.regenerate')) : null,
          canSelect ? h('span', { className: 'dt-body-swipe' },
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              type: 'button',
              'aria-label': t('body.swipe', { index: Math.max(selectedIndex, 0), count }),
              disabled: busy || selectedIndex <= 0,
              'data-testid': 'tavern-body-swipe-prev',
              onClick: () => selectCandidate(selectedIndex - 1),
            }, h(IconChevronLeftOutline14)),
            h('span', {
              className: 'dt-body-swipe-count',
              title: swipeLabel,
              'aria-label': swipeLabel,
              'data-testid': 'tavern-body-swipe-count',
            }, selectedLabel),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              type: 'button',
              'aria-label': t('body.swipe', { index: Math.min(selectedIndex + 2, count + 1), count }),
              disabled: busy || count === 0 || selectedIndex >= count - 1,
              'data-testid': 'tavern-body-swipe-next',
              onClick: () => selectCandidate(selectedIndex + 1),
            }, h(IconChevronRightOutline14))) : null,
          watching !== null ? h('span', { className: 'dt-muted' }, t('body.generating')) : null,
          reasonText !== '' ? h('span', { className: 'dt-muted' }, reasonText) : null,
          error !== '' && !editorOpen && !feedbackOpen ? h('span', { className: 'dt-error', role: 'alert' }, error) : null),
        editorOpen ? h(EditorDialog, {
          title: t('body.editTitle'),
          onClose: closeEditor,
          closeLabel: t('panel.close'),
          footer: editFooter,
          className: 'dt-body-dialog dt-body-dialog-edit',
        },
        h('div', { className: 'dt-editor' },
          h(EditorField, {
            label: t('body.edit'),
            value: draft,
            onChange: setDraft,
            multiline: true,
            className: 'dt-editor-wide dt-body-textarea dt-body-textarea-edit',
          }),
          error !== '' ? h('p', { className: 'dt-error', role: 'alert' }, error) : null)) : null,
        feedbackOpen ? h(EditorDialog, {
          title: t('body.regenerate'),
          onClose: closeRegenerate,
          closeLabel: t('panel.close'),
          footer: regenerateFooter,
          className: 'dt-body-dialog dt-body-dialog-regenerate',
        },
        h('div', { className: 'dt-editor' },
          h(EditorField, {
            label: t('body.feedback'),
            value: feedback,
            onChange: setFeedback,
            multiline: true,
            className: 'dt-editor-wide dt-body-textarea dt-body-textarea-feedback',
            hint: t('body.feedbackHint'),
          }),
          error !== '' ? h('p', { className: 'dt-error', role: 'alert' }, error) : null)) : null)
    }

    function registerTavernBodyActions(ctx) {
      return ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'tavern-body-actions',
        order: 10,
        inject: (sessionId) => ({ tavernSessionId: sessionId }),
      }, TavernBodyActions))
    }
