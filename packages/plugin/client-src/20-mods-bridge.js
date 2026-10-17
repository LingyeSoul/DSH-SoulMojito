    // Mod UI 表面（提案 0015 §3.5 P2）：iframe 指向该 Mod 的 `GET mods/<id>/ui`
    // 路由（服务端 mod.html 出口自带 CSP meta + connect-src 'none'）。iframe 纪律
    // 完整继承 FrontendFrame：sandbox="allow-scripts" 无 same-origin、token 校验
    // postMessage（token 经 iframe URL 查询段交给 mod UI，回投时对账 + 事件源
    // 必须是该 frame 的 contentWindow）。取数不能 fetch（CSP）——postMessage
    // 数据桥：iframe 发 {type:'dsh-soulmojito:mod-request', token, req} → 父页代理到
    // 该 Mod 的 HTTP 路由 → 回投 {type:'dsh-soulmojito:mod-response', token, id}。
    // 高度上报协议（FRONTEND_HEIGHT_MESSAGE）与 FrontendFrame 同款，由 mod UI
    // 自带上报脚本（示例 Mod 的 ui 路由含同款 reporter）。
    const MOD_REQUEST_MESSAGE = 'dsh-soulmojito:mod-request'
    const MOD_RESPONSE_MESSAGE = 'dsh-soulmojito:mod-response'
    // 下行事件（A-1d）：宿主把本客户端发起的写入（聊天保存/资产保存/guides 写入
    // /按钮点击）推回挂载的 ModSurface iframe——Mod UI 据此事件刷新，轮询兜底
    // 仍保留（其他标签页/服务端写入不在推送范围，mod-api.md §13 的诚实边界）。
    const MOD_EVENT_MESSAGE = 'dsh-soulmojito:mod-event'
    const MOD_EVENT_KINDS = new Set(['chat-saved', 'assets-saved', 'guides-changed', 'button-click'])
    // Mod 日志上行（A-2）：reply.html 注入的 console reporter 把 mod UI 的
    // console/error 输出回投父页；父页 per-mod 环形缓冲（≤200 条内存态）。
    const MOD_LOG_MESSAGE = 'dsh-soulmojito:mod-log'
    const MOD_LOG_LEVELS = new Set(['log', 'warn', 'error'])
    const MOD_LOG_BUFFER_LIMIT = 200
    const modLogBuffers = new Map()
    const MOD_BRIDGE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    const MOD_BRIDGE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

    function isValidModBridgePath(path) {
      if (typeof path !== 'string' || path === '' || path.length > 200 || path.includes('\\') || path.includes('%')) return false
      const segments = path.split('/')
      return segments.every((segment) => MOD_BRIDGE_PATH_SEGMENT.test(segment))
    }

    // mod-event 广播注册表：按挂载的 ModSurface 分组，unmount 即注销（JSR 按
    // iframe 分组订阅 + pagehide 整组退订的同款纪律）。token 随注册表走，广播
    // 时逐面 postMessage（每面 token 不同，不能一条消息群发）。
    const modEventSurfaces = new Set()

    function broadcastModEvent(kind, payload) {
      if (!MOD_EVENT_KINDS.has(kind)) return
      for (const surface of [...modEventSurfaces]) {
        try { surface.frameRef.current?.contentWindow?.postMessage({ type: MOD_EVENT_MESSAGE, token: surface.token, kind, payload }, '*') } catch {}
      }
    }

    // per-mod 日志环形缓冲：内存态，随页面生命周期（重载清空；mod 面板重挂不丢）。
    function appendModLog(modId, level, text) {
      const entries = modLogBuffers.get(modId) || []
      entries.push({ at: new Date().toISOString(), level, text: String(text || '').slice(0, 512) })
      if (entries.length > MOD_LOG_BUFFER_LIMIT) entries.splice(0, entries.length - MOD_LOG_BUFFER_LIMIT)
      modLogBuffers.set(modId, entries)
    }
