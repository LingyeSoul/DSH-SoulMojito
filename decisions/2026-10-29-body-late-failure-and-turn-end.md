# 正文回滚晚失败与 live turn/end 恢复

> 日期：2026-10-29。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §6.2、§9.2、
> `0022` §10、`packages/plugin/src/agent-tavern/body-runtime-settlement.ts`、
> `body-wiring.ts`。

## 问题

1. 成功结算已经 hide 旧 anchor 后，`commit` 或 `op-finish` 才失败，恢复逻辑因为旧
   anchor 已不在 surface 而走 `body-restore-*` 兼容 fallback，可能追加一条 assistant
   消息，违背“Agent 不感知回滚”。
2. `agent/turn-stopping` 在错误、取消、blocked 路径不触发；live `turn/end` 失败后没有
   自动调用 `restoreBodyAfterFailure`，失败 turn 的 trigger/process 要等启动恢复才隐藏。

## 决策

1. **两阶段 durable 结算**：新增独立 plugin record
   `plugin:dsh-soulmojito/body-settled`，payload 支持 `op-settling`（hide 前）、
   `op-settled`（hide 后）与 `op-settle-cancelled`（hide 失败）。记录只被 body
   runtime/recovery 读取，不进入消息投影、JSONL 或模型面。
2. **晚失败保留新正文**：`commit` 前移到 hide 之前；hide 成功并写 `op-settled` 后，
   `commit` / `op-finish` 失败不再回滚正文、不追加 assistant，只保留 op-start 并让恢复
   重试 `op-finish`。恢复读到 `op-settled` 时只补 `op-finish`，不重复 candidate/select/hide。
3. **settling 恢复判定**：崩溃在 hide 与 `op-settled` 之间时，恢复根据 surface 与 ledger
   三态判断：旧 anchor 已隐藏且新候选已选中 → 补 `op-settled` + `op-finish`；
   旧 anchor 仍可见且 select 已回退 → 写取消并恢复旧正文；其它状态 fail-closed。
4. **标记对账**：`op-settled` 的 `groupId/anchorId/index` 必须与 ledger 槽位、当前选中与
   `anchorMessageId` 一致，否则抛 `invalid-event`，不写 `op-finish`。
5. **legacy fallback 收窄**：没有 settlement 证据的旧会话才允许 `body-restore-*` 兼容恢复；
   新会话失败且旧 anchor 可见时只隐藏失败 turn 节点。
6. **live turn/end 恢复**：`session/event` 监听 `turn/end` 的 `error` / `cancelled` /
   `aborted`；监听器只登记，`queueMicrotask` 异步调用 `restoreBodyAfterFailure`，同一
   session 去重。恢复失败只记结构化错误并保留 op-start，交给启动恢复。
7. **恢复指标**：`BodyRecoveryOutcome.status` 增加 `finish-pending`，settled body 的
   `op-finish` 重试失败不再计入 `restored`。

## 证据

- `npm run check`：158 test files / 2523 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：14 个 spec / 356 tests；runtime 69、wiring 53、candidate-receipts 27、
  tavern-mvu 32、mvu-settle 30、write-journal 30、rollback 30。
- 关键覆盖：两阶段 settling/settled/cancelled、settling 后崩溃三分支、部分 hide 的
  `finish-hide` 幂等收口、settled 标记之后的 select 漂移、标记与 ledger 对账、commit 前移、
  hide 后 op-finish 失败保留新正文、finish-pending、live `turn/end` 有界重试与 unload 清理、
  completed 不触发、重复 turn 边去重、恢复失败保留 op-start、监听器内不同步 append。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 部分 hide 收口 | 已修：`op-settling` 记录 hide 目标，ledger 已提交时任意剩余 range 走 `finish-hide` 幂等补 hide；ledger 未提交时按 cancelled/ambiguous 收口。 |
| 双写失败 | `op-settling` / `op-settled` / `op-finish` 连续写失败时仍可能落入 legacy fallback；writer 连续故障下的残余风险。 |
| 标记选中漂移 | 已修：settlement evidence 带日志 `seq`，标记之后发生 select 时允许补 `op-finish`；标记之前未选中仍 `invalid-event` fail-closed。 |
| 取消部分 hide | `op-settle-cancelled` 且 anchor 已被部分隐藏时，仍走 `body-restore-*` assistant 副本兜底，这是旧会话兼容路径。 |
| live 时序 | 已修：`turn/end` 恢复按 0/50/250ms 有界重试，只对 `session-busy` / `host-unsupported` 重试；unload 清理 timer，最终失败仍交启动恢复。 |
| 真机 E2E | web profile 已跑通 bootstrap / 真实正文读取 / 写前 409；live-agent 完整写闭环仍需在 UI 打开会话后验证。 |

## 删除路径

- 停止写两阶段结算记录只影响后续结算；已写 settling/settled/cancelled 记录保留，恢复按证据处理喵。
- 不得删除已落盘的 settlement 记录或 `op-finish`；DSH 日志是 append-only喵。
- live `session/event` 监听随插件 unload 由 Cordis fiber 清理；没有 live-agent 注册表时
  不注册失败边，仍由启动恢复兜底。
