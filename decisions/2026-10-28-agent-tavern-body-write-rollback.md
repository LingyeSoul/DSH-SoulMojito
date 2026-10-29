# AgentTavern 正文重生成的写入回滚落地

> 日期：2026-10-28。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0022-agent-tavern-write-rollback.md`、
> `packages/plugin/src/agent-tavern/body-rollback*.ts`、`write-journal.ts`、`body-runtime*.ts`。

## 问题

AgentTavern 重生成最后一组正文时，AgentLoop 会再次运行工具。旧 turn 已写入的 MVU 变量、
flat 变量与记忆不能简单叠加到新 turn；新 turn 失败或取消时也不能留下半套写入。此前的
`body-state-unsafe` 只能整卡拒绝 MVU 聊天，无法真正重生成。

## 决策

1. **MVU 变量**：正文投影写 `body:<messageId>` receipt（seed 后、patch 前抓基线）；settle
   receipt 走 flat `VariableStore`。重生成前按 receipt 回滚旧正文变量，新正文投影自己的
   receipt；失败时按 receipt 的 after 值重放旧状态。新 turn 失败时先撤销该 turn 的 settle
   receipt（按楼层归属匹配），再恢复旧 plan。
2. **记忆与变量工具**：`memory_write/update/forget` 与 `variable_set/patch/delete` 在业务
   写入前后写 `plugin:dsh-soulmojito/write` journal（`ignorable: true`）。新 turn 失败时
   按 `rollbackTurnWrites(agentId, turn)` 撤销新写入；旧 turn 的 plan 再恢复旧写入。
   记忆回滚/重放后通过 `memoryVectors` 端口同步删除或重建 `MemoryVectorStore` 向量。
3. **事务顺序**：`prepare` → 隐藏旧 anchor → followup；成功 `commit`；失败先撤销新 turn
   写入（journal + settle receipt）、再 `restore(oldPlan)`、最后放回旧正文。start 在 prepare
   后失败也要补偿 restore。`oldPlan` 随 `op-start.rollbackPlan` 落盘，重启后由
   `foldPendingOps` 严格校验并重建。
4. **工具面**：重生成允许记忆/变量/settle 写工具；`tavern_script_advance` 与游戏落子仍
   禁用，因为它们没有同级 checkpoint。
5. **门禁收窄**：`body-state-unsafe` 不再因“MVU 卡”一律拒绝；只在卡/聊天读不到、旧正文
   缺 receipt、旧 turn 缺 journal、宿主缺 plugin-record seam 时拒绝。P0 只放开 regenerate；
   MVU 的 edit/select 仍显式拒绝，等候选级状态切换。

## 证据

- `npm run check`：157 test files / 2385 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS（含 `source-file-budget`、`v4-session-admission`、`client-bundle`）。
- `agent-tavern-body-*` + journal：11 个 spec / 186 tests。
- 关键覆盖：memory create/update/forget、variable set/patch/delete、settle flat store、
  MVU body receipt undo/redo、新 turn journal + settle receipt 撤销、旧 plan 恢复、
  `op-start.rollbackPlan` 重启重建、记忆向量同步、真实 store 集成链路、prepare 失败零写入、
  CAS 冲突、重复 prepare 幂等、MVU regenerate 放行与 edit/select 拒绝。
- 对话框（2026-10-29 用户反馈）：编辑正文 / 重生成 textarea 填满 modal body 高度，
  内部滚动、最小 120px，窄屏同样自适应；12 条客户端断言。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| `prepare` 与 `op-start` 之间的崩溃窗口 | plan 已随 `op-start.rollbackPlan` 落盘，但若进程在 `prepare` 保存“回滚后的 chat”之后、`op-start` 写入之前崩溃，这份 plan 仍不可见；彻底闭合需 port 在 `prepare` 内做原子 checkpoint。 |
| plan 体积 | plan 含 `bodyText` 与 MVU receipts，会与正文事件重复放大 JSONL；当前未压缩或去重。 |
| 向量同步失败 | 注入 `memoryVectors` 后回滚/重放会同步删除或重建 `MemoryVectorStore`；失败记 `vector-sync-failed` 诊断，不阻断主回滚，检索侧仍依赖 lazy re-embed 兜底。同步每条记忆会等待一次 embedding 调用。 |
| settle receipt 楼层判定 | 新 turn 的 settle receipt 只有楼层键；`floor === messages.length` 是“settle 先于楼层落库”的信号，极端并发下可能把同楼层 receipt 视作当前 turn。 |
| 无跨 store 2PC | chat / VariableStore / MemoryStore / MemoryVectorStore 不是真正两阶段提交；已做预读与反向补偿，极端 I/O 中断会抛 `body-rollback-partial`。 |
| 脚本/游戏写入仍禁用 | 没有同级 checkpoint，不在本决策放开。 |
| edit/select 仍严格 | MVU 上的编辑与候选切换需要候选级状态切换，P0 不放开。 |
| commit 为 no-op | journal/receipt 保留审计；当前不影响回滚正确性。 |

## 删除路径

- 停止新 journal 写入只影响后续 turn；旧 journal/receipt 保留但 body 操作可拒绝。
- 回滚端口不引入新的独立数据文件；journal 是 `ignorable` plugin record，插件缺失时宿主
  安全跳过。已生成的 flat 变量/记忆恢复逻辑可随模块移除，历史聊天状态不回滚。
- 不把 `plugin:dsh-soulmojito/write` 记录写进纯对话导出。