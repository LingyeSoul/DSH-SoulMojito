/**
 * 示例 Mod（提案 0015 P2 交付物）：管线 hook + Agent 工具 + 面板分区三件套。
 *
 * 演示的 P2 API 面：
 * - api.hooks.on('post-output')：模型输出原文的观察 hook（统计字数/回复数，
 *   落私有存储；不改写文本——观察位是 hook 最安全的用法示范）；
 * - api.tools.register：Agent 工具对（get/set mood），name 带 `<modId>_` 前缀，
 *   形状对齐宿主 tool() 工厂（parameters/output/execute）；
 * - manifest panel 声明 + api.http.route('GET','ui')：面板分区的 iframe 表面
 *   ——自包含 HTML（服务端注入 CSP meta，connect-src 'none'），经 postMessage
 *   数据桥取数（dsh-tavern:mod-request → 父页代理 → mod-response），高度上报
 *   走 dsh-tavern:frontend-height 协议（与美化前端 main.js 同款）。
 *
 * 它是 e2e（tavern-mods.spec）与 mod-loader gate 的夹具。
 */

const UI_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 12px; font: 13px/1.6 system-ui, sans-serif; color: #222; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  input[type=text] { flex: 1; min-width: 140px; padding: 5px 8px; border: 1px solid #bbb; border-radius: 6px; font: inherit; }
  button { padding: 5px 12px; border: 1px solid #888; border-radius: 6px; background: #f5f5f5; cursor: pointer; font: inherit; }
  button:disabled { opacity: .5; cursor: default; }
  dl { margin: 10px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
  dt { color: #666; } dd { margin: 0; overflow-wrap: anywhere; }
  .err { color: #b00; min-height: 18px; }
</style>
</head>
<body>
<h2>Mood Tracker</h2>
<div class="row">
  <input id="mood" type="text" placeholder="scene mood, e.g. tense">
  <button id="set">Set mood</button>
</div>
<p class="err" id="err"></p>
<dl id="stats"></dl>
<script>
(function () {
  'use strict';
  // token 从 iframe URL 查询段来（父页生成）；postMessage 回投时对账。
  var token = new URLSearchParams(location.search).get('token') || '';
  // 高度上报协议（与宿主美化前端同款）：ResizeObserver + load + resize。
  var report = function () {
    try {
      var root = document.documentElement;
      var body = document.body;
      var height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
      parent.postMessage({ type: 'dsh-tavern:frontend-height', token: token, height: height }, '*');
    } catch (_) {}
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  addEventListener('resize', report);
  setTimeout(report, 0);
  // postMessage 数据桥：mod UI 不能 fetch（CSP connect-src 'none'），一切取数
  // 经父页代理到本 Mod 的 HTTP 子路由。
  var nextId = 1;
  var pending = new Map();
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'dsh-tavern:mod-response' || data.token !== token) return;
    var waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    (data.ok ? waiter.resolve : waiter.reject)(data);
  });
  function request(method, path, body) {
    return new Promise(function (resolve, reject) {
      var id = 'req-' + nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ type: 'dsh-tavern:mod-request', token: token, id: id, req: { method: method, path: path, body: body } }, '*');
      setTimeout(function () {
        if (pending.delete(id)) reject({ error: 'bridge timeout' });
      }, 10000);
    });
  }
  var statsEl = document.getElementById('stats');
  var errEl = document.getElementById('err');
  var input = document.getElementById('mood');
  var button = document.getElementById('set');
  function render(body) {
    var entries = [
      ['Mood', body.mood || '—'],
      ['Set by', body.setBy || '—'],
      ['Replies observed', String(body.replyCount || 0)],
      ['Last reply length', String(body.lastReplyLength || 0)],
      ['Total characters', String(body.totalCharacters || 0)]
    ];
    statsEl.textContent = '';
    for (var index = 0; index < entries.length; index++) {
      var dt = document.createElement('dt');
      dt.textContent = entries[index][0];
      var dd = document.createElement('dd');
      dd.textContent = entries[index][1];
      statsEl.appendChild(dt);
      statsEl.appendChild(dd);
    }
    input.value = body.mood || '';
  }
  function refresh() {
    errEl.textContent = '';
    request('GET', 'stats').then(function (data) { render(data.body || {}); })
      .catch(function (data) { errEl.textContent = 'failed: ' + (data && data.error ? data.error : 'unknown'); });
  }
  button.addEventListener('click', function () {
    button.disabled = true;
    errEl.textContent = '';
    request('POST', 'mood', { mood: input.value.trim() }).then(function () { refresh(); })
      .catch(function (data) { errEl.textContent = 'failed: ' + (data && data.error ? data.error : 'unknown'); })
      .finally(function () { button.disabled = false; });
  });
  refresh();
})();
</script>
</body>
</html>
`

export async function setup(api) {
  let replyCount = Number((await api.storage.get('replyCount')) ?? 0)
  let totalCharacters = Number((await api.storage.get('totalCharacters')) ?? 0)
  let lastReplyLength = 0

  // 管线 hook：post-output（AI_OUTPUT regex 与输出渲染之前——mod 看到模型原文）。
  // 观察位示范：不改写文本，返回原值；统计落私有存储。失败/超时会按总线纪律
  // 降级跳过并计审计，不中断生成。
  const offHook = api.hooks.on('post-output', async (text, context) => {
    replyCount += 1
    lastReplyLength = text.length
    totalCharacters += text.length
    await api.storage.set('replyCount', replyCount)
    await api.storage.set('totalCharacters', totalCharacters)
    await api.storage.set('lastSeen', { character: context.character, chatId: context.chatId, at: context.phase })
    return text
  })

  // Agent 工具：形状对齐宿主 tool() 工厂；name 强制 <modId>_ 前缀（宿主查重）。
  const readMood = async () => ({
    mood: (await api.storage.get('mood')) ?? '',
    setBy: (await api.storage.get('moodBy')) ?? '',
    replyCount,
    lastReplyLength,
    totalCharacters,
  })
  const offGetTool = api.tools.register({
    name: 'dsh-tavern.mood-tracker_get_mood',
    description: 'Read the tracked scene mood and reply statistics recorded by the mood-tracker mod for this deployment.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => readMood(),
  })
  const offSetTool = api.tools.register({
    name: 'dsh-tavern.mood-tracker_set_mood',
    description: 'Set the scene mood tracked by the mood-tracker mod (a short phrase such as "tense" or "relieved").',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: 'Short mood phrase, capped at 80 characters.' },
      },
      required: ['mood'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const mood = String(args.mood ?? '').trim().slice(0, 80)
      if (mood === '') throw new Error('mood must be a non-empty phrase')
      await api.storage.set('mood', mood)
      await api.storage.set('moodBy', exec?.agent?.id ? `agent:${exec.agent.id}` : 'unknown')
      return { mood, ok: true }
    },
  })

  // HTTP 面：JSON 数据出口 + iframe 表面（GET ui 返回自包含 HTML）。
  api.http.route('GET', 'stats', async (_req, reply) => reply.json({ ok: true, ...(await readMood()) }))
  api.http.route('POST', 'mood', async (req, reply) => {
    const body = await req.json()
    const mood = String(body.mood ?? '').trim().slice(0, 80)
    if (mood === '') throw new Error('mood must be a non-empty phrase')
    await api.storage.set('mood', mood)
    await api.storage.set('moodBy', 'panel')
    reply.json({ ok: true, mood })
  })
  api.http.route('GET', 'ui', async (_req, reply) => reply.html(UI_PAGE))

  api.logger.info(`mood-tracker ready (api v${api.version})`)

  return async () => {
    offHook()
    offGetTool()
    offSetTool()
    await api.storage.set('disposed', true)
    api.logger.info('mood-tracker disposed')
  }
}
