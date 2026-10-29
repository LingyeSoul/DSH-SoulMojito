# AgentTavern 正文读侧：候选切换按组失效 + 楼层落后时 ledger 优先

> 日期：2026-10-29。状态：已实现（工程验证通过；真机浏览器 E2E 待补）。
> 相关：`docs/proposals/0021-agent-tavern-body-ops.md` §7.3、
> `packages/plugin/client-src/89b-ui-body.js`、`packages/plugin/src/agent-tavern/body-view.ts`、
> `packages/plugin/src/agent-tavern/body-session.ts`、`packages/plugin/src/http/router.ts`。

## 问题

两个读侧现象来自同一条错误假设——“一次 body 写入只影响被点击的 message”：

1. **候选切换卡手/正文消失**：客户端 `bumpTavernBodyRevision(sessionId, messageId)`
   只清被点击那一行的缓存。切到候选 B 后，A 行重取为 `hidden: true`，B 行仍命中
   旧的 `hidden: true` 缓存，于是整组正文可能同时消失；用户来回点候选才偶尔恢复。
   真实会话日志里连续 16 次 `select`（`0/1` 交替）即此现象。
2. **编辑后显示不及时**：`GET body` 的 `text` 优先取 JSONL 楼层。投影器
   （`src/index.ts` 的 `session/event` listener）是 fire-and-forget，`PUT body` 返回后
   GET 可能先读到旧楼层；之后没有别的 refetch 触发，旧文本会一直留在气泡里。

## 决策

1. **按 body 组失效缓存**：每次成功变更后，删除同一 `sessionId + groupId` 下所有
   message 的缓存，并递增一次 `bodyMutationEpoch`；变更前发出的 GET 响应不得回填缓存。
2. **读侧 freshness 判定**：`GET body` 将楼层与 ledger 对比——
   `agentTavern.lastBodyEventSeq` 覆盖最新 `edit`，且楼层 anchor/index 与 ledger 一致，
   才算“当前”。落后时返回 `projectionPending: true`：edit 水位落后时 `text` 用 ledger
   文本；仅 selection 落后时用楼层 `swipes[ledger.selectedIndex]` 的保存层文本（楼层
   可能仍指向旧 anchor，但候选文本已在 `swipes` 里）。楼层当前时仍以 JSONL `mes` 为准
   （保存层正则 + markdownOnly 展示层）。
3. **客户端有界重取**：只有当前 anchor 行会在 `projectionPending` 时按
   150/400/900ms 重取；隐藏候选行不驱动重试，避免两行互相取消/触发死循环。
   下一次用户变更会重置重试计数。
4. **不在服务端阻塞投影**：不 await projector 队列（listener 入队是异步的，
   阻塞 GET 会把投影失败放大成读失败）；仍由既有 projection-pending 重试与启动恢复兜底。

## 否决项

- **只清被点击的 message**：候选切换必然同时改变两行（旧 anchor 隐藏、新 anchor 显示），
  单 message 失效无法保证一致。
- **清空整个 session 的缓存**：长会话会一次触发几十个 GET，换来实现层的“简单”。
- **编辑响应只靠 mutation 返回值**：返回值没有展示层正则，且其它候选行仍需刷新。
- **GET 直接等投影队列**：入队经 `Promise.then` 延后，drain 不保证包含本次事件；
  失败时还会把已提交的编辑读成错误。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 组内行数多时一次刷新多个 GET | 只刷新同组候选（通常 2–5 行），其余 message 命中缓存 |
| 旧响应回填已失效的缓存 | `bodyMutationEpoch` 在请求开始时捕获，变更后拒绝回填 |
| 楼层永远落后导致无限重取 | 只重试 3 次；下一次用户变更重置；隐藏行不驱动重试 |
| 展示层正则短暂缺失 | 先显示 ledger 文本（用户刚保存/切换的原文），重取后回到 JSONL 文本 |

## 证据

- 真实会话 `session-6d5655c4`：结算后连续 16 次 `select`（`0/1` 交替，间隔 0.4–2s），
  每次只追加一条 `select`，没有投影错误——与“切换后正文不显示、用户来回点”一致。
- 同一会话：`op-start` 的 start-hide 覆盖 34–61（旧正文与旧 turn process），trigger
  turn 从 73 开始，证明重试请求不再包含旧稿；Trajectory 仍会按 append-only 日志展示
  `body-regenerate` 上下文行，这是宿主只读投影的已知限制（见
  `2026-10-29-agent-tavern-regenerate-hides-draft.md`）。
- 工程验证：body 聚焦 273 tests 全绿；`npm run check` 见提交前记录。

## 删除路径

- 停止读侧重试：移除 `projectionPending` 分支即可回到“只读 JSONL 楼层”的旧语义，
  已落盘的编辑/选择事件不受影响。
- 组级失效可缩回单 message 仅用于 edit；候选切换必须保持组级。
