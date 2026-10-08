# 决策：AgentTavern 预设投影（提示词块 + temperature）

> 日期：2026-10-09（含同日二次修复）。状态：已实施。相关：提案 0004（AgentTavern 架构）、0009（guides 注入范式）、0014，`src/agent-tavern/preset.ts`、`packages/tavern-pipeline`。

## 背景与根因

AgentTavern 复用宿主 AgentLoop，ST 生成路径仍持有插件自己的 prompt 装配与 LLM 调用；但在修复前，激活预设没有任何进入 AgentLoop 的通道：

- `packages/tavern-pipeline` 的 `assemblePrompt` 只被 ST 的 `runGeneration` 调用，AgentTavern 侧只有 `agent.ts` 注册的 kernel / facts / guides / script 四段；
- 预设的 `prompts[]` / `prompt_order[]` / 采样参数在 AgentTavern 会话里完全不参与装配。

用户视角即「AgentTavern 模式下预设完全不生效」：换了预设、改了提示词、调了温度，对原生会话没有任何影响。

## 现场复核与更正（同日二次修复）

首版投影上线后实测仍「预设不生效」。用真实会话日志与 ST 上游源码复核，定位到两处**解析层**缺陷（两者叠加导致长栈预设整体丢失），已一并修正：

1. **prompt_order 选集错误**。首版与 `tavern-pipeline` 都优先 `character_id === 100000`。核对 ST 上游 `public/scripts/openai.js`：ChatCompletion 传入的是
   `promptOrder: { strategy: 'global', dummyId: 100001 }` —— 单聊（global）实际读取的是 **100001** 组；100000 是 `PromptManager` 的内部默认常量/其他残留。社区长栈预设的单聊全量提示词堆栈都带在 100001 组（甚至只带该组），旧选集取到的只是 11 条"薄集"，实测注入块里只剩 `main`。
   修正：两边统一为「100001 → 100000 → 首组」的回落链（`GLOBAL_ORDER_DUMMY_ID` / `LEGACY_ORDER_DUMMY_ID`）。
2. **启用语义过严**。首版把 `prompt.system_prompt === false` 当作禁用信号（并让 `prompt.enabled` 覆盖顺序表）。核对 ST `PromptManager.getPromptCollection`：`allowedTrigger = entry.enabled && shouldTrigger(...)` —— **`prompt_order[].enabled` 是唯一权威**；`system_prompt` 只是「全局提示词 / 预设提示词」的分类标记。社区预设普遍把写作风格、思考链与格式约束类条目标成 `system_prompt: false` 且启用，首版规则把它们整组过滤。
   修正：启用语义 = 顺序表布尔值权威，缺失才回落 `prompt.enabled !== false`；`tavern-pipeline` 同时补上此前缺失的 `enabled` 过滤（其文件头注释本来就声明"enabled 条目按序装配"，实现与文档对齐）。

复核证据链：真实部署的 DSH 会话日志（`system/message` 渲染文本 + 事件时序）、用户实际导入的预设文件、ST `openai.js`/`PromptManager.js` 上游源码（见 `docs/exploration/2026-08-14-st-formats.md` 勘误）。

## 决议：各成分的映射

| 预设成分 | AgentTavern 处理 |
|---|---|
| 内容型提示词（`main`、自定义、`jailbreak`） | 注入 agent 作用域 systemPrompt section `dsh-tavern:agent-preset`（order -75：kernel 之后、facts 之前），按 `prompt_order`（优先 global dummy 100001，回落 100000/首组）顺序拼接 |
| 卡覆盖语义 | 与 ST 管线一致：`main` ← 卡 `system_prompt`、`jailbreak` ← 卡 `post_history_instructions`；空串回落预设内容，`{{original}}` 引用预设原文 |
| marker（charDescription / charPersonality / scenario / personaDescription / dialogueExamples / worldInfoBefore/After / chatHistory） | 不进固定 prompt：由会话级工具、原生历史与可选预载承接（提案 0004 §5 的既有边界） |
| `temperature` | `agent/request` waterfall 覆盖（宿主 model seat 不暴露温度，预设是用户唯一的调温入口） |
| `openai_max_context` / `openai_max_tokens` | 宿主所有：请求容量由实际 provider/model route 与 DSH pressure policy 决定（提案 0004 §8）；在工具循环里按 ST「响应长度」硬切输出上限会截断 tool-call，得不偿失 |
| 角色为 `user`/`assistant` 的内容提示词 | 折叠进同一 system 块（AgentLoop 没有逐条消息注入的 seam；保留内容，不保留角色通道） |
| `{{setvar::}}` / `{{getvar::}}` / `{{trim}}` / `{{//}}` | 随文本过宏引擎结算：setvar/注释/trim 产出空串、getvar 取回变量值；定义先于消费（与 ST 逐条 substituted 的顺序一致） |

**启用语义**：`prompt_order[].enabled` 为权威（缺布尔值时回落 `prompt.enabled !== false`）；`main` 占位语义在无相对插入需求的通道上等价于跳过。无 `prompt_order` 时与 ST 一致——不注入任何提示词。

**回落**：未选择激活预设时与 ST 生成路径共用内置默认预设（面板显示为「内置角色扮演预设」，`temperature: 1`）。

## 装载、写穿与首轮正确性

- 与 facts/guides 同款 best-effort 异步装载：首次为某 agent 装配时异步读一次，装载完成前返回空串；写穿刷新用票号 last-write-wins，防在途过期装载覆盖新写入。
- 文本进宿主前过 `prompt-safety.ts`：ST 宏展开 + 残留 `{{...}}` 中性化（预设是 ST 宏的高频来源，原文进 section 会让宿主 interpolate 抛错中止装配）。
- **失效信号跨 bundle 共享**：emit 在 `index.mjs`（state/preset CRUD 路由）与 `card-workbench.mjs`（`preset_put`），监听在 `agent.mjs`。分离 bundle 各持一份模块级 Set 会互不可见，注册表用 `Symbol.for('dsh-tavern:agent-preset-changed-listeners')` 锚定在 `globalThis`（同学科于 agent-novel/usage.ts）。同修 `guides.ts` 的写穿注册表——它跨 bundle 静默失效过（emit 侧与监听侧同款分裂）。
- **激活预热**：激活命令在 `bindSession` 之后 emit 一次，首轮装配就带预设；否则首轮请求在异步装载完成前拿到空串，用户看到的现象仍是「不生效」。

## 变化与代价

- AgentTavern 会话的 system prompt 每轮多一段预设内容（token 成本随用户配置，与 ST 一致地不做硬性截断）。
- `temperature` 开始跟随激活预设（含内置默认预设的 1）——宿主 model seat 的 provider/model/Effort 选择不受影响。
- ST 管线的装配结果随之修正（选集与启用过滤对齐 ST）；群聊与写卡工作台行为不变。

## 边界与已知偏差

- **EJS 模板不进入预设文本通道**：ST 路径经 `preRenderPreset` 对预设执行 `<% %>`（提案 0008），AgentTavern 投影不做模板渲染——使用 Prompt Template 的预设会以模板原文进入 section。接入需在 agent 侧重复模板运行时装配，另行处理。
- **regex 不作用于预设文本**：两架构一致（ST 管线也只对世界书与消息应用 regex）。
- **采样只投影 temperature**：`openai_max_context` / `openai_max_tokens` 归宿主（理由见上表）。
- **injection_position=1（@Depth）条目**：AgentTavern 侧折叠进 system 块（无深度注入通道）；ST 管线维持既有 @Depth 插入路径。

## 验证

- `packages/plugin/tests/agent-tavern-preset.spec.ts`：选集回落链（100001 → 100000 → 首组）、启用语义（仅顺序表 `enabled:false` 为禁用；`system_prompt:false` 与 `prompt.enabled:false` 不覆盖顺序表）、marker 与空内容跳过、卡覆盖与 `{{original}}`、-75 section 注册与懒装载（宏展开 + 无 `{{` 残留）、`agent/request` 温度覆盖与未绑定透传、state/PUT/DELETE 路由写穿、跨模块实例共享注册表（vi.resetModules 模拟分离 bundle）。
- `packages/tavern-pipeline/tests/pipeline.spec.ts`：100001 优先、`enabled:false` 跳过、`system_prompt:false` 仍注入、缺 100001 回落 100000。
- `packages/plugin/tests/tavern-command.spec.ts`：激活预热回归（临时移除 emit 后该用例变红，敏感性已验证）。
- `packages/plugin/tests/tavern-guides.spec.ts`：guides 注册表跨实例共享回归。
