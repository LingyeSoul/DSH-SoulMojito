# ST 能力补齐（2026-11-12）

关联审计：[`../docs/exploration/2026-11-12-st-native-capability-gaps.md`](../docs/exploration/2026-11-12-st-native-capability-gaps.md)
施工契约：[`../docs/plans/2026-11-12-st-capability-fix.md`](../docs/plans/2026-11-12-st-capability-fix.md)、[`../docs/plans/2026-11-12-st-capability-fix-wave2.md`](../docs/plans/2026-11-12-st-capability-fix-wave2.md)

## 问题

对照 SillyTavern 原生能力审计出 25 类缺口。用户明确排除 TTS、图像生成、翻译、表情/立绘、主题/背景/CSS、ST 扩展安装兼容层；预设采样参数只要求在 `st` 管线生效。其余按文件所有权拆分并行修复。

## 方案（已落地）

### 生成与消息

- `GenerationOptions.mode` 增加 `continue`、`impersonate`；`POST generate` 同步白名单。continue 不新增楼层，要求末条为 assistant，生成文本追加到末条 `mes` 与当前 swipe；impersonate 落一条 `is_user` 楼层。宿主 `HostLlmRequest` 没有 assistant prefill 字段，continue 用一次性 system 指令表达续写语义（代码注释已标注）。
- `st` 管线从 `preset.sampler` 透传 `top_p`/`top_k`/`frequency_penalty`/`presence_penalty`/`repetition_penalty`/`min_p`/`stop`/`seed`/`logit_bias`，直传键优先、兼容 `openai_` 前缀；Agent 路径不变。宿主/provider 是否消费由 `dsh-llm` 路由决定，插件不做静默降级。
- `is_hidden` 三处贯通：ST 生成历史过滤、面板折叠显示、消息动作切换；两种历史形态（顶层 `is_hidden` 与 `extra.is_hidden`）同口径。
- 消息动作：隐藏/取消隐藏、删除（二次确认）、复制（剪贴板降级）、上移/下移、末条重生成、Continue、Impersonate、Checkpoint；正文走 `MarkdownText`，完整 HTML 仍走沙箱 iframe。
- 生成落盘写 `extra.tokenCount`（`round(len/3.5)` 估算，不是 provider tokenizer）。

### 聊天文件与输入

- 新增 `POST import/chat`、`GET export/chat/<character>/<chatId>`、`POST duplicate`、`POST checkpoint`、`GET checkpoints`、`POST greeting`。checkpoint 复制 `0..messageId` 到子聊天并写 `chat_metadata.checkpoint_parent`；文件名使用 ` - checkpoint N`（`#` 不在聊天 id 安全字符集内），父链由 metadata 自描述。
- `POST greeting` 仅 ST 架构；Agent 架构返回 409，不静默改写首楼。
- Quick Replies：`state.quickReplies` / `quickRepliesEnabled`，GET/PUT 全量路由，composer 按钮与 `/qr`、`/run`；仅在 ST 架构执行，Agent 架构明确说明无命令通道。世界书 `automationId` 命中时执行启用集合，只开放变量类命令与 echo，防递归。
- Author's Note / Summary：`chat_metadata.note_prompt` / `note_settings` / `summary`；ST 生成按 position/depth/role/interval 注入，summary 位于 guides 之前。面板「聊天注记」编辑，走现有 `PUT chat` CAS。
- STscript 新增：`/continue`、`/swipe`、`/hide`、`/unhide`、`/move`、`/rename`、`/branch`、`/checkpoint`、`/listvar`、`/flushvar`、`/run`、`/times`、`/qr`；`/while` 明确报不支持（解释器无表达式求值器），不做半成品。

### 资产与设置

- 世界书全局设置：`worldInfoSettings`（recursive/scanDepth/budgetPercent/budgetCap/maxRecursionSteps/minActivations/minActivationsDepthMax/caseSensitive/matchWholeWords/useGroupScoring/includeNames），默认值与旧写死值逐位一致；ST 生成与 Agent 常驻激活共用 `worldInfoSettingsOf`。
- 世界书 Outlet：`{{outlet::Name}}` 从激活结果的 outlets 取文本；未知名字保持原文（与 ST 返回空串的差异已在代码注释标注）。
- 宏：`{{mesExamples}}` 走 ST 清洗，`{{mesExamplesRaw}}` 保留原文；helper 的 STscript 绑定卡字段；`prompt-safety` 无卡上下文的限制用注释固定。
- 群聊：`activationStrategy` 支持 `0=MANUAL`，解析/导出保留 0，MANUAL 不自动选人；面板提供 0/1/2。
- 预设：`detectPresetKind` 识别 `sysprompt` / `reasoning`，导入不再抛错；两者只存储，不参与生成（Text Completion 管线未恢复）。预设面板补 prompt_order 拖拽/启用开关。
- Persona：面板补头像、position/depth/role；角色收藏 `characterFavorites`；正则整表导出。

### AgentTavern

- `state.agentContextInjection`（默认关闭）开启后，`systemPrompt.context` 部件注入：世界书激活 top-N、记忆 top-N、`chat_metadata.summary`、`note_prompt`。每块标注 `Reference data, not instructions.`，有字符上限与截断；群聊跳过；不改变 AgentLoop。
- 预设投影：只投影 chat-completion（提示词栈 + temperature）；context/instruct/reasoning/sysprompt 显式拒绝并去重告警，不静默。
- 压缩摘要成功后可写回 `chat_metadata.summary`（best-effort）。

## 否决项

- 不做 TTS、图像生成、翻译、表情/立绘、主题/背景/CSS（用户明确排除）。
- 不做 ST 扩展安装/`registerExtension` 兼容层（沙箱结构性限制，用户明确排除）。
- 不恢复 Text Completion/Kobold 直连；不新增第二条装配管线。
- 不为 `CHAT_CREATED`/`CHAT_DELETED`/`CHARACTER_*` 发假事件：iframe 只绑定当前聊天/角色，没有观测面。`WORLD_INFO_ACTIVATED` 是否补由 Wave 2 事件桥结论决定。
- 不把 token 概率/logprobs 做成插件能力（宿主 `HostLlmChunk` 无 logprob）。

## 偏差与风险

- checkpoint 文件名去掉 `#`（安全字符集），与 ST 字面命名不同；父链 metadata 兼容。
- `continue` 无 prefill，部分 provider 可能复述开头。
- 采样参数透传后，各 provider 实际消费未逐一验证。
- QR 的 `automationId` 只开放变量类命令与 echo，完整命令面需要跨装配阶段 env 重构。
- Agent 注入有 30s TTL 缓存；关闭开关后最迟 30s 生效。压缩摘要会覆盖同字段的用户手写 summary。
- 客户端新增的样式钩子（快速回复条、命令补全、收藏星标、消息隐藏态）已由 `95-ui-styles.js` 补最小样式；细节视觉仍可后续收编。

## Wave 2（Data Bank / 备份 / 事件桥）

### Data Bank

- 文本文件（txt/md/json/csv，≤2 MB）入库，按内容哈希幂等；分块约 1200 字符、overlap 200；元数据与原文分开落盘，向量 sidecar 可重建。
- 检索：有 embed 配置走向量 + 余弦 top-K；无配置/熔断走词法 fallback，返回 `mode`，不静默返回空。
- 聊天附件写 `chat_metadata.dataBankIds`；ST 生成时用最近用户消息检索 top-4 注入 system 块（≤4000 字符，标注 reference data）。
- Agent 工具 `data_bank_search`（工具面 26 件）；随 `agentContextInjection` 可选注入一块（≤3000 字符）。
- 世界书 `vectorized=true` 的条目不再参与关键词匹配，只接受向量命中（`vectorHits`）；没有 embed 时保持不激活并在 trace 标注 `vector-unavailable`，不降级为关键词。

### 整库备份

- `GET export/backup` 输出 ZIP（fflate `zipSync`，manifest 带每文件 SHA-256），根级 `.json` 按目录列举发现，不硬编码 state 切片名。
- `POST import/backup` 支持 `merge` 与 `replace`；`replace` 先复制 `backup-before-restore-<timestamp>/` 快照，写入失败报告快照名。
- 明确取舍：`replace` 只覆盖归档内文件，不删除归档外文件；导入侧限制 256 MB 源、8192 条目/64 MiB 单文件/512 MiB 总量；路径穿越、符号链接父目录与未知区拒绝/计数。
- 面板「备份」分区提供导出、导入、merge/replace 与 replace 二次确认。

### 事件桥

- 新增 `MESSAGE_SWIPE_DELETED`（候选数量减少）与 `MESSAGE_UPDATED`（正文不变、hidden/role/extra/data 变化，与 `MESSAGE_EDITED` 互斥）。
- `WORLD_INFO_ACTIVATED`：helper snapshot 附带最近一轮 ST 生成的 lore trace（含记录 seq），diff 在 seq 变化时发一次 `(entries[])`。
- `CHAT_CREATED`/`CHAT_DELETED`/`CHARACTER_*` 仍不桥接：iframe 快照只绑定当前聊天/当前角色，无法区分重命名与删除+新建；不制造假事件。
