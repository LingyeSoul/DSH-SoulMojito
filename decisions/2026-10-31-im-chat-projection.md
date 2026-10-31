# IM 对话投影进酒馆聊天：入站 relay 与成功 im_send 都成为普通楼层

> 日期：2026-10-31。状态：**已实施**。前篇：
> [`2026-10-31-im-native-session-binding.md`](./2026-10-31-im-native-session-binding.md)、
> [`2026-10-31-im-inbound-coalescing.md`](./2026-10-31-im-inbound-coalescing.md)、
> [`2026-10-31-im-message-refs.md`](./2026-10-31-im-message-refs.md)。

## 背景

IM 绑定的是宿主原生会话，AgentTavern 投影只读 `sessionEvents(session)` 再把
user/assistant 消息写进 Tavern 聊天。IM 两个方向恰好都落在投影的盲区里：

- **入站**：路由把消息经 `agent.followup()` 投进绑定会话，宿主记成
  `agent/inbox/spliced`（`data.inserted[]`，source 为
  `{ kind: 'plugin:dsh-soulmojito', form: 'relay', summary }`）。旧投影只处理
  `user/message` 且 `source.kind === 'user'` 的事件，relay 被整条忽略。
- **出站**：模型的回复是 `assistant/message` 里的 `im_send` 工具调用。旧投影对
  任何带 `tool-call` 的 assistant 消息直接返回，回执对应的实际发送文本也不落库。

结果是 `tavern_history_search`、记忆维护与聊天界面都看不到 IM 对话：对端说了
什么、模型回了什么，全部只存在于宿主会话日志里。

2026-10-31 从本机真实 v4 IM 会话（`~/.dsh/sessions` 解压）取证，确认了三件事：

1. `agent/inbox/spliced` 的插入事件带 `inserted[]`；消费事件只有
   `removedCount`、没有 `inserted`，不能产生楼层。
2. 同一条入站消息先以 splice 插入，随后在轮内被宿主物化成 `user/message`
   （消息 id 相同、seq 不同）。只按事件 seq 判重会把每条消息投影成两层。
3. 真实工具回执形状是
   `tool/result => data.message = { id, role: 'tool', toolCallId, isError, content, source: { kind: 'tool', callId } }`；
   `assistant/message` 的 tool-call 块用 `id` 标 callId（旧宿主/测试夹具用
   `callId`），`arguments` 是 JSON 字符串。

## 决定

1. **只读投影，不伪造宿主事件。** 新逻辑只读 `sessionEvents(session)`，只写
   Tavern 聊天 store；不 append、不改写任何 DSH 事件，IM 路由行为不变。
2. **入站一层一消息。** 对 `agent/inbox/spliced` 的 `inserted[]` 与
   `user/message`（`source.form === 'relay'`）走同一段构造逻辑：每个插入消息
   投影一层 user 楼层。正文解析自 `router.ts` 的 relay 文本：去掉
   `[IM <channel>/<私聊|群聊> peer=<alias> msg=<ref> time=<iso>]` 头部、末尾
   `（这是从 IM 转发给你的消息…）` 尾部，以及合流正文逐行的 `[msg-…] ` 引用；
   合流的多条正文按原顺序保留，群聊的 `[昵称]` 前缀属于正文原样保留。
   头部的 `msg=` 引用直接作为楼层的 `im.ref`（它就是 `imMessageRef(dedupeKey)`
   的产物）；`dedupeKey` 从不进会话日志，事后无法重新计算，这里只校验
   `msg-<10 hex>` 形状，合流头没有单一引用则省略。
3. **解析失败绝不丢消息。** 头部/尾部任一不匹配时落完整原文，并在
   `extra.agentTavern` 标记 `via: 'im-relay'` + `parse: 'fallback'`；alias 依次
   从原文 `peer=`、source.summary 的 `from <alias>`、唯一绑定推断，仍未知则为
   空串（不猜）。
4. **出站只记真正发出去的。** assistant 消息里的 `im_send` 调用先进入本会话
   的内存索引（callId → 参数/坐标）；对应的 `tool/result` 到达且 `isError`
   为假、JSON 正文没有 `error` 成员时，才投影一层 assistant 楼层。文本取调用
   的 `text`，纯媒体记 `（图片）/（语音）/（视频）/（文件）` 紧凑标记，图文都
   有时文本在前、标记另起一行。失败/无回执的调用不产生楼层；带 tool-call 的
   assistant 正文整段不投影（它没有送达对端）。同一 assistant 消息的多个
   `im_send` 楼层共享 `messageId`，但它们不是 body 楼层：按 messageId 扫描的
   body 定位路径（写定位、`GET body` 读定位、回滚定位）跳过
   `via: 'im-send'` 的楼层，否则两个楼层会被判成 body 重复绑定。
5. **稳定投影身份。** 所有新楼层在 `extra.agentTavern.projectionKey` 写身份：
   普通楼层 `<sessionId>:<eventSeq>`，IM 楼层再带插入消息 id 或 callId。判重
   另外按 relay 的 `messageId` 与出站的 `callId` 兜底——同一条消息的 splice
   与 `user/message` 两个事件 seq 不同，也必须只留一层。升级前没有 key 的老
   楼层继续按旧的 `<sessionId>:<eventSeq>` 判重，重放不会重复。
6. **多对端加前缀。** 楼层 `extra.agentTavern.im.peerAlias` 恒有值；同一会话
   有多个不同绑定 alias 时，`mes` 前缀 `[<alias>] `，单对端保持正文干净。
7. **没有 IM 绑定的会话完全不变。** 只有
   `state.imPeers` 里至少一条 `binding.sessionId === session.id` 的 AgentTavern
   会话才走新分支；其余会话的 relay/工具事件照旧不产生楼层，普通 user/assistant
   投影与 body/MVU 路径不动。
8. **提示词补一句。** `agent-tavern-im` 预设新增一行：IM 收发都会记进聊天历史，
   需要回忆时用 `tavern_history_search`。

## 代价与边界

- **旧会话不会自动回填。** 投影检查点（`<tavern>/projections/<hash>.json`）已经
  越过历史 IM 事件，启动重放会跳过它们；本轮不自动清检查点。要让存量会话补出
  IM 楼层，需要人工重置该会话的投影检查点后重放（普通楼层按旧 eventSeq 判重，
  不会重复；但改绑过的会话可能把更早的消息补进当前聊天，需用户确认）。
- **relay 文本是解析契约。** 头部/尾部措辞一旦改动，解析会退化为 fallback：
  楼层保留完整原文（含头部与提示尾巴），不会丢消息，但可出现传输噪声。
- **合流楼层的单条引用不落库。** 合流头没有单一 `msg=`，正文逐行引用被视为
  传输元数据去掉；楼层只保留正文顺序。需要锚定具体消息时仍以模型上下文里的
  原始 relay 文本为准。
- **出站楼层按回执顺序写入。** 多个 `im_send` 的楼层顺序等于 tool result 到达
  顺序；正常宿主按调用顺序回执。
- **被取消的 splice 插入仍会落层。** 消息确实从平台到达了绑定会话（`inserted`
  事件已持久化），只是宿主可能因归档/等待取消而没让模型消费；IM 历史应保留
  对端说过的话。消费事件（只有 `removedCount`）本身不产生楼层。
- **重启窗口靠日志回填，游标只前进。** 若进程在 assistant 事件已越过检查点、
  result 之前重启，内存索引为空；出站投影按日志数组游标回填调用参数：首次
  从日志开头扫一遍，之后每个 miss 只补扫游标之后的新窗口，不会为每个工具
  回执重复全量扫描（不依赖进程内状态存活）。
- **投影失败仍按原来的 pending 检查点重试。** 楼层写入失败不会推进水位，重放
  时按 `projectionKey`/消息 id/callId 判重，不会写两层。
- **没有绑定就没有楼层。** 未绑定/改绑后的会话不产生 IM 楼层；这是有意的，
  避免把旧对端的对话写进当前聊天。

## 否决项

- **给宿主 append 自造事件（如 `im/relay`）。** v4 词汇表封闭，未知事件类型会让
  整份会话拒载；投影必须是只读折叠。
- **按事件 seq 判重。** 真实宿主会把同一条 relay 以 splice + `user/message`
  两个事件持久化，seq 判重必然双写。
- **把失败发送也记成楼层。** 对端没收到的东西写进历史，会污染记忆与检索。
- **投影 tool-call assistant 的正文。** 正文没有经过 `im_send`，不等于送达。
- **解析失败就丢弃消息。** IM 消息是用户真实输入，宁可带传输噪声也不能消失。
- **自动清检查点回填历史。** 改绑/归档场景会把旧对端消息写进当前聊天；回填必须
  是显式的人工动作。
- **按「最近一个对端」猜 alias。** 多对端会话会归错人；只认 relay 头/摘要里的
  alias，未知就留空。

## 验证

- `packages/plugin/tests/agent-tavern-projector.spec.ts` 新增 14 个用例：
  入站单条去头去尾、合流群聊顺序与 `[昵称]`、splice + `user/message` 去重、
  仅 `user/message` 形态（v0-v3 老 source/无 msg 头）、成功 `im_send`、失败与
  结构化传输错误不落层、一次 assistant 多个 `im_send` 顺序、纯媒体/配文标记、
  多对端前缀、解析 fallback、重启后索引回填、回填游标只补扫新窗口、无 IM 绑定
  的会话不产生楼层；所有既有投影用例保持通过。
- `packages/plugin/tests/agent-tavern-body-jsonl.spec.ts` 新增 3 个用例：同一
  assistant 消息的多个 `im_send` 楼层存在时，按 messageId 的 body 写定位/读
  定位仍解析到真正的 body 楼层；只有 IM 楼层的 messageId 不会被当成 body 楼层。
- `packages/plugin/tests/im-agent-preset.spec.ts` / `im-tools.spec.ts` /
  `im-router.spec.ts`：IM 核心行为未变（提示词新增一行不改变工具与路由契约）。
- 真实 v4 IM 会话重放（本机日志，仅本地验证、不入库）：3 层楼——入站
  「示例消息」、`im_send` 实际发送文本、该轮普通 assistant 叙述；splice 与
  `user/message` 未重复。
- `npx tsc -p packages/plugin/tsconfig.json --pretty false` 通过；
  `node packages/plugin/scripts/gates/run.mjs` 全项 PASS（gate 口径
  `split(/\r?\n/).length`：`projector.ts` 774 行、`im-projection.ts` 529 行，
  均在 800 行预算内，projector 已回到 780 行以内）。
