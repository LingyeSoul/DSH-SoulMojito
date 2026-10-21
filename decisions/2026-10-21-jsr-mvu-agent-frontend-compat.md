# JSR / MagVarUpdate 卡的 Agent 模式兼容（MVU-ZOD 兼容卡）

> 日期：2026-10-21。来源：用户导入的 MVU-ZOD 兼容卡（`示例卡.png`；卡名与题材
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

## 补记：创建表单「正在连接状态机核心…」卡死（2026-10-21 二次）

**症状**：导入后创建表单能渲染，但一直停在 `正在连接状态机核心...`，全部按钮
无响应；状态栏/行动台同样整块失效。

**根因**：`applyRegexScript` 用 `text.replace(regex, replaceString)` 做字符串
替换。卡的四份美化 HTML（创建表单 71KB、行动台 35KB、手机状态栏 94KB、PC 状态
栏 154KB）里都含 JS 字面量 `'$__META_EXTENSIBLE__$'`，尾部 **`$'`** 在替换串
里被解释为「匹配点之后的整段原文」，把消息尾巴插进 `<script>` 的单引号字符串；
尾巴含换行时整段脚本 `SyntaxError`，`DOMContentLoaded` 回调一行都没执行——
转圈文案是静态 HTML，按钮监听器全没绑上。

**决议**：对齐 ST `engine.js` 的 `runRegexScript` 语义——替换走函数回调
（`$&`、`$'`、`` $` ``、`$$` 一律字面量），只展开 `{{match}}`、`$1..$n`、
`$<name>`，捕获组先过 `trimStrings`（保留既有的整段结果 trim）。投影器测试
里用 `$&` 包匹配的用例改为 ST 支持的 `{{match}}`。

**验证**：卡内四份 HTML 经 `applyRegexScript` 后逐个 `<script>` 过
`vm.Script` 语法检查全绿（修前 0/6/9 均报错）；`vitest run` 123 个文件、
1909 测试通过。

## 补记：前端自动发送改走宿主 conversation（2026-10-21 三次）

**症状**：创建表单能填，但点「签订契约」连续弹两条 toast：
`自动填入输入框失败: no visible host composer textarea found`、
`自动发送失败: no visible host composer textarea found`。

**根因**：DSH 0.2.1 的原生输入框是 Lexical contenteditable
（`[data-composer-input][contenteditable="true"]`），不是 `textarea`；旧实现只
扫 `document.querySelectorAll('textarea')`，并且把插件自己的 ST composer
（`[data-dsh-soulmojito-surface="composer"]`）主动排除了，两条路都走不通。

**决议**（用户 2026-10-21：「像已实现的插件插入消息来处理」「游戏桥的自动续弈
就能由插件直接发送消息」）：

- `composer.fill` / `composer.send` 按到达顺序串行化（链放在 hook ref 上，
  轮询重渲染不丢顺序）；
- AgentTavern 走**直投模式**：`composer.fill` 不写原生编辑器（返回
  `deferred`），`composer.send` 直接取 `ctx.sessions.scope(sessionId)`
  `.get('conversation')` 调 `send(text)`——与原生 composer 回车、游戏桥
  followup 同一条宿主 admission。**输入框完全不出现草稿**；发送后只在输入框
  内容仍是本次文本时清一次，兜住旧失败尝试/作用域晚 materialize 的残留；
- DOM 路径只作降级面（作用域未 materialize / 旧宿主）：优先插件 ST textarea，
  其次原生 textarea，最后 Lexical contenteditable（`execCommand('insertText')`
  触发 beforeinput/input，让 Lexical 编辑模型同步）；提交后显式清一次草稿，
  因为合成 Enter/click 可能绕过原生 draft 清理；
- iframe sandbox 增加 `allow-modals`：卡用 `prompt`/`confirm` 做方案命名与
  删除确认，没有该关键字时 Chromium 直接忽略并返回 null，看起来像按钮坏了。

**验证**：`helper-client.spec.ts` 新增 host-conversation 路由与 Lexical 输入面
的 source-check；`frontend-surface`/`frontend-runtime` gate 的 sandbox 与
useHelperBridge marker 同步；全量测试与 18 项 gate 通过。

**边界**：`conversation.send` 需要会话作用域已 materialize（活跃会话成立）；
取不到作用域时自动回落到 DOM 路径。发送内容是**真实用户 turn**（source
`user`），与游戏桥的 plugin notice 不同——创角表单属于用户提交，投影器需要
按 USER_INPUT 语义落库。

## 补记：首帧快照竞态导致状态栏「未检测到主角创建」（2026-10-21 四次）

**症状**：创角已完成，聊天文件的 `chat_metadata.variables.stat_data` 与
`/helper` 快照都正确（`系统状态.主角创建完毕: true`），右侧「卡前端」状态栏仍
显示卡内的《未检测到主角创建 / 请检查变量更新是否正常。》，且不会自己恢复。

**根因**：iframe shim 装好 `message` 监听器后并不会主动取状态，快照完全依赖宿主
`useHelperBridge` 挂载时的一次性 `postSnapshot`。srcdoc 的 head 先解析
`helperLibraryTags()` 的三个 jsDelivr 外链脚本，shim 的执行被推迟；宿主的挂载
推送经常早于 shim 的监听器，消息落在无监听阶段被丢弃。卡内 `init()` 在
`DOMContentLoaded` 用本地 `getChatMessages()` 读空的 `state.messages`，回退
`Mvu.getMvuData()` 仍为空，于是渲染警告分支；此后没有再推送或拉取，空态固定。

**决议**：

- iframe shim 在监听器就绪后主动 `call('snapshot')` 拉一次，`applySnapshot`
  照旧广播 `VARIABLE_UPDATE_ENDED`；
- 宿主 `useHelperBridge` 在 iframe `load` 事件后补推一次快照（cleanup 反注册），
  与挂载推送同源；
- 两条路径互补：挂载推送若早于 shim 监听器（push 丢失），shim 的拉取必然到达
  已就绪的宿主监听器；拉取若早于宿主监听器（pull 丢失），挂载推送必然晚于
  shim 监听器。两个丢失条件在同一时序里不可能同时成立。

**验证**：用真实聊天（`2026-10-21@08h 41m 46s 299ms.jsonl`）的 display 文档与
`/helper` 快照在 headless Chromium 里搭最小宿主：修前面板渲染警告（innerText
121 字符、`title=WARNING`）；修后 `warning=false`、928 字符角色面板。
`helper-client.spec.ts` 增加两条通道的 source-check；`tsc -b`、全量
`vitest run`（123 文件 1911 通过）与 18 项 gate 全绿。

## 补记：行动台白块与 `frameElement` 沙箱兜底（2026-10-21 五次）

**症状**：状态栏恢复后，右栏「美化前端」顶部仍有一块 120px 左右的纯白空白；
下面才是状态栏。空白对应正则 6「行动方式控制台」（35KB 文档）。

**根因**：该文档在 `进程.阶段 = 幕间休息` 且无 H 事件时 `getActiveConfig()`
返回 null，按卡设计应通过 `window.frameElement.style` 把自己 `display:none`
并清掉高度。但 sandbox 无 same-origin，`window.frameElement` 恒为 `null`，
`toggleHostCollapse()` 与 `updateHostHeight()` 全部 no-op：卡以为自己隐藏了，
宿主 iframe 仍是 `FrontendFrame` 的默认 120px，外框 `bg-base` 透出白底。
（快照丢失时 `render()` 不执行，连 `toggleHostCollapse(false)` 都不会调用，
所以这是首个快照 bug 修完后暴露的第二层。）

**决议**：

- shim 内 `Object.defineProperty(window, 'frameElement')` 提供最小元素面
  （`style.setProperty/removeProperty`），把 `display`/`height` 写入用 0ms
  合并后发 `frame.prefs`；
- 宿主 `applyFramePrefs`：`hidden` → iframe 与其独子外框一起 `display:none`；
  显示时移除；`height` 以 `!important` 写到 iframe 上（卡要求 36~47px），
  不被 `FrontendFrame` 的默认高度状态与 80px 下限覆盖；
- 只改真实元素样式，不改 React 状态；卡重复调用（`[100,300,800,1500]`
  定时器 + ResizeObserver）天然补发，不存在一次性丢失问题。

**验证**：同一最小宿主跑两份快照——`幕间休息`：iframe `display:none`（白块
消失）；`战斗回合`：`display:''`、`height:47px`、面板文本
`主动 / 牵制 / 推进 / 危机 / 必杀` 五键齐全。`helper-client.spec.ts` 增加
frameElement source-check；`tsc -b`、全量 vitest 与 18 项 gate 全绿。


