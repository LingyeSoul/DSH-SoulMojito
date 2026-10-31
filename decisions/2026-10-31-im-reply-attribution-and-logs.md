# IM 回复丢失：followup 的 inbox 事件、代建 agent 的模型选择，与运行日志面板

> 日期：2026-10-31。状态：已修复（真机待复验）。来源：主人实机反馈「给微信发信息没反应」。

## 现象

微信扫码绑定成功、通道显示在线，给机器人发消息后**完全没有回复**；运行日志只有：

```text
accepted a weixin/private message from peer-… (N chars) for session session-…
turn 7 of session session-… has no pending IM origin; no IM reply was sent
```

## 根因（两处，串联）

### 1. 回复归属：followup 从不写 `user/message`

IM 入站经 `agent.followup()` 投递。真实宿主把这条消息记成 **`agent/inbox/spliced`**，
不是 `user/message`。2026-10-31 从 `~/.dsh/sessions` 解压 V4 会话日志取证（52 行）：

```text
turn/start        => data: { turn }
agent/inbox/spliced => data: { target: "next-turn", start, inserted: [UserMessage] }   // 投递
agent/inbox/spliced => data: { target: "next-turn", start, removedCount: 1, inserted: [] } // 下一轮消费
assistant/message => data: { turn, step, message, usage, stream }
turn/end          => data: { turn, reason }
```

整个会话里 `user/message` 事件数为 **0**。第一版修复只把 `userMessageIdsOfTurn`
改成「按位置归 `user/message` 的轮」，仍然返回 `[]` → 来源解析失败 → 静默不回。

宿主的消费语义在 `dsh-agent-loop` 的 `foldConsumedWork` 里：`removedCount` 的
splice 发生在某一轮打开期间，就表示这一轮消费了队列里被移除的消息。移除事件
不带 id，只能按 `start`/`removedCount` 从队列定位。

### 2. 整轮失败：插件代建的 agent 没有 provider/model

来源解析修好后还有第二层：该会话 turn 3–8 全部 `reason.kind === "error"`：

```text
prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
```

宿主注册提示词变量时取 `context.agent?.options.model`；`agentOptions` 只在
`agents.create` / `agents.resume` 时传入。宿主自己的会话入口（`dsh-api-session-controller`）
传的是 `agentDefaultModel.currentSelection()`，而插件的 `ensureImAgent` 没传——

```ts
agents.resume({ resumeSessionId, setup })            // agentOptions 缺省为 {}
agents.create({ sessionId, meta, setup })            // 同上
```

于是 `options.model === undefined`：提示词组装失败，整轮 error，用户即使收到回复
也只能是固定失败话术。

### 3. 会话被归档：pre-step 被拒，整轮 `blocked`

宿主 `dsh-api-session-controller` 的 `ArchivedSessionGate` 会在 `agent/pre-step`
拒绝归档会话提出的任何一步；agent loop 把这次拒绝记成
`turn/end => { kind: "blocked" }`，**一个请求都不发**。IM 的 followup 是「迟到的
投递」，正好落在这道闸上：

```text
turn/start turn 13
agent/inbox/spliced  removedCount: 1        // 消息被取出
turn/end turn 13     { kind: "blocked" }    // 90ms 后，没有 assistant/message
```

`5dbafd95` 这个会话在 11:00:48 被写进 `workspace.json` 的 `archivedSessionIds`。
旧逻辑只把 `blocked` 当成「没有正文的空轮」，于是又静默了一次。归档状态在
DSH 侧栏里恢复即可，但插件必须把「被阻止」和「空轮」区分开，否则用户永远只看到
「发了没反应」。

### 4. 改绑复用了旧聊天的会话（归档的起因）

用户改绑到新聊天后，消息仍然投到旧会话。`POST im/peers` 不分聊天地把
`existing?.sessionId` 传给 `bindChat`；`bindImChat` 沿用它，随后
`deps.bind(sessionId, 新聊天)` 把**旧会话的 sessionBindings 改写成新聊天**：

```text
imPeers[peer]           = { sessionId: 旧会话, chatId: 新聊天 }   // 绑定记录
sessionBindings[旧会话] = { character, chatId: 新聊天 }            // 被改写
```

于是绑定记录、会话归属、聊天三者自相矛盾：改绑看起来成功，消息却继续进旧会话；
用户把旧会话归档后，每一轮都落进上面的 `blocked`。

## 方案

1. `reply.ts` 的 `userMessageIdsOfTurn` 同时折叠两种入站形状：
   - `user/message`：保持按日志位置归轮；
   - `agent/inbox/spliced`：严格跟随 splice 维护 `next-turn` 队列，**在一轮打开期间
     被移除的消息**才算这一轮消费（`outcome: "canceled"` 的取消投递不算）。
   坏 splice 直接跳过——宁可这一轮不回，也不按猜出来的下标误认来源。
2. `session-host.ts` 的 `ensureImAgent` 给 `resume` 与 `create` 都带上
   `agentOptions`（`ctx.agentDefaultModel.currentSelection()` 的 provider/model），
   与宿主自家会话入口一致。
3. `turnBlockedOf` + `IM_TURN_BLOCKED`：`blocked` 轮回一条可行动的话术（「可能已
   归档，请先取消归档」），不再当作空轮静默。
4. `resolveBindSessionId`：手动绑定/改绑的目标会话按顺序解析——peer 当前会话仍
   属于该聊天且未归档 → 沿用；否则复用该聊天已有的未归档 AgentTavern 会话；
   都没有才铸造新会话。归档集合从宿主 `workspaceRegistry` 只读探测（不是静态
   inject，缺服务时按空集合降级）。

## 验证

- 用**真实的失败会话日志**（`session-5dbafd95…`，52 条事件）跑新归轮逻辑：
  turn 3–8 全部解析出各自 `im-*` 消息 id（修复前全为 `[]`）。
- 重启后的 turn 13：日志显示 `turn 13 produced no assistant text`，会话事件是
  `turn/end { kind: "blocked" }` 且 90ms 内没有任何 `assistant/message`——归档闸的
  真实形状。
- `im-reply-target.spec.ts`：队列投递、轮中到达归下一轮、取消投递不归属、
  `next-step` 不参与归属、`blocked` 识别。
- `im-router.spec.ts`：`finishTurn` 用真实 inbox splice 形状端到端回复到 peer；
  `blocked` 轮回「取消归档」提示而不是沉默。
- `im-session-host.spec.ts`：resume / create 两条路径都带模型选择；
  `resolveBindSessionId` 覆盖「同聊天沿用、跨聊天不复用、归档跳过、非
  AgentTavern 忽略」四种形状。

## 可观测性：运行日志面板

只看终端日志无法回答「消息到了没有、为什么没回」，所以新增一条进程内运行日志：

- `packages/plugin/src/im/log.ts`：500 条环形缓冲，`seq` 单调递增，按 `after` 增量读取，
  可按最低等级过滤。`wrapImLogger` 把宿主 logger 镜像进来——通道原本打的 warn/info
  在面板里也能看到，不需要两处写日志。
- 路由在关键节点写一条：收到（含字符数与会话）、去重命中、访问策略拒绝（warn）、
  未绑定提示、followup 失败（error）、**本轮没有 IM 来源（debug）**、回复成功（含
  分片数）、发送失败（error）。
- `GET im/logs?limit=&after=&level=` 投影给面板；时间转 ISO 字符串。
- 面板新增「IM 运行日志」带：默认过滤 `info`（debug 噪音隐藏），3 秒增量轮询，
  最多留 300 条，出错只报一次并停止轮询（点「刷新」才重启，不做重试风暴）。

日志纪律：只记录已脱敏的文本——入环前把绝对路径（含引号包裹、`C:/` 与 UNC
形态）替换为 `<path>`，peer 只出现 alias（`peer-<sha256 前 10 位>`），QR 链接只留
host，token/密钥永不进日志。面板日志带默认显示全部级别（debug 的「本轮没有 IM
来源」是「发了没反应」的关键线索），可按级别收窄。

## 否决项

- **「没有 id 命中就回给唯一 pending peer」**：共享模式下会回错人；独立模式下也会
  掩盖「宿主改了事件形状」这类真 bug。宁可修归属，不做猜测性兜底。
- **把 origin 挂到消息正文里再解析**：模型会看到内部标记，且正文会被正则/投影改写。
- **只在终端看日志**：桌面端用户看不到宿主 stdout，这正是本次排查的最大障碍。
- **只修一层**：只修归属会让用户收到「这一轮没有生成成功」，只修模型则仍然静默
  不回。两层必须一起修，用户才会看到真正的回复。
- **自动取消归档**：归档是用户在 DSH 里的显式动作，插件替用户翻回去等于覆盖他的
  决定。IM 只回一条可行动提示，状态恢复由用户在 UI 里做。

## 未覆盖

- 真机端到端仍未验证（无手机）：本轮保证「事件形状按真实日志归轮 + 代建 agent
  带模型选择」，真实回复是否到达仍需主人在微信里发一条确认。
- 已存在的坏会话需要宿主重启后由下一次入站触发 resume 才会带上模型选择；进程内
  早已 live 的 agent 不会被改写选项。
- 归档中的绑定会话不会自动恢复（见「否决项」）：用户取消归档前，IM 每轮只会收到
  「请先取消归档」的提示。
- 旧版本写坏的绑定需要升级后**再改绑一次**：`resolveBindSessionId` 会在这次改绑
  时跳过归档会话、挂到该聊天现有的会话上；插件不会在启动时自动改写用户绑定。
- 日志是进程内环形缓冲，重启即失；要留档看宿主日志。
