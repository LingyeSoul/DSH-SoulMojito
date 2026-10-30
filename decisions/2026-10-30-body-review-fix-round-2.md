# AgentTavern 正文审查第二轮修复：并发写归因、恢复时序、checkpoint 版本与出网净化

> 日期：2026-10-30。状态：已实现（全量 `check` 通过；真机 kill/E2E 待补）。
> 相关：`decisions/2026-10-29-body-review-fix-round.md`（第一轮决策第 1/3/8 条被本轮修正或扩展）、
> `docs/proposals/0021-agent-tavern-body-ops.md` §11、
> `0022-agent-tavern-write-rollback.md` §3、§7、§10。
> 代码面：`packages/plugin/src/agent-tavern/`、`packages/plugin/src/http/`。

## 问题

对 8922a19 的审查发现 3 条 High（静默改坏用户数据）与 2 条 Medium（隐私边界后门）：

1. **H1 before-only 探测把并发写当成自己的提交**（`body-rollback-writes.ts`、
   `tools/variable.ts`、`tools/memory.ts`）：`variable_set` 先写 before，随后带
   `expectedRevision` 的 `store.set` 因他人并发写抛 `VariableRevisionConflictError`，
   该组只剩 before。回滚探测看到 revision 变化即认定「我已提交」，把别人的快照当
   after 吞下，undo 用 `expectedRevision = current.revision` 必然 CAS 成功——并发写被
   静默覆盖；create 场景（before: null）直接删掉别人刚创建的变量。memory 三工具同型。
2. **H2 恢复序列先写旧 chat 后复核绑定**（`body-runtime-settlement.ts`、
   `body-rollback.ts`）：`undoNewCandidateBodyReceipt` 按 `plan.binding` 落盘在先，
   `assertPlanBindingCurrent` 在第三步 `restore` 内才执行；会话分支/改绑后旧 chat 被
   写入半回滚状态，restore 才抛 `body-rollback-target-missing`，重试时
   `live.length === 0` 静默跳过，半回滚永久残留。
3. **H3 历史 checkpoint 的真实损伤形态未被修复**（`projector.ts`）：父提交成功分支写
   `{status:'ok', lastCursor}` 不带 `pendingCursor`；旧 bug 留下的「seq 5 失败 →
   seq 6 成功覆盖成 ok」文件被 `isProjectedCursor` 判为已投影，seq 5 永久跳过。
   另外 `status:'pending'` 缺游标时补的 `lastCursor + 1` 可能指向不存在的 seq，
   会话被永久钉在 pending。
4. **M5 采纳失败的正文片段进错误链**（`body-jsonl.ts`、`projector.ts`、
   `http/router.ts`）：`adoption-mismatch` 消息嵌入至多 80 字符正文，经 checkpoint
   落盘与 `GET /projection` 出网——与第四轮 Z「删 plan.bodyText 避免第二份副本」
   的口径相悖。
5. **M6 lastOperation.reason 与 bodyFailureOf.message 绕过 HTTP 净化边界**
   （`body-runtime.ts`、`body-session.ts`、`body-view.ts`）：生产侧 `errorMessage(error)`
   原样持久化（fs 错误含绝对路径、`.tmp`/`.jsonl` 文件名），读侧折叠后原样出网；
   `http/public-error.ts` 的契约明确这类内容不得进 HTTP 响应。`bodyFailureOf` 的
   `message` 同型泄漏（未知异常 500 直接回显原始 message）。

## 决策

1. **journal failed 终结记录**：写工具的 store 调用抛错时向同一 journalId 追加单条
   无状态 `phase: 'failed'`（best-effort，业务错误优先抛出）；折叠时 before + failed
   直接判为未提交、永不进探测。`failed` 与 `noop` 同受 `assertStatelessShape` 约束：
   不得携带 before/after，不得与其他 phase 混用，必须紧跟 before。
2. **before 记录携带 payload + 归因校验**：`variable_set`/`variable_patch` 的 before
   记录新增 `payload`（各名字的目标值）；before-only 探测在 revision 变化时逐名校验
   当前值与 payload 深相等——对不上即 `write-journal-unknown` fail-closed，不把 foreign
   revision 当 after。旧 journal（无 payload）保持原 revision-diff 启发式，崩溃恢复
   行为零回归。memory 工具不做 payload 归因（需在探测端复刻 store 的记录规范化，
   耦合面大于收益），被捕获的失败路径由 failed 记录覆盖。
3. **恢复第一步前置复核目标**：恢复序列在 `rollbackNewTurnWrites` 之前执行
   `assertRestoreTargetCurrent`——经 port 工厂叠加的 `assertTarget(plan)` 能力复用
   `assertPlanBindingCurrent`（同错误码 `body-rollback-target-missing`）。port 缺该
   能力时保持旧时序（与既有 `plan?`/`apply?` 可选能力先例一致；生产 wiring 恒有）。
4. **checkpoint 版本升 2**：v1 文件在 `readCheckpoint` 归一化时整体重置为未验证态
   `{version: 2, lastCursor: -1, status: 'pending', pendingCursor: 0}`，由下一次
   replay 幂等全量重放重建可信水位（appendMessage 按 projectionIdentity 去重、body
   按槽位覆盖，全量重放幂等是既有测试不变量）。v2 丢失 `pendingCursor` 时保留
   `lastCursor + 1` 归一化；`replay()` 内 `clampPendingCursor` 把指向不存在 seq 的
   pendingCursor 钳到实际存在的下一事件，日志中再无 ≥ 它的事件则解除 pending。
5. **mismatch 错误只留长度元信息**：`adoption-mismatch` 消息改为
   `floor length N, anchor length M`，`textPrefix` 删除；错误链其余消息本就不含正文，
   checkpoint 落盘与 router 出网随源头收敛。
6. **出网边界单点净化**：`lastOperation.reason` 与 `bodyFailureOf.message` 在 view 层
   过 `publicErrorMessage`（干净文案原样通过，命中词表折叠为 `internal storage error`）；
   生产侧持久化保持完整原因以利排障。

## 否决项

- **不在 v1 ok 文件上按 `lastCursor + 1` 猜洞**：健康 v1 ok 文件会被整体钉成 pending，
  且真正损伤（洞在水位之下）对 `lastCursor + 1` 完全无效——该启发式只对 v2 成立。
  用版本号 + 一次性幂等全量重放替代，是上轮「保持可修复」承诺的超集兑现。
- **不在生产侧截断 reason**：排障需要完整原因；净化是 HTTP 边界的职责
  （`public-error.ts` 既有分层），在存储侧截断会让日志也失去证据。
- **不给 memory 工具做 payload 归因**：需复刻 store 记录规范化（createdAt/revision/
  source 缺省），探测端耦合 store 内部结构，脆弱度大于剩余崩溃窗口。
- **不在 port 接口上强制 `assertTarget`**：接口定义在共享契约文件，加必选方法会破坏
  既有 fake port；可选能力探测与该 port 既有 `plan?`/`apply?` 先例一致。

## 与上轮决策的偏差

| 上轮决策 | 本轮变化 | 理由 |
|---|---|---|
| 第 1 条「历史 checkpoint 丢失 pendingCursor 按 lastCursor+1 归一化」 | v1 不再猜洞，整体重置 + 全量重放；lastCursor+1 仅保留在 v2 | 洞在水位之下时 lastCursor+1 修不了，且会误伤健康文件 |
| 第 8 条「write-journal-unknown 仅 store 读失败路径使用」 | 扩展为第二种归因不可判定路径：before-only 组的 store 现状无法归因于本次写入（payload 对不上） | 该 detail 的文档语义本就是「无法判定是否已落库」，冲突场景正是归因不可判定 |
| 第 3 条「目标已不是 before 状态即视为已提交」 | 仅在当前值能对上本次 payload 时才视为已提交 | revision 变化也可能是他人的并发写；CAS 冲突是「有并发写」的证据，不是「我已提交」的证据 |

## 证据

- 全量 `pnpm run check`：tsc -b / typecheck:security / typecheck:plugin 通过；
  160 test files / 2671 passed + 1 skipped；`build:plugin` 成功；18 道 gate 全 PASS。
- 关键失败路径用例（修复前红、修复后绿）：
  - `never probes a before+failed group and keeps a concurrent write` /
    `records a null before plus failed when a guarded create cannot land`
    （并发写不被反向覆盖；create 场景不删他人变量）
  - `reports a before+failed group uncommitted when the store still holds the before state`
  - `refuses a before-only variable_set whose store holds a state the payload cannot explain`
    （payload 对不上 → `write-journal-unknown`）
  - `rolls back a before-only variable_set whose payload matches the store`
  - `refuses a runtime restore on a drifted binding before writing the old chat`
    （RED 证据：禁用前置复核时旧 chat revision 被改写、port 序列非空）
  - `reprojects events skipped by a legacy v1 checkpoint that a later success overwrote`
    （v1 带洞重放，含迁移后 `pending/-1/0` 中间态断言）
  - `does not pin a pending cursor at a seq the session log does not carry`（钳制）
  - adoption-mismatch 断言改为 `floor length 17` / `anchor length 16` + 正文
    `not.toContain`（`agent-tavern-body-jsonl.spec.ts:632`、
    `agent-tavern-body-projector.spec.ts:1231`，后者同时覆盖 status 落盘）
  - `collapses a stored regenerate failure reason that embeds an absolute path and an
    internal file name`（lastOperation.reason，另含 POSIX/.tmp 与干净文案两条）
  - `collapses an unknown exception message that embeds a store path`（bodyFailureOf）
- 既有回归复核：`rolls back a before-only variable_set whose store write committed`
  （旧 journal 启发式零回归）、rollback/rollback-integration/wiring/mvu-settle 全绿。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| memory 崩溃窗口 | 无 failed 记录的进程死亡 + 同 id 并发写时，memory_update/forget 仍按 revision-diff 启发式归因（variable_set/patch 有 payload 兜底）。 |
| variable_delete 观测不可分 | 目标「名字消失」与他人的 delete 在观测上不可区分（原理性）；被捕获的失败已由 failed 记录覆盖。 |
| 同值并发写 | 他人写入值恰等于本次 payload 时按已提交回滚——观测状态与「我已落地」完全一致，与完整 pair 行为一致。 |
| 第三方 port | 无 `assertTarget` 能力的自定义 port 回退旧时序（先写后拒窗口保留）；生产 wiring 恒经工厂，必然带能力。 |
| v1 迁移未持久化在读取路径 | replay 前每次重启都会重新迁移一次（幂等无害）；迁移后、replay 前 `GET /projection` 如实显示 `pending/-1/0` 未验证态。 |
| v1 pending 会话成本 | 修复从「按 pendingCursor 重放」变为「一次性全量重放」，长会话多付一次幂等重放。 |
| 词表固有边界 | reason/message 中不含词表特征的内部信息（内部用户名等）会被 `publicErrorMessage` 放行——分类器既有设计边界。 |
| 未修项 | 剩余 Low/Nit（router 降级不可达分支、canRegenerate 不看 editGate、store.ts ENOENT 契约、cloneChatRecord 形状、快照缓存测试钉 claim、settle-intent fail-open、importedMirrorAnchorText 上界、歧义错误放大、\0 缓存 key）留待下一轮；M1-M4 已在本文件末节收口。 |
| 无真机 E2E | 构造日志验证，没有进程 kill / 浏览器 E2E。 |

## 删除路径

- 停止写 `failed`/`payload`：旧 journal 记录仍按原启发式解析，探测端无需迁移；
  移除归因校验只回退到「revision 变化即视为已提交」的 H1 行为，不建议。
- `assertTarget` 是可选能力：移除 runtime 侧探测调用即回退旧时序；port 工厂保留
  能力不影响其他调用方。
- checkpoint v2 写入是单向的：v1 重置只发生在读取归一化（内存），磁盘 v1 文件在
  replay 成功前不被改写；读端接受 1|2 两版本。
- `publicLastOperation`/`publicErrorMessage` 包裹只影响 HTTP 出网文本；去掉即回退
  原样透传，无持久化数据依赖。

## 第二批修复（同日：审查 M1-M4）

四条 Medium 逐条「先验证、再修复」后全部成立并收口：

1. **M1 replay 与实时事件交错**（`projector.ts`）：replay 逐事件入队，seq 4 投影的
   store I/O 期间实时 seq 6 插队先把 `lastCursor` 推到 6，随后 seq 5 被
   `isProjectedCursor` 判已投影、永久跳过。RED 实测复现（seq 5 楼层缺失）。
   **修法**：整个 replay 扫描作为单个 tail 任务入队，内部直调 `projectOne`；实时事件
   只能排到整个扫描之后。v1 重置、`clampPendingCursor` 逻辑不变（执行位置移入任务内，
   顺带消除「cache 删除→clamp 读盘」间的插入竞态）。对已持久化 `pendingCursor` 的
   失败 seq，上一批的 `advanceCheckpoint` 本就冻结水位——本条残余窗口是无
   `pendingCursor` 的积压事件。
2. **M2 同 turn create+delete 探测顺序**（`body-rollback-journal.ts`）：探测正序、
   undo 逆序；before-only 的 create 因「名字已消失」判未提交跳过，同 turn 更晚的
   delete 组 undo 又把变量复活，终态多出 turn 前不存在的变量（H1 的 payload 归因
   在 `committed === false` 时不参与，挡不住）。**修法**：before-only 判「未提交」时
   新增 `assertNoLaterGroupTargets`——同 turn 更晚的 write/pending 组命中同一 target
   （变量按 scope/scopeId/name、memory 按 id）即 `body-state-unsafe` +
   `write-journal-unknown` fail-closed（词表零新增）；更晚的 `failed`（uncommitted）
   组可证明零写入，不触发。committed 判定路径不动。
3. **M3 restore 副本认领依赖 selectedIndex**（`body-runtime-settlement.ts`）：首次
   restore 写副本后 `appendOpAbort` 失败/进程死亡 → 用户 select 切走 → 重试时
   `restoredAnchorOf` 因 `selectedIndex !== previousIndex` 认不出已有副本，追加第二份
   旧正文。**修法**：restore 事件携带 `opId`（沿 `rollbackPlan` 的 extra-field 先例，
   共享词表不动），认领按 opId 优先、以「副本仍在 surface」为证明；无 opId 的旧记录
   回退原 selectedIndex 启发式（append-only，不改历史）。select 不加 pending 检查
   （opId 认领后 select 移动选中已不破坏幂等，加检查只会改变 409 行为面）。
4. **M4 补偿失败锁死到重启**（`body-wiring.ts`、`http/router.ts`）：start 失败且
   补偿失败时 op 留在 `pendingByAgent`（设计如此，防二次污染），但 start 失败路径
   不设 pending.turn，turn/end 重试链与启动/agent-created 恢复都接不到，用户只见
   无句柄的 500 + 后续全部 `session-busy`。**修法**：HTTP 变更 catch 里对携带
   pending op 且仍在进程内加锁的失败做**一次**进程内恢复重试（交给启动同款共享恢复
   `recoverBodyOperationWith`）；锁解除则正常返回失败（不带句柄），仍锁则失败响应
   附 `pendingOperation: {opId, status:'pending'}` 并打结构化 `left op` 日志。
   durable `op-start` + plan 不动，恢复句柄不丢；`session-busy` 拒绝不带 op，不会
   形成重试风暴。

### 第二批证据

- 全量 `pnpm run check`：160 test files / 2680 passed + 1 skipped；18 道 gate 全 PASS。
- 新用例（四条均有修复前红证据）：
  - `does not let a live event interleaving with replay permanently skip a backlog seq`
    （RED：`['Step inside.', 5]` 缺失）
  - `refuses a same-turn create whose later delete would resurrect it on undo` /
    `refuses same-turn create and delete groups that both lost their after record`
    （RED：`expected the rollback to refuse`）；对照 `later delete of the same name failed`
    修复前即绿
  - `claims an earlier restore copy by opId after a candidate switch instead of
    appending a second old-body copy`（RED：重试返回了第二个 `body-restore-*` id）/
    `claims a legacy restore record without opId through the restored selection proof`
  - `retries the recovery once and surfaces the pending op handle when the restore
    keeps failing` / `unlocks the session when the retry recovery completes the restore`
    （RED：零条 `retrying recovery` 日志；响应无 `pendingOperation`）
- 定向回归：projector/body-projector 59、write-journal/mvu-rollback/rollback 107、
  rollback-integration/rollback 53、wiring 79（含全部 H1-H3/M5/M6 既有用例）。

### 第二批风险与未完成

| 风险 | 说明 |
|---|---|
| M2 fail-closed 运维成本 | 同 turn create+delete 且 create 丢 after 时回滚整体拒绝（409）需人工介入；「从新到旧维护工作状态」可正确解析为终态，留待后续。更晚 pending 组即使随后判 uncommitted 也计入（保守取舍）。 |
| M2 memory committed 路径 | memory_write before-only + 同 turn forget 的 committed 路径仍以 `body-rollback-conflict` 失败收场（有报告、非静默，既有用例已 pin）。 |
| M3 旧记录盲区 | 修复前已落盘的无 opId restore 记录，切过候选再重试仍走旧启发式（append-only 约束）；仅新写入免疫。opId 认领不比 groupId（跨组同 opId 属篡改/损坏日志场景）。 |
| M4 重试边界 | 只做一次进程内重试，不释放写工具限制（防未回滚的写被继续污染）；持续失败的会话仍锁定到启动恢复，但用户现在拿到 opId 句柄与结构化日志。多进程同会话不在此列（单写者模型既有边界）。 |
| M1 扫描期间实时延迟 | 长积压全量扫描期间实时事件排队等待（原先可插队）——顺序换正确性。 |
| 无真机 E2E | 同前。 |
