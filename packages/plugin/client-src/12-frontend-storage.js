    // ── 沙箱存储桥（2026-10-22）────────────────────────────────────────────
    // 美化前端 localStorage 的会话级缓存 + 虚拟 IndexedDB 的二进制 URL 辅助。
    // 从 10-frontend-frame.js 拆出以守住单文件预算；函数仍在同一 ModuleLoader
    // factory 作用域内，FrontendFrame / useHelperBridge 直接调用。

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

    // Virtual IndexedDB binary channel helpers: the iframe only talks to its
    // parent facade; the host adds the session binding and reaches the plugin's
    // local routes. No same-origin or host cookies are exposed.
    function encodeBase64Url(value) {
      const bytes = new TextEncoder().encode(value)
      let binary = ''
      const chunk = 0x8000
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    }

    function decodeBase64Url(value) {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      const remainder = padded.length % 4
      const binary = atob(remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new TextDecoder().decode(bytes)
    }

    function idbQuery(character, payload) {
      const query = new URLSearchParams()
      query.set('character', character)
      for (const field of ['db', 'store', 'key']) {
        if (payload && payload[field] !== undefined) query.set(field, String(payload[field]))
      }
      return query.toString()
    }

    function readIdbMetaHeader(response) {
      const header = response.headers.get('x-dsh-idb-meta')
      if (header === null || header === '') return {}
      try {
        return JSON.parse(decodeBase64Url(header))
      } catch (error) {
        console.warn('dsh-soulmojito: invalid idb metadata header', error)
        return {}
      }
    }
