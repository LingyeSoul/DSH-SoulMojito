# 导入历史写成真实 turn 边界 + assistant 结算契约，修复 0.2.0-rc.2 会话损坏

日期：2026-10-05。状态：已实施。取代：[`2026-09-09-import-turn-coordinates.md`](2026-09-09-import-turn-coordinates.md)。

## Problem

带开场白（`first_mes` 非空）的角色卡，点「+」新建 AgentTavern 聊天必定出问题，表现三种：

1. 创建直接失败：`failed to create session "…": SessionQueryError: stored session "…" is corrupt: SessionFormatError: assistant/message does not match an open turn and step`；
2. 能创建但历史加载失败：`Cannot read properties of undefined (reading 'length') (gateway/internal)`，界面只剩外壳、内容区空白；
3. 之后在同一 workspace 新建任何会话都失败：`新建会话失败：gateway/internal: Cannot read properties of undefined (reading 'length')`。

清空开场白就能进去 —— 根因就在导入那一步。`chat.messages` 为空时不产生 append，所以不触发。

三种表现同源，是**两个独立的宿主契约违反**叠加：

### 违反一：assistant/message 必须落在已打开的 turn + step 内（表现 1）

`projector.ts` 的 `historyImportAppends` 当时把开场白导成 `assistant/message`，只带 payload 坐标
`turn: 0 / step: n`、`surfaceOp: 'append'`，没有任何 `turn/start`/`step/start` 边界。

DSH `0.2.0-rc.2` 原生 V4 准入（`dsh-session-format-v3-to-v4` 的 `Relationships.requireStep`）要求
`data.turn === this.turn && data.step === this.step`，而 `this.turn/this.step` 只由 `turn/start`/
`step/start` 打开 ⇒ 整个持久化工件被判定损坏。

**只补边界不够，`turn: 0` 本身无法补救**：`turn/start` 必须等于 `nextTurn`，`nextTurn` 从 1 起、
只在 `turn/end` 时自增 ⇒ `turn: 0` 永远开不出来（`turn/start does not open the expected turn`）。
0.3.2 之前那一版「裸消息」更早就踩过客户端的另一条：`published invalid turn undefined`，对话区空白。
三条形状（裸 / turn 0 / 真实边界）在真实校验器上的实测结论：

| 形状 | V4 准入 | 客户端折叠 |
|---|---|---|
| 裸 assistant/message（0.3.1） | FAIL `does not match an open turn and step` | FAIL `published invalid turn undefined` |
| `turn: 0, step: n`（0.3.2） | FAIL `does not match an open turn and step` | PASS |
| 真实 turn/step 边界（本次） | PASS | PASS |

### 违反二：assistant 结算必须带 `usage` 或 `stream`（表现 2、3）

`dsh-token-meter` 的 `usageOf(event)`：

```js
if (event.type === "assistant/message" && event.data.usage !== void 0) return event.data.usage
if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return void 0
return lastAssistantStreamChunk(event.data.stream, "usage")?.usage   // stream undefined
```

`lastAssistantStreamChunk` 第一行读 `stream.length`。插件写的 assistant/message **既没有 `usage` 也
没有 `stream`**（宿主的 loop 两者必居其一），于是 `tokenUsage` / `contextPressure` 两个投影单元在
`apply` 时抛 `TypeError: Cannot read properties of undefined (reading 'length')`。投影折叠没有单元级
隔离，一个单元炸掉整次 `stateOf()`/`snapshot()`：

- 表现 2：`session.control` 的 `projectionBaseline` → `snapshot(session)` 抛裸 TypeError →
  `rpcFailure` 包成 `gateway/internal`，客户端拿到空投影 = 内容区空白；
- 表现 3：`session.create` 里的 `presetForSession` → `stateOf(session,'agentPreset')` 是同一个抛点。
  而该会话因为导入没写 `turn/start`，`sessionListMetadata.blank` 仍为 true（`applySessionListMetadata`
  只在 `turn/start` 上翻 false），原生「新建会话」的 blank 复用逻辑于是反复选中这个坏会话 ——
  一个坏会话拖累后续所有新建。

## Decision

1. **导入写成真实 turn 边界**：每条用户消息开一个 turn，每条角色消息是当前 turn 内一个
   `step/start` + `assistant/message` + `step/end`，turn 以 `reason: { kind: 'completed' }` 关闭
   （与 agent-loop 关闭零消息 turn 的方式一致）。`user/message` 保持宿主原生形状（无坐标）。
2. **导入的 assistant/message 补 `stream: []`**（v4 会话）：导入消息没有流式记录，空数组是诚实的，
   不产生 usage、不改变投影结果，但让投影单元可物化。按 `session.header.version` 分支——v0-v3 宿主
   把流式记录放在独立的 `assistant/chunk` 事件里，写 v4 专属成员会毒化老工件。
3. **写入 turn 边界后必须推动 live loop 的轮次基线**（`advanceHostTurnBase`）：
   宿主在构造 `AgentLoop` 时就快照了 `turnBoundary.lastTurn`（`AgentLoop.phase.lastTurn`），而会话与
   Agent 由宿主在插件写入任何事件**之前**创建（`session.create` → `agents.ensureSession` →
   `agentLoop.create` → `new ReactLoopAgent(...)`；插件的历史导入在之后的 `/dsh-tavern-session`
   命令里才发生），快照恒为 0。不推进基线，live loop 的首轮会再写一次 `turn/start { turn: 1 }`，
   V4 准入（`turn/start` 必须等于 `nextTurn`）把会话判成损坏。`occupyHostSession`（ST 架构的占位
   pair）有同样的缺陷，一并修：先探测基线可推进再写，写完推进到 1。
4. **基线不可推进时不写 turn 边界**（宿主换代、`phase` 缺失/冻结）：宁可在未知宿主上保留一个合法
   会话，也不要一个锁死却损坏的会话；代价是这次激活不留导入 marker，「已启动」锁定不建立，下次
   激活会重试导入。
5. **`finishTavernSessionTrace` 的 `step/end` 失败时不再写 `turn/end`**：V4 准入要求 `turn/end` 时没有
   打开的 step，而「未关闭的尾巴」本身合法，留尾巴胜过写一条让整个会话损坏的事件。
6. **v4 会话不再写 `assistant/chunk`**：这个 v0/v1 事件类型不在 v4 词汇表里，持久化校验以
   `unknown to this harness and not marked ignorable` 拒绝整个会话文件（v1→v2 迁移消费它，v4 日志
   不可能合法包含它）。v4 只写最终 `assistant/message`（正文完整）。
7. **回归用真实宿主代码**：新增 `packages/plugin/tests/agent-tavern-session-admission.spec.ts`，直接
   跑宿主自带的 V4 校验器与 token-meter 投影单元，断言导入计划通过准入、投影可物化、推进基线后的
   live 轮次被接受、落回 turn 1 被拒绝；并断言两个历史形状（裸 / turn 0）仍被拒绝。

## Evidence

- 真实校验器实测（`.npm-cache/dsh-runtime`，DSH `0.2.0-rc.2`）：
  - 旧形状 → `SessionFormatError: assistant/message does not match an open turn and step`
  - `turn/start { turn: 0 }` → `SessionFormatError: turn/start does not open the expected turn`
  - 新形状 → 准入 PASS；追加 `turn/start { turn: lastImportedTurn + 1 }` PASS；追加 `turn/start { turn: 1 }` FAIL
- token-meter 实测：旧形状 `tokenUsage`/`contextPressure` 抛 `Cannot read properties of undefined
  (reading 'length')`；补 `stream: []` 后两者 OK，准入仍 PASS。
- `assistant/chunk` 实测：用真实 `JsonlSessionPersistence` 写入 v4 工件再读回 →
  `SessionFormatUnsupportedError: contains event type "assistant/chunk" (seq 3) unknown to this harness
  and not marked ignorable; refusing to interpret the log`。
- 实机证据（用户 `~/.dsh/sessions`，305 个工件）：3 个 ST 会话存在**重复的 `turn/start { turn: 1 }`**
  （`session-4c468689`、`session-65b342b6`、`session-7186fe15`），形状为
  `agent-preset/selected → turn/start(1) → turn/end(1) → turn/start(1) → …` —— 正是「占位 pair 写入后
  live loop 基线未推进」的产物，v0 宿主没有关系准入所以长期未被发现；v4 上会直接损坏。
- `pnpm run check`：tsc + 42 个测试文件 / 574 项测试 + 插件构建 + 12 个 gates 全通过。

## Alternatives considered

- **只补 `turn/start`/`step/start` 边界，不推进基线**：静态校验通过，但 live loop 首轮撞号，把损坏
  从「创建时」推迟到「第一次说话时」——更糟，因为用户已经投入了对话。否决。
- **回到裸消息或 `turn: 0` 坐标**：分别死于客户端折叠器与 V4 准入，已被两次事故证明。否决。
- **插件自己 `ctx.agents.create({ seed })` 建会话**：宿主的 `agents.create` 确实支持构造 seed
  （`agent-loop.createAgent` → `sessions.prepare(id, { seed })` → 之后才 `new ReactLoopAgent`），是
  最干净的宿主级解法；但 `session.create` RPC 不暴露 seed，插件自建就必须自己复刻
  `api-session-controller.composeAgent` 的 preset mount 与 modelSelection 安装（`installSelection`
  是包内私有函数），并让 client 改为按 sessionId 收养会话（`sessions.create({ workspaceId, sessionId })`）。
  改动面覆盖 client 新建流程与工作区注册，无法在离线环境端到端验证。**建议作为后续方向**：等宿主在
  `session.create` 上开放 seed，导入就可以整体改成「服务端种子」，彻底不碰轮次基线。
- **靠 `agent.phase` 之外的公开 seam 推进基线**：当前宿主没有暴露；`runMaintenance` 只保留而不更新
  基线。因此这里用「先探测、可写才写、写后回读验证」的方式使用该字段，并保留不可用时的安全回退。

## Consequences

- 新建 AgentTavern 聊天：开场白与既有历史以真实轮次渲染，live loop 从 `lastImportedTurn + 1` 继续，
  会话在磁盘上是合法 v4 工件，原生「新建会话」不再复用/污染它（导入写了 `turn/start`，`blank`
  翻 false）。
- 存量坏会话无法自愈：工件已经损坏的会话（例如用户当前那些）需要删除重建；v0 老工件仍按原样被
  宿主迁移链处理，本次改动只影响新写入。
- `agent.phase.lastTurn` 不是宿主公开 seam：宿主若改名，`canAdvanceHostTurnBase` 探测失败，插件会
  记一条 warning 并跳过带边界的导入（会话保持合法，开场白不进会话）。这是刻意的失败降级方向。
- 投影折叠仍然没有单元级隔离：任何单元在 `apply` 里抛错都会杀掉整次 `snapshot()`。本插件能做的
  是把自己写入的事件严格对齐宿主 writer 的形状（本次的两个契约）。
