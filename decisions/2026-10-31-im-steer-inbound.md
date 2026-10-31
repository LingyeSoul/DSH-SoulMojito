# IM 入站改为「插话发送」（运行中 steer，空闲 followup）

日期：2026-10-31。状态：已实施。前篇：[2026-10-31-im-native-session-binding.md](2026-10-31-im-native-session-binding.md)。

## Problem

绑定原生会话后，IM 入站固定走 `agent.followup`：它永远落在 `next-turn`，模型要等当前 turn 结束才看到新消息。宿主官方 UI 的「插话发送」（Steer）走的是 `agent.steer`：running agent 在最近的 step 边界消费，idle agent 用它开启新轮。原实现把一个可用的官方 seam 降级成了「排队到下一轮」——长回合里用户发来的新消息会被拖到整轮结束。

## Evidence

- `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`：`steer(message)` 的契约是 "Submit steering for the nearest step. An idle driver starts a turn; a running driver consumes it at its next step boundary."
- `@deepseek-ai/dsh-api-session-controller/lib/index.js`：`prompt` 的 `mode === 'steer'` 直接调用 `agent.steer(message)`；`updateQueue` 的 `kind: 'steer'` 走同一路径。这就是官方消息队列 UI 的「插话发送」。
- 本仓库 `src/im/session-host.ts` 只调用 `followup`；`HostAgentLike` 也没有声明 `steer`。

## Decision

1. `insertImMessage(agent, message)` 按宿主状态选边界：
   - `agent.status === 'running'` 且宿主有 `steer` → `agent.steer`；
   - 其余情况 → `agent.followup`。
2. 两个 seam 都没有时报 `IM_SESSION_NO_INBOX`，不静默、不假装插入。
3. 消息形状不变：`role: 'user'` + plugin source（`form: 'relay'`）+ `summary`；模型仍用 `im_send` 回复。
4. `HostAgentLike` 增加可选 `steer?(message)`；旧宿主缺它时保持旧行为（全部走 followup）。
5. router 的投递 seam 从 `followup` 改名为 `insert`，避免把「可能是 steer」误读成下一轮。

## Consequences

- 长回合中收到的新消息在下一个 step 边界可见，不再等整个 turn 结束。
- steering 在取消/销毁时可能被宿主丢弃（宿主契约），因此只在 running 时用它；空闲仍走 followup，保留普通输入的 durable 语义。
- 不是「打断当前 token 生成」：仍在 step 边界生效，语义与官方 UI 一致。
- `steer` 是同步 `void`，`followup` 可能返回 promise；统一在 `insertImMessage` 里 await 失败面。
- 运行日志多一条 debug：`im insert: steer|followup into <session>`。

## Rejected

- **始终 steer（含空闲）**：空闲时没有可插入的当前步，且取消语义会丢消息；官方 UI 也只在 busy 时提供 steer。
- **插件自己排队**：宿主 inbox 已负责排队与幂等，插件不另造队列（提案 0024 §3）。
- **保留 `followup` 命名**：seam 语义已经不只是下一轮，改名避免后续维护者误判。

## Verification

- `im-session-host.spec.ts`：running → steer；idle → followup；缺 `steer` → followup；steer 同步抛错会变成 rejected promise。
- `im-router.spec.ts`：插入 seam 改名后全量通过（投递、去重、访问控制、未绑定提示）。
- `pnpm run check`：tsc（含 security）、全量 vitest、build、gates 全绿。
