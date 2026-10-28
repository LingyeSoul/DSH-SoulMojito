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
   receipt；失败时按 receipt 的 after 值重放旧状态。
2. **记忆与变量工具**：`memory_write/update/forget` 与 `variable_set/patch/delete` 在业务
   写入前后写 `plugin:dsh-soulmojito/write` journal（`ignorable: true`）。新 turn 失败时
   按 `rollbackTurnWrites(agentId, turn)` 撤销新写入；旧 turn 的 plan 再恢复旧写入。
3. **事务顺序**：`prepare` → 隐藏旧 anchor → followup；成功 `commit`；失败先撤销新 turn
   写入、再 `restore(oldPlan)`、最后放回旧正文。start 在 prepare 后失败也要补偿 restore。
4. **工具面**：重生成允许记忆/变量/settle 写工具；`tavern_script_advance` 与游戏落子仍
   禁用，因为它们没有同级 checkpoint。
5. **门禁收窄**：`body-state-unsafe` 不再因“MVU 卡”一律拒绝；只在卡/聊天读不到、旧正文
   缺 receipt、旧 turn 缺 journal、宿主缺 plugin-record seam 时拒绝。P0 只放开 regenerate；
   MVU 的 edit/select 仍显式拒绝，等候选级状态切换。

## 证据

- `npm run check`：156 test files / 2365 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS（含 `source-file-budget`、`v4-session-admission`、`client-bundle`）。
- `agent-tavern-body-*` + journal：10 个 spec / 166 tests。
- 关键覆盖：memory create/update/forget、variable set/patch/delete、settle flat store、
  MVU body receipt undo/redo、新 turn 撤销、旧 plan 恢复、prepare 失败零写入、CAS 冲突、
  重复 prepare 幂等、MVU regenerate 放行与 edit/select 拒绝。
- 对话框：编辑正文 280px / 重生成 180px 固定高度、内部滚动、窄屏降高；12 条客户端断言。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 崩溃恢复 plan 未持久化 | `rollbackPlan` 只在进程内 pending op；重启后失败恢复能撤销新 turn，但没有旧 plan 可重放旧写入。后续把 plan 落 op-start/checkpoint。 |
| 向量恢复跳过 | 记忆回滚不重新嵌入向量，依赖检索侧 lazy re-embed；记录 `vector-restore-skipped` 诊断。 |
| 无跨 store 2PC | chat / VariableStore / MemoryStore 三套存储不是真正两阶段提交；已做预读与反向补偿，极端 I/O 中断会抛 `body-rollback-partial`。 |
| 脚本/游戏写入仍禁用 | 没有同级 checkpoint，不在本决策放开。 |
| edit/select 仍严格 | MVU 上的编辑与候选切换需要候选级状态切换，P0 不放开。 |
| commit 为 no-op | journal/receipt 保留审计；当前不影响回滚正确性。 |

## 删除路径

- 停止新 journal 写入只影响后续 turn；旧 journal/receipt 保留但 body 操作可拒绝。
- 回滚端口不引入新的独立数据文件；journal 是 `ignorable` plugin record，插件缺失时宿主
  安全跳过。已生成的 flat 变量/记忆恢复逻辑可随模块移除，历史聊天状态不回滚。
- 不把 `plugin:dsh-soulmojito/write` 记录写进纯对话导出。