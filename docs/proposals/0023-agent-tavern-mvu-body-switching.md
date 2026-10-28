# 提案 0023：AgentTavern MVU 正文编辑与候选切换（候选级 receipt）

> 状态：设计。日期：2026-10-28。
> 依赖：提案 0021（body ledger / 投影 / 编辑 / 候选）与 0022（MVU receipt / write journal / rollback）。
> 本提案只设计 `PUT body` 与 `POST body/select` 在 MVU / 变量历史上的候选级状态切换。
> 它不改变 0021 的候选事件词汇、不改变 0022 的 turn 级回滚契约，也不改变 ST 架构。
> 落地前现有行为保持不变：MVU 聊天上的 edit / select 仍返回 `409 body-state-unsafe`。

## 1. 结论先行

1. 每个正文候选拥有独立的 MVU receipt，稳定 key 为
   `body:<messageId>#<candidateIndex>`；旧格式 `body:<messageId>` 只读兼容，首次候选操作时惰性迁移。
2. **编辑** = 撤销当前候选的旧 receipt → 在候选基线上应用新文本的 `<UpdateVariable>` → upsert 新 receipt
   → 更新 `swipes[index]` / `mes` / 楼层 `stat_data`。
3. **切换** = 撤销 A 的 live receipt → 复用或 redo B 的 receipt → 更新 `swipe_id` / `mes`；
   切换**不重新解析 B 的文本**，receipt 是唯一可重放事实。
4. 两条路径都是 JSONL 投影事务：不产生新 turn、不调用模型、不写 write journal，
   因此**不复用** 0022 的 `prepare/restore/commit` 与 `rollbackTurnWrites`；只复用
   `undoMvuReceipts` / `redoMvuReceipts`、同一份 `saveChat` CAS 与 0021 的投影单写者。
5. 候选切换必须先有“候选感知的 regenerate”（P1）：否则切到 B 后重生成会按 anchor A 找 receipt，
   漏掉 B 的 live receipt，把 B 的补丁再叠一次。P0 只放编辑，P1 同时放切换与该修复。

## 2. 问题与现状

### 2.1 现在的拒绝链

| 位置 | 现状 |
|---|---|
| `body-view.ts` `bodyMutationSafetyOf`（109–119 行） | 只要 `bodyHistoricalMvuStateOf` 为真，`edit` / `select` 分别返回 `edit-rollback-unavailable` / `select-rollback-unavailable` |
| `body-view.ts` `buildBodyView`（223–234 行） | `canEdit` 直接用 `!historicalMvuState` 排除；`canSelect = canEdit && count > 1` |
| `http/router.ts` `handleAgentTavernBodyApi`（1546–1565 行） | 在解析 live agent、进入 runtime 锁之前就以 409 拒绝，因此不会写任何 body 事件 |
| `body-runtime.ts` `applyBodyEdit` / `selectBodyCandidate`（247–307 行） | 只追加 `edit` / `select` 事件；不处理 MVU receipt |
| `body-projector.ts` `projectBodyEvent`（94–188 行） | `edit` 只更新 `swipes` / `mes`；`select` 只更新 `swipe_id` / `mes`；没有 receipt 交换 |
| `mvu.ts` `mvuReceiptsForBody`（902–919 行） | 只按 `body:<messageId>` 与楼层下标收集，没有候选下标维度 |

`bodyHistoricalMvuStateOf` 的触发面很宽：卡声明 JSR MVU、`chat_metadata.variables.stat_data` 存在、
或 `chat_metadata.mvu.receipts` 存在。0022 只给 **regenerate** 做了 turn 级回滚，所以 edit / select 仍被整体拒绝。

### 2.2 为什么 edit 不能只投影文本

旧正文的 `<UpdateVariable>` 已经应用到 `chat_metadata.variables`。编辑后的文本通常仍带一个
`<UpdateVariable>`，如果直接在旧变量树上再应用一次：

- 相同的 `replace` 还可以“碰巧正确”，但 `add` / `increment` / `remove` 会重复累加或误删；
- 旧文本里存在、新文本里删掉的路径不会被撤销；
- 楼层的 `variables.stat_data` 仍是旧值，前端 `getChatMessages().data` 与 `chat_metadata.variables` 分叉；
- 下次 regenerate 的 `prepare` 仍按旧 receipt 回滚，变量基数从此错位。

### 2.3 为什么 select 不能只改 `swipe_id`

切换只改变“哪条候选进入模型面”，变量树必须同步到 B 的补丁结果：

- A 的 receipt 是 live，B 的 receipt 是 undone（正常切换链）→ 必须先撤销 A，再 redo B；
- B 的 receipt 是 live → 说明变量已经在 B 上，只需撤销 A（若 A 也 live 则状态已损坏）；
- B 没有 receipt 但文本带 `<UpdateVariable>` → 不能猜、不能现场重放文本，必须拒绝；
- B 没有 receipt 且文本不带块 → 变量应回到候选基线，只需撤销 A。

### 2.4 为什么 0022 的 receipt 方案不能直接套到候选切换

| 维度 | 0022 regenerate | 0023 edit / select |
|---|---|---|
| 事务单位 | 旧 turn + 新 turn | 单个候选的 MVU patch |
| `prepare` 的内容 | 撤销旧 turn 的 memory / variable journal、settle receipt、body receipt | 只能撤销候选 receipt；**不能**撤销记忆、flat 变量、settle receipt |
| 新 turn | 有；工具会写 memory / variables | 无；不产生工具写入 |
| 失败恢复 | `restore(plan)` + restore turn 复制旧 assistant | 不允许新 turn；只在 JSONL 内交换状态 |
| receipt key | `body:<messageId>`（以 anchor 为单位） | `body:<messageId>#<index>`（以候选为单位） |
| anchor 与选中的关系 | P0 下 anchor == selected | select 后 anchor 仍是 A，selected 是 B |

关键差异是 **事务单位**：0022 的 `prepare` 是“旧 turn 的全部写入 vs 新 turn 的全部写入”；
候选切换是“同一个 turn 内、同一条正文的变量补丁 A vs 补丁 B”。把 0022 的 plan 直接拿来用，
会把用户在同一 turn 里写下的记忆和 flat 变量一起撤销，这是错误的副作用。

### 2.5 一个会双写的反例

```text
candidate 0 = A。R0 = body:<messageA> 为 live。
select B：R0 标记 undone，RB = body:<messageB> 为 live，变量 = B。
regenerate：
  0022 prepare 以 anchor A 调 mvuReceiptsForBody({ messageId: A })
  -> 只收集到 R0（已经 undone，undo 是 no-op）
  -> RB 仍 live，变量仍是 B
  新候选 C 的 <UpdateVariable> 在 B 上再应用一次
  -> C 的增量在 B 的结果上叠加，而不是在候选基线上叠加
```

所以 **select 与候选感知的 regenerate 必须同批落地**，不能用“先放 select、以后再修”的方式拆开。

## 3. 候选级 receipt 设计

### 3.1 稳定 key

```ts
/** Stable identity of one body candidate (proposal 0021 §3.1). */
export interface BodyCandidateRef {
  readonly groupId: string
  readonly index: number
  readonly messageId: string
}

/** Candidate-level MVU receipt key. */
export function bodyCandidateTurnKey(ref: Pick<BodyCandidateRef, 'messageId' | 'index'>): string {
  return `body:${ref.messageId}#${ref.index}`
}
```

- `messageId` 是原生 `assistant/message` 的 id，候选一旦生成就不变；它是**身份**。
- `index` 是 body ledger 的槽位，候选只追加、不复用；它是**槽位见证**，不是身份。
- 不把 `groupId` 放进 key：`groupId` 就是该楼层第一条 assistant message 的 id，而 `messageId`
  已经全局唯一；把 group 放进 key 会让 key 更长且需要额外解析。若未来需要按组清理，
  用 ledger 的 `messageId -> groupId` 映射即可。
- 解析规则必须严格：`body:<messageId>#<digits>` 是候选 key；`body:<messageId>` 是旧格式；
  纯数字是 settle receipt；其它一律视为不可分类并拒绝。
- 若同一 `messageId` 在 ledger 出现在两个下标，key 不再唯一，直接拒绝
  `body-receipt-key-mismatch`，不做“取第一个”的静默选择。

### 3.2 不变量

1. **单 live 效应**：同一 body group 内，最多一条候选 receipt 满足
   `undoneAt === undefined && changes.length > 0`。`status: 'unchanged'` 的 receipt 可以共存，
   因为它不改变变量。
2. **同基线**：同一 group 的所有候选 receipt 都以同一个候选基线（首次投影时 seed 后的变量树）为 `before`。
   这是 regenerate 每次 `prepare` 先撤销当前候选 receipt、再让新候选投影的自然结果。
3. **有块必有 receipt**：候选的有效文本（ledger 的 `edits.get(index) ?? candidate.text`）包含
   `<UpdateVariable>`，且卡声明 JSR MVU，则该候选必须存在 receipt（live 或 undone）。
   没有 receipt 就不能编辑 / 切换，因为没有可撤销的基线。
4. **无块不留 receipt**：编辑后的文本不再包含 `<UpdateVariable>` 时，撤销旧 receipt 后必须删除该候选的
   receipt；否则未来 select 会把一条已经不存在的补丁 redo 回来。
5. **候选 receipt 与 settle receipt 正交**：候选 receipt 只拥有 `chat_metadata.variables` 的正文补丁；
   `tavern_variable_settle` 的楼层 receipt 拥有 flat `VariableStore`，切换时绝不触碰。
6. **一条候选一条最新 receipt**：编辑用 upsert（同 key 替换），不累积历史；编辑审计由 body `edit` 事件的
   `previousText` 承担，`mvu.receipts` 不保留被替换的旧 diff。
7. **未 undone 优先**：选择候选 receipt 时，优先取 `undoneAt === undefined` 的条目（若多条，取 `at` 最新）；
   没有则取 `at` 最新的 undone。只有多条 `undoneAt === undefined && changes.length > 0` 才是
   `body-receipt-duplicate`。不能只按 `at` 取最新，否则“旧 live + 新 undone”会漏撤。

### 3.3 数据结构与读写 API

`MvuReceipt` 结构不变，仍放在 `chat_metadata.mvu.receipts`：

```ts
interface MvuReceipt {
  at: string
  turnKey: string          // body:<messageId>#<index> | body:<messageId> | <floorIndex>
  status: 'updated' | 'unchanged' | 'failed'
  changes: MvuVariableChange[]
  failures: string[]
  undoneAt?: string
}
```

`mvu.ts` 已经超过 800 行；候选 receipt 的 key、inspection、迁移与 upsert 放在新的
`body-candidate-receipts.ts`（纯函数），`mvu.ts` 只做两件事：扩展 `mvuReceiptsForBody` 的前缀匹配，
以及继续提供 `readMvuReceipts` / `undoMvuReceipts` / `redoMvuReceipts`。新增 API：

```ts
/** All receipts for one candidate, in stored order (newest last).
 *  Matches both body:<messageId> and body:<messageId>#<index>; the index is a
 *  witness for the new format, while a legacy key is accepted as the same candidate. */
export function mvuReceiptsForCandidate(
  chat: ChatLogIR,
  ref: Pick<BodyCandidateRef, 'messageId' | 'index'>,
): MvuReceipt[]

/**
 * Write one candidate receipt, replacing any existing entry with the same key.
 * Unlike recordMvuTurnReceipt, this writes even when the diff is empty, because
 * the receipt is the proof that a <UpdateVariable> block was applied.
 */
export function upsertCandidateMvuReceipt(
  chat: ChatLogIR,
  before: Record<string, unknown>,
  input: {
    readonly messageId: string
    readonly index: number
    readonly at: string
    readonly failures: readonly string[]
  },
): MvuReceipt

/** Remove a candidate receipt after an edit that no longer contains a patch. */
export function removeCandidateMvuReceipt(
  chat: ChatLogIR,
  ref: Pick<BodyCandidateRef, 'messageId' | 'index'>,
): void

/** Rewrite legacy body:<messageId> keys to body:<messageId>#<index>. */
export function migrateLegacyCandidateKeys(
  chat: ChatLogIR,
  indexByMessageId: ReadonlyMap<string, number>,
): number
```

实现约束：

- `upsertCandidateMvuReceipt` 的 `at` 由投影事件的 `event.time` 派生，不能用
  `new Date()`；CAS 重试与重启重放必须得到同一个 `at`，否则 `locateStoredReceipts` 的
  `turnKey + at` 匹配会失败。
- `upsert` 先删除同 key 的旧条目，再追加；环形保留（`MVU_RECEIPTS_LIMIT`）仍需保证新条目不被切掉。
- `mvuReceiptsForBody` 改为前缀匹配：`turnKey === body:<messageId>` 或
  `turnKey.startsWith('body:<messageId>#')`。这样 0022 的 regenerate 在迁移前后都能收集到同一候选的 receipt。
- `assertReceiptCoverage`（`body-rollback-receipts.ts`）把 `bodyKey` 判断换成
  “该 messageId 存在任一 body receipt”；不要只匹配旧 key。
- `removeCandidateMvuReceipt` 只能在该候选没有 live 效应时调用；调用方必须先 undo，或确认
  唯一的 receipt 已经是 undone。否则删除 live receipt 会留下“变量已应用、receipt 消失”的孤儿状态。

### 3.4 与旧 `body:<messageId>` 的兼容

旧格式不是“另一种候选”，而是**缺少 index 的同一候选 receipt**。因为 `messageId` 已经在 key 里，
迁移只是补上槽位见证，不需要重算 diff。

| 场景 | 读取行为 |
|---|---|
| `body:<messageId>#<index>` | 候选 receipt；直接使用 |
| `body:<messageId>`，ledger 能找到唯一 index | 视为该候选的 legacy receipt；可读、可迁移 |
| `body:<messageId>`，ledger 找不到或找到多个 index | 无法确定槽位；`body-receipt-legacy` / `body-receipt-key-mismatch` |
| 纯数字 | settle receipt；候选路径忽略 |
| 其它 `body:` 形状 | 不可分类；拒绝，不猜 |

新写入策略：

- 所有**新建候选**的投影（`projectCandidateToChat`）使用新 key；
- `projectCandidateToChat` 从 `recordMvuTurnReceipt` 改为 `upsertCandidateMvuReceipt`，并用
  `input.sendDate`（事件时间）作为 `at`；否则空 diff 的候选不会留下 receipt，未来切回时会被误判为缺失；
- 普通 assistant 首楼仍可能由 `appendMessage` 写旧 key（它还不知道 body group 的 index）；
  该层保持旧 key，等首次 edit / select 惰性迁移；
- 迁移只改 `turnKey`，保留 `at` / `status` / `changes` / `failures` / `undoneAt`，因此
  `undoMvuReceipts` / `redoMvuReceipts` 仍能按 `turnKey + at` 定位。

### 3.5 迁移策略与未迁移拒绝

迁移在**第一次 edit / select 的同一个 chat 克隆与同一次 CAS 保存**中完成：

1. 从 ledger 构建 `messageId -> index`；若同一 messageId 出现多次，拒绝
   `body-receipt-key-mismatch`。
2. 遍历 `mvu.receipts`，对每个 `body:<messageId>`：
   - 若 messageId 在映射中，改写为 `body:<messageId>#<index>`；
   - 若不在映射中，保留不动（它可能属于更早的 body group，不能误删）；
   - 其它形状不动，交给现有分类逻辑。
3. 迁移后重新读取 receipts，再做撤销 / redo / upsert；**不要**把迁移前的 receipt 快照传给
   `undoMvuReceipts`，否则 `locateStoredReceipts` 会因 key 已变化而找不到。
4. 保存失败或任一步抛错 → 整个克隆丢弃，旧格式和旧变量都保持原样；重试是幂等的。

“未迁移聊天”的拒绝分两种：

| 状态 | 判定 | 行为 |
|---|---|---|
| 可迁移 | 目标 group 的 legacy receipt 都能由 ledger 唯一映射 | `GET body` 允许 edit / select；首次操作原子迁移；`receiptFormat: 'legacy'` 仅作提示 |
| 不可迁移 | messageId 重复 / legacy key 无法分类 / ledger 无法提供唯一槽位 | `409 body-state-unsafe`，detail `body-receipt-legacy` / `body-receipt-key-mismatch`；**不追加 body 事件**；ledger 完全缺失时先报 `projection-pending` |
| 无 receipt 且文本带块 | 目标候选需要 receipt 但完全没有 | `409 body-state-unsafe`，detail `body-receipt-missing` |

如果 owner 希望“绝不在读/操作中隐式迁移”，可以把同一套逻辑改成显式的迁移端点或启动迁移：
`GET body` 对任何 legacy group 返回 `canEdit/canSelect: false` + `body-receipt-legacy`，
迁移完成后再放开。两种模式的 key 与拒绝语义一致，差别只在迁移触发时机（见 §9 开放问题）。

### 3.6 保留策略与 JSONL 体积

- 候选 receipt 用 upsert，一条候选最多一条；切换只改 `undoneAt`，不新增。
- 非当前最后一组的 `body:` receipt 在新增真实楼层后不再可切换（`not-last-round`），可在投影新楼层时
  清理；P0 可以先不清理，P1 加 `pruneBodyReceipts(chat, activeGroupId)`。
- 现有 `MVU_RECEIPTS_LIMIT = 20` 是 settle + body 共用的环形。候选数超过剩余槽位时，旧候选 receipt 可能被挤出；
  一旦缺失，切回该候选会明确拒绝 `body-receipt-missing`，不会静默错算。P1 再决定“提高上限 / 活跃组固定保留 /
  独立数组”三者之一。
- `changes` 可能包含大数组的 before/after；候选数 × 变更体积会推高 JSONL。P1 加一个可观测的
  receipt 体积日志；P2 再评估 sidecar，不在本提案内引入第二套存储。

## 4. 编辑路径

### 4.1 前置条件

1. binding 为 `agent-tavern`、非群聊；agent `idle`；宿主有 `appendPluginRecord`。
2. 目标是最后一组正文；anchor 仍在当前 surface；没有后续真实用户楼层（沿用 0021 的
   `anchorTarget` / `assertLastBodyTarget`）。
3. ledger 存在或可由 `ensureBodyLedger` 种下候选 0；`index === ledger.selectedIndex`（只编辑当前选中正文）。
4. JSONL 楼层与 `swipes[index]` 已投影；若没有，返回 `projection-pending`，不把“尚未投影”误报成
   `body-receipt-missing`。首次 body 操作会先由 `ensureBodyLedger` 追加候选 0；若它的投影尚未创建
   `swipes`，第一次 edit 返回 `projection-pending`，客户端重试一次即可（P1 的投影屏障可 await 该候选投影）。
5. 候选 receipt 检查：
   - 旧文本带 `<UpdateVariable>` 且卡声明 JSR MVU → 必须有可撤销的 receipt（live 或 undone）；
   - 多条 live 效应 → `body-receipt-duplicate`；
   - legacy key → 可映射则迁移，不可映射则 `body-receipt-legacy`。
6. 文本非空、长度不超过 `BODY_TEXT_MAX_LENGTH`（`BODY_TEXT_MAX_LENGTH = 100_000`）。

### 4.2 事务序列

投影器是 JSONL 的唯一写者（0021 §8 规则 2）。编辑请求只负责“校验 + 追加事件”，真正的状态交换在
`projectBodyEvent` 的 `edit` 分支完成：

1. **runtime 预检**：`applyBodyEdit` 在 `withBodyLock` 内读取 fresh chat，调用只读
   `inspectCandidateState`；不安全就在追加事件之前返回 409。
2. **追加 `edit` 事件**：
   ```ts
   { op: 'edit', groupId, index, text, previousText }
   ```
   `text` 是用户原文；`previousText` 是 ledger 的有效文本（`edits.get(index) ?? candidate.text`）。
   事件是持久化的提交意图；追加成功即 ledger 的编辑已成立。
   `text` 与 JSONL 的 `applied.text` 可以不同：后者可能带状态栏占位符，前者是模型面文本；
   receipt 只关心变量补丁，不关心占位符。
3. **投影 `edit`**（`mutateBodyChat` 的 fresh clone 内，顺序不可交换）：
   1. 按 group 定位楼层；校验 `floor.swipe_id === index`、`swipes[index]` 存在、
      `extra.agentTavern.anchorMessageId === ledger.anchorMessageId`。
   2. 迁移 legacy key（§3.5）；重新读取 receipts。
   3. 检查 group 的单 live 效应；目标候选的 newest receipt：
      - live → `undoMvuReceipts(chat, [receipt], { at })`，变量回到候选基线；
      - undone → 不需要 undo，变量已在基线；
      - 缺失且 `needsReceipt(previousText, card)` → `body-receipt-missing`，整次投影失败，不保存。
   4. `before = snapshotChatVariables(chat)`。
   5. `applied = applyUpdateVariableToChat(card, chat, text)`。它返回：
      - `found`：文本里是否有 `<UpdateVariable>`；
      - `text`：应用了状态栏占位符后的 JSONL 文本；
      - `failures`：解析 / 部分写入失败项。
   6. `found === true` → `upsertCandidateMvuReceipt(chat, before, { messageId, index, at, failures })`；
      `found === false` → `removeCandidateMvuReceipt(chat, ref)`（清掉旧补丁的 receipt）。
   7. `applyEditToChat(chat, { groupId, index, text: applied.text })`：更新 `swipes[index]` 与 `mes`
      （`mes = swipes[swipe_id]`）；`swipe_info[index]` 保留原 provider / model / usage / feedback，
      不因用户手改而伪造新的模型元数据。
   8. `messageStatVariables(chat, floor)`：把新的 `stat_data` 挂回楼层 `variables`，保证
      `getChatMessages().data.stat_data` 与 `chat_metadata.variables` 同源。
   9. 写 `extra.agentTavern.lastBodyEventSeq = event.seq`、`lastBodyMutation = 'edit'`。
   10. `saveChat(expectedRevision)`；CAS 冲突从 fresh snapshot 重跑整个 3–9 步。
4. 返回 `stateFromLedger`；客户端重新 `GET body`。

### 4.3 候选 0 与选中槽位

- **候选 0**：`groupId === candidate.messageId`。首次 body 操作由 `ensureBodyLedger` 追加
  `candidate` 事件，投影创建 `swipes[0]`；编辑时 receipt key 为 `body:<messageId>#0`，
  更新 `swipes[0]` / `mes`。普通 assistant 首楼留下的 `body:<messageId>` 旧 receipt 在首次编辑时迁移为 `#0`。
  注意：候选 0 的 seed 必须复用楼层已投影的 `mes`（它可能带状态栏占位符），不能用 session 原文覆盖；
  否则第一次 body 操作会把占位符从 JSONL/展示层丢掉。
- **选中槽位 N**：只在 `index === ledger.selectedIndex` 时允许。编辑更新 `swipes[N]` / `mes`，
  receipt key 为 `body:<messageIdN>#N`。P1 select 之后 anchor 可能仍是 A，但选中是 B：
  编辑 B 只改 B 的槽位与 receipt，模型面的 anchor A 由 `createBodyProjection` 用
  `effectiveBodyText(ledger)`（B 的编辑文本）替换。
- **restore 副本**：`restore` 事件把 anchor 指向一个新的 `body-restore-*` 消息，但 ledger 的
  `candidates[index].messageId` 仍是原候选 id；receipt key 继续用原 messageId，不跟随副本 id。
  副本没有自己的 receipt，也不应新建。
  **重要**：副本的 assistant 内容来自原消息，可能不含用户编辑；`createBodyProjection` 必须把
  `restore` 也纳入触发（与 `select` / `edit` 同级），用 `effectiveBodyText(ledger)` 覆盖副本文本。
  否则“编辑过正文 → 重生成失败 → restore”会把显示与模型面回退到未编辑的原文。

### 4.4 失败与回滚

- **投影中途抛错**：所有操作都在 `structuredClone` 的 chat 上；抛错即丢弃，不发生部分保存。
  不需要 `restore(plan)`，因为没有任何 store 被单独写。
- **`saveChat` CAS 冲突**：`mutateBodyChat` 的 4 次重试每次从 fresh snapshot 重做迁移 / undo / patch；
  4 次都失败 → 抛 `ChatRevisionConflictError`，投影 checkpoint 保持 pending，事件保留，稍后重放。
- **新文本补丁部分失败**：`applyUpdateVariableToChat` 的 `failures` 不阻止提交；receipt 记为
  `status: 'failed'`，`changes` 只包含真正落盘的部分。这与普通生成投影的语义一致。
- **新文本无块**：撤销旧 receipt 后删除该候选 receipt；变量停在基线。
- **事件追加失败**：ledger 不变、JSONL 不变；返回 `operation-failed`，无需补偿。
- **投影失败 / checkpoint pending**：`GET body` 应报告 `projection-pending`（503），并阻止下一次
  regenerate / edit / select；重启时 `projector.replay` 从 checkpoint 重放。P1 增加
  `agent/pre-step` 的投影屏障，避免模型在新变量落盘前看到新正文。

复用清单：

| 复用 | 不复用 |
|---|---|
| `undoMvuReceipts` / `redoMvuReceipts`（内存态） | `BodyWriteRollbackPort.prepare/restore/commit`（turn 级） |
| `snapshotChatVariables` / `diffVariables` / `recordMvuTurnReceipt` 的 diff 语义 | `applyReceiptRollback`（会同时处理 settle receipt 与 flat store） |
| `applyEditToChat` / `applySelectToChat` / `locateBodyFloor` | `rollbackTurnWrites`（只为失败的新 turn 服务） |
| `mutateBodyChat` 的 CAS 重试 | `write-journal`（编辑/切换不产生工具写入） |
| `messageStatVariables` | `restoreBodyAfterFailure`（不允许新 turn） |

### 4.5 伪代码

```ts
// body-candidate-receipts.ts -- mutates the caller-owned chat clone.
export function applyCandidateEditToChat(
  chat: ChatLogIR,
  card: CharacterCardIR,
  input: {
    readonly groupId: string
    readonly index: number
    readonly messageId: string
    readonly previousText: string
    readonly text: string
    readonly eventSeq: number
    readonly at: string
    readonly ledger: BodyLedger
  },
): ChatLogIR {
  const floorIndex = locateBodyFloor(chat, input.groupId, input.messageId)
  const floor = chat.messages[floorIndex]!
  if (floor.swipe_id !== input.index) {
    throw candidateError('stale-anchor', `edit index ${input.index} does not match swipe_id ${String(floor.swipe_id)}`)
  }
  if (readLastBodyEventSeq(floor) >= input.eventSeq) return chat

  migrateLegacyCandidateKeys(chat, candidateIndexMap(input.ledger))
  assertAtMostOneLiveEffect(chat, input.ledger)

  const latest = latestCandidateReceipt(chat, input)
  if (latest === undefined && needsReceipt(input.previousText, card)) {
    throw candidateError('body-receipt-missing', `candidate ${input.index} has no receipt for its previous body`)
  }
  if (latest !== undefined && latest.undoneAt === undefined) {
    undoMvuReceipts(chat, [latest], { at: input.at })
  }

  const before = snapshotChatVariables(chat)
  const applied = applyUpdateVariableToChat(card, chat, input.text)
  if (applied.found) {
    upsertCandidateMvuReceipt(chat, before, {
      messageId: input.messageId,
      index: input.index,
      at: input.at,
      failures: applied.failures,
    })
  } else {
    removeCandidateMvuReceipt(chat, input)
  }

  const next = applyEditToChat(chat, {
    groupId: input.groupId,
    index: input.index,
    text: applied.text,
  })
  return markBodyMutation(
    messageStatVariables(next, next.messages[floorIndex]!),
    floorIndex,
    input.eventSeq,
    'edit',
  )
}
```

## 5. 候选切换路径

### 5.1 前置条件

1. 同编辑路径的 binding / idle / last-round / anchor / surface 校验。
2. `from = ledger.selectedIndex`，`to = request.index`；`from !== to`。
3. 请求携带 `expectedIndex`（from）；与 ledger 不一致 → `stale-anchor`（多客户端竞争）。
4. JSONL 楼层与 `swipes[from]`、`swipes[to]` 已投影；否则 `projection-pending`。
5. 候选 receipt 检查：
   - from 的文本带块但没有任何 receipt → `body-receipt-missing`；
   - to 的文本带块且既无 live 也无 undone receipt → `body-receipt-missing`；
   - 任一候选有多条 live 效应 → `body-receipt-duplicate`；
   - legacy key 可映射则迁移，不可映射则 `body-receipt-legacy`。

### 5.2 事务序列

1. runtime 预检（fresh chat，只读）→ 追加：
   ```ts
   { op: 'select', groupId, index: to }
   ```
2. 投影 `select`（fresh clone，顺序不可交换）：
   1. 定位楼层；校验 `floor.swipe_id === from`、两个 `swipes` 都存在。
      投影侧用 `foldBodyLedger(events, groupId, event.seq - 1)` 取 `from`；不能用 `event.seq` 的 fold，
      因为它已经是 `to`。
   2. 迁移 legacy key；重新读取 receipts。
   3. `assertAtMostOneLiveEffect(chat, ledger)`；若 > 1 → `body-receipt-duplicate`。
   4. **撤销 A**：若 from 的 newest receipt 是 live，`undoMvuReceipts(chat, [A], { at })`。
      若 from 没有 receipt 但文本带块 → `body-receipt-missing`。
   5. **复用或 redo B**：
      - newest B receipt 是 live → 不重复应用；
      - newest B receipt 是 undone → `redoMvuReceipts(chat, [B])`，恢复它的 `after` 值并清除 `undoneAt`；
      - B 没有 receipt：若 B 文本带块 → `body-receipt-missing`；否则变量停在基线，允许。
   6. `applySelectToChat(chat, { groupId, index: to, anchorMessageId: ledger.anchorMessageId })`：
      `swipe_id = to`、`mes = swipes[to]`；`extra.agentTavern.anchorMessageId` 保持 A 不变。
   7. `messageStatVariables(chat, floor)` 同步楼层 `stat_data`。
   8. 写 `lastBodyEventSeq = event.seq`、`lastBodyMutation = 'select'`。
   9. `saveChat(expectedRevision)`；CAS 冲突重跑 1–8 步。

### 5.3 原子顺序与 CAS

同一份 `chat` 对象里同时包含 `swipes` / `swipe_id` / `mes` / `variables` / `mvu.receipts`，
因此只有**一次** `saveChat`：

```text
clone snapshot
  -> migrate keys
  -> undo A (variables back to base)
  -> redo/reuse B (variables to B)
  -> set swipe_id / mes
  -> sync message stat_data
  -> mark lastBodyEventSeq
  -> saveChat(expectedRevision)
```

- 变量树的顺序必须是 **先 undo A，再 redo B**；反过来会把 B 的 `after` 叠在 A 上。
- `swipes` 本身不重写（候选文本已存在），但它的完整性在同一次保存前校验；`swipe_id` / `mes` /
  `variables` / `mvu.receipts` 必须落在同一次 `saveChat` 里。
- 不写 flat `VariableStore`，不写 settle receipt，不写 journal。
- `mutateBodyChat` 保留 4 次 CAS 重试；每次重试都重新读取并重新执行完整顺序，不做“只重试 save”。
- 4 次耗尽 → `409 body-conflict`；投影 checkpoint pending，事件保留，等待下一次重放。

### 5.4 幂等

- runtime 在 `from === to` 时直接返回当前 state，不追加事件、不写 chat。
- 投影用 `extra.agentTavern.lastBodyEventSeq >= event.seq` 提前返回；同一事件重放不会再次 undo/redo。
- A→B→A→B 的往返只翻转两条 receipt 的 `undoneAt`，不新增 receipt。
- B 的 newest receipt 是 `status: 'unchanged'` 时，redo 是无操作，只清 `undoneAt`。

### 5.5 与 regenerate 的衔接（P1，必须与 select 同批）

select 之后 anchor 仍是 A、selected 是 B。0022 的 `prepare` 以 `previousAnchorId` 收集 receipt，
会找错候选。P1 扩展：

```ts
interface BodyRollbackPlan {
  // existing fields...
  readonly candidate?: {
    readonly messageId: string
    readonly index: number
    readonly text: string
  }
}

// Optional fourth argument keeps 0022 callers working.
prepare(agentId, turn, previousMessageId, candidate?): Promise<BodyRollbackPlan>
```

- `startRegenerate` 从 ledger 取 `selectedIndex` 与 `candidates[selectedIndex]`，把 selected candidate
  传给 `prepare`；`op-start` 落盘 `previousCandidateId` / `previousCandidateIndex`（旧记录可缺省）。
- `prepare` 用 `mvuReceiptsForCandidate` 收集 B 的 receipt（外加该楼层的 settle receipt 与 turn journal）；
  不再用 anchor A 的 receipt。
- `restoreBodyAfterFailure` 优先按 `op.previousCandidateId` 找 B 的 assistant 消息复制；restore turn 的
  `restore` 事件仍使用 `previousIndex`，anchor 变为 B 的副本。
- `canRegenerate` 必须基于“selected candidate 的 receipt 可用”，而不是 anchor 的 receipt。

生命周期：

```text
candidate 0: R0 undone
candidate B: RB live, selected B, anchor A

regenerate:
  prepare(B) -> RB undone (variables back to base)
  new candidate C -> RC live (base -> C)
  success -> selected C, anchor C, R0/RB undone
  failure -> restore B: RB redone, selected B, anchor B-copy
```

P0 只放编辑时，select 仍关闭，因此 anchor == selected，0022 现有 `prepare` 仍正确；P1 放 select 时
必须同时合入上面的候选感知修改。

### 5.6 伪代码

```ts
// body-candidate-receipts.ts -- mutates the caller-owned chat clone.
export function applyCandidateSelectToChat(
  chat: ChatLogIR,
  card: CharacterCardIR,
  input: {
    readonly groupId: string
    readonly from: BodyCandidateRef
    readonly to: BodyCandidateRef
    readonly eventSeq: number
    readonly at: string
    readonly ledger: BodyLedger
  },
): ChatLogIR {
  const floorIndex = locateBodyFloor(chat, input.groupId, input.to.messageId)
  const floor = chat.messages[floorIndex]!
  if (floor.swipe_id !== input.from.index) {
    throw candidateError('stale-anchor', `selected swipe is ${String(floor.swipe_id)}, expected ${input.from.index}`)
  }
  if (readLastBodyEventSeq(floor) >= input.eventSeq) return chat

  migrateLegacyCandidateKeys(chat, candidateIndexMap(input.ledger))
  assertAtMostOneLiveEffect(chat, input.ledger)

  const fromLatest = latestCandidateReceipt(chat, input.from)
  if (fromLatest !== undefined && fromLatest.undoneAt === undefined) {
    undoMvuReceipts(chat, [fromLatest], { at: input.at })
  } else if (needsReceipt(candidateText(input.ledger, input.from.index), card)) {
    throw candidateError('body-receipt-missing', `candidate ${input.from.index} has no receipt to undo`)
  }

  const toLatest = latestCandidateReceipt(chat, input.to)
  if (toLatest === undefined) {
    if (needsReceipt(candidateText(input.ledger, input.to.index), card)) {
      throw candidateError('body-receipt-missing', `candidate ${input.to.index} has no receipt to replay`)
    }
  } else if (toLatest.undoneAt !== undefined) {
    redoMvuReceipts(chat, [toLatest])
  }

  const next = applySelectToChat(chat, {
    groupId: input.groupId,
    index: input.to.index,
    anchorMessageId: input.ledger.anchorMessageId,
  })
  return markBodyMutation(
    messageStatVariables(next, next.messages[floorIndex]!),
    floorIndex,
    input.eventSeq,
    'select',
  )
}
```

## 6. 门禁变化

### 6.1 保留的读侧检查

`bodyStateSafetyOf` 继续只管“能不能读”：card 不可读 / chat 不可读 / safety 无法解析。
它不再因为 MVU 或变量历史本身拒绝。

### 6.2 新判定：`bodyCandidateSafetyOf`

```ts
export type BodyCandidateSafetyDetail =
  | 'candidate-rollback-unavailable'
  | 'candidate-switch-disabled'
  | 'body-receipt-missing'
  | 'body-receipt-legacy'
  | 'body-receipt-duplicate'
  | 'body-receipt-key-mismatch'
  | 'body-variable-drift'
  | 'body-receipt-schema-drift'

export interface BodyCandidateSafetyInput {
  readonly action: 'edit' | 'select' | 'regenerate'
  readonly character: { readonly card: CharacterCardIR } | undefined
  readonly chat: ChatLogIR | undefined
  readonly ledger: BodyLedger | undefined
  readonly selectedIndex: number
  readonly targetIndex?: number
  readonly candidateReceiptsAvailable: boolean
}

export function bodyCandidateSafetyOf(input: BodyCandidateSafetyInput): BodyStateSafety
```

判定顺序（短路）：

1. card / chat 不可读 → `card-unreadable` / `chat-unreadable`。
2. 候选 receipt 能力未接线 → `candidate-rollback-unavailable`（旧 host / 关闭功能）。
3. 卡不声明 JSR MVU，或目标候选文本不含 `<UpdateVariable>` → `safe`（没有正文补丁要回滚）。
4. ledger 缺失但目标文本含块 → `body-receipt-missing`（无法证明 receipt 属于哪个候选）；
   JSONL 尚未投影时由调用方先报 `projection-pending`。
5. 同一 messageId 映射到多个 index → `body-receipt-key-mismatch`。
6. 目标候选的 live 效应 > 1 → `body-receipt-duplicate`。
7. 目标文本含块：
   - edit：当前候选必须有 live 或 undone receipt，否则 `body-receipt-missing`；
   - select：from 必须有可撤销 receipt；to 必须有 receipt 或文本不含块；
   - regenerate：selected candidate 必须有 receipt（0022 的 `prepare` 会再校验）。
8. legacy receipt 可映射 → `safe`，并标记 `receiptFormat: 'legacy'`；不可映射 → `body-receipt-legacy`。

与现有 router 的差异：readability / capability 仍可提前拒绝；但候选 receipt 判定必须等 live agent 与
ledger 可用之后，因此 `bodyMutationSafetyOf` 里“MVU 一律拒绝 edit/select”的早退必须先删除，
不能在旧位置保留一个更早的 409。

### 6.3 `canEdit` / `canSelect` 矩阵

| 聊天状态 | `canEdit` | `canSelect` | `reason` / `detail` |
|---|---|---|---|
| P0 构建，目标涉及 MVU 正文补丁 | true（若 edit 安全） | false | `candidate-switch-disabled`（非 MVU select 仍按 0021 工作） |
| 非 MVU 卡、无正文补丁 | true | count > 1 | — |
| MVU 卡、文本无 `<UpdateVariable>` | true | count > 1 | — |
| MVU 卡、文本有块、候选 receipt live | true | count > 1 且目标安全 | — |
| MVU 卡、文本有块、legacy 可迁移 | true（首次操作迁移） | 同上 | `receiptFormat: 'legacy'` |
| MVU 卡、文本有块、无 receipt | false | false | `body-receipt-missing` |
| 多条 live 效应 | false | false | `body-receipt-duplicate` |
| ledger 缺失 + 文本有块 | false | false | `body-receipt-missing` / `projection-pending` |
| 非最后一组 / hidden / compacted | false | false | 0021 既有码 |
| select 目标不安全 | true | false（或逐候选 `selectable: false`） | `body-receipt-missing` |

`GET body` 的 anchor 行即使 `messageId` 等于候选 0 的 messageId，`canEdit` / `canSelect` 也必须以
`ledger.selectedIndex` 的候选为准；select 之后 anchor 行展示的是 B 的文本，不能拿候选 0 的 receipt 判定。
`hidden: true` 的行不渲染动作，`canEdit` / `canSelect` 一律 false。
P1 的 `canRegenerate` 同样以 selected candidate 的 receipt 为准；anchor 的 receipt 不再足够
（见 §5.5）。

### 6.4 `body-state-unsafe` detail 收窄

| detail | 新语义 |
|---|---|
| `card-unreadable` | 保留 |
| `chat-unreadable` | 保留 |
| `safety-unavailable` | 保留 |
| `mvu-receipt-missing` | 只用于 regenerate 的旧正文；候选路径改用 `body-receipt-missing` |
| `write-journal-missing` | 只用于 regenerate 的旧 turn；edit/select 不检查 journal |
| `write-journal-unavailable` | 只用于 regenerate；edit/select 不需要 journal |
| `edit-rollback-unavailable` | **退役**：不再因 MVU 聊天出现；仅作为旧客户端兼容别名映射到 `candidate-rollback-unavailable` |
| `select-rollback-unavailable` | 同上 |
| `candidate-rollback-unavailable` | 新：候选级 receipt 能力未接线（旧 host / 功能关闭） |
| `candidate-switch-disabled` | 新：P0 构建尚未开启 MVU 候选切换；非 MVU select 不受影响，P1 移除该门 |
| `body-receipt-missing` | 新：候选文本含块但没有可撤销 / 可重放的 receipt |
| `body-receipt-legacy` | 新：旧 key 无法唯一映射到候选槽位 |
| `body-receipt-duplicate` | 新：同一 group / 候选存在多条 live 效应 |
| `body-receipt-key-mismatch` | 新：key 的 messageId / index 与 ledger 槽位不一致 |
| `body-variable-drift` | 新（P2）：当前变量与 receipt 期望的 before/after 不一致，拒绝覆盖 |
| `body-receipt-schema-drift` | 新（P2）：卡 schema 已变，redo 的 after 值可能违反当前守卫 |

`bodyStateUnsafeMessage` 为每个新 detail 提供可操作的消息：包含候选 index、messageId、
缺失/重复的 key，以及“先迁移 / 先修复，不要重试”的指引。

### 6.5 非 MVU、缺 receipt、旧格式的行为

- **非 MVU 卡**：不要求 receipt，不写 receipt；`canEdit` / `canSelect` 与 0021 一致。
  例外是“plain 卡 + 导入的 `stat_data`”：0023 起允许编辑/切换，因为插件从未为该卡应用正文补丁，
  变量不会被改动。这是对旧测试 `keeps edit refused when the chat only carries stat_data or receipts`
  的有意放开（gate 收窄）；若 owner 要求保守，可保留旧拒绝并返回 `candidate-rollback-unavailable`。
- **缺 receipt**：只在“目标文本含 `<UpdateVariable>` 且卡声明 JSR MVU”时拒绝；没有块的候选不受影响。
- **旧格式**：可迁移 → 允许并在首次操作中迁移；不可迁移 → `body-receipt-legacy`，不追加事件。
- **JSONL 未投影**：`projection-pending`（503），不是 `body-state-unsafe`；客户端应重试而不是提示“数据损坏”。

### 6.6 API 响应

`GET body` 在 0021 字段上追加（向后兼容）：

```ts
{
  ok: true,
  // ...existing fields...
  canEdit: boolean,
  canSelect: boolean,
  reason?: string,
  detail?: string,                 // concrete body-state-unsafe detail
  receiptFormat?: 'candidate' | 'legacy' | 'missing' | 'not-applicable',
  candidates?: Array<{
    index: number,
    messageId: string,
    selectable: boolean,
    detail?: string,
  }>,
}
```

`PUT body` / `POST body/select` 请求增加可选的 `expectedIndex`（当前 selectedIndex）：

```json
{
  "sessionId": "...",
  "groupId": "...",
  "expectedAnchorId": "...",
  "expectedIndex": 2,
  "index": 3,
  "text": "..."
}
```

`expectedIndex` 不匹配 → `409 stale-anchor`，不追加事件。新客户端应始终发送；旧客户端缺省时
runtime 仍按 ledger 当前 selectedIndex 执行，但会失去多客户端竞争保护。

新增公开拒绝码：

| 码 | 状态 | 场景 |
|---|---|---|
| `body-conflict` | 409 | CAS 4 次耗尽；投影 pending，可重试 |
| `projection-pending` | 503 | 事件已追加但 JSONL 投影未完成 |
| `body-state-unsafe` | 409 | 具体 detail 见 §6.4 |

## 7. 事务与失败恢复

### 7.1 状态与写入者

| 状态 | 存储 | 唯一写入者 | edit/select 是否参与 |
|---|---|---|---|
| body 事件（`candidate/select/edit/restore`） | DSH Session 日志 | `body-runtime` | 是（追加） |
| `swipes` / `swipe_id` / `mes` / `swipe_info` | Tavern JSONL | `body-projector` | 是 |
| `chat_metadata.variables` | Tavern JSONL | `body-projector` | 是 |
| `chat_metadata.mvu.receipts` | Tavern JSONL | `body-projector` | 是 |
| `extra.agentTavern.lastBodyEventSeq` | Tavern JSONL | `body-projector` | 是（candidate / select / edit / restore 都写） |
| settle receipt / flat `VariableStore` | JSONL + store | 0022 | **否** |
| memory / write journal | MemoryStore + plugin record | 工具 / 0022 | **否** |
| projector checkpoint | `projections/*.json` | `AgentTavernProjector` | 是（游标） |

### 7.2 与 0022 的关系

| 路径 | `prepare/restore/commit` | write journal | `rollbackTurnWrites` | 候选 receipt |
|---|---|---|---|---|
| regenerate | 是；P1 起候选感知 | 是 | 失败的新 turn | 撤销 selected candidate 的 receipt |
| edit | 否 | 否 | 否 | 撤销当前候选，upsert 新 receipt |
| select | 否 | 否 | 否 | 撤销 A，复用 / redo B |

明确边界：

- edit / select **不**调用 `prepare`，否则会把同一 turn 的记忆与 flat 变量一起撤销；
- edit / select **不**写 journal，因为它们不运行工具；
- edit / select **不**调用 `rollbackTurnWrites`，因为没有新 turn；
- `rollbackTurnWrites` 的 settle receipt 选择逻辑只看纯数字 key，不会误碰候选 key；
- 0022 的 `applyReceiptRollback` 会把 body receipt 交给 `undoMvuReceipts`，这在 0023 下仍成立，
  但候选路径不复用它，避免把 settle receipt 与 flat store 带进来。

### 7.3 端口方法

| 需求 | 方案 |
|---|---|
| edit / select 的安全预检 | 新增**只读** `inspectCandidateState`（或纯函数 `inspectCandidateReceipts` + HTTP 层传入 chat 快照）；不新增 mutating port |
| edit / select 的 JSONL 写入 | 继续由 projector 单写者完成；不新增 runtime 写端口 |
| 同步返回投影失败 | P1 增加可选 `awaitBodyProjection(sessionId, uptoSeq)`；wiring 从 projector 队列取 promise |
| regenerate 的候选感知 | P1 扩展 `BodyWriteRollbackPort.prepare(agentId, turn, previousMessageId, candidate?)` 与 `BodyRollbackPlan.candidate` |
| 崩溃恢复 | 复用现有 `projector.replay`；edit/select 不需要新的 `op-start` / `foldPendingOps` |

如果 owner 要求“HTTP 返回时 JSONL 必须已经落盘”，可在 P2 把 `inspectCandidateState` 升级为
`editCandidate` / `selectCandidate` 的写端口；届时仍复用同一套纯函数与 `mutateBodyChat` CAS，
只是把调用点从 projector 前移到 runtime。当前推荐 projector 单写者，避免双写与补偿。

### 7.4 崩溃窗口

| 窗口 | 持久化结果 | 恢复 |
|---|---|---|
| 事件已追加、投影未运行 | ledger 新；JSONL 旧 | checkpoint pending；重启 `projector.replay`；`GET body` 报 `projection-pending` |
| chat 已保存、checkpoint 未写 | JSONL 新；游标旧 | 重放同一事件时 `lastBodyEventSeq >= seq` 直接跳过 |
| CAS 冲突 / 保存失败 | 无部分保存 | 4 次重试；耗尽后 pending + `body-conflict` |
| 迁移中途崩溃 | 迁移只存在于 clone | 旧格式保持；重试重新迁移 |
| patch 应用中途抛错 | clone 丢弃 | 旧变量保持；事件 pending，重放 |
| 事件追加后进程被杀 | 事件在 session log | 重启投影；不依赖进程内 `pendingByAgent` |

### 7.5 回滚不完整场景

- **CAS 长期冲突**：投影保持 pending，ledger 已变、变量未变；必须阻止新的 regenerate / edit / select，
  直到重放成功。不能把这种状态报告成“已完成”。
- **receipt 被环形挤出**：切回旧候选会 `body-receipt-missing`。这是明确拒绝，不是回滚；
  P1 的保留策略要尽量降低概率。
- **多条 live 效应**：`body-receipt-duplicate`；不做“猜一条撤销”。需要人工修复 JSONL 或恢复备份。
- **无块但仍有 live receipt**：说明编辑删块时未清理 receipt 或数据被手改；按 `body-receipt-key-mismatch`
  拒绝，要求修复，不把旧补丁 redo 回来。
- **变量被外部改写**：P2 的 `body-variable-drift` 会拒绝 undo/redo，避免覆盖用户手改变量。
- **卡 schema 变化**：P2 的 `body-receipt-schema-drift` 会拒绝 redo；当前 P1 至少记录日志。
- **迁移不可映射**：`body-receipt-legacy`；不删 receipt、不猜 index。
- **不自动修复**：本提案不提供“删掉坏 receipt 继续”的静默路径；修复必须是显式运维操作。

## 8. 测试矩阵

| # | 场景 | 期望 |
|---|---|---|
| 1 | 非 MVU 编辑 | `edit` 事件 + `swipes[index]` / `mes` 更新；无 receipt；无新 turn |
| 2 | MVU 候选 0 编辑，文本含块 | 旧 receipt undone；新 receipt `body:<m0>#0`；变量 = 新补丁；`stat_data` 同步 |
| 3 | MVU 选中候选 N 编辑 | 同 2，key 为 `body:<mN>#N`；anchor 仍是 A（P1） |
| 4 | 编辑后文本不含块 | 旧 receipt undone 后删除；变量回基线；swipes 更新 |
| 5 | 编辑后块解析失败 | receipt `status: 'failed'`，`changes` 只含已落盘项；文本仍提交 |
| 6 | 编辑相同文本 | no-op：不追加事件、不写 chat；重复请求幂等 |
| 7 | 连续编辑 A→B→C | 该候选只有一条最新 receipt；变量 = C；无累积 undone 条目 |
| 8 | select A→B 成功 | A undone；B live 或 redo；`swipe_id=B`、`mes=B`；anchor 不变 |
| 9 | select B→A 成功 | B undone；A redo；变量 = A |
| 10 | select 同一 index | no-op；不追加事件、不写 chat |
| 11 | select 到无块且无 receipt 的候选 | 允许；变量回基线；`swipe_id` 更新 |
| 12 | select 到有块但无 receipt 的候选 | 409 `body-state-unsafe` / `body-receipt-missing`；不追加事件 |
| 13 | 缺 receipt 编辑 | 409 `body-receipt-missing`；不追加事件；旧变量不变 |
| 14 | legacy receipt 唯一映射 | `GET` 允许；首次编辑迁移 key；重放不再迁移 |
| 15 | legacy receipt 不可映射 | 409 `body-receipt-legacy`；不写事件；旧 JSONL 不变 |
| 16 | 多条 live 效应 | 409 `body-receipt-duplicate`；不保存 |
| 17 | CAS 冲突一次 | `mutateBodyChat` 重试成功；最终状态正确；无重复 receipt |
| 18 | CAS 4 次耗尽 | `body-conflict`；checkpoint pending；无部分变量 |
| 19 | `saveChat` 抛错 | 旧 chat 完全不变；迁移不落盘；事件保留待重放 |
| 20 | 事件追加后重启 | `agent/created` replay 只应用一次；`lastBodyEventSeq` 生效 |
| 21 | 投影失败后重试 | 第一次 pending；第二次成功；无重复 undo/redo |
| 22 | 第 21 个候选 / receipt 挤出 | 切回被挤出候选 → `body-receipt-missing`；不静默错算 |
| 23 | 非 MVU（无导入变量历史）/ ST / 群聊 | 行为零变化；ST 架构不进入本路径；plain 卡 + `stat_data` 按 §6.5 有意放开为可编辑 |
| 24 | 0021 body spec 全量 | 通过（编辑 / 候选 / 投影 / 客户端） |
| 25 | 0022 rollback spec 全量 | 通过（prepare / restore / journal / settle / 失败恢复） |
| 26 | select 后 regenerate（P1） | `prepare` 撤销 B 的 receipt（不是 A）；C 的补丁只应用一次 |
| 27 | select 后 regenerate 失败（P1） | restore 恢复 B 的正文与 receipt；不恢复 A |
| 28 | select 后 regenerate 的新 turn 写工具失败 | `rollbackTurnWrites(C)` 只撤 C；B 的 receipt 与 flat 变量不受影响 |
| 29 | `GET body` 矩阵 | 非 MVU / 无块 / live / legacy / 缺 receipt / duplicate 的 `canEdit` / `canSelect` / detail 正确 |
| 30 | schema 变化（P2） | redo 拒绝 `body-receipt-schema-drift`；变量不变 |
| 31 | 手改变量（P2） | undo/redo 拒绝 `body-variable-drift`；不覆盖 |
| 32 | 真机 MVU 卡 E2E | 编辑 / 切换 / 重生成后变量、状态栏、楼层 `swipes` 一致；重启可读 |

聚焦 spec 建议：

- `agent-tavern-body-candidate-receipts.spec.ts`：key 解析、迁移、upsert/remove、单 live 不变量；
- `agent-tavern-body-mvu-switch.spec.ts`：edit/select 的变量往返、缺 receipt、duplicate；
- `agent-tavern-body-projector.spec.ts`：CAS 重试、`lastBodyEventSeq`、`messageStatVariables`；
- `agent-tavern-body-runtime.spec.ts`：预检、expectedIndex、no-op、事件追加失败；
- `agent-tavern-body-wiring.spec.ts`：`canEdit` / `canSelect` 矩阵与 detail；
- `agent-tavern-body-rollback.spec.ts`：候选感知 `prepare` / restore（P1）。

## 9. 风险与分期

### 9.1 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 候选 key + `mvu.ts` 读写 helper + legacy 迁移 + **edit** 路径 + 门禁收窄 | MVU 编辑只应用一次；缺 receipt / legacy 拒绝；0021/0022 回归通过；MVU select 返回 `candidate-switch-disabled`，非 MVU select 不变 |
| P1 | **select** 路径 + 候选感知 regenerate（`prepare` / `restore` / `op-start` 字段）+ 逐候选安全 + 投影屏障 | A→B→A 往返一致；select 后 regenerate 不双写；重启重放幂等 |
| P2 | `body-variable-drift` / `body-receipt-schema-drift`、活跃组保留策略、receipt 体积观测、修复工具、真机 E2E | 漂移可拒绝；长聊天 JSONL 体积可控；故障可运维 |

**硬门禁：P1 的 select 不得早于候选感知 regenerate 合入。** 如果业务要求先放 MVU select，P0 必须在
MVU 聊天上把 `canRegenerate` 在 `selectedIndex !== anchorIndex` 时置 false，直到 P1；否则 0022 会双写。
非 MVU select 不涉及 receipt，不受此门影响。

### 9.2 数据结构迁移风险

- `turnKey` 是用户可编辑 JSONL 的一部分；迁移只改 key，不改 `changes`。必须原子、幂等、可重入。
- 迁移与 edit/select 共用一次 CAS；失败不留下“一半新 key、一半旧 key”的持久状态。
- 旧备份 / 分支副本可能仍是 legacy；读取端必须长期保留 `body:<messageId>` 解析，不能只支持新格式。
- 不在迁移时删除任何 receipt；无法映射的留在原位，只拒绝当前 group 的操作。

### 9.3 JSONL 体积

- 一条候选一条 receipt；切换只翻 `undoneAt`，编辑才替换。
- 大数组变更会放大单条 receipt；P1 加体积日志，P2 再评估独立存储。
- 活跃组以外的 `body:` receipt 可在新楼层投影时清理；清理前必须确认该组已不可能再编辑（`not-last-round`）。

### 9.4 回滚不完整

- CAS 耗尽、receipt 被挤出、多条 live、变量漂移、schema 漂移都不是“自动可修”的场景；必须明确拒绝并保留 pending。
- 投影 pending 期间禁止 regenerate / edit / select；客户端显示可重试错误，不显示成功。
- 没有跨 store 2PC：候选路径只写 JSONL，天然单 store；这也是不复用 0022 turn plan 的原因。

### 9.5 明确不做

- 不为每个候选 fork Session，不复活被 shadow 的 assistant 节点。
- 不在 select 时重新解析 B 的文本；只 replay receipt。
- 不在 edit/select 时回滚记忆、flat 变量或 settle receipt。
- 不支持历史楼层编辑 / 切换；仍只支持最后一组。
- 不自动删除/重建缺失 receipt；不静默“修复”。
- 不新增第二条生成链路；不改变 ST / 群聊。
- 不把候选 receipt 写进 session surface 或纯对话导出；`mvu.receipts` 仍是 JSONL 内部状态。

## 10. 开工前检查表

| 项 | 结论 |
|---|---|
| 所有者 | `body-view.ts`（门禁）、`body-runtime.ts`（预检 / 事件）、`body-projector.ts`（投影事务）、新增 `body-candidate-receipts.ts`（key / inspection / 迁移 / upsert 纯函数）、`mvu.ts`（receipt 读取 / undo / redo / 前缀匹配）、`body-jsonl.ts`（swipes / mes）、`body-wiring.ts`（deps / barrier）、tests |
| 唯一事实来源 | Session 的 body 事件 + `chat_metadata.mvu.receipts`；JSONL 的 `swipes` / `variables` 是投影，不是第二套事实 |
| 持久态及理由 | 候选 receipt、`variables`、`swipes` / `swipe_id` / `mes`、`lastBodyEventSeq` 必须落盘，保证重启/导出后切换可重建 |
| 临时态 | `withBodyLock`、projector tail / checkpoint cache、投影中的 chat clone；edit/select 不新增进程内 pending op |
| 外部依赖 | `appendPluginRecord`（0.2.1+）、`saveChat` CAS、`applyUpdateVariableToChat`、`undoMvuReceipts` / `redoMvuReceipts`、`messageStatVariables`、P1 的 `agent/pre-step` 屏障 |
| 注册入口 | 既有 `GET/PUT /body`、`POST /body/regenerate`、`POST /body/select`；`projectBodyEvent` 的 edit/select 分支；`createBodyDeps` 的只读 inspection 端口 |
| 删除路径 | body 事件 `ignorable`；`mvu.receipts` 是 JSONL，删掉只失去切换历史，不毒化会话；插件缺失时最后一次投影的文本/变量仍可读 |
| 兼容对象 | ST 架构、群聊、普通 DSH 会话零变化；非 MVU 卡不变；旧 receipt 只读兼容；旧客户端忽略新字段 |

## 11. 验收

1. MVU 候选编辑后，`chat_metadata.variables` 等于“候选基线 + 新文本补丁”，旧补丁无残留；
   下一次模型请求只看到新正文。
2. `select A→B→A` 后，`swipe_id` / `mes` / `variables` / 楼层 `stat_data` 与 A 一致；
   重复切换是 no-op，不新增 receipt。
3. edit / select 全程无新 turn、无模型请求、`sessions.fork` 零调用。
4. 缺 receipt / 不可迁移 legacy / duplicate 在追加事件之前返回 409，且 JSONL 不变。
5. CAS 冲突或保存失败不留部分变量；投影 pending 可见、可重试、重启可恢复。
6. 非 MVU（无导入变量历史）、ST、群聊行为不变；plain 卡 + `stat_data` 按 §6.5 放开；
   0021 / 0022 的 spec 全量通过（旧拒绝断言按新语义更新）。
7. P1：select 后 regenerate 以 selected candidate 为旧正文，旧 receipt 正确撤销，新补丁只应用一次；
   失败恢复的是 selected candidate，不是 anchor。
8. 重启 / 重放同一 body 事件只产生一次 receipt 变更；`lastBodyEventSeq` 与 checkpoint 一致。

## 12. 否决项

- **直接复用 0022 的 `prepare/restore` 做 edit/select**：会撤销同一 turn 的记忆、flat 变量与 settle receipt，
  事务单位错误。
- **select 时重新解析 B 的 `<UpdateVariable>`**：基线、guard、历史 failures 都可能不同，等于新写一次补丁，
  不是切换；缺 receipt 时应拒绝。
- **把 anchor 改成选中候选**：需要 assistant replacement 或新 turn，宿主语义不允许，也破坏 0021 的候选模型。
- **只改 `swipe_id` / `mes` 不改变量**：模型面与变量树分叉，下一次 regenerate 的 receipt 基数错误。
- **只改 `variables` 不改 `mvu.receipts`**：无法回滚、无法重放、无法检测重复应用。
- **删除缺 receipt 的候选或静默丢掉 receipt**：会把“不可证明”伪装成“安全”。
- **为每个候选 fork Session**：违背 0021 前提，破坏缓存与会话连续性。
- **把候选 receipt 放进独立 store**：本阶段保持 `chat_metadata.mvu.receipts` 单存储；sidecar 留到有体积证据后再评估。
- **在 P0 先放 select、后补 regenerate**：会直接产生 §2.5 的双写；这是本提案的硬门禁。
