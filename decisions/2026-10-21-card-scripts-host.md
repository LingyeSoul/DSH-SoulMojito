# 卡脚本宿主与会话世界书副本（2026-10-21）

## 问题

导入的 MVU-ZOD 卡（`示例卡.png`）在
`data.extensions.tavern_helper.scripts` 里有 4 个启用的脚本：

| 脚本 | 字符数 | 作用 |
|---|---:|---|
| `[MVU变量框架]var_update` | 90 | 变量更新接线 |
| `示例卡_zod` | 11,275 | Zod schema 与 `__mgZodReady__` 探针 |
| `示例卡MVU变量监控器` | 61,635 | 变量监控 |
| `示例卡_悬浮GM面板` | 169,492 | 自建悬浮球 `#mg-orb-btn` / 面板 `#mg-panel`，`appendChild` 到 `hud_doc.body` |

（角色卡名以「示例卡」代称。）

插件此前完全不执行脚本树（`docs/frontend/tavern-helper-compat.md` §2.3），因此：

1. GM 面板不存在于任何前端 DOM，用户看不到「保存并同步世界书」等入口；
2. GM 面板需要 `getCharWorldbookNames` / `getWorldbook` / `updateWorldbookWith`，
   而 JSR 的写面过去是明确不提供的——直接放开会写坏 `worlds/<name>.json`；
3. GM 面板的 `hud_win = window.top` 在沙箱里落到 shim 的 `fakeDocument`
   （只有 `querySelector` / `body: null`），`hud_doc.getElementById` /
   `head.appendChild` 直接抛错；
4. 行动栏（`[行动] 行动方式控制台` 正则）的两份 HTML 分别写
   `html, body { background: transparent !important; }`，宿主的画布 reset 没有
   `!important`，cascade 输给卡样式；iframe 元素本身也是透明 → 深色模式露出
   浏览器白底。

## 决议

1. **卡脚本右栏 tab**（`dsh-soulmojito/card-scripts` / `tavern-card-scripts`）：
   服务端 `GET /api/dsh-soulmojito/card/scripts` 只读列出
   `type === 'script' && enabled !== false && content` 非空的脚本；客户端列表 +
   「运行」按钮，**用户点击后**才把单份脚本包成完整 HTML 文档交给现有
   `FrontendFrame`（`sandbox="allow-scripts allow-modals"`、无 same-origin、
   CSP `connect-src 'none'` 不变）。切换聊天/角色立即停止并清空，同一时间只跑
   一份；挂载时不设置任何运行目标，**没有自动执行路径**。
2. **会话级世界书副本**：脚本写入只落到
   `chats/<character>/<chat>.jsonl.worlds.json`（`{ version: 1, worlds }`）；
   `worlds/<name>.json` 与卡内 `character_book` 永远只读。当前聊天的读取链
   （helper `lorebook.get`、生成管线、MVU、卡状态渲染、`tavern_lore_search`）
   优先副本，其次基础资产，最后才是卡内嵌书兜底。副本随聊天生命周期：
   rename 跟随、branch/fork 复制、delete 删除、删角色走目录递归删除。
3. **回退入口**：卡脚本 tab 底部「重置会话世界书」→ `lorebook.reset` 删除副本，
   下一次读取回到角色卡原版世界书。
4. **GM 面板兼容的最小宿主面**：`getCharWorldbookNames`（同步）、
   `updateWorldbookWith`（iframe 内执行 updater，只把 entries 发回宿主）、
   `getScriptTrees` / `updateScriptTreesWith`（会话脚本树副本，见下节），以及把
   `__dshTavernHost.document` 换成真实 iframe document 的 facade。
5. **行动栏修复**：iframe 元素背景使用宿主解析出的 DSH 原生背景色；
   `buildFrontendDocument` 在卡样式之后追加
   `html{background:var(--dt-host-background)!important;}`（只强制画布，不动
   `body` 与 `.tactics-panel`）；`mvu.replace` 之后重投快照；`Mvu.replaceMvuData`
   失败弹 toast；可见 iframe 高度下限 36px；capture 阶段提示 disabled 按钮。

## 会话脚本树副本（2026-10-21 追加）

问题：GM 面板的「保存并同步世界书」要先改 `示例卡_zod` 源码并等
`mg-zod-ready` 握手；上一版脚本树只活在当前 iframe 内存，刷新页面或重开卡脚本
tab 后 GM 面板又退回卡原版，用户以为「保存成功」的 Zod 改动凭空消失。

决议：

- 新增 `chats/<character>/<chat>.jsonl.scripts.json`（`{ version: 1, scriptTrees }`），
  节点形状就是卡内 `tavern_helper.scripts` 原数组，`folder` / `button` / 未知字段
  原样透传；
- iframe 不能直接写盘，统一走 helper RPC：`scripts.get` / `scripts.put` /
  `scripts.reset`；`snapshot` 在绑定聊天上带回 `scriptTrees`（无副本为 `null`）；
- shim 的 `updateScriptTreesWith` 改成**先 `scripts.put` 落盘、成功后才更新内存并
  发布 `mg-zod-ready`**；失败拒绝并保留旧树，GM 面板不会把半成品当成功；
- `seedScriptTrees` 优先会话副本，没有才从卡内节点播种；`applySnapshot` 在本地
  写入前接受快照里的副本，写入后不再被可能过期的快照覆盖；
- 卡脚本 tab 带 `chatId` 拉列表，所以运行的是会话副本里的最新 Zod 源码；
- 「重置卡脚本」→ `scripts.reset` 删除副本并停止当前运行脚本，列表回到卡原版；
- 生命周期与 `.worlds.json` 完全对齐；`deleteChat` 的 worlds/scripts 清理移入
  `mutateChat` 块内，避免与并发 put 产生孤儿副本。

边界：持久化的是**脚本源码**，不是 Zod schema 的执行结果；服务端 MVU 仍不执行
Zod，刷新后 GM 面板读到的是改过的源码而不是「已生效的规则」。

## 自动运行开关（2026-10-21 追加）

问题：用户希望在打开聊天时直接看到 GM 面板/状态脚本，而不是每次手动点「运行」。
但脚本树默认可执行全部卡逻辑，自动执行必须是显式知情同意。

决议：

- 新增持久设置 `cardScriptsAutoRun`，**默认 false**；设置页展示风险警告，走现有
  state PATCH 布尔白名单持久化；
- 开启后进入/切入酒馆聊天（`agent-tavern` 或 `st`，非群聊）自动展开「卡脚本」
  tab：每个 `(sessionId, 角色, 聊天)` 只自动打开一次，用户手动关掉后不抢焦点；
- tab 把**全部启用脚本**按脚本树顺序注入**同一个**沙箱 `FrontendFrame`（每份
  脚本一个独立 `<script type="module">` 块），复用现有 sandbox/CSP/helper shim；
- 同一 iframe 意味着脚本共享 `window` / `document` / 全局变量，不是 JSR 的隔离
  脚本容器；脚本冲突、重复注册由卡作者负责，插件不伪造隔离；
- 「停止自动运行」只停当前 tab 的 iframe，不改设置；设置关掉后 tab 停止自动运行
  并回到手动模式；重置卡脚本同时停止自动运行；
- 手动模式保持原样：开关关闭或用户停止后仍可逐个「运行/停止」。

否决：不做「每脚本一个 iframe」的自动运行（GM 面板与监控器需要同一份全局/事件
总线，拆开反而与 JSR 行为不一致）；不做每聊天的「自动运行白名单」（设置是全局
知情同意，会话副本已按聊天隔离写入）。

## 自动运行改由「美化前端」承载（2026-10-21 第二次修订）

问题：上一版把自动运行放在「卡脚本」tab 的独立 iframe。卡脚本的悬浮面板 / GM
面板 `appendChild` 到 `window.top.document.body`，但那个 body 是空白脚本 iframe，
不是玩家正在看的美化前端；结果脚本 UI 与消息 HUD 分居两个 tab / 两份 iframe，
切换 tab 或打开美化前端时脚本状态与可见面脱节。

决议：

- `cardScriptsAutoRun` 开启时，AgentTavern 的自动运行宿主改为「美化前端」tab：
  `frontend/latest` 的最新楼层 HTML 与全部启用脚本拼成**同一个**沙箱文档（脚本块
  插在 `</body>` 前；没有 HTML 楼层时给 720px 画布），只挂一个 `FrontendFrame`；
- 一个楼层可能同时带多个完整文档（真实卡：行动栏 35KB + 状态总览 154KB）。脚本
  只注入**文档长度最大**的那个主前端（同长度取最后一个），行动栏小框不抢宿主；
- 脚本的 `window.top.document` facade 指向这份文档，悬浮球 / GM 面板直接叠在美化
  前端上；Font Awesome 只在卡未自带时补一次；
- 自动展开切到「美化前端」tab；ST（消息内联，右栏没有第二份前端）仍在「卡脚本」
  tab 自动运行；
- 「卡脚本」tab 在 AgentTavern 下不再自动 / 手动重复启动（自动运行开启时手动运行
  禁用），显示「自动运行由美化前端承载」与「打开美化前端」；重置脚本树通过窗口
  事件让美化前端停止自动运行；
- 美化前端 tab 提供「停止自动运行」；脚本源码只在聊天 / 设置变化时取一次，不跟
  5s 轮询重取；iframe 只在美化楼层 HTML 变化（或启停脚本）时重建。

边界：

- 同一 iframe 意味着消息 HTML 与卡脚本共享 DOM / 全局变量，冲突由卡作者负责；
- 一个楼层有多个完整文档时只把脚本注入**文档长度最大**的主前端（同长度取最后
  一个）；行动栏 / 状态栏小框不执行脚本，也不重复注入；
- 出现新的美化楼层时整份文档重建，脚本从头启动（用户已在二选一中确认该代价）；
- 停止自动运行只停当前 iframe，不改设置；重新开关设置或重开 tab 可恢复；
- ST 行为保持不变：消息正文内联渲染，自动运行仍在卡脚本 tab。

验证证据：

- `packages/plugin/tests/frontend-client.spec.ts`：同一 iframe 拼接、脚本 bundle
  端点、启停 / 重置事件与 zh/en 键镜像；
- `packages/plugin/tests/card-scripts-client.spec.ts`：自动展开目标 tab
  （AgentTavern → 美化前端、ST → 卡脚本）、手动运行禁用、重置事件派发；
- `frontend-surface` gate 锁定 `frontendWithCardScripts`、重置事件与宿主判定
  marker；构建后 gates 全绿；
- 真实卡实测（2026-10-22）：`示例卡…` 的 4 个启用脚本含 53 处 `$'`；旧版
  `String.replace` 字符串拼接在 esbuild 校验下 3 个脚本报 `Unterminated string
  literal`（srcdoc 的 `Invalid or unexpected token`），replacer 版本 4 个脚本
  全部通过；
- 真实楼层实测（2026-10-22）：`frontend/latest` 返回 `[35122, 154052]` 两份
  文档，`frontendCardScriptHostIndex` 选中 1（`状态总览`，154KB），行动栏文档
  保持 0 个 module 块，4 个脚本全部解析通过。

## 否决项

- **默认不自动执行脚本树**：自动运行必须由 `cardScriptsAutoRun` 显式开启
  （默认关闭并展示风险警告）；没有该设置时，脚本只在用户点击「运行」后执行。
  JSR 的脚本容器 / 快速回复栏 / 每楼注入仍不复刻。
- **不写基础世界书资产**：`updateWorldbookWith` 直写 `worlds/<name>.json` 会让
  一次脚本误触污染所有聊天与卡原版；面板/Agent 工具的写入仍走确认协议。
- **不执行完整 JSR 生命周期**：`getScriptTrees` / `updateScriptTreesWith` 读写
  会话脚本树副本、解析 `__mgZodReady__` 探针并派发 `mg-zod-ready`，让 GM 面板
  阶段 B 不中断；但**不回写角色卡**；自动执行只由 `cardScriptsAutoRun` 控制，
  Zod schema 本身不会因此生效（服务端仍只有通用数值 clamp，见
  `docs/frontend/tavern-helper-compat.md` §2.3）。
- **不为了「能点」移除 `disabled`**：行动台的必杀在净化之力 < 100 时本就不可用；
  disabled 按钮不派发 click 是浏览器语义，改为 capture 阶段 toast 说明。

## 边界

- 脚本写入只限**当前绑定聊天**：`character` / `chatId` 由宿主从 session binding
  注入，iframe 无法寻址别的聊天；`lorebook.put` 强制 `chatId` 非空。
- 卡脚本 tab 在 `agent-tavern` 与 `st` 绑定下都可用（脚本树没有内联等价物）；
  非酒馆绑定显示空态。
- 副本文件按 `(character, chatId, world)` 串行化读-改-写，避免并发
  `updateWorldbookWith` 互相覆盖；脚本树按 `scripts:<character>\0<chatId>` 串行化。
- 损坏的副本文件显式报错并带文件路径，不静默回退基础资产。
- Zod 热更新落**会话脚本树副本**、不回写角色卡、不执行 schema：刷新后 GM 面板
  仍读到改过的源码，但服务端结算不会应用 Zod 规则。
- `scripts.put` 拒绝非数组 / 非对象节点；`scripts.get` / `put` / `reset` 都要求
  `chatId` 非空（只接受会话作用域）。
- 自动运行是**单 iframe 共享环境**：脚本共享 DOM/全局，插件不做脚本间隔离；
  自动展开每 `(sessionId, 角色, 聊天)` 只发生一次，停止自动运行不妨碍手动运行。

## 验证证据

- 服务端：`packages/plugin/tests/helper-route.spec.ts`（世界书副本优先、put 只写
  副本、base 不变、reset、entries 校验；`scripts.get/put/reset`、非法 chatId/形状、
  snapshot 携带 `scriptTrees`）、`packages/plugin/tests/card-scripts.spec.ts`
  （过滤/回退 id/世界名、route 200/404/空数组、`chatId` 优先会话副本且无 chatId
  行为不变）、`packages/tavern-store/tests/store.spec.ts`（worlds/scripts 两份副本
  的 put/get、隔离、rename/branch/fork、delete、损坏 JSON）、
  `packages/plugin/tests/tavern-assets.spec.ts`（带/不带 chatId 的读取差异）。
- 客户端：`packages/plugin/tests/card-scripts-client.spec.ts`、
  `helper-client.spec.ts`（同步 getter、世界书写面、脚本树副本先落盘再发布、
  document facade、mvu.replace 重投与失败 toast）、`frontend-client.spec.ts`
  （iframe 背景 + late canvas 规则）。自动运行开关另由
  `card-scripts-client.spec.ts` 锁定设置键、自动展开 hook、单 iframe 文档与
  「停止自动运行」；headless harness 验证开关开启时同一 iframe 内 GM 面板挂载、
  脚本全部执行，关闭时无自动运行。
- 真实卡实测（headless Chrome + 真实 iframe shim + 真实 11 楼 `stat_data`，
  只读真实聊天）：4 个非必杀按钮点击 → `mvu.replace` 写入并回投快照，按钮高亮
  跟随；必杀 `disabled=true`，点击不改状态，`pointerdown` 弹「该按钮当前不可用」；
  `getComputedStyle(html).backgroundColor` = 宿主背景 `rgb(30,30,36)`，
  `.tactics-panel` 仍为卡自己的 `rgba(20,21,33,0.95)`。
