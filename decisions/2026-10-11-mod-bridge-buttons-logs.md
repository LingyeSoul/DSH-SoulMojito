# Mod 桥下行事件 + 声明式按钮 + 日志查看器（A-1 / A-2）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §2.2/§2.4/§2.5 的 A-1/A-2 建议（JSR 为 PolyForm NonCommercial——只复刻可观察语义，
> 全部重新实现，零代码拷贝）。落点：`packages/plugin/src/mods/`、`packages/plugin/client/main.js`、
> `packages/plugin/examples/mods/`。开发者文档：[mod-api.md](../docs/mods/mod-api.md)。

## 1. 声明式按钮（A-1a/b/c/d）

### 契约

- **manifest 声明**（`manifest.ts`）：`buttons: string[]` 可选；≤8 项、显示名 trim 后
  非空 ≤40 字符（允许 CJK——它是显示名不是路由标识）、重复即清单校验失败。
  `ModInfo`/bootstrap 投影带 `buttons`；启用确认弹层与面板能力 Pill 区披露数量与名单。
- **Node API**（`host.ts` createApi）：`api.onButton(name, handler)`，handler
  `async (click, context) => void`；`click = { name }`，`context = { character?, chatId? }`
  （点击时可得的聊天归因，拿不到就不带）。name 必须在 manifest buttons 里声明
  （注册期校验）；同名重复注册抛错；返回反注册；handler 注册表挂在 per-instance 的
  `LoadedMod.buttons` Map 上——卸载即整组回收（与 routeTable 同生命周期，对齐其他
  api.* 面）。handler 抛错 → `button-error` 审计 + 路由 500；**正常点击不审计**
  （高频路径，对齐 event-error 纪律）。`api.version` 不动（v1 内加面）。
- **HTTP 路由**（`index.ts` handleModsApi）：`POST /api/dsh-tavern/mods/<id>/button/<name>`。
  name 经 URL 解码后过与 manifest 同款的显示名白名单（`modButtonNameError`）再匹配
  manifest 声明。响应 `{ ok, handled }`（handled = 是否有 handler 消费）。未装载 /
  未知按钮 / 任一层开关关闭 → 404 与未知路由不可区分（§6 纪律）。请求体可选
  `{ character, chatId }`（客户端有会话绑定才带，服务端只透传非空字符串）。
- **保留段**（`http.ts`）：`POST button` 与 `POST button/<name>` 加入注册期保留
  （`isReservedModSubroutePostPath`）——这些组合被宿主按钮分发先截获，注册了也
  永远不可达，fail-fast（与 enable/disable/reload 同款理由）。
- **客户端渲染**（`client/main.js`，两处）：
  1. Mod 面板该 mod 分区头部按钮 chips（`ModPanelSurface` = `ModButtonRow` + iframe +
     日志折叠视图）；
  2. **ST 聊天视图一条紧凑按钮行**（`TavernModButtons`，挂在 `TavernView` 顶部
     TavernMvuStatus/TavernScriptProgress 之后）——这是按钮的主价值位；点击携带
     当前绑定的 `{ character, chatId }`。
  无声明按钮的 mod 不渲染；全空时整行不占位（TavernMvuStatus 同款纪律）。点击 →
  POST 按钮路由，请求中禁用态，失败行内提示；成功后向挂载的 ModSurface 广播
  `button-click` mod-event。注意：**无 `panel` 声明的 mod 没有面板分区**——按钮
  chips 依赖分区存在，这类 mod 的按钮只在聊天行渲染（面板列表行的 Pill 披露数量）。

### 边界与决策

- **404 不可区分优先于可诊断性**：按钮路由的存在性本身不泄露（未装载/未知名/开关关
  一律 404）。已装载且已声明但无 handler 答 200 `handled:false`——此时 mod 的存在性
  已经通过 bootstrap 投影公开，不构成泄露。
- **上下文来自点击方**：`context.character/chatId` 由客户端 POST 体提供（同源 UI 的
  用户自己的点击；服务端不验证绑定真伪——它是**提示不是凭据**，文档明确 mod 不得
  用它做授权判断）。
- **写边界（v1 如实）**：按钮 handler 没有聊天/资产写面。story-clock 的「拨快 1 小时」
  复用 /clock advance 的推进逻辑（parseDuration + formatClock）计算结果并记入 mod
  存储 + 宿主日志；把钟**真的**拨快仍走 `/clock advance 1h`（聊天写回一律走
  hooks/STscript 由核心落盘，mod-api.md §17 的既有纪律不动摇）。

## 2. 桥下行事件（A-1d）

- **消息**：`dsh-tavern:mod-event` `{ token, kind, payload }`，kind ∈
  `chat-saved | assets-saved | guides-changed | button-click`（前三个与 Node 侧
  `api.events` 的 kind/payload 同形——mod 的 Node handler 与 UI 订阅看到同一事实的
  两个面）。一切新消息走既有 **token 对账 + contentWindow 事件源双校验**
  （ModSurface 的 onMessage 入口），零新增网络面、CSP 不放宽。
- **分发面**：模块级 `modEventSurfaces` 注册表——每个挂载的 ModSurface 注册
  `{ id, token, frameRef }`，unmount 即注销（JSR 按 iframe 分组订阅 + pagehide 整组
  退订的同款纪律：不依赖 GC，卸载后零泄漏）。广播逐面 postMessage（每面 token
  不同，不能一条消息群发）。
- **tap 点**（全部是「本客户端发起且成功」的写入）：
  - `chat-saved`：`saveChat`（PUT chat，覆盖消息编辑/swipe 切换）、生成 SSE 的
    `saved` 事件（两段落盘）、`runTavernScriptCommand`（STscript persist）；
  - `guides-changed`：`addChatGuide` / `removeChatGuide`；
  - `assets-saved`：`saveCharacterCard` / `saveWorldBook` / `savePreset` /
    `savePersona` / `createPersona` / `createGroup` / `updateGroup` / `importAsset`
    （character/world/preset/persona；导入名对 character/persona 是 fileStem 近似——
    事件是刷新提示不是事实源，mod UI 重拉即得真值）；
  - `button-click`：按钮点击成功后 `{ mod, name }`。
- **诚实边界（写进 mod-api.md §13）**：只覆盖本客户端（本标签页）发起的写入；
  **其他标签页、写卡 Agent 等服务端侧写入不推送**——mod UI 应保留拉取/轮询兜底
  （事件当加速器，不当唯一事实源）。mood-tracker 示范「事件到达即刷新 + 初始拉取
  兜底」。
- **不做 Node→客户端推送**：宿主事件（guides 总线等）在服务端侧发给 mod 的 Node
  handler（既有 `api.events`）；客户端下行桥只补「本客户端自己的写」这一段，
  不引入 SSE/WebSocket（与 store-revision 轮询的既有取舍一致）。

## 3. 日志三件套（A-2）

- **服务端注入**（`http.ts`）：`renderModHtmlDocument` 在 CSP meta 之后注入 console
  reporter `<script>`（与 CSP 注入同机制，覆盖**所有** `reply.html` 出口）。脚本从
  URL query 自读 `token`（服务端不掌握挂载期 token），无 token 静默跳过（直接 curl
  该路由不产生消息）；wrap `console.log/warn/error`（原方法照常调用）+
  `window.onerror` + `unhandledrejection` → postMessage
  `dsh-tavern:mod-log` `{ token, level, text }`；args 序列化（字符串直出、其余
  JSON.stringify、失败退 String），单条截断 ~2KB。CSP `script-src 'unsafe-inline'`
  已允许内联脚本，无需放宽。
- **客户端**（`client/main.js`）：ModSurface 的 message 入口（token + 事件源双校验
  之后）收 `mod-log` → per-mod 环形缓冲（≤200 条，内存态，页面重载清空——如实
  文档；模块级 Map 使面板重挂**不**丢日志）。Mod 面板该 mod 分区底部「Mod 日志」
  折叠视图：时间 + level 着色（log 灰 / warn 黄 / error 红）+ 文本。
- **Node 侧不动**：宿主 logger + 审计线已有（mod 的 Node 代码输出本来就近宿主日志）。
  mod-log 是 **UI 排障面不是取证面**：不落盘、不进审计（取证走宿主日志与审计线）。

## 4. 测试与夹具

- `tavern-mods.spec.ts`：manifest buttons 校验矩阵（上限/去重/非法名/类型）、
  onButton（注册-分发-重复抛错-卸载回收-handler 错误进审计-未声明名注册期抛错）、
  POST button 路由 e2e（loaded/disabled/unknown 三态与 404 不可区分、context 透传）、
  保留段注册即抛、bootstrap 投影带 buttons、`renderModHtmlDocument` 注入 reporter
  的断言。
- `tavern-mods-story-clock.spec.ts`：示例按钮行为（manifest 声明 + 分发落存储 +
  计数器）。
- `tavern-mods-p2-e2e.spec.ts`：mood-tracker ui 页含 mod-event 订阅与 console 上报
  样板。
- gates（`packages/plugin/scripts/gates/run.mjs` frontend-runtime）：静态 marker 锁
  `dsh-tavern:mod-event` / `dsh-tavern:mod-log` / `TavernModButtons` /
  `ModPanelSurface` / `broadcastModEvent`（客户端面的既有测试模式）。

## 5. 明确不做

- JSR 的动态按钮 API（`replaceScriptButtons` 运行期改按钮）——v1 走 manifest 静态
  声明（知情同意面：启用前弹层展示的就是全部按钮）。
- 按钮点击的通配/批量分发、按钮可见性表达式——没有需求证据，不加面。
- mod-log 落盘/审计——排障面与取证面分离（见 §3）。
- Node→客户端的宿主事件推送（SSE/WS）——诚实边界见 §2。
