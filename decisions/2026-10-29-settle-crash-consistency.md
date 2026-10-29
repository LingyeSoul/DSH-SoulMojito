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
2. **先落决策再写 chat**：全部 flat 写（含 `$rules`）成功后、`saveChat` 之前追加
   `phase: decide`，携带完整 receipt（`at/turnKey/status/changes/failures/opId`）。
   `saveChat` 成功后写 `phase: commit`。decide 追加失败时绝不 saveChat，按 items 逆序把
   flat 还原到 before 并写 `phase: abort`；`saveChat` 失败同样先还原再 abort，还原失败则
   保留 decide 交给恢复按 commit 收口。
3. **启动恢复**：扫描未闭合 intent；
   - 有 `abort` → 只闭合，不还原、不写 receipt；
   - 有 `decide` 且 chat 已有同 `opId` receipt → 只补 commit；
   - 有 `decide` 但 chat 没有 receipt → 用 decide.receipt 重放到当前 chat 快照并
     `saveChat`（当前 revision CAS），成功补 commit；失败保留 intent，不回滚 flat；
   - 无 decide / 无 receipt → 按 `before` 逆序还原 flat（有 before 则 set，无 before 则
     delete），成功后写 `recovered`。恢复失败保留 intent，下次重试。
4. **exact-only 标记**：新 open intent 带 `receiptOpId: true`，恢复只认
   `receipt.opId === intent.opId`；仅旧 intent（无标记）才允许 `at + turnKey` 兼容。
5. **审计溯源**：审计记录带 `opId`；恢复重放或补 commit 时按 `opId` 幂等补一条
   `recovered: true` 的审计；superseded 的旧 decided intent 写 `supersededBy` 审计，
   不追加旧 receipt、不动 undo 顺序。审计失败只记结构化 warn，不影响已完成的 commit。
6. **与 write journal 隔离**：settle intent 使用独立 event type，`readWriteJournal` 忽略它；
   `rollbackTurnWrites` 不会把未闭合 settle intent 当普通 variable 写。
7. **不改 surface**：恢复只读 chat、只写 flat store、audit 与 plugin record，不追加
   assistant、不改 chat 变量树。

## 证据

- `npm run check`：158 test files / 2517 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：14 个 spec / 350 tests；mvu-settle 30、tavern-mvu 32、write-journal 30、
  body-rollback 30、runtime 67、wiring 49。
- 关键覆盖：decide 前崩溃还原 before、decide 后 saveChat 前重放、saveChat 成功只补 commit、
  重放遇冲突保留 intent 并二次成功、新 intent 拒收无 opId receipt、旧 intent 兼容、
  decide 写失败不 saveChat、abort 收口、恢复审计按 opId 去重、superseded 审计。
- `settle-intent-record.ts` 467 行、`body-settle-intent.ts` 362 行、
  `tools/deduction.ts` 609 行、`body-recovery.ts` 719 行、`projector.ts` 609 行，均 ≤800。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 无 appendPluginRecord | 宿主没有 seam 时 `openSettleIntent` 返回 undefined，settle 走旧路径，跨 store 窗口仍无 intent 保护。 |
| `$rules` 派生写 | 已由同 opId 的 `extend` intent 覆盖；extend 追加失败时零规则 flat 写。恢复仍逐项逆序，不是跨 store 原子事务。 |
| after 语义 | after 是请求 JSON 值，不是 guard clamp/step 后的最终值；恢复只消费 before，最终值以 receipt 为准。 |
| receipt 匹配 | 新 intent 带 `receiptOpId: true`，恢复只认 opId 精确匹配；旧 intent 才允许 `at + turnKey` 兼容。 |
| decide 重放冲突 | 重放时 `saveChat` CAS 失败会保留 intent 与 flat 值，下次启动重试；不会自动回滚。 |
| 审计去重 | 恢复审计按 `opId` 读后追加；单进程由 `MutationTail` 串行，跨进程并发恢复理论上仍可能双写。 |
| superseded 审计 | 旧 decided intent 关闭时写 `supersededBy` 审计，不追加旧 receipt、不动 undo 顺序；仍不复原旧批次的值。 |
| 工具审计失败 | 工具成功路径的审计追加失败仍让工具调用报错，沿用原有主审计行为；重试会生成新 settle。 |
| 无真机 E2E | 构造日志模拟，没有进程 kill / 浏览器 E2E。 |

## 删除路径

- 停止写 settle intent 只影响后续 settle；已写 open intent 仍会被启动恢复消费。
- 不得删除已落盘的 intent/decide/abort/commit/recovered 记录与 `mvu/audit.jsonl`；
  DSH 日志与审计文件都是 append-only。
- 没有 appendPluginRecord 的宿主继续旧路径，无需迁移历史会话。
