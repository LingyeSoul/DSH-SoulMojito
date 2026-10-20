# AgentTavern 原生会话的正则显示与新建开场白选择

> 日期：2026-10-20。状态：已实施。相关：`packages/plugin/src/agent-tavern/projector.ts`（落库层正则）、`packages/plugin/src/prompt-context.ts`（`displayTexts`）、`packages/plugin/src/http/router.ts`（`GET display` / `POST chats`）、`packages/plugin/client-src/89-ui-assistant.js`、`87-ui-sidebar.js`、`61-session-binding.js`。

## 问题

1. **AgentTavern 下正则只落在 JSONL，原生会话仍显示模型原文。** `projectMessage` 把 `AI_OUTPUT` 落库层脚本应用到 Tavern 聊天文件，但宿主原生 conversation 渲染的是 durable `assistant/message`，插件没有正文 slot；用户看到 `[游玩指南]` 这类已被脚本处理掉或应被处理的标记仍然可见。
2. **备用开场白无法选用。** ST 架构靠首楼 swipe 切换 `first_mes` / `alternate_greetings`；AgentTavern 在激活时把 JSONL 首楼导入宿主会话，原生 surface 没有 swipe UI，之后无法再选。

## 决议

### 1. 展示层按 messageId 查询（不搬整份聊天）

- projector 已把每条落库消息的来源写进 `extra.agentTavern.messageId`（宿主 `assistant/message.message.id`）。
- 新增 `GET /api/dsh-soulmojito/display?character=&chatId=&messageId=`：
  - 在聊天文件中按 `extra.agentTavern.messageId` 定位楼层；
  - 返回该楼层 `mes`（已含落库层正则）再叠加 `markdownOnly` 脚本后的展示文本；
  - 找不到（如 tool-call 中间步骤尚未投影）返回 `{ ok: true, text: null }`，不报错。
- 客户端只在 **当前会话是 AgentTavern** 时注册 `conversation.chat.node` 的 `assistant-step` 覆盖（`priority: -1`，低于宿主默认的 0 才赢下 keyed cell）。覆盖组件复用宿主 `AssistantNodeView`，只替换 `node.data.blocks` 中的文本块；其余推理块、图片、turn 处理链保持宿主行为。
- 宿主 `AssistantNodeView` 的 `renderSlot` 子槽（reasoning body / message images）由插件提供等价渲染，避免重复声明宿主已声明的 children slot（slot core 对重复声明直接抛错）。
- 注册随当前绑定切换：非 AgentTavern 会话立刻 dispose，普通 DSH 会话完全走宿主默认渲染器。
- 文本查询失败或尚未投影时保留模型原文；投影完成后重试（最多 4 次，短退避）。

### 2. 新建聊天时选择开场白

- `POST chats` 接受可选 `greetingIndex`（整数，默认 0，越界明确报错）；聊天首楼写入 `mes = greetings[index]`、`swipe_id = index`，`swipes` 仍保留完整数组，ST 架构后续 swipe 行为不变。
- 客户端角色「+」新建聊天时先读卡；存在多个非空开场白则弹选择框（默认开场白 + 各备用开场白，点击即创建），否则直接创建。过滤空开场白时保留原数组下标，保证服务端索引一致。
- AgentTavern 激活导入选中的首楼，模型上下文与原生首楼看到的是同一个开场白。

## 否决项

- **客户端重新执行一遍正则脚本**：需要复制执行器、placement/depth/markdownOnly/promptOnly 语义和卡级合并；与服务端 `displayTexts` 漂移风险高。查询投影结果更直接。
- **`GET chat` 搬整份聊天给原生会话**：长篇聊天每次生成都传 MB 级 JSON，且触发无关 store 更新。按 messageId 单楼层查询是必要开销。
- **替换宿主原生 conversation 正文**：宿主 surface 是只读渲染面；DOM 注入或整体替换会与宿主渲染循环竞争。只覆盖 assistant-step 的文本块，且限定 AgentTavern 会话。
- **把落库层正则直接写进宿主 durable 消息**：宿主会话日志是事实源，插件不能改写已提交的 `assistant/message`；展示层查询保持日志原样。
- **激活后再选开场白**：已经导入的原生首楼无法替换而不重建会话；选择放在创建时，边界清晰。

## 边界

- 只处理 AgentTavern 单角色会话；群聊仍是 ST。
- tool-call 中间步骤不会被 projector 落成聊天楼层，`display` 返回 `null`，这些步骤按宿主原文显示；最终正文楼层会显示脚本结果。
- 历史导入楼层没有 `extra.agentTavern.messageId`（导入是宿主事件，不反向投影），当前保持原文；新建聊天选中的开场白通过 `greetingIndex` 生效，显示层查询不覆盖该导入首楼。
- `markdownOnly` 与落库层脚本的优先级沿用 `displayTexts`：先落库层，再展示层；`promptOnly` 不进展示。

## 测试

- `agent-tavern-display-route.spec.ts`：messageId 命中、markdownOnly 叠加、未知 messageId 返回 `text: null`、聊天不存在 404、缺参 500；`POST chats` 的 `greetingIndex` 选中 / 默认 / 越界。
- `agent-tavern-display-client.spec.ts`：客户端只注册 assistant-step、仅 AgentTavern 会话注册、按 messageId 查询、开场白选择链路与 zh/en 文案。
- `prompt-context.ts` 的 `displayTextForMessage` 由上述路由用例覆盖；`displayTexts` 行为保持既有 ST transcript 契约。
