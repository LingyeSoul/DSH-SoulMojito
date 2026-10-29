# AgentTavern 正文审查收口：游标、journal 探测、op-abort 与读侧 lastOperation

> 日期：2026-10-29。状态：已实现（工程验证通过；真机 kill/E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §6.2、§7.3、§9.2、
> `0022-agent-tavern-write-rollback.md` §3、§7、§10、
> `0023-agent-tavern-mvu-body-switching.md` §3.2、§4.3、§6。
> 代码面：`packages/plugin/src/agent-tavern/`、`packages/plugin/src/http/router.ts`。

## 问题

本轮审查围绕「AgentTavern 正文操作在崩溃、失败与重放下的可解释性」列出 8 条 Critical：

1. **投影游标只有一个标量水位**（`projector.ts`）：seq N 失败后，后续 seq N+1 成功会把
   `lastCursor` 推到 N+1，失败的 N 被永久跳过，JSONL 永久缺层。
2. **写工具 noop 没有 journal**（`write-journal.ts`、`tools/memory.ts`、
   `tools/variable.ts`）：目标不存在或 scope 被策略拒绝时没有业务写，也没有 journal 记录；
   覆盖率检查把工具调用当成「journal 丢失」，regenerate 的 rollback 保护被误拒。
3. **before-only 组一律当未提交跳过**（`body-rollback-journal.ts`、
   `body-rollback-writes.ts`）：`after` 追加失败可能发生在 store 已接受写之后；旧逻辑
   直接跳过会漏回滚已落库的写。
4. **导入楼层采纳不是原子写、也可能绑错楼层**（`body-jsonl.ts`、`body-projector.ts`）：
   历史镜像楼层没有 `agentTavern` 元数据，candidate 投影 `body-floor-not-found`、
   checkpoint 停 `pending`、编辑 503；旧采纳还可能把 group 绑到并非该 anchor 镜像的楼层。
5. **恢复完成缺少 durable 终态**（`body-runtime-settlement.ts`、`body-runtime.ts`）：
   `restore()` 成功后没有 `op-abort` 记录，重复恢复会把同一操作当 pending 再恢复一次；
   `foldPendingOps` 也无法区分「旧正文已回来」与「新正文已结算」。
6. **start 失败且补偿失败仍写 `op-finish`**（`body-runtime.ts`）：旧写尚未恢复时写终态，
   唯一的恢复句柄（op-start + plan）被丢掉。
7. **回滚身份漂移**（`body-runtime.ts`、`body-recovery.ts`）：`body-restore-*` 副本成为
   anchor 后，下一轮 prepare 与失败 turn 的新候选 receipt 仍按 surface anchor 定位，
   会漏 old turn / `body:<messageId>` receipt。
8. **读侧不可见 + 时间戳不确定**（`body-view.ts`、`body-session.ts`、`router.ts`、
   `projector.ts`）：`GET body` 看不到最近一次 abort/failed/cancelled；通用 `eventDate`
   用 `Date.now()` 兜底，同一份 session 两次重放会写出不同 `send_date`。

## 决策

1. **游标最小洞**：checkpoint 增加 `pendingCursor`（最低未完成 seq）。`lastCursor` 只在
   无洞或正好补上 `pendingCursor` 时推进；失败 seq 之后的成功不得越过洞。`replay` 重新读
   磁盘 checkpoint，避免进程内缓存掩盖 pending。历史 checkpoint 丢失 `pendingCursor`
   时按 `lastCursor + 1` 归一化，保持可修复。
2. **journal noop 记录**：写工具在「目标不存在 / scope 被拒」时追加单条 `phase: 'noop'`，
   证明这次工具调用没有业务写；`noop` 不得携带 before/after 状态，也不得与其他 phase 混用。
   覆盖率检查只把有 journal（含 noop）的工具视为已覆盖。
3. **before-only 探测**：只有 `before` 的组按 store 现状验证——目标已不是 before 状态即
   视为已提交，转成完整 pair 回滚；仍是 before 状态报 `skippedUncommitted`；无法验证
   （旧 journal 缺 names、目标消失、store 读失败）fail-closed，禁止静默跳过。
4. **op-abort 终态**：新增独立 plugin record `plugin:dsh-soulmojito/body-abort`
   （`op: 'op-abort'`、`opId`、`reason`、可选 `anchorId`）。`foldPendingOps` 只认
   `op-finish` 与 `op-abort` 两条终态；重复 abort 幂等，引用无 op-start 的 abort 以
   `invalid-event` fail-closed。`op-finish` 仍只表示「新正文已结算（或已完全补偿）」。
5. **采纳原子化**：`adoptImportedAnchorFloor` 把 anchor 文本当唯一 witness，文本不匹配即
   `body-adoption-mismatch`；采纳与 candidate 投影在同一 chat clone / 同一 CAS 写内提交，
   任一后续失败丢弃整个 clone。被丢弃的 ST swipe 表面快照进
   `extra.agentTavern.adoptedSwipes`（读侧忽略），不做不可逆删除。
6. **receipt 迁移（复核既有路径）**：legacy `body:<messageId>` 只在 ledger 能唯一映射到
   slot 时迁成 `body:<messageId>#<index>`；不能唯一映射保持 `body-receipt-legacy` 409，
   不猜测。失败 turn 的新候选 receipt 在旧 plan 重放前撤销，避免唯一变量路径残留。
7. **读侧 `lastOperation`**：`readBodySessionFacts` 按 seq 折出最近一条非成功终态
   （`op-abort` → aborted、`op-settle-cancelled` → cancelled、`op-finish failed` →
   failed），只在存在时随 `GET body` 返回 `{ opId, status, reason, at? }`。畸形 abort
   记录不让读侧 500：复用 `ledgerError` 降级路径返回稳定 body 并记 warn。该字段纯展示，
   不改任何 fail-closed 判定、`publicBodyCode` 与默认空 body。
8. **before-only 专属 detail**：`write-journal-unknown` 表示「journal 只有 before 且无法
   判定是否已落库」，HTTP 仍按 `body-state-unsafe` 映射 409 并保留 detail；journal 形状
   错误继续用 `write-journal-missing`，两者不混用。
9. **通用时间戳校验**：`projector.ts` 的 `eventDate` 与 `body-projector.ts` 对齐——
   `time` 必须是非负安全整数且落在 `Date` 可表示范围内，非法即抛错（消息带 seq/type）；
   移除 `Date.now()` 兜底。`NativeSessionEvent.time` 是宿主事件契约的必填字段，类型上不
   存在合法的 `undefined` 调用；历史/损坏事件缺 `time` 会被同一检查拒绝，不静默定时。

## 否决项

- **不用 `Date.now()` 兜底**：兜底让同一份 session 的重放结果依赖读时刻，checkpoint 与
  JSONL 无法复现，且把损坏事件伪装成正常楼层。宁可抛错让 replay 停在 pending，由
  `POST /projection/replay` 在数据修复后重放。
- **不用单一 `op-finish failed` 承担两种语义**：`op-finish failed` 已表示「新正文结算
  失败但已补偿 / 已结算只缺收尾」，而 restore 成功表示「旧正文已回到 surface」。混用会让
  恢复把已回滚的操作当结算处理（或反向重复 restore），无法幂等判断；因此保留独立
  `op-abort`。
- **不改读侧为 500 暴露畸形记录**：`GET body` 是渲染路径，损坏记录应降级为稳定 body 并
  在日志可见，而不是让整行正文消失。
- **不放宽 before-only 跳过**：静默跳过会把「已落库但丢 after」的写留成孤儿。
- **不做客户端补丁/fork**：展示层无法证明 durable 终态，违反 proposal 的日志裁定权。

## 与提案 0021/0022/0023 的偏差

| 提案 | 偏差 | 理由 |
|---|---|---|
| 0021 §9.2 | 终态原表述为 `op-finish`；新增第二条终态 `op-abort` | restore 语义与新正文结算必须可区分，否则重复恢复不幂等 |
| 0021 §7.3 | `GET body` 响应新增可选 `lastOperation` | 既有字段与默认空 body 不变，仅追加只读展示字段 |
| 0022 §3 | before-only 组由「reported and skipped」改为 store 验证 | `after` 追加失败可能发生在 store 写之后 |
| 0022 §7 / 0023 §6.4 | detail 词表新增 `write-journal-unknown` | 需区分「journal 丢失」与「只有 before、无法判定」；HTTP 仍是 409 + `body-state-unsafe` |
| 0022 §10.3 | 新候选 receipt 撤销排在旧 plan 重放之前 | `rollbackTurnWrites` 不拥有 body receipt，必须单独撤销 |
| 0023 §3.2 | 撤销按 ledger 选中 candidate 的 message id 定位，不按 surface anchor | restore 副本成为 anchor 后按 anchor 会漏 receipt 与 old turn |
| 0021 §2.2 | 采纳只改楼层元数据与 swipe 表面，不删消息、不改 `mes` | 提案明确投影不得删消息 |

## 证据

- 上一轮全量 `check`：158 test files / 2581 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- 本轮（未重跑 `build:plugin`，避免改写 `index.mjs`、`client/*.js` 生成物）：
  - 必跑 3 个 spec：`agent-tavern-body-client`、`agent-tavern-projector`、
    `agent-tavern-body-wiring` 共 98 tests 全部通过。
  - 全量 `vitest run`：158 test files / 2591 passed + 1 skipped。
  - `typecheck:plugin` 与 `typecheck:security`：均无输出（通过）。
  - gate runner 直接运行（只读生成物）：18 道 gate 全部 PASS。
- 关键覆盖：
  - `reports the latest aborted operation on GET body`（op-settle-cancelled → failed →
    abort，按 seq 取 abort，`at` 来自事件时间）
  - `omits lastOperation when no terminal failure is recorded`
  - `degrades a malformed abort record to a logged warning instead of a 500`
  - `keeps the before-only write-journal-unknown detail on a 409`
  - `writes a deterministic send_date from the event time`
  - `rejects an unusable event time -1 / 1.5 / NaN / 8640000000000001 ...`
  - `rejects a time-less historical event instead of inventing a send date`
- 既有回归（上一轮已绿、本轮复核通过）：`reprojects a failed event on replay after a
  later success advanced the cursor`、`keeps the lowest unfinished cursor across
  consecutive failures`、`accepts noop journal records as proof that a tool call wrote
  nothing`、`rolls back a before-only variable_set whose store write committed`、
  `closes an operation only on op-abort and rejects malformed abort records`、
  `keeps a commit failure pending and restores the previous body on restart`。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 生成物 | 全量 `check` 已统一重建 `index.mjs`、`client/*.js`、`version.json`；提交前复核生成物 diff 即可。 |
| `at` 缺省 | 记录没有可用宿主时间时 `lastOperation.at` 缺省，不用读时刻补齐。 |
| 畸形终态 | 畸形 abort/failed 记录只降级为「无 lastOperation + ledgerError 日志」，界面不回显损坏原因。 |
| before-only 验证边界 | 仅 store 读失败的探测路径用 `write-journal-unknown`；journal 形状错误（缺 names、目标消失）仍为 `write-journal-missing`。 |
| 无真机 E2E | 构造日志验证，没有进程 kill / 浏览器 E2E；真实崩溃窗口仍靠日志回放覆盖。 |
| 采纳快照 | `adoptedSwipes` 只做手工恢复依据，读侧不消费；没有自动还原入口。 |

## 删除路径

- 停止写 `op-abort` 只影响后续 restore；已写记录仍是唯一终态证据，不得删除（DSH 日志
  append-only）。
- 停止读 `lastOperation` 只需移除 `GET body` 的透传，不影响任何判定与历史记录。
- `write-journal-unknown` 是 detail 词表成员；旧记录不受影响，读取端按 `body-state-unsafe`
  处理即可。
- 停止 store 验证 before-only 会退回「一律跳过」的漏回滚行为，不建议；历史 journal 无需迁移。

## 后续收口（同日第二轮 / 第三轮）

第一轮的 8 条 Critical 落地后，又按「失败必须留下可处置句柄」逐节点收口：

### 第二轮（S / T / U）

- **S 结算**：剩余 6 处 `failSettlement` 分支全部改为「记录 cancellation → 释放写工具 →
  保持 op-start pending」，由 turn/end 或启动恢复执行 `rollbackNewTurnWrites + restore(plan)`
  ；`restore` 前用实时 binding 复核 `plan.binding`（改名/篡改/解绑一律
  `body-rollback-target-missing`）；`apply` / `restore` 的 saveChat 失败补 journal + receipt
  双向补偿，只有两边都干净才 `compensated: true`。
- **T settle intent**：supersede 时对已 decision 的旧 intent 幂等补 `appendMvuReceipt`，无
  decision 的先回滚 before；新增 `afterVersion: 2` + `effectiveAfter`，abort 只重放 guard
  后的实际落库值；提交后的关闭/审计降级为 warnings，不再误报失败诱发重复 receipt。
- **U 读侧**：`wiringEvents` 改为逐事件降级（只有 body 事件严格）；数据/状态类 `body-*`
  错误统一 409 `body-state-unsafe` + 原始 code 作为 detail，`projection-pending` 保留 503；
  客户端 `api()` 挂载 detail 并按 `code + detail` 出文案；`candidatePreserveKeys` 惰性化；
  同 `bodyGroupId` 多楼层读/写都拒绝并列出索引。

### 第三轮（V / W / X）

- **V 读侧与恢复**：新增 `locateBodyFloorForRead` 并让 `GET body` 复用同一套唯一性校验，
  歧义时返回 ledger 文本 + `detail: 'body-group-mismatch'`，不显示第一条楼层；`applyRestoreToChat`
  回写 `swipe_id` / `mes`，slot 缺失显式抛错；编辑路径只在确实需要 receipt 时校验 key 语法。
- **W 跨 store 事务**：单条 settle receipt 改为「先规划全部变量项、后执行」，执行失败时按
  名字逆序补偿本条已写项；补偿失败抛 `body-rollback-partial` 并携带结构化 evidence，receipt
  保持未标记可重试。
- **X 读性能**：`getChatSnapshot` 增加按 chat 文件 `size + mtimeMs + ino` 指纹的进程内 LRU
  缓存（上限 64，命中返回深拷贝）；`createChat` / `saveChat` / `renameChat` / `deleteChat` /
  `branchChat` / `forkChat` / 角色改名/删卡全部显式失效。合成 4000 条消息会话实测单次读取
  ~7 ms → ~1 ms。
- **文件预算**：`body-candidate-receipts.ts` 超过 800 行后，把 key grammar 与 ledger slot
  witness 拆到 `body-candidate-keys.ts`，原模块 re-export 保持入口不变。

### 收口后验证

- 全量 `pnpm run check`：159 test files / 2634 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS；`typecheck:plugin` 与 `typecheck:security` 均通过。

### 仍然存在的边界

| 边界 | 说明 |
|---|---|
| GET 歧义 detail | `body-group-mismatch` 只在路由层加宽 detail，`body-view.ts` 的 gate 词表未扩；歧义时 `canEdit` 仍可能为 true，真正提交会 409。 |
| 面板渲染成本 | 缓存只把常数降 6~7 倍；`GET body` 每行仍会拿到一份完整深拷贝，结构性修法（批量接口）未做。 |
| 外部写入 | 外部工具原地写且保持 size、回拨 mtime、文件系统无 inode 时指纹可能相同，返回旧解析；仓库内写路径靠显式失效覆盖。 |
| 单 receipt store 已写后抛错 | 当前按「未写入」处理，不纳入按名补偿；与既有 `applyJournalWrites` 语义一致。 |
| ledger 缺失修复 | `previousIndex !== 0` 且 ledger 完全缺失时持续 pending，尚无自动修复工具。 |
| adoptedSwipes | 只做手工恢复依据，没有自动还原入口。 |
| 真机验证 | 仍是构造日志/单测，没有进程 kill 与浏览器 E2E。 |

## 第四轮（Y / Z + 集成收口）

- **Y 读路径**：`GET body` 增加批量形式 `messageIds=a,b,c`（≤50、去重、与单 id 混传 400、单项异常隔离），
  一次请求内共享 state/character/chat snapshot/session facts source，单 id 响应完全不变；客户端把同一批
  可见行合并为一次请求，失败或缺项逐条回退单 id。
- **Y 词表**：`body-group-mismatch`（读侧歧义）与 `body-floor-unreadable`（非歧义读取失败）进入
  `BodyStateUnsafeDetail`，歧义时 `canEdit=false`，路由侧的临时加宽类型删除。
- **Y 客户端**：投影刷新预算耗尽后删除条目，不再残留 `{attempt, timer: undefined}`。
- **Z 校验**：`body-projector` 三处「post-fold 校验本条事件」的恒假防御改为对 `seq-1` 前态的事实校验
  （select 校验前态 anchor 可解析；restore 校验恢复副本真实存在）；无法表达的一半删除并在注释写明由
  fold 结构保证。
- **Z 诊断**：projector 找不到目标 chat 的错误消息补 character/chatId/session/seq/groupId。
- **Z settle 保留**：`DEFAULT_SETTLE_RESERVED` 1 → `MVU_SETTLE_RECEIPTS_RESERVED = 3`，并提供显式覆盖
  入口；body 候选优先与总量上限不变。
- **Z 隐私**：`BodyRollbackPlan.bodyText` 生产侧不再写入（避免 append-only 会话日志出现正文第二份副本），
  解析侧仍接受旧 plan 的该字段以保证恢复兼容；集成测试改为断言新 plan 不含该字段。
- **Z 审计**：`MemoryStore.restore` 的审计 `at` 用写入时刻，被恢复记录的 `updatedAt` 移入 `recordUpdatedAt`。
- **集成**：`body-session.ts` 超出 800 行预算后拆出 `body-session-contract.ts`（宿主切片/日志/基础守卫）
  与 `body-session-agents.ts`（live agent 与 binding 解析），主模块 re-export 保持入口不变，降至 747 行。

### 第四轮验证

- 全量 `pnpm run check`：160 test files / 2652 passed + 1 skipped；`build:plugin` 成功；18 道 gate 全部 PASS。

### 第四轮后仍存在的边界

| 边界 | 说明 |
|---|---|
| 批量内部复杂度 | 批量仍逐 id 扫描 chat 快照（`locateBodyFloorForRead`），不再重复读盘/重复折叠，但仍是内存级 O(行数 × 消息数)。 |
| 客户端批量验证 | 只有源码级断言，没有浏览器 E2E；极端分片渲染会退化成多批（仍远少于每行一次）。 |
| 逗号 id | `messageIds` 以逗号分隔，id 含逗号时批量形式不可用；当前 message id 不含逗号。 |
| ledger 缺失修复 | `previousIndex !== 0` 且 ledger 完全缺失时持续 pending，尚无自动修复工具。 |
| adoptedSwipes | 只做手工恢复依据，没有自动还原入口。 |
| 真机验证 | 仍是构造日志/单测，没有进程 kill 与浏览器 E2E。 |
