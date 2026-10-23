# 美化前端 · 酒馆助手（Tavern-Helper）兼容性清单

> 面向**写美化前端的人**（人写，或让 AI 写）。本文是 `window.*` / `window.TavernHelper.*`
> 兼容面的**权威清单**：哪些能用、用到什么程度、哪些一定不能用、用了会怎样。
>
> - 实现：`packages/plugin/src/helper.ts`（服务端域操作）+ `packages/tavern-jsr`（iframe shim、事件词汇表、库全局）+ `packages/tavern-frontend-storage`（沙箱 localStorage/sessionStorage/IndexedDB）
> - 决策：[`decisions/2026-10-20-frontend-helper-compat.md`](../../decisions/2026-10-20-frontend-helper-compat.md)
> - 参考对象：JS-Slash-Runner（Tavern-Helper v4.x，PolyForm NonCommercial）。
>   本文只对齐**可观察行为**；本插件不复刻它的同源无沙箱模型，也没有任何 JSR 源码拷贝。
>
> 图例：✅ 可用 · ⚠️ 可用但语义/范围不同 · ❌ 不提供 · 🧱 结构性不可用（沙箱决定）

---

## 0. 0. 2026-10-23 兼容层升级摘要

这一轮把「名字能对上」推进到「契约能对上」：

- **表面补齐**：`window` 与 `window.TavernHelper` 都安装 JSR 4.11.3 的 179 个公共名（同一函数对象，`getTavernHelperVersion()` 返回 `4.11.3`）；`getTavernVersion()` 返回 `0.0.0`（semver 形状，宿主特性门保持关闭）。
- **同步契约**：`replaceVariables` / `updateVariablesWith` / `insertOrAssignVariables` / `insertVariables` / `deleteVariable` 按 JSR 4.11 同步返回；落盘在后台队列里按序执行，失败弹 error toast。
- **宏**：`substitudeMacros` 变成真正的本地展开（`{{char}}` / `{{user}}` / `{{getvar::}}` / `{{setvar::}}` / `{{random}}` / `{{roll}}` / 时间类 + `registerMacroLike`）；未知宏原样保留。
- **正则**：`getTavernRegexes(option)` 同步返回 ST 形状；`formatAsTavernRegexedString(text, source, destination, option)` 按 JSR 签名同步返回字符串（旧 `(text, placement, option)` 姿势仍兼容）。
- **脚本容器**：右栏「卡脚本」tab 升级为真正的容器——每个脚本一个独立沙箱 iframe，带 `scriptId`/`scriptName`/`scriptInfo`；`getScriptInfo`/`replaceScriptInfo`/`getAllEnabledScriptButtons`/`replaceScriptTrees` 可用，脚本按钮条渲染在容器里并回投给对应 iframe。
- **会话级覆盖**：世界书条目族、`createWorldbook`/`deleteWorldbook`、`replaceWorldbook`、预设与人设写面、脚本树三来源（character/preset/global）全部落在 `chats/<角色>/<聊天>.jsonl.scripts.json` 覆盖层，基础资产只读。
- **只读面补全**：真实预设/人设/角色列表与 `getPreset`、`getPersona`、`getCharData`、`getCharAvatarPath`、`getChatHistoryBrief/Detail`、`RawCharacter`。
- **框架面**：`SillyTavern.getContext().chat` 改为 ST 形状（`mes`/`is_user`/`is_system`/`swipes`）并带 `eventSource`/`eventTypes`；新增 `EjsTemplate`（宿主 `template.render`）。
- **仍然显式失败**：角色卡/基础世界书/预设激活/扩展安装/导入原始资产/host DOM（`retrieveDisplayedMessage`、`refreshOneMessage`）——调用即抛出带原因的 error，不做静默 no-op。

---

## 0. 先读这一段：为什么不能"照抄 JSR 的写法"

JSR 的美化前端跑在**同源、无 sandbox、无 CSP** 的 iframe 里，`window.parent`
上的约 200 个 API 被直接拷进 iframe。本插件的 iframe 是：

```
sandbox="allow-scripts"        // 无 allow-same-origin
Content-Security-Policy: default-src 'none'; connect-src 'none'; frame-src 'none'
```

> 设置页的「允许美化前端加载外部资源」可以显式放开 `script-src` / `style-src`
> 的 HTTPS 通配与 `connect-src https: blob:`（默认关闭，见 §3.3 与 §6 的标注）。

因此有一条**结构性的分界线**，任何兼容层都无法绕过：

| 你可能会写 | 在本插件里 |
|---|---|
| `window.parent.document` 的宿主 DOM | 🧱 跨域；facade 只把 `document` 代理到本 iframe 自己的文档，读不到宿主 DOM |
| `fetch()` / `XMLHttpRequest` | 🧱 CSP `connect-src 'none'` 拦截（默认；设置页可显式放行 HTTPS） |
| `WebSocket`（`wss:`） | 🧱 CSP 拦截；放行外部资源也只覆盖 `https:`，不含 `wss:` |
| 嵌套 `<iframe src="https://…">` | 🧱 CSP `frame-src 'none'`；同文档 `<iframe srcdoc>` 可用（卡内棋盘/开局界面走这条） |
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
| `'message'` | ✅ | ✅ | 楼层的 `variables` 字段 | `message_id` 支持负数深度；越界会报错。读面在楼层没有 `stat_data` 时回退聊天作用域的 `stat_data`（MVU 卡首屏 `getVariables({type:'message'})` 的常见判据），第一次回写会把它物化到该楼层 |
| `'character'` | ✅ | ✅ | 角色变量覆盖层 `state.json` 的 `characterVariables` | 读面优先覆盖层，其次角色卡 `extensions.variables`；写面只落覆盖层，角色卡文件保持只读。删除 `characterVariables[角色名]` 即回到卡原版 |
| `'preset'` | ⚠️ | ❌ | 当前预设的 `extensions.tavern_helper.variables`（只读） | 写面抛错：预设是面板资产；读面返回当前激活预设的变量树 |
| `'script'` | ✅ | ✅ | 会话脚本树覆盖层的 `scriptVariables[scriptId]` | 只有脚本容器 iframe 有 `scriptId`；消息 iframe 调用会同步抛错。写面按聊天持久化 |
| `'extension'` | ❌ | ❌ | — | 抛 `unsupported variable scope 'extension'` |

不支持的作用域**同步抛错**，不是静默返回 `{}`——这样你在控制台能立刻看见。

### 1.2 函数表

| 函数 | 状态 | 语义与差异 |
|---|:--:|---|
| `getVariables(option)` | ✅ | 同步返回**快照副本**（你随便改不会影响宿主）。缺省 `{type:'chat'}` |
| `getAllVariables()` | ✅ | 同步返回当前生效的合并变量表：`global` ← `character` ← `script` ← `chat` ←（消息 iframe 才有的）逐楼变量；`stat_data` 可直接在顶层读到。`Mvu.getAllVariables()` 同义 |
| `replaceVariables(vars, option?)` | ✅ | 整表替换，**同步返回 `void`**（JSR 4.11 契约）。落盘在后台按序执行，失败弹 error toast。缺省 `{type:'chat'}` |
| `updateVariablesWith(fn, option?)` | ✅ | `fn` 同步时**同步返回新表**；`fn` 返回 Promise 时返回 Promise。收到的是副本 |
| `insertOrAssignVariables(vars, option?)` | ✅ | 顶层键合并（浅合并，与 JSR 一致），同步返回新表 |
| `insertVariables(vars, option?)` | ✅ | 只补缺失的顶层键，同步返回新表 |
| `deleteVariable(path, option?)` | ✅ | 点分路径删除，**同步返回** `{variables, delete_occurred}` |
| `registerVariableSchema` | ⚠️ | 接受并保存 schema，仅供本 iframe 的变量管理器读取；真正的结构守卫仍是服务端 MVU `$schema` |

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
| `Mvu.replaceMvuData(data, option?)` | ✅ | 写穿目标楼层 + 聊天权威变量树（`chat_metadata.variables.stat_data`），并镜像 chat 作用域；成功后宿主重投快照（其它 iframe 同步看到新值）；失败会在前端弹「变量写入失败」toast |
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

**脚本容器（2026-10-23 升级）**：卡内 `extensions.tavern_helper.scripts` 的脚本树
（JSR 的脚本容器 / 按钮 / 常驻悬浮面板）不在消息渲染路径里。插件的 iframe
只承载「随消息重发的 HTML」；脚本树由右栏 **「卡脚本」tab** 管理：

- 列表显示全部脚本（含卡内禁用的，禁用项标注且不可运行）；默认没有任何自动执行；
- 点「运行」后，该脚本被包成完整 HTML 文档，**在自己的沙箱 `FrontendFrame` 里执行**
  （一个脚本一个 iframe），带 `scriptId`/`scriptName`/`scriptInfo`；切换聊天/角色立即停止并清空；
- 手动模式一次运行一份；开启 `cardScriptsAutoRun` 后按脚本逐个 iframe 自动运行；
- 脚本通过 `replaceScriptButtons` 上报的按钮会渲染在容器里的按钮条，点击按
  `getButtonEvent(name)` 的 id 回投给对应 iframe（`eventOnButton` 可接）；
- 脚本的 `getScriptInfo`/`replaceScriptInfo` 与按钮列表回写到会话脚本树副本。

因此需要常驻悬浮面板的卡（例如 16 万字符的 GM 面板）默认仍需手动点一次「运行」；
开启 `cardScriptsAutoRun` 后 AgentTavern 会把脚本自动注入「美化前端」的同一个
iframe（ST 仍注入「卡脚本」tab），GM 面板的 `window.top.document` /
`getCharWorldbookNames` / `updateWorldbookWith` 都在兼容面内（见 §4）。详见
[`decisions/2026-10-21-card-scripts-host.md`](../../decisions/2026-10-21-card-scripts-host.md)。

**脚本树会按聊天持久化（2026-10-21 追加）**：`getScriptTrees` /
`updateScriptTreesWith` 读写的是**会话脚本树副本**
（`chats/<角色>/<聊天>.jsonl.scripts.json`），不是角色卡文件：

- `updateScriptTreesWith(fn)` 先经 helper `scripts.put` 落盘，成功后才更新内存树并
  发布 `mg-zod-ready`；落盘失败会拒绝并保留旧树，GM 面板不会把半成品当成功；
- 刷新页面 / 重开卡脚本 tab 后，`snapshot` 带回副本，`getScriptTrees` 从副本起步；
- 副本只保存**脚本源码**，不回写角色卡、不影响别的聊天；服务端 MVU **仍不执行
  Zod schema**（派生值 / enum 拒绝等语义不会因此生效）；
- 回退入口是卡脚本 tab 的「重置卡脚本」→ `scripts.reset`。

helper RPC（供 iframe 内部使用，不是 `window.*` 公共 API）：

| op | 载荷 | 语义 |
|---|---|---|
| `scripts.get` | 无 | 返回 `{ scriptTrees }`；无副本为 `null`；要求 `chatId` |
| `scripts.put` | `{ scriptTrees }` | 覆盖本聊天副本；校验数组与每项对象；要求 `chatId` |
| `scripts.reset` | 无 | 删除本聊天副本，返回 `{ reset: true }`；要求 `chatId` |

**自动运行开关（2026-10-21 追加，同日第二次修订）**：设置页 `cardScriptsAutoRun`
**默认关闭**。开启后：

- **AgentTavern**：进入/切入酒馆聊天自动打开「美化前端」tab（不是「卡脚本」），
  把卡内全部启用脚本按脚本树顺序注入**最新一条美化楼层里文档长度最大的完整
  HTML**（同长度取最后一个；行动栏小框不抢宿主）所在的同一个沙箱文档
  （每份脚本一个独立的 `<script type="module">` 块）。脚本的
  `window.top.document.body` 就是这份美化前端文档——悬浮球 / GM 面板直接叠在
  美化前端上，与前端共享 DOM、主题与 helper 通道；该楼层没有 HTML 时给脚本一个
  独立画布（720px 起步）。
- **ST**：消息正文内联渲染，右栏没有第二份前端；自动运行仍在「卡脚本」tab，
  全部启用脚本注入同一个沙箱 iframe。
- 脚本共享同一 iframe 的 `window` / `document` / 全局变量——不是 JSR 的隔离
  脚本容器，脚本之间的冲突由卡作者负责；
- 脚本仍拥有当前聊天的变量、消息、会话世界书副本与会话脚本树副本写权限，
  只对信任的卡开启；
- AgentTavern 下「卡脚本」tab 不再重复自动运行，只保留列表、重置与手动入口
  （自动运行开启时手动运行禁用），并提供「打开美化前端」入口；
- 「美化前端」tab 内可「停止自动运行」（只停当前 iframe，不改设置）；出现新的
  美化楼层时整份文档重建，脚本随之重启。ST 的「停止自动运行」仍在卡脚本 tab；
- 「重置卡脚本」会同时停止 AgentTavern 的自动运行（跨 tab 窗口事件），避免
  iframe 继续跑已经被重置的旧源码。

### 2.4 生成桥：`TavernHelper.generate` / `getModelList`（2026-10-22）

JSR 卡可以带自己的 OpenAI 兼容 API 源（URL + Key + 模型），并在前端调用
`TavernHelper.generate`。本插件由 **Node 宿主侧**代发请求，iframe 只拿最终文本：

> 调用期间 iframe 右下角常驻「SoulMojito正在处理生成请求…」，第二行显示模型与输入字符数；请求结束会更新为成功/失败、耗时和错误信息。卡不需要自己实现等待提示。

| 函数 | 状态 | 语义 |
|---|---|---|
| `getModelList({apiurl, key})` | ✅ | 宿主 `GET <apiurl>/models`，返回去重排序后的模型 id 数组。API Key 只进 outbound `Authorization`，不回传、不落盘、不写日志 |
| `generate(config)` | ✅ | 非流式 `POST <apiurl>/chat/completions`，返回字符串正文。支持 `custom_api` / `user_input` / `injects` / `overrides.chat_history.prompts`；`should_stream` 被接受但按最终文本一次返回 |
| `generateRaw(config)` | ⚠️ | `generate` 的别名；没有 JSR 的 raw 注入细节 |
| `stopGenerationById` / `stopAllGeneration` | ⚠️ | 返回 `false`：非流式请求没有可取消的句柄 |
| `getModelList` 的 URL 规则 | — | 必须是无 query/hash 的 base URL；`https://`，或仅 loopback（`localhost` / `127.0.0.1` / `::1`）允许 `http://`；URL 内不能带账号密码 |
| 请求上限 | — | 180s 超时、8MB 响应、2M 字符提示词、256 条消息；错误信息会 redact API Key |

生成成功后 shim 还会在 iframe 内派发 `iframe_events.GENERATION_ENDED`
（参数 `(text, generationId)`）与 `tavern_events.CHAT_COMPLETION_SETTINGS_READY`，
卡前端用它记录请求/响应；`tavern_events.GENERATION_ENDED` 不会伪造（没有真实楼层
写入时发它只会让卡去读一个不存在的楼层）。

> 卡内的 API Key 存在卡自己的 localStorage 里（通常是 WebCrypto 密文）。插件只
> 在这一次 RPC 中把它转发给宿主，宿主用完即弃；不会进入 snapshot、state.json、
> 管理面板或错误消息。

### 2.5 沙箱存储：localStorage 与虚拟 IndexedDB（2026-10-22）

沙箱 iframe 没有同源存储，原生 `localStorage` / `indexedDB` 会抛
`SecurityError`。shim 提供两条 **插件宿主侧** 的持久化通道：

- `localStorage`：**按角色持久**。`FrontendFrame` 构建 srcdoc 前从
  `GET /api/dsh-soulmojito/frontend/storage?character=…` 取回键值表并同步播种；
  `setItem/removeItem/clear` 200ms 合并后经 helper `storage.set` 写回
  `state.json` 的 `frontendStorage`（上限 512KB/角色）。刷新页面/重开聊天后设置
  仍在。
- `sessionStorage`：iframe 内存实现，页面重载即失（与 JSR 的 per-tab 语义近似，
  但不跨文档）。
- `indexedDB`：**虚拟 IndexedDB**。`indexedDB.open` / `createObjectStore` /
  `transaction` / `objectStore().get/put/delete/clear` / `deleteDatabase` 由 shim
  经宿主 RPC 转发，记录体走 `frontend/idb/put|get` 二进制路由，按角色落在
  `$DSH_HOME/soulmojito/frontend-idb/`（名字与 key 均 SHA-256 后落盘）。单条上限
  1GB、单角色上限 2GB；写入先写临时文件再原子 rename。卡把数百 MB 级资源包缓存到
  IndexedDB 后，刷新/重开聊天不会重新下载。
  支持范围：单 object store 的 keyPath、get/put/delete/clear/deleteDatabase；
  **不支持** index、cursor、多 store 复合事务、`IDBKeyRange`——调用这些缺口会
  显式抛错，不会静默返回空。`localStorage` 的内容也不会进入真实浏览器存储，
  卡无法借此读取宿主 Cookie 或别的角色数据。

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
| `iframe_events.GENERATION_ENDED` | `js_generation_ended` | `TavernHelper.generate` 成功返回后 | `(text, generationId)` |
| `tavern_events.STREAM_TOKEN_RECEIVED` | `stream_token_received` | 快照比对发现**新/改**的非用户楼层 | `(最终正文, 楼层 id)`；只发一次最终文本，不是增量 token |
| `tavern_events.CHARACTER_MESSAGE_RENDERED` | `character_message_rendered` | 同上 | `(楼层 id, 'normal')` |
| `tavern_events.USER_MESSAGE_RENDERED` | `user_message_rendered` | 新/改用户楼层 | `(楼层 id)` |
| `tavern_events.CHAT_COMPLETION_SETTINGS_READY` | `chat_completion_settings_ready` | `TavernHelper.generate` 发起前 | `({ model, messages, stream:false })`；供卡记录请求，不是宿主生成循环 |

**其余常量**（`tavern_events` 共 82 个名字，`iframe_events` 共 9 个）：

- **名字全部存在**（`tavern_events.MESSAGE_SWIPED`、`WORLD_INFO_ACTIVATED`、`PRESET_CHANGED` 都是字符串，`eventOn` 不会因 `undefined` 炸）；2026-10-23 起按 JSR 4.11.3 的完整词汇表安装。
- **但只有上表列出的会被触发**。这是刻意的：宿主没有该信号的观测面，凭空发事件等于给你的
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
| `Vue` | 3.5.40（runtime global prod） | ✅（JSR 消息 iframe 同款；Vue SFC bundle 的 `module.exports = Vue` 直接可用） |
| `VueRouter` | 4.6.4（global prod） | ✅ |
| `z`（Zod） | 4.4.3（模块命名空间） | ✅（同时支持 `z.object` 与 `mvu_zod.js` 的 `z.z`） |
| `YAML` | yamljs 0.3.0 | ✅ `parse` / `stringify`；`parseDocument(...).toJS()` 由 shim 补齐。不是 eemeli/yaml 的完整 Document API |
| `toastr` | — | ✅ 最小实现（`info/success/warning/error/clear`，渲染 iframe 内浮层，不引入外部库） |
| `PIXI` / `hljs` / `Popper` / Font Awesome | — | ❌ 用 CDN 自己按需引入（白名单 CDN 可用） |

```html
<!-- 这些 CDN 在白名单里，可以直接用 -->
<script type="module" src="https://esm.sh/vue@3"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
```

> Vue 3.5.40 / vue-router 4.6.4 / Zod 4.4.3 固定版本；Vue 与 Vue Router 用
> `cdn.jsdelivr.net`，Zod 通过 `+esm` 模块设置 `window.z`。三者都在 CSP 的
> `script-src` 白名单内，不需要打开「允许外部资源」。
> CSP `font-src` 同时放行 `data:`、`blob:` 与 `https:`——卡把字体解密到 blob URL
> 后再 `@font-face` 是常见做法。

> 白名单外的 CDN / HTTPS API：在设置页开启「允许美化前端加载外部资源」后，
> `script-src` / `style-src` / `connect-src` 会额外放行 `https:`（`connect-src` 同时保留 `blob:`，卡生成的 blob URL 可被 `fetch` 读取）。开启后外部脚本
> 可以把 iframe 里可见的聊天数据发出去，只对信任的卡开启。

---

## 4. 可用清单：其它读取面

| 函数 | 状态 | 说明 |
|---|:--:|---|
| `SillyTavern.getContext()` | ⚠️ | 只返回最小只读面：`chatId` / `chat` / `chat_metadata` / `name1`（你）/ `name2`（角色）/ `characterId`（恒 0）/ `characters`（当前角色卡）/ `getCharacterCardFields()`（恒空字段）。`getContext()` 里仍没有 `extensionSettings`、`eventSource`、`eventTypes`；这些兼容字段直接挂在 `SillyTavern.*`（`extensionSettings` / `chatCompletionSettings` 为 iframe 内存，`saveChat` / `saveSettingsDebounced` 为 Promise/空操作——变量与楼层已由 helper RPC 落盘，不会写宿主设置） |
| `SillyTavern.loadWorldInfo(name)` | ✅ | 读当前聊天的世界书并返回 ST 形状 `{ entries: { [uid]: entry } }`；优先会话副本，其次基础资产/卡内嵌书。只读，写回仍走 `updateWorldbookWith` 的会话副本 |
| `getCurrentMessageId()` | ✅ | 当前 iframe 所属楼层；侧栏/MVU 模板为 `-1`（最新）。没有楼层绑定时也不要拿它做范围上界，优先 `getLastMessageId()` |
| `getLorebook(name)` / `getWorldbook(name)` | ✅ | 返回条目数组（含 `world` 字段）。名字缺省取角色卡绑定的世界书，其次全局激活的第一本，最后卡内嵌书名。**优先读当前聊天的会话副本**，没有副本才读基础 `worlds/` 资产 |
| `getLorebooks()` / `getWorldbookNames()` / `getLorebookNames()` | ✅ | 当前聊天可见的全部世界书名（基础资产 + 会话新建 - 会话删除） |
| `getGlobalWorldbookNames()` | ✅ | 当前全局激活的世界书名 |
| `getCharWorldbookNames()` / `getCharLorebooks()` | ✅ | **同步**返回 `{ primary, additional: [] }`；名字取卡内 `extensions.world`，其次内嵌书 `characterBook.name`，都没有为 `null` |
| `getCurrentCharPrimaryLorebook()` | ✅ | 同步返回主链接书名（或内嵌书名），没有为 `null` |
| `getChatWorldbookName()` / `getChatLorebook()` | ✅ | 同步返回 `chat_metadata.world`（当前聊天的会话绑定），没有为 `null` |
| `getChatWorldbookNames()` | ⚠️ | 只返回当前聊天的会话绑定（没有为 `[]`），不是全局激活列表 |
| `setChatLorebook(name)` | ✅ | 写 `chat_metadata.world`（会话级，随聊天文件走） |
| `getOrCreateChatLorebook()` / `getOrCreateChatWorldbook()` | ✅ | 没有会话绑定就创建一本会话世界书并绑定 |
| `updateWorldbookWith(name, updater)` | ✅ | 先 `getWorldbook`，在 iframe 内执行 `updater(entries)`，再把结果写入**会话副本**（`lorebook.put`）。基础世界书资产与卡内嵌书永不被写 |
| `replaceWorldbook` / `createOrReplaceWorldbook` | ✅ | 写当前聊天的会话副本（整表） |
| `createWorldbook` / `createLorebook` | ⚠️ | **会话级新建**：写进本聊天的覆盖层；同名基础资产存在时抛错（基础资产不归前端写） |
| `deleteWorldbook` / `deleteLorebook` | ⚠️ | 会话级删除：只存在于会话的书直接移除；基础资产用空墓碑覆盖本聊天，`worlds/<name>.json` 不动 |
| `getLorebookEntries` / `replaceLorebookEntries` / `setLorebookEntries` / `updateLorebookEntriesWith` / `createLorebookEntries` / `createLorebookEntry` / `deleteLorebookEntries` / `deleteLorebookEntry` / `createWorldbookEntries` / `deleteWorldbookEntries` | ✅ | 全部走会话世界书副本；uid 自动补齐，返回 JSR 形状 |
| `getLorebookSettings()` / `setLorebookSettings()` | ⚠️ | iframe 内镜像；生成仍用宿主世界书设置，`set` 会 console.warn |
| `getScriptTrees(option)` | ✅ | 按 `type` 读 `character` / `preset` / `global`；character 默认会话副本，preset 回落到激活预设内嵌树，global 读会话覆盖层 |
| `replaceScriptTrees(trees, option)` / `updateScriptTreesWith(fn, option)` | ✅ | 三种来源都写当前聊天的会话覆盖层；`updateScriptTreesWith` 仍先落盘再发布 `mg-zod-ready`（GM 面板依赖 resolve=已保存） |
| `getScriptInfo()` / `replaceScriptInfo()` / `getScriptName()` | ✅ | 脚本容器 iframe 读自己的节点；`replaceScriptInfo` 回写会话脚本树 |
| `getScriptButtons()` / `replaceScriptButtons()` / `updateScriptButtonsWith()` / `appendInexistentScriptButtons()` | ✅ | 容器 iframe 的按钮列表；右栏「卡脚本」渲染按钮条，点击回投事件；列表同时回写节点 `button` |
| `getAllEnabledScriptButtons()` | ✅ | 聚合三种来源里启用脚本的可见按钮（`{ [scriptId]: [{ button_id, button_name }] }`） |
| `getButtonEvent(name)` / `eventOnButton(name, fn)` | ✅ | 事件 id 为 `<scriptId>_<hash>`；容器按钮条按同一 id 派发 |
| `getIframeName()` / `getMessageId(name)` / `reloadIframe()` | ✅ | 消息 iframe 为 `TH-message-<id>`，脚本容器为 `TH-script-<id>`；未知名字抛错 |
| `generate(config)` / `generateRaw(config)` | ⚠️ | 见 §2.4：宿主代理卡内 OpenAI 兼容 API，非流式返回文本；仍需 `custom_api` |
| `getModelList({apiurl, key})` | ✅ | 见 §2.4：返回模型 id 数组；Key 不回传 |
| `stopGenerationById` / `stopAllGeneration` | ⚠️ | 返回 `false`（非流式无可取消句柄） |
| `getCharData(name?)` | ✅ | JSR 形状 `v1CharData`（顶层 + `.data`），带真实头像 URL；非当前角色返回 `null`（同步面只装载当前卡） |
| `getCharacter(name)` | ✅ | 异步读角色卡原始数据（`character.get`），未知名字返回 `null` |
| `getCharacterNames()` / `getCharacterIds()` / `getCurrentCharacterName()` / `getCurrentCharacterId()` | ✅ | 快照同步面 |
| `getCharAvatarPath(name?)` | ⚠️ | 只对当前角色返回头像 URL，其它名字 `null` |
| `getChatHistoryBrief()` / `getChatHistoryDetail()` | ✅ | 从快照消息派生（`mes`/`is_user`/`extra`） |
| `RawCharacter` | ⚠️ | 只读类：`find`/`findIndex`/`getCardData`/`getAvatarId`/`getRegexScripts`/`getWorldbookNames`；写方法不存在 |
| `getPreset(name?)` / `getPresetNames()` / `getLoadedPresetName()` / `getProxyPresetNames()` | ✅ | **真实预设**从快照读取（`in_use` 等于激活预设）；未知名字返回 `null` |
| `replacePreset` / `updatePresetWith` / `createPreset` / `createOrReplacePreset` | ✅ | 会话级预设副本（不写 `presets/*.json`） |
| `deletePreset` / `renamePreset` / `loadPreset` / `setPreset` | ❌ | 显式抛错：预设删除/改名/激活是面板资产操作 |
| `getPersonaNames()` / `getPersonaIds()` / `getCurrentPersonaName()` / `getCurrentPersonaId()` / `getPersona()` | ✅ | 快照同步面；`getPersona` 返回会话副本优先的完整对象 |
| `getPersonaAvatarPath()` | ⚠️ | 快照里只有头像串时返回它，否则 `null` |
| `replacePersona` / `updatePersonaWith` / `createPersona` / `createOrReplacePersona` | ✅ | 会话级人设副本 |
| `deletePersona` | ❌ | 显式抛错：人设删除是面板资产操作 |
| `getTavernRegexes(option)` | ✅ | **同步**返回 ST `TavernRegex` 形状，按 `type`（global/character/preset）过滤 |
| `formatAsTavernRegexedString(text, source, destination, option?)` | ✅ | 同步返回 `string`；`source` 为 `user_input`/`ai_output`/`slash_command`/`world_info`/`reasoning`，`destination` 为 `display`/`prompt`；旧的 `(text, placement, option)` 姿势仍兼容 |
| `isCharacterTavernRegexesEnabled()` | ✅ | 恒 `true`（卡级正则跟随角色卡启用） |
| `replaceTavernRegexes` / `updateTavernRegexesWith` | ❌ | 显式抛错：正则资产归面板 |
| `substitudeMacros(text)` | ✅ | 本地同步宏展开（角色/用户/描述/人设/楼层/变量/random/roll/时间 + `registerMacroLike`）；未知宏原样保留 |
| `registerMacroLike(name, fn)` / `unregisterMacroLike(name)` | ✅ | 只影响本 iframe 的宏展开 |
| `initializeGlobal(name, value)` / `waitGlobalInitialized(name)` | ✅ | 本地全局注册 + 15s 轮询等待 |
| `injectPrompts(prompts)` / `uninjectPrompts(ids)` | ⚠️ | iframe 本地注入列表，只进入 `TavernHelper.generate` 的请求；不进入宿主 AgentLoop 生成 |
| `getTavernHelperVersion()` | ✅ | `'4.11.3'`（本轮实现的 API 代际） |
| `getTavernVersion()` | ⚠️ | `'0.0.0'`：semver 形状，避免 `compare-versions` 抛错，同时让 ST 特性门保持关闭 |
| `getScriptId()` | ⚠️ | 脚本容器 iframe 返回节点 id；消息 iframe 返回 `'dsh-soulmojito-frontend'` |
| `EjsTemplate.evalTemplate(code, context)` | ✅ | 宿主 `template.render`（同一 `node:vm` 沙箱）；`prepareContext` 提供变量/世界书/角色/预设读取 |
| `EjsTemplate.getFeatures()` | ⚠️ | 返回 `enabled: true` + 生成/渲染 loader 全关（本插件不跑 EJS 注入管线） |
| `isAdmin()` / `getExtensionType()` / `isInstalledExtension()` / `getExtensionStatus()` / `getTavernHelperExtensionId()` | ⚠️ | 只认 JSR 扩展自身（`'JS-Slash-Runner'`）；不枚举 ST 扩展目录 |
| `installExtension` / `uninstallExtension` / `reinstallExtension` / `updateExtension` | ❌ | 显式抛错：扩展管理不属于沙箱前端 |
| `formatAsDisplayedMessage(text, option)` | ✅ | 宏 → display 正则 → showdown，同步返回 HTML |
| `retrieveDisplayedMessage` / `refreshOneMessage` | ❌ | 宿主消息 DOM 在沙箱外，显式抛错 |
| `errorCatched(fn)` | ✅ | 同步/Promise 错误弹 error toast 后继续抛出 |
| `playAudio(type, {url, title?})` / `pauseAudio(type)` / `audioEnable` / `audioImport` / `audioMode` / `audioPlay` / `audioSelect` | ✅ | iframe 内 `<audio>`，`bgm` / `ambient` 两通道 |
| `getAudioList` / `replaceAudioList` / `appendAudioList` / `getAudioSettings` / `setAudioSettings` / `getCurrentAudio` | ⚠️ | 进程内音频状态，语义对齐 JSR 的可观察字段；不持久化、不跨 iframe |
| `localStorage` | ✅ | 按角色持久，见 §2.5（上限 512KB/角色）；`sessionStorage` 仍为 iframe 内存 |
| `indexedDB` | ⚠️ | 虚拟 IndexedDB，见 §2.5：单 store 的 open/create/transaction/get/put/delete/clear/deleteDatabase；不支持 index/cursor/多 store 事务 |
| `getCharNames()` / `getCharacterNames()` | ✅ | 角色名列表 |
| `builtin.renderMarkdown` / `copyText` / `parseRegexFromString` / `uuidv4` / `saveSettings` / `addOneMessage` | ✅ | 宿主无关的子集；`addOneMessage` 映射到 `createChatMessages`（会真实落盘） |
| `builtin.reloadEditor` / `renderPromptManager` / `promptManager` / `getImageTokenCost` / `getVideoTokenCost` | ❌ | 触及宿主 DOM/生成管线，显式抛错 |

---

## 5. 明确不可用（❌）——调用会报错或函数不存在

### 5.1 生成控制

| 函数 | 结果 |
|---|---|
| `generate()` / `generateRaw()` | ✅ / ⚠️ 见 §2.4：卡内 OpenAI 兼容源由宿主代理，非流式返回文本 |
| `stopGenerationById()` / `stopAllGeneration()` | ⚠️ 返回 `false`（非流式无可取消句柄） |
| `triggerSlash('/trigger')` | ⚠️ **仅**支持「本 iframe 刚用 `createChatMessages` 创建了用户楼层」这一种姿势：桥接层把该楼层替换成一次宿主 composer 发送，随后由 AgentLoop 生成；没有待发送楼层时仍抛 `trigger is not available in this context` |
| `triggerSlash('/regenerate')` / `'/stop'` | ❌ 没有接驱动，会抛 `trigger is not available in this environment` 一类错误 |

生成由宿主 AgentLoop 驱动。卡前端只能通过上述受控路径把**自己刚创建的那一条用户楼层**交给宿主；不能让前端任意改写已有历史或重复结算，这是架构边界，不是"还没做"。

### 5.2 世界书 / 角色卡写入

| 函数 | 结果 |
|---|---|
| `createWorldbook` / `createOrReplaceWorldbook` / `deleteWorldbook` / `replaceWorldbook` | ⚠️ 会话级：新建/整表写进本聊天副本；删除基础资产时写空墓碑，`worlds/<name>.json` 不动 |
| `updateWorldbookWith` | ✅ 只写当前聊天的**会话副本**（见 §4）；基础 `worlds/<name>.json` 与卡内嵌书不受影响 |
| `createWorldbookEntries` / `deleteWorldbookEntries` / 条目 CRUD | ✅ 全部落在会话世界书副本 |
| `rebindGlobalWorldbooks` / `rebindCharWorldbooks` / `rebindChatWorldbook` / `setCurrentCharLorebooks` | ❌ 显式抛错：绑定属于面板资产；聊天内绑定用 `setChatLorebook` |
| `createCharacter` / `createOrReplaceCharacter` / `deleteCharacter` / `replaceCharacter` / `updateCharacterWith` | ❌ 显式抛错：角色卡文件归面板/Agent 工具 |
| 人设（persona）家族 | ⚠️ 读取 ✅；`replacePersona`/`updatePersonaWith`/`createPersona`/`createOrReplacePersona` 写会话副本；`deletePersona` 显式抛错 |
| 预设（preset）家族 | ⚠️ 读取 ✅（真实预设）；`replacePreset`/`updatePresetWith`/`createPreset`/`createOrReplacePreset` 写会话副本；删除/改名/激活显式抛错 |

写**基础资产**走管理面板或 Agent 工具（`card_put` / `world_put` 等，带确认协议）。
前端只被允许改「本聊天的会话世界书副本」：误触最坏只污染这一条聊天，删掉副本
（或点「重置会话世界书」）即可回到卡原版。

### 5.3 脚本 / 扩展 / 音频 / 其它

| 家族 | 结果 |
|---|---|
| 脚本容器 | ✅ 右栏「卡脚本」tab：每个脚本独立沙箱 iframe；`getScriptId/Name/Info`、`replaceScriptInfo`、`getScriptTrees(type)`、`replaceScriptTrees`、`getAllEnabledScriptButtons` 可用；按钮条渲染在容器内并回投事件 |
| 扩展安装/卸载/更新 | ❌ 显式抛错；`isAdmin`/`getExtensionType`/`isInstalledExtension`/`getExtensionStatus`/`getTavernHelperExtensionId` 只认 JSR 扩展自身 |
| `playAudio` / `pauseAudio` / `getAudioList` / `replaceAudioList` / `appendAudioList` / `getAudioSettings` / `setAudioSettings` / `getCurrentAudio` / `audioEnable` / `audioImport` / `audioMode` / `audioPlay` / `audioSelect` | ✅ iframe 内 `<audio>`，只影响本前端，不写宿主播放器 |
| `formatAsDisplayedMessage` | ✅ 宏 → display 正则 → showdown |
| `retrieveDisplayedMessage` / `refreshOneMessage` | ❌ 宿主消息 DOM 在沙箱外，显式抛错 |
| `errorCatched` / `getMessageId` | ✅ 均已提供 |
| `registerVariableSchema` | ⚠️ 保存 schema 供 iframe 内变量管理器读取，不参与服务端校验 |
| `injectPrompts` / `uninjectPrompts` | ⚠️ 只影响本 iframe 的 `TavernHelper.generate`，不进入宿主 AgentLoop |
| `TavernHelper.iframe` 家族（跨 iframe 通信） | ❌ 不存在（本插件没有跨 iframe 注册表） |

**调用不存在或明确不支持的函数会抛带原因的 error**——这是特性：
它让"照抄的代码"在第一时间显式失败，而不是悄悄什么都不做。

---

## 6. STscript（`triggerSlash`）

`window.triggerSlash(command)` / `triggerSlashWithResult(command)` 已暴露，返回 `Promise<string>`；
内部走同一个 `slash` op。

```js
await triggerSlash('/setvar mood calm')
```

生成控制（`/trigger`、`/regenerate`、`/stop`）仍然受限：见 §5.1。

服务端可用命令（`POST /helper` 的 `slash` op）：

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
| `eventOn(tavern_events.GENERATION_ENDED, refresh)` | `setInterval(refresh, 1500)` + `eventOn(tavern_events.MESSAGE_RECEIVED, refresh)`；`TavernHelper.generate` 成功时另有 `iframe_events.GENERATION_ENDED` |
| `toastr.error('…')` | 直接用：`toastr` 已内置最小实现 |
| `$('#chat').append(...)`（改宿主 DOM） | 只能改自己 iframe 内的 DOM |
| `fetch('/api/backends/…')` | 🧱 不可用；需要的数据请走本页的 `get*` 函数 |
| `Vue.createApp(...)` | 直接用：`Vue` / `VueRouter` 已注入 |
| `generate({user_input, custom_api, …})` | 直接用：插件服务器代理卡内 OpenAI 兼容 API（见 §2.4），不要自己 `fetch` |
| `getVariables({type: 'preset'})` | 用 global 或 chat 作用域替代 |
| `setChatMessages([...], {refresh: 'all'})` | `refresh` 无效；自己重绘当前 UI |
| `createWorldbookEntries(...)` | 提示用户去面板操作，或让 Agent 调 `world_*` 工具 |
| `updateWorldbookWith(name, fn)` | 直接用：写当前聊天的会话副本；要回退就点右栏「卡脚本」→「重置会话世界书」 |
| `window.top.document` 上的悬浮面板 | `window.top` 已指向宿主 facade，`document` 代理真实 iframe document；挂载点写 `document.body` 即可 |

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
| 控制台反复出现 `Tracking Prevention blocked access to storage for <URL>`（cdnjs / 字体 CSS） | Edge/Chrome 的跟踪防护阻止第三方 CDN 使用 Cookie/localStorage；样式与脚本本身仍会加载 | 不是插件 CSP，也不是卡错误；介意日志可在浏览器允许该 CDN，或忽略 |
| `Connecting to 'http://127.0.0.1:3080/version' violates ... connect-src https: blob:` | 卡的前端把 `/version` 探测发到宿主机 HTTP 端点；沙箱 CSP 默认/外部资源模式都只放行 `https:`，不开放宿主 HTTP | 这是刻意的隔离边界；该探测在 MagVarUpdate 内被 catch 后回落版本号，不影响 MVU。不要为它放开 `connect-src http:` |
| 卡报 `SillyTavern.loadWorldInfo is not a function` | MagVarUpdate 的角色设置覆盖会读 `SillyTavern.loadWorldInfo` | 更新构建：返回 `{ entries: { [uid]: entry } }`，只读当前聊天世界书（会话副本优先） |
| 改了 `data` 但界面没变 | `setChatMessages` 的 `refresh` 无效 | 自己重绘 |
| `renderMarkdown` 输出原文 | showdown 脚本未加载（CDN 被墙/离线） | 自行降级或内联渲染 |
| `Mvu.getMvuData()` 返回 `undefined` | 聊天还没有 `stat_data`（新卡首轮尚未投影）或当前卡未被识别为 MVU 卡 | 先发一轮让投影器结算；确认卡内有 `<UpdateVariable>` / `MagVarUpdate` / `StatusPlaceHolderImpl` |
| 启动时报 `lodash.min.js: Expected a function`，调用栈指向 `util.ts` | 卡脚本在模块求值阶段执行 `_.debounce(SillyTavern.saveChat, …)`，旧 shim 上没有 `SillyTavern.saveChat` | 更新构建：`SillyTavern.saveChat` 返回已解决的 Promise（变量/楼层写盘仍走 helper RPC），`saveSettingsDebounced`、`extensionSettings`、`chatCompletionSettings` 同步补齐 |
| 启动时报 `external var "YAML":1 Uncaught ReferenceError: YAML is not defined` | MagVarUpdate 在模块求值时读取全局 `YAML` 的 `parse` / `stringify` / `parseDocument` | 更新构建：iframe 预注入 yamljs（经典脚本，`window.YAML`），并补 `parseDocument(...).toJS()`；CDN 失败时用 JSON 兜底避免直接 ReferenceError |
| 卡报 `getAllVariables is not defined`，或 `Mvu.getAllVariables is not a function` | 卡用合并变量表读当前 MVU 树 | 更新构建：`window.getAllVariables()` 与 `Mvu.getAllVariables()` 返回 `global ← character ← chat ← 最新楼层` 的合并表，`stat_data` 在顶层 |
| 控制台反复 500 且卡报 `character variables are read-only` | 卡把 `{type:'character'}` 当可写表（UI 偏好、镜像快照） | 更新构建：角色作用域写入 `state.json` 的 `characterVariables[角色名]` 覆盖层，角色卡文件保持只读；删除该键即重置 |
| 首次挂载报 `棋盘宿主通信初始化失败：页面安全策略阻止了本地消息桥` | 卡通过 `window.top.Function` 在“宿主 realm”构造 `postMessage` 函数，旧 facade 没有转发 `Function` | 更新构建：`window.top` / `window.parent` facade 暴露 `Function` 与浏览器全局兜底；函数仍在沙箱 iframe 内执行 |
| 卡点击发送后提示 `/trigger is not available` 并回退到 DOM 派发 | 卡用 `createChatMessages` 建用户楼层后要求前端触发宿主生成 | 更新构建：该 iframe 刚创建的末条用户楼层会被替换成一次宿主 composer 发送；其它 `/trigger` 调用仍明确报错，避免双驱动或重复楼层 |
| 卡前端里的 `iframe` / `srcdoc` 画面空白 | 嵌套 `srcdoc` 本身不受 `frame-src 'none'` 拦截；常见原因是父 facade 缺少 `Function`、`document.createElement` 或浏览器全局 | 先用 iframe console 确认初始化错误；更新构建中的 facade 兜底 |
| 「美化前端」显示空白画布，但「自动运行中（N 个卡脚本）」 | 当前聊天没有完整 HTML 楼层；自动运行的卡脚本只是浮层，不是主界面。很多卡的开局界面由**正则**生成（例如「开局正则」匹配首楼并替换成完整 HTML），该正则被 `disabled: true` 跳过 | 在「正则脚本」分区「从角色卡同步」，启用匹配首楼的 HTML 正则（必要时同步启用状态栏正则），回「美化前端」点刷新；首楼已保存时重渲染即可，必要时新建聊天/重生成首楼 |
| 状态栏一直空 | 模型没有输出 `<UpdateVariable>`，或卡内状态栏正则被禁用 | 用提示词查看器看实发请求；确认正则未 disabled；首轮检查 `initialized_lorebooks` 是否已播种 |
| 表单/快速选项点了没反应 | 宿主页找不到可见 composer，或输入框被面板遮挡 | 看 iframe console 的 `no visible host composer textarea found`；先把输入框滚动到可视区 |
| 卡里的按钮点了没反应 | 按钮是 `disabled` / `aria-disabled="true"`（例如行动台的「必杀」在净化之力 <100 时），浏览器不派发 click；或 MVU 写入失败被卡自己吞掉 | 宿主不再为 disabled 控件额外弹提示（以卡自己的禁用态为准）；变量写入失败仍会弹「变量写入失败: …」toast |
| 世界书写入后生成/状态栏没变化 | 副本按聊天隔离，且生成读取的是**副本**；基础 `worlds/` 面板不会显示副本内容 | 用 `getWorldbook(name)` 读回确认副本；需要回到原版就点「重置会话世界书」 |
| 刷新后 GM 面板的 Zod 改动不见了 | 改动只在会话脚本树副本里；写入失败时 `updateScriptTreesWith` 会拒绝而不是假装成功 | 看卡脚本 tab 列表是否显示改后的名称/字符数；确认 `scripts.put` 没报错。切到别的聊天本来就读不到本聊天的副本 |
| 重置卡脚本后 GM 面板还是旧内容 | 重置会删除副本并停止正在运行的脚本，但已经打开的 GM 面板不会自我改写 | 重新点「运行」；列表此时应回到角色卡原版 |
| GM 悬浮面板挂载时报 `appendChild of null` | 卡脚本未运行，或运行的是旧构建（`fakeDocument.body` 为 null） | 开启 `cardScriptsAutoRun` 让 AgentTavern 在「美化前端」里自动运行；关闭设置时可在右栏「卡脚本」手动运行 GM 面板；确认构建包含 document facade |
| 启动诊断报 `TypeError: t[e(...)] is not a function` | 卡调用了 `getLoadedPresetName` / `getPreset` / `getCharData` 等旧构建缺失的 JSR 函数 | 更新到包含 §2.4 / §4 新兼容面的构建；本插件现在提供这些函数 |
| 资源包下载完成却报「资源包已损坏」 | 资源包密钥由卡的 `creator` / `character_version` / `creator_notes` 派生；`getCharData('current').data` 必须是 V2 原始字段（snake_case），宿主内部的 IR（`characterVersion` / `creatorNotes`）不能直接暴露给卡 | 更新构建并让 iframe 重新渲染；仍失败时检查下载是否被代理/断流截断 |
| 资源包首次加载时控制台报 `frontend/idb/get` 404 | 虚拟 IndexedDB 的缓存未命中被当作错误返回；原生 `get()` 未命中应是 `onsuccess(undefined)`，部分卡把任何 IndexedDB 失败都当成缓存损坏 | 更新构建：未命中返回 204，shim 以成功结果回填 `undefined` |
| 结构化生成报 `returned no text (finish_reason=tool_calls)` | 供应商把结果放进 `message.tool_calls`，`content` 为 null；旧桥只读 content | 更新构建：`generate` 代理在 content 为空时返回 `tool_calls[].function.arguments` / 旧式 `function_call.arguments` 的文本 |
| 卡报 `Connecting to 'blob:null/…' violates ... connect-src https:` / `Fetch API cannot load blob:` | 资源包或 WASM 加载器把本地数据包成 blob URL 再 `fetch`；旧 CSP 只放行 `https:` | 更新构建：开启「允许美化前端加载外部资源」后 `connect-src` 为 `https: blob:`；blob 不增加外网可达面 |
| 控制台反复出现 `[Violation] Permissions policy violation: unload is not allowed in this document` | Chromium 默认禁止跨源 iframe 注册 `unload`；沙箱 `srcdoc` 没有响应头，`allow="unload"` 也无法把它打开 | 宿主注入垫片，把 iframe 内 `window` / `document` 的 `unload` 监听转成 `pagehide`；卡代码无需改 |
| `Invalid or unexpected token` 出现在插件 client bundle | 加载了包含模板字面量注释的旧/中间构建 | 重新构建并重启 DSH；`client/index.js` 必须通过 `node --check` |
| 字体报 `font-src ... blocked` | 旧 CSP 只允许 `data: https:`，卡用 blob URL 字体 | 更新构建：`font-src data: blob: https:` |

---

## 9. 安全提醒（给你的，也是给玩家的）

- 你的前端**读不到**宿主的 Cookie、localStorage、其它聊天、API Key；
- 你的前端**改不了**角色卡、基础世界书资产、脚本、设置；
- 你的前端**能改**当前聊天的正文、楼层变量、聊天变量、global 变量、角色作用域覆盖层，以及当前
  聊天的**会话世界书副本**——这些都是真实数据，写之前先读、先确认，别在
  `setInterval` 里无脑覆盖。角色覆盖层只落 `state.json` 的 `characterVariables`，角色卡文件本身仍是只读；副本可以随时用「重置会话世界书」丢弃，角色覆盖层删除对应角色键即可重置。
- 你的前端 `localStorage` 会按角色写回 `state.json` 的 `frontendStorage`
  （上限 512KB/角色）；`sessionStorage` 只在 iframe 内。
- `TavernHelper.generate` 的 `custom_api.key` 只随单次 RPC 进入宿主 Node 进程，
  用于 outbound `Authorization`；不写 snapshot/state.json/日志，错误消息会 redact。
  只对信任的卡配置 API 源。
- `replaceVariables` 是**整表替换**：忘了展开旧值就等于把所有变量清空。
  不确定时用 `insertOrAssignVariables` 或 `updateVariablesWith`。
