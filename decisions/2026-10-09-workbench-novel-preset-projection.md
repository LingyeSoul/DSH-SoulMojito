# 决策：写卡工作台 / AgentNovel 接入激活预设投影（带启用开关）

> 日期：2026-10-09。状态：已实施。相关：`decisions/2026-10-09-agent-tavern-preset-projection.md`（前作，AgentTavern 侧投影与选集/启用语义）、提案 0013（卡片工作台）、0005（AgentNovel）、`packages/plugin/src/preset-mount.ts`。

## 背景与需求

AgentTavern 的激活预设投影（提示词块 + temperature）上线并两轮修复后，预设只在 RP 会话生效。用户提出两条延伸需求：

1. **写卡工作台**：提供预设启用开关——工作台会话按需带上激活预设；
2. **AgentNovel**：同样接入预设。

工作台与小说是编辑/写作型 Agent：社区 RP 预设的越狱与风格条目**无条件**注入会劫持编辑内核与作者内核（"You never roleplay" 一类边界会被预设栈冲撞）。因此两者的接入都以**显式开关**门控（默认关闭），而不是复制 AgentTavern 的无条件投影。

## 决议

| 维度 | 处理 |
|---|---|
| 开关 | `TavernState.cardWorkbenchPresetEnabled` / `agentNovelPresetEnabled`（默认 false，`=== true` 归一化）。面板「预设」分区新增「预设生效范围」带两个开关；state 路由收布尔值，翻转经既有 `emitAgentPresetChanged` 写穿（与 activePreset/persona 同一批） |
| 共享实现 | 新模块 `preset-mount.ts` 的 `mountPresetProjection()`：懒装载 + 票号 last-write-wins + 跨 bundle（Symbol.for 注册表）写穿 + 绑定过滤，消费方（card-workbench/agent.ts、agent-novel/agent.ts）在模块顶层各实例化一次，`apply()` 注册 section（order -75，kernel 之后） |
| 渲染体 | 复用 `agent-tavern/preset.ts`（选集 100001→100000→首组、启用语义、marker 跳过、宏展开 + `{{...}}` 中性化）；`renderAgentPresetBlock` 增加可选 header 参数（AgentTavern 默认不变） |
| 语义框架 | 工作台用**引用式**首行（供起草卡面/预设文本对齐风格、排错时还原对局提示词环境；不覆盖工作台内核）；小说沿用 AgentTavern 的**跟随式**块头（`AGENT_PRESET_BLOCK_HEADER`，预设栈作为写作风格生效） |
| {{char}} 展开 | 工作台取来源聊天角色（排错对局），回落本会话最近产出卡（起草其卡面）；小说不绑卡。两者取不到时回落占位语义 `'the character'`——RP 预设高频有 "Write {{char}}'s next reply"，展开成空串会产出 "Write 's next reply" 残句 |
| {{user}} 展开 | 与 AgentTavern 一致：激活 persona，缺省 `'User'` |
| temperature | **不投影**。工作台要工具调用精度、小说有自己的会话模型选择（面板 modelSelections），预设调温是 RP 会话的诉求；AgentTavern 路径保持不变 |
| 卡覆盖 | **不投影**。main/jailbreak ← 卡字段的覆盖语义属于"扮演这张卡"的 RP 会话；工作台编辑卡、小说不绑卡 |
| 内置默认预设回落 | **不回落**。AgentTavern 的回落是"无激活预设也要有 RP 主提示"的语义；对编辑/写作 Agent 是噪音——未选择激活预设或激活预设文件缺失即空投影 |

## 变化与代价

- 两个新状态键随 state.json 持久化（旧文件缺字段补默认 false）。
- 开关开启后，对应会话每轮 system prompt 多一段预设内容（token 成本随用户配置，同 AgentTavern 不做硬性截断）。
- AgentTavern 投影路径（agent-tavern/agent.ts）一行未动：该路径本周刚经历两轮线上修复，共享工厂只服务两个新消费方；语义差异（temperature、卡覆盖、默认回落）参数化进同一工厂会稀释已验证实现，故保留两份装载闭包、渲染体与写穿注册表仍共享。

## 验证

- `packages/plugin/tests/preset-mount.spec.ts`（新增）：自定义 header 渲染、默认关空投影、开关开启后宏展开（{{char}}={{来源角色/产出卡/the character}}、{{user}}=persona、无 `{{` 残留）、引用式 vs 跟随式首行、绑定架构过滤（AgentTavern 绑定不吃工作台投影）、无激活预设不回落内置默认、开关关闭写穿清空。
- `packages/plugin/tests/agent-tavern-preset.spec.ts`：AgentTavern 投影回归全绿（默认 header 不受 header 参数影响）。
- `packages/tavern-store/tests/store.spec.ts`：默认状态补两个新键。
- `packages/plugin/tests/agent-novel-tools.spec.ts`：novel section 注册数 1→2（kernel -80 + novel-preset -75）。
- 全量 vitest 834 通过；`build-plugin` 五个 bundle + client 重建；plugin gates 14 项 PASS。
