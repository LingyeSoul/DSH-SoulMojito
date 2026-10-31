# QQ 账号启动被 access_token 超时打断 → 网络类启动重试

> 日期：2026-10-31。状态：已落地。前置：[`2026-10-30-qq-channel.md`](./2026-10-30-qq-channel.md)。

## 问题

扫码绑定 QQ 机器人成功后账号启动失败：

```text
qq account '<redacted>' failed to start: the QQ gateway refused to start:
Network error getting access_token: This operation was aborted
```

绑定本身成功（凭据已落库），失败发生在安装通道后的第一次 `bot.start()`。

## RCA

链路（逐段读过源码）：

`startQrBind` → `im/qq/bind.ts` 的扫码状态机 → `onSuccess` → `adoptQQCredential` →
`upsertAccount` → `store.putAccount` → `installSingleChannel` → `channel.start(lifetime.signal)` →
`createBot(...)` → `void bot.start()`。

`access_token` 请求的 abort 来源只有一处，其余全部排除：

| 候选 | 结论 | 证据 |
| --- | --- | --- |
| `runtime.lifetime` 被 dispose/热重载中止 | 排除 | 只在 `dispose` 里 `lifetime.abort()`（`src/im/runtime.ts:708`）；它经 `installSingleChannel`（`:329`）进 `QQChannel.start`，只触发 `bot.stop()`，而 `bot.start()` 本身**不带 signal**（`src/im/qq/channel.ts:270`）。 |
| `bind.ts` 的 `controller` 被 cancel/清理误用 | 排除 | 每个绑定会话新建（`bind.ts:92`），只传给连接器（`:155`）；`cancel()`（`:170-181`）才 abort，`onSuccess` 路径（`:129-147`）不 abort。 |
| 连接器结束后 abort 共享客户端 | 排除 | 连接器返回的取消函数只 abort 它自己的 controller；扫码成功后它自然返回，插件不会调用 `stop()`。绑定 session 与网关 QQBot 没有共享对象。 |
| `upsertAccount` 停掉旧通道时连累新通道 | 排除 | `installSingleChannel`（`runtime.ts:320-335`）只在装新通道前停同 key 的旧实例；新 QQBot 每次都是新实例，TokenManager/ApiClient 也按实例构造（qqbot-nodejs `src/QQBot.ts:323-332`）。 |
| SDK 内部的固定超时 | **成立** | `@tencent-connect/qqbot-nodejs@1.0.5` 的 `src/protocol/api/token.ts:13` 写死 `DEFAULT_TOKEN_TIMEOUT_MS = 10_000`；`:198-199` 为这次请求新建本地 `AbortController` 并 `setTimeout(abort)`，`:210` 作为 fetch 的 signal，`:214` 把 AbortError 包成 `Network error getting access_token: ...`。 |

实测复现（本机，Node 24）：用不响应的本地 HTTP 桩做 token base URL，`TokenManager.getAccessToken()`
在 **10010ms** 后抛出 `Network error getting access_token: This operation was aborted`，
`cause` 为 `AbortError: This operation was aborted` —— 与真机错误逐字一致，且调用方
根本没有传 signal。

结论：abort 来自 SDK 自己的 10s 固定超时。**为什么这次请求超过 10s（慢网/代理/瞬时抖动）
属于环境侧，未取证**，本文不把它写成结论。

## 方案

- 新增 `src/im/qq/start-retry.ts`：重试策略。最多 3 次尝试，退避 1s、2s；只认网络类失败
  （`Network error getting access_token`、`Network error [path]`、常见 socket errno）。
- `src/im/qq/channel.ts`：`start()` 拆成「重试循环 + `startAttempt()`」。
  - 每次失败都停掉这一条 bot 并**换新实例**重试（SDK 的 token 单飞表与半死连接都不复用）。
  - 每次重试写 `warn`，含失败原文、第几次、退避时长；面板日志环因此可见。
  - 退避期间 `status()` 保持 `starting`，不闪 `error`：网络抖动不是「通道坏了」。
  - `stop()` 之后（`closed`）或生命周期信号已中止时不再重试，避免卸载/换账号被重试翻回来。
  - `start(signal)` 自己收干净：退避期间 signal 中止或通道已 `stop()` 时先 `await this.stop()`
    再抛 `QQ_CLOSED`，`status()` 不会卡在 `starting`。
  - 整个 attempt（`createBot` + 监听注册 + `bot.start()` + gate 等待）都在 try 内：构造或
    `attach` 抛错同样回收半成品（构造失败清 `starting`，已登记 bot 走 `dropStartup`）。
- `CreateImRuntimeOptions.qqStartRetrySleep`：只给测试注入的退避等待，让「三次失败 → 回滚」的
  集成用例不把 1s/2s 写进墙钟；生产不传，走 `start-retry.ts` 里的真定时器。
- 回滚语义不变：所有尝试失败仍抛 `QQ_START_FAILED`，`upsertAccount` 照旧走
  `rollbackAccountSecret`，store 里不留连不上的半残账号。

## 审查硬化（同日独立审查）

1. **signal-only abort 残留态**：只 abort `start(signal)` 的 signal、不调 `stop()` 时，原来该分支
   直接抛 `QQ_CLOSED`，`starting` 仍为 true。现在先 `await this.stop()` 再抛，`status()` 回到
   `idle`；由 `cleans up the starting projection when the signal aborts during the retry backoff` 锁住。
2. **构造/attach 在 try 外**：原来 `startAttempt` 的清理只覆盖 `bot.start()` 之后。现在整个
   attempt 都在 try 内：`createBot` 抛错清 `starting` 并写 `lastError`，`attach` 抛错走
   `dropStartup`（停 bot、摘监听、清 gate）。两条对应用例见下。
3. **回滚只在 channel 层被证明**：`im-runtime-accounts.spec.ts` 增两条真实 `createImRuntime`
   用例，证明三次网络失败后新账号被删除、既有账号恢复旧密钥（见下）。

## 否决项

- **加长 SDK 超时 / 改 SDK 源码**：两个腾讯包在数据目录外挂安装（`im/qq/sdk.ts`），
  改本机文件下次点「安装 QQ 依赖」就被覆盖，且不属于本仓库产物。
- **`tokenPrefetch: 'async'`**：把「连不上」推迟到第一次发消息才暴露，违背失败快速可见；
  扫码成功后账号会显示在线骗人。
- **对所有启动失败重试**：凭据错误（`Token fetch failed` HTTP 4xx）、SDK 形状错误、网关主动
  关闭都是确定性的，重试只会把「配置错了」拖成更长、更难读的失败链。
- **静默重试**：重试必须每次留日志，否则网络问题会被掩盖成「第一次就好了」。

## 验证

- `packages/plugin/tests/qq-channel.spec.ts` 新增 7 条：
  - `retries a token network abort with a fresh bot and logs the backoff`
  - `does not revive a gateway that was stopped during the retry backoff`
  - `cleans up the starting projection when the signal aborts during the retry backoff`
  - `clears the starting projection when the bot factory throws on a retry attempt`
  - `stops a bot whose listener registration throws`
  - `gives up after three token network aborts with a diagnosable failure`
  - `keeps the scanned account online when the first gateway start only hit a token network abort`
    （扫码成功 → 首次启动 abort → 重试成功；账号与密钥不被回滚）
- `packages/plugin/tests/im-runtime-accounts.spec.ts` 新增 2 条集成用例：
  - `deletes a new qq account after every retried start only hit a token network abort`
  - `restores the previous qq secret after every retried start only hit a token network abort`
- 既有「凭据错误不重试」用例补了 `botsCreated === 1` 断言。
- 三个 IM 用例文件 59 条全绿；`npx tsc -p packages/plugin/tsconfig.json` 退出 0；
  `node packages/plugin/scripts/gates/run.mjs` PASS（`channel.ts` 796/800 行：退避 sleep 已挪进
  `start-retry.ts`，channel 只留重试循环与清理）。
