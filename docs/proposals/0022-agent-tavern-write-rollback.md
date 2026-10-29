# 提案 0022：AgentTavern 正文重生成的写入回滚

> 状态：已实现（工程验证通过；真机浏览器 E2E 待补）。日期：2026-10-28。
> 依赖：提案 0021（body ledger / 投影 / 重生成）。
> 本提案只补“重生成期间的写入回滚”，不改变 0021 的候选、编辑与投影契约。
> 落地决策：[`decisions/2026-10-28-agent-tavern-body-write-rollback.md`](../../decisions/2026-10-28-agent-tavern-body-write-rollback.md)。

## 1. 目标

重生成最后一组正文时，AgentLoop 会再次运行工具。旧 turn 已经写过的变量与记忆不能简单叠加到新
turn 上；新 turn 失败或取消时，也不能留下半套写入。目标：

1. **MVU 变量回滚**：旧正文的 `<UpdateVariable>` 与 `tavern_variable_settle` 先回到旧正文之前的
   状态，再让新正文投影自己的补丁。
2. **记忆写入回滚**：`memory_write` / `memory_update` / `memory_forget` 在写入前登记 undo
   记录；旧 turn 的写入可撤销，新 turn 失败/取消时新写入可撤销。
3. **重生成运行工具**：重生成 turn 允许记忆与变量写工具运行，不再用一刀切 deny 把它们挡掉；
   脚本推进与游戏落子仍保持禁用（没有本提案级的回滚）。
4. **失败恢复**：新 turn 成功则保留新状态；失败/取消则撤销新写入并恢复旧 turn 的写入与旧正文。

## 2. 唯一事实来源与事务边界

| 事实 | 来源 |
|---|---|
| 旧/新 turn 的正文与工具调用 | DSH Session 日志 |
| 写入 undo 记录 | `plugin:dsh-soulmojito/write` plugin record（`ignorable: true`） |
| MVU 前后值 | chat 的 `chat_metadata.mvu.receipts` |
| 记忆当前状态 | `MemoryStore` |
| 变量当前状态 | JSONL `chat_metadata.variables` + `VariableStore` |

`plugin:dsh-soulmojito/write` 记录不可进入模型面；记录名与写入方式沿用决策
`2026-10-28-agent-tavern-body-plugin-records.md` 的 `appendPluginRecord` 门控。

## 3. 写入 journal

事件类型：`plugin:dsh-soulmojito/write`，payload：

```ts
type WriteJournalEntry =
  | {
      kind: 'memory'
      tool: 'memory_write' | 'memory_update' | 'memory_forget'
      journalId: string
      sessionId: string
      turn: number
      phase: 'before' | 'after'
      at: string
      target: { id: string; scope: MemoryScope; scopeId: string }
      before?: MemoryRecord | null
      after?: MemoryRecord | null
    }
  | {
      kind: 'variable'
      tool: 'variable_set' | 'variable_patch' | 'variable_delete'
      journalId: string
      sessionId: string
      turn: number
      phase: 'before' | 'after'
      at: string
      target: { scope: VariableScope; scopeId: string }
      before?: readonly VariableSnapshot[] | null
      after?: readonly VariableSnapshot[] | null
    }
```

规则：

- 工具在**变更前**追加 `phase: 'before'`；变更成功后追加同 `journalId` 的 `phase: 'after'`。
- `before` 记录足够恢复旧值；`after` 记录足够重放旧 turn 的写入（失败恢复用）。
- 追加失败时，工具在**任何业务写入之前**抛错，保持 fail-closed。
- 宿主没有 `appendPluginRecord` 时 journal 不可用；此时 body 操作整体 `host-unsupported`，
  普通记忆/变量工具仍可用（不记录 journal）。

## 4. MVU 回执

- projector 在应用正文的 `<UpdateVariable>` 前抓取变量基线，应用后追加 receipt：
  `turnKey = 'body:' + messageId`。
- `tavern_variable_settle` 继续使用现有 receipt（`turnKey = String(chat.messages.length)`，即楼层下标）。
- 重生成旧正文时，按以下顺序回滚：
  1. 找到旧正文事件、旧 turn、旧楼层下标；
  2. 收集 `body:<messageId>` receipt 与该楼层下标对应的 settle receipt；
  3. 逆序 `planMvuUndoRestores` + `applyMvuUndoRestores`，标记 receipt `undoneAt`；
  4. 保存 chat（revision CAS）。
- 新正文投影时照常生成自己的 receipt；旧 receipt 保持 undone。
- 失败恢复时把旧 receipt 的 `undoneAt` 清除，并重新应用旧 receipt 的 `after` 值。

## 5. 回滚端口

`body-runtime` 增加可选端口：

```ts
interface BodyWriteRollbackPort {
  prepare(agentId: string, turn: number, previousMessageId: string): Promise<BodyRollbackPlan>
  restore(plan: BodyRollbackPlan): Promise<void>
  commit(plan: BodyRollbackPlan): Promise<void>
}
```

- `prepare`：校验旧 turn 的所有写入都有 journal / receipt；快照回滚前状态；执行回滚；返回恢复计划。
  缺数据时抛 `body-state-unsafe`，detail 为 `mvu-receipt-missing` / `write-journal-missing` /
  `write-journal-unavailable`。
- `restore`：按计划恢复回滚前状态（旧 turn 的写入与旧 variables/receipts）。
- `commit`：成功后清理计划（当前实现可为 no-op；journal 记录保留作审计）。

`body-runtime` 在 `startRegenerate` 隐藏旧 anchor **之前**调用 `prepare`；在 `finalizeTurnStopping`
成功后调用 `commit`；在 `restoreBodyAfterFailure` 中先调用 `restore`，再放回旧正文。

## 6. 工具面

重生成期间允许：

- `memory_write` / `memory_update` / `memory_forget`（journal）
- `variable_set` / `variable_patch` / `variable_delete`（journal）
- `tavern_variable_settle`（receipt）

仍禁用：

- `tavern_script_advance`（剧本游标没有本提案级快照）
- `game_start` / `game_move`（游戏状态没有本提案级快照）

如果未来要给这些工具开放重生成，必须先补同级的 journal 或 checkpoint。

## 7. `body-state-unsafe` 的新语义

`body-state-unsafe` 不再因为“卡/聊天是 MVU”而整体拒绝。它只在以下情况拒绝：

| detail | 条件 |
|---|---|
| `card-unreadable` | 角色卡读不到，无法判断 |
| `chat-unreadable` | 聊天快照读不到 |
| `mvu-receipt-missing` | 旧正文含 `<UpdateVariable>`，但没有对应 receipt |
| `write-journal-missing` | 旧 turn 有记忆/变量写工具调用，但没有完整 journal |
| `write-journal-unavailable` | 宿主缺少 `appendPluginRecord`，无法安全回滚 |

`GET body` 不再因为 MVU 卡一律 `can*: false`；它按 `writeRollback` 可用性返回
`canEdit/canRegenerate/canSelect`。P0 只保证 **regenerate** 的写回滚；`edit`/`select` 在 MVU
聊天上继续返回 `body-state-unsafe`，直到候选级状态切换实现。

## 8. 记忆恢复实现

- `memory_write`：工具先生成 id，journal before（无 before），`put({id,...})`，journal after（记录）。
  回滚 = `forget(id, scope, scopeId, currentRevision)`。
- `memory_update`：journal before（旧记录），`put`，journal after（新记录）。
  回滚 = `put(旧记录字段, currentRevision)`。
- `memory_forget`：journal before（旧记录），`forget`，journal after（软删记录）。
  回滚 = `put(旧记录字段, currentRevision)` 复活；重放 = `forget`。
- 恢复后重嵌向量：恢复/删除后分别调用 `embedWrittenMemory` / 向量删除；失败只记诊断，不阻断
  回滚主流程。

## 9. 变量恢复实现

- `variable_set` / `variable_patch` / `variable_delete`：journal before/after 存
  `VariableSnapshot`；回滚/重放用 `VariableStore.set/delete`，expectedRevision 取当前 revision。
- `tavern_variable_settle`：不重复 journal，直接使用 receipt；回滚/重放走 MVU receipt。
- JSONL `chat_metadata.variables` 与 `chat_metadata.mvu.receipts` 由 `body-rollback` 读写，
  与 flat `VariableStore` 分开处理，避免两套状态漂移。

## 10. 失败与取消

1. `prepare` 拆成只读 `plan` 与 mutating `apply`；runtime 先 `plan`，把 draft 写入 durable
   `op-prepare`（独立 plugin record），再 `apply`，最后写 `op-start.rollbackPlan`。
   旧端口没有 `plan/apply` 时仍走 `prepare` 兼容路径。`prepare` 成功后才触发新 turn；
   旧 anchor 在新 turn 期间保持可见（0021 §6.2）。
2. 新 turn 成功：先 `commit`，写 `op-settling`，再 hide 旧 anchor，写 `op-settled`，最后
   `op-finish`。hide 之后 `op-finish` 晚失败时保留新正文，只把 `op-finish` 留给恢复重试，
   不再回滚正文或追加 assistant 副本。
3. 新 turn 失败/取消：
   - live `session/event` 的 `turn/end`（`error` / `cancelled` / `aborted`）异步触发恢复，
     监听器只登记、不在事件栈 append喵；
   - 先 `rollbackTurnWrites(newTurn)` 撤销新 turn 自己的 memory/variable journal 与 settle receipt；
   - `op-settled` 且对账通过：body 已结算，只补 `op-finish`；
   - `op-settling`：按 surface/ledger 三分支判定（补 settled、取消恢复、fail-closed）；
   - `op-settle-cancelled` 或无结算证据：`restore(plan)` 恢复旧 turn 的写入与
     variables/receipts，再由 `restoreBodyAfterFailure` 放回/保留旧正文；
   - 若恢复失败，保留 op-start 待启动恢复，不假装成功。
4. 崩溃恢复：`op-start` 无 `op-finish` 时，`rollbackPlan` 直接随 `op-start.rollbackPlan`
   落盘；重启后 `foldPendingOps` 严格校验并重建。有 `op-settled` 时只补 `op-finish`；
   有 `op-settling` 时按 surface/ledger 判定；无证据才按计划恢复。
   若存在未消费的 `op-prepare`（apply 可能已回滚但 op-start 未落盘），启动先按 draft plan
   `restore` 并写 `op-prepare-recovered`，不追加 assistant、不改 surface。

## 11. 开工前检查表

1. **所有者**：`agent-tavern/write-journal.ts`（记录）、`body-rollback.ts`（回滚端口实现）、
   `body-runtime.ts`（调用时序）、`mvu.ts`/projector（receipt）、memory/variable 工具（journal 写入）。
2. **唯一事实来源**：Session 日志的 write record + MVU receipt；MemoryStore / VariableStore 是当前值。
3. **持久态及理由**：journal 与 receipt 必须落盘，保证失败/重启后可回滚；候选状态仍由 0021 ledger 管。
4. **临时态**：pending op 只在进程内；回滚计划随 `op-start.rollbackPlan` 落盘，重启由
   `foldPendingOps` 重建。
5. **外部依赖**：`appendPluginRecord`（0.2.1+）、现有 `MemoryStore` / `VariableStore` / MVU receipt。
6. **注册入口**：工具写入 journal；body-wiring 组装 rollback port；body-runtime 调用 prepare/restore/commit。
7. **删除路径**：停止写 journal 只影响新 turn；旧 journal 保留但 body 操作可拒绝；不删除历史记录。
8. **兼容对象**：非 MVU、无写工具的聊天行为不变；ST 架构不变；旧宿主缺 API 时 body 操作 `host-unsupported`。

## 12. 测试

1. journal 工具：memory create/update/forget 的 before/after、变量 set/patch/delete 的 before/after、
   journal 写入失败时业务写入不发生。
2. MVU：projector 写 `body:<messageId>` receipt；settle receipt 与正文 receipt 都能按旧楼层回滚。
3. regenerate 成功：旧变量/记忆写入被撤销，新 turn 写入保留，新正文 anchor 正确。
4. regenerate 失败/取消：旧变量/记忆写入恢复，旧正文恢复，trigger 被清理。
5. `body-state-unsafe`：缺 journal / 缺 receipt / 缺 API 的 detail 正确；MVU 卡有完整数据时放行。
6. 向量：记忆回滚后向量恢复/删除；失败只记诊断。
7. 既有 0021 的 body spec、MVU 测试、类型检查、全量 gate 全部保持通过。

## 13. 实现验证（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm run check` | 157 test files / 2385 passed + 1 skipped；`build:plugin` 成功；18/18 gate PASS（含 `source-file-budget`、`v4-session-admission`、`client-bundle`） |
| body + journal 聚焦 | 11 个 spec / 186 tests |
| 写入 journal | `agent-tavern-write-journal.spec.ts` 17 tests |
| 回滚端口 | `agent-tavern-body-rollback.spec.ts` 27 tests（含 settle receipt、向量同步、新 turn 撤销） |
| 回滚集成 | `agent-tavern-body-rollback-integration.spec.ts` 2 tests（真实 store + 真实工具 journal） |
| MVU 正文回执 | `agent-tavern-body-mvu-rollback.spec.ts` 7 tests |
| runtime 时序 / 恢复 | `agent-tavern-body-runtime.spec.ts` 33 tests（含 durable plan 与重启恢复） |
| wiring / gate | `agent-tavern-body-wiring.spec.ts` 28 tests |

实现分片（每文件 ≤800 行）：`body-rollback.ts`（门面/编排）、`body-rollback-support.ts`、
`body-rollback-writes.ts`（journal undo/redo + 向量同步）、`body-rollback-journal.ts`（事件折叠、
`rollbackTurnWrites` 与 settle receipt 撤销）、`body-rollback-receipts.ts`（body / settle 回执分流）、
`body-runtime-plan.ts`（`rollbackPlan` 的写侧 JSON 校验与读侧严格解析）。

残余风险见 §10 与落地决策的“风险与未完成”表（prepare→op-start 崩溃窗口、plan 体积、
settle 楼层判定、无跨 store 2PC、edit/select 仍严格）。
