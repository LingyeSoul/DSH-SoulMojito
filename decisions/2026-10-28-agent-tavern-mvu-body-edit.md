# AgentTavern MVU 正文编辑落地（P0）

> 日期：2026-10-28。状态：P0 已实现（工程验证通过）；MVU 候选切换仍为设计。
> 相关：`docs/proposals/0023-agent-tavern-mvu-body-switching.md`、
> `packages/plugin/src/agent-tavern/body-candidate-receipts.ts`、`body-projector.ts`。

## 问题

MVU 卡上的正文编辑此前被 `body-state-unsafe` 一刀切拒绝。旧正文的 `<UpdateVariable>`
已经改变量；直接改文本再投影会重复应用补丁，或者让 `chat_metadata.variables` 与正文
receipt 分叉。候选切换还要求区分 A/B 各自的补丁，风险更高。

## 决策

1. **候选级 receipt**：每个候选使用 `body:<messageId>#<candidateIndex>`；旧
   `body:<messageId>` 视为缺 index 的同一候选 receipt，首次编辑时惰性迁移，只改
   `turnKey`，保留 `at/status/changes/failures/undoneAt`。
2. **编辑事务**：在 projector 的同一 chat clone 内完成迁移 → 撤销旧 live receipt →
   应用新 `<UpdateVariable>` → upsert/删除候选 receipt → 更新 `swipes/mes/stat_data` →
   写 `lastBodyEventSeq`；由既有 CAS 保存，不新增 turn、不写 journal。
3. **只由插件触发**：edit 只走 `PUT /api/dsh-soulmojito/body`；不新增
   `body_*` / `rollback_*` / `edit_body` Agent 工具。receipt、迁移与回滚状态不进入提示词、
   tool result 或消息投影，Agent 只看到最终生效的正文。
4. **预检先于事件**：runtime 在追加 `edit` 事件前调用只读 `inspectEdit`；缺 receipt /
   duplicate / legacy 不可映射 / 槽位不匹配在追加前返回 409，保证零事件、零 chat 写入。
5. **门禁**：MVU `canEdit` 放开；`select` 仍返回 `candidate-switch-disabled`，直到候选感知
   regenerate 同批实现，避免切到 B 后重生成按 anchor A 找 receipt 造成双写。
6. **兼容**：`mvuReceiptsForBody` 与 `assertReceiptCoverage` 同时接受 legacy 与候选 key，
   迁移后 regenerate 不误报 `mvu-receipt-missing`。

## 证据

- `npm run check`：158 test files / 2421 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：12 个 spec / 222 tests；候选 receipt 核心 23、projector 16、runtime 36、
  wiring 34。
- 关键覆盖：legacy 迁移幂等、只应用一次、同一 edit 重放不二次撤销、无变量块回基线、
  缺 receipt / duplicate / 不可映射 legacy 拒绝、MVU `PUT body` 放行、select 仍 409、
  Agent 工具面无 body/rollback 工具。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| `canEdit` 乐观 | 已修：`GET body` 用只读 `inspectCandidateReceipts` 提前返回 `canEdit: false` + receipt detail；PUT 预检仍是最终裁决，GET/PUT 并发窗口仍在。 |
| 预检非原子 | 预检读 chat 快照，与 projector CAS 不在同一事务；并发冲突由 projector 重试/CAS 兜底。 |
| receipt 环形上限 | 默认保留策略优先保留 `body:` receipt，并为最新 settle 预留 1 槽；20 个候选满环时最旧候选仍会出局，切换时明确 `body-receipt-missing`，不静默错算。 |
| select 仍关闭 | 必须与候选感知 regenerate 同批；单独放开会产生双写。 |
| 正文恢复消息 | 已由 surface 决策处理：旧 anchor 可见时失败恢复只隐藏失败 turn 节点，不追加 assistant；仅旧版本已隐藏 anchor 的会话保留 `body-restore-*` fallback。 |
| 无真机 E2E | 尚未跑 `dsh web` 浏览器闭环，需要指定 profile 并允许写 `$DSH_HOME`。 |

## 删除路径

- 停止 edit 只影响后续操作；已迁移的候选 key 可继续被 0022 regenerate 读取，不回滚历史。
- 删除候选 receipt 前必须确认变量已回到候选基线；不得静默删除缺 receipt 的候选。
- 不把候选 receipt 写入独立 store；本阶段保持 `chat_metadata.mvu.receipts` 单存储。
