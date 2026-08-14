window.__ModuleLoader__.load({
  id: 'dsh-tavern',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const {
      IconChevronDownOutline14,
      IconChevronLeftOutline14,
      IconChevronRightOutline14,
      IconEditOutline16,
      IconPlusOutline16,
      IconRefreshOutline16,
      IconSendOutline16,
      IconStopFill16,
      IconTrashOutline16,
      IconUserOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement.bind(React)

    const API = '/api/dsh-tavern'
    const STYLE_ID = 'dsh-tavern/native-ui'
    const REVISION_CONFLICT = 'CHAT_REVISION_CONFLICT'
    const EMPTY_BOOTSTRAP = {
      state: { activeWorlds: [], sessionBindings: {}, chats: {} },
      characters: [],
      worlds: [],
      presets: [],
      personas: [],
      activeCard: null,
      model: { provider: '', model: '' },
    }
    let snapshot = {
      bootstrap: EMPTY_BOOTSTRAP,
      loading: true,
      error: '',
      chatLists: {},
      chats: {},
      revisions: {},
      runs: {},
      sidebarAttached: false,
      navigationStatus: '',
    }
    const listeners = new Set()
    const pendingChats = new Map()
    const pendingLists = new Map()
    const controllers = new Map()

    function update(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    function useTavernStore() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function jsonHeaders() {
      return { 'content-type': 'application/json' }
    }

    async function api(path, options) {
      const response = await fetch(`${API}/${path}`, options)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        const error = new Error(body.message || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body.code
        throw error
      }
      return body
    }

    async function refreshBootstrap() {
      try {
        const result = await api('bootstrap')
        update({ bootstrap: result, loading: false, error: '' })
        return result
      } catch (cause) {
        update({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
    }

    async function patchState(patch) {
      await api('state', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(patch) })
      return refreshBootstrap()
    }

    function chatKey(character, chatId) {
      return `${character}\u0000${chatId}`
    }

    async function loadChatList(character, force) {
      if (!character) return []
      if (!force && snapshot.chatLists[character]) return snapshot.chatLists[character]
      if (pendingLists.has(character)) return pendingLists.get(character)
      const pending = api(`chats?character=${encodeURIComponent(character)}`)
        .then((result) => {
          const ids = [...result.chats].reverse()
          update({ chatLists: { ...snapshot.chatLists, [character]: ids } })
          return ids
        })
        .finally(() => pendingLists.delete(character))
      pendingLists.set(character, pending)
      return pending
    }

    async function loadChat(character, chatId, force) {
      if (!character || !chatId) return null
      const key = chatKey(character, chatId)
      if (!force && snapshot.chats[key]) return snapshot.chats[key]
      if (pendingChats.has(key)) return pendingChats.get(key)
      const pending = api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`)
        .then((result) => {
          update({
            chats: { ...snapshot.chats, [key]: result.chat },
            revisions: { ...snapshot.revisions, [key]: result.revision },
          })
          return result.chat
        })
        .finally(() => pendingChats.delete(key))
      pendingChats.set(key, pending)
      return pending
    }

    async function saveChat(character, chatId, chat) {
      const key = chatKey(character, chatId)
      try {
        const result = await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ chat, revision: snapshot.revisions[key] }),
        })
        update({
          chats: { ...snapshot.chats, [key]: result.chat || chat },
          revisions: { ...snapshot.revisions, [key]: result.revision },
        })
        return result.chat || chat
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    function setRun(sessionId, patch) {
      update({
        runs: {
          ...snapshot.runs,
          [sessionId]: { busy: false, streamText: '', status: '', error: '', ...(snapshot.runs[sessionId] || {}), ...patch },
        },
      })
    }

    async function generateFor(sessionId, binding, mode, text) {
      const currentRun = snapshot.runs[sessionId]
      if (!binding || currentRun?.busy) return
      const key = chatKey(binding.character, binding.chatId)
      const currentChat = snapshot.chats[key] || await loadChat(binding.character, binding.chatId)
      const message = (text || '').trim()
      if (mode === 'send' && !message) return
      if (mode === 'send') {
        const optimistic = {
          ...currentChat,
          messages: [...currentChat.messages, {
            name: 'User',
            is_user: true,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: message,
          }],
        }
        update({ chats: { ...snapshot.chats, [key]: optimistic } })
      }
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      setRun(sessionId, { busy: true, streamText: '', status: 'Connecting', error: '' })
      try {
        const response = await fetch(`${API}/generate`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            character: binding.character,
            chatId: binding.chatId,
            revision: snapshot.revisions[key],
            message,
            mode,
          }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || `HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamed = ''
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            if (event.type === 'start') setRun(sessionId, { status: `${event.provider}/${event.model}` })
            if (event.type === 'delta') {
              streamed += event.text
              setRun(sessionId, { streamText: streamed })
            }
            if (event.type === 'error') {
              const error = new Error(event.message || 'Generation failed')
              error.code = event.code
              throw error
            }
            if (event.type === 'saved') {
              update({
                chats: { ...snapshot.chats, [key]: event.chat },
                revisions: { ...snapshot.revisions, [key]: event.revision },
              })
              setRun(sessionId, { streamText: '', status: 'Saved' })
            }
          }
          if (part.done) break
        }
      } catch (cause) {
        const aborted = controller.signal.aborted
        setRun(sessionId, {
          error: aborted ? '' : (cause instanceof Error ? cause.message : String(cause)),
          status: aborted ? 'Stopped' : '',
          streamText: '',
        })
        await loadChat(binding.character, binding.chatId, true).catch(() => {})
      } finally {
        controllers.delete(sessionId)
        setRun(sessionId, { busy: false })
      }
    }

    function stopGeneration(sessionId) {
      controllers.get(sessionId)?.abort()
    }

    function base64Url(value) {
      const bytes = new TextEncoder().encode(value)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    function currentWorkspace(ctx) {
      const sessions = ctx.sessions.list.getSnapshot()
      const workspaces = ctx.workspaces.list.getSnapshot()
      const current = sessions.current
      return workspaces.items.find((item) => current && item.sessionIds.includes(current))
        || workspaces.items.find((item) => item.workspaceId === workspaces.recentWorkspaceId)
        || workspaces.items[0]
    }

    function clickTavernTab(attempt) {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((item) => item.textContent?.trim() === 'Tavern')
      if (tab instanceof HTMLElement) {
        tab.click()
        return
      }
      if (attempt < 12) setTimeout(() => clickTavernTab(attempt + 1), 50)
    }

    async function openTavernChat(ctx, character, chatId) {
      update({ navigationStatus: '' })
      const sessions = ctx.sessions.list.getSnapshot()
      const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .find(([sessionId, binding]) => sessions.byId[sessionId]
          && binding.character === character
          && binding.chatId === chatId)
      if (existing) {
        ctx.sessions.open(existing[0])
        clickTavernTab(0)
        return existing[0]
      }

      const workspace = currentWorkspace(ctx)
      if (!workspace) throw new Error('No DSH workspace is available for a Tavern session.')
      update({ navigationStatus: `Opening ${character}` })
      const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
      const binding = ctx.sessions.binding(sessionId)
      if (!binding) throw new Error('DSH did not expose the new session binding.')
      const payload = base64Url(JSON.stringify({ character, chatId }))
      const result = await binding.session.command(`/tavern ${payload}`)
      if (!result.ok) throw new Error(result.error?.message || 'Tavern activation failed.')
      if (!result.value.matched) throw new Error('The Tavern host command is unavailable.')
      const label = sessionLabel(character, chatId)
      await binding.session.rename(label).catch(() => {})
      await refreshBootstrap()
      ctx.sessions.open(sessionId)
      update({ navigationStatus: '' })
      clickTavernTab(0)
      return sessionId
    }

    async function createTavernChat(ctx, character) {
      const result = await api('chats', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character }),
      })
      await loadChatList(character, true)
      const key = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [key]: result.chat },
        revisions: { ...snapshot.revisions, [key]: result.revision },
      })
      return openTavernChat(ctx, character, result.id)
    }

    function boundSessionIds(character, chatId) {
      return Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .filter(([, binding]) => binding.character === character && binding.chatId === chatId)
        .map(([sessionId]) => sessionId)
    }

    function sessionLabel(character, chatId) {
      return `${character} · ${chatId.replace(/\.jsonl$/i, '').slice(0, 44)}`
    }

    async function renameTavernChat(ctx, character, chatId) {
      const currentName = chatId.replace(/\.jsonl$/i, '')
      const name = window.prompt('Rename Tavern chat', currentName)
      if (name === null || name.trim() === '' || name.trim() === currentName) return chatId
      await loadChat(character, chatId)
      const key = chatKey(character, chatId)
      const sessionIds = boundSessionIds(character, chatId)
      try {
        const result = await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: name.trim(), revision: snapshot.revisions[key] }),
        })
        const nextKey = chatKey(character, result.id)
        const chats = { ...snapshot.chats }
        const revisions = { ...snapshot.revisions }
        delete chats[key]
        delete revisions[key]
        chats[nextKey] = result.chat
        revisions[nextKey] = result.revision
        update({
          bootstrap: { ...snapshot.bootstrap, state: result.state },
          chats,
          revisions,
        })
        await loadChatList(character, true)
        await Promise.all(sessionIds.map(async (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          await binding?.session.rename(sessionLabel(character, result.id)).catch(() => {})
        }))
        return result.id
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    async function deleteTavernChat(ctx, character, chatId) {
      if (!window.confirm(`Delete Tavern chat "${chatId.replace(/\.jsonl$/i, '')}"? This cannot be undone.`)) return false
      await loadChat(character, chatId)
      const key = chatKey(character, chatId)
      const sessionIds = boundSessionIds(character, chatId)
      try {
        await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'DELETE',
          headers: jsonHeaders(),
          body: JSON.stringify({ revision: snapshot.revisions[key] }),
        })
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
      const closePayload = base64Url(JSON.stringify({ action: 'close' }))
      await Promise.all(sessionIds.map(async (sessionId) => {
        const binding = ctx.sessions.binding(sessionId)
        await binding?.session.command(`/tavern ${closePayload}`).catch(() => {})
        await ctx.workspaces.archiveSession(sessionId).catch(() => {})
      }))
      const chats = { ...snapshot.chats }
      const revisions = { ...snapshot.revisions }
      delete chats[key]
      delete revisions[key]
      update({ chats, revisions })
      await Promise.all([loadChatList(character, true), refreshBootstrap()])
      return true
    }

    function isTavernSession(session) {
      if (!session?.chat?.order || !session.chat.nodes) return null
      let match = null
      for (const key of session.chat.order) {
        const node = session.chat.nodes.get(key)
        if (node?.kind === 'context'
          && node.data?.source?.kind === 'plugin'
          && node.data.source.plugin === 'dsh-tavern') {
          match = node.data.source.tavernState === 'closed' ? null : { marker: node.key }
        }
      }
      return match
    }

    function selectTavernComposer(owner) {
      return isTavernSession(owner.session)
    }

    function readFile(file, binary) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error('File read failed'))
        reader.onload = () => resolve(reader.result)
        if (binary) reader.readAsArrayBuffer(file)
        else reader.readAsText(file)
      })
    }

    function fileStem(name) {
      return name.replace(/\.[^.]+$/, '') || 'Imported'
    }

    async function importAsset(kind, file) {
      if (!file) return
      if (kind === 'character') {
        const bytes = new Uint8Array(await readFile(file, true))
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        }
        if (/\.png$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ pngBase64: btoa(binary) }),
          })
        } else if (/\.charx$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ charxBase64: btoa(binary) }),
          })
        } else {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ card: JSON.parse(new TextDecoder().decode(bytes)) }),
          })
        }
      } else {
        await api(`import/${kind}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: fileStem(file.name), data: JSON.parse(await readFile(file, false)) }),
        })
      }
      await refreshBootstrap()
    }

    function SettingSelect({ label, value, options, empty, onChange }) {
      return h('label', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, label),
        h('select', { value: value || '', onChange: (event) => onChange(event.target.value || null) },
          h('option', { value: '' }, empty),
          options.map((option) => h('option', { key: option, value: option }, option))))
    }

    function UploadButton({ kind, label, accept }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return h('label', { className: 'dt-upload', title: `Import ${label}` },
        busy ? 'Importing…' : label,
        h('input', {
          type: 'file',
          accept,
          disabled: busy,
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            setBusy(true)
            setError('')
            void importAsset(kind, file).catch((cause) => setError(cause.message)).finally(() => setBusy(false))
          },
        }),
        error ? h('span', { className: 'dt-upload-error', title: error }, '!') : null)
    }

    function TavernSettings() {
      const state = useTavernStore()
      const bootstrap = state.bootstrap
      const [error, setError] = useState('')
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const applyPatch = (patch) => {
        setError('')
        void patchState(patch).catch((cause) => setError(cause.message))
      }
      return h('div', { className: 'dt-settings', 'data-dsh-tavern-settings': '' },
        h('div', { className: 'dt-settings-heading' },
          h('div', null,
            h('h2', null, 'dsh-tavern'),
            h('p', null, 'Roleplay assets and prompt configuration')),
          h('span', { className: 'dt-model' }, bootstrap.model?.provider && bootstrap.model?.model
            ? `${bootstrap.model.provider} / ${bootstrap.model.model}`
            : 'No default model')),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, 'Active setup'),
          h('div', { className: 'dt-settings-grid' },
            h(SettingSelect, {
              label: 'Character',
              value: bootstrap.state.activeCharacter,
              options: bootstrap.characters,
              empty: 'No active character',
              onChange: (value) => applyPatch({ activeCharacter: value }),
            }),
            h(SettingSelect, {
              label: 'Preset',
              value: bootstrap.state.activePreset,
              options: bootstrap.presets,
              empty: 'Built-in RP preset',
              onChange: (value) => applyPatch({ activePreset: value }),
            }),
            h(SettingSelect, {
              label: 'Persona',
              value: bootstrap.state.activePersona,
              options: bootstrap.personas,
              empty: 'Default user',
              onChange: (value) => applyPatch({ activePersona: value }),
            }),
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: bootstrap.state.nativeAgentPersona === true,
                onChange: (event) => applyPatch({ nativeAgentPersona: event.target.checked }),
              }),
              h('span', null, 'Use active character in standard DSH Agent chats')))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, 'World Info'),
          bootstrap.worlds.length === 0
            ? h('p', { className: 'dt-muted' }, 'No world books imported')
            : h('div', { className: 'dt-check-grid' }, bootstrap.worlds.map((name) => h('label', { key: name },
                h('input', {
                  type: 'checkbox',
                  checked: bootstrap.state.activeWorlds.includes(name),
                  onChange: (event) => {
                    const worlds = new Set(bootstrap.state.activeWorlds)
                    if (event.target.checked) worlds.add(name)
                    else worlds.delete(name)
                    applyPatch({ activeWorlds: [...worlds] })
                  },
                }),
                h('span', null, name))))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, 'Import'),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'character', label: 'Character card', accept: '.png,.charx,.json,application/json,image/png,application/zip' }),
            h(UploadButton, { kind: 'world', label: 'World book', accept: '.json,application/json' }),
            h(UploadButton, { kind: 'preset', label: 'Chat preset', accept: '.json,application/json' }))),
        error || state.error ? h('p', { className: 'dt-error' }, error || state.error) : null)
    }

    function MessageRow({ sessionId, character, chatId, chat, message, index, busy }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(message.mes || '')
      const [error, setError] = useState('')
      useEffect(() => setDraft(message.mes || ''), [message.mes])
      const isUser = message.is_user === true
      const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes || '']
      const swipeIndex = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1)
      const persist = async (nextMessage) => {
        setError('')
        const nextChat = { ...chat, messages: chat.messages.map((item, itemIndex) => itemIndex === index ? nextMessage : item) }
        try {
          await saveChat(character, chatId, nextChat)
          return true
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          setRun(sessionId, { error: message })
          return false
        }
      }
      const changeSwipe = (delta) => {
        const nextIndex = (swipeIndex + delta + swipes.length) % swipes.length
        void persist({ ...message, swipe_id: nextIndex, mes: swipes[nextIndex] })
      }
      const commit = async () => {
        const nextSwipes = swipes.map((value, itemIndex) => itemIndex === swipeIndex ? draft : value)
        if (await persist({ ...message, mes: draft, ...(message.swipes ? { swipes: nextSwipes } : {}) })) {
          setEditing(false)
        }
      }
      return h('article', { className: `dt-message ${isUser ? 'dt-message-user' : 'dt-message-character'}` },
        !isUser ? h('img', {
          className: 'dt-message-avatar',
          src: `${API}/avatar/${encodeURIComponent(character)}`,
          alt: '',
          onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
        }) : null,
        h('div', { className: 'dt-message-body' },
          h('div', { className: 'dt-message-name' }, message.name || (isUser ? 'User' : character)),
          editing
            ? h('textarea', { className: 'dt-message-edit', value: draft, disabled: busy, onChange: (event) => setDraft(event.target.value) })
            : h('div', { className: 'dt-message-copy' }, message.mes || ''),
          h('div', { className: 'dt-message-actions' },
            swipes.length > 1 ? h(React.Fragment, null,
              h('button', { type: 'button', title: 'Previous swipe', disabled: busy, onClick: () => changeSwipe(-1) }, h(IconChevronLeftOutline14)),
              h('span', null, `${swipeIndex + 1}/${swipes.length}`),
              h('button', { type: 'button', title: 'Next swipe', disabled: busy, onClick: () => changeSwipe(1) }, h(IconChevronRightOutline14))) : null,
            editing ? h(React.Fragment, null,
              h('button', { type: 'button', disabled: busy, onClick: () => void commit() }, 'Save'),
              h('button', { type: 'button', onClick: () => { setDraft(message.mes || ''); setError(''); setEditing(false) } }, 'Cancel'))
              : h('button', { type: 'button', title: 'Edit message', disabled: busy, onClick: () => setEditing(true) }, h(IconEditOutline16))),
          error ? h('span', { className: 'dt-message-error' }, error) : null))
    }

    function TavernView({ sessionId }) {
      const state = useTavernStore()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const run = state.runs[sessionId] || {}
      const endRef = useRef(null)
      useEffect(() => {
        if (binding) void loadChat(binding.character, binding.chatId).catch((cause) => setRun(sessionId, { error: cause.message }))
      }, [binding?.character, binding?.chatId, sessionId])
      useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [chat, run.streamText])
      if (!binding) {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' },
          h(IconUserOutline16, { size: 22 }),
          h('strong', null, 'No Tavern chat is bound to this session.'))
      }
      if (!chat) return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' }, 'Loading Tavern chat…')
      const messages = [...chat.messages]
      if (run.streamText) messages.push({ name: binding.character, is_user: false, mes: run.streamText, streaming: true })
      return h('div', { className: 'dt-view', 'data-dsh-tavern-surface': 'view' },
        h('div', { className: 'dt-scene-strip' },
          h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
          h('div', null, h('strong', null, binding.character), h('span', null, binding.chatId.replace(/\.jsonl$/i, ''))),
          h('button', {
            type: 'button',
            title: 'Regenerate last response',
            disabled: run.busy || !chat.messages.some((message) => !message.is_user),
            onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
          }, h(IconRefreshOutline16))),
        h('div', { className: 'dt-transcript' },
          messages.map((message, index) => h(MessageRow, {
            key: `${index}-${message.send_date || ''}-${message.streaming ? 'stream' : 'saved'}`,
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            chat,
            message,
            index,
            busy: run.busy || message.streaming,
          })),
          h('div', { className: 'dt-transcript-end', ref: endRef })),
        run.error ? h('div', { className: 'dt-run-error' }, run.error) : null)
    }

    function TavernComposer({ sessionId, useInput, inputActions }) {
      const state = useTavernStore()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const input = useInput((value) => value)
      const run = state.runs[sessionId] || {}
      const send = () => {
        const message = input.draft.trim()
        if (!binding || !message || run.busy) return
        inputActions.setDraft('')
        void generateFor(sessionId, binding, 'send', message)
      }
      return h('div', { className: 'dt-composer-wrap', 'data-dsh-tavern-surface': 'composer' },
        h('div', { className: 'dt-composer' },
          h('textarea', {
            value: input.draft,
            disabled: !binding || run.busy,
            placeholder: binding ? `Write to ${binding.character}` : 'Tavern binding unavailable',
            rows: 2,
            onChange: (event) => inputActions.setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dt-composer-row' },
            h('span', { className: run.error ? 'dt-error' : 'dt-muted' }, run.error || run.status || (binding ? binding.character : '')),
            run.busy
              ? h('button', { type: 'button', className: 'dt-primary-icon', title: 'Stop generation', onClick: () => stopGeneration(sessionId) }, h(IconStopFill16))
              : h('button', { type: 'button', className: 'dt-primary-icon', title: 'Send', disabled: !binding || !input.draft.trim(), onClick: send }, h(IconSendOutline16)))))
    }

    function TavernHeaderAction({ sessionId, useSession }) {
      const state = useTavernStore()
      const active = useSession((session) => isTavernSession(session) !== null)
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const run = state.runs[sessionId] || {}
      if (!active || !binding) return null
      return h('div', { className: 'dt-header-character', 'data-dsh-tavern-surface': 'header' },
        h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
        h('span', null, binding.character),
        h('button', {
          type: 'button',
          title: 'Regenerate last response',
          disabled: run.busy,
          onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
        }, h(IconRefreshOutline16)))
    }

    function visibleSidebarTree() {
      const candidates = [...document.querySelectorAll('[role="tree"]')]
      return candidates.find((tree) => {
        if (tree.closest('[data-dsh-tavern-sidebar-host]')) return false
        const rect = tree.getBoundingClientRect()
        return rect.width > 40 && rect.height > 20 && rect.left < Math.min(420, window.innerWidth * 0.4)
      }) || null
    }

    function useSidebarHost() {
      const [host, setHost] = useState(null)
      useEffect(() => {
        let frame = 0
        let current = null
        const attach = () => {
          frame = 0
          const tree = visibleSidebarTree()
          if (!tree?.parentElement) {
            if (current?.isConnected) current.remove()
            current = null
            setHost(null)
            if (snapshot.sidebarAttached) update({ sidebarAttached: false })
            return
          }
          if (!current || !current.isConnected || current.parentElement !== tree.parentElement) {
            current?.remove()
            current = document.createElement('div')
            current.dataset.dshTavernSidebarHost = ''
            tree.parentElement.insertBefore(current, tree)
            setHost(current)
          }
          if (!snapshot.sidebarAttached) update({ sidebarAttached: true })
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(attach)
        }
        attach()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          current?.remove()
          update({ sidebarAttached: false })
        }
      }, [])
      return host
    }

    function ChatList({ ctx, character, currentSession }) {
      const state = useTavernStore()
      const chats = state.chatLists[character]
      const [error, setError] = useState('')
      const [busyChat, setBusyChat] = useState('')
      useEffect(() => { void loadChatList(character).catch((cause) => setError(cause.message)) }, [character])
      const activeBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const open = (chatId) => {
        setError('')
        void openTavernChat(ctx, character, chatId).catch((cause) => {
          update({ navigationStatus: '' })
          setError(cause.message)
        })
      }
      const runAction = (chatId, action) => {
        setError('')
        setBusyChat(chatId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusyChat(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        chats?.map((chatId) => h('div', {
          key: chatId,
          className: `dt-sidebar-chat-row ${activeBinding?.character === character && activeBinding.chatId === chatId ? 'dt-sidebar-chat-active' : ''}`,
        },
        h('button', {
          type: 'button',
          className: 'dt-sidebar-chat-open',
          title: chatId,
          disabled: busyChat === chatId,
          onClick: () => open(chatId),
        }, h('span', null, chatId.replace(/\.jsonl$/i, ''))),
        h('button', {
          type: 'button',
          title: `Rename ${chatId.replace(/\.jsonl$/i, '')}`,
          disabled: busyChat === chatId,
          onClick: () => runAction(chatId, () => renameTavernChat(ctx, character, chatId)),
        }, h(IconEditOutline16)),
        h('button', {
          type: 'button',
          title: `Delete ${chatId.replace(/\.jsonl$/i, '')}`,
          disabled: busyChat === chatId,
          onClick: () => runAction(chatId, () => deleteTavernChat(ctx, character, chatId)),
        }, h(IconTrashOutline16)))),
        !chats ? h('span', { className: 'dt-sidebar-status' }, 'Loading…') : null,
        chats?.length === 0 ? h('span', { className: 'dt-sidebar-status' }, 'No chats') : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    function TavernSidebar({ ctx, useSessions, floating, onClose }) {
      const state = useTavernStore()
      const currentSession = useSessions((sessions) => sessions.current)
      const [expanded, setExpanded] = useState(state.bootstrap.state.activeCharacter || state.bootstrap.characters[0] || '')
      const [error, setError] = useState('')
      return h('section', { className: `dt-sidebar ${floating ? 'dt-sidebar-floating' : ''}`, 'aria-label': 'Tavern roleplay chats' },
        h('div', { className: 'dt-sidebar-heading' },
          h('span', null, h(IconUserOutline16), h('strong', null, 'Tavern')),
          floating ? h('button', { type: 'button', title: 'Close', onClick: onClose }, '×') : null),
        state.bootstrap.characters.map((character) => {
          const open = expanded === character
          return h('div', { key: character, className: 'dt-character-group' },
            h('div', { className: 'dt-character-row' },
              h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpanded(open ? '' : character) },
                h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                h('img', { src: `${API}/avatar/${encodeURIComponent(character)}`, alt: '' }),
                h('span', null, character)),
              h('button', {
                type: 'button',
                title: `New chat with ${character}`,
                onClick: () => {
                  setError('')
                  void createTavernChat(ctx, character).catch((cause) => {
                    update({ navigationStatus: '' })
                    setError(cause.message)
                  })
                },
              }, h(IconPlusOutline16))),
            open ? h(ChatList, { ctx, character, currentSession }) : null)
        }),
        state.bootstrap.characters.length === 0 ? h('span', { className: 'dt-sidebar-status' }, 'No character cards') : null,
        state.navigationStatus ? h('span', { className: 'dt-sidebar-status' }, state.navigationStatus) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    function SidebarAdapter({ useSessions }) {
      const host = useSidebarHost()
      const state = useTavernStore()
      const sessionIds = useSessions((value) => value.ids)
      const sessionPhase = useSessions((value) => value.phase)
      const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})
      const [floating, setFloating] = useState(false)
      useEffect(() => {
        if (sessionPhase !== 'ready') return
        if (bindingIds.every((sessionId) => sessionIds.includes(sessionId))) return
        void api('bindings/prune', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionIds }),
        }).then((result) => update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })).catch(() => {})
      }, [sessionPhase, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      useEffect(() => {
        const toggle = () => setFloating((value) => !value)
        window.addEventListener('dsh-tavern:toggle-sidebar', toggle)
        return () => window.removeEventListener('dsh-tavern:toggle-sidebar', toggle)
      }, [])
      const context = SidebarAdapter.context
      return h(React.Fragment, null,
        host ? createPortal(h(TavernSidebar, { ctx: context, useSessions }), host) : null,
        floating ? h('div', { className: 'dt-floating-shell' },
          h(TavernSidebar, { ctx: context, useSessions, floating: true, onClose: () => setFloating(false) })) : null)
    }

    function SidebarFooterAction({ wide }) {
      const state = useTavernStore()
      if (state.sidebarAttached) return null
      return h('button', {
        type: 'button',
        className: 'dt-footer-action',
        title: 'Tavern',
        'aria-label': 'Open Tavern roleplay chats',
        onClick: () => window.dispatchEvent(new CustomEvent('dsh-tavern:toggle-sidebar')),
      }, h(IconUserOutline16), wide ? h('span', null, 'Tavern') : null)
    }

    function installStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-tavern'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = `
        .dt-settings{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:0;min-height:100%;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings h2{font-size:20px;line-height:28px;margin:0;font-weight:600}.dt-settings-heading p{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:4px 0 0}.dt-model{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere;text-align:right;max-width:42%}.dt-settings-band{padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings-band h3{font-size:14px;line-height:20px;margin:0 0 14px;font-weight:600}.dt-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}.dt-field{display:flex;flex-direction:column;gap:6px}.dt-label{color:var(--dsw-alias-label-secondary);font-size:12px}.dt-field select{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-toggle,.dt-check-grid label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}.dt-toggle{min-height:36px}.dt-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}.dt-imports{display:flex;gap:8px;flex-wrap:wrap}.dt-upload{position:relative;cursor:pointer;height:34px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:13px}.dt-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}.dt-upload-error{color:var(--dsw-alias-state-error-primary);margin-left:5px}.dt-error,.dt-run-error,.dt-sidebar-error{color:var(--dsw-alias-state-error-primary)}.dt-muted{color:var(--dsw-alias-label-tertiary)}
        .dt-view{box-sizing:border-box;width:100%;max-width:780px;margin:0 auto;display:flex;flex-direction:column;min-height:100%;padding:8px 16px 28px;color:var(--dsw-alias-label-primary);letter-spacing:0}.dt-empty{min-height:300px;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px}.dt-scene-strip{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:9px;min-height:48px;padding:8px 4px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-scene-strip>img{width:32px;height:32px;border-radius:6px;object-fit:cover}.dt-scene-strip>div{display:flex;flex-direction:column;min-width:0;flex:1}.dt-scene-strip strong{font-size:13px;line-height:18px}.dt-scene-strip span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-scene-strip button,.dt-message-actions button,.dt-header-character button,.dt-sidebar button,.dt-footer-action{color:inherit;background:transparent;border:0;cursor:pointer}.dt-scene-strip button{width:30px;height:30px;display:grid;place-items:center;border-radius:6px}.dt-scene-strip button:hover,.dt-message-actions button:hover,.dt-header-character button:hover,.dt-sidebar button:hover,.dt-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-view button:disabled,.dt-composer button:disabled,.dt-sidebar button:disabled{cursor:not-allowed;opacity:.45}.dt-transcript{display:flex;flex-direction:column;gap:22px;padding:22px 4px}.dt-message{display:flex;gap:10px;max-width:88%;min-width:0}.dt-message-user{align-self:flex-end}.dt-message-character{align-self:flex-start}.dt-message-avatar{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none}.dt-message-body{display:flex;flex-direction:column;gap:4px;min-width:0}.dt-message-user .dt-message-body{align-items:flex-end}.dt-message-name{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-message-copy{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-raised,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2)}.dt-message-user .dt-message-copy{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-base))}.dt-message-actions{display:flex;align-items:center;gap:4px;min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dt-message-actions button{min-width:24px;height:24px;border-radius:5px;display:inline-grid;place-items:center;padding:0 5px}.dt-message-edit{box-sizing:border-box;width:min(620px,70vw);max-width:100%;min-height:100px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:9px;font:inherit;line-height:1.55}.dt-transcript-end{height:1px;flex:none}.dt-message-error{max-width:620px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.dt-run-error{padding:7px 12px;font-size:12px}
        .dt-composer-wrap{box-sizing:border-box;width:100%;padding:6px var(--dsh-composer-side-clearance,16px) 14px;pointer-events:auto}.dt-composer{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);padding:10px 10px 8px;box-shadow:0 2px 10px rgba(0,0,0,.06)}.dt-composer textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:200px;resize:vertical;border:0;outline:0;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:14px;line-height:1.5}.dt-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;font-size:11px}.dt-composer-row>span{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-primary-icon{width:30px;height:30px;border:0;border-radius:7px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;cursor:pointer}.dt-header-character{height:28px;display:flex;align-items:center;gap:6px;padding:0 4px 0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px}.dt-header-character>img{width:20px;height:20px;border-radius:4px;object-fit:cover}.dt-header-character>span{max-width:100px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-header-character>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center}
        [data-dsh-tavern-sidebar-host]{flex:none;margin:0 0 6px;padding-right:var(--dsh-session-list-edge-inset,8px)}.dt-sidebar{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-sidebar-heading{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 5px;color:var(--dsw-alias-label-secondary)}.dt-sidebar-heading>span{display:flex;align-items:center;gap:6px;font-size:12px}.dt-sidebar-heading>button{width:26px;height:26px;border-radius:6px}.dt-character-group{margin-top:2px}.dt-character-row{display:flex;align-items:center;gap:2px}.dt-character-toggle{height:32px;min-width:0;flex:1;display:flex;align-items:center;gap:5px;border-radius:6px;padding:0 5px;text-align:left}.dt-character-toggle svg{transform:rotate(-90deg);transition:transform .15s}.dt-character-toggle svg.dt-chevron-open{transform:rotate(0)}.dt-character-toggle img{width:22px;height:22px;border-radius:5px;object-fit:cover}.dt-character-toggle span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dt-character-row>button:last-child{width:28px;height:28px;display:grid;place-items:center;border-radius:6px;flex:none}.dt-sidebar-chats{display:flex;flex-direction:column;margin:1px 0 4px 28px}.dt-sidebar-chat-row{height:28px;border-radius:6px;display:grid;grid-template-columns:minmax(0,1fr) 26px 26px;align-items:center;color:var(--dsw-alias-label-secondary)}.dt-sidebar-chat-open{height:28px;min-width:0;text-align:left;padding:0 7px;color:inherit;font-size:12px}.dt-sidebar-chat-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){width:26px;height:26px;display:grid;place-items:center;border-radius:5px;opacity:0}.dt-sidebar-chat-row:hover>button:not(.dt-sidebar-chat-open),.dt-sidebar-chat-row:focus-within>button:not(.dt-sidebar-chat-open){opacity:1}.dt-sidebar-chat-row.dt-sidebar-chat-active{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.dt-sidebar-status,.dt-sidebar-error{padding:4px 7px;font-size:11px;line-height:16px}.dt-floating-shell{position:fixed;z-index:2147400000;inset:64px auto 24px 12px;width:min(310px,calc(100vw - 24px));pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px rgba(0,0,0,.2);overflow:auto;padding:8px}.dt-footer-action{height:32px;display:flex;align-items:center;gap:7px;border-radius:6px;padding:0 7px}.dt-footer-action span{font-size:12px}
        @media(max-width:700px){[role="dialog"]:has(.dt-settings){flex-direction:column}[role="dialog"]:has(.dt-settings)>nav{box-sizing:border-box;width:100%;height:auto;max-height:190px;flex:none;overflow-y:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}[role="dialog"]:has(.dt-settings)>nav>:last-child{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:auto}[role="dialog"]:has(.dt-settings)>nav>:last-child>button{width:100%;min-width:0}[role="dialog"]:has(.dt-settings)>:not(nav){width:100%;min-width:0;flex:1}.dt-settings-heading{padding:16px}.dt-settings-band{padding:16px}.dt-settings-grid,.dt-check-grid{grid-template-columns:1fr}.dt-model{display:none}.dt-view{padding-inline:10px}.dt-transcript-end{height:132px}.dt-message{max-width:94%}.dt-scene-strip{top:0}.dt-header-character>span{display:none}.dt-composer-wrap{padding-inline:8px}.dt-message-edit{width:78vw}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){opacity:1}}
      `
      document.head.appendChild(tag)
    }

    function apply(ctx) {
      installStyle()
      SidebarAdapter.context = ctx
      void refreshBootstrap().catch(() => {})
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-tavern',
        order: 45,
        label: () => 'dsh-tavern',
        inject: () => ({}),
      }, TavernSettings))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'tavern',
        order: 20,
        label: () => 'Tavern',
        inject: () => ({}),
      }, TavernView))
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -20,
        select: selectTavernComposer,
        inject: () => ({}),
      }, TavernComposer))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'dsh-tavern',
        order: -5,
        inject: () => ({}),
      }, TavernHeaderAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-tavern-sidebar-adapter',
        order: 20,
        inject: () => ({}),
      }, SidebarAdapter))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-tavern-fallback',
        order: 20,
        inject: () => ({}),
      }, SidebarFooterAction))
    }

    exports.name = 'dsh-tavern'
    exports.inject = ['slots', 'sessions', 'workspaces']
    exports.apply = apply
    return module.exports
  },
})
