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

1. **durable settled 标记**：新增独立 plugin record
   `plugin:dsh-soulmojito/body-settled`（payload `op-settled`），在 `commit` 与旧 anchor
   hide 之后、`op-finish` 之前写入。它只被 body runtime/recovery 读取，不进入消息投影、
   JSONL 或模型面。
2. **晚失败保留新正文**：`commit` 前移到 hide 之前；hide 成功并写 settled 标记后，
   `commit` / `op-finish` 失败不再回滚正文、不追加 assistant，只保留 op-start 并让恢复
   重试 `op-finish`。恢复读到 settled 标记时只补 `op-finish`，不重复 candidate/select/hide。
3. **legacy fallback 收窄**：没有 settled 标记的旧会话才允许 `body-restore-*` 兼容恢复；
   新会话失败且旧 anchor 可见时只隐藏失败 turn 节点。
4. **live turn/end 恢复**：`session/event` 监听 `turn/end` 的 `error` / `cancelled` /
   `aborted`；监听器只登记，`queueMicrotask` 异步调用 `restoreBodyAfterFailure`，同一
   session 去重。恢复失败只记结构化错误并保留 op-start，交给启动恢复。

## 证据

- `npm run check`：158 test files / 2433 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：12 个 spec / 234 tests；runtime 40、wiring 42。
- 关键覆盖：commit 前移、hide 后 op-finish 失败保留新正文并由恢复只补 op-finish、
  `op-settled` 折叠与重复标记、live `turn/end` error/cancelled/aborted、completed 不触发、
  重复 turn 边去重、恢复失败保留 op-start、监听器内不同步 append。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| hide→marker 崩溃窗口 | hide 已落盘、settled 标记尚未落盘时进程崩溃，重启仍会走 legacy fallback；窗口只有一次 plugin-record append。 |
| 双写失败 | settled 标记与 `op-finish` 同时失败时仍可能落入 legacy fallback；writer 连续故障下的残余风险。 |
| 标记可信度 | 格式正确但内容错误的 `op-settled` 会被当作权威证据；格式错误会 fail-closed 抛 `invalid-event`。 |
| 恢复指标 | settled op 若 `op-finish` 重试仍失败，会以“保留新正文”返回并计入 `restored`，`BodyRecoveryOutcome.status` 没有独立 finish-pending 值。 |
| live 时序 | 恢复要求微任务执行时 loop 已回到 idle；宿主延迟更久会记 `host-unsupported` 并留给启动恢复。 |
| 无真机 E2E | 尚未跑 `dsh web` 浏览器闭环，需要指定 profile 并允许写 `$DSH_HOME`。 |

## 删除路径

- 停止写 `op-settled` 只影响后续结算；已写标记保留，恢复仍只补 `op-finish`。
- 不得删除已落盘的 settled 标记或 `op-finish`；DSH 日志是 append-only。
- live `session/event` 监听随插件 unload 由 Cordis fiber 清理；没有 live-agent 注册表时
  不注册失败边，仍由启动恢复兜底。
