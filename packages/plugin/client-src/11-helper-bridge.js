    // ── 酒馆助手兼容层（2026-10-20）────────────────────────────────────────
    // 用户需求：美化前端要深度兼容酒馆助手的常见行为（浅克隆参考
    // JS-Slash-Runner 的可观察面）。JSR 用同源 iframe + 直拷 parent API；
    // 本插件坚持沙箱（allow-scripts、无 same-origin、CSP connect-src 'none'），
    // 因此把 TavernHelper 的形状在 iframe 内重建，所有读写经 token 校验的
    // postMessage RPC 交给宿主代理，再到 POST /helper。iframe 永远拿不到
    // 宿主对象，也拿不到别的聊天：character/chatId 由宿主按会话绑定注入。
    //
    // 运行时与词汇表（事件名、库注入、沙箱 localStorage/IndexedDB）已拆到
    // @dsh-soulmojito/jsr 与 @dsh-soulmojito/frontend-storage；本文件只保留
    // 插件侧装配，宿主域操作（变量/楼层/世界书）仍在 src/helper.ts。
    const HELPER_MESSAGE = DshJsrRuntime.HELPER_MESSAGE
    const HELPER_RESULT_MESSAGE = DshJsrRuntime.HELPER_RESULT_MESSAGE
    const HELPER_SNAPSHOT_MESSAGE = DshJsrRuntime.HELPER_SNAPSHOT_MESSAGE
    const HELPER_EVENT_MESSAGE = DshJsrRuntime.HELPER_EVENT_MESSAGE
    const HELPER_TAVERN_EVENTS = DshJsrRuntime.TAVERN_EVENTS
    const HELPER_IFRAME_EVENTS = DshJsrRuntime.IFRAME_EVENTS
    const FRONTEND_STORAGE_SOURCES = DshFrontendStorage.iframeSources()

    function frontendHelperScript(token, messageId, storage) {
      return DshJsrRuntime.buildIframeScript(
        token,
        messageId,
        DshFrontendStorage.serializeFrontendStorageSeed(storage),
        FRONTEND_STORAGE_SOURCES,
      )
    }

    function helperLibraryTags() {
      return DshJsrRuntime.helperLibraryTags()
    }
