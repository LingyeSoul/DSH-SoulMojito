/**
 * TavernHelper iframe runtime source.
 *
 * The runtime is emitted as source text because the card frontend lives in a
 * sandboxed srcdoc iframe: the host page cannot import modules into it and the
 * iframe CSP forbids eval. Everything the runtime needs is interpolated here,
 * so the emitted program is self-contained except for browser globals.
 *
 * Storage shims are injected by the caller as source text (see
 * @dsh-soulmojito/frontend-storage); this module stays free of storage policy.
 */
import {
  HELPER_BUTTONS_MESSAGE,
  HELPER_EVENT_MESSAGE,
  HELPER_EXTENSION_ID,
  HELPER_LIBRARIES,
  HELPER_MESSAGE,
  HELPER_RESULT_MESSAGE,
  HELPER_SNAPSHOT_MESSAGE,
  HELPER_VERSION,
  HELPER_ZOD_MODULE,
  IFRAME_EVENTS,
  TAVERN_EVENTS,
  TAVERN_HELPER_SURFACE,
  TAVERN_VERSION,
} from './index.js'

// The plugin fragment consumes the channel/event names from the IIFE; keep them
// on the client entry so the browser bundle is self-describing.
export {
  HELPER_BUTTONS_MESSAGE,
  HELPER_EVENT_MESSAGE,
  HELPER_EXTENSION_ID,
  HELPER_MESSAGE,
  HELPER_RESULT_MESSAGE,
  HELPER_SNAPSHOT_MESSAGE,
  HELPER_VERSION,
  IFRAME_EVENTS,
  TAVERN_EVENTS,
  TAVERN_HELPER_SURFACE,
  TAVERN_VERSION,
} from './index.js'

// The emitted runtime keeps the historical names so card-facing source stays
// readable and existing marker checks keep their meaning.
const HELPER_TAVERN_EVENTS = TAVERN_EVENTS
const HELPER_IFRAME_EVENTS = IFRAME_EVENTS

export interface FrontendStorageIframeSources {
  localStorage: string
  indexedDb: string
}

/**
 * Script-container identity. Message frontends pass `null`; the script
 * container passes the node's id/name/info so `getScriptId`/`getScriptInfo`
 * observe the same values JSR exposes inside a script iframe.
 */
export interface IframeScriptIdentity {
  scriptId: string
  scriptName: string
  scriptInfo: string
}

/** Script tags for the JSR globals (lodash, jQuery, showdown, Vue, Vue Router, Zod). */
export function helperLibraryTags(): string {
  return HELPER_LIBRARIES.map((url) => `<script src="${url}" crossorigin="anonymous"></script>`).join('')
    + HELPER_ZOD_MODULE
}

/**
 * Build the self-contained iframe prelude.
 *
 * @param storageSeedJson serialized `Record<string, string>`; callers must use
 *   the storage package serializer so `<` and U+2028/U+2029 cannot break the
 *   surrounding srcdoc script.
 * @param identity script-container identity, or `null` for message frontends.
 */
export function buildIframeScript(
  token: string,
  messageId: number,
  storageSeedJson: string,
  storageSources: FrontendStorageIframeSources,
  identity: IframeScriptIdentity | null,
): string {
  return `(function () {
  var token = ${JSON.stringify(token)};
  var currentMessageId = ${JSON.stringify(typeof messageId === 'number' ? messageId : -1)};
  var initialStorage = ${storageSeedJson};
  var scriptIdentity = ${JSON.stringify(identity)};
  var scriptId = scriptIdentity !== null && typeof scriptIdentity === 'object' ? String(scriptIdentity.scriptId || '') : '';
  var scriptName = scriptIdentity !== null && typeof scriptIdentity === 'object' ? String(scriptIdentity.scriptName || '') : '';
  var scriptInfo = scriptIdentity !== null && typeof scriptIdentity === 'object' ? String(scriptIdentity.scriptInfo || '') : '';
  var realParent = window.parent;
  var requestId = 0;
  var pending = new Map();
  var listeners = new Map();
  var lastMvuStatJson = '';
  var HELPER_VERSION = ${JSON.stringify(HELPER_VERSION)};
  var TAVERN_VERSION = ${JSON.stringify(TAVERN_VERSION)};
  var HELPER_EXTENSION_ID = ${JSON.stringify(HELPER_EXTENSION_ID)};
  var HELPER_SURFACE = ${JSON.stringify(TAVERN_HELPER_SURFACE)};
  var HELPER_BUTTONS_MESSAGE = ${JSON.stringify(HELPER_BUTTONS_MESSAGE)};
  // The emitted program runs inside the iframe, so module-scope constants are
  // not in reach. Embed both event tables before any card code can call
  // window.generate() (the generation bridge emits CHAT_COMPLETION_SETTINGS_READY
  // synchronously, before the later window.tavern_events assignment).
  var HELPER_TAVERN_EVENTS = ${JSON.stringify(HELPER_TAVERN_EVENTS)};
  var HELPER_IFRAME_EVENTS = ${JSON.stringify(HELPER_IFRAME_EVENTS)};
  // JSR predefine.js sets these before card modules; Vue 3.5 runtime + Pinia read
  // them while mounting. The global production build normally hard-codes them,
  // but keeping the same observable window flags avoids version-specific warnings
  // and matches what card authors test against.
  window.__VUE_PROD_DEVTOOLS__ = true;
  window.__VUE_OPTIONS_API__ = true;
  window.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
  // MagVarUpdate (beta) reads a global 'YAML' at module load and calls
  // YAML.parse / YAML.stringify / YAML.parseDocument(...).toJS(). yamljs is
  // loaded as a classic script in HELPER_LIBRARIES; add the missing
  // parseDocument shape. When the CDN failed, keep a JSON fallback so the
  // framework can initialise instead of dying with a bare ReferenceError.
  if (!window.YAML) {
    window.YAML = {
      parse: function (text) {
        try { return JSON.parse(String(text)); }
        catch (_) { throw new Error('YAML library unavailable: only JSON input can be parsed in this iframe'); }
      },
      stringify: function (value) { return JSON.stringify(value, null, 2); }
    };
  }
  if (typeof window.YAML.parseDocument !== 'function') {
    window.YAML.parseDocument = function (text) {
      var value = window.YAML.parse(String(text));
      return { toJS: function () { return value; } };
    };
  }
  var state = {
    characterName: '', userName: 'User', chatId: '', chatMetadata: {},
    messages: [], variables: { global: {}, chat: {}, message: {}, character: {} },
    characterData: null,
    scriptTrees: null,
    // Extended snapshot (compat level 4.11): script-container trees per source,
    // observable preset/persona/character/regex/world metadata. Every field has
    // an empty default so an older host snapshot never leaves a getter throwing.
    scriptTreesByType: { character: null, preset: null, global: null },
    presets: { names: [], active: null, values: {} },
    personas: { names: [], ids: [], active: null, values: {} },
    characters: { names: [], ids: [] },
    regexScripts: { global: [], character: [], preset: [] },
    scriptVariables: {},
    worlds: { names: [], active: [], char: { primary: null, additional: [] }, chat: null },
    personaDescription: '',
    avatar: '',
    characterId: 0,
  };

  function call(op, payload, transfer) {
    return new Promise(function (resolve, reject) {
      var id = 'helper-' + (++requestId);
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ type: ${JSON.stringify(HELPER_MESSAGE)}, token: token, id: id, op: op, payload: payload || {} }, '*', Array.isArray(transfer) ? transfer : []);
    });
  }

  ${storageSources.localStorage}

  // window.frameElement 沙箱兜底（2026-10-21）：酒馆卡的自适应高度/折叠走
  // 「window.frameElement.style」（ST 同源可直接改 iframe）；sandbox 里该属性是
  // null，卡把自己隐藏时宿主 iframe 会留一块 120px 空白（白底）。这里给一个
  // 最小 shim：把 display/height 的写入转成「frame.prefs」，由宿主改真实 iframe。
  var framePrefs = { hidden: false, height: null };
  var framePrefsQueued = false;
  function flushFramePrefs() {
    framePrefsQueued = false;
    call('frame.prefs', framePrefs).catch(function (error) {
      console.error('[TavernHelper] frame prefs failed', error);
    });
  }
  function scheduleFramePrefs() {
    if (framePrefsQueued) return;
    framePrefsQueued = true;
    // 卡会连续 setProperty(display/height/margin/padding)；合并成一次 RPC。
    framePrefsTimer = setTimeout(flushFramePrefs, 0);
  }
  var frameElementShim = {
    id: '',
    tagName: 'IFRAME',
    nodeName: 'IFRAME',
    style: {
      setProperty: function (name, value) {
        var property = String(name);
        if (property === 'display') framePrefs.hidden = String(value) === 'none';
        else if (property === 'height') {
          var pixels = parseFloat(String(value));
          framePrefs.height = isFinite(pixels) ? pixels : null;
        }
        scheduleFramePrefs();
      },
      removeProperty: function (name) {
        var property = String(name);
        if (property === 'display') framePrefs.hidden = false;
        else if (property === 'height') framePrefs.height = null;
        scheduleFramePrefs();
      },
      getPropertyValue: function () { return ''; }
    },
    // 卡前端在首屏用 window.frameElement.getBoundingClientRect().width 做响应式
    // 测量（示例卡3 的 React 缩放 hook）。沙箱里 frameElement 原本是 null，只补
    // style 会在 useState 初始化时抛 TypeError。iframe 自己的视口就是宿主分配给
    // 它的矩形，返回这份本地几何即可，不需要异步 RPC。
    getBoundingClientRect: function () {
      var width = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
      var height = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width: width, height: height };
    },
    get clientWidth() { return typeof window.innerWidth === 'number' ? window.innerWidth : 0; },
    get clientHeight() { return typeof window.innerHeight === 'number' ? window.innerHeight : 0; },
    get offsetWidth() { return typeof window.innerWidth === 'number' ? window.innerWidth : 0; },
    get offsetHeight() { return typeof window.innerHeight === 'number' ? window.innerHeight : 0; }
  };
  try {
    Object.defineProperty(window, 'frameElement', {
      configurable: true,
      get: function () { return frameElementShim; }
    });
  } catch (_) {}

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function getByPath(tree, path) {
    var segments = String(path).split('.');
    var cursor = tree;
    for (var index = 0; index < segments.length; index++) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = cursor[segments[index]];
    }
    return cursor;
  }

  function setByPath(tree, path, value) {
    var segments = String(path).split('.');
    var leaf = segments.pop();
    var cursor = tree;
    for (var index = 0; index < segments.length; index++) {
      if (cursor[segments[index]] === null || typeof cursor[segments[index]] !== 'object') cursor[segments[index]] = {};
      cursor = cursor[segments[index]];
    }
    cursor[leaf] = value;
  }

  function unsetByPath(tree, path) {
    var segments = String(path).split('.');
    var leaf = segments.pop();
    var cursor = tree;
    for (var index = 0; index < segments.length; index++) {
      if (cursor === null || typeof cursor !== 'object') return false;
      cursor = cursor[segments[index]];
    }
    if (cursor === null || typeof cursor !== 'object' || !(leaf in cursor)) return false;
    delete cursor[leaf];
    return true;
  }

  function scopeOf(option, forWrite) {
    var type = option && option.type ? option.type : 'chat';
    if (type === 'global' || type === 'chat' || type === 'message' || type === 'character' || type === 'script') return type;
    if (type === 'preset' && forWrite !== true) return 'preset';
    throw new Error('DSH-SoulMojito: variable scope "' + type + '" is not supported'
      + (type === 'preset' ? ' for writes (preset assets are read-only in the sandbox)' : ' (global/chat/message/character/script)'));
  }

  function messageIndex(messageId) {
    var last = state.messages.length - 1;
    var index = typeof messageId === 'number' ? messageId : last;
    if (index < 0) index = last + 1 + index;
    return index;
  }

  function presetVariableTree() {
    var active = state.presets ? state.presets.active : null;
    if (active === null || active === undefined) return {};
    var values = state.presets.values || {};
    var preset = values[active] || values['in_use'];
    var extensions = preset && typeof preset === 'object' ? preset.extensions : null;
    var helper = extensions && typeof extensions === 'object' ? extensions.tavern_helper : null;
    var tree = helper && typeof helper === 'object' ? helper.variables : null;
    return tree && typeof tree === 'object' && !Array.isArray(tree) ? clone(tree) : {};
  }

  function variablesFor(option) {
    var scope = scopeOf(option, false);
    if (scope === 'script') return clone(scriptVariablesFor(option)) || {};
    if (scope === 'preset') return presetVariableTree();
    if (scope !== 'message') return state.variables[scope] || {};
    var index = messageIndex(option && option.message_id);
    var message = state.messages.filter(function (entry) { return entry.message_id === index; })[0];
    var data = message && message.data ? message.data : {};
    // MVU cards probe getVariables({ type: 'message' }) before the first floor
    // has its own stat_data; fall back to the chat tree on read (writes still
    // target the message), mirroring Mvu.getMvuData.
    if (data && typeof data === 'object' && !Array.isArray(data) && data.stat_data === undefined) {
      var chatStat = state.variables.chat ? state.variables.chat.stat_data : undefined;
      if (chatStat !== undefined) return Object.assign({}, data, { stat_data: clone(chatStat) });
    }
    return data;
  }

  function variableOwner(option) {
    return option && typeof option.__scriptId === 'string' && option.__scriptId !== '' ? option.__scriptId : scriptId;
  }

  function rememberScope(option, next) {
    var scope = scopeOf(option, true);
    if (scope === 'message') return;
    if (scope === 'script') {
      var owner = variableOwner(option);
      if (owner !== '') state.scriptVariables[owner] = next;
      return;
    }
    if (scope === 'preset') return;
    state.variables[scope] = next;
  }

  // MagVarUpdate and status panels call 'getAllVariables()' / 'Mvu.getAllVariables()'
  // to read the currently effective MVU tree without knowing which scope holds it.
  // JSR merges global + character + script + chat, then (message iframes only)
  // accumulates every message's variables up to the current floor.
  function allVariables(option) {
    var merged = Object.assign(
      {},
      state.variables.global || {},
      state.variables.character || {},
      scriptVariablesFor(option) || {},
      state.variables.chat || {},
    );
    if (currentMessageId >= 0) {
      for (var index = 0; index <= currentMessageId && index < state.messages.length; index++) {
        var entry = state.messages[index];
        var data = entry && entry.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(merged, clone(data));
      }
    }
    return merged;
  }
  window.getAllVariables = function (option) { return clone(allVariables(option)) || {}; };

  function scriptVariablesFor(option) {
    var owner = variableOwner(option);
    if (owner === '') return {};
    var table = state.scriptVariables && state.scriptVariables[owner];
    return table && typeof table === 'object' ? table : {};
  }

  function mvuScopeOption(option) {
    var type = option && option.type ? option.type : 'chat';
    if (type === 'message' || type === 'chat') return type;
    throw new Error('DSH-SoulMojito: Mvu scope "' + type + '" is not supported (chat/message)');
  }

  function messageAt(messageId) {
    var index = messageIndex(messageId);
    return state.messages.filter(function (entry) { return entry.message_id === index; })[0];
  }

  function mvuStatFor(option) {
    var type = mvuScopeOption(option);
    if (type === 'message') {
      var message = messageAt(option && option.message_id);
      var inMessage = message && message.data ? message.data.stat_data : undefined;
      if (inMessage !== undefined) return inMessage;
      return state.variables.chat ? state.variables.chat.stat_data : undefined;
    }
    return state.variables.chat ? state.variables.chat.stat_data : undefined;
  }

  var MVU_EVENTS = {
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    VARIABLE_UPDATE_FAILED: 'mag_variable_update_failed'
  };

  function dispatchMvu(statData) {
    if (statData === undefined) return;
    var json = JSON.stringify(statData);
    if (json === lastMvuStatJson) return;
    lastMvuStatJson = json;
    try {
      document.dispatchEvent(new CustomEvent(MVU_EVENTS.VARIABLE_UPDATE_ENDED, { detail: { stat_data: clone(statData) }, bubbles: true }));
    } catch (error) {
      console.error('[Mvu] event dispatch failed', error);
    }
  }

  function toastHost() {
    var host = document.getElementById('dsh-tavern-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'dsh-tavern-toasts';
      host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-width:min(360px,80vw);pointer-events:none;font:13px/1.45 system-ui,sans-serif';
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }

  function toastColor(kind) {
    return kind === 'error' ? '#f7768e' : kind === 'warning' ? '#e0af68' : kind === 'success' ? '#9ece6a' : '#7aa2f7';
  }

  function showToast(kind, message) {
    try {
      var item = document.createElement('div');
      item.style.cssText = 'pointer-events:auto;background:#16161e;color:#c0caf5;border-left:3px solid ' + toastColor(kind) + ';padding:8px 12px;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap';
      item.textContent = String(message);
      toastHost().appendChild(item);
      setTimeout(function () { try { item.remove(); } catch (_) {} }, 3600);
    } catch (error) {
      console.error('[toastr] ' + String(message), error);
    }
  }

  // Generation can take minutes, so the request notice stays until the call
  // settles. It carries the model and prompt size so the player knows which
  // card request is running and why the frontend is waiting.
  function generationModel(config) {
    var custom = config && config.custom_api && typeof config.custom_api === 'object' ? config.custom_api : null;
    var model = custom && typeof custom.model === 'string' ? custom.model.trim() : '';
    return model === '' ? '自定义 API' : model;
  }

  function generationPromptChars(config) {
    var total = typeof config.user_input === 'string' ? config.user_input.length : 0;
    var injects = config && Array.isArray(config.injects) ? config.injects : [];
    for (var index = 0; index < injects.length; index++) {
      var inject = injects[index];
      if (inject && inject.position !== 'none' && typeof inject.content === 'string') total += inject.content.length;
    }
    var overrides = config && config.overrides && typeof config.overrides === 'object' ? config.overrides : null;
    var history = overrides && overrides.chat_history && typeof overrides.chat_history === 'object' ? overrides.chat_history : null;
    var prompts = history && Array.isArray(history.prompts) ? history.prompts : [];
    for (var promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
      var prompt = prompts[promptIndex];
      if (prompt && typeof prompt.content === 'string') total += prompt.content.length;
    }
    return total;
  }

  function showGenerationStarted(config) {
    try {
      var item = document.createElement('div');
      item.style.cssText = 'pointer-events:auto;background:#16161e;color:#c0caf5;border-left:3px solid #7aa2f7;padding:8px 12px;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap';
      item.textContent = 'SoulMojito正在处理生成请求…\\n模型: ' + generationModel(config) + ' · 输入: ' + generationPromptChars(config) + ' 字符';
      toastHost().appendChild(item);
      return item;
    } catch (error) {
      console.error('[SoulMojito] generation notice failed', error);
      return null;
    }
  }

  function finishGenerationNotice(item, kind, message) {
    if (!item) return;
    try {
      item.style.borderLeftColor = toastColor(kind);
      item.textContent = message;
      setTimeout(function () { try { item.remove(); } catch (_) {} }, 5200);
    } catch (_) {}
  }

  // JSR 的 errorCatched 是卡前端常用包装器（示例卡2 的 defineMvuDataStore 直接用它
  // 包住 defineStore 初始化）。缺了它，前端会在模块求值阶段抛 ReferenceError。
  // 语义保持：同步抛错与 Promise 拒绝都会弹一条 error toast，然后继续抛出。
  window.errorCatched = function (fn) {
    if (typeof fn !== 'function') throw new Error('DSH-SoulMojito: errorCatched expects a function');
    var report = function (error) {
      var message = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
      showToast('error', message);
      throw error;
    };
    return function () {
      try {
        var result = fn.apply(this, arguments);
        if (result && typeof result.then === 'function') {
          return result.then(undefined, report);
        }
        return result;
      } catch (error) {
        return report(error);
      }
    };
  };

  // 音频兼容面（2026-10-22）：JSR 卡把 playAudio('bgm', { url }) 当作同步调用，
  // 不 await、不 try。缺函数会让整段解析/状态更新中断（示例卡2 的开场 BGM 就在
  // 首屏 manageSprites 里调用）。这里按 bgm/ambient 两个通道落到 iframe 内
  // <audio>，自动播放被浏览器拦截时只记 warning，不向卡抛错。
  var audioChannels = {};
  function audioChannel(type) {
    if (type !== 'bgm' && type !== 'ambient') {
      throw new Error('DSH-SoulMojito: audio type "' + String(type) + '" is not supported (bgm/ambient)');
    }
    if (!audioChannels[type]) {
      audioChannels[type] = {
        element: null,
        list: [],
        current: null,
        settings: { enabled: true, mode: 'repeat_all', muted: false, volume: 100 },
      };
    }
    return audioChannels[type];
  }
  function audioTitle(audio) {
    if (audio && typeof audio.title === 'string' && audio.title !== '') return audio.title;
    var url = audio && typeof audio.url === 'string' ? audio.url : '';
    var name = url.split('/').pop() || '';
    try { name = decodeURIComponent(name); } catch (_) {}
    return name;
  }
  function audioEntry(audio) {
    return { title: audioTitle(audio), url: String(audio.url) };
  }
  function ensureAudioElement(channel) {
    if (channel.element) return channel.element;
    var element = document.createElement('audio');
    element.preload = 'auto';
    element.style.display = 'none';
    (document.body || document.documentElement).appendChild(element);
    channel.element = element;
    return element;
  }
  function applyAudioSettings(channel) {
    if (!channel.element) return;
    channel.element.volume = Math.max(0, Math.min(1, channel.settings.volume / 100));
    channel.element.muted = channel.settings.muted === true;
    channel.element.loop = channel.settings.mode !== 'play_one_and_stop';
  }
  window.playAudio = function (type, audio) {
    var channel = audioChannel(type);
    if (!audio || typeof audio.url !== 'string' || audio.url === '') {
      throw new Error('DSH-SoulMojito: playAudio(type, { url }) requires an audio URL');
    }
    var entry = audioEntry(audio);
    channel.current = entry;
    if (!channel.list.some(function (existing) { return existing.url === entry.url || existing.title === entry.title; })) {
      channel.list.push(entry);
    }
    var element = ensureAudioElement(channel);
    element.src = entry.url;
    applyAudioSettings(channel);
    if (channel.settings.enabled !== true) return;
    var playing = element.play();
    if (playing && typeof playing.catch === 'function') {
      playing.catch(function (error) {
        console.warn('[audio] playback blocked or failed', error);
      });
    }
  };
  window.pauseAudio = function (type) {
    var channel = audioChannel(type);
    if (channel.element) channel.element.pause();
  };
  window.getAudioList = function (type) {
    return clone(audioChannel(type).list);
  };
  window.replaceAudioList = function (type, audioList) {
    var channel = audioChannel(type);
    channel.list = (Array.isArray(audioList) ? audioList : [])
      .filter(function (audio) { return audio && typeof audio.url === 'string' && audio.url !== ''; })
      .map(audioEntry);
  };
  window.appendAudioList = function (type, audioList) {
    var channel = audioChannel(type);
    (Array.isArray(audioList) ? audioList : []).forEach(function (audio) {
      if (!audio || typeof audio.url !== 'string' || audio.url === '') return;
      var entry = audioEntry(audio);
      if (channel.list.some(function (existing) { return existing.url === entry.url || existing.title === entry.title; })) return;
      channel.list.push(entry);
    });
  };
  window.getAudioSettings = function (type) {
    return Object.assign({}, audioChannel(type).settings);
  };
  window.setAudioSettings = function (type, settings) {
    var channel = audioChannel(type);
    var next = settings && typeof settings === 'object' ? settings : {};
    if (typeof next.enabled === 'boolean') channel.settings.enabled = next.enabled;
    if (next.mode === 'repeat_one' || next.mode === 'repeat_all' || next.mode === 'shuffle' || next.mode === 'play_one_and_stop') {
      channel.settings.mode = next.mode;
    }
    if (typeof next.muted === 'boolean') channel.settings.muted = next.muted;
    if (typeof next.volume === 'number' && isFinite(next.volume)) {
      channel.settings.volume = Math.max(0, Math.min(100, Math.round(next.volume)));
    }
    applyAudioSettings(channel);
  };
  window.getCurrentAudio = function (type) {
    var channel = audioChannel(type);
    var element = channel.element;
    var duration = element && isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    return {
      src: channel.current ? channel.current.url : '',
      title: channel.current ? channel.current.title : '',
      playing: element ? !element.paused && !element.ended : false,
      progress: element && duration > 0 ? Math.max(0, Math.min(100, (element.currentTime / duration) * 100)) : 0,
    };
  };

  function applySnapshot(snapshot) {
    state.characterName = snapshot.characterName || state.characterName;
    state.userName = snapshot.userName || state.userName;
    state.chatId = snapshot.chatId || state.chatId;
    state.chatMetadata = snapshot.chatMetadata || {};
    state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    state.variables = snapshot.variables || state.variables;
    state.characterData = snapshot.characterData || null;
    state.scriptTrees = Array.isArray(snapshot.scriptTrees) ? snapshot.scriptTrees : null;
    state.scriptTreesByType = snapshot.scriptTreesByType && typeof snapshot.scriptTreesByType === 'object'
      ? snapshot.scriptTreesByType
      : { character: state.scriptTrees, preset: null, global: null };
    state.presets = snapshot.presets && typeof snapshot.presets === 'object'
      ? snapshot.presets
      : { names: [], active: null, values: {} };
    state.personas = snapshot.personas && typeof snapshot.personas === 'object'
      ? snapshot.personas
      : { names: [], ids: [], active: null, values: {} };
    state.characters = snapshot.characters && typeof snapshot.characters === 'object'
      ? snapshot.characters
      : { names: [], ids: [] };
    state.regexScripts = snapshot.regexScripts && typeof snapshot.regexScripts === 'object'
      ? snapshot.regexScripts
      : { global: [], character: [], preset: [] };
    state.scriptVariables = snapshot.scriptVariables && typeof snapshot.scriptVariables === 'object'
      ? snapshot.scriptVariables
      : {};
    state.worlds = snapshot.worlds && typeof snapshot.worlds === 'object'
      ? snapshot.worlds
      : { names: [], active: [], char: { primary: null, additional: [] }, chat: null };
    state.personaDescription = typeof snapshot.personaDescription === 'string' ? snapshot.personaDescription : '';
    state.avatar = typeof snapshot.avatar === 'string' ? snapshot.avatar : '';
    state.characterId = typeof snapshot.characterId === 'number' ? snapshot.characterId : 0;
    // Script-container iframes adopt the persisted node info after a reload so
    // getScriptInfo()/replaceScriptInfo() observe the session copy.
    if (scriptId !== '') {
      var ownNode = findScriptNodeById(state.scriptTreesByType.character, scriptId);
      if (ownNode !== null && typeof ownNode.info === 'string') scriptInfo = ownNode.info;
      if (ownNode !== null && typeof ownNode.name === 'string' && ownNode.name !== '') scriptName = ownNode.name;
      if (ownNode !== null && ownNode.button && Array.isArray(ownNode.button.buttons)) {
        scriptButtons = normalizeScriptButtons(ownNode.button.buttons);
      }
    }
    // 快照先于 GM 面板首次 getScriptTrees 到达时，把会话副本装进内存树；本地
    // 已写过之后不再接受快照覆盖（见 scriptTreesLocallyWritten）。
    if (!scriptTreesLocallyWritten && Array.isArray(state.scriptTrees)) scriptTrees = clone(state.scriptTrees);
    // 状态栏前端在 DOMContentLoaded 只拉一次；快照是异步到的。这里把最新
    // stat_data 作为一次 VARIABLE_UPDATE_ENDED 广播，面板不会停在空态。
    var last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : undefined;
    var stat = last && last.data ? last.data.stat_data : undefined;
    if (stat === undefined && state.variables.chat) stat = state.variables.chat.stat_data;
    if (stat !== undefined) dispatchMvu(stat);
  }

  function emitLocally(type, args) {
    var group = listeners.get(type);
    if (!group) return;
    Array.from(group).forEach(function (listener) {
      try { listener.apply(null, args); } catch (error) { console.error('[TavernHelper] listener failed', error); }
    });
  }

  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.token !== token) return;
    if (data.type === ${JSON.stringify(HELPER_RESULT_MESSAGE)}) {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.value);
      else entry.reject(new Error(data.message || 'TavernHelper call failed'));
      return;
    }
    if (data.type === ${JSON.stringify(HELPER_SNAPSHOT_MESSAGE)}) applySnapshot(data.snapshot || {});
    if (data.type === ${JSON.stringify(HELPER_EVENT_MESSAGE)}) emitLocally(data.event, Array.isArray(data.args) ? data.args : []);
  });

  // 快照主动拉取（2026-10-21）：宿主 hook 只在挂载时推一次快照；srcdoc 的外链库
  // 会把本脚本推迟到推送之后才执行，那条消息就丢了，状态栏永远停在「未检测到
  // 主角创建」。监听器就绪后拉一次；与宿主挂载推送互补——两者时机交叉时至少
  // 有一条路径能送达，不依赖 host 的挂载顺序。
  call('snapshot').then(function (snapshot) {
    if (snapshot && typeof snapshot === 'object') applySnapshot(snapshot);
  }).catch(function (error) {
    console.error('[TavernHelper] initial snapshot failed', error);
  });

  // Variable writes are synchronous on the JSR surface (4.9+): the iframe mutates
  // its local snapshot and returns immediately, while persistence is queued in
  // order behind the previous write. Failures surface as an error toast and the
  // optimistic value is replaced by the next snapshot push.
  var variableWriteChain = Promise.resolve();
  function persistVariables(target, next) {
    var scope = scopeOf(target, true);
    var messageId = scope === 'message' ? messageIndex(target.message_id) : undefined;
    var op = scope === 'script' ? 'script.variables.replace' : 'variables.replace';
    var owner = scope === 'script' ? variableOwner(target) : scriptId;
    var payload = scope === 'script'
      ? { scriptId: owner, variables: next }
      : { scope: scope, messageId: messageId, variables: next };
    if (scope === 'script' && owner === '') {
      throw new Error('DSH-SoulMojito: script-scope variables require a script-container iframe');
    }
    variableWriteChain = variableWriteChain
      .catch(function () {})
      .then(function () { return call(op, payload); })
      .then(function (value) {
        var stored = value && typeof value === 'object' ? value.variables : undefined;
        if (stored && typeof stored === 'object') rememberScope(target, clone(stored));
      }, function (error) {
        showToast('error', '变量写入失败: ' + (error && error.message ? error.message : String(error)));
      });
  }

  function rememberMessage(target, next) {
    var message = messageAt(target && target.message_id);
    if (message) message.data = clone(next);
  }

  window.getVariables = function (option) { return clone(variablesFor(option)) || {}; };

  window.replaceVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var scope = scopeOf(target, true);
    var next = clone(variables) || {};
    if (scope === 'message') rememberMessage(target, next);
    rememberScope(target, next);
    persistVariables(target, next);
  };

  window.updateVariablesWith = function (updater, option) {
    var target = option || { type: 'chat' };
    if (typeof updater !== 'function') throw new Error('DSH-SoulMojito: updateVariablesWith expects an updater function');
    var current = clone(variablesFor(target)) || {};
    var result = updater(current);
    if (result && typeof result.then === 'function') {
      return result.then(function (next) {
        window.replaceVariables(next || {}, target);
        return next;
      });
    }
    window.replaceVariables(result || {}, target);
    return result;
  };

  window.insertOrAssignVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    Object.keys(variables || {}).forEach(function (key) { current[key] = clone(variables[key]); });
    window.replaceVariables(current, target);
    return current;
  };

  window.insertVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    Object.keys(variables || {}).forEach(function (key) {
      if (!(key in current)) current[key] = clone(variables[key]);
    });
    window.replaceVariables(current, target);
    return current;
  };

  window.deleteVariable = function (variablePath, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    var deleteOccurred = unsetByPath(current, variablePath);
    window.replaceVariables(current, target);
    return { variables: current, delete_occurred: deleteOccurred };
  };

  // JSR only uses registered schemas for its variable-manager UI; the server-side
  // MVU guard owns real validation. Keep the registration observable.
  var variableSchemas = {};
  window.registerVariableSchema = function (schema, option) {
    var type = option && option.type ? String(option.type) : 'chat';
    variableSchemas[type] = schema;
  };
  window.getVariablesSchemas = function () { return variableSchemas; };

  /* ------------------------------ macros ------------------------------ */

  // Synchronous ST macro subset. JSR's substitudeMacros is sync, so the shim
  // expands from its own snapshot instead of calling the host macro engine.
  // Unknown macros stay verbatim, matching ST's substituteParams behavior.
  var macroLikes = new Map();
  function cardField(name) {
    var data = state.characterData || {};
    return typeof data[name] === 'string' ? data[name] : '';
  }
  function macroString(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (_) { return ''; }
    }
    return String(value);
  }
  function macroTree(scope) {
    return scope === 'global' ? (state.variables.global || {}) : (state.variables.chat || {});
  }
  function macroRead(scope, path) { return getByPath(macroTree(scope), path); }
  function macroWrite(scope, path, value) {
    var tree = macroTree(scope);
    setByPath(tree, path, value);
    persistVariables(scope === 'global' ? { type: 'global' } : { type: 'chat' }, clone(tree));
  }
  function messageOf(role) {
    for (var index = state.messages.length - 1; index >= 0; index--) {
      var message = state.messages[index];
      if (!message) continue;
      if (role === 'user' && message.role === 'user') return message;
      if (role === 'char' && message.role === 'assistant') return message;
    }
    return null;
  }
  function splitMacroArgs(raw) {
    var parts = [];
    var current = '';
    var quoted = false;
    for (var index = 0; index < raw.length; index++) {
      var character = raw[index];
      if (character === '"') { quoted = !quoted; continue; }
      if (character === ',' && !quoted) { parts.push(current); current = ''; continue; }
      current += character;
    }
    if (current !== '') parts.push(current);
    return parts.map(function (part) { return part.trim(); }).filter(function (part) { return part !== ''; });
  }
  function randomPick(list) {
    if (list.length === 0) return '';
    return list[Math.floor(Math.random() * list.length)] || '';
  }
  function rollDice(spec) {
    var match = /^(\\d*)d(\\d+)([+-]\\d+)?$/i.exec(String(spec).trim());
    if (match === null) return '';
    var count = match[1] === '' ? 1 : parseInt(match[1], 10);
    var sides = parseInt(match[2], 10);
    var modifier = match[3] === undefined ? 0 : parseInt(match[3], 10);
    var total = modifier;
    for (var index = 0; index < count; index++) total += 1 + Math.floor(Math.random() * sides);
    return String(total);
  }
  function formatClock(kind) {
    var now = new Date();
    var pad = function (value) { return String(value).padStart(2, '0'); };
    if (kind === 'time') return pad(now.getHours()) + ':' + pad(now.getMinutes());
    if (kind === 'date') return now.getFullYear() + '/' + pad(now.getMonth() + 1) + '/' + pad(now.getDate());
    if (kind === 'datetime') return formatClock('date') + ' ' + formatClock('time');
    if (kind === 'isotime') return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T'
      + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }
  function expandMacros(text) {
    if (typeof text !== 'string' || text.indexOf('{{') === -1) return String(text);
    return text.replace(/\\{\\{([\\s\\S]*?)\\}\\}/g, function (whole, body) {
      var expression = String(body).trim();
      if (expression.indexOf('//') === 0) return '';
      var separator = expression.indexOf('::');
      var name = (separator === -1 ? expression : expression.slice(0, separator)).trim().toLowerCase();
      var argument = separator === -1 ? '' : expression.slice(separator + 2);
      if (macroLikes.has(name)) {
        try {
          var handler = macroLikes.get(name);
          return String(handler.apply(null, argument === '' ? [] : [argument]));
        } catch (error) {
          console.error('[TavernHelper] macro-like "' + name + '" failed', error);
          return whole;
        }
      }
      switch (name) {
        case 'char':
        case 'bot':
        case 'charifnotgroup':
          return state.characterName;
        case 'user':
          return state.userName;
        case 'persona':
          return state.personaDescription || '';
        case 'description':
          return cardField('description');
        case 'personality':
          return cardField('personality');
        case 'scenario':
          return cardField('scenario');
        case 'mesexamples':
          return cardField('mes_example');
        case 'lastmessage': {
          var last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
          return last && typeof last.message === 'string' ? last.message : '';
        }
        case 'lastusermessage': {
          var user = messageOf('user');
          return user && typeof user.message === 'string' ? user.message : '';
        }
        case 'lastcharmessage': {
          var character = messageOf('char');
          return character && typeof character.message === 'string' ? character.message : '';
        }
        case 'lastmessageid':
          return String(state.messages.length - 1);
        case 'chatid':
          return state.chatId;
        case 'group':
          return state.characterName;
        case 'input':
        case 'original':
        case 'model':
          return '';
        case 'newline':
          return '\\n';
        case 'getvar':
          return macroString(macroRead('chat', String(argument).trim()));
        case 'getglobalvar':
          return macroString(macroRead('global', String(argument).trim()));
        case 'setvar': {
          var localPair = splitAssignment(argument);
          macroWrite('chat', localPair.path, localPair.value);
          return '';
        }
        case 'setglobalvar': {
          var globalPair = splitAssignment(argument);
          macroWrite('global', globalPair.path, globalPair.value);
          return '';
        }
        case 'addvar':
        case 'incvar': {
          var incPair = splitAssignment(argument);
          var incValue = Number(macroRead('chat', incPair.path));
          macroWrite('chat', incPair.path, (isFinite(incValue) ? incValue : 0) + (incPair.value === '' ? 1 : Number(incPair.value)));
          return '';
        }
        case 'decvar': {
          var decPair = splitAssignment(argument);
          var decValue = Number(macroRead('chat', decPair.path));
          macroWrite('chat', decPair.path, (isFinite(decValue) ? decValue : 0) - (decPair.value === '' ? 1 : Number(decPair.value)));
          return '';
        }
        case 'random':
        case 'pick':
          return randomPick(splitMacroArgs(argument));
        case 'roll':
          return rollDice(argument === '' ? '1d100' : argument);
        case 'time':
        case 'date':
        case 'datetime':
        case 'isotime':
        case 'isodate':
          return formatClock(name);
        default:
          return whole;
      }
    });
  }
  function splitAssignment(raw) {
    var text = String(raw);
    var separator = text.indexOf('::');
    var path = (separator === -1 ? text : text.slice(0, separator)).trim();
    var value = separator === -1 ? '' : text.slice(separator + 2);
    return { path: path, value: value };
  }
  window.substitudeMacros = function (text) { return expandMacros(String(text)); };
  window.registerMacroLike = function (name, handler) {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('DSH-SoulMojito: registerMacroLike requires a macro name');
    if (typeof handler !== 'function') throw new Error('DSH-SoulMojito: registerMacroLike requires a handler function');
    var key = name.trim().toLowerCase();
    macroLikes.set(key, handler);
    return { unregister: function () { macroLikes.delete(key); } };
  };
  window.unregisterMacroLike = function (name) {
    macroLikes.delete(String(name).trim().toLowerCase());
  };

  /* ------------------------------ regex ------------------------------ */

  function regexListForScope(scope) {
    var table = state.regexScripts || {};
    if (scope === 'character' || scope === 'preset' || scope === 'global') return table[scope] || [];
    return [].concat(table.global || [], table.character || [], table.preset || []);
  }
  function placementOfSource(source) {
    if (source === 'user_input') return 1;
    if (source === 'ai_output') return 2;
    if (source === 'slash_command') return 3;
    if (source === 'world_info') return 5;
    if (source === 'reasoning') return 6;
    return 2;
  }
  function hasRegexPlacement(script, placement) {
    var placements = script && Array.isArray(script.placement) ? script.placement : [];
    return placements.length === 0 || placements.indexOf(placement) !== -1;
  }
  function compileScriptRegex(script) {
    var raw = script && script.substituteRegex === true
      ? expandMacros(String(script.findRegex || ''))
      : String((script && script.findRegex) || '');
    var literal = /^\\/([\\s\\S]*)\\/([a-z]*)$/.exec(raw);
    try {
      if (literal !== null) {
        var flags = literal[2].indexOf('g') === -1 ? literal[2] + 'g' : literal[2];
        return new RegExp(literal[1], flags);
      }
      return new RegExp(raw, 'g');
    } catch (error) {
      console.warn('[TavernHelper] invalid regex skipped', script && script.id, error);
      return null;
    }
  }
  function regexReplacement(template, match, captures, trimStrings) {
    var trim = function (value) {
      var next = value;
      for (var index = 0; index < trimStrings.length; index++) {
        if (trimStrings[index] !== '') next = next.split(trimStrings[index]).join('');
      }
      return next;
    };
    return String(template)
      .replace(/\\{\\{match\\}\\}/gi, '$0')
      .replace(/\\$(\\d+)|\\$<([^>]+)>/g, function (token, digits, group) {
        if (digits !== undefined) {
          var index = Number(digits);
          var value = index === 0 ? match : captures[index - 1];
          return value === undefined ? '' : trim(value);
        }
        return '';
      });
  }
  function applyRegexScriptLocal(text, script, placement, destination, depth) {
    if (!script || script.disabled === true || !hasRegexPlacement(script, placement)) return null;
    if (destination === 'display' && script.promptOnly === true) return null;
    if (destination === 'prompt' && script.markdownOnly === true) return null;
    if (typeof depth === 'number' && isFinite(depth)) {
      if (typeof script.minDepth === 'number' && depth < script.minDepth) return null;
      if (typeof script.maxDepth === 'number' && depth > script.maxDepth) return null;
    }
    var regex = compileScriptRegex(script);
    if (regex === null) return null;
    var replacement = script.substituteRegex === true ? expandMacros(String(script.replaceString || '')) : String(script.replaceString || '');
    var trimStrings = Array.isArray(script.trimStrings) ? script.trimStrings.map(String) : [];
    var result = String(text).replace(regex, function (match) {
      var captures = Array.prototype.slice.call(arguments, 1, -2);
      return regexReplacement(replacement, match, captures, trimStrings);
    });
    for (var index = 0; index < trimStrings.length; index++) {
      if (trimStrings[index] !== '') result = result.split(trimStrings[index]).join('');
    }
    return result;
  }
  function applyRegexScriptsLocal(text, scripts, placement, destination, depth) {
    var current = String(text);
    for (var index = 0; index < scripts.length; index++) {
      var next = applyRegexScriptLocal(current, scripts[index], placement, destination, depth);
      if (next !== null) current = next;
    }
    return current;
  }
  function toTavernRegex(script) {
    return {
      id: script.id,
      script_name: script.scriptName,
      enabled: script.disabled !== true,
      find_regex: script.findRegex,
      replace_string: script.replaceString,
      trim_strings: Array.isArray(script.trimStrings) ? clone(script.trimStrings) : [],
      source: {
        user_input: hasRegexPlacement(script, 1),
        ai_output: hasRegexPlacement(script, 2),
        slash_command: hasRegexPlacement(script, 3),
        world_info: hasRegexPlacement(script, 5),
        reasoning: hasRegexPlacement(script, 6),
      },
      destination: {
        display: script.promptOnly !== true,
        prompt: script.markdownOnly !== true,
      },
      run_on_edit: script.runOnEdit === true,
      min_depth: typeof script.minDepth === 'number' ? script.minDepth : null,
      max_depth: typeof script.maxDepth === 'number' ? script.maxDepth : null,
    };
  }

  window.getCurrentMessageId = function () {
    if (typeof currentMessageId === 'number' && currentMessageId >= 0) return currentMessageId;
    return state.messages.length - 1;
  };

  // MagVarUpdate / Mvu 的可观察面（2026-10-20 卡兼容）：卡前端大量使用
  // Mvu.getMvuData / replaceMvuData / events.VARIABLE_UPDATE_ENDED。
  // message 作用域的读回退聊天作用域；写穿同时更新目标楼层与聊天权威树。
  window.Mvu = {
    events: MVU_EVENTS,
    isDuringGenerating: function () { return false; },
    getMvuData: function (option) {
      var stat = mvuStatFor(option);
      return stat === undefined ? undefined : { stat_data: clone(stat) };
    },
    replaceMvuData: function (data, option) {
      var target = option || { type: 'message', message_id: -1 };
      var type = mvuScopeOption(target);
      var stat = data && data.stat_data !== undefined ? data.stat_data : data;
      if (!stat || typeof stat !== 'object' || Array.isArray(stat)) {
        showToast('error', '变量写入失败: DSH-SoulMojito: Mvu.replaceMvuData expects an object');
        return Promise.reject(new Error('DSH-SoulMojito: Mvu.replaceMvuData expects an object'));
      }
      var index = type === 'message' ? messageIndex(target.message_id) : undefined;
      if (type === 'message') {
        var message = messageAt(index);
        if (message) message.data = Object.assign({}, message.data || {}, { stat_data: clone(stat) });
      }
      if (state.variables.chat) state.variables.chat.stat_data = clone(stat);
      dispatchMvu(stat);
      // 卡片按钮的写回失败必须可见：卡自己只 console.error，用户会以为「点了没反应」。
      return call('mvu.replace', { statData: stat, messageId: index }).then(function (value) {
        if (value && value.stat_data !== undefined) {
          if (state.variables.chat) state.variables.chat.stat_data = clone(value.stat_data);
          dispatchMvu(value.stat_data);
        }
        return { stat_data: value && value.stat_data !== undefined ? value.stat_data : clone(stat) };
      }, function (error) {
        showToast('error', '变量写入失败: ' + (error && error.message ? error.message : String(error)));
        throw error;
      });
    }
  };
  window.Mvu.getAllVariables = window.getAllVariables;
  window.TavernHelper = window.TavernHelper || {};
  window.TavernHelper.Mvu = window.Mvu;

  // toastr 最小实现：卡前端只用 info/success/warning/error；不引入外部库。
  window.toastr = {
    info: function (message) { showToast('info', message); },
    success: function (message) { showToast('success', message); },
    warning: function (message) { showToast('warning', message); },
    warn: function (message) { showToast('warning', message); },
    error: function (message) { showToast('error', message); },
    clear: function () { try { var host = document.getElementById('dsh-tavern-toasts'); if (host) host.textContent = ''; } catch (_) {} }
  };

  window.getChatMessages = function (range, option) {
    var settings = option || {};
    var last = state.messages.length - 1;
    var first = state.messages.length > 0 ? state.messages[0].message_id : 0;
    function toIndex(raw) {
      var value = Number(String(raw).replace(/\\{\\{\\s*lastMessageId\\s*\\}\\}/gi, String(last)));
      if (isNaN(value)) throw new Error('DSH-SoulMojito: unsupported message range ' + range);
      return value < 0 ? last + 1 + value : value;
    }
    var start;
    var end;
    var text = String(range).replace(/\\{\\{\\s*lastMessageId\\s*\\}\\}/gi, String(last)).trim();
    var rangeMatch = /^(-?\\d+)\\s*-\\s*(-?\\d+)?$/.exec(text);
    if (rangeMatch) {
      start = toIndex(rangeMatch[1]);
      end = rangeMatch[2] === undefined ? start : toIndex(rangeMatch[2]);
    } else {
      start = toIndex(text);
      end = start;
    }
    if (start > end) { var swap = start; start = end; end = swap; }
    start = Math.max(first, start);
    end = Math.min(last, end);
    return state.messages.filter(function (message) {
      if (message.message_id < start || message.message_id > end) return false;
      if (settings.role && settings.role !== 'all' && settings.role !== message.role) return false;
      if (settings.hide_state === 'hidden' && !message.is_hidden) return false;
      if (settings.hide_state === 'unhidden' && message.is_hidden) return false;
      return true;
    }).map(function (message) { return clone(message); });
  };

  window.getLastMessageId = function () { return state.messages.length - 1; };

  function afterMessageMutation(result) {
    if (!result) return result;
    if (Array.isArray(result.messages)) state.messages = result.messages;
    if (result.variables && result.variables.chat) state.variables.chat = result.variables.chat;
    return result;
  }

  window.setChatMessages = function (messages, option) {
    return call('messages.set', { messages: messages, refresh: option && option.refresh }).then(afterMessageMutation).then(function () { return undefined; });
  };

  window.createChatMessages = function (messages, option) {
    var insertBefore = option && option.insert_before !== undefined ? option.insert_before : (option && option.insert_at);
    return call('messages.create', { messages: messages, insertBefore: insertBefore === undefined ? 'end' : insertBefore })
      .then(afterMessageMutation).then(function () { return undefined; });
  };

  window.deleteChatMessages = function (messageIds, option) {
    return call('messages.delete', { messageIds: messageIds, refresh: option && option.refresh })
      .then(afterMessageMutation).then(function () { return undefined; });
  };

  window.setChatMessage = function (message, option) {
    return window.setChatMessages([message], option);
  };

  window.rotateChatMessages = function (begin, middle, end, option) {
    return call('messages.rotate', { begin: begin, middle: middle, end: end })
      .then(afterMessageMutation).then(function () { return undefined; });
  };

  window.eventOn = function (type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return { stop: function () { window.eventRemoveListener(type, listener); } };
  };
  window.eventOnce = function (type, listener) {
    var wrapper = function () {
      window.eventRemoveListener(type, wrapper);
      return listener.apply(null, arguments);
    };
    return window.eventOn(type, wrapper);
  };
  // eventMakeFirst / eventMakeLast：JSR 用顺序控制插件的执行位次；Set 保序，
  // 重排即「删了再加」或「整组倒序后重挂」。
  window.eventMakeLast = function (type, listener) {
    window.eventRemoveListener(type, listener);
    return window.eventOn(type, listener);
  };
  window.eventMakeFirst = function (type, listener) {
    var group = listeners.get(type);
    var rest = group ? Array.from(group).filter(function (entry) { return entry !== listener; }) : [];
    listeners.set(type, new Set([listener].concat(rest)));
    return { stop: function () { window.eventRemoveListener(type, listener); } };
  };
  function emitLocallyAsync(type, args) {
    var group = listeners.get(type);
    if (!group) return Promise.resolve();
    var results = [];
    Array.from(group).forEach(function (listener) {
      try {
        results.push(Promise.resolve(listener.apply(null, args)));
      } catch (error) {
        console.error('[TavernHelper] listener failed', error);
      }
    });
    return Promise.all(results).then(function () { return undefined; });
  }

  window.eventEmit = function (type) {
    return emitLocallyAsync(type, Array.prototype.slice.call(arguments, 1));
  };
  window.eventEmitAndWait = function (type) {
    // JSR's emitAndWait is synchronous from the caller's point of view; async
    // listeners still run, and failures are logged instead of escaping.
    void emitLocallyAsync(type, Array.prototype.slice.call(arguments, 1)).catch(function (error) {
      console.error('[TavernHelper] eventEmitAndWait listener failed', error);
    });
  };
  window.eventOnButton = function (type, listener) { return window.eventOn(window.getButtonEvent(type), listener); };
  window.eventRemoveListener = function (type, listener) {
    var group = listeners.get(type);
    if (group) { group.delete(listener); if (group.size === 0) listeners.delete(type); }
  };
  window.eventClearEvent = function (type) { listeners.delete(type); };
  window.eventClearListener = function (listener) {
    listeners.forEach(function (group) { group.delete(listener); });
  };
  window.eventClearAll = function () { listeners.clear(); };
  window.addEventListener('pagehide', function () { listeners.clear(); });

  // 角色链接世界书（2026-10-21 会话副本）：getter 必须同步（GM 脚本不 await）。
  // 名字取 extensions.world，其次内嵌书 characterBook.name。
  function characterWorldbookName() {
    var data = state.characterData || {}, extensions = data.extensions || {};
    var world = typeof extensions.world === 'string' ? extensions.world.trim() : '';
    if (world !== '') return world;
    var embedded = data.characterBook && typeof data.characterBook.name === 'string' ? data.characterBook.name.trim() : '';
    return embedded !== '' ? embedded : null;
  }

  function worldNames() { return clone((state.worlds && state.worlds.names) || []) || []; }
  function worldEntries(value) { return Array.isArray(value) ? clone(value) : []; }
  function putWorldEntries(name, entries) {
    return call('lorebook.put', { name: name, entries: entries }).then(function (value) { return worldEntries(value && value.entries); });
  }
  function rememberWorldName(name) {
    if (!state.worlds) state.worlds = { names: [], active: [], char: { primary: null, additional: [] }, chat: null };
    if (state.worlds.names.indexOf(name) === -1) state.worlds.names.push(name);
  }

  window.getLorebook = function (name) {
    var request = typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {};
    return call('lorebook.get', request).then(function (value) { return value.entries; });
  };
  window.getWorldbook = window.getLorebook;
  window.getLorebooks = function () { return worldNames(); };
  window.getLorebookNames = function () { return worldNames(); };
  window.getWorldbookNames = function () { return worldNames(); };
  window.getGlobalWorldbookNames = function () { return clone((state.worlds && state.worlds.active) || []); };
  window.getCharNames = function () { return clone((state.characters && state.characters.names) || []); };
  window.getCharacterNames = window.getCharNames;
  window.getCharacterIds = function () { return clone((state.characters && state.characters.ids) || []); };
  window.getCharWorldbookNames = function () {
    var links = (state.worlds && state.worlds.char) || {};
    // Linked world first, then the card-embedded book (same order as the
    // generator and getCurrentCharPrimaryLorebook).
    var primary = links.primary === undefined || links.primary === null ? links.embedded : links.primary;
    return { primary: primary === undefined ? null : primary, additional: clone(links.additional || []) };
  };
  window.getCharLorebooks = window.getCharWorldbookNames;
  window.getCurrentCharPrimaryLorebook = function () {
    var links = (state.worlds && state.worlds.char) || {};
    return links.primary || links.embedded || null;
  };
  window.getChatWorldbookName = function () { return (state.worlds && state.worlds.chat) || null; };
  window.getChatLorebook = window.getChatWorldbookName;
  window.getChatWorldbookNames = function () {
    var chat = window.getChatWorldbookName();
    return chat === null ? [] : [chat];
  };

  // World-book writes land in this chat's session copy only (base assets and
  // card-embedded books stay read-only). The updater runs inside the iframe;
  // only the resulting entries cross the bridge.
  window.updateWorldbookWith = function (name, updater) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updateWorldbookWith(name, updater) requires a function'));
    var bookName = typeof name === 'string' && name.trim() !== '' ? name.trim() : characterWorldbookName();
    if (bookName === null) return Promise.reject(new Error('DSH-SoulMojito: updateWorldbookWith requires a world book name (this character links no world)'));
    return window.getWorldbook(bookName)
      .then(function (entries) { return Promise.resolve(updater(clone(entries) || [])); })
      .then(function (updated) { return putWorldEntries(bookName, updated); });
  };
  window.replaceWorldbook = function (name, entries) {
    var bookName = typeof name === 'string' && name.trim() !== '' ? name.trim() : characterWorldbookName();
    if (bookName === null) return Promise.reject(new Error('DSH-SoulMojito: replaceWorldbook requires a world book name'));
    return putWorldEntries(bookName, worldEntries(entries));
  };
  window.createOrReplaceWorldbook = window.replaceWorldbook;
  window.createWorldbook = function (name) {
    var bookName = typeof name === 'string' ? name.trim() : '';
    if (bookName === '') return Promise.reject(new Error('DSH-SoulMojito: createWorldbook requires a name'));
    return call('lorebook.create', { name: bookName, entries: [] }).then(function () {
      rememberWorldName(bookName);
      return true;
    });
  };
  window.createLorebook = window.createWorldbook;
  window.deleteWorldbook = function (name) {
    var bookName = typeof name === 'string' ? name.trim() : '';
    if (bookName === '') return Promise.reject(new Error('DSH-SoulMojito: deleteWorldbook requires a name'));
    return call('lorebook.delete', { name: bookName }).then(function (value) {
      if (state.worlds && Array.isArray(state.worlds.names)) {
        state.worlds.names = state.worlds.names.filter(function (entry) { return entry !== bookName; });
      }
      return value && value.deleted === true;
    });
  };
  window.deleteLorebook = window.deleteWorldbook;
  window.setChatLorebook = function (name) {
    var bookName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    return call('chat.world.set', { name: bookName }).then(function () {
      if (!state.worlds) state.worlds = { names: [], active: [], char: { primary: null, additional: [] }, chat: null };
      state.worlds.chat = bookName;
      if (bookName !== null) rememberWorldName(bookName);
      return undefined;
    });
  };
  window.getOrCreateChatLorebook = function () {
    var existing = window.getChatWorldbookName();
    if (existing !== null) return Promise.resolve(existing);
    var created = 'Chat Worldbook - ' + (state.chatId || 'new');
    return window.createWorldbook(created)
      .then(function () { return window.setChatLorebook(created); })
      .then(function () { return created; });
  };
  window.getOrCreateChatWorldbook = window.getOrCreateChatLorebook;

  window.getLorebookEntries = function (name) { return window.getWorldbook(name); };
  window.replaceLorebookEntries = function (name, entries) { return window.replaceWorldbook(name, entries); };
  window.updateLorebookEntriesWith = function (name, updater) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updateLorebookEntriesWith(name, updater) requires a function'));
    return window.getWorldbook(name).then(function (entries) {
      return Promise.resolve(updater(clone(entries) || [])).then(function (next) {
        return window.replaceWorldbook(name, next);
      });
    });
  };
  window.setLorebookEntries = function (name, patches) {
    return window.getWorldbook(name).then(function (entries) {
      var byUid = {};
      worldEntries(entries).forEach(function (entry) { byUid[String(entry.uid)] = entry; });
      var next = worldEntries(entries).map(function (entry) {
        var patch = (Array.isArray(patches) ? patches : []).filter(function (item) { return String(item.uid) === String(entry.uid); })[0];
        return patch === undefined ? entry : Object.assign({}, entry, patch);
      });
      return window.replaceWorldbook(name, next);
    });
  };
  window.createLorebookEntries = function (name, entries) {
    return window.getWorldbook(name).then(function (current) {
      var list = worldEntries(current);
      var nextUid = list.reduce(function (max, entry) { return typeof entry.uid === 'number' && entry.uid > max ? entry.uid : max; }, -1) + 1;
      var created = (Array.isArray(entries) ? entries : []).map(function (entry) {
        return Object.assign({}, entry, { uid: nextUid++ });
      });
      return window.replaceWorldbook(name, list.concat(created)).then(function (all) {
        return { entries: all, new_uids: created.map(function (entry) { return entry.uid; }) };
      });
    });
  };
  window.createLorebookEntry = function (name, entry) {
    return window.createLorebookEntries(name, [entry]).then(function (result) {
      return result.entries[result.entries.length - 1];
    });
  };
  window.deleteLorebookEntries = function (name, uids) {
    return window.getWorldbook(name).then(function (current) {
      var list = worldEntries(current);
      var wanted = (Array.isArray(uids) ? uids : []).map(String);
      var kept = list.filter(function (entry) { return wanted.indexOf(String(entry.uid)) === -1; });
      var occurred = kept.length !== list.length;
      return window.replaceWorldbook(name, kept).then(function (all) {
        return { entries: all, delete_occurred: occurred };
      });
    });
  };
  window.deleteLorebookEntry = function (name, uid) {
    return window.deleteLorebookEntries(name, [uid]).then(function (result) { return result.delete_occurred; });
  };
  window.createWorldbookEntries = window.createLorebookEntries;
  window.deleteWorldbookEntries = window.deleteLorebookEntries;

  // Lorebook scan settings are host-level; the sandbox keeps a session-local
  // mirror so read-back is consistent. Generation uses the host settings.
  var lorebookSettings = {
    scan_depth: 2,
    context_percentage: 25,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    recursive: false,
    case_sensitive: null,
    match_whole_words: null,
    use_group_scoring: false,
    overflow_alert: false,
  };
  window.getLorebookSettings = function () { return clone(lorebookSettings); };
  window.setLorebookSettings = function (settings) {
    if (settings && typeof settings === 'object') Object.assign(lorebookSettings, clone(settings));
    console.warn('[TavernHelper] setLorebookSettings is a session-local mirror; generation uses the host lorebook settings');
  };

  // 脚本树（2026-10-21，GM 面板阶段 B）：优先会话副本（state.scriptTrees，由
  // 宿主 snapshot 带回），没有才从卡内 extensions.tavern_helper.scripts 播种。
  // 节点原样保留（folder / button / 未知字段都透传）；**不回写角色卡、不自动
  // 执行**。GM 改完树后等 mg-zod-ready 握手——这里从改写后的源码解析探针直接
  // 派发，让阶段 C 继续；Zod schema 本身不会生效。
  var scriptTrees = null;
  // 本地通过 scripts.put 写过之后，后续快照不得覆盖内存树（快照可能是在写入
  // 之前取的）；重载 iframe 会重置该标记并从会话副本重新播种。
  var scriptTreesLocallyWritten = false;
  function seedScriptTrees() {
    if (Array.isArray(state.scriptTrees)) return clone(state.scriptTrees);
    var data = state.characterData || {}, helper = (data.extensions || {}).tavern_helper;
    var nodes = helper && Array.isArray(helper.scripts) ? helper.scripts : [];
    var trees = [];
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index];
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      trees.push(node);
    }
    return clone(trees);
  }
  function flattenScriptTrees(trees) {
    var flat = [];
    for (var index = 0; index < trees.length; index++) {
      var entry = trees[index];
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'folder' && Array.isArray(entry.scripts)) flat = flat.concat(flattenScriptTrees(entry.scripts));
      else flat.push(entry);
    }
    return flat;
  }
  function currentScriptTrees() {
    if (scriptTrees === null) scriptTrees = seedScriptTrees();
    return scriptTrees;
  }
  function scriptTreeType(option) {
    var type = option && option.type ? String(option.type) : 'character';
    if (type !== 'character' && type !== 'preset' && type !== 'global') {
      throw new Error('DSH-SoulMojito: script tree type must be character, preset or global (got ' + type + ')');
    }
    return type;
  }
  function scriptTreesOf(type) {
    var byType = state.scriptTreesByType || {};
    if (type === 'preset') return clone(byType.preset || []) || [];
    if (type === 'global') return clone(byType.global || []) || [];
    return clone(byType.character === null || byType.character === undefined ? currentScriptTrees() : byType.character) || [];
  }
  // 脚本容器的节点补丁（info/buttons）要落到**可变**的内存树上：scriptTreesOf
  // 返回 clone，改 clone 不会让 getAllEnabledScriptButtons / getScriptTrees 看到。
  function mutableScriptTree(type) {
    if (!state.scriptTreesByType) state.scriptTreesByType = { character: null, preset: null, global: null };
    if (type === 'preset') return state.scriptTreesByType.preset;
    if (type === 'global') return state.scriptTreesByType.global;
    if (state.scriptTreesByType.character === null || state.scriptTreesByType.character === undefined) {
      state.scriptTreesByType.character = currentScriptTrees();
    }
    return state.scriptTreesByType.character;
  }
  function setScriptTreesLocal(type, trees) {
    if (!state.scriptTreesByType) state.scriptTreesByType = { character: null, preset: null, global: null };
    if (type === 'preset') state.scriptTreesByType.preset = clone(trees);
    else if (type === 'global') state.scriptTreesByType.global = clone(trees);
    else {
      state.scriptTreesByType.character = clone(trees);
      scriptTrees = clone(trees);
      state.scriptTrees = clone(trees);
    }
  }
  function persistScriptTrees(type, trees) {
    return call('scripts.put', { type: type, scriptTrees: trees }).then(function (value) {
      var stored = value && Array.isArray(value.scriptTrees) ? value.scriptTrees : trees;
      setScriptTreesLocal(type, stored);
      if (type === 'character') scriptTreesLocallyWritten = true;
      publishZodReady(stored);
      return clone(stored);
    });
  }
  function publishZodReady(trees) {
    var flat = flattenScriptTrees(trees);
    var found = null;
    for (var index = 0; index < flat.length; index++) {
      var entry = flat[index];
      if (!entry || typeof entry.content !== 'string') continue;
      var pattern = /__mgZodReady__\\s*=\\s*(\\{[^{}]*\\})/g;
      var match;
      while ((match = pattern.exec(entry.content)) !== null) found = match[1];
    }
    if (found === null) return;
    var ready;
    try { ready = JSON.parse(found); } catch (error) { console.error('[TavernHelper] invalid __mgZodReady__ probe', error); return; }
    host.__mgZodReady__ = ready;
    window.__mgZodReady__ = ready;
    try { window.dispatchEvent(new CustomEvent('mg-zod-ready', { detail: ready })); } catch (_) {}
    try { host.dispatchEvent(new CustomEvent('mg-zod-ready', { detail: ready })); } catch (_) {}
  }
  window.getScriptTrees = function (option) {
    return scriptTreesOf(scriptTreeType(option));
  };
  window.replaceScriptTrees = function (trees, option) {
    var type = scriptTreeType(option);
    if (!Array.isArray(trees)) throw new Error('DSH-SoulMojito: replaceScriptTrees requires an array of script nodes');
    setScriptTreesLocal(type, clone(trees));
    void persistScriptTrees(type, clone(trees)).catch(function (error) {
      showToast('error', '脚本树保存失败: ' + (error && error.message ? error.message : String(error)));
    });
  };
  // 先持久化再发布 ready：GM 面板把 updateScriptTreesWith 的 resolve 当作「已
  // 保存」。落盘失败必须拒绝并保留旧内存树，不能把半成品当成成功。
  window.updateScriptTreesWith = function (updater, option) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updateScriptTreesWith requires a function'));
    var type = scriptTreeType(option);
    var draft = scriptTreesOf(type);
    return Promise.resolve().then(function () {
      return updater(draft);
    }).then(function (next) {
      if (!Array.isArray(next)) throw new Error('DSH-SoulMojito: updateScriptTreesWith updater must return an array of script nodes');
      return persistScriptTrees(type, next);
    });
  };

  function findScriptNodeById(nodes, id) {
    if (!Array.isArray(nodes) || id === '') return null;
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index];
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'folder' && Array.isArray(node.scripts)) {
        var nested = findScriptNodeById(node.scripts, id);
        if (nested !== null) return nested;
        continue;
      }
      if (node.id === id) return node;
    }
    return null;
  }
  function ownScriptNode() {
    return findScriptNodeById(scriptTreesOf('character'), scriptId);
  }
  function persistScriptPatch(id, patch) {
    if (typeof id !== 'string' || id === '') return;
    call('scripts.patch', Object.assign({ scriptId: id }, patch)).catch(function (error) {
      showToast('error', '脚本信息保存失败: ' + (error && error.message ? error.message : String(error)));
    });
  }
  function persistOwnScriptPatch(patch) {
    persistScriptPatch(scriptId, patch);
  }
  function buttonHash(text) {
    var hash = 0;
    var value = String(text);
    for (var index = 0; index < value.length; index++) {
      hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
  function buttonEventId(ownerId, name) {
    return String(ownerId) + '_' + buttonHash(name);
  }
  window.getScriptId = function () { return scriptId === '' ? 'dsh-soulmojito-frontend' : scriptId; };
  window.getScriptName = function () {
    if (scriptName !== '') return scriptName;
    var node = ownScriptNode();
    return node && typeof node.name === 'string' ? node.name : '';
  };
  window.getScriptInfo = function () {
    if (scriptInfo !== '') return scriptInfo;
    var node = ownScriptNode();
    return node && typeof node.info === 'string' ? node.info : '';
  };
  window.replaceScriptInfo = function (info) {
    scriptInfo = String(info === undefined || info === null ? '' : info);
    syncNodeInfo(scriptId, scriptInfo);
    persistOwnScriptPatch({ info: scriptInfo });
  };
  window.getButtonEvent = function (name) { return buttonEventId(window.getScriptId(), name); };
  window.getIframeName = function () {
    return scriptId === '' ? 'TH-message-' + currentMessageId : 'TH-script-' + scriptId;
  };
  window.getMessageId = function (iframeName) {
    if (iframeName === window.getIframeName()) return currentMessageId;
    throw new Error('DSH-SoulMojito: iframe "' + String(iframeName) + '" is not registered in this document');
  };
  window.reloadIframe = function () {
    try {
      window.location.reload();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(new Error('DSH-SoulMojito: reloadIframe failed: ' + (error && error.message ? error.message : String(error))));
    }
  };

  window.getAllEnabledScriptButtons = function () {
    var result = {};
    ['character', 'preset', 'global'].forEach(function (type) {
      flattenScriptTrees(scriptTreesOf(type)).forEach(function (node) {
        if (!node || node.enabled === false) return;
        if (typeof node.id !== 'string' || typeof node.content !== 'string' || node.content.trim() === '') return;
        var button = node.button && typeof node.button === 'object' ? node.button : null;
        if (button === null || button.enabled === false || !Array.isArray(button.buttons)) return;
        var visible = button.buttons.filter(function (entry) { return entry && typeof entry.name === 'string' && entry.visible !== false; });
        if (visible.length === 0) return;
        result[node.id] = visible.map(function (entry) {
          return { button_id: buttonEventId(node.id, entry.name), button_name: entry.name };
        });
      });
    });
    return result;
  };

  // 脚本按钮（JSR 快速回复栏的可观察面）：容器 iframe 上报按钮列表，宿主渲染
  // 在「卡脚本」tab；没有容器时仍维持一份 iframe 内存列表，读取结果一致。
  var scriptButtons = [];
  function normalizeScriptButtons(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(function (button) { return button && typeof button === 'object' && typeof button.name === 'string' && button.name !== ''; })
      .map(function (button) {
        return Object.assign({}, button, { visible: button.visible !== false });
      });
  }
  function syncNodeButtons(id, buttons) {
    var node = findScriptNodeById(mutableScriptTree('character'), id);
    if (node === null) node = findScriptNodeById(currentScriptTrees(), id);
    if (node === null) return;
    node.button = { enabled: true, buttons: clone(buttons) };
  }
  function syncNodeInfo(id, info) {
    var node = findScriptNodeById(mutableScriptTree('character'), id);
    if (node === null) node = findScriptNodeById(currentScriptTrees(), id);
    if (node === null) return;
    node.info = info;
  }
  function syncOwnNodeButtons() {
    syncNodeButtons(scriptId, scriptButtons);
  }
  function broadcastScriptButtonsFor(id, buttons) {
    try {
      realParent.postMessage({
        type: HELPER_BUTTONS_MESSAGE,
        token: token,
        scriptId: id,
        buttons: buttons.map(function (button) {
          return { name: button.name, visible: button.visible !== false, event: buttonEventId(id, button.name) };
        }),
      }, '*');
    } catch (error) {
      console.warn('[TavernHelper] script button broadcast failed', error);
    }
  }
  window.getScriptButtons = function () { return clone(scriptButtons); };
  function broadcastScriptButtons() {
    broadcastScriptButtonsFor(window.getScriptId(), scriptButtons);
  }
  window.replaceScriptButtons = function (buttons) {
    scriptButtons = normalizeScriptButtons(buttons);
    broadcastScriptButtons();
    syncOwnNodeButtons();
    persistOwnScriptPatch({ buttons: scriptButtons });
  };
  window.updateScriptButtonsWith = function (updater) {
    if (typeof updater !== 'function') throw new Error('DSH-SoulMojito: updateScriptButtonsWith requires a function');
    var next = updater(clone(scriptButtons));
    window.replaceScriptButtons(next);
    return clone(scriptButtons);
  };
  window.appendInexistentScriptButtons = function (buttons) {
    var existing = new Set(scriptButtons.map(function (button) { return button.name; }));
    var next = clone(scriptButtons);
    normalizeScriptButtons(buttons).forEach(function (button) {
      if (!existing.has(button.name)) {
        existing.add(button.name);
        next.push(button);
      }
    });
    window.replaceScriptButtons(next);
  };

  // triggerSlash：只接不与宿主生成循环冲突的命令子集（变量/分支/发送/裁剪/正则）。
  // /trigger、/regenerate、/stop 会由服务端解释器明确报错（生成归宿主 AgentLoop）。
  window.triggerSlash = function (command) {
    return call('slash', { command: String(command) }).then(function (value) { return value.output; });
  };
  window.triggerSlashWithResult = window.triggerSlash;

  // JSR 生成桥（2026-10-22）：示例卡3 的 React 游戏前端启动时把
  // TavernHelper.generate 当作运行时连接器的硬门槛，缺失会直接 throw
  // [silly] TavernHelper is unavailable in production runtime.。生成由插件
  // Node 侧代理卡内配置的 OpenAI 兼容 API（custom_api），iframe 只拿到最终文本；
  // API Key 不写入快照、不回传、不落日志。
  function generationIdOf(config) {
    if (config && typeof config.generation_id === 'string' && config.generation_id !== '') return config.generation_id;
    return 'dsh-soulmojito-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  }
  function generationPromptMessages(config) {
    var messages = [];
    // injectPrompts() entries join every generation call from this iframe.
    (injectedPrompts || []).forEach(function (inject) {
      if (!inject || typeof inject.content !== 'string' || inject.content === '') return;
      if (inject.position === 'none') return;
      messages.push({ role: typeof inject.role === 'string' ? inject.role : 'system', content: inject.content });
    });
    var injects = config && Array.isArray(config.injects) ? config.injects : [];
    injects.forEach(function (inject) {
      if (!inject || typeof inject.content !== 'string' || inject.content === '') return;
      if (inject.position === 'none') return;
      messages.push({ role: typeof inject.role === 'string' ? inject.role : 'system', content: inject.content });
    });
    var prompts = config && config.overrides && config.overrides.chat_history
      && Array.isArray(config.overrides.chat_history.prompts)
      ? config.overrides.chat_history.prompts
      : [];
    prompts.forEach(function (prompt) {
      if (!prompt || typeof prompt.content !== 'string') return;
      messages.push({ role: typeof prompt.role === 'string' ? prompt.role : 'user', content: prompt.content });
    });
    if (config && typeof config.user_input === 'string' && config.user_input !== '') {
      messages.push({ role: 'user', content: config.user_input });
    }
    return messages;
  }
  window.getModelList = function (customApi) {
    var config = customApi && typeof customApi === 'object' ? customApi : {};
    return call('models', { apiurl: config.apiurl, key: config.key }).then(function (value) {
      return value && Array.isArray(value.models) ? value.models : [];
    });
  };
  window.generate = function (config) {
    var request = config && typeof config === 'object' ? config : {};
    var customApi = request.custom_api && typeof request.custom_api === 'object' ? request.custom_api : null;
    if (customApi === null || typeof customApi.apiurl !== 'string' || customApi.apiurl.trim() === '') {
      return Promise.reject(new Error('DSH-SoulMojito: TavernHelper.generate requires custom_api { apiurl, model }; configure an API source in the card first'));
    }
    var generationId = generationIdOf(request);
    if (request.generation_id === undefined) request.generation_id = generationId;
    var startedAt = Date.now();
    var model = generationModel(request);
    var notice = showGenerationStarted(request);
    emitLocally(HELPER_TAVERN_EVENTS.CHAT_COMPLETION_SETTINGS_READY, [{
      model: typeof customApi.model === 'string' ? customApi.model : '',
      messages: generationPromptMessages(request),
      stream: false,
    }]);
    return call('generate', { config: request }).then(function (value) {
      var text = value && typeof value.text === 'string' ? value.text : '';
      emitLocally(HELPER_IFRAME_EVENTS.GENERATION_ENDED, [text, generationId]);
      finishGenerationNotice(notice, 'success', 'SoulMojito 生成完成 · ' + model + ' · ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
      return text;
    }, function (error) {
      var message = error && error.message ? error.message : String(error);
      finishGenerationNotice(notice, 'error', 'SoulMojito 生成失败 · ' + model + ' · ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's\\n' + message);
      throw error;
    });
  };
  window.generateRaw = function (config) { return window.generate(config); };
  window.stopGenerationById = function () { return false; };
  window.stopAllGeneration = function () { return false; };

  // Regex compatibility (JSR signature): getTavernRegexes(option) returns the
  // ST-shaped entries synchronously; formatAsTavernRegexedString(text, source,
  // destination, option) applies matches locally. Regex writes stay panel-owned.
  window.getTavernRegexes = function (option) {
    var type = option && option.type && option.type !== 'in_use' ? option.type : 'global';
    return regexListForScope(type).map(toTavernRegex);
  };
  window.formatAsTavernRegexedString = function (text, source, destination, option) {
    var placement;
    var target;
    var settings;
    if (typeof source === 'number') {
      // Legacy two-argument form: (text, placementNumber, optionObject).
      placement = source;
      target = 'display';
      settings = destination && typeof destination === 'object' ? destination : (option && typeof option === 'object' ? option : {});
    } else {
      placement = placementOfSource(source);
      target = typeof destination === 'string' && destination !== '' ? destination : 'display';
      settings = option && typeof option === 'object' ? option : {};
    }
    var scripts = Array.isArray(settings.scripts) ? settings.scripts : regexListForScope(settings.scope);
    return applyRegexScriptsLocal(String(text), scripts, placement, target, settings.depth);
  };
  window.isCharacterTavernRegexesEnabled = function () { return true; };
  window.replaceTavernRegexes = function () {
    return Promise.reject(new Error('DSH-SoulMojito: regex writes are panel-owned; a sandboxed frontend cannot replace shared regex assets'));
  };
  window.updateTavernRegexesWith = function () {
    return Promise.reject(new Error('DSH-SoulMojito: regex writes are panel-owned; a sandboxed frontend cannot update shared regex assets'));
  };

  // builtin: host-free helpers only; DOM-bound members fail explicitly.
  window.builtin = window.builtin || {};
  window.builtin.renderMarkdown = function (text) {
    if (window.showdown && typeof window.showdown.Converter === 'function') {
      return new window.showdown.Converter().makeHtml(String(text));
    }
    return String(text);
  };
  window.builtin.copyText = function (text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(String(text));
    }
    return Promise.reject(new Error('DSH-SoulMojito: clipboard API is unavailable'));
  };
  window.builtin.parseRegexFromString = function (regex) {
    try { return new RegExp(String(regex)); } catch (_) { return null; }
  };
  window.builtin.uuidv4 = function () {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (character) {
      var random = Math.floor(Math.random() * 16);
      var value = character === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  };
  window.builtin.duringGenerating = function () { return false; };
  window.builtin.saveSettings = function () { return Promise.resolve(); };
  window.builtin.reloadChatWithoutEvents = function () { return call('snapshot').then(function () { return undefined; }); };
  window.builtin.reloadAndRenderChatWithoutEvents = window.builtin.reloadChatWithoutEvents;
  window.builtin.addOneMessage = function (message, options) {
    var entry = message && typeof message === 'object' ? message : {};
    var role = typeof entry.role === 'string' ? entry.role : (entry.is_user === true ? 'user' : 'assistant');
    var text = typeof entry.message === 'string' ? entry.message : (typeof entry.mes === 'string' ? entry.mes : '');
    var insertBefore = options && typeof options.insertBefore === 'number' ? options.insertBefore : 'end';
    return window.createChatMessages([{
      role: role,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      message: text,
      is_hidden: entry.is_hidden === true,
      data: entry.data && typeof entry.data === 'object' ? entry.data : undefined,
      extra: entry.extra && typeof entry.extra === 'object' ? entry.extra : undefined,
    }], { insert_before: insertBefore });
  };
  function unavailableBuiltin(name) {
    window.builtin[name] = function () {
      throw new Error('TavernHelper.builtin.' + name + ' is not available in the DSH-SoulMojito sandbox (host DOM/pipeline access)');
    };
  }
  ['reloadEditor', 'reloadEditorDebounced', 'renderPromptManager', 'renderPromptManagerDebounced', 'getImageTokenCost', 'getVideoTokenCost'].forEach(unavailableBuiltin);
  window.builtin.promptManager = new Proxy({}, {
    get: function () {
      throw new Error('TavernHelper.builtin.promptManager is not available in the DSH-SoulMojito sandbox (host prompt manager)');
    }
  });

  // Version probes: the helper level tracks the implemented API generation; the
  // ST probe stays semver-shaped but low so host-feature gates stay off.
  window.getTavernHelperVersion = function () { return HELPER_VERSION; };
  window.getTavernVersion = function () { return TAVERN_VERSION; };
  window.getFrontendVersion = window.getTavernHelperVersion;
  window.updateFrontendVersion = function () { return Promise.resolve(false); };
  window.updateTavernHelper = function () { return Promise.resolve(false); };
  window.getTavernHelperExtensionId = function () { return HELPER_EXTENSION_ID; };

  window.TavernHelper = {
    getVariables: window.getVariables,
    getAllVariables: window.getAllVariables,
    replaceVariables: window.replaceVariables,
    updateVariablesWith: window.updateVariablesWith,
    insertOrAssignVariables: window.insertOrAssignVariables,
    insertVariables: window.insertVariables,
    deleteVariable: window.deleteVariable,
    getChatMessages: window.getChatMessages,
    setChatMessages: window.setChatMessages,
    createChatMessages: window.createChatMessages,
    deleteChatMessages: window.deleteChatMessages,
    eventOn: window.eventOn,
    eventOnce: window.eventOnce,
    eventEmit: window.eventEmit,
    eventRemoveListener: window.eventRemoveListener,
    generate: window.generate,
    generateRaw: window.generateRaw,
    getModelList: window.getModelList,
    stopGenerationById: window.stopGenerationById,
    stopAllGeneration: window.stopAllGeneration,
    getScriptButtons: window.getScriptButtons,
    replaceScriptButtons: window.replaceScriptButtons,
    updateScriptButtonsWith: window.updateScriptButtonsWith,
    appendInexistentScriptButtons: window.appendInexistentScriptButtons,
    getButtonEvent: window.getButtonEvent,
    getPreset: window.getPreset,
    replacePreset: window.replacePreset,
    getPresetNames: window.getPresetNames,
    getLoadedPresetName: window.getLoadedPresetName,
    getCharData: window.getCharData,
    getTavernHelperVersion: window.getTavernHelperVersion,
    getTavernVersion: window.getTavernVersion,
  };
  // TavernHelper 命名空间下的同名事件函数（JSR 两种调用姿势并存：window 直连
  // 与 TavernHelper.*；前端两种都写，所以两个出口都给全）。
  window.TavernHelper.eventMakeFirst = window.eventMakeFirst;
  window.TavernHelper.eventMakeLast = window.eventMakeLast;
  window.TavernHelper.eventEmitAndWait = window.eventEmitAndWait;
  window.TavernHelper.eventClearEvent = window.eventClearEvent;
  window.TavernHelper.eventClearListener = window.eventClearListener;
  window.TavernHelper.eventClearAll = window.eventClearAll;
  window.TavernHelper.getLorebook = window.getLorebook;
  window.TavernHelper.getLorebookNames = window.getLorebookNames;
  window.TavernHelper.getWorldbook = window.getWorldbook;
  window.TavernHelper.getCharWorldbookNames = window.getCharWorldbookNames;
  window.TavernHelper.updateWorldbookWith = window.updateWorldbookWith;
  window.TavernHelper.getScriptTrees = window.getScriptTrees;
  window.TavernHelper.updateScriptTreesWith = window.updateScriptTreesWith;
  window.TavernHelper.getCharNames = window.getCharNames;
  window.TavernHelper.triggerSlash = window.triggerSlash;
  window.TavernHelper.getTavernRegexes = window.getTavernRegexes;
  window.TavernHelper.formatAsTavernRegexedString = window.formatAsTavernRegexedString;

  window.tavern_events = ${JSON.stringify(HELPER_TAVERN_EVENTS)};
  window.iframe_events = ${JSON.stringify(HELPER_IFRAME_EVENTS)};
  window.eventTypes = window.tavern_events;
  // ST-shaped event bus facade: cards that subscribe through
  // SillyTavern.getContext().eventSource reach the same local listener set.
  window.eventSource = {
    on: function (type, listener) { return window.eventOn(type, listener); },
    once: function (type, listener) { return window.eventOnce(type, listener); },
    removeListener: function (type, listener) { return window.eventRemoveListener(type, listener); },
    emit: function (type) { return window.eventEmit.apply(null, arguments); },
    emitAndWait: function (type) { return window.eventEmitAndWait.apply(null, arguments); },
    makeFirst: function (type, listener) { return window.eventMakeFirst(type, listener); },
    makeLast: function (type, listener) { return window.eventMakeLast(type, listener); },
    removeAllListeners: function (type) {
      if (type === undefined) window.eventClearAll();
      else window.eventClearEvent(type);
    },
  };

  /* ------------------------------ presets ------------------------------ */

  function presetValues() { return state.presets && state.presets.values ? state.presets.values : {}; }
  function activePresetName() { return state.presets && state.presets.active ? state.presets.active : 'in_use'; }
  function presetValue(name) {
    var key = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'in_use';
    var values = presetValues();
    if (values[key] !== undefined) return clone(values[key]);
    if (key === 'in_use' || key === activePresetName()) {
      var active = activePresetName();
      if (values[active] !== undefined) return clone(values[active]);
    }
    return null;
  }
  function presetPromptKind(prompt) {
    if (!prompt || typeof prompt !== 'object') return 'normal';
    if (prompt.marker === true) return 'placeholder';
    if (prompt.system_prompt === true) return 'system';
    return 'normal';
  }
  window.getPresetNames = function () { return clone((state.presets && state.presets.names) || []); };
  window.getProxyPresetNames = function () { return clone((state.presets && state.presets.names) || []); };
  window.getLoadedPresetName = function () { return activePresetName(); };
  window.getPreset = function (name) { return presetValue(name); };
  window.isPresetNormalPrompt = function (prompt) { return presetPromptKind(prompt) === 'normal'; };
  window.isPresetSystemPrompt = function (prompt) { return presetPromptKind(prompt) === 'system'; };
  window.isPresetPlaceholderPrompt = function (prompt) { return presetPromptKind(prompt) === 'placeholder'; };
  window.default_preset = { name: 'Default', prompts: [], prompt_order: [] };
  window.builtin_prompt_default_order = [
    'world_info_before', 'persona_description', 'char_description', 'char_personality',
    'scenario', 'world_info_after', 'dialogue_examples', 'chat_history', 'user_input',
  ];
  window.replacePreset = function (name, preset, options) {
    var key = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'in_use';
    var target = key === 'in_use' ? activePresetName() : key;
    var value = clone(preset && typeof preset === 'object' ? preset : {});
    return call('presets.put', { name: target, preset: value }).then(function () {
      if (!state.presets) state.presets = { names: [], active: null, values: {} };
      state.presets.values[target] = clone(value);
      if (state.presets.names.indexOf(target) === -1) state.presets.names.push(target);
      return undefined;
    });
  };
  window.updatePresetWith = function (name, updater, options) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updatePresetWith(name, updater) requires a function'));
    var key = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'in_use';
    var current = presetValue(key);
    if (current === null) return Promise.reject(new Error('DSH-SoulMojito: preset "' + key + '" is not loaded in this sandbox'));
    return Promise.resolve(updater(current)).then(function (next) {
      return window.replacePreset(key, next, options).then(function () { return next; });
    });
  };
  window.createPreset = function (name, preset) {
    var key = typeof name === 'string' ? name.trim() : '';
    if (key === '') return Promise.reject(new Error('DSH-SoulMojito: createPreset requires a name'));
    if (presetValue(key) !== null) return Promise.resolve(false);
    return window.replacePreset(key, preset).then(function () { return true; });
  };
  window.createOrReplacePreset = function (name, preset, options) {
    var key = typeof name === 'string' ? name.trim() : '';
    if (key === '') return Promise.reject(new Error('DSH-SoulMojito: createOrReplacePreset requires a name'));
    var existed = presetValue(key) !== null;
    return window.replacePreset(key, preset, options).then(function () { return !existed; });
  };

  /* ------------------------------ personas ------------------------------ */

  function personaValues() { return state.personas && state.personas.values ? state.personas.values : {}; }
  function personaValue(id) {
    var key = id === undefined || id === 'current' ? ((state.personas && state.personas.active) || '') : String(id);
    var values = personaValues();
    return values[key] === undefined ? null : clone(values[key]);
  }
  window.getPersonaNames = function () { return clone((state.personas && state.personas.names) || []); };
  window.getPersonaIds = function () { return clone((state.personas && state.personas.ids) || []); };
  window.getCurrentPersonaName = function () { return state.personas && state.personas.active ? state.personas.active : null; };
  window.getCurrentPersonaId = window.getCurrentPersonaName;
  window.getPersona = function (id) { return personaValue(id); };
  window.getPersonaAvatarPath = function (id) {
    var persona = personaValue(id);
    if (persona === null) return null;
    return typeof persona.avatar === 'string' && persona.avatar !== '' ? persona.avatar : null;
  };
  window.replacePersona = function (id, persona, options) {
    var key = id === undefined || id === 'current' ? window.getCurrentPersonaName() : String(id);
    if (key === null || key === '') return Promise.reject(new Error('DSH-SoulMojito: replacePersona requires a persona id or an active persona'));
    var value = clone(persona && typeof persona === 'object' ? persona : {});
    return call('personas.put', { name: key, persona: value }).then(function () {
      if (!state.personas) state.personas = { names: [], ids: [], active: null, values: {} };
      state.personas.values[key] = clone(value);
      if (state.personas.names.indexOf(key) === -1) {
        state.personas.names.push(key);
        state.personas.ids.push(key);
      }
      return undefined;
    });
  };
  window.updatePersonaWith = function (id, updater, options) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updatePersonaWith(id, updater) requires a function'));
    var current = personaValue(id);
    if (current === null) return Promise.reject(new Error('DSH-SoulMojito: persona "' + String(id) + '" is not loaded in this sandbox'));
    return Promise.resolve(updater(current)).then(function (next) {
      return window.replacePersona(id, next, options).then(function () { return next; });
    });
  };
  window.createPersona = function (name, persona, options) {
    var key = typeof name === 'string' ? name.trim() : '';
    if (key === '') return Promise.reject(new Error('DSH-SoulMojito: createPersona requires a name'));
    if (personaValue(key) !== null) return Promise.resolve(false);
    return window.replacePersona(key, Object.assign({ name: key }, persona || {}), options).then(function () { return true; });
  };
  window.createOrReplacePersona = function (name, persona, options) {
    var key = typeof name === 'string' ? name.trim() : '';
    if (key === '') return Promise.reject(new Error('DSH-SoulMojito: createOrReplacePersona requires a name'));
    var existed = personaValue(key) !== null;
    return window.replacePersona(key, Object.assign({ name: key }, persona || {}), options).then(function () { return !existed; });
  };

  /* ---------------------------- characters ---------------------------- */

  function characterRawData() {
    var data = state.characterData;
    if (!data || typeof data !== 'object') return null;
    return {
      name: typeof data.name === 'string' ? data.name : state.characterName,
      description: typeof data.description === 'string' ? data.description : '',
      personality: typeof data.personality === 'string' ? data.personality : '',
      scenario: typeof data.scenario === 'string' ? data.scenario : '',
      first_mes: typeof data.first_mes === 'string' ? data.first_mes : '',
      mes_example: typeof data.mes_example === 'string' ? data.mes_example : '',
      creatorcomment: typeof data.creator_notes === 'string' ? data.creator_notes : '',
      creator_notes: typeof data.creator_notes === 'string' ? data.creator_notes : '',
      creator: typeof data.creator === 'string' ? data.creator : '',
      character_version: typeof data.character_version === 'string' ? data.character_version : '',
      avatar: state.avatar || '',
      talkativeness: typeof data.talkativeness === 'string' ? data.talkativeness : '0.5',
      fav: data.fav === true,
      tags: Array.isArray(data.tags) ? clone(data.tags) : [],
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: clone(data),
      json_data: clone(data),
    };
  }
  window.getCharData = function (name) {
    var requested = name === undefined || name === 'current' ? state.characterName : String(name);
    if (requested !== state.characterName) return null;
    return characterRawData();
  };
  window.getCharacter = function (name) {
    var requested = name === undefined ? 'current' : String(name);
    return call('character.get', { name: requested }).then(function (value) {
      return value && value.character !== undefined ? value.character : null;
    });
  };
  window.getCurrentCharacterName = function () { return state.characterName === '' ? null : state.characterName; };
  window.getCurrentCharacterId = function () {
    if (!state.characters || !Array.isArray(state.characters.ids)) return null;
    return state.characterId === undefined ? null : String(state.characterId);
  };
  window.getCharAvatarPath = function (name) {
    var requested = name === undefined || name === 'current' ? state.characterName : String(name);
    if (requested !== state.characterName) return null;
    return state.avatar === '' ? null : state.avatar;
  };
  window.getChatHistoryBrief = function () {
    var messages = state.messages.map(function (message) {
      return {
        is_user: message.role === 'user',
        name: message.name,
        mes: message.message,
        extra: clone(message.extra),
      };
    });
    return Promise.resolve(messages);
  };
  window.getChatHistoryDetail = function () {
    return Promise.resolve({
      chat_metadata: clone(state.chatMetadata),
      messages: clone(state.messages),
    });
  };
  function RawCharacter(characterData) {
    this.character_data = characterData;
  }
  RawCharacter.find = function (query) {
    var name = query && typeof query === 'object' && query.name !== undefined ? query.name : 'current';
    return window.getCharData(name);
  };
  RawCharacter.findIndex = function (name) {
    var requested = name === undefined || name === 'current' ? state.characterName : String(name);
    var names = (state.characters && state.characters.names) || [];
    return names.indexOf(requested);
  };
  RawCharacter.prototype.getCardData = function () { return this.character_data; };
  RawCharacter.prototype.getAvatarId = function () {
    return this.character_data && typeof this.character_data.avatar === 'string' ? this.character_data.avatar : '';
  };
  RawCharacter.prototype.getRegexScripts = function () {
    return ((state.regexScripts && state.regexScripts.character) || []).map(toTavernRegex);
  };
  RawCharacter.prototype.getWorldbookNames = function () { return window.getCharWorldbookNames(); };
  window.RawCharacter = RawCharacter;

  /* --------------------------- EjsTemplate --------------------------- */

  window.EjsTemplate = {
    evalTemplate: function (code, context, options) {
      return call('template.render', {
        code: String(code),
        context: context && typeof context === 'object' ? context : {},
      }).then(function (value) { return value && typeof value.text === 'string' ? value.text : ''; });
    },
    prepareContext: function (context) {
      var env = Object.assign({}, context && typeof context === 'object' ? context : {});
      env.getvar = function (key) { return macroRead('chat', String(key)); };
      env.setvar = function (key, value) { macroWrite('chat', String(key), value); return value; };
      env.getglobalvar = function (key) { return macroRead('global', String(key)); };
      env.setglobalvar = function (key, value) { macroWrite('global', String(key), value); return value; };
      env.getwi = function (title, book) {
        var request = typeof book === 'string' && book.trim() !== '' ? { name: book.trim() } : {};
        return call('lorebook.get', request).then(function (value) {
          var entries = Array.isArray(value && value.entries) ? value.entries : [];
          var found = entries.filter(function (entry) {
            return (typeof title === 'number' && entry.uid === title)
              || (entry && typeof entry.comment === 'string' && entry.comment === String(title));
          })[0];
          return found && typeof found.content === 'string' ? found.content : '';
        });
      };
      env.getchar = function (name) { return window.getCharData(name); };
      env.getpreset = function (name) {
        var preset = presetValue('in_use');
        var prompts = preset && Array.isArray(preset.prompts) ? preset.prompts : [];
        var found = prompts.filter(function (prompt) { return prompt && prompt.name === name; })[0];
        return found ? { name: name, content: String(found.content || '') } : null;
      };
      return env;
    },
    getFeatures: function () {
      return {
        enabled: true,
        generate_enabled: false,
        generate_loader_enabled: false,
        inject_loader_enabled: false,
        render_enabled: false,
        render_loader_enabled: false,
        code_blocks_enabled: false,
        raw_message_evaluation_enabled: false,
        filter_message_enabled: false,
        depth_limit: 0,
        autosave_enabled: false,
        preload_worldinfo_enabled: false,
        with_context_disabled: true,
        debug_enabled: false,
        invert_enabled: false,
        compile_workers: false,
        sandbox: true,
      };
    },
  };

  /* ---------------------- extension management ---------------------- */

  window.isAdmin = function () { return false; };
  window.getExtensionType = function (extensionId) {
    return String(extensionId) === HELPER_EXTENSION_ID ? 'local' : null;
  };
  window.isInstalledExtension = function (extensionId) {
    return String(extensionId) === HELPER_EXTENSION_ID;
  };
  window.getExtensionStatus = function (extensionId) {
    if (String(extensionId) !== HELPER_EXTENSION_ID) return Promise.resolve(null);
    return Promise.resolve({
      current_branch_name: '',
      current_commit_hash: '',
      is_up_to_date: true,
      remote_url: '',
    });
  };

  /* ------------------------- globals / prompts ------------------------- */

  window.initializeGlobal = function (name, value) {
    if (typeof name !== 'string' || name === '') throw new Error('DSH-SoulMojito: initializeGlobal requires a name');
    if (name in window && window[name] !== undefined) return;
    Object.defineProperty(window, name, { value: value, writable: true, configurable: true });
  };
  window.waitGlobalInitialized = function (name) {
    var key = String(name);
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      var check = function () {
        if (key in window && window[key] !== undefined) {
          resolve(window[key]);
          return;
        }
        attempts += 1;
        if (attempts > 150) {
          reject(new Error('DSH-SoulMojito: global "' + key + '" was not initialized within 15s'));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  };
  var injectedPrompts = [];
  window.injectPrompts = function (prompts) {
    var list = Array.isArray(prompts) ? prompts : [prompts];
    var ids = list.map(function (prompt) {
      var entry = Object.assign({}, prompt && typeof prompt === 'object' ? prompt : {});
      entry.id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : 'inject-' + Math.random().toString(36).slice(2);
      injectedPrompts.push(entry);
      return entry.id;
    });
    return {
      uninject: function () {
        injectedPrompts = injectedPrompts.filter(function (entry) { return ids.indexOf(entry.id) === -1; });
      },
    };
  };
  window.uninjectPrompts = function (ids) {
    var wanted = (Array.isArray(ids) ? ids : [ids]).map(String);
    injectedPrompts = injectedPrompts.filter(function (entry) { return wanted.indexOf(String(entry.id)) === -1; });
  };

  // Formatting for display: macros → display regex → markdown. Host DOM access
  // (retrieveDisplayedMessage / refreshOneMessage) is outside the sandbox.
  window.formatAsDisplayedMessage = function (text, option) {
    var depth = option && typeof option.depth === 'number' ? option.depth : 0;
    var expanded = expandMacros(String(text));
    var regexed = applyRegexScriptsLocal(expanded, regexListForScope(), 2, 'display', depth);
    return window.builtin.renderMarkdown(regexed);
  };

  // Audio slash commands (the JSR audioEnable family) map onto the audio channels.
  window.audioEnable = function (enabled, type) {
    window.setAudioSettings(type || 'bgm', { enabled: enabled !== false });
  };
  window.audioImport = function (urls, type) {
    var list = (Array.isArray(urls) ? urls : [urls]).map(function (url) {
      return typeof url === 'string' ? { url: url } : url;
    }).filter(function (entry) { return entry && typeof entry.url === 'string' && entry.url !== ''; });
    window.appendAudioList(type || 'bgm', list);
  };
  window.audioMode = function (mode, type) {
    window.setAudioSettings(type || 'bgm', { mode: mode });
  };
  window.audioPlay = function (url, type) {
    var channel = type || 'bgm';
    if (typeof url === 'string' && url !== '') {
      window.playAudio(channel, { url: url });
      return;
    }
    var list = window.getAudioList(channel);
    if (list.length > 0) window.playAudio(channel, list[0]);
  };
  window.audioSelect = function (title, type) {
    var channel = type || 'bgm';
    var found = window.getAudioList(channel).filter(function (entry) { return entry.title === String(title); })[0];
    if (found) window.playAudio(channel, found);
  };

  function unavailableSurface(name, reason) {
    window[name] = function () {
      throw new Error('TavernHelper.' + name + ' is not available in the DSH-SoulMojito sandbox: ' + reason);
    };
  }
  unavailableSurface('createCharacter', 'character-card assets are panel/Agent-owned');
  unavailableSurface('createOrReplaceCharacter', 'character-card assets are panel/Agent-owned');
  unavailableSurface('deleteCharacter', 'character-card assets are panel/Agent-owned');
  unavailableSurface('replaceCharacter', 'character-card assets are panel/Agent-owned');
  unavailableSurface('updateCharacterWith', 'character-card assets are panel/Agent-owned');
  unavailableSurface('deletePersona', 'persona assets are panel-owned');
  unavailableSurface('deletePreset', 'preset assets are panel-owned');
  unavailableSurface('renamePreset', 'preset assets are panel-owned');
  unavailableSurface('loadPreset', 'preset activation is panel-owned');
  unavailableSurface('setPreset', 'preset activation is panel-owned');
  unavailableSurface('installExtension', 'extensions cannot be installed from a sandboxed frontend');
  unavailableSurface('uninstallExtension', 'extensions cannot be uninstalled from a sandboxed frontend');
  unavailableSurface('reinstallExtension', 'extensions cannot be reinstalled from a sandboxed frontend');
  unavailableSurface('updateExtension', 'extensions cannot be updated from a sandboxed frontend');
  unavailableSurface('importRawCharacter', 'character-card assets are panel/Agent-owned');
  unavailableSurface('importRawChat', 'chat files are host-owned');
  unavailableSurface('importRawPreset', 'preset assets are panel-owned');
  unavailableSurface('importRawTavernRegex', 'regex assets are panel-owned');
  unavailableSurface('importRawWorldbook', 'world-book assets are panel/Agent-owned; use createWorldbook for a session copy');
  unavailableSurface('rebindGlobalWorldbooks', 'world-book bindings are panel-owned');
  unavailableSurface('rebindCharWorldbooks', 'world-book bindings are panel-owned');
  unavailableSurface('rebindChatWorldbook', 'world-book bindings are panel-owned; use setChatLorebook for the chat copy');
  unavailableSurface('setCurrentCharLorebooks', 'world-book bindings are panel-owned');
  unavailableSurface('retrieveDisplayedMessage', 'host message DOM is outside the sandbox');
  unavailableSurface('refreshOneMessage', 'host message DOM is outside the sandbox');

  // Publish the full JSR surface on both outlets. window[name] stays the source
  // of truth so card code that feature-detects on window and TavernHelper
  // observes the same function object.
  window.TavernHelper = window.TavernHelper || {};
  for (var surfaceIndex = 0; surfaceIndex < HELPER_SURFACE.length; surfaceIndex++) {
    var surfaceName = HELPER_SURFACE[surfaceIndex];
    if (window[surfaceName] !== undefined) window.TavernHelper[surfaceName] = window[surfaceName];
  }
  window.TavernHelper.Mvu = window.Mvu;
  window.TavernHelper.toastr = window.toastr;
  window.TavernHelper.eventSource = window.eventSource;
  window.TavernHelper.EjsTemplate = window.EjsTemplate;
  window.TavernHelper.addEventListener = window.eventOn;
  window.TavernHelper.removeEventListener = window.eventRemoveListener;


  // iframe-local settings objects MagVarUpdate reads directly.
  window.__dshTavernExtensionSettings = window.__dshTavernExtensionSettings || {};
  window.__dshTavernChatCompletionSettings = window.__dshTavernChatCompletionSettings || {};

  // ST-shaped chat view for cards that read SillyTavern.getContext().chat
  // (mes / is_user / is_system / swipes) instead of TavernHelper messages.
  function stChatMessage(message, index) {
    var data = message && message.data && typeof message.data === 'object' ? message.data : {};
    var text = message && typeof message.message === 'string' ? message.message : '';
    return {
      name: message && typeof message.name === 'string' ? message.name : '',
      is_user: message && message.role === 'user',
      is_system: message && (message.role === 'system' || message.is_hidden === true),
      send_date: '',
      mes: text,
      message: text,
      data: clone(data),
      variables: clone(data),
      extra: clone(message && message.extra && typeof message.extra === 'object' ? message.extra : {}),
      swipe_id: message && typeof message.swipe_id === 'number' ? message.swipe_id : 0,
      swipes: message && Array.isArray(message.swipes) && message.swipes.length > 0 ? clone(message.swipes) : [text],
      mesid: index,
    };
  }
  function stChat() { return state.messages.map(stChatMessage); }

  window.SillyTavern = {
    get chat() { return stChat(); },
    get chatMetadata() { return state.chatMetadata; },
    get characters() { var current = window.getCharData('current'); return current ? [current] : []; },
    get characterId() { return String(state.characterId === undefined ? 0 : state.characterId); },
    get name1() { return state.userName; },
    get name2() { return state.characterName; },
    get eventSource() { return window.eventSource; },
    get eventTypes() { return window.tavern_events; },
    get extensionSettings() { return window.__dshTavernExtensionSettings; },
    get chatCompletionSettings() { return window.__dshTavernChatCompletionSettings; },
    // MagVarUpdate's settings store and MVU panel read these objects directly.
    // They are iframe-local; the plugin's own settings live in state.json.
    // MagVarUpdate constructs '_.debounce(SillyTavern.saveChat, 1000)' at module
    // load. The helper RPC already persists variables/messages, so this is a
    // promise-shaped no-op rather than a missing function (which would throw
    // "Expected a function" before MVU can initialize).
    saveChat: function () { return Promise.resolve(); },
    saveSettingsDebounced: function () {},
    saveMetadata: function () { return Promise.resolve(); },
    getRequestHeaders: function () { return {}; },
    getCurrentLocale: function () {
      return typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language
        : 'en';
    },
    getChatCompletionModel: function () { return ''; },
    registerMacro: window.registerMacroLike || function () {},
    unregisterMacro: window.unregisterMacroLike || function () {},
    registerFunctionTool: function () {},
    unregisterFunctionTool: function () {},
    ToolManager: {
      isToolCallingSupported: function () { return false; },
    },
    // MagVarUpdate's character-settings override reads the card's world book
    // through SillyTavern.loadWorldInfo(name) and expects { entries: { uid: entry } }.
    // Read-only: the session copy/base asset is resolved by getWorldbook.
    loadWorldInfo: function (name) {
      return window.getWorldbook(name).then(function (entries) {
        var mapped = {};
        (Array.isArray(entries) ? entries : []).forEach(function (entry, index) {
          var uid = entry && entry.uid !== undefined ? entry.uid : index;
          mapped[String(uid)] = entry;
        });
        return { entries: mapped };
      });
    },
    getContext: function () {
      return {
        chatId: state.chatId,
        chat: stChat(),
        chat_metadata: state.chatMetadata,
        name1: state.userName,
        name2: state.characterName,
        characterId: String(state.characterId === undefined ? 0 : state.characterId),
        characters: window.SillyTavern.characters,
        eventSource: window.eventSource,
        eventTypes: window.tavern_events,
        extensionSettings: window.SillyTavern.extensionSettings,
        chatCompletionSettings: window.SillyTavern.chatCompletionSettings,
        maxContext: 0,
        getRequestHeaders: window.SillyTavern.getRequestHeaders,
        saveChat: window.SillyTavern.saveChat,
        saveMetadata: window.SillyTavern.saveMetadata,
        saveSettingsDebounced: window.SillyTavern.saveSettingsDebounced,
        getCurrentChatId: function () { return state.chatId; },
        getCharacterCardFields: function () {
          var data = state.characterData || {};
          return {
            description: typeof data.description === 'string' ? data.description : '',
            personality: typeof data.personality === 'string' ? data.personality : '',
            scenario: typeof data.scenario === 'string' ? data.scenario : '',
            mesExamples: typeof data.mes_example === 'string'
              ? data.mes_example
              : (typeof data.mesExamples === 'string' ? data.mesExamples : ''),
          };
        },
      };
    },
    getCurrentChatId: function () { return state.chatId; },
    POPUP_TYPE: { CONFIRM: 'confirm', INPUT: 'input', DISPLAY: 'display', TEXT: 'text' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: 0 },
    callGenericPopup: function (text, type, defaultValue, options) {
      var message = String(text == null ? '' : text);
      if (type === 'confirm') {
        return window.confirm(message) ? window.SillyTavern.POPUP_RESULT.AFFIRMATIVE : window.SillyTavern.POPUP_RESULT.CANCELLED;
      }
      if (type === 'input') {
        var result = window.prompt(message, defaultValue == null ? '' : String(defaultValue));
        return result === null ? window.SillyTavern.POPUP_RESULT.CANCELLED : result;
      }
      window.alert(message);
      return window.SillyTavern.POPUP_RESULT.AFFIRMATIVE;
    },
  };
  window.TavernHelper.SillyTavern = window.SillyTavern;
  window.TavernHelper.Mvu = window.Mvu;

  // window.parent / window.top facade（2026-10-20 卡兼容）：JSR 同源模型下卡代码
  // 直接读 parent.document 的 #send_textarea/#send_but。沙箱里这两个对象不可
  // 访问，buildFrontendDocument 已把 window.parent 改写到这里；同时兜底
  // defineProperty，覆盖没被改写的裸访问。真实 parent 先存到 realParent，
  // postMessage 仍走真实通道。
  var fakeComposerText = '';
  var fakeTextarea = {
    value: '',
    disabled: false,
    readOnly: false,
    style: {},
    focus: function () {},
    blur: function () {},
    select: function () {},
    setSelectionRange: function () {},
    getAttribute: function () { return null; },
    setAttribute: function () {},
    dispatchEvent: function (event) {
      if (event && event.type === 'input') {
        fakeComposerText = String(this.value || '');
        call('composer.fill', { text: fakeComposerText }).catch(function (error) {
          console.error('[composer] fill failed', error);
          showToast('error', '自动填入输入框失败：' + (error && error.message ? error.message : String(error)));
          try { navigator.clipboard.writeText(fakeComposerText); } catch (_) {}
        });
      }
      return true;
    }
  };
  var fakeSendButton = {
    disabled: false,
    style: {},
    getAttribute: function () { return null; },
    setAttribute: function () {},
    click: function () {
      if (fakeComposerText === '' && fakeTextarea.value) fakeComposerText = String(fakeTextarea.value);
      call('composer.send', { text: fakeComposerText }).catch(function (error) {
        console.error('[composer] send failed', error);
        showToast('error', '自动发送失败：' + (error && error.message ? error.message : String(error)) + '（已尝试复制到剪贴板）');
        try { navigator.clipboard.writeText(fakeComposerText); } catch (_) {}
      });
    }
  };
  // window.top / window.parent are rewritten to this host, and JSR floating
  // panels do hud_win = window.top; hud_doc = hud_win.document. A stub document
  // (body: null, getElementById missing) crashes those panels, so the facade
  // delegates everything to the real iframe document. Only the two host-composer
  // selectors stay faked: they are the historical parent.document contract.
  var documentFacade = {
    // 卡前端同时存在两条老路径：querySelector('#send_textarea') 和
    // getElementById('send_textarea')（示例卡2 的前端 store 用后者）。
    // 两条都必须落到宿主输入面 shim，否则选项/发送按钮会报「找不到输入框」。
    getElementById: function (id) {
      if (id === 'send_textarea') return fakeTextarea;
      if (id === 'send_but') return fakeSendButton;
      return document.getElementById(id);
    },
    createElement: function (tag, options) { return options === undefined ? document.createElement(tag) : document.createElement(tag, options); },
    createElementNS: function (namespace, tag) { return document.createElementNS(namespace, tag); },
    createTextNode: function (text) { return document.createTextNode(text); },
    querySelector: function (selector) {
      if (selector === '#send_textarea') return fakeTextarea;
      if (selector === '#send_but') return fakeSendButton;
      return document.querySelector(selector);
    },
    querySelectorAll: function (selector) { return document.querySelectorAll(selector); },
    addEventListener: function () { return document.addEventListener.apply(document, arguments); },
    removeEventListener: function () { return document.removeEventListener.apply(document, arguments); },
    get head() { return document.head; },
    get body() { return document.body; },
    get documentElement() { return document.documentElement; },
    get activeElement() { return document.activeElement; }
  };
  ${storageSources.indexedDb}

  var host = {
    Mvu: window.Mvu,
    toastr: window.toastr,
    SillyTavern: window.SillyTavern,
    TavernHelper: window.TavernHelper,
    document: documentFacade,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    postMessage: function () { return realParent.postMessage.apply(realParent, arguments); },
    addEventListener: function () { return window.addEventListener.apply(window, arguments); },
    removeEventListener: function () { return window.removeEventListener.apply(window, arguments); },
    dispatchEvent: function (event) { return window.dispatchEvent(event); },
    // Viewport metrics for floating panels (positioning / drag / mobile checks).
    get innerWidth() { return window.innerWidth; },
    get innerHeight() { return window.innerHeight; },
    get devicePixelRatio() { return window.devicePixelRatio; },
    get visualViewport() { return window.visualViewport; },
    matchMedia: function (query) { return window.matchMedia(query); },
    getComputedStyle: function (element, pseudo) {
      return pseudo === undefined ? window.getComputedStyle(element) : window.getComputedStyle(element, pseudo);
    },
    requestAnimationFrame: function (callback) { return window.requestAnimationFrame(callback); },
    cancelAnimationFrame: function (handle) { return window.cancelAnimationFrame(handle); },
    getVariables: window.getVariables,
    getAllVariables: window.getAllVariables,
    replaceVariables: window.replaceVariables,
    updateVariablesWith: window.updateVariablesWith,
    insertOrAssignVariables: window.insertOrAssignVariables,
    insertVariables: window.insertVariables,
    deleteVariable: window.deleteVariable,
    getChatMessages: window.getChatMessages,
    setChatMessages: window.setChatMessages,
    createChatMessages: window.createChatMessages,
    deleteChatMessages: window.deleteChatMessages,
    getLastMessageId: window.getLastMessageId,
    getCurrentMessageId: window.getCurrentMessageId,
    eventOn: window.eventOn,
    eventOnce: window.eventOnce,
    eventEmit: window.eventEmit,
    eventRemoveListener: window.eventRemoveListener,
    getLorebook: window.getLorebook,
    getWorldbook: window.getWorldbook,
    getCharWorldbookNames: window.getCharWorldbookNames,
    updateWorldbookWith: window.updateWorldbookWith,
    getScriptTrees: window.getScriptTrees,
    updateScriptTreesWith: window.updateScriptTreesWith,
    getCharNames: window.getCharNames,
    triggerSlash: window.triggerSlash,
    getScriptButtons: window.getScriptButtons,
    replaceScriptButtons: window.replaceScriptButtons,
    updateScriptButtonsWith: window.updateScriptButtonsWith,
    appendInexistentScriptButtons: window.appendInexistentScriptButtons,
    getButtonEvent: window.getButtonEvent,
    getPreset: window.getPreset,
    replacePreset: window.replacePreset,
    getPresetNames: window.getPresetNames,
    getLoadedPresetName: window.getLoadedPresetName,
    getCharData: window.getCharData,
    generate: window.generate,
    generateRaw: window.generateRaw,
    getModelList: window.getModelList,
    stopGenerationById: window.stopGenerationById,
    stopAllGeneration: window.stopAllGeneration,
    getTavernHelperVersion: window.getTavernHelperVersion,
    getTavernVersion: window.getTavernVersion,
    errorCatched: window.errorCatched,
    playAudio: window.playAudio,
    pauseAudio: window.pauseAudio,
    getAudioList: window.getAudioList,
    replaceAudioList: window.replaceAudioList,
    appendAudioList: window.appendAudioList,
    getAudioSettings: window.getAudioSettings,
    setAudioSettings: window.setAudioSettings,
    getCurrentAudio: window.getCurrentAudio,
    _: window._,
    $: window.$,
    jQuery: window.jQuery,
    showdown: window.showdown,
    get z() { return window.z; },
    get Vue() { return window.Vue; },
    get YAML() { return window.YAML; },
    localStorage: window.__dshTavernStorage,
    sessionStorage: window.__dshTavernSessionStorage,
    // Host-realm bootstrap used by card scripts that create a postMessage
    // function through 'window.top.Function'. CSP allows
    // eval, and the function still runs inside this sandbox, not the host page.
    Function: window.Function,
    get window() { return host; },
    get parent() { return host; },
    get top() { return host; }
  };
  // Fallback for browser globals a card reachable through 'window.top' expects
  // (URL, Blob, MutationObserver, setTimeout, ...). Unknown members resolve to
  // this iframe's own window, never to the real host page.
  if (typeof Proxy === 'function') {
    host = new Proxy(host, {
      get: function (target, property) {
        if (property in target) return target[property];
        var value = window[property];
        if (typeof value === 'function' && property !== 'Function' && property !== 'eval') return value.bind(window);
        return value;
      },
      has: function (target, property) {
        return property in target || property in window;
      }
    });
  }
  // 共享前端模式（2026-10-23）：自动运行把多段脚本放进同一个美化前端文档，
  // 但 JSR 的脚本容器按脚本归属信息/按钮。每段脚本在模块顶部绑定这里返回的
  // scope，裸调用 getScriptId/getScriptInfo/getScriptButtons 即可拿到自己的
  // 节点；事件仍走同一个 window 的总线，保持脚本间通信。
  function createScriptScope(identity) {
    var id = identity !== null && typeof identity === 'object' ? String(identity.scriptId || '') : '';
    var scopedName = identity !== null && typeof identity === 'object' ? String(identity.scriptName || '') : '';
    var scopedInfo = identity !== null && typeof identity === 'object' ? String(identity.scriptInfo || '') : '';
    var buttons = [];
    var buttonsTouched = false;
    var infoTouched = false;
    function ownNode() { return findScriptNodeById(scriptTreesOf('character'), id); }
    function withScriptScope(option) {
      if (option && typeof option === 'object' && option.type === 'script') {
        return Object.assign({}, option, { __scriptId: id });
      }
      return option;
    }
    function hydrateButtons() {
      if (buttonsTouched) return;
      var node = ownNode();
      if (node !== null && node.button && Array.isArray(node.button.buttons)) {
        buttons = normalizeScriptButtons(node.button.buttons);
      }
    }
    function replaceButtons(list) {
      buttons = normalizeScriptButtons(list);
      buttonsTouched = true;
      broadcastScriptButtonsFor(id, buttons);
      syncNodeButtons(id, buttons);
      persistScriptPatch(id, { buttons: buttons });
    }
    var scope = {
      getScriptId: function () { return id; },
      getScriptName: function () {
        var node = ownNode();
        if (node !== null && typeof node.name === 'string' && node.name !== '') return node.name;
        return scopedName;
      },
      getScriptInfo: function () {
        if (infoTouched) return scopedInfo;
        var node = ownNode();
        if (node !== null && typeof node.info === 'string' && node.info !== '') return node.info;
        return scopedInfo;
      },
      replaceScriptInfo: function (info) {
        scopedInfo = String(info === undefined || info === null ? '' : info);
        infoTouched = true;
        syncNodeInfo(id, scopedInfo);
        persistScriptPatch(id, { info: scopedInfo });
      },
      getIframeName: function () {
        return id === '' ? 'TH-message-' + currentMessageId : 'TH-script-' + id;
      },
      getMessageId: function (iframeName) {
        if (iframeName === scope.getIframeName()) return currentMessageId;
        throw new Error('DSH-SoulMojito: iframe "' + String(iframeName) + '" is not registered in this document');
      },
      getButtonEvent: function (name) { return buttonEventId(id, name); },
      eventOnButton: function (name, listener) { return window.eventOn(buttonEventId(id, name), listener); },
      // Script-scope variables are per script in JSR; the shared document needs
      // the explicit owner id so two scripts do not read/write one bucket.
      getVariables: function (option) { return window.getVariables(withScriptScope(option)); },
      getAllVariables: function () { return window.getAllVariables({ type: 'script', __scriptId: id }); },
      replaceVariables: function (variables, option) { return window.replaceVariables(variables, withScriptScope(option)); },
      updateVariablesWith: function (updater, option) { return window.updateVariablesWith(updater, withScriptScope(option)); },
      insertOrAssignVariables: function (variables, option) { return window.insertOrAssignVariables(variables, withScriptScope(option)); },
      insertVariables: function (variables, option) { return window.insertVariables(variables, withScriptScope(option)); },
      deleteVariable: function (variablePath, option) { return window.deleteVariable(variablePath, withScriptScope(option)); },
      getScriptButtons: function () { hydrateButtons(); return clone(buttons); },
      replaceScriptButtons: replaceButtons,
      updateScriptButtonsWith: function (updater) {
        if (typeof updater !== 'function') throw new Error('DSH-SoulMojito: updateScriptButtonsWith requires a function');
        hydrateButtons();
        var next = updater(clone(buttons));
        replaceButtons(next);
        return clone(buttons);
      },
      appendInexistentScriptButtons: function (list) {
        hydrateButtons();
        var existing = new Set(buttons.map(function (button) { return button.name; }));
        var next = clone(buttons);
        normalizeScriptButtons(list).forEach(function (button) {
          if (!existing.has(button.name)) {
            existing.add(button.name);
            next.push(button);
          }
        });
        replaceButtons(next);
      }
    };
    return scope;
  }
  window.__dshTavernScriptScope = createScriptScope;
  window.__dshTavernHost = host;
  try { Object.defineProperty(window, 'parent', { value: host, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'top', { value: host, configurable: true }); } catch (_) {}
})();`
}
