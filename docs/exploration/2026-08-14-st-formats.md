# SillyTavern 互操作格式技术参考

> 调研日期：2026-08-14。来源：CCv2/V3 规范原文（GitHub raw）、SillyTavern `release` 分支源码（`world-info.js`、`PromptManager.js`、`openai.js`、`script.js`、`personas.js`、`char-data.js`、`src/character-card-parser.js`）、docs.sillytavern.app、ST 内置默认 preset。本地对照实现：`<local ST checkout>`（源码 checkout，可作行为对照；不随仓库分发）。
> 勘误：V2 规范仓库现为 `malfoyslastname/character-card-spec-v2`（旧名 404）；V3 为 `kwaroran/character-card-spec-v3` 的 `SPEC_V3.md`。当前 V3 规范**没有** `system_prompt_multilingual`/`post_history_instructions_multilingual`/`lorebook_version`（仅早期草案/第三方实现）。
> 勘误（2026-10-09）：§3.1 中「100000 单聊 dummy、100001 群聊 dummy」的对应关系记反了。ST `openai.js` 的 ChatCompletion 装配传入 `promptOrder: { strategy: 'global', dummyId: 100001 }`——**单聊（global）读取 100001 组**；100000 是 `PromptManager` 的内部默认常量/其他残留。实现按「100001 → 100000 → 首组」回落。

## 1. 角色卡（Character Card）

### 1.1 载体

| 载体 | V2 | V3 |
|---|---|---|
| PNG/APNG | JSON（utf-8→base64）在 tEXt chunk 关键字 **`chara`** | 同机制 chunk **`ccv3`**；并存时应优先 `ccv3` |
| JSON 文件 | 根对象即卡数据 | 同 |
| CHARX（V3） | — | **zip 包，根目录必含 `card.json`**；资源以 `embeded://path/to/asset.png` 引用，按 `assets/{type}/images|audio|video/…` 存放 |

ST 导出行为（`src/character-card-parser.js`）：同时写 `chara`（V2）+ `ccv3`（spec 改写为 `chara_card_v3`/`3.0` 的副本）两个 tEXt chunk（IEND 之前）；读取 `ccv3` 优先。

### 1.2 V2 字段（`spec_v2.md`，已验证）

```ts
type TavernCardV2 = {
  spec: 'chara_card_v2'; spec_version: '2.0'
  data: {
    name, description, personality, scenario, first_mes, mes_example: string
    creator_notes: string                 // 不进 prompt
    system_prompt: string                 // 替换前端"系统提示"；空串回落用户设置；必须支持 {{original}}
    post_history_instructions: string     // 替换 ujb/jailbreak 位；支持 {{original}}
    alternate_greetings: string[]         // first_mes 的 swipe 候选
    character_book?: CharacterBook
    tags: string[]                        // 前端筛选，大小写不敏感
    creator: string; character_version: string
    extensions: Record<string, any>       // 默认 {}；不得销毁未知键；命名空间化（如 "agnai/voice"）
  }
}
```

角色书 SHOULD 与用户世界书叠加且**角色书优先**。

### 1.3 V3 字段（`SPEC_V3.md`，已验证；V2 超集）

新增：`assets?: Array<{type, uri, name, ext}>`（icon/background/user_icon/emotion；uri 支持 `embeded://`、`ccdefault:`、https、data URL）、`nickname?`（存在则 `{{char}}` 替换为它）、`creator_notes_multilingual?: Record<ISO639-1, string>`、`source?: string[]`（只追加）、`group_only_greetings: string[]`（MUST 存在，可空）、`creation_date?/modification_date?`（Unix 秒）。`spec_version` 按浮点比较；应用应忽略未知字段。

### 1.4 内嵌 character_book / Lorebook

V2 形式：

```ts
type CharacterBook = {
  name?; description?: string
  scan_depth?: number; token_budget?: number; recursive_scanning?: boolean
  extensions: Record<string, any>
  entries: Array<{
    keys: string[]; content: string; extensions: Record<string, any>
    enabled: boolean; insertion_order: number   // 数值小 = 插入更靠前（高）
    case_sensitive?: boolean; name?; priority?; id?; comment?: string
    selective?: boolean; secondary_keys?: string[]
    constant?: boolean
    position?: 'before_char' | 'after_char'
  }>
}
```

V3：entries 增 `use_regex: boolean`；`constant` 要求实现；`id` 允许 number|string；独立导出包裹 `{spec:'lorebook_v3', data: Lorebook}`；decorator 体系（`@@depth`/`@@role`/`@@position`/`@@activate_only_after` 等）——**ST 本身不实现 decorator**（做成了自有字段），它是 RisuAI 方向的跨前端层。

ST 自有角色扩展（`data.extensions`，`char-data.js`）：`talkativeness`、`fav`、`world`（绑定世界书名）、`depth_prompt: {prompt, depth, role}`、`regex_scripts`（卡级正则）。ST 把自有字段写回 `entries[].extensions`（`position` 数字、`exclude_recursion`、`probability`、`useProbability`、`depth`、`selectiveLogic`、`group`、`group_override`、`group_weight`、`prevent_recursion`、`delay_until_recursion`、`scan_depth`、`match_whole_words`、`use_group_scoring`、`case_sensitive`、`automation_id`、`role`、`vectorized`、`display_index` 等）。

## 2. 世界书（World Info，ST 原生）

### 2.1 文件格式

`worlds/<name>.json`，顶层唯一键 **`entries`：uid 字符串 → 条目**（map，非数组——与卡内嵌 book 的数组形式不同）。来源分层：**Chat / Persona / Character / Global** 四类 lore，按插入策略（evenly / character_first / global_first）合并排序。

### 2.2 条目字段全表（`world-info.js` `newWorldInfoEntryDefinition`，含默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `key` / `keysecondary` | `[]` | 主/副键；`/…/flags` 形式按 JS 正则匹配（`\x01` 前缀按角色名匹配） |
| `comment` | `''` | Memo，不进 prompt |
| `content` | `''` | 激活后插入文本（过宏 + 正则脚本） |
| `constant` | `false` | 蓝圈：无条件激活（预算内优先） |
| `vectorized` | `false` | 向量检索匹配（需扩展） |
| `selective` | `true` | 启用副键逻辑 |
| `selectiveLogic` | `0` | `0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL` |
| `addMemo` | `false` | key 未命中 comment 时回填 |
| `order` | `100` | 插入顺序；**越大越靠近上下文末端**（降序排序） |
| `position` | `0` | 见下 |
| `disable` | `false` | 禁用 |
| `ignoreBudget` | `false` | 不计预算 |
| `excludeRecursion` / `preventRecursion` | `false` | 不可被递归激活 / 激活后不触发他人 |
| `matchPersonaDescription` / `matchCharacterDescription` / `matchCharacterPersonality` / `matchCharacterDepthPrompt` / `matchScenario` / `matchCreatorNotes` | `false` | 额外匹配源 |
| `delayUntilRecursion` | `0` | 仅递归第 N 层可激活 |
| `probability` / `useProbability` | `100`/`true` | 触发概率 % |
| `depth` | `4` | `position=atDepth` 的深度（0 = prompt 最底部） |
| `outletName` | `''` | Outlet 位置具名出口，配 `{{outlet::Name}}` |
| `group` / `groupOverride` / `groupWeight` / `useGroupScoring` | `''`/`false`/`100`/`null` | Inclusion Group：同组只插一条（权重随机或 override 按 order） |
| `scanDepth` / `caseSensitive` / `matchWholeWords` | `null` | 条目级覆盖（null=跟随全局） |
| `automationId` | `''` | 与 Quick Reply 同 ID 即执行 STscript |
| `role` | `0` | atDepth 消息角色：`0=system,1=user,2=assistant` |
| `sticky` / `cooldown` / `delay` | `null` | Timed Effects（单位=消息数）：保持 N 条 / 冷却 N 条 / N 条后才可激活 |
| `triggers` | `[]` | 限定生成类型：normal/continue/impersonate/swipe/regenerate/quiet |
| `characterFilterNames` / `characterFilterTags` / `characterFilterExclude` | — | 角色过滤（世界书元数据） |

### 2.3 `position` 枚举（`world_info_position`）

| 值 | 含义 |
|---|---|
| 0 | Before Char Defs |
| 1 | After Char Defs |
| 2 | Top of AN（作者注顶部） |
| 3 | Bottom of AN |
| 4 | @D 聊天内指定深度（配 `depth`+`role`） |
| 5 | Before Example Messages |
| 6 | After Example Messages |
| 7 | Outlet（具名出口，不自动注入） |

### 2.4 触发算法（`checkWorldInfo`/`WorldInfoBuffer` 归纳，已验证）

1. **缓冲构建**：最近 N 条（`scanDepth`，MAX=1000）按深度入 depthBuffer，`\x01` 前缀分隔；可并入 persona/角色字段/扩展注入（`extensionPrompts` 中 `scan:true`）。
2. **排序**：四层来源合并，`order` 降序（同 order 按 uid 升序）；timed effects 检查（sticky 期忽略概率重掷）。
3. **主循环**（INITIAL → RECURSION → MIN_ACTIVATIONS）：disable/已激活/概率失败跳过；无 key 非constant跳过；constant 直入候选。**主键**：正则键 `regex.test`；否则大小写归一后 `includes`；`matchWholeWords` 且键为单词时边界正则 `(?:^|\W)(key)(?:$|\W)`（中文应关）。**副键**：AND_ANY 任一命中 / AND_ALL 全命中 / NOT_ANY 全未命中 / NOT_ALL 任一未命中。**概率** `Math.random()*100 <= probability`。**预算** `context * budget%`（可被 `budget_cap` 截断），超即停止（constant 排序靠前先占）。
4. **递归**：新激活且未 `preventRecursion` 的 content 追加进 recurseBuffer 进下一轮；`excludeRecursion` 不被递归激活；`delayUntilRecursion` 分层解锁；`max_recursion_steps` 限轮。
5. **Min Activations**：不足 `min_activations` 时加深扫描窗口（受 `min_activations_depth_max` 限）。
6. **装配**：激活条目按 order 降序 `unshift` 拼接，按 position 分发 worldInfoBefore/After、EM 前后、AN 上下、@Depth 条目、outlets。

## 3. 预设（Preset）

### 3.1 Chat Completion preset（`data/%USERNAME%/OpenAI Settings/*.json`，62 键）

= **采样参数 + `prompts[]` + `prompt_order[]` + 模型选择/杂项**：

- **prompts[]** 普通条目 `{name, system_prompt: true, role: 'system'|'user'|'assistant', content, identifier}`；**marker 条目** `{identifier, marker: true}`——注入点：`chatHistory`、`worldInfoBefore`、`worldInfoAfter`、`charDescription`、`charPersonality`、`scenario`、`personaDescription`、`dialogueExamples`。用户条目带 `injection_position`（0=相对/1=绝对@Depth）+ `injection_depth`。保留 identifier：`main`、`nsfw`、`jailbreak`（Post-History Instructions/UJB）、`enhanceDefinitions`。
- **prompt_order[]**：按角色存启用与排序 `[{character_id, order: [{identifier, enabled}]}]`；`100000` 单聊 dummy、`100001` 群聊 dummy，真实角色以 chid 为键。
- **参数键**（Default 实测）：temperature/top_p/top_k/top_a/min_p/frequency_penalty/presence_penalty/repetition_penalty/openai_max_context/openai_max_tokens/seed/n/stream_openai/names_behavior/squash_system_messages/`wi_format("{0}")`/scenario_format/personality_format/group_nudge_prompt/impersonation_prompt/new_chat_prompt("[Start a new Chat]")/continue_nudge_prompt/send_if_empty/chat_completion_source + 模型名。

**默认 prompt_order（= 最终 prompt 装配顺序）**：
`main → worldInfoBefore → personaDescription → charDescription → charPersonality → scenario → [enhanceDefinitions] → nsfw → worldInfoAfter → dialogueExamples → chatHistory → jailbreak(UJB)`。角色卡 `system_prompt`/`post_history_instructions` 分别替换 main 与 jailbreak 内容（空串回落）。

### 3.2 Text Completion preset（独立两文件）

- Context 模板（`presets/context/*.json`）：`story_string`（Handlebars）默认序 `anchorBefore → system → wiBefore → description → personality → scenario → wiAfter → persona → anchorAfter`，配 `story_string_position/depth/role` 等。
- 采样器（`presets/textgen/*.json`）：40+ 键（temp/typical_p/min_p/rep_pen/dynatemp/dry_*/mirostat_*/sampler_priority/…）。
- 另有 instruct / sysprompt / reasoning 预设。

## 4. 宏

大小写不敏感；新版实验宏引擎支持嵌套、`{{macro arg}}`/`{{macro::a::b}}`、`{{if}}/{{else}}`、scoped `{{setvar}}…{{/setvar}}`。核心集：

- 名称：`{{char}}`（V3 优先 nickname）、`{{user}}`、`{{group}}`、`{{charIfNotGroup}}`、`{{notChar}}`；旧式 `<BOT>`/`<USER>` 自动转换。
- 卡/persona：`{{persona}}`、`{{description}}`、`{{personality}}`、`{{scenario}}`、`{{charPrompt}}`、`{{charInstruction}}`、`{{charDepthPrompt}}`、`{{mesExamples}}`、`{{charFirstMessage::index}}`、`{{original}}`。
- 历史：`{{lastMessage}}`、`{{lastUserMessage}}`、`{{lastCharMessage}}`、`{{currentSwipeId}}`、`{{summary}}`（扩展）。
- 时间：`{{time}}`、`{{time::UTC+8}}`、`{{date}}`、`{{weekday}}`、`{{datetimeformat::fmt}}`、`{{idleDuration}}`。
- 随机：`{{random::a::b::c}}`（每求值重掷）、`{{pick::a::b}}`（同 chat 稳定）、`{{roll::1d20}}`。
- 变量：`{{getvar}}/{{setvar}}/{{addvar}}/{{incvar}}/{{decvar}}/{{hasvar}}/{{deletevar}}` + globalvar 系。
- 运行时：`{{maxPrompt}}`、`{{maxContextTokens}}`、`{{model}}`、`{{isMobile}}`、`{{lastGenerationType}}`。
- 模板注入：`{{systemPrompt}}`、`{{authorsNote}}`、`{{chatSeparator}}`、`{{outlet::name}}`。
- 工具：`{{newline}}`、`{{space}}`、`{{trim}}`、`{{reverse}}`、`{{input}}`、注释 `{{// …}}`。

**正则脚本**（与正则宏区分）：数据形态 `{scriptName, findRegex, replaceString, trimStrings, placement, disabled, promptOnly, markdownOnly, runOnEdit, substituteRegex, minDepth, maxDepth}`；placement 枚举 `USER_INPUT=1, AI_OUTPUT=2, SLASH_COMMAND=3, WORLD_INFO=5, REASONING=6`；WI 内容进 prompt 前过 WORLD_INFO placement。

## 5. 聊天文件与 Persona

### 5.1 聊天（`script.js` saveChat）

每聊天一个 `.jsonl`（`data/%USERNAME%/chats/<角色名>/<时间戳>.jsonl`）。**第 1 行 header** `{user_name, character_name, chat_metadata}`（现版本前两者恒 `'unused'`，真实元数据在 chat_metadata）；其后每行：

`{name, is_user, is_system, send_date, mes, extra: {api, model, token_count, reasoning, …}, swipe_id, swipes: string[], swipe_info: [{send_date, gen_started, gen_finished, extra}], gen_started, gen_finished, title}`

- `swipes[]` 全候选文本 + `swipe_id` 当前索引 = 重掷候选机制；`is_system: true` 不进 prompt。
- 群聊同格式存 `groups/`，群定义独立 json：`{id, name, members, activation_strategy(1=自然/2=列表), generation_mode, disabled_members, chat_id, chats, auto_mode_delay}`。

### 5.2 Persona（`personas.js`）

头像 PNG + settings.json 映射：`power_user.personas[avatarId]=name`；`persona_descriptions[avatarId]={description, position, depth, role, lorebook, title}`；position 枚举 `0=IN_PROMPT, 2=TOP_AN, 3=BOTTOM_AN, 4=AT_DEPTH, 9=NONE`。可绑专属 Lorebook。

## 6. ST 架构速览

Node(Express) 本地服务器 + 浏览器前端；多用户 `data/%USERNAME%/`（characters/chats/worlds/groups/presets/personas/settings.json/extensions）。LLM 请求由服务器代理（密钥存服务端）。两类生成管线：**Chat Completion**（messages[] + prompts/prompt_order 装配）与 **Text Completion**（story_string + instruct 模板拼单串 + 采样器）。扩展系统：浏览器端 `data/%USERNAME%/extensions/<name>/` + `manifest.json`，经事件总线、`getContext()`、`extension_settings`、`extensionPrompts`（scan:true 参与 WI 扫描）交互；服务器端另有 plugin 机制。

「SillyTavern-like」功能面：消息编辑/删除/分支（bookmark 分支存独立聊天并回链）、swipes、continue、regenerate、impersonate、群聊（激活策略/自动模式/群 nudge）、Author's Note（默认每 1 条插入，可调频率/深度/位置）、角色 @Depth note、世界书四层来源 + 导入导出、卡级正则脚本、Quick Replies + STscript、Data Bank 与向量检索。

## 7. 存疑项

1. `system_prompt_multilingual`/`post_history_instructions_multilingual`：不在当前 SPEC_V3.md（只有 `creator_notes_multilingual`）。
2. `lorebook_version`：非 CCv3 字段，疑似 RisuAI 自有格式，未验证。
3. `chara-ext-asset_:{path}` PNG 资源 chunk 与 CHARX 目录约定：规范有、ST 未完整实现（ST 只写 `chara`/`ccv3`）。
