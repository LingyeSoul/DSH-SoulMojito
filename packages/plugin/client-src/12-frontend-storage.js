    // ── 沙箱存储桥（2026-10-22）────────────────────────────────────────────
    // 美化前端 localStorage 的会话级缓存。虚拟 IndexedDB 的二进制 URL 辅助
    // 与 shim 源文本已拆到 @dsh-soulmojito/frontend-storage。

    // 同一角色的多个 iframe（行动栏 + 状态总览）共用一次 GET；首帧之后由
    // storage.set 失效。
    const frontendStorageCache = new Map()
    const frontendStorageInflight = new Map()

    function loadFrontendStorage(character) {
      if (frontendStorageCache.has(character)) return Promise.resolve(frontendStorageCache.get(character))
      const existing = frontendStorageInflight.get(character)
      if (existing !== undefined) return existing
      const request = api(`frontend/storage?character=${encodeURIComponent(character)}`)
        .then((result) => {
          const storage = result?.storage && typeof result.storage === 'object' && !Array.isArray(result.storage)
            ? result.storage
            : {}
          frontendStorageCache.set(character, storage)
          return storage
        })
        .catch((error) => {
          // Storage is an enhancement, not a display gate: a failed read must not
          // blank the card. Keep the iframe usable with an empty seed and leave a
          // visible diagnostic in the console.
          console.warn('dsh-soulmojito: frontend storage load failed', error)
          return {}
        })
        .finally(() => {
          frontendStorageInflight.delete(character)
        })
      frontendStorageInflight.set(character, request)
      return request
    }
