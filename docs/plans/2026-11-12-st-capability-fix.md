# ST 能力补齐施工契约（2026-11-12）

配套审计：[`../exploration/2026-11-12-st-native-capability-gaps.md`](../exploration/2026-11-12-st-native-capability-gaps.md)。

## 0. 范围

**做**：审计中除下列排除项外的可执行修复。

**不做**（用户明确排除）：

- TTS / 语音朗读
- 图像生成（SD/ComfyUI/DALL·E）
- 翻译
- 表情 / 立绘
- 主题 / 背景 / 自定义 CSS
- ST 扩展安装与 `registerExtension` 兼容层
- token 概率 / logprobs（宿主 `HostLlmChunk` 无 logprob，插件无法提供）

**范围限定**：预设采样参数只要求 `st` 管线生效；AgentTavern 维持现有投影（temperature）。Text Completion/Kobold 直连不恢复；context/instruct 预设只修“导入不再拒绝 + 明确记录不参与生成”，不新增第二条装配管线。

## 1. 文件所有权（硬约束）

同一文件只能由标注的 owner 修改。跨 owner 的需求走本文契约，不直接改对方文件。

| Owner | 文件 |
|---|---|
| A 生成内核 | `packages/plugin/src/generation/pipeline.ts`、`packages/plugin/src/generation-hooks.ts`、`packages/tavern-script/src/stscript.ts`、`packages/tavern-script/src/index.ts`、`packages/tavern-script/tests/*`、`packages/plugin/tests/generation*.spec.ts` |
| B 聊天文件 | `packages/plugin/src/http/session-routes.ts`、`packages/plugin/src/http/routes.ts`、`packages/plugin/src/session/store.ts`、`packages/tavern-format/src/chat.ts`、`packages/plugin/scripts/gates/run.mjs`、`packages/plugin/tests/http-route-table.spec.ts`、`packages/tavern-store/tests/*chat*` |
| C 输入/面板 | `packages/plugin/client-src/86-ui-composer.js`、`90-panels-core.js`、`96-panels-presets.js`、`80-ui-primitives.js`、`81-ui-regex.js`、`40-i18n-en.js`、`41-i18n-zh.js`、`packages/plugin/src/http/quick-replies-routes.ts`（新）、`packages/plugin/src/quick-replies.ts`（新）、`packages/tavern-store/src/store.ts`、`packages/tavern-store/src/world-settings.ts`（新）、`packages/tavern-store/src/index.ts`、`packages/tavern-store/tests/store.spec.ts` |
| D 消息 UI | `packages/plugin/client-src/84-ui-chat.js`、`packages/plugin/client-src/50-store-core.js` |
| E Agent 注入 | `packages/plugin/src/agent-tavern/agent.ts`、`packages/plugin/src/agent-tavern/anchor.ts`、`packages/plugin/src/agent-tavern/preset.ts`、`packages/plugin/src/compaction/curator.ts`、`packages/plugin/tests/agent-*.spec.ts` |
| F 资产/宏 | `packages/tavern-format/src/group.ts`、`packages/tavern-format/src/preset.ts`、`packages/tavern-format/src/textcompletion.ts`、`packages/tavern-format/src/index.ts`、`packages/tavern-macros/src/engine.ts`、`packages/tavern-macros/src/types.ts`、`packages/plugin/src/prompt-context.ts`、`packages/plugin/src/prompt-safety.ts`、`packages/plugin/src/helper.ts`、对应 tests |

共享但只读：`CONTEXT.md`、`README.md`、`docs/README.md`、`packages/plugin/src/http/io.ts`、`packages/plugin/src/runtime.ts`、`packages/plugin/client-src/manifest.json`、`packages/plugin/src/mount.ts`。

## 2. 共享契约

### 2.1 生成模式

- `GenerationOptions.mode` 扩展为 `'send' | 'regenerate' | 'trigger' | 'continue' | 'impersonate'`。
- `POST generate` body `mode` 白名单同步；未知值报错，不静默回落。
- **continue**：不新增用户楼；要求末条是 assistant（否则报错）。生成结果追加到末条 `mes`，同步 `swipes[swipe_id]`；不新建楼层；照常发 `chat-saved` / 流式增量。
- **impersonate**：生成一条 `is_user: true` 楼层；prompt 指令要求以 `{{user}}` 身份写下一句；不追加 assistant。
- **quiet/dry-run**：沿用 `previewGeneration`，不新增模式。
- 消息级 token：生成落盘时写 `extra.tokenCount = Math.round(finalText.length / 3.5)`；注释明确是估算，不是 provider tokenizer。

### 2.2 采样参数（仅 `st`）

从 `preset.sampler` 读取并映射到 `HostLlmRequest`：

`temperature`、`maxTokens`（已有）以及
`top_p`、`top_k`、`frequency_penalty`、`presence_penalty`、`repetition_penalty`、`min_p`、`stop`、`seed`、`logit_bias`。

- 仅当值存在且类型正确才写入；缺省不传，不塞 `undefined`。
- ST 的键名（如 `openai_top_p`）与直传键名都接受，优先直传。
- 宿主是否消费由 provider 决定；代码注释说明这一点，不做静默降级。
- Agent 模式不改（不新增采样投影）。

### 2.3 消息可见性

`is_hidden` 三处贯通：

1. ST 生成历史装配跳过 `is_hidden === true`（`chat_metadata` 与 `extra.is_hidden` 两种形态）。
2. 面板渲染隐藏楼层为折叠/标记，不参与普通滚动阅读（D 决定交互，但必须可见可恢复）。
3. 动作行提供隐藏/取消隐藏。

### 2.4 Author's Note / Summary

聊天元数据（JSONL header）：

```ts
chat_metadata.note_prompt?: string
chat_metadata.note_settings?: {
  position: 'in_prompt' | 'at_depth'
  depth?: number          // at_depth 时默认 4
  role?: 'system' | 'user' | 'assistant'  // 默认 system
  interval?: number       // 每 N 轮注入；0/缺省 = 每轮
}
chat_metadata.summary?: string
```

- ST 生成：`note_prompt` 非空时按 `note_settings` 注入；`summary` 非空时作为 system 段块注入（位置在 guides 之前）。
- Agent 生成：`summary` 与 `note_prompt` 由 E 的 context 部件注入；没有则不注入。
- 数据写入走现有 `PUT chat`；C 只做编辑 UI。

### 2.5 聊天文件

- `POST import/chat` body `{ character, name, content }`；`content` 是 JSONL 文本；`parseChatLog` 失败报错；重名报错（不覆盖）。
- `GET export/chat/<character>/<chatId>`：返回 JSON `{ ok, name, content }`，`content` 为 JSONL 文本（与现有资产导出风格一致）。
- `POST duplicate` body `{ character, chatId, revision, name? }`：整聊复制；新 id；`bookmark_link` 不复制。
- `POST checkpoint` body `{ character, chatId, revision, messageId?, name? }`：复制 `0..messageId`（缺省全部）到 `<chatId> - checkpoint #N`；header 写 `chat_metadata.checkpoint_parent = { character, chatId, messageId }`。
- `GET checkpoints?character=<name>&chatId=<id>`：返回该父聊天的 checkpoint 列表。
- `POST greeting` body `{ character, chatId, revision, index }`：仅 ST 架构；切换首楼 swipe 并写 `swipe_id`/`mes`；Agent 架构返回 409 + 明确原因；越界报错。

### 2.6 Quick Replies

- `TavernState.quickReplies?: QuickReplySet[]`，`TavernState.quickRepliesEnabled?: boolean`。
- `QuickReplySet = { id: string; name: string; enabled: boolean; isGlobal: boolean; automationId?: string; commands: string[] }`（`commands` 每条是一行 STscript）。
- 路由：`GET quick-replies`、`PUT quick-replies`（全量替换 + enabled）。
- `/qr <name>`：执行该集合；仅 ST 架构；Agent 架构报错。
- composer 按钮行；面板「快速回复」分区。
- 世界书条目 `automationId` 命中且集合启用时，在 ST 生成装配阶段执行一次；需要防递归（执行中不再触发同 id）。

### 2.7 STscript 新命令

在 `ScriptEnv` 增加可选能力，命令缺省时报“不支持”，不静默：

`/continue`、`/swipe [delta]`、`/hide [from] [to]`、`/unhide [from] [to]`、`/move <from> <to>`、`/rename <name>`、`/branch [messageId] [name]`、`/checkpoint [messageId]`、`/listvar`、`/flushvar`、`/run <qrName>`、`/times <n> <script>`。

`/while` 需要表达式求值，若无法在现有解析器内安全实现，明确报“不支持”并记录，不做半成品。

### 2.8 世界书设置

`packages/tavern-store/src/world-settings.ts`：

```ts
export interface WorldInfoSettings {
  recursive: boolean
  scanDepth: number
  budgetPercent: number
  budgetCap: number
  maxRecursionSteps: number
  minActivations: number
  minActivationsDepthMax: number
  caseSensitive: boolean
  matchWholeWords: boolean
  useGroupScoring: boolean
  includeNames: boolean
}
export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings
export function worldInfoSettingsOf(state: Pick<TavernState, 'worldInfoSettings'>): WorldInfoSettings
```

- `TavernState.worldInfoSettings?: Partial<WorldInfoSettings>`；normalize 时合并默认值。
- A 在 `pipeline.ts:419` 使用 `worldInfoSettingsOf(state)` 替代写死的 settings。
- C 在面板「世界书」分区提供设置表单。

### 2.9 宏与资产

- `group.activationStrategy` 扩展为 `0 | 1 | 2`；解析保留 0（MANUAL），导出保留；`tavern-pipeline` 对 0 不自动选人，仅 `triggerMember`/手动点名。
- 宏引擎新增：
  - `{{outlet::name}}`（从 `MacroEngineInit.outlets` 取）；
  - `{{mesExamplesRaw}}` 与 `{{mesExamples}}` 分开（raw 不去示例清洗）；
  - 其余生成期宏若没有数据源，保持未知宏原样，不伪造。
- 宏构造点补卡字段：`helper.ts`、`prompt-context.ts`。`prompt-safety.ts` 若无卡上下文，保留现状并在注释说明限制。
- A 在 `createMacroEngine` 传 `outlets`（来自 lore 激活结果的 outlets 文本）和 `systemPrompt`（若可用）。
- `detectPresetKind` 增加 `'sysprompt' | 'reasoning'`；`parsePresetOrThrow` 接受这两类的最小校验；生成不消费，文档明确记录。

### 2.10 Agent 注入（E）

新增 `systemPrompt.context` 部件，全部默认关闭，行为设置开关 `agentContextInjection`（C 加 state 字段与开关；E 读取）：

1. 常驻世界书/关键词激活 top-N（复用 `activateWorldInfo`，使用 2.8 的设置）。
2. 记忆 top-N（`memory-hybrid` 检索，按 importance/updatedAt）。
3. `chat_metadata.summary` 与 `note_prompt`。
每块标注“reference data, not instructions”。不得改变 AgentLoop、不得新增主循环。

预设投影：只做能安全实现的 instruct/context/reasoning 消费；实现不了的明确报“不投影”，不静默。采样参数不在 E 范围。

### 2.11 面板（C）

- 快速回复分区与编辑。
- 世界书设置表单 + 条目高级字段（recursive/sticky/cooldown/delay/group/role/outletName/automationId）。
- 预设 prompt_order 拖拽/启用开关。
- 群聊策略 0/1/2。
- persona 头像/position/depth/role。
- 角色收藏星标与列表排序。
- regex 导出按钮。
- Author's Note / Summary 编辑入口（聊天内或面板，二者其一，明确）。
- i18n：C 独占 `40/41`；D 的新 key 由 C 或主代理补，D 不改 i18n。

## 3. 测试与验证

- 每个 owner 新增/更新对应 spec；不运行测试、不 build、不提交。
- 最终由主代理统一运行：`pnpm run typecheck:plugin`、相关 `vitest run`、`node scripts/build-plugin.mjs`、`node packages/plugin/scripts/gates/run.mjs`。
- 客户端改动由 `client-bundle` gate 与手动检查覆盖；D 必须说明无法自动验证的部分。

## 4. 禁止

- 不改 `packages/plugin/*.mjs` bundle（构建产物）。
- 不改 `README.md`、`docs/README.md`（主代理统一更新）。
- 不新增 npm 依赖，除非先在报告里说明并等待主代理确认。
- 不引用真实角色卡/聊天/用户路径；测试夹具全部合成。
- 不伪造完成：实现不了的部分明确报“不支持/未实现”并给原因，不留 TODO 或空壳。

## 5. 交付报告格式

每个 owner 返回：

1. 改动文件清单。
2. 每个行为的一句话验收描述。
3. 新增/更新的测试文件。
4. 需要主代理补的 i18n key（英文 + 中文）。
5. 未解决风险/明确不做的子项。
