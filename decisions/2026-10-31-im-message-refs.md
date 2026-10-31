# IM 消息引用：relay 头部带 `msg-<hash>`，`im_send` 用 `replyTo` 锚回触发消息

日期：2026-10-31。状态：已实施。前篇：`2026-10-31-im-inbound-coalescing.md`。

## 背景

入站消息投进宿主会话后，模型只看到 `peer` alias 与正文：它不知道「这条消息」在
平台上的身份，`im_send` 也只能回「最近一条」。QQ 的被动回复必须带回触发消息的
`msg_id`，而「最近一条」会随新消息漂移（`2026-10-31-im-inbound-coalescing` 已把
被动锚点记为排序后最后一条投递的消息）：多轮交错或一个会话绑了多个对端时，模型
无法指名「回哪一条」，路由也就不能确定该把被动锚点挂给谁。

需要一个**稳定、可引用、脱敏**的消息标识：模型在头部读到它，回复时指回它，路由
据此解析出当时的对端与被动锚点。

## 决定

1. **引用格式 `msg-` + sha256(dedupeKey) 前 10 位十六进制**（
   `packages/plugin/src/im/refs.ts` 的 `imMessageRef`）。输入必须是 `dedupeKey`：
   同一平台消息重放（插件重启、平台补发、通道重连）算出的引用一致，`replyTo`
   才能跨重连命中；引用是单向前缀哈希，**绝不含 peerId、openid 或平台消息 id**
   ——ref 会进模型上下文，也可能被复述到群里。
2. **投递成功才记引用**：`deliverOne` 与 `deliverMerged` 在 `insert` 成功后，为
   **每一条**已投递消息记 `{ peerKey, sessionId, replyTo, at }`；插入失败不记——
   没进上下文的消息不该被 `replyTo` 指回。
3. **TTL 10 分钟、容量 1000**（`IM_MESSAGE_REF_TTL_MS` /
   `IM_MESSAGE_REF_MAX_ENTRIES`）：QQ/微信被动回复窗口远短于 10 分钟，过期的
   引用没有回复价值；`record`/`resolve` 时清理过期条目，满载时淘汰最旧。表只在
   进程内，不落盘。
4. **relay 头部带 `msg=` 与 `time=`**：单条头部
   `[IM qq/私聊 peer=peer-xxx msg=msg-xxxxxxxxxx time=<receivedAt ISO UTC>]`。
   合流头保留 `（连续 N 条消息）` 且**不带** `msg`/`time`（一条头对多条，挂谁的
   都不对），每条正文行前缀自己的 `[msg-xxxxxxxxxx] `（`mergedRelayTextOf` 收
   逐条 ref）。宿主消息摘要同步带 `msg=`；合流摘要不变。
5. **`im_send` 的 `replyTo` 解析目标与锚点**：给定 ref 时经
   `router.resolveMessageRef` 查表——未知/过期直接报错，不猜；解析出的 `peerKey`
   必须是本会话的绑定 peer（否则 `does not belong to this session`），与显式
   `peer` 不一致时报错。这是「多绑定必须显式传 peer」的**唯一例外**：ref 自己
   指明了目标。条目带 `replyTo` 时把它作为该次发送的被动锚点（文本与媒体都生效，
   覆盖 peer 的自动「最近一条」锚点）。
6. **接缝保持最小**：`ImRouterHandle.resolveMessageRef` 是可选的；旧假件没有它时
   工具按「未知/过期」处理，绝不回退到最近入站对端。

## 代价与边界

- **进程内表**：重载/重启即失，旧 ref 一律按过期处理；引用只服务「刚收到的消息」
  这一场景，不做跨进程持久化。
- **条目没有被动锚点时回退自动锚点**：ref 命中但消息本身没有 `replyTo` 时，走
  既有的「最近一条」自动锚点（5 分钟 TTL）——引用只保证目标对端，不保证锚点。
- **合流批次逐条成 ref**：模型可以对批次里任意一条 `replyTo`；批次内每条各自
  记录自己的锚点，不再只有「批内最后一条」。
- **哈希碰撞理论存在**：10 位十六进制对 1000 条容量内的场景足够；表是进程内的
  短命表，碰撞窗口近乎不存在。

## 否决项

- **ref 里带平台消息 id / peerId**：会进模型上下文并可能被复述到群里，破坏既有
  的「只给 alias、不给平台身份」纪律。
- **未知 ref 回退到最近一条消息**：多轮交错/多对端时会回错人；宁可报错，让模型
  重新看头部确认。
- **持久化引用表**：TTL 只有 10 分钟，落盘的读写与迁移成本换不来它的价值。
- **合流头带单个 msg**：头对多条，挂谁的都不对；改用逐行前缀。
- **让 `replyTo` 接受 peerId 或平台消息 id**：等于把平台身份面重新打开。

## 验证

- `packages/plugin/tests/im-router.spec.ts`：单条头部含 `msg=`/`time=`、摘要带
  `msg=`、同一 dedupeKey 重放得到同一引用、合流正文逐行带自己的 `[msg-...]`、
  `resolveMessageRef` 投递后可查/过 TTL 后不可查、relay 文本与摘要不含原始
  peer id/平台消息 id。
- `packages/plugin/tests/im-tools.spec.ts`：`replyTo` 解析出 ref 的 peer 并把被动
  锚点透传给 text/media 发送、未知 ref/跨会话 ref/与 `peer` 冲突各自报错、多绑定
  时 `replyTo` 可单独定目标、工具描述提到 `msg=` 与 `replyTo`。
- `packages/plugin/tests/im-agent-preset.spec.ts`：预设提示词提到消息头的 `msg=`
  与 `im_send` 的 `replyTo`。