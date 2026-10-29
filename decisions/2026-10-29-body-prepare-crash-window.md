# 正文重生成 prepare → op-start 崩溃窗口

> 日期：2026-10-29。状态：已实现（工程验证通过；真机 kill/E2E 待补）。
> 相关：`docs/proposals/0022-agent-tavern-write-rollback.md` §5、§10、
> `packages/plugin/src/agent-tavern/body-rollback.ts`、
> `body-rollback-prepare.ts`、`body-runtime.ts`、`body-recovery.ts`。

## 问题

旧 `prepare` 一次性完成“读 plan + 执行 journal/receipt 回滚 + saveChat”。runtime 直到
`prepare` 返回后才写 `op-start.rollbackPlan`。如果进程在 `prepare` 已回滚旧写入、但
`op-start` 尚未落盘时崩溃，会话里没有任何 durable plan，恢复无法把旧 turn 的
memory/variable/chat 变量放回，状态分裂。

## 决策

1. **拆分 plan / apply**：`BodyWriteRollbackPort` 新增只读 `plan(agentId, turn,
   previousMessageId)` 与 mutating `apply(plan)`；`prepare = plan + apply` 保持旧调用兼容。
   `plan` 只读 binding/card/chat/floor/journal/receipts、做 coverage 校验，不写 store。
2. **先落计划再动账**：runtime 生成 opId 后先 `plan`，把 draft plan 写入独立 plugin record
   `plugin:dsh-soulmojito/body-prepare`（`op-prepare`，JSON-safe 校验），再 `apply`，
   最后写 `op-start.rollbackPlan`。
3. **start 失败补偿**：`op-prepare` 之后任何 start 失败先 `restore(plan)`（apply 已跑用
   final plan，未跑用 draft，replay 幂等）；若 op-start 未写且 restore 成功，追加
   `op-prepare-recovered` 消费标记。restore 失败保留记录，交给启动恢复。
4. **启动恢复**：`foldPendingPrepares` 折叠 `op-prepare`；有对应 op-start/op-finish 或已
   recovered 的忽略；未消费的 prepare 调 `restore(plan)`，成功后写
   `op-prepare-recovered(reason=prepare-interrupted)`。不追加 assistant、不动 surface。
5. **兼容**：端口没有 `plan/apply` 时仍走旧 `prepare`，不写 `op-prepare`；旧 op-start、
   两阶段结算、turn/end 恢复与 receipt 保留策略不变。

## 证据

- `npm run check`：158 test files / 2460 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：13 个 spec / 286 tests；runtime 57、rollback 30。
- 关键覆盖：plan 成功但 apply 前崩溃、apply 成功但 op-start 前崩溃、op-start 正常消费
  prepare、旧端口无 plan/apply、畸形 op-prepare → `invalid-event`、apply 拒绝过期 revision、
  restore 失败保留记录重试。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| plan 体积翻倍 | draft 在 `op-prepare`、applied plan 在 `op-start` 各存一份，单次重生成日志字节上升。 |
| 跨 store 无 2PC | apply 的 settle receipt flat 写入先于 saveChat，若死在两者之间，chat 仍标记未 undone，`restore` 不会重做 flat 值；本次只收窄 journal/chat 窗口。 |
| 外部保存冲突 | plan 与 apply 之间任何 chat revision 变更现在会在改 store 前 fail-closed，比以前更严，属预期行为差异。 |
| 多 op 顺序 | 未消费 prepare 与新 pending op 同时存在（仅上次恢复失败后重新发起）时，恢复先 prepare 后 op，跨 op 顺序没有 2PC 证明。 |
| 无真机崩溃注入 | 目前是构造日志模拟，没有进程 kill / 浏览器 E2E。 |

## 删除路径

- 停止写 `op-prepare` 只影响后续 start；已写记录保留，恢复仍按 plan 处理。
- 不得删除已落盘的 `op-prepare` / `op-prepare-recovered`；DSH 日志是 append-only。
- 旧端口没有 plan/apply 时继续走 `prepare`，无需迁移历史会话。
