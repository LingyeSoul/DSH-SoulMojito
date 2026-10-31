# QQ 官方机器人通道（提案 0024 M3）

> 日期：2026-10-30。状态：已落地。前置：提案 0024、施工计划
> [`docs/plans/2026-10-30-im-channels-implementation.md`](../plans/2026-10-30-im-channels-implementation.md)。

## 问题

前一批打通了 OneBot 11，但 QQ 官方机器人平台没有通道：面板只有账号配置，扫码绑定与
网关连接都不存在。本轮补 M3，并且**改掉了上一轮把官方 SDK 内联进产物的做法**。

## 方案

### 1. 两个腾讯包全部外挂安装，运行期动态导入

`@tencent-connect/qqbot-nodejs@1.0.5`（MIT）与
`@tencent-connect/qqbot-connector@1.2.0`（**UNLICENSED**）都不进分发产物，也不进
`packages/plugin/package.json` 的依赖（该文件保持无 `dependencies`）。

- 安装位置：数据目录 `$DSH_HOME/<tavern>/im/runtime/`（`tavernDataRoot('im','runtime')`）。
- 加载：`im/qq/sdk.ts` 用 `pathToFileURL(...)` 动态 `import()` 各自的 ESM 入口
  （`dist/index.js` / `dist/esm/index.js`），校验 `QQBot` 是函数、`MsgType` 是对象、
  `startQrConnect` 是函数；失败统一抛 `QqRuntimeError`（`QQ_RUNTIME_MISSING` /
  `QQ_RUNTIME_INVALID`），message 指向面板按钮**而不是** shell 命令。
- 安装（2026-10-31 修订）：`im/qq/install.ts` 在运行期目录里执行 `pnpm add` 两个固定
  版本，由 `POST im/qq/install` 触发、面板「安装 QQ 依赖」按钮调用；运行期目录有自己的
  `private: true` `package.json`。用户永远不需要开终端（同本地 ONNX 运行时的一键安装，
  见 [`2026-10-31-im-media-qq-install.md`](./2026-10-31-im-media-qq-install.md)）。
- `GET im` 投影新增 `qqRuntime: { installed, reason? }`，面板据此显示安装按钮，而不是把
  「没装包」显示成通道故障。写账号 / 开始扫码在缺包时回 `503`，文案同样指向面板。

**为什么外挂而不是内联：**

1. **许可证**：`qqbot-connector` 的包声明是 `UNLICENSED`，随本仓库的 GPL 产物一起分发
   等于替用户做了一次未经授权的再分发。外挂后是用户在自己的数据目录里自行安装。
2. **体积与可选依赖**：`qqbot-nodejs` 带 `ws`、可选的 `bufferutil`/`utf-8-validate`/
   `silk-wasm` 等原生或解码依赖。上一轮内联需要给 ESM 产物加 `createRequire` 垫片
   与 external 列表，把「零运行时依赖的自包含 bundle」这条性质打破了一半。
3. **可替换**：官方 SDK 版本与平台协议绑定，用户可能要先换包排障；外挂后换版本不需要
   重装插件。

代价：本模块不能再 `import type ... from '@tencent-connect/...'`，只能自己声明最小结构
类型（`QqSdk`/`QqBotLike`/`QqBotOptions`/`QqReplyTarget`/`QqInboundMessage`/`QqConnector`）。
包不装时 tsc 也必须过，这是硬约束。

### 2. `start()` 的 resolve 语义

SDK 的 `bot.start()` 解到的是**连接结束**，不是连接成功：正常退出、abort、重连预算耗尽
都会 resolve 或 reject。因此通道不能 await 它，而是：

- 先挂 `ready`/`resumed`/`disconnected`/`error`/`message` 监听，再 `void bot.start()`；
- 用一个一次性 `StartupGate` 承接 `ready`/`resumed`（成功）与 start 的 reject、
  「未 ready 就断开」（失败）；
- `QQChannel.start()` await 的是 gate，`withTimeout(30s)` 兜住 SDK 不回调的情况；
- 失败时 `dropStartup()` 统一清 bot/监听/signal，并把原因留在 `lastError` 上供 `status()`。

`ready`/`resumed` 会把 `lastError` 清空：SDK 自己会重连，但重连成功前「在线」是谎报，
重连后还留着旧错误同样是谎报。

### 3. 通道构造从注入的工厂来

`QQChannel` 只接受 `createBot: (options) => QqBotLike`，不再 import 构造器；运行时在
账号安装路径里 `loadQqSdk()` 后拼出工厂。测试注入假 bot，整条链路不碰网络，也不需要
本机装有腾讯包。

### 4. 被动回复上限 4 条

QQ 平台对同一条入站消息的被动回复有次数限制（参考实现用 `ReplyLimiter({ limit: 4 })`）。
`send()` 按 part 计数：`target.replyTo` 存在时前 4 条带 `msgId`，第 5 条起改为**主动推送**
（不带 `msgId`）——宁可降级，也不要让第 5 段被平台拒绝后整轮失败。

### 5. markdown 能力是账号级配置

`QQChannel` 新增 `markdownSupport: boolean`，来源是账号密钥袋的
`markdownSupport === 'true'`（缺省 false）。false 走 `sendText`，true 走 `sendMarkdown`。
能力是申请来的，发不支持的 `msg_type=2` 会被平台拒绝；按账号区分而不是写死。

### 6. 去重键在缺 id 时用随机 UUID

`messageId` 缺失时用 `randomUUID()` 做去重键后缀，不再用 `${peerId}:${receivedAt}`：
同一毫秒的两条消息会撞键，后一条被当重放丢掉。取舍写在代码注释里——**宁可重复投递，
不可吞消息**。

### 7. 启动失败回滚

`upsertAccount` 的 QQ 分支：先 `loadQqSdk()`（缺包不落盘），再构造通道（凭据校验），
再 `putAccount`，最后 `installQQ`。安装失败时：

- 新建账号 → `store.deleteAccount()`，绝不留一个连不上的半残账号；
- 改配置的既有账号 → 用安装前读到的旧密钥 `putAccount` 还原。

后者是刻意的收窄：启动恢复也走同一条 `upsertAccount`，若对既有账号一律删除，启动时
一次网络抖动就会抹掉用户已绑定的机器人（数据丢失）。回滚的目标是「store 里不存在
连不上的配置」，不是「把账号删掉」。

### 8. 日志脱敏与出站串行

- 二维码 URL 带一次性凭据：就绪日志只写 `new URL(url).host`，解析失败只写
  `QR code ready`。SDK 自己的控制台二维码打印恒关（`displayQrCodeToConsole: false`）。
- `QQChannel` 增加 `sendChain`（与 `im/onebot/server.ts` 同写法）：两轮回复并发时分片
  必须整轮发完再发下一轮，用户不该看到 `A1,B1,A2,B2`。

## 否决项

- **继续内联 SDK**：许可证与体积两条都过不去；`createRequire` 垫片还会与包内同名导入
  冲突（需要别名 hack）。
- **把包加进 `packages/plugin/package.json` 的 dependencies**：产物是单文件 bundle，
  dependencies 只会让安装方多一份重复副本，且仍然没有解决许可证问题。
- **`groupRequireMention=false` 让群消息全放行**：官方群机器人只投递
  `GROUP_AT_MESSAGE_CREATE`，非 @ 消息根本到不了进程，这个开关在官方通道上实际不可达；
  保留开关是为了 OneBot（协议端能投递全量群消息）与未来平台能力变化。
- **缺 id 时用时间戳兜底**：撞键会吞消息，见 §6。
- **对既有账号也一律 deleteAccount 回滚**：启动期网络抖动会删掉用户配置，见 §7。

## 与规格的偏差

- 提案 §5 的 `@tencent-connect/*` 「内联」处置改为外挂（本文 §1），proposal 已同步。
- 提案 §5 的 `im-channels` gate 仍未落地：字段面由测试锁住，gate 排在客户端面板那轮。
- 群 `groupRequireMention=false` 在官方 QQ 通道不可达（见否决项），proposal 已记录。

## 未做项

1. **群聊流式输出**：SDK 有 `openStream`（`/stream_messages`），但流式与「turn 结束后
   才产出正文」的时序冲突，留给后续里程碑。
2. **媒体**：图片/语音/文件不下载、不上传；入站附件只按文本投递，`ImInbound.media`
   恒为空。语音转录（`asr_refer_text`）也未接入。
3. **真人扫码的端到端验证**：测试用假连接器锁住状态机，没有真实扫码记录；上线前需要
   人工扫一次确认相位与落库。
4. **QQ 频道（guild）/私信（dm）**：通道显式丢弃，避免把频道语义塞进角色扮演会话。

## 验证

- `pnpm exec vitest run packages/plugin/tests/qq-channel.spec.ts`：18 条，覆盖入站归一、
  群 @ 门控、分片与被动上限、markdown 两档、并发串行、相位、SDK 缺失、账号回滚、
  扫码四相位。
- `pnpm run check`：tsc 三段 + 全量 vitest + build + gates。
- 产物体积：`index.mjs` 2,646,941B → 2,371,535B（−275,406B），产物内不再有 SDK 代码。
