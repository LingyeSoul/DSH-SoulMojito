    // ── 酒馆助手兼容层（2026-10-20）────────────────────────────────────────
    // 用户需求：美化前端要深度兼容酒馆助手的常见行为（浅克隆参考
    // JS-Slash-Runner 的可观察面）。JSR 用同源 iframe + 直拷 parent API；
    // 本插件坚持沙箱（allow-scripts、无 same-origin、CSP connect-src 'none'），
    // 因此把 TavernHelper 的形状在 iframe 内重建，所有读写经 token 校验的
    // postMessage RPC 交给宿主代理，再到 POST /helper。iframe 永远拿不到
    // 宿主对象，也拿不到别的聊天：character/chatId 由宿主按会话绑定注入。
    //
    // 覆盖范围（诚实清单）：
    // - 变量：getVariables / replaceVariables / updateVariablesWith /
    //   insertOrAssignVariables / insertVariables / deleteVariable（global、
    //   chat、message 可写；character 只读）；
    // - 楼层：getChatMessages / setChatMessages / createChatMessages /
    //   deleteChatMessages / getLastMessageId；
    // - 事件：eventOn / eventOnce / eventEmit / eventRemoveListener /
    //   eventClearEvent / eventClearListener / eventClearAll（iframe 内广播，
    //   pagehide 自动注销）；
    // - SillyTavern.getContext() 的最小只读面；
    // - lodash / jQuery 由 CSP 白名单里的 jsdelivr 提供（JSR 自带同款库）。
    // 不支持：生成控制（generate/trigger/regenerate）、世界书写入、角色卡写入、
    // 脚本/preset 变量——调用即抛明确错误，不静默 no-op。
    const HELPER_MESSAGE = 'dsh-soulmojito:helper'
    const HELPER_RESULT_MESSAGE = 'dsh-soulmojito:helper-result'
    const HELPER_SNAPSHOT_MESSAGE = 'dsh-soulmojito:helper-snapshot'
    const HELPER_EVENT_MESSAGE = 'dsh-soulmojito:helper-event'
    const HELPER_LIBRARIES = [
      'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
      'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
      // bundle 版的 showdown 暴露全局 showdown，供 builtin.renderMarkdown 使用。
      'https://cdn.jsdelivr.net/npm/showdown@2.1.0/dist/showdown.min.js',
      // JSR 的消息 iframe 在卡代码之前固定加载 Vue 运行时与 Vue Router；Vue 单文件
      // 组件 bundle 常把 `vue` 标成 externals 后读全局 `Vue`（示例卡2 的 Vue 前端
      // 就是这种构建）。版本对齐卡构建的 3.5.x，避免 runtime 与编译器产物错位。
      'https://cdn.jsdelivr.net/npm/vue@3.5.40/dist/vue.runtime.global.prod.min.js',
      'https://cdn.jsdelivr.net/npm/vue-router@4.6.4/dist/vue-router.global.prod.min.js',
    ]
    // Zod 4 没有 UMD 构建；与 JSR 一样提供模块命名空间全局 `z`（既支持 `z.object`，
    // 也支持 mvu_zod.js 依赖的 `z.z`）。用远端 ESM 而不是把 330KB 内联进每个
    // srcdoc；CDN 已在 CSP 白名单内。
    const HELPER_ZOD_MODULE = '<script type="module">'
      + "import * as z from 'https://cdn.jsdelivr.net/npm/zod@4.4.3/+esm';"
      + 'window.z = z;'
      + '</script>'
    // 酒馆事件名（JSR `tavern_events` 的可观测子集）：宿主侧只桥接得出真实
    // 信号的那几条——快照比对后发现楼数/内容变化时按这里广播。其余名字保留
    // 常量（前端 `eventOn(tavern_events.X, …)` 不会因 undefined 抛错），但不会
    // 有事件到达；不假装触发。
    const HELPER_TAVERN_EVENTS = {
      APP_READY: 'app_ready',
      MESSAGE_SENT: 'message_sent',
      MESSAGE_RECEIVED: 'message_received',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_DELETED: 'message_deleted',
      MESSAGE_UPDATED: 'message_updated',
      MESSAGE_SWIPED: 'message_swiped',
      CHAT_CHANGED: 'chat_id_changed',
      GENERATION_STARTED: 'generation_started',
      GENERATION_ENDED: 'generation_ended',
      // JSR 常见的「正文变化后重绘」信号。本插件没有真实 token 流，只在快照比对
      // 观测到新楼层/正文变化时用最终文本补发一次；名字保留，避免卡里的
      // `eventOn(tavern_events.STREAM_TOKEN_RECEIVED, …)` 注册成 undefined。
      STREAM_TOKEN_RECEIVED: 'stream_token_received',
      CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
      USER_MESSAGE_RENDERED: 'user_message_rendered',
      CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    }
    const HELPER_IFRAME_EVENTS = {
      MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
      MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
      GENERATION_REQUESTED: 'js_generation_requested',
      GENERATION_STARTED: 'js_generation_started',
      STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
      STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
      GENERATION_ENDED: 'js_generation_ended',
    }

    function serializeFrontendStorageSeed(storage) {
      const value = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {}
      return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
    }

    function frontendHelperScript(token, messageId, storage) {
      return `(function () {
  var token = ${JSON.stringify(token)};
  var currentMessageId = ${JSON.stringify(typeof messageId === 'number' ? messageId : -1)};
  var initialStorage = ${serializeFrontendStorageSeed(storage)};
  var realParent = window.parent;
  var requestId = 0;
  var pending = new Map();
  var listeners = new Map();
  var lastMvuStatJson = '';
  // JSR predefine.js sets these before card modules; Vue 3.5 runtime + Pinia read
  // them while mounting. The global production build normally hard-codes them,
  // but keeping the same observable window flags avoids version-specific warnings
  // and matches what card authors test against.
  window.__VUE_PROD_DEVTOOLS__ = true;
  window.__VUE_OPTIONS_API__ = true;
  window.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
  var state = {
    characterName: '', userName: 'User', chatId: '', chatMetadata: {},
    messages: [], variables: { global: {}, chat: {}, message: {}, character: {} },
    characterData: null,
    scriptTrees: null,
  };

  function call(op, payload, transfer) {
    return new Promise(function (resolve, reject) {
      var id = 'helper-' + (++requestId);
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ type: ${JSON.stringify(HELPER_MESSAGE)}, token: token, id: id, op: op, payload: payload || {} }, '*', Array.isArray(transfer) ? transfer : []);
    });
  }

  // 沙箱无 same-origin：原生 localStorage/sessionStorage 访问即抛 SecurityError。
  // localStorage 以宿主持久表播种（FrontendFrame 构建 srcdoc 前取回），写入
  // 200ms 合并后经 storage.set 写回；sessionStorage 保持 iframe 内存语义。
  function createMemoryStorage(seed, persistent) {
    var data = {};
    if (seed && typeof seed === 'object') {
      Object.keys(seed).forEach(function (key) {
        if (typeof seed[key] === 'string') data[key] = seed[key];
      });
    }
    var persistTimer = null;
    var persistFailed = false;
    function persist() {
      persistTimer = null;
      if (persistent !== true) return;
      call('storage.set', { storage: Object.assign({}, data) }).catch(function (error) {
        if (persistFailed) return;
        persistFailed = true;
        console.error('[TavernHelper] localStorage persist failed', error);
        showToast('error', 'localStorage 持久化失败：' + (error && error.message ? error.message : String(error)));
      });
    }
    function schedulePersist() {
      if (persistent !== true || persistTimer !== null) return;
      persistTimer = setTimeout(persist, 200);
    }
    addEventListener('pagehide', function () {
      if (persistTimer === null) return;
      clearTimeout(persistTimer);
      persist();
    });
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, String(key)) ? data[String(key)] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); schedulePersist(); },
      removeItem: function (key) { delete data[String(key)]; schedulePersist(); },
      clear: function () { data = {}; schedulePersist(); },
      key: function (index) { return Object.keys(data)[index] || null; },
      get length() { return Object.keys(data).length; }
    };
  }
  window.__dshTavernStorage = createMemoryStorage(initialStorage, true);
  window.__dshTavernSessionStorage = createMemoryStorage({}, false);
  try { Object.defineProperty(window, 'localStorage', { value: window.__dshTavernStorage, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'sessionStorage', { value: window.__dshTavernSessionStorage, configurable: true }); } catch (_) {}

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

  function scopeOf(option) {
    var type = option && option.type ? option.type : 'chat';
    if (type === 'global' || type === 'chat' || type === 'message' || type === 'character') return type;
    throw new Error('DSH-SoulMojito: variable scope "' + type + '" is not supported (global/chat/message/character)');
  }

  function messageIndex(messageId) {
    var last = state.messages.length - 1;
    var index = typeof messageId === 'number' ? messageId : last;
    if (index < 0) index = last + 1 + index;
    return index;
  }

  function variablesFor(option) {
    var scope = scopeOf(option);
    if (scope !== 'message') return state.variables[scope] || {};
    var index = messageIndex(option && option.message_id);
    var message = state.messages.filter(function (entry) { return entry.message_id === index; })[0];
    var data = message && message.data ? message.data : {};
    // MVU 卡首屏常先读 getVariables({ type: 'message' }) 判断 stat_data 是否
    // 就绪（示例卡2 的 index.ts 就卡在这一步）。新聊天的开场白楼层通常没有逐楼
    // 变量，而权威 stat_data 在 chat 作用域；读面按 Mvu.getMvuData 的同款语义
    // 回退，写面仍只写 message，第一次回写会自然把 stat_data 物化到该楼层。
    if (data && typeof data === 'object' && !Array.isArray(data) && data.stat_data === undefined) {
      var chatStat = state.variables.chat ? state.variables.chat.stat_data : undefined;
      if (chatStat !== undefined) return Object.assign({}, data, { stat_data: clone(chatStat) });
    }
    return data;
  }

  function rememberScope(option, next) {
    var scope = scopeOf(option);
    if (scope === 'message') return;
    state.variables[scope] = next;
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

  function showToast(kind, message) {
    try {
      var host = document.getElementById('dsh-tavern-toasts');
      if (!host) {
        host = document.createElement('div');
        host.id = 'dsh-tavern-toasts';
        host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-width:min(360px,80vw);pointer-events:none;font:13px/1.45 system-ui,sans-serif';
        (document.body || document.documentElement).appendChild(host);
      }
      var item = document.createElement('div');
      var color = kind === 'error' ? '#f7768e' : kind === 'warning' ? '#e0af68' : kind === 'success' ? '#9ece6a' : '#7aa2f7';
      item.style.cssText = 'pointer-events:auto;background:#16161e;color:#c0caf5;border-left:3px solid ' + color + ';padding:8px 12px;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap';
      item.textContent = String(message);
      host.appendChild(item);
      setTimeout(function () { try { item.remove(); } catch (_) {} }, 3600);
    } catch (error) {
      console.error('[toastr] ' + String(message), error);
    }
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

  var lastDisabledNoticeAt = 0;
  // Disabled controls swallow the click event, so a card button such as the action
  // console's 必杀 (charge < 100) looks dead. Capture-phase pointer events explain
  // it without editing card HTML; pointerover is the fallback for engines that do
  // not deliver pointerdown on disabled controls.
  function noteDisabledControl(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var control = target.closest('button, [aria-disabled="true"]');
    if (!control) return;
    if (control.disabled !== true && control.getAttribute('aria-disabled') !== 'true') return;
    var now = Date.now();
    if (now - lastDisabledNoticeAt < 1500) return;
    lastDisabledNoticeAt = now;
    showToast('info', '该按钮当前不可用');
  }
  try {
    document.addEventListener('pointerdown', noteDisabledControl, true);
    document.addEventListener('pointerover', noteDisabledControl, true);
  } catch (_) {}

  function applySnapshot(snapshot) {
    state.characterName = snapshot.characterName || state.characterName;
    state.userName = snapshot.userName || state.userName;
    state.chatId = snapshot.chatId || state.chatId;
    state.chatMetadata = snapshot.chatMetadata || {};
    state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    state.variables = snapshot.variables || state.variables;
    state.characterData = snapshot.characterData || null;
    state.scriptTrees = Array.isArray(snapshot.scriptTrees) ? snapshot.scriptTrees : null;
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

  window.getVariables = function (option) { return clone(variablesFor(option)) || {}; };

  window.replaceVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var next = clone(variables) || {};
    rememberScope(target, next);
    return call('variables.replace', {
      scope: scopeOf(target),
      messageId: target.type === 'message' ? messageIndex(target.message_id) : undefined,
      variables: next,
    }).then(function (value) { rememberScope(target, value); return value; });
  };

  window.updateVariablesWith = function (updater, option) {
    var target = option || { type: 'chat' };
    var current = variablesFor(target);
    return Promise.resolve(updater(clone(current) || {})).then(function (next) {
      return window.replaceVariables(next || {}, target);
    });
  };

  window.insertOrAssignVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    Object.keys(variables || {}).forEach(function (key) { current[key] = clone(variables[key]); });
    return window.replaceVariables(current, target);
  };

  window.insertVariables = function (variables, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    Object.keys(variables || {}).forEach(function (key) {
      if (!(key in current)) current[key] = clone(variables[key]);
    });
    return window.replaceVariables(current, target);
  };

  window.deleteVariable = function (variablePath, option) {
    var target = option || { type: 'chat' };
    var current = clone(variablesFor(target)) || {};
    var deleteOccurred = unsetByPath(current, variablePath);
    return window.replaceVariables(current, target).then(function () {
      return { variables: current, delete_occurred: deleteOccurred };
    });
  };

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
  window.eventEmit = function (type) {
    return Promise.resolve(emitLocally(type, Array.prototype.slice.call(arguments, 1)));
  };
  window.eventEmitAndWait = function (type) {
    return emitLocally(type, Array.prototype.slice.call(arguments, 1));
  };
  window.eventOnButton = function (type, listener) { return window.eventOn(type, listener); };
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

  window.getLorebook = function (name) {
    return call('lorebook.get', { name: name }).then(function (value) { return value.entries; });
  };
  window.getWorldbook = window.getLorebook;
  window.getLorebookNames = function () {
    return call('lorebook.list', {}).then(function (value) { return value.names; });
  };
  window.getWorldbookNames = window.getLorebookNames;
  window.getGlobalWorldbookNames = function () {
    return call('lorebook.list', {}).then(function (value) { return value.active || []; });
  };
  window.getCharNames = function () {
    return call('character.list', {}).then(function (value) { return value.names; });
  };
  window.getCharacterNames = window.getCharNames;
  window.getChatWorldbookNames = window.getGlobalWorldbookNames;

  // 角色链接世界书（2026-10-21 会话副本）：getter 必须同步（GM 脚本不 await）。
  // 名字取 extensions.world，其次内嵌书 characterBook.name。
  function characterWorldbookName() {
    var data = state.characterData || {}, extensions = data.extensions || {};
    var world = typeof extensions.world === 'string' ? extensions.world.trim() : '';
    if (world !== '') return world;
    var embedded = data.characterBook && typeof data.characterBook.name === 'string' ? data.characterBook.name.trim() : '';
    return embedded !== '' ? embedded : null;
  }
  window.getCharWorldbookNames = function () { return { primary: characterWorldbookName(), additional: [] }; };
  // 世界书写入只落当前聊天的会话副本（服务端 lorebook.put 强制 chatId）；基础
  // worlds/<name>.json 与卡内 characterBook 永远不动。updater 在 iframe 内执行，
  // 只把结果 entries 发回宿主（函数不能过 postMessage）。
  window.updateWorldbookWith = function (name, updater) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updateWorldbookWith(name, updater) requires a function'));
    var bookName = typeof name === 'string' && name.trim() !== '' ? name.trim() : characterWorldbookName();
    if (bookName === null) return Promise.reject(new Error('DSH-SoulMojito: updateWorldbookWith requires a world book name (this character links no world)'));
    return window.getWorldbook(bookName)
      .then(function (entries) { return Promise.resolve(updater(entries)); })
      .then(function (updated) { return call('lorebook.put', { name: bookName, entries: updated }); })
      .then(function (value) { return value.entries; });
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
  function publishZodReady(trees) {
    var flat = flattenScriptTrees(trees);
    var found = null;
    for (var index = 0; index < flat.length; index++) {
      var entry = flat[index];
      if (!entry || typeof entry.content !== 'string') continue;
      var pattern = /__mgZodReady__\\s*=\\s*(\\{[^{}]*\\})/g;
      var match;
      // 取最后一次出现：GM 面板是在源码尾部注入新探针，旧探针可能仍在。
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
  window.getScriptTrees = function () { return clone(currentScriptTrees()); };
  // 先持久化再发布 ready：GM 面板把 updateScriptTreesWith 的 resolve 当作「已
  // 保存」。落盘失败必须拒绝并保留旧内存树，不能把半成品当成成功。
  window.updateScriptTreesWith = function (updater) {
    if (typeof updater !== 'function') return Promise.reject(new Error('DSH-SoulMojito: updateScriptTreesWith requires a function'));
    var draft = clone(currentScriptTrees());
    return Promise.resolve().then(function () {
      return updater(draft);
    }).then(function (next) {
      if (!Array.isArray(next)) throw new Error('DSH-SoulMojito: updateScriptTreesWith updater must return an array of script nodes');
      return call('scripts.put', { scriptTrees: next }).then(function (value) {
        scriptTrees = value && Array.isArray(value.scriptTrees) ? value.scriptTrees : next;
        scriptTreesLocallyWritten = true;
        publishZodReady(scriptTrees);
        return clone(scriptTrees);
      });
    });
  };

  // triggerSlash：只接不与宿主生成循环冲突的命令子集（变量/分支/发送/裁剪/正则）。
  // /trigger、/regenerate、/stop 会由服务端解释器明确报错（生成归宿主 AgentLoop）。
  window.triggerSlash = function (command) {
    return call('slash', { command: String(command) }).then(function (value) { return value.output; });
  };

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
    emitLocally(HELPER_TAVERN_EVENTS.CHAT_COMPLETION_SETTINGS_READY, [{
      model: typeof customApi.model === 'string' ? customApi.model : '',
      messages: generationPromptMessages(request),
      stream: false,
    }]);
    return call('generate', { config: request }).then(function (value) {
      var text = value && typeof value.text === 'string' ? value.text : '';
      emitLocally(HELPER_IFRAME_EVENTS.GENERATION_ENDED, [text, generationId]);
      return text;
    });
  };
  window.generateRaw = function (config) { return window.generate(config); };
  window.stopGenerationById = function () { return false; };
  window.stopAllGeneration = function () { return false; };

  // TavernHelper 的正则面（只读可观察语义）：getTavernRegexes 列出脚本，
  // formatAsTavernRegexedString 按 placement 应用。写面（replace/update）走
  // 面板与 Agent 工具，这里不给前端写口子。
  window.getTavernRegexes = function (option) {
    var settings = option || {};
    return call('regex.get', { scope: settings.scope || 'global' }).then(function (value) {
      var scripts = value.scripts || [];
      return settings.enabled_only ? scripts.filter(function (script) { return !script.disabled; }) : scripts;
    });
  };
  window.formatAsTavernRegexedString = function (text, placement, option) {
    var settings = option || {};
    var apply = function (scripts) {
      return call('regex.format', {
        text: String(text),
        placement: typeof placement === 'number' ? placement : 2,
        scripts: Array.isArray(scripts) ? scripts : undefined,
        depth: settings.depth,
      }).then(function (value) { return value.text; });
    };
    // 显式给脚本时直接应用（JSR 的调用姿势允许传入脚本集）；否则先取启用集。
    if (Array.isArray(settings.scripts)) return apply(settings.scripts);
    return window.getTavernRegexes({ enabled_only: true }).then(apply);
  };
  // builtin.renderMarkdown：showdown 已随库脚本加载；缺失时降级为纯文本，
  // 不假装渲染成功。
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
  window.substitudeMacros = function (text) { return String(text); };
  // JSR 4.8.2 is the compatibility level this shim targets. Cards such as
  // 示例卡3 gate their diagnostics on getTavernHelperVersion() >= 4.8.2; the
  // function is a capability probe, not the plugin version (the plugin version is
  // shown in the management panel). Unsupported JSR functions still throw.
  window.getTavernHelperVersion = function () { return '4.8.2'; };
  window.getTavernVersion = function () { return 'dsh-soulmojito'; };

  window.TavernHelper = {
    getVariables: window.getVariables,
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
  // TavernHelper 的全局事件函数（JSR 把 eventOn 等挂在 window 直连面）。
  // 脚本按钮（JSR 快速回复栏的可观察面）：本插件没有按钮栏，但 MVU 等常驻脚本
  // 会在启动时 get/replace/append 按钮。维持一份 iframe 内存列表，调用不中断；
  // 按钮不会渲染到宿主，读取结果仍是一致的。
  var scriptButtons = [];
  function normalizeScriptButtons(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(function (button) { return button && typeof button === 'object' && typeof button.name === 'string' && button.name !== ''; })
      .map(function (button) {
        return Object.assign({}, button, { visible: button.visible !== false });
      });
  }
  window.getScriptButtons = function () { return clone(scriptButtons); };
  window.replaceScriptButtons = function (buttons) { scriptButtons = normalizeScriptButtons(buttons); };
  window.updateScriptButtonsWith = function (updater) {
    if (typeof updater !== 'function') throw new Error('DSH-SoulMojito: updateScriptButtonsWith requires a function');
    var next = updater(clone(scriptButtons));
    scriptButtons = normalizeScriptButtons(next);
    return clone(scriptButtons);
  };
  window.appendInexistentScriptButtons = function (buttons) {
    var existing = new Set(scriptButtons.map(function (button) { return button.name; }));
    normalizeScriptButtons(buttons).forEach(function (button) {
      if (!existing.has(button.name)) {
        existing.add(button.name);
        scriptButtons.push(button);
      }
    });
  };
  window.getButtonEvent = function (name) { return 'tavern-helper-button-' + String(name); };

  // 预设 / 角色卡只读兼容面（2026-10-22）：示例卡3 的启动诊断会调用
  // getPreset('in_use') / getPreset('openai') 与 getCharData('current')。
  // JSR 的 getPreset 是同步的；预设写入在本插件属于受保护资产，前端只得到
  // iframe 内存覆盖，不写基础 preset 文件（诊断的「注入格式提示」因此只影响
  // 本次 iframe，不会污染资产）。
  var presetMemory = {};
  function presetKey(name) {
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'in_use';
  }
  window.getPreset = function (name) {
    var key = presetKey(name);
    return clone(presetMemory[key] || { name: key, prompts: [] });
  };
  window.replacePreset = function (name, preset) {
    var key = presetKey(name);
    presetMemory[key] = clone(preset && typeof preset === 'object' ? preset : { name: key, prompts: [] });
    return clone(presetMemory[key]);
  };
  window.getPresetNames = function () {
    var names = Object.keys(presetMemory);
    return names.length > 0 ? names : ['in_use'];
  };
  window.getLoadedPresetName = function () { return 'in_use'; };
  window.getCharData = function (name) {
    var data = state.characterData;
    if (!data) return null;
    if (name !== undefined && name !== 'current' && name !== state.characterName) return null;
    // JSR returns a v1CharData object: the V2 payload lives under .data, while
    // the top-level fields mirror it. Cards read getCharData('current').data.creator
    // / character_version / creator_notes (示例卡3 derives its asset-pack key there).
    return {
      name: typeof data.name === 'string' ? data.name : state.characterName,
      description: typeof data.description === 'string' ? data.description : '',
      personality: typeof data.personality === 'string' ? data.personality : '',
      scenario: typeof data.scenario === 'string' ? data.scenario : '',
      first_mes: typeof data.first_mes === 'string' ? data.first_mes : '',
      mes_example: typeof data.mes_example === 'string' ? data.mes_example : '',
      creatorcomment: typeof data.creator_notes === 'string' ? data.creator_notes : '',
      avatar: '',
      talkativeness: '0.5',
      fav: false,
      tags: Array.isArray(data.tags) ? clone(data.tags) : [],
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: clone(data),
    };
  };
  window.getScriptId = function () { return 'dsh-soulmojito-frontend'; };
  window.waitGlobalInitialized = function (name) { return Promise.resolve(window[name]); };
  window.TavernHelper.addEventListener = window.eventOn;
  window.TavernHelper.removeEventListener = window.eventRemoveListener;
  // These helpers are defined after the TavernHelper literal (script buttons /
  // presets / character data); publish them again so the namespace object is not
  // left with undefined properties. Card code reads TavernHelper.getPreset etc.
  // synchronously during startup diagnostics.
  window.TavernHelper.getScriptButtons = window.getScriptButtons;
  window.TavernHelper.replaceScriptButtons = window.replaceScriptButtons;
  window.TavernHelper.updateScriptButtonsWith = window.updateScriptButtonsWith;
  window.TavernHelper.appendInexistentScriptButtons = window.appendInexistentScriptButtons;
  window.TavernHelper.getButtonEvent = window.getButtonEvent;
  window.TavernHelper.getPreset = window.getPreset;
  window.TavernHelper.replacePreset = window.replacePreset;
  window.TavernHelper.getPresetNames = window.getPresetNames;
  window.TavernHelper.getLoadedPresetName = window.getLoadedPresetName;
  window.TavernHelper.getCharData = window.getCharData;

  window.SillyTavern = {
    getContext: function () {
      return {
        chatId: state.chatId,
        chat: state.messages,
        chat_metadata: state.chatMetadata,
        name1: state.userName,
        name2: state.characterName,
        characterId: 0,
        characters: window.getCharData('current') ? [window.getCharData('current')] : [],
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
  // 虚拟 IndexedDB（2026-10-22）：沙箱 opaque origin 拿不到真实 IndexedDB。
  // 这个垫片只实现卡常用的 open / createObjectStore / transaction / get / put /
  // delete / clear / deleteDatabase；记录体经宿主二进制路由按角色落盘，iframe
  // 不接触宿主 Origin、Cookie 或真实浏览器配额。
  function idbRequest() {
    return {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
  }
  function idbFire(request, result) {
    request.result = result;
    try { if (request.onsuccess) request.onsuccess({ target: request }); } catch (error) { console.error('[idb] onsuccess failed', error); }
  }
  function idbFail(request, error) {
    request.error = error;
    try { if (request.onerror) request.onerror({ target: request, error: error }); } catch (cause) { console.error('[idb] onerror failed', cause); }
  }
  function IdbDatabase(name) {
    var self = this;
    self.name = name;
    self.version = 0;
    self._stores = {};
    self._pending = [];
    self.objectStoreNames = {
      contains: function (storeName) { return Object.prototype.hasOwnProperty.call(self._stores, String(storeName)); },
      item: function (index) { return Object.keys(self._stores)[index] || null; },
      get length() { return Object.keys(self._stores).length; },
    };
  }
  IdbDatabase.prototype.createObjectStore = function (storeName, options) {
    var name = String(storeName);
    var keyPath = options && typeof options.keyPath === 'string' ? options.keyPath : '';
    this._stores[name] = { keyPath: keyPath };
    var dbName = this.name;
    var pending = call('idb.store.create', { db: dbName, store: name, keyPath: keyPath });
    this._pending.push(pending);
    return { name: name, keyPath: keyPath };
  };
  IdbDatabase.prototype.transaction = function (storeNames, mode) {
    return new IdbTransaction(this, storeNames, mode);
  };
  IdbDatabase.prototype.close = function () {};
  function IdbTransaction(db, storeNames, mode) {
    var self = this;
    self.db = db;
    self.mode = mode === 'readwrite' ? 'readwrite' : 'readonly';
    self.oncomplete = null;
    self.onerror = null;
    self.onabort = null;
    self.error = null;
    self._pending = [];
    self._settled = false;
    self._drainQueued = false;
    self._storeNames = Array.isArray(storeNames) ? storeNames.map(String) : [String(storeNames)];
    self._schedule();
  }
  IdbTransaction.prototype._schedule = function () {
    var self = this;
    if (self._drainQueued || self._settled) return;
    self._drainQueued = true;
    // A macrotask gives the synchronous transaction body (objectStore().get/put
    // in a row, or get().onsuccess -> put()) time to register requests. The
    // drain loop re-checks after each batch, so follow-up puts are awaited too.
    setTimeout(function () {
      self._drainQueued = false;
      self._drain();
    }, 0);
  };
  IdbTransaction.prototype._drain = function () {
    var self = this;
    if (self._settled) return;
    if (self._pending.length === 0) {
      self._complete();
      return;
    }
    var batch = self._pending;
    self._pending = [];
    Promise.allSettled(batch).then(function (results) {
      if (self._settled) return;
      var failure = results.filter(function (result) { return result.status === 'rejected'; })[0];
      if (failure !== undefined) {
        self.error = failure.reason;
        self._settled = true;
        try { if (self.onerror) self.onerror({ target: self, error: self.error }); } catch (error) { console.error('[idb] tx onerror failed', error); }
        try { if (self.onabort) self.onabort({ target: self }); } catch (error) { console.error('[idb] tx onabort failed', error); }
        return;
      }
      self._drain();
    });
  };
  IdbTransaction.prototype._complete = function () {
    if (this._settled) return;
    this._settled = true;
    try { if (this.oncomplete) this.oncomplete({ target: this }); } catch (error) { console.error('[idb] tx oncomplete failed', error); }
  };
  IdbTransaction.prototype._track = function (promise) {
    this._pending.push(promise);
    this._schedule();
  };
  IdbTransaction.prototype.objectStore = function (storeName) {
    return new IdbObjectStore(this, String(storeName));
  };
  function IdbObjectStore(transaction, name) {
    this.transaction = transaction;
    this.name = name;
    var descriptor = transaction.db._stores[name];
    this.keyPath = descriptor && typeof descriptor.keyPath === 'string' ? descriptor.keyPath : '';
  }
  IdbObjectStore.prototype.get = function (key) {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.get', { db: tx.db.name, store: this.name, key: key }).then(function (value) {
      var record = value && value.record !== undefined ? value.record : undefined;
      idbFire(request, record);
      return record;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.put = function (value) {
    var request = idbRequest();
    var tx = this.transaction;
    var record = value && typeof value === 'object' ? value : null;
    var bytes = record !== null ? record.bytes : null;
    if (ArrayBuffer.isView(bytes)) bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (!(bytes instanceof ArrayBuffer)) {
      var error = new Error('idb.put requires a record with an ArrayBuffer bytes field');
      idbFail(request, error);
      tx._track(Promise.reject(error));
      return request;
    }
    var key = record !== null ? record.key : undefined;
    var meta = {};
    if (record !== null) {
      Object.keys(record).forEach(function (name) {
        if (name !== 'bytes') meta[name] = clone(record[name]);
      });
    }
    var promise = call('idb.put', { db: tx.db.name, store: this.name, key: key, meta: meta, bytes: bytes }, [bytes]).then(function (result) {
      idbFire(request, key);
      return result;
    }, function (cause) {
      idbFail(request, cause);
      throw cause;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.delete = function (key) {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.delete', { db: tx.db.name, store: this.name, key: key }).then(function (result) {
      idbFire(request, undefined);
      return result;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.clear = function () {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.clear', { db: tx.db.name, store: this.name }).then(function (result) {
      idbFire(request, undefined);
      return result;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  var idbShim = {
    open: function (name, version) {
      var request = idbRequest();
      var db = new IdbDatabase(String(name));
      call('idb.open', { name: String(name), version: version }).then(function (value) {
        db.version = value && typeof value.version === 'number' ? value.version : 0;
        var stores = value && Array.isArray(value.stores) ? value.stores : [];
        stores.forEach(function (storeName) { db._stores[String(storeName)] = { keyPath: '' }; });
        var previousVersion = value && typeof value.previousVersion === 'number' ? value.previousVersion : 0;
        var requested = typeof version === 'number' && version > 0 ? version : 1;
        request.result = db;
        if (requested > previousVersion && request.onupgradeneeded) {
          try {
            request.onupgradeneeded({ target: request, oldVersion: previousVersion, newVersion: requested });
          } catch (error) {
            idbFail(request, error);
            return;
          }
        }
        Promise.all(db._pending).then(function () { idbFire(request, db); }, function (error) { idbFail(request, error); });
      }, function (error) { idbFail(request, error); });
      return request;
    },
    deleteDatabase: function (name) {
      var request = idbRequest();
      call('idb.delete-db', { db: String(name) }).then(function () { idbFire(request, undefined); }, function (error) { idbFail(request, error); });
      return request;
    },
  };
  try {
    Object.defineProperty(window, 'indexedDB', { value: idbShim, configurable: true });
  } catch (_) {
    try { window.indexedDB = idbShim; } catch (_) {}
  }

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
    sessionStorage: window.__dshTavernSessionStorage
  };
  window.__dshTavernHost = host;
  try { Object.defineProperty(window, 'parent', { value: host, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'top', { value: host, configurable: true }); } catch (_) {}
})();`
    }

    function helperLibraryTags() {
      return HELPER_LIBRARIES.map((url) => `<script src="${url}" crossorigin="anonymous"></script>`).join('')
        + HELPER_ZOD_MODULE
    }
