# AgentTavern 收养宿主原生会话分叉（host session fork adoption）

日期：2026-10-11。状态：已实施。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/agent-tavern/fork.ts`（收养编排 adoptAgentTavernFork）；检测谓词在 `packages/bind/src/host-session.ts`（hostSessionForkInfo）；聊天物化在 `packages/tavern-store/src/store.ts`（forkChat）；接线点 index.ts 的 `agent/created` 监听 |
| 唯一事实来源 | 宿主会话日志仍是会话事实源；分叉谱系读 `session.header`（parentSession/isSeeded/origin/delegationDepth）+ `session.inheritedEventCount`；插件侧绑定事实在 tavern-store state.sessionBindings 不变 |
| 持久态 | 新 fork 聊天 JSONL（header 克隆 + `chat_metadata.agentTavernFork` 谱系标记 + bookmark_link 回链，messages 由投影器回填）；子会话的 sessionBindings 条目；chat 作用域变量/记忆/向量的物理拷贝。全部是既有存储形态的复用，无新存储种类 |
| 临时态 | 进程内收养在飞 Map（同会话并发收养串行化）；重启丢失无害——收养幂等，已落绑定即跳过，半途崩溃由 agentTavernFork 标记的聊天扫描恢复 |
| 外部依赖 | 宿主 `agent/created` 串行事件（announce 在 loop start 前被 await，dsh-agent/lib/index.js announce()）；宿主 session.header 公开字段（rc.2 起）；无网络调用（向量按文件行 remap，不走 embed HTTP） |
| 注册入口 | 仅扩展现有 `ctx.on('agent/created')` 监听（收养在 replay 之前 await）；无新路由/命令/面板 |
| 删除路径 | 删 fork.ts + bind 导出 hostSessionForkInfo + store.forkChat + index.ts 接线回原监听 + agent-tavern-fork.spec.ts + 本决策。已收养的会话/聊天是普通绑定与普通聊天，无需迁移即可继续用（或由用户手动删除 fork 聊天） |
| 兼容对象 | 非 fork 会话行为零变化（header 谓词先行短路）；subagent 子会话（origin='subagent'/delegationDepth>0）显式排除；ST/AgentNovel/CardWorkbench 会话的宿主 fork 明确不在本期范围（§5）；旧宿主无 header → 谓词返回 undefined，行为同今日 |

## 1. 问题：宿主原生 fork 对 AgentTavern 是断链的

DSH 0.2.0-rc.2 的原生会话分叉有三个用户入口，全部经 `sessions.fork(source,
boundary?)` → `buildForkSeed`（dsh-session/lib/types/fork.d.ts）：

- 会话列表菜单「fork at the Session's last completed turn」（dsh-client-ui-workspace
  session-actions/ForkSession.d.ts，order 300）；
- conversation 视图的逐轮尾 `forkAt`（dsh-client-ui-chat ChatView.d.ts；
  composer facade 注释「send choreography / materialize fork」——编辑重发等
  路径在任意轮边界物化 fork）；
- API 面 `SessionForkRequest { sessionId, atSeq? }`（dsh-api-session-controller
  types.d.ts）。

子会话继承包含切点的精确事件前缀，`header.parentSession` + `isSeeded: true`
记录谱系，`inheritedEventCount` 是精确前缀长度（dsh-session types.d.ts）。

对 AgentTavern，子会话继承的**宿主侧**一切照常：`agent-preset/selected` marker
在日志里 → dsh-agent-preset-registry 投影保住 AgentTavern 身份，工具面、原生
composer、锚定 cadence（latestReminderTurn/hasRealUserTurn 扫继承事件）全部
天然延续。**断的是插件侧状态**：`sessionBindings[childId]` 不存在——

- 22 个域工具的 `bindingFor` 全部抛 "AgentTavern binding is unavailable"
  （agent-tavern/agent.ts）；
- facts/guides/script/preset 四个 context 段装配回调按 agent.id 反查绑定得
  空串（同文件 §context 注册）；
- 投影器 `projectOne` 因无绑定跳过（agent-tavern/projector.ts），Tavern JSONL
  侧不产生任何聊天；
- chat 作用域变量/记忆/回执/guides 全部丢失归属。

即：用户在宿主 UI 点一次 fork，得到一个「看起来还是酒馆、实际全断」的会话。

## 2. 方案：agent/created 上的收养（adoption）

单挂点：`agent/created`。宿主 registry 的 announce 在 loop start 之前**串行
await** 全部 listener（dsh-agent/lib/index.js announce()：「completion of the
serial creation listeners」），所以监听器内 await 收养可保证子会话首轮装配
前绑定已落库。收养全部为本地文件操作（无 embed HTTP），串行窗口有界。

收养步骤（adoptAgentTavernFork）：

1. **谱系判定**（bind 层 `hostSessionForkInfo`）：`header.parentSession` 为
   非空 string 且 `header.isSeeded === true` 才是 fork；`header.origin ===
   'subagent'` 或 `delegationDepth > 0` 显式排除（tavern_deduce 子代理同样
   以 fork 种子实现，dsh-subagent-fork-in-process——不排除会把子代理收养成
   第二个主角会话）。可选携带 `inheritedEventCount`（boundary seq = N-1）。
2. **幂等**：绑定已在 → 返回；进程内在飞 Map 串行化并发触发。
3. **父绑定门**：父会话必须是 `architecture === 'agent-tavern'` 且非群聊；
   否则一行 info 日志静默跳过（ST/novel/workbench 见 §5）。
4. **崩溃恢复扫描**：`listChats(character)` 里匹配 ` - fork N.jsonl` 的聊天
   读 header，`chat_metadata.agentTavernFork.sessionId === childId` 即复用
   （收养半途崩溃——聊天已建、绑定未写——不留孤儿）。
5. **物化 fork 聊天**（store.forkChat）：克隆父聊天 header（guides、MVU
   回执环随 header 继承）、messages 置空（由投影器回填——单一投影路径，
   身份幂等（childSessionId, eventSeq) 与父聊天互不污染）、写
   `chat_metadata.agentTavernFork = { sessionId, parentSessionId }` 与
   `bookmark_link = { character, chatId: 父聊天, messageId }`（复用 ST 消息
   分支的回链元数据形状，client 的「↩ linked from」行同款消费）；命名
   `${stem} - fork N.jsonl`（branchChat 的 ` - branch N` 同款字符集安全与
   递增规则，后缀区分来源）。messageId 取父聊天中 eventSeq ≤ boundary 的
   最后一条投影消息下标（父会话可能在 fork 后继续推进，回链指到分叉点而非
   父聊天末尾）；inheritedEventCount 不可读时退化为父聊天末条。
6. **chat 作用域拷贝**：变量 `listAll('chat', 父) → patch('chat', 子)`
   （逐项 {name, value}，revision 各自新生，patch 对既有名无 expectedRevision
   为覆盖语义、重跑幂等）；记忆 `list('chat', 父)`（不含软删）逐条 `put` 到
   子 scope（同 id 保谱系可追）——`MemoryStore.put` 对已存在 id 且无
   expectedRevision 必抛冲突，半途中断的重跑靠「已存在（含软删）即跳过」
   保持幂等（agent-tavern-fork.spec 的 partial memory copy 回归钉住）；
   向量 `list('chat', 父)` → `put(remap scopeId)`（digest 是 [model, content]
   的 SHA-256，内容不变则向量可原样迁移，零 HTTP，entries 按 id 覆盖幂等）。
7. **绑定**：经 index.ts 的 bindSession（继承父 contextMode；世界书跟随与
   activeCharacter 语义与正常激活一致）。
8. **尾部 fire-and-forget**：`projector.replay(child)`（继承前缀 + 子自有
   事件按既有投影语义落 JSONL；mirror/plugin source 事件照旧跳过）、
   `emitAgentPresetChanged()` 预热、`refreshActivePrompt()`。

监听器整体 try/catch 永不 reject（串行 listener 失败会**炸掉宿主 agent
创建**——announce 的契约），失败一行 warn，会话按普通 DSH 会话降级运行。

## 3. 关键取舍

- **子聊天从空开始靠 replay 回填，不复制父 JSONL 楼层**：投影是唯一楼层
  写入路径，复制会引入第二份身份语义（还要改写 extra.agentTavern.sessionId）。
  代价是回放成本 O(楼层²) 字节（每楼一次全量重写，与既有 recovery replay
  同款量级）；典型聊天（几十至一二百楼）一次性开销可接受，不做批量预填
  优化（YAGNI，等实测痛了再加）。
- **变量/记忆拷贝取父会话当前值，不按 boundary 重放**：宿主变量/记忆不是
  事件源状态，无法在任意 seq 重建。UI 默认 fork 点 = 最后完成的 turn（尾部），
  当前值即切点值，语义精确；conversation 任意轮 forkAt 的非尾部切点上是
  「父会话最新状态」的近似——如实记录在本节，不做静默假装。
- **收养时机 = 子会话首次运行**（宿主对其建 agent 时）：不扫宿主会话列表
  做主动发现。fork 后从未运行的子会话在 Tavern 面板不出现，属可接受的
  惰性（宿主列表里它本来就在；一运行即收养）。
- **client 零改动**：MVU 标题栏按钮/面板绑定读取走 bootstrap，收养落库后
  由既有刷新路径跟上（面板打开、任意客户端动作）。已知边界：state.json
  不进 store-revision 水位（既有文档化决策），纯后台收养对已打开的面板不
  推送——面板下次打开/动作时吸收，不为此引入推送通道。
- **提示词查看器 / prompt-capture**：按 sessionId 记录，收养后自然开始
  记录子会话，无需改动。

## 4. 明确不做（本期）

- **ST 架构会话的宿主 fork 收养**：ST 的会话只是容器，事实源是 JSONL 聊天；
  宿主 fork 复制的是容器（activation marker 随事件继承，client composer 会
  接管），若把子容器绑到同一 (character, chatId)，双容器并发写同一 JSONL 互
  踩 revision。ST 侧的分支语义已由「消息分支 / bookmark」在正确的层（聊天层）
  提供。宿主 fork 一个 ST 会话的现状保持「接管但共用同一聊天」，不在本期
  改变（记录在案，用户反馈痛了再立项）。
- **AgentNovel / CardWorkbench 会话的宿主 fork**：各自有独立绑定语义
  （novelId / 工作台会话身份），fork 会产生双写卡/双驱动的复合问题，需要
  各自决策评估（与 workbench-reference-read 决策对 agent-novel 的处理同款
  边界纪律）。
- **变量/记忆按 boundary 的历史重建**（见 §3 取舍）。

## 5. 测试

`packages/plugin/tests/agent-tavern-fork.spec.ts`：

- hostSessionForkInfo 谓词：v4 fork 命中（含 inheritedEventCount）、subagent
  origin 排除、delegationDepth 排除、无 header/无 parent/isSeeded=false 短路；
- forkChat：命名递增、header 克隆（guides/回执随行）、messages 空、
  agentTavernFork + bookmark_link 元数据；
- 端到端收养（真实 TavernStore/VariableStore/MemoryStore/MemoryVectorStore
  tmpdir fixture）：聊天物化 + 变量/记忆/向量拷贝 + 绑定继承 contextMode +
  投影器 replay 后子聊天楼层与身份正确（mirror 事件跳过）；
- 幂等三态：重复收养不建第二个聊天；崩溃恢复（预置带谱系标记的聊天）复用；
  非目标父绑定（ST）/subagent/已绑定各自动作正确；
- bookmark messageId 边界：父聊天含 boundary 之后的楼层时回链指到切点。
