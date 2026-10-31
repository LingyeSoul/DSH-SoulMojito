# 微信出站突发预算与 `-2 prepare failed` 冷却

日期：2026-10-31。状态：已实施。前篇：[2026-10-30-weixin-channel.md](2026-10-30-weixin-channel.md)。

## Problem

实机一个 IM 回合里，模型连续调用 `im_send` 57 次。前 12 条独立 `sendmessage` 在约 22 秒内发送成功；随后服务端开始对每一条返回：

```text
sendmessage returned ret/errcode -2: prepare failed
```

之后每次重试都继续失败，直到用户手动中止回合。同时 `context-tokens.json` 里该 peer 的 token 仍在更新（入站刚写过），因此不是「缺 context_token」或「token 过期」。

## Evidence

- session log：12 条成功 `sendmessage` 集中在一个约 22 秒的窗口；首条 `-2` 之后，`im_send` 把错误原样返回给模型，模型继续换措辞重发，失败面持续扩大。
- iLink 协议：`ret = -2` 是参数/请求错误；`errmsg = prepare failed` 在多个第三方适配器的现场记录里同时对应「会话未准备」与「bot 级突发节流」，并且明确记录 **在惩罚期间重试会延长惩罚**。
- 现有实现只有 `sendChain` 整轮串行，没有出站条数预算；发送路径的 `-2` 只被包装成 `WEIXIN_SEND_FAILED`，模型无法判断「不要重试」。

## Decision

1. **每账号 30 秒滑动窗口最多 5 条独立 `sendmessage`**（文字与媒体都计数，按 part 计）。第 6 条直接抛 `WEIXIN_SEND_BUDGET_EXHAUSTED`，请求不打到服务端。
2. **`ret/errcode -2` 识别为节流**：账号进入 5 分钟冷却，期间所有 `send` 直接抛 `WEIXIN_THROTTLED`，一个 `sendmessage` 都不发。
3. **发送路径也识别 `-14`**：立即暂停 1 小时，与轮询路径一致（此前只有轮询会设暂停）。
4. **IM preset 收紧**：微信每轮 1–3 条；`-2` / `WEIXIN_THROTTLED` / `WEIXIN_SEND_BUDGET_EXHAUSTED` 禁止在同一轮重试，如实说明一次并结束本轮。
5. 错误文本必须包含三件事：**未送达**、**不要重试**、**恢复时间**。

## Consequences

- 正常 2–5 条回复不受影响；30 秒内的第 6 条会失败，与 preset 的条数上限一致。
- 一条 `im_send` 被切成超过 5 个 part 时，后续 part 会失败；模型应改用更短的消息或分轮发送。
- 冷却是进程内状态：重启后允许再试一次（一次探测可接受，比无限重试安全）。
- 面板状态不新增 `paused` 态；节流通过 IM 运行日志 warning 与 `im_send` 错误可见。
- `sendChain` 保持：预算按请求计数，串行只保证顺序，不替代节流。

## Rejected

- **自动重试（带或不带 context_token）**：现场证据显示重试在延长惩罚；第三方「不带 token 也能成功」的结论互相冲突，不猜。
- **排队等待预算恢复**：57 条消息会把回合拖成几分钟，用户也看不出卡在哪里；立即拒绝更快暴露失控循环。
- **只靠提示词**：模型已经用 57 次调用证明不可靠；确定性护栏必须放在通道层。

## Verification

- `weixin-channel.spec.ts`：5 条后第 6 条被本地拒绝、服务端仍只收到 5 个请求；30 秒后恢复。
- `weixin-channel.spec.ts`：`-2` → `WEIXIN_THROTTLED`；冷却期第二次发送不发请求；5 分钟后恢复。
- `im-agent-preset.spec.ts`：preset 仍包含工具回复规则与 2–5 条上限，并新增微信 1–3 条与禁止重试。
- `pnpm run check`：tsc（含 security）、全量 vitest、build、gates 全绿。
