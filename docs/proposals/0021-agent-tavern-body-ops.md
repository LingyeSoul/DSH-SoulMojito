# 提案 0021：AgentTavern 正文编辑、重生成与正文候选（swipe）

> 状态：已实现（工程验证通过；真机 E2E 待补）。日期：2026-10-28。
> 参照物：DSH `0.2.1-rc.2` 的公开 seam——Session 追加式日志与 surface replacement、
> plugin-owned message projection、`agent.followup` / `agent/turn-stopping`、客户端
> `conversation.chat.assistant-actions` 与 `conversation.chat.node` slot。
> 本提案不 fork、不 patch 宿主，不新增第二条 LLM 主循环；只把 DSH 已有 seam 组合成
> AgentTavern 的正文操作语义。

## 1. 目标与范围

在 `agent-tavern` 单角色聊天里实现三种用户动作：

1. **修改正文**：编辑当前最后一组正文文本，不新开 turn、不调用模型。
2. **重新生成正文**：对最后一组正文重掷，可带意见；旧正文保留为候选。
3. **生成 / 切换正文候选（swipe）**：候选是角色回复的备选，可左右切换；每个候选都是
   真实 `assistant/message` 事件，只有选中候选进入模型上下文。

本提案的「候选」是**正文候选**，区别于提案 0010 的「行动候选」：行动候选填入输入框、
由玩家修改后发送；正文候选直接替换当前角色回复，不产生玩家楼层。

明确不做：

- 不使用 `ctx.sessions.fork` 为每个候选创建子会话。
- 不修改宿主 `assistant/message` 的已提交内容，不伪造宿主不接受的 surface 操作。
- 不绕过 DSH AgentLoop 另起一条生成链路。
- 不支持改写已有后续剧情的历史楼层；只在最后一组正文上操作。
- 不改变 ST 架构的编辑 / swipe / regenerate 行为；群聊仍固定 ST。

## 2. DSH 官方 seam 事实

以下事实来自宿主公开类型、源码行为与本地最小复现，不是对宿主的修改承诺。

### 2.1 `assistant/message` 不能做 replacement

`assistant/message` 是 surface 事件，但宿主禁止它携带 `sourceEventSeqs`；而 replacement
要求 `sourceEventSeqs` 覆盖所有被 shadow 的当前 surface 节点。因此不能“再写一条
assistant 替换旧 assistant”。本地复现的错误包含：

```text
surface replace: sourceEventSeqs must include every shadowed surface node
assistant/message embeds its source stream and cannot carry sourceEventSeqs
```

### 2.2 plugin-owned message projection 只能改内容，不能删消息

`SessionStore.registerMessageProjection()` 注册的纯函数可以改写一条既有消息的内容，但
`deriveEventMessage()` 对投影结果直接返回；把 assistant 投影成空 content 仍会得到一条
`role: 'assistant', content: []` 的消息。因此投影不能承担“隐藏旧候选”的职责。

### 2.3 空 `developer/message` replacement 可以移出模型面

空 content 的 `developer/message` 在 `deriveMessages()` 中返回 `null`。对一个当前 surface
节点追加：

```text
surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }
sourceEventSeqs: [seq]
```

即可把该节点从模型可见上下文移除，同时保留 append-origin 日志记录。它是标准 surface
事件，不依赖插件投影，重启仍可由宿主校验。

### 2.4 生成与收尾的官方入口

- `agent.followup(UserMessage)`：开启一个新 turn，是 DSH 官方的“普通后续输入”入口。
- `agent/turn-stopping`：turn 关闭前 await 的 serial 事件，可在最终 assistant 结算后、
  `turn/end` 前追加事件。
- `agent.ctx.tools.restrict({ deny })`：agent-scoped 工具限制，可用于重生成期间禁用写工具。
- `conversation.chat.assistant-actions`：已结算 assistant 消息的官方动作 list slot。
- `conversation.chat.node`：按 kind 替换渲染器；现有实现已用它覆盖 `assistant-step`。

### 2.5 自定义日志事件必须可忽略

DSH 的 v4 持久化与格式准入要求未知事件类型带 `ignorable: true`，否则整份会话拒载；
而 `Session.append()` 没有写入 `ignorable` 的入口。因此 body ledger 不能直接用
`session.append('dsh-soulmojito/body', ...)`，必须走宿主的 plugin-record 入口：

```ts
const seq = appendPluginRecord(session, 'plugin:dsh-soulmojito/body', data)
```

`appendPluginRecord` 会写入 `ignorable: true`，记录不进入 surface，宿主不识别时安全跳过。
本地最小复现确认：记录 `ignorable === true`，注册同名投影后 `deriveMessages()` 文本被改写；
未注册投影时原文不变、会话可恢复。

该入口属于宿主的实验命名空间，必须做版本探测：宿主没有 `appendPluginRecord` 时返回
`host-unsupported`，不静默退回 `Session.append`。记录名遵循
`plugin:<owner>/<record>` 语法，本提案固定为 `plugin:dsh-soulmojito/body`。

宿主 README 同时声明该入口面向 `packages/experimental/`、仓库外插件“也不应调用”（但无仓库
检查可约束外部插件）。本仓库把这条依赖作为显式的版本敏感 seam 处理：功能门控、失败关闭、
在 [`decisions/2026-10-28-agent-tavern-body-plugin-records.md`](../../decisions/2026-10-28-agent-tavern-body-plugin-records.md)
披露政策与删除路径，不用它替代任何宿主仓库内逻辑。

### 2.6 replacement 的 turn/step 与客户端行约束

- v4 关系校验要求 `developer/message` 位于**已打开的 turn + 已打开的 step**；`agent/turn-stopping`
  触发时 loop 已经写了 `step/end`，turn 仍打开。因此监听器里必须自己
  `step/start` → replacement → `step/end`，或使用独立的 bridge turn；否则当场 append
  成功、下次打开报 `developer/message does not match an open turn and step`。
- 空 `developer/message` replacement 会以 `context` 行出现在客户端时间线；只覆盖
  `turn-trigger` 不够，还必须加 `context` 的 keyed override，隐藏
  `source.form ∈ {body-hide, body-regenerate, body-restore}` 的行。
- `agent/turn-stopping` 只在 turn 正常收口时触发；错误、取消、blocked 路径不会触发。
  `op-start` 的清理/恢复必须同时由 `turn/end` 观察或启动扫描兜底。

## 3. 领域模型

### 3.1 body group

一组属于同一个“正文楼层”的候选集合。`groupId` 取该楼层第一条原生
`assistant/message` 的 `message.id`，写入 Tavern 聊天的
`extra.agentTavern.bodyGroupId`。

### 3.2 anchor

当前唯一留在模型 surface 中的 assistant 消息。模型只能看见 anchor 的内容；旧候选通过
空 `developer/message` replacement 被 shadow。

### 3.3 body ledger

由 `plugin:dsh-soulmojito/body` 日志事件折叠出的只读状态：

```ts
interface BodyCandidate {
  messageId: string
  index: number
  text: string
  feedback?: string
}

interface BodyLedger {
  groupId: string
  candidates: readonly BodyCandidate[]
  selectedIndex: number
  anchorMessageId: string
  edits: ReadonlyMap<number, string>
}
```

`foldBodyLedger` 需要输入事件里包含候选对应的 `assistant/message`，用它的文本填充
`BodyCandidate.text`；缺失时抛 `body-candidate-message-missing`，不静默填空。

### 3.4 唯一事实来源

| 事实 | 权威来源 |
|---|---|
| 模型可见正文与历史 | DSH Session surface + body projection |
| 候选顺序、选中索引、编辑文本 | `plugin:dsh-soulmojito/body` 日志事件 |
| Tavern JSONL 的 `mes` / `swipes` / `swipe_id` | projector（投影） |
| UI 展示文本 | `GET body`（由 JSONL 投影 + ledger 派生） |
| 操作互斥与恢复 | 进程内 mutation tail + `op-start` / `op-finish` 事件 |

## 4. 日志事件

新增 log-only 记录类型 `plugin:dsh-soulmojito/body`，通过宿主 `appendPluginRecord` 写入
（自带 `ignorable: true`），不携带 `surfaceOp`、不进入 surface。

```ts
type BodyEventData =
  | { op: 'op-start'; opId: string; groupId: string; kind: 'regenerate'; previousAnchorId: string; previousIndex: number }
  | { op: 'op-finish'; opId: string; result: 'ok' | 'failed'; anchorId?: string; reason?: string }
  | { op: 'candidate'; groupId: string; messageId: string; index: number; feedback?: string }
  | { op: 'restore'; groupId: string; messageId: string; index: number }
  | { op: 'select'; groupId: string; index: number }
  | { op: 'edit'; groupId: string; index: number; text: string; previousText: string }
```

事件按 `seq` 追加；`op-start` 没有对应 `op-finish` 即为未完成操作，由启动恢复处理。

## 5. 消息投影

```ts
const bodyProjection = {
  type: 'plugin:dsh-soulmojito/body',
  project(event, context) {
    if (event.data.op !== 'select' && event.data.op !== 'edit') return new Map()
    const ledger = foldBodyLedger(context.events, event.data.groupId, event.seq)
    const anchor = findAssistantMessage(context.events, ledger.anchorMessageId)
    if (anchor === undefined) return new Map()
    return new Map([
      [anchor.seq, replaceTextBlocks(anchor.data.message, effectiveText(ledger))],
    ])
  },
}
```

实现约束：

1. `context.messages` 只包含已经被投影改过的消息，不是全量历史；定位原始消息必须查
   `context.events`。
2. 投影必须纯函数，不读时钟、随机数、文件或网络。
3. `replaceTextBlocks` 保留 `id` / `role` / `source` / reasoning / tool-call 等非文本块，
   只替换文本块。
4. 投影只更新 anchor；被 shadow 的旧候选不需要也不允许重新进入 surface。
5. 投影注册在插件 root bundle，且必须保留为长期兼容 shim；不要因为功能开关关闭就反注册。

## 6. 操作流程

### 6.1 修改正文

1. 校验 binding 为 `agent-tavern`、非群聊、agent `idle`、目标是最后一组、anchor 仍在
   `session.surface.nodes`。
2. 追加 `{ op: 'edit', groupId, index, text, previousText }`。
3. 投影更新 anchor 内容；下一次 `deriveMessages()` 立即包含新文本。
4. projector 更新 JSONL 的 `swipes[swipe_id]` 与 `mes`。
5. 客户端按 messageId 重新拉取展示文本。

拒绝条件：

- 后续已有真实用户楼层：`409 not-last-round`。
- anchor 已被 compaction shadow：`409 body-compacted`。
- 空文本、超长文本：`400 invalid-body-text`。

### 6.2 重新生成正文

1. 校验同上，并额外要求 `canAdvanceHostTurnBase(agent)` 为真；否则拒绝，避免失败后
   无法恢复旧正文。
2. 追加 `op-start`。
3. 用 agent-scoped 工具限制禁用写工具（记忆、变量、剧本推进、游戏落子等）；读工具保留。
   deny 列表必须先与当前可见工具核对，未知工具名不要传给 `restrict`（宿主会抛错并终止
   本次操作）。
4. **开始时先隐藏旧 anchor**（2026-10-29 修订）：`op-start` 之后、trigger turn 之前，用一个
   bridge turn 把旧正文 anchor 与其旧 turn 的 process 节点移出模型面（真实用户消息与系统节点
   不隐藏）。重试请求因此看不到被替换的草稿，模型不会把自己的可见正文改写成近似副本；代价是
   失败恢复必须把旧正文作为 assistant 副本重新追加（见第 7 条）。
5. `agent.followup()` 投递 plugin source 的合成 trigger：

```ts
const trigger = {
  id: `body-trigger-${opId}`,
  role: 'user',
  content: [{ type: 'text', text: regenerationInstruction(feedback) }],
  source: hostPluginMessageSource(session, {
    form: 'body-regenerate',
    summary: `body regenerate ${opId}`,
    groupId,
    opId,
  }),
}
```

6. `agent/turn-stopping` 中：
   - 找本 turn 最后一个带文本且无 tool-call 的 `assistant/message`；
   - 追加 `candidate` 与 `select`；
   - 先提交（commit）write rollback，再 commit 失败时旧 anchor 仍可见；
   - 先写 durable `op-settling`。**新版操作**（第 4 条已隐藏 anchor）不在本 turn 内 hide：
     trigger turn 的 `turn/end` 之后由 live 收尾链在 post-turn bridge 用空
     `developer/message` replacement 把 trigger 与该 turn 的 process 节点移出模型面；
     答案 step 因此保持为 turn 的最后一步，宿主才能显示本轮用量并默认展开正文。
     **旧版操作**（anchor 仍在 surface）仍在当前 open turn 内同步 hide；
   - hide 成功后写 `op-settled`，再追加 `op-finish { result: 'ok', anchorId }`。hide 之后
     commit/op-finish 晚失败时保留新正文，只把 op-finish 留给恢复重试；hide 失败时：旧版
     操作（anchor 仍可见）写 `op-settle-cancelled` 并回退 select，新版操作保留已提交候选、
     只留 `settling` 记录交给恢复完成剩余 hide（anchor 已不可见，取消会让模型失去正文）。
7. 失败 / 取消 / 超时（`turn-stopping` 在错误、取消、blocked 路径不会触发，必须由
   live `session/event` 的 `turn/end`（reason `error` / `cancelled` / `aborted`）或启动扫描触发）：
   - live `turn/end` 监听器只登记，异步 microtask 调 `restoreBodyAfterFailure`，不在事件栈
     append；同一 session 去重；正常 `completed` 走结算收尾（完成延后的 hide），不触发 restore；
   - 追加 `op-finish { result: 'failed', reason }`；
   - 有 `op-settled` 标记：body 已结算，保留新正文，不 hide/不 restore/不追加 assistant，
     仅重试 `op-finish`；
   - 新版操作（开始已隐藏 anchor）：打开不调用模型的恢复 turn，追加 `assistant/message`
     副本（`stream: []`，沿用旧 provider/model）与 `body/restore`，关闭 step/turn 后
     `advanceHostTurnBase`；副本是新的 anchor，JSONL 随 `restore` 事件换锚；
   - 旧版操作（anchor 仍在 surface）：只用一个 bridge turn 隐藏失败 turn 的 trigger/process
     节点，**不追加 assistant 消息、不追加 `restore` 事件、不改 JSONL 正文**（兼容 fallback）；
   - 恢复 turn 的 trigger 同样用空 developer 隐藏。
8. HTTP 建议返回 `202 { opId }`，客户端轮询 `GET body` 或订阅 `op-finish`，避免长连接
   等待整个 turn。

### 6.3 生成候选与切换

- 生成新候选与 6.2 完全同一条路径；新候选默认选中，`swipe_id` 指向末尾。
- 切换候选只追加 `{ op: 'select', groupId, index }`：
  - 投影把 anchor 内容改成选中候选的文本；
  - projector 更新 JSONL 的 `swipe_id` / `mes`；
  - 不发模型请求、不开 turn、不 fork。
- 不尝试“复活”旧 assistant 节点；旧节点已被 shadow，复活需要 assistant replacement，
  宿主明确拒绝。

## 7. 展示层

### 7.1 动作入口

注册 `conversation.chat.assistant-actions` 的 `tavern-body-actions`：

- `编辑`：InlineEditor 或插件弹层，保存走 `PUT body`。
- `重新生成`：可带意见，走 `POST body/regenerate`。
- `‹ 2/5 ›`：走 `POST body/select`。
- 非 anchor 节点不渲染动作。

稳定 test id：`tavern-body-edit`、`tavern-body-regenerate`、`tavern-body-swipe-prev`、
`tavern-body-swipe-next`、`tavern-body-swipe-count`。

### 7.2 节点渲染

扩展现有 `client-src/89-ui-assistant.js` 的 `assistant-step` override：

- 按 `messageId` 查询 `GET body`；
- `hidden: true` 的旧候选返回 `null`；
- anchor 用返回的 `text` 替换文本块，其余 reasoning / image / turn 处理链保持宿主行为；
- 新增 `turn-trigger` keyed override，隐藏 source.form 为 `body-regenerate` /
  `body-restore` 的合成输入；
- 新增 `context` keyed override，隐藏 source.form 为 `body-hide` / `body-regenerate` /
  `body-restore` 的空 developer replacement 行（否则每次 hide 都会在时间线插一条
  “上下文注入”）；
- 可选覆盖 `turn-tail`，隐藏候选 turn 的 footer。

已知限制：不 patch 宿主时，turn rail / turn outline 仍会列出候选 turn；正文显示在 anchor
所在 turn。此限制必须在发布说明中写明。

### 7.3 API

```text
GET  /api/dsh-soulmojito/body?sessionId=&messageId=
PUT  /api/dsh-soulmojito/body
POST /api/dsh-soulmojito/body/regenerate
POST /api/dsh-soulmojito/body/select
```

`GET body` 返回：

```ts
{
  ok: true,
  groupId: string,
  anchorMessageId: string,
  selectedIndex: number,
  count: number,
  text: string,
  hidden: boolean,
  canEdit: boolean,
  canRegenerate: boolean,
  canSelect: boolean,
  projectionPending?: boolean,
  reason?: string,
}
```

JSONL 楼层落后于 ledger 时返回 `projectionPending: true`。判定：`agentTavern.lastBodyEventSeq`
未覆盖最新 `edit`，或 anchor/index 与 ledger 不一致。edit 水位落后时 `text` 改用 ledger
文本；仅 selection 落后时改用楼层 `swipes[ledger.selectedIndex]` 的保存层文本（楼层可能
仍指向旧 anchor）。客户端再按 150/400/900ms 有界重取一次展示层文本；投影正常时以 JSONL
`mes` 为准（保存层 + markdownOnly 正则）。

## 8. JSONL / ST / JSR 投影

projector 新增 body 分支：

| 事件 | JSONL 动作 |
|---|---|
| `candidate` | 追加 `swipes[]` / `swipe_info[]`，选中新索引，更新 `mes` |
| `select` | 更新 `swipe_id` / `mes` |
| `edit` | 更新 `swipes[swipe_id]` / `mes` |
| `restore` | 只更新 `extra.agentTavern.anchorMessageId`，不新增候选 |
| `op-*` | 不写 JSONL |

规则：

1. 带 `body-regenerate` / `body-restore` trigger 的 turn，assistant 不按普通楼层追加；
   由 `candidate` / `restore` 合并。
2. 所有 JSONL 更新继续走 `saveChat` 的 revision CAS，单写者仍是 projector。
3. `getChatMessages(..., { include_swipes: true })` 自动看到新 `swipes` / `swipe_id`。
4. 前端 frame 现有的 `MESSAGE_SWIPED` / `MESSAGE_EDITED` 逻辑继续生效。
5. `/regenerate` 对 AgentTavern 目前显式报错；本提案落地后改为调用 body regenerate。

## 9. 并发、恢复与删除路径

### 9.1 并发

- 每个 session 一把 `KeyedMutationTails` 锁，body 操作串行。
- 操作前 `agent.status === 'idle'`；运行中返回 `409 session-busy`。
- 请求携带 `expectedAnchorId` / `expectedIndex`，避免多客户端竞争。
- 操作期间 composer 置灰；服务端 `agent/pre-step` 可 fail-closed 拒绝新 step，直到
  `op-finish` 或恢复完成。
- 不要在 `session/event` 监听器里同步 append body 事件：宿主会抛 append 重入错误。
  JSONL 投影走现有 projector 链，事件写入只发生在 HTTP 操作与 turn-stopping 监听器内。

### 9.2 崩溃恢复

- `op-start` 无 `op-finish` 即为未完成。
- 启动时扫描 body 事件：有候选 assistant 就补 `candidate` / `select`；没有就补
  `restore` / 清理 trigger。
- 恢复结算必须复用 runtime 的 `finalizeRecoveredOperation`（内部与 `finalizeTurnStopping`
  共用同一结算 helper）；wiring 不得自己拼 `candidate/select/op-finish`，否则会漏掉
  trigger/process 的 hide replacement。
- `op-settling` / `op-settled` / `op-settle-cancelled` 是两阶段 durable 结算证据：恢复读到
  `settled` 只补 `op-finish`；读到 `settling` 时按 surface/ledger 四分支判定（补 settled、
  幂等补 hide 后 settled、取消恢复、fail-closed）；读到取消记录则恢复旧正文。
- `op-settling` 记录本次 hide 目标（`triggerMessageId` 与 `previousAnchorId`）。判 settled 前
  必须确认 trigger/process 与旧 anchor 都已离开 surface；只要 ledger 已提交到新候选，
  剩余任意 range（trigger 先隐藏或 anchor 先隐藏、甚至两段都还可见）都走 `finish-hide`，
  只隐藏剩余目标，不重复 hide、不改 ledger/select。
- `op-settled` 的 evidence 带日志 `seq`；恢复对账时若当前选中已不是结算候选，只有存在
  “标记之后的 select”记录才允许补 `op-finish`（用户后续切换），标记之前就未选中仍
  `invalid-event`。
- live `session/event` 的 `turn/end` 失败边（`error` / `cancelled` / `aborted`）必须异步触发
  `restoreBodyAfterFailure`；监听器只登记，不在事件栈 append，同一 session 去重。恢复按
  0/50/250ms 有界重试，只重试 `session-busy` / `host-unsupported`，unload 清理 timer，
  最终失败交启动恢复。
- 半开 turn 用现有 `closeImportBracket` 兜底关闭。

### 9.3 compaction

anchor 不在 `session.surface.nodes` 时，编辑 / 切换 / 重生成全部拒绝，返回
`409 body-compacted`。

### 9.4 删除路径

body 记录是 `ignorable: true` 的 plugin record，因此**进程重启后**如果插件不在，宿主会跳过
这些记录，会话仍能加载；代价是编辑/选中效果消失，模型看到最后一次落盘的 assistant 原文。
这比“自定义 required 事件毒化会话”安全得多。

仍有两个边界：

- **live 卸载**：`registerMessageProjection` 已被使用时，同一进程内反注册会让宿主的
  `_assertProjections` 拒绝继续推导，直到插件恢复或进程重启；因此关闭功能只停止新建
  body 事件，**保留** projection 作为兼容 shim。
- **彻底移除**：需要把选中正文物化/迁移，或明确接受“旧会话的编辑/选中不生效”；JSONL
  的 `swipes` 仍在，但模型面回到最后一次 assistant 原文。更新说明与卸载提示必须写明。
- 不把 `plugin:dsh-soulmojito/body` 记录写进纯对话导出。

## 10. 副作用边界（P0 必读）

1. **MVU 变量**：旧正文的 `<UpdateVariable>` 已经应用；直接再投影新正文会在旧变量上
   再打一次 patch。重生成按 receipt 的 before 值回滚到该正文之前（提案 0022 §4），
   `body:<messageId>` 缺失时拒绝并返回 `409 body-state-unsafe`。
2. **记忆 / 写工具**：旧 turn 的 `memory_write/update/forget` 与变量写工具通过
   `plugin:dsh-soulmojito/write` journal 记录 before/after；重生成允许这些工具运行，
   失败时先撤销新 turn 写入、再恢复旧 turn 写入（提案 0022 §3、§10）。
3. **前端脚本 / 美化前端**：旧正文触发过的卡脚本不会回滚；新正文会重新触发展示层，
   脚本副作用不在事务内。
4. **导出**：JSONL 的 `swipes` / `swipe_id` 必须与 body ledger 同版本；导出只依赖 JSONL，
   不把内部 body 事件写进纯对话导出。

P0 限制：

- 只支持最后一组正文。
- 缺 receipt / journal / 宿主 seam 时显式拒绝，不静默写坏。
- 重生成允许记忆与变量写工具；`tavern_script_advance` 与游戏落子仍禁用（没有同级 checkpoint）。
- MVU 的编辑与候选切换仍拒绝（`edit-rollback-unavailable` / `select-rollback-unavailable`）；
  历史楼层编辑/切换默认关闭。

## 11. 拒绝码

| 码 | 场景 |
|---|---|
| `architecture-mismatch` | binding 不是 `agent-tavern` 或为群聊 |
| `session-busy` | agent 非 idle 或已有 body 操作 |
| `not-last-round` | 目标之后已有真实用户楼层 |
| `stale-anchor` | `expectedAnchorId` / `expectedIndex` 不匹配 |
| `body-compacted` | anchor 已不在当前 surface |
| `body-state-unsafe` | MVU / 变量无法安全回滚 |
| `invalid-body-text` | 空文本或超过长度上限 |
| `host-unsupported` | 宿主缺少 projection / turn-stopping / tools.restrict |
| `projection-pending` | 事件已提交但 JSONL 投影失败，可重试 |

## 12. 开工前检查表

1. **所有者**：`packages/plugin/src/agent-tavern/body.ts`（ledger/投影）、
   `body-runtime.ts`（操作状态机）、`projector.ts`（JSONL 投影）、
   `client-src/89-ui-assistant.js`（展示与动作）、`http/router.ts`（路由）。
2. **唯一事实来源**：DSH Session 日志中的 body 事件；JSONL 只是投影。
3. **持久态及理由**：body 事件必须落盘，保证候选、选中、编辑在重启后可重建；JSONL
   `swipes` 落盘以维持 ST/JSR 兼容。
4. **临时态**：进程内 mutation tail、pending op map、客户端展示缓存；重启即失，
   由 `op-start` / `op-finish` 与 JSONL revision 重建。
5. **外部依赖**：DSH `sessions.registerMessageProjection`、`appendPluginRecord`、
   `agent.followup`、`agent/turn-stopping`、`ctx.tools.restrict`、`conversation.chat.*`
   slots；无新增网络端点。
6. **注册入口**：插件 root `apply()` 注册 projection / `agent/turn-stopping` /
   `session/event` 分支；HTTP 路由；客户端 slot 注册。
7. **删除路径**：body 记录 `ignorable`，重启无插件可跳过；关闭功能只保留 projection
   shim、停止新事件；彻底移除前提供正文物化/迁移或明确接受编辑/选中失效。
8. **兼容对象**：ST 架构完全不变；普通 DSH 会话不注册任何 slot/投影；旧宿主缺少 seam
   时功能关闭并返回 `host-unsupported`，不静默降级。

## 13. 包结构

```text
packages/plugin/src/agent-tavern/body.ts          # 事件类型、ledger fold、投影、文本替换（纯函数）
packages/plugin/src/agent-tavern/body-runtime.ts  # op 状态机、followup、turn-stopping、restore
packages/plugin/src/agent-tavern/body-jsonl.ts    # JSONL swipes 投影（纯函数）
packages/bind/src/host-session.ts                 # appendPluginRecord 版本探测与结构适配
packages/plugin/src/agent-tavern/projector.ts     # 接入 body-jsonl 与 trigger turn 跳过
packages/plugin/src/index.ts                      # inject sessions、注册 projection/事件/路由
packages/plugin/src/http/router.ts                # body 路由
packages/plugin/client-src/89-ui-assistant.js     # anchor / 隐藏 / 展示
packages/plugin/client-src/89b-ui-body.js         # 动作与状态缓存
packages/plugin/tests/agent-tavern-body-*.spec.ts
```

## 14. 测试

1. **投影单测**（真实 `dsh-session`）：
   - `appendPluginRecord` 写入 body 记录，断言 `ignorable === true`；
   - 注册 projection 后文本变化；无 projection 恢复时原文不变；
   - 空 developer replacement 隐藏 assistant / user；
   - assistant replacement 被拒绝（作为契约钉住）。
   契约测试按“仓库缓存 → `NODE_PATH` → 全局 `npm root -g`”回退解析宿主；有 0.2.1 宿主时
   全量执行，只有 0.2.0 缓存时显式 skip plugin-record 两条并警告，不假绿。
2. **ledger 单测**：候选顺序、选中索引、edit 生效、restore 不新增候选、乱序/缺失事件。
3. **JSONL 投影单测**：`swipes` / `swipe_id` / `swipe_info` / `mes`、CAS 冲突重试、
   trigger turn 不追加新楼层。
4. **runtime 单测**：成功、失败、取消、`op-start` 无 finish、`canAdvanceHostTurnBase`
   为 false、写工具限制释放。
5. **真实宿主 E2E**：编辑后下一次请求只含新文本；重生成成功/失败；切换候选后模型面
   只含选中文本；重启可读；`sessions.fork` 零调用。
6. **客户端**：anchor 显示、旧候选隐藏、trigger 隐藏、动作按钮、i18n、失败提示。

## 15. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | body 事件 + 投影 + edit | 编辑后 `deriveMessages()` 变文本；JSONL 同步；无新 turn |
| P1 | regenerate + turn-stopping + restore | 成功只剩新正文；失败恢复旧正文；trigger 不进后续请求 |
| P2 | candidate + select + UI swipe | 切换后模型面文本变化；JSONL `swipe_id` 变化；无模型调用 |
| P3 | 崩溃恢复、compaction 拒绝、MVU checkpoint、JSR 事件 | 重启可读；不重复结算；事件正确 |

## 16. 否决项

- **每个候选 fork 一个 Session**：违背本提案前提；破坏会话连续性与缓存。
- **直接 `assistant/message` replacement**：宿主拒绝，重启校验也会失败。
- **用 `Session.append()` 写自定义 body 事件**：无法写 `ignorable`，v4 持久化/格式准入
  会拒载整份会话；必须走 `appendPluginRecord`。
- **只用 message projection 隐藏旧候选**：投影不能删消息，会留下空 assistant。
- **只写 JSONL 的 swipe**：模型看不到选中文本，下一次请求与界面分叉。
- **另起一条 LLM 生成循环**：违反 AgentTavern 复用 AgentLoop 的架构红线。
- **patch / fork DSH 宿主**：版本敏感、分发成本高；本提案不采用。
- **改写已有后续剧情的历史楼层**：会破坏后续回合的因果基础，官方语义也不支持。

## 17. 验收

1. 编辑后，下一次模型请求包含新正文，且没有新增 turn。
2. 重生成成功后，模型面只包含新正文；旧正文、合成 trigger、旧 process 节点都不在。
3. 重生成失败/取消后，旧正文仍可见且仍在模型面；trigger 被清理。
4. 切换候选不发模型请求；模型面只包含选中候选文本；JSONL `swipe_id` 同步。
5. 重启后会话可读，ledger/projection 重建一致。
6. ST 架构、普通 DSH 会话、群聊行为零变化。
7. 全程 `sessions.fork` 零调用；没有 `assistant/message` replacement。
8. body 记录全部 `ignorable === true`；插件缺失时重启仍可加载会话。
