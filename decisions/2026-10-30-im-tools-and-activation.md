# IM 工具族与历史导入抽取（提案 0024 第二批）

> 日期：2026-10-30。状态：已落地。上一批见 [`098db83`](../../) 的提交说明与
> [`docs/plans/2026-10-30-im-channels-implementation.md`](../plans/2026-10-30-im-channels-implementation.md)。

## 问题

第一批交付了「入站 → 绑定 → 立即投递 → turn/end 回发」的主干，但有两个洞：

1. **模型不知道自己在对谁说话**：会话里只有一条条用户消息，没有任何工具能查
   「这个会话来自哪个渠道、是私聊还是群、角色是谁」。提案 §3.6 要求的 IM 工具族
   缺位。
2. **IM 新建/绑定的会话看不见已有历史**：命令激活会把聊天历史以真实 turn 边界
   导入宿主会话，IM 侧没有对应路径。独立模式看不到开场白，手动绑定的老聊天更
   糟——模型在一段它看不见的对话后面接着说话。

## 方案

### 1. 历史导入抽成 `session/activate.ts`

`session/command.ts` 里「写入 → 读回对齐 → 仅干净前缀补写一次 → 失败兜底关
turn → 按日志推进轮次基线」这一段原样搬到 `applyAgentTavernHistoryImport()`，
命令与 IM 共用。抽出后命令侧的事件序列逐条不变（既有 `tavern-command.spec.ts`
与 `agent-tavern-tools.spec.ts` 未改期望即通过）。

IM 侧三条路径都导入：独立模式（新聊天只有 greeting）、手动绑定（老聊天全部
历史）、共享模式（复用聊天，但会话已有 turn 时跳过，避免双写）。

### 2. IM 工具族用 alias，不暴露平台身份

`im_identity` / `im_channels` / `im_send` 挂在 AgentTavern preset 末尾，身份只取
`exec.agent.id`。对模型只暴露 `peer-<sha256 前 10 位>` 的 alias，不返回 peerKey、
peerId：QQ openid 与微信 user_id 一旦进上下文，就可能被模型复述到群里。

### 3. 工具注册按环境开关，不按运行时是否就绪

运行时发布挂在 `store()` 的异步链上。用「运行时已发布」做注册门控会让启动期先
挂载的会话静默少三件工具，直到下一次 recompose。改为读同步的
`DSH_SOULMOJITO_DISABLE_IM`：开关稳定，运行时缺失由工具调用各自降级
（`im_channels` 回 `available:false`，`im_send` 明确报错）。

### 4. 跨 bundle 句柄带 sequence 守卫

工具活在 `agent.mjs`、运行时活在 `index.mjs`，只能经 globalThis 互见。发布返回
撤销函数并按 token 校验，镜像 `publishGamesService`：热重载时旧 fiber 的 disposer
晚于新 fiber 执行，无条件下删会把新句柄一起抹掉，回复抽取随后静默停摆。

## 否决项

- **把 IM 工具塞进独立 preset**：会让「同一会话既跑 RP 又能发 IM」变成两套工具
  面，且 preset 切换会丢工具。追加到既有数组末尾、gating 由 env 决定的成本更低。
- **返回 peerKey 让模型自选目标**：可达但泄露 openid；alias 同样能定位，代价只是
  多一次哈希。
- **手动绑定不导入历史**：会让模型在一段看不见的对话后面接着说话，且不报错——
  这是审查判定的 P1，不接受。

## 与规格的偏差

- 提案 §3.6 说 `im_identity` 返回「显示名 + 最近 N 条发言人」；本轮不持久化入站
  发言人，先返回 alias/渠道/私聊群/角色/聊天。发名人摘要等通道适配层落地后补，
  因为那需要一张入站环形缓冲（与 `imStore` 的去重日志同源）。
- `im_send` 的文本不过 `deps.render`（展示层正则），只过 `projectImText`。原因：
  展示正则属于「模型正文 → 用户可读」的投影，工具主动发言不是正文；`<UpdateVariable>`
  一类内部块仍会被 `stripFrontendDocuments` 剥掉，不会外泄。

## 验证

`pnpm run check`：tsc 三段 + 全量 vitest + build + 18 gates。
本批新增 `im-tools.spec.ts`、`session-activate.spec.ts`，并给 `im-session-host.spec.ts`
补「导入必须晚于绑定」的顺序断言（此前把顺序改坏，6 条测试全绿也抓不到）。
