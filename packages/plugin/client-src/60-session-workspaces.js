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

    // 宿主侧的工作区登记可能在插件生命周期内消失（用户在原生工作区管理里删除、
    // 宿主 registry 重建）：缓存的工作区视图不能当存在性依据——直接复用它会让
    // connectWorkspace 抛 unknown workspace，内部工作区就再也不会按路径重建
    // （决策 2026-08-17 §Consequences 的「下次使用按同一路径重新创建」承诺）。
    // 旧宿主没有 list 面时保持原缓存语义（rc.6 的 controller 只暴露 create/
    // rename/connectWorkspace）。
    function pluginWorkspaceRegistered(ctx, workspace) {
      if (!workspace?.workspaceId) return false
      const items = ctx?.workspaces?.list?.getSnapshot?.()?.items
      if (!Array.isArray(items)) return true
      return items.some((item) => item?.workspaceId === workspace.workspaceId)
    }

    // 冷启动竞态：apply 的 bootstrap 是 fire-and-forget，侧栏「+」能在
    // bootstrap 的 workspace 字段到达前被点击；直接报 error.noWorkspace 是假
    // 失败。按需补等一次 bootstrap 再判定（服务端 bootstrap 先建目录再下发）。
    async function pluginWorkspaceConfig(kind) {
      const read = () => kind === 'workbench'
        ? snapshot.bootstrap.workbenchWorkspace
        : snapshot.bootstrap.internalWorkspace
      const current = read()
      if (current?.path) return current
      await refreshBootstrap()
      return read()
    }

    async function ensureTavernWorkspace(ctx) {
      const config = await pluginWorkspaceConfig('tavern')
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (internalWorkspace?.path === config.path && pluginWorkspaceRegistered(ctx, internalWorkspace)) return internalWorkspace
      if (internalWorkspacePromise) return internalWorkspacePromise
      internalWorkspace = undefined
      internalWorkspacePromise = registerPluginWorkspace(ctx, config)
        .then((workspace) => { internalWorkspace = workspace; return workspace })
        .finally(() => { internalWorkspacePromise = undefined })
      return internalWorkspacePromise
    }

    async function ensureWorkbenchWorkspace(ctx) {
      const config = await pluginWorkspaceConfig('workbench')
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (workbenchWorkspace?.path === config.path && pluginWorkspaceRegistered(ctx, workbenchWorkspace)) return workbenchWorkspace
      if (workbenchWorkspacePromise) return workbenchWorkspacePromise
      workbenchWorkspace = undefined
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
