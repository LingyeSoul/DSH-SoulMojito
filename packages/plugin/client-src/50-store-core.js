    const STYLE_ID = 'dsh-soulmojito/native-ui'
    const REVISION_CONFLICT = 'CHAT_REVISION_CONFLICT'
    const NOVEL_REVISION_CONFLICT = 'NOVEL_REVISION_CONFLICT'
    const STORE_REVISION_POLL_MS = 3000
    const EMPTY_BOOTSTRAP = {
      storeRevision: '',
      state: {
        activeWorlds: [], sessionBindings: {}, defaultArchitecture: 'agent-tavern', defaultContextMode: 'dsh-native',
        agentTavernPreloadAssets: false, agentTavernAllowGlobalWrites: false, worldFollowsCharacter: true, modelSelections: {}, chats: {}, regexScripts: [], scriptGlobals: {},
      },
      characters: [],
      worlds: [],
      presets: [],
      presetKinds: {},
      personas: [],
      groups: [],
      activeCard: null,
      model: { provider: '', model: '' },
      internalWorkspace: null,
      // Mod 轻量投影（提案 0015 §3.5 P1）：bootstrap.mods 是清单快照，actions
      // 走 /mods 管理路由；modsAvailable=false 表示环境变量硬关。
      mods: [],
      modsAvailable: true,
      agentTavern: {
        native: { available: false, missing: [], reasons: [] },
        managed: { available: false, missing: [], reasons: [] },
      },
      agentNovel: { available: false, missing: [], reasons: [] },
      // 宿主 /update 快照（bootstrap 里带的是磁盘缓存结论）。字段与
      // src/update/service.ts 的 TavernUpdateSnapshot 对齐。
      update: {
        status: 'unknown', reason: '', checkedAt: null, nextCheckAt: null, error: '', source: 'none',
        repository: '', ref: '', local: { version: '', commit: '' }, remote: null, spec: '',
        install: {
          running: false, phase: 'idle', strategy: null, startedAt: null, finishedAt: null,
          message: '', restartRequired: false, installed: null, log: [],
        },
      },
    }
    const EMPTY_MODELS = { status: 'idle', groups: [], failures: [], error: '' }
    let snapshot = {
      bootstrap: EMPTY_BOOTSTRAP,
      loading: true,
      error: '',
      chatLists: {},
      chats: {},
      revisions: {},
      displays: {},
      runs: {},
      models: EMPTY_MODELS,
      panelOpen: false,
      panelSection: 'overview',
      navigationStatus: '',
      // 侧边栏分区折叠（酒馆 / 写卡工作台）：进 store 而非组件 state，docked
      // 侧栏门户与面板聊天分区两个挂载点共享同一份折叠态（panelSection 同款
      // UI 状态语义，页面重载随 store 回到默认态）。酒馆默认展开，写卡工作台
      // 默认收起（2026-10-16）：出卡/自由工作台会话通常多于正在用的那一个，默认
      // 展开会把宿主会话工作区挤下去；标题行的「+」钮折叠态仍可新建。
      sidebarCollapsed: { tavern: false, workbench: true },
      // 剧本库写操作（导入/绑定/解绑）的广播计数：绑定写在卡 extensions 上，
      // 不经过聊天 revision，进度卡靠它感知重取（绑定后出现 / 解绑后隐藏）。
      scriptsRevision: 0,
    }
    const listeners = new Set()
    const pendingChats = new Map()
    const pendingLists = new Map()
    const pendingModels = new Map()
    const controllers = new Map()
    // 存量 blank 绑定会话的修复去重（成功修复的 sessionId；失败会移除以待重试）
    const repairedBindings = new Set()
    let internalWorkspace
    let internalWorkspacePromise
    let workbenchWorkspace
    let workbenchWorkspacePromise

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
        // Mod 声明分区跟随 bootstrap（§3.5）：签名变化时重建注册（加载/停用/
        // 标题改动都会反映到导航）。update 之后调用——组件读取的是新 snapshot。
        syncModPanelSections(result)
        return result
      } catch (cause) {
        update({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
    }

    // 资产变更水位（store-revision）：写卡 Agent 等后台写入直接在服务端落盘、
    // 没有推送通道，客户端轮询它与 bootstrap 携带的 storeRevision 比对，变化
    // 即重取 bootstrap。与自更新安装进度（1.5s 轮询 `/update`）同款轮询策略，
    // 不引入 SSE。
    async function fetchStoreRevision() {
      const result = await api('store-revision')
      return typeof result.revision === 'string' ? result.revision : ''
    }

    // 自更新三件套：读快照（宿主缓存结论，默认不打网络）、强制检查、开始安装。
    // 安装可能跑几十秒（pnpm add），宿主在 install 里维护进度日志，客户端按
    // 1.5s 轮询快照即可看到阶段与日志，不需要 SSE。
    async function loadUpdateSnapshot(refresh) {
      const result = await api(refresh === true ? 'update?refresh=1' : 'update')
      return result.update || null
    }

    async function requestUpdateCheck() {
      const result = await api('update/check', { method: 'POST', headers: jsonHeaders(), body: '{}' })
      return result.update || null
    }

    async function requestUpdateInstall(force) {
      const result = await api('update/install', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ force: force === true, wait: false }),
      })
      return result.update || null
    }

    async function patchState(patch) {
      await api('state', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(patch) })
      return refreshBootstrap()
    }

    async function loadModels(force) {
      if (!force && snapshot.models.status !== 'idle') return snapshot.models
      if (pendingModels.has('all')) return pendingModels.get('all')
      update({ models: { ...snapshot.models, status: 'loading', error: '' } })
      const pending = api('models')
        .then((result) => {
          update({
            models: { status: 'ready', groups: result.groups, failures: result.failures, error: '' },
          })
          return snapshot.models
        })
        .catch((cause) => {
          update({ models: { ...snapshot.models, status: 'error', error: cause instanceof Error ? cause.message : String(cause) } })
          throw cause
        })
        .finally(() => pendingModels.delete('all'))
      pendingModels.set('all', pending)
      return pending
    }

    async function saveModelSelection(sessionId, selection) {
      const result = await api('model', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId, selection }),
      })
      update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })
      return result.state
    }

    function sessionSelection(sessionId) {
      const state = snapshot.bootstrap.state
      const saved = state.modelSelections?.[sessionId]
      if (saved?.provider && saved?.model) return saved
      const fallback = snapshot.bootstrap.model
      return fallback?.provider && fallback?.model ? fallback : null
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
            displays: { ...snapshot.displays, [key]: result.displays },
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
        // mod-event 下行（A-1d）：tap 本客户端成功的 PUT chat（消息编辑/swipe 切换
        // 等都经此函数），推给挂载的 ModSurface。
        broadcastModEvent('chat-saved', { character, chatId, revision: result.revision })
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
          [sessionId]: { busy: false, streamText: '', streamReasoning: '', status: '', error: '', ...(snapshot.runs[sessionId] || {}), ...patch },
        },
      })
    }

    // 持续指引（提案 0009）与行动候选（提案 0010）的写路径：服务端自读快照做
    // revision CAS，响应携带新 revision。客户端照 chat 写路径（saveChat /
    // runTavernScriptCommand）同步 revisions[key]，并强刷本地聊天快照——这两
    // 类写只改 chat_metadata，不返回整个 chat，缓存里的 chats[key] 必须重取。
    function syncChatRevision(character, chatId, revision) {
      if (typeof revision !== 'string') return
      const key = chatKey(character, chatId)
      update({ revisions: { ...snapshot.revisions, [key]: revision } })
      void loadChat(character, chatId, true).catch(() => {})
    }

    function guidesPath(character, chatId, id) {
      const base = `guides/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
      return id === undefined ? base : `${base}/${encodeURIComponent(id)}`
    }

    function loadGuides(character, chatId) {
      return api(guidesPath(character, chatId))
    }

    async function addChatGuide(character, chatId, text) {
      const result = await api(guidesPath(character, chatId), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ text }),
      })
      syncChatRevision(character, chatId, result.revision)
      // mod-event 下行（A-1d）：guides 写入的 tap（与 Node 侧 guides 总线同款 payload）。
      broadcastModEvent('guides-changed', { character, chatId })
      return result
    }

    async function removeChatGuide(character, chatId, id) {
      const result = await api(guidesPath(character, chatId, id), { method: 'DELETE' })
      syncChatRevision(character, chatId, result.revision)
      broadcastModEvent('guides-changed', { character, chatId })
      return result
    }

    // chat_metadata.candidates 的读取容错（形状对齐 src/candidates.ts 的
    // readStoredCandidates：kind 非 scene 即 action，缺文本丢弃，空集视为无）。
    function normalizeStoredCandidates(value) {
      if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null
      const items = value.items
        .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim() !== '')
        .map((item) => ({ kind: item.kind === 'scene' ? 'scene' : 'action', text: item.text }))
      if (items.length === 0) return null
      return {
        items,
        generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
        ...(typeof value.feedback === 'string' && value.feedback !== '' ? { feedback: value.feedback } : {}),
      }
    }

    async function generateChatCandidates(sessionId, binding, feedback) {
      const key = chatKey(binding.character, binding.chatId)
      const result = await api('candidates', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          sessionId,
          character: binding.character,
          chatId: binding.chatId,
          revision: snapshot.revisions[key],
          ...(feedback !== undefined ? { feedback } : {}),
        }),
      })
      syncChatRevision(binding.character, binding.chatId, result.revision)
      return result
    }

    // MVU 状态与回执（提案 0012 P1）的读写路径：GET mvu/status 与写路径同样
    // 走 revision CAS（POST mvu/retry 响应携带新 revision，照 guides/candidates
    // 模式同步 revisions[key] 并强刷本地聊天快照——回执落在 chat_metadata）。
    function mvuStatusPath(character, chatId) {
      return `mvu/status/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
    }

    function loadMvuStatus(character, chatId) {
      return api(mvuStatusPath(character, chatId))
    }

    async function retryMvuSettlement(sessionId, binding) {
      const key = chatKey(binding.character, binding.chatId)
      const result = await api('mvu/retry', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          sessionId,
          character: binding.character,
          chatId: binding.chatId,
          revision: snapshot.revisions[key],
        }),
      })
      syncChatRevision(binding.character, binding.chatId, result.revision)
      return result
    }

    // 回执撤销（B-6a）：撤销最新一条有效回执。两架构都可撤销（服务端按绑定
    // 架构改派执行核）；revision 是可选预检——本地有才带（AgentTavern 会话的
    // 本地 revision 可能缺失，服务端以快照 CAS 兜底）。响应携带新 revision，
    // 与 retry 同款同步 revisions[key] 并强刷本地聊天快照。
    async function undoMvuSettlement(binding) {
      const key = chatKey(binding.character, binding.chatId)
      const revision = snapshot.revisions[key]
      const result = await api('mvu/receipts/undo', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          character: binding.character,
          chatId: binding.chatId,
          ...(typeof revision === 'string' ? { revision } : {}),
        }),
      })
      syncChatRevision(binding.character, binding.chatId, result.revision)
      return result
    }

    // 剧本游玩（提案 0014 P1）：剧本库（GET scripts / POST script/import）与
    // 绑定（POST script/bind / script/unbind，写在卡 extensions 上，非聊天
    // revision 域）；进度 GET script/progress 由生成链路的对齐推进写，这里只读。
    function scriptProgressPath(character, chatId) {
      return `script/progress/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
    }

    function loadScriptProgress(character, chatId) {
      return api(scriptProgressPath(character, chatId))
    }

    function loadScriptsLibrary() {
      return api('scripts')
    }

    function importScriptAsset(name, content, format) {
      return api('script/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, content, ...(format !== undefined ? { format } : {}) }),
      })
    }

    function bindCharacterScript(character, scriptName) {
      return api('script/bind', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character, scriptName }),
      })
    }

    function unbindCharacterScript(character) {
      return api('script/unbind', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character }),
      })
    }

    function bumpScriptsRevision() {
      update({ scriptsRevision: snapshot.scriptsRevision + 1 })
    }

    // 卡片工作台方案确认协议（提案 0013 P2）：面板拉 pending/全量方案列表并
    // 给决定；approve=true 由服务端执行核按方案写入工作版并标记 applied。
    function loadWorkbenchPlans(status = 'all', character) {
      const params = new URLSearchParams()
      params.set('status', status)
      if (character) params.set('character', character)
      return api(`card-workbench/plans?${params.toString()}`)
    }

    function decideWorkbenchPlan(planId, approve) {
      return api(`card-workbench/plans/${encodeURIComponent(planId)}/decision`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ approve }),
      })
    }

    async function generateFor(sessionId, binding, mode, text, options = {}) {
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
      setRun(sessionId, { busy: true, streamText: '', streamReasoning: '', status: 'run.connecting', error: '' })
      const selection = sessionSelection(sessionId)
      try {
        const response = await fetch(`${API}/generate`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            revision: snapshot.revisions[key],
            message,
            mode,
            // 带意见重写（提案 0011）：feedback 仅 regenerate 可携带（服务端同款
            // 校验，非 regenerate 带该字段会被拒）；空串等价普通重掷，不发送。
            ...(mode === 'regenerate' && typeof options.feedback === 'string' && options.feedback.trim() !== '' ? { feedback: options.feedback.trim() } : {}),
            ...(binding.group === true ? { group: true } : {}),
            ...(options.triggerMember ? { triggerMember: options.triggerMember } : {}),
            ...(selection ? {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
            } : {}),
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
        let streamedReasoning = ''
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            if (event.type === 'start') {
              const via = `${event.provider}/${event.model}`
              setRun(sessionId, { status: event.speaker && event.speaker !== binding.character ? `${event.speaker} · ${via}` : via, speaker: event.speaker })
            }
            if (event.type === 'delta') {
              streamed += event.text
              setRun(sessionId, { streamText: streamed })
            }
            // 思考流式（与 /generate 的 {type:'reasoning'} SSE 增量对齐）：正文
            // delta 之前逐段到达，累积进独立通道——run.streamReasoning 由
            // TavernView 拼进流式伪楼层，MessageRow 以思考块渲染。
            if (event.type === 'reasoning') {
              streamedReasoning += event.text
              setRun(sessionId, { streamReasoning: streamedReasoning })
            }
            if (event.type === 'error') {
              const error = new Error(event.message || translate('run.failed'))
              error.code = event.code
              throw error
            }
            if (event.type === 'saved') {
              update({
                chats: { ...snapshot.chats, [key]: event.chat },
                revisions: { ...snapshot.revisions, [key]: event.revision },
              })
              setRun(sessionId, { streamText: '', streamReasoning: '', status: 'run.saved' })
              // mod-event 下行（A-1d）：生成两段落盘的 tap（用户+助手消息一次写）。
              broadcastModEvent('chat-saved', { character: binding.character, chatId: binding.chatId, revision: event.revision })
            }
          }
          if (part.done) break
        }
      } catch (cause) {
        const aborted = controller.signal.aborted
        setRun(sessionId, {
          error: aborted ? '' : (cause instanceof Error ? cause.message : String(cause)),
          status: aborted ? 'run.stopped' : '',
          streamText: '',
          streamReasoning: '',
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
