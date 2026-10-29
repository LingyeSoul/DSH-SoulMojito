# 正文结算部分 hide 收口：targets 与 finish-hide

> 日期：2026-10-29。状态：已实现（工程验证通过；真机 kill/E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §9.2、
> `docs/proposals/0022-agent-tavern-write-rollback.md` §10、
> `packages/plugin/src/agent-tavern/body-runtime-settlement.ts`、
> `body-settlement-decision.ts`、`body-runtime-core.ts`。

## 问题

结算会分两次同步 append 替换不同 range：trigger/该 turn 的 process 节点，以及旧正文
anchor 与其旧 turn 的 process 节点。若进程死在两次 append 之间，旧 `settlingDecision`
只检查“旧 anchor 已隐藏 + 新候选可见且已选中”就判 settled，会留下合成 trigger / 旧
process 节点。

## 决策

1. **记录 hide 目标**：`op-settling` payload 增加可选
   `targets: { triggerMessageId, previousAnchorId }`。旧 marker 无 targets 时回退
   `triggerMessageIdOf(op)` / `op.previousAnchorId`；新 marker 的 targets 与 operation
   不一致时 `invalid-event` fail-closed。
2. **判定加严**：`settled` 要求所有 hide 目标都不在 surface 上；trigger 仍可见时绝不判
   settled。
3. **finish-hide**：旧 anchor 已隐藏、新候选可见且 ledger 已选中/提交，但仍有目标可见时，
   恢复只隐藏剩余 range（过滤已有 `body-hide` replacement，重复执行是 no-op），成功后写
   `op-settled` + `op-finish`。补 hide 失败保留 op-start，下次重试，不写 settled。
4. **不改正文语义**：finish-hide 不改 ledger/select、不追加 assistant、不重复 hide 已
   隐藏的 range。
5. **结构预算**：判定与结算辅助拆到 `body-settlement-decision.ts`，
   `body-runtime-settlement.ts` 772 行、`body-settlement-decision.ts` 257 行，均 ≤800。

## 证据

- `npm run check`：158 test files / 2498 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：runtime 64、wiring 49；runtime 新增 7 条覆盖 targets 记录、部分 hide 收口、
  两段全隐藏、bridge turn 补 hide、补 hide 失败、restore 的 finish-pending、旧 marker 兼容。
- 关键日志：`finish-hide` 分支记录补 hide 目标数；补 hide 失败抛 typed
  `BodyRuntimeFailure` 并保留 op-start。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 反向部分态 | trigger 已隐藏、旧 anchor 仍可见时仍按 `ambiguous` fail-closed；需要下次恢复或人工收尾。 |
| targets 漂移 | 新 marker 的 targets 与 operation 不一致会 `invalid-event`，没有自动修复路径。 |
| 多 range 顺序 | hide 按 surface 逆序 append；窗口只在两次同步 append 之间，真实 kill 未注入。 |
| 无真机 E2E | 构造日志模拟，没有进程 kill / 浏览器 E2E。 |

## 删除路径

- 停止写 `targets` 只影响后续 settling；已写 marker 保留，恢复仍按 targets 或 operation
  回退处理。
- 不得删除已落盘的 settling/settled/cancelled 记录；DSH 日志是 append-only。
- finish-hide 是恢复路径的一部分，删除它会让部分 hide 状态重新落入 `ambiguous`。
