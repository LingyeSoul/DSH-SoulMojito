# 微信出站队列：按面板间隔排队，突发窗口与 `-2` 冷却内等待重试

日期：2026-10-31。状态：已实施。前篇：`2026-10-31-im-native-session-binding.md`、`2026-10-31-im-inbound-coalescing.md`。

## 背景

微信 iLink 对同一 bot 的突发 `sendmessage` 有硬上限：现场实测约 12 条/22 秒后被拒，之后每次重试都延长惩罚（`ret/errcode -2: prepare failed`）。通道此前的防线（`weixin/send-guard.ts`）是**立即拒绝**：

- 30 秒窗口内第 6 条独立 `sendmessage` 直接抛 `WEIXIN_SEND_BUDGET_EXHAUSTED`；
- 收到 `-2` 后进入 5 分钟冷却，期间任何出站请求在本地就被拒（`WEIXIN_THROTTLED`）。

这条防线守住了突发，但把代价甩给了模型与用户：一次正常回复被拆成 4–5 条短句时，第 6 条开始模型就只拿到一句「没有送达，这一轮别再试了」；`-2` 之后要等下一次入站才有机会重发。模型既不知道**现在几点**，也不知道**最早几点能再发**，无法向用户解释延迟，也无法判断「队列里那条还算不算数」。

本次把「拒绝」改成「排队 + 按节奏发送 + 到点重试」，并把「现在能不能发、下一条几点发」投影给模型（`im_time`）与面板（「行为」页）。

## 决定

1. **设置新增 `ImSettings.weixinSendIntervalMs`**（`packages/tavern-store/src/im-state.ts`，
   持久化在 `state.imSettings`）。`applyImSettingsPatch` 只接受 500..60000 的安全整数，
   `null` 清除回默认；手改坏了的 state 在 `normalizeImSettings` 里整值丢弃。
   默认 `WEIXIN_SEND_INTERVAL_DEFAULT_MS = 3000`：iLink 的硬上限是 30s/5 条，
   3 秒一条意味着**哪怕一次回 5 条也只占满 12 秒**，仍在窗口内留有重试余量；
   再慢（比如 10s）会把一次 5 条回复拖到 40 秒以上，对端会以为机器人掉线；
   下限 500ms 防止面板填出仍会触发平台突发的节奏。窗口 30s/5 条与 `-2` 冷却
   5 分钟**仍是不可配置的硬上限**，设置只能放缓、不能突破。
2. **新 `weixin/send-queue.ts`：每账号一条 FIFO**。一个任务 = 一次逻辑发送
   （一次 `im_send` 的全部 part）。
   - **节奏**：每个 part 的开始时间不早于 `lastSendAt + intervalMs`，也不早于
     滑动窗口腾出的下一个名额（`WeixinSendGuard.nextWindowSlotAt`）；`-2` 冷却期内
     一个请求都不发。占位前 `sendGuard.reserveSlot()`；窗口算漏时接住
     `WEIXIN_SEND_BUDGET_EXHAUSTED` 并等到真实空位，**绝不把预算错误抛给调用方**。
   - **顺序**：账号级串行；一个任务的 part 之间不插别的发送，失败从失败的 part
     继续（不重发已成功的 part），`sendChain` 的「不出现 A1,B1,A2,B2 碎片」语义保留。
   - **`-2`**：记录冷却（`guard.throttle`）、把失败任务留在队首，最多再试
     `WEIXIN_SEND_MAX_RETRIES = 1` 次；冷却期间不发任何请求。再失败就把
     `WEIXIN_THROTTLED` 交给仍在等待的调用方并保留「未送达」的事实；若调用方已经
     拿到排队回执（见下条），失败只进运行日志，**不静默丢弃**。
   - **快速路径**：预计能在 `IM_SEND_FAST_WAIT_MS = 10s` 内开始的任务，调用方
     等真实结果；否则立刻回 `{ status: 'queued', parts, scheduledAt }`，队列在
     后台继续。等待是**滚动判定**的：每次真正开始等待/发送前都重判入队是否已超
     10 秒、计划开始是否晚于 deadline，命中就先回排队回执；中途才撞上 `-2` 时，
     冷却 5 分钟超过等待上限，同样先回排队回执，调用方不会被工具调用拖满 5 分钟。
   - **`stop()`**：中止定时器/睡眠、把未结算任务按 `WEIXIN_CLOSED` 拒绝，幂等；
     账号重连时 `start()` 重新启用。**队列只在进程内**：重启后没发出的排队消息
     不会自动续发（见代价）。
   - **`status()`**：从注入时钟取 `{ allowedNow, nextSendAt?, throttleUntil?, queueDepth }`。
3. **`WeixinChannel` 接入**：`send()` 不再做即时预算/冷却拒绝，交给队列；新增
   `sendStatus()` 与 `setSendIntervalMs()`；`stop()` 停队列；QQ/OneBot 一行不改
   （它们没有排队语义，`ImChannel.sendStatus` 是实现侧可选能力）。
4. **投影**：`ImRuntimeHandle.sendStatuses()` 返回每个实现了队列的账号一行
   `{ channel, accountId, allowedNow, nextSendAt?, throttleUntil?, queueDepth }`；
   `GET im` 带 `sendStatuses`；`POST im/settings` 落库后调用
   `runtime.applySettings()` 让运行中的队列立刻换挡（`upsertAccount` 也读当前设置）。
5. **`im_time` 工具**（随 IM 工具族挂到每个会话）：只读返回
   `{ now: ISO, timeZone: IANA, channels: [...] }`；运行时缺失时
   `available:false` + 原因，与 `im_channels` 同口径。工具描述明确告诉模型
   「排队回执带 `scheduledAt`，怀疑延迟丢失时先查这里」。不返回凭据、peer id
   或正文。
6. **面板「行为」页**（`client-src/97cc-ui-im-behavior.js`，manifest 里紧跟日志分片）：
   间隔输入（500..60000，保存走 `POST im/settings`，留空 = 恢复默认）+ 只读发送
   节奏列表（现在可发 / 下次可发 / 冷却至 / 队列深度）。面板沿用既有 5s 轮询刷新，
   不新增定时器；`97-ui-im.js` 只加一个 tab 分支，并把扫码面板拆到伴随分片
   `97d-ui-im-bind.js`，主分片回到 800 行预算之下（审查 P2 收口）。

## 代价与边界

- **工具调用可能拿到「已排队」**：`im_send` 的结果可能是 `status: 'queued'` +
  `scheduledAt`，不是送达回执。模型必须如实转述「已排期、几点发」，不能当成已送达；
  IM 模式提示词（`im/agent.ts`）与 `im_send` 工具描述都已写明这条语义：`im_time`
  可查下一发送时间/冷却/队列深度，插件会主动节流并重试一次，只有工具明确返回
  `WEIXIN_THROTTLED` 才停止本轮重试。
- **工具调用最长阻塞**：快速等待 10 秒是滚动判定的——每次真正开始等待/发送前都
  重判「入队是否已超 10 秒」与「本轮计划开始是否晚于入队 +10 秒」，命中就先回
  排队回执（后台照发）；前序任务卡在 15 秒（媒体 20 秒）请求超时里也不会把调用方
  拖过等待上界。单 part 任务的等待上界 ≈ 10 秒 + 前序请求超时；多 part（长文切分）
  的后续 part 只要计划开始晚于 deadline 同样先回执，不再按「最后一段 + 超时」干等。
  排队任务在后台，失败通过 `im_time` 的 `queueDepth` 归零与 IM 运行日志可见。
  已经回过排队回执的任务若最终失败，**没有第二个回调能通知模型**——这是「先回执、
  后台发送」的固有代价，用日志与状态投影补偿。
- **重启不续发**：队列是进程内的；进程停止时未结算任务按 `WEIXIN_CLOSED` 拒绝，
  重启后的消息不会自动出现在队列里。持久化排队消息需要落盘 + 与入站去重表同级的
  对账，本轮不做（与 `-2` 冷却一样，重启允许重新探测一次平台状态）。
- **间隔是「同一账号」的**：多账号各自一条队列、各自读同一个设置；同一账号内
  不同 peer 共享节奏（这是账号级平台限制，不是产品选择）。
- **面板只能看到活着的通道**：未连接账号不出现在节奏列表里（`sendStatuses` 只列
  运行中的通道），与 `views()` 同事实口径。
- **429/5xx 网络失败不排队**：队列只对预算窗口与 `-2` 负责；普通发送失败仍按
  `WEIXIN_SEND_FAILED` 立刻交还调用方，重试策略属于模型。

## 否决项

- **维持即时拒绝、只改提示文案**：模型仍拿不到可重发时间，用户看到的是「失败」，
  连发场景反复触发；这不解决根因（平台节流），只是把代价讲清楚。
- **无界等待**：把工具调用挂在队列上等 5 分钟冷却，一轮回复会被工具超时截断；
  快速路径必须有 10 秒上限与排队回执。
- **把节奏/冷却也做成面板可配置**：30s/5 条与 5 分钟是平台惩罚的事实，放开会让
  用户把自己送进更长的惩罚；设置只允许改常规间隔。
- **静默丢弃失败任务**：调用方已经拿到排队回执时任务再失败，必须留 warn 日志与
  队列归零的状态信号，不能假装已送达。
- **持久化排队队列**：为一段进程内的等待落盘整套恢复/去重对账不划算；重启后
  由下一次入站驱动重发。
- **prompt-only（只告诉模型自己控制节奏）**：模型看不见时钟与窗口占用，靠猜的
  间隔必然仍会撞上 `-2`；平台限制要由代码层守住。

## 验证

- `packages/plugin/tests/weixin-send-queue.spec.ts`：间隔拉开与同任务 part 连续、
  30s/5 窗口等待后投递而非拒绝、前序任务超时滚过 fastWait 后转排队回执、`-2` 暂停后
  重试一次成功、重试再失败交还 `WEIXIN_THROTTLED`、长冷却先回排队回执再后台重试、
  `status()` 投影、`stop()` 幂等拒绝。
- `packages/plugin/tests/weixin-channel.spec.ts`：第 6 条不再抛
  `WEIXIN_SEND_BUDGET_EXHAUSTED` 而是排队并在窗口后送达；`-2` 期间入队不发请求、
  冷却结束队首重试后后续消息接着送；`sendStatus()` 从注入时钟投影。
  （旧用例的语义被本次决策刻意改动，见文件内注释。）
- `packages/plugin/tests/im-settings.spec.ts`：间隔默认/越界拒绝/`null` 清除 +
  `normalizeImSettings` 容错。
- `packages/plugin/tests/im-http-accounts.spec.ts`：`GET im` 的 `sendStatuses` 投影、
  `POST im/settings` 落库并调用 `applySettings`、越界 400 不改盘。
- `packages/plugin/tests/im-tools.spec.ts`：`im_time` 输出形状/时区/无凭据与 peer id、
  运行时缺失 `available:false`、`im_send` 排队回执输出与工具描述里的
  `scheduledAt`/`im_time`/`WEIXIN_THROTTLED` 语义；`im-agent-mount.spec.ts`
  四件工具注册一次。
- `packages/plugin/tests/im-agent-preset.spec.ts`：IM 模式提示词写明排队回执如实转述、
  `im_time` 查节奏、只有 `WEIXIN_THROTTLED` 才停本轮重试，且不再出现
  `WEIXIN_SEND_BUDGET_EXHAUSTED` 的旧口径。
- `packages/plugin/tests/im-panel.spec.ts`：行为页 source 检查、四 tab 顺序与
  render smoke（间隔表单、状态行、空态、加载态）、纯函数；扫码面板拆到
  `97d-ui-im-bind.js` 后的分片顺序与渲染不回归。
- `packages/plugin/tests/im-router.spec.ts`、`weixin-media.spec.ts`：路由透传通道
  出站结果（假通道补回执）与媒体路径不回归。
