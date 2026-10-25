    // Server-issued helper binding (2026-10-25). The host page owns the session
    // binding; every surface that proxies TavernHelper ops acquires a token for
    // its own character/chatId. A 401 means the token expired (30 min) or the
    // plugin restarted: drop it, bind again and retry the same call once. The
    // sandboxed iframe never sees the token.
    const HELPER_TOKEN_HEADER = 'x-dsh-helper-token'

    // One token per session binding, reference-counted across mounted surfaces
    // (message list, sidebar and card-scripts panel can all proxy the same chat).
    const helperTokenBindings = new Map()

    function helperHeaders(token) {
      return typeof token === 'string' && token !== ''
        ? { ...jsonHeaders(), [HELPER_TOKEN_HEADER]: token }
        : jsonHeaders()
    }

    function isHelperBinding(binding) {
      return typeof binding?.character === 'string' && binding.character !== ''
        && typeof binding?.chatId === 'string' && binding.chatId !== ''
    }

    function helperBindingKey(binding) {
      return `${binding.character}\u0000${binding.chatId}`
    }

    function createUnboundHelperToken() {
      const fail = () => Promise.reject(new Error('helper binding requires character and chatId'))
      return { bound: false, bind: fail, request: fail, fetch: fail, release: () => {} }
    }

    function acquireHelperToken(binding) {
      if (!isHelperBinding(binding)) return createUnboundHelperToken()
      const character = binding.character
      const chatId = binding.chatId
      const key = helperBindingKey(binding)
      let entry = helperTokenBindings.get(key)
      if (entry === undefined) {
        entry = { token: null, pending: null, users: 0 }
        helperTokenBindings.set(key, entry)
      }
      entry.users += 1
      const bindingEntry = entry
      let released = false

      const bind = async () => {
        if (bindingEntry.token !== null) return bindingEntry.token
        if (bindingEntry.pending === null) {
          bindingEntry.pending = api('helper/bind', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ character, chatId }),
          }).then((result) => {
            if (typeof result.token !== 'string' || result.token === '') {
              throw new Error('helper/bind returned no token')
            }
            if (bindingEntry.users <= 0) {
              // The last surface unmounted while this bind was in flight: never
              // keep an unreachable token in the server table.
              void api('helper/unbind', {
                method: 'POST',
                headers: helperHeaders(result.token),
                body: '{}',
              }).catch(() => {})
              throw new Error('helper binding was released before it resolved')
            }
            bindingEntry.token = result.token
            return result.token
          }).finally(() => {
            bindingEntry.pending = null
          })
        }
        return bindingEntry.pending
      }

      const clearIfCurrent = (token) => {
        if (bindingEntry.token === token) bindingEntry.token = null
      }

      const send = (path, payload, token) => api(path, {
        method: 'POST',
        headers: helperHeaders(token),
        body: JSON.stringify(payload),
      })

      const request = async (path, payload) => {
        const token = await bind()
        try {
          return await send(path, payload, token)
        } catch (error) {
          if (error?.status !== 401) throw error
          clearIfCurrent(token)
          // Exactly one retry: re-bind for the same session binding, then repeat
          // the identical call. A second 401 is a real failure and propagates.
          return send(path, payload, await bind())
        }
      }

      const fetchAuthorized = async (path, payload) => {
        const rawFetch = (token) => fetch(`${API}/${path}`, {
          method: 'POST',
          headers: helperHeaders(token),
          body: JSON.stringify(payload),
        })
        const token = await bind()
        const response = await rawFetch(token)
        if (response.status !== 401) return response
        clearIfCurrent(token)
        return rawFetch(await bind())
      }

      const release = () => {
        if (released) return
        released = true
        bindingEntry.users -= 1
        if (bindingEntry.users > 0) return
        helperTokenBindings.delete(key)
        const token = bindingEntry.token
        bindingEntry.token = null
        if (token === null) return
        void api('helper/unbind', {
          method: 'POST',
          headers: helperHeaders(token),
          body: '{}',
        }).catch(() => {})
      }

      return { bound: true, bind, request, fetch: fetchAuthorized, release }
    }
