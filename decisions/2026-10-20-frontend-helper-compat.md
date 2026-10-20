# 美化前端：右栏自动展开开关 + 酒馆助手（Tavern-Helper）兼容层

> 日期：2026-10-20。来源：用户需求「自动展开 tab 做成设置开关，前端美化 HTML
> 要深度兼容酒馆助手行为，浅克隆参考 https://github.com/N0VI028/JS-Slash-Runner」。
> 落点：`packages/plugin/src/helper.ts`、`client-src/11-helper-bridge.js`、
> `client-src/10-frontend-frame.js`、`client-src/88-ui-frontend.js`、
> `86-ui-composer.js`、`83-ui-prompts.js`、`tavern-store/src/store.ts`、
> `http/router.ts`、gates 与测试。前序决策：
> [`2026-10-20-frontend-sidebar.md`](2026-10-20-frontend-sidebar.md)。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | server `src/helper.ts`（POST helper 的 op 分派）；client `11-helper-bridge.js`（iframe 内 shim）与 `10-frontend-frame.js` 的 `useHelperBridge`（宿主侧代理） |
| 唯一事实来源 | Tavern store（聊天文件、`chat_metadata.variables`、chat 作用域 VariableStore、`state.scriptGlobals`、角色卡/世界书）；客户端 `sessionBindings` 是唯一身份来源 |
| 持久态 | 沿用既有持久面：变量写走 `saveChat`（CAS）+ VariableStore；新增 `frontendAutoOpen` 一个布尔设置（默认 false） |
| 临时态 | iframe 内 `state`（快照副本）与 `pending`/`listeners` 两个 Map；宿主侧 `previousRef`（事件比对基线）。全部随 iframe/组件卸载消失 |
| 外部依赖 | lodash 4.17.21 与 jQuery 3.7.1，来自既有 CSP 白名单 `cdn.jsdelivr.net`（JSR 自带同款库）；无新 npm 依赖 |
| 注册入口 | `POST /api/dsh-soulmojito/helper`（router 分支）；iframe head 注入 `helperLibraryTags() + frontendHelperScript(token)`；`buildFrontendDocument` 单一注入点覆盖内联/MVU/侧栏三种宿主 |
| 删除路径 | 删 `src/helper.ts` 与路由分支、`11-helper-bridge.js` 与 manifest 条目、`useHelperBridge` 与 `FrontendFrame` 的 `binding/refreshKey` props、`useFrontendAutoOpen`、设置开关与 `frontendAutoOpen` 状态字段、gates 的两条路由 marker 与自测、两个 spec 与本决策；沙箱与 CSP 不变，删掉后前端的 TavernHelper 调用变成 `undefined is not a function`（显式失败，不静默） |
| 兼容对象 | 无 TavernHelper 依赖的前端完全不受影响（只是多两个 head 脚本）；ST 架构内联渲染同样获得兼容层；旧宿主没有 sidebarRight 时兼容层照常可用（它不依赖右栏） |

## 1. 自动展开开关

原来右栏 tab 只在手动入口出现。现在：

- **设置项** `frontendAutoOpen`（默认 false），设置页「AgentTavern 上下文」组里的
  第三个 checkbox：`美化前端出现时自动打开右侧栏（每聊天一次）`。
- 开启后由 `useFrontendAutoOpen` 在**标题栏**挂 watcher（tab 没开时 body 不挂载，
  watcher 必须比 tab 活得久）。每 `(sessionId, 聊天, 楼层)` 只自动展开一次——
  用户手动关掉后不再抢焦点。5s 轮询、页面不可见停发，与游戏自动展开同款纪律。
- 关闭时**零轮询**（`if (!enabled …) return undefined`），不是"扫到了但不开"。

## 2. 兼容层的信任模型（为什么不抄 JSR 的沙箱）

JSR 的两类 iframe 都**无 sandbox、无 CSP**，并 `_.pick(window.parent, …)` 直拷约
200 个 API——AI 产出的前端因此拥有全量宿主权限。本插件保持
`sandbox="allow-scripts"`（无 same-origin）+ CSP `connect-src 'none'`：

```
iframe (无宿主对象)
  ├ window.getVariables(...) ─┐
  │                            ├ postMessage {token, op, payload}
  └ window.eventOn(...)        │
                               ▼
宿主 useHelperBridge: sessionBindings 注入 character/chatId
                               ▼
                  POST /api/dsh-soulmojito/helper
                               ▼
                   Tavern store（唯一事实来源）
```

三条硬纪律：

1. **身份不可伪造**：iframe 只能发 op 与 payload；`character`/`chatId` 由宿主按
   自己的 `sessionBindings` 追加。没有绑定则明确失败（`this frontend is not bound
   to a Tavern chat`），不回落到 activeCharacter 猜。
2. **token + event.source 双校验**：与高度回传同款；不匹配消息直接丢弃。
3. **沙箱与 CSP 一字不改**：兼容层不新增网络面、不放宽 same-origin、不开嵌套
   frame。库脚本走既有白名单。

## 3. 覆盖范围（诚实清单）

| 家族 | 已实现 | 说明 |
|---|---|---|
| 变量读 | `getVariables({type})` | global / chat / message / character；同步读快照副本 |
| 变量写 | `replaceVariables` / `updateVariablesWith` / `insertOrAssignVariables` / `insertVariables` / `deleteVariable` | global / chat / message 可写；character 只读（抛明确错误） |
| 楼层读 | `getChatMessages(range, option)` / `getLastMessageId()` | range 支持 `-1`、`'0-10'`、`'0-{{lastMessageId}}'`；role / hide_state / include_swipes |
| 楼层写 | `setChatMessages` / `createChatMessages` / `deleteChatMessages` | 支持 message/swipes/swipe_id/data/extra/is_hidden；`insert_before`；走 `saveChat` CAS + `chat-saved` 事件 |
| 事件 | `eventOn` / `eventOnce` / `eventEmit` / `eventEmitAndWait` / `eventRemoveListener` / `eventClearEvent` / `eventClearListener` / `eventClearAll` | iframe 内广播；`pagehide` 整组注销 |
| 事件常量 | `tavern_events`（10 个）/ `iframe_events`（7 个） | **只广播宿主能真实观测到的**：楼数增加 → MESSAGE_RECEIVED、正文变化 → MESSAGE_EDITED、删楼 → MESSAGE_DELETED、切聊天 → CHAT_CHANGED、挂载起止 → RENDER_STARTED/ENDED。未桥接的事件名保留常量但不触发（不假装） |
| ST 上下文 | `SillyTavern.getContext()` | 最小只读面（chatId/chat/chat_metadata/name1/name2/characters） |
| 工具 | `getButtonEvent` / `getScriptId` / `waitGlobalInitialized` / 内嵌 lodash+jQuery | 形状兼容；按钮事件不接 Q R bar（本插件没有） |
| STscript | `/setvar` `/getvar` `/addvar` `/incvar` `/decvar` `/delvar` `/send` `/cut` `/regex` `/if` `/random` `/pick` | 走本仓库解释器；写盘与 chat 动作同一 CAS 路径 |
| 未支持 | 生成控制（generate/trigger/regenerate/stop）、世界书/角色卡写入、script/preset/extension 变量、`TavernHelper.iframe` 家族 | 一律明确报错或不存在，**不静默 no-op** |

### AgentTavern 的双写一致

AgentTavern 聊天的变量有两个读者：`chat_metadata.variables`（ST 兼容展示树，
含 `$` 键）与 chat 作用域 VariableStore（MVU 与工具面的权威源）。兼容层的
`replaceVariables({type:'chat'})` 在检测到 AgentTavern 绑定时**同时写两处**：
`$` 前缀键只进展示树，能通过变量名正则的叶子写进 VariableStore，其余旧叶子删除。
这样 HUD 与 MVU 状态栏看到的是同一份状态，而不是会漂移的两份副本。

## 4. 否决项

- **放宽沙箱 / 拷贝 parent API**：JSR 的模型是历史包袱。本插件的隔离等级更高，
  兼容层用 RPC 代理即可覆盖真实使用面，没有理由为了省一层 postMessage 交出宿主权限。
- **同源无 CSP 的"兼容模式"开关**：会在设置里引入一个"允许 AI 生成的 HTML 拿到
  全部权限"的开关，误开后无法审计。不做。
- **把每个酒馆事件都转发给前端**：宿主没有 ST 的事件总线，凭空造事件等于给前端
  假信号。只广播快照比对能证实的四类。
- **自动展开默认开启**：与"不打断写作"的默认纪律冲突，也违背前序决策里
  "不自动抢焦点"的记录。改为显式开关，默认关。

## 5. 边界与已知限制

- 楼层写走整份 `saveChat`（CAS）：大聊天上一次写要重写整个 JSONL。前端若高频
  修改楼层变量，建议用 `variables.replace({type:'message'})`（同样整写，但语义
  更清楚）或批量 `setChatMessages`。
- 快照是全量消息的浅拷贝（上限由聊天本身决定）。超长聊天（数千楼）会把整份
  messages 投给 iframe；这是"同步 getter"语义的代价，暂不做窗口化。
- `eventEmit` 只在本 iframe 内广播，不跨前端、不跨 iframe（JSR 的跨 iframe 事件
  面依赖宿主单例，本插件没有）。
- 世界书/角色卡只有读面（`SillyTavern.getContext()` 与 `characterData`）；写入面
  走既有面板与 Agent 工具，不给前端开写口子。

## 6. gates 与测试

- `REQUIRED_SERVER_ROUTES` 新增 `frontend/latest` 与 `helper`。
- `helper-route.spec.ts`：真实 store + 真实路由的 8 例——快照形状、global/chat/
  message 变量读写、character 只读拒绝、range/role 过滤、楼层增删改、STscript
  持久化、未知 op 明确报错。
- `helper-client.spec.ts`：客户端源码的 shim 面、沙箱与代理纪律、事件白名单、
  自动展开开关门控（含 store 默认值与解析器）。
- 内嵌 shim 脚本在 vm 里实际执行：`getVariables`/`eventEmit`/`getChatMessages`/
  `SillyTavern.getContext()` 形状与错误消息均按预期（一次性探针，未入仓）。
