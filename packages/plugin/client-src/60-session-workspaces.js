    function base64Url(value) {
      const bytes = new TextEncoder().encode(value)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    // 路径而非显示名是插件内部工作区的身份依据（决策 2026-08-17）；写卡工作台
    // 用同款注册核，只是路径/标题不同（bootstrap.workbenchWorkspace）。
    async function registerPluginWorkspace(ctx, config) {
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (typeof ctx?.workspaces?.create !== 'function') throw new Error(translate('error.noWorkspace'))
      const created = await ctx.workspaces.create({ path: config.path })
      let workspace = created?.workspace || created
      if (!workspace?.workspaceId) throw new Error(translate('error.noWorkspace'))
      if (config.title && workspace.title !== config.title && typeof ctx.workspaces.rename === 'function') {
        try {
          workspace = await ctx.workspaces.rename(workspace.workspaceId, config.title)
        } catch {
          // A user-owned workspace may already use the display title; the
          // canonical path remains the identity and is safe to reuse.
        }
      }
      return workspace
    }

    async function ensureTavernWorkspace(ctx) {
      const config = snapshot.bootstrap.internalWorkspace
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (internalWorkspace?.path === config.path) return internalWorkspace
      if (internalWorkspacePromise) return internalWorkspacePromise
      internalWorkspacePromise = registerPluginWorkspace(ctx, config)
        .then((workspace) => { internalWorkspace = workspace; return workspace })
        .finally(() => { internalWorkspacePromise = undefined })
      return internalWorkspacePromise
    }

    async function ensureWorkbenchWorkspace(ctx) {
      const config = snapshot.bootstrap.workbenchWorkspace
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (workbenchWorkspace?.path === config.path) return workbenchWorkspace
      if (workbenchWorkspacePromise) return workbenchWorkspacePromise
      workbenchWorkspacePromise = registerPluginWorkspace(ctx, config)
        .then((workspace) => { workbenchWorkspace = workspace; return workspace })
        .finally(() => { workbenchWorkspacePromise = undefined })
      return workbenchWorkspacePromise
    }

    function connectTavernWorkspace(ctx, workspaceId, agentPreset) {
      // uiWorkspace → workspaces 双面回退与形状轨迹记录在 @dsh-soulmojito/bind 的
      // client 探测模块（构建时经 __DSH_BIND_CLIENT_SLOT__ 注入，轨迹同步挂
      // window.__DSH_SOULMOJITO_BIND__ 供诊断读取）；0.2.1 起 agentPreset 随
      // connectWorkspace 直通 sessions.create，避免 blank 会话被默认 preset 复用。
      return DshBindClient.connectHostWorkspace(
        ctx,
        workspaceId,
        clientShapeTrace,
        agentPreset === undefined ? undefined : { agentPreset },
      )
    }

    function openSessionView(ctx, sessionId) {
      // 0.2.0 宿主把「会话进入主视图」从 sessions.open 挪到 uiWorkspace
      // .openSession（retain mainView + 替换 selection）；双面回退与轨迹记录
      // 同样集中在 @dsh-soulmojito/bind 的 client 探测模块。
      return DshBindClient.openHostSession(ctx, sessionId, clientShapeTrace)
    }

    function bindingArchitecture(binding) {
      // agent-novel / card-workbench sessions keep the native composer and
      // conversation view; classifying them as 'st' would force the ST Tavern
      // tab and composer.
      if (binding?.architecture === 'agent-novel') return 'agent-novel'
      if (binding?.architecture === 'card-workbench') return 'card-workbench'
      return binding?.architecture === 'agent-tavern' ? 'agent-tavern' : 'st'
    }
