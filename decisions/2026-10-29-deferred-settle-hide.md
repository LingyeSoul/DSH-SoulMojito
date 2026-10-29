# AgentTavern 结算 hide 延后到 post-turn bridge

> 日期：2026-10-29。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §6.2、§7.3、
> [重生成隐藏草稿](2026-10-29-agent-tavern-regenerate-hides-draft.md)、
> `packages/plugin/src/agent-tavern/body-runtime-settlement.ts`、
> `packages/plugin/src/agent-tavern/body-wiring.ts`。

## 问题

重生成成功后，DSH Chat 里重写正文被**默认折叠**，并且不显示「本轮用量」（Turn usage）喵。

真实日志里一次重生成的结构：

- trigger turn step 1：assistant 正文 → step/end；
- 同一 turn 的 step 2：`step/start` → 空 `developer/message`（body-hide）→ `step/end`
  （结算时为了隐藏 trigger/process 而新开的无模型 step）。

DSH Chat 的两个判定都只看 **turn 的最后一步**：

1. **答案边界**：`latestAnswer(turn)` 取 `turn.steps.at(-1)?.data.get('assistant-step')`。
   最后一步是 hide step，没有 assistant 数据，`answerStep = null`；整个 turn 因此没有
   “答案”，正文也被当成 process member；`foldCompletedTurns` 默认开启 → 默认折叠。
2. **本轮用量**：`deriveTurnTokenUsage` 要求每个 step 都以 usage 样本收敛。hide step 没有
   样本，`closeOpen()` 失败 → 整个 turn 的 `tokenUsage` 被丢弃 → 不渲染 Turn usage。

为什么非要多开一个 step：DSH 的持久化关系准入要求 `developer/message` 必须匹配**打开的**
turn + step（`dsh-session-format-v3-to-v4` 的 `requireStep`，`dsh-session-persistence-jsonl`
在加载时使用它）；`agent/turn-stopping` 触发时答案步已经 `step/end`，runtime 只能开新 step喵。

## 决策

1. **新版操作延后 hide**：`finalizeTurnStopping` 只提交候选/select、write rollback 与 durable
   `settling` 标记；trigger/process 的 hide 不在答案 turn 内执行喵。
2. **post-turn bridge 收尾**：trigger turn 的 `turn/end` 之后，live turn/end 收尾链调用
   `finalizeRecoveredOperation`，走既有的 `settling → finish-hide → settled → op-finish`；
   `finishSettlementHide` 在 turn 已关闭时使用 `appendHideInBridgeTurn` 喵。
3. **答案 turn 保持完整**：最后一步就是正文，宿主恢复 Turn usage 并默认展开正文喵。
4. **旧版操作保持同步 hide**：start 之前就已存在的 anchor 仍在 surface，其 cancel 语义依赖
   当次 hide 失败；不改变旧会话行为喵。
5. **恢复不变**：`settling` 仍是崩溃窗口的 durable 证据；启动恢复走同一条 finish-hide 路径喵。
6. **不 fork、不 patch 宿主**：仍只用标准 surface 事件与 `developer/message` 喵。

## 否决项

- **继续在答案 turn 内开 hide step**：就是本问题本身；宿主 UI 无行级 seam 可补救喵。
- **把正文复制进 hide step**：会重复计数本轮用量并产生第二条 assistant 消息，正文与回滚都变复杂喵。
- **重开答案 step**：`step/start` 必须匹配 `nextStep`，持久化关系准入直接拒绝喵。
- **改宿主 Chat 投影**：违反仓库既有纪律，分发成本高喵。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 每次重生成多一个 post-turn bridge turn | 只出现在轮次导航；hide 节点是空 context，聊天区不渲染喵 |
| `op-finish` 延后，op 短暂留在 `pendingByAgent` | 收尾链在 turn/end 的微任务内执行；极端情况下下一 turn/end 或启动恢复兜底喵 |
| 收尾链错过窗口（用户立即发下一轮） | 收尾链重试 `session-busy`/`host-unsupported`；下一 turn/end 以 trigger turn 重试喵 |
| 旧版操作行为变化 | 按 `previousAnchorId` 是否仍在 surface 分支；旧版保持原路径喵 |

## 证据

- 宿主 `dsh-client-ui-chat`（0.2.1-rc.2）：`latestAnswer` 10687–10691；无答案分支
  10701–10709；`ChatNodeSeat` 的 process member/hidden 3733–3753；`deriveTurnTokenUsage`
  10957–11070；Turn usage 渲染 7003；`foldCompletedTurns` 12670–12683喵。
- 宿主准入：`dsh-session-format-v3-to-v4` 的 `requireStep` 573–575；
  `dsh-session-persistence-jsonl` 导入 `assertReleasedV4Relationships`喵。
- 真实日志：turn 9 step 1 为正文，step 2 为 hide；修复后重生成 turn 只有 answer step，
  hide 写入下一 bridge turn喵。
- 工程验证：body 聚焦 276 tests 全绿；`npm run check` 见提交前记录喵。

## 删除路径

- 停止延后：`SettlementContext.deferHide` 不再设置，回到答案 turn 内 hide（会重新引入
  Turn usage 缺失与默认折叠）喵。
- 已落盘的 `settling` / `settled` / bridge hide 事件按原语义投影，不需要清理喵。
