    function readFile(file, binary) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error(translate('error.fileRead')))
        reader.onload = () => resolve(reader.result)
        if (binary) reader.readAsArrayBuffer(file)
        else reader.readAsText(file)
      })
    }

    function fileStem(name) {
      return name.replace(/\.[^.]+$/, '') || 'Imported'
    }

    // 分块 btoa：避免大文件 String.fromCharCode 展开超出参数上限（与 importAsset 同款）。
    function bytesToBase64(bytes) {
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary)
    }

    async function importAsset(kind, file) {
      if (!file) return
      if (kind === 'character') {
        const bytes = new Uint8Array(await readFile(file, true))
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        }
        if (/\.png$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ pngBase64: btoa(binary) }),
          })
        } else if (/\.charx$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ charxBase64: btoa(binary) }),
          })
        } else {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ card: JSON.parse(new TextDecoder().decode(bytes)) }),
          })
        }
      } else if (kind === 'persona') {
        const bytes = new Uint8Array(await readFile(file, true))
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        }
        await api('import/persona', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ pngBase64: btoa(binary), name: fileStem(file.name) }),
        })
      } else if (kind === 'regex') {
        await api('import/regex', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ data: JSON.parse(await readFile(file, false)) }),
        })
      } else {
        await api(`import/${kind}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: fileStem(file.name), data: JSON.parse(await readFile(file, false)) }),
        })
      }
      await refreshBootstrap()
      // mod-event 下行（A-1d）：资产导入的 tap。character/persona 的权威名以导入
      // 结果为准（此处 fileStem 只是近似提示——Mod UI 事件到达后重拉即得真值）。
      if (kind === 'character' || kind === 'world' || kind === 'preset' || kind === 'persona') {
        broadcastModEvent('assets-saved', { kind, name: fileStem(file.name) })
      }
    }

    async function createPersona(name, description) {
      const result = await api('import/persona', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'persona', name })
      return result.persona
    }

    async function savePersona(name, description) {
      const result = await api('persona', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'persona', name })
      return result.persona
    }

    async function deletePersona(name) {
      await api(`persona?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function createGroup(name, members, activationStrategy) {
      const result = await api('groups', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, members, activationStrategy }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'group', name })
      return result.group
    }

    async function updateGroup(payload) {
      const result = await api('group', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'group', name: String(payload?.name ?? '') })
      return result.group
    }

    async function deleteGroup(name) {
      await api(`group?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    // regex 写回同时更新归属表：卡级脚本的「自动」标记不用等下一次 bootstrap。
    function applyRegexResult(result) {
      update({
        bootstrap: {
          ...snapshot.bootstrap,
          state: {
            ...snapshot.bootstrap.state,
            regexScripts: result.scripts,
            ...(result.regexScriptOwners !== undefined ? { regexScriptOwners: result.regexScriptOwners } : {}),
            ...(result.regexScriptPresetOwners !== undefined ? { regexScriptPresetOwners: result.regexScriptPresetOwners } : {}),
          },
        },
      })
    }

    async function saveRegexScripts(scripts) {
      const result = await api('regex', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ scripts }),
      })
      applyRegexResult(result)
      return result.scripts
    }

    // 存量卡回填：服务端扫描全部角色卡，只补全局列表缺少的脚本名。
    async function syncRegexScriptsFromCards() {
      const result = await api('regex/sync-cards', { method: 'POST' })
      applyRegexResult(result)
      return result
    }

    // 存量预设回填：扫描预设 extensions.regex_scripts，只补全局缺失的脚本名。
    async function syncRegexScriptsFromPresets() {
      const result = await api('regex/sync-presets', { method: 'POST' })
      applyRegexResult(result)
      return result
    }

    function openPanel(section) {
      update({ panelOpen: true, ...(typeof section === 'string' && section !== '' ? { panelSection: section } : {}) })
    }

    function closePanel() {
      update({ panelOpen: false })
    }

    async function fetchCharacterCard(name) {
      const result = await api(`character/${encodeURIComponent(name)}`)
      return result.card
    }

    async function saveCharacterCard(name, card) {
      const result = await api(`character/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ card }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'character', name: result.card?.data?.name || name })
      return result.card
    }

    async function deleteCharacterAsset(name) {
      await api(`character?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function fetchWorldBook(name) {
      const result = await api(`world/${encodeURIComponent(name)}`)
      return result.book
    }

    async function saveWorldBook(name, book) {
      const result = await api(`world/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: book.name, data: worldBookToFile(book) }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'world', name: book.name || name })
      return result.book
    }

    async function deleteWorldBook(name) {
      await api(`world?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function deletePresetAsset(name) {
      await api(`preset?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function fetchPreset(name) {
      const result = await api(`preset/${encodeURIComponent(name)}`)
      return result.data
    }

    async function savePreset(name, data, nextName = name) {
      nextName = String(nextName || name).trim() || name
      const result = await api(`preset/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: nextName, data }),
      })
      await refreshBootstrap()
      broadcastModEvent('assets-saved', { kind: 'preset', name: nextName })
      return result.data
    }

    function downloadAsset(path, fallbackName) {
      const anchor = document.createElement('a')
      anchor.href = `${API}/${path}`
      anchor.download = fallbackName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    function commaList(value) {
      return Array.isArray(value) ? value.join(', ') : ''
    }

    function parseCommaList(value) {
      return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
    }

    function worldBookToFile(book) {
      const entries = {}
      for (const entry of book.entries || []) {
        const {
          uid, key, keysecondary, comment, content, constant, vectorized, selective, selectiveLogic,
          addMemo, order, position, disable, ignoreBudget, excludeRecursion, preventRecursion,
          delayUntilRecursion, probability, useProbability, depth, outletName, group, groupOverride,
          groupWeight, scanDepth, caseSensitive, matchWholeWords, useGroupScoring, automationId,
          role, sticky, cooldown, delay, triggers, matchPersonaDescription, matchCharacterDescription,
          matchCharacterPersonality, matchCharacterDepthPrompt, matchScenario, matchCreatorNotes, extra,
        } = entry
        entries[String(uid)] = {
          ...(extra || {}), uid, key: key || [], keysecondary: keysecondary || [], comment: comment || '', content: content || '',
          constant: Boolean(constant), vectorized: Boolean(vectorized), selective: Boolean(selective), selectiveLogic: Number(selectiveLogic || 0),
          addMemo: Boolean(addMemo), order: Number(order || 100), position: Number(position || 0), disable: Boolean(disable), ignoreBudget: Boolean(ignoreBudget),
          excludeRecursion: Boolean(excludeRecursion), preventRecursion: Boolean(preventRecursion), delayUntilRecursion: Number(delayUntilRecursion || 0),
          probability: Number(probability ?? 100), useProbability: useProbability !== false, depth: Number(depth || 4), outletName: outletName || '',
          group: group || '', groupOverride: Boolean(groupOverride), groupWeight: Number(groupWeight || 100), scanDepth, caseSensitive, matchWholeWords,
          useGroupScoring, automationId: automationId || '', role: Number(role || 0), sticky, cooldown, delay, triggers: triggers || [],
          matchPersonaDescription: Boolean(matchPersonaDescription), matchCharacterDescription: Boolean(matchCharacterDescription),
          matchCharacterPersonality: Boolean(matchCharacterPersonality), matchCharacterDepthPrompt: Boolean(matchCharacterDepthPrompt),
          matchScenario: Boolean(matchScenario), matchCreatorNotes: Boolean(matchCreatorNotes),
        }
      }
      return { ...(book.extra || {}), entries }
    }

    async function fetchGlobals() {
      const result = await api('variables')
      return result.globals || {}
    }

    async function saveGlobals(globals) {
      const result = await api('variables', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ globals }),
      })
      return result.globals
    }

    // AgentNovel HTTP contract (docs/proposals/0005-agent-novel-architecture.md):
    // GET/POST novels, novels/:id detail, outline, paginated body, control
    // actions, CAS patch and blob export. The server is authoritative; the UI
    // only presents the latest known status.
    function novelPath(novelId, suffix) {
      return `novels/${encodeURIComponent(novelId)}${suffix || ''}`
    }

    async function fetchNovelList() {
      const result = await api('novels')
      return Array.isArray(result.novels) ? result.novels : []
    }

    async function fetchNovelDetail(novelId) {
      const result = await api(novelPath(novelId))
      return result.novel
    }

    async function fetchNovelOutline(novelId) {
      const result = await api(novelPath(novelId, '/outline'))
      return result.outline
    }

    async function fetchNovelBody(novelId, chapterId, cursor, limit) {
      const params = new URLSearchParams()
      if (chapterId) params.set('chapterId', chapterId)
      if (cursor) params.set('cursor', cursor)
      if (limit) params.set('limit', String(limit))
      const query = params.toString()
      const result = await api(novelPath(novelId, `/body${query ? `?${query}` : ''}`))
      return {
        paragraphs: Array.isArray(result.paragraphs) ? result.paragraphs : [],
        nextCursor: result.nextCursor || null,
      }
    }

    async function createNovel(config) {
      const result = await api('novels', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(config),
      })
      return result.novel
    }

    async function previewNovelImport(source, partTargetCharacters) {
      const result = await api('novels/import/preview', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ source, partTargetCharacters }),
      })
      return result.preview
    }

    async function createNovelFromImport(config, source, partTargetCharacters) {
      const result = await api('novels/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ config, source, partTargetCharacters }),
      })
      return result.novel
    }

    async function fetchNovelSource(novelId, chapterId, cursor, limit) {
      const params = new URLSearchParams()
      if (chapterId) params.set('chapterId', chapterId)
      if (cursor) params.set('cursor', cursor)
      if (limit) params.set('limit', String(limit))
      const result = await api(novelPath(novelId, `/import/chapter?${params.toString()}`))
      return result.source
    }

    async function optimizeNovelChapter(novelId, chapterId, instruction) {
      const result = await api(novelPath(novelId, '/optimize'), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ chapterId, instruction }),
      })
      return result.optimization
    }

    async function applyNovelOptimization(novelId, revisionId, expectedRevision) {
      return api(novelPath(novelId, '/optimize/apply'), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ revisionId, expectedRevision }),
      })
    }

    async function discardNovelOptimization(novelId, revisionId, expectedRevision) {
      return api(novelPath(novelId, '/optimize/discard'), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ revisionId, expectedRevision }),
      })
    }

    async function fetchNovelRevision(novelId, revisionId, cursor, limit) {
      const params = new URLSearchParams({ revisionId })
      if (cursor) params.set('cursor', cursor)
      if (limit) params.set('limit', String(limit))
      return api(novelPath(novelId, `/revision?${params.toString()}`))
    }

    async function runNovelAction(novelId, action, body) {
      return api(novelPath(novelId, `/${action}`), body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
    }

    function isNovelConflict(cause) {
      return cause?.code === NOVEL_REVISION_CONFLICT || cause?.status === 409
    }

    async function patchNovel(novelId, expectedRevision, patch) {
      return api(novelPath(novelId), {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ expectedRevision, patch, cause: 'panel-edit' }),
      })
    }

    async function deleteNovel(novelId) {
      await api(novelPath(novelId), { method: 'DELETE' })
      await refreshBootstrap().catch(() => {})
    }

    function novelExportFileStem(title) {
      const stem = String(title || 'novel').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120)
      return stem !== '' ? stem : 'novel'
    }

    async function downloadNovelExport(novelId, format, title) {
      const kind = format === 'zip' ? 'zip' : 'md'
      const response = await fetch(`${API}/novels/${encodeURIComponent(novelId)}/export?format=${kind}`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        const error = new Error(body.message || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body.code
        throw error
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${novelExportFileStem(title)}.${kind}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }
