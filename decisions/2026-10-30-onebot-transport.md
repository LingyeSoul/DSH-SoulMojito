# OneBot 11 连接层（提案 0024 第三批）

> 日期：2026-10-30。状态：已落地。前置：提案 0024、施工计划
> [`docs/plans/2026-10-30-im-channels-implementation.md`](../plans/2026-10-30-im-channels-implementation.md)。

## 问题

前两批打通了「peer → 会话 → 立即投递 → 回复抽取 → 文本投影」，但没有任何真实通道：
运行时通道表为空，`webServer.registerUpgrade` 从未接线，OneBot 只有 codec。

## 方案

### 1. 最小 RFC 6455 服务端，不引入 `ws`

`im/onebot/ws.ts` 自实现握手与帧：`Sec-WebSocket-Accept`、掩码强制、`RSV=0`、
分片累积、`ping→pong`、close 回显、`1002/1003/1007/1009/1011`。只做服务端文本帧。

理由：仓库的产物是零运行时依赖的自包含 bundle，一个协议适配器不该打破这条性质；
后续 QQ 需要的是 WS **客户端**，Node 22 自带全局 `WebSocket` 就够，没有必要为两种角色
各引一份实现。代价是要自己维护帧层，因此帧层用真实环回测试锁住（含未掩码帧、分片、
超限、非法 UTF-8）。

### 2. 升级席位进程内常驻

`im/onebot/seat.ts`：`registerUpgrade` 对同一路径重复注册会抛错，而热重载时新 fiber
的注册可能早于旧 fiber 的 disposer。若「每次 apply 注册一次」，重载后新实例永远拿不到
路由，旧路由又指向已死的闭包。

做法：席位在 globalThis 上只注册一次，**不由任何实例生命周期回收**；握手时按
`resolveImRuntime()` 解析当前实例，实例卸载中直接 503。重建后自动恢复，不需要重启进程。

### 3. 同一连接的出站串行

`OneBotChannel.send()` 把整轮分片挂到该连接的 `sendChain` 上：两轮回复并发时分片必须
整轮发完再发下一轮。此前 `ws.ts` 只串行化了字节写入，消息语义仍会交错，用户看到
`A1,B1,A2,B2` 的碎片。

### 4. 凭据只认请求头

`Authorization: Bearer` 与 `X-OneBot-Token`，**移除** `?access_token=`：查询串会进访问
日志与反代日志，且 `URLSearchParams` 会把 token 里的 `+` 解码成空格，含 `+` 的 token
永远匹配不上。

### 5. 去重键带 scope 与 peer

`imDedupeKey(channel, accountId, scope, peerId, messageId)`：平台的 `message_id` 只在
单会话内唯一，两个群撞号时旧键会把后到的一条当重放丢掉。

### 6. `status()` 区分「有连接」与「能出站」

只挂了 Event 客户端时状态为 `paused`（原因写明 outbound 不可用），不再谎报 `online`。

## 否决项

- **引入 `ws` 依赖**：破坏零运行时依赖；两种角色（服务端/客户端）各引一份更重。
- **每实例注册 upgrade 并吞掉重复注册错误**：吞掉只让错误消失，新实例仍然没有路由。
- **webhook 支持快速操作 `reply`**：本轮只做入站；快速操作需要把宿主回复写得非常短，
  与「生成在 turn 结束后才产出」的时序不匹配。
- **解绑账号时顺手删 peer 绑定**：解绑只断通道，聊天与会话按产品决定保留。

## 与规格的偏差

- 提案 §9 的 `onebot-webhook.spec.ts` 并入 `onebot-server.spec.ts`，不单列文件。
- 未做 `im-channels` gate（提案 §5 要求）：字段面已由测试锁住，但 gate 需要与面板一起
  落地才有意义，排在客户端那一轮。
- webhook 的群 @ 判定仍用事件体里的 `self_id`（WS 路径用握手头）。持有 token 者可伪造
  `self_id` 改变「@ 谁算 @」，影响限于门控判定，不构成越权；后续给账号密钥袋加
  `selfId` 后以配置为准。

## 验证

`pnpm run check`：tsc 三段 + 全量 vitest + build + 18 gates。
本轮新增 `onebot-server.spec.ts`（17 条，真实 `node:http` + 全局 `WebSocket` 环回）、
`im-runtime-accounts.spec.ts`、`im-http-accounts.spec.ts`；审查阶段补了三条变异缺口：
未掩码帧必须 `1002`、并发 `send` 不得交错、Event-only 连接必须 `paused`。
