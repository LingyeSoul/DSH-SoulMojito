# 预设非 system 条目激活期预装载 + user 压缩后重注

日期：2026-11-13。相关：`decisions/2026-10-09-agent-tavern-preset-projection.md`、`decisions/2026-10-09-agent-preset-cache-stability.md`、`decisions/2026-10-05-import-turn-boundaries-and-settlement.md`、`packages/plugin/src/agent-tavern/preset.ts`、`packages/plugin/src/agent-tavern/projector.ts`、`packages/plugin/src/agent-tavern/preset-user-block.ts`、`packages/plugin/src/session/command.ts`。

## 问题

- ST 聊天补全预设的条目自带 `role`。既有投影把全部启用条目按 `prompt_order` 拼成一段文本塞进 order -75 的 system 头部，`role` 被完全忽略。
- `role === 'user'` 的条目是 ST 的对话帧发言（用户视角的写作约束），`role === 'assistant'` 的条目是示范发言。两者写进 system 头都等于告诉模型「这是系统规则」，与它们在 ST 里的帧语义相反。
- 宿主 `agent/pre-step` waterfall 的 payload 与 decision 只接受 `UserMessage[]`，assistant 角色没有注入通道；只在生成期注入一条 user 消息因此只能覆盖一半语义。
- 会话激活（loop 未启动）时插件可以用 `agent.session.append` 写完整 turn/step 边界——开场白/历史导入已经这么做，assistant 帧在激活期是合法且可持久化的。

## 决策

| 项 | 落法 |
|---|---|
| system 块只留 system 条目 | `renderAgentPresetBlock` 过滤 `role === 'system'`；user/assistant 条目不再进 system 头 |
| 帧化原料 | `agentPresetPreambleEntries(preset, card)`：按 `prompt_order` 顺序返回全部非 system 条目的**原始 content**（不加 header，贴近 ST 逐条帧）；`projectAgentPreset().preamble` 同步暴露（refusal/解析失败时为空数组） |
| 激活期预装载（主路径） | `historyImportAppends` 接收 `{ session, preamble }`，在受保护 system head 之后、历史消息之前写 preamble：user 条目 `closeTurn(); openTurn();` + `user/message`（plugin source，`form: 'instructions'` + `presetUserBlock: true`），assistant 条目确保 turn 打开后 `step += 1` + `step/start` + `assistant/message` + `step/end`（model source `{ provider: dsh-soulmojito, model: 'agent-tavern-preset' }`，v4 带 `stream: []`）。顺序与 `agentPresetPreambleEntries` 一致，A(user) → B(assistant) → C(user) 保真 |
| 轮次归属 | 受保护 head 占 turn 1，preamble 从 turn 2 起；preamble 写完 `closeTurn()`，历史循环从当前 turn 继续（不重复轮号）；`advanceHostTurnBase` 按计划最后 turn 推进 live loop 基线 |
| 投影安全 | user 帧带 plugin source（projector 只收 `source.kind === 'user'`），assistant 帧带预设镜像 model source 对（`isTavernSessionMarker` 认 `agent-tavern-import` / `agent-tavern-preset`）；两者都不写回 Tavern JSONL |
| pre-step 兜底通道 | 保留 `preset-user-block.ts`：压缩后（最后一条**成功的** `compaction/end` 晚于最后一次注入）重注一条 user 合并块；带 `error` 的失败压缩不改写 surface，不触发重注；存量已启动会话（没有激活期 seed）由它在首个进入 step 补齐 user 条目。激活期 seed 的 user 帧带 `presetUserBlock` 标记，通道据此判定「已注入」，不重复 |
| 内容求值 | 激活路径用与历史同一份 `tavernMacroExpand` 展开每条 content（保留未知宏原样，**不**过 `hostPromptSafe`——那是 system section 的纪律）；pre-step 兜底沿用冻结 expander + `hostPromptSafe` |
| 版本门控 | preamble 只写 v4：user 帧的 `presetUserBlock` 成员在 v0-v3 的 plugin source 封闭成员集之外（`session-source-dispositions` 契约），写入会毒化老工件 |
| 作用域 | `session/command.ts` 只在 `initializeAgentTavern && parsed.group !== true` 时构建 preamble；群聊/IM 传空数组，不预装载 |
| body 触发兼容 | 兜底块可能排在同一个 turn 的 `body-regenerate` / `body-restore` 触发消息之前；`isBodyTriggerTurn` 扫描整个 turn 的 user 消息而非只看首条，回归见 `agent-tavern-body-projector.spec.ts` |

## 否决项

| 方案 | 否决理由 |
|---|---|
| 每轮 pre-step 注入（user + 无法注入的 assistant） | append-only 纪律下每轮新增消息，前缀缓存从注入点作废；assistant 根本没有通道，语义只覆盖一半 |
| 放进 `systemPrompt.context()`（runtime snapshot） | context 是每步一条新 user 消息的通道，与「一次性」语义冲突，同样每轮烧前缀；assistant 仍无处安放 |
| 把 assistant 条目继续文本化在 system 块 | 用户视角/示范发言被说成系统规则，正是本决策要修的语义错位 |
| 在 `llm/stream` 或请求侧改写 | 绕过宿主会话日志：消息不落库、压缩看不到、提示词查看器与重生成回滚失去依据；插件也不应接管宿主的消息装配 |
| 按预设内容变化改写已注入消息 | 已落盘消息的改写会从改写点开始烧掉全部后续 KV 前缀（write-once 纪律） |
| v0-v3 也写 preamble | user 帧的标记成员不在老 plugin source 白名单内，升级迁移会整份会话拒载；老宿主只保留 user 兜底 |
| 用 marker 文本（正文包含判定）做幂等 | 固定正文标签在用户编辑预设后不再稳定；source 标记位与事件位置更直接 |

## 已知偏差

- **存量已启动会话只走 user 兜底**：激活期 seed 只在 loop 未启动时可行；已经开始的会话无法补写 assistant 帧（会撞轮号/烧前缀），user 条目由 pre-step 通道在首个进入 step 注入一次。
- **assistant 预置会被压缩吞掉且不能重注**：宿主压缩范围从第一个非 system 节点开始，assistant 帧会被摘要覆盖；pre-step 只重注 user 合并块，assistant 条目不再补写（宿主没有 assistant 注入通道）。压缩后的语义由摘要承接。
- **群聊 / IM 不预装载**：`parsed.group === true` 时完全跳过 preamble，群聊仍按既有历史导入语义运行。
- **v0-v3 宿主无 preamble**：老宿主上 user 条目走 pre-step 兜底（其 source 带 `presetUserBlock` 成员，属于该通道的既有折衷），assistant 条目在那些宿主上没有位置。
- **成功压缩保留尾部时的重复块（P3）**：若兜底块刚注入、或压缩范围因 `retainTokens` 保留尾部而未遮蔽它，`compaction/end` 仍会触发一次重注，造成上下文多一份预设块；不产生数据损坏，后续可按 `session.surface.nodes` 的可见性精化判定。
- **预设修改不重写已 seed 的帧**：预设编辑只影响尚未激活的会话与压缩后的 user 重注；已写入的 preamble 保留原文。
- **其它预设投影通道**：`renderAgentPresetBlock` 的过滤对写卡工作台 / AgentNovel（`preset-mount.ts`）与标准 DSH Agent 会话（`native-preset.ts`）同样生效——这些通道没有帧化位置，非 system 条目在它们那里完全不投影（此前是错标成 system）。

## 验证

- `packages/plugin/tests/agent-tavern-preset-user-block.spec.ts`：system 块只剩 system 条目；`agentPresetPreambleEntries` 顺序与原始 content；仅 user 条目的预设 system 块为 `undefined`；pre-step 首次注入/不重复/压缩后重注；失败压缩（`compaction/end` 带 `error`）不重注；seed 过的会话不再注入、压缩后只重注 user 合并块；真实 store + `apply()` 下宏展开。
- `packages/plugin/tests/agent-tavern-body-projector.spec.ts`：同 turn 内预设块先于 `body-regenerate` 触发消息时，重生成正文仍合并进旧楼层，不新增 JSONL 楼层。
- `packages/plugin/tests/agent-tavern-projector.spec.ts`：preamble 计划序列（head → turn2 user → step assistant → user 开新 turn → 历史）、user 的 `presetUserBlock` 标记与 assistant 的 model 标记、`stream: []`、无 preamble 时计划不变、只有 preamble 时计划合法。
- `packages/plugin/tests/session-source-dispositions.spec.ts`：v0 宿主忽略 preamble（source 白名单不变）；v4 形状合法。
- `packages/plugin/tests/tavern-command.spec.ts`：激活计划先写 preamble 再写历史，真实首轮 turn 号顺延、`phase.lastTurn` 推进到计划最后 turn。
- `packages/plugin/scripts/gates/run.mjs` 的 `v4-session-admission`：新增 preamble 序列必须通过真实宿主的词汇表、settlement 与 turn/step 关系校验（与历史导入同一道门）。
- `pnpm exec tsc -b`、`pnpm run typecheck:plugin`、`pnpm run typecheck:security`、`node scripts/build-plugin.mjs`、`node packages/plugin/scripts/gates/run.mjs`、全量 `vitest run`。