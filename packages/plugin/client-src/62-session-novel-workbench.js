      return `AgentNovel · ${String(title || '').slice(0, 60)}`.slice(0, 80)
    }

    // novel-open 通过既有内部桥接命令绑定会话（服务端负责绑定 + recompose
    // agent-novel preset + 唤醒 driver）；发送后轮询 bootstrap 直到会话出现在
    // sessionBindings 且 architecture === 'agent-novel'。
    async function waitForNovelBinding(sessionId, novelId) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const bootstrap = await refreshBootstrap()
          const binding = bootstrap?.state?.sessionBindings?.[sessionId]
          if (binding?.architecture === 'agent-novel' && (novelId === null || binding.novelId === novelId)) return binding
        } catch {
          // Bootstrap may briefly fail while the server binds; keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    }

    async function openNovelSession(ctx, novel) {
      update({ navigationStatus: translate('novel.opening') })
      try {
        const sessions = ctx.sessions.list.getSnapshot()
        const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
          .find(([sessionId, binding]) => binding?.architecture === 'agent-novel'
            && binding.novelId === novel.novelId
            && sessions.byId[sessionId])
        if (existing) {
          reserveTavernSession(ctx, existing[0])
          openSessionView(ctx, existing[0])
          return existing[0]
        }
        const workspace = await ensureTavernWorkspace(ctx)
        const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-novel')
        // 与 openTavernChat 同因：0.2.0 宿主 connect 不再隐式 retain，先显式
        // 持有再借 binding，openSessionView 接棒 mainView 保留后归还。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          if (!binding) throw new Error(translate('error.noBinding'))
          const commandPayload = base64Url(JSON.stringify({ action: 'novel-open', novelId: novel.novelId }))
          const result = await binding.session.command(`/dsh-soulmojito-session ${commandPayload}`)
          if (!result?.ok || !result.value?.matched) {
            throw new Error(result.error?.message || translate('error.activationFailed'))
          }
          reserveTavernSession(ctx, sessionId)
          const bound = await waitForNovelBinding(sessionId, novel.novelId)
          if (!bound) throw new Error(translate('novel.bindTimeout'))
          await binding.session.rename(novelSessionLabel(novel.title)).catch(() => {})
          openSessionView(ctx, sessionId)
          return sessionId
        } finally {
          heldSession.release()
        }
      } finally {
        update({ navigationStatus: '' })
      }
    }

    // workbench-open（提案 0013）：与 novel-open 同款桥接——服务端负责绑定 +
    // recompose card-workbench preset；发送后轮询 bootstrap 直到会话出现在
    // sessionBindings 且 architecture === 'card-workbench'、来源身份匹配。
    // source 为 null 时匹配自由工作台（sourceCharacter/sourceChatId 均空）。
    function workbenchBindingMatches(binding, source) {
      if (binding?.architecture !== 'card-workbench') return false
      return source
        ? binding.sourceCharacter === source.character && binding.sourceChatId === source.chatId
        : !binding.sourceCharacter && !binding.sourceChatId
    }

    async function waitForWorkbenchBinding(sessionId, source) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const bootstrap = await refreshBootstrap()
          const binding = bootstrap?.state?.sessionBindings?.[sessionId]
          if (workbenchBindingMatches(binding, source)) return binding
        } catch {
          // Bootstrap may briefly fail while the server binds; keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    }

    // 每个聊天对应一个写卡工作会话：source 携带来源聊天身份时按身份幂等复用
    // （聊天侧「交给工作台」）；source 为 null 时是面板拉起的自由工作台，「+」
    // 与新建角色卡向导走 fresh 每次新建（幂等复用会把新建短路成跳转旧会话，
    // 决策 2026-10-08 workbench-blank-reuse 客户端补充）。工作台会话落在专用
    // 内部工作区（Tavern Workbench (internal)）。
    function workbenchSessionLabel(source, ordinal = 0) {
      return source
        ? translate('workbench.chatSessionLabel', {
          character: source.character,
          chat: String(source.chatId).replace(/\.jsonl$/i, ''),
        })
        : ordinal > 1 ? `${translate('workbench.sessionLabel')} ${ordinal}` : translate('workbench.sessionLabel')
    }

    // 打开既有工作台会话（侧栏列表行、聊天侧「交给工作台」的复用分支）同样要
    // 保证内部工作区仍然登记：这两条路径此前只 openSessionView，从不经过
    // ensureWorkbenchWorkspace，宿主工作区登记被删/被重置、或会话创建于专用
    // 工作区之前时，内部对应工作区就再也不会被创建。按路径重建的 workspace
    // 会把旧会话按 cwd 重新归组；best-effort，绝不阻断导航。
    function openWorkbenchSessionView(ctx, sessionId) {
      reserveTavernSession(ctx, sessionId)
      openSessionView(ctx, sessionId)
      void ensureWorkbenchWorkspace(ctx).catch(() => {})
    }

    async function openWorkbenchSession(ctx, source = null, { fresh = false } = {}) {
      update({ navigationStatus: translate('workbench.opening') })
      try {
        // 幂等复用只服务「回到已有工作台」的入口（聊天侧「交给工作台」按来源
        // 身份复用，一聊一会话）；fresh 入口（侧栏「+」、新建角色卡向导）必须
        // 跳过——否则同来源会话存活期间点「新建」永远只是跳回旧会话。
        if (!fresh) {
          const sessions = ctx.sessions.list.getSnapshot()
          const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
            .find(([sessionId, binding]) => workbenchBindingMatches(binding, source) && sessions.byId[sessionId])
          if (existing) {
            openWorkbenchSessionView(ctx, existing[0])
            return existing[0]
          }
        }
        const workspace = await ensureWorkbenchWorkspace(ctx)
        const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId, 'card-workbench')
        // 与 openTavernChat 同因：0.2.0 宿主 connect 不再隐式 retain，先显式
        // 持有再借 binding，openSessionView 接棒 mainView 保留后归还。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          if (!binding) throw new Error(translate('error.noBinding'))
          const commandPayload = base64Url(JSON.stringify(source
            ? { action: 'workbench-open', sourceCharacter: source.character, sourceChatId: source.chatId }
            : { action: 'workbench-open' }))
          const result = await binding.session.command(`/dsh-soulmojito-session ${commandPayload}`)
          if (!result?.ok || !result.value?.matched) {
            throw new Error(result.error?.message || translate('error.activationFailed'))
          }
          reserveTavernSession(ctx, sessionId)
          const bound = await waitForWorkbenchBinding(sessionId, source)
          if (!bound) throw new Error(translate('workbench.bindTimeout'))
          // 多自由工作台并存时按现存数给宿主标题带序号（第 2 个起），面板列表
          // WorkbenchList 用同款序号区分同名条目；聊天侧工作台按来源身份天然
          // 唯一，出卡后统一改名为卡名。
          const freeOrdinal = source ? 0 : 1 + Object.entries(snapshot.bootstrap.state.sessionBindings || {})
            .filter(([sid, binding]) => sid !== sessionId && workbenchBindingMatches(binding, null) && ctx.sessions.list.getSnapshot().byId[sid])
            .length
          await binding.session.rename(workbenchSessionLabel(source, freeOrdinal)).catch(() => {})
          openSessionView(ctx, sessionId)
          return sessionId
        } finally {
          heldSession.release()
        }
      } finally {
        update({ navigationStatus: '' })
      }
    }

    // 写卡会话改名（对齐酒馆聊天侧边栏的改名能力）：title 落进绑定（侧边栏
    // 分组标签的数据源，压过 createdCard 与来源派生标签），宿主会话标题经
    // binding.session.rename 同步（best-effort，失败只丢宿主标题不改绑定）。
    async function renameWorkbenchSession(ctx, sessionId, currentLabel) {
      const name = window.prompt(translate('workbench.renamePrompt'), currentLabel)
      if (name === null || name.trim() === '' || name.trim() === currentLabel) return false
      await api('card-workbench/rename', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId, title: name.trim() }),
      })
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const binding = ctx.sessions.binding(sessionId)
        await binding?.session.rename(name.trim()).catch(() => {})
      } finally {
        heldSession.release()
      }
      await refreshBootstrap()
      return true
    }

    // 写卡会话删除（对齐酒馆聊天侧边栏的删除能力）：会话数据本体在宿主侧，
    // 删绑定 + 归档会话即删干净（工作台方案按卡/世界书独立存储，不受影响，
    // 面板仍可见）。不发 close 桥接命令——那是给存活的 ST 会话留「已关闭」
    // 用的，删除路径写进去只会污染将被归档的记录。
    async function deleteWorkbenchSession(ctx, sessionId) {
      await api('binding', {
        method: 'DELETE',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId }),
      })
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        await ctx.workspaces.archiveSession(sessionId).catch(() => {})
      } finally {
        heldSession.release()
      }
      await refreshBootstrap()
      return true
    }

    async function branchTavernChat(ctx, character, chatId, index, sessionId, targetArchitecture) {
      const key = chatKey(character, chatId)
      const revision = snapshot.revisions[key]
      if (!revision) throw new Error(translate('view.loading'))
      const result = await api('branch', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          character, chatId, messageId: index, revision,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          originArchitecture: bindingArchitecture(snapshot.bootstrap.state.sessionBindings?.[sessionId]),
          targetArchitecture: targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st',
        }),
      })
      const nextKey = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [nextKey]: result.chat },
        revisions: { ...snapshot.revisions, [nextKey]: result.revision },
      })
      await loadChatList(character, true)
      return openTavernChat(ctx, character, result.id, false, {
        architecture: targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st',
        contextMode: 'dsh-native',
      })
    }

    async function forkTavernArchitecture(ctx, sessionId, binding) {
      const chat = await loadChat(binding.character, binding.chatId)
      if (!chat || chat.messages.length === 0) throw new Error(translate('view.loading'))
      const target = bindingArchitecture(binding) === 'agent-tavern' ? 'st' : 'agent-tavern'
      return branchTavernChat(ctx, binding.character, binding.chatId, chat.messages.length - 1, sessionId, target)
    }

    async function runTavernScriptCommand(sessionId, binding, script) {
      setRun(sessionId, { busy: true, streamText: '', status: 'composer.script', error: '' })
      try {
        const result = await api('script', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            character: binding.character,
            chatId: binding.chatId,
            ...(binding.group === true ? { group: true } : {}),
            script,
          }),
        })
        const key = chatKey(binding.character, binding.chatId)
        update({
          chats: { ...snapshot.chats, [key]: result.chat },
          revisions: { ...snapshot.revisions, [key]: result.revision },
        })
        // mod-event 下行（A-1d）：STscript persist 的 tap（/setvar 等命令落盘）。
        broadcastModEvent('chat-saved', { character: binding.character, chatId: binding.chatId, revision: result.revision })
        setRun(sessionId, {
          streamText: '',
          status: result.output ? `↳ ${result.output.slice(0, 120)}` : 'run.saved',
        })
      } catch (cause) {
        setRun(sessionId, { error: cause instanceof Error ? cause.message : String(cause), status: '' })
        await loadChat(binding.character, binding.chatId, true).catch(() => {})
      } finally {
        setRun(sessionId, { busy: false })
      }
    }

    function boundSessionIds(character, chatId) {
      return Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .filter(([, binding]) => binding.character === character && binding.chatId === chatId)
        .map(([sessionId]) => sessionId)
    }

    function sessionLabel(character, chatId, group = false, architecture = 'st') {
      const stem = chatId.replace(/\.jsonl$/i, '').slice(0, 44)
      const prefix = group ? '☰' : architecture === 'agent-tavern' ? 'AgentTavern' : 'ST'
      return `${prefix} ${character} · ${stem}`
    }

    function chatArchitectureLabels(character, chatId, group = false) {
      const matches = Object.values(snapshot.bootstrap.state.sessionBindings || {})
        .filter((binding) => binding?.character === character && binding?.chatId === chatId)
        .map((binding) => architectureLabel(bindingArchitecture(binding)))
      if (matches.length === 0) return [architectureLabel(group ? 'st' : snapshot.bootstrap.state.defaultArchitecture)]
      return [...new Set(matches)]
    }

    async function renameTavernChat(ctx, character, chatId) {
      const currentName = chatId.replace(/\.jsonl$/i, '')
      const name = window.prompt(translate('nav.renamePrompt'), currentName)
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
          // 已绑定会话可能不在主视图（binding() 为 undefined），显式持有后才
          // 能补齐宿主侧 rename。
          const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
          try {
            const binding = ctx.sessions.binding(sessionId)
            await binding?.session.rename(sessionLabel(character, result.id, binding?.group === true, bindingArchitecture(binding))).catch(() => {})
          } finally {
            heldSession.release()
          }
        }))
        return result.id
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    async function deleteTavernChat(ctx, character, chatId) {
      const label = chatId.replace(/\.jsonl$/i, '')
      if (!window.confirm(translate('nav.deleteConfirm', { name: label }))) return false
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
        // close 桥接命令需要会话作用域存活；不在主视图的绑定会话先显式持有。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          await api('binding', {
            method: 'DELETE',
            headers: jsonHeaders(),
            body: JSON.stringify({ sessionId }),
          }).catch(() => {})
          await binding?.session.command(`/dsh-soulmojito-session ${closePayload}`).catch(() => {})
          await ctx.workspaces.archiveSession(sessionId).catch(() => {})
        } finally {
          heldSession.release()
        }
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
        if (node?.kind !== 'context') continue
        // v4 宿主把 plugin source 归并为 producer-owned kind（'plugin:dsh-soulmojito'，
        // 与宿主 v3→v4 迁移产物一致）；v0-v3 宿主仍是 { kind: 'plugin', plugin }。
        // 改名兼容（2026-10-16）：旧名 dsh-tavern 的 kind/plugin 值双认（存量会话）。
        const source = node.data?.source
        const isTavernSource = source?.kind === 'plugin:dsh-soulmojito' || source?.kind === 'plugin:dsh-tavern'
          || (source?.kind === 'plugin' && (source.plugin === 'dsh-soulmojito' || source.plugin === 'dsh-tavern'))
        if (isTavernSource && source.form === 'notice') {
          // 关闭判据双轨：v0 会话的关闭 marker 带 tavernState 成员；disposition
          // 收敛后服务端只写 summary: 'Tavern closed'（见 confirmable-session-writes
          // 决策 §5）——只认旧成员会把已关闭会话重新判活，composer 重新接管。
          const closed = source.tavernState === 'closed' || source.summary === 'Tavern closed'
          match = closed ? null : { marker: node.key }
        }
      }
      return match
    }

    function selectTavernComposer(owner) {
      return isTavernSession(owner.session)
    }