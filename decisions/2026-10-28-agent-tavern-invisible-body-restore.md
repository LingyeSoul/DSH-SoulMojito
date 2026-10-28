# AgentTavern 正文恢复的 surface 方案：失败不再追加 assistant

> 日期：2026-10-28。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §6.2、`0023` §7.1、
> `packages/plugin/src/agent-tavern/body-runtime*.ts`。

## 问题

旧实现重生成一开始就用空 `developer/message` 把旧 anchor 移出模型面；失败时为了把旧正文
放回 surface，只能新开一个恢复 turn 并追加 `body-restore-*` 的 `assistant/message`。这条
消息不携带回滚元数据，但模型下一轮确实会看到一条新的 assistant 消息，等于能感知“发生过
恢复/回滚”。

DSH admission 又明确禁止 `assistant/message` 带 `sourceEventSeqs` 做 range replace，所以
不能把旧 anchor 原地“复活”。

## 决策

1. **延后隐藏**：重生成开始时不再隐藏旧 anchor，也不开 bridge turn；旧正文在新 turn 运行
   期间保持可见。模型看到的是“用户要求重写这段正文”的正常上下文。
2. **成功再隐藏**：`finalizeTurnStopping` 成功后，用空 `developer/message` replacement
   隐藏新 turn 的 trigger/process 节点，以及旧 anchor 与其旧 turn 的 process 节点；新候选
   保持可见。真实用户消息与 system prompt 不隐藏。
3. **失败只隐藏失败 turn**：`restoreBodyAfterFailure` 先回滚新 turn 写入、恢复旧 plan，
   再用一个 bridge turn 隐藏失败 turn 的 trigger/process 节点；不追加
   `assistant/message`、不追加 `restore` body 事件、不改 JSONL 正文楼层。旧 anchor 仍在
   surface，Agent 看到的就是操作前的正文。
4. **旧会话兼容**：旧版本在 start 时已隐藏 anchor 的会话，仍保留 `body-restore-*`
   assistant 副本 + `restore` 事件作为 fallback；是否走 fallback 由旧 anchor 是否仍在
   surface 判定。
5. **不 fork、不改提示词、不新增工具**：surface 操作仍只由插件 runtime 执行，恢复状态不
   进入模型面。

## 证据

- `npm run check`：158 test files / 2423 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS。
- body 聚焦：12 个 spec / 224 tests；runtime 37、wiring 35、projector 16、rollback 27。
- 关键覆盖：start 后 anchor 仍在 surface；成功结算后旧 anchor 被空 developer 替换、
  候选可见；失败恢复无新增 assistant、无 restore 事件、JSONL `mes/swipes` 不变；旧版本
  隐藏 anchor 的会话走 fallback；崩溃恢复两种分支；连续两次重生成。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 重生成上下文变化 | 旧正文在新 turn 运行期间可见，模型会带着旧正文生成新版本；这是预期语义变化。 |
| 晚失败 fallback | 若成功结算已 hide 旧 anchor 后 commit/op-finish 才失败，surface 已变，恢复会走 `body-restore-*` fallback，仍可能追加一条 assistant。 |
| 线上 `turn/end` 恢复缺口 | 当前 live `turn/end` 错误路径没有自动调用 `restoreBodyAfterFailure`，失败 turn 的 trigger/process 可能等启动恢复才隐藏；旧正文本身保持可见。 |
| 旧会话副本 | fallback 只服务旧版本已隐藏 anchor 的会话，新会话不再产生 `body-restore-*`。 |
| 无真机 E2E | 尚未跑 `dsh web` 浏览器闭环，需要指定 profile 并允许写 `$DSH_HOME`。 |

## 删除路径

- 停止新 surface 方案只影响后续操作；已存在的 `body-restore-*` 副本与 `restore` 事件保留，
  由 projector 按旧语义继续投影。
- 不得为了“清理 surface”删除历史 assistant/developer 事件；DSH 是 append-only 日志。
- `body-restore-*` fallback 可在一段兼容期后移除，但不能删除已落盘的恢复事件。
