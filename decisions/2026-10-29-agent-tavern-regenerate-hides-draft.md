# AgentTavern 重生成：开始即隐藏旧正文（回到 ST 的重掷语义）

> 日期：2026-10-29。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §6.2、`0022` §10、
> [决策 2026-10-28（被本决策取代）](2026-10-28-agent-tavern-invisible-body-restore.md)、
> `packages/plugin/src/agent-tavern/body-runtime*.ts`。

## 问题

DSH 的原生展示面（Chat 转录、Trajectory 事件表、轮次导航）读取的是 append-only 事件日志：
body 结算写入的空 `developer/message` replacement 只对**模型面**生效，不会从人类视图移除已经
追加的合成 trigger 和候选正文。2026-10-28 的决策让旧正文在重试期间保持可见，于是：

1. 每次重试的请求上下文里同时有合成 trigger（`Regenerate the final assistant reply …`）和
   旧正文；Trajectory 把非 `user` 来源的 user 消息归为「上下文」行并展示原文，轮次仍在导航
   里列出。
2. 模型看到自己的草稿后基本照抄：实测一次真实重试的新正文与旧稿 normalized bigram 相似度
   **0.9594**（321 行中 258 行逐字相同）。官方视图里因此表现为“重试的正文出现了两次”。

2026-10-29 用户选择 ST 语义：**重掷不得看到被替换的草稿**。

## 决策

1. **开始即隐藏**：`startRegenerate` 在 `op-start` 之后、`followup` 之前，用一个 bridge turn
   把旧 anchor 与其旧 turn 的 process 节点移出模型面；真实用户消息与 system prompt 保留。
   bridge turn 关闭后推进 live loop 的轮次基线，trigger turn 从下一号开始。
2. **成功只收尾巴（2026-10-29 修订 2：延后到 post-turn bridge）**：`finalizeTurnStopping`
   先提交候选/select 与 write rollback，并写 durable `settling`；trigger/process 的 hide 不
   再在答案 turn 内开新 step，而是在 trigger turn 结束后由 live turn/end 收尾链在 bridge
   turn 完成（`settling → finish-hide → settled → op-finish`）。答案 step 保持为 turn 的
   最后一步，宿主才能给出本轮用量并默认展开正文（决策
   `2026-10-29-deferred-settle-hide.md`）。旧版操作仍在 open turn 内同步 hide。
3. **失败恢复旧正文**：新版操作（开始已隐藏 anchor）在失败/取消时走
   `body-restore-*` assistant 副本 + `body/restore`，副本成为新 anchor，JSONL 随事件换锚。
   旧版操作（anchor 仍在 surface）仍走不追加副本的兼容路径——按 anchor 是否在 surface 判定。
4. **start 失败**：若 anchor 已被移出 surface（hide 部分或全部落地、followup 失败），不写
   `op-finish`，保留 `op-start` 交给启动恢复还原旧正文；anchor 仍在 surface 时维持
   `op-finish failed`。
5. **settlement hide 失败**：新版操作保留已提交候选与 durable `settling` 记录，由恢复执行
   finish-hide（取消会让模型失去正文）；旧版操作仍写 `op-settle-cancelled` 并回退 select。
6. **不 fork、不改提示词模板、不新增工具**：隐藏仍只由插件 runtime 用标准 surface 事件执行。

## 否决项

- **保留旧稿、只把指令改成“写一个不同的版本”**：依赖模型自觉，旧稿仍留在重试请求里，且与
  “继续从可见上下文写”的契约自相矛盾；实测照抄率已经说明约束不可靠。
- **只改客户端展示**：Chat 已有 keyed override，但 Trajectory 与轮次导航是宿主只读投影，
  没有行级 seam；不能靠 UI 掩盖日志事实。
- **用 message projection 删除消息**：宿主投影只能改写内容、不能删消息（提案 0021 §2.2）。
- **patch / fork 宿主**：违反仓库既有纪律，分发成本高。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 失败恢复重新引入 assistant 副本（2026-10-28 的收益回退） | 只在新版操作的失败路径出现；成功重试不产生副本；旧版会话行为不变 |
| 每次重试多一个 bridge turn，轮次导航多一个无预览 turn | bridge turn 无 prompt/response，导航按轮次号展示；属于已接受的视觉成本 |
| 结算 success 再多一个 post-turn bridge turn | hide 落在 turn/end 收尾链；聊天区不渲染，仅轮次导航多一空 turn（决策 2026-10-29-deferred-settle-hide） |
| start 失败且 anchor 已隐藏 | 不写 `op-finish`，op-start 留在日志里，启动恢复走 restore 副本；日志一行 warning 可观测 |
| 旧稿不再进入重试上下文，连续性依赖历史 | 场景历史仍在上下文中；这是 ST `regenerate` 的既有语义 |

## 证据

- 真实会话日志（2026-10-29）：重试 turn 的请求上下文含合成 trigger；旧稿与新稿相似度
  0.9594；settle 的 replacement 未改变人类转录。
- 宿主 0.2.1-rc.2：Chat 转录只取 append-origin 事件、replacement 标注为 model-only；
  Trajectory 把非 `user` 来源的 user 消息呈现为「上下文」行；轮次大纲只折叠
  `turn/start` + 人类 prompt + `assistant/message`，不处理 replacement。
- 工程验证：body 聚焦 11 个 spec / 270 tests 全绿（runtime 69、wiring 54 等）；
  `npm run check` 见提交前记录。

## 删除路径

- 停止新隐藏：后续重试不再开 bridge turn，旧会话仍可读（已落盘的 replacement / restore
  事件按原语义投影）。
- 不得为了“清理 surface”删除历史消息事件；DSH 是 append-only 日志。
- `body-restore-*` 兼容路径与新版失败恢复共用同一实现，可随旧会话淘汰一起移除，但不能删除
  已落盘的恢复事件。
