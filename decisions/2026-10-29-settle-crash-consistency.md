# settle 跨 store 崩溃一致性：durable settle intent

> 日期：2026-10-29。状态：已实现（工程验证通过；真机 kill/E2E 待补）。
> 相关：`docs/proposals/0022-agent-tavern-write-rollback.md` §8、§9、§10、
> `packages/plugin/src/agent-tavern/write-journal.ts`、
> `body-settle-intent.ts`、`tools/deduction.ts`、`body-recovery.ts`。

## 问题

`tavern_variable_settle` 先逐条写 chat 作用域 flat `VariableStore`，全部写完后才写
`chat_metadata.mvu.receipts` 并 `saveChat`。若进程在 flat 写入与 chat 保存之间崩溃，flat
值已变、chat 没有 receipt；`prepare` 可能拒绝或留下分裂状态。

## 决策

1. **先落 intent 再写 flat**：新增独立 plugin record
   `plugin:dsh-soulmojito/settle-intent`，第一次 flat 写之前写 `phase: open`，包含
   `opId/sessionId/character/scopeId/turnKey/receiptAt` 与每项 `{name,before?,after?}`。
   `$rules` 派生写在任何 flat 写之前追加同 opId 的 `phase: extend`，覆盖规则目标项。
   追加失败时一个 flat 写都不发生，fail-closed。
2. **正常完成 commit**：flat 写 + receipt + `saveChat` 成功后写 `phase: commit`；commit
   追加失败显式抛出，不静默吞。settle receipt 写入本次 `opId`，恢复优先按
   `receipt.opId === intent.opId` 精确匹配；旧 receipt 无 opId 才回退 `at + turnKey`。
   commit 同时闭合同一 chat 仍 open 的旧 intent，避免失败重试后被旧意图过度回滚。
3. **启动恢复**：扫描未闭合 intent；若 chat 中已有同 `turnKey` 且 `at >= receiptAt` 的
   未撤销 receipt，说明 saveChat 已落盘，只补 commit，不动 flat；否则按 `before` 逆序还原
   flat（有 before 则 set，无 before 则 delete，使用当前 revision CAS），成功后写
   `recovered`。恢复失败保留 intent，下次重试。
4. **与 write journal 隔离**：settle intent 使用独立 event type，`readWriteJournal` 忽略它；
   `rollbackTurnWrites` 不会把未闭合 settle intent 当普通 variable 写。
5. **不改 surface**：恢复只读 chat、只写 flat store 与 plugin record，不追加 assistant、
   不改 chat 变量树。

## 证据

- `npm run check`：158 test files / 2491 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：14 个 spec / 324 tests；mvu-settle 20、tavern-mvu 32、write-journal 24、
  body-rollback 30。
- 关键覆盖：flat 写后 saveChat 前崩溃还原 before、intent 写入失败零 flat 写、正常 settle
  不重复撤销、commit 失败按 receipt 闭合、失败重试旧 intent superseded、旧 receipt 覆盖、
  空 intent 幂等。
- `body-rollback-journal.ts` 736 行 + `body-settle-intent.ts` 149 行，均 ≤800；
  `write-journal.ts` 拆分后 543 行，settle intent 词表在 `settle-intent-record.ts`（313 行）。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 无 appendPluginRecord | 宿主没有 seam 时 `openSettleIntent` 返回 undefined，settle 走旧路径，跨 store 窗口仍无 intent 保护。 |
| `$rules` 派生写 | 已由同 opId 的 `extend` intent 覆盖；extend 追加失败时零规则 flat 写。恢复仍逐项逆序，不是跨 store 原子事务。 |
| after 语义 | after 是请求 JSON 值，不是 guard clamp/step 后的最终值；恢复只消费 before，最终值以 receipt 为准。 |
| receipt 匹配 | 新 settle receipt 带 `opId`，恢复精确匹配；旧 receipt 无 opId 仍按 `at + turnKey` 兼容，理论上同毫秒同楼层可能误匹配，随环形淘汰自然消失。 |
| commit 窗口 | commit 在 saveChat 之后，仍存在 saveChat 成功但进程在 commit 前死亡的窗口，由 receipt 匹配兜底。 |
| 无真机 E2E | 构造日志模拟，没有进程 kill / 浏览器 E2E。 |

## 删除路径

- 停止写 settle intent 只影响后续 settle；已写 open intent 仍会被启动恢复消费。
- 不得删除已落盘的 intent/commit/recovered 记录；DSH 日志是 append-only。
- 没有 appendPluginRecord 的宿主继续旧路径，无需迁移历史会话。
