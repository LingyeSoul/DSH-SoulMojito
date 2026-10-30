# 提案 0024：IM 通道（QQ / 微信 / OneBot 11）

> 状态：设计；M0–M3 已实现（OneBot 11 / QQ），M4/M5 未开始。日期：2026-10-30。
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

**PR**：玩家在管理面板把 QQ 私聊、QQ 群、微信私聊各绑到一个 Tavern 会话。之后他打开
手机 QQ 或微信直接说话——消息**立刻**进入该会话的 AgentTavern 原生 AgentLoop，角色卡、
世界书、预设、记忆、变量、工具全部照常生效；本回合结束后正文原路发回手机。Agent 也能
透过 IM 工具主动发消息。全程不需要打开 DSH 页面。

**客户与验收**：
- 玩家：三条通道各自独立开关，默认关闭；扫码即绑定，无需手填 AppID/Secret。
- 玩家：QQ 群就是**普通群聊**——多个人在同一群里说话，全部进**同一个** Tavern 会话，
  每条消息带发言人标签；不是 Tavern 群组资产，不跑多角色仲裁。
- 玩家：新 peer 的绑定方式三选一——手动绑定、独立会话（默认）、共享会话；共享会话必须
  显式打开。哪个 peer 说的那一轮，回复就回到哪个 peer。
- 玩家：消息立即投递，不攒批、不等空闲、不做「延迟合并」；同一个人连发三条就是三条
  用户消息。
- 玩家：回复在 turn 结束后原路返回；美化前端 HTML、`<UpdateVariable>` 之类的内部协议
  不会出现在聊天窗口。
- 玩家：Agent 在回合内可以主动补一句、可以查「这个会话是哪个群、谁在说话」。
- 维护者：IM **不新增第二条生成循环**；AgentTavern 的 preset/工具/投影纪律原样复用，
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

**可借的**：SDK 调用、二维码状态机、限流、分块、中间件纪律。
**不可借的**：`sessionKey = qqbot:${appId}:${scope}:${peerId}` → 一个裸 DSH Agent
（`session/session-manager.ts`），入站直接 `followup` 后把 assistant 文本原样发出。
本项目的会话身份是 Tavern 会话绑定，不是一个无资产的原生会话。

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
插件侧要复刻它，现成的 seam 就是 `agent.followup(message)`：

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
                         peer → Tavern 会话绑定（sessionId + character + chatId）
                                                   │
                                        agent.followup(user/message)
                                                   │
                                 宿主 AgentLoop（AgentTavern preset）
                                                   │
                     turn/end → 读投影楼层 → displayTextForMessage
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

### 3.3 peer → Tavern 会话绑定（核心）

一条 IM 对话 = **一个 Tavern 聊天 + 一个 DSH 会话 + 一份 AgentTavern 绑定**。
角色、预设、世界书全部来自那个聊天，**不存在独立的「IM 默认角色」配置**。

```ts
interface ImPeerBinding {
  sessionId: string     // DSH 会话（AgentTavern 绑定在同一 sessionId 上）
  character: string     // 取自聊天，不单独配置
  chatId: string
  scope: 'private' | 'group'
  createdAt: string
  boundBy: 'auto' | 'manual'
}
```

**多条绑定可以指向同一个 `sessionId/chatId`**：绑定粒度是 peer，聊天归属不是。默认
`independent` 模式下每个 peer 一条独立会话；只有 `shared` 模式才会让多条绑定落进同一个
聊天，所以代码里不允许把「peer」和「聊天」当成一对一。

键：`peerKey = ${channel}:${accountId}:${scope}:${peerId}`，存 `state.imPeers[peerKey]`。

**新 peer 的绑定方式**（`state.imBindingMode`，默认 `independent`）：

| 模式 | 行为 | 需要配置 |
|---|---|---|
| `manual` | 未知 peer 不触发生成，只回「尚未绑定，请在面板绑定」 | 无 |
| `independent`（默认） | 为 peer **新建一个独立聊天**：角色与开场白取自 `imSourceChatId`，历史为空；再建会话 + 激活 AgentTavern | `imSourceChatId`（来源聊天 / 角色模板） |
| `shared` | 直接**复用** `imSharedChatId` 指向的聊天与它已有的会话，不克隆、不改历史，只写一条绑定 | `imSharedChatId` |

共享是显式 opt-in：它把多个 peer 塞进同一段上下文（代价见 §3.3.1），默认不这么做。

**会话生命周期**（新链路，需单独里程碑）：

```
ensureImSession(sessionId):
  live = ctx.agents.get(sessionId)           → 命中即复用
  else:
    setup = agentCtx => agentPresets.mount(agentCtx, AGENT_TAVERN_PRESET_ID)
    try   resume({ resumeSessionId, setup })   // 重启后按持久化会话恢复
    catch create({ sessionId, meta:{ cwd: internalWorkspace, agentPreset }, setup })
  bindSession(db, sessionId, character, chatId, false, 'agent-tavern', 'dsh-native')
  emitAgentPresetChanged()
```

`agents.create/resume` + `agentPresets.mount` 已在官方插件里被验证可行
（`dsh-qqbot/src/session/session-manager.ts` 的 `getOrCreate`），本仓库目前只观察宿主
agent、从不创建（`src/games/wake.ts` 只 followup 已有 agent），所以这是**新增能力**，
必须单独过宿主门禁。

**开场白导入**：新建聊天后，`session/command.ts:126-135,197-258` 会把开场白与既有历史
以真实 turn 边界导入宿主会话（`historyImportAppends` + `confirmSessionAppend` +
`advanceHostTurnBase`）。IM 必须走同一段逻辑，否则模型看不到角色开口。建议把该段抽成
`src/session/activate.ts`，由命令与 IM 共用，禁止复制第二份。

#### 3.3.1 回复要回到「发起这一轮的人」

共享模式下，一个会话可能同时服务多个 peer；独立模式下也可能有客户端亲自打的字，所以
「回复发到哪」不能靠聊天反查，只能靠**每条消息的回复目标**：

- 入站消息在 `followup` 之前登记 `pendingOrigins: Map<messageId, peerKey>`（内存）。
- `turn/end` 时扫描本轮的 `user/message` 事件，取第一个命中 `pendingOrigins` 的
  message id 作为该轮回复目标，发送后删除。
- 本轮没有命中的（客户端自己打的字、其它 Agent 注入）→ 不发 IM，正常结束。
- 一轮命中多个（宿主把多条 followup 合进同一轮）→ 只回最早的发起者，其余清掉 origin
  并记一条结构化 warning，避免下一轮错发。
- `pendingOrigins` 带 TTL（默认 10 分钟）与上限（默认 200/会话），超限丢弃并记 warning。

独立模式下这套判断同样跑，只是命中集合永远只有一个 peer；它顺带解决了「用户在网页里
跟同一个会话说话，插件却把回复推去 QQ」这个串台问题。

代价必须说清：**共享会话就是共享上下文**（仅 `shared` 模式）。A 与 B 在同一个人设下
连续对话，模型能看见彼此说过的话——这是复用同一聊天的必然结果，不是 bug；面板的绑定表
要给「共享会话」徽标。

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

### 3.5 生成循环：AgentTavern 优先，且只有这一条

- **入站即投递**：`agent.followup(createUserMessage(...))`，不 `await whenIdle()`、
  不去抖、不合并、不等上一轮结束（宿主 inbox 自己排队）。
- **出站来自 turn/end**：监听既有 `session/event`，会话有 IM 绑定时，在该轮
  `turn/end` 之后读投影楼层，取本轮最后一条非空 assistant 正文。
- **投影时序**：`assistant/message` 事件早于 `turn/end`，投影器通常已经写完；仍按
  ≤3s 有界轮询等待「出现新的 `extra.agentTavern.messageId` 楼层」。超时则回退到该轮
  原始 assistant 文本 + `AI_OUTPUT` 正则，并记一条结构化 warning——不让用户看到空白。
- **失败话术**：`turn/end` 的 `reason.kind === 'error'` 时回一句固定短句，不回模型原文。
- **不碰 ST**：IM 不调用 `runGeneration`，`assertStGenerationBinding` 的语义在 IM 侧
  依然成立——绑定为 `agent-tavern` 的会话不允许被 ST 入口写入。

### 3.6 IM 工具族

挂在 AgentTavern preset 的工具面上（`src/agent-tavern/agent.ts` 的 `createTools`），
仅当 IM 子系统启用时注册。**身份一律来自真实 session binding**，参数不能指定会话。

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

- **立即投递是硬不变量**：收到即 `followup`，没有 debounce、没有 batch、没有「等人说完」。
- **串行由宿主负责**：同会话多轮由 AgentLoop 排队；插件不另建队列。
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
  weixin/<accountId>/sync-buf.json      # get_updates_buf 游标
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

- **解绑 peer**：删 `state.imPeers[key]`；聊天与会话保留（用户资产不因解绑而丢）。
- **解绑账号**：停通道 → 删密钥文件与账号条目 → 清游标/context token/去重键 →
  该账号下的 peer 绑定标 `orphaned`。
- **移除 OneBot 端点**：调用 upgrade 路由 disposer、断开活动连接、删 token。
- **环境硬关**：`DSH_SOULMOJITO_DISABLE_IM=1` 时整个子系统不注册路由与连接。
- **删除聊天/会话**：既有清理逻辑负责悬挂的 `imPeers`（照 `sessionBindings` 的做法）。

### 4.6 为什么不是 Mod

Mod v1 没有出网客户端、HTTP upgrade、密钥保管、长驻 socket 生命周期。硬塞进去要 Mod
API 破一次隔离纪律，代价大于收益。

## 5. 宿主依赖与打包

| 依赖 | 现状 | 处置 |
|---|---|---|
| `webServer.registerUpgrade({path, handler})` | 宿主 `dsh-host-webserver` 已提供（`lib/types/index.d.ts:41-46`），本插件未声明 | `host-contract.ts` 加可选 `registerUpgrade?`；缺失时 OneBot 只开 HTTP POST |
| `agents.create/resume` + `agent.followup` + `whenIdle` | `HostAgentsService` 只声明了 `get/list/create?`，`HostAgentLike` 未声明 `followup` | 扩展为可选成员并集中探测；缺失即 IM 不可用（面板说明原因） |
| `agentPresets.mount` | `dsh-adapter.ts` 已用 | 复用，不新增 seam |
| `ws` | 插件当前零运行时依赖 | 不再内联：OneBot 用自研最小服务端（`im/onebot/ws.ts`），QQ 客户端由外挂的官方 SDK 自带 |
| `@tencent-connect/qqbot-nodejs` | 官方 SDK，纯 ESM；带 `ws` 与可选原生依赖 | **外挂安装**（MIT）：装在 `$DSH_HOME/<tavern>/im/runtime/`，运行期 `import()`；不进产物、不进 dependencies |
| `@tencent-connect/qqbot-connector` | 扫码状态机，纯 ESM；包声明 **UNLICENSED** | **外挂安装**：UNLICENSED 不能随本仓库的 GPL 产物再分发，由用户在自己的数据目录安装 |
| 微信协议 | 官方文档 + 参考实现 | 自研 HTTP 客户端（4 个端点），不引入 OpenClaw peer 依赖 |
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
- 绑定表：`peer → 会话`，显示角色与聊天名、`共享会话` 徽标；支持改绑、解绑、一键
  「用当前聊天新建绑定」。
- 自动绑定：`绑定模式` 三选一（手动 / 独立会话 / 共享会话，默认独立）+ 对应配置项
  （来源聊天 `imSourceChatId`、共享聊天 `imSharedChatId`）。
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
POST   /api/dsh-soulmojito/im/settings          # 自动绑定、白名单、节流
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
| 1 | 所有者 | `src/im/`（通道 + 路由 + 投影）、`src/session/activate.ts`（会话激活，与命令共用）、`http/im.ts`、面板「聊天渠道」 |
| 2 | 唯一事实来源 | 凭据 = `im/secrets/*`；绑定 = `state.imPeers`；绑定策略 = `state.imBindingMode` + 来源/共享聊天 id；会话身份 = `state.sessionBindings`；聊天内容 = JSONL；轮次事实 = 宿主 session event log |
| 3 | 持久态及理由 | 凭据（重启重连）、游标（不重收历史）、context token（微信回复必需）、去重键（防重复投喂）、peer→session 绑定（重启保持同一会话） |
| 4 | 临时态 | 连接、扫码相位、令牌桶、`pendingOrigins`（回复目标）、live agent 句柄——重启即失，由 `agents.resume` 与绑定恢复 |
| 5 | 外部依赖 | `webServer.registerUpgrade`（可选）、`agents.create/resume/followup/whenIdle`（可选）、`agentPresets.mount`、`api.bot.qq.com`、`ilinkai.weixin.qq.com`、上游 OneBot、`ws` |
| 6 | 注册入口 | `apply()` 里 `ctx.effect(() => createImRuntime(ctx))`；`webServer.register` / `registerUpgrade`；AgentTavern preset 工具面；面板分区 |
| 7 | 删除路径 | 见 §4.5；disposer 覆盖 socket、轮询、upgrade、定时器、live agent 句柄 |
| 8 | 兼容对象 | 旧装 `tavern/` 数据根、无 `registerUpgrade` 的宿主（只开 HTTP POST）、无 `agents.create` 的宿主（IM 整体不可用并说明）、既有 AgentTavern 投影与工具纪律、`pnpm run check` 基线 |

## 8. 里程碑

> 先做 AgentTavern 的会话托管，再挂通道：核心链路（建会话→激活→立即投递→取回复）不
> 通，接三条协议也只是把坏链路接三遍。

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| **M0 契约与骨架** | `ImChannel`/`ImInbound`、`ImRouter` 骨架、`projectImText`、凭据与绑定存储、面板占位、`registerUpgrade` 与 `agents.*` 探测、`im-channels` gate | 假通道 + 假 Agent 能跑通「入站→绑定→投递→回复」，`pnpm run check` 绿 |
| **M1 会话托管 + IM 工具** | `ensureImSession`（create/resume + preset mount）、抽出 `session/activate.ts`、开场白导入、`turn/end` 回复捕获、立即投递、`im_identity`/`im_channels`/`im_send` | 手动绑定的聊天在无客户端下收到消息并回话；工具面可见且身份不可伪造 |
| **M2 OneBot 11** | 反向 WS（Universal）+ HTTP POST + 出站 API、token 鉴权、单聊/群 @、去重 | 用户自备实现连入，私聊与群 @ 双通 |
| **M3 QQ** | 扫码绑定、网关接入、被动回复限流、Markdown 分块、私聊流式、群 @ 门控、自动绑定 | 扫码后私聊/群聊双通，超长与超次回复正确降级 |
| **M4 微信** | 扫码（含验证码）、长轮询与游标、context token、typing、markdown 过滤、-14 暂停 | 扫码后私聊双通，连续多轮不丢上下文 |
| **M5 收口** | 媒体双向、错误话术、审计计数、解绑清理、文档与面板完善 | 媒体不崩、错误可读、`README`/`docs` 更新 |

## 9. 验收与测试矩阵

| 测试 | 形态 | 断言 |
|---|---|---|
| `im-session-host.spec.ts` | 临时 store + 假 agents 注册表 | 独立模式建新聊天（同角色、空历史）并 create→bind→激活；共享模式复用同一 chatId；resume 命中复用；缺 `agents.create` 时 fail-closed |
| `im-delivery.spec.ts` | 假通道 + 假 Agent（记录 followup） | 入站立即 followup、无 debounce；`source.kind==='user'`；同消息二次投递被去重 |
| `im-reply-target.spec.ts` | 真 store + 假 Agent + 独立/共享两种绑定 | 独立模式只回唯一 peer；共享模式谁的 message id 命中就回给谁；本轮无命中不发 IM；一轮多 origin 只回最早的并清空 |
| `im-reply.spec.ts` | 真 store + 真实 JSONL + 投影桩 | `turn/end` 后取最后一条正文；前端/MVU 被剥；投影超时有回退 |
| `im-tools.spec.ts` | 真工具面 | `im_send` 默认只能发当前 peer；跨 peer 关闭时拒绝；身份不可由参数伪造 |
| `onebot-protocol.spec.ts` | 真 `ws` 服务端与客户端环回 | universal 握手头、`post_type` 解析、`echo` 配对、错误 token 401 |
| `onebot-webhook.spec.ts` | 真 HTTP 环回 | 事件接收、快速操作 `reply`、超大 body 拒绝 |
| `weixin-protocol.spec.ts` | 本地 HTTP 桩服务（真实 socket） | 扫码全状态机（含 `need_verifycode`/`scaned_but_redirect`）、游标推进、`-14` 暂停、`sendmessage` 载荷 |
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
5. **宿主 seam 漂移**：`registerUpgrade`、`agents.followup` 都是可选 seam，探测 + 失败
   关闭，OneBot 保留 HTTP POST 兜底。
6. **群消息密度**：群里多人闲聊会持续触发生成 → @ 门控（默认开、可关）+ 令牌桶 +
   面板可见计数；但**不做攒批**（与「立即投递」互斥）。
7. **共享会话＝共享上下文**（仅 `shared` 模式）：不同 peer 的对话互相可见。共享因此是
   显式 opt-in，默认 `independent` 一 peer 一条独立会话；面板徽标、README 与设置说明都
   要写清。
8. **合规**：OneBot 上游可能是非官方客户端，本插件不提供、不内置、不背书；启用时面板
   明示「上游由你自备并自负合规责任」。

**已定档（2026-10-30 产品决定）**
- 新 peer 绑定三态：手动 / 独立会话（默认）/ 共享会话；共享必须显式打开。
- QQ 群默认必须 @ 才投递，面板提供 `imGroupRequireMention` 开关可关。
- `im_send` **不允许跨会话**：目标必须已绑定到当前 session。
- 解绑 peer 时**保留**聊天与会话，只删绑定。

**未决问题**：无。
