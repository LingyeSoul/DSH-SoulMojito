/**
 * 酒馆助手兼容层与自动展开开关的客户端源码检查（2026-10-20）：iframe 侧
 * shim 的 TavernHelper 面、宿主侧代理的 token/绑定纪律、事件广播数据源，
 * 以及「自动展开 tab」必须由设置开关门控（默认关闭、无开关时不轮询）。
 * 复用 games-client.spec.ts 的 main.js source-check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildIframeScript } from '../../tavern-jsr/src/client.js'
import { iframeSources } from '../../tavern-frontend-storage/src/client.js'
import { HELPER_CHANNELS, IFRAME_EVENTS, TAVERN_EVENTS } from '../../tavern-jsr/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
// The runtime and virtual storage now live in workspace packages that the build
// inlines into client/index.js; main.js only carries the fragments and slots.
const source = readFileSync(join(here, '../client/index.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')
const store = readFileSync(join(here, '../../tavern-store/src/store.ts'), 'utf8')
const compatDoc = readFileSync(join(here, '../../../docs/frontend/tavern-helper-compat.md'), 'utf8')

describe('TavernHelper compatibility layer (main.js source check)', () => {
  it('defines the iframe-side TavernHelper surface', () => {
    expect(HELPER_CHANNELS).toEqual({
      message: 'dsh-soulmojito:helper',
      result: 'dsh-soulmojito:helper-result',
      snapshot: 'dsh-soulmojito:helper-snapshot',
      event: 'dsh-soulmojito:helper-event',
    })
    for (const marker of [
      'const HELPER_MESSAGE = DshJsrRuntime.HELPER_MESSAGE',
      'const HELPER_RESULT_MESSAGE = DshJsrRuntime.HELPER_RESULT_MESSAGE',
      'const HELPER_SNAPSHOT_MESSAGE = DshJsrRuntime.HELPER_SNAPSHOT_MESSAGE',
      'function frontendHelperScript(token, messageId, storage, identity)',
      'window.getVariables = function',
      'window.getAllVariables = function',
      'window.Mvu.getAllVariables = window.getAllVariables',
      'window.replaceVariables = function',
      'window.updateVariablesWith = function',
      'window.insertOrAssignVariables = function',
      'window.deleteVariable = function',
      'window.getChatMessages = function',
      'window.setChatMessages = function',
      'window.createChatMessages = function',
      'window.deleteChatMessages = function',
      'window.eventOn = function',
      'window.tavern_events =',
      'window.SillyTavern = {',
      'saveChat: function () { return Promise.resolve(); }',
      'saveSettingsDebounced: function () {}',
      'get extensionSettings() { return window.__dshTavernExtensionSettings; }',
      'ToolManager: {',
      'Function: window.Function',
      'get: function (target, property) {',
      'loadWorldInfo: function (name) {',
      'window.YAML.parseDocument',
      'window.getCurrentMessageId = function',
      'window.Mvu = {',
      'getMvuData: function',
      'replaceMvuData: function',
      'window.toastr = {',
      'window.getCharWorldbookNames = function',
      'window.updateWorldbookWith = function',
      'window.getScriptTrees = function',
      'window.updateScriptTreesWith = function',
      'publishZodReady',
      'var documentFacade =',
      'window.__dshTavernHost = host',
      'window.__dshTavernStorage',
      'window.__dshTavernSessionStorage',
      "call('mvu.replace'",
      "call('composer.fill'",
      "call('composer.send'",
      'pendingTriggerRef',
      "String(data.payload?.command ?? '') === '/trigger'",
      'const handOffUserFloor = async (text) =>',
      'handOffTriggeredSlash(result.value)',
      "value.triggerRequested !== true",
      'await conversation.send(text)',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('ships the JSR library globals and generation bridge', () => {
    // JSR card frontends expect Vue/Vue Router/Zod globals before their bundle
    // runs. 示例卡2 is a Vue SFC bundle with `module.exports = Vue`; 示例卡3's
    // mvu_zod.js reads `z.z` and `z.object`.
    expect(source).toContain("https://cdn.jsdelivr.net/npm/vue@3.5.40/dist/vue.runtime.global.prod.min.js")
    expect(source).toContain("https://cdn.jsdelivr.net/npm/vue-router@4.6.4/dist/vue-router.global.prod.min.js")
    expect(source).toContain("https://cdn.jsdelivr.net/npm/zod@4.4.3/+esm")
    expect(source).toContain("https://cdn.jsdelivr.net/npm/yamljs@0.3.0/dist/yaml.min.js")
    expect(source).toContain('window.z = z')
    // 示例卡3's runtime connector hard-gates on TavernHelper.generate; the shim
    // proxies the card-owned API through the host (never the other way around).
    for (const marker of [
      'window.generate = function (config)',
      "call('generate', { config: request })",
      'window.getModelList = function (customApi)',
      "call('models', { apiurl: config.apiurl, key: config.key })",
      'generate: window.generate,',
      'getModelList: window.getModelList,',
      'window.getCharData = function (name)',
      "data: clone(data)",
      'window.getPreset = function (name)',
      'window.getLoadedPresetName = function () { return activePresetName(); };',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('restores the card-facing audio / error / input surface', () => {
    for (const marker of [
      'window.errorCatched = function (fn)',
      'window.playAudio = function (type, audio)',
      'window.pauseAudio = function (type)',
      'window.getCurrentAudio = function (type)',
      "element.play()",
      "getBoundingClientRect: function ()",
      "if (id === 'send_textarea') return fakeTextarea;",
      "if (id === 'send_but') return fakeSendButton;",
    ]) {
      expect(source).toContain(marker)
    }
    // The runtime source lives in the JSR package; the fragment only assembles
    // the per-iframe arguments and the storage seed.
    expect(source).toContain('DshJsrRuntime.buildIframeScript(')
    expect(source).toContain('DshFrontendStorage.serializeFrontendStorageSeed(storage)')
  })

  it('seeds and persists the sandbox localStorage through the host', () => {
    expect(source).toContain('function serializeFrontendStorageSeed(storage)')
    expect(source).toContain('function loadFrontendStorage(character)')
    expect(source).toContain("api(`frontend/storage?character=${encodeURIComponent(character)}`)")
    expect(source).toContain('createMemoryStorage(initialStorage, true)')
    expect(source).toContain("call('storage.set', { storage: Object.assign({}, data) })")
    expect(source).toContain("if (data.op === 'storage.set') frontendStorageCache.delete(current.character)")
    expect(source).toContain('storageSeed === null')
    expect(source).toContain('font-src data: blob: https:')
  })

  it('ships the virtual IndexedDB bridge and binary routes', () => {
    for (const marker of [
      'function IdbDatabase(name)',
      'IdbDatabase.prototype.createObjectStore',
      'IdbDatabase.prototype.transaction',
      'IdbObjectStore.prototype.get = function (key)',
      'IdbObjectStore.prototype.put = function (value)',
      "call('idb.put', { db: tx.db.name, store: this.name, key: key, meta: meta, bytes: bytes }, [bytes])",
      "call('idb.get', { db: tx.db.name, store: this.name, key: key })",
      "Object.defineProperty(window, 'indexedDB'",
      'DshFrontendStorage.isIdbBridgeOp(data.op)',
      'DshFrontendStorage.handleIdbBridge(data.op, payload, current.character, API, fetch)',
      'frontend/idb/get',
      'frontend/idb/put',
    ]) {
      expect(source).toContain(marker)
    }
    expect(compatDoc).toContain('虚拟 IndexedDB')
    expect(compatDoc).toContain('frontend/idb/put|get')
  })

  it('documents the new JSR compatibility surface', () => {
    for (const name of [
      'generate', 'getModelList', 'getCharData', 'getPreset', 'getLoadedPresetName',
      'errorCatched', 'playAudio', 'pauseAudio', 'getAudioSettings', 'setAudioSettings',
      'getScriptButtons', 'replaceScriptButtons',
    ]) {
      expect(compatDoc).toContain(`\`${name}`)
    }
    for (const marker of ['Vue 3.5.40', 'vue-router 4.6.4', 'Zod 4.4.3', 'frontend/storage']) {
      expect(compatDoc).toContain(marker)
    }
  })

  it('keeps the sandbox and proxies through the host binding', () => {
    expect(source).toContain("sandbox: 'allow-scripts allow-modals allow-forms'")
    expect(source).toContain("connect-src blob:")
    expect(source).toContain("form-action 'self' about: blob:")
    expect(source).toContain('function useHelperBridge(frameRef, token, binding, refreshKey, hostSessionId, manualHeightRef, onScriptButtons)')
    expect(source).toContain("if (event.source !== frameRef.current?.contentWindow) return")
    expect(source).toContain("data.token !== token")
    expect(source).toContain('this frontend is not bound to a Tavern chat')
    expect(source).toContain('window.__dshTavernHost')
    expect(source).toContain('composer.fill')
    expect(source).toContain('composer.send')
    // 绑定只能来自宿主侧 sessionBindings，iframe 报什么都不能改身份
    expect(source).toContain("op: data.op,\n              character: current.character,\n              chatId: current.chatId")
  })

  it('recovers the first-frame snapshot when the mount push is lost', () => {
    // iframe shim 在 srcdoc 解析后主动拉一次；宿主在 iframe load 后再推一次。
    // 两条路径互补：外链 CDN 推迟 shim 执行时，挂载推送会先于监听器而丢失。
    expect(source).toContain("call('snapshot')")
    expect(source).toContain('const onFrameLoad = () => postSnapshot()')
    expect(source).toContain("frame?.addEventListener('load', onFrameLoad)")
    expect(source).toContain('initial snapshot failed')
  })

  it('forwards frameElement style writes so cards can collapse themselves', () => {
    // ST 同源里卡用 window.frameElement.style 隐藏/撑高自己的 iframe；沙箱里
    // frameElement 是 null，卡隐藏时宿主会留一块 120px 白块。shim 转 frame.prefs。
    expect(source).toContain("Object.defineProperty(window, 'frameElement'")
    expect(source).toContain("call('frame.prefs'")
    expect(source).toContain('function applyFramePrefs(frame, prefs, manualHeight)')
    expect(source).toContain("if (data.op === 'frame.prefs')")
  })

  it('routes AgentTavern composer sends through the host conversation service', () => {
    // 原生 composer 是 Lexical contenteditable，不是 textarea；自动发送走宿主
    // conversation.send（与插件插入消息同一条 admission），DOM 只做草稿展示。
    expect(source).toContain('function hostConversation(hostSessionId)')
    expect(source).toContain('sessions?.scope?.(hostSessionId)')
    expect(source).toContain("scoped?.get?.('conversation')")
    expect(source).toContain('await conversation.send(text)')
    expect(source).toContain('[data-composer-input][contenteditable="true"]')
    expect(source).toContain("const composerChainRef = useRef(Promise.resolve())")
  })

  it('exposes the session world-book and script-tree shims for GM panels', () => {
    // getCharWorldbookNames 必须同步（GM 脚本不 await），名字回落内嵌书名。
    expect(source).toContain("window.getCharWorldbookNames = function () {")
    expect(source).toContain("var embedded = data.characterBook && typeof data.characterBook.name === 'string'")
    // updateWorldbookWith 在 iframe 内跑 updater，只把 entries 发到会话副本。
    expect(source).toContain("call('lorebook.put', { name: name, entries: entries })")
    expect(source).toContain("window.TavernHelper[surfaceName] = window[surfaceName]")
    // 脚本树读写会话副本：seed 优先副本，改写先 scripts.put 再发布 mg-zod-ready。
    expect(source).toContain('var scriptTrees = null')
    expect(source).toContain('if (Array.isArray(state.scriptTrees)) return clone(state.scriptTrees);')
    expect(source).toContain("__mgZodReady__")
    expect(source).toContain("'mg-zod-ready'")
    expect(source).toContain('HELPER_SURFACE.length')
  })

  it('gives floating panels a real document facade through window.top', () => {
    // GM 面板用 `hud_win = window.top; hud_doc = hud_win.document`，旧 stub
    // （body:null、无 getElementById）会在 appendChild 处崩掉。
    for (const marker of [
      'var documentFacade =',
      "if (id === 'send_textarea') return fakeTextarea;",
      "if (id === 'send_but') return fakeSendButton;",
      'get head() { return document.head; }',
      'get body() { return document.body; }',
      'get documentElement() { return document.documentElement; }',
      'get activeElement() { return document.activeElement; }',
      "document: documentFacade",
      'get innerWidth() { return window.innerWidth; }',
      'get innerHeight() { return window.innerHeight; }',
      'get devicePixelRatio() { return window.devicePixelRatio; }',
      'get visualViewport() { return window.visualViewport; }',
      'matchMedia: function (query) { return window.matchMedia(query); }',
      'requestAnimationFrame: function (callback) { return window.requestAnimationFrame(callback); }',
    ]) {
      expect(source).toContain(marker)
    }
    // 真实 parent.postMessage 通道不变
    expect(source).toContain('var realParent = window.parent;')
    expect(source).toContain('postMessage: function () { return realParent.postMessage.apply(realParent, arguments); }')
  })

  it('reports MVU write failures and re-posts the snapshot after mvu.replace', () => {
    expect(source).toContain("showToast('error', '变量写入失败: '")
    expect(source).toContain("data.op === 'slash' || data.op === 'mvu.replace'")
  })

  it('shows a generation status notice and no disabled-button toast', () => {
    // The disabled-button hint was noise: cards already render their own
    // unavailable state. Generate requests get a persistent, informative notice.
    expect(source).not.toContain('该按钮当前不可用')
    expect(source).not.toContain('noteDisabledControl')
    expect(source).toContain('SoulMojito正在处理生成请求')
    expect(source).toContain("模型: ' + generationModel(config)")
    expect(source).toContain('SoulMojito 生成完成')
    expect(source).toContain('SoulMojito 生成失败')
  })

  it('persists the session script tree through scripts.put before publishing ready', () => {
    // state/applySnapshot：宿主 snapshot 带回会话副本
    expect(source).toContain('scriptTrees: null,')
    expect(source).toContain('state.scriptTrees = Array.isArray(snapshot.scriptTrees) ? snapshot.scriptTrees : null;')
    // seed 优先副本，并保留 folder / 未知字段（不再只重建 script 节点）
    expect(source).toContain('if (Array.isArray(state.scriptTrees)) return clone(state.scriptTrees);')
    expect(source).toContain('if (!node || typeof node !== \'object\' || Array.isArray(node)) continue;')
    expect(source).toContain('var scriptTreesLocallyWritten = false;')
    // 先落盘，成功后才更新内存并发布 mg-zod-ready
    const updateStart = source.indexOf('window.updateScriptTreesWith = function (updater, option) {')
    const persistStart = source.indexOf('function persistScriptTrees(type, trees) {')
    const putIndex = source.indexOf("call('scripts.put', { type: type, scriptTrees: trees })", persistStart)
    const publishIndex = source.indexOf('publishZodReady(stored);', putIndex)
    expect(updateStart).toBeGreaterThanOrEqual(0)
    expect(persistStart).toBeGreaterThanOrEqual(0)
    expect(putIndex).toBeGreaterThan(persistStart)
    expect(publishIndex).toBeGreaterThan(putIndex)
    expect(source.slice(putIndex, publishIndex)).toContain("scriptTreesLocallyWritten = true;")
  })

  it('keeps the generated iframe shim syntactically valid', () => {
    const body = buildIframeScript('probe-token', 1, JSON.stringify({ theme: 'dark' }), iframeSources(), null)
    expect(() => new Function(body)).not.toThrow()
  })

  it('broadcasts only signals the host can actually observe', () => {
    expect(source).toContain('const HELPER_TAVERN_EVENTS = DshJsrRuntime.TAVERN_EVENTS')
    expect(source).toContain('const HELPER_IFRAME_EVENTS = DshJsrRuntime.IFRAME_EVENTS')
    expect(source).toContain('HELPER_TAVERN_EVENTS.MESSAGE_RECEIVED')
    expect(source).toContain('HELPER_TAVERN_EVENTS.MESSAGE_EDITED')
    expect(source).toContain('HELPER_TAVERN_EVENTS.CHAT_CHANGED')
    expect(source).toContain('HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED')
    expect(source).toContain('const HELPER_EVENT_MESSAGE = DshJsrRuntime.HELPER_EVENT_MESSAGE')
    expect(TAVERN_EVENTS.CHAT_CHANGED).toBe('chat_id_changed')
    expect(IFRAME_EVENTS.GENERATION_ENDED).toBe('js_generation_ended')
  })

  it('gates auto-open behind the frontendAutoOpen setting', () => {
    expect(source).toContain('function useFrontendAutoOpen(sessionId, binding, architecture, enabled)')
    expect(source).toContain("if (!enabled || !binding || architecture !== 'agent-tavern') return undefined")
    expect(source).toContain('useFrontendAutoOpen(sessionId, binding, architecture, state.bootstrap.state.frontendAutoOpen === true)')
    expect(source).toContain('checked: bootstrap.state.frontendAutoOpen === true')
    expect(store).toContain('frontendAutoOpen: boolean')
    expect(store).toContain('frontendAutoOpen: false')
    expect(store).toContain('frontendAutoOpen: parsed.frontendAutoOpen === true')
  })

  it('ships the setting label in both dictionaries', () => {
    expect(zh).toContain("'settings.frontendAutoOpen'")
    expect(en).toContain("'settings.frontendAutoOpen'")
  })

  it('gates external frontend resources behind the frontendAllowExternalResources setting', () => {
    expect(source).toContain('function frontendContentSecurityPolicy(allowExternalResources)')
    expect(source).toContain("connect-src https: blob:")
    expect(source).toContain('useFrontendAllowExternalResources()')
    expect(source).toContain('checked: bootstrap.state.frontendAllowExternalResources === true')
    expect(store).toContain('frontendAllowExternalResources: boolean')
    expect(store).toContain('frontendAllowExternalResources: false')
    expect(store).toContain('frontendAllowExternalResources: parsed.frontendAllowExternalResources === true')
    expect(zh).toContain("'settings.frontendAllowExternalResources'")
    expect(en).toContain("'settings.frontendAllowExternalResources'")
    expect(zh).toContain("'settings.frontendAllowExternalResourcesHint'")
    expect(en).toContain("'settings.frontendAllowExternalResourcesHint'")
  })

  it('documents every exported helper with an availability verdict', () => {
    // 文档必须覆盖实现的每个出口：加函数不改文档 = 文档立刻过期。
    const exported = [
      'getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables',
      'insertVariables', 'deleteVariable', 'getChatMessages', 'getLastMessageId', 'getCurrentMessageId',
      'setChatMessages', 'createChatMessages', 'deleteChatMessages', 'eventOn', 'eventOnce',
      'eventEmit', 'eventEmitAndWait', 'eventMakeFirst', 'eventMakeLast',
      'eventRemoveListener', 'eventClearEvent', 'eventClearListener', 'eventClearAll',
      'getLorebook', 'getWorldbook', 'getLorebookNames', 'getWorldbookNames',
      'getGlobalWorldbookNames', 'getCharNames', 'getCharacterNames',
      'getChatWorldbookNames', 'getTavernRegexes', 'formatAsTavernRegexedString',
      'getCharWorldbookNames', 'updateWorldbookWith', 'getScriptTrees', 'updateScriptTreesWith',
      'triggerSlash', 'substitudeMacros', 'getTavernHelperVersion', 'getTavernVersion',
      'getButtonEvent', 'getScriptId', 'waitGlobalInitialized',
      'generate', 'generateRaw', 'getModelList', 'stopGenerationById', 'stopAllGeneration',
      'getCharData', 'getPreset', 'replacePreset', 'getPresetNames', 'getLoadedPresetName',
      'getScriptButtons', 'replaceScriptButtons', 'updateScriptButtonsWith', 'appendInexistentScriptButtons',
      'errorCatched', 'playAudio', 'pauseAudio', 'getAudioList', 'replaceAudioList',
      'appendAudioList', 'getAudioSettings', 'setAudioSettings', 'getCurrentAudio',
    ]
    for (const name of exported) {
      expect(source).toContain(`window.${name}`)
      expect(compatDoc).toContain(`\`${name}`)
    }
    // 文档必须同时给出可用与不可用的判定，不能只写好消息。
    for (const verdict of ['✅', '⚠️', '❌', '🧱']) expect(compatDoc).toContain(verdict)
    // 结构性不可用的三件事必须点明。
    for (const blocked of ['connect-src', 'frame-src', 'allow-same-origin']) expect(compatDoc).toContain(blocked)
  })

  it('documents that only observable events fire, with the exact set', () => {
    for (const event of [
      'app_ready', 'message_sent', 'message_received', 'message_edited',
      'message_deleted', 'chat_id_changed', 'message_iframe_render_started',
      'message_iframe_render_ended',
    ]) {
      expect(compatDoc).toContain(event)
    }
    expect(compatDoc).toContain('只有上表列出的会被触发')
  })
})
