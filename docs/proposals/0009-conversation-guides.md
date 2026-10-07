# 提案 0009：Conversation Guides（持续指引）— dsh-tavern 功能复刻

> 状态：已实现。日期：2026-10-07。参照物：`flizzywine/dsh-tavern`（AGPL-3.0）的**公开功能文档**
> （README「Guide：给这一局注入上下文指引」、`docs/feature-inventory.md` B09），按本仓库 clean-room
> 教义从行为规格重实现，不复制其源码，也不引入新依赖。实施期间禁止阅读该仓库源码。

## 1. 范围

玩家把持续生效的写作/节奏/剧情要求（如「多写心理活动，对白不超过三句」「好感度涨得慢一点」）
写成一条 Guide；之后本局每次生成（正文、候选、重写）都参考，不用每轮重复输入。可添加、查看、删除。

| 能力 | 去向 |
|---|---|
| Guide 存储（添加/列出/删除，随聊天持久化） | `chat.header.chat_metadata.guides: Array<{id, text, createdAt}>` |
| ST 链路注入（正文生成时持续生效） | `runGeneration` 装配后 system 段追加 guides 块 |
| AgentTavern 注入（原生 AgentLoop 侧持续生效） | `agent.ts` 新增 `dsh-tavern:agent-guides` systemPrompt context 段（facts 同款异步装载 + 写穿缓存） |
| 管理 API | `GET/POST guides/:character/:chatId`、`DELETE guides/:character/:chatId/:id`（沿用现有路由段风格） |
| 面板入口 | 右侧 Guide 面板：列出 / 添加 / 删除（提案 0010/0011 的 UI 一并接线） |

**明确裁剪**（不做，理由）：
- flizzywine 的 Guide 还参与后台变量结算请求——本仓库结算链路（提案 0012）落地后再接。
- Guide 分组 / 临时开关 / 优先级：公开文档未描述该语义，v1 只做扁平列表。
- 跨聊天复用：Guide 属于单局（flizzywine 语义「给这一局注入」），全局偏好归画像类提案。

**已文档化的适配偏差**：
1. 上限 8 条、单条 ≤500 字符（flizzywine 未公开限制；防注入面失控的本地决策）。
2. AgentTavern 侧装载是 best-effort 异步（对齐 `dsh-tavern:agent-facts` 的 facts 模式）：首次装配
   可能拿到空串，写穿缓存在 guide 写入时即时更新，无需等待重载。
3. ST 链路注入位置是 system 段末尾（所有已装配 system 块之后），而非深度消息注入——Guide 是
   会话级持续要求，不是楼层内容。

## 2. 包结构

```
packages/plugin/src/guides.ts            纯逻辑：guide 列表的增删改校验、格式化为注入块
packages/plugin/src/index.ts             guides 路由 + runGeneration systemParts 注入
packages/plugin/src/agent-tavern/agent.ts  agent-guides context 段（写穿缓存）
packages/plugin/tests/tavern-guides.spec.ts  存储往返 / 注入格式 / 上限校验单测
```

## 3. 接线

1. **ST 链路**（`runGeneration`）：装配完成、`while (requestMessages[0]?.role === 'system')`
   收集 systemParts 之后，若有激活 guides 则 `systemParts.push(formatGuidesBlock(guides))`，
   再进入 `ctx.llm.stream`。块格式：首行 `Conversation guides (persistent user directives; apply to every reply):`
   + 每条一行 `- text`（按创建时间升序，新指南在后）。
2. **AgentTavern**（`agent.ts` `apply()`）：`ctx.systemPrompt?.context?.({ name: 'dsh-tavern:agent-guides',
   order: -65, text: (assembly) => agentGuidesText(assembly?.agent?.id) })`；`agentGuidesText` 通过
   binding（`sessionBindings[agentId]` → character/chatId）读 guides，写穿缓存由 guides.ts 的写入路径
   失效/更新，读取失败静默返回空串（不阻塞装配）。
3. **API**：三条路由进 `handleApi`，读写都走 `db.getChatSnapshot` + `db.saveChat`（revision CAS 与
   现有聊天写路径一致）；POST 校验 text 非空、≤500 字符、当前 ≤8 条，id 用 `crypto.randomUUID()`。

## 4. 语义对照要点

- Guide 是**用户指令**（untrusted-but-user-authored），注入块自带「user directives」标注，不伪装成
  世界书或角色设定；正文中不出现 Guide 字样（维持「维护不可见」的既有 kernel 约束）。
- 删除即时生效：下一次生成（ST 或 AgentTavern）不再携带。
- 导出纯对话 TXT 不包含 guides（它是请求侧注入，不是楼层内容）。
