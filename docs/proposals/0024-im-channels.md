# 提案 0024：IM 通道（QQ / 微信 / OneBot 11）

> 状态：M0–M5 已实现（OneBot 11 / QQ / 微信；媒体双向、运行日志面板、QQ 运行时
> 一键安装、typing 缓存与群分片已落地）。日期：2026-10-30（2026-10-31 更新）。
> 仍未做：真机扫码的端到端验证（只有本地桩）与 QQ 原生流式（平台只对 C2C 开放）。
> 目标宿主：DSH `0.2.1-rc.2`（兼容 `0.2.0-rc.2`）；验证基线 `pnpm run check`。
> 参考物（只读研究，不复制其源码进本仓库）：
> - QQ 官方机器人平台：`tencent-connect/dsh-qqbot`（MIT）与其依赖
>   `@tencent-connect/qqbot-nodejs@1.0.5`（MIT，唯一依赖 `ws@^8`）、
>   `@tencent-connect/qqbot-connector@1.2.0`（**UNLICENSED**，扫码绑定）。
>   两个包都**外挂安装**，不进分发产物（见 §5 与
>   [`decisions/2026-10-30-qq-channel.md`](../../decisions/2026-10-30-qq-channel.md)）。
> - 微信官方后端协议：`Tencent/openclaw-weixin` 的 `docs/protocol.md`（MIT）。
> - OneBot 11 标准：`botuniverse/onebot-11`。
> - 仓库内投递链路：`src/games/wake.ts`、`src/agent-tavern/body-runtime.ts`、
>   `src/agent-novel/driver.ts`、`src/session/command.ts`、`src/session/trace.ts`。

## 1. 目标行为（Working Backwards）

**PR**：玩家在管理面板把 QQ 私聊、QQ 群、微信私聊各绑到一个**已经打开的 DSH 原生会话**。
之后他打开手机 QQ 或微信直接说话——消息**立刻**以插件来源插进该会话，会话自己的
preset、工具、上下文照常生效；模型用 `im_send` 把回复发回手机。插件不代建会话、
不导入聊天、也不自动抓 `turn/end` 的正文。

**客户与验收**：
- 玩家：三条通道各自独立开关，默认关闭；扫码即绑定，无需手填 AppID/Secret。
- 玩家：QQ 群就是**普通群聊**——多个人在同一群里说话，全部进**同一个**绑定会话，
  每条消息带发言人标签；不是 Tavern 群组资产，不跑多角色仲裁。
- 玩家：未绑定 peer 发来消息时，面板列出「未绑定对端」，点一下绑到当前会话；
  插件不自动新建会话。
- 玩家：消息立即投递，不攒批、不等空闲、不做「延迟合并」；同一个人连发三条就是三条
  用户消息。
- 玩家：模型用 `im_send` 把回复原路发回；插件不自动抓 `turn/end` 的正文。
- 玩家：Agent 在回合内可以主动补一句、可以查「这个会话绑了哪些群/谁在说话」。
- 维护者：IM **不新增第二条生成循环**；会话自己的 preset/工具/上下文原样复用，
  `pnpm run check` 仍是唯一权威口径。

**明确不做**（v1 边界）：
1. **不做账号逆向接入**。QQ/微信的机器人身份只来自官方扫码；OneBot 上游由用户自备并
   自担合规责任，本插件不内置 QQ 账号登录、协议破解或验证码绕过。
2. **不做 ST 意义的群聊**。QQ 群不是 `chat_metadata.group`，不参与
   `pickGroupMember`/talkativeness；群成员都是「用户」，不是「角色」。
3. **不做 IM → ST 生成**。IM 只走 AgentTavern；ST 的 `/generate` 是客户端主导的架构，
   与「手机端立即投递、无客户端」互斥。
4. **不做微信群聊**。协议层虽有 `group_id`，但官方文档明示「字段存在不等于功能支持」。
5. **不做 QQ 频道（guild）**。频道语义与角色扮演无关。
6. **不做语音合成下行**。QQ 语音要 silk 编解码；v1 只接收语音转录。
7. **不把 IM 做成 Mod**。Mod API 没有出网、没有 HTTP upgrade、拿不到密钥保管面。

## 2. 参考物事实盘点

### 2.1 QQ 官方机器人平台

| 事实 | 证据 |
|---|---|
| 传输走 WebSocket 网关，SDK 负责 token、鉴权、心跳、重连 | `qqbot-nodejs` 的 `QQBot({transport:'websocket'})`；`dsh-qqbot` 的 `gateway/bootstrap.ts` |
| 出站路径按场景参数化 | `protocol/api/routes.js`：`/v2/users/{openid}/messages`、`/v2/groups/{group_openid}/messages`、`/v2/users/{openid}/stream_messages`、`/gateway` |
| 扫码绑定直接产出机器人凭据 | `qqbot-connector` 的 `startQrConnect(callbacks, { signal, source })` → `{ appId, appSecret, userOpenid? }` |
| 入站身份按场景归并 | `dsh-qqbot/src/transport/inbound.ts`：`scope = group ? 'group' : 'c2c'`，`peerId = groupOpenid ?? senderId` |
| 群聊必须 @ 才触发 | `config.ts` 的 `requireMention` 默认 `true` |
| 被动回复有次数与时效约束 | `gateway/bootstrap.ts`：`new ReplyLimiter({ limit: 4 })`，超限降级主动推送 |
| 单条约 5000 字符上限 | `config.ts` 的 `textChunkLimit` 默认 `4500` |

**可借的**：SDK 调用、二维码状态机、限流、分块、中间件纪律，以及「入站消息插进
绑定会话、由 Agent 自己处理」的原生会话模型。
**不可借的**：把 Tavern 聊天当成 IM 的会话身份——本项目的绑定目标就是宿主原生
session，消息插入后用 IM 工具回复（决策 2026-10-31-im-native-session-binding）。

**群 @ 开关的实际可达性**（2026-10-30 修正）：官方群机器人只在用户真的 @ 了机器人时
投递 `GROUP_AT_MESSAGE_CREATE`，非 @ 消息根本不会到达进程。因此
`imSettings.groupRequireMention = false` 在官方 QQ 通道上**实际不可达**——没有可放行的
非 @ 群消息。开关仍然保留：OneBot 11 的协议端能投递全量群消息，那里它生效；官方平台
若将来放开全量投递，也不必改配置形状。

### 2.2 微信官方后端协议

| 事实 | 证据 |
|---|---|
| 固定入口 `https://ilinkai.weixin.qq.com`，CDN 默认 `https://novac2c.cdn.weixin.qq.com/c2c` | `protocol.md` §Scope and transport；`login-qr.ts` 的 `FIXED_BASE_URL` |
| 扫码取码 `POST /ilink/bot/get_bot_qrcode?bot_type=3`，轮询 `GET /ilink/bot/get_qrcode_status?qrcode=` | `protocol.md` §QR-code login；`login-qr.ts:95-158` |
| 状态机：`wait/scaned/confirmed/expired/need_verifycode/verify_code_blocked/scaned_but_redirect/binded_redirect` | `protocol.md` 状态表；`login-qr.ts:334-475` |
| 确认后拿到 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id` | `protocol.md` |
| 收消息是长轮询 `POST /ilink/bot/getupdates`，带游标 `get_updates_buf`，建议 35s 超时 | `protocol.md` §getUpdates；`monitor.ts:86-183` |
| 发消息 `POST /ilink/bot/sendmessage`，`message_type=2`、`message_state=2`、必须回带 `context_token` | `protocol.md` §sendMessage；`messaging/send.ts:56-80` |
| 输入状态 `getconfig` → `typing_ticket` → `sendtyping` | `protocol.md` §getConfig / §sendTyping |
| `errcode/ret == -14` 表示 token 失效，暂停该账号 1 小时 | `monitor.ts:111-127` |
| 媒体走 CDN：`getuploadurl` → AES-128-ECB → `x-encrypted-param`；下载按 `media.aes_key` 解密 | `protocol.md` §CDN media flow |
| 微信不渲染 markdown，需字符级过滤 | `messaging/markdown-filter.ts` |

文档自述「客户端类型与行为不等于完整服务端契约」，因此该通道按「参考实现 + 灰度 +
可观测」对待，不猜字段。

### 2.3 OneBot 11

| 事实 | 证据 |
|---|---|
| 反向 WS 可作 Universal 客户端，一条连接双工 | `communication/ws-reverse.md:11-31` |
| 握手头带 `X-Self-ID`、`X-Client-Role`（API/Event/Universal） | `ws-reverse.md:24-31` |
| 事件统一 `{ time, self_id, post_type }`，`post_type ∈ message/notice/request/meta_event` | `event/README.md:17-33` |
| 消息事件含 `message_type/sub_type/message_id/user_id/group_id/message/raw_message/sender` | `event/message.md` |
| API 响应 `{ status, retcode, data, echo }`；`ok`↔`0`、`async`↔`1` | `api/README.md:19-35`；`communication/http.md:61-63` |
| 出站三件套 `send_private_msg`/`send_group_msg`/`send_msg`，返回 `message_id`(int32) | `api/public.md:42-90` |
| HTTP POST 可在响应里做快速操作（`reply`/`at_sender`） | `event/message.md:35-40,86-96` |

本插件的定位是 OneBot 的**对端**：对外提供 Universal 反向 WS 端点 + HTTP POST webhook，
并作为 HTTP 客户端调用上游 API 出站。

### 2.4 本仓库已有的「插件 → Agent」投递链路

写卡工作台交接后用户看到的那条消息，本质上就是宿主 session 里的一条 `user/message`。
插件侧要复刻它，现成的 seam 是 `agent.followup(message)`（空闲开新轮）与
`agent.steer(message)`（运行中插话，对应官方 UI 的「插话发送」）：

| 位置 | 用途 | 消息形状 |
|---|---|---|
| `src/games/wake.ts:144-155` | 人类落子后唤醒 Agent | `{ id, role:'user', content:[{type:'text',text}], source: hostPluginMessageSource(session,{form:'notice',summary}) }` |
| `src/agent-tavern/body-runtime.ts:240` | 带意见重生成的触发 | `buildRegenerateTrigger(...)` |
| `src/agent-novel/driver.ts:443-462` | 有界重试的 followup | 同上，带 attempt 退避 |
| `src/session/trace.ts:174-213` | ST 生成镜像进宿主会话 | `turn/start` + `user/message`（`source:{kind:'user'}`） |

IM 入站是**真实人类**发言，因此 `source` 用 `{ kind: 'user' }`（与
`beginTavernSessionTurn` 同款），不冒充插件通知；只有通道异常提示才用
`hostPluginMessageSource(..., { form: 'notice' })`。

## 3. 架构

```
QQ 网关 ─┐
微信长轮询 ─┼─→ ImChannel（协议适配）─→ ImInbound ─┐
OneBot WS/HTTP ─┘                                 │
                                                   ▼
                                     ImRouter（去重 · 白名单 · 立即投递）
                                                    │
                               peer → 原生会话绑定（sessionId）
                                                    │
                    agent.steer (running) / followup (idle)
                                                    │
                              宿主 AgentLoop（会话自己的 preset）
                                                    │
                                    模型调用 im_send
                                                    ▼
                                     ImChannel.send() → 原路回复
```

### 3.1 三层职责

| 层 | 职责 | 明确不知道的事 |
|---|---|---|
| `im/<channel>/` | 协议细节：鉴权、连接、事件解析、出站编码、限流、媒体 | 角色卡、聊天、生成 |
| `im/router.ts` | peer 身份、会话绑定解析、立即投递、节流、失败话术、幂等 | 任何协议字段 |
| `im/project.ts` | 回复投影：楼层 → 展示文本 → 剥内部块 → 切分 | 协议长度以外的策略 |

### 3.2 ImChannel 契约

```ts
export interface ImChannel {
  readonly id: 'qq' | 'weixin' | 'onebot'
  readonly accountId: string
  start(signal: AbortSignal): Promise<void>   // 连接失败必须抛，不允许静默重试
  stop(): Promise<void>                       // 关连接、放 upgrade、清定时器
  status(): ImChannelStatus                   // idle|starting|online|paused|error + 原因
  send(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendReceipt>
}
```

入站统一成：

```ts
export interface ImInbound {
  channel: ImChannelId
  accountId: string
  scope: 'private' | 'group'
  peerId: string        // QQ openid / 微信 user_id / OneBot group_id|user_id
  senderId: string      // 真实发送者（群聊里与 peerId 不同）
  senderName: string
  text: string
  media: readonly ImMediaRef[]
  replyTo?: string
  dedupeKey: string     // channel+account+message_id
  receivedAt: number
}
```

`dedupeKey` 落盘保留 24h：QQ 网关重连补发、微信游标回退、OneBot 重连重投都会重复
投递，重复投递等于给模型喂两遍同一句话。

### 3.3 peer → 原生会话绑定（核心）

一条 IM 对话 = **一个 peer → 一个已存在的宿主原生 session**。绑定不创建会话、
不创建 Tavern 聊天、不导入历史；会话由用户在 DSH 里创建并打开，IM 只负责把消息
插进去，并把回复工具的落点限制在该会话。

```ts
interface ImPeerBinding {
  sessionId: string     // 宿主原生会话 id（session.id）
  scope: 'private' | 'group'
  createdAt: string
  boundBy: 'auto' | 'manual'
}
```

键：`peerKey = ${channel}:${accountId}:${scope}:${peerId}`，存 `state.imPeers[peerKey]`。
多条绑定可以指向同一个 `sessionId`（共享上下文）；绑定粒度是 peer，不是会话。

**未知 peer**：入站消息先记进 `state.imPendingPeers[peerKey]`（只存最近时间与安全的
群昵称），面板「未绑定对端」显示它；同时回一条固定提示。用户在面板里把该对端点一
下绑到**当前会话**（面板经宿主 `useSessions` 取当前 session id）。没有自动绑定模式：
不替用户新建会话，也不猜目标。

**投递**：通过去重与访问控制后，路由立即把 plugin relay message 插进绑定会话的
inbox：运行中的 agent 用 `agent.steer`（插话，下一个 step 读到），空闲的用
`agent.followup`（开新轮）。不排队、不 debounce（决策
[2026-10-31-im-steer-inbound](../../decisions/2026-10-31-im-steer-inbound.md)）：

```ts
{
  id: `im-${uuid}`,
  role: 'user',
  content: [{ type: 'text', text: '[IM qq/私聊 peer=peer-xxx]
<正文>
（回复请调用 im_send，peer 参数用 peer-xxx）' }],
  source: hostPluginMessageSource(session, {
    form: 'relay',
    summary: 'IM qq/private message from peer-xxx',
  }),
}
```

**回复**：插件不再从 `turn/end` 抓正文自动发送。IM 工具族由 index bundle 在
`agent/created` / `agent/status` / 启动时的 live agent 列表三个入口注册进每个
agent 的 `ctx.tools`（挂载域）；模型看到消息后调用 `im_send` 回复，`im_identity`
列出本会话绑定的 alias。`im_send` 仍拒绝跨会话目标。

**会话必须在线**：v1 只投给 `agents.get(sessionId)` 拿得到的活 agent；拿不到时回
「会话当前未打开」提示并记日志，不创建/resume 会话。冷会话恢复（需要宿主提供
session meta 与 preset 组合）留作后续，不能用「插件代建会话」绕过。

**迁移**：v1 的 `character/chatId` 绑定在 store 归一化时丢弃多余字段，只保留
`sessionId`；只要该会话仍在，绑定继续可用。

**不做自动回复归属**：共享模式下多个 peer 在同一会话里，模型用 alias 决定回给谁；
插件不需要 `pendingOrigins`，也不会把「网页里用户自己说的话」误当成 IM 来源。

### 3.4 QQ 群就是普通群聊

| 维度 | 私聊（QQ C2C / 微信 / OneBot private） | QQ 群 / OneBot group |
|---|---|---|
| 会话身份 | 一个 peer 一条绑定 | 一个群一条绑定 |
| 聊天归属 | 由绑定模式决定：独立会话（默认）或共享会话 | 同左 |
| 消息来源 | 一个人 | 多个群成员，全是「用户」 |
| 消息内容 | 原文 | `[昵称] 原文`（发言人前缀） |
| 群聊资产 | 不涉及 | **不创建、不参与** `chat_metadata.group` |
| 发言仲裁 | 无 | 无：模型看到谁说了什么，自己决定回不回 |
| 触发 | 每条消息 | QQ 默认必须 @ 机器人（`imGroupRequireMention`，默认开、可关）；OneBot 默认 @ 或前缀 |
| 回复落点 | 私聊 peer | 群 |

配套一条**会话级 prompt 上下文**（按 `agent.id` 查绑定，与
`src/agent-tavern/agent.ts:73` 的 `agentPresetText(agentId)` 同一手法）：

- 私聊：「本会话来自 QQ 私聊，对方显示名为 X。」
- 群聊：「本会话来自 QQ 群「X」的多人对话；每条用户消息前缀是发言人显示名。
  群里可能有多人同时说话，只回应需要你回应的内容，不要复述别人的话。」

这样模型知道自己在群里，而管线里只有一条单角色时间线。

### 3.5 生成循环：由绑定会话自己跑

- **入站即插入**：运行中用 `agent.steer`、空闲用 `agent.followup`，不 `await whenIdle()`、
  不去抖、不合并、不等上一轮结束（宿主 inbox 自己排队）。消息来源是
  `plugin:dsh-soulmojito` + `form: 'relay'`，与本地用户输入可区分。
- **回复由模型发**：插件不在 `turn/end` 抓正文、不自动发送；模型看到 IM 消息后
  调用 `im_send`，从 alias 选择目标。共享会话里谁发的话、回给谁，都由模型按
  alias 决定。
- **投递失败**：`agents.get(sessionId)` 拿不到活 agent（会话未打开）时回一句固定
  提示并记日志；不创建/resume 会话，也不假装插入成功。
- **不碰 ST**：IM 不调用 `runGeneration`；会话自己的 preset 负责生成。
### 3.6 IM 工具族

由 index bundle 在 `agent/created` / `agent/status` / 启动时的 live agent 列表三个
入口注册进每个 agent 的 `ctx.tools`（`src/im/agent-mount.ts`）——绑定目标可能是
standard / novel / workbench 等任意原生会话，不能只挂在 AgentTavern preset 上。
**身份一律来自真实 session binding**，参数不能指定会话。

IM 绑定的会话建议使用 `AgentTavernIM`（`agent-tavern-im`）preset：它在 AgentTavern
之上加了 IM 模式提示（所有回复用 `im_send`、短句多条、群聊区分发言人、附件用媒体
参数）。工具仍由 index bundle 统一挂载，preset 只负责把回复规范讲清楚；`POST
im/peers` 会对 live 空闲会话自动 `recompose` 到该 preset（未打开/运行中则等
`agent/created`/`agent/status(idle)` 补切，novel/workbench/ST 不强行切换）。

| 工具 | 作用 | 边界 |
|---|---|---|
| `im_identity` | 查当前会话绑定的通道、私聊/群、对端显示名、最近 N 条发言人与时间 | 只读，只返回本会话绑定 |
| `im_channels` | 三条通道的在线/暂停/错误状态 | 只读，不返回密钥 |
| `im_send` | 向本会话已绑定的某个 peer 发一条文本 | **不允许跨会话**：目标必须已绑定到当前 session（独立模式一个、共享模式可能多个） |

理由：模型在群里需要知道「谁在说话」，在长回合里需要能主动补一句；但绝不能变成
一个「给任意 QQ 号发消息」的开放接口。

### 3.7 出站文本投影

一条流水线，三条通道只在最后一步分叉：

1. 取楼层 `mes`（已过 `AI_OUTPUT` 落库正则）→ `displayTextForMessage`（`markdownOnly`
   展示正则，与面板所见一致）；
2. `stripFrontendDocuments`：扔掉美化前端 HTML 文档与 `html` 代码块；
3. 剥内部协议块：`<UpdateVariable>…</UpdateVariable>`、`<StatusPlaceHolderImpl/>`、
   状态栏模板残留；
4. 折叠连续空行、去首尾空白；
5. 切分：
   - QQ：Markdown 感知切分（代码块/表格不切断），上限 `textChunkLimit`（默认 4500），
     带递增 `msg_seq`，超 4 条走主动推送；
   - 微信：先过等价 `StreamingMarkdownFilter`（剥 CJK 斜体/标题标记/图片），再按段落
     切分（默认 1800 字符）；
   - OneBot：CQ 码转义（`[` `]` `&`），按 `message` 数组发 `text` 段。

**空投影**：投影后为空（例如模型只输出前端文档）时发固定短句「（无文本回复）」，
不发明文错误，也不静默丢弃。

### 3.8 立即投递、并发与节流

- **立即投递是硬不变量**：收到即插进 inbox（running `steer` / idle `followup`），没有
  debounce、没有 batch、没有「等人说完」。
- **串行由宿主负责**：同会话多轮由 AgentLoop 排队；插件不另建队列。
- **平台突发预算**：微信通道按账号 30 秒最多 5 条 `sendmessage`；`ret=-2` 进入 5 分钟
  冷却，期间不发请求（决策
  [2026-10-31-weixin-send-throttle](../../decisions/2026-10-31-weixin-send-throttle.md)）。
- **节流只防刷屏**：每 peer 令牌桶（默认突发 5、稳态 1 条/秒），超限回一条提示并记数，
  不缓存积压。
- **幂等**：`dedupeKey` 命中即丢弃，不回话。
- **超时**：`imTurnTimeoutMs`（默认 30 分钟）只影响「等回复」的等待窗口，不打断宿主
  回合；超时向对端发一句「仍在处理中」并继续等（不重复触发）。

## 4. 凭据、存储与安全边界

### 4.1 扫码绑定

统一状态机，面板只读投影（不在面板里跑协议）：

```ts
type BindPhase =
  | { kind: 'idle' }
  | { kind: 'waiting'; url: string; qrSvg?: string; issuedAt: number }
  | { kind: 'verify'; prompt: string }        // 微信 need_verifycode
  | { kind: 'saving' }
  | { kind: 'failed'; reason: string }
```

- QQ：`startQrConnect` → `onQrDisplayed(url)` → `onSuccess([{appId,appSecret,userOpenid}])`；
  `userOpenid` 直接写进该账号私聊白名单（扫码人即 owner）。
- 微信：`get_bot_qrcode` → 轮询 `get_qrcode_status`；`need_verifycode` 转 `verify` 相位；
  `confirmed` 落 `bot_token/baseurl/ilink_bot_id`。
- OneBot：无需扫码，面板生成 `ws://<host>:<port>/api/dsh-soulmojito/im/onebot/ws` +
  一次性 token，用户填进上游实现。

轮询绑定 `AbortController`，插件卸载/热重载不得留下孤儿任务。

### 4.2 存储布局

```
$DSH_HOME/soulmojito/im/                # 旧装：$DSH_HOME/tavern/im/
  accounts.json                         # 账号清单（无密钥内容）
  secrets/<channel>-<accountId>.json    # 密钥，mode 0600
  cursors/<accountId>.json              # get_updates_buf 游标（各通道共用 ImStore 游标面）
  weixin/<accountId>/context-tokens.json# peer → context_token
  dedupe.log                            # 24h 去重键（追加 + 定期压实）
  media/                                # 入站媒体临时目录（TTL 清理）
```

- 密钥**不进 `state.json`**：`state.json` 会被面板、Mod 与工具面读取。
- 权限 0600；读写失败按失败关闭处理（该账号报 `error`，不降级到明文）。
- 日志与面板投影只出现 `appId`、`ilink_bot_id`、token 前 4 位 + `…`。
- IM 会话的 agent `cwd` 复用既有内部工作区（`src/workspace.ts` 的
  `prepareInternalWorkspace`），不新建第二套目录。

peer 绑定、默认设置、白名单走 `state.json` 的 `imPeers` / `imSettings`，与
`sessionBindings` 同文件、同 CAS 纪律。

### 4.3 访问控制

| 场景 | 默认 | 说明 |
|---|---|---|
| 私聊 `privateMode` | `allowlist` | 空名单 = 拒绝所有人；扫码人自动入名单 |
| 群聊 `groupMode` | `allowlist` | 空名单 = 拒绝所有群；面板逐群勾选 |
| 未绑定 peer | 拒绝 | 只回「尚未绑定」提示，不触发生成 |
| OneBot 入站 | 关闭 | 必须先建端点并拿到 token |
| 指令面 | 仅 owner | `/new` `/stop` 等只认白名单 senderId |

非 owner 的消息**只作为对话输入**，不解析指令：群里任何人都能聊天，但没人能替 owner
换模型或清空上下文。

### 4.4 威胁模型

| 威胁 | 处置 |
|---|---|
| 反向 WS 被同网段冒充 | 每端点独立 token，`Authorization: Bearer` 或 `X-OneBot-Token`，失败 401 断连 |
| webhook 被当注入源 | 同一 token + `post_type` 白名单 + 请求体上限 256KB |
| 入站媒体炸弹 | 大小上限 20MB、MIME 白名单、临时目录 TTL、绝不写进仓库 |
| 群成员诱导模型吐密钥 | 密钥不在模型可见上下文；出站只做文本投影，不拼配置 |
| 内部协议外泄 | `projectImText` 强制剥离前端/MVU 块；白名单外用户不触发生成 |
| 宿主监听 `0.0.0.0` | IM 管理路由沿用 `http/trust.ts`；upgrade 路由自己校验 token（Origin 检查对 ws 握手不适用） |
| token 失窃 | 0600 + 面板不显示完整值 + 解绑即删文件 |

### 4.5 删除路径

- **解绑 peer**：删 `state.imPeers[key]`；会话保留（用户资产不因解绑而丢）。
- **解绑账号**：停通道 → 删密钥文件与账号条目 → 清游标/context token/去重键/媒体目录 →
  删该账号下的 `imPeers` 与 `imPendingPeers`（死绑定不再出现在面板）。
- **移除 OneBot 端点**：调用 upgrade 路由 disposer、断开活动连接、删 token。
- **环境硬关**：`DSH_SOULMOJITO_DISABLE_IM=1` 时整个子系统不注册路由与连接。
- **删除会话**：`bindings/prune` 同时按 `sessionId` 过滤悬挂的 `imPeers`。

### 4.6 为什么不是 Mod

Mod v1 没有出网客户端、HTTP upgrade、密钥保管、长驻 socket 生命周期。硬塞进去要 Mod
API 破一次隔离纪律，代价大于收益。

## 5. 宿主依赖与打包

| 依赖 | 现状 | 处置 |
|---|---|---|
| `webServer.registerUpgrade({path, handler})` | 宿主 `dsh-host-webserver` 已提供（`lib/types/index.d.ts:41-46`），本插件未声明 | `host-contract.ts` 加可选 `registerUpgrade?`；缺失时 OneBot 只开 HTTP POST |
| `agents.create/resume` + `agent.followup/steer` + `whenIdle` | `HostAgentsService` 只声明了 `get/list/create?`，`HostAgentLike` 未声明 `followup`/`steer` | 扩展为可选成员并集中探测；两者都缺失即 IM 不可用（面板说明原因） |
| `agentPresets.mount` | `dsh-adapter.ts` 已用 | 复用，不新增 seam |
| `ws` | 插件当前零运行时依赖 | 不再内联：OneBot 用自研最小服务端（`im/onebot/ws.ts`），QQ 客户端由外挂的官方 SDK 自带 |
| `@tencent-connect/qqbot-nodejs` | 官方 SDK，纯 ESM；带 `ws` 与可选原生依赖 | **外挂安装**（MIT）：装在 `$DSH_HOME/<tavern>/im/runtime/`，运行期 `import()`；不进产物、不进 dependencies |
| `@tencent-connect/qqbot-connector` | 扫码状态机，纯 ESM；包声明 **UNLICENSED** | **外挂安装**：UNLICENSED 不能随本仓库的 GPL 产物再分发，由用户在自己的数据目录安装 |
| 微信协议 | 官方文档 + 参考实现 | 自研 HTTP 客户端（6 个端点），不引入 OpenClaw peer 依赖 |
| OneBot 11 | 文本标准 | 自研事件/动作映射，无依赖 |

**打包不变量**：`packages/plugin/package.json` 保持无 `dependencies`；产物仍自包含。
新增 gate `im-channels` 断言：产物无裸模块 import、`state.json` 无密钥字段、IM 路由
全挂在 `API` 前缀下、upgrade 路由注册与 dispose 对称、manifest 含 `97-ui-im` 分片。

**QQ 运行时的安装与投影**：`im/qq/sdk.ts` 从数据目录动态导入两个包，缺包时
`loadQqSdk`/`loadQqConnector` 抛带安装命令的 `QqRuntimeError`；`GET im` 投影
`qqRuntime: { installed, reason? }`，安装命令为：

```text
cd "<im runtime dir>" && pnpm add @tencent-connect/qqbot-nodejs@1.0.5 @tencent-connect/qqbot-connector@1.2.0
```

**体积**：M3 落地前（内联 SDK）`index.mjs` 2,646,941B；改为外挂后 2,371,535B
（−275,406B），产物内不再有 SDK 代码。gate 记录基线，超过 1.5× 失败。

## 6. 面板与路由

### 6.1 面板「聊天渠道」分区

- 三张卡片：QQ / 微信 / OneBot，状态灯（未配置 / 扫码中 / 在线 / 已暂停 / 错误 + 原因）。
- 账号列表：`appId` 或 `ilink_bot_id`、绑定时间、最近活动、解绑。
- 扫码弹窗：二维码 SVG + 备用链接 + 刷新 + 微信验证码输入框 + 状态轮询。
- 绑定表：`peer → 原生会话`，显示会话标题、`共享会话` 徽标；支持改绑到当前会话、解绑。
- 未绑定对端：发过消息但还没绑的对端列在这里，点一下绑到当前会话。
- 群聊：`imGroupRequireMention` 开关，默认开启（必须 @）。官方 QQ 群机器人只投递 @
  消息，关掉开关在 QQ 通道上不可达（§2.1）；OneBot 11 上它才真的放行全部群消息。
- 安全面：私聊/群聊白名单（从最近入站勾选或粘贴 id）。

### 6.2 路由

```
GET    /api/dsh-soulmojito/im                   # 通道/账号/绑定/最近入站投影
POST   /api/dsh-soulmojito/im/accounts          # 创建（OneBot）或改配置
DELETE /api/dsh-soulmojito/im/accounts          # 解绑账号
POST   /api/dsh-soulmojito/im/bind/start        # 开始扫码
GET    /api/dsh-soulmojito/im/bind/status       # 轮询相位
POST   /api/dsh-soulmojito/im/bind/verify       # 提交微信验证码
POST   /api/dsh-soulmojito/im/bind/cancel
GET    /api/dsh-soulmojito/im/peers             # 绑定表 + 最近入站
POST   /api/dsh-soulmojito/im/peers             # 手动绑定/改绑/解绑
POST   /api/dsh-soulmojito/im/settings          # 白名单、群 @ 门控、节流
POST   /api/dsh-soulmojito/im/onebot/webhook    # OneBot HTTP POST 入站
GET    /api/dsh-soulmojito/im/onebot/ws         # (upgrade) 反向 WS
```

管理路由沿用 `handleApi` 的信任边界；upgrade 路由自己校验 token。

### 6.3 客户端

新增 `client-src/97-ui-im.js`，i18n 键进 `40-i18n-en.js`/`41-i18n-zh.js`，导航项进
`90-panels-core.js`，样式进 `95-ui-styles.js`；`client-architecture-split` 与导航结构
gate 同步更新。

## 7. 开工前检查表（CONTEXT.md 八项）

| # | 项 | 答案 |
|---|---|---|
| 1 | 所有者 | `src/im/`（通道 + 路由 + 投影 + 原生会话投递 + 工具挂载）、`http/im.ts`、面板「聊天渠道」 |
| 2 | 唯一事实来源 | 凭据 = `im/secrets/*`；绑定 = `state.imPeers`（值只有原生 `sessionId`）；未绑定待办 = `state.imPendingPeers`；会话/聊天事实 = 宿主 session log 与 `state.sessionBindings`；回复 = 模型调用 `im_send` |
| 3 | 持久态及理由 | 凭据（重启重连）、游标（不重收历史）、context token（微信回复必需）、去重键（防重复投喂）、peer→session 绑定（重启保持同一会话） |
| 4 | 临时态 | 连接、扫码相位、令牌桶、未绑定提示抑制窗口——重启即失；绑定与会话由用户与宿主恢复 |
| 5 | 外部依赖 | `webServer.registerUpgrade`（可选）、`agents.get/list` 与 `agent.steer/followup`（可选，两者都缺失时 IM 投递不可用）、`agent.ctx.tools.register`（工具挂载）、`api.bot.qq.com`、`ilinkai.weixin.qq.com`、上游 OneBot、`ws` |
| 6 | 注册入口 | `apply()` 里创建 IM 运行时与 `agent/created`/`agent/status` 工具挂载；`webServer.register` / `registerUpgrade`；面板分区 |
| 7 | 删除路径 | 见 §4.5；disposer 覆盖 socket、轮询、upgrade、定时器、live agent 句柄 |
| 8 | 兼容对象 | 旧装 `tavern/` 数据根、旧 `character/chatId` 绑定（归一化为 `sessionId`）、无 `registerUpgrade` 的宿主（只开 HTTP POST）、无 `agents.get` 的宿主（IM 整体不可用并说明）、`pnpm run check` 基线 |

## 8. 里程碑

> 先做原生会话绑定与投递，再挂通道：核心链路（绑定会话→立即插入→模型 im_send）不
> 通，接三条协议也只是把坏链路接三遍。

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| **M0 契约与骨架** | `ImChannel`/`ImInbound`、`ImRouter` 骨架、`projectImText`、凭据与绑定存储、面板占位、`registerUpgrade` 与 `agents.*` 探测、`im-channels` gate | 假通道 + 假 Agent 能跑通「入站→绑定→投递→回复」，`pnpm run check` 绿 |
| **M1 原生会话绑定 + IM 工具** | `sessionId` 绑定、未绑定对端待办、`agent.steer`/`agent.followup` 立即插入、`im/agent-mount.ts` 把 `im_identity`/`im_channels`/`im_send` 挂进每个 agent 域 | 绑定到原生会话后收到消息立即插入；模型用 im_send 回复；工具身份不可伪造 |
| **M2 OneBot 11** | 反向 WS（Universal）+ HTTP POST + 出站 API、token 鉴权、单聊/群 @、去重 | 用户自备实现连入，私聊与群 @ 双通 |
| **M3 QQ** | 扫码绑定、网关接入、被动回复限流、Markdown 分块、私聊流式、群 @ 门控、自动绑定 | 扫码后私聊/群聊双通，超长与超次回复正确降级 |
| **M4 微信** | 扫码（含验证码）、长轮询与游标、context token、typing、markdown 过滤、-14 暂停 | 扫码后私聊双通，连续多轮不丢上下文 |
| **M5 收口** | 媒体双向、错误话术、审计计数、解绑清理、文档与面板完善 | 媒体不崩、错误可读、`README`/`docs` 更新 |

## 9. 验收与测试矩阵

| 测试 | 形态 | 断言 |
|---|---|---|
| `im-session-host.spec.ts` | 假 agents 注册表 | 缺 get/list 的能力原因；活 agent 查找与「会话未打开」结构化错误；inbox 消息的 v4/v0 source 形状；running→steer、idle→followup、缺 steer→followup |
| `im-router.spec.ts` | 真 store + 假通道/假 Agent（记录 inbox 插入） | 入站立即插入绑定会话、无 debounce；未绑定对端进待办并回提示；媒体物化排在访问控制之后 |
| `im-tools.spec.ts` | 真工具面 | `im_send` 默认只能发当前 peer；跨 peer 关闭时拒绝；身份不可由参数伪造 |
| `onebot-protocol.spec.ts` | 真 `ws` 服务端与客户端环回 | universal 握手头、`post_type` 解析、`echo` 配对、错误 token 401 |
| `onebot-webhook.spec.ts` | 真 HTTP 环回 | 事件接收、快速操作 `reply`、超大 body 拒绝 |
| `weixin-channel.spec.ts` | 本地 HTTP 桩服务（真实 socket） | 扫码全状态机（含 `need_verifycode`/`scaned_but_redirect`/`binded_redirect`）、游标推进与「投递先于落盘」、`-14` 暂停与暂停期不出站、`sendmessage` 载荷 |
| `qq-transport.spec.ts` | SDK 对桩 OpenAPI + 桩网关 WS | 鉴权头、`msg_id/msg_seq`、限流到 4 后降级、分块不切断代码块 |
| `im-security.spec.ts` | 真 store + 真 HTTP | 空名单拒绝、密钥不落 `state.json`、日志脱敏、媒体超限拒绝 |
| GUI 手测 | 桌面 + 390×844 | 扫码弹窗、状态灯、绑定表、解绑后连接消失 |

回归底线：`pnpm run check`（tsc + vitest + build + 全 gates）。

## 10. 风险与未决问题

**风险**
1. **会话托管是新能力**：本插件从没创建过宿主 agent。`agents.create` 的 meta/setup
   形状、preset 落 header、重启后 resume 的 preset 身份都要实测；建议 M0 先写一个最小
   spike 验证再铺开。
2. **第三方协议代码不进产物**：QQ 的两个腾讯包（其一 UNLICENSED）改为外挂安装在
   `$DSH_HOME/<tavern>/im/runtime/`，运行期动态导入；宿主没装时账号写入与扫码都
   fail-closed 并给安装命令。代价是部署多一步，收益是 GPL 产物里没有不可再分发的
   代码，也不需要 esbuild 的 external/垫片。
3. **被动回复窗口**：QQ `msg_id` 有时效与条数限制，长回复第 5 条起必须降级主动推送。
4. **微信文档自述不完整**：只做「文档写了的」，灰度 + 可观测，不猜字段。
5. **宿主 seam 漂移**：`registerUpgrade`、`agents.steer/followup` 都是可选 seam，探测 + 失败
   关闭，OneBot 保留 HTTP POST 兜底。
6. **群消息密度**：群里多人闲聊会持续触发生成 → @ 门控（默认开、可关）+ 令牌桶 +
   面板可见计数；但**不做攒批**（与「立即投递」互斥）。
7. **共享会话＝共享上下文**：多条绑定指向同一个原生 session 时，不同 peer 的对话互相
   可见。绑定是逐 peer 的显式动作；面板徽标、README 与设置说明都要写清。
8. **合规**：OneBot 上游可能是非官方客户端，本插件不提供、不内置、不背书；启用时面板
   明示「上游由你自备并自负合规责任」。

**已定档（2026-10-31 修订，取代 2026-10-30 的绑定三态）**
- 绑定目标是**已存在的原生会话**：未绑定对端在面板列为待办，用户手动绑到当前会话；
  插件不代建会话、不导入 Tavern 聊天。
- QQ 群默认必须 @ 才投递，面板提供 `imGroupRequireMention` 开关可关。
- `im_send` **不允许跨会话**：目标必须已绑定到当前 session。
- 解绑 peer 时**保留**会话，只删绑定。

**已知行为（2026-10-30，微信通道落地）**
- **暂停态不持久化**：`-14` 的一小时暂停只活在进程内（`pausedUntil`），重启/重连即清空
  并立刻重新探测；token 仍失效时会在首个 `getupdates` 再次暂停。好处是不用维护一张
  带时钟的磁盘状态，代价是重启后可能多发一次请求。
- **`verify_code_blocked` 判死**：验证码尝试过多时本次扫码直接 `failed` 并要求重新扫码；
  参考实现把该状态继续当作可轮询状态返回。协议没有解除封锁的路径，继续轮询一张已封锁
  的二维码只是空转（详见 [`decisions/2026-10-30-weixin-channel.md`](../../decisions/2026-10-30-weixin-channel.md) §5）。

**未决问题**：无。
