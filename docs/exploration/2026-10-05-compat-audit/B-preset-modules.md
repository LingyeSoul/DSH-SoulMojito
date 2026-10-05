# 审计 B · Agent preset 双模块（已完成 2026-10-05）

宿主基准：`.npm-cache/dsh-runtime/node_modules/@deepseek-ai/`（0.2.0-rc.2）
审计员结论总判定：契约面基本严密，唯一硬不兼容 = 导入 assistant/message 缺 `stream`（会话毒化级）。

## 必修（❌）

1. **`packages/plugin/src/agent-tavern/projector.ts:317-336`** — `historyImportAppends` 构造的 `assistant/message` 事件 data 缺宿主必填 `stream` 字段。
   - 宿主证据：`dsh-session/lib/types/types.d.ts:336` `stream: AssistantStreamRecord[]` 非可选。
   - 症状：append 当时不炸（运行时校验 `dsh-session/lib/index.js:1191-1216` 不查 stream），但进程重启/resume 走 seed 校验 `dsh-session/lib/index.js:1164-1170 assertAssistantSettlementShape` 必抛 `seed assistant/message at index N has invalid settlement fields` → 会话永久无法恢复。
   - 修复：data 补 `stream: []`（一行）。

2. **`packages/plugin/src/index.ts:2570-2579`（recordTavernSessionAssistant）** — 同型：append 的 assistant/message 缺 `stream` → resume 毒化。同修。

## 建议修（⚠️）

3. **`packages/plugin/src/index.ts:2559` 附近（recordTavernSessionChunk）** — `assistant/chunk` 不在 0.2.0-rc.2 SessionEventMap（事件全集：turn/*, step/*, user/message, developer/message, system/*, assistant/message, assistant/attempt, tool-call/*, tool-result/*, request-header, request-context, session-end-seed）。append 必抛，try/catch + `logging=false` 静默关闭整个 ST 生成 trace → assistant/message 不再写。修复：删掉该 append 或改走 assistant/attempt 语义。
4. **`packages/plugin/src/dsh-home.ts`** — 宿主 home 优先级 `explicit configured path > $DSH_HOME > ~/.dsh`（`dsh-home-paths/lib/index.js:65`）；插件只认 `$DSH_HOME || ~/.dsh`。宿主被显式配置且未设 DSH_HOME 时存储分叉。低概率，对齐之。
5. **agent-novel/usage.ts:79-98 + writer.ts:795-798** — SubagentResult 无 `usage` 字段（`dsh-subagent types.d.ts:256-282`），token 观测恒空。fail-open 已声明，不阻断——挂起等宿主。

## 已验证 ✅（无需动，证据见审计员报告）

- cordis.patch.yml 两个 preset 声明五字段（id/name/description/order/plugins）与 `dsh-agent-preset` Config 全匹配；入口 name 与 agent.mjs:4002 / novel.mjs:5666 一致。
- inject=['systemPrompt','tools']、section/context seam（含 agent 身份通道 `dsh-agent dispatch.js:92-94 assembleContextFor`）、ctx.effect 双参。
- ToolDefinition/output.schema+render/exec.agent/signal 全匹配 `dsh-tools index.d.ts:115-128,106-113,229,241`。
- subagents spawn 全链：provider 'spawn'、`SubagentStartRequest`、toolFilter allow:[] 清空语义、`SubagentRun{result.stopReason:'completed'}`。
- agent/pre-step waterfall + prepend:true；payload `{agent:{session},turn,step,signal}`。
- v4 source 版本分支（≥4 `plugin:dsh-tavern`，<4 `{kind:'plugin',plugin}`）双侧闭环：v4 拒裸 'plugin'（v3-to-v4 index.js:126），迁移重写未列名插件（index.js:85-92，dsh-tavern 不在 RELEASED_SAME_NAME_PRODUCERS）。
- session 读取三形态探测命中 0.2.0-rc.2 `snapshotEvents`（dsh-session index.d.ts:193）。
- dsh-adapter 探测的 mount/systemPrompt.section+context/tools.register/agents.get 全部存在；contextProjection/projectionAwareCompaction 硬编码 false = 有意禁用（agent-managed 模式 fail-closed 拒绝，非掩盖）。
- agent-novel：事件订阅（agent/created、agent/disposed、agent/status、turn/end reason 枚举）、followup/whenIdle/withoutInitiator、W1/W2 编排 toolFilter allow 名单、notice 消息 form:'notice'+summary 契约。
- requirements.ts 的 source.channel/panel 为预留字段，当前恒走 composer 分支，无写入方，不影响。
