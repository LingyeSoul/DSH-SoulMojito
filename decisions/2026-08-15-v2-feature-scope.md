# 决策：v2 功能面的范围与形态选择

日期：2026-08-15。状态：已接受。上下文见 `docs/proposals/0002-branch-persona-groups-script-textcompletion.md`。

## 1. 群组 members 用角色名而非 chid 索引

ST 的 `groups/<name>.json` `members` 存运行时角色索引，导出后不可移植。dsh-tavern
store 以名字寻址，因此导入 ST 群文件时数字成员被跳过并计数（`droppedMembers`），
不视为失败。群聊文件落在 `chats/<group>/`，绑定条目加 `group: true` 标志，复用
既有 revision/prune/归档链路，不为群聊另建存储面。

## 2. 生成内核单点分叉

`runGeneration` 是唯一生成路径（send/regenerate/trigger 三模式）。群聊分叉 =
发言者选择 + 历史重塑（他人转 user 带 `Name:` 前缀）+ group nudge + 成员卡字段；
文本补全分叉 = story_string 装配 + Kobold 直连。STscript 的 `/trigger`、
`/regenerate` 复用该内核（非流式 collect），避免第二套保存语义。

## 3. STscript 实现命令子集，不做 Quick Reply 联动

解释器进新包 `@dsh-tavern/script`（与 regex 执行器同包），支持管道、变量、条件、
随机与聊天动作。`automationId` 与 Quick Reply 的联动、闭包、定时器不实现——
它们依赖 ST 的前端生命周期，在 DSH 表面没有对应物。composer `/` 前缀是唯一入口。

## 4. Text Completion 直连 Kobold，不走 ctx.llm

DSH 的 provider 注册面向 hosted API；KoboldAI/KoboldCpp 是用户本地端点，语义
（SSE `/api/extra/generate/stream` + 单发 `/api/v1/generate` 回退）与密钥形态
（无或 Bearer）都不同。插件 Node half 用全局 fetch 直连，配置存
`state.json` `textCompletion`，`GET tc/check` 验活。这保持 DSH 不感知 Kobold。

## 5. branch 用元数据回链，不注入伪消息

ST bookmark 在新聊天插入链接消息；我们写 `chat_metadata.bookmark_link` 并在视图
渲染回链条，JSONL 保持干净。分支命名 `${stem} - branch N.jsonl` 以满足
`safeChatFileName` 的 ASCII 白名单（与现有 rename 行为一致）。

## 6. gates 保护面随路由扩张

`REQUIRED_SERVER_ROUTES` 增加全部新路由，防止后续改动静默删除 persona/群组/
branch/regex/script/Kobold 入口。
