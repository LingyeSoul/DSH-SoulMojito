# JSR 4.11 兼容面补齐：同步契约、会话级覆盖与脚本容器

> 日期：2026-10-23
> 触发：用户要求「本插件 JSR 兼容和原版 JSR 还有多少区别」并指定：能实现的实现，
> 修改内容的按会话级世界书机制处理，脚本容器由管理面板/右栏提供分页。
> 参考：JS-Slash-Runner 4.11.3（`cee1fb4`，浅克隆只读对照；未拷贝源码）。
> 落点：`packages/tavern-jsr`（iframe 运行时）、`packages/plugin/src/helper.ts`（宿主域操作）、
> `packages/tavern-store/src/store.ts`（会话覆盖层）、`packages/plugin/client-src/88b-ui-card-scripts.js`（脚本容器）。

## 问题

2026-10-22 的兼容层只覆盖 67/179 个 JSR 公共名，其中 30 个有语义偏差：变量写 API 返回
Promise（JSR 4.11 是同步）、`substitudeMacros` 原样返回、`getTavernRegexes` 返回 Promise
且是内部 IR 形状、`getPreset` 是空壳、`getScriptTrees` 忽略 `type`、`TavernHelper`
命名空间只有 46 个名字、`SillyTavern.getContext().chat` 是 JSR 形状而不是 ST 形状。
「名字能对上」不等于「契约能对上」。

## 决议

### 1. 表面与命名空间

- `TAVERN_HELPER_SURFACE` 固定为 JSR 4.11.3 的 179 个公共名；运行时把每个已安装的
  `window[name]` 反射到 `window.TavernHelper[name]`，保证两个出口是同一函数对象。
- 无法实现的家族安装**显式抛错**的桩（角色卡写、扩展安装、导入原始资产、宿主 DOM），
  错误消息说明原因和替代入口；不做静默 no-op。
- `getTavernHelperVersion()` 返回 `4.11.3`（本轮实现的 API 代际）；`getTavernVersion()`
  返回 `0.0.0`（semver 形状，避免 `compare-versions` 抛错，同时让 ST 特性门保持关闭）。

### 2. 同步契约

JSR 4.11 的变量写 API、正则读/格式化 API、脚本树读 API 都是同步的。沙箱里真正的
持久化是异步 RPC，因此采用「乐观本地写 + 有序后台落盘」：

- `replaceVariables` / `insertOrAssignVariables` / `insertVariables` 同步返回（`void` / 新表）；
- `updateVariablesWith` 在 updater 同步时同步返回新表，异步时返回 Promise；
- `deleteVariable` 同步返回 `{ variables, delete_occurred }`；
- 写失败弹 error toast，下一次快照会覆盖本地乐观值；
- `getTavernRegexes` / `formatAsTavernRegexedString` 从快照内的正则脚本本地同步应用，
  宏替换也在 iframe 内同步完成（`{{char}}` / `{{user}}` / `{{getvar::}}` / `registerMacroLike` 等）。

### 3. 会话级覆盖（内容修改）

用户指定：内容修改沿用会话级世界书机制。本轮把覆盖层文件扩展为「会话 JSR 覆盖层」：

`chats/<角色>/<聊天>.jsonl.scripts.json`

```
{
  version: 1,
  scriptTrees: [...],                 // 兼容旧构建 = character 树
  trees: { character?, preset?: { [preset]: [...] }, global? },
  scriptVariables: { [scriptId]: {...} },
  presets: { [name]: Preset },
  personas: { [name]: Persona }
}
```

- 世界书：`lorebook.put` / `lorebook.create` / `lorebook.delete` 只写 `chats/<角色>/<聊天>.jsonl.worlds.json`；
  基础资产用空墓碑覆盖本聊天，`worlds/<name>.json` 永远不动。
- 脚本树：character/preset/global 三种 `type` 都写本聊天的覆盖层；`preset` 读取回落到
  激活预设内嵌树。
- 预设/人设写面写会话副本；删除/改名/激活仍抛错（面板资产）。
- 角色卡写、基础世界书新建、扩展安装、`importRaw*` 仍抛错（不可安全会话化）。

### 4. 脚本容器

右栏「卡脚本」tab 升级为容器：脚本列表（含禁用项）、每个脚本独立沙箱 iframe、
`scriptId`/`scriptName`/`scriptInfo`、`getScriptInfo`/`replaceScriptInfo`、
`getScriptTrees(type)`/`replaceScriptTrees`、`getAllEnabledScriptButtons`；
脚本上报的按钮渲染为容器按钮条，点击按 `getButtonEvent(name)` 回投事件。
AgentTavern 的 `cardScriptsAutoRun` 仍是共享前端模式（注入「美化前端」同一文档，
GM 面板要叠在前端上）：每段脚本注入 per-script scope，`getScriptId` /
`getScriptName` / `getScriptInfo` / `replaceScriptInfo`、按钮 API 以及
`{ type: 'script' }` 变量读写按所属脚本归属，按钮条渲染在「美化前端」tab 并回投；
脚本之间共享 DOM/事件总线，不做逐脚本隔离。容器 tab 负责手动运行与 ST 自动运行
的逐脚本隔离；共享模式里的显式 `window.*` / `TavernHelper.*` 调用仍是共享面，
`window.getScriptId()` 返回前端占位 id。

未采用「自动运行也逐脚本 iframe」：GM 面板的悬浮球/面板要叠在美化前端上，
而 `eventEmit` 是 iframe 本地的、`getScriptTrees` 在每个 iframe 各有一份副本，
拆开还需要跨 iframe 事件总线和脚本树广播；这条路的收益（隔离）与 2026-10-21
已确认的叠层需求直接冲突，留待以后有独立 overlay 宿主时再评估。

### 5. 框架面

`SillyTavern.getContext()` 返回 ST 形状的 `chat`（`mes`/`is_user`/`is_system`/`swipes`）
与 `eventSource`/`eventTypes`；新增 `EjsTemplate`（宿主 `template.render`，复用生成链路的
`node:vm` 沙箱）、`initializeGlobal`/`waitGlobalInitialized`、`injectPrompts`（只作用于
`TavernHelper.generate`）。

## 否决项

- **把 JSR 的零隔离模型搬进来**：与沙箱信任边界冲突，继续拒绝。
- **对不支持的函数静默 no-op**：会让「照抄代码」在错误路径上跑很久；改为显式抛错。
- **把预设/人设写进基础资产**：违背「前端只能改本聊天」的既有边界。
- **把正则写面做成会话覆盖**：正则同时影响生成管线，需要会话层正则读取接入；
  本轮保持只读，避免半生效状态。

## 边界（仍然不同）

- 同源宿主 DOM、`fetch`/WebSocket、真实 ST 扩展目录：结构性不可用（沙箱/CSP）。
- `generate` 仍要求卡内 `custom_api`，不走 ST 预设管线；overrides/tools/json_schema/流式
  仍被忽略（属于生成管线改造）。
- 正则写面、角色卡写面、基础世界书新建、扩展管理、`retrieveDisplayedMessage`/
  `refreshOneMessage`：显式抛错。
- 消息正文与完整 HTML 文档同楼时，正文保留在 iframe 上方；JSR 的「逐 `<pre>` 原地替换」
  不逐字复刻。
- AgentTavern 自动运行没有逐脚本隔离：脚本共享前端文档的 DOM 与事件总线；
  per-script scope 只覆盖裸调用，显式 `window.getScriptId()` 仍是共享占位 id。

## 测试

- `packages/tavern-jsr/tests/runtime.spec.ts`：179 个公共名 golden、同步变量写、宏展开、
  正则签名/目的地过滤、ST 形状 chat/eventSource、脚本容器身份/按钮聚合、共享文档
  per-script 身份/按钮/脚本变量隔离。
- `packages/plugin/tests/helper-route.spec.ts`：脚本树三来源与 info/buttons 回写、
  会话世界书新建/墓碑删除、聊天世界书绑定、预设/人设会话副本、楼层旋转、EJS 渲染。
- `packages/plugin/tests/helper-client.spec.ts`、`card-scripts*.spec.ts`：客户端标记与容器行为。
