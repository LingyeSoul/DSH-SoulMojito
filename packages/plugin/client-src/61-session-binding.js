    // 宿主 sessions store 的快照是 SessionListState { ids, byId, phase,
    // projectionsBySession }——没有 current 字段（dsh-api-session-controller
    // lib/types/client/sessions/service.d.ts）。宿主自己的组件（DocumentTitle /
    // CordisPanel / ui-session.publishMain）一律以 retainedBy.mainView > 0 推导
    // 「主视图中的会话」。这里照宿主同款口径推导；若未来宿主补充 current 字段则
    // 优先直读。返回 string | undefined，引用稳定，可直接喂给 selector hook。
    function useCurrentSessionId(useSessions) {
      return useSessions((sessions) => {
        if (typeof sessions?.current === 'string') return sessions.current
        for (const session of Object.values(sessions?.byId || {})) {
          if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id
        }
        return undefined
      })
    }

    function architectureLabel(architecture) {
      if (architecture === 'agent-novel') return translate('view.architectureNovel')
      if (architecture === 'card-workbench') return translate('workbench.sessionLabel')
      return architecture === 'agent-tavern' ? translate('view.architectureAgent') : translate('view.architectureSt')
    }

    function newChatPolicy(group = false, override = {}) {
      if (group) return { architecture: 'st', contextMode: 'dsh-native' }
      const state = snapshot.bootstrap.state || {}
      const architecture = override.architecture === 'st' || override.architecture === 'agent-tavern'
        ? override.architecture
        : state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'
      const contextMode = override.contextMode === 'agent-managed' || state.defaultContextMode === 'agent-managed'
        ? 'agent-managed'
        : 'dsh-native'
      if (architecture === 'agent-tavern') {
        const status = contextMode === 'agent-managed'
          ? snapshot.bootstrap.agentTavern?.managed
          : snapshot.bootstrap.agentTavern?.native
        if (!status?.available) {
          const reason = status?.reasons?.join(' ') || translate('error.agentTavernUnavailable', { reason: 'host capability check failed' })
          const error = new Error(translate('error.agentTavernUnavailable', { reason }))
          error.code = 'TAVERN_ARCHITECTURE_CONFLICT'
          error.status = 409
          throw error
        }
      }
      return { architecture, contextMode }
    }

    function activationFields(policy) {
      return policy.architecture === 'agent-tavern'
        ? { architecture: policy.architecture, contextMode: policy.contextMode }
        : { architecture: 'st' }
    }

    function reserveTavernSession(ctx, sessionId) {
      // rc.6 connectWorkspace reuses any locally blank session. AgentTavern
      // cannot append a synthetic turn/start, so clear only the client blank
      // mirror while keeping the durable event log untouched.
      ctx?.sessions?.binding(sessionId)?.session?.handleBlank?.(false)
    }

    // 诊断（0.2.0-rc.2 适配期临时）：侧边栏错误原本只显示 message，定位
    // 「Cannot read properties of undefined (reading 'sessionId')」这类宿主链路
    // 抛点需要首帧栈位。同时把完整 stack 存 window.__DSH_SOULMOJITO_DIAG__ 供
    // devtools 取用；问题定位后移除。
    function sidebarErrorDetail(cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const stack = cause instanceof Error ? String(cause.stack || '') : ''
      try {
        window.__DSH_SOULMOJITO_DIAG__ = [...(window.__DSH_SOULMOJITO_DIAG__ || []), { message, stack, at: new Date().toISOString() }].slice(-10)
      } catch { /* 诊断本身不许抛 */ }
      console.error('[dsh-soulmojito] sidebar error:', cause)
      const frames = stack.split(/\r?\n/).slice(1, 4).map((line) => line.trim()).filter(Boolean)
      return frames.length > 0 ? `${message} ⏎ ${frames.join(' ⏎ ')}` : message
    }

    function clickTavernTab(attempt) {
      // The conversation.view tab label is translated via the slot's label()
      // callback, so match every shipped spelling of the Tavern title.
      const titles = [MESSAGES_EN['nav.title'], MESSAGES_ZH['nav.title']]
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((item) => titles.includes(item.textContent?.trim() || ''))
      if (tab instanceof HTMLElement) {
        tab.click()
        return
      }
      if (attempt < 12) setTimeout(() => clickTavernTab(attempt + 1), 50)
    }

    // 旧版本激活的绑定会话在宿主侧仍是 blank（无 turn/start），会被原生「新建
    // 会话」的 blank 复用逻辑劫持。对其幂等重发内部绑定桥接命令，服务端
    // 补齐 marker 和占位 turn 对即摘除。成功记入 repairedBindings，失败移除以待
    // 下次触发重试。AgentTavern 桥接命令对已初始化会话是一次性的，重发只会
    // 往会话记录里塞报错，摘除客户端 blank 镜像即可；仅 initializationPending
    // 的绑定才需要重发以补完初始化。CardWorkbench 的同来源重发是幂等安全路径
    // （服务端不重复 recompose、只补占位），与 ST 同走命令重发。
    async function repairBinding(ctx, sessionId, binding) {
      if (!binding || repairedBindings.has(sessionId)) return
      repairedBindings.add(sessionId)
      // Novel bindings are established by the novel-open bridge command; the
      // generic repair path only clears the client blank mirror so the native
      // new-chat reuse cannot hijack the session.
      if (binding.architecture === 'agent-novel') {
        reserveTavernSession(ctx, sessionId)
        return
      }
      if (binding.architecture === 'card-workbench') {
        // 旧版本打开的工作台会话宿主侧仍是 blank（无 turn/start），会劫持下一次
        // openWorkbenchSession 的 connect 并撞上「已绑定其他来源」守卫。重发同
        // 来源 workbench-open 让服务端补占位 turn 对（幂等：marker 已在则不
        // recompose，同来源通过已启动锁，绑定重写保留 createdCard）。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const payload = base64Url(JSON.stringify({
            action: 'workbench-open',
            sourceCharacter: typeof binding.sourceCharacter === 'string' ? binding.sourceCharacter : '',
            sourceChatId: typeof binding.sourceChatId === 'string' ? binding.sourceChatId : '',
          }))
          const bound = ctx?.sessions?.binding(sessionId)
          if (!bound) throw new Error('session binding unavailable')
          const result = await bound.session.command(`/dsh-soulmojito-session ${payload}`)
          if (!result?.ok || !result.value?.matched) throw new Error('Tavern session bridge rejected')
          reserveTavernSession(ctx, sessionId)
        } catch {
          repairedBindings.delete(sessionId)
        } finally {
          heldSession.release()
        }
        return
      }
      if (bindingArchitecture(binding) !== 'st' && binding.initializationPending !== true) {
        reserveTavernSession(ctx, sessionId)
        return
      }
      // 待修复的会话可能早已离开主视图（mainView 保留已释放），同样需要显式
      // 持有才能借到 binding；失败照旧由 catch 回落重试。
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const policy = {
          architecture: bindingArchitecture(binding),
          contextMode: binding.contextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
        }
        const payload = base64Url(JSON.stringify({
          character: binding.character,
          chatId: binding.chatId,
          ...(binding.group === true ? { group: true } : {}),
          ...activationFields(policy),
        }))
        const bound = ctx?.sessions?.binding(sessionId)
        if (!bound) throw new Error('session binding unavailable')
        const result = await bound.session.command(`/dsh-soulmojito-session ${payload}`)
        if (!result?.ok || !result.value?.matched) throw new Error('Tavern session bridge rejected')
        reserveTavernSession(ctx, sessionId)
      } catch {
        repairedBindings.delete(sessionId)
      } finally {
        heldSession.release()
      }
    }

    async function openTavernChat(ctx, character, chatId, group = false, policyOverride) {
      update({ navigationStatus: '' })
      const sessions = ctx.sessions.list.getSnapshot()
      const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .find(([sessionId, binding]) => sessions.byId[sessionId]
          && binding.character === character
          && binding.chatId === chatId)
      if (existing) {
        // 已绑定的会话也重发一次绑定命令：旧版本激活的会话宿主侧可能仍 blank，
        // 服务端借此补占位 turn 对，解除原生「新建会话」的复用劫持（幂等）。
        if (bindingArchitecture(existing[1]) === 'st' || existing[1].initializationPending === true) {
          void repairBinding(ctx, existing[0], existing[1])
        }
        reserveTavernSession(ctx, existing[0])
        openSessionView(ctx, existing[0])
        if (bindingArchitecture(existing[1]) === 'st') clickTavernTab(0)
        return existing[0]
      }

      const policy = newChatPolicy(group, policyOverride)
      const workspace = await ensureTavernWorkspace(ctx)

      update({ navigationStatus: translate('nav.opening', { name: character }) })
      const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-tavern')
      // 0.2.0-rc.2 起 connectWorkspace 内部走 sessions.create，不再隐式保留
      // 作用域，未 retain 时 ctx.sessions.binding() 恒为 undefined（宿主契约：
      // retain 后才能借 binding）。先以插件名义显式持有，openSessionView 建立
      // mainView 保留后在 finally 归还，全程引用计数 ≥ 1。
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (!binding) throw new Error(translate('error.noBinding'))
        const payload = JSON.stringify({ sessionId, character, chatId, ...(group ? { group: true } : {}), ...activationFields(policy) })
        await api('binding', {
          method: 'POST',
          headers: jsonHeaders(),
          body: payload,
        })
        const commandPayload = base64Url(JSON.stringify({
          character,
          chatId,
          ...(group ? { group: true } : {}),
          ...activationFields(policy),
        }))
        const result = await binding.session.command(`/dsh-soulmojito-session ${commandPayload}`)
        if (!result.ok || !result.value?.matched) {
          await api('binding', {
            method: 'DELETE',
            headers: jsonHeaders(),
            body: JSON.stringify({ sessionId }),
          }).catch(() => {})
          throw new Error(result.error?.message || translate('error.activationFailed'))
        }
        reserveTavernSession(ctx, sessionId)
        const label = sessionLabel(character, chatId, group, policy.architecture)
        await binding.session.rename(label).catch(() => {})
        await refreshBootstrap()
        openSessionView(ctx, sessionId)
        update({ navigationStatus: '' })
        if (policy.architecture === 'st') clickTavernTab(0)
        return sessionId
      } finally {
        heldSession.release()
      }
    }

    async function createTavernChat(ctx, character, group = false, policyOverride, greetingIndex) {
      const result = await api('chats', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(group
          ? { group: character }
          : { character, ...(greetingIndex === undefined ? {} : { greetingIndex }) }),
      })
      await loadChatList(character, true)
      const key = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [key]: result.chat },
        revisions: { ...snapshot.revisions, [key]: result.revision },
      })
      return openTavernChat(ctx, character, result.id, group, policyOverride)
    }

    function novelSessionLabel(title) {