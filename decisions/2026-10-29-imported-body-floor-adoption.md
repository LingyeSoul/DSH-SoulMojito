# 导入楼层接管：history mirror 的正文操作落地

> 日期：2026-10-29。状态：已实现（工程验证通过）。相关：
> `packages/plugin/src/agent-tavern/body-projector.ts`（`adoptImportedAnchorFloor`）、
> `packages/plugin/src/agent-tavern/body-jsonl.ts`（`applyFloorAdoptionToChat`）、
> `packages/plugin/client-src/89b-ui-body.js`（`withBodyProjectionRetry`）、
> `decisions/2026-10-20-agent-tavern-native-display-and-greeting.md`。

## 问题

AgentTavern 激活时的历史导入把开场白/历史写成宿主会话里的镜像消息
（source 为合成 provider/model 对 `dsh-soulmojito`/`agent-tavern-import`），
投影器按既有决议**不把镜像消息反向投影回 JSONL**（否则重复）。于是聊天首楼由
`POST /chats` 写入、只有 ST swipe 字段，没有 `extra.agentTavern` 身份。用户对这条
正文点「编辑」时：

1. `PUT body` 预检 `requireProjectedCandidate` 找不到楼层 → 503 `projection-pending`
   （`body edit deferred … body floor not found …`）；
2. `ensureBodyLedger` 已追加的 `candidate` 事件在投影器侧同样 `body-floor-not-found`，
   checkpoint 停在 `pending`；
3. 客户端对 `projection-pending` 零重试，用户看到的是纯技术错误。

实测证据：会话 `session-e856e7ea…` 的 checkpoint `pending/18`（同一 group 报
body floor not found），聊天首楼 `swipes=3/swipe_id=2/extra=null`，会话首个
assistant 事件 source 为镜像对。

## 决策

1. **首个体事件接管楼层**（`adoptImportedAnchorFloor`）：锚点是导入镜像、且
   group 尚未绑定时，认领聊天里最后一条「插件未知」的 assistant 楼层
   （无 `bodyGroupId`、无 `messageId`、非 user/system、`mes` 非空），写入
   `bodyGroupId` + `sessionId` + `anchorMessageId`。
2. **收敛 swipe 面**：接管时删除该楼层的 `swipes/swipe_id/swipe_info`——body
   ledger 的槽位 (`swipes[index]`) 与候选一一对应，ST 备用开场白在激活后本就
   不可选（decision 2026-10-20）。随后本事件的 candidate 投影按「首个 body 操作」
   同一路径创建槽 0：保存层正则、`<UpdateVariable>` 补丁与 `body:<messageId>`
   receipt、`mes` 占位符语义全部与 live 楼层一致。`mes` 在投影落地前保持不变，
   接管不会留下空文本窗口。
3. **显示层不动**：接管只写 group 绑定，不写 `extra.agentTavern.messageId`，
   `GET display` 对导入楼层继续回退原文（decision 2026-10-20 边界保持）。
4. **只在合法事件上接管**：接管放在各分支的校验之后（candidate 的
   `requireProjectedCandidate`、select/edit/restore 的 ledger 校验），无效事件在
   写聊天之前就失败；非镜像锚点（live 楼层缺失 = 真滞后）不接管，checkpoint 仍是
   `pending` 等待重放。
5. **客户端有界重试**：`projection-pending` 按 200/500/1000ms 重试同一请求（幂等），
   穷尽后显示新的 `body.projectionPending` 文案而不是原始 503 消息
   （proposal 0023 §4.1 的「客户端重试一次」落为有界退避）。

旧会话的 `pending` checkpoint 在下一次 replay（`agent/created` 或
`POST /projection/replay`）按同一路径自愈；本次修复前已越过该 seq 的会话不再回头
补投，其导入首楼只读（`not-last-round`），不影响后续 live 正文操作。

## 证据

- 真实数据回放（拷贝，非原地）：把会话 `session-e856e7ea…` 的待办状态
  （checkpoint pending/18 + 首楼 `extra:null`）复制到临时 tavern 根，replay 后
  checkpoint 转 `ok/lastCursor=19`，首楼写入
  `{bodyGroupId, anchorMessageId, sessionId}`、`swipes` 收敛为 1 槽、`swipe_id=0`；
  二次 replay 聊天逐值不变（幂等）。
- 新增/扩展测试：projector 接管 + candidate 落地 + edit、MVU 导入开场白补丁
  + 单 receipt、非镜像锚点不接管（仍 pending）；wiring 侧接管后 `PUT body` 返回
  200 并追加 edit 事件；client 源检查重试函数与新增文案键。
- `npm run check`：见提交时的完整输出（tsc -b + security/plugin typecheck +
  vitest 全量 + build:plugin + gates）。

## 风险与未完成

| 风险 | 说明 |
|---|---|
| 备用开场白数据 | 接管会删除聊天首楼的 ST swipes（备用开场白）；激活 AgentTavern 后它们本就不可选，但面板 ST 视图不再展示。owner 已确认接受。 |
| 认领目标启发式 | 若聊天在导入后又被面板追加过「插件未知」的 assistant 楼层，认领可能选错目标；正常流程（会话镜像聊天 1:1）不受影响。 |
| 修复前的历史会话 | 已越过该 seq 的 checkpoint 不会回放，旧导入首楼保持只读；不会误改已继续的会话。 |

## 删除路径

- 接管只影响「未绑定」楼层；删除时停止触发 `adoptImportedAnchorFloor` 即可，
  已接管的楼层保持 `bodyGroupId`（继续可定位，语义不变）。
- 不把接管标记写入独立存储：状态仍在 `extra.agentTavern` 与聊天文件内。