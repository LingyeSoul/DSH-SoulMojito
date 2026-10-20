    // AgentTavern runs on the host's native conversation surface: the host owns
    // assistant rows, so regex scripts applied by the projector to the Tavern
    // JSONL never reach the visible text. Reuse the host's assistant renderer,
    // replacing only its text blocks with the display text the server derives
    // from the projected message (save-layer regex already applied + display-
    // only markdownOnly scripts). Scoped per messageId so the lookup stays O(1)
    // and never ships the whole chat.
    const DISPLAY_TEXT_CACHE_LIMIT = 400
    const displayTextCache = new Map()
    const displayTextInflight = new Map()
    const EMPTY_PRESENTATION_SOURCE = {
      getSnapshot: () => ({
        mode: 'standard', foldCompletedTurns: true, stepGrouping: 'collapsed',
        liveProcessDetail: true, settledReasoningPreview: true, collapseTiming: 'completion',
      }),
      subscribe: () => () => {},
    }


    function displayTextCacheKey(binding, messageId, revision) {
      return `${revision}\u0000${binding.character}\u0000${binding.chatId}\u0000${messageId}`
    }

    function cacheDisplayText(key, text) {
      if (displayTextCache.size >= DISPLAY_TEXT_CACHE_LIMIT) {
        const first = displayTextCache.keys().next().value
        if (first !== undefined) displayTextCache.delete(first)
      }
      displayTextCache.set(key, text)
    }

    async function loadDisplayText(binding, messageId, revision) {
      const key = displayTextCacheKey(binding, messageId, revision)
      if (displayTextCache.has(key)) return displayTextCache.get(key)
      if (displayTextInflight.has(key)) return displayTextInflight.get(key)
      const pending = api(`display?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}&messageId=${encodeURIComponent(messageId)}`)
        .then((result) => {
          if (typeof result.text === 'string') cacheDisplayText(key, result.text)
          return typeof result.text === 'string' ? result.text : undefined
        })
        .finally(() => displayTextInflight.delete(key))
      displayTextInflight.set(key, pending)
      return pending
    }

    function useTavernDisplayText(binding, messageId) {
      const state = useTavernStore()
      const revision = state.bootstrap.storeRevision || ''
      const [text, setText] = useState(undefined)
      useEffect(() => {
        if (!binding || !messageId) {
          setText(undefined)
          return undefined
        }
        let cancelled = false
        let attempts = 0
        let timer
        const load = () => {
          void loadDisplayText(binding, messageId, revision).then((value) => {
            if (cancelled) return
            if (value !== undefined) {
              setText(value)
              return
            }
            // The projector writes the chat after the durable event; retry a
            // few times instead of leaving the raw model text in place.
            if (attempts < 4) {
              attempts += 1
              timer = setTimeout(load, 250 * attempts)
            }
          }).catch(() => {
            if (!cancelled) setText(undefined)
          })
        }
        setText(undefined)
        load()
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [binding?.character, binding?.chatId, messageId, revision])
      return text
    }

    function withTavernDisplayText(node, text) {
      if (typeof text !== 'string') return node
      let used = false
      const blocks = []
      for (const block of node.data.blocks) {
        if (block?.kind !== 'text') {
          blocks.push(block)
          continue
        }
        if (used) continue
        used = true
        if (text !== '') blocks.push({ ...block, text })
      }
      if (!used && text !== '') blocks.push({ kind: 'text', text })
      return { ...node, data: { ...node.data, blocks } }
    }

    function TavernAssistantImages({ images, loadImage, align }) {
      const [urls, setUrls] = useState([])
      useEffect(() => {
        let cancelled = false
        void Promise.all((images || []).map((image) => Promise.resolve()
          .then(() => loadImage(image.attachment))
          .catch(() => '')))
          .then((values) => { if (!cancelled) setUrls(values) })
        return () => { cancelled = true }
      }, [images, loadImage])
      const visible = urls.filter((url) => url !== '')
      if (visible.length === 0) return null
      return h('div', {
        className: `dt-assistant-images${align === 'end' ? ' dt-assistant-images-end' : ''}`,
      }, visible.map((url, index) => h('img', { key: index, src: url, alt: '' })))
    }

    function tavernAssistantRenderSlot(name, props) {
      if (name === 'conversation.chat.reasoning.body') {
        return h(MarkdownText, { text: props?.text || '' })
      }
      if (name === 'conversation.chat.message.images') {
        return h(TavernAssistantImages, {
          images: props?.images,
          loadImage: props?.loadImage,
          align: props?.align,
        })
      }
      return null
    }

    function useTavernPresentation(hostEntry) {
      let source = EMPTY_PRESENTATION_SOURCE
      try {
        source = hostEntry?.inject?.()?.hooks?.presentation || EMPTY_PRESENTATION_SOURCE
      } catch { /* the fallback policy is sufficient for reasoning previews */ }
      return useCallback((selector) => useSyncExternalStore(
        source.subscribe,
        () => selector(source.getSnapshot()),
        () => selector(source.getSnapshot()),
      ), [source])
    }

    function useAssistantSlotVersion() {
      const ctx = PanelHost.context
      const slots = ctx?.slots
      return useSyncExternalStore(
        (listener) => typeof slots?.subscribe === 'function' ? slots.subscribe('conversation.chat.node', listener) : () => {},
        () => typeof slots?.getVersion === 'function' ? slots.getVersion('conversation.chat.node') : 0,
        () => typeof slots?.getVersion === 'function' ? slots.getVersion('conversation.chat.node') : 0,
      )
    }

    // Plain text fallback while the host assistant renderer is not registered
    // yet (or when a host version does not ship one). Regex display still wins
    // over losing the row entirely.
    function TavernAssistantFallback({ node }) {
      return h('div', { className: 'dt-assistant-fallback' },
        (node?.data?.blocks || [])
          .filter((block) => block?.kind === 'text' && block.text !== '')
          .map((block, index) => h('p', { key: index }, block.text)))
    }

    const TavernAssistantNode = React.memo(function TavernAssistantNode(props) {
      useAssistantSlotVersion()
      const state = useTavernStore()
      const binding = state.bootstrap.state.sessionBindings?.[props.tavernSessionId]
      const blocks = props.node?.data?.blocks || []
      // The projector only stores message-less tool steps as nothing; asking
      // for them would burn retries on a lookup that can never resolve.
      const messageId = blocks.some((block) => block?.kind === 'tool-call')
        || !blocks.some((block) => block?.kind === 'text')
        ? undefined
        : props.node?.data?.finalNode?.messageId
      const displayText = useTavernDisplayText(
        binding && binding.architecture === 'agent-tavern' && binding.group !== true ? binding : undefined,
        messageId,
      )
      const node = withTavernDisplayText(props.node, displayText)
      const hostEntry = findHostAssistantEntry(PanelHost.context)
      const usePresentation = useTavernPresentation(hostEntry)
      if (!hostEntry) return h(TavernAssistantFallback, { node })
      return h(hostEntry.component, {
        ...props,
        node,
        renderSlot: tavernAssistantRenderSlot,
        usePresentation,
      })
    })

    function findHostAssistantEntry(ctx) {
      const entries = typeof ctx?.slots?.entries === 'function'
        ? ctx.slots.entries('conversation.chat.node')
        : []
      return entries.find((entry) => entry?.options?.key === 'assistant-step' && entry.component !== TavernAssistantNode)
    }

    function registerTavernAssistantNode(ctx) {
      return ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'assistant-step',
        // Lower priority wins a keyed cell; the host default is priority 0.
        priority: -1,
        locale: 'chat',
        inject: (sessionId) => ({ tavernSessionId: sessionId }),
      }, TavernAssistantNode))
    }
