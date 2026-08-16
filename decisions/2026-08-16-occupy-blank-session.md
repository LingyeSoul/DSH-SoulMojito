# 绑定会话占位：摘除宿主 blank 复用资格

日期：2026-08-16

## 背景

严重缺陷：原生「新建会话」把用户切换进已绑定的 Tavern 会话，无法新建普通 DSH 会话。

根因链（全部对照宿主 rc.6 源码与实机数据验证）：

1. 宿主 `workspaces.startSession()`（原生新建会话按钮）→ `connectWorkspace(workspaceId)`，后者按 `sessions.ids` 顺序复用 workspace 内第一个 `summary.blank === true` 的会话（`dsh-client-runtime` client.js 的复用循环），并 `sessions.open` 它。
2. 宿主 blank 判定（`dsh-host-apiproxy` `sessionBlank`/`applySessionListMetadata`）：**日志中从未出现 `turn/start` 即 blank**。注释明确 standalone plugin events（命令记录、marker 等）不翻转 blank。
3. Tavern 会话的激活 marker 与聊天生成都不经过宿主 agent loop（生成走插件自建 `/generate` + `ctx.llm.stream`），宿主日志永远没有 `turn/start`——实机解压被绑定会话日志仅 1 个 `session` 创建事件。
4. 因此每个绑定的 Tavern 会话都永久满足复用条件，原生新建会话必然落进它；且 Tavern composer 接管了该会话的输入，用户无法用原生对话产生真实 turn 解除复用——死锁。

proposal 0001 中「marker 让 blank session 进入 active 状态」是与宿主实现不符的错误假设，即本缺陷的设计根源。

## 决策

1. **绑定成功后追加一对占位空转 turn 事件**（`occupyHostSession`）：仅当会话还没有任何 `turn/start` 时，`append('turn/start', { turn: 1 })` + `append('turn/end', { turn: 1, reason: { kind: 'completed' } })`。`reason: completed` 与 agent-loop 对零消息 turn 的关闭方式一致；无 surfaceOp 的 log-only 事件经 `Session.append` 运行时校验放行（`planSurfaceEvent` 对非 surface 事件早退）。agent-loop 的真实 turn 号取 `findLast(turn/start) + 1`，编号保持连续。宿主拒绝追加时不阻断激活（仅失去防复用保护）。
2. **存量修复走 client，三路触发共用 `repairBinding`**（幂等重发内部 session bridge，借服务端补占位 turn 对；按会话粒度去重，命令失败不标记、待下次触发重试）：
   - `openTavernChat` 的已绑定去重分支——点击任意已绑定聊天即修复。首轮实现漏掉此分支（去重分支不发命令），旧绑定会话即便全部新代码生效也无从修复；
   - `TavernView` 挂载——任何方式（含原生新建会话的复用劫持）落入绑定会话时修复；
   - `PanelHost` 启动清扫——会话列表 ready 且 bootstrap 加载后，对宿主仍标记 blank 的绑定会话统一修复。复用 `binding.session.command()` 通道（与 deleteTavernChat 的 close 广播同款），可对非当前会话执行。
3. **回归测试** `packages/plugin/tests/tavern-command.spec.ts`：以 mock agent 直接驱动命令 handler，断言占位 turn 对的写入、重复绑定的幂等、已有真实 turn 会话的零污染。

## 备选方案

- **绑定后 `archiveSession`**：被否——archive 会把会话从宿主 sidebar 隐藏，Tavern 会话需要保持可见可切换。
- **让 Tavern 生成走宿主 agent turn**：被否——生成管线（世界书/宏/正则/swipe）完全绕过宿主 loop，为此引入真实模型 turn 成本与副作用不可接受。
- **client 检测「New Session 误落 Tavern 会话」再纠正**：被否——无法可靠区分用户主动点击与复用劫持，且存在导航竞态。

## 后果

- 绑定会话在宿主列表从 blank（仅当前时可见、作为「新建会话」临时行）变为正常可见条目——会话已 rename（`角色 · chat`），可见即预期。宿主 workspace UI 的可见性规则：`!session.blank || session.id === current`，blank 会话本就不该长期滞留。
- close（解绑）不回滚占位 turn 对：带 closed marker 的会话不应再被复用为 blank 草稿。
- 已有真实 turn 的会话再绑定不追加占位对，日志零污染。
- 多窗口并发修复安全：命令串行执行，第二个执行方发现 turn/start 已存在即跳过。
- 修复命令会在宿主会话日志留下一行 command lifecycle 记录（control-plane 内容，不影响 blank 判定与 UI）。
