# ST 原生能力缺口审计（2026-11-12）

只读审计：对照 SillyTavern 原生（核心聊天 + 官方扩展）能力，定位本插件尚未提供、且已有可复用接缝的部分。结论全部带证据坐标；未确认项显式标注。

> 状态（2026-11-12）：除 TTS、图像生成、翻译、表情/立绘、主题/背景/CSS、ST 扩展安装兼容层（用户明确排除）外，本审计列出的可执行项已按 [`decisions/2026-11-12-st-capability-parity.md`](../../decisions/2026-11-12-st-capability-parity.md) 落地；正文保留审计当时的现状证据，不回写为“已修复”。

参考口径：

- ST 聊天与消息动作：<https://docs.sillytavern.app/usage/chatting/>
- ST 首页能力清单（World Info / Group chats / Personas / Data Bank RAG / STscript / 官方扩展）：<https://docs.sillytavern.app/>
- 本仓库既有兼容声明：`docs/frontend/tavern-helper-compat.md`、`docs/proposals/0002-*.md`

三态口径：**已实现**（服务端 + UI 成对闭环）、**部分**（数据/扩展面存在但主路径不生效）、**缺失**。

---

## 0. 结论摘要

| # | 能力域 | ST 原生语义 | 现状 | 缺口 | 可落点 | 成本 |
|---|---|---|---|---|---|---|
| 1 | 生成动词 | Continue 续写末条 AI 文本 | 缺失：`GenerationOptions.mode` 仅 `send/regenerate/trigger`（`packages/plugin/src/generation/pipeline.ts:239-244`） | 无续写模式与输出拼接 | `pipeline.ts:240`、`:708-730`、`:838-858` | M |
| 2 | 生成动词 | Impersonate 以用户身份代写 | 缺失：无分支、无命令（`pipeline.ts:240`；`packages/tavern-script/src/stscript.ts:8-11`） | 无用户身份生成与落楼 | `pipeline.ts:711-724`（send 落楼点） | M |
| 3 | 采样参数 | top_p/top_k/penalties/stop/logit_bias/seed | 部分：预设 `sampler` 原样保留（`packages/tavern-format/src/preset.ts:3-35`），但请求只传 temperature/maxTokens（`pipeline.ts:650-655`） | 其余采样键被丢弃 | `pipeline.ts:650-655`；`packages/plugin/src/generation-hooks.ts:38-46` | S |
| 4 | 消息可见性 | Included/Excluded 眼形开关 | 部分：`is_hidden` 只在 JSR 读取面过滤（`packages/plugin/src/helper.ts:1536-1545`、`:1610-1612`），面板渲染不过滤（`packages/plugin/client-src/84-ui-chat.js:126-139`），生成历史不过滤（`pipeline.ts:503-513`） | 语义未贯通 | `84-ui-chat.js:140-152`；`pipeline.ts:503` | S |
| 5 | 消息动作 | 删除/移动/复制/翻译/朗读/生成图 | 缺失：面板只有 swipe/编辑/两种分支（`84-ui-chat.js:140-152`）；数据层已有 delete/rotate 扩展面（`helper.ts:228-237`、`:1548-1585`） | 无面板入口 | `84-ui-chat.js:140-152`；`chat-generation-routes.ts:32-40`（PUT 全量写） | S-M |
| 6 | Checkpoint/Rewind | 同聊天存档并回跳 | 缺失：只有 branch 开新聊天（`packages/plugin/src/http/session-routes.ts:188-210`、`packages/plugin/src/session/store.ts:1583-1625`）与 `/cut` 截断（`pipeline.ts:1002-1008`） | 无 checkpoint 文件/回跳 | store 的 `branchChat` 复用 + 新路由（`routes.ts:550-560`） | M |
| 7 | 聊天文件管理 | 导入/导出/复制整聊 | 部分：新建/重命名/删除有（`session-routes.ts:114-185`；`chat-generation-routes.ts:42-80`）；导入导出路由只覆盖 character/world/preset（`packages/plugin/src/http/routes.ts:270-273`、`:448-466`；`:294-306`） | 无 `import/chat`、`export/chat`、整聊 duplicate | JSONL 编解码已存在（`packages/tavern-format/src/chat.ts:14,35`）；路由表 `routes.ts:270` | S |
| 8 | Quick Replies | 快捷回复集合 + `/qr` + automationId | 缺失：唯一出现是世界书字段透传（`packages/tavern-lore/src/entry.ts:154`）与制卡 hint（`packages/plugin/src/card-workbench/tools-world.ts:81`） | 无资产、无命令、无按钮面 | composer（`packages/plugin/client-src/86-ui-composer.js:55-110`）+ STscript 注册表（`stscript.ts:255`） | M |
| 9 | Author's Note | 聊天级注记，按位置/深度注入 | 缺失：只有世界书 AN 位（`pipeline.ts:518-524`）与 persona 深度（`:487-500`）；`chat_metadata.note_prompt` 未被读取 | 无字段写面、无 UI、无注入 | `pipeline.ts:518-524`；面板聊天分区 | S-M |
| 10 | 斜杠帮助/补全 | `/help` + 命令自动补全 | 缺失：composer 整行提交（`86-ui-composer.js:62-67`）；命令名单可读（`stscript.ts:255`）；`/help` 仅 IM 渠道（`packages/plugin/src/im/commands.ts:37-57`） | 无补全 UI | `86-ui-composer.js:62-67` | S |
| 11 | 消息渲染 | Markdown/行内 HTML | 部分：ST 面板正文纯文本（`84-ui-chat.js:139`），`MarkdownText` 已在作用域（`packages/plugin/client-src/00-shell-head.js:43`）但只用于 reasoning/资产视图 | 正文无 markdown | `84-ui-chat.js:139` | S |
| 12 | 事件桥 | ST eventSource 事件面 | 部分：82 个常量已声明（`packages/tavern-jsr/src/index.ts:81-164`），实际投递约 20 个（`docs/frontend/tavern-helper-compat.md` §3.2）；`WORLD_INFO_ACTIVATED`、`MESSAGE_UPDATED`、`MESSAGE_SWIPE_DELETED`、`CHAT_CREATED/DELETED`、`CHARACTER_*` 未桥接 | 依赖这些事件的卡脚本静默失效 | 生成落盘/流式点（`pipeline.ts:838-858`）；聊天写路径（`chat-generation-routes.ts:32`）；世界书激活点（`pipeline.ts:410-425`） | M |
| 13 | 官方扩展：TTS | 朗读 AI 回复 | 缺失：`client-src` 无 tts/朗读键；音频只在 iframe 内（`packages/tavern-jsr/src/client.ts:495-650`） | 无服务、无消息动作 | 消息动作行 `84-ui-chat.js:140-152`；宿主插槽 `packages/plugin/client-src/89b-ui-body.js:631-635` | M |
| 14 | 官方扩展：图像生成 | SD/ComfyUI/DALL·E 出图并嵌入消息 | 缺失：唯一图片面是宿主图片插槽（`89-ui-assistant.js:123-131`） | 无生成源、无入消息、无画廊 | 消息渲染 `84-ui-chat.js:126-139` + 面板分区（`90-panels-core.js:18`） | L |
| 15 | 官方扩展：翻译 | 逐条翻译/对照 | 缺失：`42-i18n-translate.js` 只是 UI 文案 i18n | 无翻译服务/按钮/对照视图 | `84-ui-chat.js:140-152`；`routes.ts:551-553` | M |
| 16 | 官方扩展：表情/立绘 | sprites/expressions | 缺失：`client-src` 无 sprite/expression 命中 | 无宿主表情系统 | 消息头像位 `84-ui-chat.js:106-112` | M |
| 17 | UI 定制 | 主题/背景/自定义 CSS | 部分：前端 iframe 跟随宿主主题（`10-frontend-frame.js:161-215`）；无自定义主题/背景/CSS 编辑 | 无主题编辑器/聊天背景 | 面板注册 `90-panels-core.js:18` | M |
| 18 | 数据备份 | 整库快照/恢复/迁移 | 缺失：仅三类资产导出（`routes.ts:270,448,463`） | 无整库备份 | `routes.ts:550-554` + 新分区 | M |
| 19 | ST 扩展生态 | registerExtension/扩展清单/UI 注入 | 缺失：沙箱显式拒绝安装（`packages/tavern-jsr/src/client.ts:2690-2693`）；Mod 是 Node ESM（`packages/plugin/src/mods/host.ts:759-846`） | 不同构，不能直接承接 | 独立提案；`createApi`（`mods/host.ts:759`） | L |
| 20 | Agent 模式自动注入 | 世界书位置化激活 / 记忆召回 / summary | 部分：工具面齐全（`agent-tavern/agent.ts:228-236`），但 prompt 部件只有 kernel/preset/facts/guides/script/games（`agent.ts:73-95`） | 无自动激活、无 top-N 记忆、无 summary | `agent.ts:178-199`（context 部件）；`anchor.ts:190-276` | M |
| 21 | 世界书全局设置 | 递归步数/预算/最小激活/大小写/整词/组计分 | 部分：引擎全实现（`tavern-lore/src/engine.ts:166-207`），调用点写死 `recursive:true, scanDepth:2, budgetPercent:25`（`generation/pipeline.ts:419`） | 其余设置无 state 键、无面板 | `pipeline.ts:419` + `tavern-store/src/store.ts:189` 邻域 | S |
| 22 | 世界书 Outlet | `position=7` + `{{outlet::Name}}` 拉取 | 部分：outlets 已算好（`tavern-lore/src/engine.ts:257-283`），宏未注册（`tavern-macros/src/engine.ts:216-220`） | outlet 条目永不进入 prompt | `engine.ts:283` + `tavern-macros/src/engine.ts:216` | S |
| 23 | 宏绑定一致性 | JSR/helper/模板/生成面同一宏同值 | 部分：卡字段宏只在生成面绑定（`pipeline.ts:459-467`）；helper（`helper.ts:1782-1792`）、prompt-context（`prompt-context.ts:18-24`）、prompt-safety（`prompt-safety.ts:32-40`）只绑 char/user | 卡作者脚本里 `{{description}}` 等展开为空 | 三处宏构造点 | S |
| 24 | 群聊 MANUAL | activation_strategy=0，仅手动点名 | 缺失：类型只有 1/2（`tavern-format/src/group.ts:16`），解析把 0 静默写成 1（`:70`） | 导入即语义改写，导出不回原值（静默数据损坏） | `group.ts:61,70`；`tavern-pipeline/src/group.ts:80` | S |
| 25 | 预设互操作 | 采样全集 / context / instruct / sysprompt / reasoning | 部分：只消费 temperature + maxTokens（`pipeline.ts:652-654`）；context/instruct 仅解析（`prompt-context.ts:68-84`）；sysprompt/reasoning 分类不存在，导入抛错（`:82-83`）；TC 生成路径已下线（`tavern-store/src/store.ts:2130-2131`） | 社区预设"能存不能用" | `prompt-context.ts:68`；`pipeline.ts:650-655` | M |

---

## 1. 聊天运行时（`st` 架构）

### 1.1 生成动词

现有入口只接受三种模式：

- `GenerationOptions.mode: 'send' | 'regenerate' | 'trigger'`（`packages/plugin/src/generation/pipeline.ts:239-244`）
- `POST generate` 只透传 `send`/`regenerate`（`pipeline.ts:57-61`）
- `trigger` 仅在 STscript `/trigger` 内使用（`pipeline.ts:966-982`）

因此：

- **Continue**：没有"不新增用户楼、续写末条 AI 文本"的模式。`runGeneration` 的 send 分支先 push 用户楼（`pipeline.ts:711-724`），regenerate 分支弹旧回复（`:726-729`），都不适合续写。落点是新增模式并在保存阶段拼接末条正文（`:838-858`）。若要走真正的 assistant prefill，还需宿主 `llm.stream` 支持 prefill 参数；当前 `HostLlmRequest` 只声明 system/reasoningEffort/temperature/maxTokens/tools（`packages/plugin/src/host-contract.ts:40-47`），但带 `[key: string]: unknown`。两种方案成本不同，需在提案中二选一。
- **Impersonate**：没有"以用户身份生成并落用户楼"的分支。最自然的落点是 `pipeline.ts:711-724` 的 send 落楼点，生成后把 role 改成 user，并复用 `user-input` hook（`:715`）。
- **Quiet/Dry-run**：`previewGeneration` 已提供零副作用试写（`pipeline.ts:132-235`；路由 `packages/plugin/src/http/generation-variable-routes.ts:48-55`），但只接在工作台（`93-ui-workbench.js:99-120`），聊天视图没有入口；且它跳过五相位 hook。可视为部分。

### 1.2 消息操作

数据层能力比 UI 多：

- 编辑：`84-ui-chat.js:87-92`，落盘走 `PUT chat/<id>` 全量写（`chat-generation-routes.ts:32-40`）。
- Swipe 切换：`84-ui-chat.js:83-86`，新候选由 regenerate 写入 `swipes/swipe_info`（`pipeline.ts:843-846`）。
- 分支：`84-ui-chat.js:95-104`。
- 隐藏：`is_hidden` 仅 JSR 读取面过滤（`helper.ts:1536-1545`、`1610-1612`），面板渲染（`84-ui-chat.js:126-139`）与 ST 生成历史（`pipeline.ts:503-513`）都不过滤。**先补语义再接 UI**，否则"隐藏"只改 JSONL 不改行为。
- 删除/移动/复制：无 UI；JSR 扩展面已有 delete/rotate（`helper.ts:228-237`、`1548-1585`），STscript 只有 `/cut`（`stscript.ts:441-452`）。
- 消息级 token：未落盘（`pipeline.ts:846-851`），只有整轮估算与提示词查看器（`packages/plugin/src/prompt-viewer.ts:181-182`）。
- Checkpoint/Rewind：缺失。branch 是"复制到新聊天"（`session/store.ts:1583-1625`），不是同聊天回滚点。

### 1.3 聊天管理

已有：新建（含开场白选择，`session-routes.ts:114-185`）、重命名（`chat-generation-routes.ts:42-64`）、删除（`:66-80`）、分支（`session-routes.ts:188-210`）。

缺失：

- **导入/导出 JSONL**：导入路由只有 character/world/preset/persona/regex（`routes.ts:294-306`、`:321-324`、`:489-491`），导出只有 character/world/preset（`:270-273`、`:448-466`）。编解码器已存在（`tavern-format/src/chat.ts:14,35`），只缺路由与 UI。
- **整聊复制**：branch 语义是分支并写 `bookmark_link`（`session/store.ts:1605`），不是纯副本。

### 1.4 输入辅助

- Quick Replies：整块缺失。世界书 `automationId` 只透传（`tavern-lore/src/entry.ts:154`），制卡工具只给 hint（`card-workbench/tools-world.ts:81`）。
- 聊天级 Author's Note：缺失；ST 数据键 `note_prompt` 在测试里出现过（`packages/tavern-format/tests/chat.spec.ts:5`），但生成路径不读取。
- 临时采样覆盖：缺失；请求参数只来自预设（`pipeline.ts:650-655`），客户端 body 不带采样字段（`packages/plugin/client-src/50-store-core.js:515-527`）。
- `/help` 与补全：面板侧缺失（`86-ui-composer.js:62-67`），命令名单可读（`stscript.ts:255`）。

### 1.5 采样参数

`parsePreset` 把除 `prompts`/`prompt_order` 外的键原样放进 `sampler`（`tavern-format/src/preset.ts:31-35`），但生成请求只消费 `temperature` 与 `openai_max_tokens`（`pipeline.ts:653-654`）。ST 高级格式化中的 `top_p`、`top_k`、`frequency_penalty`、`presence_penalty`、`repetition_penalty`、`stop`、`logit_bias`、`seed` 都没有进入 `params`。这是**语义缺口而非格式缺口**：预设导入后看起来完整，实际生成不使用。

落点：`pipeline.ts:650-655` 与 `generation-hooks.ts:38-46` 的类型同步扩展。宿主 `HostLlmRequest` 有开放索引签名（`host-contract.ts:40-47`），但 `dsh-llm` 对各 provider 的映射需在实现时验证；不能假设所有键都直达 provider。

---

## 2. 资产生成语义

### 2.1 角色卡

面板编辑已覆盖 name/nickname/creator/tags/identitySummary/description/personality/scenario/firstMes/mesExample/alternateGreetings/systemPrompt/postHistoryInstructions/creatorNotes/advanced JSON（`packages/plugin/client-src/90-panels-core.js:236-250`）。导入 `.png/.charx/.json`（`:426`）、导出（`:408`）。

缺口：头像/立绘编辑、收藏（`fav` 全仓零实现，`tavern-format/src/types.ts:42` 只有 extensions 袋）、卡内嵌世界书的直接编辑入口（世界书只能去独立分区）。

行为差异（不是简单缺失，需按产品取舍）：`character_book` 只在链接世界书缺失时兜底（`plugin/src/tavern-assets.ts:81-96`），而 ST 是"卡书与用户书叠加且卡书优先"；这是仓库为避免重复激活做的有意选择。`group_only_greetings` 只取第一条（`plugin/src/http/session-routes.ts:128-131`），多条被丢弃。`alternate_greetings` 只在建档时灌入 swipes（`session-routes.ts:164-182`），AgentTavern 首楼导入后无法再切换/新增开场白（同文件注释自述）。

### 2.2 世界书

引擎字段消费完整：递归、副键、概率、inclusion group、sticky/cooldown/delay、position/depth、`matchScenario/matchCreatorNotes/matchCharacterDepthPrompt`（`packages/tavern-lore/src/engine.ts:29-90`；`buffer.ts:82-88`；`groups.ts:1-8`）。

缺口：

- **全局设置不可配**：引擎实现了 `maxRecursionSteps`/`minActivations`/`budgetCap`/`caseSensitive`/`matchWholeWords`/`useGroupScoring`/`includeNames`（`tavern-lore/src/engine.ts:166-207`），但调用点写死 `{recursive:true, scanDepth:2, budgetPercent:25}`（`generation/pipeline.ts:419`），state 里也没有对应键（`tavern-store/src/store.ts:189` 邻域）。
- **vectorized 不参与激活**：字段只被归一化（`tavern-lore/src/entry.ts:122`；`types.ts:93`），引擎没有向量通道。
- **Outlet 永不注入**：`outlets` 已按 `outletName` 分组（`tavern-lore/src/engine.ts:257-283`），但 `{{outlet::Name}}` 宏未注册（`tavern-macros/src/engine.ts:216-220`），前端激活面还显式排除 outlet（`plugin/src/frontend-generation-context.ts:52`）。`position=7` 整类条目等于死数据。
- **其余透传字段空转**：`characterFilter*`、`addMemo`、`automationId` 只归一不消费（`entry.ts:125,154,162-164`；`types.ts:63,127-134` 注释"不实现/仅透传"）；激活统计只有逐次 trace（`plugin/src/prompt-viewer.ts:234-261`），没有跨轮聚合。
- **四层来源不完整**：只有 Global（`activeWorlds`）+ Character（链接书）+ 嵌入兜底（`plugin/src/tavern-assets.ts:43-100`）；没有 Chat 级 lore 绑定，Persona 也没有 lorebook 字段（`tavern-store/src/store.ts:351-356`）。`chats/*.worlds.json` 是 JSR 会话副本，不是 ST 的 chat 级世界书选择。
- 面板只暴露 comment/key/keysecondary/order/depth/probability/disable/constant/selective/content（`90-panels-core.js:526-536`），其余字段只能走 advanced JSON。

### 2.3 预设

`prompt_order` 数据完整参与两端装配（`packages/plugin/src/agent-tavern/preset.ts:48-91`），但面板只提供 prompts 的增删改；没有拖拽排序、没有逐项 enabled 开关（`96-panels-presets.js:19-46` 只在增删/改名时同步 order）。ST 的 Prompt Manager 是核心体验，这是 UI 缺口而非数据缺口。

其它互操作缺口：

- **采样参数只消费 2 个键**：`temperature` + `openai_max_tokens`（`pipeline.ts:652-654`）；`top_p`/`top_k`/penalties/`min_p` 在 plugin 源码零命中，预设里其余 20+ 键静默丢弃。
- **context/instruct 模板无消费者**：解析与校验存在（`tavern-format/src/textcompletion.ts:38-104`；`prompt-context.ts:68-84`），但 Text Completion 生成路径已下线（`tavern-store/src/store.ts:2130-2131` 读取时丢弃 `pipelineMode`/`textCompletion`）。模板导入后无处生效。
- **sysprompt/reasoning 预设导入即失败**：`detectPresetKind` 只识 4 类（`textcompletion.ts:58-66`），`parsePresetOrThrow` 直接抛 `preset format not recognized`（`prompt-context.ts:82-83`）。
- **内容条目的绝对深度注入未实现**：`tavern-pipeline/src/pipeline.ts:16` 注释声称支持 `injection_position`，全包 grep 仅此一行，装配循环（`:158-181`）没有消费。
- **按角色的 `prompt_order` 被忽略**：`resolvePromptOrder` 只认 100001→100000→首组（`pipeline.ts:78-92`），ST 按 `character_id` 的专属 order 不会生效。
- **connection profile 不适用**：插件按设计复用 DSH provider/model 路由（`pipeline.ts:574-579`），预设内 `chat_completion_source` 不消费；这是架构选择，不是待补能力。

Agent 投影只承接 prompt manager 与 temperature（`agent-tavern/preset.ts:118-171`）；instruct/context template/reasoning 不投影（`prompt-context.ts:68-84`；`agent.ts:342`）。ST 架构的生成装配同样只走 chat-completion（`pipeline.ts:372-680`），并不消费 context/instruct——提案 0002 §6 的 Text Completion 路径已随 `pipelineMode` 下线（`tavern-store/src/store.ts:2130-2131`），提案状态未同步，属于文档漂移。

### 2.4 宏

内置宏覆盖 char/user/group/persona/卡字段/历史/模型/时间/随机/变量/legacy tags（`packages/tavern-macros/src/engine.ts:170-390`），未知宏保持原样（文件头注释）。

缺口：

- **绑定面不一致**：卡字段宏只在 ST 生成面绑定（`pipeline.ts:459-467`）；helper（`plugin/src/helper.ts:1782-1792`）、`prompt-context.ts:18-24`、`prompt-safety.ts:32-40` 只绑 char/user。卡作者脚本里 `{{description}}`/`{{charPrompt}}`/`{{persona}}` 会展开为空。
- **`{{outlet::Name}}` 未注册**，导致世界书 outlet 无出口（见 2.2）。
- **`{{systemPrompt}}` 恒空**：宏已注册（`engine.ts:192`），但两个构造面都不传 `init.systemPrompt`（`pipeline.ts:459-467`；`prompt-safety.ts:32-40`）。
- **`{{mesExamples}}` 与 `{{mesExamplesRaw}}` 同值**（`engine.ts:184-185`），未区分清洗/原文。
- **生成期/工具宏缺失**：`{{input}}`、`{{reverse}}`、`{{charFirstMessage::index}}`、`{{currentSwipeId}}`、`{{isMobile}}`、`{{lastGenerationType}}` 未注册（`engine.ts:195-220`）。`{{summary}}` 属官方扩展示例，不是核心义务。
- **无嵌套/条件/块宏**：单遍扫描、不递归（`engine.ts:446-490`）；`{{if}}`、块 `{{setvar}}…{{/setvar}}` 暂不支持。

### 2.5 STscript

已实现命令集：echo/comment/setvar/getvar/setglobalvar/getglobalvar/addvar/incvar/decvar/hasvar/hasglobalvar/delvar/delglobalvar/if/random/roll/pick/send/sys/trigger/regenerate/stop/cut/regex（`packages/tavern-script/src/stscript.ts:8-11`）。

缺口命令中，高价值的不是冷门命令，而是与第 1 节缺口同源的聊天动作：`/continue`、`/swipe`、`/hide`、`/unhide`、`/move`、`/rename`、`/branch`、`/checkpoint`、`/listvar`、`/flushvar`。它们都能挂在现有命令注册表（`stscript.ts:255`）与 `ScriptEnv`（`:16-46`）上，但需要服务端 env 扩能（`pipeline.ts:948-1010`）。

控制流也不完整：只有 `/if` 与单层嵌套执行（`stscript.ts:344-368`），没有 `/run`、`/times`、`/while`、`/let`、`/var`。社区 Quick Reply 脚本大量依赖循环与子脚本调用，可移植率因此接近 0。

### 2.6 群聊

`activationStrategy` 只有 `1=NATURAL`、`2=LIST`（`tavern-format/src/group.ts:15-16`）；ST 的 MANUAL（0，仅手动点选）在解析时被**静默改写成 1**（`group.ts:70`，单测 `:61`），导出的 `activation_strategy` 已不是原文件——这是静默数据损坏，不是排序/配置缺失。面板也没有策略/发言顺序配置（`80-ui-primitives.js:159` GroupBand）。`auto_mode_delay` 只透传（`group.ts:27`），没有自动发言循环；`generation_mode`（SWAP/APPEND）无字段。`talkativeness` 加权与 group nudge 已实现（`pipeline.ts:290-305`；提案 0002 §4）。`group_only_greetings` 只取第一条（`session-routes.ts:128-131`）。

### 2.7 正则与 persona

正则：全局/卡/预设 + 会话覆盖，功能面完整（`docs/frontend/tavern-helper-compat.md` §4.1）；面板缺导出按钮（`81-ui-regex.js:369-372` 只有导入/同步）。

Persona：数据层支持 position/depth/role（`pipeline.ts:487-500`），但面板编辑器只有 name/description（`80-ui-primitives.js:35-40`），没有头像与注入位置配置。

---

## 3. 前端与扩展面

### 3.1 消息渲染

ST 面板正文是纯文本（`84-ui-chat.js:139`），思考块也是纯文本（`:123`）。`MarkdownText` 已加载（`00-shell-head.js:43`），但只用于 reasoning/资产视图（`89-ui-assistant.js:121`、`90b-panel-views.js:17`）。完整 HTML 文档走沙箱 iframe（`84-ui-chat.js:68,126-136`），行内 HTML 不渲染。

### 3.2 消息动作

面板动作行只有 swipe 切换、编辑、两种分支（`84-ui-chat.js:140-152`）。缺复制、单条删除、单条重生成、reaction、翻译、朗读、出图。数据写路径现成（全量 `PUT chat`），不需要新事务。

### 3.3 事件桥

`tavern_events` 全量声明（`packages/tavern-jsr/src/index.ts:81-164`），真实投递清单见 `docs/frontend/tavern-helper-compat.md` §3.2：APP_READY、MESSAGE_SENT/RECEIVED/EDITED/SWIPED/DELETED、CHAT_CHANGED、PRESET_CHANGED、GENERATION_STARTED/STOPPED、STREAM_TOKEN_RECEIVED、CHARACTER_MESSAGE_RENDERED、USER_MESSAGE_RENDERED、CHAT_COMPLETION_SETTINGS_READY 等。

未桥接且卡脚本常依赖的：`WORLD_INFO_ACTIVATED`、`MESSAGE_UPDATED`、`MESSAGE_SWIPE_DELETED`、`MESSAGE_FILE_EMBEDDED`、`CHAT_CREATED`、`CHAT_DELETED`、`CHARACTER_*`、`PRESET_DELETED/RENAMED`。事件由快照比对推导，补桥接需要宿主持久化"上一快照"之外的信号；落点在生成落盘（`pipeline.ts:838-858`）、聊天写路由（`chat-generation-routes.ts:32-40`）、世界书激活（`pipeline.ts:410-425`）。

### 3.4 扩展模型

ST 扩展 = 浏览器 JS + manifest + 设置页；本插件 Mod = Node 侧 ESM + 能力面（`packages/plugin/src/mods/host.ts:759-846`）。JSR 沙箱显式拒绝扩展安装（`tavern-jsr/src/client.ts:2690-2693`），`registerExtension`/`loadExtensionSettings` 未实现。要承接 ST 扩展开源生态，需要独立提案定义"扩展清单 → Mod 清单"的映射与 UI 注入边界；不能靠现有 shim 伪装。

### 3.5 官方扩展能力

TTS、图像生成、翻译、表情/立绘、主题/背景/自定义 CSS 均无实现（`client-src` 检索无功能代码；主题只跟随宿主，`10-frontend-frame.js:161-215`；音频只在卡 iframe 内，`tavern-jsr/src/client.ts:495-650`）。沙箱 `allow-scripts` 无 same-origin、`connect-src` 默认仅 `blob:`（`00-shell-head.js:86-118`），这些能力**必须落宿主**：消息动作行 + 面板分区 + 服务端路由（或 Mod 服务端 API），不能塞进卡 iframe。

### 3.6 数据备份

仅 character/world/preset 三类导出（`routes.ts:270,448,463`）。无整库快照、恢复、迁移向导；聊天导出也缺（见 1.3）。

---

## 4. AgentTavern 侧

工具面 25 件齐全：角色/世界书/历史/场景 4、记忆 5、变量 5、剧本 2、推演 1、MVU 1、游戏 7（`packages/plugin/src/agent-tavern/agent.ts:228-236`；清单 `mods/cross-bundle.ts:78-90`）。缺的是**工具之外的自动化**：

1. **世界书位置化自动激活**：Agent 路径没有 system 注入，只有模型主动 `tavern_lore_search`；该工具内部还把 `scanDepth:1, recursive:false` 写死（`agent-tavern/tools/character.ts:55-60`）。ST 路径才有位置化装配（`pipeline.ts:517-525`）。落点：`agent.ts:178-199` 的 context 部件（order≈-66）或 `card-state.ts:220` 的 pre-step 通道，复用 `activateWorldInfo`。
2. **记忆零自动召回**：五个 `memory_*` 工具可用，prompt 部件里没有一条记忆（`agent.ts:73-95`）。落点：context 部件注入 top-N（importance×freshness），复用 `memory-hybrid.ts:72-115`。
3. **无 summary 通道**：只有压缩检查点（`compaction/shared.ts:12-45`；`curator.ts:177-180`），没有 ST 式"按需总结并常驻"。数据可落 `chat_metadata.summary`；`tavern_scene_get` 已能读全量 metadata（`agent-tavern/tools/character.ts:95-100`）。
4. **Data Bank/文件 RAG 缺失**：向量只服务 64KB 文本记忆（`tavern-store/src/memory.ts:15-30`；`memory-hybrid.ts:72-115`）。落点：复用 `memory-embed.ts` + 新工具注册（`agent.ts:228`）。
5. **Checkpoint/Rewind 只有被动收养**：全仓只收养宿主 fork（`agent-tavern/fork.ts:1-20`），不主动调用；无 live rewind 命令。落点：`ctx.commands.register`（`session/command.ts:34-38`）+ `sessions.fork`。
6. **预设投影只承接一半**：prompt manager + temperature（`agent-tavern/preset.ts:118-171`）；instruct/context/reasoning 不投影（`prompt-context.ts:68-84`）。这是"Agent 模式与 ST 预设语义对等"的主要缺口。
7. **Author's Note/depth 注入缺失**：Agent 路径没有 depth 注入通道（`agent.ts:73-95`），guides 是另一条语义（`guides.ts:19-22`）。

---

## 5. 结构性边界

以下不建议按"补齐 ST"直接做：

- **ST 扩展安装/DOM 直改**：沙箱无 same-origin（`00-shell-head.js:86-118`），`retrieveDisplayedMessage`/`refreshOneMessage` 已显式抛错（`tavern-jsr/src/client.ts:2703-2704`）。要兼容需独立提案。
- **`fetch`/WebSocket 直连**：CSP 默认只放行 `blob:`；外部资源开关也只放行 `https:`，不含 `wss:`（`docs/frontend/tavern-helper-compat.md` §0）。
- **多 API 连接 profile**：DSH 宿主已有 provider/model 路由与密钥管理，插件按设计复用（`README.md` "与 DSH 的原生集成"），不应再建第二套。
- **Text Completion/Kobold 直连**：`pipelineMode`/`textCompletion` 已从 state 下线并在读取时丢弃（`tavern-store/src/store.ts:2130-2131`），当前只走宿主 Chat Completion 路由。若要对齐 ST 的 Text Completion 后端，需新提案，而不是在现有装配里补分支。
- **Fabric**：不在运行路径（`README.md`）。
- **token 概率/logprobs**：依赖 provider 能力与宿主 streaming 形状，`HostLlmChunk` 当前没有 logprob 变体（`host-contract.ts:50-58`）；属宿主能力缺口，不是插件 UI 缺口。

---

## 6. 优先级建议

**P0（现有接缝、用户高频、低风险）**

1. `is_hidden` 语义贯通：生成历史过滤 + 面板渲染 + 消息动作（`pipeline.ts:503`、`84-ui-chat.js:126-152`）。
2. 消息动作补齐：删除/复制/单条重生成（复用全量 `PUT chat`）。
3. 聊天 JSONL 导入/导出（复用 `tavern-format/src/chat.ts`）。
4. 采样参数透传（`pipeline.ts:650-655`），先覆盖 top_p/top_k/penalties/stop。
5. 世界书全局设置面：把写死的 `recursive/scanDepth/budgetPercent` 与其余引擎开关接进 state + 面板（`pipeline.ts:419`；`store.ts:189`）。
6. 宏绑定一致性：helper/prompt-context/prompt-safety 三处补卡字段（`helper.ts:1782`；`prompt-context.ts:18`；`prompt-safety.ts:32`）。
7. 群聊 MANUAL 修复：类型保留 0，解析不再静默改写（`group.ts:16,70`），补一条迁移/回归测试。
8. STscript 聊天动作命令扩展（`stscript.ts:255` + `pipeline.ts:948-1010`）。
9. 正文 markdown 渲染（`84-ui-chat.js:139`，`MarkdownText` 已在作用域）。
10. 文档纠偏：提案 0002 的 Text Completion 状态、`pipeline.ts:16` 的 `injection_position` 注释、`group.ts` 的策略注释与实现对齐。

**P1（需要少量新数据/路由）**

11. Continue/Impersonate 生成动词（`pipeline.ts:240`）。
12. 聊天级 Author's Note（字段 + 面板 + 两端注入）。
13. Checkpoint/Rewind（复用 branch 存储 + 新路由）。
14. 预设 prompt_order 可视化（拖拽 + enabled，`96-panels-presets.js`）。
15. 预设分类与消费者：sysprompt/reasoning 识别（`prompt-context.ts:82`）、context/instruct 在 chat 管线的消费或明确拒绝。
16. Agent 自动世界书激活 + 记忆 top-N（`agent.ts:178-199`）。
17. Summary 通道（ST + Agent，`curator.ts:177`、`chat_metadata.summary`）。
18. Quick Replies 最小闭环（资产 + `/qr` + composer）。
19. 世界书 outlet：注册 `{{outlet::Name}}`（`tavern-macros/src/engine.ts:216`；`tavern-lore/src/engine.ts:283`）。
20. alternate greetings 切换路由（`session-routes.ts:164`）。

**P2（新基础设施/独立提案）**

21. Data Bank/文件 RAG（复用 embed）。
22. 翻译/TTS/图像生成（宿主 provider + 消息动作；先经 Mod API 验证）。
23. 主题/背景/表情。
24. ST 扩展兼容层（独立提案）。
25. 整库备份/迁移。
26. 世界书 vectorized 检索（复用记忆 embed；需先定 provider 与索引身份）。

---

## 7. 证据复现

```bash
# 生成模式与采样参数
rg -n "mode: 'send'|temperature:|maxTokens:" packages/plugin/src/generation/pipeline.ts
rg -n "top_p|top_k|frequency_penalty|logit_bias" packages/plugin/src packages/tavern-format/src

# 隐藏语义
rg -n "is_hidden" packages/plugin/src packages/plugin/client-src

# 聊天导入导出路由
rg -n "export/character|import/character|export/chat|import/chat" packages/plugin/src/http/routes.ts

# STscript 命令表
sed -n '1,60p' packages/tavern-script/src/stscript.ts

# 事件桥真实投递
sed -n '370,425p' docs/frontend/tavern-helper-compat.md

# Agent 上下文部件
rg -n "systemPrompt|context\(" packages/plugin/src/agent-tavern/agent.ts

# 世界书调用点与 outlet
sed -n '410,425p' packages/plugin/src/generation/pipeline.ts
rg -n "outlet" packages/tavern-lore/src packages/tavern-macros/src packages/plugin/src

# 宏绑定面
rg -n "createMacroEngine\(" packages/plugin/src packages/tavern-macros/src

# 预设分类与 TC 下线
sed -n '58,66p' packages/tavern-format/src/textcompletion.ts
sed -n '2128,2134p' packages/tavern-store/src/store.ts

# 群聊 MANUAL
sed -n '55,75p' packages/tavern-format/src/group.ts

# STscript 命令表
sed -n '1,60p' packages/tavern-script/src/stscript.ts
```
