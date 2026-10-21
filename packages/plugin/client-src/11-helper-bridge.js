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
    ]
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

    function frontendHelperScript(token, messageId) {
      return `(function () {
  var token = ${JSON.stringify(token)};
  var currentMessageId = ${JSON.stringify(typeof messageId === 'number' ? messageId : -1)};
  var realParent = window.parent;
  var requestId = 0;
  var pending = new Map();
  var listeners = new Map();
  var lastMvuStatJson = '';
  var state = {
    characterName: '', userName: 'User', chatId: '', chatMetadata: {},
    messages: [], variables: { global: {}, chat: {}, message: {}, character: {} },
    characterData: null,
  };

  function call(op, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'helper-' + (++requestId);
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ type: ${JSON.stringify(HELPER_MESSAGE)}, token: token, id: id, op: op, payload: payload || {} }, '*');
    });
  }

  // 沙箱无 same-origin：原生 localStorage/sessionStorage 访问即抛 SecurityError。
  // 卡前端用它们做表单自动保存/签名恢复；给一份 iframe 内存实现，页面重载即失，
  // 但不会让初始化中断。
  function createMemoryStorage() {
    var data = {};
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, String(key)) ? data[String(key)] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[String(key)]; },
      clear: function () { data = {}; },
      key: function (index) { return Object.keys(data)[index] || null; },
      get length() { return Object.keys(data).length; }
    };
  }
  window.__dshTavernStorage = createMemoryStorage();
  window.__dshTavernSessionStorage = createMemoryStorage();
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
    }
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
    return message && message.data ? message.data : {};
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

  function applySnapshot(snapshot) {
    state.characterName = snapshot.characterName || state.characterName;
    state.userName = snapshot.userName || state.userName;
    state.chatId = snapshot.chatId || state.chatId;
    state.chatMetadata = snapshot.chatMetadata || {};
    state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    state.variables = snapshot.variables || state.variables;
    state.characterData = snapshot.characterData || null;
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
        return Promise.reject(new Error('DSH-SoulMojito: Mvu.replaceMvuData expects an object'));
      }
      var index = type === 'message' ? messageIndex(target.message_id) : undefined;
      if (type === 'message') {
        var message = messageAt(index);
        if (message) message.data = Object.assign({}, message.data || {}, { stat_data: clone(stat) });
      }
      if (state.variables.chat) state.variables.chat.stat_data = clone(stat);
      dispatchMvu(stat);
      return call('mvu.replace', { statData: stat, messageId: index }).then(function (value) {
        if (value && value.stat_data !== undefined) {
          if (state.variables.chat) state.variables.chat.stat_data = clone(value.stat_data);
          dispatchMvu(value.stat_data);
        }
        return { stat_data: value && value.stat_data !== undefined ? value.stat_data : clone(stat) };
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

  // triggerSlash：只接不与宿主生成循环冲突的命令子集（变量/分支/发送/裁剪/正则）。
  // /trigger、/regenerate、/stop 会由服务端解释器明确报错（生成归宿主 AgentLoop）。
  window.triggerSlash = function (command) {
    return call('slash', { command: String(command) }).then(function (value) { return value.output; });
  };

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
  window.getTavernHelperVersion = function () { return 'dsh-soulmojito'; };
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
  window.TavernHelper.getCharNames = window.getCharNames;
  window.TavernHelper.triggerSlash = window.triggerSlash;
  window.TavernHelper.getTavernRegexes = window.getTavernRegexes;
  window.TavernHelper.formatAsTavernRegexedString = window.formatAsTavernRegexedString;

  window.tavern_events = ${JSON.stringify(HELPER_TAVERN_EVENTS)};
  window.iframe_events = ${JSON.stringify(HELPER_IFRAME_EVENTS)};
  // TavernHelper 的全局事件函数（JSR 把 eventOn 等挂在 window 直连面）。
  window.getButtonEvent = function (name) { return 'tavern-helper-button-' + String(name); };
  window.getScriptId = function () { return 'dsh-soulmojito-frontend'; };
  window.waitGlobalInitialized = function (name) { return Promise.resolve(window[name]); };
  window.TavernHelper.addEventListener = window.eventOn;
  window.TavernHelper.removeEventListener = window.eventRemoveListener;

  window.SillyTavern = {
    getContext: function () {
      return {
        chatId: state.chatId,
        chat: state.messages,
        chat_metadata: state.chatMetadata,
        name1: state.userName,
        name2: state.characterName,
        characterId: 0,
        characters: state.characterData ? [state.characterData] : [],
        getCharacterCardFields: function () {
          return { description: '', personality: '', scenario: '', mesExamples: '' };
        },
      };
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
    click: function () {
      if (fakeComposerText === '' && fakeTextarea.value) fakeComposerText = String(fakeTextarea.value);
      call('composer.send', { text: fakeComposerText }).catch(function (error) {
        console.error('[composer] send failed', error);
        showToast('error', '自动发送失败：' + (error && error.message ? error.message : String(error)) + '（已尝试复制到剪贴板）');
        try { navigator.clipboard.writeText(fakeComposerText); } catch (_) {}
      });
    }
  };
  var fakeDocument = {
    querySelector: function (selector) {
      if (selector === '#send_textarea') return fakeTextarea;
      if (selector === '#send_but') return fakeSendButton;
      return null;
    },
    querySelectorAll: function () { return []; },
    body: null,
    documentElement: null
  };
  var host = {
    Mvu: window.Mvu,
    toastr: window.toastr,
    SillyTavern: window.SillyTavern,
    TavernHelper: window.TavernHelper,
    document: fakeDocument,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    postMessage: function () { return realParent.postMessage.apply(realParent, arguments); },
    addEventListener: function () { return window.addEventListener.apply(window, arguments); },
    removeEventListener: function () { return window.removeEventListener.apply(window, arguments); },
    dispatchEvent: function (event) { return window.dispatchEvent(event); },
    getVariables: window.getVariables,
    replaceVariables: window.replaceVariables,
    getChatMessages: window.getChatMessages,
    getLastMessageId: window.getLastMessageId,
    getCurrentMessageId: window.getCurrentMessageId,
    getLorebook: window.getLorebook,
    getWorldbook: window.getWorldbook,
    getCharNames: window.getCharNames,
    triggerSlash: window.triggerSlash,
    _: window._,
    $: window.$,
    jQuery: window.jQuery,
    showdown: window.showdown,
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
    }
