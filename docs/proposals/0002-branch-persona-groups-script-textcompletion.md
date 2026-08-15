# 提案 0002：branch/bookmark、persona 管理、群聊、STscript/regex、Text Completion

> 状态：已实现并验证（tsc + 17 文件 134 项测试 + 六道 gate 全绿）。日期：2026-08-15。基线：提案 0001 的第一版主线。

## 1. 范围

第一版交付了单角色 Chat Completion 主线。本提案补齐五个生态缺口，全部遵循既有边界：
纯逻辑进库包、持久化进 `tavern-store`、路由进 Node half、UI 进正式 slots / sidebar adapter，
不引入 Fabric，不复制 ST 源码（语义对照 `docs/exploration/2026-08-14-st-formats.md`）。

| 能力 | 库 | 存储 | UI 面 |
|---|---|---|---|
| branch/bookmark | format（bookmark_link 透传） | `chats/` + `chat_metadata.bookmark_link` | 消息级 branch 按钮 + 回链条 + 侧栏 ⑂ 标记 |
| persona 导入管理 | format（复用卡解码） | `personas/<name>.json` + `personas/avatars/<name>.png` | 设置页管理带（增删改、导入、头像） |
| 群聊 | format（group IR）+ pipeline（回合变换） | `groups/<name>.json` + `chats/<group>/` | 侧栏群组分区 + composer 成员触发 |
| STscript / regex | `@dsh-tavern/script`（新包） | `state.json` `regexScripts` / chat 变量 | composer `/` 前缀执行 + 设置页 regex 导入 |
| Text Completion | format（context/instruct/sampler 解析）+ pipeline（story_string 装配） | `presets/`（按形态区分）+ `state.json` `textCompletion` | 设置页管线/端点配置 |

## 2. branch / bookmark

- `POST branch` `{character, chatId, messageId, name?, revision}`：复制 header 与
  `messages[0..messageId]` 生成新聊天，`chat_metadata.bookmark_link = {character, chatId, messageId}`。
- 分支命名 `${stem} - branch N.jsonl`（保持 `safeChatFileName` 字符集）。
- 视图顶部回链条可跳回父聊天；侧栏分支行加 ⑂ 前缀。不注入伪消息，保持 JSONL 干净。

## 3. persona

- 形态 `{name, description, position?, depth?, role?, title?}`；position/depth/role 仅消费
  `0=IN_PROMPT` 与 `4=AT_DEPTH`（TOP_AN/BOTTOM_AN 映射到对应深度注入通道）。
- 导入 PNG：解码内嵌 `chara`/`ccv3` 的 description；文件名 stem 作 persona 名；头像原样保存。
- 管理 API：`POST import/persona`、`PUT persona`、`DELETE persona`、`GET persona-avatar/`。

## 4. 群聊

- `groups/<name>.json` 按 ST group 文件形态（`members` 存角色名而非 chid 索引，导入 ST 文件时
  数字成员被忽略并计数上报）。激活策略 `1=NATURAL`（talkativeness 加权，扩展
  `data.extensions.talkativeness`，排除上一发言者除非 allow_self_responses）/ `2=LIST`（列表轮转）。
- 群聊存 `chats/<group>/*.jsonl`，`chat_metadata.group = {members, disabledMembers}`；
  创建时按 V3 `group_only_greetings` 逐成员落问候消息。
- 回合装配：发言者本人的历史映射 assistant，其他成员/用户映射 user 并带 `Name: ` 前缀；
  预设 `group_nudge_prompt` 追加为 user nudge；`{{group}}` 宏为启用成员列表。
- 生成 API `triggerMember` 显式点名；regenerate 复用上一发言者。绑定加 `group: true` 标志。

## 5. STscript / regex

- 新包 `@dsh-tavern/script`：
  - regex：ST `{scriptName, findRegex, replaceString, trimStrings, placement, disabled,
    promptOnly, markdownOnly, runOnEdit, substituteRegex, minDepth, maxDepth}` IR 与执行器。
    placement 位 `USER_INPUT=1 | AI_OUTPUT=2 | SLASH_COMMAND=3 | WORLD_INFO=5 | REASONING=6`。
  - STscript：管道 `|` 分隔、引号参数、宏展开；命令子集
    `echo/comment/setvar/getvar/setglobalvar/getglobalvar/addvar/incvar/decvar/hasvar/delvar/
    if(left/right/op/then/else)/random/roll/pick/send/trigger/regenerate/stop/cut`。
- 存储：全局 regex 在 `state.json`；卡级 `data.extensions.regex_scripts` 生成时合并；
  聊天局部变量在 `chat_metadata.variables`，全局在 `state.json` `scriptGlobals`。
- 应用点：`USER_INPUT` 在落用户消息前；`AI_OUTPUT` 非 promptOnly 在保存前、promptOnly
  在装配历史时按 `minDepth/maxDepth` 逐消息应用；`WORLD_INFO` 在 lore 内容进 prompt 前；
  `REASONING` 在保存 reasoning 前；`markdownOnly` 经 `GET chat` 的平行 `displays[]`
  通道只在展示层生效（不落盘、不进 prompt、不参与 revision CAS 载荷）。
- 执行：`POST script` 服务端解释，`/send`+`/trigger`（trigger 模式：不追加用户消息、
  不弹出旧回复、lore 以 quiet 触发）复用生成内核（非流式，返回最终 chat）；
  composer `/` 前缀进入脚本模式。`automationId` 与 Quick Reply 联动不实现（文档声明）。

## 6. Text Completion / Kobold

- 形态探测：`story_string` → context 模板；`input_prefix`/`output_prefix` → instruct 模板；
  无 `prompts[]` 且含采样键 → textgen 采样器。与 Chat Completion preset 共存于 `presets/`。
- `assembleTextCompletion`：story_string 支持 `{{#if field}}…{{else}}…{{/if}}` 与
  `{{field}}`（description/personality/scenario/persona/wiBefore/wiAfter/system/callInstruct 等），
  历史按 instruct 序列（`input_prefix/output_prefix/system_seq`，`names_behavior` 控制名字注入）
  或裸文本 + `example_separator`；预算裁剪同 Chat Completion。
- Kobold 客户端（Node half，直连外部端点）：优先 SSE
  `POST {endpoint}/api/extra/generate/stream`，404/405 回退 `POST /api/v1/generate` 单发；
  `GET tc/check` 调 `/api/v1/model` 验活。配置存 `state.json` `textCompletion`
  `{endpoint, apiKey?, streaming, contextPreset?, instructPreset?, samplerPreset?}` 与
  `pipelineMode: 'chat' | 'text'`。
- 生成路由按 `pipelineMode` 分叉；两条管线共享 lore/宏/预算与保存语义（swipe、revision、Stop）。

## 7. 验证

- 每个库包新增 spec；`pnpm run check` 全量（tsc + vitest + build + gates）为交付门。
- gates 的 `REQUIRED_SERVER_ROUTES` 扩展到新路由（import/persona、persona、persona-avatar/、
  groups、group/、branch、regex、script、tc/check），保护级别随功能面同步扩张。
