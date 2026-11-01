# 决策：标准 DSH Agent 会话接入激活预设投影（行为开关）

> 日期：2026-11-01。状态：已实施。相关：`decisions/2026-10-09-workbench-novel-preset-projection.md`（兄弟通道）、`decisions/2026-10-09-agent-preset-cache-stability.md`（前缀缓存纪律）、`decisions/2026-10-21-behavior-settings-section.md`（开关归置点）、`packages/plugin/src/native-preset.ts`。

## 背景与需求

用户需求：「添加新的行为设置：在标准 DSH Agent 会话中使用当前预设」。激活预设（ST 聊天补全预设）此前只在三条通道生效：AgentTavern（无条件投影）、写卡工作台与 AgentNovel（各自开关）。**标准 DSH Agent 会话**——没有任何 Tavern 绑定的普通 DSH 会话——完全不吃预设。

面板「行为设置 · 会话行为」组里已有兄弟开关 `nativeAgentPersona`（“在标准 DSH Agent 会话中使用当前角色”），本开关与它成对：一个带当前角色，一个带当前预设。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/native-preset.ts`（新模块：门控装载 + section）、`src/index.ts`（注册 section 与重启预热）、`src/lazy-projection.ts`（新增 `refreshAll`）、`src/http/router.ts`（state patch 键 + 写穿）、`tavern-store`（`nativeAgentPreset` 状态键）、`client-src/83-ui-prompts.js` + 40/41 i18n（行为设置开关） |
| 唯一事实来源 | `state.json` 的 `nativeAgentPreset`（开关）与 `activePreset`（选择）；预设内容本身仍以预设文件为唯一事实来源 |
| 持久态 | `nativeAgentPreset` 布尔键随 `state.json` 持久化，缺省 = 关闭。可选键，与 `nativeAgentPersona` 同款：不进 `DEFAULT_STATE`、`...rest` 透传，读取侧一律 `=== true` |
| 临时态 | 每 agent 的投影缓存（`lazy-projection`）、模块级冻结记录（装载时刻时钟 + RNG 种子）与一次写穿共用的渲染记忆只在进程内，重启由预热重建 |
| 外部依赖 | 既有跨 bundle 注册表 `onAgentPresetChanged`、宿主 `systemPrompt.section`、`ctx.agents.list()`（预热面，缺失时退回纯懒装载） |
| 注册入口 | index bundle 的 `ctx.systemPrompt.section`：`dsh-soulmojito:native-preset`，order `-75`（与其它预设投影同位）；面板「行为设置 → 会话行为」开关（原生设置页同 band） |
| 删除路径 | 摘掉 `src/index.ts` 的两处调用（section 注册 + 预热）即回旧形态；状态键留着无害（无人读取）；`native-preset.spec.ts` 会翻红提醒 |
| 兼容对象 | 绑定会话零变化：AgentTavern / 写卡工作台 / 小说各自通道一行未动；旧 `state.json` 缺字段即关闭；ST 架构不涉及 |

## 落法

- **门控在装载里，不在 section 注册里**：index bundle 是 profile 级挂载，它注册的 section 对**所有**会话的装配可见，因此只有「`nativeAgentPreset === true` **且** `state.sessionBindings[agentId]` 不存在」的 agent 才拿到文本。绑定会话各有专属预设通道，重复投影会把同一份预设栈叠两遍。
- **写穿走 `refreshAll`**：`lazy-projection` 的 `refreshWhere` 遍历 `sessionBindings`，标准会话不在其中——新增 `refreshAll()` 重载**已装载过**的全部 agent。开关翻转、激活预设切换、预设增删改都经同一个 `emitAgentPresetChanged` 落地（`state` 路由把 `nativeAgentPreset` 并入 emit 条件）。
- **一次写穿只读一次盘**：`refreshAll()` / `preheatAll()` 先读一份 state 快照，交给每个装载；装载体再按输入组合共享一份渲染记忆（`renderMemo`，写穿时推进代数失效）——投影内容与 agent 无关，只有绑定门控逐 agent 判定。
- **门控失败写空串**（区别于 AgentTavern 通道的留旧值）：关掉开关、或会话后来被绑成 Tavern 会话时，section 必须立即消失。
- **不投影 `temperature`**：与工作台/小说同一条理由——标准会话要工具调用精度，预设调温是 RP 会话的诉求，仍由 AgentTavern 通道承载（宿主 model seat 不暴露温度，所以这是本开关的已知边界，不是遗漏）。
- **不做卡覆盖**：标准会话没有卡；`main` / `jailbreak` 的卡覆盖属于「扮演这张卡」的会话。
- **无激活预设即空投影**：不回落内置默认 RP 预设（同工作台/小说；内置默认是「无预设也要有个 RP 主提示」的 AgentTavern 语义）。
- **宏展开**：`{{char}}` 取当前角色名（与 `nativeAgentPersona` 同一「当前配置」语义），未选角色回落占位语义 `the character`（避免 `Write 's next reply` 一类残句）；`{{user}}` 取激活 persona，缺省 `User`。产物过 `hostPromptSafe`（宿主 `interpolate` 会把残留 `{{...}}` 当变量渲染并炸装配）。
- **前缀缓存**：预设块住在宿主受保护 system 头，动态宏按模块级冻结记录求值（装载时刻时钟 + 种子 RNG），写穿重载对相同输入字节稳定；`apply()` 期用活着的 agent 列表预热（`preheatAll`），消除重启后首轮空串 → 整块出现。

## 开关响应（同轮修复）

首版把「每个已装载 agent 各读一次 state、各渲染一次预设」写进了写穿路径。`TavernStore.getState()` 每次都读盘解析 `state.json`，而已装载 agent 集合会随会话与 spawn 子代理累积——面板一按开关就要按 agent 数重复读盘 + 解析 + 宏展开，用户反馈「开关不跟手，要卡一会」。实测（80 个已装载 agent、120 条提示词的模拟预设）：修复前 `170ms`（开）/`25ms`（关），修复后 `15ms` / `5ms`。修法就是上面的「一次写穿只读一次盘 + 渲染记忆」，并把启动预热改成 `preheatAll`（同样只读一次 state）。


## 已知边界

- 插件无法从装配上下文读到 DSH agent preset 的 id，只能用「有无 Tavern 绑定」判定标准会话；宿主内的 spawn 子代理（`agent-reasoning` 等）同样没有绑定，开关打开时也会拿到预设栈。该开关默认关闭，且这是 index bundle 现有全局 section 面的同一粒度（`nativeAgentPersona` 同款）。
- 只投影提示词栈，不投影采样参数（见上）。用户若要预设调温，用 AgentTavern 会话。

## 验证

- 新增 `packages/plugin/tests/native-preset.spec.ts`：section 名与 order；默认关空投影；开关打开后未绑定会话拿到块（跟随式首行、启用过滤、宏展开、无 `{{` 残留）；绑定会话（AgentTavern / 写卡工作台）恒空；跨秒边界同内容重写的字节稳定性（冻结时钟 + 种子）；无激活预设不回落内置默认；关断写穿清空。
- `packages/plugin/tests/behavior-settings-client.spec.ts`：新增 `applyPatch({ nativeAgentPreset: event.target.checked })` marker。
- 新增 `packages/plugin/tests/lazy-projection.spec.ts`：`refreshAll` / `preheatAll` 对 N 个 agent 只读一次 state（并确认快照传给每个装载；预热后的 agent 走缓存不再装载）。
- `tavern-store/tests/store.spec.ts` 默认状态不变（可选键，同 `nativeAgentPersona`）。
- 全量 `vitest run`（188 文件）与 `packages/plugin/scripts/gates/run.mjs` 通过；`build:plugin` 重建五个宿主 bundle + client。

## 影响面

- 开关打开后，标准 DSH Agent 会话每轮 system prompt 多一段预设内容（token 成本随用户配置，与其它预设通道同款不做硬性截断）。
- 绑定会话、ST 架构、IM 通道零变化。
- `lazy-projection.ts` 新增 `refreshAll()`，对既有四个消费者（facts / guides / 剧本摘要 / 预设）是纯增量面。
