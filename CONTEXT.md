# AgentTavern Context

本项目把 DSH 扩展为可切换的角色扮演架构：AgentTavern 复用 DSH 原生 AgentLoop，ST 兼容架构保留为独立的兼容模式。

## 架构语言

**AgentTavern**：运行在 DSH 原生 AgentLoop 上的角色扮演 profile。它规定角色身份、上下文装配、工具权限和记忆策略，但不拥有第二个 LLM 主循环。
_Avoid_: Tavern 模式、Agent 模式、RP loop

**ST 架构**：当前基于 SillyTavern 可观察语义的兼容架构。它由插件自行装配 prompt 并调用 LLM，保留 JSONL、swipe、preset 和 STscript 行为。
_Avoid_: 旧架构、普通 Tavern

**AgentLoop**：DSH 负责 turn、step、模型请求、工具调用和事件记录的原生执行循环。AgentTavern 只能通过 profile、上下文和工具扩展它。
_Avoid_: Tavern loop、生成循环

**Agent preset**：DSH `dsh-agent-preset` / `dsh-agent-preset-registry`（DSH `0.2.0-rc.2` 起 `dsh-agent-presets` 拆分而来，`agentPresets` 服务面不变）提供的可持久组合。preset 在 agent 发布前挂载 scoped 工具、prompt、变量和其他 projection 插件，并以可重建的 preset id 绑定会话。
_Avoid_: 在 DSH-SoulMojito 内另造一套 profile registry

## 状态语言

**上下文**：某一次 AgentLoop 模型请求实际看到的消息、工具结果和最小运行时指令。上下文是临时投影，不是完整历史。
_Avoid_: 聊天记录、记忆

**聊天记录**：按时间顺序保存的用户和角色对话事件，作为可重放的事实来源。它可以被压缩、检索或暂时排除出上下文，但不因遗忘而删除。
_Avoid_: 上下文、记忆库

**记忆**：从聊天记录或工具写入的、可检索的长期事实或事件摘要。记忆必须有来源、作用域和版本，不能把一次模型猜测当成事实。
_Avoid_: 历史、变量

**变量**：Agent 通过工具读写的结构化、可寻址状态。变量适合计数、标志、关系状态和精确值；自然语言事实应写入记忆。
_Avoid_: 记忆变量、脚本变量（在 AgentTavern 语境中）

**遗忘**：上下文装配时暂时不携带低相关内容，保留其在聊天记录或记忆存储中的可检索性。遗忘不是删除，也不是让模型永久失去数据。
_Avoid_: 清空历史、删除记忆

**上下文模式**：AgentTavern 会话决定如何从聊天记录形成某次模型请求的上下文。它只描述历史投影策略，不是记忆、变量或资产工具的启用开关。
_Avoid_: 记忆模式、生成模式

**DSH 原生上下文模式**：AgentTavern 不主动排除聊天历史，由 DSH 和实际模型的上下文容量决定请求可见范围。记忆、变量和资产工具仍然可用。
_Avoid_: 无记忆模式、完整记忆模式

**Agent 管理上下文模式**：AgentTavern 主动选择当前请求携带的聊天历史，被排除内容仍保留为可检索事实。它改变历史投影，不改变记忆、变量和资产工具是否可用。
_Avoid_: 遗忘开关、压缩模式

**作用域**：数据可被哪些 AgentLoop 会话访问的命名空间。标准作用域为 `turn`、`chat`、`character`、`agent` 和 `global`；写入权限按作用域单独控制。
_Avoid_: 全局变量（未说明作用域时）

## 资产语言

**静态资产**：角色卡、世界书、persona、preset 等由用户配置、默认只读的 Tavern 资产。AgentTavern 通过工具按需读取，而不是把全部资产固定注入每一轮。
_Avoid_: 默认提示词

**会话世界书副本**：某个聊天作用域的世界书覆盖层（`chats/<角色>/<聊天>.jsonl.worlds.json`）。卡脚本的写入只落在副本，基础世界书资产与卡内嵌书保持只读；当前聊天的激活、生成与 MVU 读取优先使用副本，副本随聊天生命周期（重命名跟随、分支/分叉复制、删除清理）。
_Avoid_: 世界书备份、全局覆盖层

**会话脚本树副本**：某个聊天作用域的卡脚本树覆盖层（`chats/<角色>/<聊天>.jsonl.scripts.json`）。GM 面板通过 `updateScriptTreesWith` 改写的脚本源码只落在副本，角色卡文件与卡内 `tavern_helper.scripts` 保持只读；会话内 `getScriptTrees` 从副本起步，刷新/重开卡脚本 tab 仍可读。副本只保存源码，不执行 Zod schema，也随聊天生命周期（重命名跟随、分支/分叉复制、删除清理）。
_Avoid_: 脚本备份、全局脚本覆盖

**上下文提供者**：AgentLoop profile 在每次模型请求前，根据会话、预算和检索结果生成上下文投影的模块。当前 DSH 的 `systemPrompt.context()` 负责动态 runtime snapshot；任意历史节点的临时选择需要宿主提供 `agent/context` seam。
_Avoid_: prompt 拼接器

## 文档纪律

**提案**（`docs/proposals/NNNN-*.md`）：架构级新特性的设计契约，编号递增，实现后在 `docs/README.md` 的提案表登记（根 `README.md` 只保留产品面入口）。
**决策**（`decisions/YYYY-MM-DD-*.md`）：单次落地决策的记录——问题、方案、否决项、与规格的偏差。
**探索**（`docs/exploration/YYYY-MM-DD-*.md`）：调研归档，结论必须带证据坐标（文件:行号）。

**开工前检查表**（新特性动工前逐项回答，写进提案或决策文档；源自 LittleWhiteBox 的工程纪律，
「删除路径」一栏最容易救命）：

1. 所有者（哪个模块/哪条链路对它负责）
2. 唯一事实来源（数据以哪份文件/哪个 store 为准）
3. 持久态及理由（什么必须落盘、为什么）
4. 临时态（什么只在内存/进程内，重启即失，是否可接受）
5. 外部依赖（宿主 seam、网络端点、env）
6. 注册入口（挂接点：路由/事件/hook/面板分区）
7. **删除路径**（如何干净移除：反注册、数据文件、迁移/回滚）
8. 兼容对象（旧数据、旧宿主版本、既有行为的 golden 保证）
