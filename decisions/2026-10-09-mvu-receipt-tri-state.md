# 决策：MVU 回执状态收窄为三态

日期：2026-10-09。状态：已实施（补记录窄）。相关：提案 0012（§1 回执五态、§4 裁剪范围）、`packages/plugin/src/mvu.ts`、`packages/plugin/src/agent-tavern/agent.ts`（settle 工具）。

## Problem

提案 0012 §1 要求回执「区分已更新/未变化/部分成功/过期/中断」五态；实现是三态 `MvuReceiptStatus = 'updated' | 'unchanged' | 'failed'`（mvu.ts），部分成功直接落 `failed`，「过期」「中断」没有对应状态，原因/脚本联动字段也未落。§4 的明确裁剪清单没有收录这次收窄——设计文档与实现口径不一致。

## Decision

维持三态并补记收窄理由。逐态核对后发现缺失的两态对应的是**不走回执的异常路径**，把它们塞进回执反而会破坏既有纪律：

1. **「过期」= CAS 版本冲突，走 409 异常不落回执**。变量写穿经 `saveChat` 的 revision CAS；冲突时抛 `ChatRevisionConflictError`（ST 链路 mvu.ts:408-410 → 路由 409；AgentTavern settle 工具同款），由调用方重调工具重试——变量已写、回执未落，重试幂等（agent.ts 注释明示该纪律）。若改为落一条 `stale` 回执再重试，成功路径会留下两条回执污染「每轮一条」的展示假设。
2. **「中断」= abort/渲染异常，同样无回执**。`exec.signal?.throwIfAborted()` 直接抛出（agent.ts），流程未到回执落盘点；重试路径的渲染失败进 `failures` 明细（mvu.ts retry），正文与已写变量不受影响。
3. **「部分成功」并入 `failed`，但信息不丢**：结算逐项隔离（单项失败只进 `failures`，成功项照记 `receiptChanges`），面板与重试都能从回执明细里区分「全失败」与「部分成功」。加一个 `partial` 态的收益只是状态徽章颜色，代价是 `readMvuReceipts` 的读取过滤、客户端两套 i18n 枚举（en/zh）与徽章 CSS 全要跟着扩——收益不抵漂移面。
4. **「原因/脚本联动」字段**：确定性脚本结算下，失败原因即 `failures[].reason`（逐项携带）；「脚本联动」在单脚本结算模型里没有独立语义（就是结算本身）。

顺带记录一个既有口径差异：重试路径（`retryMvuSettlement`）只重跑渲染写穿，不产生 `failed` 回执（mvu.ts 注释），与 settle 工具的三元判定（有 failures 即 `failed`）是两条路径各自正确的语义，不是不一致。

## Alternatives considered

- **补齐五态**：需要动三处状态计算、`readMvuReceipts` 三态过滤（tavern-mvu.spec.ts:122-127 锁定了过滤行为）、客户端 en/zh i18n 与 `dt-mvu-badge-*` CSS、并把 CAS 冲突从 409 异常改道为回执——最后一步会破坏「重试幂等、不留脏回执」的纪律。拒绝。
- **只加 `partial` 不加另两态**：五态变四态仍是「与提案不一致」，且要动读取过滤与 i18n，收益最小。拒绝。

## Consequences

- 提案 0012 §4 补录本收窄并引用本决策，§1 的五态描述保留为「目标行为归纳」（clean-room 来源），实现口径以本决策为准。
- 三态口径由 `tavern-mvu.spec.ts`（含 'weird' 状态被丢弃的过滤锁定）与 `agent-tavern-mvu-settle.spec.ts`（部分成功落 failed 的锁定用例）双向锁定。
- 未来若面板需要区分「部分成功」，加 `partial` 态时必须同步：状态计算三处、readMvuReceipts 过滤、客户端 i18n ×2、徽章 CSS——清单记在这里防漏。
