# JSR / MagVarUpdate 卡的 Agent 模式兼容（MVU-ZOD 兼容卡）

> 日期：2026-10-21。来源：用户导入的 MVU-ZOD 兼容卡（`v3.3.3_Hotfix.png`；卡名与题材
> 不在此记录）后要求「尽可能兼容这个卡的运行，重点考虑 Agent 模式与前端」。
> 落点：`packages/plugin/src/agent-tavern/mvu-compat.ts`、`card-state.ts`、
> `projector.ts`、`session/command.ts`、`http/router.ts`、`helper.ts`、
> `packages/plugin/client-src/10-frontend-frame.js`、`11-helper-bridge.js`、
> `packages/tavern-template/src/{api,runtime}.ts`、文档与测试。

## 问题

这张卡不是「HTML 美化前端 + 静态世界书」的普通卡，它的运行链路是：

```
卡内 EJS 世界书（46 条 constant）
  → 模型输出 <UpdateVariable><JSONPatch>
  → 酒馆助手脚本 MagVarUpdate 解析 patch、写 stat_data
  → 展示层正则 StatusPlaceHolderImpl → READY → 154KB 状态栏 HTML
  → 前端通过 window.parent.Mvu / getChatMessages 读变量并驱动按钮
```

导入到 AgentTavern 后有三处断点：

1. **脚本树不执行**：`extensions.tavern_helper.scripts` 里的 MagVarUpdate / Zod /
   游戏引擎 / 悬浮 GM 面板都不会跑；`<UpdateVariable>` 没人解析，`stat_data`
   永远不存在。
2. **EJS 世界书不注入**：AgentTavern 静态资产走工具按需读取，不会像 ST 那样
   每轮渲染 constant 世界书。模型看不到阶段规则、事件处理器和输出协议。
3. **前端直连宿主**：卡前端大量使用 `window.parent.Mvu`、`window.parent.toastr`、
   `window.parent.document.querySelector('#send_textarea')`；沙箱没有
   same-origin，这些调用直接抛异常。`getCurrentMessageId` / `Mvu` 也未定义。

另外卡内 EJS 用了 lodash 的 `random/sample/sampleSize`，并把 `<%= %>` 写在
同步 `forEach` 回调里；模板编译器统一生成 `await (expr)`，在非 async 回调中
会变成 `ReferenceError: await is not defined`。

## 决议

### 1. 服务端接管 MVU patch（`mvu-compat.ts`）

- 投影器在助手楼层落库前解析 `<UpdateVariable>` / `<JSONPatch>`；
- 宽松 JSON Patch：`replace` / `insert` / `add` 自动补中间对象，`delta` 数值增减，
  `当前` 路径按 sibling `最大` clamp，`remove` 缺失即幂等；容忍注释、尾逗号、
  Markdown 围栏；
- 写回 `chat_metadata.variables.stat_data`，补 `initialized_lorebooks`，并给
  楼层 `variables.stat_data` 挂快照（`getChatMessages().data.stat_data` 同源）；
- 卡内声明 `StatusPlaceHolderImpl` 时补占位符，展示层正则按原顺序完成
  READY → 状态栏；
- 新聊天 / 旧聊天激活时播种 `{ initialized_lorebooks: true, stat_data: { 系统状态: { 主角创建完毕: false } } }`。

### 2. 每轮注入卡内 EJS 世界书（`card-state.ts`）

- 只对 `cardUsesJsrMvu` 的卡启用；
- `agent/pre-step` 的 step 1 追加一条 plugin-source 消息，append-only，不烧 KV 前缀；
- 首轮全量；后续只注入渲染结果变化的条目；每 8 轮全量刷新，对抗 compaction；
- 渲染走 `createMvuRuntime`（与 MVU 结算共享模板运行时），local 变量是
  `chat_metadata.variables` + chat 作用域 overlay 的拷贝，渲染不写库；
- 120k 字符预算，按 `order` 排序；渲染失败只告警并跳过该条。

### 3. 前端 facade（client half）

- `Mvu`：`getMvuData` / `replaceMvuData` / `events.VARIABLE_UPDATE_ENDED` /
  `isDuringGenerating`；写穿走新的 `mvu.replace` helper op；
- `toastr`：最小浮层实现；
- `getCurrentMessageId`：由 `FrontendFrame` 的 `messageId` 注入；
- `window.parent` / `window.top`：`buildFrontendDocument` 改写为
  `window.__dshTavernHost`，同时兜底 `defineProperty`；facade 提供 `Mvu`、
  `toastr`、`SillyTavern`、`TavernHelper`、`document`；
- `#send_textarea` / `#send_but`：映射到宿主页真实可见 textarea（原生 setter +
  input 事件）；`composer.send` 尽力按 Enter / submit，失败保留已填文本并显式报错；
- `localStorage` / `sessionStorage`：sandbox 无 same-origin，原生访问抛
  `SecurityError`；注入前改写到 iframe 内存实现，创角表单的自动保存/签名恢复
  不再中断（页面重载即失，可接受）。

### 4. 模板运行时

- `buildSandboxEnv` 注入隐藏 `await(value)` 助手：非 async 回调里的 `<%= %>`
  退回同步取值；遇到 thenable 则抛出明确错误，不输出 `[object Promise]`；
- mini-lodash 补 `random` / `sample` / `sampleSize` / `clamp` / `uniq` / `isEqual` / `unset`。

## 否决项

- **执行完整 JSR 脚本树**：需要跨楼层常驻脚本宿主、脚本生命周期、按钮注册表与
  无沙箱同源模型；与当前「每条消息一个 sandbox iframe」的安全边界冲突，且这次
  卡的状态栏/行动台都是消息内 HTML，不需要脚本树才能显示。
- **在 iframe 里加载 MagVarUpdate bundle 并跑 Zod**：bundle 依赖 `window.parent`
  同源与网络 `connect-src`；沙箱不放行。Zod 的派生/拒绝语义若要用，应在服务端
  以显式 schema 运行时实现，不能靠卡内脚本。
- **把整份卡规则每轮全量注入**：46 条原始 195k 字符，长局会烧穿上下文；按渲染
  结果 + 变化 diff 注入，首轮全量、8 轮刷新。
- **自动提交用户消息**：`composer.send` 只在卡表单点击时尽力发送；生成循环仍归
  宿主 AgentLoop，插件不伪造用户 turn。

## 边界

- `tavern_helper.scripts` 仍然不执行：游戏引擎、悬浮 GM 面板、Zod 热编辑、脚本
  按钮不会工作；状态栏/行动台/快速选项这些 HTML 前端可用。
- Zod schema 不执行：字段派生、enum 拒绝、卡自定义 clamp 不保证；只做通用
  `当前/最大` clamp 与结构兜底。
- 卡内 EJS 的随机条目每轮重新掷骰，与 ST 每轮渲染语义一致；变化 diff 会把它
  当作变化条目重复注入。
- `composer.send` 是 DOM 级 best-effort（宿主版本敏感）；找不到 composer 时
  显式失败，不静默。
- 群聊不走 AgentTavern 卡状态注入（群聊固定 ST）。

## 测试

- `packages/tavern-template/tests/template.spec.ts`：同步回调 `await` 回归、
  lodash 新方法、thenable 明确报错。
- `packages/plugin/tests/agent-tavern-mvu-jsr.spec.ts`：patch 应用、clamp、
  `&` 键、占位符、非法 JSON、非 MVU 卡 no-op、投影器 e2e。
- `packages/plugin/tests/agent-tavern-card-state.spec.ts`：EJS 渲染、变量门槛、
  lodash、禁用条目、pre-step 注入、全量/变化格式。
- `packages/plugin/tests/helper-route.spec.ts`：`mvu.replace` 写穿聊天权威树 +
  楼层变量 + snapshot。
- `packages/plugin/tests/helper-client.spec.ts`：Mvu/toastr/parent facade/composer
  入口与文档同步。
