# 决策：用户人设与角色摘要改为 complete 段的 system 部件

> 日期：2026-11-02。状态：已实施。相关：`decisions/2026-11-02-agent-prompt-takeover.md`（complete 段接管）、`docs/proposals/0004-agent-tavern-architecture.md` §5（固定上下文）、`decisions/2026-10-09-agent-tavern-preset-projection.md`（marker 映射）、`packages/plugin/src/agent-tavern/agent.ts`。

## 背景与问题

用户反馈：AgentTavern 会话里「用户、角色信息的插入位置似乎有问题」。

复核真实会话日志（`system/message` 与 `user/message` 事件序列）后确认：

- 角色摘要（`agent-facts`）此前注册为 `systemPrompt.context()`，宿主把它渲染成**每步末尾的一条 user 消息**（`RuntimeContextProjection.project` → `pre-step` 的 `messages` 末尾）。模型看到的顺序是「真实用户消息 → user 角色摘要 → user 开场引导」，角色设定被当成用户发言，且位于注意力最高的位置；
- 激活预载（`buildAgentTavernPreloadSnapshot`）同样是 user 消息，且经 `agent.inject` 排在开场白之后；
- **用户人设（persona）描述完全没有进入 AgentTavern 的固定 prompt**：`personaDescription` marker 被预设投影跳过，`facts` 只带名称宏，不带描述。

提案 0004 §5 明确把「当前角色身份、用户身份、角色短身份摘要」列为固定 prompt 的组成；完整角色卡、示例对话、世界书条目和长期历史才不属于固定 prompt。当前实现与规格不一致。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/agent-tavern/agent.ts`（facts 通道与 complete 段装配）、`packages/plugin/src/agent-tavern/prompt-parts.ts`（scope 语义注释）、相关测试与文档 |
| 唯一事实来源 | 身份文本 = `sessionBindings[agentId]` 指向的角色卡 + `state.activePersona` 指向的人设；system 头 = complete 段按 `prompt-parts` 注册表求值 |
| 持久态 | 无新增持久态；人设/角色卡仍是既有资产文件 |
| 临时态 | `factsProjection` 的按 agent 懒装载缓存；重启由 `preheatAgentProjections` 预热重建 |
| 外部依赖 | 宿主 `systemPrompt.section(complete: true)`；与 takeover 决策相同 |
| 注册入口 | `agent-facts` 部件：order `-70`，`scope: 'system'`；不再调用 `ctx.systemPrompt.context()` |
| 删除路径 | 把 `scope` 改回 `'context'` 并恢复 `apply()` 里的 context 注册即可回旧形态；`agent-tavern-mount` / `agent-prompt-viewer` / `prompt-safety` 的断言会翻红提醒 |
| 兼容对象 | ST 架构、AgentNovel、CardWorkbench、IM 通道零变化；仅 AgentTavern 的固定 prompt 组成变化 |

## 决议

`agent-facts`（保留既有部件名，避免跨 bundle 契约无谓漂移）从 runtime context 改为 complete 段内的 system 部件，文本顺序固定为：

1. `Current user persona: <name>`（激活人设存在时）；
2. `User persona description (untrusted asset data): <description>`（上限 1200 字符）；
3. `Current Tavern character: <name>`;
4. `Character identity summary (untrusted asset data): <identitySummary 或短描述>`;
5. `Personality summary: <personality>`（上限 600 字符）；
6. `Scenario summary: <scenario>`（上限 600 字符）。

理由：

- 用户人设和角色摘要都是**每个会话稳定**的身份信息，不是每步变化的 runtime context；
- 固定 prompt 位于历史之前，模型不会把设定误读成用户最新发言；
- 与 ST 的 `personaDescription` / `charDescription` 语义对齐，同时保留「短摘要、有界」的 AgentTavern 边界（不把完整角色卡固定塞进每次请求）；
- 文本只随激活人设/角色卡变化，前缀缓存字节稳定；写穿仍走既有 `onAgentPresetChanged` 信号，并新增 facts 刷新。

## 落法

- `agent.ts` 的 `factsProjection.load` 增加 `db.getPersona(state.activePersona)`，把用户人设名称与描述拼进身份文本；宏展开 + `hostPromptSafe` 与既有 facts/guides 同款。
- `registerAgentPromptPart` 的 `agent-facts` 改为 `scope: 'system'`；`apply()` 删除 `ctx.systemPrompt.context({ name: 'agent-facts' })`，只保留 guides / script / games 三条动态 context。
- `preheatAgentProjections`（原 `preheatAgentPresetProjections`）与 `onAgentPresetChanged` 同时刷新 preset 与 facts；激活命令的 `emitAgentPresetChanged()` 因此会在首轮前装载身份段，避免首轮空串 → 整块出现的前缀缓存突变。
- 提示词查看器：`agent-facts` 现在出现在 system 分面，`record.system` 包含它；不再有「context 身份段」的 `· context` 标记。

## 否决项

- **把完整角色卡/世界书固定进 system**：违背提案 0004 §5 的边界，token 成本随卡长度线性增长；完整资料仍由 `tavern_character_get` / `tavern_lore_search` 按需读取。
- **把 persona 塞进 `{{user}}` 宏**：宏只提供名称，无法承载描述；且 ST 的 personaDescription 是独立块。
- **保留 facts 作为 context 只调整 order**：宿主 runtime context 永远追加在 claimed messages 之后，order 只决定段内顺序，改不了「user 消息在用户发言之后」这一事实。
- **改预载的 user 注入位置**：预载是可选的一次性参考数据，语义与固定身份不同；本次只修固定 prompt 的组成，预载位置留待独立需求评估。

## 已知边界

- 身份段是固定块，位于预设栈之后、历史之前；不按 `prompt_order` 的 marker 位置逐条穿插（marker 映射仍按 2026-10-09 决策，本次只把用户人设与角色摘要从 user 消息移到固定 prompt）。
- 身份段上限：人设描述 1200 字符、性格/场景各 600 字符、角色摘要沿用 `identitySummary` 的 2000 字符上限；超长部分无声截断（与 facts 既有纪律一致）。
- 人设切换 / 预设切换 / 激活预热会刷新身份段；直接编辑角色卡不经过 `emitAgentPresetChanged` 的路径仍按下一次激活/重启预热生效（既有 facts 同款边界）。
- 预载（可选）仍是 user 消息，排在开场白之后；它不参与固定 prompt，不影响本次「身份段进 system」的结论。

## 验证

- `packages/plugin/tests/agent-tavern-mount.spec.ts`：complete 段包含角色摘要、性格摘要、用户人设名称与描述；未绑定 agent 不出现身份文本。
- `packages/plugin/tests/agent-prompt-viewer.spec.ts`：`agent-facts` 出现在 system 分面（不再标 `· context`），`record.system` 包含身份段；查看器覆盖面锁同步。
- `packages/plugin/tests/prompt-safety.spec.ts`：身份段内的卡/人设宏展开与 `{{...}}` 中性化仍过宿主 `interpolate` 复刻。
- `packages/plugin/tests/tavern-guides.spec.ts`：facts 不再是宿主 context，但 system 部件 order 仍为 -70（guides 之前）。
- 全量 `pnpm check`（tsc + vitest + 重建插件产物 + gates）。
