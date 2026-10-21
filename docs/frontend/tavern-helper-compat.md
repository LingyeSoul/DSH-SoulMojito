# 美化前端 · 酒馆助手（Tavern-Helper）兼容性清单

> 面向**写美化前端的人**（人写，或让 AI 写）。本文是 `window.*` / `window.TavernHelper.*`
> 兼容面的**权威清单**：哪些能用、用到什么程度、哪些一定不能用、用了会怎样。
>
> - 实现：`packages/plugin/src/helper.ts`（服务端能力）+ `packages/plugin/client-src/11-helper-bridge.js`（iframe shim）
> - 决策：[`decisions/2026-10-20-frontend-helper-compat.md`](../../decisions/2026-10-20-frontend-helper-compat.md)
> - 参考对象：JS-Slash-Runner（Tavern-Helper v4.x，PolyForm NonCommercial）。
>   本文只对齐**可观察行为**；本插件不复刻它的同源无沙箱模型，也没有任何 JSR 源码拷贝。
>
> 图例：✅ 可用 · ⚠️ 可用但语义/范围不同 · ❌ 不提供 · 🧱 结构性不可用（沙箱决定）

---

## 0. 先读这一段：为什么不能"照抄 JSR 的写法"

JSR 的美化前端跑在**同源、无 sandbox、无 CSP** 的 iframe 里，`window.parent`
上的约 200 个 API 被直接拷进 iframe。本插件的 iframe 是：

```
sandbox="allow-scripts"        // 无 allow-same-origin
Content-Security-Policy: default-src 'none'; connect-src 'none'; frame-src 'none'
```

> 设置页的「允许美化前端加载外部资源」可以显式放开 `script-src` / `style-src`
> 的 HTTPS 通配与 `connect-src https:`（默认关闭，见 §3.3 与 §6 的标注）。

因此有一条**结构性的分界线**，任何兼容层都无法绕过：

| 你可能会写 | 在本插件里 |
|---|---|
| `window.parent.document` / `window.parent.fetch` | 🧱 跨域，直接被浏览器拒绝 |
| `fetch()` / `XMLHttpRequest` | 🧱 CSP `connect-src 'none'` 拦截（默认；设置页可显式放行 HTTPS） |
| `WebSocket`（`wss:`） | 🧱 CSP 拦截；放行外部资源也只覆盖 `https:`，不含 `wss:` |
| 嵌套 `<iframe>` | 🧱 CSP `frame-src 'none'` |
| `<script src="https://你的服务器/...">` | 🧱 CSP 只放行固定 CDN 白名单（设置页可显式放行任意 HTTPS） |
| `window.parent.SillyTavern` 直读 | 🧱 不存在；用本页的 `SillyTavern.getContext()` |

**所有宿主能力都走一条受校验的通道**：

```
你的前端  ──postMessage({token, op, payload})──▶  宿主插件
   ▲                                                   │
   └────── postMessage({token, id, ok, value}) ◀────────┘
```

- `token` 每个 iframe 独立；`event.source` 与你这个 iframe 不一致的消息直接丢弃。
- **身份由宿主决定**：`character` / `chatId` 取当前会话绑定，你的前端无法指定，
  也无法读到别的聊天。没有绑定（比如在设置面板里预览）时调用会得到
  `this frontend is not bound to a Tavern chat`。
- 每次写入成功后宿主会**重投快照**，所以你后续的同步 getter 读到的是新值。

---

## 1. 可用清单：变量

### 1.1 支持的变量作用域

| `type` | 读 | 写 | 存储位置 | 备注 |
|---|:--:|:--:|---|---|
| `'global'` | ✅ | ✅ | Tavern 状态 `scriptGlobals` | 所有聊天共享；随插件状态持久化 |
| `'chat'` | ✅ | ✅ | 聊天文件 `chat_metadata.variables` | AgentTavern 会话**同时**写 chat 作用域变量存储（见 §1.3） |
| `'message'` | ✅ | ✅ | 楼层的 `variables` 字段 | `message_id` 支持负数深度；越界会报错 |
| `'character'` | ✅ | ❌ | 角色卡 `extensions.variables` | 写入抛 `character variables are read-only in DSH-SoulMojito` |
| `'preset'` | ❌ | ❌ | — | 抛 `unsupported variable scope 'preset'` |
| `'script'` | ❌ | ❌ | — | 同上 |
| `'extension'` | ❌ | ❌ | — | 同上 |

不支持的作用域**同步抛错**，不是静默返回 `{}`——这样你在控制台能立刻看见。

### 1.2 函数表

| 函数 | 状态 | 语义与差异 |
|---|:--:|---|
| `getVariables(option)` | ✅ | 同步返回**快照副本**（你随便改不会影响宿主）。缺省 `{type:'chat'}` |
| `replaceVariables(vars, option?)` | ✅ | 整表替换，返回 `Promise<变量表>`。缺省 `{type:'chat'}` |
| `updateVariablesWith(fn, option?)` | ✅ | `fn` 可以是同步或 async；收到的是副本，返回新表 |
| `insertOrAssignVariables(vars, option?)` | ✅ | 顶层键合并（浅合并，与 JSR 一致） |
| `insertVariables(vars, option?)` | ✅ | 只补缺失的顶层键 |
| `deleteVariable(path, option?)` | ✅ | 点分路径删除，返回 `{variables, delete_occurred}` |
| `registerVariableSchema` | ❌ | 本插件的变量结构守卫是 MVU 的 `$schema`（服务端确定性执行），不接受前端注册 |

```js
// 聊天变量
const vars = getVariables({ type: 'chat' });
if ((vars.好感度 ?? 0) < 60) {
  await replaceVariables({ ...vars, 好感度: 60 }, { type: 'chat' });
}

// 最新楼层变量
const stage = getVariables({ type: 'message', message_id: -1 }).阶段;

// 全局变量（lodash 已内置）
const globals = getVariables({ type: 'global' });
if (_.has(globals, '图鉴.已解锁')) { /* ... */ }
```

### 1.3 AgentTavern 会话的"双写"，以及它会带来什么

AgentTavern 架构下，聊天变量有**两个读者**：

1. `chat_metadata.variables` —— ST 兼容的展示树（`$` 前缀键也在这里）；
2. chat 作用域变量存储 —— MVU 状态栏、`variable_*` Agent 工具、模板渲染的权威源。

你调用 `replaceVariables({type:'chat'})` 时，宿主会把两份一起更新：

- `$` 开头的键**只**写展示树（这是 JSR 的约定：`$` 前缀不进提示词）；
- 其余能通过变量名规则（字母/数字/`_.-`，≤64 字符）的**叶子**写进 chat 作用域；
- 之前存在、这次没出现的 chat 作用域变量会被删除（整表替换语义）。

所以你**不需要**为了 MVU 再写一遍；也不要指望"只改展示树、不动 MVU"。

---

## 2. 可用清单：楼层消息

### 2.1 消息形状

```ts
type ChatMessage = {
  message_id: number
  name: string
  role: 'system' | 'assistant' | 'user'
  is_hidden: boolean
  message: string        // 正文
  data: Record<string, any>   // 楼层变量（MVU/前端共用；注意 JSR 也叫楼层变量）
  extra: Record<string, any>  // 其它附加数据（含 reasoning 等）
}
```

`include_swipes: true` 时额外有：

```ts
type ChatMessageSwiped = ChatMessage & {
  swipe_id: number
  swipes: string[]
  swipes_data: Record<string, any>[]
  swipes_info: Record<string, any>[]
}
```

### 2.2 函数表

| 函数 | 状态 | 语义与差异 |
|---|:--:|---|
| `getChatMessages(range, option?)` | ✅ | `range`：`10` / `'10'` / `-1` / `'0-10'` / `'0-{{lastMessageId}}'`。返回按 `message_id` 升序。每条的 `data.stat_data` 是**该楼层**的 MVU 快照（Agent 模式由投影器写入；ST 模式回退聊天变量） |
| `getLastMessageId()` | ✅ | 同步，最新楼层号；空聊天为 `-1` |
| `getCurrentMessageId()` | ✅ | 当前 iframe 所属楼层号；侧栏 / MVU 状态模板为 `-1`（最新） |
| `setChatMessages(list, option?)` | ✅ | 可改 `message` / `name` / `role` / `is_hidden` / `data` / `extra` / `swipes` / `swipe_id` / `swipes_info` |
| `createChatMessages(list, option?)` | ✅ | `insert_before`（或旧名 `insert_at`）；`'end'` 或数字（支持负数） |
| `deleteChatMessages(ids, option?)` | ✅ | 支持负数；重复 id 会去重；返回后快照已同步 |
| `rotateChatMessages(begin, middle, end)` | ❌ | 未实现。需要时用 `getChatMessages` + `deleteChatMessages` + `createChatMessages` 组合，注意引用会变 |

`option.refresh` 会被接收但**不做任何事**：本插件的段落渲染由宿主驱动，
你的前端无法强制别的楼层重新渲染。改了当前楼层数据后，请自己重绘。

```js
// 读出全部楼层，按角色过滤
const messages = getChatMessages('0-{{lastMessageId}}', { role: 'assistant' });

// 修改最新楼层的变量（不重绘）
const last = getChatMessages(-1)[0];
last.data.心情 = '紧张';
await setChatMessages([{ message_id: last.message_id, data: last.data }], { refresh: 'none' });
```

**整份写盘的成本**：楼层写走 `saveChat`（CAS + 整文件重写）。楼层变量高频变化时，
优先用 `replaceVariables({type:'chat'})` 或批量一次 `setChatMessages`，不要每帧写。

### 2.3 MVU / MagVarUpdate 兼容面（2026-10-21）

使用 MagVarUpdate 的卡（世界书里有 `<UpdateVariable>` / `<JSONPatch>`，或卡内
`extensions.tavern_helper.scripts` 引 `MagVarUpdate` / `registerMvuSchema`）可以
直接调用 `Mvu.*`：

| 函数 | 状态 | 语义 |
|---|---|---|
| `Mvu.getMvuData(option?)` | ✅ | 同步返回 `{ stat_data }`。`option.type` 支持 `'message'` / `'chat'`；message 缺 `stat_data` 时回落聊天树 |
| `Mvu.replaceMvuData(data, option?)` | ✅ | 写穿目标楼层 + 聊天权威变量树（`chat_metadata.variables.stat_data`），并镜像 chat 作用域；返回 `Promise<{ stat_data }>` |
| `Mvu.events.VARIABLE_UPDATE_ENDED` | ✅ | 本 iframe 内的 `document` 自定义事件，`detail.stat_data` 是写后快照；GM/状态栏按钮改值后即时重绘 |
| `Mvu.events.VARIABLE_UPDATE_STARTED` / `VARIABLE_UPDATE_FAILED` | ⚠️ | 常量存在；生成循环由宿主掌握，这两个事件不会由宿主主动触发 |
| `Mvu.isDuringGenerating()` | ⚠️ | 恒 `false`；前端无法观测宿主 turn 状态 |

Agent 模式的 MVU 写入由插件完成：投影器解析模型回复末尾的 `<UpdateVariable>`，
应用宽松 JSON Patch（`replace` / `insert` / `delta` / `remove`，自动补中间对象，
`当前/最大` 条 clamp），把结果写入聊天变量与楼层 `variables.stat_data`。卡内
`StatusPlaceHolderImpl` 会由投影器补上，展示层正则再把它换成状态栏 HTML。
**Zod schema 不执行**：派生值 / enum 拒绝 / 卡自定义 clamp 仍以卡内脚本语义为准；
插件只做通用数值条 clamp 与结构兜底。

`toastr` 也内置了最小实现（`info` / `success` / `warning` / `error` / `clear`），
卡里的提示不会因为缺少全局而中断。`window.parent` / `window.top` 在注入前被
改写到同页 facade：`window.parent.document.querySelector('#send_textarea')`
写入宿主可见输入框，`#send_but` 尽力触发发送（找不到宿主 composer 时显式报错）。
`window.parent.Mvu`、`.toastr`、`.SillyTavern`、`.TavernHelper` 走同一 facade。
`localStorage` / `sessionStorage` 在沙箱里是 iframe 内存实现（页面重载即失）——
创角表单的自动保存/签名恢复因此不会因 `SecurityError` 中断。

**明确不执行**：卡内 `extensions.tavern_helper.scripts` 的脚本树（JSR 的脚本
容器 / 按钮 / 常驻悬浮面板）。它们不是消息 HTML，本插件的 iframe 没有跨楼层
脚本宿主；状态栏/行动台这类**随消息重发的 HTML** 才是兼容面。需要脚本树行为
的卡请走 ST 架构或等后续脚本宿主能力。

---

## 3. 可用清单：事件

### 3.1 函数表

| 函数 | 状态 | 说明 |
|---|:--:|---|
| `eventOn(type, fn)` | ✅ | 返回 `{ stop }`；同类型重复注册幂等（Set 语义） |
| `eventOnce(type, fn)` | ✅ | 触发一次后自摘 |
| `eventEmit(type, ...args)` | ⚠️ | 只在本 iframe 内广播，**不跨前端、不跨 iframe、不通知宿主** |
| `eventEmitAndWait(type, ...args)` | ⚠️ | 同上；返回同步结果，不是 Promise |
| `eventMakeFirst(type, fn)` | ✅ | 调整本 iframe 内的执行顺序 |
| `eventMakeLast(type, fn)` | ✅ | 同上 |
| `eventRemoveListener(type, fn)` | ✅ | |
| `eventClearEvent(type)` | ✅ | |
| `eventClearListener(fn)` | ✅ | |
| `eventClearAll()` | ✅ | iframe `pagehide` 时自动执行（无需手动） |
| `eventOnButton` | ⚠️ | 只是 `eventOn` 别名；本插件没有快速回复栏，按钮事件不会自己发生 |

### 3.2 真正会到达的事件（关键）

本插件没有 SillyTavern 的事件总线，事件由**快照比对**推导。**只有下表这些会真的触发**：

| 常量 | 事件名 | 何时触发 | 回调参数 |
|---|---|---|---|
| `tavern_events.APP_READY` | `app_ready` | iframe 首次拿到快照 | 无 |
| `tavern_events.MESSAGE_SENT` | `message_sent` | 出现新的**用户**楼层 | `(message_id)` |
| `tavern_events.MESSAGE_RECEIVED` | `message_received` | 出现新的**非用户**楼层 | `(message_id)` |
| `tavern_events.MESSAGE_EDITED` | `message_edited` | 已有楼层正文或发言人变化 | `(message_id)` |
| `tavern_events.MESSAGE_DELETED` | `message_deleted` | 楼层消失 | `(第一个被删的 message_id)` |
| `tavern_events.CHAT_CHANGED` | `chat_id_changed` | 绑定的聊天切换 | `(chatId)` |
| `iframe_events.MESSAGE_IFRAME_RENDER_STARTED` | `message_iframe_render_started` | 本 iframe 挂载 | `(token)` |
| `iframe_events.MESSAGE_IFRAME_RENDER_ENDED` | `message_iframe_render_ended` | 本 iframe 卸载 | `(token)` |

**其余常量**（`MESSAGE_SWIPED` / `MESSAGE_UPDATED` / `GENERATION_*` / `STREAM_TOKEN_*`
/ `WORLD_INFO_ACTIVATED` / `CHARACTER_*` / `PRESET_*` …）：

- **名字存在**（`tavern_events.MESSAGE_SWIPED` 是字符串，`eventOn` 不会因 `undefined` 炸）；
- **但永远不会被触发**。这是刻意的：宿主没有该信号的观测面，凭空发事件等于给你的
  前端假数据，会让「等事件再渲染」的逻辑永久卡住。

> 实践建议：**要刷新就轮询自己的数据**（`getVariables` / `getChatMessages` + `setInterval`，
> 或者像内置状态栏那样在 `eventOn(MESSAGE_RECEIVED)` 之外再加一个 1-2s 的低频 `setInterval`）。
> 不要设计成"只靠 GENERATION_ENDED 触发一次"的架构——它不会来。

### 3.3 可用的库

iframe 头里会注入（走 CSP 白名单的 jsdelivr）：

| 全局 | 版本 | 状态 |
|---|---|---|
| `_`（lodash） | 4.17.21 | ✅ |
| `$` / `jQuery` | 3.7.1 | ✅ |
| `showdown` | 2.1.0 | ✅（`builtin.renderMarkdown` 依赖它） |
| `toastr` | — | ✅ 最小实现（`info/success/warning/error/clear`，渲染 iframe 内浮层，不引入外部库） |
| `Vue` / `VueRouter` | — | ❌ 用 CDN 自己按需引入（`esm.sh` / `jsdelivr` 在白名单） |
| `PIXI` / `toastr` / `YAML` / `z` / `hljs` / `Popper` / Font Awesome | — | ❌ 同上，自己引 |

```html
<!-- 这些 CDN 在白名单里，可以直接用 -->
<script type="module" src="https://esm.sh/vue@3"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
```

> 白名单外的 CDN / HTTPS API：在设置页开启「允许美化前端加载外部资源」后，
> `script-src` / `style-src` / `connect-src` 会额外放行 `https:`。开启后外部脚本
> 可以把 iframe 里可见的聊天数据发出去，只对信任的卡开启。

---

## 4. 可用清单：其它读取面

| 函数 | 状态 | 说明 |
|---|:--:|---|
| `SillyTavern.getContext()` | ⚠️ | 只返回最小只读面：`chatId` / `chat` / `chat_metadata` / `name1`（你）/ `name2`（角色）/ `characterId`（恒 0）/ `characters`（当前角色卡）/ `getCharacterCardFields()`（恒空字段）。**没有** `extensionSettings`、`eventSource`、`eventTypes`、`saveSettingsDebounced` 等 |
| `getCurrentMessageId()` | ✅ | 当前 iframe 所属楼层；侧栏/MVU 模板为 `-1`（最新）。没有楼层绑定时也不要拿它做范围上界，优先 `getLastMessageId()` |
| `getLorebook(name)` / `getWorldbook(name)` | ✅ | 返回条目数组（含 `world` 字段）。名字缺省取角色卡绑定的世界书，其次全局激活的第一本；都没有则抛错 |
| `getLorebookNames()` / `getWorldbookNames()` | ✅ | 全部世界书名 |
| `getGlobalWorldbookNames()` | ✅ | 当前全局激活的世界书名 |
| `getChatWorldbookNames()` | ⚠️ | 别名到 `getGlobalWorldbookNames`（本插件没有"聊天绑定世界书"这一层） |
| `getCharNames()` / `getCharacterNames()` | ✅ | 角色名列表 |
| `getTavernRegexes(option?)` | ✅ | `{enabled_only}` 过滤；条目形状来自本插件的 `RegexScriptIR`，**不是** JSR 的 `TavernRegex` 形状 |
| `formatAsTavernRegexedString(text, placement, option?)` | ⚠️ | 应用正则并返回 `Promise<string>`。`placement` 用 ST 的数字位（1=用户输入 2=AI 输出 3=斜杠 5=世界书 6=推理）；`option.scripts` 可直接给脚本集；`option.depth` 参与深度型脚本判定 |
| `substitudeMacros(text)` | ⚠️ | 存在但**原样返回**：宏展开在服务端生成管线里做，前端拿不到宏引擎 |
| `getTavernHelperVersion()` / `getTavernVersion()` | ⚠️ | 返回 `'dsh-soulmojito'`（不是版本号）。**不要**用它做版本分支判断 |
| `getScriptId()` | ⚠️ | 恒返回 `'dsh-soulmojito-frontend'`：本插件没有 JSR 的脚本容器概念 |
| `waitGlobalInitialized(name)` | ⚠️ | `Promise.resolve(window[name])`；不会等待真实初始化 |
| `getButtonEvent(name)` | ⚠️ | 返回一个字符串；对应的按钮事件永远不会被触发 |
| `builtin.renderMarkdown(text)` | ✅ | 用内嵌 showdown；showdown 未加载时降级为原文 |
| `builtin.copyText(text)` | ✅ | Clipboard API；不可用时 reject |
| `builtin.parseRegexFromString(regex)` | ✅ | 解析失败返回 `null` |
| `builtin.addOneMessage` / `duringGenerating` / `promptManager` / `getImageTokenCost` … | ❌ | 触及宿主 DOM 或生成管线，不在兼容面内 |

---

## 5. 明确不可用（❌）——调用会报错或函数不存在

### 5.1 生成控制

| 函数 | 结果 |
|---|---|
| `generate()` / `generateRaw()` | ❌ 不存在 |
| `stopGenerationById()` / `stopAllGeneration()` | ❌ 不存在 |
| `triggerSlash('/trigger')` / `'/regenerate'` / `'/stop'` | ⚠️ 命令存在但**没有接驱动**：`/trigger`、`/regenerate`、`/stop` 会抛 `trigger is not available in this environment` 一类错误 |

生成由宿主 AgentLoop 驱动。让前端触发生成会与宿主的 turn 管理冲突（双重驱动、
重复结算），这是架构边界，不是"还没做"。

### 5.2 世界书 / 角色卡写入

| 函数 | 结果 |
|---|---|
| `createWorldbook` / `createOrReplaceWorldbook` / `deleteWorldbook` / `replaceWorldbook` / `updateWorldbookWith` | ❌ 不存在 |
| `createWorldbookEntries` / `deleteWorldbookEntries` | ❌ 不存在 |
| `rebindGlobalWorldbooks` / `rebindCharWorldbooks` / `rebindChatWorldbook` / `getOrCreateChatWorldbook` | ❌ 不存在 |
| `createCharacter` / `createOrReplaceCharacter` / `deleteCharacter` / `replaceCharacter` / `updateCharacterWith` | ❌ 不存在 |
| 人设（persona）家族 | ❌ 不存在 |
| 预设（preset）家族 | ❌ 不存在 |

写资产走**管理面板**或**Agent 工具**（`card_put` / `world_put` 等，带确认协议）。
前端如果能直接改角色卡/世界书，一次误触就能毁掉存档，且没有审计。

### 5.3 脚本 / 扩展 / 音频 / 其它

| 家族 | 结果 |
|---|---|
| `getScriptTrees` / `replaceScriptTrees` / `updateScriptTreesWith` / `getAllEnabledScriptButtons` | ❌ 不存在（本插件没有 JSR 脚本树） |
| `isInstalledExtension` / `installExtension` / `uninstallExtension` / `reinstallExtension` / `updateExtension` / `getExtensionInstallationInfo` / `getExtensionType` / `isAdmin` / `getTavernHelperExtensionId` | ❌ 不存在 |
| `playAudio` / `pauseAudio` / `getAudioList` / `replaceAudioList` / `appendAudioList` / `getAudioSettings` / `setAudioSettings` / `getCurrentAudio` | ❌ 不存在（用 `<audio>` 标签 + 白名单媒体源自己播） |
| `retrieveDisplayedMessage` / `formatAsDisplayedMessage` / `refreshOneMessage` | ❌ 不存在（宿主渲染的楼层无法被前端读取/刷新） |
| `errorCatched` / `getMessageId` | ❌ 不存在 |
| `registerVariableSchema` | ❌ 不存在（见 §1.2） |
| `TavernHelper.iframe` 家族（跨 iframe 通信） | ❌ 不存在（本插件没有 iframe 注册表） |

**调用不存在的函数会抛 `TypeError: xxx is not a function`**——这是特性：
它让"照抄的代码"在第一时间显式失败，而不是悄悄什么都不做。

---

## 6. STscript（`triggerSlash` 等价物）

前端**没有** `triggerSlash`，但可以用同一个兼容通道执行一段 STscript：

```js
// 走 helper 的 slash op（内部实现同 triggerSlash 的语义子集）
await fetch  // 🧱 默认不可用（CSP connect-src 'none'）；设置页放开外部资源后可用
```

> 目前 `slash` op 只由服务端内部与测试使用，**没有**暴露成 `window.triggerSlash`。
> 需要在前端执行变量类 STscript 时，直接用 `replaceVariables` ——它更明确，也少一层解析。

服务端可用命令（`POST /helper` 的 `slash` op，供脚本/测试使用）：

| 类别 | 命令 | 状态 |
|---|---|---|
| 变量 | `/setvar` `/getvar` `/addvar` `/incvar` `/decvar` `/delvar` `/setglobalvar` `/getglobalvar` `/delglobalvar` `/hasvar` `/hasglobalvar` | ✅ |
| 分支/随机 | `/if` `/random` `/roll` `/pick` | ✅ |
| 聊天 | `/send` `/cut` | ✅ |
| 正则 | `/regex name=x` | ✅ |
| 生成 | `/trigger` `/regenerate` `/stop` | ❌ 抛错（见 §5.1） |
| 其它 ST 命令（`/echo` 之外的显示类、`/sys`、`/impersonate`…） | ❌ 解析失败 |

`/echo` 被接受但丢弃输出（没有宿主输入框可放）。

---

## 7. 常见写法对照（抄 JSR 代码时的救急表）

| JSR 里的写法 | 这里怎么写 |
|---|---|
| `window.parent.SillyTavern.getContext()` | `SillyTavern.getContext()` |
| `await triggerSlash('/setvar x 1')` | `await replaceVariables({...getVariables(), x: 1})` |
| `eventOn(tavern_events.GENERATION_ENDED, refresh)` | `setInterval(refresh, 1500)` + `eventOn(tavern_events.MESSAGE_RECEIVED, refresh)` |
| `toastr.error('…')` | 自己画 DOM，或 `console.error`（控制台可见） |
| `$('#chat').append(...)`（改宿主 DOM） | 只能改自己 iframe 内的 DOM |
| `fetch('/api/backends/…')` | 🧱 不可用；需要的数据请走本页的 `get*` 函数 |
| `Vue.createApp(...)` | 先引入 Vue：`<script src="https://esm.sh/vue@3">`（白名单 CDN） |
| `getVariables({type: 'preset'})` | 用 global 或 chat 作用域替代 |
| `setChatMessages([...], {refresh: 'all'})` | `refresh` 无效；自己重绘当前 UI |
| `createWorldbookEntries(...)` | 提示用户去面板操作，或让 Agent 调 `world_*` 工具 |

---

## 8. 排错：症状 → 原因

| 症状 | 原因 | 处理 |
|---|---|---|
| `this frontend is not bound to a Tavern chat` | 当前消息不属于任何酒馆会话（或绑定尚未建立） | 在酒馆聊天里打开；等绑定完成再调用 |
| `unsupported variable scope 'preset'` | 用了 §1.1 表里不支持的作用域 | 改用 global/chat/message |
| `message_id 12 is out of range (chat has 8 messages)` | 楼层号越界 | 用 `getLastMessageId()` 或负数深度 |
| `chat 'xxx' not found` | 聊天被删除 / 绑定指向旧文件 | 刷新页面；或重新打开该聊天 |
| 事件监听写了但永远不触发 | 监听的是 §3.2 之外的"不触发"事件 | 改为轮询，见 §3.2 建议 |
| `xxx is not a function` | 调用了 §5 的不可用函数 | 查表替换 |
| `Failed to fetch` / 请求被拦 | 用了 `fetch`/XHR/WebSocket | 🧱 结构性限制，改用兼容函数 |
| 改了 `data` 但界面没变 | `setChatMessages` 的 `refresh` 无效 | 自己重绘 |
| `renderMarkdown` 输出原文 | showdown 脚本未加载（CDN 被墙/离线） | 自行降级或内联渲染 |
| `Mvu.getMvuData()` 返回 `undefined` | 聊天还没有 `stat_data`（新卡首轮尚未投影）或当前卡未被识别为 MVU 卡 | 先发一轮让投影器结算；确认卡内有 `<UpdateVariable>` / `MagVarUpdate` / `StatusPlaceHolderImpl` |
| 状态栏一直空 | 模型没有输出 `<UpdateVariable>`，或卡内状态栏正则被禁用 | 用提示词查看器看实发请求；确认正则未 disabled；首轮检查 `initialized_lorebooks` 是否已播种 |
| 表单/快速选项点了没反应 | 宿主页找不到可见 composer，或输入框被面板遮挡 | 看 iframe console 的 `no visible host composer textarea found`；先把输入框滚动到可视区 |

---

## 9. 安全提醒（给你的，也是给玩家的）

- 你的前端**读不到**宿主的 Cookie、localStorage、其它聊天、API Key；
- 你的前端**改不了**角色卡、世界书、脚本、设置；
- 你的前端**能改**当前聊天的正文、楼层变量、聊天变量，以及 global 变量——
  这些都是真实数据，写之前先读、先确认，别在 `setInterval` 里无脑覆盖。
- `replaceVariables` 是**整表替换**：忘了展开旧值就等于把所有变量清空。
  不确定时用 `insertOrAssignVariables` 或 `updateVariablesWith`。
