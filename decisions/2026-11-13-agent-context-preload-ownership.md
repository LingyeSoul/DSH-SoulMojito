# Agent 自动注入的通道归属与 Author’s Note 摘除

日期：2026-11-13。相关：`decisions/2026-11-12-st-capability-parity.md`（Agent 自动注入）、`packages/plugin/src/agent-tavern/context-injection.ts`、`packages/plugin/src/tavern-assets.ts`、`packages/plugin/src/agent-tavern/agent.ts`。

## 问题

- `agentContextInjection` 与 `agentTavernPreloadAssets` 可同时开启。预载把 `constant` 世界书条目写进会话起点的 user 消息（`buildAgentTavernPreloadSnapshot`，单条 ≤4000 字符、总 ≤32000）；每步注入又通过 `activateWorldInfo().allActivated` 把同一批条目放进 top-6 世界书块。同一条目出现两次；预载是起点快照、注入是实时数据，条目编辑后模型会同时看到新旧两版。
- 注入的 Author’s Note（`chat_metadata.note_prompt`）只是 ST 生成期的位置化字段（position/depth/interval），Agent 通道没有对应语义；用户要求摘除。
- KERNEL 无条件宣称「卡细节与世界书不在你的上下文里」，在预载/注入开启时是假命题。

## 决议

| 项 | 落法 |
|---|---|
| 常驻世界书归属 | `agentTavernPreloadAssets === true` 时，`buildLoreReferences` 过滤 `entry.entry.constant === true`；预载关闭时保持原行为（注入带常驻条目） |
| Author’s Note | 删除 `formatNoteBlock`、`AGENT_CONTEXT_LIMITS.noteBlockChars`、`metadata['note_prompt']` 读取；ST 生成管线的 position/depth/interval 注入不变 |
| KERNEL 措辞 | 「不在上下文里」改为条件句：除非卡细节/世界书已在上下文（预载或参考块），否则按未豁免处理；首轮工具调用同样加「除非需要的事实已在上下文」 |
| 面板文案 | zh/en `settings.agentContextInjectionHint` 去掉 Author’s Note，并写明预载开启时常驻条目由预载负责 |
| `agent-facts` 归属 | 预载开启时只保留身份层（人设/角色名/身份摘要），省略 `Personality summary` 与 `Scenario summary`；全文由预载负责 |
| 预载字段裁剪 | 跳过 `system_prompt` / `post_history_instructions`（preset 的 main/jailbreak 卡覆盖负责）与含 `<%` 的常驻条目（`card-state` 每轮渲染） |
| 开关写穿 | `panel-state-routes` 对 `agentContextInjection` / `agentTavernPreloadAssets` 的 patch 调用 `emitAgentPresetChanged()`；既有监听刷新 preset/facts/context 三路缓存，取消 30s 空窗 |

## 边界

- 预载读基础世界资产（`collectWorldInfoBooks` 不带 chatId），注入读会话副本（`getChatWorld`）。归属切换后，会话副本对常驻条目的编辑不会进入预载的基础版本；这是去重的已知代价，动态命中仍读会话副本。
- `agent-facts` 的身份摘要（策展字段，或描述前 240 字符）仍与预载的完整 description 重叠；保留它是为了固定 prompt 始终有一条短身份线，不再重复的是性格/场景摘要。
- 预载去掉卡 `system_prompt` / `post_history_instructions` 后，这两段只在 preset 投影（main/jailbreak 卡覆盖）里出现；非 chat-completion 预设本来就被显式拒绝投影，因此不会出现「preload 独占但 preset 拒绝」的半投影，完整卡仍可由 `tavern_character_get` 读取。
- 预载的 `first_message` 仍可能与历史导入的开场白重复：空聊天需要它，有历史的聊天已导入开场白；本次不按会话状态裁剪，留作独立需求。
- 含 `<%` 的常驻条目整条跳过，不拆静态片段；`card-state` 只在模板开关开启且卡使用 MVU/EJS 时每轮渲染。模板关闭时这类条目不会以原文进入上下文。
- 30s TTL 仍是世界书/记忆内容的刷新周期；开关翻转走写穿，不再等 TTL。

## 删除路径

- 恢复常驻条目注入：删 `buildLoreReferences` 的 `excludeConstant` 入参与过滤。
- 恢复 Author’s Note：恢复 `formatNoteBlock` / `noteBlockChars` / `blocks` 里的调用，或从本文件的 git 历史取回。
- 恢复 facts 性格/场景摘要：删 `agent.ts` 的 `preloadOwnsCard` 条件。
- 恢复预载字段：重新加回 `character.system_prompt` / `character.post_history_instructions`，并删掉常驻条目循环里的 `<%` 跳过。
- 恢复 30s 空窗：从 `panel-state-routes.ts` 的 `emitAgentPresetChanged()` 条件里删掉两个开关。
- KERNEL 恢复原文：`agent.ts` 的 `KERNEL` 数组最后一段。

## 验证

- `packages/plugin/tests/agent-context-injection.spec.ts`：三块（世界书/记忆/summary）；预载开启时常驻条目不出现在每步块、关闭时回归；note 不再出现。
- `packages/plugin/tests/tavern-preload.spec.ts`：完整卡字段保留；EJS、禁用条目、preset 已覆盖的卡字段不出现在预载快照。
- `packages/plugin/tests/agent-tavern-mount.spec.ts`：预载开启时 facts 不再带性格/场景摘要，身份摘要仍在。
- `packages/plugin/tests/tavern-command.spec.ts`：patch 两个开关后注入块立即变化，证明写穿生效。
- `pnpm check`：`tsc -b` + security/plugin tsc + vitest + `scripts/build-plugin.mjs` + gates。
