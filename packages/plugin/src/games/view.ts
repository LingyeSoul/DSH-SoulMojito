/**
 * 游戏视图服务（提案 0018 §4.4，P0 的 HTML 面）。
 *
 * `GET games/:gid/view/:sid` 返回游戏包的 view.html，服务端注入：
 * - 游戏桥脚本（本文件 gameBridgeScript）：token 从 location.search 读、
 *   监听下行 `dsh-tavern:game-state`（token 对账）、提供上行
 *   `dsh-tavern:game-action` 的发送面；
 * - CSP meta + console reporter + 视口脚本 + vh 改写 + 高度上报——全部复用
 *   mods/http.ts 的 renderModHtmlDocument 管线（不新写第二套）。
 *
 * token 语义（§4.4）：per-mount token 由宿主 GameSurface（P1 客户端）生成并
 * 经 URL 查询段带入；宿主在上行 game-action 时校验 token 与 event.source
 * （镜像 main.js 的 mod-request 纪律）。服务端不掌握挂载期 token，无需也
 * 不做服务端 token 签发。
 *
 * 兼容性说明：参照包（五子棋）的 view.html 自行监听 message 事件——注入的
 * 桥脚本与视图自身的监听互不冲突（同一窗口的多个 message 监听器都能收到）；
 * 桥脚本额外暴露 window.dshTavernGame 便捷面（onState/state/send），新视图
 * 二选一。
 */

import { MOD_HTML_DEFAULT_CSP, renderModHtmlDocument } from '../mods/http.js'

/** 下行全量状态投递（§3.3 协议第一条；v1 无增量）。 */
export const GAME_STATE_MESSAGE = 'dsh-tavern:game-state'
/** 上行人类落子（§3.3 协议第二条；合法性由 Node 侧引擎终审）。 */
export const GAME_ACTION_MESSAGE = 'dsh-tavern:game-action'

/** 注入的桥脚本：token 自读 + game-state 监听 + game-action 上行便捷面。 */
export function gameBridgeScript(): string {
  return `(function () {
  var token = '';
  try { token = new URLSearchParams(location.search).get('token') || ''; } catch (_) { return; }
  if (token === '') return;
  var latest = null;
  var subs = [];
  var notify = function (payload) {
    for (var index = 0; index < subs.length; index += 1) { try { subs[index](payload); } catch (_) {} }
  };
  window.dshTavernGame = {
    onState: function (callback) {
      subs.push(callback);
      if (latest !== null) { try { callback(latest); } catch (_) {} }
      return function () {
        var index = subs.indexOf(callback);
        if (index >= 0) subs.splice(index, 1);
      };
    },
    state: function () { return latest; },
    send: function (action) {
      try { parent.postMessage({ type: ${JSON.stringify(GAME_ACTION_MESSAGE)}, token: token, action: action }, '*'); } catch (_) {}
    },
  };
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(GAME_STATE_MESSAGE)} || data.token !== token) return;
    latest = data;
    notify(data);
  });
})();`
}

/** 组装最终文档：桥脚本注入 <head> 最前 → renderModHtmlDocument（CSP+标准件）。 */
export function renderGameViewDocument(viewHtml: string): string {
  const bridge = `<script>${gameBridgeScript()}</script>`
  const document = String(viewHtml ?? '')
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(document)
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length
    return renderModHtmlDocument(`${document.slice(0, at)}${bridge}${document.slice(at)}`, MOD_HTML_DEFAULT_CSP)
  }
  if (/<html(?:\s[^>]*)?>/i.test(document)) {
    return renderModHtmlDocument(document.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${bridge}</head>`), MOD_HTML_DEFAULT_CSP)
  }
  return renderModHtmlDocument(`<!doctype html><html><head>${bridge}</head><body>${document}</body></html>`, MOD_HTML_DEFAULT_CSP)
}
