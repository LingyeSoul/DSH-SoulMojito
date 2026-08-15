window.__ModuleLoader__.load({
  id: 'dsh-tavern',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const {
      IconCheckOutline16,
      IconChevronDownOutline14,
      IconChevronLeftOutline14,
      IconChevronRightOutline14,
      IconEditOutline16,
      IconPlusOutline16,
      IconRefreshOutline16,
      IconSendOutline16,
      IconStopFill16,
      IconTrashOutline16,
      IconUserOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useEffect, useId, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement.bind(React)

    const API = '/api/dsh-tavern'
    const LOCALE_NS = 'dsh-tavern'
    const MESSAGES_EN = {
      'settings.subtitle': 'Roleplay assets and prompt configuration',
      'settings.activeSetup': 'Active setup',
      'settings.character': 'Character',
      'settings.characterEmpty': 'No active character',
      'settings.preset': 'Preset',
      'settings.presetEmpty': 'Built-in RP preset',
      'settings.persona': 'Persona',
      'settings.personaEmpty': 'Default user',
      'settings.nativePersona': 'Use active character in standard DSH Agent chats',
      'settings.worldInfo': 'World Info',
      'settings.worldsEmpty': 'No world books imported',
      'settings.import': 'Import',
      'settings.importCharacter': 'Character card',
      'settings.importWorld': 'World book',
      'settings.importPreset': 'Chat preset',
      'settings.importing': 'Importing…',
      'settings.importTitle': 'Import {name}',
      'settings.version': 'Version',
      'settings.personaManage': 'Personas',
      'settings.personaEmpty': 'No personas yet',
      'settings.personaNew': 'New persona',
      'settings.personaImport': 'Persona PNG',
      'settings.personaNamePrompt': 'Persona name',
      'settings.personaDescPrompt': 'Persona description',
      'settings.personaEdit': 'Edit {name}',
      'settings.personaDelete': 'Delete {name}',
      'settings.personaDeleteConfirm': 'Delete persona "{name}"?',
      'settings.groups': 'Groups',
      'settings.groupsEmpty': 'No groups created',
      'settings.groupNew': 'New group',
      'settings.groupNamePrompt': 'Group name',
      'settings.groupPickMembers': 'Pick members',
      'settings.groupCreate': 'Create group',
      'settings.groupCancel': 'Cancel',
      'settings.groupMembers': 'Members',
      'settings.groupStrategy': 'Activation',
      'settings.groupNatural': 'Natural (talkativeness)',
      'settings.groupList': 'List order',
      'settings.groupDelete': 'Delete {name}',
      'settings.groupDeleteConfirm': 'Delete group "{name}"? Chats are kept.',
      'settings.groupToggleMember': 'Enable or disable {member}',
      'settings.groupRemoveMember': 'Remove {member}',
      'settings.regex': 'Regex scripts',
      'settings.regexEmpty': 'No regex scripts imported',
      'settings.importRegex': 'Regex scripts',
      'settings.regexDelete': 'Delete {name}',
      'settings.regexToggle': 'Enable or disable {name}',
      'settings.regexPlacements': 'Placements: {names}',
      'settings.pipeline': 'Generation pipeline',
      'settings.pipelineHint': 'Chooses how replies are generated. World Info, macros, regex scripts, swipes and revision protection behave identically in both modes.',
      'settings.pipelineHintChat': 'Sends a messages[] list through the DSH model routing (providers, keys and the composer model picker). The active Chat Completion preset controls prompt order and sampling.',
      'settings.pipelineHintText': 'Assembles a single prompt string (context template + instruct sequences) and calls a KoboldAI/KoboldCpp endpoint directly. Configure the endpoint below; the composer model picker does not apply in this mode.',
      'settings.pipelineChat': 'Chat Completion (DSH models)',
      'settings.pipelineText': 'Text Completion (Kobold)',
      'settings.tcEndpoint': 'Kobold endpoint',
      'settings.tcApiKey': 'API key (optional)',
      'settings.tcStreaming': 'Prefer SSE streaming',
      'settings.tcContext': 'Context template',
      'settings.tcInstruct': 'Instruct template',
      'settings.tcSampler': 'Textgen sampler',
      'settings.tcTest': 'Test connection',
      'settings.tcTesting': 'Testing…',
      'settings.tcOk': 'Connected: {name}',
      'settings.anyPreset': 'None',
      'message.user': 'User',
      'message.previousSwipe': 'Previous swipe',
      'message.nextSwipe': 'Next swipe',
      'message.edit': 'Edit message',
      'message.branch': 'Branch chat from this message',
      'message.branching': 'Branching…',
      'message.save': 'Save',
      'message.cancel': 'Cancel',
      'view.unbound': 'No Tavern chat is bound to this session.',
      'view.loading': 'Loading Tavern chat…',
      'view.regenerate': 'Regenerate last response',
      'view.linkedFrom': 'Linked from {name}',
      'run.connecting': 'Connecting',
      'run.saved': 'Saved',
      'run.stopped': 'Stopped',
      'run.failed': 'Generation failed',
      'model.select': 'Select model',
      'model.default': 'Default',
      'model.model': 'Model',
      'model.effort': 'Effort',
      'model.menuLabel': 'Model and reasoning effort',
      'model.refreshing': 'Refreshing model list…',
      'model.retry': 'Retry',
      'model.loadFailed': '{name} failed to load: {message}',
      'model.noneAvailable': 'No models available.',
      'model.noEffort': 'This model provides no reasoning effort levels.',
      'composer.writeTo': 'Write to {name}',
      'composer.unavailable': 'Tavern binding unavailable',
      'composer.stop': 'Stop generation',
      'composer.send': 'Send',
      'composer.script': 'Run STscript',
      'composer.member': 'Reply as {name}',
      'nav.title': 'Tavern',
      'nav.chats': 'Tavern roleplay chats',
      'nav.open': 'Open Tavern roleplay chats',
      'nav.close': 'Close',
      'nav.groups': 'Groups',
      'nav.newChat': 'New chat with {name}',
      'nav.newGroupChat': 'New chat in {name}',
      'nav.loading': 'Loading…',
      'nav.noChats': 'No chats',
      'nav.noCharacters': 'No character cards',
      'nav.opening': 'Opening {name}',
      'nav.rename': 'Rename {name}',
      'nav.delete': 'Delete {name}',
      'nav.renamePrompt': 'Rename Tavern chat',
      'nav.deleteConfirm': 'Delete Tavern chat "{name}"? This cannot be undone.',
      'error.fileRead': 'File read failed',
      'error.noWorkspace': 'No DSH workspace is available for a Tavern session.',
      'error.noBinding': 'DSH did not expose the new session binding.',
      'error.activationFailed': 'Tavern activation failed.',
      'error.hostCommandUnavailable': 'The Tavern host command is unavailable.',
    }
    const MESSAGES_ZH = {
      'settings.subtitle': '角色卡、世界书与预设管理',
      'settings.activeSetup': '当前配置',
      'settings.character': '角色',
      'settings.characterEmpty': '未选择角色',
      'settings.preset': '预设',
      'settings.presetEmpty': '内置角色扮演预设',
      'settings.persona': '用户人设',
      'settings.personaEmpty': '默认用户',
      'settings.nativePersona': '在标准 DSH Agent 会话中使用当前角色',
      'settings.worldInfo': '世界书',
      'settings.worldsEmpty': '尚未导入世界书',
      'settings.import': '导入',
      'settings.importCharacter': '角色卡',
      'settings.importWorld': '世界书',
      'settings.importPreset': '聊天预设',
      'settings.importing': '导入中…',
      'settings.importTitle': '导入{name}',
      'settings.version': '版本',
      'settings.personaManage': '用户人设',
      'settings.personaEmpty': '尚未创建人设',
      'settings.personaNew': '新建人设',
      'settings.personaImport': '人设 PNG',
      'settings.personaNamePrompt': '人设名称',
      'settings.personaDescPrompt': '人设描述',
      'settings.personaEdit': '编辑{name}',
      'settings.personaDelete': '删除{name}',
      'settings.personaDeleteConfirm': '删除人设“{name}”？',
      'settings.groups': '群聊',
      'settings.groupsEmpty': '尚未创建群聊',
      'settings.groupNew': '新建群聊',
      'settings.groupNamePrompt': '群组名称',
      'settings.groupPickMembers': '选择成员',
      'settings.groupCreate': '创建群组',
      'settings.groupCancel': '取消',
      'settings.groupMembers': '成员',
      'settings.groupStrategy': '激活策略',
      'settings.groupNatural': '自然（健谈度）',
      'settings.groupList': '列表顺序',
      'settings.groupDelete': '删除{name}',
      'settings.groupDeleteConfirm': '删除群组“{name}”？聊天记录会保留。',
      'settings.groupToggleMember': '启用或停用{member}',
      'settings.groupRemoveMember': '移除{member}',
      'settings.regex': '正则脚本',
      'settings.regexEmpty': '尚未导入正则脚本',
      'settings.importRegex': '正则脚本',
      'settings.regexDelete': '删除{name}',
      'settings.regexToggle': '启用或停用{name}',
      'settings.regexPlacements': '作用位置：{names}',
      'settings.pipeline': '生成管线',
      'settings.pipelineHint': '选择回复的生成方式。世界书、宏、正则脚本、swipe 与修订冲突保护在两种方式下行为完全一致。',
      'settings.pipelineHintChat': '按聊天预设的 prompts/prompt_order 组装消息列表，经 DSH 的模型路由发送（provider、密钥与 composer 的模型选择器均生效）。',
      'settings.pipelineHintText': '把上下文模板与 instruct 序列拼成单条提示词，直连 KoboldAI/KoboldCpp 端点生成。需先在下方填写端点；composer 的模型选择器在此模式下不生效，采样参数来自选中的采样器预设。',
      'settings.pipelineChat': 'Chat Completion（DSH 模型）',
      'settings.pipelineText': 'Text Completion（Kobold）',
      'settings.tcEndpoint': 'Kobold 端点',
      'settings.tcApiKey': 'API 密钥（可选）',
      'settings.tcStreaming': '优先 SSE 流式',
      'settings.tcContext': '上下文模板',
      'settings.tcInstruct': '指令模板',
      'settings.tcSampler': '采样器预设',
      'settings.tcTest': '测试连接',
      'settings.tcTesting': '测试中…',
      'settings.tcOk': '已连接：{name}',
      'settings.anyPreset': '无',
      'message.user': '用户',
      'message.previousSwipe': '上一个候选',
      'message.nextSwipe': '下一个候选',
      'message.edit': '编辑消息',
      'message.branch': '从此消息分支',
      'message.branching': '分支中…',
      'message.save': '保存',
      'message.cancel': '取消',
      'view.unbound': '此会话未绑定酒馆聊天。',
      'view.loading': '正在加载酒馆聊天…',
      'view.regenerate': '重新生成最新回复',
      'view.linkedFrom': '来源聊天：{name}',
      'run.connecting': '连接中',
      'run.saved': '已保存',
      'run.stopped': '已停止',
      'run.failed': '生成失败',
      'model.select': '选择模型',
      'model.default': '默认',
      'model.model': '模型',
      'model.effort': '思考力度',
      'model.menuLabel': '模型与思考力度',
      'model.refreshing': '正在刷新模型列表…',
      'model.retry': '重试',
      'model.loadFailed': '{name} 加载失败：{message}',
      'model.noneAvailable': '没有可用模型。',
      'model.noEffort': '该模型不提供思考力度选项。',
      'composer.writeTo': '写给 {name}',
      'composer.unavailable': '酒馆绑定不可用',
      'composer.stop': '停止生成',
      'composer.send': '发送',
      'composer.script': '运行 STscript',
      'composer.member': '由 {name} 回复',
      'nav.title': '酒馆',
      'nav.chats': '酒馆角色扮演聊天',
      'nav.open': '打开酒馆角色扮演聊天',
      'nav.close': '关闭',
      'nav.groups': '群聊',
      'nav.newChat': '与 {name} 开新聊天',
      'nav.newGroupChat': '在 {name} 开新聊天',
      'nav.loading': '加载中…',
      'nav.noChats': '暂无聊天',
      'nav.noCharacters': '暂无角色卡',
      'nav.opening': '正在打开 {name}',
      'nav.rename': '重命名 {name}',
      'nav.delete': '删除 {name}',
      'nav.renamePrompt': '重命名酒馆聊天',
      'nav.deleteConfirm': '删除酒馆聊天“{name}”？此操作不可撤销。',
      'error.fileRead': '文件读取失败',
      'error.noWorkspace': '没有可用于酒馆会话的 DSH 工作区。',
      'error.noBinding': 'DSH 未返回新建会话的绑定。',
      'error.activationFailed': '酒馆激活失败。',
      'error.hostCommandUnavailable': '宿主的酒馆命令不可用。',
    }
    // translate follows the host locale service once apply() binds it; the
    // identity fallback mirrors LocaleRuntime.translate (missing key -> key,
    // {param} interpolation) for pre-apply and stubbed environments.
    let translate = (key, params) => {
      if (!params) return key
      return key.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    }
    let subscribeLocale = () => () => {}
    let getLocaleRevision = () => ({ revision: 0 })

    function useTranslate() {
      useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision)
      return translate
    }
    const STYLE_ID = 'dsh-tavern/native-ui'
    const REVISION_CONFLICT = 'CHAT_REVISION_CONFLICT'
    const EMPTY_BOOTSTRAP = {
      state: { activeWorlds: [], sessionBindings: {}, modelSelections: {}, chats: {}, regexScripts: [], scriptGlobals: {}, pipelineMode: 'chat' },
      characters: [],
      worlds: [],
      presets: [],
      presetKinds: {},
      personas: [],
      groups: [],
      activeCard: null,
      model: { provider: '', model: '' },
    }
    const EMPTY_MODELS = { status: 'idle', groups: [], failures: [], error: '' }
    let snapshot = {
      bootstrap: EMPTY_BOOTSTRAP,
      loading: true,
      error: '',
      chatLists: {},
      chats: {},
      revisions: {},
      displays: {},
      runs: {},
      models: EMPTY_MODELS,
      sidebarAttached: false,
      navigationStatus: '',
    }
    const listeners = new Set()
    const pendingChats = new Map()
    const pendingLists = new Map()
    const pendingModels = new Map()
    const controllers = new Map()

    function update(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    function useTavernStore() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function jsonHeaders() {
      return { 'content-type': 'application/json' }
    }

    async function api(path, options) {
      const response = await fetch(`${API}/${path}`, options)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        const error = new Error(body.message || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body.code
        throw error
      }
      return body
    }

    async function refreshBootstrap() {
      try {
        const result = await api('bootstrap')
        update({ bootstrap: result, loading: false, error: '' })
        return result
      } catch (cause) {
        update({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
    }

    async function patchState(patch) {
      await api('state', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(patch) })
      return refreshBootstrap()
    }

    async function loadModels(force) {
      if (!force && snapshot.models.status !== 'idle') return snapshot.models
      if (pendingModels.has('all')) return pendingModels.get('all')
      update({ models: { ...snapshot.models, status: 'loading', error: '' } })
      const pending = api('models')
        .then((result) => {
          update({
            models: { status: 'ready', groups: result.groups, failures: result.failures, error: '' },
          })
          return snapshot.models
        })
        .catch((cause) => {
          update({ models: { ...snapshot.models, status: 'error', error: cause instanceof Error ? cause.message : String(cause) } })
          throw cause
        })
        .finally(() => pendingModels.delete('all'))
      pendingModels.set('all', pending)
      return pending
    }

    async function saveModelSelection(sessionId, selection) {
      const result = await api('model', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId, selection }),
      })
      update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })
      return result.state
    }

    function sessionSelection(sessionId) {
      const state = snapshot.bootstrap.state
      const saved = state.modelSelections?.[sessionId]
      if (saved?.provider && saved?.model) return saved
      const fallback = snapshot.bootstrap.model
      return fallback?.provider && fallback?.model ? fallback : null
    }

    function chatKey(character, chatId) {
      return `${character}\u0000${chatId}`
    }

    async function loadChatList(character, force) {
      if (!character) return []
      if (!force && snapshot.chatLists[character]) return snapshot.chatLists[character]
      if (pendingLists.has(character)) return pendingLists.get(character)
      const pending = api(`chats?character=${encodeURIComponent(character)}`)
        .then((result) => {
          const ids = [...result.chats].reverse()
          update({ chatLists: { ...snapshot.chatLists, [character]: ids } })
          return ids
        })
        .finally(() => pendingLists.delete(character))
      pendingLists.set(character, pending)
      return pending
    }

    async function loadChat(character, chatId, force) {
      if (!character || !chatId) return null
      const key = chatKey(character, chatId)
      if (!force && snapshot.chats[key]) return snapshot.chats[key]
      if (pendingChats.has(key)) return pendingChats.get(key)
      const pending = api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`)
        .then((result) => {
          update({
            chats: { ...snapshot.chats, [key]: result.chat },
            revisions: { ...snapshot.revisions, [key]: result.revision },
            displays: { ...snapshot.displays, [key]: result.displays },
          })
          return result.chat
        })
        .finally(() => pendingChats.delete(key))
      pendingChats.set(key, pending)
      return pending
    }

    async function saveChat(character, chatId, chat) {
      const key = chatKey(character, chatId)
      try {
        const result = await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ chat, revision: snapshot.revisions[key] }),
        })
        update({
          chats: { ...snapshot.chats, [key]: result.chat || chat },
          revisions: { ...snapshot.revisions, [key]: result.revision },
        })
        return result.chat || chat
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    function setRun(sessionId, patch) {
      update({
        runs: {
          ...snapshot.runs,
          [sessionId]: { busy: false, streamText: '', status: '', error: '', ...(snapshot.runs[sessionId] || {}), ...patch },
        },
      })
    }

    async function generateFor(sessionId, binding, mode, text, options = {}) {
      const currentRun = snapshot.runs[sessionId]
      if (!binding || currentRun?.busy) return
      const key = chatKey(binding.character, binding.chatId)
      const currentChat = snapshot.chats[key] || await loadChat(binding.character, binding.chatId)
      const message = (text || '').trim()
      if (mode === 'send' && !message) return
      if (mode === 'send') {
        const optimistic = {
          ...currentChat,
          messages: [...currentChat.messages, {
            name: 'User',
            is_user: true,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: message,
          }],
        }
        update({ chats: { ...snapshot.chats, [key]: optimistic } })
      }
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      setRun(sessionId, { busy: true, streamText: '', status: 'run.connecting', error: '' })
      const selection = sessionSelection(sessionId)
      try {
        const response = await fetch(`${API}/generate`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            revision: snapshot.revisions[key],
            message,
            mode,
            ...(binding.group === true ? { group: true } : {}),
            ...(options.triggerMember ? { triggerMember: options.triggerMember } : {}),
            ...(selection ? {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
            } : {}),
          }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || `HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamed = ''
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            if (event.type === 'start') {
              const via = `${event.provider}/${event.model}`
              setRun(sessionId, { status: event.speaker && event.speaker !== binding.character ? `${event.speaker} · ${via}` : via, speaker: event.speaker })
            }
            if (event.type === 'delta') {
              streamed += event.text
              setRun(sessionId, { streamText: streamed })
            }
            if (event.type === 'error') {
              const error = new Error(event.message || translate('run.failed'))
              error.code = event.code
              throw error
            }
            if (event.type === 'saved') {
              update({
                chats: { ...snapshot.chats, [key]: event.chat },
                revisions: { ...snapshot.revisions, [key]: event.revision },
              })
              setRun(sessionId, { streamText: '', status: 'run.saved' })
            }
          }
          if (part.done) break
        }
      } catch (cause) {
        const aborted = controller.signal.aborted
        setRun(sessionId, {
          error: aborted ? '' : (cause instanceof Error ? cause.message : String(cause)),
          status: aborted ? 'run.stopped' : '',
          streamText: '',
        })
        await loadChat(binding.character, binding.chatId, true).catch(() => {})
      } finally {
        controllers.delete(sessionId)
        setRun(sessionId, { busy: false })
      }
    }

    function stopGeneration(sessionId) {
      controllers.get(sessionId)?.abort()
    }

    function base64Url(value) {
      const bytes = new TextEncoder().encode(value)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    function currentWorkspace(ctx) {
      const sessions = ctx.sessions.list.getSnapshot()
      const workspaces = ctx.workspaces.list.getSnapshot()
      const current = sessions.current
      return workspaces.items.find((item) => current && item.sessionIds.includes(current))
        || workspaces.items.find((item) => item.workspaceId === workspaces.recentWorkspaceId)
        || workspaces.items[0]
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

    async function openTavernChat(ctx, character, chatId, group = false) {
      update({ navigationStatus: '' })
      const sessions = ctx.sessions.list.getSnapshot()
      const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .find(([sessionId, binding]) => sessions.byId[sessionId]
          && binding.character === character
          && binding.chatId === chatId)
      if (existing) {
        ctx.sessions.open(existing[0])
        clickTavernTab(0)
        return existing[0]
      }

      const workspace = currentWorkspace(ctx)
      if (!workspace) throw new Error(translate('error.noWorkspace'))
      update({ navigationStatus: translate('nav.opening', { name: character }) })
      const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
      const binding = ctx.sessions.binding(sessionId)
      if (!binding) throw new Error(translate('error.noBinding'))
      const payload = base64Url(JSON.stringify({ character, chatId, ...(group ? { group: true } : {}) }))
      const result = await binding.session.command(`/tavern ${payload}`)
      if (!result.ok) throw new Error(result.error?.message || translate('error.activationFailed'))
      if (!result.value.matched) throw new Error(translate('error.hostCommandUnavailable'))
      const label = sessionLabel(character, chatId, group)
      await binding.session.rename(label).catch(() => {})
      await refreshBootstrap()
      ctx.sessions.open(sessionId)
      update({ navigationStatus: '' })
      clickTavernTab(0)
      return sessionId
    }

    async function createTavernChat(ctx, character, group = false) {
      const result = await api('chats', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(group ? { group: character } : { character }),
      })
      await loadChatList(character, true)
      const key = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [key]: result.chat },
        revisions: { ...snapshot.revisions, [key]: result.revision },
      })
      return openTavernChat(ctx, character, result.id, group)
    }

    async function branchTavernChat(ctx, character, chatId, index) {
      const key = chatKey(character, chatId)
      const revision = snapshot.revisions[key]
      if (!revision) throw new Error(translate('view.loading'))
      const result = await api('branch', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character, chatId, messageId: index, revision }),
      })
      const nextKey = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [nextKey]: result.chat },
        revisions: { ...snapshot.revisions, [nextKey]: result.revision },
      })
      await loadChatList(character, true)
      return openTavernChat(ctx, character, result.id)
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

    function sessionLabel(character, chatId, group = false) {
      const stem = chatId.replace(/\.jsonl$/i, '').slice(0, 44)
      return group ? `☰ ${character} · ${stem}` : `${character} · ${stem}`
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
          const binding = ctx.sessions.binding(sessionId)
          await binding?.session.rename(sessionLabel(character, result.id)).catch(() => {})
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
        const binding = ctx.sessions.binding(sessionId)
        await binding?.session.command(`/tavern ${closePayload}`).catch(() => {})
        await ctx.workspaces.archiveSession(sessionId).catch(() => {})
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
        if (node?.kind === 'context'
          && node.data?.source?.kind === 'plugin'
          && node.data.source.plugin === 'dsh-tavern') {
          match = node.data.source.tavernState === 'closed' ? null : { marker: node.key }
        }
      }
      return match
    }

    function selectTavernComposer(owner) {
      return isTavernSession(owner.session)
    }

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
    }

    async function createPersona(name, description) {
      const result = await api('import/persona', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
      return result.persona
    }

    async function savePersona(name, description) {
      const result = await api('persona', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
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
      return result.group
    }

    async function updateGroup(payload) {
      const result = await api('group', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      await refreshBootstrap()
      return result.group
    }

    async function deleteGroup(name) {
      await api(`group?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function saveRegexScripts(scripts) {
      const result = await api('regex', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ scripts }),
      })
      update({ bootstrap: { ...snapshot.bootstrap, state: { ...snapshot.bootstrap.state, regexScripts: result.scripts } } })
      return result.scripts
    }

    async function saveTextCompletion(patch) {
      await api('state', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(patch),
      })
      await refreshBootstrap()
    }

    async function testKoboldConnection() {
      return api('tc/check')
    }

    function SettingSelect({ label, value, options, empty, onChange }) {
      return h('label', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, label),
        h('select', { value: value || '', onChange: (event) => onChange(event.target.value || null) },
          ...(empty === undefined ? [] : [h('option', { key: '', value: '' }, empty)]),
          options.map((option) => h('option', { key: option, value: option }, option))))
    }

    function UploadButton({ kind, label, accept }) {
      const t = useTranslate()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return h('label', { className: 'dt-upload', title: t('settings.importTitle', { name: label }) },
        busy ? t('settings.importing') : label,
        h('input', {
          type: 'file',
          accept,
          disabled: busy,
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            setBusy(true)
            setError('')
            void importAsset(kind, file).catch((cause) => setError(cause.message)).finally(() => setBusy(false))
          },
        }),
        error ? h('span', { className: 'dt-upload-error', title: error }, '!') : null)
    }

    function PersonaBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const personas = state.bootstrap.personas || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.personaManage')),
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            onClick: () => {
              const name = window.prompt(t('settings.personaNamePrompt'), '')
              if (name === null || name.trim() === '') return
              run(createPersona(name.trim(), ''))
            },
          }, t('settings.personaNew')),
          h(UploadButton, { kind: 'persona', label: t('settings.personaImport'), accept: '.png,image/png' })),
        personas.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.personaEmpty')) : h('div', { className: 'dt-persona-list' },
          personas.map((persona) => h('div', { key: persona.name, className: 'dt-persona-row' },
            h('img', {
              className: 'dt-persona-avatar',
              src: `${API}/persona-avatar/${encodeURIComponent(persona.name)}`,
              alt: '',
              onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
            }),
            h('div', { className: 'dt-persona-copy' },
              h('strong', null, persona.name),
              h('span', { title: persona.description }, persona.description.slice(0, 140) || '—')),
            h('div', { className: 'dt-persona-actions' },
              h('button', {
                type: 'button',
                title: t('settings.personaEdit', { name: persona.name }),
                onClick: () => {
                  const next = window.prompt(t('settings.personaDescPrompt'), persona.description)
                  if (next === null) return
                  run(savePersona(persona.name, next))
                },
              }, h(IconEditOutline16)),
              h('button', {
                type: 'button',
                title: t('settings.personaDelete', { name: persona.name }),
                onClick: () => {
                  if (window.confirm(t('settings.personaDeleteConfirm', { name: persona.name }))) run(deletePersona(persona.name))
                },
              }, h(IconTrashOutline16)))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function GroupBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [creating, setCreating] = useState(null)
      const [selected, setSelected] = useState([])
      const characters = state.bootstrap.characters
      const groups = state.bootstrap.groups || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.groups')),
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            onClick: () => {
              const name = window.prompt(t('settings.groupNamePrompt'), '')
              if (name === null || name.trim() === '') return
              setCreating(name.trim())
              setSelected([])
            },
          }, t('settings.groupNew'))),
        creating !== null ? h('div', { className: 'dt-group-create' },
          h('strong', null, `${t('settings.groupPickMembers')} — ${creating}`),
          h('div', { className: 'dt-check-grid' }, characters.map((name) => h('label', { key: name },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(name),
              onChange: (event) => {
                setSelected(event.target.checked ? [...selected, name] : selected.filter((item) => item !== name))
              },
            }),
            h('span', null, name))),
          characters.length === 0 ? h('span', { className: 'dt-muted' }, t('nav.noCharacters')) : null),
          h('div', { className: 'dt-imports' },
            h('button', {
              type: 'button',
              className: 'dt-upload',
              disabled: selected.length === 0,
              onClick: () => {
                const name = creating
                setCreating(null)
                run(createGroup(name, selected, 1))
              },
            }, t('settings.groupCreate')),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => setCreating(null) }, t('settings.groupCancel')))) : null,
        groups.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.groupsEmpty')) : h('div', { className: 'dt-group-list' },
          groups.map((group) => h('div', { key: group.name, className: 'dt-group-manage' },
            h('div', { className: 'dt-group-title' },
              h('strong', null, `${group.name} (${group.members.length})`),
              h('span', null, t('settings.groupMembers')),
              h('select', {
                value: group.activationStrategy,
                'aria-label': t('settings.groupStrategy'),
                onChange: (event) => run(updateGroup({ name: group.name, activationStrategy: Number(event.target.value) })),
              },
              h('option', { value: 1 }, t('settings.groupNatural')),
              h('option', { value: 2 }, t('settings.groupList'))),
              h('button', {
                type: 'button',
                title: t('settings.groupDelete', { name: group.name }),
                onClick: () => {
                  if (window.confirm(t('settings.groupDeleteConfirm', { name: group.name }))) run(deleteGroup(group.name))
                },
              }, h(IconTrashOutline16))),
            h('div', { className: 'dt-group-members' }, group.members.map((member) => {
              const disabled = group.disabledMembers.includes(member)
              return h('span', {
                key: member,
                className: `dt-member-chip ${disabled ? 'dt-member-chip-off' : ''}`,
                title: t('settings.groupToggleMember', { member }),
                onClick: () => run(updateGroup({
                  name: group.name,
                  disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                })),
              },
              h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
              h('span', null, member),
              h('button', {
                type: 'button',
                title: t('settings.groupToggleMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({
                    name: group.name,
                    disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                  }))
                },
              }, disabled ? '○' : '●'),
              h('button', {
                type: 'button',
                title: t('settings.groupRemoveMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({ name: group.name, members: group.members.filter((item) => item !== member) }))
                },
              }, '×'))
            }))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    const REGEX_PLACEMENT_NAMES = { 1: 'input', 2: 'output', 3: 'command', 5: 'world info', 6: 'reasoning' }

    function RegexBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const scripts = state.bootstrap.state.regexScripts || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.regex')),
        h('div', { className: 'dt-imports' },
          h(UploadButton, { kind: 'regex', label: t('settings.importRegex'), accept: '.json,application/json' })),
        scripts.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.regexEmpty')) : h('div', { className: 'dt-regex-list' },
          scripts.map((script) => h('div', { key: script.id, className: `dt-regex-row ${script.disabled ? 'dt-regex-off' : ''}` },
            h('label', { className: 'dt-toggle', title: t('settings.regexToggle', { name: script.scriptName }) },
              h('input', {
                type: 'checkbox',
                checked: !script.disabled,
                onChange: () => run(saveRegexScripts(scripts.map((item) => item.id === script.id ? { ...item, disabled: !item.disabled } : item))),
              }),
              h('span', null, script.scriptName)),
            h('span', { className: 'dt-muted', title: t('settings.regexPlacements', { names: script.placement.map((p) => REGEX_PLACEMENT_NAMES[p] || p).join(', ') }) },
              script.findRegex.slice(0, 60)),
            h('button', {
              type: 'button',
              title: t('settings.regexDelete', { name: script.scriptName }),
              onClick: () => run(saveRegexScripts(scripts.filter((item) => item.id !== script.id))),
            }, h(IconTrashOutline16))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PipelineBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [testing, setTesting] = useState('')
      const tavernState = state.bootstrap.state
      const tc = tavernState.textCompletion || {}
      const kinds = state.bootstrap.presetKinds || {}
      const presetsOf = (kind) => Object.keys(kinds).filter((name) => kinds[name] === kind).sort()
      const save = (patch) => { setError(''); void saveTextCompletion(patch).catch((cause) => setError(cause.message)) }
      const saveTc = (patch) => save({ textCompletion: { endpoint: '', streaming: true, ...tc, ...patch } })
      const mode = tavernState.pipelineMode === 'text' ? 'text' : 'chat'
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.pipeline')),
        h('p', { className: 'dt-hint' }, t('settings.pipelineHint')),
        h('div', { className: 'dt-settings-grid' },
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('settings.pipeline')),
            h('select', {
              value: mode,
              'aria-label': t('settings.pipeline'),
              onChange: (event) => save({ pipelineMode: event.target.value || 'chat' }),
            },
            h('option', { value: 'chat' }, t('settings.pipelineChat')),
            h('option', { value: 'text' }, t('settings.pipelineText')))),
          h('p', { className: 'dt-hint dt-hint-wide' }, t(mode === 'text' ? 'settings.pipelineHintText' : 'settings.pipelineHintChat')),
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('settings.tcEndpoint')),
            h('input', {
              type: 'text',
              defaultValue: tc.endpoint || '',
              placeholder: 'http://127.0.0.1:5001',
              onBlur: (event) => { if (event.target.value.trim() !== (tc.endpoint || '')) saveTc({ endpoint: event.target.value.trim() }) },
            })),
          h('label', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('settings.tcApiKey')),
            h('input', {
              type: 'password',
              defaultValue: tc.apiKey || '',
              onBlur: (event) => { if (event.target.value !== (tc.apiKey || '')) saveTc({ apiKey: event.target.value }) },
            })),
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: tc.streaming !== false,
              onChange: (event) => saveTc({ streaming: event.target.checked }),
            }),
            h('span', null, t('settings.tcStreaming'))),
          h(SettingSelect, {
            label: t('settings.tcContext'),
            value: tc.contextPreset || '',
            options: presetsOf('context'),
            empty: t('settings.presetEmpty'),
            onChange: (value) => saveTc({ contextPreset: value || undefined }),
          }),
          h(SettingSelect, {
            label: t('settings.tcInstruct'),
            value: tc.instructPreset || '',
            options: presetsOf('instruct'),
            empty: t('settings.anyPreset'),
            onChange: (value) => saveTc({ instructPreset: value || undefined }),
          }),
          h(SettingSelect, {
            label: t('settings.tcSampler'),
            value: tc.samplerPreset || '',
            options: presetsOf('textgen-sampler'),
            empty: t('settings.anyPreset'),
            onChange: (value) => saveTc({ samplerPreset: value || undefined }),
          })),
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            disabled: testing !== '',
            onClick: () => {
              setTesting(t('settings.tcTesting'))
              setError('')
              void testKoboldConnection()
                .then((result) => setTesting(t('settings.tcOk', { name: result.model?.name || 'kobold' })))
                .catch((cause) => { setTesting(''); setError(cause.message) })
            },
          }, testing !== '' ? testing : t('settings.tcTest'))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function TavernSettings() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const [error, setError] = useState('')
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const applyPatch = (patch) => {
        setError('')
        void patchState(patch).catch((cause) => setError(cause.message))
      }
      const stamp = bootstrap.version || bootstrap.commit
        ? `v${bootstrap.version || '?'}${bootstrap.commit ? ` (${bootstrap.commit})` : ''}`
        : ''
      return h('div', { className: 'dt-settings', 'data-dsh-tavern-settings': '' },
        h('div', { className: 'dt-settings-heading' },
          h('div', null,
            h('h2', null, 'dsh-tavern'),
            h('p', null, t('settings.subtitle')),
            stamp ? h('p', { className: 'dt-settings-version' }, `${t('settings.version')} ${stamp}`) : null)),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.activeSetup')),
          h('div', { className: 'dt-settings-grid' },
            h(SettingSelect, {
              label: t('settings.character'),
              value: bootstrap.state.activeCharacter,
              options: bootstrap.characters,
              empty: t('settings.characterEmpty'),
              onChange: (value) => applyPatch({ activeCharacter: value }),
            }),
            h(SettingSelect, {
              label: t('settings.preset'),
              value: bootstrap.state.activePreset,
              options: bootstrap.presets,
              empty: t('settings.presetEmpty'),
              onChange: (value) => applyPatch({ activePreset: value }),
            }),
            h(SettingSelect, {
              label: t('settings.persona'),
              value: bootstrap.state.activePersona,
              options: bootstrap.personas.map((persona) => persona.name),
              empty: t('settings.personaEmpty'),
              onChange: (value) => applyPatch({ activePersona: value }),
            }),
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: bootstrap.state.nativeAgentPersona === true,
                onChange: (event) => applyPatch({ nativeAgentPersona: event.target.checked }),
              }),
              h('span', null, t('settings.nativePersona'))))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.worldInfo')),
          bootstrap.worlds.length === 0
            ? h('p', { className: 'dt-muted' }, t('settings.worldsEmpty'))
            : h('div', { className: 'dt-check-grid' }, bootstrap.worlds.map((name) => h('label', { key: name },
                h('input', {
                  type: 'checkbox',
                  checked: bootstrap.state.activeWorlds.includes(name),
                  onChange: (event) => {
                    const worlds = new Set(bootstrap.state.activeWorlds)
                    if (event.target.checked) worlds.add(name)
                    else worlds.delete(name)
                    applyPatch({ activeWorlds: [...worlds] })
                  },
                }),
                h('span', null, name))))),
        h(PersonaBand),
        h(GroupBand),
        h(RegexBand),
        h(PipelineBand),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'character', label: t('settings.importCharacter'), accept: '.png,.charx,.json,application/json,image/png,application/zip' }),
            h(UploadButton, { kind: 'world', label: t('settings.importWorld'), accept: '.json,application/json' }),
            h(UploadButton, { kind: 'preset', label: t('settings.importPreset'), accept: '.json,application/json' }))),
        error || state.error ? h('p', { className: 'dt-error' }, error || state.error) : null)
    }

    function MessageRow({ sessionId, character, chatId, chat, message, index, busy, display }) {
      const t = useTranslate()
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(message.mes || '')
      const [error, setError] = useState('')
      const [branching, setBranching] = useState(false)
      useEffect(() => setDraft(message.mes || ''), [message.mes])
      const isUser = message.is_user === true
      const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes || '']
      const swipeIndex = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1)
      const persist = async (nextMessage) => {
        setError('')
        const nextChat = { ...chat, messages: chat.messages.map((item, itemIndex) => itemIndex === index ? nextMessage : item) }
        try {
          await saveChat(character, chatId, nextChat)
          return true
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          setRun(sessionId, { error: message })
          return false
        }
      }
      const changeSwipe = (delta) => {
        const nextIndex = (swipeIndex + delta + swipes.length) % swipes.length
        void persist({ ...message, swipe_id: nextIndex, mes: swipes[nextIndex] })
      }
      const commit = async () => {
        const nextSwipes = swipes.map((value, itemIndex) => itemIndex === swipeIndex ? draft : value)
        if (await persist({ ...message, mes: draft, ...(message.swipes ? { swipes: nextSwipes } : {}) })) {
          setEditing(false)
        }
      }
      const branch = () => {
        setError('')
        setBranching(true)
        void branchTavernChat(SidebarAdapter.context, character, chatId, index)
          .catch((cause) => setError(cause.message))
          .finally(() => setBranching(false))
      }
      return h('article', { className: `dt-message ${isUser ? 'dt-message-user' : 'dt-message-character'}` },
        !isUser ? h('img', {
          className: 'dt-message-avatar',
          src: `${API}/avatar/${encodeURIComponent(message.name || character)}`,
          alt: '',
          onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
        }) : null,
        h('div', { className: 'dt-message-body' },
          h('div', { className: 'dt-message-name' }, message.name || (isUser ? t('message.user') : character)),
          editing
            ? h('textarea', { className: 'dt-message-edit', value: draft, disabled: busy, onChange: (event) => setDraft(event.target.value) })
            : h('div', { className: 'dt-message-copy' }, display ?? message.mes ?? ''),
          h('div', { className: 'dt-message-actions' },
            swipes.length > 1 ? h(React.Fragment, null,
              h('button', { type: 'button', title: t('message.previousSwipe'), disabled: busy, onClick: () => changeSwipe(-1) }, h(IconChevronLeftOutline14)),
              h('span', null, `${swipeIndex + 1}/${swipes.length}`),
              h('button', { type: 'button', title: t('message.nextSwipe'), disabled: busy, onClick: () => changeSwipe(1) }, h(IconChevronRightOutline14))) : null,
            editing ? h(React.Fragment, null,
              h('button', { type: 'button', disabled: busy, onClick: () => void commit() }, t('message.save')),
              h('button', { type: 'button', onClick: () => { setDraft(message.mes || ''); setError(''); setEditing(false) } }, t('message.cancel')))
              : h(React.Fragment, null,
                h('button', { type: 'button', title: t('message.edit'), disabled: busy, onClick: () => setEditing(true) }, h(IconEditOutline16)),
                h('button', { type: 'button', className: 'dt-branch-btn', title: t('message.branch'), disabled: busy || branching, onClick: branch }, '⑂'))),
          branching ? h('span', { className: 'dt-message-error' }, t('message.branching')) : null,
          error ? h('span', { className: 'dt-message-error' }, error) : null))
    }

    function TavernView({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const run = state.runs[sessionId] || {}
      const endRef = useRef(null)
      useEffect(() => {
        if (binding) void loadChat(binding.character, binding.chatId).catch((cause) => setRun(sessionId, { error: cause.message }))
      }, [binding?.character, binding?.chatId, sessionId])
      useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [chat, run.streamText])
      if (!binding) {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' },
          h(IconUserOutline16, { size: 22 }),
          h('strong', null, t('view.unbound')))
      }
      if (!chat) return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' }, t('view.loading'))
      const messages = [...chat.messages]
      if (run.streamText) messages.push({ name: run.speaker || binding.character, is_user: false, mes: run.streamText, streaming: true })
      const link = chat.header?.chat_metadata?.bookmark_link
      return h('div', { className: 'dt-view', 'data-dsh-tavern-surface': 'view' },
        link ? h('div', { className: 'dt-backlink' },
          h('button', {
            type: 'button',
            onClick: () => {
              void openTavernChat(SidebarAdapter.context, link.character, link.chatId)
                .catch((cause) => setRun(sessionId, { error: cause.message }))
            },
          }, `↩ ${t('view.linkedFrom', { name: `${link.character} · ${(link.chatId || '').replace(/\.jsonl$/i, '')}` })}`)) : null,
        h('div', { className: 'dt-scene-strip' },
          h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
          h('div', null, h('strong', null, binding.character), h('span', null, binding.chatId.replace(/\.jsonl$/i, ''))),
          h('button', {
            type: 'button',
            title: t('view.regenerate'),
            disabled: run.busy || !chat.messages.some((message) => !message.is_user),
            onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
          }, h(IconRefreshOutline16))),
        h('div', { className: 'dt-transcript' },
          messages.map((message, index) => h(MessageRow, {
            key: `${index}-${message.send_date || ''}-${message.streaming ? 'stream' : 'saved'}`,
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            chat,
            message,
            index,
            busy: run.busy || message.streaming,
            display: state.displays[chatKey(binding.character, binding.chatId)]?.[index],
          })),
          h('div', { className: 'dt-transcript-end', ref: endRef })),
        run.error ? h('div', { className: 'dt-run-error' }, run.error) : null)
    }

    function findCurrentChoice(groups, selection) {
      if (!selection) return null
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === selection.provider && model.id === selection.model) return { group, model }
        }
      }
      return null
    }

    // ModelSelect mirrors the native composer model seat: a pill trigger in the
    // input row opening a two-level Model/Effort menu over the provider-grouped
    // directory. Selection persists per Tavern session; the fallback is the DSH
    // default model, and a current selection outside the advertised catalog
    // keeps the trigger on the "Select model" fallback without a stale row.
    function ModelSelect({ sessionId, locked }) {
      const state = useTavernStore()
      const t = useTranslate()
      const models = state.models
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [actionError, setActionError] = useState('')
      const [selecting, setSelecting] = useState(false)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const itemRefs = useRef([])
      const id = useId()
      const selection = sessionSelection(sessionId)
      const currentChoice = findCurrentChoice(models.groups, selection)
      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = selection?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined ? undefined
        : effectiveEffort === undefined ? t('model.default')
          : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
      useEffect(() => { if (snapshot.models.status === 'idle') void loadModels().catch(() => {}) }, [])
      useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])
      const close = (restoreFocus) => {
        setOpen(false)
        setPane('root')
        setActionError('')
        if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
      }
      const show = () => {
        setPane('root')
        setActionError('')
        setOpen(true)
        void loadModels(true).catch(() => {})
      }
      const moveFocus = (offset) => {
        const items = itemRefs.current.filter((item) => item !== null)
        if (items.length === 0) return
        const active = items.findIndex((item) => item === document.activeElement)
        items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          if (pane !== 'root') setPane('root')
          else close(true)
          return
        }
        if (!open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }
      const onBlur = (event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
        close(false)
      }
      const submit = (next) => {
        setSelecting(true)
        setActionError('')
        saveModelSelection(sessionId, next)
          .then(() => { setSelecting(false); close(true) }, (cause) => {
            setSelecting(false)
            setActionError(cause instanceof Error ? cause.message : String(cause))
          })
      }
      const choose = (provider, model, defaultEffort) => {
        if (selection?.provider === provider && selection?.model === model) {
          close(true)
          return
        }
        submit({
          provider,
          model,
          ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
        })
      }
      const chooseEffort = (effort) => {
        if (!selection) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        submit({
          provider: selection.provider,
          model: selection.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        })
      }
      const modelLabel = currentChoice?.model.name ?? t('model.select')
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      itemRefs.current = []
      let itemIndex = 0
      const itemRef = () => {
        const at = itemIndex++
        return (node) => { itemRefs.current[at] = node }
      }
      const retry = h('button', {
        type: 'button',
        className: 'dt-model-retry',
        onClick: () => { void loadModels(true).catch(() => {}) },
      }, t('model.retry'))
      const actionErrorRow = actionError
        ? h('div', { className: 'dt-model-error' }, h('span', null, actionError))
        : null
      const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'dt-model-trigger',
        'aria-label': t('model.select'),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        title: triggerLabel,
        disabled: locked,
        onClick: () => { if (open) close(false); else show() },
      },
      h('span', { className: 'dt-model-trigger-label' }, modelLabel),
      effortLabel !== undefined ? h('span', { className: 'dt-model-trigger-effort' }, effortLabel) : null,
      h(IconChevronDownOutline14, { className: `dt-model-chevron ${open ? 'dt-model-chevron-open' : ''}` }))
      const drillCell = (label, value, paneName) => h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitem',
        className: 'dt-model-cell',
        onClick: () => setPane(paneName),
      },
      h('span', { className: 'dt-model-cell-label' }, label),
      h('span', { className: 'dt-model-cell-value' }, value),
      h(IconChevronRightOutline14, { className: 'dt-model-cell-chevron' }))
      const rootPane = pane === 'root' ? h(React.Fragment, null,
        actionErrorRow,
        drillCell(t('model.model'), modelLabel, 'model'),
        reasoning !== undefined ? drillCell(t('model.effort'), effortLabel, 'effort') : null) : null
      const modelPane = pane === 'model' ? h(React.Fragment, null,
        models.status === 'loading' ? h('div', { className: 'dt-model-status' }, t('model.refreshing')) : null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        models.failures.map((failure) => h('div', { key: failure.id, className: 'dt-model-warning' },
          h('span', null, t('model.loadFailed', { name: failure.name, message: failure.message })),
          retry)),
        h('div', { className: 'dt-model-groups' },
          models.groups.map((group) => h('section', {
            key: group.id,
            role: 'group',
            'aria-labelledby': `${id}-${group.id}`,
            className: 'dt-model-group',
          },
          h('div', { className: 'dt-model-group-title', id: `${id}-${group.id}` }, group.name),
          group.models.map((model) => {
            const selected = selection?.provider === group.id && selection?.model === model.id
            return h('button', {
              ref: itemRef(),
              key: model.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected,
              className: 'dt-model-option',
              title: model.name,
              disabled: selecting,
              onClick: () => choose(group.id, model.id, model.reasoning?.defaultEffort),
            },
            h('span', { className: 'dt-model-option-copy' },
              h('span', { className: 'dt-model-name' }, model.name),
              model.description !== undefined ? h('span', { className: 'dt-model-description' }, model.description) : null),
            h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
          }))),
        models.status === 'ready' && models.groups.every((group) => group.models.length === 0)
          ? h('div', { className: 'dt-model-empty' }, t('model.noneAvailable'))
          : null)) : null
      const effortPane = pane === 'effort' ? h(React.Fragment, null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        reasoning === undefined
          ? h('div', { className: 'dt-model-empty' }, t('model.noEffort'))
          : h(React.Fragment, null,
            reasoning.defaultEffort === undefined ? h('button', {
              ref: itemRef(),
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': effectiveEffort === undefined,
              className: 'dt-model-option',
              disabled: selecting,
              onClick: () => chooseEffort(undefined),
            },
            h('span', { className: 'dt-model-option-copy' }, h('span', { className: 'dt-model-name' }, t('model.default'))),
            h('span', { className: 'dt-model-check' }, effectiveEffort === undefined ? h(IconCheckOutline16) : null)) : null,
            reasoning.efforts.map((effort) => {
              const selected = effectiveEffort === effort.id
              return h('button', {
                ref: itemRef(),
                key: effort.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected,
                className: 'dt-model-option',
                disabled: selecting,
                onClick: () => chooseEffort(effort.id),
              },
              h('span', { className: 'dt-model-option-copy' },
                h('span', { className: 'dt-model-name' }, effort.name),
                effort.description !== undefined ? h('span', { className: 'dt-model-description' }, effort.description) : null),
              h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
            }))) : null
      return h('div', { ref: rootRef, className: 'dt-model-select', onKeyDown, onBlur },
        trigger,
        open ? h('div', {
          id: `${id}-menu`,
          className: 'dt-model-menu',
          role: 'menu',
          'aria-label': t('model.menuLabel'),
        }, rootPane, modelPane, effortPane) : null)
    }

    function MemberPicker({ binding, disabled, selected, onSelect }) {
      const state = useTavernStore()
      const t = useTranslate()
      const group = (state.bootstrap.groups || []).find((item) => item.name === binding.character)
      if (!group) return null
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      return h('div', { className: 'dt-member-row' },
        enabled.map((member) => h('button', {
          key: member,
          type: 'button',
          className: `dt-member-chip ${selected === member ? 'dt-member-chip-active' : ''}`,
          title: t('composer.member', { name: member }),
          disabled,
          onClick: () => onSelect(selected === member ? '' : member),
        },
        h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
        h('span', null, member))))
    }

    function TavernComposer({ sessionId, useInput, inputActions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const input = useInput((value) => value)
      const run = state.runs[sessionId] || {}
      const [trigger, setTrigger] = useState('')
      const send = () => {
        const message = input.draft.trim()
        if (!binding || !message || run.busy) return
        if (message.startsWith('/')) {
          inputActions.setDraft('')
          void runTavernScriptCommand(sessionId, binding, message)
          return
        }
        inputActions.setDraft('')
        void generateFor(sessionId, binding, 'send', message, trigger ? { triggerMember: trigger } : {})
        setTrigger('')
      }
      const placeholder = binding
        ? `${binding.group === true ? '☰ ' : ''}${t('composer.writeTo', { name: binding.character })}`
        : t('composer.unavailable')
      return h('div', { className: 'dt-composer-wrap', 'data-dsh-tavern-surface': 'composer' },
        h('div', { className: 'dt-composer' },
          binding?.group === true ? h(MemberPicker, { binding, disabled: run.busy, selected: trigger, onSelect: setTrigger }) : null,
          h('textarea', {
            value: input.draft,
            disabled: !binding || run.busy,
            placeholder,
            rows: 2,
            onChange: (event) => inputActions.setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dt-composer-row' },
            h('span', { className: run.error ? 'dt-error' : 'dt-muted' }, run.error || (run.status ? t(run.status) : (binding ? binding.character : ''))),
            h('div', { className: 'dt-composer-actions' },
              h(ModelSelect, { sessionId, locked: run.busy || !binding }),
              run.busy
                ? h('button', { type: 'button', className: 'dt-primary-icon', title: t('composer.stop'), onClick: () => stopGeneration(sessionId) }, h(IconStopFill16))
                : h('button', {
                  type: 'button',
                  className: 'dt-primary-icon',
                  title: input.draft.trim().startsWith('/') ? t('composer.script') : t('composer.send'),
                  disabled: !binding || !input.draft.trim(),
                  onClick: send,
                }, input.draft.trim().startsWith('/') ? h('span', { className: 'dt-script-glyph' }, '/') : h(IconSendOutline16))))))
    }

    function TavernHeaderAction({ sessionId, useSession }) {
      const state = useTavernStore()
      const t = useTranslate()
      const active = useSession((session) => isTavernSession(session) !== null)
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const run = state.runs[sessionId] || {}
      if (!active || !binding) return null
      return h('div', { className: 'dt-header-character', 'data-dsh-tavern-surface': 'header' },
        h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
        h('span', null, binding.character),
        h('button', {
          type: 'button',
          title: t('view.regenerate'),
          disabled: run.busy,
          onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
        }, h(IconRefreshOutline16)))
    }

    function visibleSidebarTree() {
      const candidates = [...document.querySelectorAll('[role="tree"]')]
      return candidates.find((tree) => {
        if (tree.closest('[data-dsh-tavern-sidebar-host]')) return false
        const rect = tree.getBoundingClientRect()
        return rect.width > 40 && rect.height > 20 && rect.left < Math.min(420, window.innerWidth * 0.4)
      }) || null
    }

    function useSidebarHost() {
      const [host, setHost] = useState(null)
      useEffect(() => {
        let frame = 0
        let current = null
        const attach = () => {
          frame = 0
          const tree = visibleSidebarTree()
          if (!tree?.parentElement) {
            if (current?.isConnected) current.remove()
            current = null
            setHost(null)
            if (snapshot.sidebarAttached) update({ sidebarAttached: false })
            return
          }
          if (!current || !current.isConnected || current.parentElement !== tree.parentElement) {
            current?.remove()
            current = document.createElement('div')
            current.dataset.dshTavernSidebarHost = ''
            tree.parentElement.insertBefore(current, tree)
            setHost(current)
          }
          if (!snapshot.sidebarAttached) update({ sidebarAttached: true })
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(attach)
        }
        attach()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          current?.remove()
          update({ sidebarAttached: false })
        }
      }, [])
      return host
    }

    function ChatList({ ctx, character, currentSession, group = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const chats = state.chatLists[character]
      const [error, setError] = useState('')
      const [busyChat, setBusyChat] = useState('')
      useEffect(() => { void loadChatList(character).catch((cause) => setError(cause.message)) }, [character])
      const activeBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const open = (chatId) => {
        setError('')
        void openTavernChat(ctx, character, chatId, group).catch((cause) => {
          update({ navigationStatus: '' })
          setError(cause.message)
        })
      }
      const runAction = (chatId, action) => {
        setError('')
        setBusyChat(chatId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusyChat(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        chats?.map((chatId) => h('div', {
          key: chatId,
          className: `dt-sidebar-chat-row ${activeBinding?.character === character && activeBinding.chatId === chatId ? 'dt-sidebar-chat-active' : ''}`,
        },
        h('button', {
          type: 'button',
          className: 'dt-sidebar-chat-open',
          title: chatId,
          disabled: busyChat === chatId,
          onClick: () => open(chatId),
        }, h('span', null, / - branch \d+$/.test(chatId.replace(/\.jsonl$/i, '')) ? '⑂ ' : '', chatId.replace(/\.jsonl$/i, ''))),
        h('button', {
          type: 'button',
          title: t('nav.rename', { name: chatId.replace(/\.jsonl$/i, '') }),
          disabled: busyChat === chatId,
          onClick: () => runAction(chatId, () => renameTavernChat(ctx, character, chatId)),
        }, h(IconEditOutline16)),
        h('button', {
          type: 'button',
          title: t('nav.delete', { name: chatId.replace(/\.jsonl$/i, '') }),
          disabled: busyChat === chatId,
          onClick: () => runAction(chatId, () => deleteTavernChat(ctx, character, chatId)),
        }, h(IconTrashOutline16)))),
        !chats ? h('span', { className: 'dt-sidebar-status' }, t('nav.loading')) : null,
        chats?.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noChats')) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    function TavernSidebar({ ctx, useSessions, floating, onClose }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useSessions((sessions) => sessions.current)
      const [expanded, setExpanded] = useState(state.bootstrap.state.activeCharacter || state.bootstrap.characters[0] || '')
      const [expandedGroup, setExpandedGroup] = useState('')
      const [error, setError] = useState('')
      const groups = state.bootstrap.groups || []
      return h('section', { className: `dt-sidebar ${floating ? 'dt-sidebar-floating' : ''}`, 'aria-label': t('nav.chats') },
        h('div', { className: 'dt-sidebar-heading' },
          h('span', null, h(IconUserOutline16), h('strong', null, t('nav.title'))),
          floating ? h('button', { type: 'button', title: t('nav.close'), onClick: onClose }, '×') : null),
        state.bootstrap.characters.map((character) => {
          const open = expanded === character
          return h('div', { key: character, className: 'dt-character-group' },
            h('div', { className: 'dt-character-row' },
              h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpanded(open ? '' : character) },
                h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                h('img', { src: `${API}/avatar/${encodeURIComponent(character)}`, alt: '' }),
                h('span', null, character)),
              h('button', {
                type: 'button',
                title: t('nav.newChat', { name: character }),
                onClick: () => {
                  setError('')
                  void createTavernChat(ctx, character).catch((cause) => {
                    update({ navigationStatus: '' })
                    setError(cause.message)
                  })
                },
              }, h(IconPlusOutline16))),
            open ? h(ChatList, { ctx, character, currentSession }) : null)
        }),
        state.bootstrap.characters.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noCharacters')) : null,
        groups.length > 0 ? h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },
          h('span', null, '☰ ', h('strong', null, t('nav.groups')))) : null,
        groups.map((group) => {
          const open = expandedGroup === group.name
          return h('div', { key: group.name, className: 'dt-character-group' },
            h('div', { className: 'dt-character-row' },
              h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpandedGroup(open ? '' : group.name) },
                h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                h('img', { src: `${API}/avatar/${encodeURIComponent(group.name)}`, alt: '' }),
                h('span', null, `☰ ${group.name}`)),
              h('button', {
                type: 'button',
                title: t('nav.newGroupChat', { name: group.name }),
                onClick: () => {
                  setError('')
                  void createTavernChat(ctx, group.name, true).catch((cause) => {
                    update({ navigationStatus: '' })
                    setError(cause.message)
                  })
                },
              }, h(IconPlusOutline16))),
            open ? h(ChatList, { ctx, character: group.name, currentSession, group: true }) : null)
        }),
        state.navigationStatus ? h('span', { className: 'dt-sidebar-status' }, state.navigationStatus) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    function SidebarAdapter({ useSessions }) {
      const host = useSidebarHost()
      const state = useTavernStore()
      const sessionIds = useSessions((value) => value.ids)
      const sessionPhase = useSessions((value) => value.phase)
      const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})
      const [floating, setFloating] = useState(false)
      useEffect(() => {
        if (sessionPhase !== 'ready') return
        if (bindingIds.every((sessionId) => sessionIds.includes(sessionId))) return
        void api('bindings/prune', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionIds }),
        }).then((result) => update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })).catch(() => {})
      }, [sessionPhase, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      useEffect(() => {
        const toggle = () => setFloating((value) => !value)
        window.addEventListener('dsh-tavern:toggle-sidebar', toggle)
        return () => window.removeEventListener('dsh-tavern:toggle-sidebar', toggle)
      }, [])
      const context = SidebarAdapter.context
      return h(React.Fragment, null,
        host ? createPortal(h(TavernSidebar, { ctx: context, useSessions }), host) : null,
        floating ? h('div', { className: 'dt-floating-shell' },
          h(TavernSidebar, { ctx: context, useSessions, floating: true, onClose: () => setFloating(false) })) : null)
    }

    function SidebarFooterAction({ wide }) {
      const state = useTavernStore()
      const t = useTranslate()
      if (state.sidebarAttached) return null
      return h('button', {
        type: 'button',
        className: 'dt-footer-action',
        title: t('nav.title'),
        'aria-label': t('nav.open'),
        onClick: () => window.dispatchEvent(new CustomEvent('dsh-tavern:toggle-sidebar')),
      }, h(IconUserOutline16), wide ? h('span', null, t('nav.title')) : null)
    }

    function installStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-tavern'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = `
        .dt-settings{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:0;min-height:100%;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings h2{font-size:20px;line-height:28px;margin:0;font-weight:600}.dt-settings-heading p{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:4px 0 0}.dt-settings-version{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:2px 0 0;user-select:text}.dt-settings-band{padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings-band h3{font-size:14px;line-height:20px;margin:0 0 14px;font-weight:600}.dt-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}.dt-field{display:flex;flex-direction:column;gap:6px}.dt-label{color:var(--dsw-alias-label-secondary);font-size:12px}.dt-field select{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-toggle,.dt-check-grid label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}.dt-toggle{min-height:36px}.dt-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}.dt-imports{display:flex;gap:8px;flex-wrap:wrap}.dt-upload{position:relative;cursor:pointer;height:34px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:13px}.dt-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}.dt-upload-error{color:var(--dsw-alias-state-error-primary);margin-left:5px}.dt-error,.dt-run-error,.dt-sidebar-error{color:var(--dsw-alias-state-error-primary)}.dt-muted{color:var(--dsw-alias-label-tertiary)}
        .dt-view{box-sizing:border-box;width:100%;max-width:780px;margin:0 auto;display:flex;flex-direction:column;min-height:100%;padding:8px 16px 28px;color:var(--dsw-alias-label-primary);letter-spacing:0}.dt-empty{min-height:300px;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px}.dt-scene-strip{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:9px;min-height:48px;padding:8px 4px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-scene-strip>img{width:32px;height:32px;border-radius:6px;object-fit:cover}.dt-scene-strip>div{display:flex;flex-direction:column;min-width:0;flex:1}.dt-scene-strip strong{font-size:13px;line-height:18px}.dt-scene-strip span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-scene-strip button,.dt-message-actions button,.dt-header-character button,.dt-sidebar button,.dt-footer-action{color:inherit;background:transparent;border:0;cursor:pointer}.dt-scene-strip button{width:30px;height:30px;display:grid;place-items:center;border-radius:6px}.dt-scene-strip button:hover,.dt-message-actions button:hover,.dt-header-character button:hover,.dt-sidebar button:hover,.dt-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-view button:disabled,.dt-composer button:disabled,.dt-sidebar button:disabled{cursor:not-allowed;opacity:.45}.dt-transcript{display:flex;flex-direction:column;gap:22px;padding:22px 4px}.dt-message{display:flex;gap:10px;max-width:88%;min-width:0}.dt-message-user{align-self:flex-end}.dt-message-character{align-self:flex-start}.dt-message-avatar{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none}.dt-message-body{display:flex;flex-direction:column;gap:4px;min-width:0}.dt-message-user .dt-message-body{align-items:flex-end}.dt-message-name{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-message-copy{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-raised,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2)}.dt-message-user .dt-message-copy{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-base))}.dt-message-actions{display:flex;align-items:center;gap:4px;min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dt-message-actions button{min-width:24px;height:24px;border-radius:5px;display:inline-grid;place-items:center;padding:0 5px}.dt-message-edit{box-sizing:border-box;width:min(620px,70vw);max-width:100%;min-height:100px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:9px;font:inherit;line-height:1.55}.dt-transcript-end{height:1px;flex:none}.dt-message-error{max-width:620px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.dt-run-error{padding:7px 12px;font-size:12px}
        .dt-composer-wrap{box-sizing:border-box;width:100%;padding:6px var(--dsh-composer-side-clearance,16px) 14px;pointer-events:auto}.dt-composer{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);padding:10px 10px 8px;box-shadow:0 2px 10px rgba(0,0,0,.06)}.dt-composer textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:200px;resize:vertical;border:0;outline:0;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:14px;line-height:1.5}.dt-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;font-size:11px}.dt-composer-row>span{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-composer-actions{display:flex;align-items:center;gap:8px;flex:none}.dt-primary-icon{width:30px;height:30px;border:0;border-radius:7px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;cursor:pointer}.dt-header-character{height:28px;display:flex;align-items:center;gap:6px;padding:0 4px 0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px}.dt-header-character>img{width:20px;height:20px;border-radius:4px;object-fit:cover}.dt-header-character>span{max-width:100px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-header-character>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center}
        .dt-model-select{min-width:0;position:relative}.dt-model-trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.dt-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dt-model-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.dt-model-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-trigger-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.dt-model-trigger-effort{color:var(--dsw-alias-label-caption);flex:none}.dt-model-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.dt-model-chevron-open{transform:rotate(180deg)}.dt-model-menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(240px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.dt-model-status,.dt-model-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.dt-model-error,.dt-model-warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}.dt-model-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.dt-model-retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.dt-model-groups{min-height:0;overflow-y:auto}.dt-model-group+.dt-model-group{margin-top:4px}.dt-model-group-title{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.dt-model-option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.dt-model-option:hover:not(:disabled),.dt-model-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-option-copy{flex-direction:column;flex:1;min-width:0;display:flex}.dt-model-name{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.dt-model-description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.dt-model-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.dt-model-cell{width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}.dt-model-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-cell-label{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.dt-model-cell-value{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:0 auto;overflow:hidden}.dt-model-cell-chevron{color:var(--dsw-alias-label-tertiary);flex:none}
        [data-dsh-tavern-sidebar-host]{flex:none;margin:0 0 6px;padding-right:var(--dsh-session-list-edge-inset,8px)}.dt-sidebar{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-sidebar-heading{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 5px;color:var(--dsw-alias-label-secondary)}.dt-sidebar-heading>span{display:flex;align-items:center;gap:6px;font-size:12px}.dt-sidebar-heading>button{width:26px;height:26px;border-radius:6px}.dt-character-group{margin-top:2px}.dt-character-row{display:flex;align-items:center;gap:2px}.dt-character-toggle{height:32px;min-width:0;flex:1;display:flex;align-items:center;gap:5px;border-radius:6px;padding:0 5px;text-align:left}.dt-character-toggle svg{transform:rotate(-90deg);transition:transform .15s}.dt-character-toggle svg.dt-chevron-open{transform:rotate(0)}.dt-character-toggle img{width:22px;height:22px;border-radius:5px;object-fit:cover}.dt-character-toggle span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dt-character-row>button:last-child{width:28px;height:28px;display:grid;place-items:center;border-radius:6px;flex:none}.dt-sidebar-chats{display:flex;flex-direction:column;margin:1px 0 4px 28px}.dt-sidebar-chat-row{height:28px;border-radius:6px;display:grid;grid-template-columns:minmax(0,1fr) 26px 26px;align-items:center;color:var(--dsw-alias-label-secondary)}.dt-sidebar-chat-open{height:28px;min-width:0;text-align:left;padding:0 7px;color:inherit;font-size:12px}.dt-sidebar-chat-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){width:26px;height:26px;display:grid;place-items:center;border-radius:5px;opacity:0}.dt-sidebar-chat-row:hover>button:not(.dt-sidebar-chat-open),.dt-sidebar-chat-row:focus-within>button:not(.dt-sidebar-chat-open){opacity:1}.dt-sidebar-chat-row.dt-sidebar-chat-active{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.dt-sidebar-status,.dt-sidebar-error{padding:4px 7px;font-size:11px;line-height:16px}.dt-floating-shell{position:fixed;z-index:2147400000;inset:64px auto 24px 12px;width:min(310px,calc(100vw - 24px));pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px rgba(0,0,0,.2);overflow:auto;padding:8px}.dt-footer-action{height:32px;display:flex;align-items:center;gap:7px;border-radius:6px;padding:0 7px}.dt-footer-action span{font-size:12px}
        @media(max-width:700px){[role="dialog"]:has(.dt-settings){flex-direction:column}[role="dialog"]:has(.dt-settings)>nav{box-sizing:border-box;width:100%;height:auto;max-height:190px;flex:none;overflow-y:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}[role="dialog"]:has(.dt-settings)>nav>:last-child{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:auto}[role="dialog"]:has(.dt-settings)>nav>:last-child>button{width:100%;min-width:0}[role="dialog"]:has(.dt-settings)>:not(nav){width:100%;min-width:0;flex:1}.dt-settings-heading{padding:16px}.dt-settings-band{padding:16px}.dt-settings-grid,.dt-check-grid{grid-template-columns:1fr}.dt-view{padding-inline:10px}.dt-transcript-end{height:132px}.dt-message{max-width:94%}.dt-scene-strip{top:0}.dt-header-character>span{display:none}.dt-composer-wrap{padding-inline:8px}.dt-model-trigger{max-width:140px}.dt-message-edit{width:78vw}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){opacity:1}}
        .dt-persona-list{display:flex;flex-direction:column;gap:6px}.dt-persona-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dt-persona-avatar{width:34px;height:34px;border-radius:6px;object-fit:cover;flex:none}.dt-persona-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.dt-persona-copy span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-persona-actions{display:flex;gap:2px}.dt-persona-actions button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-persona-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-group-create{display:flex;flex-direction:column;gap:8px;margin:10px 0;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}.dt-group-list{display:flex;flex-direction:column;gap:12px}.dt-group-manage{display:flex;flex-direction:column;gap:6px}.dt-group-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dt-group-title>span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dt-group-title select{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-base);padding:0 6px}.dt-group-title>button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-group-members{display:flex;flex-wrap:wrap;gap:6px}
        .dt-member-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px 0 3px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:inherit;font-size:12px;cursor:pointer}.dt-member-chip>img{width:22px;height:22px;border-radius:50%;object-fit:cover}.dt-member-chip-off{opacity:.45}.dt-member-chip-off>span{text-decoration:line-through}.dt-member-chip-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.dt-member-chip>button{color:inherit;background:transparent;border:0;cursor:pointer;padding:0 2px;font-size:11px}
        .dt-regex-list{display:flex;flex-direction:column;gap:6px}.dt-regex-row{display:flex;align-items:center;gap:10px;min-height:36px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dt-regex-row.dt-regex-off{opacity:.5}.dt-regex-row>.dt-toggle{flex:1;min-width:0}.dt-regex-row>.dt-muted{font-family:monospace;font-size:11px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-regex-row>button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}
        .dt-field input[type=text],.dt-field input[type=password]{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-upload:disabled{opacity:.5;cursor:not-allowed}
        .dt-backlink{display:flex;padding:2px 0}.dt-backlink>button{color:var(--dsw-alias-label-tertiary);background:transparent;border:0;cursor:pointer;font-size:12px;padding:4px 2px}.dt-backlink>button:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
        .dt-member-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.dt-member-row .dt-member-chip>button{display:none}.dt-script-glyph{font-weight:700;font-size:15px;line-height:1}.dt-sidebar-subheading{margin-top:10px}.dt-branch-btn{font-size:13px}
        .dt-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0 0 12px}.dt-hint-wide{grid-column:1 / -1;margin:0 0 12px}
      `
      document.head.appendChild(tag)
    }

    function apply(ctx) {
      installStyle()
      SidebarAdapter.context = ctx
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }), 'dsh-tavern: locale dictionaries')
      translate = ctx.locale.bind(LOCALE_NS)
      subscribeLocale = (listener) => ctx.locale.subscribe(listener)
      getLocaleRevision = () => ctx.locale.getSnapshot()
      void refreshBootstrap().catch(() => {})
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-tavern',
        order: 45,
        label: () => 'dsh-tavern',
        inject: () => ({}),
      }, TavernSettings))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'tavern',
        order: 20,
        label: () => translate('nav.title'),
        inject: () => ({}),
      }, TavernView))
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -20,
        select: selectTavernComposer,
        inject: () => ({}),
      }, TavernComposer))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'dsh-tavern',
        order: -5,
        inject: () => ({}),
      }, TavernHeaderAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-tavern-sidebar-adapter',
        order: 20,
        inject: () => ({}),
      }, SidebarAdapter))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-tavern-fallback',
        order: 20,
        inject: () => ({}),
      }, SidebarFooterAction))
    }

    exports.name = 'dsh-tavern'
    exports.inject = ['slots', 'sessions', 'workspaces', 'locale']
    exports.apply = apply
    return module.exports
  },
})
