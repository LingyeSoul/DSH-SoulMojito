# 群聊 nudge 装配接线与 STscript /regex 命令（SLASH_COMMAND 应用点）

日期：2026-10-10。状态：已实施。关联：提案 `docs/proposals/0002-branch-persona-groups-script-textcompletion.md`（群聊 nudge 与 regex placement 的原始承诺）、`docs/proposals/0015-mod-extensions.md`（pre-assemble hook 位）。

## Problem

两个「定义了但从未接线」的悬空面，同属提案 0002 交付时留下的缝隙：

1. **群聊 nudge 死变量**：`runGeneration`（`packages/plugin/src/index.ts`）把
   `buildGroupTurn` 算出的 `turn.nudge` 赋给局部变量后全函数无消费点——
   `preset group_nudge_prompt` 配了也永远不进 prompt（单聊路径不受影响）。
   send/regenerate 分支重算 `turnMessages` 时同样不携带 nudge。提案 0002
   §4 承诺的「预设 `group_nudge_prompt` 追加为 user nudge」只落了一半：
   pipeline 侧 `GroupTurnResult.nudge` 有形状有测试，plugin 侧没接。
2. **SLASH_COMMAND placement 零应用点**：`RegexPlacement.SLASH_COMMAND=3`
   在解析层接受（`PLACEMENT_VALUES`）、执行层支持过滤（`hasPlacement`），
   但全仓库没有任何调用方把它传给 `applyRegexScripts`——用户导入带
   placement=3 的 ST 正则脚本后，该位永远不生效，也没有任何入口能手动触发。

## Decision

### nudge：在 pre-assemble 位注入装配输入

- `runGeneration` 在 `assemblePrompt` 调用点（即提案 0015 预留的 **pre-assemble
  hook 位**，装配输入 draft 的最后一站）把 nudge 合成为一条 `is_user: true` 的
  ChatMessage 追加到 `messages` 末尾。`{{char}}` 已在 `buildGroupTurn` 按发言者
  替换，其余宏（`{{user}}` 等）在此经宏引擎展开——对齐 ST `substituteParams`
  语义；不过 EJS（nudge 是预设采样值不是聊天楼层，ST 亦不做模板渲染）。
- **位置与预算对齐 ST 可观察行为**（openai.js `groupNudge` 条目）：
  `insertAtEnd(groupNudgeMessage, 'chatHistory')` —— 历史末尾、post-history
  条目（jailbreak/UJB）之前；token 预算先为 nudge 预留（`reserveBudget`），
  历史按剩余预算裁剪——本实现里 nudge 作为最新楼层进入保新裁剪循环，
  永远先于历史被保留，净效果等价（超预算时丢最旧历史，nudge 恒在）。
- **合成楼层不落盘**：只进 prompt，不 push 进 `chat.messages`、不进 swipes、
  不进会话镜像。
- 角色沿用仓库既有承诺（提案 0002 §4「追加为 user nudge」+
  `tavern-pipeline` group.spec 锁定的 `{role:'user'}`），不改判 ST 的 system
  角色——仓库在 0002 已做此取舍且测试锁定，本次只补接线不重开决策。
- 该注入点选在 assemblePrompt 输入侧而非装配后 push：提案 0015 的
  pre-assemble hook（draft→draft）落地后，mod 在 draft 中可见并可改写这条
  nudge——它是该 hook 的第一个既存受益者。

### /regex：STscript 命令作为 placement=3 的应用点

- 新增 STscript 命令 `/regex`（`packages/tavern-script/src/stscript.ts`）：
  `/regex name=<脚本名> [输入串]`（脚本名也接受首位位置参数；输入串可由
  管道注入）。`ScriptEnv` 新增 `applyRegex(scriptName, text)` 动作面，
  plugin 侧 `POST script` 路由以 `collectRegexScripts`（全局 + 卡级合并集）
  接线。
- **查找语义对齐 ST `runRegexCallback`**：脚本名大小写不敏感；未找到/禁用
  原样返回输入、不抛错不中断脚本（ST 是 toastr 警告后返回原值）；返回替换
  后文本作为命令输出（`chatChanged: false`，ST 亦不改聊天）。
- **与 ST 的刻意差异**：本实现要求脚本 placement 位**含 3** 才生效（经
  `applyRegexScript(text, script, RegexPlacement.SLASH_COMMAND, …)` 过滤）。
  ST 的回调不检查 placement 位（任何启用脚本都可用 /regex 触发），placement=3
  在 ST 只是 UI 勾选框标记。此处收紧的理由：仓库执行器契约本就是
  placement 过滤（`applyRegexScript` 的既有文档语义），且「placement=3 有
  应用点」正是本次要修的缺口——若照抄 ST 的宽松实现，SLASH_COMMAND 位在
  本仓库仍然无任何运行时消费点。收紧后该位成为 /regex 的显式 opt-in，
  与 ST UI 勾选框「Alter Slash Command」的作者意图一致。
- substituteRegex 宏展开沿用执行器（deps.expand 接宏引擎），与 ST
  `runRegexScript` 的 substitute 行为对齐。

## Alternatives considered

- **nudge 装配后 push 到 `assembled.messages`**：实现更省（LlmMessage 形状
  直接可用），但落在 pre-assemble hook 位之后——hook 落地后 mod 永远看不到
  这条 nudge；且绕过 assemblePrompt 的历史预算循环，nudge 不占预算、超长
  历史场景行为与 ST 不一致。否决。
- **`AssembleInput` 加 `nudge` 专用字段**（pipeline API 扩展）：stats 口径更净
  （historyKept 不计 nudge），但需要 pipeline 包 API 变更 + 两处（Chat
  Completion/Text Completion）同步；合成楼层方案的 historyKept +1 属展示层
  小偏差（start 事件 stats），不值得为此扩 API。否决，记为已知偏差。
- **/regex 缺省输入取最后一条 AI 消息并原地改写**：ST 无此行为（输入缺省
  就是空串，取最后消息用 `{{lastMessage}}` 宏显式表达）；改写楼层牵动
  CAS/落盘纪律，收益为零。否决。
- **/regex 照抄 ST 不做 placement 过滤**：见上——会留下「placement=3 定义了
  但无应用点」的原状，与本次修复目标直接冲突。否决。

## Consequences

- 群聊 `group_nudge_prompt`（含默认回落空串=不加 nudge 的语义）真实生效；
  send / regenerate / trigger 三模式共用同一注入点（trigger 复用内核同路）。
- STscript 命令面 +1（`regex`），解释器层与应用层语义各有用例锁定
  （stscript.spec / tavern-stscript-regex.spec / tavern-group-nudge.spec）；
  提案 0002 §5 的命令清单与应用点清单同步补记。
- depth=0 注入（底部作者注、WI atDepth 0）按装配循环位于 nudge 之后——
  ST 的群 nudge `insertAtEnd` 也先于 AN@D0 类深度注入落位，位次一致。
- 已知偏差：nudge 参与历史预算时计入 `historyKept`（+1）；深度注入
  `minDepth/maxDepth` 不适用于 nudge（它不是 AI_OUTPUT，无深度语义）。
- 同类缺口盘点：五个 placement 位现全部有应用点（USER_INPUT/AI_OUTPUT/
  WORLD_INFO/REASONING/SLASH_COMMAND）。仍悬空的近亲是 `runOnEdit` 字段
  （IR 解析/序列化有、无消费点）：ST 语义是「用户编辑消息保存时对**被编辑
  楼层**重放 AI_OUTPUT 脚本」，而本仓库 `PUT chat` 是整包覆盖保存、无
  「哪条被编辑」信号——盲目对整包重放会在每次无关保存上二次应用。落地
  需要编辑协议扩展（editedIndex 类信号），另立决策，不在本次范围。
